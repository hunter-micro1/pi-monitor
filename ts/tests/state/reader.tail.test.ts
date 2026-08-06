/**
 * Adaptive tail-window regression tests.
 *
 * The reader tails a fixed slice of the session file rather than
 * parsing megabytes on every tick. That slice was sized for pi,
 * whose JSONL is almost entirely conversational records — 64 KB
 * always contained a turn.
 *
 * Claude Code interleaves large `attachment` records (observed:
 * ~2.9 KB average, 54 KB max) between turns. On a real session the
 * last conversational record was 226 KB from EOF, so a 64 KB tail
 * saw only attachments, produced `lastRole: null`, and pinned a
 * perfectly healthy pane to `unknown`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeHarness } from "../../src/harness/claude.js";
import { piHarness } from "../../src/harness/pi.js";
import { JsonlReader } from "../../src/state/reader.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-tail-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** An attachment record padded to roughly `bytes` on the wire. */
function attachment(bytes: number): string {
  return JSON.stringify({
    type: "attachment",
    uuid: "a",
    timestamp: "2026-08-06T01:00:00.000Z",
    attachment: { blob: "x".repeat(Math.max(0, bytes - 120)) },
  });
}

function claudeAssistant(text: string): string {
  return JSON.stringify({
    type: "assistant",
    uuid: "u",
    timestamp: "2026-08-06T01:00:00.000Z",
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  });
}

describe("JsonlReader adaptive tail", () => {
  it("finds the last turn even when attachments bury it far beyond 64 KB", () => {
    const p = join(dir, "buried.jsonl");
    const lines = [claudeAssistant("the real answer")];
    // ~300 KB of attachments after the turn — mirrors the observed
    // 226 KB burial, with headroom.
    for (let i = 0; i < 100; i++) lines.push(attachment(3000));
    writeFileSync(p, `${lines.join("\n")}\n`);

    const snap = new JsonlReader().read(p, claudeHarness);
    expect(snap?.lastRole).toBe("assistant");
    expect(snap?.lastStopReason).toBe("stop");
    expect(snap?.lastAssistantPreview).toBe("the real answer");
  });

  it("still reports null lastRole for a file with no conversational records at all", () => {
    const p = join(dir, "noise.jsonl");
    writeFileSync(
      p,
      `${Array.from({ length: 50 }, () => attachment(2000)).join("\n")}\n`,
    );

    const snap = new JsonlReader().read(p, claudeHarness);
    expect(snap?.lastRole).toBeNull();
  });

  it("prefers the LAST turn when several are separated by attachment noise", () => {
    const p = join(dir, "several.jsonl");
    const lines: string[] = [];
    lines.push(claudeAssistant("older answer"));
    for (let i = 0; i < 40; i++) lines.push(attachment(3000));
    lines.push(claudeAssistant("newer answer"));
    for (let i = 0; i < 40; i++) lines.push(attachment(3000));
    writeFileSync(p, `${lines.join("\n")}\n`);

    const snap = new JsonlReader().read(p, claudeHarness);
    expect(snap?.lastAssistantPreview).toBe("newer answer");
  });

  it("does not change pi behavior on a dense conversational file", () => {
    const p = join(dir, "pi.jsonl");
    const msg = (text: string) =>
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text }],
        },
      });
    writeFileSync(p, `${[msg("first"), msg("last")].join("\n")}\n`);

    const snap = new JsonlReader().read(p, piHarness);
    expect(snap?.lastRole).toBe("assistant");
    expect(snap?.lastAssistantPreview).toBe("last");
  });
});
