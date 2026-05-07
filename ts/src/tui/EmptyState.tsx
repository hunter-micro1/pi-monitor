/**
 * Welcome card shown when the user has no pi sessions running.
 *
 * Mirrors the centered welcome block in
 * `_render` of the Python `tui.py`. Bold accent heading + two
 * action prompts with the action keys highlighted. Centered both
 * axes so first-launch users land on something inviting instead
 * of an empty list.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { ACCENT, FOREGROUND_MUTED } from "./colors.js";

export function EmptyState(): ReactElement {
  return (
    <Box
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      paddingY={2}
    >
      <Text bold color={ACCENT}>
        No pi sessions yet
      </Text>
      <Box marginTop={1}>
        <Text color={FOREGROUND_MUTED}>Press </Text>
        <Text bold color={ACCENT}>
          o
        </Text>
        <Text color={FOREGROUND_MUTED}> to launch a new agent</Text>
      </Box>
      <Box>
        <Text color={FOREGROUND_MUTED}>Press </Text>
        <Text bold color={ACCENT}>
          ?
        </Text>
        <Text color={FOREGROUND_MUTED}> to see all keybindings</Text>
      </Box>
    </Box>
  );
}
