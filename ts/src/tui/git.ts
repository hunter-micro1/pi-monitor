/**
 * Git branch resolver with a 15s TTL cache.
 *
 * Mirrors `branch_for_cwd` in `tui.py`. Every render tick
 * re-derives the branch for every visible pane's cwd; the cache
 * keeps that path subprocess-free at our 0.5s tick cadence. A 15s
 * TTL means each cwd hits `git` at most every ~30 ticks.
 *
 * Detached HEADs intentionally return null \u2014 there's no branch
 * name to display, and showing the SHA is just visual noise.
 */

import { spawnSync } from "node:child_process";

/** Cache TTL (sec). Identical to _BRANCH_TTL_S in tui.py. */
export const BRANCH_TTL_S = 15;

interface CacheEntry {
  /** Monotonic timestamp when this entry was written (`performance.now() / 1000`). */
  readonly t: number;
  /** Branch name, or null for "no branch" (detached head, not a checkout, etc.). */
  readonly branch: string | null;
}

const cache = new Map<string, CacheEntry>();

/**
 * Returns the current git branch for `cwd`, or null if it isn't a
 * git checkout, the HEAD is detached, or the `git` invocation
 * failed for any reason. Memoized for `BRANCH_TTL_S` seconds per cwd.
 */
export function branchForCwd(cwd: string): string | null {
  if (!cwd) return null;
  const now = nowSec();
  const cached = cache.get(cwd);
  if (cached !== undefined && now - cached.t < BRANCH_TTL_S) {
    return cached.branch;
  }
  const branch = readBranchFromGit(cwd);
  cache.set(cwd, { t: now, branch });
  return branch;
}

/**
 * Drop every cache entry. Tests use this to force a re-read; the
 * App never needs to call it.
 */
export function _clearBranchCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readBranchFromGit(cwd: string): string | null {
  try {
    const result = spawnSync(
      "git",
      ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        encoding: "utf8",
        timeout: 400,
        // `git -C` sets cwd via flag; we don't need to set the
        // child's process.cwd. Inheriting our env is fine.
      },
    );
    if (result.status !== 0) return null;
    const out = (result.stdout ?? "").trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

function nowSec(): number {
  return performance.now() / 1000;
}
