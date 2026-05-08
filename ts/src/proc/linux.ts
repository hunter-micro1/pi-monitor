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
 * descendant whose `comm` is exactly `pi`. Includes `panePid`
 * itself so `exec pi` still resolves.
 *
 * Why deepest, not first: extensions like `auto-worktree` re-exec
 * pi inside an `agent/<base>-<ts>` worktree, producing a chain of
 * pi processes (outer pi at the launch cwd → inner pi at the
 * worktree cwd). The state resolver consumes `procCwd(piPid)` to
 * claim the right JSONL session file, and the worktree cwd lives
 * on the leaf pi. Returning the outer pi — the previous behaviour
 * — left every auto-worktree pane stuck with no snapshot, which
 * collapsed the bottom details box to its title row.
 *
 * BFS with a seen-set so a corrupt /proc snapshot can't loop us.
 * Walks the whole reachable tree (cheap: tmux pane subtrees are
 * small) and tracks the deepest pi seen so far.
 *
 * Mirrors `find_pi_pid_for_pane` in the Python build.
 */
export function findPiPidForPane(panePid: number): number | null {
  let best: { pid: number; depth: number } | null = null;
  const queue: Array<{ pid: number; depth: number }> = [{ pid: panePid, depth: 0 }];
  const seen = new Set<number>();

  while (queue.length > 0) {
    // shift() is O(n) on big queues but the descendant count under
    // a tmux pane shell is tiny (1\u20133 typically), so this is fine.
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
    if (comm === "pi" && (best === null || depth > best.depth)) {
      best = { pid, depth };
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
  return best?.pid ?? null;
}
