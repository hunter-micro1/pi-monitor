/**
 * Harness registry.
 *
 * Single place that knows which coding agents pi-monitor can observe.
 * Adding a third harness means writing an adapter and appending it
 * here — no changes to detection, claiming, inference, or render.
 */

import { claudeHarness } from "./claude.js";
import { piHarness } from "./pi.js";
import type { Harness, HarnessId } from "./types.js";

export type { Harness, HarnessId, NormalizedRecord } from "./types.js";
export { normalizedRecord } from "./types.js";
export { firstTextPreview, textPreview, PREVIEW_MAX_CHARS } from "./text.js";
export { piHarness, PI_SESSIONS_ROOT } from "./pi.js";
export { claudeHarness, CLAUDE_SESSIONS_ROOT } from "./claude.js";

/** Every supported harness, in display/priority order. */
export const HARNESSES: readonly Harness[] = [piHarness, claudeHarness];

const BY_ID = new Map<HarnessId, Harness>(HARNESSES.map((h) => [h.id, h]));

/**
 * Process `comm` -> harness. Built once at module load; the pane
 * walk consults it for every process in a pane's descendant tree, so
 * it must stay a hash lookup rather than a scan.
 */
const BY_COMM = new Map<string, Harness>();
for (const h of HARNESSES) {
  for (const comm of h.commNames) BY_COMM.set(comm, h);
}

/** Look up a harness by its stable id. */
export function harnessById(id: HarnessId): Harness {
  const h = BY_ID.get(id);
  if (h === undefined) {
    // Unreachable for well-typed callers; throwing beats returning a
    // silently wrong adapter, which would bind panes to the wrong
    // session directory.
    throw new Error(`unknown harness id: ${id}`);
  }
  return h;
}

/**
 * Harness owning a process `comm`, or `null` when the process isn't
 * a recognized coding agent.
 */
export function harnessByComm(comm: string): Harness | null {
  return BY_COMM.get(comm) ?? null;
}

/**
 * Every `comm` value that identifies some harness. Handed to the
 * platform process walkers so they only pay for one comparison per
 * process regardless of how many harnesses are registered.
 */
export const ALL_COMM_NAMES: readonly string[] = [...BY_COMM.keys()];
