/**
 * Monitor-session management + spawning new pi agents +
 * status-line widget push.
 *
 * Direct port of the corresponding helpers from
 * `src/pi_monitor/tmux.py`. The monitor session is a 2-pane
 * window: pane 0 hosts the TUI, pane 1 is the right slot the
 * resolver respawns with `tmux attach -t <viewer>` whenever the
 * cursor moves to a new agent.
 */

import { existsSync, statSync } from "node:fs";

import { TmuxError, sessionExists, tmuxRun } from "./client.js";
import { listPanes } from "./panes.js";
import { cleanupOrphanViewers } from "./viewer.js";

/** Name of the monitor session. */
export const MONITOR_SESSION = "monitor";
/** Stable target for the TUI pane (left). */
export const TUI_PANE = `${MONITOR_SESSION}:0.0`;
/** Stable target for the right slot. */
export const RIGHT_SLOT = `${MONITOR_SESSION}:0.1`;

/**
 * Idle command for the right slot when no agent is borrowed.
 * Prints a small banner and blocks forever via `tail -f /dev/null`
 * (POSIX; works on macOS where `sleep infinity` is GNU-only).
 */
function placeholderCmd(): string {
  return (
    "sh -c '" +
    'printf "\\n  hover a pi row in the tree (j/k) to preview an agent here' +
    '\\n  Enter or Tab focuses this pane so keys go to the agent\\n\\n"; ' +
    "tail -f /dev/null'"
  );
}

/**
 * Create or normalize the monitor session into a 2-pane layout.
 *
 * - If the session doesn't exist: create it, run `leftCommand` in
 *   pane 0, split horizontally and run the placeholder in pane 1.
 * - If the session exists with 1 pane (older versions): split a
 *   right pane in and start the placeholder.
 * - If the session exists with >2 panes: kill any extras beyond
 *   pane 1.
 * - If the session exists with 2 panes already: leave it alone.
 *
 * Always calls `cleanupOrphanViewers` first so a previous crash
 * can't leave stray clients alive.
 *
 * Mirrors `ensure_monitor_session`.
 */
export function ensureMonitorSession(leftCommand?: string): void {
  cleanupOrphanViewers();

  if (!sessionExists(MONITOR_SESSION)) {
    const cmd = leftCommand ?? "true";
    tmuxRun(["new-session", "-d", "-s", MONITOR_SESSION, "-x", "200", "-y", "50", cmd]);
    tmuxRun([
      "split-window",
      "-h",
      "-t",
      TUI_PANE,
      "-l",
      "60%",
      "-d",
      placeholderCmd(),
    ]);
    tmuxRun(["select-pane", "-t", TUI_PANE]);
    return;
  }

  const monitorPanes = listPanes()
    .filter((p) => p.session === MONITOR_SESSION && p.windowIndex === 0)
    .sort((a, b) => a.paneIndex - b.paneIndex);

  if (monitorPanes.length === 0) {
    // Existing-but-empty shouldn't really happen, but be defensive.
    tmuxRun(["kill-session", "-t", MONITOR_SESSION]);
    ensureMonitorSession(leftCommand);
    return;
  }

  if (monitorPanes.length === 1) {
    tmuxRun([
      "split-window",
      "-h",
      "-t",
      TUI_PANE,
      "-l",
      "60%",
      "-d",
      placeholderCmd(),
    ]);
    tmuxRun(["select-pane", "-t", TUI_PANE]);
    return;
  }

  // 2 or more \u2014 kill any extras and reset the right slot to the
  // placeholder so we don't inherit a stale `tmux attach` from a
  // crashed run.
  for (let i = 2; i < monitorPanes.length; i++) {
    const pane = monitorPanes[i] as (typeof monitorPanes)[number];
    try {
      tmuxRun(["kill-pane", "-t", pane.paneId]);
    } catch (err) {
      if (!(err instanceof TmuxError)) throw err;
    }
  }
  try {
    resetRightSlotToPlaceholder();
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
  }
  try {
    tmuxRun(["select-pane", "-t", TUI_PANE]);
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
  }
}

/** Kill the monitor session if it exists. */
export function killMonitorSession(): void {
  if (!sessionExists(MONITOR_SESSION)) return;
  tmuxRun(["kill-session", "-t", MONITOR_SESSION]);
}

