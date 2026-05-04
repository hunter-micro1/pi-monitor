"""Pi agent state inference from session JSONL files.

We derive `AgentState` for each pi pane by reading the *last* meaningful
message entry from the pane's session file and looking at the file's mtime.
We never scrape `tmux capture-pane`; the JSONL plus mtime is sufficient.

Pane → JSONL mapping: pi stores sessions per cwd at
`~/.pi/agent/sessions/--<cwd-with-/-replaced-by->--/<timestamp>_<uuid>.jsonl`,
but multiple pi processes can share a cwd (and therefore a session directory).
Pi opens-writes-closes the file on every append, so `/proc/<pid>/fd` does
NOT reveal which JSONL belongs to which pi. We disambiguate by:

  1. Walking the pane's process tree to find the live `pi` descendant pid.
  2. Reading that pid's start time from `/proc/<pid>/stat` + `/proc/uptime`.
  3. For each pi pane in start-time-DESC order, claiming the most recently
     modified unclaimed JSONL whose mtime falls within that pi's lifetime.
  4. Falling back to the most recently modified unclaimed JSONL in the cwd
     when no file has been written during the pi's lifetime yet.

Greedy claim resolution prevents two panes from binding to the same JSONL.
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
                if isinstance(item, dict)
                and item.get("type") == "toolCall"
                and item.get("id")
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
# Pane → JSONL mapping
# ---------------------------------------------------------------------------


def cwd_to_session_dir(cwd: str) -> Path:
    """Pi encodes a session's cwd as `--<path-with-/-replaced-by->--`,
    stripping the leading `/` first (so `/home/x` becomes `--home-x--`)."""
    return SESSIONS_ROOT / f"--{cwd.lstrip('/').replace('/', '-')}--"


def _list_jsonl_with_mtime(directory: Path) -> list[tuple[Path, float]]:
    if not directory.exists():
        return []
    return [
        (p, p.stat().st_mtime)
        for p in directory.iterdir()
        if p.suffix == ".jsonl"
    ]


_PROC = Path("/proc")


def _proc_starttime(pid: int) -> float | None:
    """Absolute unix time when `pid` was created, or None if pid is gone.

    Reads field 22 (starttime, in clock ticks since boot) from /proc/<pid>/stat
    and combines with /proc/uptime. The comm field can contain spaces and
    parentheses, so we slice past the last `)` before splitting.
    """
    try:
        stat = (_PROC / str(pid) / "stat").read_text()
        rparen = stat.rfind(")")
        if rparen == -1:
            return None
        fields = stat[rparen + 2 :].split()
        # After comm, fields are state(3) ppid(4) ... starttime(22).
        # We sliced past pid+comm, so starttime is index 19.
        starttime_ticks = int(fields[19])
        uptime_s = float((_PROC / "uptime").read_text().split()[0])
    except (FileNotFoundError, ValueError, IndexError, PermissionError):
        return None
    boot_time = time.time() - uptime_s
    clock_ticks = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
    return boot_time + (starttime_ticks / clock_ticks)


def _walk_pi_descendant(root_pid: int, max_depth: int = 6) -> int | None:
    """Find a descendant of `root_pid` whose comm is exactly 'pi'.

    Iterative BFS with a depth cap so we never recurse forever on a corrupt
    /proc snapshot. Returns the first matching pid or None.
    """
    queue: list[tuple[int, int]] = [(root_pid, 0)]
    while queue:
        pid, depth = queue.pop(0)
        try:
            comm = (_PROC / str(pid) / "comm").read_text().strip()
        except (FileNotFoundError, PermissionError):
            continue
        if comm == "pi":
            return pid
        if depth >= max_depth:
            continue
        try:
            children_raw = (
                _PROC / str(pid) / "task" / str(pid) / "children"
            ).read_text()
        except (FileNotFoundError, PermissionError):
            continue
        for child_str in children_raw.split():
            try:
                queue.append((int(child_str), depth + 1))
            except ValueError:
                continue
    return None


def find_pi_pid_for_pane(pane_pid: int) -> int | None:
    """Walk the process tree from a tmux pane's pid to find its `pi` descendant.

    The pane_pid is typically the pane's shell (zsh/bash); pi runs as a child.
    Returns None if no pi descendant is alive.
    """
    return _walk_pi_descendant(pane_pid)


def _claim_session_file(
    cwd: str,
    pi_pid: int | None,
    claimed: set[Path],
) -> Path | None:
    """Pick the JSONL most likely to belong to this pi, excluding already-
    claimed files. Prefer files written during pi's lifetime; fall back to
    most recently modified unclaimed file in the cwd's session dir."""
    candidates = [
        (p, m)
        for p, m in _list_jsonl_with_mtime(cwd_to_session_dir(cwd))
        if p not in claimed
    ]
    if not candidates:
        return None
    if pi_pid is not None:
        start = _proc_starttime(pi_pid)
        if start is not None:
            in_window = [(p, m) for p, m in candidates if m >= start]
            if in_window:
                return max(in_window, key=lambda pm: pm[1])[0]
    return max(candidates, key=lambda pm: pm[1])[0]


