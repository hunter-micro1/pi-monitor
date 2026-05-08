/**
 * pi-monitor CLI entry point.
 *
 * Behaviour mirrors `cli.py`:
 *   - Outside the monitor tmux session: create the session if
 *     needed (its left pane runs this same binary, which re-enters
 *     this CLI inside the monitor session and renders the TUI),
 *     run crash recovery, then `tmux switch-client` into the
 *     monitor session.
 *   - Inside the monitor tmux session: skip the bootstrap and run
 *     the TUI.
 *
 * No "no tmux at all" mode beyond a clear error \u2014 the whole tool
 * only makes sense inside tmux.
 *
 * tsup's `banner.js` injects the shebang at bundle time, so the
 * published `dist/cli.js` is executable.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const VERSION = "0.4.11";

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(helpText());
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-V")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (!hasTmuxOnPath()) {
    process.stderr.write("pi-monitor: tmux not found in PATH.\n");
    return 2;
  }

  // Late imports so --help / --version don't pay the React + Ink
  // cost (~50ms cold-start hit on small machines).
  const { serverRunning, TmuxError } = await import("./tmux/client.js");
  if (!serverRunning()) {
    process.stderr.write(
      "pi-monitor: no tmux server running. Start tmux first (e.g. `tmux new -s work`).\n",
    );
    return 2;
  }

  // --reset: nuke an existing 'monitor' session (typically left over
  // from a previous binary version) and any pi-monitor-view-*
  // viewers, then continue with the normal bootstrap. Useful after
  // upgrading the npm package -- the old monitor session would
  // otherwise keep its pane 0 running the previous binary.
  if (argv.includes("--reset")) {
    const { killMonitorSession } = await import("./tmux/monitor.js");
    const { cleanupOrphanViewers } = await import("./tmux/viewer.js");
    try {
      cleanupOrphanViewers();
      killMonitorSession();
    } catch (err) {
      if (!(err instanceof TmuxError)) throw err;
    }
  }

  if (insideMonitorSession()) {
    return await runTui();
  }
  return await bootstrapAndSwitch();
}

// ---------------------------------------------------------------------------
// Bootstrap path
// ---------------------------------------------------------------------------

async function bootstrapAndSwitch(): Promise<number> {
  const { TmuxError } = await import("./tmux/client.js");
  const { ensureMonitorSession, switchClientToMonitor } = await import(
    "./tmux/monitor.js"
  );

  try {
    ensureMonitorSession(selfInvocation());
    switchClientToMonitor();
    return 0;
  } catch (err) {
    if (err instanceof TmuxError) {
      process.stderr.write(`pi-monitor: tmux error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// TUI path
// ---------------------------------------------------------------------------

async function runTui(): Promise<number> {
  const [
    { render },
    { createElement },
    { App },
    { makeTmuxBridge },
    { listPanes, listPiPanes, isViewerSession },
    { StateResolver },
    { createPiSession, createPiWindow, setStatusWidget, clearStatusWidget },
  ] = await Promise.all([
    import("ink"),
    import("react"),
    import("./tui/App.js"),
    import("./tui/tmuxBridge.js"),
    import("./tmux/panes.js"),
    import("./state/resolver.js"),
    import("./tmux/monitor.js"),
  ]);

  // Avoid showing the monitor session's own panes in its own list.
  const ownPaneIds = collectMonitorPaneIds(listPanes);

  const resolver = new StateResolver();
  const tmux = makeTmuxBridge();

  const getEntries = () => {
    // Two filters:
    //   - ownPaneIds: panes living in the `monitor` session itself.
    //   - isViewerSession: tmux session-grouping makes the linked
    //     viewers (`pi-monitor-view-*`) report the same pi panes a
    //     second time under their viewer-session name. Suppress
    //     that duplicate so each pi pane appears in exactly one
    //     SessionGroup (its real session).
    const panes = listPiPanes().filter(
      (p) => !ownPaneIds.has(p.paneId) && !isViewerSession(p.session),
    );
    const refs = panes.map((p) => ({
      paneId: p.paneId,
      cwd: p.cwd,
      isPi: p.isPi,
      panePid: p.pid,
    }));
    const statuses = resolver.resolve(refs);
    return panes.map((p) => ({
      paneId: p.paneId,
      session: p.session,
      windowIndex: p.windowIndex,
      paneIndex: p.paneIndex,
      paneTitle: p.title === "" ? null : p.title,
      cwd: p.cwd,
      status: statuses.get(p.paneId) ?? {
        paneId: p.paneId,
        state: "no_pi" as const,
        sessionFile: null,
        snapshot: null,
        idleSeconds: 0,
        phase: null,
        currentTool: null,
        retryAttempt: 0,
      },
    }));
  };

  const onLaunchPi = (result: {
    mode: "session" | "window";
    cwd: string;
    targetSession?: string;
  }): void => {
    try {
      if (result.mode === "session") {
        createPiSession(result.cwd);
      } else if (result.targetSession !== undefined) {
        createPiWindow(result.targetSession, result.cwd);
      } else {
        // Defensive: window mode without target falls back to a
        // new session so we don't silently swallow the user's
        // intent.
        createPiSession(result.cwd);
      }
    } catch (err) {
      // We don't have a notification surface yet; write to stderr so
      // the message survives the Ink overdraw.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pi-monitor: launch failed: ${msg}\n`);
    }
  };

  // App's tick effect will overwrite this with the live
  // attention-state summary on the first poll; until then a
  // placeholder so the widget shows something the moment the
  // user attaches.
  setStatusWidget("pi-monitor");

  const { waitUntilExit } = render(
    createElement(App, {
      getEntries,
      tmux,
      onLaunchPi,
      defaultCwd: homedir(),
      setStatusWidget,
    }),
  );

  // Cleanly clear the widget on exit. waitUntilExit resolves when
  // the App calls process.exit / ink.exit() / Ctrl-C.
  try {
    await waitUntilExit();
  } finally {
    clearStatusWidget();
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTmuxOnPath(): boolean {
  // `command -v tmux` is portable; fall back to spawnSync since we
  // only need to know "does this resolve to anything".
  const result = spawnSync("which", ["tmux"], { stdio: "ignore" });
  return result.status === 0;
}

function insideMonitorSession(): boolean {
  if (process.env.TMUX === undefined) return false;
  const result = spawnSync("tmux", ["display-message", "-p", "#{session_name}"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return false;
  return (result.stdout ?? "").trim() === "monitor";
}

function selfInvocation(): string {
  // Use the same node binary + cli.js path we're running under so
  // venv/nvm/asdf installs work without depending on PATH.
  // process.argv[0] is the node binary; argv[1] is this script.
  const node = shellQuote(process.argv[0] ?? "node");
  const script = shellQuote(process.argv[1] ?? "");
  return `${node} ${script}`.trim();
}

/**
 * Collect tmux pane ids that belong to the monitor session itself
 * (the TUI pane on the left + the right slot). We hide them from
 * the agent list so the monitor doesn't show itself.
 */
function collectMonitorPaneIds(
  listPanes: () => Array<{ paneId: string; session: string }>,
): Set<string> {
  const ids = new Set<string>();
  try {
    for (const p of listPanes()) {
      if (p.session === "monitor") ids.add(p.paneId);
    }
  } catch {
    // listPanes can throw if tmux is gone; ignore.
  }
  return ids;
}

function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function helpText(): string {
  return [
    "pi-monitor \u2014 live tmux-aware status monitor for pi coding agents",
    "",
    "Usage:",
    "  pi-monitor            run the monitor (bootstrap into a tmux session)",
    "  pi-monitor --reset    kill the existing monitor session before bootstrapping",
    "                        (use after upgrading the npm package)",
    "  pi-monitor --help     show this help",
    "  pi-monitor --version  print version and exit",
    "",
    `version: ${VERSION}`,
    "",
  ].join("\n");
}

// Entry: parse argv (skip node + script path) and run.
main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`pi-monitor: unhandled error: ${msg}\n`);
    process.exit(1);
  },
);
