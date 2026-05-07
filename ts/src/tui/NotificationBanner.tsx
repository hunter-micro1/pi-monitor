/**
 * Top-of-screen banner surfacing in-TUI notifications fired by the
 * Notifier. Mirrors the Python build's `App.notify(...)` toasts but
 * implemented as a top-pinned banner since Ink doesn't have a
 * Textual-style screen-stack toast primitive.
 *
 * Auto-dismiss is owned by App (a `useEffect` clears the
 * notification state after 5s); this component is pure-render.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { ACCENT, FOREGROUND, FOREGROUND_MUTED } from "./colors.js";

export interface BannerNotification {
  /** Short header (e.g. "pi-monitor \u00b7 %17"). */
  readonly title: string;
  /** Body text (e.g. "agent state: idle"). */
  readonly body: string;
  /** Drives the border color: critical = red, normal = accent. */
  readonly severity: "normal" | "critical";
}

export interface NotificationBannerProps {
  readonly notification: BannerNotification;
}

export function NotificationBanner({
  notification,
}: NotificationBannerProps): ReactElement {
  const borderColor = notification.severity === "critical" ? "#F7768E" : ACCENT;
  return (
    <Box
      flexDirection="row"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      marginX={2}
      marginTop={1}
    >
      <Box flexGrow={1}>
        <Text bold color={FOREGROUND}>
          {notification.title}
        </Text>
        <Text color={FOREGROUND_MUTED}>{"  \u00b7  "}</Text>
        <Text color={FOREGROUND}>{notification.body}</Text>
      </Box>
    </Box>
  );
}
