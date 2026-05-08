/**
 * Per-session header color.
 *
 * Each tmux session in the sidebar gets a stable color derived from
 * its name, so users can scan-by-color when several sessions are
 * open. Hash is deterministic across launches: `sum(char codes)`
 * folded with djb2's classic `*33` rotation, then mod palette
 * length. The same session name always lands on the same color.
 *
 * Mirrors cmux's per-workspace color idiom (issue #1753 in the
 * cmux repo) but auto-derives the color rather than asking the
 * user to pick one. If we ever surface a config knob, this is the
 * extension point.
 *
 * Palette is hand-picked to be:
 *   - tokyo-night-compatible (the rest of the TUI is tokyo-night).
 *   - distinct from STATE_COLORS so a section header never reads
 *     as a state pill (working/idle/error/etc.).
 *   - desaturated enough that bold + colored doesn't shout over
 *     the row content.
 */

/**
 * Hand-picked 8-color palette. Order is fixed; the index returned
 * by `sessionHeaderColor` is `hash % PALETTE.length`, so reordering
 * would shift every existing session's color.
 */
export const SESSION_HEADER_PALETTE: readonly string[] = [
  "#BB9AF7", // soft purple
  "#2AC3DE", // teal
  "#C3E88D", // pale lime
  "#FFC777", // peach
  "#F78C6C", // coral
  "#B4BEFE", // pale periwinkle
  "#F5C2E7", // pink
  "#94E2D5", // mint
];

/**
 * Stable color for a session header, derived from `name` via a djb2
 * hash. Empty / very short names still get a deterministic color
 * (the empty-name case lands on PALETTE[0]).
 */
export function sessionHeaderColor(name: string): string {
  let hash = 5381; // djb2 seed.
  for (let i = 0; i < name.length; i++) {
    // djb2: hash * 33 + c, masked to 32-bit unsigned.
    hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  }
  return SESSION_HEADER_PALETTE[hash % SESSION_HEADER_PALETTE.length] as string;
}
