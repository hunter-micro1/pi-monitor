/**
 * Pulse-color computation for WORKING agent rows.
 *
 * Mirrors `_pulse_color` and `_lerp_color` in `tui.py`. The Python
 * build runs this on a 0.08s tick; we'll do the same. Pure functions
 * so unit tests can pin the math without an Ink harness.
 */

import { STATE_COLORS, WORKING_PULSE_DIM } from "./colors.js";

/** One full breath cycle (sec). Matches PULSE_PERIOD_S in tui.py. */
export const PULSE_PERIOD_S = 1.5;

/**
 * Lerp two `#RRGGBB` strings at `fraction` in [0, 1]. fraction=0
 * returns `from`; fraction=1 returns `to`. Linear in each channel
 * (matches the Python `_lerp_color`).
 */
export function lerpColor(from: string, to: string, fraction: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const f = clamp01(fraction);
  const r = Math.round(a.r + (b.r - a.r) * f);
  const g = Math.round(a.g + (b.g - a.g) * f);
  const bl = Math.round(a.b + (b.b - a.b) * f);
  return `#${toHex2(r)}${toHex2(g)}${toHex2(bl)}`;
}

/**
 * Compute the WORKING pulse color at time `tNow` (seconds), with
 * `tStart` set when the App mounted. Returns a `#RRGGBB` string
 * lerped between `dim` and `bright` over a sine wave with floor
 * fraction 0.40 and ceiling 1.00 (== 0.70 +/- 0.30 sin).
 *
 * `dim` / `bright` default to the static tokyo-night working colors
 * so callers (and tests) that don't thread a theme keep the previous
 * behavior. The App passes the active theme's `workingPulseDim` +
 * `state.working` so the breathe tracks the live palette, the way
 * `_refresh_state_colors` re-derives them per-theme in tui.py.
 *
 * Mirrors the formula in `_pulse_color`:
 *   elapsed = (now - t0) % PERIOD
 *   fraction = 0.70 + 0.30 * sin(2\u03c0 \u00b7 elapsed / PERIOD)
 */
export function pulseColor(
  tNow: number,
  tStart: number,
  dim: string = WORKING_PULSE_DIM,
  bright: string = STATE_COLORS.working,
): string {
  const elapsed =
    (((tNow - tStart) % PULSE_PERIOD_S) + PULSE_PERIOD_S) % PULSE_PERIOD_S;
  const fraction = 0.7 + 0.3 * Math.sin((2 * Math.PI * elapsed) / PULSE_PERIOD_S);
  return lerpColor(dim, bright, fraction);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseHex(s: string): { r: number; g: number; b: number } {
  // Tolerates `#RGB` and `#RRGGBB`.
  const stripped = s.startsWith("#") ? s.slice(1) : s;
  if (stripped.length === 3) {
    const r = parseHex2(stripped[0]! + stripped[0]!);
    const g = parseHex2(stripped[1]! + stripped[1]!);
    const b = parseHex2(stripped[2]! + stripped[2]!);
    return { r, g, b };
  }
  if (stripped.length === 6) {
    return {
      r: parseHex2(stripped.slice(0, 2)),
      g: parseHex2(stripped.slice(2, 4)),
      b: parseHex2(stripped.slice(4, 6)),
    };
  }
  // Fallback: black. The pulse animation degrading to "black" is
  // less bad than throwing in the render path.
  return { r: 0, g: 0, b: 0 };
}

function parseHex2(s: string): number {
  const n = Number.parseInt(s, 16);
  return Number.isNaN(n) ? 0 : n;
}

function toHex2(n: number): string {
  const c = Math.max(0, Math.min(255, Math.round(n)));
  return c.toString(16).padStart(2, "0");
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
