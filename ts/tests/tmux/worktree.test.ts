/**
 * createAgentWorktree tests. Injects a fake gitExec so tests stay
 * pure (no real git, no real disk writes). The fake reads queued
 * scripted responses keyed by the args' first token, so every test
 * can declare exactly which git invocations it expects.
 */

import { describe, expect, it } from "vitest";

import { TmuxError } from "../../src/tmux/client.js";
import { createAgentWorktree } from "../../src/tmux/worktree.js";

interface ExpectedCall {
  match: (args: readonly string[]) => boolean;
  result: { stdout: string; stderr: string; status: number };
  /** Record the actual call for later assertions. */
  actual?: readonly string[];
}

/**
 * Build a scripted git runner. The runner consumes calls in order;
 * each call must satisfy the corresponding expectation's matcher.
 * Mismatches fail loudly so a refactor that changes the call order
 * doesn't silently pass the wrong assertion.
 */
function scriptedGit(expectations: ExpectedCall[]): {
  exec: (args: readonly string[], cwd: string) => {
    stdout: string;
    stderr: string;
    status: number;
  };
  calls: { args: readonly string[]; cwd: string }[];
} {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  let i = 0;
  return {
    calls,
    exec(args, cwd) {
      calls.push({ args, cwd });
      const exp = expectations[i];
      if (exp === undefined) {
        throw new Error(`unexpected git call #${i}: ${args.join(" ")}`);
      }
      if (!exp.match(args)) {
        throw new Error(
          `git call #${i} did not match the expected pattern. ` +
            `got: ${args.join(" ")}`,
        );
      }
      exp.actual = args;
      i += 1;
      return exp.result;
    },
  };
}

function ok(stdout: string): { stdout: string; stderr: string; status: number } {
  return { stdout, stderr: "", status: 0 };
}

function fail(stderr: string): { stdout: string; stderr: string; status: number } {
  return { stdout: "", stderr, status: 1 };
}

const FIXED_DATE = new Date(Date.UTC(2026, 0, 15, 12, 34, 56));
const FIXED_TS = "20260115-123456";

