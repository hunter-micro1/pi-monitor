"""Thin wrappers over `tmux` for the bits we actually need.

Everything is shell-out via subprocess. tmux is fast enough that a poll loop
calling `list-panes` every 500ms doesn't show up in CPU graphs.

The monitor session is a TWO-pane session:

  pane 0 (left):  the Textual TUI (tree + chrome). Fixed-ish width.
  pane 1 (right): an interactive "right slot". When the user picks an
                  agent in the tree, the right slot is respawned with
                  `tmux attach -t <viewer>` where <viewer> is a session
                  group sister of the agent's source session
                  (`tmux new-session -t <source>`). The right pane then
                  hosts a real, fully interactive tmux client showing the
                  source's window — the source pane stays put in its
                  origin session, and zero panes are ever moved.

Linked-viewer prefix is set to `C-a` so the user can drive the inner
tmux without colliding with the outer monitor session's `C-b` prefix.
"""

from __future__ import annotations

import shlex
import shutil
import subprocess
from dataclasses import dataclass

MONITOR_SESSION = "monitor"
TUI_PANE = f"{MONITOR_SESSION}:0.0"
RIGHT_SLOT = f"{MONITOR_SESSION}:0.1"

# Prefix on linked-viewer sessions. Server-attached sessions can have their
# own prefix; the outer monitor session keeps the tmux default (`C-b`) so
# keys don't collide between the two clients.
VIEWER_SESSION_PREFIX = "pi-monitor-view-"
VIEWER_INNER_PREFIX = "C-a"


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


def is_viewer_session(name: str) -> bool:
    """True for sessions we created as linked viewers."""
    return name.startswith(VIEWER_SESSION_PREFIX)


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


def _placeholder_cmd() -> str:
    """Idle command for the right slot when no agent is borrowed.

    Prints a banner and blocks forever. We use `tail -f /dev/null` (POSIX)
    rather than `sleep infinity` (GNU-only). The shell stays alive so the
    pane doesn't immediately exit; we'll later `respawn-pane -k` it with
    a real `tmux attach` when the user picks an agent.
    """
    return (
        "sh -c 'printf \"\\n  press Enter on a pane in the tree to "
        'interact with it here\\n\\n"; tail -f /dev/null\''
    )


def ensure_monitor_session(left_command: str | None = None) -> None:
    """Create or normalize the monitor session into a 2-pane layout.

    - If the session doesn't exist: create it, run `left_command` in pane 0,
      split horizontally and run the placeholder in pane 1.
    - If the session exists with 1 pane (older versions): split a right pane
      in and start the placeholder.
    - If the session exists with >2 panes: kill any extras beyond pane 1.
    - If the session exists with 2 panes already: leave it alone (the right
      slot may have a stale `tmux attach` from a previous crash; the caller
      is expected to also `cleanup_orphan_viewers()` before respawn so any
      stale viewer is gone before the user picks a new agent).
    """
    cleanup_orphan_viewers()

    if not session_exists(MONITOR_SESSION):
        cmd = left_command or "true"
        _tmux(
            "new-session",
            "-d",
            "-s",
            MONITOR_SESSION,
            "-x",
            "200",
            "-y",
            "50",
            cmd,
        )
        _tmux(
            "split-window",
            "-h",
            "-t",
            TUI_PANE,
            "-l",
            "60%",
            "-d",
            _placeholder_cmd(),
        )
        _tmux("select-pane", "-t", TUI_PANE)
        return

    monitor_panes = sorted(
        (
            p
            for p in list_panes()
            if p.session == MONITOR_SESSION and p.window_index == 0
        ),
        key=lambda p: p.pane_index,
    )

    if not monitor_panes:
        # Existing-but-empty shouldn't really happen, but be defensive.
        _tmux("kill-session", "-t", MONITOR_SESSION)
        ensure_monitor_session(left_command)
        return

    if len(monitor_panes) == 1:
        # Pre-2-pane state: add the right slot.
        _tmux(
            "split-window",
            "-h",
            "-t",
            TUI_PANE,
            "-l",
            "60%",
            "-d",
            _placeholder_cmd(),
        )
        _tmux("select-pane", "-t", TUI_PANE)
        return

    # 2 or more — kill any extras (older multi-pane states), then reset
    # the right slot to a clean placeholder so we don't inherit a stale
    # `tmux attach` from a crashed run.
    for pane in monitor_panes[2:]:
        try:
            _tmux("kill-pane", "-t", pane.pane_id)
        except TmuxError:
            pass
    try:
        reset_right_slot_to_placeholder()
    except TmuxError:
        pass
    try:
        _tmux("select-pane", "-t", TUI_PANE)
    except TmuxError:
        pass


