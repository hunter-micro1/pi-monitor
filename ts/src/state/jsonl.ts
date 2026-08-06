/**
 * JSONL session-file scanner.
 *
 * Originally a direct port of `_scan_lines` from
 * `src/pi_monitor/state.py`, now split in two: the per-line *parsing*
 * moved into `src/harness/` (each coding agent has its own record
 * shape), while the *state machine* below — trailing role, open
 * tool-call set, running usage totals — stays shared. Two harnesses
 * observing the same conversational events must produce the same
 * snapshot, and that only holds if there's one implementation of the
 * fold.
 *
 * `firstTextPreview` is re-exported for the existing test corpus,
 * which was ported 1:1 from `tests/test_state.py`.
 */

import { type Harness, piHarness } from "../harness/index.js";
import type { JsonlSnapshot } from "./types.js";

export { firstTextPreview, PREVIEW_MAX_CHARS } from "../harness/text.js";

function emptySnapshot(mtime: number): JsonlSnapshot {
  return {
    mtime,
    lastRole: null,
    lastStopReason: null,
    lastError: null,
    pendingToolCalls: 0,
    lastAssistantPreview: null,
    lastUserPrompt: null,
    cumulativeTokens: 0,
    cumulativeCostUsd: 0,
  };
}

/**
 * Walk forward through `blob` (the tail of a session file) and return
 * a `JsonlSnapshot` reflecting the trailing meaningful entry plus any
 * open tool-use turn whose tool calls aren't all matched yet.
 *
 * Lines the harness doesn't recognize as conversational are skipped
 * entirely — they must not move `lastRole`. This matters most for
 * Claude Code, whose live session files routinely END with an
 * `attachment` record; letting that through would mask the assistant
 * turn that actually closed the exchange and peg the pane to
 * `unknown` forever.
 *
 * Role handling (unchanged from the pi-only build):
 *   - `assistant`: capture lastRole, lastStopReason, lastError and
 *     the text preview. If `stopReason === "toolUse"`, replace the
 *     open tool-call set with this turn's ids; otherwise clear it
 *     (the turn closed without invoking tools).
 *   - `toolResult`: pop the matching id from the open set.
 *   - `user`: clear the open set (a new prompt supersedes any pending
 *     tool exchange).
 *   - `bashExecution` / `custom`: track lastRole only.
 *
 * `harness` defaults to pi so the ported test corpus keeps calling
 * `scanLines(blob, mtime)` unchanged.
 */
export function scanLines(
  blob: string,
  mtime: number,
  harness: Harness = piHarness,
): JsonlSnapshot {
  let lastRole: JsonlSnapshot["lastRole"] = null;
  let lastStopReason: string | null = null;
  let lastError: string | null = null;
  let lastAssistantPreview: string | null = null;
  let lastUserPrompt: string | null = null;
  let cumulativeTokens = 0;
  let cumulativeCostUsd = 0;
  let openToolCallIds = new Set<string>();

  for (const line of blob.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = harness.parseRecord(line);
    if (record === null) continue;

    cumulativeTokens += record.tokens;
    cumulativeCostUsd += record.costUsd;

    if (record.role === "assistant") {
      lastRole = "assistant";
      lastStopReason = record.stopReason;
      lastError = record.errorMessage;
      if (record.text !== null) lastAssistantPreview = record.text;

      if (lastStopReason === "toolUse") {
        // New tool-use turn supersedes any pending one from earlier.
        openToolCallIds = new Set(record.toolCallIds);
      } else {
        openToolCallIds.clear();
      }
    } else if (record.role === "toolResult") {
      lastRole = "toolResult";
      if (record.toolCallId !== null) openToolCallIds.delete(record.toolCallId);
    } else if (record.role === "user") {
      lastRole = "user";
      if (record.text !== null) lastUserPrompt = record.text;
      openToolCallIds.clear();
    } else {
      // bashExecution / custom: activity events. They move lastRole
      // but don't touch stop/tool tracking, which belongs to the
      // assistant/tool exchange.
      lastRole = record.role;
    }
  }

  const snapshot = emptySnapshot(mtime);
  return {
    ...snapshot,
    lastRole,
    lastStopReason,
    lastError,
    pendingToolCalls: openToolCallIds.size,
    lastAssistantPreview,
    lastUserPrompt,
    cumulativeTokens,
    cumulativeCostUsd,
  };
}
