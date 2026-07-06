/**
 * StateResolver.
 *
 * Direct port of the `StateResolver` class + `_state_from_heartbeat`
 * + `_PHASE_TO_STATE` from `src/pi_monitor/state.py`.
 *
 * Produces a `PaneStatus` for every `PaneRef` the caller hands in,
 * with a shared `claimed` set so two panes can never bind to the
 * same JSONL file. The heartbeat fast-path skips JSONL inference
 * entirely when the `pi-monitor-heartbeat` extension is publishing
 * a fresh status; otherwise the resolver claims a session file via
 * `claimSessionFile` and runs `inferState` on the snapshot.
 */

import { readHeartbeat } from "../heartbeat/reader.js";
import { findAgentProcessForPane, procCwds, procStartTime } from "../proc/index.js";
import { claimClaudeSessionFile, claimSessionFile } from "./files.js";
import { STARTING_GRACE_S, inferState } from "./infer.js";
import { JsonlReader } from "./reader.js";
import type { AgentKind, AgentState, PaneStatus } from "./types.js";

/**
 * Minimal info `StateResolver.resolve` needs about a pane.
 * Decoupled from the (future) tmux client so the resolver has no
 * tmux dependency. Mirrors `PaneRef` in the Python build.
 */
export interface PaneRef {
  paneId: string;
  cwd: string;
  /** Supported agent runtime in this pane, or null for ordinary shell panes. */
  agentKind?: AgentKind | null;
  /** Back-compat for older tests/callers; prefer agentKind. */
  isPi?: boolean;
  /** The tmux pane's pid (typically a shell). */
  panePid: number;
}

/**
 * Heartbeat phase -> AgentState. Phases not in this table fall
 * through to JSONL inference. Mirrors `_PHASE_TO_STATE`.
 */
const PHASE_TO_STATE: Record<string, AgentState> = {
  idle: "idle",
  agent_running: "working",
  tool_running: "working",
  compacting: "working",
  retrying: "retrying",
  awaiting_permission: "waiting",
};

/**
 * Tools whose execution actively blocks on the user (the agent is
 * stalled until the user clicks/types something). The heartbeat
 * extension reports these as `phase: tool_running` because, strictly
 * speaking, the tool IS running — but from the human-attention point
 * of view they are indistinguishable from `awaiting_permission`:
 * the agent has stopped making progress until you act.
 *
 * When `tool_running` is paired with one of these names, the resolver
 * overrides the default `working` mapping to `waiting`, surfacing the
 * pane as needs-attention in the UI and notifications.
 *
 * Keep this list small and obvious. Adding speculative entries here
 * causes false-positive notifications.
 */
export const BLOCKING_USER_TOOLS: ReadonlySet<string> = new Set(["ask_user_question"]);

interface ResolverOptions {
  /**
   * Override the heartbeat directory (default `~/.pi/agent/.heartbeats`).
   * Tests pass a tmp dir; production callers leave it alone.
   */
  heartbeatBaseDir?: string;
  /**
   * Override the sessions root (default `~/.pi/agent/sessions`).
   * Tests pass a tmp dir; production callers leave it alone.
   */
  sessionsRoot?: string;
  /**
   * Override Claude Code's projects root (default `~/.claude/projects`).
   * Tests pass a tmp dir; production callers leave it alone.
   */
  claudeProjectsRoot?: string;
}

export class StateResolver {
  private reader: JsonlReader;
  private heartbeatBaseDir: string | undefined;
  private sessionsRoot: string | undefined;
  private claudeProjectsRoot: string | undefined;

  constructor(options: ResolverOptions = {}) {
    this.reader = new JsonlReader();
    this.heartbeatBaseDir = options.heartbeatBaseDir;
    this.sessionsRoot = options.sessionsRoot;
    this.claudeProjectsRoot = options.claudeProjectsRoot;
  }

  /**
   * Resolve state for every pane in one pass.
   *
   * Agent panes are grouped by provider + cwd so pi and Claude Code
   * never compete for JSONL files. Pi keeps its existing timestamp-
   * bounded claim logic and heartbeat fast path. Claude uses its
   * project directory under ~/.claude/projects and JSONL inference only.
   *
   * Two panes can never bind to the same JSONL in one resolver tick.
   */
  resolve(refs: PaneRef[], nowSeconds?: number): Map<string, PaneStatus> {
    const now = nowSeconds ?? Date.now() / 1000;

    const kinds = new Map<string, AgentKind | null>();
    const pids = new Map<string, number | null>();
    const agentPidList: number[] = [];

    for (const ref of refs) {
      const kind = ref.agentKind ?? (ref.isPi === true ? "pi" : null);
      kinds.set(ref.paneId, kind);
      if (kind === null) continue;
      const found = findAgentProcessForPane(ref.panePid);
      const pid = found?.kind === kind ? found.pid : null;
      pids.set(ref.paneId, pid);
      if (pid !== null) agentPidList.push(pid);
    }

    const cwdByPid = procCwds(agentPidList);
    const starts = new Map<string, number | null>();
    const effectiveCwds = new Map<string, string>();
    for (const ref of refs) {
      const kind = kinds.get(ref.paneId) ?? null;
      if (kind === null) continue;
      const agentPid = pids.get(ref.paneId) ?? null;
      starts.set(ref.paneId, agentPid !== null ? procStartTime(agentPid) : null);
      const agentCwd = agentPid !== null ? (cwdByPid.get(agentPid) ?? null) : null;
      effectiveCwds.set(ref.paneId, agentCwd ?? ref.cwd);
    }

    const groups = new Map<string, PaneRef[]>();
    for (const ref of refs) {
      const kind = kinds.get(ref.paneId) ?? null;
      if (kind === null) continue;
      const cwd = effectiveCwds.get(ref.paneId) ?? ref.cwd;
      const key = JSON.stringify([kind, cwd]);
      let list = groups.get(key);
      if (list === undefined) {
        list = [];
        groups.set(key, list);
      }
      list.push(ref);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => {
        const sa = starts.get(a.paneId) ?? Number.NEGATIVE_INFINITY;
        const sb = starts.get(b.paneId) ?? Number.NEGATIVE_INFINITY;
        return sa - sb;
      });
    }

