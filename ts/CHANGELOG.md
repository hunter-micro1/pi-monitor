# pi-monitor (TypeScript) changelog

All notable changes to the TypeScript build of pi-monitor are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Python build at the repo root has its own changelog at
[`../CHANGELOG.md`](../CHANGELOG.md).

## [0.4.15] — 2026-05-08

Bottom details box trimmed to a four-line minimal layout per
user request: title row + `Worktree` + `When` + `Tokens`. Drops
the `Doing`, `Prompt`, `Reply`, and `Error` lines.

- Title row still shows `name · branch | activity tag`, so the
  branch and current state are visible without a dedicated
  label row.
- Removed the `truncate` import and the `describeDoing` helper
  from `PaneDetails.tsx`. Less code, narrower surface.
- A regression-guard test in `tests/tui/PaneDetails.test.tsx`
  feeds a worst-case status that previously populated every
  detail line and asserts none of `Doing` / `Prompt` / `Reply` /
  `Error` appear in the rendered frame.

Note: `Tokens` is sourced from the JSONL snapshot, which the
resolver intentionally skips while the `pi-monitor-heartbeat`
extension is publishing fresh status (the heartbeat fast-path).
That means the `Tokens` line briefly disappears during a
tool-call and reappears once the agent goes idle. Pre-existing
behaviour from 0.4.0; surfacing it here so it isn't surprising.

## [0.4.14] — 2026-05-08

Details-box upgrades for the bottom-of-sidebar pane summary.

- **App pinned to absolute pane height.** The outer Ink Box now
  sets `height={stdout.rows}` (default 24 in tests / non-TTY).
  Before, the flex spacer between the row list and the details
  box only claimed leftover space inside the App's _natural_
  height; on a tall monitor pane with a short pane list, the
  details box sat in the middle with empty rows below. Now it
  pins to the literal bottom of the pane.
- **`Worktree` line.** Shows the pi descendant's actual cwd —
  typically the auto-worktree dir like
  `~/Projects/foo-hunter-poc-20260508-143208` — with the user's
  `$HOME` collapsed to `~`. Disambiguates the case where two
  panes share a branch name across different worktree dirs.
- **`When` line.** Renders `Started Xh Ym ago · idle Zs` from the
  session JSONL filename (pi names every file
  `YYYY-MM-DDTHH-MM-SS-mmmZ_<uuid>.jsonl`) plus the resolver's
  existing `idleSeconds`. Shows whichever halves are computable
  — idle alone when the filename can't be parsed, Started alone
  when idle is < 1s, hidden entirely when neither is available.
- New `fmtDuration`, `fmtCwdDisplay`, `parseSessionStartFromFile`
  helpers in `format/row.ts` cover the new formatting; details-box
  label column widened from 8 to 10 chars to accommodate `Worktree`.

## [0.4.13] — 2026-05-08

Two bug fixes for symptoms that showed up together once the
bottom-of-sidebar details box landed in 0.4.9: the same pi pane
appearing twice in the list, and the box rendering only its
title row with no detail lines.

- **Dedupe panes by `paneId`.** Tmux's session-grouping
  (`new-session -t <source>`) makes the kernel report the same
  pane id under every sister session, so a user-created sister
  like `pi-9-13` linked to `pi-9` would render pane `%11` twice.
  The viewer-prefix filter introduced in 0.4.9 only catches
  `pi-monitor-view-*` sisters; this release adds a paneId-based
  dedupe (first occurrence wins) that catches every other
  group-sister case. New `selectAgentPanes` helper in
  `tmux/agentPanes.ts` lifts the three filter rules
  (own-monitor / viewer-prefix / dedupe) out of `cli.ts` so
  they're unit-testable.
