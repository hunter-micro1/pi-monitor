/**
 * Prompt for a directory to launch a new pi agent in. Returns
 * `{ mode, cwd }` on Enter via onSubmit; null via onCancel on Esc.
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
}

export interface NewPiScreenProps {
  /** "session" = `tmux new-session`, "window" = `tmux new-window`. */
  readonly mode: NewPiMode;
  /** Pre-filled cwd. Cursor lands at end of value. */
  readonly defaultCwd: string;
  /** Called with `{ mode, cwd }` when the user presses Enter. */
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

export function NewPiScreen(props: NewPiScreenProps): ReactElement {
  const { mode, defaultCwd, onSubmit, onCancel, listDir, width } = props;

  const [value, setValue] = useState(defaultCwd);
  const [matches, setMatches] = useState<readonly string[]>([]);

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
      const result = completeDirPath(value, listDir);
      setValue(result.value);
      setMatches(result.matches);
      return;
    }
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed === "") {
        onCancel();
        return;
      }
      onSubmit({ mode, cwd: trimmed });
      return;
    }
    // Any other input \u2014 user is typing again. Clear the stale match
    // list once they start adding/removing characters.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      if (matches.length > 0) setMatches([]);
    }
  });

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

      <Box marginTop={1}>
        <Text color={FOREGROUND_MUTED}>{"\u203a "}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          placeholder="directory to start pi in"
          // showCursor is true by default; explicit for clarity.
          showCursor
        />
      </Box>

      <MatchesLine matches={matches} />

      <Box marginTop={1}>
        <Text color={ACCENT}>Tab</Text>
        <Text color={FOREGROUND_MUTED}>{" complete  \u00b7  "}</Text>
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
