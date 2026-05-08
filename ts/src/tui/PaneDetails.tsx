/**
 * Bottom-of-sidebar details box for the cursor row.
 *
 * Renders an expanded view of the currently-selected pane's status:
 * the title + branch + state tag (mirror of the PaneRow's top
 * line), plus 1-3 label-prefixed detail lines depending on what
 * data is available:
 *
 *   Doing   <phase + tool>     // only for working rows w/ heartbeat
 *   Last    <assistant preview> // when snapshot has lastAssistantPreview
 *   Error   <error message>     // when state === "error"
 *
 * Hidden entirely when the cursor isn't on a pane row (the App
 * passes `null`); a section divider above keeps the box visually
 * grouped with the row list rather than the footer.
 *
 * Truncation cap is intentionally higher than the inline activity
 * line (200 chars vs ACTIVITY_MAX_CHARS=80) so users can see more
 * of the last assistant turn here without leaving the TUI.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import {
  type ActivityTag,
  STATE_COLORS,
  activityTag,
  fmtRowMain,
  truncate,
} from "../format/row.js";
import type { PaneStatus } from "../state/types.js";
import { FOREGROUND, FOREGROUND_MUTED } from "./colors.js";

/** Max chars for the assistant-preview / error lines in the box. */
export const DETAILS_TEXT_MAX_CHARS = 200;

/** Width reserved for the "Doing"/"Last"/"Error" label column. */
const LABEL_COL = 8;

export interface PaneDetailsProps {
  /** Status of the cursor row, or null when cursor isn't on a pane. */
  status: PaneStatus | null;
  paneTitle: string | null;
  paneIndex: number;
  branch: string | null;
  /** Pulse color threaded in by the App for working rows. */
  workingColor?: string | null;
}

export function PaneDetails({
  status,
  paneTitle,
  paneIndex,
  branch,
  workingColor = null,
}: PaneDetailsProps): ReactElement | null {
  if (status === null) return null;

  const main = fmtRowMain({ paneTitle, paneIndex, status, branch, workingColor });
  const tag: ActivityTag = activityTag(status, workingColor);

  const doing = describeDoing(status);
  const last = status.snapshot?.lastAssistantPreview
    ? truncate(status.snapshot.lastAssistantPreview, DETAILS_TEXT_MAX_CHARS)
    : null;
  const errorMsg =
    status.state === "error" && status.snapshot?.lastError
      ? truncate(status.snapshot.lastError, DETAILS_TEXT_MAX_CHARS)
      : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider />

      {/* Title line: matches PaneRow's first line layout (paneTitle
          + branch left, state tag right) so the user reads "I am
          looking at the same row, expanded" rather than "what is
          this new thing". No selection bar \u2014 the details box is
          implicitly about the selected row. */}
      <Box flexDirection="row" paddingX={2} marginTop={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold color={main.nameColor ?? FOREGROUND}>
            {main.name}
          </Text>
          {main.branch !== null && (
            <Text color={FOREGROUND_MUTED}>
              {" \u00b7 "}
              {main.branch}
            </Text>
          )}
        </Box>
        <Text color={tag.color}>{tag.verb}</Text>
      </Box>

      {/* Detail lines. Each label is dim, the value is full
          foreground (or state-colored for the error line). Indent
          matches the title row's paddingX={2} so labels align with
          paneTitle's first letter. */}
      {doing !== null && <Detail label="Doing" value={doing} />}
      {last !== null && <Detail label="Last" value={last} />}
      {errorMsg !== null && (
        <Detail label="Error" value={errorMsg} valueColor={STATE_COLORS.error} />
      )}
    </Box>
  );
}

/** One label-value detail line. */
function Detail({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}): ReactElement {
  return (
    <Box flexDirection="row" paddingX={2}>
      <Box width={LABEL_COL}>
        <Text color={FOREGROUND_MUTED}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={valueColor ?? FOREGROUND}>{value}</Text>
      </Box>
    </Box>
  );
}

/**
 * Compose the "Doing" line from phase + currentTool + retryAttempt.
 * Returns null when there's nothing more informative to say than
 * what the right-side state tag already shows.
 */
function describeDoing(status: PaneStatus): string | null {
  const { phase, currentTool, retryAttempt, state } = status;

  if (phase === "tool_running" && currentTool) {
    return `running ${currentTool}`;
  }
  if (phase === "tool_running") return "running tool";
  if (phase === "compacting") return "compacting context history";
  if (phase === "agent_running") return "drafting response";
  if (phase === "awaiting_permission") return "awaiting your permission";
  if (phase === "retrying") {
    return retryAttempt > 0
      ? `retrying after transient error (attempt ${retryAttempt})`
      : "retrying after transient error";
  }
  if (state === "waiting") return "awaiting your input";
  return null;
}

function Divider(): ReactElement {
  return (
    <Box
      marginX={2}
      borderStyle="single"
      borderTop
      borderRight={false}
      borderLeft={false}
      borderBottom={false}
      borderColor={FOREGROUND_MUTED}
    />
  );
}
