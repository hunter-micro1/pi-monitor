"""Cross-platform tests for the psutil-backed process resolver and the
notification transport.

These tests don't try to invoke real `notify-send`/`osascript` or read
real processes \u2014 they patch out the boundaries (`shutil.which`,
`subprocess.run`, `psutil.Process`) so the same suite runs on Linux, on
macOS, and in CI. The point is to pin down the dispatch behavior:
we hit the right transport, we swallow disappearances/errors, and we
never raise into the caller (notifications are advisory).
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import psutil
import pytest

from pi_monitor.notify import _send_notification
from pi_monitor.state import _proc_starttime, find_pi_pid_for_pane


# ---------------------------------------------------------------------------
# _send_notification: dispatch by available tool
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_which_lookups():
    """The notification path branches on `shutil.which` results; without
    explicit patching the test would pick up whatever tool happens to be
    installed on the host, so each test case patches `shutil.which`
    explicitly. This fixture is purely a marker that we're aware of the
    dependency \u2014 no setup/teardown work is needed."""
    yield


def test_send_notification_uses_notify_send_when_available():
    """notify-send is the Linux/libnotify path; when present we call it
    with the standard args even if osascript is also on PATH (the order
    matters for users who installed both)."""

    def which(name):
        return "/usr/bin/notify-send" if name == "notify-send" else "/usr/bin/osascript"

    with (
        patch("pi_monitor.notify.shutil.which", side_effect=which),
        patch("pi_monitor.notify.subprocess.run") as mrun,
    ):
        _send_notification("hello", "body text", urgency="critical")
        assert mrun.call_count == 1
        args, kwargs = mrun.call_args
        cmd = args[0]
        assert cmd[0] == "notify-send"
        assert "--app-name=pi-monitor" in cmd
        assert "--urgency" in cmd
        assert "critical" in cmd
        assert "hello" in cmd
        assert "body text" in cmd


def test_send_notification_falls_back_to_osascript_on_macos():
    """On macOS notify-send is absent and osascript ships by default; the
    notification routes through AppleScript's `display notification`."""

    def which(name):
        return "/usr/bin/osascript" if name == "osascript" else None

    with (
        patch("pi_monitor.notify.shutil.which", side_effect=which),
        patch("pi_monitor.notify.subprocess.run") as mrun,
    ):
        _send_notification("hello", "body text")
        assert mrun.call_count == 1
        cmd = mrun.call_args[0][0]
        assert cmd[0] == "osascript"
        assert cmd[1] == "-e"
        # The script wraps both title and body in JSON-quoted strings
        # which AppleScript accepts verbatim.
        assert "display notification" in cmd[2]
        assert '"body text"' in cmd[2]
        assert '"hello"' in cmd[2]


def test_send_notification_escapes_quotes_in_body():
    """An assistant error message can contain double quotes (\"ECONNRESET\"
    style traces); JSON-escaping the body prevents AppleScript from
    parsing them as string terminators and silently dropping the
    notification."""

    def which(name):
        return "/usr/bin/osascript" if name == "osascript" else None

    nasty = 'message with "quotes" and \\backslashes'
    with (
        patch("pi_monitor.notify.shutil.which", side_effect=which),
        patch("pi_monitor.notify.subprocess.run") as mrun,
    ):
        _send_notification("title", nasty)
        script = mrun.call_args[0][0][2]
        # The escaped form must be present (json.dumps wraps + escapes).
        assert '\\"quotes\\"' in script
        assert "\\\\backslashes" in script


def test_send_notification_noop_when_no_transport():
    """SSH session into a headless box \u2014 neither notify-send nor osascript
    available. Must not raise, must not attempt to spawn anything."""

    with (
        patch("pi_monitor.notify.shutil.which", return_value=None),
        patch("pi_monitor.notify.subprocess.run") as mrun,
    ):
        _send_notification("hello", "body")
        assert mrun.call_count == 0


def test_send_notification_swallows_subprocess_errors():
    """If notify-send is on PATH but the call itself fails (timeout,
    OSError on exec), we keep going \u2014 a busted notification daemon
    must never crash pi-monitor's render loop."""

    def which(name):
        return "/usr/bin/notify-send" if name == "notify-send" else None

    with (
        patch("pi_monitor.notify.shutil.which", side_effect=which),
        patch(
            "pi_monitor.notify.subprocess.run",
            side_effect=OSError("daemon down"),
        ),
    ):
        # The point is just that this returns normally instead of raising.
        _send_notification("hello", "body")


