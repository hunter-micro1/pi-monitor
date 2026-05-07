/**
 * Low-level tmux subprocess wrapper tests.
 *
 * Mocks `node:child_process` so the same suite runs without a real
 * tmux on PATH. Pins the contract higher-level modules rely on:
 *   - tmuxRun returns stdout when capture=true, "" otherwise.
 *   - tmuxRun throws TmuxError on non-zero exit.
 *   - serverRunning / sessionExists never throw \u2014 they map exit
 *     codes to booleans.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

import {
  TmuxError,
  serverRunning,
  sessionExists,
  tmuxRun,
} from "../../src/tmux/client.js";

const spawnSyncMock = vi.mocked(spawnSync);

beforeEach(() => {
  spawnSyncMock.mockReset();
});

afterEach(() => {
  spawnSyncMock.mockReset();
});

// ---------------------------------------------------------------------------
// tmuxRun
// ---------------------------------------------------------------------------

describe("tmuxRun", () => {
  it("returns stdout when capture is true", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(tmuxRun(["display-message", "-p", "x"], { capture: true })).toBe("ok\n");
  });

  it("returns an empty string when capture is omitted", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "irrelevant",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(tmuxRun(["select-pane", "-t", "x"])).toBe("");
  });

  it("throws TmuxError with the stderr on non-zero exit", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "no such session\n",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(() => tmuxRun(["kill-session", "-t", "missing"])).toThrow(TmuxError);
    try {
      tmuxRun(["kill-session", "-t", "missing"]);
    } catch (err) {
      expect((err as Error).message).toContain("no such session");
      expect((err as Error).message).toContain("exit 1");
    }
  });

  it("throws TmuxError when the spawn itself errored (tmux not installed)", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
      error: new Error("ENOENT: tmux not found"),
    } as unknown as ReturnType<typeof spawnSync>);
    expect(() => tmuxRun(["has-session"])).toThrow(TmuxError);
  });

  it("calls tmux with the args verbatim", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    tmuxRun(["new-session", "-d", "-s", "foo"]);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "tmux",
      ["new-session", "-d", "-s", "foo"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });
});

// ---------------------------------------------------------------------------
// serverRunning
// ---------------------------------------------------------------------------

describe("serverRunning", () => {
  it("returns true when has-session exits 0", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(serverRunning()).toBe(true);
  });

  it("returns false when has-session exits non-zero", () => {
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "no server",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(serverRunning()).toBe(false);
  });

  it("returns false when spawn itself failed (tmux not on PATH)", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
      error: new Error("ENOENT"),
    } as unknown as ReturnType<typeof spawnSync>);
    expect(serverRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sessionExists
// ---------------------------------------------------------------------------

describe("sessionExists", () => {
  it("uses the =name target syntax to avoid prefix matches", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    sessionExists("foo");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "tmux",
      ["has-session", "-t", "=foo"],
      expect.anything(),
    );
  });

  it("returns true on exit 0, false otherwise", () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(sessionExists("present")).toBe(true);

    spawnSyncMock.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "no",
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);
    expect(sessionExists("missing")).toBe(false);
  });
});
