# pi-monitor

Live, tmux-aware status monitor for [pi](https://github.com/badlogic/pi-mono) coding agents.

When you run several pi sessions across multiple tmux sessions and panes, it's hard to tell at a glance which agents are streaming, which are stalled, and which are idle waiting for your next prompt. `pi-monitor` gives you a single split view: a tree of every pi pane on the left with live status badges, and a real, fully-interactive view of the agent you picked on the right — without ever moving the source pane out of its origin tmux session.

```
┌──────────────────────────────┬───────────────────────────────────┐
│ ▾ contracts (🔴1 🟡1)         │                                   │
│   🟢 PSP7-gateway   working   │                                   │
│   🟡 POWERBI       stalled 8s │   the actual pi agent             │
│   🔴 Roleplay      idle 4m    │   you selected, fully             │
│ ▾ CAPE                        │   interactive (real tmux pane)    │
│   🟢 PC            working    │                                   │
│   🔴 ANALYST       idle 12s   │                                   │
└──────────────────────────────┴───────────────────────────────────┘
```

## Install

From source (until published to PyPI):

```bash
uv tool install --from git+https://github.com/hshayde/pi-monitor pi-monitor
```

Or for development:

```bash
git clone https://github.com/hshayde/pi-monitor
cd pi-monitor
uv tool install -e .
```

## Quickstart

1. Add a hotkey to `~/.tmux.conf`:

   ```tmux
   bind-key m run-shell 'pi-monitor'
   ```

2. (Optional) add a status-line widget showing aggregate counts in every session:

   ```tmux
   set -g status-right '#{@pi-monitor-status}  %H:%M'
   ```

3. Reload config and launch:

   ```bash
   tmux source ~/.tmux.conf
   ```

   Then press `prefix + m` to summon the monitor.

## How it works

- A dedicated `monitor` tmux session is created on first run with two panes side by side: the Textual TUI on the left, an idle "right slot" on the right.
- Pressing `Enter` on a pane row creates (or reuses) a `tmux new-session -t <source>` session-group sister of that pane's source session, focuses the agent's window+pane in that sister, then `respawn-pane`s the right slot with `env -u TMUX tmux attach -t <sister>`. The right slot is now a real, fully interactive nested tmux client. The source pane is **never moved** — your project session's split is left alone.
- Picking an agent in a different source session swaps the right slot to a fresh sister and kills the previous one. Picking another agent in the same source session just retargets the existing sister.
- Because the right slot is a nested tmux client, its prefix is set to **`C-a`** (the outer monitor session keeps the default `C-b`), so the two clients' keybindings don't collide.
- Status is inferred from each pane's pi session JSONL file (`~/.pi/agent/sessions/`) plus its mtime. No screen scraping.
- Aggregate counts (`🔴N 🟡N 🟢N`) are pushed to a tmux user option `@pi-monitor-status` every 500ms while the TUI runs, so your `status-right` shows them in every session.
- Crash-safe: every launch sweeps any leftover `pi-monitor-view-*` sister sessions before opening, and the right slot is always reset to its placeholder.

## Keybindings

| Key                   | Action                                           |
| --------------------- | ------------------------------------------------ |
| `j` / `k` / `↓` / `↑` | Move selection                                   |
| `Enter` (or click)    | Attach the selected agent to the right tmux pane and focus it |
| `Tab`                 | Focus the right tmux pane (whatever's already attached)       |
| tmux `prefix + ←`     | Native tmux nav back to the left tree pane                    |
| `C-a` (in right pane) | Prefix for the inner viewer client (e.g. `C-a [` to scroll)   |
| `Space`               | Expand / collapse a session header               |
| `g` / `G`             | Jump to top / bottom                             |
| `s`                   | Cycle sort: tmux-order ↔ needs-attention-first  |
| `H`                   | Toggle showing non-pi panes                      |
| `r`                   | Force refresh now                                |
| `m`                   | Toggle desktop notifications (mute/unmute)       |
| `q`                   | Quit: kill all `pi-monitor-view-*` sisters and the monitor session |
| `1`–`9`               | Jump to the Nth pane in the tree                 |

## States

| Glyph | Meaning                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------- |
| 🟢    | working — agent is streaming or running tools                                                                 |
| 🔴    | idle — agent finished, awaiting your next prompt                                                              |
| 🟡    | stalled — tool-use turn open >5s without a result (likely awaiting your confirmation, or a long-running tool) |
| ❌    | error — last assistant message has an error                                                                   |
| ❓    | unknown — pane runs pi but no JSONL detected yet                                                              |
| ⚫    | no pi running in this pane                                                                                    |

## Notifications

By default, `pi-monitor` fires a `notify-send` desktop notification when a pane transitions into `idle`, `stalled`, or `error` (not into `working`). Each pane has a 2-second debounce to suppress flapping.

Press `m` in the TUI to mute / unmute. The setting persists in `~/.config/pi-monitor/config.json`.

## Requirements

- Linux with `/proc` (used to walk each tmux pane's process tree to its `pi` descendant; pi's start time is read from `/proc/<pid>/stat` to disambiguate panes that share a cwd).
- tmux ≥ 3.2 with `set -g mouse on`.
- A pi install that writes session files to the default location (`~/.pi/agent/sessions/`).

## Known limitations (v1)

- pi sessions started with `--no-session` produce no JSONL and show as `?`.
- pi sessions launched with a custom `--session-dir` are not detected.
- pi running over ssh inside a pane is not detected (the pane shows `cmd=ssh`).
- The right slot shares the source session's window with all of its other panes. If your source window is split, the right slot mirrors that split — input still goes to the cursored pane (we set `select-pane` in the sister), but you'll see the neighbouring panes shrunk alongside.
- macOS is not supported. The linked-session flow is tmux-native and would work, but the `notify-send` integration assumes libnotify and the `/proc`-based pi-pid resolution would need an `lsof`/`ps` fallback.

## License

MIT
