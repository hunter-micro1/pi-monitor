/**
 * Session "section" containing one tmux session's pi panes.
 *
 * Visual model: cmux-style flat list. There is NO bordered box;
 * sections are just a stack of rows separated by a single thin
 * divider line. The session name + chip lives at the top of each
 * section as a header. Cards visually separate via that divider,
 * not via individual border lines, so neighboring sections read as
 * one continuous list with subtle group breaks.
 *
 * Mirrors the cmux sidebar layout we're targeting for visual parity.
 */

import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import { STATE_COLORS, fmtSessionHeader } from "../format/row.js";
import type { AgentState } from "../state/types.js";
import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";

export interface SessionGroupProps {
  /** Session name (header). */
  session: string;
  /**
   * The single highest-priority issue chip to render next to the
   * name, e.g. "1 idle" or "1 error". null when nothing is stuck.
   * Mirrors `_session_chip` in the Python build.
   */
  chip?: { count: number; state: AgentState } | null;
  /** True for the topmost section (skips the leading divider). */
  first?: boolean;
  /** PaneRow children. */
  children: ReactNode;
}

/**
 * Pick the single highest-priority issue chip for a session header.
 * Equivalent of `_session_chip` in `tui.py`. Walks the per-session
 * statuses and returns the most attention-worthy state count.
 */
export function pickSessionChip(
  statuses: { state: AgentState }[],
): { count: number; state: AgentState } | null {
  const counts = new Map<AgentState, number>();
  for (const s of statuses) {
    counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
  }
  for (const state of ["error", "waiting", "idle", "retrying"] as AgentState[]) {
    const n = counts.get(state) ?? 0;
    if (n > 0) return { count: n, state };
  }
  const working = counts.get("working") ?? 0;
  if (working > 0) return { count: working, state: "working" };
  return null;
}

export function SessionGroup({
  session,
  chip = null,
  first = false,
  children,
}: SessionGroupProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={first ? 1 : 0}>
      {!first && <Divider />}

      {/* Section header: bold name + chip. Tight 0-margin on the
          divider above and the rows below \u2014 the section reads as a
          single visual block.

          Header is outdented: it sits at the App's paddingX edge
          (col 2) while the pane rows below sit one selection-bar
          column further in (col 4). Gives a clear visual
          hierarchy \u2014 'session label' is left of 'rows in this
          session'. */}
      <Box flexDirection="row" marginTop={first ? 0 : 1} marginBottom={1}>
        <Box flexGrow={1}>
          {/* Header text uses the brand ACCENT blue. Per-session
              hash colors still apply to non-working pane TITLES
              via the sessionColor prop on PaneRow (see App.tsx);
              the header itself is unified to ACCENT for a clean,
              scannable section label. */}
          <Text bold color={ACCENT}>
            {fmtSessionHeader(session)}
          </Text>
          {chip !== null && (
            <>
              <Text color={FOREGROUND_MUTED}>{"   "}</Text>
              <Text color={STATE_COLORS[chip.state]}>{"\u25cf "}</Text>
              <Text color={FOREGROUND}>{chip.count}</Text>
              <Text color={FOREGROUND_MUTED}>{` ${chip.state}`}</Text>
            </>
          )}
        </Box>
      </Box>

      {children}
    </Box>
  );
}

function Divider(): ReactElement {
  // Use Ink's top-border on a 1-row Box to get an auto-sized
  // horizontal line that hugs the parent's content width. Avoids
  // the manual `─`-repeat width math and the wrap edge case it
  // hit on terminals wider than 100 cols.
  return (
    <Box
      marginX={2}
      borderStyle="single"
      borderTop
      borderRight={false}
      borderLeft={false}
      borderBottom={false}
      borderColor={FOREGROUND_MUTED}
    />
  );
}
