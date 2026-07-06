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

function normalizeStopReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "tool_use") return "toolUse";
  if (value === "end_turn" || value === "stop_sequence") return "stop";
  return value;
}

function numericField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toolCallIds(content: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(content)) return ids;
  for (const item of content as ContentItem[]) {
    if (typeof item !== "object" || item === null) continue;
    if (item.type !== "toolCall" && item.type !== "tool_use") continue;
    if (typeof item.id === "string") ids.add(item.id);
  }
  return ids;
}

function toolResultIds(content: unknown): string[] {
  const ids: string[] = [];
  if (!Array.isArray(content)) return ids;
  for (const item of content as Array<Record<string, unknown>>) {
    if (typeof item !== "object" || item === null) continue;
    if (item.type !== "tool_result") continue;
    const id = item.tool_use_id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/**
 * Walk forward through `blob` (the tail of a JSONL session file) and
 * return a `JsonlSnapshot` reflecting the trailing meaningful entry
 * plus any open tool-use turn whose toolCalls aren't all matched yet.
 *
 * Supports both pi's historical `type: "message"` wrapper and Claude
 * Code's direct `type: "assistant" | "user"` entries. Unknown entry
 * shapes are ignored defensively so a schema addition cannot break the
 * whole monitor tick.
 */
export function scanLines(blob: string, mtime: number): JsonlSnapshot {
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
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const entryType = entry.type;
    let msg: Record<string, unknown>;
    let role: unknown;
    if (entryType === "message") {
      msg = (entry.message ?? {}) as Record<string, unknown>;
      role = msg.role;
    } else if (entryType === "assistant" || entryType === "user") {
      msg = (entry.message ?? {}) as Record<string, unknown>;
      role = typeof msg.role === "string" ? msg.role : entryType;
    } else {
      continue;
    }

    if (role === "assistant") {
      lastRole = "assistant";
      lastStopReason = normalizeStopReason(msg.stopReason ?? msg.stop_reason);
      lastError =
        typeof msg.errorMessage === "string"
          ? msg.errorMessage
          : typeof entry.error === "string"
            ? entry.error
            : null;

      const content = msg.content ?? [];
      const preview = firstTextPreview(content);
      if (preview !== null) lastAssistantPreview = preview;

      // Usage / cost roll-up. Pi publishes usage.totalTokens and
      // usage.cost.total. Claude Code publishes Anthropic-style
      // input_tokens + output_tokens and no reliable local cost.
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        const total = usage.totalTokens;
        if (typeof total === "number" && Number.isFinite(total)) {
          cumulativeTokens += total;
        } else {
          cumulativeTokens +=
            numericField(usage, "input_tokens") +
            numericField(usage, "cache_creation_input_tokens") +
            numericField(usage, "cache_read_input_tokens") +
            numericField(usage, "output_tokens");
        }
        const cost = usage.cost as Record<string, unknown> | undefined;
        if (cost && typeof cost === "object") {
          const ct = cost.total;
          if (typeof ct === "number" && Number.isFinite(ct)) {
            cumulativeCostUsd += ct;
          }
        }
      }

      const toolIds = toolCallIds(content);
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
      const content = msg.content ?? [];
      const resultIds = toolResultIds(content);
      if (resultIds.length > 0) {
        lastRole = "toolResult";
        for (const id of resultIds) openToolCallIds.delete(id);
      } else {
        lastRole = "user";
        openToolCallIds.clear();
      }
      const prompt = firstTextPreview(content);
      if (prompt !== null) lastUserPrompt = prompt;
    } else if (role === "bashExecution" || role === "custom") {
      // Activity events; track lastRole but don't change tool / stop
      // tracking — those belong to the assistant/tool exchange.
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
    lastUserPrompt,
    cumulativeTokens,
    cumulativeCostUsd,
  };
}
