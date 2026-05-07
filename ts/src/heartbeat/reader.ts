/**
 * Heartbeat reader.
 *
 * Direct port of `read_heartbeat` and friends from
 * `src/pi_monitor/heartbeat.py`. Reads the small JSON file the
 * `pi-monitor-heartbeat` pi extension writes per-process and returns a
 * `Heartbeat` record \u2014 or `null` when the file is missing, malformed,
 * or stale.
 *
 * Why we trust the payload `ts` over file mtime: the extension stamps
 * `ts` at the moment pi observes the event; the OS-recorded mtime
 * lags by however long the write takes. They're almost always within
 * a millisecond, but the payload value is more semantically accurate.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * How long after the heartbeat's stamped `ts` we still trust it. The
 * extension writes on every relevant lifecycle event; during a long
 * bash run there *are* no events, so this window must be generous.
 * Five seconds is enough to ride out tiny event-loop hitches without
 * preserving a heartbeat from a pi that crashed mid-tool. Mirrors
 * `HEARTBEAT_FRESHNESS_S` in the Python build.
 */
export const HEARTBEAT_FRESHNESS_S = 5.0;

/**
 * Phase values the extension is known to publish. We accept others
 * (the extension's schema may grow); unknown phases are surfaced
 * as-is and treated by the caller as a no-info signal (fall through
 * to JSONL).
 */
export const VALID_PHASES = new Set<string>([
  "idle",
  "agent_running",
  "tool_running",
  "retrying",
  "compacting",
  "awaiting_permission",
]);

/**
 * Parsed heartbeat payload. Mirrors v1 of the schema documented in
 * the extension's source. Unknown payload fields are dropped silently.
 */
export interface Heartbeat {
  pid: number;
  /** Absolute path the agent reports as its current session file. */
  sessionFile: string | null;
  /** Unix seconds (extension writes Date.now() / 1000). */
  ts: number;
  /** See VALID_PHASES; unknown strings are surfaced as-is. */
  phase: string;
  currentTool: string | null;
  retryAttempt: number;
}

/**
 * Default location of the heartbeat directory. Mirrors
 * `HEARTBEATS_DIR` in the Python build. Override via the `paths`
 * argument to `readHeartbeat` for tests; production callers should
 * leave it alone.
 */
export const HEARTBEATS_DIR = join(homedir(), ".pi", "agent", ".heartbeats");

/**
 * Path to the per-pid heartbeat file. Exposed for symmetry with the
 * Python helper of the same name.
 */
export function heartbeatPathForPid(
  pid: number,
  baseDir: string = HEARTBEATS_DIR,
): string {
  return join(baseDir, `${pid}.json`);
}

/**
 * Read-and-parse the heartbeat for `pid`, returning `null` on any
 * failure mode the resolver should treat as "no heartbeat" (missing
 * file, permission denied, malformed JSON, schema rejection, stale
 * payload).
 *
 * `nowSeconds` overrides the wall-clock for deterministic tests.
 * `paths.dir` overrides the heartbeat directory location, which is
 * how unit tests point the reader at a tmp dir without touching the
 * real `~/.pi/agent/.heartbeats/` tree.
 */
export function readHeartbeat(
  pid: number,
  options: { nowSeconds?: number; baseDir?: string } = {},
): Heartbeat | null {
  const baseDir = options.baseDir ?? HEARTBEATS_DIR;
  const path = heartbeatPathForPid(pid, baseDir);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // ENOENT / EACCES / EISDIR \u2014 same handling as the Python
    // FileNotFoundError / PermissionError branch.
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const obj = data as Record<string, unknown>;

  // Required fields. Tolerate version mismatches by ignoring unknown
  // fields; reject only when essentials are missing or the wrong
  // type.
  const ts = Number(obj.ts);
  if (!Number.isFinite(ts)) return null;
  if (typeof obj.phase !== "string") return null;
  const phase = obj.phase;

  const pidInPayload = obj.pid === undefined ? pid : Number(obj.pid);
  if (!Number.isInteger(pidInPayload)) return null;
  if (pidInPayload !== pid) {
    // Heartbeat path is keyed by pid, so a mismatch means corruption.
    return null;
  }

  const now = options.nowSeconds ?? Date.now() / 1000;
  if (now - ts > HEARTBEAT_FRESHNESS_S) return null;

  const sessionFileRaw = obj.session_file;
  const sessionFile =
    typeof sessionFileRaw === "string" && sessionFileRaw.length > 0
      ? sessionFileRaw
      : null;

  const currentToolRaw = obj.current_tool;
  const currentTool = typeof currentToolRaw === "string" ? currentToolRaw : null;

  let retryAttempt = 0;
  if (obj.retry_attempt !== undefined && obj.retry_attempt !== null) {
    const n = Number(obj.retry_attempt);
    retryAttempt = Number.isInteger(n) && n >= 0 ? n : 0;
  }

  return {
    pid,
    sessionFile,
    ts,
    phase,
    currentTool,
    retryAttempt,
  };
}
