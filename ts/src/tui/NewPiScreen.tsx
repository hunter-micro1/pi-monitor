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

type FocusedField = "cwd" | "name";

export function NewPiScreen(props: NewPiScreenProps): ReactElement {
  const { mode, defaultCwd, onSubmit, onCancel, listDir, width } = props;

  const [cwdValue, setCwdValue] = useState(defaultCwd);
  const [matches, setMatches] = useState<readonly string[]>([]);
  // Session name: prefilled from cwd, auto-syncs to cwd basename
  // until the user edits it manually (then we stop syncing so we
  // don't overwrite their choice on every keystroke in the cwd
  // field).
  const [nameValue, setNameValue] = useState(() => deriveSessionName(defaultCwd));
  const [nameTouched, setNameTouched] = useState(false);
  const [focused, setFocused] = useState<FocusedField>("cwd");

  // Window mode hides the name field entirely; tabs only cycle
  // within the cwd field (i.e. completion never moves focus).
  const showNameField = mode === "session";

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
      // In the cwd field: try completion first; if completion
      // produced no change AND no candidate list, cycle focus to
      // the name field (when name field is visible). In the name
      // field: cycle back to cwd.
      if (focused === "cwd") {
        const result = completeDirPath(cwdValue, listDir);
        const advanced = result.value !== cwdValue;
        const hasMatches = result.matches.length > 0;
        if (advanced || hasMatches) {
          setCwdValue(result.value);
          setMatches(result.matches);
          if (advanced && !nameTouched) {
            setNameValue(deriveSessionName(result.value));
          }
          return;
        }
        // No further completion; cycle focus when name field is
        // available. In window mode, just stay (tab is a no-op).
        if (showNameField) {
          setFocused("name");
          setMatches([]);
        }
        return;
      }
      // Currently focused on name; cycle back to cwd.
      setFocused("cwd");
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
      });
      return;
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
  const handleCwdChange = (next: string): void => {
    setCwdValue(next);
    if (!nameTouched) {
      setNameValue(deriveSessionName(next));
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
