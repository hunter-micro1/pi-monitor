/**
 * Tests for the Notifier — debounce, retry suppression, mute,
 * tick-released deferred errors.
 *
 * Direct equivalents of the `test_*` blocks in
 * `tests/test_notify.py`. Where the Python tests use a list of
 * tuples for the `on_transition` capture, we use the same shape.
 * Where Python tests rely on an unmocked `_send_notification` (which
 * silently no-ops when `notify-send` isn't on PATH), we pass a
 * spy `notifyTransport` so we can also assert on the desktop dispatch.
 */

import { describe, expect, it, vi } from "vitest";

import { Notifier, type TransitionCallback } from "../../src/notify/notifier.js";
import type { AgentState } from "../../src/state/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedCall {
  paneId: string;
  state: AgentState;
  title: string;
  body: string;
}

function capturingNotifier(options: ConstructorParameters<typeof Notifier>[0] = {}): {
  notifier: Notifier;
  calls: CapturedCall[];
  transport: ReturnType<typeof vi.fn>;
} {
  const calls: CapturedCall[] = [];
  const onTransition: TransitionCallback = (paneId, state, title, body) => {
    calls.push({ paneId, state, title, body });
  };
  const transport = vi.fn();
  const notifier = new Notifier({
    onTransition,
    notifyTransport: transport,
    ...options,
  });
  return { notifier, calls, transport };
}

// ---------------------------------------------------------------------------
// Existing transition behaviour the suppression logic must not regress
// ---------------------------------------------------------------------------

describe("Notifier — basic transitions", () => {
  it("fires on transition into idle", () => {
    const { notifier, calls } = capturingNotifier();
    notifier.transition("p1", "working", { now: 0.0 });
    const fired = notifier.transition("p1", "idle", { now: 10.0 });
    expect(fired).toBe(true);
    expect(calls).toEqual([
      {
        paneId: "p1",
        state: "idle",
        title: "pi-monitor \u00b7 p1",
        body: "agent state: idle",
      },
    ]);
  });

  it("fires immediately on a non-retryable error", () => {
    const { notifier, calls } = capturingNotifier();
    notifier.transition("p1", "working", { now: 0.0 });
    const fired = notifier.transition("p1", "error", {
      errorMessage: "Authentication failed: bad API key",
      now: 10.0,
    });
    expect(fired).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe("error");
  });

  it("debounces a repeat-state transition", () => {
    const { notifier, calls } = capturingNotifier();
    notifier.transition("p1", "idle", { now: 10.0 });
    const fired = notifier.transition("p1", "idle", { now: 20.0 });
    expect(fired).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("does not fire when disabled", () => {
    const { notifier, calls } = capturingNotifier({ enabled: false });
    notifier.transition("p1", "working", { now: 0.0 });
    const fired = notifier.transition("p1", "idle", { now: 10.0 });
    expect(fired).toBe(false);
    expect(calls).toEqual([]);
  });

  it("seedFrom does not fire", () => {
    const { notifier, calls } = capturingNotifier();
    notifier.seedFrom([
      ["p1", "idle"],
      ["p2", "error"],
    ]);
    expect(notifier.transition("p1", "idle", { now: 1.0 })).toBe(false);
    expect(notifier.transition("p2", "error", { now: 1.0 })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("calls the desktop transport with critical urgency on errors", () => {
    const { notifier, transport } = capturingNotifier();
    notifier.transition("p1", "working", { now: 0.0 });
    notifier.transition("p1", "error", {
      errorMessage: "Tool not found",
      now: 10.0,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[2]).toBe("critical");
  });

  it("calls the desktop transport with normal urgency on idle/waiting", () => {
    const { notifier, transport } = capturingNotifier();
    notifier.transition("p1", "working", { now: 0.0 });
    notifier.transition("p1", "idle", { now: 10.0 });
    expect(transport.mock.calls[0]?.[2]).toBe("normal");
  });
});

// ---------------------------------------------------------------------------
// Retry-error suppression
// ---------------------------------------------------------------------------

describe("Notifier — retry suppression", () => {
  it("does not fire immediately on a retryable error", () => {
    const { notifier, calls } = capturingNotifier({ retrySuppressionS: 10.0 });
    notifier.transition("p1", "working", { now: 0.0 });
    const fired = notifier.transition("p1", "error", {
      errorMessage: "overloaded_error",
      now: 5.0,
    });
    expect(fired).toBe(false);
    expect(calls).toEqual([]);
    // tick() before the deadline keeps it deferred.
    expect(notifier.tick(5.5)).toBe(0);
    expect(calls).toEqual([]);
  });

  it("recovery during the window cancels the deferred notification", () => {
    const { notifier, calls } = capturingNotifier({ retrySuppressionS: 10.0 });
    notifier.transition("p1", "working", { now: 0.0 });
    notifier.transition("p1", "error", { errorMessage: "503", now: 5.0 });
    notifier.transition("p1", "working", { now: 8.0 });
    notifier.tick(100.0);
    expect(calls).toEqual([]);
  });

  it("an error that persists past the window fires via tick()", () => {
    const { notifier, calls } = capturingNotifier({ retrySuppressionS: 10.0 });
    notifier.transition("p1", "working", { now: 0.0 });
    notifier.transition("p1", "error", {
      errorMessage: "rate limited",
      now: 5.0,
    });
    const firedCount = notifier.tick(15.0);
    expect(firedCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe("error");
    // Second tick with no new state must not double-fire.
    expect(notifier.tick(20.0)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("retryable error followed by idle within window fires idle only", () => {
    const { notifier, calls } = capturingNotifier({ retrySuppressionS: 10.0 });
    notifier.transition("p1", "working", { now: 0.0 });
    notifier.transition("p1", "error", {
      errorMessage: "overloaded",
      now: 5.0,
    });
    notifier.transition("p1", "idle", { now: 8.0 });
    notifier.tick(20.0);
    expect(calls.map((c) => c.state)).toEqual(["idle"]);
  });

  it("disabling between defer and deadline suppresses the deferred fire", () => {
    const { notifier, calls } = capturingNotifier({ retrySuppressionS: 5.0 });
    notifier.transition("p1", "working", { now: 0.0 });
    notifier.transition("p1", "error", {
      errorMessage: "upstream connect error",
      now: 1.0,
    });
    notifier.enabled = false;
    expect(notifier.tick(10.0)).toBe(0);
    expect(calls).toEqual([]);
  });

  it("non-retryable errors fire immediately even with suppression on", () => {
    const { notifier, calls } = capturingNotifier({ retrySuppressionS: 10.0 });
    notifier.transition("p1", "working", { now: 0.0 });
    const fired = notifier.transition("p1", "error", {
      errorMessage: "Tool 'bash' not found",
      now: 10.0,
    });
    expect(fired).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe("error");
  });

  it("retrySuppressionS=0 disables the feature entirely", () => {
    const { notifier, calls } = capturingNotifier({ retrySuppressionS: 0.0 });
    notifier.transition("p1", "working", { now: 0.0 });
    const fired = notifier.transition("p1", "error", {
      errorMessage: "429",
      now: 10.0,
    });
    expect(fired).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Callback safety: a throwing on_transition must not block the
// desktop transport.
// ---------------------------------------------------------------------------

describe("Notifier — callback safety", () => {
  it("a throwing onTransition does not prevent the desktop transport", () => {
    const transport = vi.fn();
    const notifier = new Notifier({
      onTransition: () => {
        throw new Error("boom");
      },
      notifyTransport: transport,
    });
    notifier.transition("p1", "working", { now: 0.0 });
    notifier.transition("p1", "idle", { now: 10.0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
