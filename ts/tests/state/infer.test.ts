/**
 * Tests for state inference + the retryable-error matcher.
 *
 * Direct equivalents of the `test_infer_*` and
 * `test_is_retryable_error_message_*` blocks in
 * `tests/test_state.py`. Same fixtures, same intent.
 */

import { describe, expect, it } from "vitest";

import {
  IDLE_THRESHOLD_S,
  RETRYABLE_ERROR_RE,
  STARTING_GRACE_S,
  inferState,
  isRetryableErrorMessage,
} from "../../src/state/infer.js";
import type { JsonlSnapshot } from "../../src/state/types.js";

// ---------------------------------------------------------------------------
// Fixture helper: build a JsonlSnapshot with sensible defaults so each
// test only specifies the fields it cares about. Mirrors the Python
// dataclass constructor's keyword-arg ergonomics.
// ---------------------------------------------------------------------------

function snapshot(fields: Partial<JsonlSnapshot> = {}): JsonlSnapshot {
  return {
    mtime: 0.0,
    lastRole: null,
    lastStopReason: null,
    lastError: null,
    pendingToolCalls: 0,
    lastAssistantPreview: null,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Constants are exported for callers (resolver phase 2.3)
// ---------------------------------------------------------------------------

describe("inference constants", () => {
  it("matches the Python IDLE_THRESHOLD_S", () => {
    expect(IDLE_THRESHOLD_S).toBe(1.0);
  });

  it("matches the Python STARTING_GRACE_S", () => {
    expect(STARTING_GRACE_S).toBe(30.0);
  });
});

// ---------------------------------------------------------------------------
// inferState: snapshot -> state + thresholds
// ---------------------------------------------------------------------------

describe("inferState", () => {
  it("promotes assistant+stop to idle once mtime is stable past the threshold", () => {
    const snap = snapshot({ lastRole: "assistant", lastStopReason: "stop" });
    const { state, idleSeconds } = inferState(snap, 2.0);
    expect(state).toBe("idle");
    expect(idleSeconds).toBe(2.0);
  });

  it("keeps assistant+stop as working below the threshold", () => {
    const snap = snapshot({ lastRole: "assistant", lastStopReason: "stop" });
    expect(inferState(snap, 0.5).state).toBe("working");
  });

  it("tooluse with pending calls is always working, regardless of idle time " +
    "(we can't tell 'still running' from 'awaiting user' from outside)", () => {
    const snap = snapshot({
      lastRole: "assistant",
      lastStopReason: "toolUse",
      pendingToolCalls: 1,
    });
    for (const now of [1.0, 30.0, 600.0, 10000.0]) {
      expect(inferState(snap, now).state).toBe("working");
    }
  });

  it("tooluse with no pending calls is also working (mid-stream turn)", () => {
    const snap = snapshot({
      lastRole: "assistant",
      lastStopReason: "toolUse",
      pendingToolCalls: 0,
    });
    expect(inferState(snap, 100.0).state).toBe("working");
  });

  it("error stop-reason -> error", () => {
    const snap = snapshot({ lastRole: "assistant", lastStopReason: "error" });
    expect(inferState(snap, 100.0).state).toBe("error");
  });

  it("error message takes priority over a benign stop-reason", () => {
    const snap = snapshot({
      lastRole: "assistant",
      lastStopReason: "stop",
      lastError: "boom",
    });
    expect(inferState(snap, 100.0).state).toBe("error");
  });

  it("toolResult is working", () => {
    const snap = snapshot({ lastRole: "toolResult" });
    expect(inferState(snap, 100.0).state).toBe("working");
  });

  it("user message is working", () => {
    const snap = snapshot({ lastRole: "user" });
    expect(inferState(snap, 100.0).state).toBe("working");
  });

  it("bashExecution and custom roles are working", () => {
    expect(inferState(snapshot({ lastRole: "bashExecution" }), 100.0).state).toBe(
      "working",
    );
    expect(inferState(snapshot({ lastRole: "custom" }), 100.0).state).toBe("working");
  });

  it("null snapshot -> unknown with idleSeconds=0", () => {
    const result = inferState(null, 100.0);
    expect(result.state).toBe("unknown");
    expect(result.idleSeconds).toBe(0.0);
  });

  it("aborted stop-reason past threshold -> idle", () => {
    const snap = snapshot({ lastRole: "assistant", lastStopReason: "aborted" });
    expect(inferState(snap, 100.0).state).toBe("idle");
  });

  it("length stop-reason past threshold -> idle", () => {
    const snap = snapshot({ lastRole: "assistant", lastStopReason: "length" });
    expect(inferState(snap, 100.0).state).toBe("idle");
  });

  it("unknown stop-reason -> working (treat as mid-turn)", () => {
    const snap = snapshot({ lastRole: "assistant", lastStopReason: "weird" });
    expect(inferState(snap, 100.0).state).toBe("working");
  });

  it("idleSeconds clamps to zero for clock skew where mtime > now", () => {
    // Defensive: if filesystem mtime races slightly ahead of our `now`
    // we don't want a negative idle window leaking into the UI.
    const snap = snapshot({ mtime: 100.0 });
    const { idleSeconds } = inferState(snap, 99.0);
    expect(idleSeconds).toBe(0.0);
  });

  it("uses Date.now()/1000 when nowSeconds is omitted", () => {
    const snap = snapshot({ mtime: Date.now() / 1000 });
    // Should be near zero. Allow a generous slack so flaky CI doesn't
    // false-fail this; the contract is "uses real wall-clock if no
    // override is provided", not "<5ms accuracy".
    const { idleSeconds } = inferState(snap);
    expect(idleSeconds).toBeLessThan(2.0);
    expect(idleSeconds).toBeGreaterThanOrEqual(0.0);
  });
});

// ---------------------------------------------------------------------------
// isRetryableErrorMessage: matches pi's auto-retried transients
// ---------------------------------------------------------------------------

describe("isRetryableErrorMessage", () => {
  it("matches the real shapes pi's _isRetryableError regex catches", () => {
    expect(isRetryableErrorMessage("Anthropic API: overloaded_error")).toBe(true);
    expect(isRetryableErrorMessage("HTTP 429 Too Many Requests")).toBe(true);
    expect(isRetryableErrorMessage("503 service unavailable")).toBe(true);
    expect(isRetryableErrorMessage("fetch failed: connection refused")).toBe(true);
    expect(isRetryableErrorMessage("socket hang up")).toBe(true);
    expect(isRetryableErrorMessage("upstream connect error")).toBe(true);
    expect(isRetryableErrorMessage("Request timed out")).toBe(true);
  });

  it("rejects null / empty / undefined", () => {
    expect(isRetryableErrorMessage(null)).toBe(false);
    expect(isRetryableErrorMessage(undefined)).toBe(false);
    expect(isRetryableErrorMessage("")).toBe(false);
  });

  it("rejects real, non-retryable failure shapes", () => {
    expect(isRetryableErrorMessage("Tool 'bash' not found")).toBe(false);
    expect(isRetryableErrorMessage("Invalid argument: missing 'path'")).toBe(false);
    expect(isRetryableErrorMessage("Authentication failed: bad API key")).toBe(false);
  });

  it("is case-insensitive (the underlying regex carries the /i flag)", () => {
    expect(RETRYABLE_ERROR_RE.flags).toContain("i");
    expect(isRetryableErrorMessage("OVERLOADED")).toBe(true);
    expect(isRetryableErrorMessage("Internal Error")).toBe(true);
  });
});
