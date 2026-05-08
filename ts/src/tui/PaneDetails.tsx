/**
 * Bottom-of-sidebar details box for the cursor row.
 *
 * Renders a tight, five-line summary of the currently-selected
 * pane:
 *
 *   <name> · <branch>                <activity tag>     // title row
 *   Worktree   <pi cwd, $HOME -> ~>                     // when cwd is non-empty
 *   When       Started Xh Ym ago · idle Zs              // when sessionFile parses
 *   Prompt     <last user message, truncated 200 chars> // when snapshot has lastUserPrompt
 *   Tokens     <total> total · <cost>                   // when cumulativeTokens > 0
 *
 * The title row mirrors PaneRow's first line so users read
 * "expanded version of the cursor row" rather than "what's this
 * new thing". Each label-prefixed line below is conditional and
 * hides when its data isn't available; the box intentionally
 * OMITS Doing / Reply / Error lines — the activity tag in the
 * title row already conveys "is this agent busy / errored", and
 * the user doesn't want the box growing.
 *
 * IMPORTANT: the box does NOT pulse. Threading the App's pulseHex
 * here would make the title text + activity tag breathe in
 * lock-step with the row list every 80ms, which on slow tmux
 * pipelines (WSL2 → tmux) reads as flicker on a control that's
 * supposed to be a stable readout. The box uses static
 * `STATE_COLORS.working` for working rows; only the row list
 * above carries the breathing animation.
 *
 * Hidden entirely when the cursor isn't on a pane row (the App
 * passes `null`); a section divider above keeps the box visually
 * grouped with the row list rather than the footer.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import {
  type ActivityTag,
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

/** Width reserved for the "Worktree"/"When"/"Prompt"/"Tokens" label column. */
const LABEL_COL = 10;

/** Max chars for the Prompt line value before ellipsis. */
const PROMPT_MAX_CHARS = 200;

export interface PaneDetailsProps {
  /** Status of the cursor row, or null when cursor isn't on a pane. */
  status: PaneStatus | null;
  paneTitle: string | null;
  paneIndex: number;
  branch: string | null;
  /**
   * Pi descendant's actual cwd — typically the auto-worktree dir,
   * which is more informative than the branch alone when several
   * panes share a branch name across worktrees. Empty / null hides
   * the `Worktree` line. The App threads `AppEntry.cwd` here.
   */
  cwd?: string | null;
  /**
   * `$HOME` for the `Worktree` line's path collapse. Defaults to
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
  cwd = null,
  home,
  nowSeconds,
}: PaneDetailsProps): ReactElement | null {
  if (status === null) return null;

  // workingColor is intentionally NOT threaded here — the box
  // stays static so it doesn't flicker on slow tmux pipelines.
  // See the file-level comment.
  const main = fmtRowMain({ paneTitle, paneIndex, status, branch });
  const tag: ActivityTag = activityTag(status);

  const tree = cwd && cwd.length > 0 ? fmtCwdDisplay(cwd, resolveHome(home)) : null;
  const when = describeWhen(status, nowSeconds);
  const prompt =
    status.snapshot?.lastUserPrompt && status.snapshot.lastUserPrompt.length > 0
      ? truncate(status.snapshot.lastUserPrompt, PROMPT_MAX_CHARS)
      : null;
  const tokens =
    status.snapshot && status.snapshot.cumulativeTokens > 0
      ? `${fmtTokens(status.snapshot.cumulativeTokens)} total \u00b7 ${fmtCostUsd(
          status.snapshot.cumulativeCostUsd,
        )}`
      : null;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider />

      {/* Title row: paneTitle + branch on the left, activity tag on
          the right. No selection bar — the details box is
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

      {/* Detail lines. Each label is dim, value is full foreground.
          Indent matches the title row's paddingX={2} so labels
          align with paneTitle's first letter. */}
      {tree !== null && <Detail label="Worktree" value={tree} />}
      {when !== null && <Detail label="When" value={when} />}
      {prompt !== null && <Detail label="Prompt" value={prompt} />}
      {tokens !== null && <Detail label="Tokens" value={tokens} />}
    </Box>
  );
}

/** One label-value detail line. */
function Detail({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <Box flexDirection="row" paddingX={2}>
      <Box width={LABEL_COL}>
        <Text color={FOREGROUND_MUTED}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={FOREGROUND}>{value}</Text>
      </Box>
    </Box>
  );
}

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
