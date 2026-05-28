/**
 * Agent-branch worktree creation.
 *
 * pi-monitor's new-pi modal has a `Worktree` toggle. When the user
 * picks ON, this module creates a fresh git worktree at
 * `<repo_parent>/<repo>-<base>-<ts>` on a new branch named
 * `agent/<base>-<ts>`, and pi is launched inside that worktree.
 *
 * Why pi-monitor owns this instead of delegating to the upstream
 * `auto-worktree` pi extension: pi v0.76 hard-rejects unknown CLI
 * flags before any extension factory runs (cli/args.js:173 emits
 * `Unknown option: -w`), so `pi -w` no longer triggers
 * auto-worktree. Until auto-worktree migrates to `pi.registerFlag`
 * (upstream), the only way for the toggle to actually create a
 * worktree is to do it here. The behaviour mirrors auto-worktree's
 * decide() so users get the same `agent/<base>-<ts>` layout they
 * already expect.
 */

import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";

import { TmuxError } from "./client.js";

/** Reserved config key recording the base branch we forked from. */
const PI_BASE_CONFIG_KEY = "piBase";

/** Pattern for an agent-managed branch: `agent/<base>-YYYYMMDD-HHMMSS`. */
const AGENT_BRANCH_RE = /^agent\/(.+)-\d{8}-\d{6}$/;

/**
 * Successful worktree-creation result.
 */
export interface WorktreeResult {
  /** Absolute path to the newly-created worktree. */
  readonly path: string;
  /** Newly-created branch (`agent/<base>-<ts>`). */
  readonly branch: string;
  /** Base branch we forked from. */
  readonly base: string;
}

/**
 * Override hooks for tests. Production callers omit `gitExec` /
 * `now`; tests pass a fake spawnSync-compatible runner.
 */
export interface CreateAgentWorktreeOptions {
  /**
   * Subprocess runner. Defaults to a real `git` spawnSync. Tests
   * pass a fake to drive the decision tree without touching disk.
   */
  readonly gitExec?: (
    args: readonly string[],
    cwd: string,
  ) => { stdout: string; stderr: string; status: number };
  /**
   * Clock. Defaults to `new Date()`. Tests pin it to a known
   * instant so the timestamp suffix is deterministic.
   */
  readonly now?: () => Date;
}

/**
 * Create a fresh agent-branch worktree for `cwd` and return its
 * absolute path. Throws `TmuxError` on any precondition failure
 * (not a git repo, detached HEAD, etc.) so the App can surface
 * the message via its launch-error banner.
 *
 * Steps mirrored from `auto-worktree`'s `decide()`:
 *  1. Resolve `cwd` to its git toplevel.
 *  2. Resolve the current branch; bail if HEAD is detached.
 *  3. Resolve the BASE branch:
 *     - If current branch isn't `agent/*`, it IS the base.
 *     - Else, read `branch.<currentBranch>.piBase` from git config.
 *       If unset, parse `agent/<base>-YYYYMMDD-HHMMSS` from the
 *       current branch name and use that name iff it resolves to
 *       a real ref.
 *  4. Compute the new worktree path + agent-branch name from base
 *     and a `YYYYMMDD-HHMMSS` UTC timestamp.
 *  5. `git worktree add <newPath> -b <newBranch> <baseBranch>`.
 *  6. Record `branch.<newBranch>.piBase = <baseBranch>` so re-runs
 *     inside the new worktree know their base.
 */
export function createAgentWorktree(
  cwd: string,
  options: CreateAgentWorktreeOptions = {},
): WorktreeResult {
  const gitExec = options.gitExec ?? defaultGitExec;
  const now = options.now ?? (() => new Date());

  const toplevel = git(gitExec, cwd, ["rev-parse", "--show-toplevel"]);
  if (toplevel === null) {
    throw new TmuxError(`not a git checkout: ${cwd}`);
  }

  const currentBranch = git(gitExec, toplevel, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (currentBranch === null) {
    throw new TmuxError(`HEAD is detached in ${toplevel}; can't pick a base branch`);
  }

  const baseBranch = resolveBaseBranch(gitExec, toplevel, currentBranch);
  if (baseBranch === null) {
    throw new TmuxError(
      `can't infer a base branch for ${currentBranch}; ` +
        `set branch.${currentBranch}.${PI_BASE_CONFIG_KEY} in this repo to opt in`,
    );
  }

  const ts = formatTimestamp(now());
  const newBranch = `agent/${baseBranch}-${ts}`;
  const repoName = basename(toplevel);
  const newPath = `${dirname(toplevel)}/${repoName}-${baseBranch}-${ts}`;

  // `git worktree add` is atomic: it either creates both the
  // worktree directory and the branch, or neither. Capture stderr
  // so we can surface a useful error in the banner.
  const add = gitExec(
    ["worktree", "add", newPath, "-b", newBranch, baseBranch],
    toplevel,
  );
  if (add.status !== 0) {
    throw new TmuxError(
      `git worktree add failed: ${add.stderr.trim() || add.stdout.trim() || "(no output)"}`,
    );
  }

  // Record the base branch so re-launches inside this worktree can
  // round-trip back to it. Failure is non-fatal; the worktree
  // works either way.
  try {
    gitExec(
      ["config", `branch.${newBranch}.${PI_BASE_CONFIG_KEY}`, baseBranch],
      toplevel,
    );
  } catch {
    // Ignore — config write is a nice-to-have.
  }

  return { path: newPath, branch: newBranch, base: baseBranch };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function defaultGitExec(
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

/** Run git and return trimmed stdout on exit 0, else null. */
function git(
  gitExec: NonNullable<CreateAgentWorktreeOptions["gitExec"]>,
  cwd: string,
  args: readonly string[],
): string | null {
  const r = gitExec(args, cwd);
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out === "" ? null : out;
}

/**
 * Resolve the base branch for `currentBranch`. Mirrors the logic
 * in auto-worktree.ts:
 *
 *  - If currentBranch isn't `agent/...`, it IS the base.
 *  - Else, prefer `git config branch.<currentBranch>.piBase`.
 *  - Else, parse `agent/<base>-YYYYMMDD-HHMMSS` and only return
 *    that `<base>` if `git rev-parse --verify <base>` succeeds.
 */
function resolveBaseBranch(
  gitExec: NonNullable<CreateAgentWorktreeOptions["gitExec"]>,
  toplevel: string,
  currentBranch: string,
): string | null {
  const match = currentBranch.match(AGENT_BRANCH_RE);
  if (match === null) {
    // Not an agent branch — it IS the base.
    return currentBranch;
  }

  // Agent branch. First check the recorded piBase config key.
  const recorded = git(gitExec, toplevel, [
    "config",
    `branch.${currentBranch}.${PI_BASE_CONFIG_KEY}`,
  ]);
  if (recorded !== null) return recorded;

  // Fallback: parse `<base>` out of the agent branch name and
  // verify it's a real ref. Can fail for nested bases (e.g.
  // `feature/foo`) whose slashes were encoded into the timestamp
  // suffix — for those we'd need the explicit config key.
  const candidate = match[1];
  if (candidate === undefined || candidate === "") return null;
  const verify = gitExec(["rev-parse", "--verify", "--quiet", candidate], toplevel);
  if (verify.status !== 0) return null;
  return candidate;
}

/** `YYYYMMDD-HHMMSS` UTC. Matches auto-worktree's naming. */
function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}