def kill_monitor_session() -> None:
    if session_exists(MONITOR_SESSION):
        _tmux("kill-session", "-t", MONITOR_SESSION)


def switch_client_to_monitor() -> None:
    """Attach the current client to the monitor session."""
    _tmux("switch-client", "-t", MONITOR_SESSION)


# ---------------------------------------------------------------------------
# Linked viewers (session-group sisters of source sessions)
# ---------------------------------------------------------------------------


def viewer_session_name(source: str) -> str:
    """Stable, identifiable name for a viewer linked to `source`."""
    safe = source.replace(":", "-").replace(".", "-").replace(" ", "-")
    return f"{VIEWER_SESSION_PREFIX}{safe}"


def ensure_linked_viewer(source: str) -> str:
    """Create a session-group sister of `source` (or return the existing
    one) and set its prefix to `VIEWER_INNER_PREFIX`. Returns the viewer
    session name. The viewer shares `source`'s windows; killing the viewer
    leaves `source` and its panes untouched.
    """
    name = viewer_session_name(source)
    if not session_exists(name):
        _tmux("new-session", "-d", "-s", name, "-t", source)
        try:
            _tmux("set-option", "-t", name, "prefix", VIEWER_INNER_PREFIX)
        except TmuxError:
            # Old tmux that won't take prefix per-session — not fatal.
            pass
    return name


def kill_linked_viewer(name: str) -> None:
    """Best-effort kill. The shared windows persist as long as the source
    session still references them, which is exactly what we want."""
    if session_exists(name):
        try:
            _tmux("kill-session", "-t", name)
        except TmuxError:
            pass


def cleanup_orphan_viewers() -> None:
    """Kill every leftover `pi-monitor-view-*` session. Called on bootstrap
    and quit so a previous crash can't leave stray clients alive."""
    try:
        out = _tmux("list-sessions", "-F", "#{session_name}", capture=True)
    except TmuxError:
        return
    for line in out.splitlines():
        name = line.strip()
        if is_viewer_session(name):
            try:
                _tmux("kill-session", "-t", name)
            except TmuxError:
                pass


def viewer_focus_pane(viewer: str, window_index: int, pane_index: int) -> None:
    """Set the viewer session's current window+pane so an attached client
    lands on the agent's pane. Best-effort; silently ignores the case where
    the source moved its windows out from under us."""
    target_window = f"{viewer}:{window_index}"
    target_pane = f"{target_window}.{pane_index}"
    try:
        _tmux("select-window", "-t", target_window)
    except TmuxError:
        return
    try:
        _tmux("select-pane", "-t", target_pane)
    except TmuxError:
        pass


def attach_right_slot_to_viewer(viewer: str) -> None:
    """Respawn the monitor's right pane with a tmux client attached to
    `viewer`. The `env -u TMUX` prefix unsets the inherited `$TMUX` so the
    inner client doesn't refuse to nest."""
    cmd = f"env -u TMUX tmux attach -t {shlex.quote(viewer)}"
    _tmux("respawn-pane", "-k", "-t", RIGHT_SLOT, cmd)


def reset_right_slot_to_placeholder() -> None:
    """Bring the right pane back to its idle 'press Enter to interact' state."""
    _tmux("respawn-pane", "-k", "-t", RIGHT_SLOT, _placeholder_cmd())


def focus_right_slot() -> None:
    _tmux("select-pane", "-t", RIGHT_SLOT)


def focus_left_slot() -> None:
    _tmux("select-pane", "-t", TUI_PANE)


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
