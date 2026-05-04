"""Pi agent state inference from session JSONL files.

We derive `AgentState` for each pi pane by reading the *last* meaningful
message entry from the pane's session file and looking at the file's mtime.
We never scrape `tmux capture-pane`; the JSONL plus mtime is sufficient.

Pane → JSONL mapping uses `/proc/<pid>/fd/*` walked over the pane's process
and all its descendants, since pi may run as a child of a login shell.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

# Minimum stable-mtime time before we promote "assistant just stopped" to
# `idle`, and before we promote a tool-use turn with unfulfilled tool calls
# to `stalled`. See Q4 of the design notes.
IDLE_THRESHOLD_S = 1.0
STALLED_THRESHOLD_S = 5.0

SESSIONS_ROOT = Path.home() / ".pi" / "agent" / "sessions"


class AgentState(str, Enum):
    IDLE = "idle"
    WORKING = "working"
    STALLED = "stalled"
    ERROR = "error"
    NO_PI = "no_pi"
    UNKNOWN = "unknown"


@dataclass
class JsonlSnapshot:
    """What we extracted from a session file at one moment in time."""

    mtime: float
    last_role: str | None = None  # "user" | "assistant" | "toolResult" | None
    last_stop_reason: str | None = None  # only set when last_role == "assistant"
    last_error: str | None = None  # assistant errorMessage if any
    pending_tool_calls: int = 0  # unmatched tool calls from latest toolUse turn


@dataclass
class _CachedFile:
    size: int
    snapshot: JsonlSnapshot


@dataclass
class PaneStatus:
    pane_id: str  # e.g. "contracts:0.2"
    state: AgentState
    session_file: Path | None = None
    snapshot: JsonlSnapshot | None = None
    idle_seconds: float = 0.0  # seconds since last write (mtime distance)


# ---------------------------------------------------------------------------
# JSONL reading
# ---------------------------------------------------------------------------


class JsonlReader:
    """Caches `(path → (size, snapshot))` so each tick is O(delta)."""

    # Tail this many bytes when we *do* re-read. Enough to cover the last
    # ~50 entries even on a chatty session, far cheaper than reading 3MB.
    TAIL_BYTES = 65_536

    def __init__(self) -> None:
        self._cache: dict[str, _CachedFile] = {}

    def read(self, path: Path) -> JsonlSnapshot | None:
        try:
            st = path.stat()
        except FileNotFoundError:
            self._cache.pop(str(path), None)
            return None

        cached = self._cache.get(str(path))
        if cached is not None and cached.size == st.st_size:
            # File untouched since last read; mtime *can* differ if it was
            # truncated-and-rewritten to the same size, but pi only appends.
            cached.snapshot.mtime = st.st_mtime
            return cached.snapshot

        snapshot = self._scan_tail(path, st.st_mtime)
        self._cache[str(path)] = _CachedFile(size=st.st_size, snapshot=snapshot)
        return snapshot

    def _scan_tail(self, path: Path, mtime: float) -> JsonlSnapshot:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            start = max(0, end - self.TAIL_BYTES)
            f.seek(start)
            blob = f.read()

        # If we didn't start at byte 0 we likely sliced mid-line; drop the first
        # partial line to keep the parser honest.
        if start > 0:
            nl = blob.find(b"\n")
            if nl == -1:
                return JsonlSnapshot(mtime=mtime)
            blob = blob[nl + 1 :]

        return _scan_lines(blob, mtime)


def _scan_lines(blob: bytes, mtime: float) -> JsonlSnapshot:
    """Walk forward through the tail bytes, tracking the latest message entry
    plus any open tool-use turn whose tool calls aren't all fulfilled yet."""

    last_role: str | None = None
    last_stop_reason: str | None = None
    last_error: str | None = None
    open_toolcall_ids: set[str] = set()

    for line in blob.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("type") != "message":
            continue
        msg = entry.get("message") or {}
        role = msg.get("role")
        if role == "assistant":
            last_role = "assistant"
            last_stop_reason = msg.get("stopReason")
            last_error = msg.get("errorMessage")
            content = msg.get("content") or []
            tool_ids = {
                item.get("id")
                for item in content
                if isinstance(item, dict) and item.get("type") == "toolCall" and item.get("id")
            }
            if last_stop_reason == "toolUse":
                # New tool-use turn supersedes any pending one from earlier.
                open_toolcall_ids = set(tool_ids)
            else:
                open_toolcall_ids.clear()
        elif role == "toolResult":
            last_role = "toolResult"
            tcid = msg.get("toolCallId")
            if tcid in open_toolcall_ids:
                open_toolcall_ids.discard(tcid)
        elif role == "user":
            last_role = "user"
            open_toolcall_ids.clear()
        elif role in ("bashExecution", "custom"):
            # These are agent-level events; treat as activity but don't change
            # the assistant/tool-result distinction.
            last_role = role

    return JsonlSnapshot(
        mtime=mtime,
        last_role=last_role,
        last_stop_reason=last_stop_reason,
        last_error=last_error,
        pending_tool_calls=len(open_toolcall_ids),
    )


