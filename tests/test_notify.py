"""Notifier tests: state transitions, debounce, and retry-error suppression.

These tests don't touch `notify-send` itself; they observe the in-app
`on_transition` callback as a stand-in for "would have fired a desktop
notification". `_send_notification` no-ops when `notify-send` isn't on PATH
(see `_send_notification`'s `shutil.which` guard), so it's safe to leave it
unmocked in the test environment.
"""

from __future__ import annotations

import pytest

from pi_monitor.notify import Notifier
from pi_monitor.state import AgentState


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _capturing_notifier(**kwargs) -> tuple[Notifier, list[tuple]]:
    """Notifier wired to a list-collecting `on_transition` callback.

    Returns `(notifier, calls)`. Each call appended to `calls` is the
    tuple `(pane_id, state, title, body)` exactly as the in-TUI toast
    handler would receive it.
    """
    calls: list[tuple] = []

    def on_transition(pane_id, state, title, body):
        calls.append((pane_id, state, title, body))

    n = Notifier(on_transition=on_transition, **kwargs)
    return n, calls


# ---------------------------------------------------------------------------
# Existing transition behaviour the suppression logic must not regress
# ---------------------------------------------------------------------------


def test_transition_into_idle_fires(monkeypatch: pytest.MonkeyPatch):
    n, calls = _capturing_notifier()
    n.transition("p1", AgentState.WORKING, now=0.0)
    fired = n.transition("p1", AgentState.IDLE, now=10.0)
    assert fired is True
    assert calls == [("p1", AgentState.IDLE, "pi-monitor · p1", "agent state: idle")]


def test_transition_into_non_retryable_error_fires_immediately():
    n, calls = _capturing_notifier()
    n.transition("p1", AgentState.WORKING, now=0.0)
    fired = n.transition(
        "p1",
        AgentState.ERROR,
        error_message="Authentication failed: bad API key",
        now=10.0,
    )
    assert fired is True
    assert len(calls) == 1
    assert calls[0][1] == AgentState.ERROR


def test_no_fire_on_repeat_state():
    # Times must clear the 2 s debounce sentinel (`_last_fire` defaults
    # to 0.0, so a transition at now<2.0 is itself suppressed).
    n, calls = _capturing_notifier()
    n.transition("p1", AgentState.IDLE, now=10.0)
    fired = n.transition("p1", AgentState.IDLE, now=20.0)
    assert fired is False
    assert len(calls) == 1


def test_disabled_notifier_skips_fire():
    n, calls = _capturing_notifier(enabled=False)
    n.transition("p1", AgentState.WORKING, now=0.0)
    fired = n.transition("p1", AgentState.IDLE, now=10.0)
    assert fired is False
    assert calls == []


def test_seed_from_does_not_fire():
    n, calls = _capturing_notifier()
    n.seed_from([("p1", AgentState.IDLE), ("p2", AgentState.ERROR)])
    # Transitioning to the SAME state must not fire (already seeded).
    assert n.transition("p1", AgentState.IDLE, now=1.0) is False
    assert n.transition("p2", AgentState.ERROR, now=1.0) is False
    assert calls == []


# ---------------------------------------------------------------------------
# Retry-error suppression
# ---------------------------------------------------------------------------


def test_retryable_error_does_not_fire_immediately():
    """The whole point of this feature: a single transient error landing
    must NOT produce a desktop notification at the moment it lands."""
    n, calls = _capturing_notifier(retry_suppression_s=10.0)
    n.transition("p1", AgentState.WORKING, now=0.0)
    fired = n.transition(
        "p1",
        AgentState.ERROR,
        error_message="overloaded_error",
        now=5.0,
    )
    assert fired is False
    assert calls == []
    # And `tick()` before the deadline must keep it deferred.
    assert n.tick(now=5.5) == 0
    assert calls == []


def test_retryable_error_recovery_drops_pending_notification():
    """Pi recovers (transitions to WORKING) within the suppression window
    → the pending ERROR notification is cancelled and never fires, even
    after the deadline passes."""
    n, calls = _capturing_notifier(retry_suppression_s=10.0)
    n.transition("p1", AgentState.WORKING, now=0.0)
    n.transition("p1", AgentState.ERROR, error_message="503", now=5.0)
    # Pi's retry succeeds before the window closes.
    n.transition("p1", AgentState.WORKING, now=8.0)
    # Tick well past the original deadline — nothing should fire.
    n.tick(now=100.0)
    assert calls == []


def test_retryable_error_persisting_past_window_fires_via_tick():
    """Pi keeps reporting the same retryable error past the suppression
    window → tick() promotes the deferred entry to a real notification."""
    n, calls = _capturing_notifier(retry_suppression_s=10.0)
    n.transition("p1", AgentState.WORKING, now=0.0)
    n.transition(
        "p1", AgentState.ERROR, error_message="rate limited", now=5.0
    )
    # Right at deadline — fire.
    fired = n.tick(now=15.0)
    assert fired == 1
    assert len(calls) == 1
    assert calls[0][1] == AgentState.ERROR
    # A second tick with no new state change must not double-fire.
    assert n.tick(now=20.0) == 0
    assert len(calls) == 1


def test_retryable_then_idle_during_window_fires_idle_only():
    """Pi errors transiently, then lands at IDLE before the suppression
    window expires. The deferred ERROR must drop; the IDLE notifies
    normally."""
    n, calls = _capturing_notifier(retry_suppression_s=10.0)
    n.transition("p1", AgentState.WORKING, now=0.0)
    n.transition("p1", AgentState.ERROR, error_message="overloaded", now=5.0)
    n.transition("p1", AgentState.IDLE, now=8.0)
    # Past the original deadline, only the IDLE should be in `calls`.
    n.tick(now=20.0)
    assert [c[1] for c in calls] == [AgentState.IDLE]


def test_tick_respects_disabled_after_deferral():
    """Disabling the notifier between defer and deadline must suppress
    the deferred fire — mute is mute, even retroactively."""
    n, calls = _capturing_notifier(retry_suppression_s=5.0)
    n.transition("p1", AgentState.WORKING, now=0.0)
    n.transition(
        "p1", AgentState.ERROR, error_message="upstream connect error", now=1.0
    )
    n.enabled = False
    fired = n.tick(now=10.0)
    assert fired == 0
    assert calls == []


def test_non_retryable_error_unaffected_by_suppression():
    """Sanity: a retryable suppression window must not eat genuine
    non-transient errors."""
    n, calls = _capturing_notifier(retry_suppression_s=10.0)
    n.transition("p1", AgentState.WORKING, now=0.0)
    fired = n.transition(
        "p1",
        AgentState.ERROR,
        error_message="Tool 'bash' not found",
        now=10.0,
    )
    assert fired is True
    assert len(calls) == 1
    assert calls[0][1] == AgentState.ERROR


def test_zero_suppression_disables_deferral():
    """`retry_suppression_s=0` disables the feature: even retryable
    errors fire immediately, matching pre-suppression behaviour."""
    n, calls = _capturing_notifier(retry_suppression_s=0.0)
    n.transition("p1", AgentState.WORKING, now=0.0)
    fired = n.transition(
        "p1", AgentState.ERROR, error_message="429", now=10.0
    )
    assert fired is True
    assert len(calls) == 1
