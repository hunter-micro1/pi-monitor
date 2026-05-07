/**
 * Render the App with a representative fixture and dump the frame.
 * Used to look at the current UI without launching tmux.
 */

import { render } from "ink-testing-library";
import { createElement } from "react";
import type { PaneStatus } from "../src/state/types.js";
import { App, type AppEntry } from "../src/tui/App.js";

function status(fields: Partial<PaneStatus> = {}): PaneStatus {
	return {
		paneId: fields.paneId ?? "%1",
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

const fixtures: AppEntry[] = [
	entry({
		paneId: "%1",
		session: "contracts",
		paneTitle: "PSP7-gateway",
		cwd: "/home/u/contracts",
		status: status({
			paneId: "%1",
			state: "working",
			phase: "tool_running",
			currentTool: "bash",
		}),
	}),
	entry({
		paneId: "%2",
		session: "contracts",
		paneTitle: "POWERBI",
		cwd: "/home/u/contracts/billing",
		paneIndex: 1,
		status: status({
			paneId: "%2",
			state: "idle",
			idleSeconds: 12,
			snapshot: {
				mtime: 0,
				lastRole: "assistant",
				lastStopReason: null,
				lastError: null,
				pendingToolCalls: 0,
				lastAssistantPreview:
					"All four browser themes are aligned to the new design tokens.",
			},
		}),
	}),
	entry({
		paneId: "%3",
		session: "cape",
		paneTitle: "ANALYST",
		cwd: "/home/u/cape",
		status: status({
			paneId: "%3",
			state: "error",
			idleSeconds: 12,
			snapshot: {
				mtime: 0,
				lastRole: "assistant",
				lastStopReason: null,
				lastError: "ECONNRESET reading model stream",
				pendingToolCalls: 0,
				lastAssistantPreview: null,
			},
		}),
	}),
];

const { lastFrame } = render(
	createElement(App, {
		getEntries: () => fixtures,
		branchForCwd: (cwd: string) =>
			cwd.includes("billing")
				? "feature/billing"
				: cwd.includes("cape")
					? "main"
					: "feature/auth",
		pollIntervalMs: 9999,
		pulseIntervalMs: 9999,
		notificationsEnabled: false,
	}),
);

setTimeout(() => {
	process.stdout.write(`${lastFrame() ?? ""}\n`);
	process.exit(0);
}, 100);
