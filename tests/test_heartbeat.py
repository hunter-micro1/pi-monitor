"""Heartbeat reader + state-resolver integration tests.

The reader (`pi_monitor.heartbeat`) consumes JSON files written by the
optional `pi-monitor-heartbeat` extension. These tests fake those files
on disk under a tmp `HEARTBEATS_DIR` and assert that:

  * malformed / missing / stale files return None
  * fresh well-formed files round-trip correctly
  * `StateResolver.resolve` consults the heartbeat *before* JSONL
    inference and overrides what the JSONL would have said
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest


def _write_heartbeat(
    dir_: Path,
    pid: int,
    *,
    ts: float,
    phase: str = "agent_running",
    session_file: str | None = None,
    current_tool: str | None = None,
    retry_attempt: int = 0,
    version: int = 1,
) -> Path:
    """Synthesize a heartbeat file matching the v1 schema."""
    dir_.mkdir(parents=True, exist_ok=True)
    path = dir_ / f"{pid}.json"
    payload = {
        "version": version,
        "pid": pid,
        "session_file": session_file,
        "ts": ts,
        "phase": phase,
        "current_tool": current_tool,
        "retry_attempt": retry_attempt,
    }
    path.write_text(json.dumps(payload) + "\n")
    return path


# ---------------------------------------------------------------------------
# Reader: parse correctness
# ---------------------------------------------------------------------------


def test_read_returns_none_when_file_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr("pi_monitor.heartbeat.HEARTBEATS_DIR", tmp_path)
    from pi_monitor.heartbeat import read_heartbeat

    assert read_heartbeat(12345, now=1000.0) is None


def test_read_returns_none_when_file_malformed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr("pi_monitor.heartbeat.HEARTBEATS_DIR", tmp_path)
    (tmp_path / "12345.json").write_text("{not json")
    from pi_monitor.heartbeat import read_heartbeat

    assert read_heartbeat(12345, now=1000.0) is None


def test_read_returns_none_when_required_field_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr("pi_monitor.heartbeat.HEARTBEATS_DIR", tmp_path)
    # No `phase`.
    (tmp_path / "12345.json").write_text(
        json.dumps({"version": 1, "pid": 12345, "ts": 1000.0})
    )
    from pi_monitor.heartbeat import read_heartbeat

    assert read_heartbeat(12345, now=1000.0) is None


def test_read_returns_none_when_pid_mismatches_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Defensive: a payload claiming a different pid than its filename
    is suspicious. Treat as corrupt."""
    monkeypatch.setattr("pi_monitor.heartbeat.HEARTBEATS_DIR", tmp_path)
    _write_heartbeat(tmp_path, 12345, ts=1000.0)
    # Overwrite payload's pid field.
    (tmp_path / "12345.json").write_text(
        json.dumps(
            {
                "version": 1,
                "pid": 99999,
                "ts": 1000.0,
                "phase": "idle",
                "session_file": None,
                "current_tool": None,
                "retry_attempt": 0,
            }
        )
    )
    from pi_monitor.heartbeat import read_heartbeat

    assert read_heartbeat(12345, now=1000.0) is None


def test_read_returns_none_when_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A heartbeat older than HEARTBEAT_FRESHNESS_S is ignored. The
    extension may have crashed; we'd rather fall back to JSONL than
    surface a frozen status."""
    monkeypatch.setattr("pi_monitor.heartbeat.HEARTBEATS_DIR", tmp_path)
    from pi_monitor.heartbeat import HEARTBEAT_FRESHNESS_S, read_heartbeat

    _write_heartbeat(tmp_path, 12345, ts=1000.0, phase="agent_running")
    # Far past the freshness window.
    assert (
        read_heartbeat(12345, now=1000.0 + HEARTBEAT_FRESHNESS_S + 1.0)
        is None
    )


def test_read_round_trips_fresh_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr("pi_monitor.heartbeat.HEARTBEATS_DIR", tmp_path)
    from pi_monitor.heartbeat import read_heartbeat

    _write_heartbeat(
        tmp_path,
        12345,
        ts=1000.0,
        phase="tool_running",
        session_file="/abs/path/sess.jsonl",
        current_tool="bash",
        retry_attempt=0,
    )
    hb = read_heartbeat(12345, now=1000.5)
    assert hb is not None
    assert hb.pid == 12345
    assert hb.phase == "tool_running"
    assert hb.session_file == Path("/abs/path/sess.jsonl")
    assert hb.current_tool == "bash"
    assert hb.retry_attempt == 0


def test_read_tolerates_unknown_phase(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Reader returns the heartbeat with phase as-is. The state-mapping
    layer (in state.py) is responsible for falling back when the phase
    isn't one it knows about."""
    monkeypatch.setattr("pi_monitor.heartbeat.HEARTBEATS_DIR", tmp_path)
    from pi_monitor.heartbeat import read_heartbeat

    _write_heartbeat(tmp_path, 12345, ts=1000.0, phase="future_state")
    hb = read_heartbeat(12345, now=1000.5)
    assert hb is not None
    assert hb.phase == "future_state"


