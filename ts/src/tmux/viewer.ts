/**
 * Linked-viewer flow.
 *
 * Direct port of the `viewer_*` / `cleanup_orphan_viewers` /
 * `is_viewer_session` helpers from `src/pi_monitor/tmux.py`.
 *
 * A "viewer" is a tmux session created as a session-group sister of
 * a real source session via `tmux new-session -t <source>`. The
 * monitor's right pane attaches to the viewer (`tmux attach -t
 * <viewer>`); killing the viewer leaves the source session and its
 * panes untouched, which is exactly what we want when the user
 * picks a different agent.
 */

import { TmuxError, sessionExists, tmuxRun } from "./client.js";
import { VIEWER_SESSION_PREFIX, isViewerSession } from "./panes.js";

/** Prefix the inner viewer client uses, so it doesn't collide with C-b. */
export const VIEWER_INNER_PREFIX = "C-a";

/**
 * Stable, identifiable name for a viewer linked to `source`.
 * Replaces `:`, `.`, and spaces with `-` so the result is a valid
 * tmux session name. Mirrors `viewer_session_name`.
 */
export function viewerSessionName(source: string): string {
  const safe = source.replace(/[:. ]/g, "-");
  return `${VIEWER_SESSION_PREFIX}${safe}`;
}

/**
 * Create a session-group sister of `source` (or return the existing
 * one) and set its prefix + status overrides. Returns the viewer
 * session name. The viewer shares `source`'s windows; killing the
 * viewer leaves `source` untouched.
 *
 * Status-line off so the right pane doesn't render two stacked
 * status bars (the outer monitor bar already shows pi-monitor's
 * aggregate counts; a duplicate inner bar is noise).
 *
 * Mirrors `ensure_linked_viewer`.
 */
export function ensureLinkedViewer(source: string): string {
  const name = viewerSessionName(source);
  if (sessionExists(name)) return name;

  tmuxRun(["new-session", "-d", "-s", name, "-t", source]);
  // Best-effort prefix + status overrides. Older tmux that won't
  // accept either is non-fatal \u2014 the user just sees the default
  // prefix and a duplicate status bar.
  try {
    tmuxRun(["set-option", "-t", name, "prefix", VIEWER_INNER_PREFIX]);
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
  }
  try {
    tmuxRun(["set-option", "-t", name, "status", "off"]);
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
  }
  return name;
}

/**
 * Best-effort kill. The shared windows persist as long as `source`
 * still references them, which is exactly what we want. Mirrors
 * `kill_linked_viewer`.
 */
export function killLinkedViewer(name: string): void {
  if (!sessionExists(name)) return;
  try {
    tmuxRun(["kill-session", "-t", name]);
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
  }
}

/**
 * Kill every leftover `pi-monitor-view-*` session. Called on
 * bootstrap and quit so a previous crash can't leave stray clients
 * alive. Mirrors `cleanup_orphan_viewers`.
 */
export function cleanupOrphanViewers(): void {
  let raw = "";
  try {
    raw = tmuxRun(["list-sessions", "-F", "#{session_name}"], {
      capture: true,
    });
  } catch (err) {
    if (err instanceof TmuxError) return; // no server / no sessions
    throw err;
  }
  for (const line of raw.split("\n")) {
    const name = line.trim();
    if (name === "") continue;
    if (!isViewerSession(name)) continue;
    try {
      tmuxRun(["kill-session", "-t", name]);
    } catch (err) {
      if (!(err instanceof TmuxError)) throw err;
    }
  }
}

/**
 * Set the viewer session's current window+pane so an attached
 * client lands on the agent's pane. Best-effort: silently ignores
 * the case where the source moved its windows out from under us.
 *
 * Mirrors `viewer_focus_pane`.
 */
export function viewerFocusPane(
  viewer: string,
  windowIndex: number,
  paneIndex: number,
): void {
  const targetWindow = `${viewer}:${windowIndex}`;
  const targetPane = `${targetWindow}.${paneIndex}`;
  try {
    tmuxRun(["select-window", "-t", targetWindow]);
  } catch (err) {
    if (err instanceof TmuxError) return;
    throw err;
  }
  try {
    tmuxRun(["select-pane", "-t", targetPane]);
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
  }
}

/**
 * Tmux-zoom the given pane within the viewer's window so it fills
 * the viewer's frame and any sibling panes are hidden. Idempotent
 * \u2014 no-op if the window is already zoomed on the target pane.
 *
 * Mirrors `viewer_zoom_to_pane`.
 */
export function viewerZoomToPane(
  viewer: string,
  windowIndex: number,
  paneIndex: number,
): void {
  const targetWindow = `${viewer}:${windowIndex}`;
  const targetPane = `${targetWindow}.${paneIndex}`;

  // Read the window's zoom flag + the active pane index. If we're
  // already zoomed on the target, skip.
  let flag = "0";
  let active = "";
  try {
    const out = tmuxRun(
      [
        "display-message",
        "-p",
        "-t",
        targetWindow,
        "-F",
        "#{window_zoomed_flag},#{pane_index}",
      ],
      { capture: true },
    ).trim();
    const comma = out.indexOf(",");
    if (comma >= 0) {
      flag = out.slice(0, comma);
      active = out.slice(comma + 1);
    }
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
    // Treat as not-zoomed if we can't read; we'll attempt to zoom
    // below and that may fail too \u2014 also non-fatal.
  }

  if (flag === "1" && active === String(paneIndex)) return;

  if (flag === "1") {
    // Zoomed on the wrong pane \u2014 unzoom so we can re-zoom on target.
    try {
      tmuxRun(["resize-pane", "-Z", "-t", targetWindow]);
    } catch (err) {
      if (err instanceof TmuxError) return;
      throw err;
    }
  }

  try {
    tmuxRun(["select-pane", "-t", targetPane]);
    tmuxRun(["resize-pane", "-Z", "-t", targetPane]);
  } catch (err) {
    if (!(err instanceof TmuxError)) throw err;
  }
}
