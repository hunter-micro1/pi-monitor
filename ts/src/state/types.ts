/**
 * Core data types shared across the state inference pipeline.
 *
 * Direct ports of the dataclasses + AgentState enum at the top of
 * `src/pi_monitor/state.py` in the Python build. Keeping the field
 * names identical (snake_case → camelCase only where truly idiomatic)
 * makes side-by-side review against the Python original tractable.
 */

/**
 * What an agent is currently doing, from pi-monitor's perspective.
 *
 * Order is intentional: needs-attention states (`error`, `waiting`,
 * `idle`) come first so iteration-based priority lookups can use it
 * as a tie-break for free \u2014 same convention the Python build relies
 * on in its `STATE_PRIORITY` table.
 */
export type AgentState =
  | "error"
  | "waiting"
  | "idle"
  | "retrying"
  | "working"
  | "unknown"
  | "no_pi";

/**
 * Convenience constants so call sites can write `AgentState.IDLE`
 * instead of the bare string literal. Mirrors the Python `Enum`.
 */
export const AgentState = {
  ERROR: "error",
  WAITING: "waiting",
  IDLE: "idle",
  RETRYING: "retrying",
  WORKING: "working",
  UNKNOWN: "unknown",
  NO_PI: "no_pi",
} as const satisfies Record<string, AgentState>;

/**
 * Snapshot of a session JSONL file at one moment in time.
 *
 * `_scan_lines` produces one of these from the tail of a session
 * file; the resolver folds it into a `PaneStatus`. Field meanings
 * line up 1:1 with the Python `JsonlSnapshot` dataclass.
 */
export interface JsonlSnapshot {
  /** mtime of the JSONL file (seconds since epoch). */
  mtime: number;
  /**
   * Role of the trailing message entry. `null` when the file is
   * empty or contains only non-message entries.
   */
  lastRole: "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | null;
  /**
   * `stopReason` of the trailing assistant message, when it IS an
   * assistant. Otherwise `null`.
   */
  lastStopReason: string | null;
  /**
   * `errorMessage` of the trailing assistant message when it has one.
   * `null` otherwise.
   */
  lastError: string | null;
  /**
   * Number of unmatched tool calls from the latest tool-use turn.
   * Drops to zero once every toolCall has a corresponding
   * toolResult.
   */
  pendingToolCalls: number;
  /**
   * First text chunk of the latest assistant message, lstripped and
   * capped at PREVIEW_MAX_CHARS at parse time. The UI may further
   * truncate to fit the row width. `null` when the trailing assistant
   * has no text content (tool-only turn) or no assistant has spoken
   * yet.
   */
  lastAssistantPreview: string | null;
}

/**
 * What pi-monitor surfaces about a single tmux pane on every render
 * tick. Built by `StateResolver.resolve` from the JSONL snapshot,
 * heartbeat data (when the extension is installed), and the pane's
 * lifetime info.
 */
export interface PaneStatus {
  /** e.g. "contracts:0.2" \u2014 the tmux target for the pane. */
  paneId: string;
  state: AgentState;
  /**
   * Absolute path to the JSONL the resolver bound to this pane,
   * or `null` when no session file is claimable yet (fresh pi
   * still waiting for its first flush).
   */
  sessionFile: string | null;
  snapshot: JsonlSnapshot | null;
  /** Seconds since the last write to `sessionFile` (mtime distance). */
  idleSeconds: number;
  /**
   * Optional heartbeat-extension fields. Populated only when the
   * `pi-monitor-heartbeat` extension is running inside the pi
   * process AND its status file is fresh; `null` / 0 otherwise.
   * Letting the UI tell "agent is in tool X right now" from
   * "agent is busy, no idea what it's doing" without re-reading
   * the heartbeat file at render time.
   */
  phase: string | null;
  currentTool: string | null;
  retryAttempt: number;
}
