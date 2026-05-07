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
