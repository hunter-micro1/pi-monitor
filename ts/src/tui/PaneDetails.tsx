/**
 * Bottom-of-sidebar details box for the cursor row.
 *
 * Renders an expanded view of the currently-selected pane's status:
 * the title + branch + state tag (mirror of the PaneRow's top
 * line), plus up to 7 label-prefixed detail lines depending on
 * what data is available:
 *
 *   Doing      <phase + tool>          // working w/ heartbeat
 *   Worktree   <pi cwd, $HOME -> ~>    // when cwd is non-empty
 *   When       Started Xh Ym ago · idle Zs   // when sessionFile parses
 *   Prompt  <last user message>     // when snapshot has lastUserPrompt
 *   Reply   <last assistant text>   // when snapshot has lastAssistantPreview
 *   Tokens  <total> total · <cost>  // when cumulativeTokens > 0
 *   Error   <error message>         // when state === "error"
 *
 * Hidden entirely when the cursor isn't on a pane row (the App
 * passes `null`); a section divider above keeps the box visually
 * grouped with the row list rather than the footer.
 *
 * Truncation cap is intentionally higher than the inline activity
 * line (200 chars vs ACTIVITY_MAX_CHARS=80) so users can see more
 * of the last user / assistant turn here without leaving the TUI.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import {
  type ActivityTag,
  STATE_COLORS,
  activityTag,
  fmtCostUsd,
  fmtCwdDisplay,
  fmtDuration,
  fmtRowMain,
  fmtTokens,
  parseSessionStartFromFile,
  truncate,
} from "../format/row.js";
import type { PaneStatus } from "../state/types.js";
import { FOREGROUND, FOREGROUND_MUTED } from "./colors.js";

/** Max chars for the assistant-preview / error lines in the box. */
export const DETAILS_TEXT_MAX_CHARS = 200;

/** Width reserved for the "Doing"/"Worktree"/"Error" label column. */
const LABEL_COL = 10;

export interface PaneDetailsProps {
  /** Status of the cursor row, or null when cursor isn't on a pane. */
  status: PaneStatus | null;
  paneTitle: string | null;
  paneIndex: number;
  branch: string | null;
  /** Pulse color threaded in by the App for working rows. */
  workingColor?: string | null;
  /**
   * Pi descendant's actual cwd — typically the auto-worktree dir,
   * which is more informative than the branch alone when several
   * panes share a branch name across worktrees. Empty / null hides
   * the `Tree` line. The App threads `AppEntry.cwd` here.
   */
  cwd?: string | null;
  /**
   * `$HOME` for the `Tree` line's path collapse. Defaults to
   * `process.env.HOME` so production callers don't have to pass
   * it; tests override it to keep snapshots stable across machines.
   */
  home?: string | null;
  /**
   * Wall-clock seconds for the `When` line. Defaults to
   * `Date.now() / 1000`; tests pin it for deterministic durations.
   */
  nowSeconds?: number;
}

export function PaneDetails({
  status,
  paneTitle,
  paneIndex,
  branch,
  workingColor = null,
  cwd = null,
  home,
  nowSeconds,
}: PaneDetailsProps): ReactElement | null {
  if (status === null) return null;

  const main = fmtRowMain({ paneTitle, paneIndex, status, branch, workingColor });
  const tag: ActivityTag = activityTag(status, workingColor);

  const doing = describeDoing(status);
  const tree = cwd && cwd.length > 0 ? fmtCwdDisplay(cwd, resolveHome(home)) : null;
  const when = describeWhen(status, nowSeconds);
  const prompt = status.snapshot?.lastUserPrompt
    ? truncate(status.snapshot.lastUserPrompt, DETAILS_TEXT_MAX_CHARS)
    : null;
  const reply = status.snapshot?.lastAssistantPreview
    ? truncate(status.snapshot.lastAssistantPreview, DETAILS_TEXT_MAX_CHARS)
    : null;
  const tokens =
    status.snapshot && status.snapshot.cumulativeTokens > 0
      ? `${fmtTokens(status.snapshot.cumulativeTokens)} total \u00b7 ${fmtCostUsd(
          status.snapshot.cumulativeCostUsd,
        )}`
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
          paneTitle's first letter. Order: what the agent is doing
          right now (Doing), where it lives on disk (Tree), how
          long it has been alive + how recently it spoke (When),
          what the user asked (Prompt), what the agent replied
          (Reply), how much it has spent (Tokens), and — only on
          error rows — Error. */}
      {doing !== null && <Detail label="Doing" value={doing} />}
      {tree !== null && <Detail label="Worktree" value={tree} />}
      {when !== null && <Detail label="When" value={when} />}
      {prompt !== null && <Detail label="Prompt" value={prompt} />}
      {reply !== null && <Detail label="Reply" value={reply} />}
      {tokens !== null && <Detail label="Tokens" value={tokens} />}
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
/**
 * Resolve the `home` prop with a sensible default. Pulled out so
 * the default lookup happens lazily — React would otherwise
 * re-evaluate `process.env.HOME` on every render via a default
 * parameter, which is fine but reads as accidental.
 */
function resolveHome(passed: string | null | undefined): string | null {
  if (passed !== undefined) return passed;
  return process.env.HOME ?? null;
}

/**
 * Compose the `When` line: pi's session age (parsed from the
 * sessionFile's filename) plus how long it has been since the last
 * JSONL flush (idleSeconds). Returns null when neither half is
 * available.
 */
function describeWhen(
  status: PaneStatus,
  nowSeconds: number | undefined,
): string | null {
  const start = parseSessionStartFromFile(status.sessionFile);
  const now = nowSeconds ?? Date.now() / 1000;
  const parts: string[] = [];
  if (start !== null && Number.isFinite(now - start) && now - start > 0) {
    parts.push(`Started ${fmtDuration(now - start)} ago`);
  }
  // Idle distance is meaningful even without a parseable filename
  // (e.g. legacy session paths or future filename schemes). Show it
  // alongside Started when both are present, alone otherwise.
  if (status.idleSeconds >= 1) {
    parts.push(`idle ${fmtDuration(status.idleSeconds)}`);
  }
  if (parts.length === 0) return null;
  return parts.join(" \u00b7 ");
}

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
