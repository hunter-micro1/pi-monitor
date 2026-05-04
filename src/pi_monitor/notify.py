"""Desktop notifications + tiny config persistence.

We only fire notifications for transitions *into* a "needs-attention" state
(idle / stalled / error). Working → idle fires; idle → working does not.
Each pane gets a 2-second debounce so flapping states don't spam the user.

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
from typing import Iterable

from .state import AgentState

ATTENTION_STATES = frozenset({AgentState.IDLE, AgentState.STALLED, AgentState.ERROR})

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


@dataclass
class Notifier:
    """Tracks last-known state per pane and fires `notify-send` on transitions
    into attention states. Debounces duplicate transitions inside `debounce_s`.
    """

    debounce_s: float = 2.0
    enabled: bool = True
    _last_state: dict[str, AgentState] = field(default_factory=dict)
    _last_fire: dict[str, float] = field(default_factory=dict)

    def transition(
        self,
        pane_id: str,
        new_state: AgentState,
        *,
        title: str | None = None,
        body: str | None = None,
        now: float | None = None,
    ) -> bool:
        """Record a state observation and maybe fire a notification.

        Returns True iff a notification was actually fired.
        """
        now = now if now is not None else time.time()
        prev = self._last_state.get(pane_id)
        self._last_state[pane_id] = new_state

        if prev == new_state:
            return False
        if new_state not in ATTENTION_STATES:
            return False
        if not self.enabled:
            return False

        last_fire = self._last_fire.get(pane_id, 0.0)
        if now - last_fire < self.debounce_s:
            return False
        self._last_fire[pane_id] = now

        _send_notification(
            title or f"pi-monitor · {pane_id}",
            body or f"agent state: {new_state.value}",
            urgency="critical" if new_state == AgentState.ERROR else "normal",
        )
        return True

    def update_state_only(self, pane_id: str, new_state: AgentState) -> None:
        """Seed the tracker without firing notifications. Used on first poll
        so we don't get a flood of "idle" notifications when the TUI starts."""
        self._last_state[pane_id] = new_state

    def seed_from(self, observations: Iterable[tuple[str, AgentState]]) -> None:
        for pane_id, state in observations:
            self.update_state_only(pane_id, state)


# ---------------------------------------------------------------------------
# notify-send wrapper
# ---------------------------------------------------------------------------


def _send_notification(title: str, body: str, urgency: str = "normal") -> None:
    if shutil.which("notify-send") is None:
        return
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
