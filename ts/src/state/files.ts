/**
 * Per-cwd JSONL discovery + the filename-timestamp claim helper.
 *
 * Direct port of `cwd_to_session_dir`, `_filename_starttime`,
 * `_list_jsonl_with_mtime`, `_claim_session_file`, and
 * `find_session_file_for_cwd` from `src/pi_monitor/state.py`.
 *
 * The "claim" algorithm is the heart of the resolver: it disambiguates
 * which JSONL belongs to which pi process when multiple pis share a
 * cwd. See the long-form rationale at the top of `state.py` in the
 * Python build for the full reasoning; the comments here are the
 * short version.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pi's session directory layout:
 *   ~/.pi/agent/sessions/<cwd-encoded>/<timestamp>_<uuid>.jsonl
 *
 * Where `<cwd-encoded>` strips the leading slash and replaces every
 * `/` with `-`, then surrounds the result in `--...--`.
 */
export const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

/**
 * Translate a pane's cwd to the directory pi writes its session
 * JSONL files into. Mirrors `cwd_to_session_dir` in the Python build.
 *
 * Tests pass `sessionsRoot` to point at a tmp directory.
 */
export function cwdToSessionDir(
  cwd: string,
  sessionsRoot: string = SESSIONS_ROOT,
): string {
  const stripped = cwd.replace(/^\/+/, "");
  const encoded = stripped.replace(/\//g, "-");
  return join(sessionsRoot, `--${encoded}--`);
}

/**
 * Session filenames pi writes look like:
 *   `2026-05-03T20-37-34-005Z_019def8f-86b5-77ac-96f5-302472f17757.jsonl`
 * The timestamp portion is ISO-8601 with `:` and `.` replaced by `-`
 * (filename-safe). We anchor at the start and stop at the `_<uuid>`
 * separator. Mirrors `_FILENAME_TS_RE` in the Python build.
 */
const FILENAME_TS_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;

/**
 * Slack we allow when comparing a filename timestamp to a pi
 * process's start time. Pi calls `Date.now()` a few ticks after the
 * kernel created the process, so filename_ts > pi.start in practice;
 * the epsilon just guards against `procStartTime`'s ms-rounding and
 * any latent clock skew. Mirrors `_FILENAME_TS_EPSILON_S`.
 */
export const FILENAME_TS_EPSILON_S = 1.0;

/**
 * Parse the ISO timestamp pi embeds in a session filename, returning
 * a unix-seconds timestamp. Returns `null` for filenames that don't
 * match the expected pattern (e.g. test fixtures with arbitrary
 * names) so callers can fall back to mtime-based heuristics.
 *
 * Accepts a full path or a basename; only the basename matters.
 */
export function parseFilenameStartTime(filenameOrPath: string): number | null {
  const base = filenameOrPath.replace(/^.*\//, "");
  const match = FILENAME_TS_RE.exec(base);
  if (match === null) return null;
  const [, date, h, m, s, ms] = match;
  const iso = `${date}T${h}:${m}:${s}.${ms}Z`;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return parsed / 1000;
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
 * Pick the JSONL belonging to a single pi process in `cwd`.
 *
 * Selection order, highest priority first:
 *
 *   1. **Owned**: filename timestamp \u2208 [piStart - eps, nextPiStart - eps)
 *      \u2014 a file pi created during its lifetime, before any younger
 *      sibling pi in the same cwd was born. `nextPiStart=null` means
 *      "no younger pi" \u2192 unbounded above. Pick max by mtime so an
 *      active /new'd file beats its abandoned predecessor.
 *
 *   2. **Resumed**: filename timestamp predates pi (so it's not pi's
 *      own creation) AND mtime >= piStart (pi has actually written
 *      to it, which is what `--session` does). Pick max by mtime.
 *
 *   3. **No-info fallback** (only when piStart is null): max-by-mtime
 *      unclaimed file in the cwd. Used by `findSessionFileForCwd`
 *      and by panes whose pid lookup failed.
 *
 * Returns `null` (not a guess) when we know pi's start time but no
 * file matches \u2014 e.g. a freshly-launched idle pi that hasn't
 * written yet. This is the fix for the cohabitation swap bug: the
 * previous version's "most recent file in cwd" fallback silently
 * re-bound the new pi to another pi's actively-written session.
 *
 * Mirrors `_claim_session_file` in the Python build.
 */
export function claimSessionFile(args: {
  cwd: string;
  piStart: number | null;
  nextPiStart: number | null;
  claimed: Set<string>;
  sessionsRoot?: string;
}): string | null {
  const { cwd, piStart, nextPiStart, claimed, sessionsRoot } = args;
  const dir = cwdToSessionDir(cwd, sessionsRoot ?? SESSIONS_ROOT);
  const candidates = listJsonlWithMtime(dir).filter(([p]) => !claimed.has(p));
  if (candidates.length === 0) return null;

  if (piStart === null) {
    // No-info fallback: greedy max-by-mtime.
    return maxByMtime(candidates);
  }

  const eps = FILENAME_TS_EPSILON_S;
  const upper = nextPiStart !== null ? nextPiStart - eps : Number.POSITIVE_INFINITY;
  const lower = piStart - eps;

  const owned: Array<[string, number]> = [];
  const olderFilename: Array<[string, number]> = [];
  for (const entry of candidates) {
    const [p] = entry;
    const fts = parseFilenameStartTime(p);
    if (fts !== null && fts >= lower && fts < upper) {
      owned.push(entry);
    } else if (fts === null || fts < lower) {
      // Either a non-standard name (test fixtures) or a file created
      // before pi was born. Eligible for the resumed-session path,
      // which additionally requires mtime >= piStart.
      olderFilename.push(entry);
    }
  }
  if (owned.length > 0) return maxByMtime(owned);

  const resumed = olderFilename.filter(([, m]) => m >= piStart);
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
): string | null {
  return claimSessionFile({
    cwd,
    piStart: null,
    nextPiStart: null,
    claimed: new Set(),
    sessionsRoot,
  });
}
