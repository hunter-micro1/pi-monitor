/**
 * Spinner-frame contract test.
 *
 * Pins the exact 10-frame Braille set + the 80ms cadence to keep
 * pi-monitor's working indicator visually identical to pi's own
 * Loader component (`@mariozechner/pi-tui`). If pi changes its
 * default frames, this test stays green; the deliberate snapshot
 * here is "what pi-monitor renders today", not "what pi renders".
 */

import { describe, expect, it } from "vitest";

import { BRAILLE_FRAMES, SPINNER_INTERVAL_MS } from "../../src/tui/spinner.js";

describe("spinner", () => {
  it("ships exactly 10 frames", () => {
    expect(BRAILLE_FRAMES).toHaveLength(10);
  });

  it("matches pi-tui's DEFAULT_FRAMES verbatim", () => {
    expect([...BRAILLE_FRAMES]).toEqual([
      "\u280b",
      "\u2819",
      "\u2839",
      "\u2838",
      "\u283c",
      "\u2834",
      "\u2826",
      "\u2827",
      "\u2807",
      "\u280f",
    ]);
  });

  it("uses the same 80ms cadence pi-tui uses", () => {
    expect(SPINNER_INTERVAL_MS).toBe(80);
  });

  it("each frame is a single Braille code point", () => {
    for (const f of BRAILLE_FRAMES) {
      expect([...f]).toHaveLength(1);
      const cp = f.codePointAt(0) ?? 0;
      // U+2800..U+28FF is the Braille Patterns block.
      expect(cp).toBeGreaterThanOrEqual(0x2800);
      expect(cp).toBeLessThanOrEqual(0x28ff);
    }
  });
});
