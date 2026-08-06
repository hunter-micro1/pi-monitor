/**
 * Harness abstraction.
 *
 * pi-monitor started life as a pi-only tool: process detection,
 * session-file discovery, and JSONL parsing were all hardcoded to
 * pi's conventions. A `Harness` is the seam that lets a second
 * coding agent (Claude Code) provide the same observability without
 * duplicating the state machine in `state/jsonl.ts` or the claim
 * algorithm in `state/files.ts`.
 *
 * The contract is deliberately narrow. A harness answers four
 * questions:
 *
 *   1. Which processes are me?          -> `commNames`
 *   2. Where do my sessions live?       -> `sessionDir`
 *   3. When did this session start?     -> `sessionStartTime`
 *   4. What does this JSONL line mean?  -> `parseRecord`
 *
 * Everything downstream (claiming, inference, notification, render)
 * is harness-agnostic and shared.
 */

/** Stable identifier for a supported coding agent. */
export type HarnessId = "pi" | "claude";

/**
 * A JSONL line normalized into pi-monitor's internal vocabulary.
 *
 * Adapters translate their native record shape into this so the
 * shared scanner in `state/jsonl.ts` runs one state machine for all
 * harnesses. `parseRecord` returns `null` for lines that carry no
 * conversational meaning (metadata, hook output, attachments) —
 * those must not disturb `lastRole`, or a trailing attachment record
 * would mask the assistant turn that actually ended the exchange.
 */
export interface NormalizedRecord {
  /**
   * Which participant produced this record. Mirrors the roles the
   * pi build already understood, so `inferState` is unchanged.
   */
  role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom";
  /**
   * Assistant stop reason, normalized to pi's vocabulary:
   * `stop` | `length` | `aborted` | `toolUse` | `error`.
   *
   * Normalizing here (rather than teaching `inferState` a second
   * dialect) is what keeps state semantics identical across
   * harnesses — an `end_turn` from Claude and a `stop` from pi are
   * the same observable fact and must produce the same state.
   */
  stopReason: string | null;
  /** Assistant error text, when the turn failed. */
  errorMessage: string | null;
  /**
   * First text chunk of the message, already lstripped and capped by
   * the adapter. Used for the row preview (assistant) and the
   * prompt column (user).
   */
  text: string | null;
  /** Tool-call ids opened by an assistant turn. */
  toolCallIds: readonly string[];
  /** Tool-call id closed by a toolResult record. */
  toolCallId: string | null;
  /** Token count attributable to this record (0 when unknown). */
  tokens: number;
  /** Cost in USD attributable to this record (0 when unknown). */
  costUsd: number;
}

/**
 * Convenience constructor so adapters can specify only the fields
 * that apply to the record they're building.
 */
export function normalizedRecord(
  role: NormalizedRecord["role"],
  fields: Partial<Omit<NormalizedRecord, "role">> = {},
): NormalizedRecord {
  return {
    role,
    stopReason: fields.stopReason ?? null,
    errorMessage: fields.errorMessage ?? null,
    text: fields.text ?? null,
    toolCallIds: fields.toolCallIds ?? [],
    toolCallId: fields.toolCallId ?? null,
    tokens: fields.tokens ?? 0,
    costUsd: fields.costUsd ?? 0,
  };
}

/** One supported coding agent. */
export interface Harness {
  id: HarnessId;
  /** Short label for the UI (e.g. the sidebar badge). */
  label: string;
  /**
   * Kernel-tracked `comm` values that identify this agent's process.
   *
   * Matched against `/proc/<pid>/comm` on Linux and `ps -o comm=` on
   * macOS during the pane process-tree walk. Also compared against
   * tmux's `pane_current_command` as a fast path — correct on Linux,
   * unreliable on macOS (libproc reports `node` for Node-based
   * binaries), which is exactly why the tree walk exists.
   */
  commNames: readonly string[];
  /**
   * Directory this harness writes session JSONL files into for a
   * given working directory.
   */
  sessionDir(cwd: string, root?: string): string;
  /** Root under which `sessionDir` resolves. Tests override it. */
  defaultSessionsRoot(): string;
  /**
   * Unix seconds at which the session in `path` began, or `null`
   * when it can't be determined.
   *
   * This is the input to the claim algorithm's ownership window (see
   * `state/files.ts`), which is what stops a freshly-launched agent
   * from stealing an older sibling's actively-written file. pi
   * encodes the timestamp in the filename (free to read); Claude
   * names files by UUID, so its adapter reads the first record's
   * `timestamp` instead. Same algorithm either way.
   */
  sessionStartTime(path: string): number | null;
  /**
   * Translate one raw JSONL line into a `NormalizedRecord`, or
   * `null` when the line carries no conversational meaning.
   */
  parseRecord(line: string): NormalizedRecord | null;
  /**
   * Whether this harness publishes live phase heartbeats.
   *
   * Heartbeats are the only way to distinguish "a tool is running"
   * from "a tool is blocked awaiting your approval" — the session
   * JSONL looks identical in both cases, for every harness (see the
   * note on `IDLE_THRESHOLD_S` in `state/infer.ts`). pi gets them
   * from the `pi-monitor-heartbeat` extension. Claude Code has no
   * equivalent yet, so its panes resolve state from JSONL alone and
   * never report `waiting`.
   */
  supportsHeartbeat: boolean;
}
