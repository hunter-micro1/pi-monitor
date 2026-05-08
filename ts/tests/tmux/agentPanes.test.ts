/**
 * selectAgentPanes — three filter rules:
 *   1. drop ownPaneIds (panes living in the monitor session)
 *   2. drop viewer-prefixed session sisters (`pi-monitor-view-*`)
 *   3. dedupe by paneId (catches non-viewer-prefixed sisters
 *      that tmux session-groups still report twice)
 */

import { describe, expect, it } from "vitest";

import { type PaneLike, selectAgentPanes } from "../../src/tmux/agentPanes.js";

const NO_OWN: ReadonlySet<string> = new Set();

describe("selectAgentPanes", () => {
  it("preserves non-overlapping panes in input order", () => {
    const panes: PaneLike[] = [
      { paneId: "%1", session: "apps" },
      { paneId: "%2", session: "apps" },
      { paneId: "%3", session: "other" },
    ];
    expect(selectAgentPanes(panes, NO_OWN)).toEqual(panes);
  });

  it("drops panes whose paneId is in ownPaneIds", () => {
    const panes: PaneLike[] = [
      { paneId: "%1", session: "apps" },
      { paneId: "%99", session: "monitor" },
      { paneId: "%2", session: "apps" },
    ];
    const result = selectAgentPanes(panes, new Set(["%99"]));
    expect(result.map((p) => p.paneId)).toEqual(["%1", "%2"]);
  });

  it("drops panes living under a `pi-monitor-view-*` session", () => {
    const panes: PaneLike[] = [
      { paneId: "%1", session: "apps" },
      { paneId: "%2", session: "pi-monitor-view-apps" },
    ];
    const result = selectAgentPanes(panes, NO_OWN);
    expect(result.map((p) => p.paneId)).toEqual(["%1"]);
  });

  it("dedupes by paneId — first session-name occurrence wins", () => {
    // Reproduces the user-reported bug: pane %11 reported under
    // `pi-9` AND `pi-9-13` because tmux session-grouping put
    // them in the same group. The viewer-prefix rule doesn't
    // catch `pi-9-13` (no `pi-monitor-view-` prefix).
    const panes: PaneLike[] = [
      { paneId: "%11", session: "pi-9" },
      { paneId: "%11", session: "pi-9-13" },
    ];
    const result = selectAgentPanes(panes, NO_OWN);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ paneId: "%11", session: "pi-9" });
  });

  it("applies all three rules together", () => {
    const panes: PaneLike[] = [
      { paneId: "%1", session: "apps" }, // keep
      { paneId: "%99", session: "monitor" }, // drop (own)
      { paneId: "%1", session: "pi-monitor-view-apps" }, // drop (viewer + dup)
      { paneId: "%2", session: "pi-9" }, // keep
      { paneId: "%2", session: "pi-9-13" }, // drop (dup)
      { paneId: "%3", session: "pi-monitor-view-apps" }, // drop (viewer)
    ];
    const result = selectAgentPanes(panes, new Set(["%99"]));
    expect(result.map((p) => `${p.paneId}@${p.session}`)).toEqual([
      "%1@apps",
      "%2@pi-9",
    ]);
  });

  it("returns an empty array when all panes are filtered out", () => {
    const panes: PaneLike[] = [
      { paneId: "%99", session: "monitor" },
      { paneId: "%50", session: "pi-monitor-view-x" },
    ];
    expect(selectAgentPanes(panes, new Set(["%99"]))).toEqual([]);
  });

  it("is order-stable for repeated paneIds across sessions", () => {
    // Same paneId in three sessions — the FIRST one wins.
    const panes: PaneLike[] = [
      { paneId: "%5", session: "real" },
      { paneId: "%5", session: "sister-a" },
      { paneId: "%5", session: "sister-b" },
    ];
    const result = selectAgentPanes(panes, NO_OWN);
    expect(result).toHaveLength(1);
    expect(result[0]?.session).toBe("real");
  });
});
