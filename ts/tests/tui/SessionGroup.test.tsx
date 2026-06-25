/**
 * SessionGroup card-render tests.
 *
 * The card is a rounded bordered box with the session name as its
 * border title (matches the README screenshot / the Python build).
 * ink-testing-library strips ANSI, so we assert on the box-drawing
 * characters + content placement rather than colors.
 */

import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { SessionGroup } from "../../src/tui/SessionGroup.js";

describe("SessionGroup render", () => {
  it("renders the session name in a titled top border above its rows", () => {
    const { lastFrame } = render(
      <SessionGroup session="contracts" width={44} first>
        <Text>row a</Text>
        <Text>row b</Text>
      </SessionGroup>,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("contracts");
    expect(out).toContain("row a");
    expect(out).toContain("row b");
    // Titled top edge: `╭─ contracts ──…──╮`.
    expect(out).toContain("\u256d\u2500 contracts ");
    // Bottom corners present (rounded box).
    expect(out).toContain("\u2570");
    expect(out).toContain("\u256f");
    // Header before rows.
    expect(out.indexOf("contracts")).toBeLessThan(out.indexOf("row a"));
  });

  it("draws a bordered box (left/right/bottom edges) around the rows", () => {
    const { lastFrame } = render(
      <SessionGroup session="cape" width={40}>
        <Text>row</Text>
      </SessionGroup>,
    );
    const out = lastFrame() ?? "";
    // Vertical edges + horizontal fill are always present for a card.
    expect(out).toContain("\u2502"); // │ side border
    expect(out).toContain("\u2500"); // ─ horizontal
  });

  it("renders both active and inactive cards without throwing", () => {
    expect(() =>
      render(
        <SessionGroup session="a" width={40} active>
          <Text>row</Text>
        </SessionGroup>,
      ),
    ).not.toThrow();
    expect(() =>
      render(
        <SessionGroup session="b" width={40} active={false}>
          <Text>row</Text>
        </SessionGroup>,
      ),
    ).not.toThrow();
  });

  it("degrades to a plain top edge when the name overflows the width", () => {
    const { lastFrame } = render(
      <SessionGroup session="a-very-long-session-name-that-overflows" width={12}>
        <Text>row</Text>
      </SessionGroup>,
    );
    // Should still render corners and not crash / wrap chaotically.
    const out = lastFrame() ?? "";
    expect(out).toContain("\u256d"); // top-left corner
    expect(out).toContain("\u256e"); // top-right corner
  });
});
