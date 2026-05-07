/**
 * Side-effect bridge between the App's cursor state and the tmux
 * monitor session's right pane.
 *
 * Mirrors `_borrow_into_right_slot` + `_active_viewer` tracking in
 * `tui.py`. Implemented as a closure-over-state factory so callers
 * (cli.ts in production, vi.fn() in tests) can swap the
 * implementation without touching App.tsx.
 */

import { TmuxError } from "../tmux/client.js";
import {
  attachRightSlotToViewer,
  focusRightSlot,
  killMonitorSession,
  resetRightSlotToPlaceholder,
} from "../tmux/monitor.js";
import {
  cleanupOrphanViewers,
  ensureLinkedViewer,
  killLinkedViewer,
  viewerFocusPane,
  viewerZoomToPane,
} from "../tmux/viewer.js";

export interface PaneTarget {
  /** Tmux session that hosts the source pane. */
  readonly session: string;
  /** Source pane's window index. */
  readonly windowIndex: number;
  /** Source pane's index inside its window. */
  readonly paneIndex: number;
  /**
   * Source pane's working directory. Threaded into
   * `attachRightSlotToViewer` so that user-initiated splits inside
   * the right slot land in the agent's directory.
   */
  readonly cwd: string | null;
}

export interface TmuxBridge {
  /**
   * Called whenever the cursor lands on (or moves to a different)
   * pane row. Sets up a linked viewer for the source session,
   * focuses + zooms the source pane inside it, and respawns the
   * right slot on the new viewer when it differs from the previous
   * one. Idempotent on repeat calls with the same target.
   */
  onPaneCursor(target: PaneTarget): void;

  /**
   * Called when the cursor moves off the pane list (e.g. up onto
   * the "+ new" affordance). Resets the right slot to its idle
   * banner and kills the previously-attached viewer if any.
   */
  onCursorAway(): void;

  /**
   * Tab / Enter handler. Hands keyboard focus to the right slot if
   * a viewer is currently attached; no-op otherwise.
   */
  focusAgent(): void;

  /**
   * Final cleanup. Called on App exit. Kills every pi-monitor-view-*
   * viewer + the monitor session itself.
   */
  shutdown(): void;
}

/**
 * Build a TmuxBridge backed by the real `tmux` subprocess via the
 * `tmux/*` modules. Tests inject their own mock implementing
 * TmuxBridge directly instead of calling this factory.
 */
export function makeTmuxBridge(): TmuxBridge {
  let activeViewer: string | null = null;
  let activeTarget: PaneTarget | null = null;

  function sameTarget(a: PaneTarget, b: PaneTarget): boolean {
    return (
      a.session === b.session &&
      a.windowIndex === b.windowIndex &&
      a.paneIndex === b.paneIndex
    );
  }

  return {
    onPaneCursor(target) {
      if (activeTarget !== null && sameTarget(activeTarget, target)) {
        // Same pane already attached + zoomed; nothing to do.
        return;
      }
      try {
        const viewer = ensureLinkedViewer(target.session);
        viewerFocusPane(viewer, target.windowIndex, target.paneIndex);
        viewerZoomToPane(viewer, target.windowIndex, target.paneIndex);
        if (activeViewer !== viewer) {
          attachRightSlotToViewer(viewer, target.cwd ?? null);
          if (activeViewer !== null) killLinkedViewer(activeViewer);
          activeViewer = viewer;
        }
        activeTarget = target;
      } catch (err) {
        if (!(err instanceof TmuxError)) throw err;
        // Swallow; next cursor move retries.
      }
    },

    onCursorAway() {
      if (activeViewer === null && activeTarget === null) return;
      try {
        resetRightSlotToPlaceholder();
      } catch (err) {
        if (!(err instanceof TmuxError)) throw err;
      }
      if (activeViewer !== null) {
        try {
          killLinkedViewer(activeViewer);
        } catch (err) {
          if (!(err instanceof TmuxError)) throw err;
        }
        activeViewer = null;
      }
      activeTarget = null;
    },

    focusAgent() {
      if (activeViewer === null) return;
      try {
        focusRightSlot();
      } catch (err) {
        if (!(err instanceof TmuxError)) throw err;
      }
    },

    shutdown() {
      try {
        cleanupOrphanViewers();
      } catch (err) {
        if (!(err instanceof TmuxError)) throw err;
      }
      try {
        killMonitorSession();
      } catch (err) {
        if (!(err instanceof TmuxError)) throw err;
      }
      activeViewer = null;
      activeTarget = null;
    },
  };
}
