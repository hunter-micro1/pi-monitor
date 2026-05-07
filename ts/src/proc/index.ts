/**
 * Cross-platform process-tree resolver.
 *
 * Dispatches to `proc/linux.ts` or `proc/macos.ts` based on
 * `process.platform`. The two implementations expose the same
 * `procStartTime` / `findPiPidForPane` shape, so callers don't
 * branch.
 *
 * Mirrors what the Python build's `psutil` shim does internally.
 * Windows is intentionally not supported \u2014 the Python build doesn't
 * support it either, and tmux on Windows is a separate problem.
 */

import * as linux from "./linux.js";
import * as macos from "./macos.js";

const impl = process.platform === "darwin" ? macos : linux;

export const procStartTime = impl.procStartTime;
export const findPiPidForPane = impl.findPiPidForPane;
