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
npm install -g @hshayde/pi-monitor
# or
pnpm add -g @hshayde/pi-monitor
```

This installs the `pi-monitor` binary on your PATH. Requires Node 20+
and tmux on PATH.

> The npm package is scoped (`@hshayde/`) because the unscoped
> `pi-monitor` name was already taken on the registry by an unrelated
> project. The installed binary on PATH is still just `pi-monitor`.

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
pnpm test         # vitest (350 tests)
pnpm test:watch   # vitest in watch mode
pnpm typecheck    # tsc --noEmit
pnpm check        # biome lint + format check
pnpm format       # biome --write to fix lint/format issues
pnpm build        # tsup bundle to ./dist
pnpm smoke        # end-to-end smoke (after `pnpm build`)
```

## Smoke test

`pnpm smoke` runs `scripts/smoke.sh`. Two tiers:

1. **Tier 1** (always runs): subprocess checks against the bundled
   `dist/cli.js` — `--help`, `--version`, `-h`, `-V`. Doesn't touch
   tmux.
2. **Tier 2** (skipped if tmux is missing): isolates a fresh tmux
   server inside a private `TMUX_TMPDIR`, runs the binary as the
   command of an attached session, verifies the monitor session is
   created with two panes, asserts the TUI title bar rendered, sends
   `q`, asserts the monitor session shut down. The isolated server
   is killed and the tmpdir removed on EXIT — your real tmux state
   is untouched.

CI runs both tiers on every push (the Tier-2 job installs tmux via
apt before invoking `pnpm smoke`).

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
