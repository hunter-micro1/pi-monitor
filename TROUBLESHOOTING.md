# Troubleshooting

Quick fixes for the things new users hit on Linux and macOS. If your
issue isn't here, open one at
<https://github.com/hshayde/pi-monitor/issues> and include `pi-monitor
--version`, `tmux -V`, and the OS.

---

## "I launched pi-monitor and the list is empty"

The session list only shows tmux panes that are running pi (a process
named `pi`). Check:

1. **Are you actually inside tmux?** `pi-monitor` is meant to be invoked
   from a tmux key binding, not a bare shell. If `$TMUX` is unset,
   pi-monitor still starts but has no panes to scan because each tmux
   server is its own world.
2. **Is pi running in any pane?** From a regular shell, `ps -ef | grep '\bpi$'`
   should list at least one process. If not, start an agent
   (`pi "say hi"` in any tmux pane) and re-launch the monitor.
3. **Are you filtering pi-only?** That's the default. Press `Shift+H`
   to toggle showing every tmux pane regardless of command \u2014 useful
   for debugging "is the pane even visible to pi-monitor".

If panes appear with `unknown` (`?`) state, see the next section.

---

## "All panes show `unknown` / no activity"

`unknown` means pi-monitor walked the pane's process tree, found a
`pi` child, but couldn't find a session JSONL or read its mtime.

Common causes:

- **You launched pi with `--no-session`.** Pi only writes the JSONL
  when sessions are enabled. Re-run pi without that flag.
- **You launched pi with a custom `--session-dir`.** pi-monitor only
  scans `~/.pi/agent/sessions/`. Either drop the flag or move the
  directory.
- **Pi just started and hasn't sent its first message yet.** The
  resolver shows WORKING for the first 30 s of a no-file pi (the
  `STARTING_GRACE_S` window in `state.py`). After that, it falls back
  to `unknown`. Type something at the agent and the JSONL will appear.
- **You're SSH'd into a remote box and pi runs over `ssh`.** The pane's
  visible command is `ssh`, not `pi`, so we can't follow the tree to a
  pi descendant. There's no fix for this short of running pi-monitor
  on the remote box itself.

---

## "Translucency doesn't show through to my wallpaper"

pi-monitor renders every cell with the ANSI default-bg escape
(`ESC[49m`) so the terminal honors its own background. If you're seeing
a solid color instead, the terminal isn't translucent.

Check your terminal's transparency setting:

- **kitty**: `background_opacity 0.85` in `~/.config/kitty/kitty.conf`
- **alacritty**: `window.opacity = 0.85` in `~/.config/alacritty/alacritty.toml`
- **GNOME Terminal**: Profile \u2192 Colors \u2192 "Use transparent background"
- **iTerm2** (macOS): Preferences \u2192 Profiles \u2192 Window \u2192 Transparency
- **WezTerm**: `window_background_opacity = 0.85`

If the terminal IS configured for translucency but pi-monitor still
paints solid, double-check you're on **0.3.0 or later** \u2014
the `ansi_color=True` fix that enables true translucency landed in
`bb6415b` / 0.2.0.

---

## "Git branch doesn't show next to agent names"

The branch column comes from `git -C <pane.cwd> symbolic-ref --short HEAD`,
cached for 15 s per cwd. It'll be empty when:

- The pane's cwd isn't a git checkout (`git status` would also fail).
- The repo's HEAD is detached (e.g. checked out a tag or specific
  commit). pi-monitor intentionally shows nothing rather than the SHA
  here \u2014 the SHA scans like noise next to real branch names.
- `git` isn't on PATH. Verify with `which git`.
- The first launch is still cold: the cache has a 0.4 s subprocess
  timeout per cwd. If your home is on a slow filesystem the first tick
  can return `None` for unrelated cwds; the second tick (about 0.5 s
  later) will catch up.

---

## "The activity tag just says `working`, never `running bash` etc."

The verbose activity tag (`running bash`, `compacting`, `thinking`,
`retrying #2`, `awaiting input`) is sourced from the
`pi-monitor-heartbeat` extension that runs _inside_ each pi process.
Without it, pi-monitor falls back to JSONL-only inference, which can
only say `working` \u2014 the JSONL doesn't carry phase or current-tool
information.

Install the extension once (it's bundled in this repo):

```bash
ln -sf "$(pwd)/extensions/pi-monitor-heartbeat" \
    ~/.pi/agent/extensions/pi-monitor-heartbeat
```

Then **restart any running pi processes** \u2014 the extension only attaches
on pi launch, so existing sessions keep falling back to JSONL until you
exit and relaunch them.

The activity tag updates within ~2 s of state changes once heartbeat
is in place.

---

## "Notifications aren't showing up"

pi-monitor picks the right transport per OS:

- **Linux**: `notify-send` (libnotify). Install with
  `sudo apt install libnotify-bin` or your distro's equivalent.
  Verify with `notify-send "test" "ok"`.
- **macOS**: `osascript` (Notification Center). It's preinstalled, but
  Notification Center has to be granted permission to display alerts
  from Terminal/iTerm2/etc. on first use. If notifications are missing
  on macOS:
  1. Run `osascript -e 'display notification "test" with title "pi-monitor"'`
     manually. The first time, macOS prompts for permission.
  2. Open System Settings \u2192 Notifications, find your terminal app,
     and confirm "Allow notifications" + the alert style.
- **Headless SSH or no notification daemon**: pi-monitor silently
  skips desktop notifications and just shows the in-TUI toast. This is
  intentional \u2014 the toast is enough; we don't want to spam stderr.

If notifications ARE firing but feel spammy, press `m` inside the TUI
to mute. The setting persists in `~/.config/pi-monitor/config.json`.

If you want to debug whether transitions are even being detected: look
at the in-TUI toast that fires alongside every desktop notification.
If the toast appears but the notification doesn't, the issue is the
desktop transport, not pi-monitor's state inference.

---

## "I'm seeing emojis in my tmux status line"

That's the **status-line widget**, not the TUI itself. The TUI is
glyph-free; the status widget pi-monitor pushes to
`@pi-monitor-status` uses emojis (`\ud83d\udfe2 1 \ud83d\udfe1 1 \ud83d\udd34 1`) because they
need to fit in the tmux status bar where typography options are
limited. If you don't want them, just don't reference
`#{@pi-monitor-status}` in your `status-right`.

---

## "The right pane shows the wrong agent / shows my source pane"

The right pane is a real, fully-interactive nested tmux client showing
a session-group sister of the source. A few things to check:

- **Did you press `Tab` (or `Enter`) to commit?** Hovering with `j`/`k`
  attaches the right pane but keyboard focus stays on the tree. Tab
  hands the keystroke off so you can actually type at the agent.
- **The source window has multiple panes.** The right slot mirrors the
  source window; if your pi pane is split with a shell or editor, the
  right slot shows that split. Press `prefix+z` (which is `C-a z` in
  the inner viewer client) to zoom into just the agent.
- **You see "no agent attached yet" when pressing Tab.** The right
  slot is at its placeholder. Hover any pane row first (j/k) so the
  monitor attaches a viewer, then Tab.

---

## "pi-monitor crashes on launch with a tmux error"

Most likely your tmux is older than 3.2 (linked sessions and the
session-group flow we use changed in 3.0/3.2). Check with `tmux -V`.
On older tmux, upgrade or build from source; pi-monitor's flow has no
fallback for pre-3.2.

Other common launch issues:

- **`set -g mouse on` not set**: not strictly required, but click
  navigation in the tree won't work.
- **Permissions on `~/.pi/agent/`**: the heartbeat extension writes
  there. If pi runs as a different user (sudo, container), the writer
  and reader won't share the same directory.

---

## "I want to roll back to v0.1.0 / v0.2.0"

Both are tagged. Reinstall with the explicit tag:

```bash
uv tool install --force --from \
    git+https://github.com/hshayde/pi-monitor@v0.2.0 pi-monitor
```

The CHANGELOG documents the visual + behavioral changes between
versions if you want to know what you'd be giving up.
