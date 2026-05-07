/**
 * Tests for the row formatting helpers.
 *
 * Equivalents of the `test_truncate_*`, `test_fmt_idle_*`,
 * `test_working_verb_*`, `test_activity_tag_*`,
 * `test_activity_description_*`, `test_fmt_row_main_*`, and
 * `test_fmt_session_header_*` blocks in
 * `tests/test_tui_render.py`.
 *
 * Where the Python tests assert on Rich-markup substrings (e.g.
 * `"running bash" in out`), the TS tests assert on the structured
 * fields we return (e.g. `tag.verb === "running bash"`). Same intent,
 * different shape.
 */

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_MAX_CHARS,
  STATE_COLORS,
  STATE_GLYPHS,
  activityDescription,
  activityTag,
  fmtIdle,
  fmtRowMain,
  fmtSessionHeader,
  fmtStatusWidget,
  truncate,
  workingVerb,
} from "../../src/format/row.js";
import type { JsonlSnapshot, PaneStatus } from "../../src/state/types.js";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function snapshot(fields: Partial<JsonlSnapshot> = {}): JsonlSnapshot {
  return {
    mtime: 0.0,
    lastRole: null,
    lastStopReason: null,
    lastError: null,
    pendingToolCalls: 0,
    lastAssistantPreview: null,
    ...fields,
  };
}

function status(fields: Partial<PaneStatus> = {}): PaneStatus {
  return {
    paneId: "x",
    state: "idle",
    sessionFile: null,
    snapshot: null,
    idleSeconds: 0.0,
    phase: null,
    currentTool: null,
    retryAttempt: 0,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("passes through short strings unchanged", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("inserts an ellipsis when too long", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd\u2026");
  });

  it("collapses to empty at width 0", () => {
    expect(truncate("abc", 0)).toBe("");
  });

  it("keeps a single ellipsis at width 1", () => {
    expect(truncate("abc", 1)).toBe("\u2026");
  });
});

// ---------------------------------------------------------------------------
// fmtIdle
// ---------------------------------------------------------------------------

describe("fmtIdle", () => {
  it("returns empty under one second", () => {
    expect(fmtIdle(0.4)).toBe("");
  });

  it("formats seconds", () => {
    expect(fmtIdle(12)).toBe("12s");
  });

  it("formats minutes", () => {
    expect(fmtIdle(246)).toBe("4m");
  });

  it("formats hours", () => {
    expect(fmtIdle(3700)).toBe("1h");
  });
});

// ---------------------------------------------------------------------------
// workingVerb: heartbeat phase + tool -> activity word
// ---------------------------------------------------------------------------

describe("workingVerb", () => {
  it("uses 'running <tool>' when tool_running carries a tool name", () => {
    const s = status({
      state: "working",
      phase: "tool_running",
      currentTool: "bash",
    });
    expect(workingVerb(s)).toBe("running bash");
  });

  it("truncates long tool names with an ellipsis", () => {
    const s = status({
      state: "working",
      phase: "tool_running",
      currentTool: "replace_in_file",
    });
    const out = workingVerb(s);
    expect(out.startsWith("running ")).toBe(true);
    expect(out.includes("\u2026")).toBe(true);
  });

  it("falls back to 'running tool' when tool_running has no tool name", () => {
    const s = status({
      state: "working",
      phase: "tool_running",
      currentTool: null,
    });
    expect(workingVerb(s)).toBe("running tool");
  });

  it("maps compacting phase to 'compacting'", () => {
    expect(workingVerb(status({ state: "working", phase: "compacting" }))).toBe(
      "compacting",
    );
  });

  it("maps agent_running phase to 'thinking'", () => {
    expect(workingVerb(status({ state: "working", phase: "agent_running" }))).toBe(
      "thinking",
    );
  });

  it("falls back to plain 'working' without a phase", () => {
    expect(workingVerb(status({ state: "working" }))).toBe("working");
  });
});

// ---------------------------------------------------------------------------
// activityTag: state -> { verb, color }
// ---------------------------------------------------------------------------

