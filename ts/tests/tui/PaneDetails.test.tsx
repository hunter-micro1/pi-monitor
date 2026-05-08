/**
 * PaneDetails snapshot tests.
 *
 * Covers the visibility gate (null status \u2192 no render), the title
 * row (name + branch + activity tag), and the three conditional
 * detail lines (`Worktree`, `When`, `Tokens`). Doing / Prompt /
 * Reply / Error labels are not part of the box anymore \u2014 a
 * dedicated test below pins that down so they can't sneak back
 * in.
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

  it("renders the title row with name + branch + activity tag", () => {
    const { lastFrame } = render(
      <PaneDetails
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

  // ---------------------------------------------------------------------
  // Worktree
  // ---------------------------------------------------------------------

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

  // ---------------------------------------------------------------------
  // When
  // ---------------------------------------------------------------------

  it("renders a When line with Started + idle when both are available", () => {
    // Session start parsed from filename, fixed nowSeconds so the
    // age is deterministic.
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
    // No sessionFile and idleSeconds < 1 \u2014 nothing to display.
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

  // ---------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------

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

  // ---------------------------------------------------------------------
  // Removed lines stay removed
  // ---------------------------------------------------------------------

  it("never renders Doing / Prompt / Reply / Error labels even with rich snapshot data", () => {
    // Worst-case input that USED to populate every line of the
    // pre-0.4.15 box: working+tool_running for Doing, error state
    // + lastError for Error, full snapshot prose for Prompt /
    // Reply. None of those labels should appear.
    const { lastFrame } = render(
      <PaneDetails
        status={status({
          state: "error",
          phase: "tool_running",
          currentTool: "bash",
          idleSeconds: 12,
          snapshot: snapshot({
            lastUserPrompt: "publish 0.4.15",
            lastAssistantPreview: "draft response goes here",
            lastError: "ECONNRESET reading model stream",
          }),
        })}
        paneTitle="agent"
        paneIndex={0}
        branch="main"
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).not.toContain("Doing");
    expect(out).not.toContain("Prompt");
    expect(out).not.toContain("Reply");
    expect(out).not.toContain("Error");
    // The activity tag still surfaces error state on the title row.
    expect(out).toContain("errored 12s");
  });
});