- **`findPiPidForPane` now returns the deepest pi descendant.**
  Previously a BFS that returned the first pi it saw, which is
  the outer pi at the tmux launch cwd. The `auto-worktree`
  extension re-execs pi inside an `agent/<base>-<ts>` worktree,
  producing a chain (outer pi → inner pi at the worktree). The
  outer pi's cwd is wrong for the JSONL claim, so `procCwd`
  landed on the launch dir, the snapshot came back null, and
  the details box collapsed to its title row. Now walks the
  whole reachable subtree and returns the deepest `comm == pi`
  process, so `procCwd` resolves the worktree dir and the
  details box shows the actual prompt / reply / tokens / error.
  Mirrored in both `proc/linux.ts` and `proc/macos.ts`.

## [0.4.12] — 2026-05-08

Visual cohesion + layout polish for the sidebar.

- **Per-session pane title color.** Each section's hash-of-name
  color (introduced in 0.4.9 for the section header) now also
  applies to every non-working pane title in that section, so
  each section reads as a colored block. Working titles still
  use the pulse color so the row visibly breathes. The cursor
  cue stays the leftmost `▎` bar marker; title color does NOT
  change between selected and non-selected rows, keeping the
  section grouping clean.
- **Details box pinned to the very bottom of the sidebar.** A
  flex spacer between the row list and the details box claims
  all leftover vertical space, so the box always sits just above
  the footer hints regardless of how many panes are in the list.
  Trains your eye on a constant location for the
  branch / Doing / Prompt / Reply / Tokens / Error info.

## [0.4.11] — 2026-05-08

Bug-fix release. The state resolver now follows the pi descendant's
actual cwd when claiming JSONL session files, fixing a long-standing
data-flow gap that left every pi pane stuck at `unknown` whenever
the `auto-worktree` extension re-execs pi inside an `agent/<base>-<ts>`
worktree distinct from the tmux pane's shell cwd. With this fix the
details-box content (Doing / Prompt / Reply / Tokens / Error) lights
up again because the snapshots populate.

- **`procCwd(pid)` in the proc shim.** Linux reads the
  `/proc/<pid>/cwd` symlink; macOS shells out to
  `lsof -a -p <pid> -d cwd -Fn`. Both return null when the pid is
  gone, the lookup is unreadable / EACCES, or the platform tool
  isn't on PATH.
- **Resolver uses `procCwd(piPid)` for grouping + claim.** After
  the existing `findPiPidForPane` walk, the resolver also captures
  the pi descendant's actual cwd. That cwd — not the tmux pane's
  `pane_current_path` — is used both for grouping pi panes and
  for `claimSessionFile`'s session-dir lookup. Falls back to the
  ref's tmux cwd when `procCwd` returns null (no pi descendant or
  /proc unreadable). Display-side branch resolution
  (`branchForCwd`) still uses the tmux cwd, so the rendered branch
  name is unchanged.

## [0.4.10] — 2026-05-08

Details-box content release. The bottom-of-sidebar box added in
0.4.9 now shows the user's last prompt and cumulative token / cost
usage alongside the agent's last reply, so you can answer "what
has this session done and what has it cost" without leaving the
TUI.

- **Last user prompt** (`Prompt` line). The JSONL parser now
  captures the first text chunk of the most recent `role: user`
  message into `JsonlSnapshot.lastUserPrompt`. Renders in the
  details box truncated to 200 chars (vs 80 inline).
- **Cumulative tokens + cost** (`Tokens` line). The parser sums
  `usage.totalTokens` and `usage.cost.total` across every
  assistant turn into `JsonlSnapshot.cumulativeTokens` and
  `cumulativeCostUsd`. Renders as `28.7K total · $0.06` when
  there's anything to show; hidden when zero. Defensive against
  assistant turns with missing or malformed usage metadata.
- **`Last` line renamed to `Reply`.** Now that the box has both
  the user's prompt and the agent's reply, the labels read as
  the conversational pair (`Prompt` / `Reply`) instead of the
  ambiguous `Last`.
- New `fmtTokens` and `fmtCostUsd` helpers in `format/row.ts`
  for the compact display (raw int < 1k, `<x.x>K` < 1M,
  `<x.x>M` above; cost `<¢1` sub-cent, `$0.NN` mid, `$N.NN`
  above $1).

## [0.4.9] — 2026-05-08

