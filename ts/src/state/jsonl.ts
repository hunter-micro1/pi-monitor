/**
 * JSONL session-file parser.
 *
 * Direct port of `_scan_lines` and `_first_text_preview` from
 * `src/pi_monitor/state.py`. The Python build calls these on the tail
 * bytes of `~/.pi/agent/sessions/*.jsonl` files; this TS port consumes
 * the same byte stream (or a string equivalent) and produces an
 * equivalent `JsonlSnapshot`.
 *
 * The line-by-line state machine semantics are preserved exactly so
 * the test corpus from `tests/test_state.py` ports straight over.
 */

import type { JsonlSnapshot } from "./types.js";

/**
 * Cap on the assistant-text preview captured per JSONL line. The UI
 * truncates further to fit the row width; this bound just keeps an
 * absurdly-long single-text-block message from bloating the cached
 * snapshot. Mirrors `_PREVIEW_MAX_CHARS` in the Python build.
 */
export const PREVIEW_MAX_CHARS = 200;

/** Shape of an assistant-message content item we care about. */
type ContentItem = {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
};

/**
 * Return the first text chunk of an assistant message's `content`,
 * lstripped, capped at `PREVIEW_MAX_CHARS`. Returns `null` when no
 * usable text is present (tool-only message, all-whitespace text,
 * malformed content shape).
 *
 * Defensive against pi sometimes emitting `content` as a plain string
 * or `null` instead of a list \u2014 the Python helper handles that and
 * we mirror it.
 */
export function firstTextPreview(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (const item of content as ContentItem[]) {
    if (typeof item !== "object" || item === null) continue;
    if (item.type !== "text") continue;
    const text = item.text;
    if (typeof text !== "string") continue;
    const stripped = text.replace(/^\s+/, "");
    if (stripped.length === 0) continue;
    return stripped.length > PREVIEW_MAX_CHARS
      ? stripped.slice(0, PREVIEW_MAX_CHARS)
      : stripped;
  }
  return null;
}

/**
 * Walk forward through `blob` (the tail of a JSONL session file) and
 * return a `JsonlSnapshot` reflecting the trailing meaningful entry
 * plus any open tool-use turn whose toolCalls aren't all matched yet.
 *
 * Skip rules ported from the Python:
 *   - Empty/whitespace-only lines.
 *   - JSON parse errors.
 *   - Entries whose top-level `type` isn't `"message"`.
 *
 * Role handling:
 *   - `assistant`: capture lastRole, lastStopReason, lastError, and
 *     the first-text preview. If `stopReason === "toolUse"`, replace
 *     `openToolCallIds` with this turn's toolCall ids; otherwise clear
 *     the open set (the assistant turn closed without invoking tools).
 *   - `toolResult`: pop matching toolCallId from `openToolCallIds`.
 *   - `user`: clear `openToolCallIds` (a new prompt supersedes any
 *     pending tool exchange).
 *   - `bashExecution` / `custom`: track lastRole only \u2014 these are
 *     activity events, not assistant/tool round trips.
 */
export function scanLines(blob: string, mtime: number): JsonlSnapshot {
  let lastRole: JsonlSnapshot["lastRole"] = null;
  let lastStopReason: string | null = null;
  let lastError: string | null = null;
  let lastAssistantPreview: string | null = null;
  let openToolCallIds = new Set<string>();

  for (const line of blob.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;

    const msg = (entry.message ?? {}) as Record<string, unknown>;
    const role = msg.role;

    if (role === "assistant") {
      lastRole = "assistant";
      lastStopReason = typeof msg.stopReason === "string" ? msg.stopReason : null;
      lastError = typeof msg.errorMessage === "string" ? msg.errorMessage : null;

      const content = msg.content ?? [];
      const preview = firstTextPreview(content);
      if (preview !== null) lastAssistantPreview = preview;

      const toolIds = new Set<string>();
      if (Array.isArray(content)) {
        for (const item of content as ContentItem[]) {
          if (typeof item !== "object" || item === null) continue;
          if (item.type !== "toolCall") continue;
          if (typeof item.id === "string") toolIds.add(item.id);
        }
      }
      if (lastStopReason === "toolUse") {
        // New tool-use turn supersedes any pending one from earlier.
        openToolCallIds = toolIds;
      } else {
        openToolCallIds.clear();
      }
    } else if (role === "toolResult") {
      lastRole = "toolResult";
      const tcid = msg.toolCallId;
      if (typeof tcid === "string") openToolCallIds.delete(tcid);
    } else if (role === "user") {
      lastRole = "user";
      openToolCallIds.clear();
    } else if (role === "bashExecution" || role === "custom") {
      // Activity events; track lastRole but don't change tool / stop
      // tracking \u2014 those belong to the assistant/tool exchange.
      lastRole = role;
    }
  }

  return {
    mtime,
    lastRole,
    lastStopReason,
    lastError,
    pendingToolCalls: openToolCallIds.size,
    lastAssistantPreview,
  };
}
