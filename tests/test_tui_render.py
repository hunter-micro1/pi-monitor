"""Pure-function tests for the TUI render helpers.

The interactive parts of the TUI (cursor model, mount/unmount, CSS classes)
are exercised by hand-running pi-monitor against a real tmux server, but
the format helpers and branch resolver are pure and worth pinning down
with unit tests so refactors of the render path can't silently regress
the activity-tag wording or the branch-cache invariant.
"""

from __future__ import annotations

import subprocess
from unittest.mock import patch

from pi_monitor.state import AgentState, JsonlSnapshot, PaneStatus
from pi_monitor.tui import (
    _activity_description,
    _activity_tag,
    _branch_cache,
    _truncate,
    _working_verb,
    branch_for_cwd,
    fmt_idle,
    fmt_row_main,
    fmt_session_header,
)


# ---------------------------------------------------------------------------
# Test fixture: a small constructor for PaneStatus in the various shapes
# the render path actually sees in production. Keeps the per-test setup
# noise low and centralizes the snapshot/heartbeat fields the helpers
# read so additions to PaneStatus don't ripple across every test body.
# ---------------------------------------------------------------------------


def _status(
    state: AgentState,
    *,
    idle: float = 0.0,
    phase: str | None = None,
    tool: str | None = None,
    retry: int = 0,
    preview: str | None = None,
    error: str | None = None,
) -> PaneStatus:
    snap: JsonlSnapshot | None = None
    if preview is not None or error is not None:
        snap = JsonlSnapshot(
            mtime=0.0,
            last_assistant_preview=preview,
            last_error=error,
        )
    return PaneStatus(
        pane_id="x",
        state=state,
        idle_seconds=idle,
        phase=phase,
        current_tool=tool,
        retry_attempt=retry,
        snapshot=snap,
    )


# ---------------------------------------------------------------------------
# fmt_idle
# ---------------------------------------------------------------------------


def test_fmt_idle_sub_second_returns_empty():
    assert fmt_idle(0.4) == ""


def test_fmt_idle_seconds():
    assert fmt_idle(12) == "12s"


def test_fmt_idle_minutes():
    assert fmt_idle(246) == "4m"


def test_fmt_idle_hours():
    assert fmt_idle(3700) == "1h"


# ---------------------------------------------------------------------------
# _truncate
# ---------------------------------------------------------------------------


def test_truncate_short_passes_through():
    assert _truncate("abc", 10) == "abc"


def test_truncate_long_inserts_ellipsis():
    assert _truncate("abcdefghij", 5) == "abcd…"


def test_truncate_zero_width_collapses():
    assert _truncate("abc", 0) == ""


# ---------------------------------------------------------------------------
# _working_verb: heartbeat phase + tool → activity word
# ---------------------------------------------------------------------------


def test_working_verb_with_tool():
    s = _status(AgentState.WORKING, phase="tool_running", tool="bash")
    assert _working_verb(s) == "running bash"


def test_working_verb_truncates_long_tool_name():
    s = _status(AgentState.WORKING, phase="tool_running", tool="replace_in_file")
    out = _working_verb(s)
    assert out.startswith("running ")
    # The tool name is capped at _TAG_TOOL_MAX (10) chars by _truncate, so
    # something like 'running replace_i…' shows up. Exact char depends on
    # the cap, so we check the truncation marker rather than the suffix.
    assert "…" in out


def test_working_verb_tool_running_no_tool_name():
    s = _status(AgentState.WORKING, phase="tool_running", tool=None)
    assert _working_verb(s) == "running tool"


def test_working_verb_compacting():
    s = _status(AgentState.WORKING, phase="compacting")
    assert _working_verb(s) == "compacting"


def test_working_verb_agent_running():
    s = _status(AgentState.WORKING, phase="agent_running")
    assert _working_verb(s) == "thinking"


def test_working_verb_no_phase_falls_back():
    s = _status(AgentState.WORKING)
    assert _working_verb(s) == "working"


# ---------------------------------------------------------------------------
# _activity_tag: state + phase → right-aligned colored verb markup
# ---------------------------------------------------------------------------


def test_activity_tag_working_uses_pulse_color():
    s = _status(AgentState.WORKING, phase="agent_running")
    out = _activity_tag(s, working_color="#abcdef")
    assert "thinking" in out
    # Pulse color overrides the static state color so the tag breathes
    # in lockstep with the title.
    assert "#abcdef" in out


