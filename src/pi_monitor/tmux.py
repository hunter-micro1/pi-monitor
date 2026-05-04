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
            panes.append(Pane(
                pane_id=pane_id,
                target=f"{session}:{win}.{pidx}",
                session=session,
                window_index=int(win),
                pane_index=int(pidx),
                pid=int(pid),
                cwd=cwd,
                title=title,
                command=cmd,
            ))
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
    return subprocess.run(
        ["tmux", "has-session", "-t", f"={name}"], capture_output=True
    ).returncode == 0


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


def recover_orphan_panes() -> list[str]:
    """If a previous monitor crashed mid-borrow, a real pi pane may be
    parked in the monitor session's right slot. Break it out so it returns
    to its origin window. We compare each pane's `pane_start_command` /
    process command — if the right slot's pane is *not* the user's shell
    we assume it's an orphan and break it out.

    Returns the list of pane targets we recovered.
    """
    if not session_exists(MONITOR_SESSION):
        return []
    recovered: list[str] = []
    panes = [p for p in list_panes() if p.session == MONITOR_SESSION]
    # The TUI pane (left) is the one running `pi-monitor`. Anything else
    # in the monitor session that's a pi process is an orphan we need to
    # eject before the new TUI starts.
    for p in panes:
        if p.pane_index == 0:
            continue
        if p.is_pi:
            try:
                _tmux("break-pane", "-d", "-s", p.pane_id)
                recovered.append(p.target)
            except TmuxError:
                pass
    return recovered


# ---------------------------------------------------------------------------
# Pane borrow / return
# ---------------------------------------------------------------------------


def borrow_pane(source_pane_id: str) -> None:
    """Move the source pane into the monitor's right slot.

    We first kill whatever is in the right slot (typically the placeholder
    shell), then `join-pane -h` the source pane. We address slots by index
    because their tmux ids change as panes are joined/broken.
    """
    # Kill the current right-slot pane (placeholder or previously borrowed
    # pane that hasn't been returned yet).
    _tmux("kill-pane", "-t", RIGHT_SLOT)
    # join-pane moves the source to the right of the surviving (left) pane.
    _tmux("join-pane", "-h", "-s", source_pane_id, "-t", LEFT_PANE)


def return_pane(borrowed_pane_id: str) -> None:
    """Send a borrowed pane back to a fresh window (origin window if tmux
    can find it; otherwise a new window in the borrowed session). We use
    `break-pane -d` so focus stays on the monitor."""
    try:
        _tmux("break-pane", "-d", "-s", borrowed_pane_id)
    except TmuxError:
        # Pane already gone (user closed it from inside) — nothing to do.
        pass
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
