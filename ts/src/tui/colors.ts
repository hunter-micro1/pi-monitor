/**
 * Theme palette for the Ink TUI.
 *
 * The Python build's Textual layer pulls these from the live theme on
 * every cycle (`_refresh_state_colors` mutates module globals). Ink
 * doesn't have a CSS theme system, so for phase 4 we pin the same
 * tokyo-night-style hex values the Python build uses post-cycle as a
 * reasonable default. Theme cycling lands in a follow-up if needed
 * \u2014 for now this static palette covers the visual parity check.
 *
 * Hex strings (no `#`-stripping) so they pass straight through to
 * Ink's `<Text color>` prop.
 */

import type { AgentState } from "../state/types.js";

/** Brand accent. Used for headers, selected affordance, and hint keys. */
export const ACCENT = "#7AA2F7";

/** Default foreground for body text. */
export const FOREGROUND = "#C0CAF5";

/** Muted foreground for inactive rows + dim metadata. */
export const FOREGROUND_MUTED = "#9AA5CE";

/** Bright background tint used for the cursor row's highlight bar. */
export const SELECTION_BG = "#3B4261";

/**
 * Per-state foreground colors. Same intent as STATE_COLORS in the
 * Python build (success / warning / error semantics) but with hex
 * values pinned for the Ink renderer.
 */
export const STATE_COLORS: Record<AgentState, string> = {
  working: "#9ECE6A",
  idle: "#E0AF68",
  error: "#F7768E",
  waiting: "#FF9E64",
  retrying: "#7DCFFF",
  unknown: "#737AA2",
  no_pi: "#414868",
};

/**
 * Pulse-end (dim) value for the WORKING animation. Lerped against
 * STATE_COLORS.working at the brightness floor of the sine wave.
 *
 * Same role as `WORKING_PULSE_DIM` in the Python build, but the
 * Python value is recomputed per-theme; ours is static for now.
 */
export const WORKING_PULSE_DIM = "#3D4D2E";
