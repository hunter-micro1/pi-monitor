# pi-monitor

Live, tmux-aware status monitor for [pi](https://github.com/badlogic/pi-mono) coding agents.

When you run several pi sessions across multiple tmux sessions and panes, it gets hard to tell at a glance which agents are streaming, which are stalled on a confirmation, and which are idle waiting for your next prompt. `pi-monitor` gives you a single split view: a tree of every pi pane on the left with live status badges, and the actually-interactive borrowed pane on the right.

> Status: under construction. v0.1.0 is scaffold only; the full TUI lands incrementally in the next commits.

## Install

```bash
uv tool install pi-monitor
```

(Once published. Until then: `uv tool install --from git+https://github.com/hshayde/pi-monitor pi-monitor`.)

## Requirements

- Linux with `/proc` (used to map tmux panes → pi session files).
- tmux 3.2+ with `set -g mouse on`.
- A pi install that writes session files to `~/.pi/agent/sessions/` (default).

## Quickstart

After install, add a hotkey to your `~/.tmux.conf`:

```tmux
bind-key m run-shell 'pi-monitor'
```

Reload tmux config (`tmux source ~/.tmux.conf`) and press `prefix + m` to summon the monitor.

## Status-line widget (optional)

To see aggregate "needs-attention" counts in every tmux session, add this to your `~/.tmux.conf`:

```tmux
set -g status-right '#{@pi-monitor-status} %H:%M'
```

The widget is updated by `pi-monitor` while it's running. If `pi-monitor` exits, the widget clears.

## Known limitations (v1)

- pi sessions started with `--no-session` show as `?` (no JSONL to read).
- pi sessions using a custom `--session-dir` are not detected.
- pi running over ssh inside a pane is not detected (the pane shows `cmd=ssh`).
- Pane→session mapping requires `/proc` (Linux only). macOS support would need an `lsof`-based fallback.

## License

MIT