Three small sidebar improvements: a duplicate-tab data-correctness
fix, per-session header colors so users can scan-by-color, and a
bottom-of-sidebar details box that expands the cursor row.

- **Drop the duplicate `pi-monitor-view-*` SessionGroup.** tmux's
  session-grouping makes the linked viewer (`pi-monitor-view-apps`
  etc.) report the same pi panes a second time under the
  viewer-session name. The sidebar previously rendered each pi pane
  in two SessionGroups: once under its real session, once under the
  viewer (visually a duplicate "tab"). Filtered out at the pane
  source so each pi pane shows up exactly once in its real session.
- **Per-session header colors.** Each tmux session in the sidebar
  now gets a stable color derived from its name (djb2 hash mod
  8-color palette). Same session always lands on the same color
  across launches. Palette is hand-picked to be tokyo-night-
  compatible AND distinct from the state colors
  (working/idle/error/...) so a session header never reads as a
  state pill. Mirrors cmux's per-workspace color idiom (cmux
  issue #1753) but auto-derives the color rather than asking the
  user.
- **Bottom-of-sidebar details box.** Cursor on a pane row now
  expands into a 2-5 line details box between the row list and
  the footer. Layout: divider → title · branch state → "Doing"
  line (heartbeat phase + tool, when present) → "Last" line
  (assistant preview, capped at 200 chars vs 80 inline) → "Error"
  line (only on error rows). Hidden when the cursor isn't on a
  pane (the `+ new pi session` row, or empty list).

## [0.4.8] — 2026-05-08

Visual-only release. Aligns the active-row cue with cmux's
single-tab idiom and pulls in pi's own Loader spinner for working
rows so the sidebar speaks the same visual language as the agent
terminal.

- **Drop the section block highlight.** Previously every row in
  the section containing the cursor brightened en-masse, and the
  section header switched to the accent color. Both effects are
  removed: only the cursor row brightens (via the existing `▎`
  bar marker + a foreground title), all other rows stay muted.
  Mirrors cmux's single-tab highlight (one row at a time) rather
  than a multi-row block highlight.
- **Pi-style 9-dot Braille spinner on working rows.** The
  right-side activity tag for any row in the `working` state is
  now prefixed with the same 10-frame Braille animation
  (`⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` at 80ms) that pi itself
  uses in its Loader component (`@mariozechner/pi-tui`). The
  spinner shares the existing pulse `setInterval` so it adds no
  new timer; the two animations are phase-locked at 80ms.
- **Cursor-row brightening on the spinner.** When a row is both
  selected (cursor is on it) AND working, the spinner glyph
  renders in the accent color instead of the pulse green, giving
  the focused-and-working row a visible cue without disturbing
  the verb's pulse breathing.

## [0.4.7] — 2026-05-07

- **`--reset` flag** to nuke the existing `monitor` tmux session
  before bootstrapping. Necessary after upgrading the npm package:
  the bootstrap path is normally a no-op when a session named
  `monitor` already exists, so pane 0 keeps running the previous
  binary's process and you don't see the new UI. Run
  `pi-monitor --reset` once after `npm install -g @hshayde/pi-monitor@latest`
  to get a fresh session running the new binary.
- **State-colored leading dot on activity descriptions.** Each
  pane row's bottom line (the dim activity-line) now leads with
  a `●` colored by the row's state, matching the title-bar
  status pills and section chips. Every state cue across the
  TUI now uses the same dot grammar.
- Activity-line render is suppressed entirely when there's no
  description (e.g. `no_pi` rows), so we don't render an orphan
  dot on a blank line.

## [0.4.6] — 2026-05-07

UI polish release. Three focused passes on the rendered TUI; no
functional changes. The look targets cmux's flat-list sidebar more
directly, with status-pill indicators and a brief flash animation
on cursor moves.

- **Cursor highlight via a left-edge bar marker (`▎`).** Replaces
  the earlier `inverse` text-style highlight, which read as harsh
  on translucent backgrounds. Selected rows show the bar in accent
  color; non-selected rows reserve the same column with a space so
  all rows align.
