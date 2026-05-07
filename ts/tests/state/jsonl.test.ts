/**
 * Tests for the JSONL parser. Direct equivalents of the
 * `test_first_text_preview_*` and `test_scan_lines_*` blocks in
 * `tests/test_state.py`.
 *
 * Each test maps 1:1 to a Python case so cross-checking the port is
 * mechanical: same input fixture, same assertion target, same
 * intent. Where Python relied on `_msg(role, **fields)` we use a
 * tiny `msg()` helper here.
 */

import { describe, expect, it } from "vitest";

import { firstTextPreview, scanLines } from "../../src/state/jsonl.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function msg(role: string, fields: Record<string, unknown> = {}): unknown {
  return {
    type: "message",
    id: "x",
    parentId: null,
    timestamp: "t",
    message: { role, ...fields },
  };
}

function blob(...entries: unknown[]): string {
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// firstTextPreview: first text chunk of an assistant message
// ---------------------------------------------------------------------------

describe("firstTextPreview", () => {
  it("picks the first text chunk", () => {
    const content = [{ type: "text", text: "hello world" }];
    expect(firstTextPreview(content)).toBe("hello world");
  });

  it("strips leading whitespace", () => {
    const content = [{ type: "text", text: "   indented response" }];
    expect(firstTextPreview(content)).toBe("indented response");
  });

  it("skips all-whitespace text and falls through to the next item", () => {
    const content = [
      { type: "text", text: "   " },
      { type: "text", text: "actual content" },
    ];
    expect(firstTextPreview(content)).toBe("actual content");
  });

  it("ignores tool-call items and picks subsequent text", () => {
    const content = [
      { type: "toolCall", name: "bash", id: "1" },
      { type: "text", text: "after the tool" },
    ];
    expect(firstTextPreview(content)).toBe("after the tool");
  });

  it("returns null for tool-only content", () => {
    const content = [{ type: "toolCall", name: "bash", id: "1" }];
    expect(firstTextPreview(content)).toBeNull();
  });

  it("caps long text at 200 chars", () => {
    const long = "x".repeat(500);
    const out = firstTextPreview([{ type: "text", text: long }]);
    expect(out).not.toBeNull();
    expect(out?.length).toBe(200);
  });

  it("handles non-array content defensively", () => {
    expect(firstTextPreview(null)).toBeNull();
    expect(firstTextPreview("some string")).toBeNull();
    expect(firstTextPreview({})).toBeNull();
    expect(firstTextPreview(undefined)).toBeNull();
  });

  it("ignores items missing a string text field", () => {
    const content = [{ type: "text", text: 42 }, { type: "text" }];
    expect(firstTextPreview(content)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scanLines: roles + tool-use bookkeeping
// ---------------------------------------------------------------------------

describe("scanLines", () => {
  it("captures assistant + stop reason on a single message", () => {
    const data = blob(
      msg("assistant", {
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
      }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastRole).toBe("assistant");
    expect(snap.lastStopReason).toBe("stop");
    expect(snap.pendingToolCalls).toBe(0);
  });

  it("treats a toolUse turn with one toolCall as one pending", () => {
    const data = blob(
      msg("assistant", {
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
        stopReason: "toolUse",
      }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastRole).toBe("assistant");
    expect(snap.lastStopReason).toBe("toolUse");
    expect(snap.pendingToolCalls).toBe(1);
  });

  it("clears one pending when a matching toolResult arrives", () => {
    const data = blob(
      msg("assistant", {
        content: [
          { type: "toolCall", id: "t1", name: "bash", arguments: {} },
          { type: "toolCall", id: "t2", name: "bash", arguments: {} },
        ],
        stopReason: "toolUse",
      }),
      msg("toolResult", {
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastRole).toBe("toolResult");
    // t2 is still open.
    expect(snap.pendingToolCalls).toBe(1);
  });

  it("clears all pending when a user message lands", () => {
    const data = blob(
      msg("assistant", {
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
        stopReason: "toolUse",
      }),
      msg("user", { content: "next prompt" }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastRole).toBe("user");
    expect(snap.pendingToolCalls).toBe(0);
  });

  it("captures errorMessage on assistant errors", () => {
    const data = blob(
      msg("assistant", {
        content: [],
        stopReason: "error",
        errorMessage: "boom",
      }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastError).toBe("boom");
  });

  it("skips entries whose type isn't 'message'", () => {
    const lines = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "abc",
        timestamp: "t",
        cwd: "/x",
      }),
      JSON.stringify(
        msg("assistant", {
          content: [{ type: "text", text: "hi" }],
          stopReason: "stop",
        }),
      ),
    ];
    const snap = scanLines(`${lines.join("\n")}\n`, 100.0);
    expect(snap.lastRole).toBe("assistant");
  });

  it("returns null lastRole for an empty file", () => {
    const snap = scanLines("", 100.0);
    expect(snap.lastRole).toBeNull();
    expect(snap.pendingToolCalls).toBe(0);
  });

  it("captures the assistant text preview", () => {
    const data = blob(
      msg("assistant", {
        content: [{ type: "text", text: "All four browser themes are aligned." }],
        stopReason: "stop",
      }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastAssistantPreview).toBe("All four browser themes are aligned.");
  });

  it("preserves the assistant preview through a tool round trip", () => {
    // After an assistant text message, a follow-up tool round trip
    // must not erase the preview \u2014 the user still wants to see what
    // the agent said while the tool runs. Mirrors
    // test_scan_lines_assistant_preview_persists_through_tool_round_trip
    // from the Python suite.
    const data = blob(
      msg("assistant", {
        content: [
          { type: "text", text: "running the migration now" },
          { type: "toolCall", id: "t1", name: "bash", arguments: {} },
        ],
        stopReason: "toolUse",
      }),
      msg("toolResult", {
        toolCallId: "t1",
        content: [{ type: "text", text: "ok" }],
      }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastAssistantPreview).toBe("running the migration now");
  });

  it("leaves preview null when the message has no text content", () => {
    const data = blob(
      msg("assistant", {
        content: [{ type: "toolCall", name: "bash", id: "1", arguments: {} }],
        stopReason: "toolUse",
      }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastAssistantPreview).toBeNull();
  });

  it("ignores malformed JSON lines and keeps going", () => {
    const data = `{not valid json}\n${JSON.stringify(
      msg("assistant", {
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
      }),
    )}\n`;
    const snap = scanLines(data, 100.0);
    expect(snap.lastRole).toBe("assistant");
  });

  it("tracks bashExecution and custom roles as activity events", () => {
    const data = blob(
      msg("assistant", {
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
      }),
      msg("bashExecution", { content: "$ pwd" }),
    );
    const snap = scanLines(data, 100.0);
    expect(snap.lastRole).toBe("bashExecution");
  });

  it("propagates mtime onto the snapshot", () => {
    const snap = scanLines("", 1729000000);
    expect(snap.mtime).toBe(1729000000);
  });
});
