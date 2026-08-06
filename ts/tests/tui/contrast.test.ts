/**
 * Contrast helper tests.
 *
 * The concrete numbers here come from the real palettes in
 * `themes.ts` — these are the pairs that actually render on a cursor
 * row, not synthetic ones.
 */

import { describe, expect, it } from "vitest";

import {
  MIN_SELECTION_CONTRAST,
  contrastRatio,
  ensureReadable,
  relativeLuminance,
} from "../../src/tui/contrast.js";
import { THEMES } from "../../src/tui/themes.js";

describe("relativeLuminance", () => {
  it("anchors at black and white", () => {
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
  });

  it("expands 3-digit hex", () => {
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 5);
  });

  it("returns null for values it cannot measure", () => {
    expect(relativeLuminance("red")).toBeNull();
    expect(relativeLuminance("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("gives 21 for black on white and 1 for identical colours", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#2E3C64", "#2E3C64")).toBeCloseTo(1, 5);
  });

  it("is order-independent", () => {
    const a = contrastRatio("#9AA5CE", "#2E3C64");
    const b = contrastRatio("#2E3C64", "#9AA5CE");
    expect(a).toBeCloseTo(b as number, 10);
  });

  it("scores the real failing pair below threshold", () => {
    // tokyo-night no_agent on tokyo-night selectionBg — the pair that
    // rendered as invisible text on the cursor row.
    const ratio = contrastRatio("#414868", "#2E3C64") as number;
    expect(ratio).toBeLessThan(MIN_SELECTION_CONTRAST);
  });
});

describe("ensureReadable", () => {
  it("keeps a colour that already reads well", () => {
    expect(ensureReadable("#C0CAF5", "#2E3C64", "#FFFFFF")).toBe("#C0CAF5");
  });

  it("substitutes the fallback when contrast is too low", () => {
    expect(ensureReadable("#414868", "#2E3C64", "#C0CAF5")).toBe("#C0CAF5");
  });

  it("passes through colours it cannot measure rather than guessing", () => {
    expect(ensureReadable("red", "#2E3C64", "#C0CAF5")).toBe("red");
  });
});

describe("every theme's foreground reads on its own selection highlight", () => {
  it.each(Object.keys(THEMES))("%s", (name) => {
    const theme = THEMES[name];
    if (theme === undefined) throw new Error(`missing theme ${name}`);
    const ratio = contrastRatio(theme.foreground, theme.selectionBg) as number;
    // The fallback colour must itself be readable, or substituting to
    // it would just move the problem.
    expect(ratio).toBeGreaterThanOrEqual(MIN_SELECTION_CONTRAST);
  });
});
