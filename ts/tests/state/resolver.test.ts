/**
 * StateResolver orchestration tests.
 *
 * Mocks proc/index (process tree) and heartbeat/reader so the
 * resolver runs end-to-end without touching real /proc, ps, or the
 * heartbeat directory. Real fs is used for session JSONL fixtures
 * under a tmp `sessionsRoot`.
 *
 * Equivalents of the resolver-level cases in `tests/test_state.py`
 * and `tests/test_heartbeat.py`.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/proc/index.js", () => ({
  findAgentProcessForPane: vi.fn(),
  procStartTime: vi.fn(),
  procCwds: vi.fn(),
}));

vi.mock("../../src/heartbeat/reader.js", () => ({
  readHeartbeat: vi.fn(),
}));

import { readHeartbeat } from "../../src/heartbeat/reader.js";
import {
  findAgentProcessForPane,
  procCwds,
  procStartTime,
} from "../../src/proc/index.js";
import { cwdToClaudeProjectDir, cwdToSessionDir } from "../../src/state/files.js";
import { type PaneRef, StateResolver } from "../../src/state/resolver.js";

const findAgentProcessForPaneMock = vi.mocked(findAgentProcessForPane);
const procStartTimeMock = vi.mocked(procStartTime);
const procCwdsMock = vi.mocked(procCwds);
const readHeartbeatMock = vi.mocked(readHeartbeat);

let sessionsRoot: string;
let claudeProjectsRoot: string;

beforeEach(() => {
  sessionsRoot = mkdtempSync(join(tmpdir(), "pi-mon-resolver-"));
  claudeProjectsRoot = mkdtempSync(join(tmpdir(), "pi-mon-claude-resolver-"));
  findAgentProcessForPaneMock.mockReset();
  procStartTimeMock.mockReset();
  procCwdsMock.mockReset();
  readHeartbeatMock.mockReset();
  // Default: no heartbeat (forces JSONL path).
  readHeartbeatMock.mockReturnValue(null);
  // Default: no cwd lookups resolved -> resolver falls back to
  // ref.cwd. Tests that exercise the auto-worktree path override
  // this with a populated map.
  procCwdsMock.mockReturnValue(new Map());
});

afterEach(() => {
  rmSync(sessionsRoot, { recursive: true, force: true });
  rmSync(claudeProjectsRoot, { recursive: true, force: true });
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
  const dir = cwdToClaudeProjectDir(args.cwd, claudeProjectsRoot);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, args.filename);
  writeFileSync(path, args.body ?? "");
  utimesSync(path, args.mtime, args.mtime);
  return path;
}

function ref(args: {
  paneId: string;
  cwd: string;
  agentKind?: PaneRef["agentKind"];
  isPi?: boolean;
  panePid?: number;
}): PaneRef {
  const agentKind = args.agentKind ?? (args.isPi === false ? null : "pi");
  return {
    paneId: args.paneId,
    cwd: args.cwd,
    agentKind,
    isPi: agentKind === "pi",
    panePid: args.panePid ?? 1000,
  };
}

function newResolver(): StateResolver {
  return new StateResolver({ sessionsRoot, claudeProjectsRoot });
}

// ---------------------------------------------------------------------------
// Heartbeat fast-path
// ---------------------------------------------------------------------------

describe("StateResolver \u2014 heartbeat fast-path", () => {
  it("uses the heartbeat phase and skips JSONL inference entirely", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    readHeartbeatMock.mockReturnValue({
      pid: 9999,
      sessionFile: "/some/abs/path.jsonl",
      ts: 1500.0,
      phase: "tool_running",
      currentTool: "bash",
      retryAttempt: 0,
    });

    const resolver = newResolver();
    const refs = [ref({ paneId: "p1", cwd: "/x" })];
    const out = resolver.resolve(refs, 1500.5);

    const status = out.get("p1");
    expect(status).toBeDefined();
    expect(status?.state).toBe("working");
    expect(status?.phase).toBe("tool_running");
    expect(status?.currentTool).toBe("bash");
    expect(status?.sessionFile).toBe("/some/abs/path.jsonl");
    // No JSONL was claimed because heartbeat won.
    expect(status?.snapshot).toBeNull();
  });

  it("maps tool_running + ask_user_question to waiting (blocks on user)", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    readHeartbeatMock.mockReturnValue({
      pid: 9999,
      sessionFile: "/some/abs/path.jsonl",
      ts: 1500.0,
      phase: "tool_running",
      currentTool: "ask_user_question",
      retryAttempt: 0,
    });

    const resolver = newResolver();
    const refs = [ref({ paneId: "p1", cwd: "/x" })];
    const out = resolver.resolve(refs, 1500.5);

    const status = out.get("p1");
    expect(status?.state).toBe("waiting");
    // Heartbeat fields still surface through to the UI so the row
    // can show "ask_user_question" as the current tool label.
    expect(status?.phase).toBe("tool_running");
    expect(status?.currentTool).toBe("ask_user_question");
  });

  it("keeps tool_running + null currentTool as working (regression)", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    readHeartbeatMock.mockReturnValue({
      pid: 9999,
      sessionFile: "/some/abs/path.jsonl",
      ts: 1500.0,
      phase: "tool_running",
      currentTool: null,
      retryAttempt: 0,
    });

    const resolver = newResolver();
    const refs = [ref({ paneId: "p1", cwd: "/x" })];
    const out = resolver.resolve(refs, 1500.5);

    expect(out.get("p1")?.state).toBe("working");
  });

  it("populates snapshot from JSONL even on heartbeat fast-path", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    // Resolver used to set snapshot:null on the heartbeat path,
    // which hid the Prompt + Tokens lines in PaneDetails because
    // their data lives on the snapshot. With heartbeat.sessionFile
    // present, we still read the JSONL so those lines work even
    // while the heartbeat extension is publishing.
    const sessionFile = writeJsonl({
      cwd: "/x",
      filename: "2026-05-11T10-00-00-000Z_a.jsonl",
      mtime: 1499.5,
      body: `${JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "please ship the new release" }],
        },
      })}\n`,
    });
    readHeartbeatMock.mockReturnValue({
      pid: 9999,
      sessionFile,
      ts: 1500.0,
      phase: "tool_running",
      currentTool: "bash",
      retryAttempt: 0,
    });

    const resolver = newResolver();
    const refs = [ref({ paneId: "p1", cwd: "/x" })];
    const out = resolver.resolve(refs, 1500.5);

    const status = out.get("p1");
    expect(status?.state).toBe("working"); // from heartbeat
    expect(status?.snapshot).not.toBeNull(); // from JSONL
    expect(status?.snapshot?.lastUserPrompt).toBe("please ship the new release");
    // idleSeconds now derives from snapshot.mtime when available,
    // not the hard-coded 0.0 it used to be on the heartbeat path.
    expect(status?.idleSeconds).toBeCloseTo(1.0, 1);
  });

  it("falls back to JSONL when the heartbeat is unrecognized", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    readHeartbeatMock.mockReturnValue({
      pid: 9999,
      sessionFile: null,
      ts: 1500.0,
      phase: "future_phase_not_in_table",
      currentTool: null,
      retryAttempt: 0,
    });

    writeJsonl({
      cwd: "/x",
      filename: "2024-01-01T00-00-00-000Z_a.jsonl",
      mtime: 1500.0,
      body: "",
    });

    const resolver = newResolver();
    const refs = [ref({ paneId: "p1", cwd: "/x" })];
    const out = resolver.resolve(refs, 1500.5);

    const status = out.get("p1");
    // No heartbeat phase recognized -> JSONL path. Empty body
    // means scanLines produces a snapshot with lastRole=null,
    // which infer treats as UNKNOWN.
    expect(status?.phase).toBeNull();
  });

  it("marks the heartbeat's session_file as claimed so siblings can't steal it", () => {
    findAgentProcessForPaneMock
      .mockReturnValueOnce({ kind: "pi", pid: 1111 }) // p1
      .mockReturnValueOnce({ kind: "pi", pid: 2222 }); // p2
    procStartTimeMock
      .mockReturnValueOnce(1000.0) // p1
      .mockReturnValueOnce(1100.0); // p2

    const claimedPath = writeJsonl({
      cwd: "/x",
      filename: "2026-05-03T20-00-00-000Z_a.jsonl",
      mtime: 1500.0,
    });
    readHeartbeatMock.mockImplementation((pid) => {
      if (pid === 1111) {
        return {
          pid: 1111,
          sessionFile: claimedPath,
          ts: 1500.0,
          phase: "agent_running",
          currentTool: null,
          retryAttempt: 0,
        };
      }
      return null; // p2 has no heartbeat
    });

    const resolver = newResolver();
    const refs = [ref({ paneId: "p1", cwd: "/x" }), ref({ paneId: "p2", cwd: "/x" })];
    const out = resolver.resolve(refs, 1500.5);

    expect(out.get("p1")?.sessionFile).toBe(claimedPath);
    // p2 must NOT have the same sessionFile \u2014 the resolver locked
    // it out of the claim set.
    expect(out.get("p2")?.sessionFile).not.toBe(claimedPath);
  });
});

// ---------------------------------------------------------------------------
// JSONL fast-path (no heartbeat)
// ---------------------------------------------------------------------------

describe("StateResolver \u2014 JSONL path", () => {
  it("infers IDLE for a session with assistant + stop past the threshold", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    const path = writeJsonl({
      cwd: "/x",
      filename: "2026-05-03T20-37-30-000Z_a.jsonl",
      mtime: 1500.0,
      body: `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
      })}\n`,
    });

    const resolver = newResolver();
    const refs = [ref({ paneId: "p1", cwd: "/x" })];
    const out = resolver.resolve(refs, 1502.0); // 2 s past mtime > 1 s threshold

    const status = out.get("p1");
    expect(status?.state).toBe("idle");
    expect(status?.sessionFile).toBe(path);
    expect(status?.idleSeconds).toBeCloseTo(2.0, 1);
  });

  it("returns NO_PI for refs with isPi=false", () => {
    const resolver = newResolver();
    const refs = [ref({ paneId: "shell-only", cwd: "/x", isPi: false })];
    const out = resolver.resolve(refs, 1500.0);

    expect(out.get("shell-only")?.state).toBe("no_pi");
  });

  it("promotes a fresh pi with no flushed JSONL to WORKING during the grace window", () => {
    // pi started 5 s ago; STARTING_GRACE_S is 30 s.
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1500.0);
    // No JSONL on disk.

    const resolver = newResolver();
    const refs = [ref({ paneId: "fresh", cwd: "/y" })];
    const out = resolver.resolve(refs, 1505.0);

    expect(out.get("fresh")?.state).toBe("working");
  });

  it("demotes a long-running no-flushed-JSONL pi to UNKNOWN past the grace", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0); // 100 s ago

    const resolver = newResolver();
    const refs = [ref({ paneId: "old", cwd: "/y" })];
    const out = resolver.resolve(refs, 1100.0);

    expect(out.get("old")?.state).toBe("unknown");
  });

  it("two pis in the same cwd \u2014 the cohabit-swap regression: a fresh idle pi must NOT steal the older sibling's actively-written file", () => {
    findAgentProcessForPaneMock
      .mockReturnValueOnce({ kind: "pi", pid: 1111 }) // p1 (older)
      .mockReturnValueOnce({ kind: "pi", pid: 2222 }); // p2 (younger, fresh)
    procStartTimeMock
      .mockReturnValueOnce(Date.UTC(2026, 4, 3, 20, 37, 30) / 1000) // p1
      .mockReturnValueOnce(Date.UTC(2026, 4, 3, 20, 50, 0) / 1000); // p2

    // Older pi's file: filename predates p2's start.
    const olderPath = writeJsonl({
      cwd: "/cohabit",
      filename: "2026-05-03T20-37-34-005Z_owner.jsonl",
      mtime: Date.UTC(2026, 4, 3, 20, 50, 5) / 1000, // recent activity
      body: `${JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "running" }],
          stopReason: "toolUse",
        },
      })}\n`,
    });

    const resolver = newResolver();
    const now = Date.UTC(2026, 4, 3, 20, 50, 10) / 1000;
    const out = resolver.resolve(
      [
        ref({ paneId: "p1", cwd: "/cohabit", panePid: 100 }),
        ref({ paneId: "p2", cwd: "/cohabit", panePid: 200 }),
      ],
      now,
    );

    // p1 (older) claims its file.
    expect(out.get("p1")?.sessionFile).toBe(olderPath);
    // p2 (younger, no file of its own yet) MUST NOT claim p1's file.
    expect(out.get("p2")?.sessionFile).not.toBe(olderPath);
    // Within p2's grace window -> WORKING. (now - p2.start = 10 s < 30 s.)
    expect(out.get("p2")?.state).toBe("working");
  });

  it("a non-pi pane mixed with pi panes still gets NO_PI", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    writeJsonl({
      cwd: "/x",
      filename: "2026-05-03T20-37-30-000Z_a.jsonl",
      mtime: 1500.0,
    });

    const resolver = newResolver();
    const out = resolver.resolve(
      [
        ref({ paneId: "p1", cwd: "/x" }),
        ref({ paneId: "shell", cwd: "/anywhere", isPi: false }),
      ],
      1502.0,
    );

    expect(out.get("p1")?.state).not.toBe("no_pi");
    expect(out.get("shell")?.state).toBe("no_pi");
  });

  it("uses the pi descendant's actual cwd for JSONL claim (auto-worktree)", () => {
    // The auto-worktree extension re-execs pi inside an
    // `agent/<base>-<ts>` worktree. The tmux pane still reports
    // its shell's cwd; pi writes JSONL keyed off ITS cwd. The
    // resolver has to follow the pi process's actual cwd.
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    procCwdsMock.mockReturnValue(new Map([[9999, "/x-agent-worktree"]]));
    // JSONL file lives in the agent-worktree's session dir, NOT
    // the tmux-pane-cwd's dir. Resolver must look in the right
    // place.
    writeJsonl({
      cwd: "/x-agent-worktree",
      filename: "2026-05-03T20-37-30-000Z_a.jsonl",
      mtime: 1500.0,
    });

    const resolver = newResolver();
    const out = resolver.resolve([ref({ paneId: "p1", cwd: "/x" })], 1502.0);

    const status = out.get("p1");
    expect(status).toBeDefined();
    // The contract this test pins: the JSONL was claimed from the
    // agent-worktree's session dir, NOT from the tmux-pane-cwd's
    // dir. Empty file body means inferState returns `unknown`
    // either way, so we assert on `sessionFile` (the actual
    // location the resolver looked at).
    expect(status?.sessionFile).toContain("--x-agent-worktree--");
    // Bulk lookup happens once per tick with every live pi pid;
    // here that's [9999].
    expect(procCwdsMock).toHaveBeenCalledWith([9999]);
  });

  it("falls back to ref.cwd when the procCwd lookup returns null", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "pi", pid: 9999 });
    procStartTimeMock.mockReturnValue(1000.0);
    procCwdsMock.mockReturnValue(new Map());
    writeJsonl({
      cwd: "/x",
      filename: "2026-05-03T20-37-30-000Z_a.jsonl",
      mtime: 1500.0,
    });

    const resolver = newResolver();
    const out = resolver.resolve([ref({ paneId: "p1", cwd: "/x" })], 1502.0);

    const status = out.get("p1");
    expect(status?.sessionFile).toContain("--x--");
  });

  it("infers state for a Claude Code pane from ~/.claude/projects JSONL", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "claude", pid: 7777 });
    procStartTimeMock.mockReturnValue(1000.0);
    const path = writeClaudeJsonl({
      cwd: "/Users/foo/project",
      filename: "session.jsonl",
      mtime: 1500.0,
      body: `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        },
      })}\n`,
    });

    const resolver = newResolver();
    const out = resolver.resolve(
      [ref({ paneId: "claude", cwd: "/Users/foo/project", agentKind: "claude" })],
      1502.0,
    );

    const status = out.get("claude");
    expect(status?.state).toBe("idle");
    expect(status?.sessionFile).toBe(path);
    expect(status?.snapshot?.lastAssistantPreview).toBe("done");
  });

  it("keeps same-cwd Claude panes bound to their own session windows", () => {
    findAgentProcessForPaneMock.mockImplementation((panePid) => {
      if (panePid === 100) return { kind: "claude", pid: 7777 };
      if (panePid === 200) return { kind: "claude", pid: 8888 };
      return null;
    });
    procStartTimeMock.mockImplementation((pid) => {
      if (pid === 7777) return 1000.0;
      if (pid === 8888) return 1100.0;
      return null;
    });
    const older = writeClaudeJsonl({
      cwd: "/Users/foo/project",
      filename: "older.jsonl",
      mtime: 1005.0,
      body: `${JSON.stringify({
        type: "assistant",
        timestamp: new Date(1005 * 1000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "older" }],
          stop_reason: "end_turn",
        },
      })}\n`,
    });
    const younger = writeClaudeJsonl({
      cwd: "/Users/foo/project",
      filename: "younger.jsonl",
      mtime: 1110.0,
      body: `${JSON.stringify({
        type: "assistant",
        timestamp: new Date(1110 * 1000).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "younger" }],
          stop_reason: "end_turn",
        },
      })}\n`,
    });

    const resolver = newResolver();
    const out = resolver.resolve(
      [
        ref({
          paneId: "older",
          cwd: "/Users/foo/project",
          agentKind: "claude",
          panePid: 100,
        }),
        ref({
          paneId: "younger",
          cwd: "/Users/foo/project",
          agentKind: "claude",
          panePid: 200,
        }),
      ],
      1112.0,
    );

    expect(out.get("older")?.sessionFile).toBe(older);
    expect(out.get("younger")?.sessionFile).toBe(younger);
    expect(out.get("older")?.snapshot?.lastAssistantPreview).toBe("older");
    expect(out.get("younger")?.snapshot?.lastAssistantPreview).toBe("younger");
  });

  it("does not read pi heartbeat files for Claude Code panes", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "claude", pid: 7777 });
    procStartTimeMock.mockReturnValue(1000.0);
    writeClaudeJsonl({
      cwd: "/Users/foo/project",
      filename: "session.jsonl",
      mtime: 1500.0,
      body: `${JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }],
          stop_reason: "tool_use",
        },
      })}\n`,
    });
    readHeartbeatMock.mockClear();

    const resolver = newResolver();
    const out = resolver.resolve(
      [ref({ paneId: "claude", cwd: "/Users/foo/project", agentKind: "claude" })],
      1500.5,
    );

    expect(out.get("claude")?.state).toBe("working");
    expect(readHeartbeatMock).not.toHaveBeenCalled();
  });

  it("infers Claude assistant errors from top-level error fields", () => {
    findAgentProcessForPaneMock.mockReturnValue({ kind: "claude", pid: 7777 });
    procStartTimeMock.mockReturnValue(1000.0);
    writeClaudeJsonl({
      cwd: "/Users/foo/project",
      filename: "session.jsonl",
      mtime: 1500.0,
      body: `${JSON.stringify({
        type: "assistant",
        error: "overloaded_error",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "failed" }],
          stop_reason: "end_turn",
        },
      })}\n`,
    });

    const resolver = newResolver();
    const out = resolver.resolve(
      [ref({ paneId: "claude", cwd: "/Users/foo/project", agentKind: "claude" })],
      1500.5,
    );

    expect(out.get("claude")?.state).toBe("error");
  });
});
