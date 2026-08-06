/**
 * Session-file discovery + the claim algorithm.
 *
 * Originally a direct port of `cwd_to_session_dir`,
 * `_filename_starttime`, `_list_jsonl_with_mtime`,
 * `_claim_session_file` and `find_session_file_for_cwd` from
 * `src/pi_monitor/state.py`.
 *
 * The claim algorithm is the heart of the resolver: it disambiguates
 * which JSONL belongs to which agent process when several share a
 * cwd. It is harness-agnostic — the only harness-specific inputs are
 * *where* session files live and *when* a given file's session
 * started, both of which come from the adapter.
 *
 * `cwdToSessionDir` / `parseFilenameStartTime` remain exported
 * (delegating to the pi adapter) because the ported test corpus and
 * single-pane helpers still call them by name.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Harness, piHarness } from "../harness/index.js";

/** pi's sessions root. Kept as a named export for existing callers. */
export const SESSIONS_ROOT = piHarness.defaultSessionsRoot();

/**
 * Slack allowed when comparing a session start time to an agent
 * process's start time. An agent stamps its session a few ticks
 * after the kernel created the process, so session_ts > proc.start in
 * practice; the epsilon guards against `procStartTime`'s ms-rounding
 * and any latent clock skew. Mirrors `_FILENAME_TS_EPSILON_S`.
 */
export const FILENAME_TS_EPSILON_S = 1.0;

/** Translate a cwd to pi's session directory. */
export function cwdToSessionDir(
  cwd: string,
  sessionsRoot: string = SESSIONS_ROOT,
): string {
  return piHarness.sessionDir(cwd, sessionsRoot);
}

/** Parse the ISO timestamp pi embeds in a session filename. */
export function parseFilenameStartTime(filenameOrPath: string): number | null {
  return piHarness.sessionStartTime(filenameOrPath);
}

/**
 * List `*.jsonl` files in `directory` with their mtime in unix
 * seconds, or an empty list when the directory doesn't exist.
 * Mirrors `_list_jsonl_with_mtime`.
 */
export function listJsonlWithMtime(directory: string): Array<[string, number]> {
  if (!existsSync(directory)) return [];
  const entries: Array<[string, number]> = [];
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(directory, name);
    try {
      const st = statSync(full);
      // st.mtimeMs is ms since epoch; downstream wants seconds.
      entries.push([full, st.mtimeMs / 1000]);
    } catch {}
  }
  return entries;
}

/**
 * Pick the JSONL belonging to a single agent process in `cwd`.
 *
 * Selection order, highest priority first:
 *
 *   1. **Owned**: session start ∈ [agentStart - eps, nextAgentStart -
 *      eps) — a file the agent created during its lifetime, before
 *      any younger sibling in the same cwd was born.
 *      `nextAgentStart=null` means "no younger sibling" → unbounded
 *      above. Pick max by mtime so an active /new'd file beats its
 *      abandoned predecessor.
 *
 *   2. **Resumed**: session start predates the agent (so it's not the
 *      agent's own creation) AND mtime >= agentStart (the agent has
 *      actually written to it, which is what `--session` /
 *      `--resume` does). Pick max by mtime.
 *
 *   3. **No-info fallback** (only when agentStart is null): max-by-
 *      mtime unclaimed file in the cwd.
 *
 * Returns `null` (not a guess) when we know the agent's start time
 * but no file matches — e.g. a freshly-launched agent that hasn't
 * written yet. This is the fix for the cohabitation swap bug: a
 * "most recent file in cwd" fallback would silently re-bind the new
 * agent to another agent's actively-written session.
 *
 * Mirrors `_claim_session_file` in the Python build.
 */
export function claimSessionFile(args: {
  cwd: string;
  agentStart: number | null;
  nextAgentStart: number | null;
  claimed: Set<string>;
  sessionsRoot?: string;
  harness?: Harness;
}): string | null {
  const { cwd, agentStart, nextAgentStart, claimed } = args;
  const harness = args.harness ?? piHarness;
  const root = args.sessionsRoot ?? harness.defaultSessionsRoot();
  const dir = harness.sessionDir(cwd, root);
  const candidates = listJsonlWithMtime(dir).filter(([p]) => !claimed.has(p));
  if (candidates.length === 0) return null;

  if (agentStart === null) {
    // No-info fallback: greedy max-by-mtime.
    return maxByMtime(candidates);
  }

  const eps = FILENAME_TS_EPSILON_S;
  const upper =
    nextAgentStart !== null ? nextAgentStart - eps : Number.POSITIVE_INFINITY;
  const lower = agentStart - eps;

  const owned: Array<[string, number]> = [];
  const olderSession: Array<[string, number]> = [];
  for (const entry of candidates) {
    const [p] = entry;
    const sts = harness.sessionStartTime(p);
    if (sts !== null && sts >= lower && sts < upper) {
      owned.push(entry);
    } else if (sts === null || sts < lower) {
      // Either an undatable session (test fixtures, unreadable head)
      // or one started before this agent was born. Eligible for the
      // resumed-session path, which additionally requires
      // mtime >= agentStart.
      olderSession.push(entry);
    }
  }
  if (owned.length > 0) return maxByMtime(owned);

  const resumed = olderSession.filter(([, m]) => m >= agentStart);
  if (resumed.length > 0) return maxByMtime(resumed);

  return null;
}

function maxByMtime(entries: Array<[string, number]>): string {
  let best = entries[0] as [string, number];
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i] as [string, number];
    if (e[1] > best[1]) best = e;
  }
  return best[0];
}

/**
 * Convenience for single-pane callers / tests: most recently
 * modified jsonl in the cwd's session directory, ignoring claim
 * resolution. Mirrors `find_session_file_for_cwd`.
 */
export function findSessionFileForCwd(
  cwd: string,
  sessionsRoot: string = SESSIONS_ROOT,
  harness: Harness = piHarness,
): string | null {
  return claimSessionFile({
    cwd,
    agentStart: null,
    nextAgentStart: null,
    claimed: new Set(),
    sessionsRoot,
    harness,
  });
}
