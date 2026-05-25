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
 *   - The bar marker is the SOLE cursor cue. Title color does not
 *     change between selected and non-selected rows: every row in
 *     a section already gets that section's `sessionColor` (see
 *     below), and the bar gives an unambiguous "you are here".
 *
 * Per-session title color:
 *   - All non-working rows in a section share that section's
 *     hash-of-name color (`sessionColor` prop, fed by App from
 *     `sessionHeaderColor(session)`). Lets users scan-by-color
 *     across sections without competing with state semantics.
 *   - Working rows ignore `sessionColor` and use their pulse color
 *     instead, so the active row's title visibly breathes.
 *   - Falls back to `FOREGROUND_MUTED` when no `sessionColor` is
 *     threaded in (e.g. unit tests that don't supply one).
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
import { type ReactElement, memo } from "react";
import {
  type ActivityTag,
  STATE_COLORS,
  activityDescription,
  activityTag,
  fmtRowMain,
} from "../format/row.js";
import type { PaneStatus } from "../state/types.js";
import { ACCENT, FOREGROUND_MUTED } from "./colors.js";

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
  /**
   * Color the App threads in for this section's hash-of-name
   * accent. Applied to non-working pane titles so each section
   * reads as a colored block. Working titles ignore it (they use
   * the pulse color instead). Optional so unit tests that don't
   * care about color cohesion can omit it; PaneRow then falls
   * back to the default muted color.
   */
  sessionColor?: string;
}

/**
 * Internal implementation. Wrapped in {@link memo} below so the
 * 80 ms pulse tick in App doesn't force a full re-render of every
 * row on every frame. Animated props (`workingColor`,
 * `spinnerGlyph`, `cursorBarColor`) are only passed in by App
 * when this row actually consumes them — idle/error/waiting rows
 * see stable `undefined` and skip the re-render entirely.
 */
function PaneRowImpl({
  status,
  paneTitle,
  paneIndex,
  branch,
  selected = false,
  workingColor = null,
  cursorBarColor = ACCENT,
  spinnerGlyph,
  sessionColor,
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

  // Title color rule:
  //   - Working rows: pulse color (main.nameColor is set when
  //     state is working; the title visibly breathes).
  //   - Other rows: sessionColor when the App threaded it in, so
  //     each section reads as a colored block. Falls back to
  //     FOREGROUND_MUTED when no sessionColor is supplied.
  // The cursor cue is the leftmost `▎` bar marker; the title
  // color deliberately does NOT change between selected and non-
  // selected rows so the section-color grouping stays clean.
  const titleColor =
    main.nameColor !== null ? main.nameColor : (sessionColor ?? FOREGROUND_MUTED);

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

/**
 * Memoized PaneRow. Default shallow prop equality is enough: the
 * App threads animated props (workingColor, spinnerGlyph,
 * cursorBarColor) only into rows that consume them, so non-working
 * non-selected rows see stable `undefined` between pulse ticks.
 * Status references stay stable between resolver ticks (the
 * entries array is the same array reference between pulses), so
 * a row with no state change skips the pulse re-render entirely.
 */
export const PaneRow = memo(PaneRowImpl);
