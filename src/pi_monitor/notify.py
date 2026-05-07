"""Desktop notifications + tiny config persistence.

We only fire notifications for transitions *into* a "needs-attention" state
(idle / error). Working → idle fires; idle → working does not.
Each pane gets a 2-second debounce so flapping states don't spam the user.

ERROR transitions whose `errorMessage` looks like one of pi's auto-retried
transients (overload / 429 / network blips) are *deferred* by
`retry_suppression_s`. If the pane recovers to a non-error state before the
window expires the notification is dropped entirely; otherwise it fires
as a real ERROR. This kills the false desktop alarms during pi's
exponential-backoff auto-retry loop without losing notifications for
actually-broken sessions.

Config lives at `~/.config/pi-monitor/config.json` and is touched only when
the user toggles a setting from the TUI (mute, sort mode).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from .state import AgentState, is_retryable_error_message

# All states that warrant a desktop notification on entry. WAITING
# (heartbeat-only) is included because it means the agent is blocked on
# a user decision — every bit as much "needs you" as IDLE. RETRYING is
# deliberately NOT here: pi handles retries without user action, so we
# stay silent and let the user keep doing whatever they were doing.
ATTENTION_STATES = frozenset({AgentState.IDLE, AgentState.WAITING, AgentState.ERROR})

CONFIG_PATH = Path.home() / ".config" / "pi-monitor" / "config.json"
DEFAULT_CONFIG = {
    "notifications_enabled": True,
    "sort_mode": "tmux",  # or "status"
}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return dict(DEFAULT_CONFIG)
    try:
        data = json.loads(CONFIG_PATH.read_text())
    except (ValueError, OSError):
        return dict(DEFAULT_CONFIG)
    merged = dict(DEFAULT_CONFIG)
    merged.update(data if isinstance(data, dict) else {})
    return merged


def save_config(config: dict) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n")


# ---------------------------------------------------------------------------
# Notifier
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _PendingError:
    """An ERROR transition deferred while pi might be auto-retrying."""

    deadline: float
    title: str
    body: str


@dataclass
class Notifier:
    """Tracks last-known state per pane and fires `notify-send` on transitions
    into attention states. Debounces duplicate transitions inside `debounce_s`.

    ERROR transitions with a retryable `error_message` are held for
    `retry_suppression_s` and only fired if the pane is still in ERROR when
    the window expires. Callers must pump `tick(now)` periodically (e.g.
    once per poll loop) so deferred errors actually get released; without
    a pump the suppression window is effectively infinite.

    The TUI installs `on_transition` to also receive an in-TUI toast on the
    same trigger. The callback runs only when `enabled` is True (mute affects
    both desktop notifications and in-app toasts).
    """

    debounce_s: float = 2.0
    retry_suppression_s: float = 10.0
    enabled: bool = True
    on_transition: Callable[[str, AgentState, str, str], None] | None = None
    _last_state: dict[str, AgentState] = field(default_factory=dict)
    _last_fire: dict[str, float] = field(default_factory=dict)
    _pending: dict[str, _PendingError] = field(default_factory=dict)

    def transition(
        self,
        pane_id: str,
        new_state: AgentState,
        *,
        title: str | None = None,
        body: str | None = None,
        error_message: str | None = None,
        now: float | None = None,
    ) -> bool:
        """Record a state observation and maybe fire a notification.

        Returns True iff a notification was actually fired *now*. A return
        of False can mean: no transition, suppressed by debounce, deferred
        by retry suppression, or attention-not-required.
        """
        now = now if now is not None else time.time()
        prev = self._last_state.get(pane_id)
        self._last_state[pane_id] = new_state

        # Any non-ERROR transition cancels a pending suppressed error —
        # whatever pi was retrying, it's not retrying anymore.
        if new_state != AgentState.ERROR:
            self._pending.pop(pane_id, None)

        if prev == new_state:
            return False
        if new_state not in ATTENTION_STATES:
            return False
        if not self.enabled:
            return False

        # ERROR with a retryable error message — defer instead of firing.
        # If pi recovers (next non-ERROR transition) we drop the pending
        # entry above. Otherwise `tick()` will fire it once the window
        # expires.
        if (
            new_state == AgentState.ERROR
            and self.retry_suppression_s > 0
            and is_retryable_error_message(error_message)
        ):
            resolved_title = title or f"pi-monitor · {pane_id}"
            resolved_body = body or f"agent state: {new_state.value}"
            self._pending[pane_id] = _PendingError(
                deadline=now + self.retry_suppression_s,
                title=resolved_title,
                body=resolved_body,
            )
            return False

        last_fire = self._last_fire.get(pane_id, 0.0)
        if now - last_fire < self.debounce_s:
            return False
        self._last_fire[pane_id] = now

        resolved_title = title or f"pi-monitor · {pane_id}"
        resolved_body = body or f"agent state: {new_state.value}"
        self._fire(pane_id, new_state, resolved_title, resolved_body)
        return True

    def tick(self, now: float | None = None) -> int:
        """Release any deferred ERROR notifications whose suppression window
        has expired. Returns the number of notifications fired.

        Call this once per poll tick. Without it, deferred errors never
        surface — this is the only place suppressed ERRORs get unblocked.
        """
        if not self._pending:
            return 0
        now = now if now is not None else time.time()
        fired = 0
        # Materialize the iter; we mutate _pending inside the loop.
        for pane_id, pending in list(self._pending.items()):
            if now < pending.deadline:
                continue
            self._pending.pop(pane_id, None)
            if not self.enabled:
                continue
            # Only fire if the pane is still in ERROR. A non-ERROR
            # transition would have cleared the pending entry, so this
            # check is belt-and-braces; keep it for the case where a
            # caller calls tick() before transition() in the same loop.
            if self._last_state.get(pane_id) != AgentState.ERROR:
                continue
            last_fire = self._last_fire.get(pane_id, 0.0)
            if now - last_fire < self.debounce_s:
                continue
            self._last_fire[pane_id] = now
            self._fire(pane_id, AgentState.ERROR, pending.title, pending.body)
            fired += 1
        return fired

    def _fire(
        self,
        pane_id: str,
        state: AgentState,
        title: str,
        body: str,
    ) -> None:
        """Run the in-TUI toast callback (if any) and the desktop notify.
        Shared between the immediate-fire and deferred-fire paths."""
        if self.on_transition is not None:
            try:
                self.on_transition(pane_id, state, title, body)
            except Exception:
                # In-app callback failures must never block desktop notifications.
                pass
        _send_notification(
            title,
            body,
            urgency="critical" if state == AgentState.ERROR else "normal",
        )

    def update_state_only(self, pane_id: str, new_state: AgentState) -> None:
        """Seed the tracker without firing notifications. Used on first poll
        so we don't get a flood of "idle" notifications when the TUI starts."""
        self._last_state[pane_id] = new_state

    def seed_from(self, observations: Iterable[tuple[str, AgentState]]) -> None:
        for pane_id, state in observations:
            self.update_state_only(pane_id, state)


