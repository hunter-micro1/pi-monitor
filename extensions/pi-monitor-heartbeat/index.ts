/**
 * pi-monitor-heartbeat: publish a small JSON file describing this pi process's
 * current phase so pi-monitor can classify it accurately from the outside.
 *
 * Why this exists
 * ---------------
 * pi-monitor reads `~/.pi/agent/sessions/<cwd>/<file>.jsonl` to infer agent
 * state, but the JSONL is silent during long LLM streams, long bash runs,
 * compaction, and the auto-retry sleep windows. From outside the process the
 * monitor can't distinguish "compacting" from "idle" or "retrying" from "just
 * errored". This extension runs *inside* pi and writes an authoritative
 * heartbeat file pi-monitor reads first, falling back to its mtime-based
 * inference when the file is stale or absent.
 *
 * Heartbeat path
 * --------------
 *   ~/.pi/agent/.heartbeats/<pi-pid>.json
 *
 * Keying by pid (not by session id) means pi-monitor can map a pane → pi pid
 * → heartbeat without solving the JSONL claim problem twice. The reader is
 * expected to ignore heartbeats whose `ts` is more than ~5 s old.
 *
 * Schema (v1)
 * -----------
 *   {
 *     "version": 1,
 *     "pid": <pi process pid>,
 *     "session_file": <abs path to jsonl> | null,
 *     "ts": <unix seconds, fractional>,
 *     "phase": "idle" | "agent_running" | "tool_running"
 *            | "retrying" | "compacting" | "awaiting_permission",
 *     "current_tool": <tool name> | null,
 *     "retry_attempt": <int, 0 if not retrying>
 *   }
 *
 * Phases pi-monitor cares about
 * -----------------------------
 *   idle               → AgentState.IDLE
 *   agent_running      → AgentState.WORKING
 *   tool_running       → AgentState.WORKING       (current_tool set)
 *   compacting         → AgentState.WORKING       (sub-label "compacting")
 *   retrying           → AgentState.RETRYING      (no notification)
 *   awaiting_permission→ AgentState.WAITING       (needs-attention)
 *
 * `awaiting_permission` is reserved for permission-gating extensions. This
 * extension can't observe `ctx.ui.confirm` from another extension, so it
 * never publishes that phase itself — the schema slot is here so future
 * extensions can write the heartbeat directly using a small helper without
 * depending on pi-monitor.
 *
 * Retry detection
 * ---------------
 * pi's `auto_retry_start` / `auto_retry_end` events are NOT exposed to
 * extensions (verified against `dist/core/extensions/types.d.ts`'s `on()`
 * overloads). We detect auto-retry by inspecting `agent_end.messages`: if
 * the trailing assistant has `stopReason: "error"` AND its `errorMessage`
 * matches pi's retryable regex, pi will sleep + retry next, so we set
 * `phase: "retrying"`. The next `agent_start` while in `retrying` keeps
 * the phase; the next `agent_end` whose trailing assistant is not a
 * retryable error exits the retry phase.
 *
 * Keep the retry regex in sync with pi-coding-agent's `_isRetryableError`
 * (`dist/core/agent-session.js`).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_DIR = join(homedir(), ".pi", "agent", ".heartbeats");
const HEARTBEAT_PATH = join(HEARTBEAT_DIR, `${process.pid}.json`);

const SCHEMA_VERSION = 1;

/**
 * Mirror of pi-coding-agent's `_isRetryableError` regex
 * (`dist/core/agent-session.js`). Keep in sync; if pi adds new patterns,
 * we'll match a subset until updated (worst case: a real new transient
 * temporarily reports as ERROR/`stop`-with-error in pi-monitor's fallback
 * path until this regex is refreshed).
 */
const RETRYABLE_ERROR_RE =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Phase =
	| "idle"
	| "agent_running"
	| "tool_running"
	| "retrying"
	| "compacting"
	| "awaiting_permission";

