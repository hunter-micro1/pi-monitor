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
import { findPiPidForPane, procCwds, procStartTime } from "../proc/index.js";
import { claimSessionFile } from "./files.js";
import { STARTING_GRACE_S, inferState } from "./infer.js";
import { JsonlReader } from "./reader.js";
import type { AgentState, PaneStatus } from "./types.js";

/**
 * Minimal info `StateResolver.resolve` needs about a pane.
 * Decoupled from the (future) tmux client so the resolver has no
 * tmux dependency. Mirrors `PaneRef` in the Python build.
 */
export interface PaneRef {
  paneId: string;
  cwd: string;
  isPi: boolean;
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
}

export class StateResolver {
  private reader: JsonlReader;
  private heartbeatBaseDir: string | undefined;
  private sessionsRoot: string | undefined;

  constructor(options: ResolverOptions = {}) {
    this.reader = new JsonlReader();
    this.heartbeatBaseDir = options.heartbeatBaseDir;
    this.sessionsRoot = options.sessionsRoot;
  }

  /**
   * Resolve state for every pane in one pass.
   *
   * Pis are grouped by cwd (different cwds use different session
   * directories so they never compete) and processed start-time-ASC
   * within each group. The ASC order means each pi knows the next-
   * younger sibling's start time, which bounds its filename
   * ownership window above. This prevents a freshly-launched pi
   * from stealing an older pi's actively-written file.
   *
   * Two panes can never bind to the same JSONL.
   */
  resolve(refs: PaneRef[], nowSeconds?: number): Map<string, PaneStatus> {
    const now = nowSeconds ?? Date.now() / 1000;

    // Walk process trees once; cache (refId -> piPid / start /
    // effectiveCwd).
    //
    // effectiveCwd is the pi DESCENDANT's actual cwd, not the
    // tmux pane_current_path. The auto-worktree extension re-execs
    // pi inside an `agent/<base>-<ts>` worktree distinct from the
    // pane's shell cwd; pi writes its session JSONL keyed off ITS
    // cwd, so JSONL discovery has to use the same. Falls back to
    // ref.cwd when /proc is unreadable, the pi descendant has
    // gone away, or the platform-specific procCwd lookup failed.
    //
    // Pass 1: resolve the deepest pi pid per pane. Cheap — backed
    // by the cached `ps -A` / /proc snapshot.
    const pids = new Map<string, number | null>();
    const piPidList: number[] = [];
    for (const ref of refs) {
      if (!ref.isPi) continue;
      const piPid = findPiPidForPane(ref.panePid);
      pids.set(ref.paneId, piPid);
      if (piPid !== null) piPidList.push(piPid);
    }
    // Pass 2: bulk-fetch cwds for every live pi pid in ONE
    // subprocess. On macOS this is `lsof -p p1,p2,...` instead of
    // N separate lsof spawns — the dominant tick-time win once
    // you have ~5+ panes. On Linux it's a loop of cheap readlinks.
    const cwdByPid = procCwds(piPidList);
    // Pass 3: per-ref start time + effectiveCwd.
    const starts = new Map<string, number | null>();
    const effectiveCwds = new Map<string, string>();
    for (const ref of refs) {
      if (!ref.isPi) continue;
      const piPid = pids.get(ref.paneId) ?? null;
      starts.set(ref.paneId, piPid !== null ? procStartTime(piPid) : null);
      const piCwd = piPid !== null ? (cwdByPid.get(piPid) ?? null) : null;
      effectiveCwds.set(ref.paneId, piCwd ?? ref.cwd);
    }

    // Group pi panes by EFFECTIVE cwd (pi's actual cwd; see above).
    // Within each group sort by start time ASC (null first; those
    // panes have no lifetime info and use the plain mtime-DESC
    // fallback, which is order-independent).
    const groups = new Map<string, PaneRef[]>();
    for (const ref of refs) {
      if (!ref.isPi) continue;
      const key = effectiveCwds.get(ref.paneId) ?? ref.cwd;
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
        const piPid = pids.get(ref.paneId);

        // Heartbeat fast path: trust the extension's state, but
        // still read the JSONL when the heartbeat advertises a
        // session_file so PaneDetails can show Prompt + Tokens
        // (those come from the snapshot, not the heartbeat). The
        // JsonlReader is incrementally cached and the typical
        // delta is tiny, so the cost is bounded.
        if (piPid !== undefined && piPid !== null) {
          const hbState = this.stateFromHeartbeat(piPid, now);
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

        // No heartbeat: claim a session file via the filename-
        // timestamp resolver, run inferState on the snapshot.
        const piStart = starts.get(ref.paneId) ?? null;
        const next = list[i + 1];
        const nextPiStart =
          next !== undefined ? (starts.get(next.paneId) ?? null) : null;

        const sessionFile = claimSessionFile({
          cwd: effectiveCwds.get(ref.paneId) ?? ref.cwd,
          piStart,
          nextPiStart,
          claimed,
          sessionsRoot: this.sessionsRoot,
        });

        if (sessionFile === null) {
          // Live pi with no flushed JSONL yet: most likely a fresh
          // launch streaming its first response. Show WORKING during
          // the grace window so users don't see "?" on every new
          // pi. After the window we fall back to UNKNOWN \u2014 never
          // IDLE, which would notify.
          if (piStart !== null && now - piStart < STARTING_GRACE_S) {
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

    // Anything not in `results` is a non-pi pane (or a pane whose
    // is_pi flag was false); mark them NO_PI so the UI can show
    // them dim instead of dropping them entirely.
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
