/**
 * Top-level Ink component. Owns:
 *   - the resolver tick (default 500ms)
 *   - the WORKING-row pulse animation (default 80ms)
 *   - the cursor reducer (j/k navigation, g/G to top/bottom, 1-9 jumps)
 *   - the title bar + footer chrome
 *   - modal mode switching (help, new-pi)
 *   - tmux right-slot integration via injectable TmuxBridge
 *
 * Mirrors `PiMonitorApp` in `tui.py`. Tmux side-effects are
 * routed through a `TmuxBridge` prop so tests can swap a mock in
 * without subprocesses; cli.ts wires the real bridge.
 *
 * Data source is injected via the `getEntries` prop so tests can
 * supply canned data without touching the real resolver / tmux.
 */

import { Box, Text, useApp, useInput, useStdout } from "ink";
import { type ReactElement, useEffect, useReducer, useRef, useState } from "react";

import { STATE_COLORS, fmtStatusWidget } from "../format/row.js";
import { Notifier } from "../notify/notifier.js";
import type { AgentState, PaneStatus } from "../state/types.js";
import { EmptyState } from "./EmptyState.js";
import { HelpScreen } from "./HelpScreen.js";
import { type NewPiResult, NewPiScreen } from "./NewPiScreen.js";
import { type BannerNotification, NotificationBanner } from "./NotificationBanner.js";
import { PaneDetails } from "./PaneDetails.js";
import { PaneRow } from "./PaneRow.js";
import { SessionGroup, pickSessionChip } from "./SessionGroup.js";
import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";
import { sessionHeaderColor } from "./sessionColors.js";
import { INITIAL_CURSOR, currentPos, cursorReducer } from "./cursor.js";
import type { ListDir } from "./dirComplete.js";
import { branchForCwd as defaultBranchForCwd } from "./git.js";
import { lerpColor, pulseColor } from "./pulse.js";
import { BRAILLE_FRAMES } from "./spinner.js";
import type { TmuxBridge } from "./tmuxBridge.js";

/** One displayable agent. Pane metadata + resolved status. */
export interface AppEntry {
  /** Tmux pane id (e.g. "%17"). Unique cursor key. */
  readonly paneId: string;
  /** Session name the pane lives in. */
  readonly session: string;
  /** Pane's window index. Threaded into viewerFocusPane. */
  readonly windowIndex: number;
  /** Pane index inside its window. */
  readonly paneIndex: number;
  /** Pane title from tmux, or null if unset. */
  readonly paneTitle: string | null;
  /** Pane current path. Used by the branch resolver. */
  readonly cwd: string;
  /** Resolved live status. */
  readonly status: PaneStatus;
}

export interface AppProps {
  /**
   * Returns the current set of pi panes + their statuses. Called
   * synchronously on first render and then on every tick. Async
   * implementations are awaited; data races are guarded with a
   * `mounted` flag.
   */
  readonly getEntries: () => AppEntry[] | Promise<AppEntry[]>;
  /** Called when the user presses `q`. Defaults to Ink's `useApp().exit`. */
  readonly onQuit?: () => void;
  /** Tick cadence for getEntries (ms). Default 500. */
  readonly pollIntervalMs?: number;
  /** WORKING pulse cadence (ms). Default 80. */
  readonly pulseIntervalMs?: number;
  /**
   * Branch resolver override (for tests). Defaults to the cached
   * `branchForCwd` from `tui/git.ts`.
   */
  readonly branchForCwd?: (cwd: string) => string | null;
  /**
   * Called when the user submits the new-pi modal. The App returns
   * to list mode immediately after; the caller is responsible for
   * the actual tmux invocation. Defaults to a no-op.
   */
  readonly onLaunchPi?: (result: NewPiResult) => void;
  /** Initial cwd for the new-pi modal. Defaults to `process.cwd()`. */
  readonly defaultCwd?: string;
  /** Optional listDir override forwarded to NewPiScreen (tests). */
  readonly listDir?: ListDir;
  /**
   * Tmux right-slot bridge. When provided, App drives the linked
   * viewer + status widget on cursor changes, focuses the right
   * slot on Tab/Enter, and shuts the bridge down on quit. Default
   * is no tmux integration (display-only mode).
   */
  readonly tmux?: TmuxBridge;
  /**
   * Tmux status-line writer. Receives the formatted attention-state
   * summary on every resolver tick. Hosts the empty string between
   * mount and the first tick. Tests pass a vi.fn(); the real cli.ts
   * passes `setStatusWidget` from `tmux/monitor.ts`.
   */
  readonly setStatusWidget?: (text: string) => void;
  /**
   * Whether the in-TUI notification banner is enabled. Default true.
   * Tests pass `false` to disable banner state churn when they don't
   * care about it.
   */
  readonly notificationsEnabled?: boolean;
  /** Banner auto-dismiss timeout (ms). Default 5000. */
  readonly notificationDismissMs?: number;
}

