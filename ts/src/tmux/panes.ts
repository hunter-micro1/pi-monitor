/**
 * Pane discovery.
 *
 * Direct port of the `Pane` dataclass + `list_panes` /
 * `list_pi_panes` / `is_viewer_session` from
 * `src/pi_monitor/tmux.py`.
 */

import { findAgentPidsForPane } from "../proc/index.js";
import type { AgentType } from "../state/types.js";
import { TmuxError, tmuxRun } from "./client.js";

/** Prefix used for sessions we create as linked viewers. */
export const VIEWER_SESSION_PREFIX = "pi-monitor-view-";

/**
 * Matches a `pane_title` that is actually a leaked Kitty graphics
 * protocol control payload, not a real title.
 *
 * pi (via pi-tui) renders and clears inline images with Kitty
 * graphics APC sequences like `ESC _ Ga=d,d=A,q=2 ESC \` ("delete
 * all images") or `ESC _ Ga=T,f=100,q=2;<base64> ESC \`. tmux has
 * no native Kitty-graphics support, and its APC handler routes the
 * *payload* of any `ESC _ ... ESC \` string straight into the pane
 * title. So a pi pane's title gets overwritten with the raw control
 * string — e.g. `Ga=d,d=A,q=2` — which pi-monitor would otherwise
 * display as the agent's name.
 *
 * The payload always starts with `G`, then comma-separated
 * single-letter `key=value` controls, optionally followed by
 * `;<base64>`. We full-match that exact shape so a legitimate
 * user/agent title is never touched.
 */
const KITTY_GRAPHICS_TITLE_RE =
  /^G[a-z]=[^,;]*(?:,[a-z]=[^,;]*)*(?:;[A-Za-z0-9+/=]*)?$/;

/**
 * Drop pane titles that are leaked Kitty-graphics control payloads
 * (see `KITTY_GRAPHICS_TITLE_RE`). Returns `""` for such titles so
 * the render pipeline falls back to the numeric `pane N` name
 * (`cli.ts` maps `""` → `null`, and `fmtRowMain` then uses the
 * fallback). Any genuine title is returned unchanged.
 */
export function sanitizePaneTitle(title: string): string {
  return KITTY_GRAPHICS_TITLE_RE.test(title) ? "" : title;
}

/**
 * Format string handed to `tmux list-panes -F`. Tab-separated so
 * fields with embedded spaces (paths, titles) survive the round
 * trip. Mirrors the Python build's `_LIST_FORMAT`, plus a trailing
 * `@pi_pane_label` — the per-pane user option the pi-tmux-pane-title
 * extension writes. We prefer it over `pane_title` because pi-tui's
 * Kitty graphics APC corrupts pane_title (see `sanitizePaneTitle`),
 * while the `@`-prefixed option lives in a namespace APC can't touch.
 */
const LIST_FORMAT =
  "#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}" +
  "\t#{pane_pid}\t#{pane_current_path}\t#{pane_title}\t#{pane_current_command}" +
  "\t#{@pi_pane_label}";

/**
 * One tmux pane. Mirrors the Python `Pane` dataclass.
 */