- **Status pills with colored dots.** Title-bar state counts and
  per-section chips now render as `● 1 error` (state-colored
  dot, full-foreground count, dim label) instead of plain colored
  text. Reads as an indicator at a glance.
- **Flat list with horizontal dividers.** Session cards no longer
  use rounded bordered boxes. Sections are separated by a single
  thin dim divider (Ink `borderTop`) and each section is a header
  - rows. Mirrors cmux's sidebar layout.
- **Cursor-flash animation.** When the cursor moves to a new row,
  the bar briefly lerps from accent toward white and decays back
  over 250ms. Cheap (piggybacks on the existing pulse interval);
  gives the cursor a visible beat that Ink's atomic frame
  rendering can't otherwise provide.
- **Footer cleanup.** `j/k move   g/G top/bot   o new   ? help   q quit`
  becomes `j k move    ↵ focus    o new    ? help    q quit`
  (drop g/G; surface the Tab/Enter handoff to the right pane).
- **Width cap on wide terminals.** Content capped at 100 cols via
  `useStdout`. Wide terminals (200+ cols) no longer have stretchy
  cards; the right side becomes wallpaper bleed-through.
- **Title-bar cleanup.** Drops the leftover `status` placeholder
  text that had been sitting next to the brand name.
- **`scripts/render-png.sh`** — new tooling that renders the App
  via tmux capture-pane + ANSI-to-HTML + headless Chrome. Useful
  for design reviews of the live colored output without a real
  interactive client.

## [0.4.5] — 2026-05-07

- **Renamed npm package to `@hshayde/pi-monitor`** because the
  unscoped `pi-monitor` name was already taken on the registry by
  an unrelated project. The git repository, source tree, the
  binary on PATH (`pi-monitor`), and the import paths are all
  unchanged — only the npm package name moved. Install:
  `npm install -g @hshayde/pi-monitor`.

## [0.4.4] — 2026-05-07

- **package.json `bin` path fix.** npm 10 silently dropped the
  `./dist/cli.js` bin entry on publish ("script name was invalid"),
  which would have shipped 0.4.3 without a working `pi-monitor`
  binary on PATH. `npm pkg fix` strips the `./` prefix; the publish
  warning is gone and the bin entry now survives. No code change
  beyond the version bump.

## [0.4.3] — 2026-05-07

- **Sandboxed live tmux smoke test.** New `pnpm smoke` script
  (`ts/scripts/smoke.sh`) runs in two tiers: subprocess-only
  `--help` / `--version` checks, and an isolated-tmux-server tier
  that spins up a fresh server in a private `TMUX_TMPDIR`,
  runs the bundled binary, verifies the monitor session +
  2-pane layout + TUI render, sends `q`, and asserts the
  cleanup path. Wired into CI — the `ts` job now installs tmux
  via apt and runs the smoke after the build. Closes the last
  deferred item from 0.4.0's release notes.

## [0.4.2] — 2026-05-07

- **In-TUI notification banner.** Agent-state transitions to attention
  states (idle / waiting / error) now surface as a top-of-screen banner
  via the existing `Notifier` class. Critical (error) banners get a red
  border; normal ones use the accent color. Auto-dismisses after 5s
  (configurable via `notificationDismissMs`); can be suppressed entirely
  with `notificationsEnabled: false`. Closes the deferred item from
  0.4.0's release notes.

## [0.4.1] — 2026-05-07

- **Tick-driven tmux status widget.** The `@pi-monitor-status` user
  option now refreshes on every resolver tick instead of just on App
  entry. Format mirrors Python's `fmt_status_widget`: `<glyph><count>`
  per non-zero state, space-separated, in attention-priority order
  (error > waiting > idle > retrying > working). Closes the deferred
  item from 0.4.0's release notes.

## [0.4.0] — 2026-05-07

First released TS build. Functional parity with the Python build at 0.3.0;
ships as the canonical npm package while the Python build continues at
0.3.x in parallel.

### Added

