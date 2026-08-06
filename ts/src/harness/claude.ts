/**
 * Claude Code harness adapter.
 *
 * Claude Code's on-disk session format differs from pi's in three
 * ways that matter here:
 *
 *   1. **Path encoding.** Sessions live under
 *      `~/.claude/projects/<encoded-cwd>/` where the encoding
 *      replaces every `/` AND `.` with `-` (so `/a/b/.claude` becomes
 *      `-a-b--claude`). pi instead wraps its encoding in `--...--`.
 *
 *   2. **No timestamp in the filename.** Files are named
 *      `<uuid>.jsonl`. The claim algorithm in `state/files.ts` needs
 *      a session start time to bound each agent's ownership window —
 *      without one it degrades to "newest mtime wins", which is the
 *      exact cohabitation bug that algorithm exists to prevent. We
 *      recover the start time from the first record's `timestamp`
 *      field instead (cached; a given file's first record never
 *      changes).
 *
 *   3. **Interleaved non-conversational records.** `attachment`,
 *      `hook_success`, `total_tokens_reminder` and friends are
 *      appended around the real turns — a live session's LAST line is
 *      very often an `attachment`. `parseRecord` returns `null` for
 *      those so they can't mask the assistant turn that actually
 *      ended the exchange.
 */

import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { textPreview } from "./text.js";
import { type Harness, type NormalizedRecord, normalizedRecord } from "./types.js";

/** Root of Claude Code's per-project session storage. */
export const CLAUDE_SESSIONS_ROOT = join(homedir(), ".claude", "projects");

/**
 * Bytes read from the head of a session file when recovering its
 * start time. The first record is a few hundred bytes at most; 8 KB
 * gives generous headroom for a large leading system record without
 * pulling in the whole file.
 */
const HEAD_BYTES = 8192;

/**
 * Claude `stop_reason` -> pi's normalized vocabulary.
 *
 * This table is the whole reason `state/infer.ts` needs no changes:
 * an `end_turn` from Claude and a `stop` from pi describe the same
 * observable fact ("the agent finished its turn"), so they must
 * produce the same `AgentState`.
 */
const STOP_REASON_MAP: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "toolUse",
  refusal: "stop",
};

/**
 * Cache of `path -> start time (unix seconds) | null`. A session
 * file's first record is immutable, so this never needs invalidating
 * within a process lifetime.
 */
const startTimeCache = new Map<string, number | null>();

/** Content-block shape Claude uses. */
type ContentItem = { type?: unknown; id?: unknown; tool_use_id?: unknown };

/** Sum the token counters Claude reports on an assistant turn. */
function sumUsage(usage: Record<string, unknown> | undefined): number {
  if (!usage || typeof usage !== "object") return 0;
  let total = 0;
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]) {
    const v = usage[key];
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}

export const claudeHarness: Harness = {
  id: "claude",
  label: "claude",
  // Claude Code installs a native launcher named `claude`. On macOS
  // tmux reports `node` for it, same as pi — the process-tree walk in
  // `proc/` is what makes detection work there.
  commNames: ["claude"],
  supportsHeartbeat: false,

  defaultSessionsRoot(): string {
    return CLAUDE_SESSIONS_ROOT;
  },

  /**
   * `/home/u/Projects/pi-monitor` -> `-home-u-Projects-pi-monitor`.
   * Dots collapse to dashes too, so `/a/.claude/wt` becomes
   * `-a--claude-wt`. Verified against every project directory on
   * disk at time of writing.
   */
  sessionDir(cwd: string, root: string = CLAUDE_SESSIONS_ROOT): string {
    return join(root, cwd.replace(/[/.]/g, "-"));
  },

  /**
   * Recover the session start time from the first record carrying a
   * `timestamp`. Reads only the head of the file and memoizes the
   * result. Returns `null` when the file is unreadable or no leading
   * record has a parseable timestamp — callers then fall back to the
   * mtime heuristics, exactly as they do for a pi file with a
   * non-standard name.
   */
  sessionStartTime(path: string): number | null {
    const cached = startTimeCache.get(path);
    if (cached !== undefined) return cached;

    let result: number | null = null;
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.alloc(HEAD_BYTES);
      const bytes = readSync(fd, buf, 0, HEAD_BYTES, 0);
      const blob = buf.toString("utf8", 0, bytes);
      for (const line of blob.split("\n")) {
        if (line.trim().length === 0) continue;
        let entry: Record<string, unknown>;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null) continue;
          entry = parsed as Record<string, unknown>;
        } catch {
          // Truncated trailing line from the fixed-size head read, or
          // genuine garbage. Either way, stop — a partial line is
          // always the last one we got.
          break;
        }
        const ts = entry.timestamp;
        if (typeof ts !== "string") continue;
        const parsedTs = Date.parse(ts);
        if (!Number.isNaN(parsedTs)) {
          result = parsedTs / 1000;
          break;
        }
      }
    } catch {
      result = null;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed or invalid
        }
      }
    }

    startTimeCache.set(path, result);
    return result;
  },

  parseRecord(line: string): NormalizedRecord | null {
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return null;
      entry = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = entry.type;
    // Everything that isn't a conversational turn (attachment,
    // hook_success, mode, total_tokens_reminder, ...) is invisible to
    // state inference.
    if (type !== "assistant" && type !== "user") return null;

    const msg = (entry.message ?? {}) as Record<string, unknown>;
    const content = msg.content ?? [];

    if (type === "assistant") {
      const rawStop = msg.stop_reason;
      const stopReason =
        typeof rawStop === "string" ? (STOP_REASON_MAP[rawStop] ?? rawStop) : null;

      const toolCallIds: string[] = [];
      if (Array.isArray(content)) {
        for (const item of content as ContentItem[]) {
          if (typeof item !== "object" || item === null) continue;
          if (item.type !== "tool_use") continue;
          if (typeof item.id === "string") toolCallIds.push(item.id);
        }
      }

      // Claude signals a failed turn two different ways, and both
      // occur in the wild:
      //
      //   - a top-level `error` string on the record, and
      //   - `isApiErrorMessage: true` with the human-readable reason
      //     in the text body (e.g. "API Error: 503 overloaded").
      //
      // Surfacing either as `errorMessage` gives us pi's ERROR state
      // *and* lets the notifier's retryable-error suppression work
      // unchanged, since it matches on the message text.
      const text = textPreview(content);
      const topLevelError = typeof entry.error === "string" ? entry.error : null;
      const errorMessage =
        topLevelError ??
        (entry.isApiErrorMessage === true ? (text ?? "API error") : null);

      return normalizedRecord("assistant", {
        stopReason: errorMessage !== null ? "error" : stopReason,
        errorMessage,
        text,
        toolCallIds,
        tokens: sumUsage(msg.usage as Record<string, unknown> | undefined),
        // Claude's JSONL carries no cost field; the UI shows 0 rather
        // than a fabricated estimate.
        costUsd: 0,
      });
    }

    // A `user` record is either a real prompt or the transport for
    // tool results. Tool results must map to pi's `toolResult` role
    // so pending-tool-call tracking behaves identically.
    if (Array.isArray(content)) {
      for (const item of content as ContentItem[]) {
        if (typeof item !== "object" || item === null) continue;
        if (item.type !== "tool_result") continue;
        return normalizedRecord("toolResult", {
          toolCallId: typeof item.tool_use_id === "string" ? item.tool_use_id : null,
        });
      }
    }

    return normalizedRecord("user", { text: textPreview(content) });
  },
};
