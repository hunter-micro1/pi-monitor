/**
 * Pane discovery tests.
 *
 * Mocks `tmux/client.ts` so we don't shell out to a real tmux,
 * and `proc/index.ts` so the proc-tree-walk fallback used by
 * `isPi` is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/tmux/client.js", () => ({
  TmuxError: class TmuxError extends Error {},
  tmuxRun: vi.fn(),
  serverRunning: vi.fn(),
  sessionExists: vi.fn(),
}));

vi.mock("../../src/proc/index.js", () => ({
  findPiPidForPane: vi.fn(() => null),
  procStartTime: vi.fn(() => null),
  procCwd: vi.fn(() => null),
}));

import { findPiPidForPane } from "../../src/proc/index.js";
import { TmuxError, tmuxRun } from "../../src/tmux/client.js";
import { isViewerSession, listPanes, listPiPanes } from "../../src/tmux/panes.js";

const tmuxRunMock = vi.mocked(tmuxRun);
const findPiPidForPaneMock = vi.mocked(findPiPidForPane);

beforeEach(() => {
  tmuxRunMock.mockReset();
  // Default: no pi descendants. Individual tests override with
  // mockImplementation when they need the macOS fallback path.
  findPiPidForPaneMock.mockReset();
  findPiPidForPaneMock.mockReturnValue(null);
});

afterEach(() => {
  tmuxRunMock.mockReset();
  findPiPidForPaneMock.mockReset();
});

/**
 * Build a fake `tmux list-panes -F` line with the field order our
 * format string expects: pane_id \t session \t window \t pane_idx
 *  \t pid \t cwd \t title \t command.
 */
function fakeLine(args: {
  paneId?: string;
  session?: string;
  window?: number;
  paneIdx?: number;
  pid?: number;
  cwd?: string;
  title?: string;
  command?: string;
}): string {
  return [
    args.paneId ?? "%1",
    args.session ?? "main",
    String(args.window ?? 0),
    String(args.paneIdx ?? 0),
    String(args.pid ?? 1234),
    args.cwd ?? "/home/u",
    args.title ?? "",
    args.command ?? "zsh",
  ].join("\t");
}

// ---------------------------------------------------------------------------
// listPanes
// ---------------------------------------------------------------------------

