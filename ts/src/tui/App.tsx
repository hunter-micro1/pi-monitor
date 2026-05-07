/**
 * Top-level Ink component. Owns:
 *   - the resolver tick (default 500ms)
 *   - the WORKING-row pulse animation (default 80ms)
 *   - the cursor reducer (j/k navigation, g/G to top/bottom, 1\u20139 jumps)
 *   - the title bar + footer chrome
 *
 * Mirrors `PiMonitorApp` in `tui.py` for the read-only parts. Modal
 * screens (Help, NewPi) and tmux integration land in 4.3 / 4.4.
 *
 * Data source is injected via the `getEntries` prop so tests can
 * supply canned data without touching the real resolver / tmux.
 */

import { Box, Text, useApp, useInput } from "ink";
import { type ReactElement, useEffect, useReducer, useState } from "react";

import { STATE_COLORS, fmtSessionHeader } from "../format/row.js";
import type { AgentState, PaneStatus } from "../state/types.js";
import { EmptyState } from "./EmptyState.js";
import { PaneRow } from "./PaneRow.js";
import { SessionGroup, pickSessionChip } from "./SessionGroup.js";
import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";
import { INITIAL_CURSOR, currentPos, cursorReducer } from "./cursor.js";
import { branchForCwd as defaultBranchForCwd } from "./git.js";
import { pulseColor } from "./pulse.js";

/** One displayable agent. Pane metadata + resolved status. */
export interface AppEntry {
  /** Tmux pane id (e.g. "%17"). Unique cursor key. */
  readonly paneId: string;
  /** Session name the pane lives in. */
  readonly session: string;
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
   * implementations are awaited \u2014 data races are guarded with a
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
}

export function App(props: AppProps): ReactElement {
  const {
    getEntries,
    onQuit,
    pollIntervalMs = 500,
    pulseIntervalMs = 80,
    branchForCwd = defaultBranchForCwd,
  } = props;

  const ink = useApp();
  const [entries, setEntries] = useState<readonly AppEntry[]>([]);
  const [cursor, dispatch] = useReducer(cursorReducer, INITIAL_CURSOR);

  // Pulse animation state. Anchor t0 once and recompute the live
  // color on the pulseInterval timer; PaneRow consumes it via prop.
  const [pulseT0] = useState<number>(() => performance.now() / 1000);
  const [pulseHex, setPulseHex] = useState<string>(() => pulseColor(pulseT0, pulseT0));

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
        // Swallow \u2014 we don't want a transient resolver failure to
        // crash the whole TUI. Next tick will retry.
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor.* identity is intentionally not a dep \u2014 sync is driven by entries.
  useEffect(() => {
    dispatch({
      type: "sync",
      paneIds: entries.map((e) => e.paneId),
    });
  }, [entries]);

  // ---------------------------------------------------------------------
  // Pulse animation.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      setPulseHex(pulseColor(performance.now() / 1000, pulseT0));
    }, pulseIntervalMs);
    return () => clearInterval(id);
  }, [pulseT0, pulseIntervalMs]);

  // ---------------------------------------------------------------------
  // Keybindings.
  // ---------------------------------------------------------------------
  useInput((input, key) => {
    if (input === "q") {
      (onQuit ?? ink.exit)();
      return;
    }
    if (key.ctrl && input === "c") {
      (onQuit ?? ink.exit)();
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
  });

  // ---------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------
  const groups = groupBySession(entries);
  const cursorPos = currentPos(cursor);
  const selectedPaneId =
    cursorPos !== null && cursorPos.kind === "pane" ? cursorPos.paneId : null;
  const newSelected = cursorPos !== null && cursorPos.kind === "new";
  const counts = countByState(entries.map((e) => e.status.state));
  const empty = entries.length === 0;

  return (
    <Box flexDirection="column">
      <TitleBar counts={counts} />

      <Box flexDirection="column" paddingX={2}>
        <Box marginTop={1}>
          <Text bold color={ACCENT} inverse={newSelected}>
            + new pi session
          </Text>
        </Box>

        {empty && <EmptyState />}

        {groups.map(({ session, items }) => {
          const activeCard = items.some((e) => e.paneId === selectedPaneId);
          const chip = pickSessionChip(items.map((e) => e.status));
          return (
            <SessionGroup
              key={session}
              session={session}
              chip={chip}
              active={activeCard}
            >
              {items.map((entry) => (
                <PaneRow
                  key={entry.paneId}
                  status={entry.status}
                  paneTitle={entry.paneTitle}
                  paneIndex={entry.paneIndex}
                  branch={branchForCwd(entry.cwd)}
                  selected={entry.paneId === selectedPaneId}
                  inActiveCard={activeCard}
                  workingColor={pulseHex}
                />
              ))}
            </SessionGroup>
          );
        })}
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
        <Text color={FOREGROUND_MUTED}>
          {"  "}
          {fmtSessionHeader("status")}
        </Text>
      </Box>
      <Box flexDirection="row">
        {chips.map((c, i) => (
          <Box key={c.state} marginLeft={i === 0 ? 0 : 2}>
            <Text color={STATE_COLORS[c.state]}>
              {c.n} {c.state}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Footer(): ReactElement {
  const hints: Array<{ key: string; label: string }> = [
    { key: "j/k", label: "move" },
    { key: "g/G", label: "top/bot" },
    { key: "o", label: "new" },
    { key: "?", label: "help" },
    { key: "q", label: "quit" },
  ];
  return (
    <Box paddingX={2} marginTop={1}>
      {hints.map((h, i) => (
        <Box key={h.key} marginLeft={i === 0 ? 0 : 3}>
          <Text bold color={ACCENT}>
            {h.key}
          </Text>
          <Text color={FOREGROUND_MUTED}> {h.label}</Text>
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
