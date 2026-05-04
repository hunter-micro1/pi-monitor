"""State inference tests with synthetic JSONL fixtures."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from pi_monitor.state import (
    AgentState,
    JsonlReader,
    JsonlSnapshot,
    _scan_lines,
    infer_state,
)


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _msg(role: str, **fields) -> dict:
    return {
        "type": "message",
        "id": "x",
        "parentId": None,
        "timestamp": "t",
        "message": {"role": role, **fields},
    }


def _write_jsonl(path: Path, entries: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")


# ---------------------------------------------------------------------------
# _scan_lines: roles → snapshot fields
# ---------------------------------------------------------------------------


def test_scan_lines_assistant_stop():
    blob = (
        json.dumps(
            _msg(
                "assistant", content=[{"type": "text", "text": "hi"}], stopReason="stop"
            )
        )
        + "\n"
    ).encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "assistant"
    assert snap.last_stop_reason == "stop"
    assert snap.pending_tool_calls == 0


def test_scan_lines_assistant_tooluse_pending():
    blob = (
        json.dumps(
            _msg(
                "assistant",
                content=[
                    {"type": "toolCall", "id": "t1", "name": "bash", "arguments": {}}
                ],
                stopReason="toolUse",
            )
        )
        + "\n"
    ).encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "assistant"
    assert snap.last_stop_reason == "toolUse"
    assert snap.pending_tool_calls == 1


def test_scan_lines_tooluse_then_result_clears_pending():
    entries = [
        _msg(
            "assistant",
            content=[
                {"type": "toolCall", "id": "t1", "name": "bash", "arguments": {}},
                {"type": "toolCall", "id": "t2", "name": "bash", "arguments": {}},
            ],
            stopReason="toolUse",
        ),
        _msg(
            "toolResult",
            toolCallId="t1",
            toolName="bash",
            content=[{"type": "text", "text": "ok"}],
            isError=False,
        ),
    ]
    blob = ("\n".join(json.dumps(e) for e in entries) + "\n").encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "toolResult"
    assert snap.pending_tool_calls == 1  # t2 still open


def test_scan_lines_user_clears_open_calls():
    entries = [
        _msg(
            "assistant",
            content=[{"type": "toolCall", "id": "t1", "name": "bash", "arguments": {}}],
            stopReason="toolUse",
        ),
        _msg("user", content="next prompt"),
    ]
    blob = ("\n".join(json.dumps(e) for e in entries) + "\n").encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "user"
    assert snap.pending_tool_calls == 0


def test_scan_lines_assistant_error():
    blob = (
        json.dumps(
            _msg("assistant", content=[], stopReason="error", errorMessage="boom")
        )
        + "\n"
    ).encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_error == "boom"


def test_scan_lines_skips_session_header():
    entries = [
        {"type": "session", "version": 3, "id": "abc", "timestamp": "t", "cwd": "/x"},
        _msg("assistant", content=[{"type": "text", "text": "hi"}], stopReason="stop"),
    ]
    blob = ("\n".join(json.dumps(e) for e in entries) + "\n").encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "assistant"


def test_scan_lines_empty_file():
    snap = _scan_lines(b"", mtime=100.0)
    assert snap.last_role is None
    assert snap.pending_tool_calls == 0


# ---------------------------------------------------------------------------
# infer_state: snapshot → state + thresholds
# ---------------------------------------------------------------------------


def test_infer_idle_after_threshold():
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant", last_stop_reason="stop")
    state, idle = infer_state(snap, now=2.0)
    assert state == AgentState.IDLE
    assert idle == 2.0


def test_infer_idle_below_threshold_is_working():
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant", last_stop_reason="stop")
    state, _ = infer_state(snap, now=0.5)
    assert state == AgentState.WORKING


def test_infer_stalled_after_threshold():
    snap = JsonlSnapshot(
        mtime=0.0,
        last_role="assistant",
        last_stop_reason="toolUse",
        pending_tool_calls=1,
    )
    state, idle = infer_state(snap, now=10.0)
    assert state == AgentState.STALLED
    assert idle == 10.0


def test_infer_stalled_below_threshold_is_working():
    snap = JsonlSnapshot(
        mtime=0.0,
        last_role="assistant",
        last_stop_reason="toolUse",
        pending_tool_calls=1,
    )
    state, _ = infer_state(snap, now=2.0)
    assert state == AgentState.WORKING


def test_infer_tooluse_with_no_pending_is_working():
    snap = JsonlSnapshot(
        mtime=0.0,
        last_role="assistant",
        last_stop_reason="toolUse",
        pending_tool_calls=0,
    )
    state, _ = infer_state(snap, now=100.0)
    assert state == AgentState.WORKING


def test_infer_error_via_stop_reason():
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant", last_stop_reason="error")
    state, _ = infer_state(snap, now=100.0)
    assert state == AgentState.ERROR


def test_infer_error_via_message():
    snap = JsonlSnapshot(
        mtime=0.0, last_role="assistant", last_stop_reason="stop", last_error="boom"
    )
    state, _ = infer_state(snap, now=100.0)
    assert state == AgentState.ERROR


def test_infer_toolresult_is_working():
    snap = JsonlSnapshot(mtime=0.0, last_role="toolResult")
    state, _ = infer_state(snap, now=100.0)
    assert state == AgentState.WORKING


def test_infer_user_is_working():
    snap = JsonlSnapshot(mtime=0.0, last_role="user")
    state, _ = infer_state(snap, now=100.0)
    assert state == AgentState.WORKING


def test_infer_none_snapshot_is_unknown():
    state, idle = infer_state(None, now=100.0)
    assert state == AgentState.UNKNOWN
    assert idle == 0.0


def test_infer_aborted_is_idle():
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant", last_stop_reason="aborted")
    state, _ = infer_state(snap, now=100.0)
    assert state == AgentState.IDLE


# ---------------------------------------------------------------------------
# JsonlReader: tail-based reads + incremental cache
# ---------------------------------------------------------------------------


def test_reader_reads_small_file(tmp_path: Path):
    f = tmp_path / "s.jsonl"
    _write_jsonl(
        f,
        [
            _msg(
                "assistant", content=[{"type": "text", "text": "hi"}], stopReason="stop"
            )
        ],
    )
    snap = JsonlReader().read(f)
    assert snap.last_role == "assistant"
    assert snap.last_stop_reason == "stop"


def test_reader_returns_none_on_missing_file(tmp_path: Path):
    snap = JsonlReader().read(tmp_path / "nope.jsonl")
    assert snap is None


def test_reader_skips_partial_first_line_when_tailing(tmp_path: Path):
    """When the file is bigger than TAIL_BYTES, the first line in the tail
    is likely partial; we drop it. We can simulate this by setting a tiny
    TAIL_BYTES and writing several entries."""
    f = tmp_path / "big.jsonl"
    entries = [_msg("user", content=f"prompt-{i}") for i in range(50)]
    entries.append(
        _msg("assistant", content=[{"type": "text", "text": "hi"}], stopReason="stop")
    )
    _write_jsonl(f, entries)

    reader = JsonlReader()
    reader.TAIL_BYTES = 200  # force tail mode for this test
    snap = reader.read(f)
    # We should still recover the *last* entry even though the first bytes
    # we read are mid-line garbage.
    assert snap.last_role == "assistant"


def test_reader_incremental_cache_skips_unchanged(tmp_path: Path):
    f = tmp_path / "s.jsonl"
    _write_jsonl(
        f,
        [
            _msg(
                "assistant", content=[{"type": "text", "text": "hi"}], stopReason="stop"
            )
        ],
    )
    reader = JsonlReader()
    snap1 = reader.read(f)
    # Force a known mtime so we can verify the cached snapshot's mtime is
    # refreshed even when size is unchanged.
    new_mtime = snap1.mtime + 5
    os.utime(f, (new_mtime, new_mtime))
    snap2 = reader.read(f)
    assert snap2 is snap1  # same object, just mtime-updated
    assert snap2.mtime == pytest.approx(new_mtime)


def test_reader_picks_up_appended_lines(tmp_path: Path):
    f = tmp_path / "s.jsonl"
    _write_jsonl(f, [_msg("user", content="hi")])
    reader = JsonlReader()
    snap1 = reader.read(f)
    assert snap1.last_role == "user"

    with f.open("a") as fp:
        fp.write(
            json.dumps(
                _msg(
                    "assistant",
                    content=[{"type": "text", "text": "hi"}],
                    stopReason="stop",
                )
            )
            + "\n"
        )
    snap2 = reader.read(f)
    assert snap2.last_role == "assistant"
    assert snap2.last_stop_reason == "stop"


# ---------------------------------------------------------------------------
# Sessions root constant points to the canonical pi location
# ---------------------------------------------------------------------------


def test_sessions_root_points_at_pi_dir():
    from pi_monitor.state import SESSIONS_ROOT

    assert str(SESSIONS_ROOT).endswith(".pi/agent/sessions")


# ---------------------------------------------------------------------------
# Cwd → session dir encoding
# ---------------------------------------------------------------------------


def test_cwd_to_session_dir_encodes_slashes():
    from pi_monitor.state import cwd_to_session_dir

    out = cwd_to_session_dir("/home/me/proj")
    assert out.name == "--home-me-proj--"


def test_cwd_to_session_dir_under_sessions_root():
    from pi_monitor.state import SESSIONS_ROOT, cwd_to_session_dir

    out = cwd_to_session_dir("/x")
    assert out.parent == SESSIONS_ROOT


# ---------------------------------------------------------------------------
# Per-pid claim resolution: two pi panes sharing a cwd must not collide
# ---------------------------------------------------------------------------


def _stamp(path: Path, mtime: float) -> None:
    os.utime(path, (mtime, mtime))


def test_claim_session_file_picks_most_recent_unclaimed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """With pi_pid=None we bypass the start-time filter and just pick the
    most recently modified unclaimed file in the cwd's session dir."""
    monkeypatch.setattr("pi_monitor.state.SESSIONS_ROOT", tmp_path)
    sess = tmp_path / "--proj--"
    sess.mkdir()
    older = sess / "2026-01-01T00-00-00-000Z_a.jsonl"
    newer = sess / "2026-01-02T00-00-00-000Z_b.jsonl"
    older.write_text("")
    newer.write_text("")
    _stamp(older, 100.0)
    _stamp(newer, 200.0)

    from pi_monitor.state import _claim_session_file

    claimed: set[Path] = set()
    first = _claim_session_file("/proj", pi_pid=None, claimed=claimed)
    assert first == newer
    claimed.add(first)
    second = _claim_session_file("/proj", pi_pid=None, claimed=claimed)
    assert second == older
    claimed.add(second)
    third = _claim_session_file("/proj", pi_pid=None, claimed=claimed)
    assert third is None


