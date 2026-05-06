"""Pi agent state inference from session JSONL files.

We derive `AgentState` for each pi pane by reading the *last* meaningful
message entry from the pane's session file and looking at the file's mtime.
We never scrape `tmux capture-pane`; the JSONL plus mtime is sufficient.

Pane → JSONL mapping: pi stores sessions per cwd at
`~/.pi/agent/sessions/--<cwd-with-/-replaced-by->--/<timestamp>_<uuid>.jsonl`,
but multiple pi processes can share a cwd (and therefore a session directory).
Pi opens-writes-closes the file on every append, so `/proc/<pid>/fd` does
NOT reveal which JSONL belongs to which pi. The filename embeds an ISO
timestamp captured the moment pi created the session, which is the only
reliable per-process anchor we have from outside.

We disambiguate per-cwd by:

  1. Walking each pane's process tree to find its live `pi` descendant pid.
  2. Reading that pid's start time from `/proc/<pid>/stat` + `/proc/uptime`.
  3. Sorting the cwd's pi panes by start time ASC (oldest first) and, for
     each pi P, claiming an unclaimed JSONL by:
       a. **Owned** — filename timestamp ∈ [P.start − ε, next_P.start − ε)
          (`+∞` for the youngest pi). This is a session P created (initial
          or via `/new`). Pick max by mtime so an active /new'd file beats
          its abandoned predecessor.
       b. **Resumed** — filename timestamp predates P (P loaded it via
          `--session`) AND mtime ≥ P.start (P has actually written to it).
          Pick max by mtime.
  4. Pis whose pid lookup failed have no lifetime info; they fall back to
     plain mtime-DESC greedy assignment so single-pane cases keep working.

Greedy claim resolution prevents two panes from binding to the same JSONL,
and the bounded ownership window prevents a freshly-launched (file-less)
pi from stealing an older pi's actively-written session — the bug that
used to flip statuses whenever a new agent started in a tmux window next
to a working one.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path

# Minimum stable-mtime time before we promote "assistant just stopped" to
# `idle`. We deliberately do NOT track a separate "stalled" state — from
# external observation we cannot reliably distinguish "tool taking a long
# time" from "tool awaiting user confirmation" (pi only writes complete
# message entries to the JSONL, never streaming events). Reporting one as
# the other is more confusing than just calling it WORKING and trusting the
# user to look at the pane (via the preview) when they want to engage.
IDLE_THRESHOLD_S = 1.0

# How long after pi launches we keep showing a no-file pane as WORKING
# instead of UNKNOWN. SessionManager._persist only flushes the JSONL
# after the first assistant message lands (`hasAssistant` guard), so a
# freshly-launched pi that's actively streaming its first reply has zero
# bytes on disk. Treating that window as WORKING avoids the confusing ❓
# glyph for every fresh launch. Past the grace window a no-file pane
# almost certainly means the user just hasn't typed anything yet, so we
# fall back to UNKNOWN — never IDLE, which would notify.
STARTING_GRACE_S = 30.0

SESSIONS_ROOT = Path.home() / ".pi" / "agent" / "sessions"

# Errors pi auto-retries with exponential backoff. Mirrors
# `_isRetryableError` in pi-coding-agent's `agent-session.js`. When an
# assistant lands with `stopReason: "error"` AND its `errorMessage`
# matches this pattern, pi is in the middle of
# `auto_retry_start..auto_retry_end` and will most likely recover on its
# own within a few seconds. The Notifier uses this to suppress the
# desktop notification for a short window so transient 429/503/network
# blips don't spam the user. Keep this in sync with the upstream regex;
# if pi's list grows we'll match a subset until updated (worst case: a
# real new transient briefly fires a notification, which is the
# pre-suppression behaviour).
_RETRYABLE_ERROR_RE = re.compile(
    r"overloaded"
    r"|provider.?returned.?error"
    r"|rate.?limit"
    r"|too many requests"
    r"|429"
    r"|500|502|503|504"
    r"|service.?unavailable"
    r"|server.?error"
    r"|internal.?error"
    r"|network.?error"
    r"|connection.?error"
    r"|connection.?refused"
    r"|connection.?lost"
    r"|other side closed"
    r"|fetch failed"
    r"|upstream.?connect"
    r"|reset before headers"
    r"|socket hang up"
    r"|ended without"
    r"|http2 request did not get a response"
    r"|timed? out"
    r"|timeout"
    r"|terminated"
    r"|retry delay",
    re.IGNORECASE,
)


def is_retryable_error_message(msg: str | None) -> bool:
    """True if `msg` looks like one of pi's auto-retried transient errors.

    Used by the Notifier to defer ERROR notifications during pi's
    exponential-backoff window. Empty/None is treated as non-retryable —
    we only suppress when we have a concrete error string to match.
    """
    if not msg:
        return False
    return _RETRYABLE_ERROR_RE.search(msg) is not None


class AgentState(str, Enum):
    WORKING = "working"
    IDLE = "idle"
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


@dataclass
class InspectorSnapshot:
    """Richer view of a session JSONL for the on-cursor inspector panel.

    Built by walking the entire JSONL once (then incrementally on growth).
    Tracks cumulative usage (sum across all assistant messages) and the
    latest user-message preview.
    """

    mtime: float
    model: str | None = None
    provider: str | None = None
    cumulative_cost: float = 0.0
    cumulative_input: int = 0
    cumulative_output: int = 0
    cumulative_cache_read: int = 0
    cumulative_cache_write: int = 0
    last_user_message: str | None = None
    current_tool: str | None = None
    message_count: int = 0
    user_message_count: int = 0
    assistant_message_count: int = 0
    session_name: str | None = None  # from session_info entries


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


@dataclass
class _CachedInspector:
    size: int
    snapshot: InspectorSnapshot


class InspectorReader:
    """Full-file JSONL parser used only for the cursored pane's inspector
    panel. Caches per path; on size growth reads only the new tail and folds
    new usage into the running totals.
    """

    def __init__(self) -> None:
        self._cache: dict[str, _CachedInspector] = {}

    def read(self, path: Path) -> InspectorSnapshot | None:
        try:
            st = path.stat()
        except FileNotFoundError:
            self._cache.pop(str(path), None)
            return None
        cached = self._cache.get(str(path))
        if cached is not None and cached.size == st.st_size:
            cached.snapshot.mtime = st.st_mtime
            return cached.snapshot
        if cached is None:
            with path.open("rb") as f:
                blob = f.read()
            snap = _inspector_full_scan(blob, st.st_mtime)
        else:
            with path.open("rb") as f:
                f.seek(cached.size)
                new_blob = f.read()
            snap = _inspector_incremental_scan(new_blob, cached.snapshot, st.st_mtime)
        self._cache[str(path)] = _CachedInspector(size=st.st_size, snapshot=snap)
        return snap


def _inspector_apply_entry(snap: InspectorSnapshot, entry: dict) -> None:
    """Fold one parsed JSONL entry into a running InspectorSnapshot."""
    etype = entry.get("type")
    if etype == "session_info":
        name = entry.get("name")
        if isinstance(name, str):
            snap.session_name = name
        return
    if etype != "message":
        return
    msg = entry.get("message") or {}
    role = msg.get("role")
    snap.message_count += 1
    if role == "assistant":
        snap.assistant_message_count += 1
        if isinstance(msg.get("model"), str):
            snap.model = msg["model"]
        if isinstance(msg.get("provider"), str):
            snap.provider = msg["provider"]
        usage = msg.get("usage") or {}
        if isinstance(usage, dict):
            snap.cumulative_input += int(usage.get("input") or 0)
            snap.cumulative_output += int(usage.get("output") or 0)
            snap.cumulative_cache_read += int(usage.get("cacheRead") or 0)
            snap.cumulative_cache_write += int(usage.get("cacheWrite") or 0)
            cost = usage.get("cost") or {}
            if isinstance(cost, dict):
                snap.cumulative_cost += float(cost.get("total") or 0.0)
        # Track current tool only if this is a toolUse turn whose tool calls
        # have not all been fulfilled yet (we can't know that without the
        # follow-up toolResult; clear it here, set it again below if needed).
        snap.current_tool = None
        if msg.get("stopReason") == "toolUse":
            content = msg.get("content") or []
            for item in content:
                if (
                    isinstance(item, dict)
                    and item.get("type") == "toolCall"
                    and isinstance(item.get("name"), str)
                ):
                    snap.current_tool = item["name"]
                    break
    elif role == "user":
        snap.user_message_count += 1
        snap.last_user_message = _extract_user_text(msg.get("content"))
        snap.current_tool = None  # user prompt clears any pending tool
    elif role == "toolResult":
        # A tool finished; clear the "current tool" hint.
        snap.current_tool = None


def _extract_user_text(content) -> str | None:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                t = item.get("text")
                if isinstance(t, str):
                    parts.append(t)
        if parts:
            return "\n".join(parts)
    return None


def _inspector_full_scan(blob: bytes, mtime: float) -> InspectorSnapshot:
    snap = InspectorSnapshot(mtime=mtime)
    for line in blob.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        _inspector_apply_entry(snap, entry)
    return snap


def _inspector_incremental_scan(
    new_blob: bytes, prior: InspectorSnapshot, mtime: float
) -> InspectorSnapshot:
    """Fold new bytes (since last read) into the prior snapshot in place.
    The first line is dropped if it looks partial — but pi only appends whole
    lines, so this should always start cleanly at a line boundary."""
    prior.mtime = mtime
    for line in new_blob.splitlines():
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        _inspector_apply_entry(prior, entry)
    return prior


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


# Session filenames look like
# `2026-05-03T20-37-34-005Z_019def8f-86b5-77ac-96f5-302472f17757.jsonl`.
# Pi builds the prefix by replacing `:` and `.` in an ISO timestamp with
# `-`, so we have to put them back before parsing. We anchor at the start
# of the filename and stop at the `_<uuid>` separator.
_FILENAME_TS_RE = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})T"
    r"(?P<h>\d{2})-(?P<m>\d{2})-(?P<s>\d{2})-(?P<ms>\d{3})Z_"
)

# Slack we allow when comparing a filename timestamp to a pi process's
# start time. Pi calls `new Date()` a few ticks after the kernel created
# the process, so filename_ts > pi.start in practice; the epsilon just
# guards against `_proc_starttime`'s clock-tick rounding (~10ms) and any
# latent clock skew.
_FILENAME_TS_EPSILON_S = 1.0


def _filename_starttime(path: Path) -> float | None:
    """Parse the ISO timestamp pi embeds in a session filename, returning a
    unix timestamp. Returns None for filenames that don't match the
    expected pattern (e.g. test fixtures with arbitrary names) so callers
    can fall back to mtime-based heuristics."""
    match = _FILENAME_TS_RE.match(path.name)
    if match is None:
        return None
    iso = (
        f"{match['date']}T{match['h']}:{match['m']}:{match['s']}.{match['ms']}"
        "+00:00"
    )
    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return None


def _list_jsonl_with_mtime(directory: Path) -> list[tuple[Path, float]]:
    if not directory.exists():
        return []
    return [(p, p.stat().st_mtime) for p in directory.iterdir() if p.suffix == ".jsonl"]


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
    pi_start: float | None,
    next_pi_start: float | None,
    claimed: set[Path],
) -> Path | None:
    """Pick the JSONL belonging to a single pi process in `cwd`.

    The strong signal is the filename's embedded ISO timestamp — it's the
    moment pi created the session and is the only per-process anchor we
    can read from outside (pi opens-writes-closes on every append, so
    /proc/fd is empty between turns).

    Selection order, highest priority first:

      1. **Owned**: filename timestamp ∈ [pi_start − ε, next_pi_start − ε).
         A file pi created during its lifetime, before any younger sibling
         pi in the same cwd was born. `next_pi_start=None` means "no
         younger pi" → unbounded above. Pick max by mtime so an active
         /new'd file beats its abandoned predecessor.
      2. **Resumed**: filename timestamp predates pi (so it's not pi's own
         creation) AND mtime ≥ pi_start (pi has actually written to it,
         which is what `--session` does). Pick max by mtime.
      3. **No-info fallback** (only when `pi_start is None`): max-by-mtime
         unclaimed file in the cwd. Used by `find_session_file_for_cwd`
         and by panes whose pid lookup failed.

    Returns `None` (not a guess) when we know pi's start time but no file
    matches — e.g. a freshly-launched idle pi that hasn't written yet.
    This is the fix for the cohabitation swap bug: the prior code fell
    back to "most recent file in cwd" here, which silently re-bound the
    new pi to another pi's actively-written session.
    """
    candidates = [
        (p, m)
        for p, m in _list_jsonl_with_mtime(cwd_to_session_dir(cwd))
        if p not in claimed
    ]
    if not candidates:
        return None

    if pi_start is None:
        return max(candidates, key=lambda pm: pm[1])[0]

    eps = _FILENAME_TS_EPSILON_S
    upper = (next_pi_start - eps) if next_pi_start is not None else float("inf")
    lower = pi_start - eps

    owned: list[tuple[Path, float]] = []
    older_filename: list[tuple[Path, float]] = []
    for p, m in candidates:
        fts = _filename_starttime(p)
        if fts is not None and lower <= fts < upper:
            owned.append((p, m))
        elif fts is None or fts < lower:
            # Either a non-standard name (test fixtures) or a file created
            # before pi was born. Eligible for the resumed-session path,
            # which additionally requires mtime ≥ pi_start.
            older_filename.append((p, m))
    if owned:
        return max(owned, key=lambda pm: pm[1])[0]

    resumed = [(p, m) for p, m in older_filename if m >= pi_start]
    if resumed:
        return max(resumed, key=lambda pm: pm[1])[0]

    return None


def find_session_file_for_cwd(pane_cwd: str) -> Path | None:
    """Convenience for single-pane callers / tests: most recently modified
    jsonl in the cwd's session directory, ignoring claim resolution."""
    return _claim_session_file(
        pane_cwd, pi_start=None, next_pi_start=None, claimed=set()
    )