describe("listPanes", () => {
  it("parses the standard tab-separated format into Pane records", () => {
    tmuxRunMock.mockReturnValue(
      `${[
        fakeLine({
          paneId: "%1",
          session: "main",
          window: 0,
          paneIdx: 0,
          pid: 4321,
          cwd: "/x",
          title: "agent",
          command: "pi",
        }),
        fakeLine({
          paneId: "%2",
          session: "main",
          window: 0,
          paneIdx: 1,
          pid: 4322,
          cwd: "/y",
          title: "shell",
          command: "zsh",
        }),
      ].join("\n")}\n`,
    );
    const panes = listPanes();
    expect(panes).toHaveLength(2);
    const first = panes[0] as (typeof panes)[number];
    expect(first.paneId).toBe("%1");
    expect(first.session).toBe("main");
    expect(first.windowIndex).toBe(0);
    expect(first.paneIndex).toBe(0);
    expect(first.pid).toBe(4321);
    expect(first.cwd).toBe("/x");
    expect(first.title).toBe("agent");
    expect(first.command).toBe("pi");
    expect(first.isPi).toBe(true);
    expect(first.target).toBe("main:0.0");
    const second = panes[1] as (typeof panes)[number];
    expect(second.isPi).toBe(false);
    expect(second.target).toBe("main:0.1");
  });

  it("skips lines that don't have exactly 8 tab-separated fields", () => {
    tmuxRunMock.mockReturnValue("only one column\n");
    expect(listPanes()).toEqual([]);
  });

  it("skips lines with non-integer numeric columns", () => {
    tmuxRunMock.mockReturnValue(
      `${["%1", "main", "x", "0", "1234", "/", "", "zsh"].join("\t")}\n`,
    );
    expect(listPanes()).toEqual([]);
  });

  it("handles an empty trailing line gracefully", () => {
    tmuxRunMock.mockReturnValue(`${fakeLine({ paneId: "%1" })}\n\n`);
    expect(listPanes()).toHaveLength(1);
  });

  it("returns [] when tmuxRun throws TmuxError (no server / no panes)", () => {
    tmuxRunMock.mockImplementation(() => {
      throw new TmuxError("no server");
    });
    expect(listPanes()).toEqual([]);
  });

  it("preserves cwd / title strings with embedded spaces", () => {
    tmuxRunMock.mockReturnValue(
      `${fakeLine({
        paneId: "%5",
        cwd: "/home/u/My Stuff/project",
        title: "long agent name here",
        command: "pi",
      })}\n`,
    );
    const [pane] = listPanes();
    expect(pane?.cwd).toBe("/home/u/My Stuff/project");
    expect(pane?.title).toBe("long agent name here");
  });

  it("flags pane as isPi via process-tree walk when tmux reports 'node' (macOS regression)", () => {
    // macOS bug: tmux's pane_current_command uses libproc and
    // returns the executable basename for Node-based binaries
    // (i.e. `node`, never `pi`). Without the tree-walk fallback,
    // every real pi pane on macOS is filtered out as not-pi and
    // the user sees an empty agent list.
    tmuxRunMock.mockReturnValue(
      `${[
        // shell-launched pi: pane PID is zsh, pi is a child.
        fakeLine({ paneId: "%1", pid: 86074, command: "node" }),
        // genuine no-pi shell pane.
        fakeLine({ paneId: "%2", pid: 87262, command: "zsh" }),
        // pane PID itself is pi.
        fakeLine({ paneId: "%3", pid: 86575, command: "node" }),
      ].join("\n")}\n`,
    );
    findPiPidForPaneMock.mockImplementation((pid: number) => {
      if (pid === 86074) return 86193; // descendant pi
      if (pid === 86575) return 86575; // pid itself is pi
      return null;
    });
    const panes = listPanes();
    expect(panes).toHaveLength(3);
    expect(panes[0]?.isPi).toBe(true);
    expect(panes[1]?.isPi).toBe(false);
    expect(panes[2]?.isPi).toBe(true);
  });

  it("skips the tree walk when tmux already reports command='pi' (Linux fast path)", () => {
    tmuxRunMock.mockReturnValue(`${fakeLine({ paneId: "%1", command: "pi" })}\n`);
    const panes = listPanes();
    expect(panes[0]?.isPi).toBe(true);
    // Fast path: don't even ask the proc resolver.
    expect(findPiPidForPaneMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listPiPanes
// ---------------------------------------------------------------------------

describe("listPiPanes", () => {
  it("filters to panes whose tree contains pi (incl. the macOS 'node' case)", () => {
    tmuxRunMock.mockReturnValue(
      `${[
        fakeLine({ paneId: "%1", pid: 100, command: "pi" }),
        fakeLine({ paneId: "%2", pid: 200, command: "zsh" }),
        fakeLine({ paneId: "%3", pid: 300, command: "node" }), // macOS pi
      ].join("\n")}\n`,
    );
    findPiPidForPaneMock.mockImplementation((pid: number) =>
      pid === 300 ? 301 : null,
    );
    const piOnly = listPiPanes();
    expect(piOnly.map((p) => p.paneId)).toEqual(["%1", "%3"]);
  });
});

// ---------------------------------------------------------------------------
// isViewerSession
// ---------------------------------------------------------------------------

describe("isViewerSession", () => {
  it("matches the pi-monitor-view- prefix exactly", () => {
    expect(isViewerSession("pi-monitor-view-foo")).toBe(true);
    expect(isViewerSession("pi-monitor-view-")).toBe(true);
  });

  it("rejects unrelated session names", () => {
    expect(isViewerSession("monitor")).toBe(false);
    expect(isViewerSession("foo")).toBe(false);
    expect(isViewerSession("")).toBe(false);
  });

  it("is case-sensitive (matches the Python helper)", () => {
    expect(isViewerSession("PI-MONITOR-VIEW-foo")).toBe(false);
  });
});