# ---------------------------------------------------------------------------
# Pane → JSONL mapping via /proc
# ---------------------------------------------------------------------------


def _descendant_pids(root_pid: int) -> list[int]:
    """BFS through /proc/<pid>/task/<pid>/children. Linux-only."""
    seen: list[int] = []
    queue = [root_pid]
    while queue:
        pid = queue.pop(0)
        seen.append(pid)
        children_path = Path(f"/proc/{pid}/task/{pid}/children")
        try:
            children = children_path.read_text().split()
        except (FileNotFoundError, PermissionError):
            continue
        for child in children:
            try:
                queue.append(int(child))
            except ValueError:
                pass
    return seen


def find_session_file_for_pid(pane_pid: int) -> Path | None:
    """Walk fd/ for the pane's process tree, return the open *.jsonl under
    ~/.pi/agent/sessions/. If the process tree has multiple matches (rare),
    return the most recently modified."""
    candidates: list[Path] = []
    for pid in _descendant_pids(pane_pid):
        fd_dir = Path(f"/proc/{pid}/fd")
        try:
            entries = list(fd_dir.iterdir())
        except (FileNotFoundError, PermissionError):
            continue
        for entry in entries:
            try:
                target = os.readlink(entry)
            except OSError:
                continue
            if not target.endswith(".jsonl"):
                continue
            target_path = Path(target)
            try:
                target_path.relative_to(SESSIONS_ROOT)
            except ValueError:
                continue
            candidates.append(target_path)
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime if p.exists() else 0.0)


# ---------------------------------------------------------------------------
# State inference
# ---------------------------------------------------------------------------


def infer_state(snapshot: JsonlSnapshot | None, now: float | None = None) -> tuple[AgentState, float]:
    """Map a snapshot to an `AgentState` plus seconds since last write."""
    if snapshot is None:
        return AgentState.UNKNOWN, 0.0
    now = now if now is not None else time.time()
    idle_for = max(0.0, now - snapshot.mtime)

    if snapshot.last_error:
        return AgentState.ERROR, idle_for
    if snapshot.last_role == "assistant":
        sr = snapshot.last_stop_reason
        if sr == "error":
            return AgentState.ERROR, idle_for
        if sr in ("stop", "length"):
            if idle_for >= IDLE_THRESHOLD_S:
                return AgentState.IDLE, idle_for
            return AgentState.WORKING, idle_for
        if sr == "toolUse" and snapshot.pending_tool_calls > 0:
            if idle_for >= STALLED_THRESHOLD_S:
                return AgentState.STALLED, idle_for
            return AgentState.WORKING, idle_for
        if sr == "aborted":
            return AgentState.IDLE, idle_for
        return AgentState.WORKING, idle_for
    if snapshot.last_role in ("toolResult", "user", "bashExecution", "custom"):
        return AgentState.WORKING, idle_for
    return AgentState.UNKNOWN, idle_for


# ---------------------------------------------------------------------------
# Top-level helper used by the TUI
# ---------------------------------------------------------------------------


@dataclass
class StateResolver:
    """Combines pane discovery, JSONL caching, and state inference."""

    reader: JsonlReader = field(default_factory=JsonlReader)
    _pid_to_session: dict[int, Path] = field(default_factory=dict)

    def status_for_pane(
        self,
        pane_id: str,
        pane_pid: int,
        is_pi: bool,
        now: float | None = None,
    ) -> PaneStatus:
        if not is_pi:
            return PaneStatus(pane_id=pane_id, state=AgentState.NO_PI)

        # Re-resolve the session file if our cached one is stale (file gone,
        # or the pi process restarted).
        cached = self._pid_to_session.get(pane_pid)
        if cached is None or not cached.exists():
            session_file = find_session_file_for_pid(pane_pid)
            if session_file is None:
                return PaneStatus(pane_id=pane_id, state=AgentState.UNKNOWN)
            self._pid_to_session[pane_pid] = session_file
        else:
            session_file = cached

        snapshot = self.reader.read(session_file)
        state, idle_for = infer_state(snapshot, now=now)
        return PaneStatus(
            pane_id=pane_id,
            state=state,
            session_file=session_file,
            snapshot=snapshot,
            idle_seconds=idle_for,
        )
