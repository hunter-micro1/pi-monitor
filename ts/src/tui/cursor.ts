/**
 * Cursor model for the App's selectable rows.
 *
 * Mirrors the Python `_cursor_positions` / `_cursor_idx` machinery in
 * `tui.py`. Implemented as a pure reducer so it's trivial to unit
 * test without an Ink render harness.
 *
 * Selectable positions in display order:
 *   - exactly one ("new",) at the top \u2014 the "+ new pi" affordance
 *   - one ("pane", pane_id) per visible pi pane, in the order the
 *     resolver returns them
 *
 * On the first render with any panes the cursor starts on the first
 * pane, not the new-affordance \u2014 same heuristic as the Python build
 * (matches cmux/Warp's "your first agent is already focused" UX).
 */

export type CursorPos =
  | { readonly kind: "new" }
  | { readonly kind: "pane"; readonly paneId: string };

export interface CursorState {
  readonly positions: readonly CursorPos[];
  readonly index: number;
  /**
   * False until we've seen at least one resolver tick with panes;
   * controls whether the next sync auto-jumps to the first pane.
   */
  readonly firstPaneAutoFocusDone: boolean;
}

export const INITIAL_CURSOR: CursorState = {
  positions: [{ kind: "new" }],
  index: 0,
  firstPaneAutoFocusDone: false,
};

export type CursorAction =
  /** New resolver entries arrived. Recompute positions, preserve selection. */
  | { type: "sync"; paneIds: readonly string[] }
  /** j / down. */
  | { type: "down" }
  /** k / up. */
  | { type: "up" }
  /** g \u2014 jump to top. */
  | { type: "top" }
  /** G \u2014 jump to bottom. */
  | { type: "bottom" }
  /** 1..9 \u2014 jump to nth pane (1-indexed; clamped to range). */
  | { type: "jump"; n: number };

export function cursorReducer(state: CursorState, action: CursorAction): CursorState {
  switch (action.type) {
    case "sync":
      return syncPositions(state, action.paneIds);
    case "down":
      return moveTo(state, state.index + 1);
    case "up":
      return moveTo(state, state.index - 1);
    case "top":
      return moveTo(state, 0);
    case "bottom":
      return moveTo(state, state.positions.length - 1);
    case "jump":
      return jumpTo(state, action.n);
    default: {
      // Exhaustiveness check — if a new action type is added,
      // TS errors here.
      action satisfies never;
      return state;
    }
  }
}

/** Returns the current position, or null if positions is empty. */
export function currentPos(state: CursorState): CursorPos | null {
  return state.positions[state.index] ?? null;
}

/**
 * Returns the pane-id under the cursor, or null when the cursor is
 * on the "new" row or out of bounds.
 */
export function currentPaneId(state: CursorState): string | null {
  const pos = currentPos(state);
  return pos !== null && pos.kind === "pane" ? pos.paneId : null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function syncPositions(state: CursorState, paneIds: readonly string[]): CursorState {
  const positions: CursorPos[] = [{ kind: "new" }];
  for (const id of paneIds) {
    positions.push({ kind: "pane", paneId: id });
  }

  // Try to preserve the user's selection across resolver ticks. If the
  // previous pane disappeared, fall back to the first pane (or the
  // "new" affordance if there are no panes left).
  const prev = currentPos(state);
  let index = 0;

  if (prev !== null) {
    if (prev.kind === "new") {
      // User was on "+ new pi". Keep them there only if no panes
      // exist yet, OR if they've explicitly landed there before \u2014
      // i.e. firstPaneAutoFocusDone is true.
      if (paneIds.length === 0 || state.firstPaneAutoFocusDone) {
        index = 0; // "new" stays first
      } else {
        index = 1; // first pane
      }
    } else {
      // User was on a pane. Find it again; otherwise jump to the
      // first pane (or "new" if none).
      const foundIdx = positions.findIndex(
        (p) => p.kind === "pane" && p.paneId === prev.paneId,
      );
      if (foundIdx >= 0) {
        index = foundIdx;
      } else if (paneIds.length > 0) {
        index = 1;
      } else {
        index = 0;
      }
    }
  } else if (paneIds.length > 0) {
    index = 1;
  }

  return {
    positions,
    index,
    firstPaneAutoFocusDone: state.firstPaneAutoFocusDone || paneIds.length > 0,
  };
}

function moveTo(state: CursorState, target: number): CursorState {
  if (state.positions.length === 0) return state;
  const clamped = Math.max(0, Math.min(target, state.positions.length - 1));
  if (clamped === state.index) return state;
  return { ...state, index: clamped };
}

function jumpTo(state: CursorState, n: number): CursorState {
  if (n < 1) return state;
  // Find the nth pane position (1-indexed; the "new" row at index 0
  // doesn't count toward the count). Clamps to the last pane if n
  // overshoots.
  const paneIndices: number[] = [];
  for (let i = 0; i < state.positions.length; i++) {
    if (state.positions[i]?.kind === "pane") paneIndices.push(i);
  }
  if (paneIndices.length === 0) return state;
  const target = Math.min(n - 1, paneIndices.length - 1);
  return moveTo(state, paneIndices[target] as number);
}
