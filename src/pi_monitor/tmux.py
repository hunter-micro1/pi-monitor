"""Thin wrappers over `tmux` for the bits we actually need.

Everything is shell-out via subprocess. tmux is fast enough that a poll loop
calling `list-panes` every 500ms doesn't show up in CPU graphs.

The monitor session is a single-pane session that runs the Textual TUI.
The TUI renders a tree of agents on the left and a live capture-pane mirror
of the cursored agent on the right. Pressing Tab in the TUI switches the
tmux client to the cursored pane (full-screen interact). To return to the
monitor, the user re-invokes `pi-monitor` (or their bound hotkey) which
detects the existing monitor session and `switch-client`s back to it.
"""

from __future__ import annotations

import shlex
import shutil
import subprocess
from dataclasses import dataclass

MONITOR_SESSION = "monitor"
TUI_PANE = f"{MONITOR_SESSION}:0.0"


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
# Monitor session bootstrap
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
    """Create the monitor session if it doesn't exist (single-pane).

    The TUI fills the whole pane; preview is rendered in-Textual via
    `capture_pane` rather than by hosting a real second tmux pane. If a
    monitor session exists from an older version of pi-monitor that had a
    multi-pane layout, this scrubs the extras so we end up with a clean
    single-pane window 0.
    """
    if session_exists(MONITOR_SESSION):
        # Clean up any extra panes from previous (pre-preview) versions.
        for p in list_panes():
            if p.session != MONITOR_SESSION:
                continue
            if p.window_index == 0 and p.pane_index == 0:
                continue
            try:
                _tmux("kill-pane", "-t", p.pane_id)
            except TmuxError:
                pass
        return
    cmd = left_command or "true"
    _tmux("new-session", "-d", "-s", MONITOR_SESSION, "-x", "200", "-y", "50", cmd)


def kill_monitor_session() -> None:
    if session_exists(MONITOR_SESSION):
        _tmux("kill-session", "-t", MONITOR_SESSION)


def switch_client_to_monitor() -> None:
    """Attach the current client to the monitor session."""
    _tmux("switch-client", "-t", MONITOR_SESSION)


# ---------------------------------------------------------------------------
# Preview + interactive jump
# ---------------------------------------------------------------------------


def capture_pane(target: str, escape_codes: bool = True) -> str:
    """Capture the visible content of a pane via `tmux capture-pane`.

    With escape_codes=True (default), ANSI escape sequences are included so
    we can render the source pane's colors in the preview widget via Rich's
    `Text.from_ansi(...)`.
    """
    args = ["capture-pane", "-t", target, "-p"]
    if escape_codes:
        args.append("-e")
    return _tmux(*args, capture=True)


def switch_client_to_pane(pane: Pane) -> None:
    """Switch the user's tmux client to the given pane (full-screen interact).

    The monitor session stays alive in the background; the user comes back
    by re-running `pi-monitor` (or whatever they bound to that command).
    """
    _tmux("switch-client", "-t", pane.session)
    _tmux("select-window", "-t", f"{pane.session}:{pane.window_index}")
    _tmux("select-pane", "-t", pane.target)


# ---------------------------------------------------------------------------
# Spawning new pi agents
# ---------------------------------------------------------------------------


def _suggest_session_name(cwd: str) -> str:
    """Basename of the cwd, with `-2`, `-3` ... appended if a session of
    that name already exists. `pi` is the fallback for empty/root paths."""
    import os

    base = os.path.basename(cwd.rstrip("/")) or "pi"
    candidate = base
    n = 2
    while session_exists(candidate):
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def create_pi_session(cwd: str, name: str | None = None) -> str:
    """Create a new detached tmux session running `pi` in `cwd`. Returns the
    final session name (which may differ from the requested one if a
    collision suffix was appended)."""
    import os

    cwd = os.path.expanduser(cwd)
    if not os.path.isdir(cwd):
        raise TmuxError(f"directory not found: {cwd}")
    final_name = name or _suggest_session_name(cwd)
    if name is not None and session_exists(name):
        raise TmuxError(f"session {name!r} already exists")
    _tmux("new-session", "-d", "-s", final_name, "-c", cwd, "pi")
    return final_name


def split_pi_pane(target_window: str, cwd: str) -> None:
    """Split the target window with a new pane running `pi` in `cwd`.

    `target_window` is in `<session>:<window_index>` form (e.g. `contracts:0`).
    The split is horizontal so the new pane appears beside its sibling.
    """
    import os

    cwd = os.path.expanduser(cwd)
    if not os.path.isdir(cwd):
        raise TmuxError(f"directory not found: {cwd}")
    _tmux("split-window", "-h", "-t", target_window, "-c", cwd, "pi")


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
