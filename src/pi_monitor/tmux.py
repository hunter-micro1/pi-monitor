"""Thin wrappers over `tmux` for the bits we actually need.

Everything is shell-out via subprocess. tmux is fast enough that a poll loop
calling `list-panes` every 500ms doesn't show up in CPU graphs.

The monitor session is laid out as:

    monitor:0  ┌──── pane 0 (left) : the TUI
               └──── pane 1 (right) : the borrow slot

We address the right slot by `index 1` rather than by id because we need to
re-create it after each break-pane (panes carry their id with them when moved,
but new panes get fresh ids).
"""

from __future__ import annotations

import shlex
import shutil
import subprocess
from dataclasses import dataclass

MONITOR_SESSION = "monitor"
RESCUE_SESSION = "pi-monitor-rescued"
RIGHT_SLOT = f"{MONITOR_SESSION}:0.1"
LEFT_PANE = f"{MONITOR_SESSION}:0.0"


# ---------------------------------------------------------------------------
# Pane discovery
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Pane:
    pane_id: str  # tmux pane id like "%42"
    target: str  # "session:window.pane" e.g. "contracts:0.2"
    session: str
    window_index: int
    pane_index: int
    pid: int
    cwd: str
    title: str
    command: str  # pane_current_command, e.g. "pi" or "zsh"

    @property
    def is_pi(self) -> bool:
        return self.command == "pi"


_LIST_FORMAT = (
    "#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}"
    "\t#{pane_pid}\t#{pane_current_path}\t#{pane_title}\t#{pane_current_command}"
)


def list_panes() -> list[Pane]:
    """Every pane on the tmux server. Empty list if tmux isn't running."""
    try:
        out = _tmux("list-panes", "-a", "-F", _LIST_FORMAT, capture=True)
    except TmuxError:
        return []
    panes: list[Pane] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 8:
            continue
        pane_id, session, win, pidx, pid, cwd, title, cmd = parts
        try:
            panes.append(
                Pane(
                    pane_id=pane_id,
                    target=f"{session}:{win}.{pidx}",
                    session=session,
                    window_index=int(win),
                    pane_index=int(pidx),
                    pid=int(pid),
                    cwd=cwd,
                    title=title,
                    command=cmd,
                )
            )
        except ValueError:
            continue
    return panes


def list_pi_panes() -> list[Pane]:
    """Convenience filter."""
    return [p for p in list_panes() if p.is_pi]


# ---------------------------------------------------------------------------
# Monitor session bootstrap + crash recovery
# ---------------------------------------------------------------------------


def server_running() -> bool:
    if shutil.which("tmux") is None:
        return False
    return subprocess.run(["tmux", "has-session"], capture_output=True).returncode == 0


def session_exists(name: str) -> bool:
    return (
        subprocess.run(
            ["tmux", "has-session", "-t", f"={name}"], capture_output=True
        ).returncode
        == 0
    )


def ensure_monitor_session(left_command: str | None = None) -> None:
    """Create the monitor session if it doesn't exist. The left pane runs
    `left_command` (typically `pi-monitor --tui`). The right pane is created
    empty (running the user's shell) and waits to be replaced via join-pane.

    If the monitor session already exists this is a no-op so a re-launch
    just re-attaches without disturbing in-flight borrowed panes.
    """
    if session_exists(MONITOR_SESSION):
        return
    cmd = left_command or "true"  # `true` exits immediately; only used in tests
    _tmux("new-session", "-d", "-s", MONITOR_SESSION, "-x", "200", "-y", "50", cmd)
    # Split horizontally so we get pane 0 (left) and pane 1 (right).
    _tmux("split-window", "-h", "-t", LEFT_PANE)
    # Give the left pane ~30% of the width.
    _tmux("resize-pane", "-t", LEFT_PANE, "-x", "55")


def kill_monitor_session() -> None:
    if session_exists(MONITOR_SESSION):
        _tmux("kill-session", "-t", MONITOR_SESSION)


def _ensure_rescue_session() -> None:
    """Create a hidden rescue session orphans can be moved into. Idempotent."""
    if not session_exists(RESCUE_SESSION):
        _tmux("new-session", "-d", "-s", RESCUE_SESSION)


