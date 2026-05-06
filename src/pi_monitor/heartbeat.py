"""Heartbeat reader for the optional `pi-monitor-heartbeat` extension.

The extension (see `extensions/pi-monitor-heartbeat/index.ts` in this repo)
runs *inside* each pi process and writes a small JSON file at
`~/.pi/agent/.heartbeats/<pid>.json` describing what the agent is actually
doing. When present and fresh, this file is the authoritative source of
truth for that pi's state — the resolver consults it before falling back
to JSONL/mtime heuristics.

Path layout: keyed by pi pid (not session id) so the resolver doesn't
have to solve the JSONL claim problem twice. The reader is given a pid
and returns either a parsed `Heartbeat` or `None`.

Freshness: a heartbeat older than `HEARTBEAT_FRESHNESS_S` seconds is
treated as stale (the extension may have crashed or pi may be wedged).
The caller falls back to JSONL inference for stale heartbeats.

This module has no notify/state dependencies of its own; the mapping of
`Phase` → `AgentState` lives in `state.py` next to the rest of the
state machine so it stays under one roof.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

# Heartbeat directory on disk. Mirrors the extension's path layout in
# `extensions/pi-monitor-heartbeat/index.ts`. Both sides must agree.
HEARTBEATS_DIR = Path.home() / ".pi" / "agent" / ".heartbeats"

# How recently the extension must have written a heartbeat for us to
# trust it. The extension writes on every relevant lifecycle event;
# during a long bash run there *are* no events, so this window must be
# generous. Five seconds is enough to ride out tiny event-loop hitches
# without preserving a heartbeat from a pi that crashed mid-tool.
HEARTBEAT_FRESHNESS_S = 5.0


@dataclass(frozen=True)
class Heartbeat:
    """Parsed heartbeat payload. See the extension's docstring for the
    canonical schema; this dataclass mirrors v1 of that schema."""

    pid: int
    session_file: Path | None
    ts: float  # unix seconds (extension writes Date.now() / 1000)
    phase: str  # see VALID_PHASES; unknown values are still surfaced
    current_tool: str | None
    retry_attempt: int


# Phase values the extension is known to publish. We accept others (the
# extension's schema may grow); unknown phases are surfaced as-is and
# treated by the caller as a no-info signal (fall through to JSONL).
VALID_PHASES = frozenset(
    {
        "idle",
        "agent_running",
        "tool_running",
        "retrying",
        "compacting",
        "awaiting_permission",
    }
)


def heartbeat_path_for_pid(pid: int) -> Path:
    return HEARTBEATS_DIR / f"{pid}.json"


def read_heartbeat(
    pid: int, now: float | None = None
) -> Heartbeat | None:
    """Read and parse the heartbeat for `pid`, returning `None` when the
    file is missing, malformed, or stale.

    Stale = `now - heartbeat.ts > HEARTBEAT_FRESHNESS_S`. We use the
    payload's own `ts` (set inside pi on each event) rather than the
    file's mtime so a long-running tool doesn't make a perfectly valid
    heartbeat look stale just because no events fired during the tool.
    Wait — actually it would. Tool execution start *does* fire an event
    and bumps ts. The file's mtime and the payload ts are nearly
    identical in practice; using the payload value is the more correct
    one (it's the moment pi observed the event, not the moment the OS
    finished the write).
    """
    path = heartbeat_path_for_pid(pid)
    try:
        raw = path.read_text()
    except (FileNotFoundError, PermissionError):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    # Required fields. Tolerate version mismatches by ignoring fields we
    # don't know about; reject only when essentials are missing.
    try:
        ts = float(data["ts"])
        phase = str(data["phase"])
        pid_in_payload = int(data.get("pid", pid))
    except (KeyError, TypeError, ValueError):
        return None
    if pid_in_payload != pid:
        # Heartbeat path is keyed by pid, so this should never happen in
        # practice. Treat as corrupt → ignore.
        return None
    now = now if now is not None else time.time()
    if now - ts > HEARTBEAT_FRESHNESS_S:
        return None
    session_file_raw = data.get("session_file")
    session_file = (
        Path(session_file_raw)
        if isinstance(session_file_raw, str) and session_file_raw
        else None
    )
    current_tool_raw = data.get("current_tool")
    current_tool = (
        current_tool_raw if isinstance(current_tool_raw, str) else None
    )
    try:
        retry_attempt = int(data.get("retry_attempt", 0) or 0)
    except (TypeError, ValueError):
        retry_attempt = 0
    return Heartbeat(
        pid=pid,
        session_file=session_file,
        ts=ts,
        phase=phase,
        current_tool=current_tool,
        retry_attempt=retry_attempt,
    )
