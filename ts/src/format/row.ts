/**
 * Pure-function row formatting helpers.
 *
 * Direct port of `_truncate`, `fmt_idle`, `_working_verb`,
 * `_activity_tag`, `_activity_description`, `fmt_row_main`, and
 * `fmt_session_header` from `src/pi_monitor/tui.py`.
 *
 * Key shape difference from the Python build: these helpers return
 * **structured data**, not embedded Rich markup. The Python build
 * embeds color codes inline (e.g. `"[#4EBF71]running bash[/#4EBF71]"`)
 * because Textual renders Rich markup directly. The TS build is
 * heading toward Ink/JSX rendering in phase 4, where the renderer
 * consumes structured data and applies colors via `<Text color="...">`
 * props. Returning structures here keeps that boundary clean and
 * makes the unit tests assert on intent ("verb is `running bash`,
 * color is the working color") rather than markup details.
 */

import type { AgentState, PaneStatus } from "../state/types.js";

/**
 * Theme-derived color table the Python build mutates on every theme
 * cycle (`STATE_COLORS` in tui.py). For phase 1 we ship a static
 * fallback matching Python's pre-theme-refresh defaults; phase 4 will
 * switch this to a reactive table driven by the live Ink/JSX theme
 * once we pick a Textual-equivalent.
 *
 * Hex strings (no `#`-stripping) so they pass straight through to
 * Ink's `<Text color>` prop, which accepts hex or named colors.
 */
export const STATE_COLORS: Record<AgentState, string> = {
  working: "#9ECE6A",
  idle: "#E0AF68",
  error: "#F7768E",
  waiting: "#FF9E64", // warm orange \u2014 calls attention
  retrying: "#7DCFFF", // steel blue \u2014 "automated, ongoing"
  unknown: "#565F89",
  no_pi: "#414868",
};

/** Per-state-tag verbs that depend only on the state (no idle math). */
const STATIC_TAG_VERBS: Partial<Record<AgentState, string>> = {
  waiting: "awaiting input",
  no_pi: "no pi",
  unknown: "unknown",
};

/**
 * Maximum visible width for a tool name in the activity tag. Keeps
 * the right column predictable when an agent is running a long-named
 * tool like `replace_in_file` \u2014 we'd rather show
 * `running replace_i\u2026` than blow out the row width.
 *
 * Mirrors `_TAG_TOOL_MAX` in the Python build.
 */
export const TAG_TOOL_MAX = 10;

/**
 * Soft cap on the activity-line text. The Static (Ink Text) wrapper
 * truncates further to fit the row width via overflow handling; this
 * bound just keeps a wall-of-text assistant message from bloating the
 * per-tick render cost.
 *
 * Mirrors `_ACTIVITY_MAX_CHARS` in the Python build.
 */
export const ACTIVITY_MAX_CHARS = 80;

/**
 * Right-truncate `text` to `width` cells, replacing the trailing
 * char with U+2026 ("\u2026") if it didn't fit. Width 0 collapses
 * to empty; width 1 keeps a single ellipsis as a placeholder.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(width - 1, 0))}\u2026`;
}

/**
 * Compact human-friendly token count.
 *   < 1k     -> "<int>"          ("137")
 *   < 1M     -> "<x.x>K"          ("28.7K")
 *   else     -> "<x.x>M"          ("1.3M")
 *
 * Returns "0" for 0 / negative / non-finite input.
 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Compact USD cost display:
 *   < $0.01   -> "<¢N>¢"           (sub-cent rounded up to 1¢)
 *   < $1      -> "$0.<NN>"          ("$0.06")
 *   else      -> "$N.NN"            ("$1.23")
 *
 * Returns "$0" for 0 / negative / non-finite input.
 */
export function fmtCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 0.01) return "<¢1";
  return `$${usd.toFixed(2)}`;
}

/**
 * Format `seconds` as a compact human-friendly idle duration:
 *   < 1s   -> ""
 *   < 60s  -> "Ns"
 *   < 60m  -> "Nm"
 *   else   -> "Nh"
 */
export function fmtIdle(seconds: number): string {
  if (seconds < 1) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * Format `seconds` as a longer-form human duration with two units
 * of precision, suitable for the bottom details box's "Started
 * Xh Ym ago" / "idle Xs" lines:
 *
 *   < 1s          -> "0s"            // floor; never negative
 *   < 60s         -> "Ns"            ("4s")
 *   < 60m         -> "Nm Ks" / "Nm"  ("3m 12s", "5m" when seconds=0)
 *   < 24h         -> "Nh Mm" / "Nh"
 *   else          -> "Nd Hh" / "Nd"
 *
 * The trailing zero unit is dropped so we get the shorter "5m"
 * instead of "5m 0s". `fmtIdle` stays as the one-unit form for the
 * tight pane-row activity tag; this helper is for the wider
 * details box where we have room for the second unit.
 */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return "0s";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return r === 0 ? `${m}m` : `${m}m ${r}s`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const r = Math.floor((s - h * 3600) / 60);
    return r === 0 ? `${h}h` : `${h}h ${r}m`;
  }
  const d = Math.floor(s / 86400);
  const r = Math.floor((s - d * 86400) / 3600);
  return r === 0 ? `${d}d` : `${d}d ${r}h`;
}

