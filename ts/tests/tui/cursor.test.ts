/**
 * Cursor reducer tests. Pure function \u2014 no Ink harness needed.
 */

import { describe, expect, it } from "vitest";

import {
  type CursorState,
  INITIAL_CURSOR,
  currentPaneId,
  currentPos,
  cursorReducer,
} from "../../src/tui/cursor.js";

function sync(state: CursorState, paneIds: string[]): CursorState {
  return cursorReducer(state, { type: "sync", paneIds });
}

function down(state: CursorState): CursorState {
  return cursorReducer(state, { type: "down" });
}

function up(state: CursorState): CursorState {
  return cursorReducer(state, { type: "up" });
}

describe("INITIAL_CURSOR", () => {
  it("starts on the 'new' affordance with one position", () => {
    expect(INITIAL_CURSOR.index).toBe(0);
    expect(INITIAL_CURSOR.positions).toHaveLength(1);
    expect(INITIAL_CURSOR.positions[0]?.kind).toBe("new");
  });
});

describe("sync", () => {
  it("auto-jumps to the first pane on the first sync with panes", () => {
    const next = sync(INITIAL_CURSOR, ["%1", "%2"]);
    expect(next.positions).toHaveLength(3);
    expect(next.index).toBe(1);
    expect(currentPaneId(next)).toBe("%1");
    expect(next.firstPaneAutoFocusDone).toBe(true);
  });

  it("keeps the user on 'new' when there are no panes yet", () => {
    const next = sync(INITIAL_CURSOR, []);
    expect(next.index).toBe(0);
    expect(next.positions).toHaveLength(1);
    expect(currentPos(next)?.kind).toBe("new");
    expect(next.firstPaneAutoFocusDone).toBe(false);
  });

  it("preserves the selected pane across resyncs", () => {
    const a = sync(INITIAL_CURSOR, ["%1", "%2", "%3"]);
    // Simulate the user pressing j twice (go to %3).
    const moved = down(down(a));
    expect(currentPaneId(moved)).toBe("%3");

    // %2 disappears; %1 and %3 remain.
    const b = sync(moved, ["%1", "%3"]);
    expect(currentPaneId(b)).toBe("%3");
  });

  it("falls back to the first pane when the selected pane disappears", () => {
    const a = sync(INITIAL_CURSOR, ["%1", "%2"]);
    const moved = down(a); // -> %2
    expect(currentPaneId(moved)).toBe("%2");

    const b = sync(moved, ["%1"]); // %2 is gone
    expect(currentPaneId(b)).toBe("%1");
  });

  it("falls back to 'new' when every pane disappears", () => {
    const a = sync(INITIAL_CURSOR, ["%1"]);
    const b = sync(a, []);
    expect(b.index).toBe(0);
    expect(currentPos(b)?.kind).toBe("new");
  });

  it("respects firstPaneAutoFocusDone (user moves back to 'new', resync keeps them)", () => {
    const a = sync(INITIAL_CURSOR, ["%1", "%2"]); // -> idx 1 (auto)
    const back = up(a); // -> idx 0 ("new")
    expect(currentPos(back)?.kind).toBe("new");
    // Resync: cursor should stay on 'new' since auto-focus already
    // happened once.
    const b = sync(back, ["%1", "%2"]);
    expect(currentPos(b)?.kind).toBe("new");
  });
});

describe("up / down", () => {
  it("clamps at the boundaries", () => {
    const a = sync(INITIAL_CURSOR, ["%1", "%2"]);
    expect(a.index).toBe(1);
    const beyond = down(down(down(a)));
    expect(beyond.index).toBe(2); // last position
    const below = up(up(up(a)));
    expect(below.index).toBe(0); // first position
  });
});

describe("top / bottom", () => {
  it("jumps to first / last selectable position", () => {
    const a = sync(INITIAL_CURSOR, ["%1", "%2", "%3"]);
    const top = cursorReducer(a, { type: "top" });
    const bottom = cursorReducer(a, { type: "bottom" });
    expect(top.index).toBe(0);
    expect(bottom.index).toBe(3);
    expect(currentPaneId(bottom)).toBe("%3");
  });
});

describe("jump n", () => {
  it("jumps to the nth pane (1-indexed)", () => {
    const a = sync(INITIAL_CURSOR, ["%1", "%2", "%3"]);
    expect(currentPaneId(cursorReducer(a, { type: "jump", n: 1 }))).toBe("%1");
    expect(currentPaneId(cursorReducer(a, { type: "jump", n: 2 }))).toBe("%2");
    expect(currentPaneId(cursorReducer(a, { type: "jump", n: 3 }))).toBe("%3");
  });

  it("clamps n past the last pane", () => {
    const a = sync(INITIAL_CURSOR, ["%1", "%2"]);
    expect(currentPaneId(cursorReducer(a, { type: "jump", n: 9 }))).toBe("%2");
  });

  it("is a no-op when there are no panes", () => {
    const a = sync(INITIAL_CURSOR, []);
    const b = cursorReducer(a, { type: "jump", n: 1 });
    expect(b).toBe(a);
  });

  it("rejects n < 1", () => {
    const a = sync(INITIAL_CURSOR, ["%1"]);
    const b = cursorReducer(a, { type: "jump", n: 0 });
    expect(b).toBe(a);
  });
});

describe("currentPaneId", () => {
  it("returns null when the cursor is on 'new'", () => {
    expect(currentPaneId(INITIAL_CURSOR)).toBeNull();
  });
});