# ---------------------------------------------------------------------------
# Resolver integration: heartbeat overrides JSONL inference
# ---------------------------------------------------------------------------


def _stamp(path: Path, mtime: float) -> None:
    os.utime(path, (mtime, mtime))


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


def _setup_pi_pane(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    pi_pid: int = 9999,
    pi_start: float = 1000.0,
):
    """Wire SESSIONS_ROOT, HEARTBEATS_DIR, and the /proc fakes for a
    single pi pane. Returns (sessions_root, heartbeats_dir)."""
    sessions_root = tmp_path / "sessions"
    heartbeats_dir = tmp_path / "heartbeats"
    sessions_root.mkdir()
    heartbeats_dir.mkdir()
    monkeypatch.setattr("pi_monitor.state.SESSIONS_ROOT", sessions_root)
    monkeypatch.setattr(
        "pi_monitor.heartbeat.HEARTBEATS_DIR", heartbeats_dir
    )
    monkeypatch.setattr(
        "pi_monitor.state.find_pi_pid_for_pane", lambda pane_pid: pi_pid
    )
    monkeypatch.setattr(
        "pi_monitor.state._proc_starttime",
        lambda pid: pi_start if pid == pi_pid else None,
    )
    return sessions_root, heartbeats_dir


def test_resolve_uses_heartbeat_idle_over_working_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The JSONL has an open toolUse turn (would be WORKING), but the
    heartbeat says idle. Heartbeat wins."""
    from pi_monitor.state import AgentState, PaneRef, StateResolver

    sessions_root, heartbeats_dir = _setup_pi_pane(tmp_path, monkeypatch)

    sess = sessions_root / "--proj--"
    sess.mkdir()
    file_a = sess / "live.jsonl"
    _write_jsonl(
        file_a,
        [
            _msg(
                "assistant",
                content=[
                    {
                        "type": "toolCall",
                        "id": "t1",
                        "name": "bash",
                        "arguments": {},
                    }
                ],
                stopReason="toolUse",
            )
        ],
    )
    _stamp(file_a, 1100.0)

    _write_heartbeat(
        heartbeats_dir, 9999, ts=1199.5, phase="idle"
    )

    resolver = StateResolver()
    refs = [PaneRef(pane_id="p", cwd="/proj", is_pi=True, pane_pid=1)]
    out = resolver.resolve(refs, now=1200.0)
    assert out["p"].state == AgentState.IDLE


def test_resolve_uses_heartbeat_retrying_overrides_error_jsonl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The JSONL ends with assistant{stopReason:'error'} — would map to
    ERROR. The heartbeat reports retrying. The new RETRYING state wins,
    suppressing what would otherwise be a critical-urgency notification."""
    from pi_monitor.state import AgentState, PaneRef, StateResolver

    sessions_root, heartbeats_dir = _setup_pi_pane(tmp_path, monkeypatch)

    sess = sessions_root / "--proj--"
    sess.mkdir()
    file_a = sess / "live.jsonl"
    _write_jsonl(
        file_a,
        [
            _msg(
                "assistant",
                content=[],
                stopReason="error",
                errorMessage="overloaded_error",
            )
        ],
    )
    _stamp(file_a, 1100.0)

    _write_heartbeat(
        heartbeats_dir, 9999, ts=1199.5, phase="retrying", retry_attempt=2
    )

    resolver = StateResolver()
    refs = [PaneRef(pane_id="p", cwd="/proj", is_pi=True, pane_pid=1)]
    out = resolver.resolve(refs, now=1200.0)
    assert out["p"].state == AgentState.RETRYING


