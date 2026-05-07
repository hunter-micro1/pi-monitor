/**
 * One agent row inside a SessionGroup. Two visible lines:
 *
 *   line 1: `<name> \u00b7 <branch>` flex-left, `<state-tag>` flex-right
 *   line 2: dim activity description, indented past the title
 *
 * Mirrors the Python `PaneRow` widget. The Ink/JSX shape replaces
 * Textual's CSS classes with explicit props \u2014 the App computes
 * `selected`, `inActiveCard`, and the live `workingColor` once per
 * tick and threads them in.
 *
 * Visual differences from the Python build:
 *   - Ink's `<Box>` doesn't have `backgroundColor`, so the
 *     `selection bar` from Textual becomes a brightness lift +
 *     `inverse` text style instead. Same effect (cursor row pops),
 *     fewer rendering surprises.
 *   - All other styling (bold name, dim branch, colored state tag,
 *     dim activity line) ports byte-for-byte.
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
import { FOREGROUND, FOREGROUND_MUTED } from "./colors.js";

export interface PaneRowProps {
  /** PaneStatus from the resolver. Drives every visible field. */
  status: PaneStatus;
  /** `pane_title` from tmux. Falls back to `pane <index>` when empty. */
  paneTitle: string | null;
  /** Numeric pane index for the fallback title. */
  paneIndex: number;
  /** Current git branch for the agent's cwd, or null. */
  branch: string | null;
  /**
   * True iff this row is the cursor target. Title flips to full
   * foreground + `inverse` text-style for an obvious highlight.
   */
  selected?: boolean;
  /**
   * True iff this row sits inside the SessionGroup that contains
   * the cursor. Brightness lift to full foreground without the
   * `inverse` flip \u2014 lets the eye land on the focused card.
   */
  inActiveCard?: boolean;
  /**
   * Pulse color for WORKING titles. The App's animation timer
   * computes one new color per frame and threads it in here. When
   * null we fall back to the static STATE_COLORS.working.
   */
  workingColor?: string | null;
}

export function PaneRow({
  status,
  paneTitle,
  paneIndex,
  branch,
  selected = false,
  inActiveCard = false,
  workingColor = null,
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
      {/* Top line: name + branch on the left (flex-grow), state tag on the right (auto). */}
      <Box flexDirection="row" paddingX={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold color={titleColor} inverse={selected}>
            {main.name}
          </Text>
          {main.branch !== null && (
            <Text color={FOREGROUND_MUTED} inverse={selected}>
              {" \u00b7 "}
              {main.branch}
            </Text>
          )}
        </Box>
        <Box marginLeft={2}>
          <Text color={tag.color} inverse={selected}>
            {tag.verb}
          </Text>
        </Box>
      </Box>

      {/* Activity line: dim, indented two cells past the title. */}
      <Box paddingLeft={3} paddingRight={1}>
        <Text dimColor color={FOREGROUND_MUTED}>
          {description}
        </Text>
      </Box>
    </Box>
  );
}