def test_resolve_disambiguates_two_panes_in_same_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Two pi panes in the same cwd must bind to different JSONLs even
    when /proc info is unavailable (pi_pid lookups return None)."""
    monkeypatch.setattr("pi_monitor.state.SESSIONS_ROOT", tmp_path)
    sess = tmp_path / "--proj--"
    sess.mkdir()
    file_a = sess / "a.jsonl"
    file_b = sess / "b.jsonl"
    _write_jsonl(
        file_a,
        [
            _msg(
                "assistant",
                content=[{"type": "text", "text": "a"}],
                stopReason="stop",
            )
        ],
    )
    _write_jsonl(
        file_b,
        [_msg("user", content="prompt-b")],
    )
    _stamp(file_a, 100.0)
    _stamp(file_b, 200.0)

    # No real /proc data – force pid lookups to return None so the resolver
    # falls back to mtime-DESC greedy assignment, which still must produce
    # distinct claims.
    monkeypatch.setattr("pi_monitor.state.find_pi_pid_for_pane", lambda pid: None)

    from pi_monitor.state import PaneRef, StateResolver

    resolver = StateResolver()
    refs = [
        PaneRef(pane_id="sess:0.0", cwd="/proj", is_pi=True, pane_pid=1),
        PaneRef(pane_id="sess:0.1", cwd="/proj", is_pi=True, pane_pid=2),
    ]
    out = resolver.resolve(refs, now=300.0)
    files = {out[r.pane_id].session_file for r in refs}
    assert files == {file_a, file_b}


def test_resolve_prefers_files_within_pi_lifetime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """When pi started AFTER an old JSONL stopped being written to, the
    resolver should bind to the file whose mtime is in pi's lifetime, not
    the global most-recent."""
    monkeypatch.setattr("pi_monitor.state.SESSIONS_ROOT", tmp_path)
    sess = tmp_path / "--proj--"
    sess.mkdir()
    pre = sess / "pre.jsonl"
    live = sess / "live.jsonl"
    _write_jsonl(
        pre,
        [
            _msg(
                "assistant",
                content=[{"type": "text", "text": "old"}],
                stopReason="stop",
            )
        ],
    )
    _write_jsonl(
        live,
        [_msg("user", content="recent")],
    )
    # `pre` mtime is older than pi's start time; `live` is within pi's life.
    _stamp(pre, 100.0)
    _stamp(live, 250.0)

    monkeypatch.setattr(
        "pi_monitor.state.find_pi_pid_for_pane", lambda pid: 9999 if pid == 1 else None
    )
    monkeypatch.setattr(
        "pi_monitor.state._proc_starttime",
        lambda pid: 200.0 if pid == 9999 else None,
    )

    from pi_monitor.state import PaneRef, StateResolver

    resolver = StateResolver()
    refs = [PaneRef(pane_id="sess:0.0", cwd="/proj", is_pi=True, pane_pid=1)]
    out = resolver.resolve(refs, now=300.0)
    assert out["sess:0.0"].session_file == live


def test_resolve_marks_non_pi_pane_no_pi(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr("pi_monitor.state.SESSIONS_ROOT", tmp_path)
    from pi_monitor.state import AgentState, PaneRef, StateResolver

    resolver = StateResolver()
    refs = [PaneRef(pane_id="x:0.0", cwd="/whatever", is_pi=False, pane_pid=1)]
    out = resolver.resolve(refs)
    assert out["x:0.0"].state == AgentState.NO_PI


def test_resolve_unknown_when_no_session_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr("pi_monitor.state.SESSIONS_ROOT", tmp_path)
    monkeypatch.setattr("pi_monitor.state.find_pi_pid_for_pane", lambda pid: None)
    from pi_monitor.state import AgentState, PaneRef, StateResolver

    resolver = StateResolver()
    refs = [PaneRef(pane_id="y:0.0", cwd="/no-sessions", is_pi=True, pane_pid=42)]
    out = resolver.resolve(refs)
    assert out["y:0.0"].state == AgentState.UNKNOWN
