/**
 * Curated theme palettes for the Ink TUI.
 *
 * The Python build pulls these from Textual's live theme system on
 * every `t` cycle (`_refresh_state_colors` reads
 * `current_theme.to_color_system().generate()`). Ink has no theme
 * engine, so we hardcode the canonical palette for each curated
 * theme here and switch the active `Theme` object on `t`.
 *
 * Each palette maps to the same roles the Python build derives:
 *   accent          ← theme `primary`   (brand text, card borders, hints)
 *   foreground      ← theme `foreground`
 *   foregroundMuted ← theme `foreground-muted`
 *   selectionBg     ← a mid surface tone for the cursor-row highlight
 *   background      ← theme `background` (deepest base; pulse-dim lerp end)
 *   state.working   ← `success`
 *   state.idle      ← `warning`
 *   state.error     ← `error`
 *   state.waiting   ← warm orange (heartbeat: blocked on user)
 *   state.retrying  ← steel blue  (heartbeat: auto-retry in flight)
 *   workingPulseDim ← dim end of the working-title breathe
 *
 * Hex strings (with `#`) so they pass straight to Ink's `color` /
 * `backgroundColor` props.
 */

import type { AgentState } from "../state/types.js";

export interface Theme {
  /** Stable id; one of THEME_CYCLE. Persisted to config. */
  readonly name: string;
  readonly accent: string;
  readonly foreground: string;
  readonly foregroundMuted: string;
  readonly selectionBg: string;
  readonly background: string;
  readonly workingPulseDim: string;
  readonly state: Readonly<Record<AgentState, string>>;
}

/**
 * Curated theme set. Order is the `t`-cycle order; the first entry
 * is the default. Mirrors the curated head of `THEMES` in `tui.py`
 * ("curated for translucency — these stay legible over a wallpaper").
 */
export const THEMES: Readonly<Record<string, Theme>> = {
  "tokyo-night": {
    name: "tokyo-night",
    accent: "#7AA2F7",
    foreground: "#C0CAF5",
    foregroundMuted: "#9AA5CE",
    selectionBg: "#2E3C64",
    background: "#1A1B26",
    workingPulseDim: "#3D4D2E",
    state: {
      working: "#9ECE6A",
      idle: "#E0AF68",
      error: "#F7768E",
      waiting: "#FF9E64",
      retrying: "#7DCFFF",
      unknown: "#565F89",
      no_pi: "#414868",
    },
  },
  "catppuccin-mocha": {
    name: "catppuccin-mocha",
    accent: "#89B4FA",
    foreground: "#CDD6F4",
    foregroundMuted: "#A6ADC8",
    selectionBg: "#45475A",
    background: "#1E1E2E",
    workingPulseDim: "#3F5840",
    state: {
      working: "#A6E3A1",
      idle: "#F9E2AF",
      error: "#F38BA8",
      waiting: "#FAB387",
      retrying: "#89DCEB",
      unknown: "#6C7086",
      no_pi: "#313244",
    },
  },
  dracula: {
    name: "dracula",
    accent: "#BD93F9",
    foreground: "#F8F8F2",
    foregroundMuted: "#6272A4",
    selectionBg: "#44475A",
    background: "#282A36",
    workingPulseDim: "#2C6F45",
    state: {
      working: "#50FA7B",
      idle: "#F1FA8C",
      error: "#FF5555",
      waiting: "#FFB86C",
      retrying: "#8BE9FD",
      unknown: "#6272A4",
      no_pi: "#383A46",
    },
  },
  gruvbox: {
    name: "gruvbox",
    accent: "#83A598",
    foreground: "#EBDBB2",
    foregroundMuted: "#A89984",
    selectionBg: "#3C3836",
    background: "#282828",
    workingPulseDim: "#5A5C20",
    state: {
      working: "#B8BB26",
      idle: "#FABD2F",
      error: "#FB4934",
      waiting: "#FE8019",
      retrying: "#8EC07C",
      unknown: "#928374",
      no_pi: "#32302F",
    },
  },
  "textual-dark": {
    name: "textual-dark",
    accent: "#0178D4",
    foreground: "#E0E0E0",
    foregroundMuted: "#A0A0A0",
    selectionBg: "#303030",
    background: "#1E1E1E",
    workingPulseDim: "#2F7544",
    state: {
      working: "#4EBF71",
      idle: "#FFA62B",
      error: "#BA3C5B",
      waiting: "#DE935F",
      retrying: "#81A2BE",
      unknown: "#808080",
      no_pi: "#505050",
    },
  },
};

/** `t`-cycle order, matching the curated head of `THEMES` in tui.py. */
export const THEME_CYCLE: readonly string[] = [
  "tokyo-night",
  "catppuccin-mocha",
  "dracula",
  "gruvbox",
  "textual-dark",
];

/** Default theme (matches the README screenshot). */
export const DEFAULT_THEME = "tokyo-night";

/**
 * Validate a theme name from config; fall back to the default if it
 * isn't one we ship (typo, removed theme, a Textual theme the Python
 * build supports but the Ink build doesn't). Mirrors `_resolve_theme`
 * in tui.py.
 */
export function resolveTheme(name: string | undefined | null): string {
  return name != null && name in THEMES ? name : DEFAULT_THEME;
}

/** Look up a Theme by name, falling back to the default. */
export function themeByName(name: string | undefined | null): Theme {
  return THEMES[resolveTheme(name)] as Theme;
}

/** Next theme name in the curated cycle (wraps). Mirrors action_cycle_theme. */
export function nextTheme(name: string): string {
  const idx = THEME_CYCLE.indexOf(resolveTheme(name));
  return THEME_CYCLE[(idx + 1) % THEME_CYCLE.length] as string;
}
