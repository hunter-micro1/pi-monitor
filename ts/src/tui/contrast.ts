/**
 * Minimum-contrast helper for the selection highlight.
 *
 * Row text colours are chosen for their meaning (session identity,
 * agent state) against a transparent background. The cursor row swaps
 * in `theme.selectionBg` underneath them, and several of those
 * meaningful colours are dark by design — `no_agent` is `#414868`,
 * which lands at a ~1.2:1 ratio on tokyo-night's `#2E3C64`
 * highlight and simply disappears.
 *
 * Rather than hand-tune a second palette per theme, we measure and
 * substitute only when a colour actually fails.
 */

/** Parse `#rrggbb` (or `#rgb`) into 0-255 channels; null if unparseable. */
function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  let body = m[1] as string;
  if (body.length === 3) {
    body = `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ];
}

/** sRGB channel -> linear, per WCAG 2.x. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white). Returns `null` for
 * colours we can't parse (named colours, ANSI indices) so callers can
 * leave those alone rather than guess.
 */
export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (rgb === null) return null;
  const [r, g, b] = rgb;
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * WCAG contrast ratio between two colours, 1 (identical) to 21
 * (black on white). `null` when either colour is unparseable.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Minimum ratio we accept for row text on the selection highlight.
 *
 * 3.0 is WCAG AA for large/bold text. Terminal rows are small, but
 * these are decorative state tints rather than body copy, and holding
 * them to 4.5 would replace most of the palette on the cursor row and
 * lose the colour coding entirely. 3.0 keeps the hue where it can and
 * substitutes only where the colour is genuinely unreadable.
 */
export const MIN_SELECTION_CONTRAST = 3.0;

/**
 * Return `fg` when it reads acceptably on `bg`, otherwise `fallback`.
 *
 * Unparseable colours pass through untouched — we can only measure
 * hex, and silently swapping a colour we couldn't measure would be
 * worse than leaving it.
 */
export function ensureReadable(
  fg: string,
  bg: string,
  fallback: string,
  min: number = MIN_SELECTION_CONTRAST,
): string {
  const ratio = contrastRatio(fg, bg);
  if (ratio === null) return fg;
  return ratio >= min ? fg : fallback;
}
