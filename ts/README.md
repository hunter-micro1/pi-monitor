# pi-monitor (TypeScript build)

Live, tmux-aware status monitor for [pi](https://github.com/badlogic/pi-mono)
coding agents. Same product as the Python build (`../src/pi_monitor/`);
this directory is the canonical install starting at 0.4.0.

The Python build at the repo root continues to work and is published
to PyPI separately; the project README at `../README.md` covers the
product in depth (screenshots, key bindings, heartbeat extension,
tmux configuration, etc.).

## Install

```bash
npm install -g pi-monitor
# or
pnpm add -g pi-monitor
```

This installs the `pi-monitor` binary on your PATH. Requires Node 20+
and tmux on PATH.

## Run

```bash
pi-monitor                # bootstrap the monitor session + switch in
pi-monitor --help         # usage
pi-monitor --version      # print version + exit
```

## Dev

```bash
cd ts
pnpm install
pnpm dev          # run the cli without bundling (tsx)
pnpm test         # vitest (334 tests)
pnpm test:watch   # vitest in watch mode
pnpm typecheck    # tsc --noEmit
pnpm check        # biome lint + format check
pnpm format       # biome --write to fix lint/format issues
pnpm build        # tsup bundle to ./dist
```

## Tooling

- **Runtime:** Node 20 LTS
- **Language:** TypeScript 5.x (strict mode)
- **TUI:** Ink 5 + React 18
- **Tests:** Vitest + ink-testing-library
- **Lint/format:** Biome 1.9
- **Bundler:** tsup
- **Package manager:** pnpm 10

## Architecture

The TS source mirrors the Python source structure 1:1:

| Python file                     | TS module(s)                                |
| ------------------------------- | ------------------------------------------- |
| `src/pi_monitor/state.py`       | `src/state/{types,jsonl,infer,reader,resolver,files}.ts` |
| `src/pi_monitor/heartbeat.py`   | `src/heartbeat/reader.ts`                   |
| `src/pi_monitor/notify.py`      | `src/notify/notifier.ts`                    |
| `src/pi_monitor/tmux.py`        | `src/tmux/{client,panes,viewer,monitor}.ts` |
| `src/pi_monitor/tui.py`         | `src/tui/*.tsx`                             |
| `src/pi_monitor/cli.py`         | `src/cli.ts`                                |

Process resolution shims live under `src/proc/` (Linux uses `/proc`
directly, macOS shells out to `ps -A` with a 200ms result cache).

The full rewrite plan is at [`../docs/REWRITE_PLAN.md`](../docs/REWRITE_PLAN.md).

## Changelog

See [`./CHANGELOG.md`](./CHANGELOG.md) for the full version history.
