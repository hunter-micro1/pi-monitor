/**
 * One agent row. Two visible lines:
 *
 *   line 1: `<bar> <name> · <branch>`  flex-left, `<state-tag>` flex-right
 *   line 2: `   <state-dot> <activity description>` (dim, state-colored
 *                                                    leading dot)
 *
 * Selection model:
 *   - The leftmost column reserves 2 cells. When a row is selected
 *     the cursor bar `\u258e` (a thin half-block) renders there in the
 *     `cursorBarColor` (the App lerps it brightward on cursor moves).
 *   - The selected row's title also brightens to FOREGROUND so the
 *     row reads as the active one beyond just the bar marker.
 *
 * Activity-line state dot:
 *   - cmux uses small icons before each activity verb. We use a
 *     `\u25cf` colored by the row's state to match the rest of the
 *     design system (status pills in the title bar + section chips
 *     all use the same dot character).
 *   - Dot is suppressed entirely when there's no activity description
 *     (e.g. no_pi rows) so we don't render an orphan dot on a blank
 *     line.
 *
 * Working-row spinner:
 *   - When `state === "working"`, the right-side activity tag is
 *     prefixed with a Braille-spinner glyph (the same 10-frame set
 *     pi itself uses in its `Loader` component). The App threads
 *     in the current frame via `spinnerGlyph`; non-working rows
 *     ignore it.
 *   - On the cursor row the spinner glyph renders in ACCENT instead
 *     of the pulse color, so a working AND selected row gets a
 *     visible "this one is the focus" cue without disturbing the
 *     verb's color (the verb keeps its pulse so the row still
 *     visibly breathes).
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  type ActivityTag,
  STATE_COLORS,
  activityDescription,
  activityTag,
  fmtRowMain,
} from "../format/row.js";
import type { PaneStatus } from "../state/types.js";
import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";

/** Column reserved for the selection bar (1 cell + 1 space). */
const SELECTION_COL = 2;

export interface PaneRowProps {
  status: PaneStatus;
  paneTitle: string | null;
  paneIndex: number;
  branch: string | null;
  selected?: boolean;
  workingColor?: string | null;
  cursorBarColor?: string;
  /**
   * Current Braille-spinner frame for working rows. Threaded in
   * by the App on its 80ms tick. Ignored when state is not
   * `working`. Optional so unit tests can omit it.
   */
  spinnerGlyph?: string;
}

export function PaneRow({
  status,
  paneTitle,
  paneIndex,
  branch,
  selected = false,
  workingColor = null,
  cursorBarColor = ACCENT,
  spinnerGlyph,
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

  // Brightness hierarchy: muted by default, full only on the
  // selected row. We deliberately do NOT brighten every row in the
  // active section — the cursor bar (▎) is the single "you are
  // here" cue, matching cmux's single-tab highlight rather than a
  // section-wide block highlight. WORKING rows ignore this and use
  // their pulse color directly.
  const titleColor =
    main.nameColor !== null ? main.nameColor : selected ? FOREGROUND : FOREGROUND_MUTED;

  const stateDotColor =
    workingColor && status.state === "working"
      ? workingColor
      : (STATE_COLORS[status.state] ?? FOREGROUND_MUTED);

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
          {status.state === "working" &&
            spinnerGlyph !== undefined &&
            spinnerGlyph !== "" && (
              <Text color={selected ? ACCENT : tag.color}>{`${spinnerGlyph} `}</Text>
            )}
          <Text color={tag.color}>{tag.verb}</Text>
        </Box>
      </Box>

      {/* Activity line: dim with a state-colored leading dot. The
          dot makes the row's state visible at the activity-line beat
          even if the right-side tag scrolled out of view on a narrow
          terminal. */}
      {description !== "" && (
        <Box flexDirection="row" paddingLeft={SELECTION_COL + 2}>
          <Text color={stateDotColor}>{"\u25cf "}</Text>
          <Text dimColor color={FOREGROUND_MUTED}>
            {description}
          </Text>
        </Box>
      )}
    </Box>
  );
}