# ---------------------------------------------------------------------------
# _proc_starttime: psutil.Process.create_time() shim
# ---------------------------------------------------------------------------


def test_proc_starttime_returns_create_time():
    """psutil normalizes Linux's /proc/<pid>/stat starttime + boot time
    AND macOS's kinfo_proc start to the same Unix-time float, so this
    function should just be a thin wrapper."""

    fake_proc = MagicMock()
    fake_proc.create_time.return_value = 1234567890.5
    with patch("pi_monitor.state.psutil.Process", return_value=fake_proc):
        assert _proc_starttime(42) == 1234567890.5


def test_proc_starttime_none_when_pid_gone():
    """A pid that died between when we listed it and when we looked up its
    create time should resolve to None, not raise. NoSuchProcess is the
    canonical psutil signal for this."""

    with patch(
        "pi_monitor.state.psutil.Process",
        side_effect=psutil.NoSuchProcess(42),
    ):
        assert _proc_starttime(42) is None


def test_proc_starttime_none_when_access_denied():
    """On macOS we sometimes can't read another user's process metadata.
    Same handling \u2014 None, not a raised exception."""

    with patch(
        "pi_monitor.state.psutil.Process",
        side_effect=psutil.AccessDenied(42),
    ):
        assert _proc_starttime(42) is None


def test_proc_starttime_none_for_zombie():
    """A process in zombie state has no useful metadata; psutil raises
    ZombieProcess and we treat it as gone."""

    fake = MagicMock()
    fake.create_time.side_effect = psutil.ZombieProcess(42)
    with patch("pi_monitor.state.psutil.Process", return_value=fake):
        assert _proc_starttime(42) is None


# ---------------------------------------------------------------------------
# find_pi_pid_for_pane: psutil.Process.children walker
# ---------------------------------------------------------------------------


def _fake_proc(pid: int, name: str, children: list = None):
    """Build a MagicMock that quacks like the psutil.Process API the
    resolver actually uses: `pid`, `name()`, `children(recursive=True)`."""
    p = MagicMock()
    p.pid = pid
    p.name.return_value = name
    p.children.return_value = list(children or [])
    return p


def test_find_pi_pid_for_pane_pane_pid_is_pi_itself():
    """User did `exec pi`, replacing the shell. The pane pid IS the pi
    pid; we should return it without walking descendants."""

    pi = _fake_proc(100, "pi")
    with patch("pi_monitor.state.psutil.Process", return_value=pi):
        assert find_pi_pid_for_pane(100) == 100
    pi.children.assert_not_called()


def test_find_pi_pid_for_pane_finds_descendant():
    """Common case: pane pid is the user's shell, pi is one of its
    descendants (often a direct child, sometimes deeper if pi was
    launched under env / nice / etc)."""

    pi_child = _fake_proc(200, "pi")
    other = _fake_proc(201, "node")
    shell = _fake_proc(100, "zsh", children=[other, pi_child])

    with patch("pi_monitor.state.psutil.Process", return_value=shell):
        assert find_pi_pid_for_pane(100) == 200


def test_find_pi_pid_for_pane_none_when_no_pi_in_tree():
    """A shell pane with no pi inside it should return None so the
    resolver can mark the pane NO_PI without spending more cycles."""

    children = [_fake_proc(101, "vim"), _fake_proc(102, "node")]
    shell = _fake_proc(100, "zsh", children=children)
    with patch("pi_monitor.state.psutil.Process", return_value=shell):
        assert find_pi_pid_for_pane(100) is None


def test_find_pi_pid_for_pane_handles_pid_gone():
    """The pane pid disappeared between the tmux scan and our lookup."""

    with patch(
        "pi_monitor.state.psutil.Process",
        side_effect=psutil.NoSuchProcess(100),
    ):
        assert find_pi_pid_for_pane(100) is None


def test_find_pi_pid_for_pane_skips_descendants_that_die_mid_walk():
    """Descendants can disappear in the middle of our walk (psutil sees
    them, we ask their .name(), they're already gone). We should skip
    those silently and keep looking, not propagate the exception."""

    dead = MagicMock()
    dead.pid = 201
    dead.name.side_effect = psutil.NoSuchProcess(201)
    pi = _fake_proc(202, "pi")
    shell = _fake_proc(100, "zsh", children=[dead, pi])
    with patch("pi_monitor.state.psutil.Process", return_value=shell):
        assert find_pi_pid_for_pane(100) == 202