    const claimed = new Set<string>();
    const results = new Map<string, PaneStatus>();

    for (const list of groups.values()) {
      for (let i = 0; i < list.length; i++) {
        const ref = list[i] as PaneRef;
        const kind = kinds.get(ref.paneId) ?? null;
        if (kind === null) continue;
        const agentPid = pids.get(ref.paneId) ?? null;
        const agentStart = starts.get(ref.paneId) ?? null;

        // Heartbeat fast path is pi-specific. Claude Code has no
        // heartbeat integration in this implementation and falls
        // through to JSONL inference.
        if (kind === "pi" && agentPid !== null) {
          const hbState = this.stateFromHeartbeat(agentPid, now);
          if (hbState !== null) {
            const { state, heartbeat } = hbState;
            let snapshot = null;
            let idleSeconds = 0.0;
            if (heartbeat.sessionFile !== null) {
              claimed.add(heartbeat.sessionFile);
              snapshot = this.reader.read(heartbeat.sessionFile);
              if (snapshot !== null) {
                idleSeconds = Math.max(0.0, now - snapshot.mtime);
              }
            }
            results.set(ref.paneId, {
              paneId: ref.paneId,
              state,
              sessionFile: heartbeat.sessionFile,
              snapshot,
              idleSeconds,
              phase: heartbeat.phase,
              currentTool: heartbeat.currentTool,
              retryAttempt: heartbeat.retryAttempt,
            });
            continue;
          }
        }

        const next = list[i + 1];
        const nextStart = next !== undefined ? (starts.get(next.paneId) ?? null) : null;
        const cwd = effectiveCwds.get(ref.paneId) ?? ref.cwd;
        const sessionFile =
          kind === "pi"
            ? claimSessionFile({
                cwd,
                piStart: agentStart,
                nextPiStart: nextStart,
                claimed,
                sessionsRoot: this.sessionsRoot,
              })
            : claimClaudeSessionFile({
                cwd,
                agentStart,
                nextAgentStart: nextStart,
                claimed,
                projectsRoot: this.claudeProjectsRoot,
              });

        if (sessionFile === null) {
          // Fresh agents can be streaming before their first JSONL
          // flush. Show WORKING during the grace window, then UNKNOWN.
          if (agentStart !== null && now - agentStart < STARTING_GRACE_S) {
            results.set(ref.paneId, this.bareStatus(ref.paneId, "working"));
          } else {
            results.set(ref.paneId, this.bareStatus(ref.paneId, "unknown"));
          }
          continue;
        }
        claimed.add(sessionFile);
        const snapshot = this.reader.read(sessionFile);
        const { state, idleSeconds } = inferState(snapshot, now);
        results.set(ref.paneId, {
          paneId: ref.paneId,
          state,
          sessionFile,
          snapshot,
          idleSeconds,
          phase: null,
          currentTool: null,
          retryAttempt: 0,
        });
      }
    }

    // Anything not in `results` is a non-agent pane; mark it NO_PI so
    // the UI can show it dim instead of dropping it entirely.
    for (const ref of refs) {
      if (!results.has(ref.paneId)) {
        results.set(ref.paneId, this.bareStatus(ref.paneId, "no_pi"));
      }
    }
    return results;
  }

  /**
   * Read the heartbeat for `pid` and map it to a state. Returns
   * the state plus the full Heartbeat record so the resolver can
   * plumb phase / currentTool / retryAttempt into PaneStatus.
   * `null` when no fresh heartbeat or the phase is unrecognized.
   */
  private stateFromHeartbeat(
    pid: number,
    nowSeconds: number,
  ): {
    state: AgentState;
    heartbeat: NonNullable<ReturnType<typeof readHeartbeat>>;
  } | null {
    const hb = readHeartbeat(pid, {
      nowSeconds,
      baseDir: this.heartbeatBaseDir,
    });
    if (hb === null) return null;
    let state = PHASE_TO_STATE[hb.phase];
    if (state === undefined) return null;
    // Tool-running phases default to `working`, but a handful of
    // tools (ask_user_question, ...) block on user input. Treat
    // those as `waiting` so the UI flags them as needs-attention.
    if (
      state === "working" &&
      hb.phase === "tool_running" &&
      hb.currentTool !== null &&
      BLOCKING_USER_TOOLS.has(hb.currentTool)
    ) {
      state = "waiting";
    }
    return { state, heartbeat: hb };
  }

  private bareStatus(paneId: string, state: AgentState): PaneStatus {
    return {
      paneId,
      state,
      sessionFile: null,
      snapshot: null,
      idleSeconds: 0.0,
      phase: null,
      currentTool: null,
      retryAttempt: 0,
    };
  }
}