let phase: Phase = "idle";
let priorPhase: Phase | null = null;
let activeTools = 0;
let currentTool: string | null = null;
let retryAttempt = 0;

// Cached `getSessionFile()` result. We refresh it on session-level events;
// it's not a hot path so we don't bother memoizing per-write.
let sessionFile: string | null = null;

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function ensureDir(): void {
	try {
		mkdirSync(HEARTBEAT_DIR, { recursive: true });
	} catch {
		// best-effort; if we can't create the dir we just skip writes
	}
}

function write(): void {
	const payload = {
		version: SCHEMA_VERSION,
		pid: process.pid,
		session_file: sessionFile,
		ts: Date.now() / 1000,
		phase,
		current_tool: currentTool,
		retry_attempt: retryAttempt,
	};
	try {
		writeFileSync(HEARTBEAT_PATH, `${JSON.stringify(payload)}\n`);
	} catch {
		// Heartbeat is advisory; never crash pi over a write failure.
	}
}

function deleteHeartbeat(): void {
	try {
		rmSync(HEARTBEAT_PATH, { force: true });
	} catch {
		// Same: best-effort cleanup. A leftover stale heartbeat is harmless;
		// pi-monitor's freshness threshold + pid-existence check filters it.
	}
}

function isRetryableErrorMessage(msg: string | undefined): boolean {
	if (!msg) return false;
	return RETRYABLE_ERROR_RE.test(msg);
}

function lastAssistant(
	messages: readonly { role?: string }[],
): { stopReason?: string; errorMessage?: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string };
		if (m && m.role === "assistant") {
			return m as { stopReason?: string; errorMessage?: string };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	ensureDir();

	pi.on("session_start", async (_event, ctx) => {
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		phase = "idle";
		priorPhase = null;
		activeTools = 0;
		currentTool = null;
		retryAttempt = 0;
		write();
	});

	pi.on("agent_start", async (_event, ctx) => {
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		// During pi's auto-retry loop the same agent_start fires for the
		// retry attempt. Don't reset retry_attempt here; agent_end is the
		// authoritative point that decides "retrying" vs "done".
		if (phase !== "retrying") {
			phase = "agent_running";
			priorPhase = null;
			activeTools = 0;
			currentTool = null;
			retryAttempt = 0;
		}
		write();
	});

	pi.on("agent_end", async (event, ctx) => {
		sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		const last = lastAssistant(event.messages as { role?: string }[]);
		if (
			last &&
			last.stopReason === "error" &&
			isRetryableErrorMessage(last.errorMessage)
		) {
			// Pi will sleep + retry next. Mark as retrying so pi-monitor
			// shows RETRYING (no notification) instead of ERROR.
			if (phase !== "retrying") {
				priorPhase = phase;
			}
			phase = "retrying";
			retryAttempt += 1;
		} else {
			phase = "idle";
			priorPhase = null;
			activeTools = 0;
			currentTool = null;
			retryAttempt = 0;
		}
		write();
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		activeTools += 1;
		currentTool = event.toolName;
		// `tool_running` nests inside `agent_running`. Don't overwrite
		// `compacting` or `retrying` if a tool somehow fires inside those.
		if (phase === "agent_running") {
			priorPhase = phase;
			phase = "tool_running";
		}
		write();
	});

	pi.on("tool_execution_end", async (_event, _ctx) => {
		activeTools = Math.max(0, activeTools - 1);
		if (activeTools === 0) {
			currentTool = null;
			if (phase === "tool_running") {
				phase = priorPhase ?? "agent_running";
				priorPhase = null;
			}
		}
		write();
	});

	pi.on("session_before_compact", async (_event, _ctx) => {
		if (phase !== "compacting") {
			priorPhase = phase;
		}
		phase = "compacting";
		write();
	});

	pi.on("session_compact", async (_event, _ctx) => {
		if (phase === "compacting") {
			phase = priorPhase ?? "idle";
			priorPhase = null;
		}
		write();
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		deleteHeartbeat();
	});
}
