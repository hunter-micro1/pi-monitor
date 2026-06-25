/**
 * Session "card" containing one tmux session's pi panes.
 *
 * Visual model (matches the README screenshot / the Python build's
 * `SessionGroup` widget): a rounded border box with the session name
 * as the border title. The cursor's card lights its border up to the
 * solid accent; inactive cards render the same accent dimmed.
 *
 * Ink's `<Box>` has no border-title prop, so we draw the top edge
 * manually as a `╭─ name ──…──╮` line and let a borderTop={false}
 * box supply the left/right/bottom edges + corners beneath it. The
 * two pieces share an explicit `width` so the manual corners line up
 * with the box's vertical borders.
 *
 * Fill stays transparent so the terminal's translucency / wallpaper
 * bleeds through inside the card, same as the Python build.
 */

import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import { fmtSessionHeader } from "../format/row.js";
import { useTheme } from "./ThemeContext.js";

export interface SessionGroupProps {
  /** Session name (border title). */
  session: string;
  /** True for the topmost card (skips the leading top margin). */
  first?: boolean;
  /**
   * True when the cursor is on a row inside this card. Brightens the
   * border + title to the solid accent (inactive cards render dim),
   * mirroring `.active-group` in the Python build.
   */
  active?: boolean;
  /** Total card width in columns (border-to-border). */
  width: number;
  /** PaneRow children. */
  children: ReactNode;
}

/**
 * Build the titled top border line: `╭─ <name> ──…──╮`, padded with
 * box-drawing dashes to exactly `width` columns. Falls back to a
 * plain top edge when the name would overflow the available width.
 */
function topBorderLine(name: string, width: number): string {
  const left = `\u256d\u2500 ${name} `;
  const right = "\u256e";
  const fillLen = width - left.length - right.length;
  if (fillLen < 0) {
    // Name too wide for this terminal: degrade to a plain top edge.
    return `\u256d${"\u2500".repeat(Math.max(0, width - 2))}\u256e`;
  }
  return `${left}${"\u2500".repeat(fillLen)}${right}`;
}

export function SessionGroup({
  session,
  first = false,
  active = false,
  width,
  children,
}: SessionGroupProps): ReactElement {
  const theme = useTheme();
  const title = fmtSessionHeader(session);
  return (
    <Box flexDirection="column" marginTop={first ? 0 : 1} width={width}>
      {/* Manual titled top edge. dimColor when this card isn't the
          cursor's card so the active card's border visibly "lights
          up" (Python's .active-group upgrade). */}
      <Text bold color={theme.accent} dimColor={!active}>
        {topBorderLine(title, width)}
      </Text>
      {/* Left/right/bottom edges + bottom corners. borderTop is off
          because the manual line above already drew the top + its
          corners. */}
      <Box
        flexDirection="column"
        width={width}
        borderStyle="round"
        borderColor={theme.accent}
        borderDimColor={!active}
        borderTop={false}
        paddingX={1}
      >
        {children}
      </Box>
    </Box>
  );
}
