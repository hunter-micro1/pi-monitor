/**
 * One agent row inside a session card. Two visible lines:
 *
 *   line 1: ` <name> · <branch>`           left, `<state-tag>` right
 *   line 2: `   <state-dot> <activity description>` (dim)
 *
 * Selection model (matches the README screenshot / the Python build):
 *   - The cursor row gets a soft full-width selection background
 *     (`theme.selectionBg`) spanning both lines. That bg IS the
 *     cursor cue — there is no separate bar glyph.
 *   - Non-cursor rows render transparent so the terminal's
 *     translucency bleeds through.
 *
 * Per-session title color: non-working rows take the section's
 * hash-of-name `sessionColor`; working rows take the pulse color so
 * the active title visibly breathes. Falls back to the theme's muted
 * foreground when no `sessionColor` is threaded in.
 *
 * Working-row spinner: the right-side tag is prefixed with a Braille
 * spinner glyph the App threads in via `spinnerGlyph`; on the cursor
 * row it renders in the accent color.
 *
 * All colors come from the active {@link useTheme} palette so a `t`
 * theme cycle recolors every row.
 */

import { Box, Text } from "ink";
import { type ReactElement, memo } from "react";
import {
  type ActivityTag,
  activityDescription,
  activityTag,
  fmtRowMain,
  truncate,
} from "../format/row.js";
import type { PaneStatus } from "../state/types.js";
import { useTheme } from "./ThemeContext.js";

/**
 * Default inner-card width used when the App doesn't thread one in
 * (e.g. unit tests rendering a bare PaneRow). Wide enough that no
 * truncation kicks in for typical fixture content.
 */
const DEFAULT_ROW_WIDTH = 96;

export interface PaneRowProps {
  status: PaneStatus;
  paneTitle: string | null;
  paneIndex: number;
  branch: string | null;
  selected?: boolean;
  workingColor?: string | null;
  /**
   * Accent the App lerps brightward briefly after a cursor move.
   * Used to color the working-row spinner on the cursor row.
   */
  cursorBarColor?: string;
  /** Current Braille-spinner frame for working rows. */
  spinnerGlyph?: string;
  /** This section's hash-of-name accent for non-working titles. */
  sessionColor?: string;
  /** Inner card content width (border + padding already removed). */
  rowWidth?: number;
}

function spaces(n: number): string {
  return " ".repeat(Math.max(0, n));
}

function PaneRowImpl({
  status,
  paneTitle,
  paneIndex,
  branch,
  selected = false,
  workingColor = null,
  cursorBarColor,
  spinnerGlyph,
  sessionColor,
  rowWidth = DEFAULT_ROW_WIDTH,
}: PaneRowProps): ReactElement {
  const theme = useTheme();
  const main = fmtRowMain({
    paneTitle,
    paneIndex,
    status,
    branch,
    workingColor,
    stateColors: theme.state,
  });
  const tag: ActivityTag = activityTag(status, workingColor, theme.state);
  const description = activityDescription(status);

  const titleColor =
    main.nameColor !== null ? main.nameColor : (sessionColor ?? theme.foregroundMuted);
  const stateDotColor =
    workingColor && status.state === "working"
      ? workingColor
      : (theme.state[status.state] ?? theme.foregroundMuted);
  const showSpinner =
    status.state === "working" && spinnerGlyph !== undefined && spinnerGlyph !== "";
  const spinnerColor = selected ? (cursorBarColor ?? theme.accent) : tag.color;

  // -------------------------------------------------------------------
  // One fixed-width, padded-segment layout for every row. A computed
  // spacer right-aligns the state tag (instead of flexGrow, which
  // mis-composes against the next row under Ink's static renderer).
  // The cursor row sets `bg` on every segment + the spacer so the
  // soft selection highlight is contiguous edge-to-edge; other rows
  // leave it transparent so terminal translucency bleeds through.
  // -------------------------------------------------------------------
  const bg = selected ? theme.selectionBg : undefined;
  const lead = " ";
  const trailing = " ";
  const spinnerStr = showSpinner ? `${spinnerGlyph} ` : "";
  const rightLen = spinnerStr.length + tag.verb.length + trailing.length;

  let nameStr = main.name;
  let branchStr = main.branch !== null ? ` \u00b7 ${main.branch}` : "";
  let gap = rowWidth - (lead.length + nameStr.length + branchStr.length) - rightLen;
  if (gap < 1) {
    branchStr = "";
    gap = rowWidth - (lead.length + nameStr.length) - rightLen;
  }
  if (gap < 1) {
    const maxName = rowWidth - rightLen - lead.length - 1;
    nameStr = truncate(nameStr, Math.max(1, maxName));
    gap = Math.max(1, rowWidth - (lead.length + nameStr.length) - rightLen);
  }

  const lead2 = "   ";
  const dot = "\u25cf ";
  let desc = description;
  const descMax = rowWidth - lead2.length - dot.length - trailing.length;
  if (desc.length > descMax) desc = truncate(desc, Math.max(0, descMax));
  const pad2 = Math.max(
    0,
    rowWidth - lead2.length - dot.length - desc.length - trailing.length,
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" width={rowWidth}>
        <Text backgroundColor={bg}>{lead}</Text>
        <Text backgroundColor={bg} bold color={titleColor} wrap="truncate">
          {nameStr}
        </Text>
        {branchStr !== "" && (
          <Text backgroundColor={bg} color={theme.foregroundMuted} wrap="truncate">
            {branchStr}
          </Text>
        )}
        <Text backgroundColor={bg}>{spaces(gap)}</Text>
        {spinnerStr !== "" && (
          <Text backgroundColor={bg} color={spinnerColor} wrap="truncate">
            {spinnerStr}
          </Text>
        )}
        <Text backgroundColor={bg} color={tag.color} wrap="truncate">
          {tag.verb}
        </Text>
        <Text backgroundColor={bg}>{trailing}</Text>
      </Box>
      {description !== "" && (
        <Box flexDirection="row" width={rowWidth}>
          <Text backgroundColor={bg}>{lead2}</Text>
          <Text backgroundColor={bg} color={stateDotColor}>
            {dot}
          </Text>
          <Text
            backgroundColor={bg}
            dimColor
            color={theme.foregroundMuted}
            wrap="truncate"
          >
            {desc}
          </Text>
          <Text backgroundColor={bg}>{spaces(pad2) + trailing}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Memoized PaneRow. The App threads animated props (workingColor,
 * spinnerGlyph, cursorBarColor) only into rows that consume them, so
 * non-working non-selected rows skip the pulse re-render entirely.
 */
export const PaneRow = memo(PaneRowImpl);
