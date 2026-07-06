/**
 * Linux process-tree resolver.
 *
 * Reads `/proc/<pid>/*` synchronously. The original Python build did
 * the same thing before switching to psutil; we go back to native
 * `/proc` because there's no psutil in Node and the calls are
 * microseconds anyway.
 *
 * Public API matches `proc/macos.ts` so `proc/index.ts` can dispatch
 * on `process.platform`.
 */

import { readFileSync, readlinkSync, statSync } from "node:fs";

import type { AgentKind } from "../state/types.js";

export interface AgentProcess {
  kind: AgentKind;
  pid: number;
}

/**
 * Current working directory for `pid`. Reads the
 * `/proc/<pid>/cwd` symlink and returns its absolute target, or
 * `null` if the pid is gone, the symlink is unreadable, or the
 * caller lacks permission to traverse it.
 *
 * Used by the state resolver to find a pi process's actual cwd
 * when an extension (e.g. auto-worktree) has re-exec'd it into a
 * different directory than the tmux pane's `pane_current_path`.
 */
export function procCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Bulk equivalent of {@link procCwd}. Linux readlink is
 * microseconds, so this is just a loop — the bulk shape exists
 * for API parity with the macOS impl, where the resolver collapses
 * N lsof spawns into 1.
 */
export function procCwds(pids: readonly number[]): Map<number, string | null> {
  const out = new Map<number, string | null>();
  for (const pid of pids) {
    const cwd = procCwd(pid);
    if (cwd !== null) out.set(pid, cwd);
  }
  return out;
}

/**
 * Process start time in unix seconds, or null if the pid is gone or
 * unreadable. We use the ctime of `/proc/<pid>/` which the kernel
 * stamps when it creates the proc entry \u2014 same value, no clock-tick
 * arithmetic. Mirrors `_proc_starttime` in the Python build (which
 * went through psutil to get the same number on a more general path).
 */
export function procStartTime(pid: number): number | null {
  try {
    return statSync(`/proc/${pid}`).ctimeMs / 1000;
  } catch {
    return null;
  }
}

/**
 * Walk the process tree from `panePid` and return the DEEPEST
 * supported agent descendant. Includes `panePid` itself so
 * `exec pi` / `exec claude` still resolves.
 *
 * The first supported kind encountered from the pane root is the
 * primary agent for this pane. We still keep walking to find the
 * deepest process of that SAME kind (auto-worktree can create pi ->
 * pi chains), but we ignore nested different-kind tools so a pi pane
 * that happens to run `claude` as a subprocess does not get reclassified.
 *
 * BFS with a seen-set so a corrupt /proc snapshot can't loop us.
 * Walks the whole reachable tree (cheap: tmux pane subtrees are
 * small) and tracks the deepest primary-kind agent seen so far.
 */
export function findAgentProcessForPane(panePid: number): AgentProcess | null {
  let primaryKind: AgentKind | null = null;
  let best: { kind: AgentKind; pid: number; depth: number } | null = null;
  const queue: Array<{ pid: number; depth: number }> = [{ pid: panePid, depth: 0 }];
  const seen = new Set<number>();

  while (queue.length > 0) {
    // shift() is O(n) on big queues but the descendant count under
    // a tmux pane shell is tiny (1–3 typically), so this is fine.
    const { pid, depth } = queue.shift() as { pid: number; depth: number };
    if (seen.has(pid)) continue;
    seen.add(pid);

    let comm: string;
    try {
      comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      // Process disappeared or not readable; skip and continue.
      continue;
    }
    const kind = agentKindFromComm(comm);
    if (kind !== null) {
      primaryKind ??= kind;
      if (kind === primaryKind && (best === null || depth > best.depth)) {
        best = { kind, pid, depth };
      }
    }

    let childrenRaw: string;
    try {
      childrenRaw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    } catch {
      continue;
    }
    for (const piece of childrenRaw.trim().split(/\s+/)) {
      if (piece === "") continue;
      const n = Number(piece);
      if (Number.isInteger(n) && !seen.has(n)) {
        queue.push({ pid: n, depth: depth + 1 });
      }
    }
  }
  return best === null ? null : { kind: best.kind, pid: best.pid };
}

/** Mirrors the original pi-only helper for existing callers/tests. */
export function findPiPidForPane(panePid: number): number | null {
  const agent = findAgentProcessForPane(panePid);
  return agent?.kind === "pi" ? agent.pid : null;
}

/** Convenience wrapper for Claude Code callers/tests. */
export function findClaudePidForPane(panePid: number): number | null {
  const agent = findAgentProcessForPane(panePid);
  return agent?.kind === "claude" ? agent.pid : null;
}

function agentKindFromComm(comm: string): AgentKind | null {
  if (comm === "pi") return "pi";
  if (comm === "claude") return "claude";
  return null;
}
