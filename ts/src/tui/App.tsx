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
import {
  type ReactElement,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

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
import { INITIAL_CURSOR, currentPos, cursorReducer } from "./cursor.js";
import type { ListDir } from "./dirComplete.js";
import { branchForCwd as defaultBranchForCwd } from "./git.js";
import { lerpColor, pulseColor } from "./pulse.js";
import { sessionHeaderColor } from "./sessionColors.js";
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
  // Pin the App to the literal pane height so the flex spacer
  // between the row list and the bottom details box claims every
  // leftover row in the pane (not just leftover rows inside the
  // App's natural height). Without this, on a tall monitor pane
  // a short pane list leaves blank rows BELOW the details box
  // instead of pushing it to the very bottom-left of the pane.
  // Falls back to 24 (xterm classic) when ink-testing-library or
  // a non-TTY stdout report no row count.
  const termRows = stdout?.rows ?? 24;
  const [entries, setEntries] = useState<readonly AppEntry[]>([]);
  // Pre-resolved git branch per cwd. Populated by the resolver tick
  // so render never has to call `branchForCwd` (which spawnSyncs
  // `git symbolic-ref` on cache-miss); the 80 ms pulse re-render
  // path stays subprocess-free, which is what makes 5+ panes feel
  // responsive on macOS.
  const [branchByCwd, setBranchByCwd] = useState<ReadonlyMap<string, string | null>>(
    () => new Map(),
  );
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
        // Pre-resolve git branches for every unique cwd OUTSIDE
        // the render path. branchForCwd has a 15s TTL cache, but
        // cache misses do a synchronous `git symbolic-ref` spawn;
        // calling it from the render path used to freeze the UI
        // for tens of ms during cursor navigation. Doing it here
        // batches all resolutions into the tick budget (which
        // already does ps/lsof/tmux subprocess work) and keeps
        // every subsequent pulse re-render subprocess-free.
        const nextBranches = new Map<string, string | null>();
        for (const e of result) {
          if (e.cwd === "" || nextBranches.has(e.cwd)) continue;
          nextBranches.set(e.cwd, branchForCwd(e.cwd));
        }
        if (!mounted) return;
        // Only swap the state map when something actually changed,
        // so a steady-state tick (same panes, same branches) doesn't
        // bump a fresh Map reference into state and trigger a
        // pointless re-render for every PaneRow consumer.
        setBranchByCwd((prev) =>
          sameBranchMap(prev, nextBranches) ? prev : nextBranches,
        );
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
  }, [getEntries, pollIntervalMs, branchForCwd]);

  // ---------------------------------------------------------------------
  // Display order. groupBySession buckets entries by session AND lifts
  // attention-worthy rows (error/waiting/idle) above retrying/working
  // within each bucket — see its JSDoc. We memoize because the result
  // feeds both the render below AND the cursor-sync effect; the cursor
  // must walk panes in the same order the user sees them, otherwise
  // j/k would skip around the visible list.
  // ---------------------------------------------------------------------
  const groups = useMemo(() => groupBySession(entries), [entries]);
  const orderedPaneIds = useMemo(
    () => groups.flatMap((g) => g.items.map((i) => i.paneId)),
    [groups],
  );

  // ---------------------------------------------------------------------
  // Cursor sync. When the visible order changes, recompute selectable
  // positions and try to keep the user's selection alive.
  // ---------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor.* identity is intentionally not a dep.
  useEffect(() => {
    dispatch({
      type: "sync",
      paneIds: orderedPaneIds,
    });
  }, [orderedPaneIds]);

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
        // Enter / Tab on a pane row: hand keyboard focus to the
        // right slot.
        // Enter / Tab on the `+ new pi session` affordance: open
        // the new-session popup (same effect as pressing `o`
        // there). Users expect Enter on a 'button-like' row to
        // activate it.
        const pos = currentPos(cursor);
        if (pos?.kind === "pane") {
          tmux?.focusAgent();
        } else if (pos?.kind === "new") {
          setMode("newSession");
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
  // newSession / newWindow no longer return early. Instead the
  // App tree stays mounted and renders the NewPiScreen as a
  // bottom popup (in place of the details box) so the pane list
  // and titlebar remain visible behind it. See the
  // popupOpen-gated branch in the bottom slot below.
  const popupOpen = mode === "newSession" || mode === "newWindow";
  const popupNewPiMode: "session" | "window" =
    mode === "newSession" ? "session" : "window";
  const popupCwdHint =
    mode === "newWindow" && windowTarget !== null ? windowTarget.cwd : defaultCwd;
  const closePopup = (): void => {
    setMode("list");
    setWindowTarget(null);
  };
  const submitPopup = (result: NewPiResult): void => {
    const enriched: NewPiResult =
      mode === "newWindow" && windowTarget !== null
        ? { ...result, targetSession: windowTarget.session }
        : result;
    setMode("list");
    setWindowTarget(null);
    onLaunchPi?.(enriched);
  };

  const cursorPos = currentPos(cursor);
  const selectedPaneId =
    cursorPos !== null && cursorPos.kind === "pane" ? cursorPos.paneId : null;
  const newSelected = cursorPos !== null && cursorPos.kind === "new";
  const counts = countByState(entries.map((e) => e.status.state));
  const empty = entries.length === 0;

  return (
    <Box flexDirection="column" width={contentWidth} height={termRows}>
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
              {items.map((entry) => {
                // Gate animated props so PaneRow's memo can skip
                // re-renders on the 80 ms pulse tick for rows that
                // don't consume them:
                //   - workingColor + spinnerGlyph only matter when
                //     state === "working" (the row is breathing).
                //   - cursorBarColor only matters when the row is
                //     selected (the bar lerps brightward briefly
                //     after a cursor move).
                // Non-working, non-selected rows see stable
                // `undefined` between pulses; React.memo's default
                // shallow comparator then skips the render.
                const isWorking = entry.status.state === "working";
                const isSelected = entry.paneId === selectedPaneId;
                return (
                  <PaneRow
                    key={entry.paneId}
                    status={entry.status}
                    paneTitle={entry.paneTitle}
                    paneIndex={entry.paneIndex}
                    // Read pre-resolved branch from the tick-populated
                    // map; null until the first tick lands (one frame).
                    branch={branchByCwd.get(entry.cwd) ?? null}
                    selected={isSelected}
                    workingColor={isWorking ? pulseHex : undefined}
                    cursorBarColor={isSelected ? cursorBarHex : undefined}
                    spinnerGlyph={isWorking ? BRAILLE_FRAMES[spinnerFrame] : undefined}
                    sessionColor={sectionColor}
                  />
                );
              })}
            </SessionGroup>
          );
        })}

        {/* Flex spacer pushes the details box to the very bottom
            of the sidebar. With short pane lists this leaves an
            empty band above the box; the box's vertical position
            stays constant so users can train their eye on it. */}
        <Box flexGrow={1} />

        {/* Bottom slot. The popup takes over while open so the
            user can type a path without losing the pane list
            above; otherwise we render the details box for the
            cursor row. PaneDetails returns null when status is
            null, so non-pane cursor positions collapse cleanly. */}
        {popupOpen ? (
          <Box marginTop={1}>
            <NewPiScreen
              mode={popupNewPiMode}
              defaultCwd={popupCwdHint}
              onCancel={closePopup}
              onSubmit={submitPopup}
              listDir={listDir}
              // Fit inside the row list's paddingX={2} on each
              // side so the popup never exceeds the sidebar
              // width on narrow panes.
              width={Math.max(20, contentWidth - 4)}
            />
          </Box>
        ) : (
          (() => {
            const cursorEntry =
              selectedPaneId !== null
                ? (entries.find((e) => e.paneId === selectedPaneId) ?? null)
                : null;
            return (
              <PaneDetails
                status={cursorEntry?.status ?? null}
                paneTitle={cursorEntry?.paneTitle ?? null}
                paneIndex={cursorEntry?.paneIndex ?? 0}
                branch={
                  cursorEntry !== null
                    ? (branchByCwd.get(cursorEntry.cwd) ?? null)
                    : null
                }
                cwd={cursorEntry?.cwd ?? null}
              />
            );
          })()
        )}
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
 * Priority rank used to lift attention-worthy panes to the top of
 * their session group. Lower = more attention-worthy. Mirrors the
 * lattice that `pickSessionChip` (SessionGroup.tsx), `TitleBar`, and
 * `fmtStatusWidget` already encode: error → waiting → idle →
 * retrying → working → unknown/no_pi.
 *
 * Kept inline here rather than exported because every other call
 * site iterates a literal in priority order; only `groupBySession`
 * needs an `O(1)` rank lookup.
 */
