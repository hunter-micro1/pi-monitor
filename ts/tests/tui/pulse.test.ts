/**
 * Pulse-color math tests. Pure functions \u2014 no Ink.
 */

import { describe, expect, it } from "vitest";

import { STATE_COLORS, WORKING_PULSE_DIM } from "../../src/tui/colors.js";
import { PULSE_PERIOD_S, lerpColor, pulseColor } from "../../src/tui/pulse.js";

describe("lerpColor", () => {
  it("returns `from` at fraction 0", () => {
    expect(lerpColor("#000000", "#ff00ff", 0).toLowerCase()).toBe("#000000");
  });

  it("returns `to` at fraction 1", () => {
    expect(lerpColor("#000000", "#ff00ff", 1).toLowerCase()).toBe("#ff00ff");
  });

  it("midpoint averages each channel", () => {
    expect(lerpColor("#000000", "#ffffff", 0.5).toLowerCase()).toBe("#808080");
  });

  it("clamps fraction to [0, 1]", () => {
    expect(lerpColor("#000000", "#ffffff", -1).toLowerCase()).toBe("#000000");
    expect(lerpColor("#000000", "#ffffff", 2).toLowerCase()).toBe("#ffffff");
  });

  it("tolerates 3-digit hex shorthand", () => {
    expect(lerpColor("#fff", "#000", 0.5).toLowerCase()).toBe("#808080");
  });
});

describe("pulseColor", () => {
  it("at t=t0 the sin is 0 -> fraction 0.70 -> partway between dim and bright", () => {
    const out = pulseColor(0, 0).toLowerCase();
    // Should be a hex \u2014 not throw, not equal either endpoint.
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    expect(out).not.toBe(WORKING_PULSE_DIM.toLowerCase());
    expect(out).not.toBe(STATE_COLORS.working.toLowerCase());
  });

  it("at t=t0 + PERIOD/4 we hit the bright peak (fraction 1.00)", () => {
    const out = pulseColor(PULSE_PERIOD_S / 4, 0).toLowerCase();
    expect(out).toBe(STATE_COLORS.working.toLowerCase());
  });

  it("at t=t0 + 3*PERIOD/4 we hit the dim trough (fraction 0.40)", () => {
    const out = pulseColor((3 * PULSE_PERIOD_S) / 4, 0).toLowerCase();
    // fraction 0.4 \u2014 not equal to dim or bright endpoint, but lies
    // 40% of the way from dim toward bright.
    const expected = lerpColor(
      WORKING_PULSE_DIM,
      STATE_COLORS.working,
      0.4,
    ).toLowerCase();
    expect(out).toBe(expected);
  });

  it("is periodic (out at t == out at t + PERIOD)", () => {
    const a = pulseColor(0.123, 0);
    const b = pulseColor(0.123 + PULSE_PERIOD_S, 0);
    expect(a).toBe(b);
  });

  it("handles a tStart in the future (negative elapsed)", () => {
    // Should still produce a valid hex; mod-arithmetic handles
    // negative values.
    const out = pulseColor(0, 1.0);
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
  });
});
