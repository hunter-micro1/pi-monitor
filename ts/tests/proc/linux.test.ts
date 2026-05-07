/**
 * Linux process-tree resolver tests.
 *
 * Mocks `node:fs` so the same suite runs on macOS / CI without
 * needing a real /proc layout. The shape of the responses matches
 * what the kernel actually puts in those files (whitespace +
 * trailing newline behavior matters for comm/children parsing).
 */

import { describe, expect, it, vi } from "vitest";

import { findPiPidForPane, procStartTime } from "../../src/proc/linux.js";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
}));

import { readFileSync, statSync } from "node:fs";

const readFileSyncMock = vi.mocked(readFileSync);
const statSyncMock = vi.mocked(statSync);

// Helper to set up a /proc fake. `comms` and `children` are keyed
// by pid; missing entries simulate a process that's gone.
function withProcLayout(args: {
  comms?: Record<number, string>;
  children?: Record<number, number[]>;
  ctimes?: Record<number, number>;
}): void {
  const comms = args.comms ?? {};
  const children = args.children ?? {};
  const ctimes = args.ctimes ?? {};

  readFileSyncMock.mockImplementation((p) => {
    const path = String(p);
    let m = path.match(/^\/proc\/(\d+)\/comm$/);
    if (m) {
      const pid = Number(m[1]);
      if (comms[pid] === undefined) {
        // Mirror real fs: missing path throws ENOENT.
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return `${comms[pid]}\n`;
    }
    m = path.match(/^\/proc\/(\d+)\/task\/\1\/children$/);
    if (m) {
      const pid = Number(m[1]);
      const kids = children[pid];
      if (kids === undefined) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return `${kids.join(" ")}\n`;
    }
    throw new Error(`unexpected readFileSync path: ${path}`);
  });

  statSyncMock.mockImplementation((p) => {
    const path = String(p);
    const m = path.match(/^\/proc\/(\d+)$/);
    if (m === null) {
      throw new Error(`unexpected statSync path: ${path}`);
    }
    const pid = Number(m[1]);
    const ctime = ctimes[pid];
    if (ctime === undefined) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    // statSync returns a Stats object with ctimeMs in milliseconds.
    return { ctimeMs: ctime * 1000 } as unknown as ReturnType<typeof statSync>;
  });
}

// ---------------------------------------------------------------------------
// procStartTime
// ---------------------------------------------------------------------------

describe("linux.procStartTime", () => {
  it("returns the ctime of /proc/<pid> in unix seconds", () => {
    withProcLayout({ ctimes: { 1234: 1729000000 } });
    expect(procStartTime(1234)).toBe(1729000000);
  });

  it("returns null when /proc/<pid> doesn't exist", () => {
    withProcLayout({ ctimes: {} });
    expect(procStartTime(1234)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findPiPidForPane
// ---------------------------------------------------------------------------

describe("linux.findPiPidForPane", () => {
  it("returns the pane pid itself when comm is already 'pi' (exec pi case)", () => {
    withProcLayout({
      comms: { 100: "pi" },
      children: { 100: [] },
    });
    expect(findPiPidForPane(100)).toBe(100);
  });

  it("walks descendants and finds pi as a child of the shell", () => {
    // tmux pane shell -> [vim, pi]
    withProcLayout({
      comms: { 100: "zsh", 101: "vim", 102: "pi" },
      children: { 100: [101, 102], 101: [], 102: [] },
    });
    expect(findPiPidForPane(100)).toBe(102);
  });

  it("walks deeper than one level when needed", () => {
    // pane shell -> bash -> env -> pi
    withProcLayout({
      comms: { 100: "zsh", 101: "bash", 102: "env", 103: "pi" },
      children: { 100: [101], 101: [102], 102: [103], 103: [] },
    });
    expect(findPiPidForPane(100)).toBe(103);
  });

  it("returns null when the tree contains no pi", () => {
    withProcLayout({
      comms: { 100: "zsh", 101: "vim", 102: "node" },
      children: { 100: [101, 102], 101: [], 102: [] },
    });
    expect(findPiPidForPane(100)).toBeNull();
  });

  it("returns null when the pane pid itself is gone", () => {
    withProcLayout({});
    expect(findPiPidForPane(100)).toBeNull();
  });

  it("skips a child that disappeared mid-walk and keeps searching siblings", () => {
    // 100 -> [101 (gone), 102 (pi)]
    withProcLayout({
      comms: { 100: "zsh", 102: "pi" },
      children: { 100: [101, 102], 102: [] },
    });
    expect(findPiPidForPane(100)).toBe(102);
  });

  it("doesn't loop forever on a corrupt /proc cycle", () => {
    // Pretend children says 100's child is 100 (impossible, but let's
    // be defensive). The seen-set must terminate the walk.
    withProcLayout({
      comms: { 100: "zsh" },
      children: { 100: [100] },
    });
    expect(findPiPidForPane(100)).toBeNull();
  });
});
