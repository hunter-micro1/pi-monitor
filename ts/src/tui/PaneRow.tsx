/**
 * One agent row inside a SessionGroup. Two visible lines:
 *
 *   line 1: `<bar> <name> · <branch>`  flex-left, `<state-tag>` flex-right
 *   line 2: dim activity description, indented past the leading bar
 *
 * Selected rows get a vertical-bar marker `▎` in the leftmost column
 * (accent-colored). Non-selected rows get a single space in that
 * column so all rows align. This replaces the inverse-text highlight
 * the earlier build used; the bar is less harsh than full-row
 * inverse and cleaner over translucent backgrounds.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import {
  type ActivityTag,
  activityDescription,
  activityTag,
  fmtRowMain,
} from "../format/row.js";
import type { PaneStatus } from "../state/types.js";
import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";

/** Column reserved for the selection bar (1 cell + 1 space). */
const SELECTION_COL = 2;

export interface PaneRowProps {
  /** PaneStatus from the resolver. Drives every visible field. */
  status: PaneStatus;
  /** `pane_title` from tmux. Falls back to `pane <index>` when empty. */
  paneTitle: string | null;
  /** Numeric pane index for the fallback title. */
  paneIndex: number;
  /** Current git branch for the agent's cwd, or null. */
  branch: string | null;
  /** True iff this row is the cursor target. Renders the bar marker. */
  selected?: boolean;
  /**
   * True iff this row sits inside the SessionGroup that contains
   * the cursor. Brightness lift to full foreground; lets the eye
   * land on the focused card without flipping the row.
   */
  inActiveCard?: boolean;
  /**
   * Pulse color for WORKING titles. The App's animation timer
   * computes one new color per frame and threads it in here. When
   * null we fall back to the static STATE_COLORS.working.
   */
  workingColor?: string | null;
  /**
   * Selection-bar color. The App lerps this from accent toward
   * white briefly when the cursor moves to a new row, then settles
   * back to ACCENT. Renders only when `selected` is true; otherwise
   * the column is a blank space and this prop is ignored.
   */
  cursorBarColor?: string;
}

export function PaneRow({
  status,
  paneTitle,
  paneIndex,
  branch,
  selected = false,
  inActiveCard = false,
  workingColor = null,
  cursorBarColor = ACCENT,
}: PaneRowProps): ReactElement {
  const main = fmtRowMain({
    paneTitle,
    paneIndex,
    status,
    branch,
    workingColor,
  });
  const tag: ActivityTag = activityTag(status, workingColor);
  const description = activityDescription(status);

  // Brightness hierarchy: muted by default, full when the row is
  // selected OR sits inside the focused card. WORKING rows ignore
  // this and use their pulse color directly.
  const titleColor =
    main.nameColor !== null
      ? main.nameColor
      : selected || inActiveCard
        ? FOREGROUND
        : FOREGROUND_MUTED;

  return (
    <Box flexDirection="column">
      {/* Top line: selection bar + name + branch on the left, state tag on the right. */}
      <Box flexDirection="row">
        <Box width={SELECTION_COL}>
          <Text bold color={selected ? cursorBarColor : ACCENT}>
            {selected ? "\u258e" : " "}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold color={titleColor}>
            {main.name}
          </Text>
          {main.branch !== null && (
            <Text color={FOREGROUND_MUTED}>
              {" \u00b7 "}
              {main.branch}
            </Text>
          )}
        </Box>
        <Box marginLeft={2}>
          <Text color={tag.color}>{tag.verb}</Text>
        </Box>
      </Box>

      {/* Activity line: dim, indented past the selection column + 2. */}
      <Box paddingLeft={SELECTION_COL + 2} paddingRight={1}>
        <Text dimColor color={FOREGROUND_MUTED}>
          {description}
        </Text>
      </Box>
    </Box>
  );
}
