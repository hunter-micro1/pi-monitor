/**
 * Linked-viewer flow tests.
 *
 * Mocks `tmux/client.ts` so we don't shell out. Each call to
 * `tmuxRun` is asserted on so we pin the exact tmux invocations
 * the higher-level App relies on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/tmux/client.js", () => ({
  TmuxError: class TmuxError extends Error {},
  tmuxRun: vi.fn(),
  serverRunning: vi.fn(),
  sessionExists: vi.fn(),
}));

import { TmuxError, sessionExists, tmuxRun } from "../../src/tmux/client.js";
import {
  cleanupOrphanViewers,
  ensureLinkedViewer,
  killLinkedViewer,
  viewerFocusPane,
  viewerSessionName,
  viewerZoomToPane,
} from "../../src/tmux/viewer.js";

const tmuxRunMock = vi.mocked(tmuxRun);
const sessionExistsMock = vi.mocked(sessionExists);

beforeEach(() => {
  tmuxRunMock.mockReset();
  sessionExistsMock.mockReset();
});

afterEach(() => {
  tmuxRunMock.mockReset();
  sessionExistsMock.mockReset();
});

// ---------------------------------------------------------------------------
// viewerSessionName
// ---------------------------------------------------------------------------

describe("viewerSessionName", () => {
  it("prefixes pi-monitor-view-", () => {
    expect(viewerSessionName("foo")).toBe("pi-monitor-view-foo");
  });

  it("escapes characters that aren't valid in tmux session names", () => {
    expect(viewerSessionName("a:b.c d")).toBe("pi-monitor-view-a-b-c-d");
  });
});

// ---------------------------------------------------------------------------
// ensureLinkedViewer
// ---------------------------------------------------------------------------

describe("ensureLinkedViewer", () => {
  it("returns the existing viewer name without spawning when it exists", () => {
    sessionExistsMock.mockReturnValue(true);
    const name = ensureLinkedViewer("contracts");
    expect(name).toBe("pi-monitor-view-contracts");
    expect(tmuxRunMock).not.toHaveBeenCalled();
  });

  it("creates a session-group sister and sets prefix + status off", () => {
    sessionExistsMock.mockReturnValue(false);
    const name = ensureLinkedViewer("contracts");
    expect(name).toBe("pi-monitor-view-contracts");
    expect(tmuxRunMock).toHaveBeenNthCalledWith(1, [
      "new-session",
      "-d",
      "-s",
      "pi-monitor-view-contracts",
      "-t",
      "contracts",
    ]);
    expect(tmuxRunMock).toHaveBeenNthCalledWith(2, [
      "set-option",
      "-t",
      "pi-monitor-view-contracts",
      "prefix",
      "C-a",
    ]);
    expect(tmuxRunMock).toHaveBeenNthCalledWith(3, [
      "set-option",
      "-t",
      "pi-monitor-view-contracts",
      "status",
      "off",
    ]);
  });

  it("survives when set-option prefix or status fails (old tmux)", () => {
    sessionExistsMock.mockReturnValue(false);
    tmuxRunMock.mockImplementation((args) => {
      if (args[0] === "set-option") {
        throw new TmuxError("unknown option");
      }
      return "";
    });
    expect(() => ensureLinkedViewer("contracts")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// killLinkedViewer
// ---------------------------------------------------------------------------

describe("killLinkedViewer", () => {
  it("calls kill-session when the viewer exists", () => {
    sessionExistsMock.mockReturnValue(true);
    killLinkedViewer("pi-monitor-view-x");
    expect(tmuxRunMock).toHaveBeenCalledWith([
      "kill-session",
      "-t",
      "pi-monitor-view-x",
    ]);
  });

  it("is a no-op when the viewer is already gone", () => {
    sessionExistsMock.mockReturnValue(false);
    killLinkedViewer("pi-monitor-view-x");
    expect(tmuxRunMock).not.toHaveBeenCalled();
  });

  it("swallows TmuxError on kill-session", () => {
    sessionExistsMock.mockReturnValue(true);
    tmuxRunMock.mockImplementation(() => {
      throw new TmuxError("session vanished");
    });
    expect(() => killLinkedViewer("pi-monitor-view-x")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphanViewers
// ---------------------------------------------------------------------------

describe("cleanupOrphanViewers", () => {
  it("kills every pi-monitor-view-* session in list-sessions output", () => {
    tmuxRunMock.mockImplementation((args) => {
      if (args[0] === "list-sessions") {
        return "monitor\npi-monitor-view-a\npi-monitor-view-b\nother\n";
      }
      return "";
    });
    cleanupOrphanViewers();

    const killCalls = tmuxRunMock.mock.calls.filter(
      (c) => (c[0] as string[])[0] === "kill-session",
    );
    expect(killCalls).toHaveLength(2);
    expect(killCalls.map((c) => (c[0] as string[])[2])).toEqual([
      "pi-monitor-view-a",
      "pi-monitor-view-b",
    ]);
  });

  it("does nothing when list-sessions throws (no server)", () => {
    tmuxRunMock.mockImplementation(() => {
      throw new TmuxError("no server");
    });
    expect(() => cleanupOrphanViewers()).not.toThrow();
  });

  it("survives a failing kill on a single session and keeps cleaning the rest", () => {
    let calls = 0;
    tmuxRunMock.mockImplementation((args) => {
      calls += 1;
      if (args[0] === "list-sessions") {
        return "pi-monitor-view-a\npi-monitor-view-b\n";
      }
      // Make the FIRST kill-session throw; the second should still
      // run.
      if (args[0] === "kill-session" && calls === 2) {
        throw new TmuxError("first kill failed");
      }
      return "";
    });
    expect(() => cleanupOrphanViewers()).not.toThrow();
    const killCalls = tmuxRunMock.mock.calls.filter(
      (c) => (c[0] as string[])[0] === "kill-session",
    );
    expect(killCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// viewerFocusPane
// ---------------------------------------------------------------------------

describe("viewerFocusPane", () => {
  it("calls select-window then select-pane", () => {
    viewerFocusPane("pi-monitor-view-x", 1, 2);
    expect(tmuxRunMock).toHaveBeenCalledWith([
      "select-window",
      "-t",
      "pi-monitor-view-x:1",
    ]);
    expect(tmuxRunMock).toHaveBeenCalledWith([
      "select-pane",
      "-t",
      "pi-monitor-view-x:1.2",
    ]);
  });

  it("aborts silently when select-window fails (window vanished)", () => {
    tmuxRunMock.mockImplementation((args) => {
      if (args[0] === "select-window") throw new TmuxError("no such window");
      return "";
    });
    expect(() => viewerFocusPane("pi-monitor-view-x", 1, 2)).not.toThrow();
    // select-pane should NOT have run.
    const paneCalls = tmuxRunMock.mock.calls.filter(
      (c) => (c[0] as string[])[0] === "select-pane",
    );
    expect(paneCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// viewerZoomToPane
// ---------------------------------------------------------------------------

describe("viewerZoomToPane", () => {
  it("does nothing when already zoomed on the target pane", () => {
    tmuxRunMock.mockImplementation((args) => {
      if (args[0] === "display-message") return "1,2";
      throw new Error(`unexpected: ${args.join(" ")}`);
    });
    viewerZoomToPane("v", 0, 2);
    // Only display-message was called \u2014 no select-pane / resize.
    const otherCalls = tmuxRunMock.mock.calls.filter(
      (c) => (c[0] as string[])[0] !== "display-message",
    );
    expect(otherCalls).toHaveLength(0);
  });

  it("unzooms then re-zooms when zoomed on the wrong pane", () => {
    let phase = 0;
    tmuxRunMock.mockImplementation((args) => {
      if (args[0] === "display-message") return "1,3"; // wrong pane
      phase += 1;
      return "";
    });
    viewerZoomToPane("v", 0, 2);
    // resize-pane -Z on the window (unzoom) + select-pane + resize-pane
    // -Z on the target pane.
    const resizeCalls = tmuxRunMock.mock.calls.filter(
      (c) => (c[0] as string[])[0] === "resize-pane",
    );
    expect(resizeCalls).toHaveLength(2);
    expect(phase).toBeGreaterThanOrEqual(2);
  });

  it("zooms when not zoomed yet", () => {
    tmuxRunMock.mockImplementation((args) => {
      if (args[0] === "display-message") return "0,0";
      return "";
    });
    viewerZoomToPane("v", 0, 2);
    expect(tmuxRunMock).toHaveBeenCalledWith(["select-pane", "-t", "v:0.2"]);
    expect(tmuxRunMock).toHaveBeenCalledWith(["resize-pane", "-Z", "-t", "v:0.2"]);
  });
});
