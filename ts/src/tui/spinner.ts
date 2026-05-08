/**
 * Braille-spinner frames for the working-row indicator.
 *
 * Same 10-frame animation pi itself uses for its `Loader` component
 * (`@mariozechner/pi-tui/components/loader.ts`'s DEFAULT_FRAMES).
 * Reusing the exact glyphs + cadence keeps the visual idiom
 * consistent: when a user sees "spinner = pi is doing something" in
 * the agent terminal, the same glyph in pi-monitor's sidebar means
 * the same thing.
 *
 * Pure data so the test pins the contract; the App wires this into
 * its existing 80ms pulse interval (no second timer needed).
 */
export const BRAILLE_FRAMES = [
  "\u280b", // \u280b
  "\u2819", // \u2819
  "\u2839", // \u2839
  "\u2838", // \u2838
  "\u283c", // \u283c
  "\u2834", // \u2834
  "\u2826", // \u2826
  "\u2827", // \u2827
  "\u2807", // \u2807
  "\u280f", // \u280f
] as const;

/** Frame interval in milliseconds. Matches pi-tui's DEFAULT_INTERVAL_MS. */
export const SPINNER_INTERVAL_MS = 80;
