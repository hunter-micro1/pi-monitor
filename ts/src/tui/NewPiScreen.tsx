/**
 * Prompt for a directory to launch a new pi agent in. Returns
 * `{ mode, cwd }` on Enter via onSubmit; null via onCancel on Esc.
 *
 * Mirrors `NewPiScreen` in `tui.py`. Uses `ink-text-input` for
 * editable text (cursor positioning, backspace, etc.) and
 * `useInput` to intercept Tab + Enter + Esc before the input
 * sees them.
 */

import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { type ReactElement, useState } from "react";

import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";
import { type ListDir, completeDirPath } from "./dirComplete.js";

export type NewPiMode = "session" | "window";

export interface NewPiResult {
  readonly mode: NewPiMode;
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
}

export function NewPiScreen(props: NewPiScreenProps): ReactElement {
  const { mode, defaultCwd, onSubmit, onCancel, listDir } = props;

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
      alignItems="center"
      justifyContent="center"
      paddingY={2}
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={ACCENT}
        paddingX={2}
        paddingY={1}
        width={72}
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