def test_activity_tag_working_falls_back_to_state_color():
    s = _status(AgentState.WORKING, phase="agent_running")
    out = _activity_tag(s, working_color=None)
    assert "thinking" in out


def test_activity_tag_idle_with_time():
    s = _status(AgentState.IDLE, idle=246.0)
    assert "idle 4m" in _activity_tag(s)


def test_activity_tag_idle_no_time():
    s = _status(AgentState.IDLE, idle=0.0)
    out = _activity_tag(s)
    assert "idle" in out
    # No trailing time suffix when fmt_idle returns empty.
    assert "idle " not in out


def test_activity_tag_error_with_time():
    s = _status(AgentState.ERROR, idle=12.0)
    assert "errored 12s" in _activity_tag(s)


def test_activity_tag_retrying_with_attempt():
    s = _status(AgentState.RETRYING, retry=3)
    assert "retrying #3" in _activity_tag(s)


def test_activity_tag_retrying_no_attempt():
    s = _status(AgentState.RETRYING, retry=0)
    out = _activity_tag(s)
    assert "retrying" in out
    # No `#N` count suffix when retry_attempt is 0. We can't simply check
    # for `#` because the markup itself uses `#` for hex color codes
    # (e.g. `[#81a2be]...[/#81a2be]`); check for the suffix shape instead.
    assert "retrying #" not in out


def test_activity_tag_waiting():
    s = _status(AgentState.WAITING)
    assert "awaiting input" in _activity_tag(s)


def test_activity_tag_no_pi():
    s = _status(AgentState.NO_PI)
    assert "no pi" in _activity_tag(s)


def test_activity_tag_unknown():
    s = _status(AgentState.UNKNOWN)
    assert "unknown" in _activity_tag(s)


# ---------------------------------------------------------------------------
# _activity_description: priority order across phase / snapshot
# ---------------------------------------------------------------------------


def test_activity_description_phase_beats_snapshot_preview():
    """When the heartbeat is publishing a phase, we trust it over the
    JSONL preview — the phase is the live signal, the snapshot may
    describe a turn that already finished."""
    s = _status(
        AgentState.WORKING,
        phase="compacting",
        preview="The migration finished cleanly.",
    )
    assert _activity_description(s) == "compressing context history"


def test_activity_description_tool_running_with_tool():
    s = _status(AgentState.WORKING, phase="tool_running", tool="edit")
    assert _activity_description(s) == "executing edit"


def test_activity_description_agent_running():
    s = _status(AgentState.WORKING, phase="agent_running")
    assert _activity_description(s) == "drafting response"


def test_activity_description_retrying_includes_attempt():
    s = _status(AgentState.WORKING, phase="retrying", retry=2)
    assert "attempt 2" in _activity_description(s)


def test_activity_description_awaiting_permission():
    s = _status(AgentState.WAITING, phase="awaiting_permission")
    assert _activity_description(s) == "waiting for your decision"


def test_activity_description_idle_uses_snapshot_preview():
    s = _status(
        AgentState.IDLE,
        idle=246.0,
        preview="All four browser themes are aligned to the new palette.",
    )
    out = _activity_description(s)
    assert "browser themes" in out


def test_activity_description_error_uses_last_error():
    s = _status(
        AgentState.ERROR,
        idle=12.0,
        error="ECONNRESET reading model stream",
    )
    out = _activity_description(s)
    assert "ECONNRESET" in out


def test_activity_description_long_preview_truncates():
    long_text = "x" * 300
    s = _status(AgentState.IDLE, preview=long_text)
    out = _activity_description(s)
    # The hard cap is 80 chars; ellipsis indicates truncation.
    assert len(out) <= 81  # 80 chars + the ellipsis
    assert "…" in out


def test_activity_description_no_data_returns_empty():
    s = _status(AgentState.IDLE)
    assert _activity_description(s) == ""


def test_activity_description_no_pi_returns_empty():
    """NO_PI panes have neither heartbeat nor snapshot; nothing to say."""
    s = _status(AgentState.NO_PI)
    assert _activity_description(s) == ""


# ---------------------------------------------------------------------------
# fmt_session_header + fmt_row_main: shape of returned markup
# ---------------------------------------------------------------------------


def test_fmt_session_header_escapes_special_chars():
    out = fmt_session_header("session [name]")
    # Rich markup uses [ and ] as control characters; the header must
    # escape them so a session named 'foo [bar]' doesn't blow up rendering.
    assert "\\[" in out
    assert "bold" in out


