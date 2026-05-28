/**
 * Prompt for a directory + session name to launch a new pi agent
 * in. Returns `{ mode, cwd, name }` on Enter via onSubmit; null
 * via onCancel on Esc.
 *
 * Two stacked text inputs (`Directory` + `Session name`). Tab
 * cycles between them; in the cwd field Tab also does path
 * completion (longest common prefix + trailing slash on a unique
 * match) before cycling once nothing more can be completed. The
 * name field hides entirely in window mode — windows live inside
 * an existing session, so a session name is irrelevant there.
 *
 * Renders as a self-contained bordered box. The App composes it
 * into the main layout as a bottom popup (replacing the details
 * box while open) so the pane list stays visible behind it; the
 * component itself does NOT center / fullscreen — size and
 * placement are the caller's responsibility.
 *
 * Uses `ink-text-input` for editable text (cursor positioning,
 * backspace, etc.) and `useInput` to intercept Tab + Enter + Esc
 * before the input sees them.
 */

import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { type ReactElement, useState } from "react";

import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";
import { type ListDir, completeDirPath } from "./dirComplete.js";
import { branchForCwd as defaultBranchForCwd } from "./git.js";

export type NewPiMode = "session" | "window";

export interface NewPiResult {
  readonly mode: NewPiMode;
  /**
   * For window mode: the tmux session the new window should be
   * added to. Set by App from the cursored pane's session before
   * dispatching to onLaunchPi. Always undefined for session mode.
   */
  readonly targetSession?: string;
  readonly cwd: string;
  /**
   * Session name the user typed in the Session-name field. Only
   * meaningful for `mode === "session"`; window mode ignores it
   * (it spawns inside `targetSession`). Empty string means 'no
   * preference' — the caller should fall back to its auto-name
   * heuristic (basename + collision suffix).
   */
  readonly name?: string;
  /**
   * True iff pi should be launched with `-w`, so the bundled
   * auto-worktree extension creates a fresh `agent/<base>-<ts>`
   * worktree and re-execs pi inside it. False to run pi in place
   * on the cwd's current branch. Default in the UI is true when
   * the cwd resolves to a git checkout on a named branch; the
   * user can toggle with `w`.
   */
  readonly worktree: boolean;
}

export interface NewPiScreenProps {
  /** "session" = `tmux new-session`, "window" = `tmux new-window`. */
  readonly mode: NewPiMode;
  /** Pre-filled cwd. Cursor lands at end of value. */
  readonly defaultCwd: string;
  /** Called with the result on Enter. */
  readonly onSubmit: (result: NewPiResult) => void;
  /** Called when the user presses Esc. */
  readonly onCancel: () => void;
  /** Optional listDir override (tests). */
  readonly listDir?: ListDir;
  /**
   * Outer width of the bordered popup. Defaults to undefined,
   * which lets Yoga size it to the content. The App passes
   * `contentWidth - 4` so the popup fits inside its paddingX=2
   * sidebar without overflowing on narrow panes.
   */
  readonly width?: number;
  /**
   * Branch resolver override (tests). Returns the git branch name
   * for a cwd, or null if not a checkout / detached HEAD. The
   * default cached resolver is used in production. Used to seed
   * the worktree-toggle default (true when on a named branch).
   */
  readonly branchForCwd?: (cwd: string) => string | null;
}

/**
 * Default for the Session-name field, derived from a cwd. Strips
 * trailing slashes and takes the basename; `pi` for empty / root
 * cwds. Mirrors the heuristic in `tmux/monitor.ts:suggestSessionName`,
 * minus the collision-suffix step (the user can override here).
 *
 * Exported for unit tests; production callers go through the
 * component's render path.
 */
export function deriveSessionName(cwd: string): string {
  const base = cwd.replace(/\/+$/, "").split("/").pop() || "pi";
  return base;
}

/** Width of the dim label column on the left of each input row. */
const LABEL_COL = 14;

/**
 * Focusable element in the modal. Tab cycles between them; the two
 * text inputs only react to keystrokes while focused, and the
 * worktree row only intercepts the toggle hotkeys while focused.
 * This keeps `w` / Space from being typed into the cwd/name fields.
 */
type FocusedField = "cwd" | "name" | "worktree";

