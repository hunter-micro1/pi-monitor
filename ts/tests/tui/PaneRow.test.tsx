/**
 * PaneRow snapshot tests.
 *
 * Renders the component via ink-testing-library and asserts on the
 * raw string output. We're not chasing pixel parity with the Python
 * Textual snapshots \u2014 just pinning the visible-content invariants:
 * name + branch on top, activity on bottom, state tag where we
 * expect, brightness behavior on selection.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { JsonlSnapshot, PaneStatus } from "../../src/state/types.js";
import { PaneRow } from "../../src/tui/PaneRow.js";

function snapshot(fields: Partial<JsonlSnapshot> = {}): JsonlSnapshot {
  return {
    mtime: 0,
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
    idleSeconds: 0,
    phase: null,
    currentTool: null,
    retryAttempt: 0,
    ...fields,
  };
}

describe("PaneRow", () => {
  it("renders an idle row with name + branch + 'idle <time>' tag", () => {
    const { lastFrame } = render(
      <PaneRow
        status={status({ state: "idle", idleSeconds: 246 })}
        paneTitle="POWERBI"
        paneIndex={0}
        branch="feature/billing"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("POWERBI");
    expect(out).toContain("feature/billing");
    expect(out).toContain("idle 4m");
  });

  it("renders a working row with the heartbeat-derived tag", () => {
    const { lastFrame } = render(
      <PaneRow
        status={status({
          state: "working",
          phase: "tool_running",
          currentTool: "bash",
        })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        workingColor="#abcdef"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("agent");
    expect(out).toContain("main");
    expect(out).toContain("running bash");
  });

  it("uses the snapshot's lastAssistantPreview as the activity description", () => {
    const { lastFrame } = render(
      <PaneRow
        status={status({
          state: "idle",
          idleSeconds: 12,
          snapshot: snapshot({
            lastAssistantPreview: "All four browser themes are aligned.",
          }),
        })}
        paneTitle="POWERBI"
        paneIndex={0}
        branch="feature/x"
      />,
    );
    expect(lastFrame()).toContain("All four browser themes are aligned.");
  });

  it("uses the snapshot's lastError as the activity description for error rows", () => {
    const { lastFrame } = render(
      <PaneRow
        status={status({
          state: "error",
          idleSeconds: 12,
          snapshot: snapshot({ lastError: "ECONNRESET reading model stream" }),
        })}
        paneTitle="ANALYST"
        paneIndex={0}
        branch="main"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("errored 12s");
    expect(out).toContain("ECONNRESET");
  });

  it("falls back to 'pane <index>' when paneTitle is null", () => {
    const { lastFrame } = render(
      <PaneRow status={status()} paneTitle={null} paneIndex={3} branch={null} />,
    );
    expect(lastFrame()).toContain("pane 3");
  });

  it("drops the branch fragment entirely when branch is null", () => {
    const { lastFrame } = render(
      <PaneRow status={status()} paneTitle="agent" paneIndex={0} branch={null} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("agent");
    // No '\u00b7' separator should appear since branch is absent.
    // (The activity line might still contain text that has '\u00b7'
    // if a snapshot was set; guard by checking the relevant slice.)
    const firstLine = out.split("\n")[0] ?? "";
    expect(firstLine).not.toContain("\u00b7");
  });

  it("renders the no_pi state without an activity description", () => {
    const { lastFrame } = render(
      <PaneRow
        status={status({ state: "no_pi" })}
        paneTitle="shell"
        paneIndex={0}
        branch={null}
      />,
    );
    const out = lastFrame() ?? "";
    // Title is present; no activity-style copy bleeds in for no_pi.
    expect(out).toContain("shell");
    expect(out).not.toContain("running");
    expect(out).not.toContain("idle");
  });

  it("prefixes the right-side tag with the spinner glyph on working rows", () => {
    const { lastFrame } = render(
      <PaneRow
        status={status({ state: "working", phase: "agent_running" })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        spinnerGlyph={"\u280b"}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("\u280b");
    expect(out).toContain("thinking");
  });

  it("omits the spinner glyph on non-working rows even when one is supplied", () => {
    const { lastFrame } = render(
      <PaneRow
        status={status({ state: "idle", idleSeconds: 30 })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        spinnerGlyph={"\u280b"}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("\u280b");
  });

  it("omits the spinner when no glyph is threaded in (working row falls back to verb only)", () => {
    const { lastFrame } = render(
      <PaneRow
        status={status({ state: "working", phase: "agent_running" })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("thinking");
    // None of the 10 Braille frames should appear when the App
    // hasn't threaded a glyph in (e.g. before the first tick).
    for (const cp of [
      "\u280b",
      "\u2819",
      "\u2839",
      "\u2838",
      "\u283c",
      "\u2834",
      "\u2826",
      "\u2827",
      "\u2807",
      "\u280f",
    ]) {
      expect(out).not.toContain(cp);
    }
  });
});
