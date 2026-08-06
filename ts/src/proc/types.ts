/**
 * Shared shapes for the platform process walkers.
 *
 * `proc/linux.ts` and `proc/macos.ts` expose the same API so
 * `proc/index.ts` can dispatch on `process.platform` without callers
 * branching.
 */

/**
 * An agent process found inside a tmux pane's descendant tree.
 *
 * `comm` is the kernel-tracked command name that matched, which is
 * what tells the caller WHICH harness owns the pane — the walk is
 * given every registered harness's comm names at once, so the match
 * has to report back what it found.
 */
export interface AgentProc {
  pid: number;
  comm: string;
}
