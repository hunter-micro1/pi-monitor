/**
 * macOS process-tree resolver: real-`ps` smoke test.
 *
 * Skipped on non-darwin platforms. Unlike `macos.test.ts` (which
 * mocks `node:child_process`), this test ACTUALLY shells out to
 * the host `ps` so a future column-name regression can't slip
 * through CI silently.
 *
 * Regression context: 0.4.x shipped with `ps -o ...,etimes=`,
 * which is a Linux/procps-only keyword. macOS BSD `ps` rejects it
 * with `ps: etimes: keyword not found` and exits non-zero, which
 * the resolver's try/catch turned into an empty snapshot. Result:
 * pi-monitor found zero pi panes on every Mac. Mocking
 * `execFileSync` made every unit test pass anyway.
 */

import { describe, expect, it } from "vitest";

// vitest's `it.skipIf` skips the body without marking the test as
// failed when the predicate is true; we use it so this file is a
// no-op on Linux CI without needing a separate workflow guard.
const itDarwin = it.skipIf(process.platform !== "darwin");

// We import dynamically so vitest's auto-mocking from sibling
// `macos.test.ts` (which `vi.mock`s `node:child_process`) doesn't
// leak into this file. The ESM module graph keeps these isolated,
// but importing inside the test makes that obvious.
async function loadMacos() {
  return await import("../../src/proc/macos.js");
}

describe("macos real ps integration", () => {
  itDarwin("readPsSnapshot returns at least the current process", async () => {
    const { readPsSnapshot, _resetPsCacheForTests } = await loadMacos();
    _resetPsCacheForTests();
    const snap = readPsSnapshot({ force: true });
    // launchd is pid 1 on macOS and is always present.
    expect(snap.size).toBeGreaterThan(0);
    expect(snap.has(1)).toBe(true);
    // The current process must be in the snapshot too.
    expect(snap.has(process.pid)).toBe(true);
  });

  itDarwin("procStartTime returns a sane value for the current process", async () => {
    const { procStartTime, _resetPsCacheForTests } = await loadMacos();
    _resetPsCacheForTests();
    const ts = procStartTime(process.pid);
    expect(ts).not.toBeNull();
    const now = Date.now() / 1000;
    // Process started in the past, but not before unix epoch.
    expect(ts as number).toBeGreaterThan(0);
    expect(ts as number).toBeLessThanOrEqual(now);
    // And not absurdly far in the past (< 1 year ago is plenty
    // of slack for any realistic test runner).
    expect(now - (ts as number)).toBeLessThan(365 * 86_400);
  });

  itDarwin("findPiPidForPane returns null for a non-pi pid", async () => {
    const { findPiPidForPane, _resetPsCacheForTests } = await loadMacos();
    _resetPsCacheForTests();
    // The vitest worker isn't a `pi` process, so its tree must
    // contain no pi. (If it did, findPiPidForPane would return
    // that pid; null is the only correct answer here.)
    expect(findPiPidForPane(process.pid)).toBeNull();
  });
});
