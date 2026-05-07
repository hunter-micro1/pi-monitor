/**
 * Phase-0 sanity test. There's nothing real to test yet — the actual
 * logic ports begin in phase 1 — but we want at least one passing
 * test on disk so `pnpm test` exits 0 and the CI job goes green from
 * day one. Subsequent phases will replace this with real coverage.
 */

import { describe, expect, it } from "vitest";

describe("scaffold", () => {
  it("can run a vitest test", () => {
    expect(1 + 1).toBe(2);
  });

  it("the build target node version matches what we declared", () => {
    // package.json sets `engines.node = ">=20.0.0"` and tsconfig
    // targets ES2022; both are paired with tsup's `node20` target.
    // If a future PR bumps one without the others, tests pin the
    // intent. Major-version bumps land deliberately.
    const major = Number(process.versions.node.split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
