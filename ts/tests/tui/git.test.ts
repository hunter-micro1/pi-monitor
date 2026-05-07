/**
 * branchForCwd tests. Mocks node:child_process at the module
 * boundary so the suite stays subprocess-free.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";

import { _clearBranchCache, branchForCwd } from "../../src/tui/git.js";

const spawnSyncMock = vi.mocked(spawnSync);

beforeEach(() => {
  spawnSyncMock.mockReset();
  _clearBranchCache();
});

afterEach(() => {
  spawnSyncMock.mockReset();
  _clearBranchCache();
});

function ok(stdout: string): ReturnType<typeof spawnSync> {
  return {
    status: 0,
    stdout,
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  } as ReturnType<typeof spawnSync>;
}

function fail(): ReturnType<typeof spawnSync> {
  return {
    status: 1,
    stdout: "",
    stderr: "fatal",
    pid: 0,
    output: [],
    signal: null,
  } as ReturnType<typeof spawnSync>;
}

describe("branchForCwd", () => {
  it("returns the trimmed stdout when git exits 0", () => {
    spawnSyncMock.mockReturnValue(ok("feature/auth\n"));
    expect(branchForCwd("/x")).toBe("feature/auth");
  });

  it("returns null when cwd is empty", () => {
    expect(branchForCwd("")).toBeNull();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns null when git exits non-zero (detached / not a checkout)", () => {
    spawnSyncMock.mockReturnValue(fail());
    expect(branchForCwd("/no-git")).toBeNull();
  });

  it("returns null when stdout is empty", () => {
    spawnSyncMock.mockReturnValue(ok(""));
    expect(branchForCwd("/x")).toBeNull();
  });

  it("returns null when spawnSync itself throws (git not installed)", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(branchForCwd("/x")).toBeNull();
  });

  it("caches the result \u2014 second call doesn't re-shell-out", () => {
    spawnSyncMock.mockReturnValue(ok("main\n"));
    expect(branchForCwd("/x")).toBe("main");
    expect(branchForCwd("/x")).toBe("main");
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("treats different cwds as separate cache keys", () => {
    spawnSyncMock.mockReturnValueOnce(ok("a\n")).mockReturnValueOnce(ok("b\n"));
    expect(branchForCwd("/x")).toBe("a");
    expect(branchForCwd("/y")).toBe("b");
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("invokes git with -C cwd and the standard symbolic-ref args", () => {
    spawnSyncMock.mockReturnValue(ok("main\n"));
    branchForCwd("/some/dir");
    const call = spawnSyncMock.mock.calls[0];
    expect(call?.[0]).toBe("git");
    expect(call?.[1]).toEqual([
      "-C",
      "/some/dir",
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
  });
});