/**
 * Display form for an absolute filesystem path. Collapses a leading
 * `home` prefix to `~` (so `/home/user/Projects/foo` renders as
 * `~/Projects/foo`); leaves everything else as-is. Used by the
 * bottom details box's `Worktree` line to keep cwds short on the
 * sidebar.
 *
 * Returns the input unchanged when home is empty / null / not a
 * prefix of cwd.
 */
export function fmtCwdDisplay(cwd: string, home: string | null): string {
  if (cwd === "") return "";
  if (home === null || home === "") return cwd;
  // Strip any trailing slashes from home so `/home/user/` and
  // `/home/user` both match. cwd never has a trailing slash from
  // /proc, but /proc on different distros has surprised us before.
  const h = home.replace(/\/+$/, "");
  if (cwd === h) return "~";
  if (cwd.startsWith(`${h}/`)) return `~${cwd.slice(h.length)}`;
  return cwd;
}

/**
 * Parse the launch timestamp out of a pi session-JSONL filename.
 *
 * pi names every session file `YYYY-MM-DDTHH-MM-SS-mmmZ_<uuid>.jsonl`
 * (colons in the ISO timestamp swapped for dashes so the path is
 * filesystem-safe). The state resolver doesn't otherwise carry a
 * session-start timestamp, so we recover it from the filename here
 * for the details box's `Started Xh Ym ago` line.
 *
 * Returns the timestamp in unix seconds, or `null` when the path
 * is not a session JSONL we recognize. Tolerant of full paths,
 * bare basenames, and filenames with extra suffixes after the
 * uuid.
 */
export function parseSessionStartFromFile(file: string | null): number | null {
  if (file === null || file === "") return null;
  // Accept a full path or a basename. \\ in case Windows ever shows
  // up; pi itself is POSIX-only today but cheap insurance.
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const base = slash >= 0 ? file.slice(slash + 1) : file;
  // Match: 4-digit year - 2 - 2 T 2 - 2 - 2 - 3 Z, then `_<uuid>`.
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
  if (m === null) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return ms / 1000;
}

/**
 * Compact activity verb for a WORKING row, derived from the heartbeat
 * extension's phase + currentTool when available.
 *
 * Without the heartbeat (phase is null) we fall back to plain
 * `working` so users with the JSONL-only fast-path still get a
 * sensible badge.
 */
export function workingVerb(status: PaneStatus): string {
  const { phase, currentTool } = status;
  if (phase === "tool_running" && currentTool) {
    return `running ${truncate(currentTool, TAG_TOOL_MAX)}`;
  }
  if (phase === "tool_running") return "running tool";
  if (phase === "compacting") return "compacting";
  if (phase === "agent_running") return "thinking";
  return "working";
}

/**
 * Result of `activityTag`. The renderer picks `verb` for the text
 * and `color` for the foreground. Working rows pulse via an override
 * color the App threads in (`workingColor`); when null we fall back
 * to the static state color.
 */
export interface ActivityTag {
  verb: string;
  color: string;
}

/**
 * Right-side activity word for a pane row, with the color the
 * renderer should use. Surfaces the heartbeat phase + currentTool
 * when available so users see what an agent is doing right now
 * (`running bash`, `compacting`, `thinking`) instead of a generic
 * `working`. Falls back to a plain state verb when the heartbeat
 * isn't available.
 *
 * `workingColor` is the pulsed color the App's animation timer
 * computes; passing it through here lets the WORKING tag breathe
 * in lockstep with the title.
 */
export function activityTag(
  status: PaneStatus,
  workingColor: string | null = null,
  stateColors: Record<AgentState, string> = STATE_COLORS,
): ActivityTag {
  const state = status.state;
  const baseColor = stateColors[state] ?? "#808080";

  if (state === "working") {
    return {
      verb: workingVerb(status),
      color: workingColor ?? baseColor,
    };
  }
  if (state === "idle") {
    const idle = fmtIdle(status.idleSeconds);
    return {
      verb: idle ? `idle ${idle}` : "idle",
      color: baseColor,
    };
  }
  if (state === "error") {
    const idle = fmtIdle(status.idleSeconds);
    return {
      verb: idle ? `errored ${idle}` : "errored",
      color: baseColor,
    };
  }
  if (state === "retrying") {
    const n = status.retryAttempt;
    return {
      verb: n > 0 ? `retrying #${n}` : "retrying",
      color: baseColor,
    };
  }
  return {
    verb: STATIC_TAG_VERBS[state] ?? "unknown",
    color: baseColor,
  };
}

