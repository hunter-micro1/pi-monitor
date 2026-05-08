/**
 * Per-session header color contract.
 *
 * Pins the palette + hash stability so a session that landed on
 * (e.g.) "purple" yesterday still lands on "purple" today. Color
 * choice is allowed to drift between releases, but only via a
 * deliberate palette edit \u2014 never via accidental hash drift.
 */

import { describe, expect, it } from "vitest";

import {
  SESSION_HEADER_PALETTE,
  sessionHeaderColor,
} from "../../src/tui/sessionColors.js";

describe("sessionHeaderColor", () => {
  it("ships exactly 8 palette entries", () => {
    expect(SESSION_HEADER_PALETTE).toHaveLength(8);
  });

  it("every palette entry is a valid 7-char hex color", () => {
    for (const c of SESSION_HEADER_PALETTE) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("returns a palette entry for any session name", () => {
    for (const name of ["", "a", "main", "powerbi", "agent/main-20260508"]) {
      expect(SESSION_HEADER_PALETTE).toContain(sessionHeaderColor(name));
    }
  });

  it("is stable: same input always yields the same color", () => {
    expect(sessionHeaderColor("contracts")).toBe(sessionHeaderColor("contracts"));
    expect(sessionHeaderColor("powerbi")).toBe(sessionHeaderColor("powerbi"));
  });

  it("distributes across the palette for a typical session set", () => {
    // Five distinct workspace-style names should land on at least
    // 3 distinct colors (loose check; we don't want all 5 to hash
    // to the same bucket on the curated palette size).
    const names = ["apps", "monitor", "powerbi", "agent", "contracts"];
    const colors = new Set(names.map(sessionHeaderColor));
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  it("empty name lands on PALETTE[5] (djb2 seed 5381 % 8 = 5)", () => {
    // Pinned so refactoring the hash doesn't silently shift it.
    expect(sessionHeaderColor("")).toBe(SESSION_HEADER_PALETTE[5]);
  });
});
