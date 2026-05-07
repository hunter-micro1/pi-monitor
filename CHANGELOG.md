# Changelog

All notable changes to pi-monitor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file tracks the **Python** build (PyPI). The TypeScript build
(npm, canonical from 0.4.0) has its own changelog at
[`ts/CHANGELOG.md`](./ts/CHANGELOG.md).

## [0.4.0 (TypeScript)] — 2026-05-07

The TypeScript build at [`ts/`](./ts) ships as `@hshayde/pi-monitor` on
npm (scoped because the unscoped `pi-monitor` name was already taken;
the installed binary on PATH is still `pi-monitor`). Functional parity
with the Python 0.3.0 build; same product, same UX, different runtime.
Both packages are supported in parallel:

- `npm install -g @hshayde/pi-monitor` — TS build (canonical going forward).
- `uv tool install --from git+https://github.com/hshayde/pi-monitor pi-monitor`
  — Python build (continues at 0.3.x; receives bug fixes).

Full TS changelog at [`ts/CHANGELOG.md`](./ts/CHANGELOG.md). The Python
build's last released version remains 0.3.0; that version is what's
described in the rest of this file.

## [0.3.0] — 2026-05-07

Cross-platform release. The TUI now runs unchanged on macOS as well as
Linux; CI is hardened with app-level tests and an empty-state polish.

### Added

- **macOS support.** Process resolution (walking each pane's tree to its
  `pi` descendant + reading the pi process's start time to disambiguate
  panes that share a cwd) is now backed by [psutil](https://github.com/giampaolo/psutil),
  so the same code runs on Linux (`/proc`) and macOS (`kinfo_proc`).
  Notifications fall back to `osascript` (Notification Center) when
  `notify-send` isn't on PATH; in headless SSH sessions notifications
  are silently skipped while the in-TUI toast still fires.
- **15 app-level tests** (`tests/test_tui_app.py`) driving `PiMonitorApp`
  via Textual's headless `run_test()` Pilot. Covers the cursor model
  under j/k, `.selected` / `.active-group` class toggling, mount/unmount
  diff against synthetic pane data, the empty-state welcome, the jump
  shortcut, and the SessionGroup header-first invariant.
- **14 cross-platform tests** (`tests/test_cross_platform.py`) for the
  notification dispatch (notify-send, osascript fallback, no-transport
  no-op, JSON-escaping a body with quotes, swallowed subprocess errors)
  and the psutil-backed process resolver (create_time pass-through,
  NoSuchProcess / AccessDenied / ZombieProcess handling, descendant
  walking with a dead pid mid-walk).
- **Polished zero-sessions empty state.** With no agents present the
  scroll area expands a centered welcome block: bold accent heading
  `No pi sessions yet`, then `Press o to launch a new agent` and
  `Press ? to see all keybindings` with the action keys highlighted in
  the brand accent. Title bar stays plain so the eye lands on the
  call-to-action.
- **GitHub Actions CI** running ruff + pytest on Python 3.9 (the
  `requires-python` floor) and 3.13, plus a wheel/sdist build job that
  uploads the artifacts. Matrix uses concurrency cancellation so stale
  pushes don't burn minutes.
- **PEP 735 dev dependency group** (`pytest>=8`, `ruff>=0.13`) so a
  fresh `uv sync` has the test/lint stack available without any extra
  opt-in.
- **`uv.lock`** committed for reproducible installs and CI cache key
  generation.

### Changed

- **`psutil>=5.9`** added to runtime dependencies.
- **`_proc_starttime` and `find_pi_pid_for_pane`** rewritten on top of
  psutil. The public API and call sites are unchanged — existing
  state.py monkeypatch tests keep working — but the internals no longer
  read `/proc/<pid>/stat`, `/proc/uptime`, or `/proc/<pid>/task/<pid>/children`,
  so they work on any psutil-supported platform.
- **README**: dropped the macOS-not-supported note in Known Limitations,
  updated Requirements to mention psutil and macOS support, expanded
  the Notifications section to document the dual notify-send / osascript
  transport.

### Fixed

- **Cursor now lands on the first pane row on launch** when at least one
  pane is visible (matches cmux/Warp). Previously `_rebuild_cursor_positions`
  preserved the seed `("new",)` cursor on first tick instead of
  promoting to the first pane, because the seed was always present in
  the rebuilt positions list and the fallback only fired when the
  previous position had vanished. New `_first_render_done` flag
  distinguishes initial paint from steady-state ticks.

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