/** Attach the current client to the monitor session. */
export function switchClientToMonitor(): void {
  tmuxRun(["switch-client", "-t", MONITOR_SESSION]);
}

/**
 * Respawn the monitor's right pane with a tmux client attached to
 * `viewer`. The `env -u TMUX` prefix unsets the inherited `$TMUX`
 * so the inner client doesn't refuse to nest.
 *
 * `cwd` (when provided) is passed to `respawn-pane -c`, so any
 * user-initiated split inside the right pane lands in the agent's
 * directory instead of pi-monitor's launch directory.
 *
 * Mirrors `attach_right_slot_to_viewer`.
 */
export function attachRightSlotToViewer(viewer: string, cwd?: string | null): void {
  // shell-quote the viewer name so spaces/quotes can't break the
  // command. Implemented as a tiny POSIX-shell escaper since Node
  // has no builtin.
  const cmd = `env -u TMUX tmux attach -t ${shellQuote(viewer)}`;
  const args = ["respawn-pane", "-k"];
  if (cwd !== undefined && cwd !== null && cwd !== "") {
    args.push("-c", cwd);
  }
  args.push("-t", RIGHT_SLOT, cmd);
  tmuxRun(args);
}

/** Bring the right pane back to its idle banner state. */
export function resetRightSlotToPlaceholder(): void {
  tmuxRun(["respawn-pane", "-k", "-t", RIGHT_SLOT, placeholderCmd()]);
}

/** Move keyboard focus to the right slot. */
export function focusRightSlot(): void {
  tmuxRun(["select-pane", "-t", RIGHT_SLOT]);
}

/** Move keyboard focus back to the TUI (left) pane. */
export function focusLeftSlot(): void {
  tmuxRun(["select-pane", "-t", TUI_PANE]);
}

// ---------------------------------------------------------------------------
// Spawning new pi agents
// ---------------------------------------------------------------------------

/**
 * Basename of `cwd`, with `-2` / `-3` ... appended if a session of
 * that name already exists. `pi` is the fallback for empty/root
 * paths. Mirrors `_suggest_session_name`.
 */
function suggestSessionName(cwd: string): string {
  const base = cwd.replace(/\/+$/, "").split("/").pop() || "pi";
  let candidate = base;
  let n = 2;
  while (sessionExists(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * Create a new detached tmux session running `pi` in `cwd`. Returns
 * the final session name (which may differ from the requested one
 * if a collision suffix was appended).
 *
 * Mirrors `create_pi_session`.
 */
export function createPiSession(cwd: string, name?: string): string {
  if (!isDirectory(cwd)) {
    throw new TmuxError(`directory not found: ${cwd}`);
  }
  const finalName = name ?? suggestSessionName(cwd);
  if (name !== undefined && sessionExists(name)) {
    throw new TmuxError(`session ${JSON.stringify(name)} already exists`);
  }
  tmuxRun(["new-session", "-d", "-s", finalName, "-c", cwd, "pi"]);
  return finalName;
}

/**
 * Create a new window in `targetSession` running `pi` in `cwd`.
 * Each pi agent gets its own window (tab) inside the session.
 *
 * Mirrors `create_pi_window`.
 */
export function createPiWindow(targetSession: string, cwd: string): void {
  if (!isDirectory(cwd)) {
    throw new TmuxError(`directory not found: ${cwd}`);
  }
  tmuxRun(["new-window", "-t", targetSession, "-c", cwd, "pi"]);
}

// ---------------------------------------------------------------------------
// Status-line widget
// ---------------------------------------------------------------------------

/**
 * Push a string into a tmux user option that the user's
 * `status-right` references via `#{@pi-monitor-status}`. Best-effort
 * \u2014 silently swallows TmuxError so we don't crash the App during
 * a transient tmux outage.
 *
 * Mirrors `set_status_widget`.
 */
export function setStatusWidget(text: string): void {
  try {
    tmuxRun(["set-option", "-gq", "@pi-monitor-status", text]);
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
  }
}

/** Equivalent to `setStatusWidget("")`. */
export function clearStatusWidget(): void {
  setStatusWidget("");
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * POSIX-shell single-quote a string. Mirrors `shlex.quote` for the
 * subset of cases we hit. Wraps in single quotes; embedded single
 * quotes use the standard "close quote, escape literal, reopen"
 * trick (`'\''`).
 */
function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
