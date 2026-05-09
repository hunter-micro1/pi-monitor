/**
 * macOS process-tree resolver.
 *
 * No `/proc` on Darwin, so we shell out to `ps`. Single per-snapshot
 * call lists every running process; we cache the result for a short
 * window so the resolver can do per-pane lookups without firing N
 * subprocesses per tick.
 *
 * Public API matches `proc/linux.ts` so `proc/index.ts` can dispatch
 * on `process.platform`.
 */

import { execFileSync } from "node:child_process";

/**
 * How long a `ps -A` snapshot is reused across `procStartTime` /
 * `findPiPidForPane` calls. The resolver runs every ~500 ms; 200 ms
 * is enough to amortize all the per-pane lookups in a single tick
 * while still being responsive to processes that come/go between
 * ticks.
 */
const CACHE_TTL_MS = 200;

interface PsRow {
  pid: number;
  ppid: number;
  comm: string;
  /** Elapsed seconds since process start (parsed from `ps -o etime=`). */
  etimes: number;
}

let cached: { atMs: number; rows: Map<number, PsRow> } | null = null;

/**
 * Parse a BSD `ps -o etime=` value (`[[dd-]hh:]mm:ss`) into seconds.
 *
 * Examples:
 *   "00:42"          ->     42
 *   "01:23"          ->     83
 *   "23:01:23"       ->  82883
 *   "3-04:05:06"     -> 273906
 *
 * Returns `null` for unrecognized input.
 *
 * Why not the `etimes` keyword (raw seconds)? It's a Linux-only
 * procps-ng extension. macOS BSD `ps` rejects it with
 * `ps: etimes: keyword not found` and exits non-zero, which used
 * to silently empty the snapshot and leave pi-monitor unable to
 * find any pi panes on macOS. `etime` is the BSD-supported
 * alternative.
 *
 * Exposed for tests.
 */
export function parseEtime(value: string): number | null {
  // Optional `dd-` day prefix, then 2 or 3 colon-separated time fields.
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (m === null) return null;
  const days = m[1] === undefined ? 0 : Number(m[1]);
  const hours = m[2] === undefined ? 0 : Number(m[2]);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  if (
    !Number.isFinite(days) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds)
  ) {
    return null;
  }
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/**
 * Run `ps -A -o pid=,ppid=,comm=,etime=` and parse the output into
 * a pid -> row map. Caches for `CACHE_TTL_MS` ms.
 *
 * `LC_ALL=C` is forced so the output is ASCII-stable across locales;
 * without it some macOS configurations localize the column headers
 * (which we suppress with `=`) and number formatting.
 *
 * NOTE: We use BSD `etime` (`[[dd-]hh:]mm:ss`), not procps `etimes`
 * (raw seconds) — see `parseEtime` for the regression context.
 *
 * Exposed for tests; production callers go through `procStartTime`
 * and `findPiPidForPane`.
 */
export function readPsSnapshot(
  options: { force?: boolean; nowMs?: number } = {},
): Map<number, PsRow> {
  const now = options.nowMs ?? Date.now();
  if (!options.force && cached !== null && now - cached.atMs < CACHE_TTL_MS) {
    return cached.rows;
  }
  let raw = "";
  try {
    raw = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm=,etime="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      // ps shouldn't take more than a second under any reasonable
      // load. Cap so a hung subprocess can't block the App.
      timeout: 2_000,
    });
  } catch {
    // ps not on PATH, killed, or non-zero exit. Treat as empty
    // snapshot — callers will return null for everything.
    cached = { atMs: now, rows: new Map() };
    return cached.rows;
  }

  const rows = new Map<number, PsRow>();
  for (const line of raw.split("\n")) {
    // Output looks like: "  1234   5678 zsh        01:23"
    // Three columns + a comm column that may itself have spaces.
    // Pull pid, ppid, etime from the ends and keep everything in
    // between as comm. (`-o pid=` suppresses the header so we
    // don't have to skip a row.)
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 4) continue;
    const pidS = tokens[0] as string;
    const ppidS = tokens[1] as string;
    const etimeS = tokens[tokens.length - 1] as string;
    const comm = tokens.slice(2, -1).join(" ");

    const pid = Number(pidS);
    const ppid = Number(ppidS);
    const etimes = parseEtime(etimeS);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || etimes === null) {
      continue;
    }
    rows.set(pid, { pid, ppid, comm, etimes });
  }

  cached = { atMs: now, rows };
  return rows;
}