# ---------------------------------------------------------------------------
# State inference
# ---------------------------------------------------------------------------


def infer_state(
    snapshot: JsonlSnapshot | None, now: float | None = None
) -> tuple[AgentState, float]:
    """Map a snapshot to an `AgentState` plus seconds since last write.

    Three meaningful states:
      ERROR    — last assistant has an error
      IDLE     — last entry is `assistant` with stopReason in {stop, length,
                  aborted} AND mtime stable for >= IDLE_THRESHOLD_S
      WORKING  — anything else (toolUse pending, mid-stream, user/toolResult)
    """
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
        if sr in ("stop", "length", "aborted"):
            if idle_for >= IDLE_THRESHOLD_S:
                return AgentState.IDLE, idle_for
            return AgentState.WORKING, idle_for
        # toolUse / unknown stopReason — the agent is mid-turn.
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

        Pis are grouped by cwd (different cwds use different session dirs
        so they never compete) and processed start-time-ASC within each
        group. The ASC order means each pi knows the next-younger sibling's
        start time, which bounds its filename ownership window above. This
        prevents a freshly-launched pi from stealing an older pi's actively-
        written file.

        Two panes can never bind to the same JSONL.
        """
        if now is None:
            now = time.time()
        # Walk process trees once; cache (ref → pi_start_time). We only
        # need start time downstream, so drop the pid after the lookup.
        starts: dict[str, float | None] = {}
        for ref in refs:
            if not ref.is_pi:
                continue
            pi_pid = find_pi_pid_for_pane(ref.pane_pid)
            starts[ref.pane_id] = (
                _proc_starttime(pi_pid) if pi_pid is not None else None
            )

        # Group pi panes by cwd. Within each group sort by start time ASC
        # (None first — those panes have no lifetime info and use the
        # plain mtime-DESC fallback, which is order-independent).
        groups: dict[str, list[PaneRef]] = {}
        for ref in refs:
            if ref.is_pi:
                groups.setdefault(ref.cwd, []).append(ref)
        for group in groups.values():
            group.sort(key=lambda r: starts[r.pane_id] or float("-inf"))

        claimed: set[Path] = set()
        results: dict[str, PaneStatus] = {}
        for group in groups.values():
            for i, ref in enumerate(group):
                pi_start = starts[ref.pane_id]
                next_pi_start = (
                    starts[group[i + 1].pane_id] if i + 1 < len(group) else None
                )
                session_file = _claim_session_file(
                    ref.cwd, pi_start, next_pi_start, claimed
                )
                if session_file is None:
                    # Live pi with no flushed JSONL yet: most likely a
                    # fresh launch streaming its first response. Show
                    # WORKING during the grace window so users don't see
                    # ❓ on every new pi. After the window we fall back
                    # to UNKNOWN — never IDLE, which would notify.
                    if (
                        pi_start is not None
                        and (now - pi_start) < STARTING_GRACE_S
                    ):
                        results[ref.pane_id] = PaneStatus(
                            pane_id=ref.pane_id, state=AgentState.WORKING
                        )
                    else:
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
