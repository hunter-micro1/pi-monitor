/**
 * State inference: map a JsonlSnapshot to an AgentState.
 *
 * Direct port of `infer_state` and `is_retryable_error_message` from
 * `src/pi_monitor/state.py`. Same thresholds, same retryable-error
 * regex, same priority order so the test corpus from `test_state.py`
 * ports straight over.
 */

import type { AgentState, JsonlSnapshot } from "./types.js";

/**
 * Minimum stable-mtime time before we promote "assistant just stopped"
 * to `idle`. We deliberately do NOT track a separate "stalled" state \u2014
 * from external observation we cannot reliably distinguish "tool
 * taking a long time" from "tool awaiting user confirmation" (pi only
 * writes complete message entries to the JSONL, never streaming
 * events). Reporting one as the other is more confusing than just
 * calling it WORKING and trusting the user to look at the pane (via
 * the preview) when they want to engage.
 *
 * Mirrors `IDLE_THRESHOLD_S` in the Python build.
 */
export const IDLE_THRESHOLD_S = 1.0;

/**
 * How long after pi launches we keep showing a no-file pane as
 * WORKING instead of UNKNOWN. SessionManager._persist only flushes
 * the JSONL after the first assistant message lands (`hasAssistant`
 * guard), so a freshly-launched pi that's actively streaming its
 * first reply has zero bytes on disk. Treating that window as WORKING
 * avoids a confusing "?" glyph for every fresh launch. Past the grace
 * window a no-file pane almost certainly means the user just hasn't
 * typed anything yet, so we fall back to UNKNOWN \u2014 never IDLE, which
 * would notify.
 *
 * Mirrors `STARTING_GRACE_S` in the Python build. Used by the
 * resolver, not by `inferState` itself.
 */
export const STARTING_GRACE_S = 30.0;

/**
 * Errors pi auto-retries with exponential backoff. Mirrors
 * `_isRetryableError` in pi-coding-agent's `agent-session.js` and
 * `_RETRYABLE_ERROR_RE` in the Python build of pi-monitor.
 *
 * When an assistant lands with `stopReason: "error"` AND its
 * `errorMessage` matches this pattern, pi is in the middle of
 * `auto_retry_start..auto_retry_end` and will most likely recover
 * within a few seconds. The Notifier uses this to suppress the
 * desktop notification for a short window so transient 429/503/network
 * blips don't spam the user.
 *
 * Keep in sync with the upstream regex; if pi's list grows we'll
 * match a subset until updated (worst case: a real new transient
 * briefly fires a notification, the pre-suppression behavior).
 */
export const RETRYABLE_ERROR_RE =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

/**
 * True if `msg` looks like one of pi's auto-retried transient errors.
 * Used by the Notifier to defer ERROR notifications during pi's
 * exponential-backoff window. Empty / null / undefined are treated
 * as non-retryable \u2014 we only suppress when we have a concrete error
 * string to match.
 */
export function isRetryableErrorMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return RETRYABLE_ERROR_RE.test(msg);
}

/**
 * Result of a state inference call: the inferred state plus seconds
 * since the underlying JSONL was last written.
 */
export interface InferResult {
  state: AgentState;
  idleSeconds: number;
}

/**
 * Map a snapshot to an `AgentState` plus seconds since last write.
 *
 * Three meaningful states:
 *   ERROR    \u2014 last assistant has an error
 *   IDLE     \u2014 last entry is `assistant` with stopReason in
 *              {stop, length, aborted} AND mtime stable for at
 *              least IDLE_THRESHOLD_S seconds.
 *   WORKING  \u2014 anything else (toolUse pending, mid-stream,
 *              user/toolResult, bashExecution, custom).
 *
 * `now` defaults to `Date.now() / 1000` (Unix seconds, fractional)
 * but is overridable for deterministic tests \u2014 same shape as the
 * Python helper's `now: float | None = None` parameter.
 */
export function inferState(
  snapshot: JsonlSnapshot | null,
  nowSeconds?: number,
): InferResult {
  if (snapshot === null) {
    return { state: "unknown", idleSeconds: 0.0 };
  }
  const now = nowSeconds ?? Date.now() / 1000;
  const idleSeconds = Math.max(0.0, now - snapshot.mtime);

  if (snapshot.lastError) {
    return { state: "error", idleSeconds };
  }
  if (snapshot.lastRole === "assistant") {
    const sr = snapshot.lastStopReason;
    if (sr === "error") {
      return { state: "error", idleSeconds };
    }
    if (sr === "stop" || sr === "length" || sr === "aborted") {
      if (idleSeconds >= IDLE_THRESHOLD_S) {
        return { state: "idle", idleSeconds };
      }
      return { state: "working", idleSeconds };
    }
    // toolUse / unknown stopReason \u2014 the agent is mid-turn.
    return { state: "working", idleSeconds };
  }
  if (
    snapshot.lastRole === "toolResult" ||
    snapshot.lastRole === "user" ||
    snapshot.lastRole === "bashExecution" ||
    snapshot.lastRole === "custom"
  ) {
    return { state: "working", idleSeconds };
  }
  return { state: "unknown", idleSeconds };
}
