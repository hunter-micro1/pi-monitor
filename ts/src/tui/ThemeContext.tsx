/**
 * React context carrying the active {@link Theme}.
 *
 * Replaces the Python build's module-global color mutation
 * (`_refresh_state_colors` rewrites STATE_COLORS / ACCENT in place).
 * Module mutation doesn't trigger React re-renders, so instead the
 * App owns the active theme name in state and provides the resolved
 * palette here; every chrome component reads it via {@link useTheme}.
 *
 * The default value is the tokyo-night palette, so components
 * rendered outside a provider (e.g. unit tests that mount a single
 * component) still get sensible colors without a wrapper.
 */

import { type ReactElement, type ReactNode, createContext, useContext } from "react";

import { type Theme, themeByName } from "./themes.js";

const ThemeContext = createContext<Theme>(themeByName("tokyo-night"));

export function ThemeProvider({
  theme,
  children,
}: {
  theme: Theme;
  children: ReactNode;
}): ReactElement {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/** Read the active theme palette. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}
