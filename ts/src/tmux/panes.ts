/**
 * Pane discovery.
 *
 * Direct port of the `Pane` dataclass + `list_panes` /
 * `list_pi_panes` / `is_viewer_session` from
 * `src/pi_monitor/tmux.py`.
 */

import { TmuxError, tmuxRun } from "./client.js";

/** Prefix used for sessions we create as linked viewers. */
export const VIEWER_SESSION_PREFIX = "pi-monitor-view-";

/**
 * Format string handed to `tmux list-panes -F`. Tab-separated so
 * fields with embedded spaces (paths, titles) survive the round
 * trip. Matches `_LIST_FORMAT` in the Python build column-for-
 * column.
 */
const LIST_FORMAT =
  "#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}" +
  "\t#{pane_pid}\t#{pane_current_path}\t#{pane_title}\t#{pane_current_command}";

/**
 * One tmux pane. Mirrors the Python `Pane` dataclass.
 */
export interface Pane {
  /** Stable tmux pane id like "%42" — survives across renames. */
  paneId: string;
  /** Composite addressing target like "contracts:0.2". */
  target: string;
  session: string;
  windowIndex: number;
  paneIndex: number;
  /** PID of the pane's foreground process (typically a shell). */
  pid: number;
  /** `pane_current_path` \u2014 cwd of the foreground process. */
  cwd: string;
  /** `pane_title` \u2014 may be set by the user (`tmux select-pane -T`). */
  title: string;
  /** `pane_current_command` \u2014 e.g. "pi", "zsh". */
  command: string;
  /** Convenience: command === "pi". */
  isPi: boolean;
}

/**
 * Every pane on the tmux server. Empty array when tmux isn't
 * running (we swallow the `TmuxError` so callers don't have to).
 *
 * Mirrors `list_panes` in the Python build.
 */
export function listPanes(): Pane[] {
  let raw = "";
  try {
    raw = tmuxRun(["list-panes", "-a", "-F", LIST_FORMAT], { capture: true });
  } catch (err) {
    if (err instanceof TmuxError) return [];
    throw err;
  }

  const panes: Pane[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    if (parts.length !== 8) continue;
    const [paneId, session, win, pidx, pid, cwd, title, command] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const windowIndex = Number.parseInt(win, 10);
    const paneIndex = Number.parseInt(pidx, 10);
    const pidNum = Number.parseInt(pid, 10);
    if (
      !Number.isFinite(windowIndex) ||
      !Number.isFinite(paneIndex) ||
      !Number.isFinite(pidNum)
    ) {
      continue;
    }
    panes.push({
      paneId,
      target: `${session}:${win}.${pidx}`,
      session,
      windowIndex,
      paneIndex,
      pid: pidNum,
      cwd,
      title,
      command,
      isPi: command === "pi",
    });
  }
  return panes;
}

/** Convenience: only panes whose foreground command is `pi`. */
export function listPiPanes(): Pane[] {
  return listPanes().filter((p) => p.isPi);
}

/**
 * True for sessions we created as linked viewers. Mirrors
 * `is_viewer_session`.
 */
export function isViewerSession(name: string): boolean {
  return name.startsWith(VIEWER_SESSION_PREFIX);
}
