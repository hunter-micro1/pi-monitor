/**
 * Monitor session, right-slot lifecycle, spawn helpers, and status
 * widget. Mocks tmux/client + tmux/panes + tmux/viewer at the
 * module boundary so we don't shell out to a real tmux.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/tmux/client.js", () => ({
  TmuxError: class TmuxError extends Error {},
  tmuxRun: vi.fn(),
  serverRunning: vi.fn(),
  sessionExists: vi.fn(),
}));

vi.mock("../../src/tmux/panes.js", () => ({
  listPanes: vi.fn(() => []),
}));

vi.mock("../../src/tmux/viewer.js", () => ({
  cleanupOrphanViewers: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

import { existsSync, statSync } from "node:fs";

import { TmuxError, sessionExists, tmuxRun } from "../../src/tmux/client.js";
import {
  attachRightSlotToViewer,
  clearStatusWidget,
  createPiSession,
  createPiWindow,
  ensureMonitorSession,
  killMonitorSession,
  resetRightSlotToPlaceholder,
  setStatusWidget,
} from "../../src/tmux/monitor.js";
import { listPanes } from "../../src/tmux/panes.js";
import { cleanupOrphanViewers } from "../../src/tmux/viewer.js";

const tmuxRunMock = vi.mocked(tmuxRun);
const sessionExistsMock = vi.mocked(sessionExists);
const listPanesMock = vi.mocked(listPanes);
const cleanupOrphanViewersMock = vi.mocked(cleanupOrphanViewers);
const existsSyncMock = vi.mocked(existsSync);
const statSyncMock = vi.mocked(statSync);

beforeEach(() => {
  tmuxRunMock.mockReset();
  sessionExistsMock.mockReset();
  listPanesMock.mockReset();
  cleanupOrphanViewersMock.mockReset();
  existsSyncMock.mockReset();
  statSyncMock.mockReset();
  // Sensible defaults; individual tests override.
  listPanesMock.mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// ensureMonitorSession
// ---------------------------------------------------------------------------

describe("ensureMonitorSession", () => {
  it("creates a 2-pane layout from scratch when the session doesn't exist", () => {
    sessionExistsMock.mockReturnValue(false);
    ensureMonitorSession();

    // Always cleans up orphans first.
    expect(cleanupOrphanViewersMock).toHaveBeenCalled();

    // new-session, split-window, select-pane.
    const cmds = tmuxRunMock.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(cmds[0]).toBe("new-session");
    expect(cmds[1]).toBe("split-window");
    expect(cmds[2]).toBe("select-pane");
  });

  it("uses the leftCommand when given", () => {
    sessionExistsMock.mockReturnValue(false);
    ensureMonitorSession("pi-monitor-tui");
    const newSession = tmuxRunMock.mock.calls[0]?.[0] as string[];
    // The command is the last positional in `tmux new-session -d -s
    // monitor -x 200 -y 50 <cmd>`.
    expect(newSession.at(-1)).toBe("pi-monitor-tui");
  });

  it("splits a right pane in when the existing session has only one", () => {
    sessionExistsMock.mockReturnValue(true);
    listPanesMock.mockReturnValue([
      // single pane in monitor:0
      // biome-ignore lint/suspicious/noExplicitAny: minimal pane shape for the test
      { session: "monitor", windowIndex: 0, paneIndex: 0, paneId: "%1" } as any,
    ]);
    ensureMonitorSession();
    const cmds = tmuxRunMock.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(cmds).toContain("split-window");
  });

  it("disables pane-border-status on the monitor window in every setup path", () => {
    // Three branches set up the monitor session (fresh, 1-pane,
    // 2+ pane); all three must apply the window override so a
    // user's `set -g pane-border-status top` doesn't leak through
    // and draw a redundant top-border above the right pane.

    // Branch 1: session doesn't exist (fresh create).
    sessionExistsMock.mockReturnValue(false);
    ensureMonitorSession();
    const freshCmds = tmuxRunMock.mock.calls.map((c) => (c[0] as string[]).slice(0, 5));
    expect(freshCmds).toContainEqual([
      "set-window-option",
      "-t",
      "monitor:0",
      "pane-border-status",
      "off",
    ]);

    // Branch 2: session exists with 1 pane (legacy layout).
    tmuxRunMock.mockClear();
    sessionExistsMock.mockReturnValue(true);
    listPanesMock.mockReturnValue([
      // biome-ignore lint/suspicious/noExplicitAny: minimal pane shape for the test
      { session: "monitor", windowIndex: 0, paneIndex: 0, paneId: "%1" } as any,
    ]);
    ensureMonitorSession();
    const onePaneCmds = tmuxRunMock.mock.calls.map((c) =>
      (c[0] as string[]).slice(0, 5),
    );
    expect(onePaneCmds).toContainEqual([
      "set-window-option",
      "-t",
      "monitor:0",
      "pane-border-status",
      "off",
    ]);

    // Branch 3: session exists with 3 panes (extras to clean up).
    tmuxRunMock.mockClear();
    sessionExistsMock.mockReturnValue(true);
    listPanesMock.mockReturnValue([
      // biome-ignore lint/suspicious/noExplicitAny: minimal pane shape
      { session: "monitor", windowIndex: 0, paneIndex: 0, paneId: "%1" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal pane shape
      { session: "monitor", windowIndex: 0, paneIndex: 1, paneId: "%2" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal pane shape
      { session: "monitor", windowIndex: 0, paneIndex: 2, paneId: "%3" } as any,
    ]);
    ensureMonitorSession();
    const manyPaneCmds = tmuxRunMock.mock.calls.map((c) =>
      (c[0] as string[]).slice(0, 5),
    );
    expect(manyPaneCmds).toContainEqual([
      "set-window-option",
      "-t",
      "monitor:0",
      "pane-border-status",
      "off",
    ]);
  });

  it("kills extras and resets the right slot when there are >2 panes", () => {
    sessionExistsMock.mockReturnValue(true);
    listPanesMock.mockReturnValue([
      // biome-ignore lint/suspicious/noExplicitAny: minimal pane shape
      { session: "monitor", windowIndex: 0, paneIndex: 0, paneId: "%1" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal pane shape
      { session: "monitor", windowIndex: 0, paneIndex: 1, paneId: "%2" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal pane shape
      { session: "monitor", windowIndex: 0, paneIndex: 2, paneId: "%3" } as any,
    ]);
    ensureMonitorSession();
    const cmds = tmuxRunMock.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(cmds).toContain("kill-pane");
    expect(cmds).toContain("respawn-pane"); // resetRightSlotToPlaceholder
  });
});

// ---------------------------------------------------------------------------
// killMonitorSession
// ---------------------------------------------------------------------------

describe("killMonitorSession", () => {
  it("kills the session when it exists", () => {
    sessionExistsMock.mockReturnValue(true);
    killMonitorSession();
    expect(tmuxRunMock).toHaveBeenCalledWith(["kill-session", "-t", "monitor"]);
  });

  it("is a no-op when the session is gone", () => {
    sessionExistsMock.mockReturnValue(false);
    killMonitorSession();
    expect(tmuxRunMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// attachRightSlotToViewer / resetRightSlotToPlaceholder
// ---------------------------------------------------------------------------

describe("attachRightSlotToViewer", () => {
  it("respawns the right slot with `tmux attach -t <viewer>`", () => {
    attachRightSlotToViewer("pi-monitor-view-foo");
    const args = tmuxRunMock.mock.calls[0]?.[0] as string[];
    expect(args[0]).toBe("respawn-pane");
    expect(args).toContain("-k");
    expect(args.at(-1)).toBe("env -u TMUX tmux attach -t pi-monitor-view-foo");
    // -t <RIGHT_SLOT> must be present.
    expect(args).toContain("monitor:0.1");
  });

  it("includes -c <cwd> when cwd is provided", () => {
    attachRightSlotToViewer("pi-monitor-view-foo", "/home/u/project");
    const args = tmuxRunMock.mock.calls[0]?.[0] as string[];
    expect(args).toContain("-c");
    expect(args).toContain("/home/u/project");
  });

  it("shell-quotes viewer names with special chars", () => {
    attachRightSlotToViewer("pi-monitor-view-with space");
    const args = tmuxRunMock.mock.calls[0]?.[0] as string[];
    const cmd = args.at(-1) as string;
    // The viewer name was wrapped in single quotes.
    expect(cmd).toContain("'pi-monitor-view-with space'");
  });
});

describe("resetRightSlotToPlaceholder", () => {
  it("respawns with the idle banner command", () => {
    resetRightSlotToPlaceholder();
    const args = tmuxRunMock.mock.calls[0]?.[0] as string[];
    expect(args[0]).toBe("respawn-pane");
    expect(args).toContain("-k");
    expect(args).toContain("monitor:0.1");
    // Banner contains the hint text.
    const last = args.at(-1) as string;
    expect(last).toContain("hover a pi row");
  });
});

// ---------------------------------------------------------------------------
// createPiSession / createPiWindow
// ---------------------------------------------------------------------------

describe("createPiSession", () => {
  it("rejects with TmuxError when cwd doesn't exist", () => {
    existsSyncMock.mockReturnValue(false);
    expect(() => createPiSession("/no/such/dir")).toThrow(TmuxError);
  });

  it("creates a new detached session when cwd is valid", () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({
      isDirectory: () => true,
    } as ReturnType<typeof statSync>);
    sessionExistsMock.mockReturnValue(false); // no collision

    const name = createPiSession("/home/u/project", "myname");
    expect(name).toBe("myname");
    expect(tmuxRunMock).toHaveBeenCalledWith([
      "new-session",
      "-d",
      "-s",
      "myname",
      "-c",
      "/home/u/project",
      "pi",
    ]);
  });

  it("auto-suggests a session name from the cwd basename when none given", () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({
      isDirectory: () => true,
    } as ReturnType<typeof statSync>);
    sessionExistsMock.mockReturnValue(false);

    const name = createPiSession("/home/u/project/");
    expect(name).toBe("project");
  });

  it("appends -2 / -3 ... when the suggested name collides", () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({
      isDirectory: () => true,
    } as ReturnType<typeof statSync>);
    // First two calls return true (project, project-2 exist), then false.
    sessionExistsMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const name = createPiSession("/home/u/project");
    expect(name).toBe("project-3");
  });

  it("rejects when an explicitly-named session already exists", () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({
      isDirectory: () => true,
    } as ReturnType<typeof statSync>);
    sessionExistsMock.mockReturnValue(true);
    expect(() => createPiSession("/home/u/project", "taken")).toThrow(TmuxError);
  });
});

describe("createPiWindow", () => {
  it("rejects with TmuxError when cwd doesn't exist", () => {
    existsSyncMock.mockReturnValue(false);
    expect(() => createPiWindow("session", "/missing")).toThrow(TmuxError);
  });

  it("calls new-window with -c <cwd> and pi", () => {
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({
      isDirectory: () => true,
    } as ReturnType<typeof statSync>);
    createPiWindow("contracts", "/home/u/c");
    expect(tmuxRunMock).toHaveBeenCalledWith([
      "new-window",
      "-t",
      "contracts",
      "-c",
      "/home/u/c",
      "pi",
    ]);
  });
});

// ---------------------------------------------------------------------------
// setStatusWidget / clearStatusWidget
// ---------------------------------------------------------------------------

describe("setStatusWidget", () => {
  it("pushes via set-option -gq @pi-monitor-status", () => {
    setStatusWidget("hello");
    expect(tmuxRunMock).toHaveBeenCalledWith([
      "set-option",
      "-gq",
      "@pi-monitor-status",
      "hello",
    ]);
  });

  it("swallows TmuxError so a transient outage doesn't crash the App", () => {
    tmuxRunMock.mockImplementation(() => {
      throw new TmuxError("no server");
    });
    expect(() => setStatusWidget("hello")).not.toThrow();
  });
});

describe("clearStatusWidget", () => {
  it("pushes an empty string", () => {
    clearStatusWidget();
    expect(tmuxRunMock).toHaveBeenCalledWith([
      "set-option",
      "-gq",
      "@pi-monitor-status",
      "",
    ]);
  });
});
