/**
 * TmuxBridge tests. Mocks the tmux/* module surface so we can pin
 * the call sequence without subprocesses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/tmux/client.js", () => ({
  TmuxError: class TmuxError extends Error {},
  tmuxRun: vi.fn(),
  serverRunning: vi.fn(),
  sessionExists: vi.fn(),
}));

vi.mock("../../src/tmux/monitor.js", () => ({
  attachRightSlotToViewer: vi.fn(),
  focusRightSlot: vi.fn(),
  killMonitorSession: vi.fn(),
  resetRightSlotToPlaceholder: vi.fn(),
}));

vi.mock("../../src/tmux/viewer.js", () => ({
  cleanupOrphanViewers: vi.fn(),
  ensureLinkedViewer: vi.fn(),
  killLinkedViewer: vi.fn(),
  viewerFocusPane: vi.fn(),
  viewerZoomToPane: vi.fn(),
}));

import { TmuxError } from "../../src/tmux/client.js";
import {
  attachRightSlotToViewer,
  focusRightSlot,
  killMonitorSession,
  resetRightSlotToPlaceholder,
} from "../../src/tmux/monitor.js";
import {
  cleanupOrphanViewers,
  ensureLinkedViewer,
  killLinkedViewer,
  viewerFocusPane,
  viewerZoomToPane,
} from "../../src/tmux/viewer.js";
import { makeTmuxBridge } from "../../src/tui/tmuxBridge.js";

const ensureLinkedViewerMock = vi.mocked(ensureLinkedViewer);
const viewerFocusPaneMock = vi.mocked(viewerFocusPane);
const viewerZoomToPaneMock = vi.mocked(viewerZoomToPane);
const attachRightSlotMock = vi.mocked(attachRightSlotToViewer);
const killLinkedViewerMock = vi.mocked(killLinkedViewer);
const focusRightSlotMock = vi.mocked(focusRightSlot);
const resetPlaceholderMock = vi.mocked(resetRightSlotToPlaceholder);
const cleanupOrphanViewersMock = vi.mocked(cleanupOrphanViewers);
const killMonitorSessionMock = vi.mocked(killMonitorSession);

beforeEach(() => {
  vi.clearAllMocks();
  ensureLinkedViewerMock.mockImplementation(
    (source: string) => `pi-monitor-view-${source}`,
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("makeTmuxBridge", () => {
  describe("onPaneCursor", () => {
    it("ensures viewer + focuses + zooms + attaches right slot on first call", () => {
      const bridge = makeTmuxBridge();
      bridge.onPaneCursor({
        session: "contracts",
        windowIndex: 0,
        paneIndex: 1,
        cwd: "/home/u/c",
      });
      expect(ensureLinkedViewerMock).toHaveBeenCalledWith("contracts");
      expect(viewerFocusPaneMock).toHaveBeenCalledWith(
        "pi-monitor-view-contracts",
        0,
        1,
      );
      expect(viewerZoomToPaneMock).toHaveBeenCalledWith(
        "pi-monitor-view-contracts",
        0,
        1,
      );
      expect(attachRightSlotMock).toHaveBeenCalledWith(
        "pi-monitor-view-contracts",
        "/home/u/c",
      );
      expect(killLinkedViewerMock).not.toHaveBeenCalled();
    });

    it("is idempotent on the same target (no second attach)", () => {
      const bridge = makeTmuxBridge();
      const t = {
        session: "contracts",
        windowIndex: 0,
        paneIndex: 1,
        cwd: "/x",
      };
      bridge.onPaneCursor(t);
      bridge.onPaneCursor(t);
      expect(attachRightSlotMock).toHaveBeenCalledTimes(1);
      expect(viewerFocusPaneMock).toHaveBeenCalledTimes(1);
    });

    it("attaches new viewer + kills old one when source session changes", () => {
      const bridge = makeTmuxBridge();
      bridge.onPaneCursor({
        session: "alpha",
        windowIndex: 0,
        paneIndex: 0,
        cwd: "/a",
      });
      bridge.onPaneCursor({
        session: "beta",
        windowIndex: 0,
        paneIndex: 0,
        cwd: "/b",
      });
      expect(attachRightSlotMock).toHaveBeenCalledTimes(2);
      expect(attachRightSlotMock).toHaveBeenLastCalledWith(
        "pi-monitor-view-beta",
        "/b",
      );
      expect(killLinkedViewerMock).toHaveBeenCalledWith("pi-monitor-view-alpha");
    });

    it("re-focuses + re-zooms on a different pane in the same session", () => {
      const bridge = makeTmuxBridge();
      bridge.onPaneCursor({
        session: "alpha",
        windowIndex: 0,
        paneIndex: 0,
        cwd: "/a",
      });
      bridge.onPaneCursor({
        session: "alpha",
        windowIndex: 1,
        paneIndex: 2,
        cwd: "/a",
      });
      expect(viewerFocusPaneMock).toHaveBeenCalledTimes(2);
      expect(viewerFocusPaneMock).toHaveBeenLastCalledWith(
        "pi-monitor-view-alpha",
        1,
        2,
      );
      // Same viewer, no second attach + no kill.
      expect(attachRightSlotMock).toHaveBeenCalledTimes(1);
      expect(killLinkedViewerMock).not.toHaveBeenCalled();
    });

    it("threads a null cwd into attachRightSlotToViewer when not provided", () => {
      const bridge = makeTmuxBridge();
      bridge.onPaneCursor({
        session: "alpha",
        windowIndex: 0,
        paneIndex: 0,
        cwd: null,
      });
      expect(attachRightSlotMock).toHaveBeenCalledWith("pi-monitor-view-alpha", null);
    });

    it("swallows TmuxError without rethrowing", () => {
      ensureLinkedViewerMock.mockImplementation(() => {
        throw new TmuxError("no server");
      });
      const bridge = makeTmuxBridge();
      expect(() =>
        bridge.onPaneCursor({
          session: "x",
          windowIndex: 0,
          paneIndex: 0,
          cwd: null,
        }),
      ).not.toThrow();
    });
  });

  describe("onCursorAway", () => {
    it("is a no-op when nothing was attached", () => {
      const bridge = makeTmuxBridge();
      bridge.onCursorAway();
      expect(resetPlaceholderMock).not.toHaveBeenCalled();
      expect(killLinkedViewerMock).not.toHaveBeenCalled();
    });

    it("resets placeholder + kills the active viewer after a prior attach", () => {
      const bridge = makeTmuxBridge();
      bridge.onPaneCursor({
        session: "alpha",
        windowIndex: 0,
        paneIndex: 0,
        cwd: "/a",
      });
      bridge.onCursorAway();
      expect(resetPlaceholderMock).toHaveBeenCalledTimes(1);
      expect(killLinkedViewerMock).toHaveBeenCalledWith("pi-monitor-view-alpha");
    });

    it("clears state so the next onPaneCursor re-attaches", () => {
      const bridge = makeTmuxBridge();
      bridge.onPaneCursor({
        session: "alpha",
        windowIndex: 0,
        paneIndex: 0,
        cwd: "/a",
      });
      bridge.onCursorAway();
      bridge.onPaneCursor({
        session: "alpha",
        windowIndex: 0,
        paneIndex: 0,
        cwd: "/a",
      });
      expect(attachRightSlotMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("focusAgent", () => {
    it("is a no-op when nothing is attached", () => {
      const bridge = makeTmuxBridge();
      bridge.focusAgent();
      expect(focusRightSlotMock).not.toHaveBeenCalled();
    });

    it("calls focusRightSlot when a viewer is attached", () => {
      const bridge = makeTmuxBridge();
      bridge.onPaneCursor({
        session: "alpha",
        windowIndex: 0,
        paneIndex: 0,
        cwd: null,
      });
      bridge.focusAgent();
      expect(focusRightSlotMock).toHaveBeenCalledTimes(1);
    });

    it("swallows TmuxError on focus failure", () => {
      focusRightSlotMock.mockImplementation(() => {
        throw new TmuxError("pane vanished");
      });
      const bridge = makeTmuxBridge();
      bridge.onPaneCursor({
        session: "x",
        windowIndex: 0,
        paneIndex: 0,
        cwd: null,
      });
      expect(() => bridge.focusAgent()).not.toThrow();
    });
  });

  describe("shutdown", () => {
    it("calls cleanupOrphanViewers + killMonitorSession", () => {
      const bridge = makeTmuxBridge();
      bridge.shutdown();
      expect(cleanupOrphanViewersMock).toHaveBeenCalledTimes(1);
      expect(killMonitorSessionMock).toHaveBeenCalledTimes(1);
    });

    it("survives a TmuxError from either step", () => {
      cleanupOrphanViewersMock.mockImplementation(() => {
        throw new TmuxError("first");
      });
      killMonitorSessionMock.mockImplementation(() => {
        throw new TmuxError("second");
      });
      const bridge = makeTmuxBridge();
      expect(() => bridge.shutdown()).not.toThrow();
      // Both still attempted.
      expect(cleanupOrphanViewersMock).toHaveBeenCalled();
      expect(killMonitorSessionMock).toHaveBeenCalled();
    });
  });
});
