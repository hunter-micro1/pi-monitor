# Changelog

All notable changes to pi-monitor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-07

A full visual rewrite of the left pane to match the cmux/Warp design
language while keeping every existing tmux behavior (linked viewers,
hover-preview, monitor session, status widget, heartbeat extension).

### Added
- **Live activity per pane row.** Each row is now two lines: `name · git-branch  …  state-tag` on top, a dim ellipsized one-liner on the bottom showing what the agent is doing right now. The bottom line is sourced from (in priority order) the heartbeat phase, the trimmed last error, or the first text chunk of the latest assistant response.
- **Git branch column.** `branch_for_cwd(cwd)` resolves the current branch via `git symbolic-ref --short HEAD` with a 15s TTL cache; result rendered next to the agent name.
- **Heartbeat-driven activity tags.** When the `pi-monitor-heartbeat` extension is running, the right-hand state tag becomes `running bash`, `compacting`, `thinking`, `retrying #2`, or `awaiting input` instead of plain `working`.
- **Bordered session cards.** Each tmux session is a rounded `SessionGroup` container with the session name in the colored border title; the cursor's card upgrades to a solid `$primary` border via the `.active-group` class.
- **Brightness hierarchy.** Inactive row titles render in `$foreground-muted`; the cursor row plus every row in the focused card upgrade to full `$foreground`. Working titles still pulse via Rich markup, which always wins.
- **Selection animation.** Smooth `transition: background 180ms in_out_cubic` on `PaneRow`; cursor moves fade in/out instead of snapping.
- **Tests for the new render path.** 55 new unit tests covering `_working_verb`, `_activity_tag`, `_activity_description`, `branch_for_cwd` (including TTL caching invariants), `_first_text_preview`, and the `last_assistant_preview` JSONL extraction. Total suite: 125/125 passing.
- **CHANGELOG.md.**

### Changed
- **Default theme is now `tokyo-night`** (was `textual-dark`); cycle reordered so the curated five (tokyo-night, catppuccin-mocha, dracula, gruvbox, textual-dark) come first. The remaining themes stay resolvable so users with config-pinned favorites are not bumped.
- **Translucency works end-to-end.** App now constructs with `ansi_color=True`, which activates Textual's `:ansi` pseudo-class and switches the root background from the theme's RGB `$background` to `ansi_default`. Every transparent-resolved cell emits the ANSI default-bg escape (`ESC[49m`), so the terminal honors its own (translucent) default background instead of an opaque RGB block.
- **WORKING-row pulse floor raised** from `0.55..1.00` to `0.70..1.00`. The old trough blended into the wallpaper on translucent terminals; the new floor stays clearly legible.
- **Selection background uses `ansi_bright_black`** (an ANSI palette gray) instead of an alpha-tinted theme color. Alpha doesn't blend cleanly against `ansi_default`, so the palette color is the predictable choice.
- **Title bar trimmed.** Dropped the redundant `5 panes`, the `sort:` prefix, and the theme name. Now: `pi-monitor   2 working · 1 idle · 1 error`. Sort mode and mute indicator surface only when non-default.
- **State counts in the chrome use colored words** (`2 working · 1 idle`) instead of leading bullet glyphs.
- **README** rewritten to reflect the new layout, keybindings, theming story, and translucency mechanics.

### Removed
- **All decorative glyphs from the TUI**: the `▌` rail, `⠋` spinner, `●` chips in the title bar, `▾`/`▸` collapse arrows. Visual structure is now carried by typography (bold names, dim metadata), color (state tints on titles + state words), and motion (color pulse + selection-bg transition).
- **`Space` keybinding to collapse/expand sessions.** Without disclosure arrows the affordance was awkward; cmux/Warp don't collapse either.
- **`h` / `l` for tree expand/collapse.** Repurposed as previous/next-session-card jumps.

### Fixed
- **Selection no longer turns muddy under translucency.** The previous `$primary 18%` selection bg blended against `ansi_default` (which has no concrete RGB) and produced unpredictable colors; replaced with `ansi_bright_black` (proven palette color).

## [0.1.0] — initial

- Tree-based session viewer with linked-viewer right pane, hover-preview, modal flows for spawning new sessions/windows, theme cycling, mute toggle, heartbeat extension support, viewer reconciliation, status-widget push to tmux.