def find_session_file_for_cwd(pane_cwd: str) -> Path | None:
    """Convenience for single-pane callers / tests: most recently modified
    jsonl in the cwd's session directory, ignoring claim resolution."""
    return _claim_session_file(pane_cwd, pi_pid=None, claimed=set())


# ---------------------------------------------------------------------------
# State inference
# ---------------------------------------------------------------------------


def infer_state(
    snapshot: JsonlSnapshot | None, now: float | None = None
) -> tuple[AgentState, float]:
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


@dataclass(frozen=True)
class PaneRef:
    """Minimal info `StateResolver.resolve` needs about a pane.

    Decoupled from `tmux.Pane` so this module has no tmux dependency.
    """

    pane_id: str
    cwd: str
    is_pi: bool
    pane_pid: int  # the tmux pane's pid (typically a shell)


@dataclass
class StateResolver:
    """Combines per-pane jsonl discovery, JSONL caching, and state inference."""

    reader: JsonlReader = field(default_factory=JsonlReader)

    def resolve(
        self,
        refs: list[PaneRef],
        now: float | None = None,
    ) -> dict[str, PaneStatus]:
        """Resolve state for every pane in one pass with shared claim set.

        Greedy assignment in pi-start-time-DESC order: newest pi picks first
        from the most recently modified unclaimed JSONLs whose mtime falls
        within its lifetime. Two panes can never bind to the same JSONL.
        """
        # Walk process trees once; cache (ref → pi_pid, start_time).
        meta: dict[str, tuple[int | None, float | None]] = {}
        for ref in refs:
            if not ref.is_pi:
                meta[ref.pane_id] = (None, None)
                continue
            pi_pid = find_pi_pid_for_pane(ref.pane_pid)
            start = _proc_starttime(pi_pid) if pi_pid is not None else None
            meta[ref.pane_id] = (pi_pid, start)

        # Sort pi panes by start time DESC (None last). Non-pi panes don't
        # claim anything and are filled in afterwards.
        pi_refs = [r for r in refs if r.is_pi]
        pi_refs.sort(
            key=lambda r: meta[r.pane_id][1] or float("-inf"),
            reverse=True,
        )

        claimed: set[Path] = set()
        results: dict[str, PaneStatus] = {}
        for ref in pi_refs:
            pi_pid, _ = meta[ref.pane_id]
            session_file = _claim_session_file(ref.cwd, pi_pid, claimed)
            if session_file is None:
                results[ref.pane_id] = PaneStatus(
                    pane_id=ref.pane_id, state=AgentState.UNKNOWN
                )
                continue
            claimed.add(session_file)
            snapshot = self.reader.read(session_file)
            state, idle_for = infer_state(snapshot, now=now)
            results[ref.pane_id] = PaneStatus(
                pane_id=ref.pane_id,
                state=state,
                session_file=session_file,
                snapshot=snapshot,
                idle_seconds=idle_for,
            )
        for ref in refs:
            if ref.pane_id not in results:
                results[ref.pane_id] = PaneStatus(
                    pane_id=ref.pane_id, state=AgentState.NO_PI
                )
        return results
