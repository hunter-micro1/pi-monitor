/**
 * SessionGroup snapshot tests + pickSessionChip unit tests.
 */

import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { AgentState } from "../../src/state/types.js";
import { SessionGroup, pickSessionChip } from "../../src/tui/SessionGroup.js";

describe("SessionGroup render", () => {
  it("renders the session name as a header followed by its rows", () => {
    const { lastFrame } = render(
      <SessionGroup session="contracts" first>
        <Text>row a</Text>
        <Text>row b</Text>
      </SessionGroup>,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("contracts");
    expect(out).toContain("row a");
    expect(out).toContain("row b");
    // Section ordering: header before rows.
    const headerIdx = out.indexOf("contracts");
    const rowAIdx = out.indexOf("row a");
    expect(headerIdx).toBeLessThan(rowAIdx);
  });

  it("renders a horizontal divider above non-first sections", () => {
    const { lastFrame } = render(
      <SessionGroup session="contracts">
        <Text>row</Text>
      </SessionGroup>,
    );
    // first=false (default) emits the divider; '─' is the box-
    // drawing horizontal line Ink renders for borderTop.
    expect(lastFrame() ?? "").toContain("\u2500");
  });

  it("omits the divider for the first section", () => {
    const { lastFrame } = render(
      <SessionGroup session="contracts" first>
        <Text>row</Text>
      </SessionGroup>,
    );
    expect(lastFrame() ?? "").not.toContain("\u2500");
  });

  it("renders the chip next to the title when one is provided", () => {
    const { lastFrame } = render(
      <SessionGroup session="powerbi" chip={{ count: 2, state: "idle" }}>
        <Text>row</Text>
      </SessionGroup>,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("powerbi");
    expect(out).toContain("2 idle");
  });

  it("hides the chip when none is provided", () => {
    const { lastFrame } = render(
      <SessionGroup session="solo">
        <Text>row</Text>
      </SessionGroup>,
    );
    const out = lastFrame() ?? "";
    expect(out).not.toMatch(/\d+\s+(idle|error|waiting|retrying|working)/);
  });

  it("works in active mode without throwing", () => {
    expect(() =>
      render(
        <SessionGroup session="x" active>
          <Text>row</Text>
        </SessionGroup>,
      ),
    ).not.toThrow();
  });
});

describe("pickSessionChip", () => {
  function s(state: AgentState): { state: AgentState } {
    return { state };
  }

  it("returns null when every pane is working", () => {
    expect(pickSessionChip([s("working"), s("working")])).toEqual({
      count: 2,
      state: "working",
    });
  });

  it("prioritizes errors over everything else", () => {
    const chip = pickSessionChip([s("idle"), s("error"), s("waiting"), s("retrying")]);
    expect(chip).toEqual({ count: 1, state: "error" });
  });

  it("prioritizes waiting over idle", () => {
    const chip = pickSessionChip([s("idle"), s("waiting"), s("idle")]);
    expect(chip).toEqual({ count: 1, state: "waiting" });
  });

  it("prioritizes idle over retrying", () => {
    const chip = pickSessionChip([s("idle"), s("retrying"), s("retrying")]);
    expect(chip).toEqual({ count: 1, state: "idle" });
  });

  it("returns null when there are no panes at all", () => {
    expect(pickSessionChip([])).toBeNull();
  });

  it("counts duplicates of the chosen state", () => {
    const chip = pickSessionChip([s("idle"), s("idle"), s("idle")]);
    expect(chip).toEqual({ count: 3, state: "idle" });
  });

  it("ignores unknown / no_pi states for chip-priority purposes", () => {
    const chip = pickSessionChip([s("unknown"), s("no_pi"), s("working")]);
    // No issue states at all; only working remains, so chip is the
    // working count.
    expect(chip).toEqual({ count: 1, state: "working" });
  });
});
