/**
 * Tests for the per-cwd JSONL discovery + claim helpers.
 *
 * Direct equivalents of `test_filename_starttime_*`,
 * `test_cwd_to_session_dir_*`, and the `_claim_session_file` parts
 * of the cohabit-swap section in `tests/test_state.py`.
 */

import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeHarness } from "../../src/harness/claude.js";
import {
  claimSessionFile,
  cwdToSessionDir,
  findSessionFileForCwd,
  parseFilenameStartTime,
} from "../../src/state/files.js";

// ---------------------------------------------------------------------------
// Per-test tmp sessions root
// ---------------------------------------------------------------------------

let sessionsRoot: string;
let projectsRoot: string;

beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), "pi-mon-sess-"));
  projectsRoot = mkdtempSync(join(tmpdir(), "pi-mon-claude-"));
});

afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true });
  rmSync(projectsRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeJsonl(args: {
  cwd: string;
  filename: string;
  mtime: number;
  body?: string;
}): string {
  const dir = cwdToSessionDir(args.cwd, sessionsRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, args.filename);
  writeFileSync(path, args.body ?? "");
  utimesSync(path, args.mtime, args.mtime);
  return path;
}

function writeClaudeJsonl(args: {
  cwd: string;
  filename: string;
  mtime: number;
  body?: string;
}): string {
  const dir = claudeHarness.sessionDir(args.cwd, projectsRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, args.filename);
  const body =
    args.body ??
    `${JSON.stringify({
      type: "user",
      timestamp: new Date(args.mtime * 1000).toISOString(),
      message: { role: "user", content: [] },
    })}\n`;
  writeFileSync(path, body);
  utimesSync(path, args.mtime, args.mtime);
  return path;
}

function emptyFile(path: string): void {
  closeSync(openSync(path, "w"));
}
emptyFile; // referenced by future tests; suppress lint until then.

// ---------------------------------------------------------------------------
// cwdToSessionDir
// ---------------------------------------------------------------------------

describe("cwdToSessionDir", () => {
  it("encodes a normal cwd into the --foo-bar-- pattern", () => {
    const got = cwdToSessionDir("/home/user/project", sessionsRoot);
    expect(got).toBe(join(sessionsRoot, "--home-user-project--"));
  });

  it("strips a single leading slash", () => {
    const got = cwdToSessionDir("/x", sessionsRoot);
    expect(got).toBe(join(sessionsRoot, "--x--"));
  });

  it("strips multiple leading slashes (defensive)", () => {
    const got = cwdToSessionDir("///nested", sessionsRoot);
    expect(got).toBe(join(sessionsRoot, "--nested--"));
  });
});

describe("claudeHarness.sessionDir", () => {
  it("encodes a normal cwd using Claude Code's project-dir pattern", () => {
    const got = claudeHarness.sessionDir("/Users/foo/project", projectsRoot);
    expect(got).toBe(join(projectsRoot, "-Users-foo-project"));
  });
});

// ---------------------------------------------------------------------------
// parseFilenameStartTime
// ---------------------------------------------------------------------------

describe("parseFilenameStartTime", () => {
  it("parses pi's standard ISO-prefix filename", () => {
    const ts = parseFilenameStartTime(
      "2026-05-03T20-37-34-005Z_019def8f-86b5-77ac-96f5-302472f17757.jsonl",
    );
    // 2026-05-03T20:37:34.005Z in unix seconds.
    const expected = Date.UTC(2026, 4, 3, 20, 37, 34, 5) / 1000;
    expect(ts).toBe(expected);
  });

  it("returns null for non-iso filenames", () => {
    expect(parseFilenameStartTime("hello.jsonl")).toBeNull();
    expect(parseFilenameStartTime("2026-01-02_no-T.jsonl")).toBeNull();
    expect(parseFilenameStartTime("live.jsonl")).toBeNull();
  });

  it("works on a full path (uses the basename)", () => {
    const ts = parseFilenameStartTime("/some/dir/2026-05-03T20-37-34-005Z_aaa.jsonl");
    expect(ts).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// claimSessionFile
// ---------------------------------------------------------------------------

describe("claimSessionFile", () => {
  it("returns null when the directory doesn't exist", () => {
    const got = claimSessionFile({
      cwd: "/no/such/cwd",
      agentStart: 1000.0,
      nextAgentStart: null,
      claimed: new Set(),
      sessionsRoot,
    });
    expect(got).toBeNull();
  });

  it("claims an owned file (filename ts in [agentStart - eps, +inf))", () => {
    const cwd = "/foo";
    const path = writeJsonl({
      cwd,
      filename: "2026-05-03T20-37-34-005Z_owned.jsonl",
      mtime: 1762000010,
    });
    const agentStart = Date.UTC(2026, 4, 3, 20, 37, 30) / 1000; // 4 s before filename ts
    const got = claimSessionFile({
      cwd,
      agentStart,
      nextAgentStart: null,
      claimed: new Set(),
      sessionsRoot,
    });
    expect(got).toBe(path);
  });

  it("does NOT claim a file outside its [agentStart, nextAgentStart) window", () => {
    const cwd = "/foo";
    const oldFile = writeJsonl({
      cwd,
      filename: "2026-05-03T20-37-34-005Z_old.jsonl",
      mtime: 1762000000,
    });
    const newFile = writeJsonl({
      cwd,
      filename: "2026-05-03T21-00-00-000Z_new.jsonl",
      mtime: 1762000020,
    });
    // The OLDER pi only owns up to nextAgentStart - eps. The newer file
    // belongs to a younger sibling pi and must not be claimed by the
    // older one.
    const oldPiStart = Date.UTC(2026, 4, 3, 20, 37, 30) / 1000;
    const newPiStart = Date.UTC(2026, 4, 3, 20, 50, 0) / 1000;
    const got = claimSessionFile({
      cwd,
      agentStart: oldPiStart,
      nextAgentStart: newPiStart,
      claimed: new Set(),
      sessionsRoot,
    });
    expect(got).toBe(oldFile);
    expect(got).not.toBe(newFile);
  });

  it("falls back to a resumed file (filename predates pi, mtime >= agentStart)", () => {
    const cwd = "/foo";
    const agentStart = Date.UTC(2026, 4, 3, 20, 37, 30) / 1000;
    // Filename is older than pi's start time; pi resumed it via
    // `--session`. mtime > agentStart means pi has actually written
    // since opening.
    const path = writeJsonl({
      cwd,
      filename: "2025-01-01T00-00-00-000Z_resumed.jsonl",
      mtime: agentStart + 5, // pi appended after starting
    });
    const got = claimSessionFile({
      cwd,
      agentStart,
      nextAgentStart: null,
      claimed: new Set(),
      sessionsRoot,
    });
    expect(got).toBe(path);
  });

  it("returns null when nothing is claimable for a known agentStart", () => {
    // Cohabit-swap regression: a fresh idle pi (agentStart in the future
    // relative to all existing files) must NOT steal the older
    // sibling's actively-written file. The Python build's previous
    // behaviour was to greedy-pick max-by-mtime here; the new
    // behavior is null.
    const cwd = "/foo";
    const olderPi = Date.UTC(2026, 4, 3, 20, 37, 30) / 1000;
    const olderFile = writeJsonl({
      cwd,
      filename: "2026-05-03T20-37-34-005Z_owned.jsonl",
      mtime: olderPi + 5,
    });
    // A YOUNGER pi with no flushed file yet.
    const youngerPi = Date.UTC(2026, 4, 3, 20, 50, 0) / 1000;
    const claimed = new Set([olderFile]); // older sibling already grabbed it
    const got = claimSessionFile({
      cwd,
      agentStart: youngerPi,
      nextAgentStart: null,
      claimed,
      sessionsRoot,
    });
    expect(got).toBeNull();
  });

  it("falls back to mtime-DESC when agentStart is null (no-info path)", () => {
    const cwd = "/foo";
    writeJsonl({ cwd, filename: "old.jsonl", mtime: 1000 });
    const newest = writeJsonl({
      cwd,
      filename: "newer.jsonl",
      mtime: 2000,
    });
    const got = claimSessionFile({
      cwd,
      agentStart: null,
      nextAgentStart: null,
      claimed: new Set(),
      sessionsRoot,
    });
    expect(got).toBe(newest);
  });

  it("respects the claimed set", () => {
    const cwd = "/foo";
    const a = writeJsonl({ cwd, filename: "a.jsonl", mtime: 1000 });
    const b = writeJsonl({ cwd, filename: "b.jsonl", mtime: 2000 });
    // b is already claimed by a sibling; we should land on a.
    const got = claimSessionFile({
      cwd,
      agentStart: null,
      nextAgentStart: null,
      claimed: new Set([b]),
      sessionsRoot,
    });
    expect(got).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// claimSessionFile driven by the Claude adapter
//
// The claim algorithm is shared across harnesses; what changes is
// where files live and how a session's start time is recovered. These
// cases pin the Claude side of that: project-dir layout, and start
// times read from the first record rather than the filename.
// ---------------------------------------------------------------------------

function claimClaude(args: {
  cwd: string;
  agentStart: number | null;
  nextAgentStart?: number | null;
  claimed: Set<string>;
}): string | null {
  return claimSessionFile({
    cwd: args.cwd,
    agentStart: args.agentStart,
    nextAgentStart: args.nextAgentStart ?? null,
    claimed: args.claimed,
    sessionsRoot: projectsRoot,
    harness: claudeHarness,
  });
}

describe("claimSessionFile (claude harness)", () => {
  it("returns null when the Claude project directory doesn't exist", () => {
    const got = claimClaude({
      cwd: "/no/such/cwd",
      agentStart: 1000,
      claimed: new Set(),
    });
    expect(got).toBeNull();
  });

  it("claims the newest unclaimed Claude JSONL by mtime", () => {
    const cwd = "/Users/foo/project";
    writeClaudeJsonl({ cwd, filename: "old.jsonl", mtime: 1000 });
    const newest = writeClaudeJsonl({ cwd, filename: "new.jsonl", mtime: 2000 });
    const got = claimClaude({ cwd, agentStart: null, claimed: new Set() });
    expect(got).toBe(newest);
  });

  it("respects the claimed set", () => {
    const cwd = "/Users/foo/project";
    const a = writeClaudeJsonl({ cwd, filename: "a.jsonl", mtime: 1000 });
    const b = writeClaudeJsonl({ cwd, filename: "b.jsonl", mtime: 2000 });
    const got = claimClaude({ cwd, agentStart: null, claimed: new Set([b]) });
    expect(got).toBe(a);
  });

  it("filters out files not modified after a known agent start", () => {
    const cwd = "/Users/foo/project";
    writeClaudeJsonl({ cwd, filename: "old.jsonl", mtime: 1000 });
    const active = writeClaudeJsonl({ cwd, filename: "active.jsonl", mtime: 1105 });
    const got = claimClaude({ cwd, agentStart: 1100, claimed: new Set() });
    expect(got).toBe(active);
  });

  it("uses Claude entry timestamps to bound sibling ownership windows", () => {
    // The regression this guards: Claude names files by bare UUID, so
    // without reading the first record's timestamp the window collapses
    // to "newest mtime wins" and the younger agent steals the older
    // sibling's actively-written file.
    const cwd = "/Users/foo/project";
    const older = writeClaudeJsonl({ cwd, filename: "older.jsonl", mtime: 1005 });
    const younger = writeClaudeJsonl({ cwd, filename: "younger.jsonl", mtime: 1110 });

    const first = claimClaude({
      cwd,
      agentStart: 1000,
      nextAgentStart: 1100,
      claimed: new Set(),
    });
    const second = claimClaude({
      cwd,
      agentStart: 1100,
      claimed: new Set([older]),
    });

    expect(first).toBe(older);
    expect(second).toBe(younger);
  });
});

// ---------------------------------------------------------------------------
// findSessionFileForCwd
// ---------------------------------------------------------------------------

describe("findSessionFileForCwd", () => {
  it("returns the most recently modified jsonl in the cwd's dir", () => {
    const cwd = "/foo";
    writeJsonl({ cwd, filename: "old.jsonl", mtime: 1000 });
    const newest = writeJsonl({ cwd, filename: "newer.jsonl", mtime: 2000 });
    expect(findSessionFileForCwd(cwd, sessionsRoot)).toBe(newest);
  });

  it("returns null for a cwd with no session dir", () => {
    expect(findSessionFileForCwd("/missing/cwd", sessionsRoot)).toBeNull();
  });
});