# ---------------------------------------------------------------------------
# Desktop notification wrapper
# ---------------------------------------------------------------------------


def _send_notification(title: str, body: str, urgency: str = "normal") -> None:
    """Fire a desktop notification, picking the right transport for the OS.

    Linux / *BSD with libnotify: shells out to `notify-send` (the same
    integration we've always had).

    macOS: shells out to `osascript` and uses AppleScript's `display
    notification` action, which routes through Notification Center. The
    body and title are quoted via `json.dumps` so any embedded quotes
    don't break the AppleScript expression — JSON's string escaping
    happens to be a strict subset of AppleScript's, so this is safe.
    `urgency` is a libnotify concept that AppleScript doesn't support,
    so it's ignored on macOS.

    Falls back to a no-op when neither tool is available (e.g. headless
    SSH sessions, CI). Notifications are advisory; never raise.
    """
    if shutil.which("notify-send") is not None:
        try:
            subprocess.run(
                [
                    "notify-send",
                    "--app-name=pi-monitor",
                    "--urgency",
                    urgency,
                    title,
                    body,
                ],
                capture_output=True,
                timeout=2.0,
            )
        except (subprocess.SubprocessError, OSError):
            pass
        return
    if shutil.which("osascript") is not None:
        # `json.dumps` gives us a properly-escaped, double-quoted string
        # that AppleScript will accept verbatim.
        script = (
            f"display notification {json.dumps(body)} with title {json.dumps(title)}"
        )
        try:
            subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                timeout=2.0,
            )
        except (subprocess.SubprocessError, OSError):
            pass
        return
