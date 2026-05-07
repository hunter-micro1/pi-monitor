# pi-monitor (TypeScript) changelog

All notable changes to the TypeScript build of pi-monitor are documented
here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The Python build at the repo root has its own changelog at
[`../CHANGELOG.md`](../CHANGELOG.md).

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
pi-monitor` / `pnpm add -g pi-monitor`. Single-file ESM bundle with
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
