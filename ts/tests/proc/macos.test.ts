/**
 * macOS process-tree resolver tests.
 *
 * Mocks `node:child_process` so we don't shell out to a real `ps`.
 * The shape of the fake output matches what `ps -A -o
 * pid=,ppid=,comm=,etimes=` actually prints on a darwin box: one
 * line per process, columns separated by runs of spaces, comm
 * column may itself contain spaces (e.g. macOS-bundled apps).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

import {
  _resetPsCacheForTests,
  findPiPidForPane,
  procCwd,
  procStartTime,
} from "../../src/proc/macos.js";

const execFileSyncMock = vi.mocked(execFileSync);

beforeEach(() => {
  _resetPsCacheForTests();
});

afterEach(() => {
  execFileSyncMock.mockReset();
});

/**
 * Helper to install a fake `ps -A` output. Each row is
 * (pid, ppid, comm, etimes).
 */
function fakePsRows(rows: Array<[number, number, string, number]>): void {
  const text = rows
    .map(([pid, ppid, comm, etimes]) => `${pid} ${ppid} ${comm} ${etimes}`)
    .join("\n");
  execFileSyncMock.mockReturnValue(text);
}

// ---------------------------------------------------------------------------
// procStartTime
// ---------------------------------------------------------------------------

describe("macos.procStartTime", () => {
  it("computes start time as now - etimes", () => {
    fakePsRows([[1234, 1, "pi", 60]]);
    const before = Date.now() / 1000;
    const ts = procStartTime(1234);
    const after = Date.now() / 1000;
    // ts should be approximately (now - 60). Allow slack for the
    // wall-clock advancing between our 'before' and the impl's read.
    expect(ts).not.toBeNull();
    expect(ts as number).toBeGreaterThanOrEqual(before - 60 - 1);
    expect(ts as number).toBeLessThanOrEqual(after - 60 + 1);
  });

  it("returns null when the pid isn't in the snapshot", () => {
    fakePsRows([[1234, 1, "pi", 60]]);
    expect(procStartTime(9999)).toBeNull();
  });

  it("returns null when ps fails entirely", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ps not found");
    });
    expect(procStartTime(1234)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findPiPidForPane
// ---------------------------------------------------------------------------

describe("macos.findPiPidForPane", () => {
  it("returns the pane pid itself when comm is 'pi'", () => {
    fakePsRows([[100, 1, "pi", 30]]);
    expect(findPiPidForPane(100)).toBe(100);
  });

  it("walks descendants and finds pi as a child of the shell", () => {
    fakePsRows([
      [100, 1, "zsh", 100],
      [101, 100, "vim", 50],
      [102, 100, "pi", 30],
    ]);
    expect(findPiPidForPane(100)).toBe(102);
  });

  it("walks deeper than one level", () => {
    fakePsRows([
      [100, 1, "zsh", 100],
      [101, 100, "bash", 80],
      [102, 101, "env", 70],
      [103, 102, "pi", 30],
    ]);
    expect(findPiPidForPane(100)).toBe(103);
  });

  it("returns null when there's no pi in the tree", () => {
    fakePsRows([
      [100, 1, "zsh", 100],
      [101, 100, "vim", 50],
      [102, 100, "node", 50],
    ]);
    expect(findPiPidForPane(100)).toBeNull();
  });

  it("returns null when the pane pid is gone from the snapshot", () => {
    fakePsRows([[1, 0, "launchd", 999999]]);
    expect(findPiPidForPane(100)).toBeNull();
  });

  it("returns null when ps fails entirely", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("ps not found");
    });
    expect(findPiPidForPane(100)).toBeNull();
  });

  it("handles comm names with embedded spaces (e.g. macOS apps)", () => {
    // ps -o comm= can return a path with spaces or a app-bundle name
    // like "Google Chrome Helper". The parser keeps everything between
    // the second and last whitespace-separated tokens as the comm.
    fakePsRows([
      [100, 1, "Google Chrome Helper", 50],
      [101, 100, "pi", 30],
    ]);
    expect(findPiPidForPane(100)).toBe(101);
  });

  it("doesn't loop forever on a corrupt cycle in the snapshot", () => {
    // ppid pointing back at oneself should be impossible from the
    // kernel, but the seen-set must defend against it.
    fakePsRows([[100, 100, "zsh", 30]]);
    expect(findPiPidForPane(100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Snapshot caching: only one ps subprocess per cache window.
// ---------------------------------------------------------------------------

describe("macos snapshot cache", () => {
  it("reuses a snapshot across multiple lookups in the same window", () => {
    fakePsRows([
      [100, 1, "zsh", 60],
      [101, 100, "pi", 30],
    ]);
    procStartTime(100);
    findPiPidForPane(100);
    procStartTime(101);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// procCwd
// ---------------------------------------------------------------------------

describe("macos.procCwd", () => {
  it("parses the cwd from `lsof -p <pid> -d cwd -Fn` output", () => {
    // Real lsof -Fn output has the pid on a `p` line, fd marker
    // on `f`, and the path on `n`. We pick the first `n` line.
    execFileSyncMock.mockReturnValue("p1234\nfcwd\nn/home/user/project\n");
    expect(procCwd(1234)).toBe("/home/user/project");
  });

  it("returns null when lsof exits non-zero (process gone)", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("lsof: process not found");
    });
    expect(procCwd(1234)).toBeNull();
  });

  it("returns null when lsof emits no n-line", () => {
    execFileSyncMock.mockReturnValue("p1234\nfcwd\n");
    expect(procCwd(1234)).toBeNull();
  });

  it("handles paths containing spaces", () => {
    execFileSyncMock.mockReturnValue("p1234\nfcwd\nn/Users/Hayden/Library/My Things\n");
    expect(procCwd(1234)).toBe("/Users/Hayden/Library/My Things");
  });
});
