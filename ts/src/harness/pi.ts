/**
 * pi harness adapter.
 *
 * Extracted verbatim from the pre-harness `state/jsonl.ts` scanner
 * and `state/files.ts` path helpers. Behavior is intentionally
 * unchanged — the existing test corpus (ported 1:1 from the Python
 * build's `test_state.py`) is the regression net for that claim.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { firstTextPreview } from "./text.js";
import { type Harness, type NormalizedRecord, normalizedRecord } from "./types.js";

/**
 * pi's session directory layout:
 *   ~/.pi/agent/sessions/<cwd-encoded>/<timestamp>_<uuid>.jsonl
 *
 * Where `<cwd-encoded>` strips the leading slash and replaces every
 * `/` with `-`, then surrounds the result in `--...--`.
 */
export const PI_SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

/**
 * Session filenames pi writes look like:
 *   `2026-05-03T20-37-34-005Z_019def8f-86b5-77ac-96f5-302472f17757.jsonl`
 * The timestamp portion is ISO-8601 with `:` and `.` replaced by `-`
 * (filename-safe). We anchor at the start and stop at the `_<uuid>`
 * separator. Mirrors `_FILENAME_TS_RE` in the Python build.
 */
const FILENAME_TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;

/** Content-block shape pi uses. */
type ContentItem = { type?: unknown; id?: unknown };

export const piHarness: Harness = {
  id: "pi",
  label: "pi",
  commNames: ["pi"],
  supportsHeartbeat: true,

  defaultSessionsRoot(): string {
    return PI_SESSIONS_ROOT;
  },

  sessionDir(cwd: string, root: string = PI_SESSIONS_ROOT): string {
    const stripped = cwd.replace(/^\/+/, "");
    const encoded = stripped.replace(/\//g, "-");
    return join(root, `--${encoded}--`);
  },

  /**
   * pi encodes the session start time in the filename, so this is a
   * pure string parse — no file read. Returns `null` for names that
   * don't match (e.g. test fixtures with arbitrary names) so callers
   * fall back to mtime-based heuristics.
   */
  sessionStartTime(path: string): number | null {
    const base = path.replace(/^.*\//, "");
    const match = FILENAME_TS_RE.exec(base);
    if (match === null) return null;
    const [, date, h, m, s, ms] = match;
    const iso = `${date}T${h}:${m}:${s}.${ms}Z`;
    const parsed = Date.parse(iso);
    if (Number.isNaN(parsed)) return null;
    return parsed / 1000;
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
    if (entry.type !== "message") return null;

    const msg = (entry.message ?? {}) as Record<string, unknown>;
    const role = msg.role;
    const content = msg.content ?? [];

    if (role === "assistant") {
      // pi's stopReason vocabulary IS the normalized vocabulary —
      // the other adapters translate into it, so nothing to map here.
      const toolCallIds: string[] = [];
      if (Array.isArray(content)) {
        for (const item of content as ContentItem[]) {
          if (typeof item !== "object" || item === null) continue;
          if (item.type !== "toolCall") continue;
          if (typeof item.id === "string") toolCallIds.push(item.id);
        }
      }

      // Defensive: pi sometimes emits assistant turns without a usage
      // block (e.g. a reconstructed resume), so missing/malformed
      // fields fall through as zero.
      let tokens = 0;
      let costUsd = 0;
      const usage = msg.usage as Record<string, unknown> | undefined;
      if (usage && typeof usage === "object") {
        const total = usage.totalTokens;
        if (typeof total === "number" && Number.isFinite(total)) tokens = total;
        const cost = usage.cost as Record<string, unknown> | undefined;
        if (cost && typeof cost === "object") {
          const ct = cost.total;
          if (typeof ct === "number" && Number.isFinite(ct)) costUsd = ct;
        }
      }

      return normalizedRecord("assistant", {
        stopReason: typeof msg.stopReason === "string" ? msg.stopReason : null,
        errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : null,
        text: firstTextPreview(content),
        toolCallIds,
        tokens,
        costUsd,
      });
    }

    if (role === "toolResult") {
      return normalizedRecord("toolResult", {
        toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : null,
      });
    }

    if (role === "user") {
      return normalizedRecord("user", { text: firstTextPreview(content) });
    }

    if (role === "bashExecution" || role === "custom") {
      // Activity events; they move lastRole but carry no stop/tool
      // information of their own.
      return normalizedRecord(role);
    }

    return null;
  },
};