type AppMode = "list" | "help" | "newSession" | "newWindow";

export function App(props: AppProps): ReactElement {
  const {
    getEntries,
    onQuit,
    pollIntervalMs = 500,
    pulseIntervalMs = 80,
    branchForCwd = defaultBranchForCwd,
    onLaunchPi,
    defaultCwd = process.cwd(),
    listDir,
    setStatusWidget,
    notificationsEnabled = true,
    notificationDismissMs = 5000,
  } = props;

  const ink = useApp();
  const { stdout } = useStdout();
  // Cap content width on wide terminals. Cards filling 200+ cols read
  // stretchy; capping at 100 leaves a comfortable margin and lets the
  // terminal's wallpaper / translucency show on the right.
  const termCols = stdout?.columns ?? 80;
  const contentWidth = Math.min(termCols, 100);
  const [entries, setEntries] = useState<readonly AppEntry[]>([]);
  const [cursor, dispatch] = useReducer(cursorReducer, INITIAL_CURSOR);
  const [mode, setMode] = useState<AppMode>("list");
  // Captured at the moment the user presses 'o' on a pane row, so
  // the new-pi modal can carry the target session through to
  // onLaunchPi when the cursor moves before submission.
  const [windowTarget, setWindowTarget] = useState<{
    session: string;
    cwd: string;
  } | null>(null);

  const tmux = props.tmux ?? null;

  // In-TUI notification banner. Notifier instance is owned by a ref
  // so it survives across renders; its onTransition callback pushes
  // into local React state, which an auto-dismiss effect clears
  // after notificationDismissMs.
  const [banner, setBanner] = useState<BannerNotification | null>(null);
  const notifierRef = useRef<Notifier | null>(null);
  if (notifierRef.current === null) {
    notifierRef.current = new Notifier({
      enabled: notificationsEnabled,
      onTransition: (_paneId, state, title, body) => {
        setBanner({
          title,
          body,
          severity: state === "error" ? "critical" : "normal",
        });
      },
    });
  }
  // Keep enabled flag in sync if the prop ever flips.
  if (notifierRef.current.enabled !== notificationsEnabled) {
    notifierRef.current.enabled = notificationsEnabled;
  }

  // Pulse animation state. Anchor t0 once and recompute the live
  // color on the pulseInterval timer; PaneRow consumes it via prop.
  const [pulseT0] = useState<number>(() => performance.now() / 1000);
  const [pulseHex, setPulseHex] = useState<string>(() => pulseColor(pulseT0, pulseT0));

  // Cursor-move flash animation. We track the timestamp of the
  // last cursor change in a ref; the pulse interval below derives
  // a brightness multiplier that decays from 1.0 -> 0 over
  // CURSOR_FLASH_MS, lerping the bar color from accent toward
  // white on the way down. Gives a visible "the cursor moved
  // here" beat without needing real frame-by-frame tweening.
  const lastCursorIndex = useRef(cursor.index);
  const cursorMoveAtRef = useRef<number>(performance.now() / 1000);
  const [cursorBarHex, setCursorBarHex] = useState<string>(ACCENT);

  // Spinner frame index for the working-row Braille animation.
  // Bumped on the same 80ms cadence as the pulse below; one tick
  // = one frame, mirroring pi-tui's Loader timing exactly.
  const [spinnerFrame, setSpinnerFrame] = useState<number>(0);

  if (lastCursorIndex.current !== cursor.index) {
    cursorMoveAtRef.current = performance.now() / 1000;
    lastCursorIndex.current = cursor.index;
  }

  // ---------------------------------------------------------------------
  // Resolver tick.
  // ---------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;
    const tick = async (): Promise<void> => {
      try {
        const result = await getEntries();
        if (!mounted) return;
        setEntries(result);
      } catch {
        // Swallow; transient resolver failures shouldn't kill the
        // TUI. Next tick retries.
      }
    };
    void tick();
    const id = setInterval(tick, pollIntervalMs);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [getEntries, pollIntervalMs]);

  // ---------------------------------------------------------------------
  // Cursor sync. When entries change, recompute selectable positions
  // and try to keep the user's selection alive.
  // ---------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor.* identity is intentionally not a dep.
  useEffect(() => {
    dispatch({
      type: "sync",
      paneIds: entries.map((e) => e.paneId),
    });
  }, [entries]);

  // ---------------------------------------------------------------------
  // Pulse + cursor-flash animation. One interval drives both: the
  // working-row breathing color AND the brief flash on cursor moves.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now() / 1000;
      setPulseHex(pulseColor(now, pulseT0));
      // Cursor flash: lerp ACCENT -> #FFFFFF based on a 250ms
      // linear decay since the last cursor move. Settles back to
      // solid ACCENT after the window expires; cheap because the
      // interval was already running for the working pulse.
      const flash = Math.max(0, 1 - (now - cursorMoveAtRef.current) / 0.25);
      setCursorBarHex(lerpColor(ACCENT, "#FFFFFF", flash * 0.6));
      // Bump the Braille spinner frame on the same tick. pulse
      // uses 80ms by default which is exactly pi-tui's Loader
      // cadence, so the two animations stay phase-locked.
      setSpinnerFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
    }, pulseIntervalMs);
    return () => clearInterval(id);
  }, [pulseT0, pulseIntervalMs]);

  // ---------------------------------------------------------------------
  // Notifier driving. transition() is called per pane on every
  // entries-change; tick() runs on the same cadence so deferred
  // retryable errors get released after their suppression window.
  // ---------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: notifierRef.current intentionally not a dep.
  useEffect(() => {
    const notifier = notifierRef.current;
    if (notifier === null) return;
    for (const e of entries) {
      notifier.transition(e.paneId, e.status.state, {
        errorMessage: e.status.snapshot?.lastError ?? null,
      });
    }
    notifier.tick();
  }, [entries]);

  // ---------------------------------------------------------------------
  // Banner auto-dismiss. Clears the banner state notificationDismissMs
  // after it was last set. New notifications reset the timer because
  // the effect re-runs on every banner change.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (banner === null) return;
    const id = setTimeout(() => setBanner(null), notificationDismissMs);
    return () => clearTimeout(id);
  }, [banner, notificationDismissMs]);

  // ---------------------------------------------------------------------
  // Tmux status-line widget. Updated on every entries change so the
  // user's status-right (`#{@pi-monitor-status}`) reflects live
  // attention counts. Empty string when nothing is interesting.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (setStatusWidget === undefined) return;
    setStatusWidget(fmtStatusWidget(entries.map((e) => e.status.state)));
  }, [entries, setStatusWidget]);

  // ---------------------------------------------------------------------
  // Tmux right-slot integration. Drive the linked viewer + status
  // widget on cursor changes; reset placeholder when the cursor
  // leaves the pane list.
  // ---------------------------------------------------------------------
  const cursorPaneIdForTmux =
    currentPos(cursor)?.kind === "pane"
      ? (currentPos(cursor) as { kind: "pane"; paneId: string }).paneId
      : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor identity intentionally collapsed into cursorPaneIdForTmux.
  useEffect(() => {
    if (tmux === null) return;
    if (cursorPaneIdForTmux === null) {
      tmux.onCursorAway();
      return;
    }
    const entry = entries.find((e) => e.paneId === cursorPaneIdForTmux);
    if (entry === undefined) {
      tmux.onCursorAway();
      return;
    }
    tmux.onPaneCursor({
      session: entry.session,
      windowIndex: entry.windowIndex,
      paneIndex: entry.paneIndex,
      cwd: entry.cwd === "" ? null : entry.cwd,
    });
  }, [tmux, cursorPaneIdForTmux, entries]);

  // ---------------------------------------------------------------------
  // Keybindings. Disabled while a modal is up; the modal owns
  // input and dismisses itself by calling its onCancel/onSubmit/
  // onDismiss callbacks.
  // ---------------------------------------------------------------------
  const handleQuit = (): void => {
    tmux?.shutdown();
    (onQuit ?? ink.exit)();
  };
  useInput(
    (input, key) => {
      if (input === "q") {
        handleQuit();
        return;
      }
      if (key.ctrl && input === "c") {
        handleQuit();
        return;
      }
      if (key.return || key.tab) {
        // Enter / Tab: hand keyboard focus to the right slot.
        // Only meaningful when the cursor is on a pane row.
        if (currentPos(cursor)?.kind === "pane") {
          tmux?.focusAgent();
        }
        return;
      }
      if (input === "?") {
        setMode("help");
        return;
      }
      if (input === "o") {
        // 'o' on a pane row => new window inside that pane's session.
        // 'o' on the new-row affordance (or empty) => new session.
        const pos = currentPos(cursor);
        if (pos !== null && pos.kind === "pane") {
          const e = entries.find((x) => x.paneId === pos.paneId);
          if (e !== undefined) {
            setWindowTarget({ session: e.session, cwd: e.cwd });
            setMode("newWindow");
            return;
          }
        }
        setMode("newSession");
        return;
      }
      if (input === "j" || key.downArrow) {
        dispatch({ type: "down" });
        return;
      }
      if (input === "k" || key.upArrow) {
        dispatch({ type: "up" });
        return;
      }
      if (input === "g") {
        dispatch({ type: "top" });
        return;
      }
      if (input === "G") {
        dispatch({ type: "bottom" });
        return;
      }
      if (input.length === 1 && input >= "1" && input <= "9") {
        dispatch({ type: "jump", n: Number.parseInt(input, 10) });
      }
    },
    { isActive: mode === "list" },
  );

  // ---------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------
  if (mode === "help") {
    return <HelpScreen onDismiss={() => setMode("list")} />;
  }
  if (mode === "newSession" || mode === "newWindow") {
    const newPiMode = mode === "newSession" ? "session" : "window";
    const cwdHint =
      mode === "newWindow" && windowTarget !== null ? windowTarget.cwd : defaultCwd;
    return (
      <NewPiScreen
        mode={newPiMode}
        defaultCwd={cwdHint}
        onCancel={() => {
          setMode("list");
          setWindowTarget(null);
        }}
        onSubmit={(result) => {
          setMode("list");
          const enriched: NewPiResult =
            mode === "newWindow" && windowTarget !== null
              ? { ...result, targetSession: windowTarget.session }
              : result;
          setWindowTarget(null);
          onLaunchPi?.(enriched);
        }}
        listDir={listDir}
      />
    );
  }

  const groups = groupBySession(entries);
  const cursorPos = currentPos(cursor);
  const selectedPaneId =
    cursorPos !== null && cursorPos.kind === "pane" ? cursorPos.paneId : null;
  const newSelected = cursorPos !== null && cursorPos.kind === "new";
  const counts = countByState(entries.map((e) => e.status.state));
  const empty = entries.length === 0;

  return (
    <Box flexDirection="column" width={contentWidth}>
      <TitleBar counts={counts} />
      {banner !== null && <NotificationBanner notification={banner} />}

      {/* The middle region (row list + flex spacer + details box)
          claims all height between the TitleBar/banner above and
          the Footer below. The flex spacer inside it pushes
          PaneDetails to the very bottom regardless of how many
          pane rows are in the list. */}
      <Box flexDirection="column" paddingX={2} marginTop={1} flexGrow={1}>
        {/* + new pi session affordance. Same selection-bar pattern
            as PaneRow so the cursor moves through a single visual
            grammar across every selectable row. */}
        <Box flexDirection="row">
          <Box width={2}>
            <Text bold color={newSelected ? cursorBarHex : ACCENT}>
              {newSelected ? "\u258e" : " "}
            </Text>
          </Box>
          <Text bold color={newSelected ? ACCENT : FOREGROUND_MUTED}>
            + new pi session
          </Text>
        </Box>

        {empty && <EmptyState />}

        {groups.map(({ session, items }, sectionIdx) => {
          const chip = pickSessionChip(items.map((e) => e.status));
          // Hash-of-name color reused on every row in this section
          // so each section reads as a colored block. PaneRow
          // applies it to non-working titles only.
          const sectionColor = sessionHeaderColor(session);
          return (
            <SessionGroup
              key={session}
              session={session}
              chip={chip}
              first={sectionIdx === 0}
            >
              {items.map((entry) => (
                <PaneRow
                  key={entry.paneId}
                  status={entry.status}
                  paneTitle={entry.paneTitle}
                  paneIndex={entry.paneIndex}
                  branch={branchForCwd(entry.cwd)}
                  selected={entry.paneId === selectedPaneId}
                  workingColor={pulseHex}
                  cursorBarColor={cursorBarHex}
                  spinnerGlyph={BRAILLE_FRAMES[spinnerFrame]}
                  sessionColor={sectionColor}
                />
              ))}
            </SessionGroup>
          );
        })}

        {/* Flex spacer pushes the details box to the very bottom
            of the sidebar. With short pane lists this leaves an
            empty band above the box; the box's vertical position
            stays constant so users can train their eye on it. */}
        <Box flexGrow={1} />

        {/* Bottom-of-sidebar details box for the cursor row. The
            component itself returns null when status is null, so
            non-pane cursor positions (the "+ new pi session" row,
            empty list) collapse to nothing automatically. */}
        {(() => {
          const cursorEntry =
            selectedPaneId !== null
              ? (entries.find((e) => e.paneId === selectedPaneId) ?? null)
              : null;
          return (
            <PaneDetails
              status={cursorEntry?.status ?? null}
              paneTitle={cursorEntry?.paneTitle ?? null}
              paneIndex={cursorEntry?.paneIndex ?? 0}
              branch={cursorEntry !== null ? branchForCwd(cursorEntry.cwd) : null}
              workingColor={pulseHex}
            />
          );
        })()}
      </Box>

      <Footer />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface TitleBarProps {
  readonly counts: Readonly<Record<AgentState, number>>;
}

function TitleBar({ counts }: TitleBarProps): ReactElement {
  // Order matches the priority lattice: error first, then waiting,
  // idle, retrying, working. unknown / no_pi suppressed.
  const chips: Array<{ state: AgentState; n: number }> = [];
  for (const state of [
    "error",
    "waiting",
    "idle",
    "retrying",
    "working",
  ] as AgentState[]) {
    const n = counts[state];
    if (n > 0) chips.push({ state, n });
  }
  return (
    <Box paddingX={2} paddingY={0} flexDirection="row">
      <Box flexGrow={1}>
        <Text bold color={ACCENT}>
          pi-monitor
        </Text>
      </Box>
      <Box flexDirection="row">
        {chips.map((c, i) => (
          <Box key={c.state} marginLeft={i === 0 ? 0 : 3}>
            {/* Colored ● indicator + dim count + dim label. Reads
                like a status pill at-a-glance: dot says 'this kind
                of attention', count + label fill in the detail. */}
            <Text color={STATE_COLORS[c.state]}>{"● "}</Text>
            <Text color={FOREGROUND}>{c.n}</Text>
            <Text color={FOREGROUND_MUTED}>{` ${c.state}`}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Footer(): ReactElement {
  const hints: Array<{ key: string; label: string }> = [
    { key: "j k", label: "move" },
    { key: "↵", label: "focus" },
    { key: "o", label: "new" },
    { key: "?", label: "help" },
    { key: "q", label: "quit" },
  ];
  return (
    <Box paddingX={2} marginTop={1} flexDirection="row">
      {hints.map((h, i) => (
        <Box key={h.key} marginLeft={i === 0 ? 0 : 4}>
          <Text bold color={ACCENT}>
            {h.key}
          </Text>
          <Text color={FOREGROUND_MUTED}>{`  ${h.label}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group entries by tmux session in display order. Within each
 * session, entries keep the order the resolver gave us.
 */
export function groupBySession(
  entries: readonly AppEntry[],
): Array<{ session: string; items: AppEntry[] }> {
  const order: string[] = [];
  const buckets = new Map<string, AppEntry[]>();
  for (const e of entries) {
    if (!buckets.has(e.session)) {
      order.push(e.session);
      buckets.set(e.session, []);
    }
    (buckets.get(e.session) as AppEntry[]).push(e);
  }
  return order.map((s) => ({
    session: s,
    items: buckets.get(s) as AppEntry[],
  }));
}

function countByState(states: readonly AgentState[]): Record<AgentState, number> {
  const counts: Record<AgentState, number> = {
    working: 0,
    idle: 0,
    error: 0,
    waiting: 0,
    retrying: 0,
    unknown: 0,
    no_pi: 0,
  };
  for (const s of states) counts[s] += 1;
  return counts;
}

// Re-export for tests / external callers.
export { FOREGROUND, FOREGROUND_MUTED };
