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

import { useTheme } from "./ThemeContext.js";

export function EmptyState(): ReactElement {
  const theme = useTheme();
  return (
    <Box
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      paddingY={2}
    >
      <Text bold color={theme.accent}>
        No pi sessions yet
      </Text>
      <Box marginTop={1}>
        <Text color={theme.foregroundMuted}>Press </Text>
        <Text bold color={theme.accent}>
          o
        </Text>
        <Text color={theme.foregroundMuted}> to launch a new agent</Text>
      </Box>
      <Box>
        <Text color={theme.foregroundMuted}>Press </Text>
        <Text bold color={theme.accent}>
          ?
        </Text>
        <Text color={theme.foregroundMuted}> to see all keybindings</Text>
      </Box>
    </Box>
  );
}