export function NewPiScreen(props: NewPiScreenProps): ReactElement {
  const { mode, defaultCwd, onSubmit, onCancel, listDir, width } = props;

  const branchResolver = props.branchForCwd ?? defaultBranchForCwd;

  const [cwdValue, setCwdValue] = useState(defaultCwd);
  const [matches, setMatches] = useState<readonly string[]>([]);
  // Session name: prefilled from cwd, auto-syncs to cwd basename
  // until the user edits it manually (then we stop syncing so we
  // don't overwrite their choice on every keystroke in the cwd
  // field).
  const [nameValue, setNameValue] = useState(() => deriveSessionName(defaultCwd));
  const [nameTouched, setNameTouched] = useState(false);
  const [focused, setFocused] = useState<FocusedField>("cwd");
  // Worktree toggle. Default: on when the cwd appears to be a git
  // checkout on a named branch (so the auto-worktree extension has
  // something to do), off otherwise. The user can flip with `w`.
  // We snapshot the default at mount; later edits to the cwd field
  // don't silently flip the toggle out from under the user.
  const [worktree, setWorktree] = useState<boolean>(() => {
    return branchResolver(defaultCwd) !== null;
  });
  // Once the user explicitly toggles, stop auto-syncing on cwd
  // edits. Until then, a cwd change that moves between a git
  // checkout and a non-checkout updates the toggle.
  const [worktreeTouched, setWorktreeTouched] = useState<boolean>(false);

  // Window mode hides the name field entirely; tabs cycle
  // cwd ↔ worktree only in that mode.
  const showNameField = mode === "session";

  /**
   * Next focus target in the Tab cycle. Cwd → name → worktree → cwd
   * in session mode; cwd → worktree → cwd in window mode.
   */
  const nextFocus = (current: FocusedField): FocusedField => {
    if (current === "cwd") return showNameField ? "name" : "worktree";
    if (current === "name") return "worktree";
    return "cwd";
  };

  const title =
    mode === "session"
      ? "Launch pi in a new tmux session"
      : "Launch pi in a new window (current session)";

  // ---------------------------------------------------------------------
  // Key handler. We intercept Tab + Esc + Enter at the App layer so
  // they don't get swallowed by ink-text-input.
  // ---------------------------------------------------------------------
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.tab) {
      // In the cwd field: try completion. If Tab advanced the
      // value, stay on cwd so the user can keep tabbing through
      // deeper levels. If it just listed alternates (advance=false
      // but matches were returned), cycle to the next field —
      // otherwise the user gets stuck on cwd whenever the current
      // directory has any subdirs. On a no-op Tab (no advance, no
      // matches) we also cycle. In the name/worktree fields:
      // unconditional cycle.
      if (focused === "cwd") {
        const result = completeDirPath(cwdValue, listDir);
        const advanced = result.value !== cwdValue;
        if (advanced) {
          setCwdValue(result.value);
          setMatches(result.matches);
          if (!nameTouched) {
            setNameValue(deriveSessionName(result.value));
          }
          return;
        }
        setMatches(result.matches);
        setFocused(nextFocus("cwd"));
        return;
      }
      setFocused(nextFocus(focused));
      return;
    }
    if (key.return) {
      const trimmedCwd = cwdValue.trim();
      if (trimmedCwd === "") {
        onCancel();
        return;
      }
      const trimmedName = nameValue.trim();
      onSubmit({
        mode,
        cwd: trimmedCwd,
        // Empty name signals 'use the caller's auto-naming
        // heuristic' so the existing collision-suffix path stays
        // available. Window mode always sends an empty name.
        name: showNameField ? trimmedName : "",
        worktree,
      });
      return;
    }
    // Worktree row is focused: Space or `w` flips the toggle.
    // We only honor these here so neither key is ever consumed by
    // the text inputs (their `focus` prop is false when the
    // worktree row is the focused element, so they aren't reading
    // stdin in this state).
    if (focused === "worktree") {
      if (input === " " || input === "w") {
        setWorktree((v) => !v);
        setWorktreeTouched(true);
        return;
      }
    }
    // Any other input — user is typing again. Clear the stale match
    // list once they start adding/removing characters in the cwd
    // field.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      if (matches.length > 0) setMatches([]);
    }
  });

  // Keep the session-name pre-fill in sync with the cwd basename
  // until the user edits the name field. Once they do, nameTouched
  // flips and the auto-sync stops.
  // Worktree toggle: auto-sync on cwd-change until the user has
  // explicitly pressed `w`. Re-resolving the branch every keystroke
  // hits a cached git probe, so it's cheap; the cache keeps it
  // sub-microsecond after the first lookup per cwd.
  const handleCwdChange = (next: string): void => {
    setCwdValue(next);
    if (!nameTouched) {
      setNameValue(deriveSessionName(next));
    }
    if (!worktreeTouched) {
      setWorktree(branchResolver(next) !== null);
    }
  };
  const handleNameChange = (next: string): void => {
    setNameValue(next);
    setNameTouched(true);
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={ACCENT}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Text bold color={ACCENT}>
        {title}
      </Text>

      {/* Directory field. Always visible. */}
      <Box marginTop={1} flexDirection="row">
        <Box width={LABEL_COL}>
          <Text color={FOREGROUND_MUTED}>Directory</Text>
        </Box>
        <Text color={focused === "cwd" ? ACCENT : FOREGROUND_MUTED}>{"\u203a "}</Text>
        <Box flexGrow={1} flexShrink={1}>
          <TextInput
            value={cwdValue}
            onChange={handleCwdChange}
            placeholder="directory to start pi in"
            focus={focused === "cwd"}
            // showCursor is true by default; explicit for clarity.
            showCursor
          />
        </Box>
      </Box>

      {/* Session-name field. Hidden in window mode. */}
      {showNameField && (
        <Box marginTop={1} flexDirection="row">
          <Box width={LABEL_COL}>
            <Text color={FOREGROUND_MUTED}>Session name</Text>
          </Box>
          <Text color={focused === "name" ? ACCENT : FOREGROUND_MUTED}>
            {"\u203a "}
          </Text>
          <Box flexGrow={1} flexShrink={1}>
            <TextInput
              value={nameValue}
              onChange={handleNameChange}
              placeholder="auto (basename of dir)"
              focus={focused === "name"}
              showCursor
            />
          </Box>
        </Box>
      )}

      <MatchesLine matches={matches} />

      {/* Worktree toggle. Always visible (session AND window
          mode); auto-worktree fires whenever pi launches with `-w`,
          regardless of whether we used `tmux new-session` or
          `tmux new-window` to start it. Tab-focusable so `w`/Space
          don't conflict with text-input typing. */}
      <Box marginTop={1} flexDirection="row">
        <Box width={LABEL_COL}>
          <Text color={FOREGROUND_MUTED}>Worktree</Text>
        </Box>
        <Text color={focused === "worktree" ? ACCENT : FOREGROUND_MUTED}>
          {"\u203a "}
        </Text>
        <Text bold color={worktree ? ACCENT : FOREGROUND_MUTED}>
          {worktree ? "[\u2713] ON " : "[ ] OFF"}
        </Text>
        <Text color={FOREGROUND_MUTED}>{"  Tab to focus, "}</Text>
        <Text color={focused === "worktree" ? ACCENT : FOREGROUND_MUTED}>w</Text>
        <Text color={FOREGROUND_MUTED}>{"/"}</Text>
        <Text color={focused === "worktree" ? ACCENT : FOREGROUND_MUTED}>Space</Text>
        <Text color={FOREGROUND_MUTED}>{" to toggle"}</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={ACCENT}>Tab</Text>
        <Text color={FOREGROUND_MUTED}>{" cycle/complete  \u00b7  "}</Text>
        <Text color={ACCENT}>Enter</Text>
        <Text color={FOREGROUND_MUTED}>{" launch  \u00b7  "}</Text>
        <Text color={ACCENT}>Esc</Text>
        <Text color={FOREGROUND_MUTED}>{" cancel"}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

function MatchesLine({
  matches,
}: {
  readonly matches: readonly string[];
}): ReactElement {
  if (matches.length === 0) {
    // Reserve the line so the layout doesn't jump when matches arrive.
    return <Box marginTop={1} />;
  }
  // Show up to 6 candidates inline; `+N more` summary past that.
  const visible = matches.slice(0, 6);
  const extra = matches.length - visible.length;
  return (
    <Box marginTop={1}>
      <Text color={FOREGROUND_MUTED} dimColor>
        {visible.join("  ")}
        {extra > 0 ? `  +${extra} more` : ""}
      </Text>
      <Text color={FOREGROUND}> </Text>
    </Box>
  );
}