/**
 * Verbose second-line description for a pane row.
 *
 * Picks the most informative source available, in priority order:
 *   heartbeat phase (compacting / tool_running / agent_running /
 *                    retrying / awaiting_permission)
 *     > JSONL lastError (for ERROR rows)
 *     > JSONL lastAssistantPreview (for everyone else)
 *     > empty string
 *
 * Empty string means "render nothing on the second line" \u2014 the
 * renderer is expected to still allocate the row but show no text.
 */
export function activityDescription(status: PaneStatus): string {
  // Heartbeat-driven phases get fixed, action-oriented text. These
  // describe "what pi is doing internally right now" and are more
  // useful than the trailing assistant text during e.g. a 30-second
  // compaction.
  if (status.phase === "compacting") return "compressing context history";
  if (status.phase === "tool_running" && status.currentTool) {
    return `executing ${status.currentTool}`;
  }
  if (status.phase === "agent_running") return "drafting response";
  if (status.phase === "retrying") {
    const n = status.retryAttempt;
    return n > 0
      ? `retrying after transient error (attempt ${n})`
      : "retrying after transient error";
  }
  if (status.phase === "awaiting_permission") {
    return "waiting for your decision";
  }

  // JSONL-derived previews. ERROR pulls the actual error message;
  // everything else pulls the latest assistant-text preview.
  const snap = status.snapshot;
  if (snap === null) return "";
  if (status.state === "error" && snap.lastError) {
    return truncate(snap.lastError, ACTIVITY_MAX_CHARS);
  }
  if (snap.lastAssistantPreview) {
    return truncate(snap.lastAssistantPreview, ACTIVITY_MAX_CHARS);
  }
  return "";
}

/**
 * Structured data for the LEFT half of a pane row.
 *
 * The renderer picks `name` for the bold title text, `branch` for
 * the dim ` \u00b7 branch` fragment (drop entirely when null), and
 * `nameColor` for the title color. WORKING rows get the pulse color
 * (when the App's animation timer threads it in via `workingColor`);
 * non-WORKING rows return `null` for `nameColor` so the renderer
 * uses its default foreground/dim styling.
 */
export interface RowMain {
  name: string;
  branch: string | null;
  /** Color to apply to the name text, or null to use the default. */
  nameColor: string | null;
}

/**
 * Build the structured form of a pane row's left half.
 *
 * The agent name comes from `pane.title` with a numeric fallback when
 * pi hasn't named the pane yet. WORKING rows tint the name with the
 * pulse color so the title visibly breathes; other states leave
 * `nameColor` null and rely on CSS-level brightness (selected vs
 * inactive) at render time.
 */
export function fmtRowMain(args: {
  paneTitle: string | null;
  paneIndex: number;
  status: PaneStatus;
  branch: string | null;
  workingColor?: string | null;
  stateColors?: Record<AgentState, string>;
}): RowMain {
  const {
    paneTitle,
    paneIndex,
    status,
    branch,
    workingColor = null,
    stateColors = STATE_COLORS,
  } = args;
  const name = paneTitle && paneTitle.length > 0 ? paneTitle : `pane ${paneIndex}`;
  const isWorking = status.state === "working";
  return {
    name,
    branch,
    nameColor: isWorking ? (workingColor ?? stateColors.working) : null,
  };
}

/**
 * Plain text for the SessionGroup border title. Color is the live
 * accent (driven by the theme) and is applied at render time, not
 * here; this helper only deals with content + escaping.
 *
 * Mirrors `fmt_session_header` in the Python build.
 */
export function fmtSessionHeader(session: string): string {
  return session;
}

// ---------------------------------------------------------------------------
// Tmux status-widget summary
// ---------------------------------------------------------------------------

/**
 * Per-state emoji glyphs for the tmux status-line summary. Ports
 * `STATE_GLYPHS` in `tui.py`. unknown / no_pi suppressed in the
 * widget output below; they don't represent attention-worthy state.
 */
export const STATE_GLYPHS: Record<AgentState, string> = {
  idle: "🔴",
  working: "🟢",
  error: "❌",
  waiting: "🟠",
  retrying: "🔵",
  unknown: "❓",
  no_pi: "⚫",
};

/**
 * Build the tmux status-widget string. Format: `<glyph><count>` per
 * non-zero state, space-separated, in attention-priority order:
 * error -> waiting -> idle -> retrying -> working. unknown / no_pi
 * suppressed.
 *
 * Returns "" when nothing is interesting (e.g. the only states are
 * unknown / no_pi). The caller pushes this verbatim into the
 * `@pi-monitor-status` user option, which the user's `status-right`
 * references via `#{@pi-monitor-status}`.
 *
 * Mirrors `fmt_status_widget` in `tui.py`.
 */
export function fmtStatusWidget(states: readonly AgentState[]): string {
  const counts: Partial<Record<AgentState, number>> = {};
  for (const s of states) {
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const state of [
    "error",
    "waiting",
    "idle",
    "retrying",
    "working",
  ] as AgentState[]) {
    const n = counts[state] ?? 0;
    if (n > 0) parts.push(`${STATE_GLYPHS[state]}${n}`);
  }
  return parts.join(" ");
}
