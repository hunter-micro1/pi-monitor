/**
 * One agent row. Two visible lines:
 *
 *   line 1: `<bar> <name> · <branch>`  flex-left, `<state-tag>` flex-right
 *   line 2: `   <state-dot> <activity description>` (dim, state-colored
 *                                                    leading dot)
 *
 * Selection model:
 *   - A stable `▶` marker, bright text, selection background, and
 *     explicit CURRENT label identify the pane shown in the viewer.
 *   - Pi/Claude identity is always visible beside the pane title.
 *
 * Per-session title color:
 *   - All non-working rows in a section share that section's
 *     hash-of-name color (`sessionColor` prop, fed by App from
 *     `sessionHeaderColor(session)`). Lets users scan-by-color
 *     across sections without competing with state semantics.
 *   - Working rows use the static working-state color.
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
import type { AgentType, PaneStatus } from "../state/types.js";
import {
  ACCENT,
  CLAUDE_ACCENT,
  FOREGROUND_MUTED,
  SELECTION_BG,
  SELECTION_FG,
} from "./colors.js";

/** Column reserved for the selection bar (1 cell + 1 space). */
const SELECTION_COL = 2;

export interface PaneRowProps {
  status: PaneStatus;
  agentType?: AgentType;
  paneTitle: string | null;
  paneIndex: number;
  branch: string | null;
  selected?: boolean;
  /**
   * Color the App threads in for this section's hash-of-name
   * accent. Applied to non-working pane titles so each section
   * reads as a colored block. Working titles use their static
   * state color instead. Optional so unit tests that don't
   * care about color cohesion can omit it; PaneRow then falls
   * back to the default muted color.
   */
  sessionColor?: string;
}

/**
 * Internal implementation. Wrapped in {@link memo} so unchanged
 * polling results do not re-render individual rows.
 */
function PaneRowImpl({
  status,
  agentType = "pi",
  paneTitle,
  paneIndex,
  branch,
  selected = false,
  sessionColor,
}: PaneRowProps): ReactElement {
  const main = fmtRowMain({
    paneTitle,
    paneIndex,
    status,
    branch,
  });
  const tag: ActivityTag = activityTag(status);
  const description = activityDescription(status);

  // Title color rule:
  //   - Working rows: static state color from fmtRowMain.
  //   - Other rows: sessionColor when the App threaded it in, so
  //     each section reads as a colored block. Falls back to
  //     FOREGROUND_MUTED when no sessionColor is supplied.
  // Selected rows override section/state colors with the high-
  // contrast current-row palette.
  const titleColor = selected
    ? SELECTION_FG
    : main.nameColor !== null
      ? main.nameColor
      : (sessionColor ?? FOREGROUND_MUTED);
  const agentColor = agentType === "claude" ? CLAUDE_ACCENT : ACCENT;

  const stateDotColor = STATE_COLORS[status.state] ?? FOREGROUND_MUTED;

  return (
    <Box flexDirection="column">
      {/* Top line: selection bar + name + branch on the left, state tag on the right. */}
      <Box flexDirection="row">
        <Box width={SELECTION_COL}>
          <Text bold color={selected ? SELECTION_FG : ACCENT}>
            {selected ? "▶" : " "}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text
            bold
            color={titleColor}
            backgroundColor={selected ? SELECTION_BG : undefined}
          >
            {` ${main.name} `}
          </Text>
          <Text
            bold
            color={selected ? SELECTION_FG : agentColor}
            backgroundColor={selected ? SELECTION_BG : undefined}
          >
            {agentType === "claude" ? " CLAUDE " : " PI "}
          </Text>
          {main.branch !== null && (
            <Text
              color={selected ? SELECTION_FG : FOREGROUND_MUTED}
              backgroundColor={selected ? SELECTION_BG : undefined}
            >
              {` · ${main.branch} `}
            </Text>
          )}
        </Box>
        <Box marginLeft={2}>
          <Text
            bold={selected}
            color={selected ? SELECTION_FG : tag.color}
            backgroundColor={selected ? SELECTION_BG : undefined}
          >
            {selected ? ` CURRENT · ${tag.verb} ` : tag.verb}
          </Text>
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

/** Memoized because semantically equal polls preserve row props. */
export const PaneRow = memo(PaneRowImpl);