describe("createAgentWorktree", () => {
  it("creates a worktree from a normal branch (uses current branch as base)", () => {
    const git = scriptedGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel", result: ok("/repos/myrepo") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("main") },
      // worktree add
      {
        match: (a) =>
          a[0] === "worktree" &&
          a[1] === "add" &&
          a[2] === `/repos/myrepo-main-${FIXED_TS}` &&
          a[3] === "-b" &&
          a[4] === `agent/main-${FIXED_TS}` &&
          a[5] === "main",
        result: ok(""),
      },
      // config write (non-fatal)
      {
        match: (a) =>
          a[0] === "config" &&
          a[1] === `branch.agent/main-${FIXED_TS}.piBase` &&
          a[2] === "main",
        result: ok(""),
      },
    ]);

    const result = createAgentWorktree("/repos/myrepo/sub/dir", {
      gitExec: git.exec,
      now: () => FIXED_DATE,
    });

    expect(result).toEqual({
      path: `/repos/myrepo-main-${FIXED_TS}`,
      branch: `agent/main-${FIXED_TS}`,
      base: "main",
    });
  });

  it("resolves base from `branch.<current>.piBase` config when inside an agent worktree", () => {
    const git = scriptedGit([
      { match: (a) => a[0] === "rev-parse", result: ok("/repos/myrepo-main-20251231-000000") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("agent/main-20251231-000000") },
      // config lookup returns recorded base
      {
        match: (a) =>
          a[0] === "config" &&
          a[1] === "branch.agent/main-20251231-000000.piBase",
        result: ok("main"),
      },
      // worktree add — new agent branch is suffix-of-base, NOT suffix-of-current
      {
        match: (a) =>
          a[0] === "worktree" &&
          a[1] === "add" &&
          a[4] === `agent/main-${FIXED_TS}` &&
          a[5] === "main",
        result: ok(""),
      },
      {
        match: (a) =>
          a[0] === "config" &&
          a[1] === `branch.agent/main-${FIXED_TS}.piBase` &&
          a[2] === "main",
        result: ok(""),
      },
    ]);

    const result = createAgentWorktree("/repos/myrepo-main-20251231-000000", {
      gitExec: git.exec,
      now: () => FIXED_DATE,
    });
    expect(result.base).toBe("main");
    expect(result.branch).toBe(`agent/main-${FIXED_TS}`);
  });

  it("falls back to parsing the branch name when piBase isn't recorded", () => {
    const git = scriptedGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel", result: ok("/repos/myrepo-feature-20251231-000000") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("agent/feature-20251231-000000") },
      // config lookup misses
      { match: (a) => a[0] === "config", result: fail("") },
      // verify the parsed candidate `feature` is a real ref
      {
        match: (a) =>
          a[0] === "rev-parse" && a[1] === "--verify" && a[3] === "feature",
        result: ok("abcdef"),
      },
      {
        match: (a) =>
          a[0] === "worktree" &&
          a[1] === "add" &&
          a[4] === `agent/feature-${FIXED_TS}` &&
          a[5] === "feature",
        result: ok(""),
      },
      { match: () => true, result: ok("") }, // config write
    ]);

    const result = createAgentWorktree("/repos/myrepo-feature-20251231-000000", {
      gitExec: git.exec,
      now: () => FIXED_DATE,
    });
    expect(result.base).toBe("feature");
  });

  it("throws when the cwd isn't a git checkout", () => {
    const git = scriptedGit([
      { match: (a) => a[0] === "rev-parse", result: fail("fatal: not a git repository") },
    ]);
    expect(() =>
      createAgentWorktree("/tmp", { gitExec: git.exec, now: () => FIXED_DATE }),
    ).toThrow(TmuxError);
  });

  it("throws when HEAD is detached", () => {
    const git = scriptedGit([
      { match: (a) => a[0] === "rev-parse", result: ok("/repos/myrepo") },
      { match: (a) => a[0] === "symbolic-ref", result: fail("") },
    ]);
    expect(() =>
      createAgentWorktree("/repos/myrepo", {
        gitExec: git.exec,
        now: () => FIXED_DATE,
      }),
    ).toThrow(/HEAD is detached/);
  });

  it("throws when inside an agent worktree with no recorded base and the parsed candidate doesn't resolve", () => {
    const git = scriptedGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel", result: ok("/repos/x") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("agent/missing-20251231-000000") },
      { match: (a) => a[0] === "config", result: fail("") },
      // candidate `missing` doesn't resolve.
      {
        match: (a) =>
          a[0] === "rev-parse" && a[1] === "--verify" && a[3] === "missing",
        result: fail(""),
      },
    ]);
    expect(() =>
      createAgentWorktree("/repos/x", {
        gitExec: git.exec,
        now: () => FIXED_DATE,
      }),
    ).toThrow(/can't infer a base branch/);
  });

  it("propagates the git worktree-add stderr in the TmuxError message", () => {
    const git = scriptedGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel", result: ok("/repos/x") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("main") },
      {
        match: (a) => a[0] === "worktree" && a[1] === "add",
        result: fail("fatal: cannot lock ref"),
      },
    ]);
    expect(() =>
      createAgentWorktree("/repos/x", {
        gitExec: git.exec,
        now: () => FIXED_DATE,
      }),
    ).toThrow(/git worktree add failed.*cannot lock ref/);
  });

  it("doesn't fail when the piBase config write fails (it's nice-to-have)", () => {
    const git = scriptedGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel", result: ok("/repos/x") },
      { match: (a) => a[0] === "symbolic-ref", result: ok("main") },
      { match: (a) => a[0] === "worktree" && a[1] === "add", result: ok("") },
      { match: (a) => a[0] === "config", result: fail("readonly config") },
    ]);
    expect(() =>
      createAgentWorktree("/repos/x", {
        gitExec: git.exec,
        now: () => FIXED_DATE,
      }),
    ).not.toThrow();
  });
});
