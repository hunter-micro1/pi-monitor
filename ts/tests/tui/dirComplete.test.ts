/**
 * Tab-completion tests. Pure function, mock the listDir callback
 * instead of touching the real filesystem.
 */

import { homedir } from "node:os";
import { describe, expect, it } from "vitest";

import { type ListDir, completeDirPath } from "../../src/tui/dirComplete.js";

/**
 * Build a mock listDir from a flat parent-to-children map. Lookups
 * for paths not in the map return [].
 */
function mockListDir(tree: Record<string, readonly string[]>): ListDir {
  return (path: string) => tree[path] ?? [];
}

describe("completeDirPath", () => {
  it("returns the input unchanged when value is empty", () => {
    expect(completeDirPath("", () => [])).toEqual({
      value: "",
      matches: [],
    });
  });

  it("returns matches but no completion when nothing matches the partial", () => {
    const list = mockListDir({ "/x": ["alpha", "beta"] });
    expect(completeDirPath("/x/zz", list)).toEqual({
      value: "/x/zz",
      matches: [],
    });
  });

  it("appends a trailing slash on a single match", () => {
    const list = mockListDir({ "/x": ["one", "other"] });
    // Partial 'on' uniquely matches 'one'.
    expect(completeDirPath("/x/on", list)).toEqual({
      value: "/x/one/",
      matches: ["one"],
    });
  });

  it("completes to the longest common prefix on multiple matches", () => {
    const list = mockListDir({ "/x": ["alpha", "alphabet", "alphanumeric"] });
    const result = completeDirPath("/x/al", list);
    // 'alpha' is the LCP (next char a vs b vs n diverges).
    expect(result.value).toBe("/x/alpha");
    expect(result.matches).toEqual(["alpha", "alphabet", "alphanumeric"]);
  });

  it("returns matches without modifying value when the LCP equals the partial", () => {
    const list = mockListDir({ "/x": ["alpha", "alphabet"] });
    // Partial 'alpha' already equals the LCP.
    expect(completeDirPath("/x/alpha", list)).toEqual({
      value: "/x/alpha",
      matches: ["alpha", "alphabet"],
    });
  });

  it("hides hidden entries unless the partial starts with a dot", () => {
    const list = mockListDir({ "/x": [".hidden", "visible"] });
    // No leading dot in partial; only 'visible' should match.
    expect(completeDirPath("/x/", list)).toEqual({
      value: "/x/visible/",
      matches: ["visible"],
    });
    // Leading dot in partial; only '.hidden' should match.
    expect(completeDirPath("/x/.", list)).toEqual({
      value: "/x/.hidden/",
      matches: [".hidden"],
    });
  });

  it("treats trailing-slash inputs as 'list parent's children'", () => {
    const list = mockListDir({ "/x": ["a", "b", "c"] });
    const result = completeDirPath("/x/", list);
    // Partial is empty so every (non-hidden) entry matches; LCP is "".
    expect(result.matches).toEqual(["a", "b", "c"]);
  });

  it("preserves the ~ form when the user typed it", () => {
    const home = homedir();
    const list = mockListDir({ [home]: ["only"] });
    expect(completeDirPath("~/on", list)).toEqual({
      value: "~/only/",
      matches: ["only"],
    });
  });

  it("expands ~/ to the homedir for filesystem lookup", () => {
    const home = homedir();
    const calls: string[] = [];
    const tracker: ListDir = (p) => {
      calls.push(p);
      return p === home ? ["only"] : [];
    };
    completeDirPath("~/on", tracker);
    expect(calls).toContain(home);
  });

  it("returns matches sorted alphabetically", () => {
    const list = mockListDir({ "/x": ["zeta", "alpha", "mu"] });
    const result = completeDirPath("/x/", list);
    expect(result.matches).toEqual(["alpha", "mu", "zeta"]);
  });

  it("handles bare directory name (no slash) as relative", () => {
    const list = mockListDir({ ".": ["build"] });
    const result = completeDirPath("bui", list);
    expect(result.matches).toEqual(["build"]);
  });
});
