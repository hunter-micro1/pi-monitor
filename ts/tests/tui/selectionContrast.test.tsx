/**
 * Selection-contrast regression tests.
 *
 * The bug: the cursor row paints `theme.selectionBg` under text that
 * also carried `dimColor` on top of `theme.foregroundMuted`. Muted +
 * ANSI dim (SGR 2) over that highlight rendered as unreadable
 * near-black. Separately, dark state tints (`no_agent` at `#414868`)
 * sit at ~1.2:1 against the highlight and disappear outright.
 *
 * These assert the colour decisions directly rather than sniffing
 * ANSI, so they hold regardless of whether the test runner has colour
 * enabled.
 */

import { describe, expect, it } from "vitest";

import { rowTextStyles } from "../../src/tui/PaneRow.js";
import { MIN_SELECTION_CONTRAST, contrastRatio } from "../../src/tui/contrast.js";
import { THEMES, themeByName } from "../../src/tui/themes.js";

describe("rowTextStyles", () => {
  const theme = themeByName("tokyo-night");

  it("drops the dim attribute on the selected row", () => {
    expect(rowTextStyles(true, theme).descDim).toBe(false);
  });

  it("keeps dim + muted on unselected rows so they still recede", () => {
    const styles = rowTextStyles(false, theme);
    expect(styles.descDim).toBe(true);
    expect(styles.descColor).toBe(theme.foregroundMuted);
  });

  it("uses full foreground for the selected row's description", () => {
    expect(rowTextStyles(true, theme).descColor).toBe(theme.foreground);
  });

  it("selected description reads acceptably on the highlight", () => {
    const { descColor } = rowTextStyles(true, theme);
    const ratio = contrastRatio(descColor, theme.selectionBg) as number;
    expect(ratio).toBeGreaterThanOrEqual(MIN_SELECTION_CONTRAST);
  });
});

describe("every theme keeps selected-row text readable", () => {
  it.each(Object.keys(THEMES))("%s: description on selectionBg", (name) => {
    const theme = THEMES[name];
    if (theme === undefined) throw new Error(`missing theme ${name}`);
    const { descColor } = rowTextStyles(true, theme);
    const ratio = contrastRatio(descColor, theme.selectionBg) as number;
    expect(ratio).toBeGreaterThanOrEqual(MIN_SELECTION_CONTRAST);
  });

  it.each(Object.keys(THEMES))("%s: every state tint survives lifting", (name) => {
    const theme = THEMES[name];
    if (theme === undefined) throw new Error(`missing theme ${name}`);
    const { lift } = rowTextStyles(true, theme);
    for (const [state, tint] of Object.entries(theme.state)) {
      const ratio = contrastRatio(lift(tint), theme.selectionBg) as number;
      expect(ratio, `${name}/${state}`).toBeGreaterThanOrEqual(MIN_SELECTION_CONTRAST);
    }
  });
});