/**
 * Reset the snapshot cache. Useful between unit tests so a stub
 * `execFileSync` mock doesn't leak across cases. Production callers
 * should not need this.
 */
export function _resetPsCacheForTests(): void {
  cached = null;
}

/**
 * Current working directory for `pid`. Shells out to
 * `lsof -a -p <pid> -d cwd -Fn` and parses the `n`-prefixed cwd
 * line. Returns `null` when lsof is unavailable, the pid is
 * gone, or no cwd line was emitted.
 *
 * Used by the state resolver to find a pi process's actual cwd
 * when an extension (e.g. auto-worktree) has re-exec'd it into
 * a different directory than the tmux pane's `pane_current_path`.
 *
 * Each call shells out (no caching). Callers in the hot resolver
 * loop are expected to invoke this once per pi pane per tick;
 * with single-digit pi panes per tmux server it stays well under
 * the 500ms tick budget.
 */
export function procCwd(pid: number): string | null {
  let raw = "";
  try {
    raw = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      // lsof should be sub-second; cap so a hung subprocess can't
      // block the App.
      timeout: 2_000,
    });
  } catch {
    return null;
  }
  // -Fn output is one or more lines per file descriptor; the cwd
  // line is the one whose first character is `n` followed by the
  // path. e.g.
  //   p1234
  //   fcwd
  //   n/home/user/project
  for (const line of raw.split("\n")) {
    if (line.length > 1 && line.charCodeAt(0) === 110 /* 'n' */) {
      return line.slice(1);
    }
  }
  return null;
}

/**
 * Process start time in unix seconds. Computed as
 * `now - etimes` from the cached `ps` snapshot.
 *
 * Mirrors `_proc_starttime` in the Python build.
 */
export function procStartTime(pid: number): number | null {
  const snap = readPsSnapshot();
  const row = snap.get(pid);
  if (row === undefined) return null;
  return Date.now() / 1000 - row.etimes;
}

/**
 * Walk the process tree from `panePid` and return the DEEPEST
 * descendant (inclusive) whose `comm` is exactly `pi`. See the
 * Linux sibling for the rationale: extensions like
 * `auto-worktree` re-exec pi inside an `agent/<base>-<ts>`
 * worktree, so the leaf pi carries the cwd the JSONL claim
 * needs.
 *
 * Builds a parent-to-children index from the cached `ps` snapshot
 * and BFSes from `panePid`, walking the whole reachable tree.
 */
export function findPiPidForPane(panePid: number): number | null {
  const snap = readPsSnapshot();

  // Build parent -> children index from the snapshot. Cheap; the
  // overall snapshot is at most a few hundred entries.
  const childrenByPpid = new Map<number, number[]>();
  for (const row of snap.values()) {
    let list = childrenByPpid.get(row.ppid);
    if (list === undefined) {
      list = [];
      childrenByPpid.set(row.ppid, list);
    }
    list.push(row.pid);
  }

  let best: { pid: number; depth: number } | null = null;
  const queue: Array<{ pid: number; depth: number }> = [{ pid: panePid, depth: 0 }];
  const seen = new Set<number>();

  while (queue.length > 0) {
    const { pid, depth } = queue.shift() as { pid: number; depth: number };
    if (seen.has(pid)) continue;
    seen.add(pid);

    const row = snap.get(pid);
    if (row === undefined) continue;
    if (row.comm === "pi" && (best === null || depth > best.depth)) {
      best = { pid, depth };
    }

    const kids = childrenByPpid.get(pid);
    if (kids === undefined) continue;
    for (const kpid of kids) {
      if (!seen.has(kpid)) queue.push({ pid: kpid, depth: depth + 1 });
    }
  }
  return best?.pid ?? null;
}