describe("activityTag", () => {
  it("uses the workingColor override for WORKING rows", () => {
    const s = status({ state: "working", phase: "agent_running" });
    const out = activityTag(s, "#abcdef");
    expect(out.verb).toBe("thinking");
    expect(out.color).toBe("#abcdef");
  });

  it("falls back to STATE_COLORS.working when workingColor is null", () => {
    const s = status({ state: "working", phase: "agent_running" });
    expect(activityTag(s, null).color).toBe(STATE_COLORS.working);
  });

  it("formats 'idle <time>' with idleSeconds", () => {
    const s = status({ state: "idle", idleSeconds: 246 });
    expect(activityTag(s).verb).toBe("idle 4m");
  });

  it("drops the idle suffix when idleSeconds is below 1", () => {
    const s = status({ state: "idle", idleSeconds: 0 });
    expect(activityTag(s).verb).toBe("idle");
  });

  it("formats 'errored <time>' for error rows", () => {
    const s = status({ state: "error", idleSeconds: 12 });
    expect(activityTag(s).verb).toBe("errored 12s");
  });

  it("includes #N suffix on retrying when retryAttempt is set", () => {
    const s = status({ state: "retrying", retryAttempt: 3 });
    expect(activityTag(s).verb).toBe("retrying #3");
  });

  it("drops the #N suffix when retryAttempt is 0", () => {
    const s = status({ state: "retrying", retryAttempt: 0 });
    expect(activityTag(s).verb).toBe("retrying");
  });

  it("uses 'awaiting input' for waiting", () => {
    expect(activityTag(status({ state: "waiting" })).verb).toBe("awaiting input");
  });

  it("uses 'no pi' for no_pi", () => {
    expect(activityTag(status({ state: "no_pi" })).verb).toBe("no pi");
  });

  it("uses 'unknown' for unknown", () => {
    expect(activityTag(status({ state: "unknown" })).verb).toBe("unknown");
  });

  it("returns the state's color from STATE_COLORS by default", () => {
    expect(activityTag(status({ state: "idle" })).color).toBe(STATE_COLORS.idle);
    expect(activityTag(status({ state: "error" })).color).toBe(STATE_COLORS.error);
    expect(activityTag(status({ state: "waiting" })).color).toBe(STATE_COLORS.waiting);
  });
});

// ---------------------------------------------------------------------------
// activityDescription: priority order across phase / snapshot
// ---------------------------------------------------------------------------

