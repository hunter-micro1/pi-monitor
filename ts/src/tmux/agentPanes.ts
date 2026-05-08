/**
 * Per-tick pane selection.
 *
 * Lifts the small "which panes belong in the agent list" filter
 * out of `cli.ts` so it's unit-testable without spinning up Ink
 * + tmux. Three rules:
 *
 *   1. Drop panes living in the `monitor` session itself (the
 *      TUI pane on the left + the right slot would otherwise
 *      show up as agents).
 *   2. Drop panes reported under a viewer-prefixed session
 *      (`pi-monitor-view-*`). Tmux's session-grouping makes
 *      the linked viewer report the same pi panes a second
 *      time under the viewer-session name.
 *   3. Dedupe by `paneId` (first occurrence wins). Catches the
 *      same group-sister case as rule 2 when the sister
 *      session was created by something other than us — e.g.
 *      a user manually `tmux new-session -t <agent>` or
 *      another tool that names its sisters without the
 *      `pi-monitor-view-` prefix. Without this, `pane_id %11`
 *      reported under both `pi-9` and `pi-9-13` would render
 *      twice.
 */

import { isViewerSession } from "./panes.js";

/** Minimal pane shape `selectAgentPanes` needs. Mirrors `Pane`. */
export interface PaneLike {
  paneId: string;
  session: string;
}

/**
 * Apply the three filter rules above and return the panes the
 * TUI should render. Preserves input order.
 */
export function selectAgentPanes<P extends PaneLike>(
  panes: readonly P[],
  ownPaneIds: ReadonlySet<string>,
): P[] {
  const seen = new Set<string>();
  const out: P[] = [];
  for (const p of panes) {
    if (ownPaneIds.has(p.paneId)) continue;
    if (isViewerSession(p.session)) continue;
    if (seen.has(p.paneId)) continue;
    seen.add(p.paneId);
    out.push(p);
  }
  return out;
}