- **Bundled npm CLI** (`pi-monitor`) installable via `npm install -g
@hshayde/pi-monitor` / `pnpm add -g @hshayde/pi-monitor`. Single-file ESM bundle with
  shebang injected at build time; cold-start lazy-imports React + Ink
  so `--help` / `--version` stay fast.
- **Ink + React TUI** mirroring the Python Textual UI: bordered session
  cards, two-line agent rows (name + branch on top, live activity on
  bottom), state-colored tags, sine-pulsed WORKING tint at 80ms cadence.
- **Cursor model** with first-pane auto-focus on first sync, selection
  preservation across resolver ticks (same pane wins; falls back to
  first pane when the previous one disappears), j/k/g/G/1–9 navigation.
- **Modal screens.** `?` opens a help overlay listing every binding.
  `o` opens a new-pi launcher with bash-style tab completion (longest
  common prefix; trailing-slash on unique match; `~` preservation).
- **Tmux right-slot integration** via the `TmuxBridge` interface:
  cursor moves preview the agent live in the right pane (linked
  viewer attach + zoom to source pane); Tab/Enter hands keyboard
  focus to the agent; `q` quits with full cleanup
  (`cleanup_orphan_viewers` + `kill_monitor_session`).
- **Heartbeat extension fast-path** (mirrors the Python build): when
  the `pi-monitor-heartbeat` extension is publishing, the resolver
  trusts the extension's phase + currentTool + retryAttempt and skips
  JSONL inference entirely. Fresh-heartbeat threshold 5s.
- **JSONL fallback inference** with cohabit-safe filename ownership:
  pis sharing a cwd are sorted by start time so each one's filename
  ownership window is bounded above by the next-younger sibling's
  start time. Two panes can never bind to the same JSONL.
- **macOS support** via `ps -A -o pid=,ppid=,comm=,etimes=` with `LC_ALL=C`
  - a 200ms cache. Linux still uses `/proc/<pid>` directly (ctime for
    start time, comm for binary name, task/children for the tree walk).
- **Notifier** with `ATTENTION_STATES` set, 2s debounce, 10s retry
  suppression, pluggable transport. Matches the Python build's notify.py.
- **Test suite** of 334 vitest tests across 25 files. Pure-function
  modules (state, infer, format, pulse, cursor) covered with ~95% line
  coverage; subprocess-driven modules (tmux, proc, git) mocked at the
  module boundary; ink-testing-library snapshots cover every component
  and the App's full mode-switch + cursor + bridge wiring.

### Architecture

Direct port of `src/pi_monitor/*.py`:

- `src/state/*` ports `state.py` (split into `types`, `jsonl`, `infer`,
  `reader`, `resolver`, `files`).
- `src/heartbeat/reader.ts` ports `heartbeat.py`.
- `src/notify/notifier.ts` ports `notify.py`.
- `src/tmux/*` ports `tmux.py` (split into `client`, `panes`, `viewer`,
  `monitor`).
- `src/tui/*.tsx` ports `tui.py` (split into one component per file).
- `src/cli.ts` ports `cli.py`.

Process resolution lives under `src/proc/` (`linux.ts`, `macos.ts`,
`index.ts` for the platform shim). The Python build uses `psutil`;
the TS build's `linux.ts` reads `/proc` directly and `macos.ts` shells
out to `ps`, both behind the same `findPiPidForPane` + `procStartTime`
interface.

### Notes

- Theme cycling from the Python build is not yet ported. The TS build
  uses a pinned tokyo-night palette as default; cycling lands in a
  follow-up release.
- Status-line widget (`@pi-monitor-status`) is pushed on entry and
  cleared on exit, but doesn't update on tick. Per-tick refresh is a
  follow-up.
- Notification toasts inside the TUI (the Python build's bottom-of-
  screen banners) are not yet rendered; launch errors fall back to
  stderr. Adding a banner component to the App is a follow-up.
- Live tmux smoke test (running the bundled binary against a live tmux
  server) is the user's responsibility for now. The 25-file vitest
  suite covers every module; live integration is left to manual QA
  until we have a sandboxed `TMUX_TMPDIR` harness.
