# pi-monitor TypeScript rewrite — scoped plan

This document is a plan for review BEFORE any code is written. The
goal is to make sure we agree on scope, tooling, layout, and the
minimum acceptance criteria before either of us spends a day on a
project structure that turns out to be the wrong shape.

---

## Goal

Replace the current Python/Textual implementation with a Node.js +
TypeScript implementation that has full **feature parity** with
pi-monitor 0.3.0 and stays as close to cmux/Warp's design language
as the current Python build does.

Non-goals for v1 of the rewrite:
- Adding capabilities the Python build doesn't have.
- Windows support (still Linux + macOS).
- Replacing the heartbeat extension (it's a pi-side TS extension
  already; we keep it as-is).

## Why this might or might not be worth it

The honest case for the rewrite (paraphrasing your prior reasoning):
- Single-language stack with the rest of your AI tooling (pi is TS,
  the heartbeat extension is TS).
- Easier for you to iterate on without context-switching.
- Node's startup time is faster than CPython's for small CLIs.

The honest case against (concerns I've raised in this session):
- **Translucency works the same way in any TUI:** the program must
  emit `ESC[49m` (ANSI default-bg). This is one line in Textual
  (`ansi_color=True`); it's also one line in Ink. The framework
  isn't the gate.
- **Textual's CSS is more powerful than Ink's inline styling.** We'll
  re-derive the brightness hierarchy + transitions in JSX, which is
  more code, not less.
- **Test coverage doesn't port for free.** 176 Python tests will need
  re-equivalents in TS (probably ~120 since some are pure-helper
  tests that compress when ported).
- **Process-tree resolution on macOS** in Node is messier than
  Python's psutil (no clean equivalent; we shell out to `ps`).
- **The Python build is already production-ready** at v0.3.0 with
  CI, packaging, and a 176-test suite. We'd be giving that up for a
  while during the port.

You picked the rewrite anyway, so I'm not relitigating; this section
exists so we both have the same explicit context if v1 of the TS
build hits a wall and we want to fall back.

---

## Tooling decisions

Picking concrete tools so we don't bikeshed mid-port.

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js 20 LTS** | Stable, npm-publishable, matches what pi targets. (Bun would be faster but its npm-package compatibility on macOS is still rough at this scale.) |
| Language | **TypeScript 5.x** | Strict mode, no `any` outside boundary types. |
| TUI framework | **Ink 5** (React for CLIs) | Most mature TS TUI. JSX components, hooks for state, supports ANSI default-bg via `transparent` prop. |
| Process info | **node:child_process + custom `ps` parser** for macOS, **`/proc` for Linux** | Avoids the `pidusage` dep tree. Same shape as our current Python psutil shim. |
| JSON / fs | **Native `node:fs/promises` + `JSON.parse`** | No deps. |
| Notifications | **`node-notifier`** | Cross-platform (notify-send on Linux, NotificationCenter on macOS) wrapped. Falls back to silent. |
| State management | **React hooks** (useState/useReducer) | No Redux. The state is small. |
| Build | **tsc + tsup** | Tsup bundles to a single .js so `npm install -g pi-monitor` is one file. |
| Tests | **Vitest** | Faster than Jest, native ESM, JSX-aware. Snapshot tests for Ink components via `ink-testing-library`. |
| Lint / format | **Biome** | Single tool for both, faster than ESLint + Prettier. |
| Package manager | **pnpm** | Disk-efficient, deterministic lockfile, fast on CI. |

Editorially: **no monorepo, no workspaces, no PyO3 bridge.** This is
a clean Node project that lives in its own directory and ships its
own npm package.

---

## Repo layout

The rewrite goes in a new directory in the SAME repo so:
- We keep the entire git history (commits, tags, CHANGELOG).
- The Python build stays available at HEAD until the TS build hits
  feature parity, then we deprecate the Python entry point.
- CI runs both suites during the transition.

```
pi-monitor/                      # repo root, unchanged
├── src/pi_monitor/              # Python source — unchanged during the port
├── tests/                       # Python tests — unchanged
├── extensions/                  # heartbeat extension — TS already, unchanged
├── ts/                          # NEW: TS rewrite root
│   ├── package.json
│   ├── tsconfig.json
│   ├── biome.json
│   ├── pnpm-lock.yaml
│   ├── src/
│   │   ├── cli.ts               # entry point (#!/usr/bin/env node)
│   │   ├── tui/                 # Ink components
│   │   │   ├── App.tsx
│   │   │   ├── SessionGroup.tsx
│   │   │   ├── PaneRow.tsx
│   │   │   ├── EmptyState.tsx
│   │   │   ├── HelpScreen.tsx
│   │   │   └── NewPiScreen.tsx
│   │   ├── state/               # AgentState, JsonlSnapshot, resolver
│   │   │   ├── types.ts
│   │   │   ├── jsonl.ts
│   │   │   ├── infer.ts
│   │   │   └── resolver.ts
│   │   ├── tmux/                # tmux subprocess wrapper
│   │   │   ├── client.ts        # _tmux equivalent
│   │   │   ├── panes.ts         # list_panes
│   │   │   ├── viewer.ts        # ensure_linked_viewer + slot mgmt
│   │   │   └── monitor.ts       # session creation, cleanup
│   │   ├── proc/                # process tree resolver
│   │   │   ├── linux.ts         # /proc reader
│   │   │   ├── macos.ts         # ps subprocess parser
│   │   │   └── index.ts         # platform dispatch
│   │   ├── heartbeat/           # heartbeat reader
│   │   │   └── reader.ts
│   │   ├── notify/              # desktop notifications
│   │   │   ├── notifier.ts
│   │   │   └── transport.ts
│   │   └── format/              # row + tag + activity helpers
│   │       └── row.ts
│   └── tests/
│       ├── jsonl.test.ts
│       ├── infer.test.ts
│       ├── resolver.test.ts
│       ├── notifier.test.ts
│       ├── proc.test.ts
│       ├── format.test.ts
│       └── tui.test.tsx         # Ink component snapshot + interaction
├── docs/
├── README.md                    # cross-links both implementations during the port
└── .github/workflows/ci.yml     # adds a `ts` job alongside the existing `test` + `build`
```

---

## Phased delivery

Each phase is a separate PR-equivalent commit so we can pause and
review (or roll back) at any boundary. Phases run roughly in
dependency order so each one is testable in isolation.

### Phase 0 — Scaffold (1 commit, half a day)

- Create `ts/` directory with `package.json`, `tsconfig.json`,
  `biome.json`, `vitest.config.ts`, `tsup.config.ts`, plus a
  hello-world `src/cli.ts` that just exits 0.
- Add a `ts` job to `.github/workflows/ci.yml` that runs
  `pnpm install`, `pnpm biome check`, `pnpm test`, `pnpm build`.
- README gets a small "Two implementations during port" callout
  pointing at the `ts/` directory.
- **Acceptance:** `cd ts && pnpm install && pnpm test && pnpm build`
  green. CI runs the new job alongside the existing Python jobs.

### Phase 1 — Pure logic ports (3–4 commits, 2 days)

Port the things that have no terminal / network / subprocess
dependencies, in this order:

1. **`state/types.ts`** — `AgentState` enum, `PaneStatus`,
   `JsonlSnapshot` interfaces.
2. **`state/jsonl.ts`** — `_scan_lines`, `_first_text_preview`. Tests
   port directly from `tests/test_state.py`'s `_scan_lines` block
   (~20 cases).
3. **`state/infer.ts`** — `infer_state`, the IDLE_THRESHOLD_S /
   STARTING_GRACE_S constants, the retryable-error regex.
4. **`format/row.ts`** — `_working_verb`, `_activity_tag`,
   `_activity_description`, `fmt_row_main`, `fmt_session_header`,
   `_truncate`. Tests port from `tests/test_tui_render.py`.
5. **`notify/notifier.ts`** — Notifier class with debounce + retry
   suppression. Tests port from `tests/test_notify.py`.

**Acceptance:** vitest covers ~80 of the 176 Python tests by
equivalent. No TUI yet; pure data in / data out.

### Phase 2 — System I/O wrappers (3 commits, 1.5 days)

6. **`proc/linux.ts`** + **`proc/macos.ts`** + **`proc/index.ts`** —
   the psutil shim. Linux reads `/proc/<pid>/stat`; macOS shells
   out to `ps -o pid=,ppid=,comm=,lstart= -p <pid>` and parses.
   Tests use the platform-mock pattern from
   `tests/test_cross_platform.py`.
7. **`heartbeat/reader.ts`** — read `~/.pi/agent/.heartbeats/<pid>.json`,
   schema-validate, freshness check. Tests port from
   `tests/test_heartbeat.py`.
8. **`state/resolver.ts`** — the per-cwd claim resolver. This is the
   largest logic module; ports from the bottom half of `state.py`.
   Tests port from the resolver-section of `tests/test_state.py`
   (~20 cases including the cohabit-swap regression test).

**Acceptance:** every non-TUI Python test has a TS equivalent
passing.

### Phase 3 — Tmux client (2 commits, 1.5 days)

9. **`tmux/client.ts`** — `_tmux` subprocess wrapper, output
   parsing, error type.
10. **`tmux/panes.ts`** + **`tmux/viewer.ts`** + **`tmux/monitor.ts`** —
    `list_panes`, `is_viewer_session`, `ensure_linked_viewer`,
    `attach_right_slot_to_viewer`, `kill_linked_viewer`,
    `cleanup_orphan_viewers`, `kill_monitor_session`. Most of these
    are pure subprocess invocations; tests use a `_tmux` mock that
    returns canned output.

**Acceptance:** `cli.ts` can `pnpm dev` and dump a list of pi panes
to stdout (no TUI yet, just the data pipeline end-to-end).

### Phase 4 — TUI (4 commits, 3 days)

11. **`tui/PaneRow.tsx`** — two-line component. State-colored title
    (with pulse hook for WORKING), dim branch, dim activity line.
12. **`tui/SessionGroup.tsx`** — bordered container, colored title,
    `.active-group` equivalent (border highlight via prop).
13. **`tui/App.tsx`** — top-level: title bar, attention banner,
    SessionList, footer. Cursor model via `useReducer`, key
    bindings via `useInput`. Empty-state welcome block.
14. **`tui/HelpScreen.tsx`** + **`tui/NewPiScreen.tsx`** — modal
    overlays. Ink doesn't have a screen stack like Textual; we use
    a `useState`-driven mode switch. Tab-completion logic ports
    from Python.

**Acceptance:** visual parity check: side-by-side screenshot of the
Python and TS builds shows the same layout for the same fixture.
ink-testing-library snapshot tests cover the cursor model, the
selection toggling, and the empty state.

### Phase 5 — CLI plumbing + cross-platform validation (1 commit, half a day)

15. **`cli.ts`** — argument parsing (probably none — pi-monitor has
    no CLI flags today). `process.on('SIGINT')` cleanup.
    `package.json` `bin` field so `npm install -g pi-monitor` puts
    `pi-monitor` on PATH.
16. Real macOS smoke run from your machine. Confirm:
    - Translucency works (terminal default-bg shines through).
    - Notifications fire via NotificationCenter.
    - Process tree walking finds pi via the macOS `ps` path.
    - Two-line rows render correctly under iTerm2 + Ghostty + WezTerm.

**Acceptance:** "I ran it on my machine and it works" from you.

### Phase 6 — Release + Python deprecation (1 commit, half a day)

17. Bump `ts/package.json` to `0.4.0`. Tag `v0.4.0`. `pnpm publish`
    when ready (needs your npm token).
18. Update README to make the TS build the canonical install
    instruction; move the Python build to a "Legacy Python build"
    section with a deprecation banner.
19. Decide cutover: do we delete `src/pi_monitor/` after a release
    or two, or keep it indefinitely?

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Ink can't reproduce the cmux/Warp look | Medium | Phase 4 ends with a side-by-side screenshot check; if Ink falls short we either (a) accept a small visual gap or (b) fall back to the Python build and call the rewrite a learning exercise. |
| macOS ps parsing has locale gotchas | Low | The Python equivalent (`psutil`) abstracts this; we'll stick to `LC_ALL=C ps -o pid=,ppid=,comm=,lstart=` to force a stable format. |
| Sub-50ms cursor-nav budget hard to hit in JS | Low | Ink renders are fast at 100 widgets in our experience. We have the perf-test fixtures in Python; we port the budgets and assert in vitest. |
| The whole port stalls midway | Medium | Each phase is a separate commit and CI-gated. We can pause at any phase and the Python build stays the canonical ship. |
| Translucency doesn't work the same | Low | Ink supports `transparent` background which emits ANSI default-bg; same primitive Textual uses. The actual mechanism is identical. |

---

## What I need from you before phase 0 starts

1. **Confirm the tooling picks** above (Node 20, Ink 5, vitest, Biome,
   pnpm). If you want different choices (Bun, Jest, etc.) say so
   now — switching mid-port is expensive.
2. **Confirm the repo layout** (TS in `ts/` of the same repo, not a
   new repo). If you'd prefer a separate repo I can write a migration
   script.
3. **Confirm the cutover plan** — keep both builds during the port,
   ship `0.4.0` as the TS build, deprecate Python after `0.4.0` runs
   stable for some period you define.
4. **Hard veto on the rewrite if anything in the "Why this might not
   be worth it" section landed wrong.** I'd rather hear it now than
   after phase 4.

If all four come back as "yes proceed," I'll start phase 0. Each
subsequent phase will land as a single commit you can review or
roll back.
