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
    lastUserPrompt: null,
    cumulativeTokens: 0,
    cumulativeCostUsd: 0,
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
    expect(out).toContain("Reply");
    expect(out).toContain("All four browser themes are aligned.");
    // Idle with no phase has nothing for the "Doing" line.
    expect(out).not.toContain("Doing");
    // No tokens accumulated -> no Tokens line.
    expect(out).not.toContain("Tokens");
  });

  it("renders the Prompt line from snapshot.lastUserPrompt", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({
          state: "working",
          phase: "agent_running",
          snapshot: snapshot({
            lastUserPrompt: "publish our new version of pi",
          }),
        })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Prompt");
    expect(out).toContain("publish our new version of pi");
  });

  it("renders the Tokens line when cumulativeTokens > 0", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({
          state: "idle",
          snapshot: snapshot({
            cumulativeTokens: 28741,
            cumulativeCostUsd: 0.06,
          }),
        })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Tokens");
    expect(out).toContain("28.7K total");
    expect(out).toContain("$0.06");
  });

  it("hides the Tokens line when cumulativeTokens is 0", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({
          state: "idle",
          snapshot: snapshot({ cumulativeTokens: 0, cumulativeCostUsd: 0 }),
        })}
        paneTitle="agent"
        paneIndex={0}
        branch={null}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("Tokens");
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

  it("renders a Worktree line with $HOME collapsed to ~", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status()}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        cwd="/home/x/Projects/foo"
        home="/home/x"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Worktree");
    expect(out).toContain("~/Projects/foo");
  });

  it("hides the Worktree line when cwd is null or empty", () => {
    const noCwd = render(
      <PaneDetails
        status={status()}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        cwd={null}
        home="/home/x"
      />,
    );
    expect(noCwd.lastFrame() ?? "").not.toContain("Worktree");

    const emptyCwd = render(
      <PaneDetails
        status={status()}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        cwd=""
        home="/home/x"
      />,
    );
    expect(emptyCwd.lastFrame() ?? "").not.toContain("Worktree");
  });

  it("renders a When line with Started + idle when both are available", () => {
    // Session start parsed from filename, fixed nowSeconds so the
    // age is deterministic. 2026-05-08T18:32:09.372Z + 1h 12m =
    // 2026-05-08T19:44:09.372Z.
    const start = Date.UTC(2026, 4, 8, 18, 32, 9, 372) / 1000;
    const now = start + 3600 + 12 * 60; // +1h 12m
    const { lastFrame } = render(
      <PaneDetails
        status={status({
          state: "idle",
          idleSeconds: 4,
          sessionFile:
            "/x/2026-05-08T18-32-09-372Z_019e08dc-819c-73be-8b57-37b9416be06b.jsonl",
        })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        nowSeconds={now}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("When");
    expect(out).toContain("Started 1h 12m ago");
    expect(out).toContain("idle 4s");
  });

  it("shows only `idle ...` on the When line when sessionFile is null", () => {
    const { lastFrame } = render(
      <PaneDetails
        status={status({ state: "idle", idleSeconds: 90, sessionFile: null })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        nowSeconds={1_000_000}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("When");
    expect(out).toContain("idle 1m 30s");
    expect(out).not.toContain("Started");
  });

  it("hides the When line entirely when nothing is computable", () => {
    // No sessionFile and idleSeconds < 1 — nothing to display.
    const { lastFrame } = render(
      <PaneDetails
        status={status({ state: "idle", idleSeconds: 0, sessionFile: null })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
        nowSeconds={1_000_000}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("When");
  });
});