def recover_orphan_panes() -> list[str]:
    """Move any pi pane parked in the monitor session out into a dedicated
    rescue session (`pi-monitor-rescued`). This MUST move panes out of the
    monitor session entirely — not into a new window inside monitor — because
    the monitor session can be `kill-session`d at quit time and would take
    every pane in it down.

    Returns the list of pane targets we recovered (now living in the rescue
    session). Caller should surface this to the user.
    """
    if not session_exists(MONITOR_SESSION):
        return []
    orphans = [
        p
        for p in list_panes()
        if p.session == MONITOR_SESSION and p.pane_index != 0 and p.is_pi
    ]
    if not orphans:
        return []
    _ensure_rescue_session()
    recovered: list[str] = []
    for p in orphans:
        try:
            _tmux(
                "break-pane",
                "-d",
                "-s", p.pane_id,
                "-t", f"{RESCUE_SESSION}:",
                "-n", p.title or "rescued",
            )
            recovered.append(p.target)
        except TmuxError:
            # Leave it where it is; better an orphan than a kill.
            pass
    return recovered


def monitor_has_pi_panes() -> bool:
    """True iff any pane in the monitor session (other than the TUI at index 0)
    is currently running pi. Used as a kill-session safety gate."""
    if not session_exists(MONITOR_SESSION):
        return False
    return any(
        p.session == MONITOR_SESSION and p.pane_index != 0 and p.is_pi
        for p in list_panes()
    )


# ---------------------------------------------------------------------------
# Pane borrow / return
# ---------------------------------------------------------------------------


def borrow_pane(source_pane_id: str) -> None:
    """Move the source pane into the monitor's right slot.

    Safety: refuse to kill the existing right-slot pane if it currently
    holds a pi pane (which would mean a previous return_pane silently
    failed). Better to error loudly than silently destroy a borrowed agent.
    """
    right_slot = next(
        (p for p in list_panes() if p.target == RIGHT_SLOT), None
    )
    if right_slot is not None and right_slot.is_pi:
        raise TmuxError(
            "refusing to borrow: right slot still contains a pi pane "
            f"({right_slot.title!r}). Quit pi-monitor with `q` (which will "
            "refuse to kill the monitor session while pi panes are parked) "
            "and rescue the pane manually."
        )
    _tmux("kill-pane", "-t", RIGHT_SLOT)
    _tmux("join-pane", "-h", "-s", source_pane_id, "-t", LEFT_PANE)


def return_pane(borrowed_pane_id: str, origin_session: str) -> None:
    """Send a borrowed pane back to its origin SESSION as a new window.

    Critical: `break-pane -d -s <pane_id>` (without `-t`) creates a new
    window in the SOURCE pane's CURRENT session — which after a join-pane is
    the monitor session. Returning a pane that way leaves it parked in
    monitor, where the next kill-session destroys it. We MUST pass
    `-t <origin_session>:` so the new window is created in the original
    session.

    Raises TmuxError if break-pane fails for any reason. The caller must
    handle that and NOT kill the monitor session, or pi processes die.
    """
    _tmux(
        "break-pane",
        "-d",
        "-s", borrowed_pane_id,
        "-t", f"{origin_session}:",
    )
    # After breaking out the borrowed pane, the right slot is now empty.
    # Recreate a placeholder shell so the layout doesn't collapse to a
    # single pane.
    _tmux("split-window", "-h", "-t", LEFT_PANE)
    _tmux("resize-pane", "-t", LEFT_PANE, "-x", "55")


def focus_right_slot() -> None:
    _tmux("select-pane", "-t", RIGHT_SLOT)


def focus_left_slot() -> None:
    _tmux("select-pane", "-t", LEFT_PANE)


def switch_client_to_monitor() -> None:
    """Attach the current client to the monitor session."""
    _tmux("switch-client", "-t", MONITOR_SESSION)


# ---------------------------------------------------------------------------
# Status-line widget
# ---------------------------------------------------------------------------


def set_status_widget(text: str) -> None:
    """Push a string into a tmux user option that the user's `status-right`
    references via `#{@pi-monitor-status}`."""
    try:
        _tmux("set-option", "-gq", "@pi-monitor-status", text)
    except TmuxError:
        pass


def clear_status_widget() -> None:
    set_status_widget("")


# ---------------------------------------------------------------------------
# Internal: subprocess wrapper
# ---------------------------------------------------------------------------


class TmuxError(RuntimeError):
    pass


def _tmux(*args: str, capture: bool = False) -> str:
    """Run a tmux command, raising `TmuxError` on non-zero exit."""
    cmd = ["tmux", *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise TmuxError(
            f"tmux {shlex.join(args)} failed (exit {result.returncode}): "
            f"{result.stderr.strip()}"
        )
    return result.stdout if capture else ""