def test_fmt_row_main_includes_branch_when_present():
    from pi_monitor.tmux import Pane

    pane = Pane(
        pane_id="%1",
        target="x:1.0",
        session="x",
        window_index=1,
        pane_index=0,
        pid=1,
        cwd="/tmp/x",
        title="agent",
        command="pi",
    )
    s = _status(AgentState.IDLE)
    out = fmt_row_main(pane, s, "feature/auth")
    assert "agent" in out
    assert "feature/auth" in out
    # The branch fragment is rendered dim and prefixed with `· `.
    assert "·" in out


def test_fmt_row_main_omits_branch_when_none():
    from pi_monitor.tmux import Pane

    pane = Pane(
        pane_id="%1",
        target="x:1.0",
        session="x",
        window_index=1,
        pane_index=0,
        pid=1,
        cwd="/tmp/x",
        title="agent",
        command="pi",
    )
    s = _status(AgentState.IDLE)
    out = fmt_row_main(pane, s, None)
    assert "agent" in out
    # No `·` separator and no branch-fragment markup.
    assert "·" not in out


# ---------------------------------------------------------------------------
# branch_for_cwd: subprocess + TTL cache
# ---------------------------------------------------------------------------


def _fake_completed(returncode: int, stdout: str):
    return type(
        "CompletedProcess",
        (),
        {"returncode": returncode, "stdout": stdout, "stderr": ""},
    )()


def test_branch_for_cwd_empty_string_returns_none():
    assert branch_for_cwd("") is None


def test_branch_for_cwd_returns_short_branch_name():
    _branch_cache.clear()
    with patch(
        "pi_monitor.tui.subprocess.run",
        return_value=_fake_completed(0, "main\n"),
    ):
        assert branch_for_cwd("/tmp/repo") == "main"


def test_branch_for_cwd_handles_feature_branch_name():
    _branch_cache.clear()
    with patch(
        "pi_monitor.tui.subprocess.run",
        return_value=_fake_completed(0, "feature/oauth-refresh\n"),
    ):
        assert branch_for_cwd("/tmp/repo") == "feature/oauth-refresh"


def test_branch_for_cwd_detached_head_returns_none():
    _branch_cache.clear()
    with patch(
        "pi_monitor.tui.subprocess.run",
        return_value=_fake_completed(1, ""),
    ):
        assert branch_for_cwd("/tmp/repo") is None


def test_branch_for_cwd_timeout_returns_none():
    _branch_cache.clear()
    with patch(
        "pi_monitor.tui.subprocess.run",
        side_effect=subprocess.TimeoutExpired("git", 0.4),
    ):
        assert branch_for_cwd("/tmp/repo") is None


def test_branch_for_cwd_oserror_returns_none():
    _branch_cache.clear()
    with patch(
        "pi_monitor.tui.subprocess.run",
        side_effect=OSError("git not found"),
    ):
        assert branch_for_cwd("/tmp/repo") is None


def test_branch_for_cwd_caches_result():
    """Within the TTL window, a repeated lookup must not re-spawn git.
    The whole point of the cache is to amortize the subprocess cost so
    the render path stays cheap on every tick."""
    _branch_cache.clear()
    with patch(
        "pi_monitor.tui.subprocess.run",
        return_value=_fake_completed(0, "main\n"),
    ) as mrun:
        assert branch_for_cwd("/tmp/repo") == "main"
        assert branch_for_cwd("/tmp/repo") == "main"
        assert branch_for_cwd("/tmp/repo") == "main"
        assert mrun.call_count == 1


def test_branch_for_cwd_caches_per_path():
    _branch_cache.clear()
    with patch(
        "pi_monitor.tui.subprocess.run",
        return_value=_fake_completed(0, "main\n"),
    ) as mrun:
        branch_for_cwd("/tmp/a")
        branch_for_cwd("/tmp/b")
        # Different cwds → two distinct git calls, no false sharing.
        assert mrun.call_count == 2


def test_branch_for_cwd_caches_negative_results_too():
    """A None result (detached, non-git, timeout) is also cached so we
    don't re-spawn git every tick on a non-checkout cwd."""
    _branch_cache.clear()
    with patch(
        "pi_monitor.tui.subprocess.run",
        return_value=_fake_completed(128, ""),
    ) as mrun:
        assert branch_for_cwd("/tmp/not-a-repo") is None
        assert branch_for_cwd("/tmp/not-a-repo") is None
        assert mrun.call_count == 1
