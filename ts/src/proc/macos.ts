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
 * `findPiPidForPane` calls. The resolver runs every ~500 ms and
 * makes 2–3 calls per pi pane in one tick (findPiPid + procStartTime
 * × N), so the TTL must comfortably exceed a single tick or every
 * tick will re-spawn `ps -A` mid-loop.
 *
 * 450 ms gives one `ps -A` spawn per resolver tick at the default
 * 500 ms cadence, with 50 ms slack so a slow `ps` doesn't push the
 * next tick's first call past the TTL and double-spawn.
 */
const CACHE_TTL_MS = 450;

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
 * Current working directory for every pid in `pids`. Issues ONE
 * `lsof -p p1,p2,...` subprocess and parses the per-pid cwd lines
 * out of the combined output. Missing/unreadable pids are absent
 * from the returned map.
 *
 * This is the bulk equivalent of {@link procCwd}; the state
 * resolver calls it once per tick with every live pi pid so 10
 * panes cost 1 lsof spawn instead of 10. Per-spawn cost on macOS
 * is ~10–30 ms, so this is the single biggest tick-budget win
 * once you cross ~5 panes.
 *
 * Empty `pids` short-circuits to an empty map with no subprocess.
 *
 * Output parsing: lsof emits a `p<pid>` marker line at the start
 * of each process record, then one `f<fd>` line + one `n<path>`
 * line per matching descriptor. With `-d cwd` we get at most one
 * `n` line per pid. We track the most-recent `p` and attribute
 * the next `n` line to it.
 */
export function procCwds(pids: readonly number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (pids.length === 0) return out;

  // Dedupe + filter to integers. lsof would tolerate dupes but it
  // costs nothing here and makes the test mock easier to reason
  // about.
  const unique = Array.from(new Set(pids)).filter((p) => Number.isInteger(p) && p > 0);
  if (unique.length === 0) return out;

  let raw = "";
  try {
    raw = execFileSync("lsof", ["-a", "-p", unique.join(","), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      // lsof should be sub-second; cap so a hung subprocess can't
      // block the App. Scaled lightly with pid count so very
      // large batches don't trip the cap before lsof finishes,
      // but stays bounded.
      timeout: 2_000 + Math.min(unique.length * 100, 3_000),
    });
  } catch {
    // lsof exits non-zero when *any* of the requested pids is gone,
    // even if the rest produced output. The output is still on
    // stdout, but execFileSync throws and discards it. Caller gets
    // an empty map; the resolver falls back to ref.cwd per pane.
    return out;
  }

  let currentPid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.length < 2) continue;
    const tag = line.charCodeAt(0);
    if (tag === 112 /* 'p' */) {
      const n = Number(line.slice(1));
      currentPid = Number.isInteger(n) ? n : null;
    } else if (tag === 110 /* 'n' */ && currentPid !== null) {
      // First `n` line per pid wins; -d cwd only emits one anyway,
      // so this is just defensive.
      if (!out.has(currentPid)) {
        out.set(currentPid, line.slice(1));
      }
    }
  }
  return out;
}

/**
 * Current working directory for a single `pid`. Thin wrapper over
 * {@link procCwds}; prefer the bulk API in hot paths.
 *
 * Used by the state resolver to find a pi process's actual cwd
 * when an extension (e.g. auto-worktree) has re-exec'd it into
 * a different directory than the tmux pane's `pane_current_path`.
 */
export function procCwd(pid: number): string | null {
  return procCwds([pid]).get(pid) ?? null;
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
