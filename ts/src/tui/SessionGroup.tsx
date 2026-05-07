/**
 * Bordered card containing one tmux session's pi panes.
 *
 * Mirrors the Python `SessionGroup` widget. Visual differences:
 *   - Textual paints the session name into the border title via
 *     `border-title-align: left`. Ink's `<Box borderStyle="round">`
 *     doesn't have a built-in title slot, so we render the title as
 *     a separate Text element above the bordered box. Slight visual
 *     gap from the Python version, but the structure is the same:
 *     name + count chip floats over a bordered card.
 *   - Active-card emphasis becomes a brighter borderColor + bold
 *     title instead of a CSS class swap.
 */

import { Box, Text } from "ink";
import type { ReactElement, ReactNode } from "react";

import { STATE_COLORS, fmtSessionHeader } from "../format/row.js";
import type { AgentState } from "../state/types.js";
import { ACCENT, FOREGROUND_MUTED } from "./colors.js";

export interface SessionGroupProps {
  /** Session name (border title). */
  session: string;
  /**
   * The single highest-priority issue chip to render next to the
   * name, e.g. "2 idle" or "1 error". null when nothing is
   * stuck. Mirrors `_session_chip` in the Python build.
   */
  chip?: { count: number; state: AgentState } | null;
  /** True iff the cursor is on a row inside this card. */
  active?: boolean;
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
  active = false,
  children,
}: SessionGroupProps): ReactElement {
  const borderColor = active ? ACCENT : FOREGROUND_MUTED;

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header chip-row sits flush against the top border of the
          bordered box below — visual link between name and card.
          Ink's <Box borderStyle="round"> has no built-in title
          slot, so we approximate it via tight vertical spacing
          (no marginBottom on the header, no marginTop on the box). */}
      <Box paddingLeft={3}>
        <Text bold color={active ? ACCENT : FOREGROUND_MUTED}>
          {fmtSessionHeader(session)}
        </Text>
        {chip !== null && (
          <>
            <Text color={FOREGROUND_MUTED}>{"  "}</Text>
            <Text color={STATE_COLORS[chip.state]}>
              {chip.count} {chip.state}
            </Text>
          </>
        )}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
      >
        {children}
      </Box>
    </Box>
  );
}