export interface Pane {
  /** Stable tmux pane id like "%42" — survives across renames. */
  paneId: string;
  /** Composite addressing target like "contracts:0.2". */
  target: string;
  session: string;
  windowIndex: number;
  paneIndex: number;
  /** PID of the pane's foreground process (typically a shell). */
  pid: number;
  /** `pane_current_path` — cwd of the foreground process. */
  cwd: string;
  /**
   * Display name for the pane. Prefers the `@pi_pane_label` user
   * option (set by the pi-tmux-pane-title extension; immune to the
   * Kitty-graphics clobber). Falls back to `pane_title` for panes
   * without a label, with leaked Kitty-graphics payloads normalized
   * to `""` (see `sanitizePaneTitle`) so garbage never surfaces as an
   * agent name.
   */
  title: string;
  /**
   * `pane_current_command` — e.g. "pi", "zsh".
   *
   * Note: on macOS, tmux's pane_current_command uses libproc which
   * returns the executable basename, so a Node-based binary like
   * `pi` is reported as `node`. The kernel-tracked `comm` (what
   * `ps -o comm=` and `/proc/<pid>/comm` report) is correct.
   * Don't use this field directly to decide pi-ness; use `isPi`,
   * which falls back to a process-tree walk.
   */
  command: string;
  /**
   * True iff this pane has a `pi` process anywhere in its descendant
   * tree. We can't trust `command === "pi"` alone because tmux on
   * macOS reports `node` for pi panes (libproc returns the
   * executable basename). The tree-walk fallback finds pi via its
   * kernel-tracked `comm` regardless of platform.
   */
  isPi: boolean;
  /** True iff this pane contains a live Claude Code process. */
  isClaude: boolean;
  /** Detected live coding-agent implementation, or null for ordinary panes. */
  agentType: AgentType | null;
}

/**
 * Every pane on the tmux server. Empty array when tmux isn't
 * running (we swallow the `TmuxError` so callers don't have to).
 *
 * Mirrors `list_panes` in the Python build.
 */
export function listPanes(): Pane[] {
  let raw = "";
  try {
    raw = tmuxRun(["list-panes", "-a", "-F", LIST_FORMAT], { capture: true });
  } catch (err) {
    if (err instanceof TmuxError) return [];
    throw err;
  }

  const panes: Pane[] = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const parts = line.split("\t");
    if (parts.length !== 9) continue;
    const [paneId, session, win, pidx, pid, cwd, paneTitle, command, paneLabel] =
      parts as [string, string, string, string, string, string, string, string, string];
    const windowIndex = Number.parseInt(win, 10);
    const paneIndex = Number.parseInt(pidx, 10);
    const pidNum = Number.parseInt(pid, 10);
    if (
      !Number.isFinite(windowIndex) ||
      !Number.isFinite(paneIndex) ||
      !Number.isFinite(pidNum)
    ) {
      continue;
    }
    // Exact tmux commands take the fast path. Otherwise walk the
    // process subtree once; this covers shell-launched agents and
    // platforms where tmux reports a wrapper executable.
    const directType = agentTypeForCommand(command);
    const detected =
      directType === "pi" ? { pi: pidNum, claude: null } : findAgentPidsForPane(pidNum);
    // Pi wins an ambiguous subtree because Pi can launch Claude as a
    // child tool; Pi's heartbeat/session remains authoritative there.
    // If a direct Claude process cannot be inspected, retain the exact
    // tmux command as a reliable fallback instead of dropping the pane.
    const agentType: AgentType | null =
      detected.pi !== null ? "pi" : detected.claude !== null ? "claude" : directType;
    const isPi = agentType === "pi";
    const isClaude = agentType === "claude";
    // @pi_pane_label belongs to Pi's extension; never let a stale pane
    // option rename a Claude row.
    const title =
      isPi && paneLabel.length > 0 ? paneLabel : sanitizePaneTitle(paneTitle);
    panes.push({
      paneId,
      target: `${session}:${win}.${pidx}`,
      session,
      windowIndex,
      paneIndex,
      pid: pidNum,
      cwd,
      title,
      command,
      isPi,
      isClaude,
      agentType,
    });
  }
  return panes;
}

/** Convenience: every pane containing a supported live coding agent. */
export function listAgentPanes(): Pane[] {
  return listPanes().filter((p) => p.agentType !== null);
}

/** Compatibility API: only panes whose tree contains a `pi` process. */
export function listPiPanes(): Pane[] {
  return listPanes().filter((p) => p.isPi);
}

function agentTypeForCommand(command: string): AgentType | null {
  if (command === "pi") return "pi";
  if (command === "claude" || command === "claude-code") return "claude";
  return null;
}

/**
 * True for sessions we created as linked viewers. Mirrors
 * `is_viewer_session`.
 */
export function isViewerSession(name: string): boolean {
  return name.startsWith(VIEWER_SESSION_PREFIX);
}
