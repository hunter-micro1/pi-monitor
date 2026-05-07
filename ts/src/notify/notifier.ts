/**
 * Notifier — state-change tracker that fires desktop notifications
 * (and in-TUI toast callbacks) on transitions into attention states.
 *
 * Direct port of the `Notifier` class in
 * `src/pi_monitor/notify.py`. Same debounce, same retry-suppression,
 * same `on_transition` callback contract. The desktop notification
 * transport itself is split out into a separate module (phase 2.x)
 * so it can be platform-mocked in tests; here we accept it as a
 * dependency so unit tests don't have to spawn `notify-send` /
 * `osascript`.
 */

import { isRetryableErrorMessage } from "../state/infer.js";
import type { AgentState } from "../state/types.js";

/**
 * States that warrant a desktop notification on entry. Mirrors
 * `ATTENTION_STATES` in the Python build. WAITING is included
 * because it means the agent is blocked on a user decision \u2014 every
 * bit as much "needs you" as IDLE. RETRYING is deliberately NOT
 * here: pi handles retries without user action, so we stay silent.
 */
export const ATTENTION_STATES = new Set<AgentState>(["idle", "waiting", "error"]);

/** Callback fired alongside the desktop notification (in-TUI toast). */
export type TransitionCallback = (
  paneId: string,
  state: AgentState,
  title: string,
  body: string,
) => void;

/**
 * Transport function for desktop notifications. The real
 * implementation (phase 2.x) shells out to notify-send / osascript;
 * tests pass a spy.
 */
export type NotifyTransport = (
  title: string,
  body: string,
  urgency: "normal" | "critical",
) => void;

interface PendingError {
  deadline: number;
  title: string;
  body: string;
}

export interface NotifierOptions {
  /**
   * Minimum seconds between two notifications for the same pane.
   * Mirrors `debounce_s` in the Python build (default 2.0).
   */
  debounceS?: number;
  /**
   * How long to defer an ERROR notification when the message looks
   * like a retryable transient. If the pane recovers within this
   * window the notification is dropped entirely.
   * Mirrors `retry_suppression_s` (default 10.0).
   */
  retrySuppressionS?: number;
  /** Whether notifications fire at all. Mirrors the `enabled` flag. */
  enabled?: boolean;
  /** Optional in-TUI toast bridge. */
  onTransition?: TransitionCallback;
  /**
   * Desktop-notification transport. Default is a no-op so the
   * Notifier is testable in isolation; callers wire in the real
   * notify-send/osascript dispatcher (phase 2.x) at App boot.
   */
  notifyTransport?: NotifyTransport;
}

export class Notifier {
  debounceS: number;
  retrySuppressionS: number;
  enabled: boolean;
  onTransition: TransitionCallback | null;
  private notifyTransport: NotifyTransport;
  private lastState: Map<string, AgentState> = new Map();
  private lastFire: Map<string, number> = new Map();
  private pending: Map<string, PendingError> = new Map();

  constructor(options: NotifierOptions = {}) {
    this.debounceS = options.debounceS ?? 2.0;
    this.retrySuppressionS = options.retrySuppressionS ?? 10.0;
    this.enabled = options.enabled ?? true;
    this.onTransition = options.onTransition ?? null;
    this.notifyTransport = options.notifyTransport ?? (() => undefined);
  }

  /**
   * Record a state observation and maybe fire a notification.
   * Returns true iff a notification actually fired *now*. A false
   * return can mean any of: no transition, suppressed by debounce,
   * deferred by retry suppression, attention-not-required, or muted.
   */
  transition(
    paneId: string,
    newState: AgentState,
    args: {
      title?: string;
      body?: string;
      errorMessage?: string | null;
      now?: number;
    } = {},
  ): boolean {
    const now = args.now ?? Date.now() / 1000;
    const prev = this.lastState.get(paneId);
    this.lastState.set(paneId, newState);

    // Any non-ERROR transition cancels a pending suppressed error \u2014
    // whatever pi was retrying, it's not retrying anymore.
    if (newState !== "error") {
      this.pending.delete(paneId);
    }

    if (prev === newState) return false;
    if (!ATTENTION_STATES.has(newState)) return false;
    if (!this.enabled) return false;

    // ERROR with a retryable message: defer instead of firing.
    if (
      newState === "error" &&
      this.retrySuppressionS > 0 &&
      isRetryableErrorMessage(args.errorMessage)
    ) {
      const title = args.title || `pi-monitor \u00b7 ${paneId}`;
      const body = args.body || `agent state: ${newState}`;
      this.pending.set(paneId, {
        deadline: now + this.retrySuppressionS,
        title,
        body,
      });
      return false;
    }

    const lastFire = this.lastFire.get(paneId) ?? 0.0;
    if (now - lastFire < this.debounceS) return false;
    this.lastFire.set(paneId, now);

    const title = args.title || `pi-monitor \u00b7 ${paneId}`;
    const body = args.body || `agent state: ${newState}`;
    this.fire(paneId, newState, title, body);
    return true;
  }

  /**
   * Release any deferred ERROR notifications whose suppression
   * window has expired. Returns the number that fired.
   *
   * Call once per poll tick. Without it, deferred errors never
   * surface \u2014 this is the only place suppressed ERRORs get unblocked.
   */
  tick(nowSeconds?: number): number {
    if (this.pending.size === 0) return 0;
    const now = nowSeconds ?? Date.now() / 1000;
    let fired = 0;
    // Materialize the iteration; we mutate `pending` inside the loop.
    for (const [paneId, p] of [...this.pending.entries()]) {
      if (now < p.deadline) continue;
      this.pending.delete(paneId);
      if (!this.enabled) continue;
      // Only fire if the pane is still in ERROR. A non-ERROR
      // transition would have cleared the pending entry, so this
      // check is belt-and-braces.
      if (this.lastState.get(paneId) !== "error") continue;
      const lastFire = this.lastFire.get(paneId) ?? 0.0;
      if (now - lastFire < this.debounceS) continue;
      this.lastFire.set(paneId, now);
      this.fire(paneId, "error", p.title, p.body);
      fired += 1;
    }
    return fired;
  }

  /** Seed the tracker without firing. Used on first poll. */
  updateStateOnly(paneId: string, newState: AgentState): void {
    this.lastState.set(paneId, newState);
  }

  seedFrom(observations: Iterable<[string, AgentState]>): void {
    for (const [paneId, state] of observations) {
      this.updateStateOnly(paneId, state);
    }
  }

  /**
   * Fire both the in-TUI toast (if installed) and the desktop
   * notification. Shared between the immediate and deferred paths.
   */
  private fire(paneId: string, state: AgentState, title: string, body: string): void {
    if (this.onTransition !== null) {
      try {
        this.onTransition(paneId, state, title, body);
      } catch {
        // In-app callback failures must never block desktop
        // notifications. Mirrors the Python try/except.
      }
    }
    this.notifyTransport(title, body, state === "error" ? "critical" : "normal");
  }
}
