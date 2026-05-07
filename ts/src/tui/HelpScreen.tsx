/**
 * Modal overlay listing every keybinding. Any key dismisses.
 *
 * Mirrors `HelpScreen` in `tui.py`. The visual difference is the
 * Textual modal centers a 64-col card in the dimmed parent
 * background; Ink doesn't have a screen-stack primitive, so we
 * render this as a top-level component that App swaps in instead
 * of the list view when `mode === 'help'`. The dim-the-background
 * effect isn't reproducible in pure Ink without overdraw tricks;
 * we accept that and rely on the centered bordered card to read
 * as a modal.
 */

import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";

import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";
import { HELP_SECTIONS } from "./helpData.js";

export interface HelpScreenProps {
  /** Called on any keystroke. */
  readonly onDismiss: () => void;
}

export function HelpScreen({ onDismiss }: HelpScreenProps): ReactElement {
  useInput(() => {
    onDismiss();
  });

  // Pad keys to a fixed width so descriptions line up. 11 cols
  // matches the Python build's `key.ljust(11)`.
  const KEY_WIDTH = 11;

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
        width={64}
      >
        <Box marginBottom={1}>
          <Text bold color={ACCENT}>
            pi-monitor \u2014 keybindings
          </Text>
        </Box>

        {HELP_SECTIONS.map((section, sectionIdx) => (
          <Box
            key={section.header}
            flexDirection="column"
            marginTop={sectionIdx === 0 ? 0 : 1}
          >
            <Text bold color={FOREGROUND}>
              {section.header}
            </Text>
            {section.rows.map((row) => (
              <Box key={row.key}>
                <Box width={KEY_WIDTH + 2} paddingLeft={2}>
                  <Text color={ACCENT}>{row.key}</Text>
                </Box>
                <Text color={FOREGROUND}>{row.desc}</Text>
              </Box>
            ))}
          </Box>
        ))}

        <Box marginTop={1}>
          <Text dimColor color={FOREGROUND_MUTED}>
            press any key to dismiss
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
