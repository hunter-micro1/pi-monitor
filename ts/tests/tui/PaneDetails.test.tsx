/**
 * PaneDetails snapshot tests.
 *
 * Covers the visibility gate (null status → no render) and the
 * conditional detail-line rendering for the four interesting
 * states (idle, working, waiting, error).
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { JsonlSnapshot, PaneStatus } from "../../src/state/types.js";
import { PaneDetails } from "../../src/tui/PaneDetails.js";

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

describe("PaneDetails", () => {
  it("renders nothing when status is null", () => {
    const { lastFrame } = render(
      <PaneDetails status={null} paneTitle="x" paneIndex={0} branch={null} />,
    );
    expect(lastFrame() ?? "").toBe("");
  });

  it("renders title + branch + state tag for an idle row with a preview", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({
          state: "idle",
          idleSeconds: 246,
          snapshot: snapshot({
            lastAssistantPreview: "All four browser themes are aligned.",
          }),
        })}
        paneTitle="POWERBI"
        paneIndex={0}
        branch="feature/billing"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("POWERBI");
    expect(out).toContain("feature/billing");
    expect(out).toContain("idle 4m");
    expect(out).toContain("Last");
    expect(out).toContain("All four browser themes are aligned.");
    // Idle with no phase has nothing for the "Doing" line.
    expect(out).not.toContain("Doing");
  });

  it("renders a Doing line for a working row whose heartbeat reports a tool", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({
          state: "working",
          phase: "tool_running",
          currentTool: "bash",
        })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("agent");
    expect(out).toContain("Doing");
    expect(out).toContain("running bash");
  });

  it("renders the Doing line for awaiting_permission phase", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({ state: "working", phase: "awaiting_permission" })}
        paneTitle="agent"
        paneIndex={0}
        branch={null}
      />,
    );
    expect(lastFrame() ?? "").toContain("awaiting your permission");
  });

  it("renders the Doing line for the waiting state even without a phase", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({ state: "waiting" })}
        paneTitle="agent"
        paneIndex={0}
        branch={null}
      />,
    );
    expect(lastFrame() ?? "").toContain("awaiting your input");
  });

  it("renders an Error line for error rows with a lastError snapshot", () => {
    const { lastFrame } = render(
      <PaneDetails
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
    expect(out).toContain("Error");
    expect(out).toContain("ECONNRESET reading model stream");
  });

  it("does not render the Error label when state is not error", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({
          state: "idle",
          snapshot: snapshot({ lastError: "stale error from a past turn" }),
        })}
        paneTitle="agent"
        paneIndex={0}
        branch={null}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("Error");
  });

  it("falls back to 'pane <index>' when paneTitle is null", () => {
    const { lastFrame } = render(
      <PaneDetails status={status()} paneTitle={null} paneIndex={3} branch={null} />,
    );
    expect(lastFrame() ?? "").toContain("pane 3");
  });

  it("drops the branch fragment when branch is null", () => {
    const { lastFrame } = render(
      <PaneDetails status={status()} paneTitle="agent" paneIndex={0} branch={null} />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("agent");
    // Branch separator should not appear in the title row when
    // branch is absent.
    const firstTitleLine = out.split("\n").find((l) => l.includes("agent")) ?? "";
    expect(firstTitleLine).not.toContain("\u00b7");
  });
});
