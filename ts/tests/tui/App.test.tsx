/**
 * App integration tests. Drives the live tick loop with real timers
 * + injected getEntries; exercises cursor + render through stdin
 * keystrokes.
 *
 * Vi fake timers tangled with Ink's useEffect-based listener
 * registration (data-event handlers don't fire reliably under
 * fake-timer microtask flushing). Real timers + short
 * pollIntervalMs + a tiny `wait()` helper is the simpler path and
 * keeps the suite under a few hundred ms.
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import type { PaneStatus } from "../../src/state/types.js";
import { App, type AppEntry, groupBySession } from "../../src/tui/App.js";

function status(fields: Partial<PaneStatus> = {}): PaneStatus {
  return {
    paneId: "x",
    state: "idle",
    sessionFile: null,
    snapshot: null,
    idleSeconds: 0,
    phase: null,
    currentTool: null,
    retryAttempt: 0,
    ...fields,
  };
}

function entry(fields: Partial<AppEntry> = {}): AppEntry {
  return {
    paneId: fields.paneId ?? "%1",
    session: fields.session ?? "main",
    windowIndex: fields.windowIndex ?? 0,
    paneIndex: fields.paneIndex ?? 0,
    paneTitle: fields.paneTitle ?? "agent",
    cwd: fields.cwd ?? "/x",
    status: fields.status ?? status(),
  };
}

async function wait(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("groupBySession", () => {
  it("buckets entries by session in first-seen order", () => {
    const result = groupBySession([
      entry({ paneId: "%1", session: "main" }),
      entry({ paneId: "%2", session: "contracts" }),
      entry({ paneId: "%3", session: "main" }),
    ]);
    expect(result.map((g) => g.session)).toEqual(["main", "contracts"]);
    expect(result[0]?.items.map((e) => e.paneId)).toEqual(["%1", "%3"]);
    expect(result[1]?.items.map((e) => e.paneId)).toEqual(["%2"]);
  });

  it("returns [] for empty input", () => {
    expect(groupBySession([])).toEqual([]);
  });
});

describe("App render", () => {
  it("fills the pane height so the bottom details box pins to the literal bottom", async () => {
    // ink-testing-library's Stdout reports columns=100 and no rows,
    // so the App falls back to 24-row height. We assert the frame
    // is exactly 24 lines tall — if the height prop ever stops
    // being applied, the frame collapses to its natural content
    // height (~10 rows in empty state) and this test catches it.
    const { lastFrame } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    const out = lastFrame() ?? "";
    // Trailing newline strip parity: split on \n, drop a final empty
    // entry if the frame ended in a newline.
    const lines = out.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    expect(lines.length).toBe(24);
  });

  it("renders the empty-state welcome when there are no entries", async () => {
    const { lastFrame } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    const out = lastFrame() ?? "";
    expect(out).toContain("pi-monitor");
    expect(out).toContain("+ new pi session");
    expect(out).toContain("No pi sessions yet");
  });

  it("renders one SessionGroup per session with its panes", async () => {
    const entries = [
      entry({ paneId: "%1", session: "main", paneTitle: "agent-a" }),
      entry({ paneId: "%2", session: "main", paneTitle: "agent-b" }),
      entry({ paneId: "%3", session: "contracts", paneTitle: "lawyer" }),
    ];
    const { lastFrame } = render(
      <App
        getEntries={() => entries}
        branchForCwd={() => "main"}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    const out = lastFrame() ?? "";
    expect(out).toContain("main");
    expect(out).toContain("contracts");
    expect(out).toContain("agent-a");
    expect(out).toContain("agent-b");
    expect(out).toContain("lawyer");
    // Empty-state hidden when entries exist.
    expect(out).not.toContain("No pi sessions yet");
  });

  it("calls onQuit when the user presses q", async () => {
    const onQuit = vi.fn();
    const { stdin } = render(
      <App
        getEntries={() => []}
        onQuit={onQuit}
        branchForCwd={() => null}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("q");
    await wait();
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it("calls onQuit on Ctrl-C", async () => {
    const onQuit = vi.fn();
    const { stdin } = render(
      <App
        getEntries={() => []}
        onQuit={onQuit}
        branchForCwd={() => null}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("\u0003");
    await wait();
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it("polls getEntries on the configured interval", async () => {
    let calls = 0;
    const get = (): AppEntry[] => {
      calls += 1;
      return [];
    };
    render(
      <App
        getEntries={get}
        branchForCwd={() => null}
        pollIntervalMs={30}
        pulseIntervalMs={9999}
      />,
    );
    // First call happens on mount; subsequent calls at the interval
    // cadence. ~150ms = mount + ~4 intervals.
    await wait(150);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("re-reads entries on each poll tick", async () => {
    let phase = 0;
    const get = (): AppEntry[] => {
      phase += 1;
      if (phase === 1) {
        return [entry({ paneId: "%1", paneTitle: "first" })];
      }
      return [
        entry({ paneId: "%1", paneTitle: "first" }),
        entry({ paneId: "%2", paneTitle: "second" }),
      ];
    };
    const { lastFrame } = render(
      <App
        getEntries={get}
        branchForCwd={() => null}
        pollIntervalMs={30}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    expect(lastFrame() ?? "").toContain("first");
    await wait(60);
    const out = lastFrame() ?? "";
    expect(out).toContain("first");
    expect(out).toContain("second");
  });

  it("swallows getEntries errors without crashing", async () => {
    const get = vi.fn(() => {
      throw new Error("boom");
    });
    const { lastFrame } = render(
      <App
        getEntries={get}
        branchForCwd={() => null}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    // Render didn't crash; we still see the chrome.
    expect(lastFrame() ?? "").toContain("pi-monitor");
  });

  it("threads workingColor into PaneRow on each pulse tick", async () => {
    const entries = [
      entry({
        paneId: "%1",
        status: status({
          state: "working",
          phase: "tool_running",
          currentTool: "bash",
        }),
      }),
    ];
    const { lastFrame } = render(
      <App
        getEntries={() => entries}
        branchForCwd={() => "main"}
        pollIntervalMs={9999}
        pulseIntervalMs={80}
      />,
    );
    await wait();
    expect(lastFrame() ?? "").toContain("running bash");
    // Let the pulse fire a couple of times; should still render fine.
    await wait(50);
    expect(lastFrame() ?? "").toContain("running bash");
  });
});

describe("App modal mode", () => {
  it("opens HelpScreen when the user presses ?", async () => {
    const { stdin, lastFrame } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("?");
    await wait();
    const out = lastFrame() ?? "";
    expect(out).toContain("keybindings");
    expect(out).toContain("press any key to dismiss");
  });

  it("closes HelpScreen on any keystroke", async () => {
    const { stdin, lastFrame } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("?");
    await wait();
    // 'press any key to dismiss' is unique to HelpScreen.
    expect(lastFrame() ?? "").toContain("press any key to dismiss");
    stdin.write("x");
    await wait();
    expect(lastFrame() ?? "").not.toContain("press any key to dismiss");
  });

  it("keeps the pane list visible behind the new-pi popup (popup, not full-screen modal)", async () => {
    // Regression-guard for the 'inline vs hover menu' user
    // report: pressing 'o' must NOT replace the App tree. The
    // titlebar + section header + pane row stay rendered while
    // the popup is up.
    const { stdin, lastFrame } = render(
      <App
        getEntries={() => [
          entry({
            paneId: "%1",
            session: "alpha",
            paneTitle: "agent-a",
          }),
        ]}
        branchForCwd={() => null}
        defaultCwd="/home/u"
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("o");
    await wait();
    const out = lastFrame() ?? "";
    // Popup is open.
    expect(out).toContain("Launch pi in a new");
    // Pane list is still rendered above it.
    expect(out).toContain("alpha");
    expect(out).toContain("agent-a");
    // TitleBar + footer are still rendered.
    expect(out).toContain("pi-monitor");
    expect(out).toContain("q");
    expect(out).toContain("quit");
  });

  it("opens NewPiScreen in 'session' mode when 'o' is pressed and no panes exist", async () => {
    const { stdin, lastFrame } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        defaultCwd="/home/u"
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("o");
    await wait();
    expect(lastFrame() ?? "").toContain("Launch pi in a new tmux session");
  });

  it("opens NewPiScreen in 'window' mode when 'o' is pressed on a pane row", async () => {
    const { stdin, lastFrame } = render(
      <App
        getEntries={() => [entry({ paneId: "%1" })]}
        branchForCwd={() => null}
        defaultCwd="/home/u"
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    // First pane is auto-focused on first sync.
    stdin.write("o");
    await wait();
    expect(lastFrame() ?? "").toContain("Launch pi in a new window (current session)");
  });

  it("calls onLaunchPi and returns to list when NewPiScreen submits", async () => {
    const onLaunchPi = vi.fn();
    const { stdin, lastFrame } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        defaultCwd="/home/u"
        onLaunchPi={onLaunchPi}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("o");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onLaunchPi).toHaveBeenCalledWith({
      mode: "session",
      cwd: "/home/u",
    });
    // Back on the list.
    expect(lastFrame() ?? "").not.toContain("Launch pi in a new");
  });

  it("returns to list mode without calling onLaunchPi when NewPiScreen is cancelled", async () => {
    const onLaunchPi = vi.fn();
    const { stdin, lastFrame } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        defaultCwd="/home/u"
        onLaunchPi={onLaunchPi}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("o");
    await wait();
    stdin.write("\u001b");
    await wait();
    expect(onLaunchPi).not.toHaveBeenCalled();
    expect(lastFrame() ?? "").not.toContain("Launch pi in a new");
  });
});

describe("App tmux bridge", () => {
  function makeMockBridge() {
    return {
      onPaneCursor: vi.fn(),
      onCursorAway: vi.fn(),
      focusAgent: vi.fn(),
      shutdown: vi.fn(),
    };
  }

  it("calls onPaneCursor on first sync (auto-focus on first pane)", async () => {
    const tmux = makeMockBridge();
    render(
      <App
        getEntries={() => [
          entry({
            paneId: "%1",
            session: "alpha",
            windowIndex: 0,
            paneIndex: 1,
            cwd: "/a",
          }),
        ]}
        branchForCwd={() => null}
        tmux={tmux}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    expect(tmux.onPaneCursor).toHaveBeenCalledWith({
      session: "alpha",
      windowIndex: 0,
      paneIndex: 1,
      cwd: "/a",
    });
  });

  it("calls onCursorAway when there are no panes", async () => {
    const tmux = makeMockBridge();
    render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        tmux={tmux}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    expect(tmux.onCursorAway).toHaveBeenCalled();
    expect(tmux.onPaneCursor).not.toHaveBeenCalled();
  });

  it("calls onPaneCursor again when cursor moves to a different pane", async () => {
    const tmux = makeMockBridge();
    const entries = [
      entry({ paneId: "%1", session: "a", windowIndex: 0, paneIndex: 0 }),
      entry({ paneId: "%2", session: "b", windowIndex: 0, paneIndex: 0 }),
    ];
    const { stdin } = render(
      <App
        getEntries={() => entries}
        branchForCwd={() => null}
        tmux={tmux}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("j");
    await wait();
    // Two distinct calls: initial auto-focus + j move.
    expect(tmux.onPaneCursor).toHaveBeenCalledTimes(2);
    expect(tmux.onPaneCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ session: "b" }),
    );
  });

  it("calls onCursorAway when cursor moves up to the new-row affordance", async () => {
    const tmux = makeMockBridge();
    const { stdin } = render(
      <App
        getEntries={() => [entry({ paneId: "%1" })]}
        branchForCwd={() => null}
        tmux={tmux}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    // k moves up from the auto-focused first pane to "+ new".
    stdin.write("k");
    await wait();
    expect(tmux.onCursorAway).toHaveBeenCalled();
  });

  it("calls focusAgent on Enter when cursor is on a pane", async () => {
    const tmux = makeMockBridge();
    const { stdin } = render(
      <App
        getEntries={() => [entry({ paneId: "%1" })]}
        branchForCwd={() => null}
        tmux={tmux}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(tmux.focusAgent).toHaveBeenCalled();
  });

  it("calls focusAgent on Tab when cursor is on a pane", async () => {
    const tmux = makeMockBridge();
    const { stdin } = render(
      <App
        getEntries={() => [entry({ paneId: "%1" })]}
        branchForCwd={() => null}
        tmux={tmux}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("\t");
    await wait();
    expect(tmux.focusAgent).toHaveBeenCalled();
  });

  it("does NOT call focusAgent on Enter when cursor is on the new row", async () => {
    const tmux = makeMockBridge();
    const { stdin } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        tmux={tmux}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(tmux.focusAgent).not.toHaveBeenCalled();
  });

  it("calls shutdown on q quit", async () => {
    const tmux = makeMockBridge();
    const onQuit = vi.fn();
    const { stdin } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        tmux={tmux}
        onQuit={onQuit}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("q");
    await wait();
    expect(tmux.shutdown).toHaveBeenCalled();
    expect(onQuit).toHaveBeenCalled();
  });
});

describe("App new-pi targetSession", () => {
  it("session mode submits without targetSession", async () => {
    const onLaunchPi = vi.fn();
    const { stdin } = render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        defaultCwd="/home/u"
        onLaunchPi={onLaunchPi}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("o");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onLaunchPi).toHaveBeenCalledWith({
      mode: "session",
      cwd: "/home/u",
    });
    // targetSession field is absent on session-mode submissions.
    expect(onLaunchPi.mock.calls[0]?.[0]).not.toHaveProperty("targetSession");
  });

  it("window mode carries targetSession from the cursored pane", async () => {
    const onLaunchPi = vi.fn();
    const entries = [
      entry({
        paneId: "%1",
        session: "alpha",
        cwd: "/home/u/proj",
      }),
    ];
    const { stdin } = render(
      <App
        getEntries={() => entries}
        branchForCwd={() => null}
        defaultCwd="/home/u"
        onLaunchPi={onLaunchPi}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    // Cursor is auto-focused on the first pane => 'o' opens window mode.
    stdin.write("o");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onLaunchPi).toHaveBeenCalledWith({
      mode: "window",
      cwd: "/home/u/proj",
      targetSession: "alpha",
    });
  });

  it("window mode pre-fills the modal with the pane's cwd, not defaultCwd", async () => {
    const entries = [
      entry({
        paneId: "%1",
        session: "alpha",
        cwd: "/home/u/proj",
      }),
    ];
    const { stdin, lastFrame } = render(
      <App
        getEntries={() => entries}
        branchForCwd={() => null}
        defaultCwd="/different/place"
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    stdin.write("o");
    await wait();
    const out = lastFrame() ?? "";
    expect(out).toContain("/home/u/proj");
    expect(out).not.toContain("/different/place");
  });
});

describe("App status widget", () => {
  it("calls setStatusWidget on first sync with the formatted summary", async () => {
    const setStatusWidget = vi.fn();
    const entries = [
      entry({ paneId: "%1", status: status({ state: "working" }) }),
      entry({ paneId: "%2", status: status({ state: "idle" }) }),
    ];
    render(
      <App
        getEntries={() => entries}
        branchForCwd={() => null}
        setStatusWidget={setStatusWidget}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    expect(setStatusWidget).toHaveBeenCalled();
    const last = setStatusWidget.mock.calls.at(-1)?.[0] as string;
    // Order: idle before working (priority lattice).
    expect(last).toContain("1");
    expect(last).toMatch(/🔴|🟢/);
  });

  it("calls setStatusWidget with empty string when no panes", async () => {
    const setStatusWidget = vi.fn();
    render(
      <App
        getEntries={() => []}
        branchForCwd={() => null}
        setStatusWidget={setStatusWidget}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    expect(setStatusWidget).toHaveBeenCalledWith("");
  });

  it("re-emits setStatusWidget on every poll tick", async () => {
    const setStatusWidget = vi.fn();
    let phase = 0;
    const get = (): AppEntry[] => {
      phase += 1;
      if (phase === 1) {
        return [entry({ paneId: "%1", status: status({ state: "idle" }) })];
      }
      return [
        entry({ paneId: "%1", status: status({ state: "idle" }) }),
        entry({ paneId: "%2", status: status({ state: "error" }) }),
      ];
    };
    render(
      <App
        getEntries={get}
        branchForCwd={() => null}
        setStatusWidget={setStatusWidget}
        pollIntervalMs={30}
        pulseIntervalMs={9999}
      />,
    );
    await wait();
    const before = setStatusWidget.mock.calls.length;
    await wait(60);
    const after = setStatusWidget.mock.calls.length;
    expect(after).toBeGreaterThan(before);
    // Last call now contains the new error count.
    const last = setStatusWidget.mock.calls.at(-1)?.[0] as string;
    expect(last).toContain("❌1");
  });
});

describe("App notification banner", () => {
  it("does not render a banner before any state transitions", async () => {
    const { lastFrame } = render(
      <App
        getEntries={() => [
          entry({ paneId: "%1", status: status({ state: "working" }) }),
        ]}
        branchForCwd={() => null}
        pollIntervalMs={9999}
        pulseIntervalMs={9999}
        notificationDismissMs={9999}
      />,
    );
    await wait();
    // No banner; just the chrome.
    expect(lastFrame() ?? "").not.toContain("agent state:");
  });

  it("shows a banner when a pane transitions to idle", async () => {
    let phase = 0;
    const get = (): AppEntry[] => {
      phase += 1;
      const state = phase === 1 ? "working" : "idle";
      return [entry({ paneId: "%1", status: status({ state }) })];
    };
    const { lastFrame } = render(
      <App
        getEntries={get}
        branchForCwd={() => null}
        pollIntervalMs={30}
        pulseIntervalMs={9999}
        notificationDismissMs={9999}
      />,
    );
    await wait();
    // First tick: working. No banner.
    expect(lastFrame() ?? "").not.toContain("agent state: idle");
    await wait(60);
    // Second tick: idle. Banner now visible.
    const out = lastFrame() ?? "";
    expect(out).toContain("agent state: idle");
    expect(out).toContain("%1");
  });

  it("auto-dismisses the banner after notificationDismissMs", async () => {
    let phase = 0;
    const get = (): AppEntry[] => {
      phase += 1;
      const state = phase === 1 ? "working" : "idle";
      return [entry({ paneId: "%1", status: status({ state }) })];
    };
    const { lastFrame } = render(
      <App
        getEntries={get}
        branchForCwd={() => null}
        pollIntervalMs={30}
        pulseIntervalMs={9999}
        notificationDismissMs={50}
      />,
    );
    await wait(60);
    // Banner is up.
    expect(lastFrame() ?? "").toContain("agent state: idle");
    // Wait long enough for the dismiss timer.
    await wait(80);
    expect(lastFrame() ?? "").not.toContain("agent state: idle");
  });

  it("does not show a banner when notificationsEnabled is false", async () => {
    let phase = 0;
    const get = (): AppEntry[] => {
      phase += 1;
      const state = phase === 1 ? "working" : "idle";
      return [entry({ paneId: "%1", status: status({ state }) })];
    };
    const { lastFrame } = render(
      <App
        getEntries={get}
        branchForCwd={() => null}
        pollIntervalMs={30}
        pulseIntervalMs={9999}
        notificationsEnabled={false}
        notificationDismissMs={9999}
      />,
    );
    await wait(60);
    // No banner despite the transition.
    expect(lastFrame() ?? "").not.toContain("agent state: idle");
  });
});