const PRIORITY_RANK: Record<AgentState, number> = {
  error: 0,
  waiting: 1,
  idle: 2,
  retrying: 3,
  working: 4,
  unknown: 5,
  no_pi: 6,
};

/**
 * Group entries by tmux session in display order. Sessions keep
 * the first-seen order from the resolver. Within each session,
 * items are stable-sorted by attention priority so panes that need
 * the user — `error`, `waiting`, then `idle` — float to the top,
 * with `retrying`/`working` below. Items in the same state preserve
 * the resolver's relative order.
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
  return order.map((s) => {
    const items = buckets.get(s) as AppEntry[];
    // Stable sort: Array.prototype.sort is spec-stable on V8 (Node
    // 12+), so equal-priority items keep resolver order.
    items.sort((a, b) => PRIORITY_RANK[a.status.state] - PRIORITY_RANK[b.status.state]);
    return { session: s, items };
  });
}

/**
 * Shallow-equal compare for the cwd→branch map produced by the
 * resolver tick. Same keys + same values per key. Used to skip a
 * pointless `setBranchByCwd` (and the re-render it triggers) when
 * a steady-state tick re-resolves identical branches.
 */
function sameBranchMap(
  a: ReadonlyMap<string, string | null>,
  b: ReadonlyMap<string, string | null>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (!b.has(k) || b.get(k) !== v) return false;
  }
  return true;
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
