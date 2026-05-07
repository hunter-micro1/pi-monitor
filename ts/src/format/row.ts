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
  working: "#4EBF71",
  idle: "#FFA62B",
  error: "#BA3C5B",
  waiting: "#de935f", // warm orange \u2014 calls attention
  retrying: "#81a2be", // steel blue \u2014 "automated, ongoing"
  unknown: "#808080",
  no_pi: "#505050",
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
): ActivityTag {
  const state = status.state;
  const baseColor = STATE_COLORS[state] ?? "#808080";

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
 * inactive vs active-group) at render time.
 */
export function fmtRowMain(args: {
  paneTitle: string | null;
  paneIndex: number;
  status: PaneStatus;
  branch: string | null;
  workingColor?: string | null;
}): RowMain {
  const { paneTitle, paneIndex, status, branch, workingColor = null } = args;
  const name = paneTitle && paneTitle.length > 0 ? paneTitle : `pane ${paneIndex}`;
  const isWorking = status.state === "working";
  return {
    name,
    branch,
    nameColor: isWorking ? (workingColor ?? STATE_COLORS.working) : null,
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
