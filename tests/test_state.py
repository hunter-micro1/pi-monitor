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
    return {"type": "message", "id": "x", "parentId": None, "timestamp": "t",
            "message": {"role": role, **fields}}


def _write_jsonl(path: Path, entries: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")


# ---------------------------------------------------------------------------
# _scan_lines: roles → snapshot fields
# ---------------------------------------------------------------------------


def test_scan_lines_assistant_stop():
    blob = (json.dumps(_msg("assistant", content=[{"type": "text", "text": "hi"}],
                            stopReason="stop")) + "\n").encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "assistant"
    assert snap.last_stop_reason == "stop"
    assert snap.pending_tool_calls == 0


def test_scan_lines_assistant_tooluse_pending():
    blob = (json.dumps(_msg("assistant",
                            content=[{"type": "toolCall", "id": "t1", "name": "bash",
                                      "arguments": {}}],
                            stopReason="toolUse")) + "\n").encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "assistant"
    assert snap.last_stop_reason == "toolUse"
    assert snap.pending_tool_calls == 1


def test_scan_lines_tooluse_then_result_clears_pending():
    entries = [
        _msg("assistant",
             content=[{"type": "toolCall", "id": "t1", "name": "bash", "arguments": {}},
                      {"type": "toolCall", "id": "t2", "name": "bash", "arguments": {}}],
             stopReason="toolUse"),
        _msg("toolResult", toolCallId="t1", toolName="bash",
             content=[{"type": "text", "text": "ok"}], isError=False),
    ]
    blob = ("\n".join(json.dumps(e) for e in entries) + "\n").encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "toolResult"
    assert snap.pending_tool_calls == 1  # t2 still open


def test_scan_lines_user_clears_open_calls():
    entries = [
        _msg("assistant",
             content=[{"type": "toolCall", "id": "t1", "name": "bash", "arguments": {}}],
             stopReason="toolUse"),
        _msg("user", content="next prompt"),
    ]
    blob = ("\n".join(json.dumps(e) for e in entries) + "\n").encode()
    snap = _scan_lines(blob, mtime=100.0)
    assert snap.last_role == "user"
    assert snap.pending_tool_calls == 0


def test_scan_lines_assistant_error():
    blob = (json.dumps(_msg("assistant", content=[], stopReason="error",
                            errorMessage="boom")) + "\n").encode()
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
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant",
                         last_stop_reason="toolUse", pending_tool_calls=1)
    state, idle = infer_state(snap, now=10.0)
    assert state == AgentState.STALLED
    assert idle == 10.0


def test_infer_stalled_below_threshold_is_working():
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant",
                         last_stop_reason="toolUse", pending_tool_calls=1)
    state, _ = infer_state(snap, now=2.0)
    assert state == AgentState.WORKING


def test_infer_tooluse_with_no_pending_is_working():
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant",
                         last_stop_reason="toolUse", pending_tool_calls=0)
    state, _ = infer_state(snap, now=100.0)
    assert state == AgentState.WORKING


def test_infer_error_via_stop_reason():
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant", last_stop_reason="error")
    state, _ = infer_state(snap, now=100.0)
    assert state == AgentState.ERROR


def test_infer_error_via_message():
    snap = JsonlSnapshot(mtime=0.0, last_role="assistant",
                         last_stop_reason="stop", last_error="boom")
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
    _write_jsonl(f, [_msg("assistant", content=[{"type": "text", "text": "hi"}],
                          stopReason="stop")])
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
    entries.append(_msg("assistant", content=[{"type": "text", "text": "hi"}],
                        stopReason="stop"))
    _write_jsonl(f, entries)

    reader = JsonlReader()
    reader.TAIL_BYTES = 200  # force tail mode for this test
    snap = reader.read(f)
    # We should still recover the *last* entry even though the first bytes
    # we read are mid-line garbage.
    assert snap.last_role == "assistant"


def test_reader_incremental_cache_skips_unchanged(tmp_path: Path):
    f = tmp_path / "s.jsonl"
    _write_jsonl(f, [_msg("assistant", content=[{"type": "text", "text": "hi"}],
                          stopReason="stop")])
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
        fp.write(json.dumps(_msg("assistant",
                                 content=[{"type": "text", "text": "hi"}],
                                 stopReason="stop")) + "\n")
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