describe("activityDescription", () => {
  it("phase beats snapshot preview", () => {
    const s = status({
      state: "working",
      phase: "compacting",
      snapshot: snapshot({
        lastAssistantPreview: "The migration finished cleanly.",
      }),
    });
    expect(activityDescription(s)).toBe("compressing context history");
  });

  it("tool_running with a tool returns 'executing <tool>'", () => {
    const s = status({
      state: "working",
      phase: "tool_running",
      currentTool: "edit",
    });
    expect(activityDescription(s)).toBe("executing edit");
  });

  it("agent_running phase returns 'drafting response'", () => {
    const s = status({ state: "working", phase: "agent_running" });
    expect(activityDescription(s)).toBe("drafting response");
  });

  it("retrying phase includes the attempt number", () => {
    const s = status({ state: "working", phase: "retrying", retryAttempt: 2 });
    expect(activityDescription(s)).toContain("attempt 2");
  });

  it("awaiting_permission phase has fixed text", () => {
    const s = status({ state: "waiting", phase: "awaiting_permission" });
    expect(activityDescription(s)).toBe("waiting for your decision");
  });

  it("idle row uses snapshot preview", () => {
    const s = status({
      state: "idle",
      idleSeconds: 246,
      snapshot: snapshot({
        lastAssistantPreview: "All four browser themes are aligned to the new palette.",
      }),
    });
    expect(activityDescription(s)).toContain("browser themes");
  });

  it("error row uses snapshot lastError", () => {
    const s = status({
      state: "error",
      idleSeconds: 12,
      snapshot: snapshot({ lastError: "ECONNRESET reading model stream" }),
    });
    expect(activityDescription(s)).toContain("ECONNRESET");
  });

  it("long preview truncates with an ellipsis", () => {
    const s = status({
      state: "idle",
      snapshot: snapshot({ lastAssistantPreview: "x".repeat(300) }),
    });
    const out = activityDescription(s);
    expect(out.length).toBeLessThanOrEqual(ACTIVITY_MAX_CHARS + 1); // +1 for ellipsis
    expect(out.includes("\u2026")).toBe(true);
  });

  it("returns empty when no snapshot or phase is available", () => {
    expect(activityDescription(status({ state: "idle" }))).toBe("");
  });

  it("no_pi pane has no description", () => {
    expect(activityDescription(status({ state: "no_pi" }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fmtRowMain
// ---------------------------------------------------------------------------

describe("fmtRowMain", () => {
  it("uses pane title when present", () => {
    const out = fmtRowMain({
      paneTitle: "PSP7-gateway",
      paneIndex: 0,
      status: status(),
      branch: "feature/auth",
    });
    expect(out.name).toBe("PSP7-gateway");
    expect(out.branch).toBe("feature/auth");
  });

  it("falls back to 'pane <index>' when title is null/empty", () => {
    expect(
      fmtRowMain({
        paneTitle: null,
        paneIndex: 3,
        status: status(),
        branch: null,
      }).name,
    ).toBe("pane 3");
    expect(
      fmtRowMain({
        paneTitle: "",
        paneIndex: 7,
        status: status(),
        branch: null,
      }).name,
    ).toBe("pane 7");
  });

  it("returns null branch verbatim (renderer drops the fragment)", () => {
    const out = fmtRowMain({
      paneTitle: "agent",
      paneIndex: 0,
      status: status(),
      branch: null,
    });
    expect(out.branch).toBeNull();
  });

  it("tints name with workingColor on WORKING rows; null otherwise", () => {
    const working = fmtRowMain({
      paneTitle: "x",
      paneIndex: 0,
      status: status({ state: "working" }),
      branch: null,
      workingColor: "#abcdef",
    });
    expect(working.nameColor).toBe("#abcdef");

    const idle = fmtRowMain({
      paneTitle: "x",
      paneIndex: 0,
      status: status({ state: "idle" }),
      branch: null,
    });
    expect(idle.nameColor).toBeNull();
  });

  it("falls back to STATE_COLORS.working when workingColor is null on a WORKING row", () => {
    const out = fmtRowMain({
      paneTitle: "x",
      paneIndex: 0,
      status: status({ state: "working" }),
      branch: null,
      workingColor: null,
    });
    expect(out.nameColor).toBe(STATE_COLORS.working);
  });
});

// ---------------------------------------------------------------------------
// fmtSessionHeader
// ---------------------------------------------------------------------------

describe("fmtSessionHeader", () => {
  it("returns the session name verbatim", () => {
    expect(fmtSessionHeader("contracts")).toBe("contracts");
  });

  it("preserves session names with special chars (escaping happens at render)", () => {
    // Unlike the Python helper which has to escape Rich markup chars
    // (`[`, `]`) here, the TS helper returns plain text and the JSX
    // renderer doesn't have a markup interpretation step \u2014 so
    // brackets pass through.
    expect(fmtSessionHeader("session [name]")).toBe("session [name]");
  });
});

describe("fmtStatusWidget", () => {
  it("returns empty string when there are no states", () => {
    expect(fmtStatusWidget([])).toBe("");
  });

  it("returns empty string when only unknown / no_pi states are present", () => {
    expect(fmtStatusWidget(["unknown", "no_pi", "unknown"])).toBe("");
  });

  it("renders a single state with its glyph + count", () => {
    expect(fmtStatusWidget(["working", "working", "working"])).toBe(
      `${STATE_GLYPHS.working}3`,
    );
  });

  it("orders states by attention priority (error > waiting > idle > retrying > working)", () => {
    const out = fmtStatusWidget(["working", "idle", "error", "waiting", "retrying"]);
    expect(out).toBe(
      `${STATE_GLYPHS.error}1 ${STATE_GLYPHS.waiting}1 ${STATE_GLYPHS.idle}1 ${STATE_GLYPHS.retrying}1 ${STATE_GLYPHS.working}1`,
    );
  });

  it("counts duplicates of the same state", () => {
    expect(fmtStatusWidget(["error", "error", "error"])).toBe(`${STATE_GLYPHS.error}3`);
  });

  it("suppresses unknown / no_pi when other states are present", () => {
    const out = fmtStatusWidget(["working", "unknown", "no_pi", "unknown"]);
    expect(out).toBe(`${STATE_GLYPHS.working}1`);
  });
});
