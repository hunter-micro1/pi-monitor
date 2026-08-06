/**
 * Claude Code adapter tests.
 *
 * Fixtures mirror record shapes sampled from real
 * `~/.claude/projects/*.jsonl` files rather than invented ones, so a
 * schema drift upstream shows up here as a failure instead of as
 * silently-wrong pane states.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeHarness } from "../../src/harness/claude.js";

function line(entry: unknown): string {
  return JSON.stringify(entry);
}

function assistant(fields: Record<string, unknown>, top: Record<string, unknown> = {}) {
  return line({
    type: "assistant",
    uuid: "u1",
    timestamp: "2026-08-06T01:17:14.562Z",
    cwd: "/home/u/proj",
    ...top,
    message: { role: "assistant", ...fields },
  });
}

function user(content: unknown) {
  return line({
    type: "user",
    uuid: "u2",
    timestamp: "2026-08-06T01:17:39.858Z",
    message: { role: "user", content },
  });
}

// ---------------------------------------------------------------------------
// sessionDir: cwd -> Claude's encoded project directory
// ---------------------------------------------------------------------------

describe("claudeHarness.sessionDir", () => {
  it("replaces path separators with dashes", () => {
    expect(claudeHarness.sessionDir("/home/u/Projects/pi-monitor", "/root")).toBe(
      "/root/-home-u-Projects-pi-monitor",
    );
  });

  it("collapses dots to dashes too (dotted dirs like .claude)", () => {
    // Real observed case: /a/contract/.claude/worktrees/r2
    // encodes to -a-contract--claude-worktrees-r2 (double dash: one
    // from the slash, one from the dot).
    expect(claudeHarness.sessionDir("/a/contract/.claude/worktrees/r2", "/root")).toBe(
      "/root/-a-contract--claude-worktrees-r2",
    );
  });
});

// ---------------------------------------------------------------------------
// sessionStartTime: recovered from the first record, not the filename
// ---------------------------------------------------------------------------

describe("claudeHarness.sessionStartTime", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pm-claude-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the first record's timestamp", () => {
    const p = join(dir, "a1b2.jsonl");
    writeFileSync(
      p,
      `${[
        assistant({ stop_reason: "end_turn" }),
        assistant({ stop_reason: "tool_use" }),
      ].join("\n")}\n`,
    );
    // 2026-08-06T01:17:14.562Z
    expect(claudeHarness.sessionStartTime(p)).toBeCloseTo(
      Date.parse("2026-08-06T01:17:14.562Z") / 1000,
      3,
    );
  });

  it("skips leading records that carry no timestamp", () => {
    const p = join(dir, "a2.jsonl");
    writeFileSync(
      p,
      `${[
        line({ type: "mode", permissionMode: "default" }),
        assistant({ stop_reason: "end_turn" }),
      ].join("\n")}\n`,
    );
    expect(claudeHarness.sessionStartTime(p)).toBeCloseTo(
      Date.parse("2026-08-06T01:17:14.562Z") / 1000,
      3,
    );
  });

  it("returns null for a missing file", () => {
    expect(claudeHarness.sessionStartTime(join(dir, "nope.jsonl"))).toBeNull();
  });

  it("returns null when no record has a parseable timestamp", () => {
    const p = join(dir, "a3.jsonl");
    writeFileSync(p, `${line({ type: "mode" })}\n`);
    expect(claudeHarness.sessionStartTime(p)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseRecord: native shape -> normalized vocabulary
// ---------------------------------------------------------------------------

describe("claudeHarness.parseRecord", () => {
  it("maps end_turn to pi's `stop`", () => {
    const r = claudeHarness.parseRecord(assistant({ stop_reason: "end_turn" }));
    expect(r?.role).toBe("assistant");
    expect(r?.stopReason).toBe("stop");
  });

  it("maps stop_sequence to `stop` and max_tokens to `length`", () => {
    expect(
      claudeHarness.parseRecord(assistant({ stop_reason: "stop_sequence" }))
        ?.stopReason,
    ).toBe("stop");
    expect(
      claudeHarness.parseRecord(assistant({ stop_reason: "max_tokens" }))?.stopReason,
    ).toBe("length");
  });

  it("maps tool_use to `toolUse`", () => {
    expect(
      claudeHarness.parseRecord(assistant({ stop_reason: "tool_use" }))?.stopReason,
    ).toBe("toolUse");
  });

  it("passes through an unrecognized stop_reason rather than dropping it", () => {
    expect(
      claudeHarness.parseRecord(assistant({ stop_reason: "novel_reason" }))?.stopReason,
    ).toBe("novel_reason");
  });

  it("collects tool_use block ids as open tool calls", () => {
    const r = claudeHarness.parseRecord(
      assistant({
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "hmm", signature: "s" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
          { type: "tool_use", id: "toolu_2", name: "Bash", input: {} },
        ],
      }),
    );
    expect(r?.toolCallIds).toEqual(["toolu_1", "toolu_2"]);
  });

  it("extracts the first text block as the preview, skipping thinking", () => {
    const r = claudeHarness.parseRecord(
      assistant({
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "internal", signature: "s" },
          { type: "text", text: "  visible answer" },
        ],
      }),
    );
    expect(r?.text).toBe("visible answer");
  });

  it("sums the usage counters into a token total", () => {
    const r = claudeHarness.parseRecord(
      assistant({
        stop_reason: "end_turn",
        usage: {
          input_tokens: 2,
          output_tokens: 654,
          cache_read_input_tokens: 102718,
          cache_creation_input_tokens: 1041,
        },
      }),
    );
    expect(r?.tokens).toBe(2 + 654 + 102718 + 1041);
  });

  it("treats isApiErrorMessage as an error turn", () => {
    const r = claudeHarness.parseRecord(
      assistant(
        {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "API Error: 503 overloaded" }],
        },
        { isApiErrorMessage: true },
      ),
    );
    expect(r?.stopReason).toBe("error");
    expect(r?.errorMessage).toBe("API Error: 503 overloaded");
  });

  it("maps a tool_result user record to the toolResult role", () => {
    const r = claudeHarness.parseRecord(
      user([
        { type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false },
      ]),
    );
    expect(r?.role).toBe("toolResult");
    expect(r?.toolCallId).toBe("toolu_1");
  });

  it("treats a plain string user message as a prompt", () => {
    const r = claudeHarness.parseRecord(user("do the thing"));
    expect(r?.role).toBe("user");
    expect(r?.text).toBe("do the thing");
  });

  it("treats an array-of-text user message as a prompt", () => {
    const r = claudeHarness.parseRecord(user([{ type: "text", text: "do the thing" }]));
    expect(r?.role).toBe("user");
    expect(r?.text).toBe("do the thing");
  });

  it.each(["attachment", "hook_success", "total_tokens_reminder", "mode", "direct"])(
    "ignores non-conversational record type %s",
    (type) => {
      expect(claudeHarness.parseRecord(line({ type, uuid: "x" }))).toBeNull();
    },
  );

  it("ignores malformed JSON", () => {
    expect(claudeHarness.parseRecord("{not json")).toBeNull();
  });
});
