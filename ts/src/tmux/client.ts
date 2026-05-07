/**
 * Low-level tmux subprocess wrapper.
 *
 * Direct port of the helpers at the bottom of
 * `src/pi_monitor/tmux.py` (`_tmux`, `TmuxError`, `server_running`,
 * `session_exists`). Higher-level domain modules
 * (`tmux/panes.ts`, `tmux/viewer.ts`, `tmux/monitor.ts`) call
 * `tmuxRun` and never spawn `tmux` directly, so we have one place
 * to mock in tests.
 *
 * Sync subprocess on purpose: the resolver is sync, the tick loop
 * is sync, and tmux is fast enough that a 500 ms poll calling
 * `list-panes` doesn't show up in CPU graphs.
 */

import { spawnSync } from "node:child_process";

/** Raised for any non-zero tmux exit. Caller decides whether to swallow. */
export class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

/**
 * Run `tmux <args...>`. Returns stdout when `capture` is true,
 * otherwise an empty string. Throws `TmuxError` on non-zero exit.
 *
 * Mirrors `_tmux` in the Python build. The TS shape uses a single
 * options object instead of a kwarg so call sites can pass a single
 * arg list naturally.
 */
export function tmuxRun(args: string[], options: { capture?: boolean } = {}): string {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    // tmux output is small; default maxBuffer (1 MB) is fine.
  });
  if (result.error) {
    throw new TmuxError(
      `tmux ${args.join(" ")} could not be spawned: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new TmuxError(
      `tmux ${args.join(" ")} failed (exit ${result.status}): ${stderr}`,
    );
  }
  return options.capture === true ? (result.stdout ?? "") : "";
}

/**
 * True iff `tmux` is on PATH and a server is currently running
 * (i.e. `tmux has-session` exits zero with no args). Mirrors
 * `server_running` in the Python build.
 */
export function serverRunning(): boolean {
  // Use execFileSync with non-throwing exit handling: tmux returns
  // non-zero when no server is running, which we want to treat as
  // false instead of an exception.
  try {
    const result = spawnSync("tmux", ["has-session"], { encoding: "utf8" });
    if (result.error) return false;
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * True iff a tmux session with the exact name `name` exists. Uses
 * the `=name` syntax so prefix matches don't false-positive.
 * Mirrors `session_exists` in the Python build.
 */
export function sessionExists(name: string): boolean {
  const result = spawnSync("tmux", ["has-session", "-t", `=${name}`], {
    encoding: "utf8",
  });
  if (result.error) return false;
  return result.status === 0;
}
