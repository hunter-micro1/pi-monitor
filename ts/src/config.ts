/**
 * Persistent user config for pi-monitor.
 *
 * Direct port of `load_config` / `save_config` in
 * `src/pi_monitor/notify.py`. The file lives at
 * `~/.config/pi-monitor/config.json` and is shared with the Python
 * build: same path, same snake_case keys, so a user's theme / sort /
 * mute choice persists across both binaries.
 *
 * Only touched on an explicit user action (cycle theme, cycle sort,
 * toggle mute) — never written speculatively.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Persisted shape. Keys mirror the Python build verbatim. */
export interface PiMonitorConfig {
  /** Active theme name (one of THEME_CYCLE; validated on load). */
  theme: string;
  /** "tmux" (pane order) or "status" (needs-attention-first). */
  sort_mode: "tmux" | "status";
  /** Desktop + in-app notifications enabled. */
  notifications_enabled: boolean;
}

export const DEFAULT_CONFIG: PiMonitorConfig = {
  theme: "tokyo-night",
  sort_mode: "tmux",
  notifications_enabled: true,
};

/** Absolute path to the JSON config file. */
export function configPath(): string {
  return join(homedir(), ".config", "pi-monitor", "config.json");
}

/**
 * Load config, merging persisted values over defaults. Any read /
 * parse failure (missing file, bad JSON, permissions) falls back to
 * the defaults — config is a convenience, never load-bearing.
 */
export function loadConfig(): PiMonitorConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const data = JSON.parse(raw) as unknown;
    if (data === null || typeof data !== "object") {
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...(data as Partial<PiMonitorConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Persist config, creating the parent directory if needed. Swallows
 * write errors (read-only home, etc.) — a failed persist must never
 * crash the TUI.
 */
export function saveConfig(config: PiMonitorConfig): void {
  const path = configPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // Best-effort; ignore.
  }
}