def test_resolve_uses_heartbeat_waiting_for_no_session_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A heartbeat with phase=awaiting_permission should map to WAITING
    even when there's no JSONL on disk yet (e.g. an extension blocked
    the very first tool call)."""
    from pi_monitor.state import AgentState, PaneRef, StateResolver

    _, heartbeats_dir = _setup_pi_pane(tmp_path, monkeypatch)

    _write_heartbeat(
        heartbeats_dir, 9999, ts=1199.5, phase="awaiting_permission"
    )

    resolver = StateResolver()
    refs = [PaneRef(pane_id="p", cwd="/proj", is_pi=True, pane_pid=1)]
    out = resolver.resolve(refs, now=1200.0)
    assert out["p"].state == AgentState.WAITING


def test_resolve_falls_back_when_heartbeat_unknown_phase(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """An unknown phase value must NOT short-circuit the resolver to
    UNKNOWN/IDLE. It falls back to the JSONL, which here says WORKING."""
    from pi_monitor.state import AgentState, PaneRef, StateResolver

    sessions_root, heartbeats_dir = _setup_pi_pane(tmp_path, monkeypatch)

    sess = sessions_root / "--proj--"
    sess.mkdir()
    file_a = sess / "live.jsonl"
    _write_jsonl(file_a, [_msg("user", content="hi")])
    _stamp(file_a, 1199.0)

    _write_heartbeat(heartbeats_dir, 9999, ts=1199.5, phase="future_state")

    resolver = StateResolver()
    refs = [PaneRef(pane_id="p", cwd="/proj", is_pi=True, pane_pid=1)]
    out = resolver.resolve(refs, now=1200.0)
    # Fell through to JSONL → user → WORKING.
    assert out["p"].state == AgentState.WORKING


def test_resolve_falls_back_when_heartbeat_stale(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """A stale heartbeat (extension crashed?) is ignored. We fall back
    to JSONL just as if the extension had never been installed."""
    from pi_monitor.heartbeat import HEARTBEAT_FRESHNESS_S
    from pi_monitor.state import AgentState, PaneRef, StateResolver

    sessions_root, heartbeats_dir = _setup_pi_pane(tmp_path, monkeypatch)

    sess = sessions_root / "--proj--"
    sess.mkdir()
    file_a = sess / "live.jsonl"
    _write_jsonl(
        file_a,
        [
            _msg(
                "assistant",
                content=[{"type": "text", "text": "done"}],
                stopReason="stop",
            )
        ],
    )
    _stamp(file_a, 1100.0)

    # ts is well past the freshness window relative to `now=1200.0`.
    _write_heartbeat(
        heartbeats_dir,
        9999,
        ts=1200.0 - HEARTBEAT_FRESHNESS_S - 5.0,
        phase="agent_running",
    )

    resolver = StateResolver()
    refs = [PaneRef(pane_id="p", cwd="/proj", is_pi=True, pane_pid=1)]
    out = resolver.resolve(refs, now=1200.0)
    # JSONL: assistant{stop} idle for 100 s ≫ 1 s threshold → IDLE.
    assert out["p"].state == AgentState.IDLE


def test_resolve_heartbeat_session_file_marks_claimed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """If a heartbeat declares a session_file, that file must be added
    to the resolver's `claimed` set so a sibling pi in the same cwd
    doesn't double-bind to it."""
    from pi_monitor.state import AgentState, PaneRef, StateResolver

    sessions_root = tmp_path / "sessions"
    heartbeats_dir = tmp_path / "heartbeats"
    sessions_root.mkdir()
    heartbeats_dir.mkdir()
    monkeypatch.setattr("pi_monitor.state.SESSIONS_ROOT", sessions_root)
    monkeypatch.setattr(
        "pi_monitor.heartbeat.HEARTBEATS_DIR", heartbeats_dir
    )

    sess = sessions_root / "--proj--"
    sess.mkdir()
    # Single JSONL in cwd. P_A's heartbeat claims it; P_B (no heartbeat)
    # must not also bind to it.
    file_a = sess / "2026-01-01T00-00-00-000Z_a.jsonl"
    _write_jsonl(
        file_a,
        [
            _msg(
                "assistant",
                content=[{"type": "text", "text": "hi"}],
                stopReason="stop",
            )
        ],
    )
    _stamp(file_a, 1100.0)

    monkeypatch.setattr(
        "pi_monitor.state.find_pi_pid_for_pane",
        lambda pane_pid: {1: 1001, 2: 1002}.get(pane_pid),
    )
    # P_A older, P_B younger.
    monkeypatch.setattr(
        "pi_monitor.state._proc_starttime",
        lambda pid: {1001: 999.0, 1002: 1100.5}.get(pid),
    )

    _write_heartbeat(
        heartbeats_dir,
        1001,
        ts=1199.5,
        phase="agent_running",
        session_file=str(file_a),
    )

    resolver = StateResolver()
    refs = [
        PaneRef(pane_id="A", cwd="/proj", is_pi=True, pane_pid=1),
        PaneRef(pane_id="B", cwd="/proj", is_pi=True, pane_pid=2),
    ]
    out = resolver.resolve(refs, now=1200.0)
    # A used heartbeat; B fell through to claim — but file_a is now
    # claimed, so B has nothing to bind to. Within STARTING_GRACE_S of
    # B's start (1100.5), so B reports WORKING with no session file.
    assert out["A"].state == AgentState.WORKING
    assert out["A"].session_file == file_a
    assert out["B"].session_file is None
