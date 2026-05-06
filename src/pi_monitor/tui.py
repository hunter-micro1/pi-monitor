"""Textual TUI for pi-monitor.

The monitor session is a tmux 2-pane window. This file owns only the LEFT
pane: a tree of every pi pane on the tmux server with live status badges.

The RIGHT pane is owned by tmux: when the user hits Enter (or Tab) on a
pane row, we ensure a session-group sister of that pane's source session
exists ("linked viewer"), focus the agent's window+pane in the viewer,
then `respawn-pane` the right slot with `tmux attach -t <viewer>`. The
result is a real, fully interactive tmux client showing the agent — with
zero pane-moving on the source side.

Layout (inside the LEFT tmux pane):
    ┌──────────────────────────────────────────┐
    │ title-bar  (brand · counts · sort · mute)│
    │ attention-banner (auto-hides)            │
    │ ╭─ Sessions ─────────────────────────╮   │
    │ │ tree                                │   │
    │ ╰────────────────────────────────────╯   │
    │ footer (key hints)                       │
    └──────────────────────────────────────────┘

The Screen and chrome bars use `background: transparent` so any
translucency the user has configured in their terminal shows through.
The tree card and modal dialogs keep a themed `$surface` so text stays
legible against whatever's behind the terminal.
"""

from __future__ import annotations

import math
import os
import time
from pathlib import Path

from rich.markup import escape
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container
from textual.screen import ModalScreen
from textual.widgets import Footer, Input, Static, Tree

from .notify import ATTENTION_STATES, Notifier, load_config, save_config
from .state import (
    AgentState,
    PaneRef,
    PaneStatus,
    StateResolver,
)
from .tmux import (
    MONITOR_SESSION,
    Pane,
    TmuxError,
    attach_right_slot_to_viewer,
    cleanup_orphan_viewers,
    clear_status_widget,
    ensure_linked_viewer,
    focus_right_slot,
    is_viewer_session,
    kill_linked_viewer,
    kill_monitor_session,
    list_panes,
    reset_right_slot_to_placeholder,
    set_status_widget,
    viewer_focus_pane,
    viewer_zoom_to_pane,
    _tmux,
)

POLL_INTERVAL_S = 0.5

# Spinner / pulse animation cadence. 80ms ~ 12 fps which is what npm, yarn,
# kubectl etc. use; smooth without burning cycles.
SPINNER_INTERVAL_S = 0.08
# Standard braille rotation (10 frames). Each frame is one cell wide.
SPINNER_FRAMES = ("⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏")
# Pulse period for working-state text color (sine wave between bright and dim).
PULSE_PERIOD_S = 1.5

# Curated subset of Textual's built-in themes. Press `t` to cycle.
# Order is intentional: dark themes first, then a couple of light ones at
# the end so users who want light just keep tapping past the dark set.
THEMES: tuple[str, ...] = (
    "textual-dark",
    "tokyo-night",
    "catppuccin-mocha",
    "dracula",
    "nord",
    "gruvbox",
    "monokai",
    "solarized-dark",
    "textual-light",
    "solarized-light",
)
DEFAULT_THEME = "textual-dark"

# Per-state colors are derived from the active Textual theme on every
# theme switch. Traffic-light semantics:
#   working  = success (good, leave alone)
#   idle     = warning (waiting for you)
#   error    = error   (broken)
#   waiting  = accent  (heartbeat-only: agent blocked on a user decision)
#   retrying = primary (heartbeat-only: pi auto-retrying a transient API error)
#
# These module globals (STATE_COLORS, WORKING_PULSE_DIM, ACCENT) are
# MUTATED by PiMonitorApp._refresh_state_colors so that bare format helpers
# (fmt_row, fmt_session_header, _help_text, ...) stay theme-aware without
# being threaded with an app reference. Tests that need the defaults should
# import them at top of the test, not after instantiating the App.
#
# The static values below are the pre-theme-refresh fallback (used during
# module import, before the App mounts). _refresh_state_colors overwrites
# them on mount and on every `t` cycle.
STATE_COLORS: dict[AgentState, str] = {
    AgentState.WORKING: "#4EBF71",
    AgentState.IDLE: "#FFA62B",
    AgentState.ERROR: "#BA3C5B",
    AgentState.WAITING: "#de935f",  # warm orange — calls attention
    AgentState.RETRYING: "#81a2be",  # steel blue — "automated, ongoing"
    AgentState.UNKNOWN: "#808080",
    AgentState.NO_PI: "#505050",
}
# Dim end of the working-state pulse. Recomputed from the active theme
# whenever it changes (see _refresh_state_colors).
WORKING_PULSE_DIM: str = "#2f7544"
# Accent color used for brand text and key hints in Rich markup. Kept in
# sync with the live theme's `primary` color.
ACCENT: str = "#0178D4"

# Severity passed to Textual's in-TUI toast on transitions. WAITING is a
# real attention state (user must respond), so it gets a warning toast.
# RETRYING never toasts — the user has nothing to do.
STATE_TOAST_SEVERITY: dict[AgentState, str] = {
    AgentState.IDLE: "warning",
    AgentState.WAITING: "warning",
    AgentState.ERROR: "error",
}

# Used only by the tmux status-line widget; emoji are dependable in tmux.
STATE_GLYPHS: dict[AgentState, str] = {
    AgentState.IDLE: "🔴",
    AgentState.WORKING: "🟢",
    AgentState.ERROR: "❌",
    AgentState.WAITING: "🟠",
    AgentState.RETRYING: "🔵",
    AgentState.UNKNOWN: "❓",
    AgentState.NO_PI: "⚫",
}

# In-app glyphs for the always-on counts in the title bar. Single-cell
# Unicode shapes (NOT emoji) so they line up cleanly across terminals
# and inherit the theme's foreground color when un-tagged.
CHIP_GLYPHS: dict[AgentState, str] = {
    AgentState.WORKING: "●",
    AgentState.IDLE: "●",
    AgentState.ERROR: "●",
    AgentState.UNKNOWN: "○",
}

# Width to which we pad state labels in the tree. Longest is 'working' (7).
STATE_LABEL_WIDTH = 8


def _new_session_label() -> str:
    """Top-of-tree affordance to open the new-session modal. Re-rendered on
    theme change so the accent color stays in sync with the active theme."""
    return f"[bold {ACCENT}]+  new session[/bold {ACCENT}]"


# Lower number = higher attention priority. WAITING slots above IDLE
# (the user is being asked something specific). RETRYING is below IDLE
# but above WORKING because it's a transient state worth surfacing.
STATE_PRIORITY: dict[AgentState, int] = {
    AgentState.ERROR: 0,
    AgentState.WAITING: 1,
    AgentState.IDLE: 2,
    AgentState.RETRYING: 3,
    AgentState.UNKNOWN: 4,
    AgentState.WORKING: 5,
    AgentState.NO_PI: 6,
}

HELP_SECTIONS: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = (
    (
        "Navigation",
        (
            ("j / ↓", "down"),
            ("k / ↑", "up"),
            ("h / ←", "collapse / parent"),
            ("l / →", "expand / first child"),
            ("g / G", "top / bottom"),
            ("1–9", "jump to Nth pane"),
            ("Space", "expand / collapse session"),
        ),
    ),
    (
        "Interact",
        (
            ("j / k", "hover previews the agent live in the right pane"),
            ("Enter", "commit — focus the right pane so keys go to the agent"),
            ("Tab", "same as Enter for a pane row"),
            ("prefix+←", "tmux nav back to the tree pane"),
            ("C-a z", "inner viewer: unzoom to see siblings"),
            ('C-a " / %', "inner viewer: split inside the right slot"),
        ),
    ),
    (
        "Spawn",
        (("o", "new session (on +) or new window (on session/pane)"),),
    ),
    (
        "View",
        (
            ("t", "cycle theme"),
            ("s", "cycle sort: tmux ↔ needs-attention-first"),
            ("Shift+H", "toggle non-pi panes"),
            ("r", "force refresh"),
        ),
    ),
    (
        "Notifications",
        (("m", "mute / unmute (desktop + in-app toasts)"),),
    ),
    (
        "Exit",
        (
            ("q", "kill monitor session + all viewers"),
            ("?", "toggle this help"),
        ),
    ),
)


def _help_text() -> str:
    """Render the help overlay using the live accent color."""
    out = [f"[bold {ACCENT}]pi-monitor — keybindings[/bold {ACCENT}]"]
    for header, rows in HELP_SECTIONS:
        out.append(f"\n[bold]{header}[/bold]")
        for key, desc in rows:
            out.append(f"  [{ACCENT}]{key.ljust(11)}[/{ACCENT}]  {desc}")
    out.append("\n[dim]press any key to dismiss[/dim]")
    return "\n".join(out)


class HelpScreen(ModalScreen):
    """Modal overlay listing every keybinding. Any key dismisses."""

    DEFAULT_CSS = """
    HelpScreen {
        align: center middle;
        background: $background 60%;
    }
    HelpScreen > #help-dialog {
        width: 64;
        height: auto;
        max-height: 80%;
        padding: 1 2;
        border: round $primary;
        background: $surface;
        color: $foreground;
    }
    HelpScreen > #help-dialog > Static {
        width: 100%;
    }
    """

    def compose(self) -> ComposeResult:
        with Container(id="help-dialog"):
            yield Static(_help_text())

    def on_key(self, event) -> None:
        self.dismiss()


class NewPiScreen(ModalScreen):
    """Prompt for a directory to launch a new pi agent in.

    Returns a tuple `(mode, cwd)` on Enter, or `None` on Esc. The caller
    distinguishes 'session' (new tmux session) vs 'window' (new window in
    the current session) via the `mode` it passed in at construction.
    """

    DEFAULT_CSS = """
    NewPiScreen {
        align: center middle;
        background: $background 60%;
    }
    NewPiScreen > #new-pi-dialog {
        width: 72;
        height: auto;
        padding: 1 2;
        border: round $primary;
        background: $surface;
        color: $foreground;
    }
    NewPiScreen #new-pi-title {
        color: $primary;
        text-style: bold;
    }
    NewPiScreen #new-pi-matches {
        color: $foreground-muted;
        height: auto;
        max-height: 5;
        margin-top: 1;
        padding: 0;
    }
    NewPiScreen #new-pi-hint {
        color: $foreground-muted;
        margin-top: 1;
    }
    NewPiScreen Input {
        margin-top: 1;
        background: $boost;
        color: $foreground;
        border: tall $surface-lighten-1;
    }
    NewPiScreen Input:focus {
        border: tall $primary;
    }
    """

    BINDINGS = [
        Binding("escape", "cancel", "cancel"),
        # priority=True so the modal grabs Tab before Input's focus-traversal.
        Binding("tab", "complete", "complete", priority=True, show=False),
    ]

    def __init__(self, mode: str, default_cwd: str) -> None:
        super().__init__()
        self.mode = mode  # "session" or "window"
        self.default_cwd = default_cwd

    def compose(self) -> ComposeResult:
        title = (
            "Launch pi in a new tmux session"
            if self.mode == "session"
            else "Launch pi in a new window (current session)"
        )
        with Container(id="new-pi-dialog"):
            yield Static(title, id="new-pi-title")
            yield Input(
                value=self.default_cwd,
                id="new-pi-cwd",
                placeholder="directory to start pi in",
            )
            yield Static("", id="new-pi-matches")
            yield Static(
                "[#8abeb7]Tab[/#8abeb7] to complete  ·  "
                "[#8abeb7]Enter[/#8abeb7] to launch  ·  "
                "[#8abeb7]Esc[/#8abeb7] to cancel",
                id="new-pi-hint",
            )

    def on_mount(self) -> None:
        inp = self.query_one(Input)
        inp.focus()
        inp.cursor_position = len(inp.value)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        cwd = event.value.strip()
        if not cwd:
            self.dismiss(None)
            return
        self.dismiss((self.mode, cwd))

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_complete(self) -> None:
        """Bash-style tab completion: extend value to longest common prefix
        of matching subdirectories, show remaining candidates below."""
        inp = self.query_one(Input)
        current = inp.value
        completed, matches = _complete_dir_path(current)
        if completed != current:
            inp.value = completed
            inp.cursor_position = len(completed)
        matches_widget = self.query_one("#new-pi-matches", Static)
        if not matches:
            matches_widget.update("[dim](no matching directories)[/dim]")
        elif len(matches) == 1:
            matches_widget.update("")
        else:
            shown = "  ".join(escape(m) for m in matches[:6])
            extra = f"  [dim]+{len(matches) - 6} more[/dim]" if len(matches) > 6 else ""
            matches_widget.update(f"[dim]{shown}[/dim]{extra}")

    def on_input_changed(self, event: Input.Changed) -> None:
        # Clear stale match list when the user keeps typing.
        self.query_one("#new-pi-matches", Static).update("")


def _complete_dir_path(value: str) -> tuple[str, list[str]]:
    """Return (completed_value, matching_subdir_names).

    `completed_value` is the longest common prefix of all directories whose
    name starts with the partial component of `value`. If exactly one match,
    a trailing slash is appended so the user can immediately tab again into
    the next level. Hidden entries (`.` prefix) are only shown when the
    user typed a leading dot themselves.
    """
    if not value:
        return value, []
    expanded = os.path.expanduser(value)
    if expanded.endswith("/"):
        parent = expanded.rstrip("/") or "/"
        partial = ""
    else:
        parent = os.path.dirname(expanded) or "."
        partial = os.path.basename(expanded)
    show_hidden = partial.startswith(".")
    try:
        entries = sorted(os.listdir(parent))
    except (FileNotFoundError, PermissionError, NotADirectoryError):
        return value, []
    matches: list[str] = []
    for name in entries:
        if not show_hidden and name.startswith("."):
            continue
        if not name.startswith(partial):
            continue
        if os.path.isdir(os.path.join(parent, name)):
            matches.append(name)
    if not matches:
        return value, []
    if len(matches) == 1:
        full = os.path.join(parent, matches[0]) + "/"
    else:
        common = matches[0]
        for m in matches[1:]:
            i = 0
            while i < len(common) and i < len(m) and common[i] == m[i]:
                i += 1
            common = common[:i]
        if not common or common == partial:
            return value, matches
        full = os.path.join(parent, common)
    # Preserve `~` form if the user typed it.
    if value.startswith("~"):
        home = os.path.expanduser("~")
        if full.startswith(home):
            full = "~" + full[len(home) :]
    return full, matches


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def fmt_idle(seconds: float) -> str:
    if seconds < 1:
        return ""
    if seconds < 60:
        return f"{int(seconds)}s"
    if seconds < 3600:
        return f"{int(seconds // 60)}m"
    return f"{int(seconds // 3600)}h"


def _lerp_color(c1: str, c2: str, t: float) -> str:
    """Linear-interpolate two `#rrggbb` colors. t in [0, 1]."""
    r1, g1, b1 = int(c1[1:3], 16), int(c1[3:5], 16), int(c1[5:7], 16)
    r2, g2, b2 = int(c2[1:3], 16), int(c2[3:5], 16), int(c2[5:7], 16)
    r = int(r1 + (r2 - r1) * t)
    g = int(g1 + (g2 - g1) * t)
    b = int(b1 + (b2 - b1) * t)
    return f"#{r:02x}{g:02x}{b:02x}"


def fmt_row(
    pane: Pane,
    status: PaneStatus,
    *,
    spinner_char: str = " ",
    working_color: str | None = None,
) -> str:
    """Rich markup string for a tree leaf.

    Layout:  `<glyph> <state>  Title  · cwd  · idle`

    For WORKING rows, the leading glyph is the current spinner frame and
    the state word's color comes from `working_color` (the pulsed value
    computed by the animation timer). For all other states the leading
    column is a single space (kept for column alignment) and color comes
    from `STATE_COLORS`.
    """
    is_working = status.state == AgentState.WORKING
    if is_working:
        color = working_color or STATE_COLORS[AgentState.WORKING]
        glyph = spinner_char
    else:
        color = STATE_COLORS.get(status.state, "grey50")
        glyph = " "

    state_label = status.state.value.ljust(STATE_LABEL_WIDTH)
    title = escape(pane.title or f"pane {pane.pane_index}")
    cwd = escape(Path(pane.cwd).name or pane.cwd)
    idle = fmt_idle(status.idle_seconds)

    parts = [
        f"[{color}]{glyph}[/{color}] [bold {color}]{state_label}[/bold {color}] {title}"
    ]
    if cwd:
        parts.append(f"  [dim]· {cwd}[/dim]")
    if idle:
        parts.append(f"  [dim]· {idle}[/dim]")
    return "".join(parts)


def fmt_session_header(session: str, statuses: list[PaneStatus]) -> str:
    """`Session  ·  1 idle` (counts only for attention states).

    No glyphs; colored count text on the right.
    """
    name = escape(session)
    counts: list[str] = []
    for state in (AgentState.ERROR, AgentState.WAITING, AgentState.IDLE):
        n = sum(1 for s in statuses if s.state == state)
        if n:
            color = STATE_COLORS[state]
            counts.append(f"[{color}]{n} {state.value}[/{color}]")
    suffix = f"  [dim]·[/dim]  {'  [dim]·[/dim]  '.join(counts)}" if counts else ""
    return f"[bold]{name}[/bold]{suffix}"


def fmt_status_widget(statuses: list[PaneStatus]) -> str:
    counts: dict[AgentState, int] = {}
    for s in statuses:
        counts[s.state] = counts.get(s.state, 0) + 1
    parts: list[str] = []
    for state in (
        AgentState.ERROR,
        AgentState.WAITING,
        AgentState.IDLE,
        AgentState.RETRYING,
        AgentState.WORKING,
    ):
        n = counts.get(state, 0)
        if n:
            parts.append(f"{STATE_GLYPHS[state]}{n}")
    return " ".join(parts)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


class PiMonitorApp(App):
    """The pi-monitor TUI.

    Renders the Sessions tree in the LEFT tmux pane of the monitor session.
    The RIGHT tmux pane is owned by tmux and reset/respawned via this class
    when the user picks an agent (see `_borrow_into_right_slot`).
    """

    # Layout uses Textual's theme variables ($primary, $accent, $surface,
    # $foreground, $foreground-muted, ...) so swapping the active theme
    # rethemes the whole UI for free. The Screen and chrome bars are
    # transparent on purpose: a translucent terminal will let the user's
    # wallpaper / blurred desktop show through. The tree card and modals
    # keep $surface so text never lands on a busy backdrop.
    CSS = """
    Screen {
        background: transparent;
        color: $foreground;
        layout: vertical;
    }

    #title-bar {
        height: 1;
        padding: 0 2;
        background: transparent;
        color: $foreground;
        text-wrap: nowrap;
        text-overflow: ellipsis;
    }

    #attention-banner {
        height: 1;
        padding: 0 2;
        background: transparent;
        color: $foreground-muted;
        text-wrap: nowrap;
        text-overflow: ellipsis;
    }

    #attention-banner.hidden {
        display: none;
    }

    #tree-wrap {
        height: 1fr;
        width: 100%;
        border: round $primary 50%;
        border-title-color: $primary;
        border-title-style: bold;
        border-title-align: left;
        background: $surface;
        margin: 1 1 0 1;
        padding: 0;
    }

    #tree-wrap:focus-within {
        border: round $primary;
    }

    Tree {
        background: $surface;
        color: $foreground;
        padding: 1 1;
    }

    Tree > .tree--cursor {
        background: $primary 30%;
        color: $foreground;
        text-style: bold;
    }

    Tree > .tree--guides {
        color: $foreground-muted 50%;
    }

    Footer {
        background: transparent;
        color: $foreground-muted;
    }

    /* In Textual 8.x the Footer DOM is Footer > KeyGroup > FooterKey, so the
       component classes live two levels deep and cannot be matched with a
       direct-child selector from Footer. Use unscoped class selectors. */
    .footer-key--key {
        background: transparent;
        color: $primary;
        text-style: bold;
    }

    .footer-key--description {
        background: transparent;
        color: $foreground-muted;
    }
    """

    BINDINGS = [
        Binding("h", "tree_collapse_or_parent", "←", show=False),
        Binding("j", "tree_cursor_down", "↓", show=False),
        Binding("k", "tree_cursor_up", "↑", show=False),
        Binding("l", "tree_expand_or_child", "→", show=False),
        Binding("tab", "focus_right", "→agent"),
        Binding("g", "go_top", "top", show=False),
        Binding("G", "go_bottom", "bottom", show=False),
        Binding("s", "cycle_sort", "sort"),
        Binding("t", "cycle_theme", "theme"),
        Binding("shift+h", "toggle_show_non_pi", "show non-pi", show=False),
        Binding("r", "refresh_now", "refresh", show=False),
        Binding("m", "toggle_mute", "mute"),
        Binding("o", "open_new", "new"),
        Binding("q", "quit_monitor", "quit"),
        Binding("?", "show_help", "help"),
        Binding("1", "jump(1)", show=False),
        Binding("2", "jump(2)", show=False),
        Binding("3", "jump(3)", show=False),
        Binding("4", "jump(4)", show=False),
        Binding("5", "jump(5)", show=False),
        Binding("6", "jump(6)", show=False),
        Binding("7", "jump(7)", show=False),
        Binding("8", "jump(8)", show=False),
        Binding("9", "jump(9)", show=False),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.config = load_config()
        self.notifier = Notifier(
            enabled=bool(self.config.get("notifications_enabled", True))
        )
        self.resolver = StateResolver()
        self.show_non_pi = False
        self.sort_mode = self.config.get("sort_mode", "tmux")
        saved_theme = self.config.get("theme", DEFAULT_THEME)
        self._theme_name = self._resolve_theme(saved_theme)
        # If the saved theme name didn't match anything in our curated
        # list (typo, removed theme, theme from a Textual we don't ship),
        # remember the bad value so on_mount can toast about it once.
        self._stale_saved_theme: str | None = (
            saved_theme if saved_theme != self._theme_name else None
        )
        self._first_tick = True
        self._last_labels: dict[tuple[str, str], str] = {}
        self._needs_full_rebuild = True
        self._latest_statuses: dict[str, tuple[Pane, PaneStatus]] = {}
        # The viewer session currently attached in the right tmux pane (or
        # None when the right pane is at its placeholder).
        self._active_viewer: str | None = None
        # Animation state: spinner frame counter.
        self._spinner_frame = 0

    @staticmethod
    def _resolve_theme(name: str) -> str:
        """Validate a theme name from config; fall back to default if it
        isn't a built-in (e.g. user pinned a Textual theme that's been
        removed in a later version)."""
        return name if name in THEMES else DEFAULT_THEME

    # -- Composition --------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Static("pi-monitor", id="title-bar")
        yield Static("", id="attention-banner", classes="hidden")
        with Container(id="tree-wrap"):
            yield Tree("Sessions", id="tree")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "pi-monitor"
        self._title_bar: Static = self.query_one("#title-bar", Static)
        self._attention_banner: Static = self.query_one("#attention-banner", Static)
        self._tree_wrap: Container = self.query_one("#tree-wrap", Container)
        self._tree_wrap.border_title = "Sessions"
        self._tree: Tree = self.query_one("#tree", Tree)
        self._tree.show_root = False
        self._tree.guide_depth = 2
        self._tree.focus()
        self.notifier.on_transition = self._on_transition
        # Pull initial palette from the saved theme before the first tick
        # so the very first render uses the right colors.
        self.theme = self._theme_name
        self._refresh_state_colors()
        # Surface bad config values once, after the UI is up. We persist
        # the corrected value so we don't nag on every launch.
        if self._stale_saved_theme is not None:
            self.notify(
                f"unknown theme '{self._stale_saved_theme}', using {self._theme_name}",
                severity="warning",
                timeout=4,
            )
            self.config["theme"] = self._theme_name
            save_config(self.config)
            self._stale_saved_theme = None
        self.set_interval(POLL_INTERVAL_S, self._tick)
        self.set_interval(SPINNER_INTERVAL_S, self._animate_working_rows)
        self._tick()

    def _refresh_state_colors(self) -> None:
        """Pull the live theme's colors into our module-level color tables.
        Called on mount and on every theme cycle so existing format helpers
        stay theme-aware without being threaded with an app reference.

        Mutating the module globals is the simplest path: STATE_COLORS is
        already a mutable dict that fmt_* helpers read at call time, and
        ACCENT / WORKING_PULSE_DIM are only read by helpers in this file.
        """
        global ACCENT, WORKING_PULSE_DIM
        # If the saved theme isn't registered any more (Textual dropped it,
        # config has a typo, ...) recover deterministically: log once via a
        # toast, fall back to the default, and keep going.
        if self._theme_name not in self.available_themes:
            self.notify(
                f"unknown theme '{self._theme_name}', using {DEFAULT_THEME}",
                severity="warning",
                timeout=4,
            )
            self._theme_name = DEFAULT_THEME
            self.theme = DEFAULT_THEME
            self.config["theme"] = DEFAULT_THEME
            save_config(self.config)
        # Use the *resolved* CSS variables rather than the raw `Theme.success`
        # attributes, because raw attributes are sometimes None (textual-dark
        # leaves `background` for Textual to derive, textual-light leaves
        # `foreground` likewise). The resolver fills those in.
        palette = self.current_theme.to_color_system().generate()
        surface_solid = palette["surface"][:7]
        STATE_COLORS[AgentState.WORKING] = palette["success"]
        STATE_COLORS[AgentState.IDLE] = palette["warning"]
        STATE_COLORS[AgentState.ERROR] = palette["error"]
        # Heartbeat-only states (only set when the pi-monitor-heartbeat
        # extension is installed). Map to theme palette so they stay
        # legible on every theme:
        #   waiting  → accent  (distinct from warning, demands attention)
        #   retrying → primary (calm, "system is handling this")
        # The slight overlap between RETRYING and ACCENT (which also pulls
        # from `primary`) is intentional and harmless: ACCENT is used in
        # chrome (key hints, new-session row); RETRYING is used in pane
        # rows. Different visual contexts, same hue.
        STATE_COLORS[AgentState.WAITING] = palette["accent"]
        STATE_COLORS[AgentState.RETRYING] = palette["primary"]
        # Use Textual's own muted foreground for UNKNOWN — it's contrast-
        # correct against `$surface` on light themes too. The value carries
        # an `#RRGGBBAA` alpha suffix; **Textual's** Static renderer strips
        # the alpha at print time, so the on-screen color is the RGB
        # component. (Pure Rich would fail to parse it — don't reuse this
        # outside a Textual render path.)
        STATE_COLORS[AgentState.UNKNOWN] = palette["foreground-muted"]
        # NO_PI used to be the same RGB as UNKNOWN with only the alpha
        # different, which Textual ignores. Blend it halfway toward
        # `$surface` so the two states are *visually* distinguishable
        # while staying clearly de-emphasized.
        STATE_COLORS[AgentState.NO_PI] = _lerp_color(
            palette["foreground-disabled"][:7], surface_solid, 0.5
        )
        ACCENT = palette["primary"]
        # Pulse dim end: blend success with $surface (the tree card's bg) at
        # 50% so the dim end of the working animation stays legible across
        # light AND dark themes. Strip alpha defensively before lerping.
        WORKING_PULSE_DIM = _lerp_color(palette["success"][:7], surface_solid, 0.5)

    # -- Animation ---------------------------------------------------------

    def _animation_state(self) -> tuple[str, str]:
        """Current (spinner_char, pulse_color) for working rows."""
        spinner_char = SPINNER_FRAMES[self._spinner_frame % len(SPINNER_FRAMES)]
        # Sine-wave pulse between dim and bright green over PULSE_PERIOD_S.
        # Range 0.55..1.0 keeps the dim end legible.
        t = time.time() % PULSE_PERIOD_S
        fraction = 0.55 + 0.45 * math.sin(2 * math.pi * t / PULSE_PERIOD_S)
        if fraction < 0:
            fraction = 0.0
        elif fraction > 1:
            fraction = 1.0
        pulse_color = _lerp_color(
            WORKING_PULSE_DIM, STATE_COLORS[AgentState.WORKING], fraction
        )
        return spinner_char, pulse_color

    def _animate_working_rows(self) -> None:
        """Update labels of WORKING rows with the next spinner frame and the
        current pulse color. Skips non-working rows so non-animated rows
        don't flicker. Runs every SPINNER_INTERVAL_S."""
        if not hasattr(self, "_tree"):
            return
        self._spinner_frame = (self._spinner_frame + 1) % len(SPINNER_FRAMES)
        spinner_char, pulse_color = self._animation_state()
        for sess_node in self._tree.root.children:
            for leaf in sess_node.children:
                if not (leaf.data and leaf.data[0] == "pane"):
                    continue
                entry = self._latest_statuses.get(leaf.data[1])
                if entry is None:
                    continue
                pane, status = entry
                if status.state != AgentState.WORKING:
                    continue
                label = fmt_row(
                    pane,
                    status,
                    spinner_char=spinner_char,
                    working_color=pulse_color,
                )
                pane_key = ("pane", pane.pane_id)
                if self._last_labels.get(pane_key) != label:
                    self._last_labels[pane_key] = label
                    leaf.set_label(label)

    def _on_transition(
        self,
        pane_id: str,
        state: AgentState,
        title: str,
        body: str,
    ) -> None:
        severity = STATE_TOAST_SEVERITY.get(state, "information")
        self.notify(
            f"{body}\nstate: {state.value}",
            title=title,
            severity=severity,
            timeout=6,
        )

    # -- Tick / render ------------------------------------------------------

    def _tick(self) -> None:
        try:
            all_panes = list_panes()
        except TmuxError:
            return

        # Hide our own monitor session AND any viewer session-group sisters
        # we created — viewer sessions surface the same shared windows under
        # a different session name and would otherwise show as duplicates.
        visible = [
            p
            for p in all_panes
            if p.session != MONITOR_SESSION and not is_viewer_session(p.session)
        ]
        if not self.show_non_pi:
            visible = [p for p in visible if p.is_pi]

        refs = [
            PaneRef(
                pane_id=p.target,
                cwd=p.cwd,
                is_pi=p.is_pi,
                pane_pid=p.pid,
            )
            for p in visible
        ]
        resolved = self.resolver.resolve(refs)
        statuses: list[tuple[Pane, PaneStatus]] = [
            (p, resolved[p.target]) for p in visible
        ]

        observations = [(p.target, s.state) for p, s in statuses]
        if self._first_tick:
            self.notifier.seed_from(observations)
            self._first_tick = False
        else:
            for pane, status in statuses:
                # Pass last_error so the notifier can suppress transient
                # auto-retry blips. snapshot is None for STARTING / NO_PI
                # / UNKNOWN panes; treat that as no error.
                err_msg = (
                    status.snapshot.last_error if status.snapshot is not None else None
                )
                self.notifier.transition(
                    pane.target,
                    status.state,
                    title=f"pi · {pane.session}/{pane.title}",
                    body=Path(pane.cwd).name or pane.cwd,
                    error_message=err_msg,
                )
            # Release any previously-deferred ERROR notifications whose
            # suppression window has expired without recovery.
            self.notifier.tick()

        self._latest_statuses = {p.pane_id: (p, s) for p, s in statuses}

        set_status_widget(fmt_status_widget([s for _, s in statuses]))
        self._update_chrome(statuses)
        self._render(statuses)
        self._reconcile_active_viewer(visible)

    def _reconcile_active_viewer(self, visible_panes: list[Pane]) -> None:
        """If the source session for the currently-attached viewer is gone
        (user killed it externally), reset the right slot back to its
        placeholder so we don't keep a zombie pane alive."""
        if self._active_viewer is None:
            return
        live_sources = {
            p.session for p in visible_panes if not is_viewer_session(p.session)
        }
        # Reverse-engineer the source name from the viewer name. We only
        # accept the match if a live pane in that source is actually present;
        # otherwise the source is gone.
        prefix = "pi-monitor-view-"
        if not self._active_viewer.startswith(prefix):
            return
        suspected = self._active_viewer[len(prefix) :]
        if suspected in live_sources:
            return
        # Source vanished — clean up.
        kill_linked_viewer(self._active_viewer)
        try:
            reset_right_slot_to_placeholder()
        except TmuxError:
            pass
        self._active_viewer = None

    def _update_chrome(self, statuses: list[tuple[Pane, PaneStatus]]) -> None:
        """Render the title bar (brand + always-on stat chips + view info)
        and the attention banner (top issue + count of the rest).

        Once any pane exists the title-bar layout is stable so the eye
        doesn't have to chase moving content: zero-counts render in dim.
        With zero panes total we drop the chips entirely and let the tree's
        empty-state hint do the talking.
        """
        counts: dict[AgentState, int] = {}
        for _, s in statuses:
            counts[s.state] = counts.get(s.state, 0) + 1
        total = sum(counts.values())

        brand = f"[bold {ACCENT}]pi-monitor[/bold {ACCENT}]"
        if total == 0:
            # Empty state: brand + the same hint the tree shows, so users
            # see the next action no matter where their eye lands.
            self._title_bar.update(
                f"{brand}   [dim]no pi sessions yet · press [/dim]"
                f"[bold {ACCENT}]o[/bold {ACCENT}][dim] to launch one[/dim]"
            )
            self._tree_wrap.border_title = "Sessions"
            self._update_attention_banner(statuses, counts)
            return

        # Stat chips: working / idle / error, colored from the live theme.
        # Zero rows render in dim so the layout is stable while panes come
        # and go.
        chips: list[str] = []
        for state in (AgentState.WORKING, AgentState.IDLE, AgentState.ERROR):
            n = counts.get(state, 0)
            color = STATE_COLORS[state] if n else "grey50"
            chips.append(f"[{color}]{CHIP_GLYPHS[state]} {n}[/{color}]")
        chips_str = "  ".join(chips)

        info_bits = [
            f"{total} pane{'s' if total != 1 else ''}",
            f"sort:{self.sort_mode}",
            self._theme_name,
        ]
        if not self.notifier.enabled:
            info_bits.append("muted")
        info = "  [dim]·[/dim]  ".join(info_bits)

        self._title_bar.update(
            f"{brand}   {chips_str}   [dim]·[/dim]   [dim]{info}[/dim]"
        )

        # Border title shows section name + live total so the card itself
        # tells you how much it's showing without having to scan the chips.
        self._tree_wrap.border_title = f"Sessions  ·  {total}"

        self._update_attention_banner(statuses, counts)

    def _update_attention_banner(
        self,
        statuses: list[tuple[Pane, PaneStatus]],
        counts: dict[AgentState, int],
    ) -> None:
        """Surface the single most-attention-needing pane by name. If more
        panes also need attention, append `+N more`. Hide entirely when
        nothing's stuck.

        Highest priority wins: ERROR > IDLE. Among the same state we pick
        the longest-idle pane (oldest issue first).
        """
        attention_total = sum(
            counts.get(s, 0)
            for s in (AgentState.ERROR, AgentState.WAITING, AgentState.IDLE)
        )
        if attention_total == 0:
            self._attention_banner.add_class("hidden")
            self._attention_banner.update("")
            return

        # Pick the worst case: errors first, then waiting, then idle,
        # oldest within state.
        candidates: list[tuple[Pane, PaneStatus]] = [
            (p, s) for p, s in statuses if s.state in ATTENTION_STATES
        ]
        candidates.sort(
            key=lambda ps: (
                STATE_PRIORITY.get(ps[1].state, 99),
                -ps[1].idle_seconds,
            )
        )
        top_pane, top_status = candidates[0]
        color = STATE_COLORS[top_status.state]
        # Per-state verb. Default fallback handles any future ATTENTION
        # state we forget to map here.
        verb = {
            AgentState.ERROR: "errored",
            AgentState.WAITING: "waiting",
            AgentState.IDLE: "idle",
        }.get(top_status.state, top_status.state.value)
        idle_tag = fmt_idle(top_status.idle_seconds)
        idle_part = f" {idle_tag}" if idle_tag else ""
        target = escape(f"{top_pane.session}/{top_pane.title or top_pane.pane_index}")
        rest = attention_total - 1
        rest_part = f"  [dim]· +{rest} more[/dim]" if rest else ""
        # CHIP_GLYPHS only covers the four "primary" states (working/idle/
        # error/unknown). For WAITING, fall back to STATE_GLYPHS' tmux glyph.
        chip = CHIP_GLYPHS.get(
            top_status.state, STATE_GLYPHS.get(top_status.state, "○")
        )
        self._attention_banner.update(
            f"[bold {color}]{chip}[/bold {color}] "
            f"[bold]{target}[/bold] [{color}]{verb}{idle_part}[/{color}]"
            f"{rest_part}  [dim]· press 1–9 to jump[/dim]"
        )
        self._attention_banner.remove_class("hidden")

    def _render(self, statuses: list[tuple[Pane, PaneStatus]]) -> None:
        by_session: dict[str, list[tuple[Pane, PaneStatus]]] = {}
        for pane, status in statuses:
            by_session.setdefault(pane.session, []).append((pane, status))
        for items in by_session.values():
            if self.sort_mode == "status":
                items.sort(
                    key=lambda x: (
                        STATE_PRIORITY.get(x[1].state, 99),
                        x[0].window_index,
                        x[0].pane_index,
                    )
                )
            else:
                items.sort(key=lambda x: (x[0].window_index, x[0].pane_index))
        desired_sessions = sorted(by_session.keys())

        if self._needs_full_rebuild:
            self._full_rebuild(by_session, desired_sessions)
            self._needs_full_rebuild = False
        else:
            self._diff_update(by_session, desired_sessions)
        self._sync_empty_hint(not desired_sessions)

    def _sync_empty_hint(self, empty: bool) -> None:
        """Show or hide the first-run hint leaf below `+ new session`.

        The hint is a sibling root-level leaf (not a child of the new-
        session row). Called after both the full and diff rebuild paths
        so users see "no pi sessions yet · press o to launch one" when
        their tree is otherwise blank, regardless of how we got there.
        """
        hint_key = ("hint", None)
        existing = next(
            (c for c in self._tree.root.children if c.data == hint_key), None
        )
        if empty and existing is None:
            label = (
                "  [dim]no pi sessions yet · press [/dim]"
                f"[bold {ACCENT}]o[/bold {ACCENT}]"
                "[dim] to launch one[/dim]"
            )
            self._tree.root.add_leaf(label, data=hint_key)
            self._last_labels[hint_key] = label
        elif not empty and existing is not None:
            existing.remove()
            self._last_labels.pop(hint_key, None)

    def _full_rebuild(
        self,
        by_session: dict[str, list[tuple[Pane, PaneStatus]]],
        desired_sessions: list[str],
    ) -> None:
        prev_cursor = self._tree.cursor_node.data if self._tree.cursor_node else None
        expanded: dict[tuple, bool] = {}
        for child in list(self._tree.root.children):
            if child.data:
                expanded[child.data] = child.is_expanded

        self._tree.root.remove_children()
        self._last_labels.clear()

        # Synthetic 'new session' affordance always at the top of the tree.
        new_label = _new_session_label()
        new_key = ("new", None)
        self._tree.root.add_leaf(new_label, data=new_key)
        self._last_labels[new_key] = new_label

        spinner_char, pulse_color = self._animation_state()
        for session in desired_sessions:
            items = by_session[session]
            header = fmt_session_header(session, [s for _, s in items])
            sess_key = ("session", session)
            sess_node = self._tree.root.add(header, data=sess_key, expand=True)
            self._last_labels[sess_key] = header
            if expanded.get(sess_key, True) is False:
                sess_node.collapse()
            for pane, status in items:
                label = fmt_row(
                    pane,
                    status,
                    spinner_char=spinner_char,
                    working_color=pulse_color,
                )
                pane_key = ("pane", pane.pane_id)
                sess_node.add_leaf(label, data=pane_key)
                self._last_labels[pane_key] = label

        if prev_cursor is not None:
            self._restore_cursor(prev_cursor)

    def _diff_update(
        self,
        by_session: dict[str, list[tuple[Pane, PaneStatus]]],
        desired_sessions: list[str],
    ) -> None:
        sess_nodes: dict[str, object] = {}
        for child in self._tree.root.children:
            if child.data and child.data[0] == "session":
                sess_nodes[child.data[1]] = child

        live = set(desired_sessions)
        for name, node in list(sess_nodes.items()):
            if name not in live:
                node.remove()
                self._last_labels.pop(("session", name), None)
                del sess_nodes[name]

        spinner_char, pulse_color = self._animation_state()
        for name in desired_sessions:
            items = by_session[name]
            header = fmt_session_header(name, [s for _, s in items])
            sess_key = ("session", name)

            if name not in sess_nodes:
                sess_node = self._tree.root.add(header, data=sess_key, expand=True)
                sess_nodes[name] = sess_node
                self._last_labels[sess_key] = header
                for pane, status in items:
                    label = fmt_row(
                        pane,
                        status,
                        spinner_char=spinner_char,
                        working_color=pulse_color,
                    )
                    pane_key = ("pane", pane.pane_id)
                    sess_node.add_leaf(label, data=pane_key)
                    self._last_labels[pane_key] = label
                continue

            sess_node = sess_nodes[name]
            if self._last_labels.get(sess_key) != header:
                sess_node.set_label(header)
                self._last_labels[sess_key] = header

            pane_nodes: dict[str, object] = {}
            for child in sess_node.children:
                if child.data and child.data[0] == "pane":
                    pane_nodes[child.data[1]] = child

            desired_ids = {p.pane_id for p, _ in items}
            for pid, node in list(pane_nodes.items()):
                if pid not in desired_ids:
                    node.remove()
                    self._last_labels.pop(("pane", pid), None)
                    del pane_nodes[pid]

            for pane, status in items:
                # WORKING rows are owned by the animation timer; let it set
                # their labels so its frame doesn't fight ours. We still add
                # missing rows here (with the current animation snapshot).
                pane_key = ("pane", pane.pane_id)
                if pane.pane_id in pane_nodes:
                    if status.state == AgentState.WORKING:
                        continue
                    label = fmt_row(pane, status)
                    if self._last_labels.get(pane_key) != label:
                        pane_nodes[pane.pane_id].set_label(label)
                        self._last_labels[pane_key] = label
                else:
                    label = fmt_row(
                        pane,
                        status,
                        spinner_char=spinner_char,
                        working_color=pulse_color,
                    )
                    sess_node.add_leaf(label, data=pane_key)
                    self._last_labels[pane_key] = label

    def _restore_cursor(self, target_data) -> None:
        """Re-cursor to a row identified by its `data` key after a rebuild.

        Uses `move_cursor` (cursor-only) instead of `select_node`, because
        select_node also posts a `NodeSelected` event — which we wired to
        side-effects like opening the new-session modal or focusing the
        right tmux pane. A passive rebuild must never trigger user-action
        side-effects.
        """
        if target_data is None:
            return
        for sess_node in self._tree.root.children:
            if sess_node.data == target_data:
                self._tree.move_cursor(sess_node)
                return
            for leaf in sess_node.children:
                if leaf.data == target_data:
                    self._tree.move_cursor(leaf)
                    return

    # -- Tree event ---------------------------------------------------------

    def on_tree_node_highlighted(self, event) -> None:
        """Cursor moved to a row — preview the hovered agent in the right
        pane while keyboard focus stays on the tree.

        Pane rows trigger an attach (idempotent if it's the same source
        session). Session headers and the `[+] new session` row are
        no-ops; the right pane keeps showing whatever was last previewed
        so the user can navigate around without losing context.
        """
        node = event.node
        if not node.data:
            return
        if node.data[0] != "pane":
            return
        entry = self._latest_statuses.get(node.data[1])
        if entry is None:
            return
        self._borrow_into_right_slot(entry[0])

    def on_tree_node_selected(self, event) -> None:
        """Enter (or click) on a row.

        - on `[+] new session`: open the new-session modal
        - on a pane: hand keyboard focus to the right pane so the user
          can type to the agent. The agent itself was already attached
          on hover (see `on_tree_node_highlighted`).
        - on a session header: default tree expand/collapse (handled elsewhere)
        """
        node = event.node
        if not node.data:
            return
        kind = node.data[0]
        if kind == "new":
            self._open_new_session()
            return
        if kind == "pane":
            # Make sure the preview is current (covers a rare race where
            # the user clicks a row their cursor never highlighted).
            entry = self._latest_statuses.get(node.data[1])
            if entry is not None:
                self._borrow_into_right_slot(entry[0])
            if self._active_viewer is None:
                return
            try:
                focus_right_slot()
            except TmuxError as exc:
                self.notify(
                    f"could not focus right pane: {exc}",
                    severity="error",
                    timeout=8,
                )

    # -- Right slot management ---------------------------------------------

    def _borrow_into_right_slot(self, pane: Pane) -> None:
        """Make the right tmux pane show `pane` interactively, without
        moving the source pane. We:

        1. Ensure a session-group sister of `pane.session` exists.
        2. Set that viewer's current window+pane to `pane`'s coordinates.
        3. Tmux-zoom the selected pane in the viewer's window so any
           non-pi siblings (a shell, an editor, ...) sharing the same
           tmux window are hidden. Idempotent.
        4. If the right slot was attached to a different viewer (i.e. a
           different source session), respawn it with `tmux attach` to
           the new viewer (passing the agent's `cwd` so any user-
           initiated split of the right pane lands in the agent's
           directory), then kill the old viewer.

        The 2-pane monitor split (tree on the left, agent on the right)
        stays as configured. Cursor focus stays on the tree so the user
        can keep navigating; Tab (`action_focus_right`) is the explicit
        handoff to the right pane when they're ready to type.

        To temporarily see the source window's other panes, the user can
        press the inner viewer's `prefix + z` (configured to `C-a z`) to
        unzoom. Splits added via `C-a \"` / `C-a %` will be created
        inside the right slot's frame.
        """
        try:
            viewer = ensure_linked_viewer(pane.session)
            viewer_focus_pane(viewer, pane.window_index, pane.pane_index)
            viewer_zoom_to_pane(viewer, pane.window_index, pane.pane_index)

            if self._active_viewer != viewer:
                attach_right_slot_to_viewer(viewer, cwd=pane.cwd)
                if self._active_viewer is not None:
                    kill_linked_viewer(self._active_viewer)
                self._active_viewer = viewer
        except TmuxError as exc:
            self.notify(f"could not borrow: {exc}", severity="error", timeout=8)

    def action_focus_right(self) -> None:
        """Tab: hand the keyboard to the right tmux pane (whatever's
        attached there). If the right slot is still at the placeholder we
        skip — the user has nothing to interact with yet."""
        if self._active_viewer is None:
            self.notify(
                "no agent attached yet — Enter on a pane first",
                severity="warning",
                timeout=4,
            )
            return
        try:
            focus_right_slot()
        except TmuxError as exc:
            self.notify(
                f"could not focus right pane: {exc}", severity="error", timeout=8
            )

    def action_go_top(self) -> None:
        if self._tree.root.children:
            first = self._tree.root.children[0]
            target = first.children[0] if first.children else first
            self._tree.select_node(target)
            self._tree.scroll_home()

    def action_go_bottom(self) -> None:
        if not self._tree.root.children:
            return
        last = self._tree.root.children[-1]
        target = last.children[-1] if last.children else last
        self._tree.select_node(target)
        self._tree.scroll_end()

    def action_cycle_sort(self) -> None:
        self.sort_mode = "status" if self.sort_mode == "tmux" else "tmux"
        self.config["sort_mode"] = self.sort_mode
        save_config(self.config)
        self._needs_full_rebuild = True
        self._tick()

    def action_cycle_theme(self) -> None:
        """Cycle through the curated theme list, persist the choice, and
        force a full tree rebuild so cached row labels pick up the new
        accent / state colors."""
        idx = THEMES.index(self._theme_name) if self._theme_name in THEMES else 0
        self._theme_name = THEMES[(idx + 1) % len(THEMES)]
        self.theme = self._theme_name
        self.config["theme"] = self._theme_name
        save_config(self.config)
        self._refresh_state_colors()
        self._needs_full_rebuild = True
        self._tick()
        self.notify(f"theme: {self._theme_name}", timeout=2)

    def action_toggle_show_non_pi(self) -> None:
        self.show_non_pi = not self.show_non_pi
        self._needs_full_rebuild = True
        self._tick()

    def action_refresh_now(self) -> None:
        self._tick()

    def action_toggle_mute(self) -> None:
        self.notifier.enabled = not self.notifier.enabled
        self.config["notifications_enabled"] = self.notifier.enabled
        save_config(self.config)
        self.notify(
            f"Notifications {'on' if self.notifier.enabled else 'muted'}",
            severity="information",
        )

    def action_jump(self, n: int) -> None:
        idx = 0
        for sess_node in self._tree.root.children:
            for leaf in sess_node.children:
                idx += 1
                if idx == n:
                    self._tree.select_node(leaf)
                    return

    def action_tree_cursor_down(self) -> None:
        self._tree.action_cursor_down()

    def action_tree_cursor_up(self) -> None:
        self._tree.action_cursor_up()

    def action_tree_collapse_or_parent(self) -> None:
        node = self._tree.cursor_node
        if node is None:
            return
        if node.allow_expand and node.is_expanded:
            node.collapse()
            return
        parent = node.parent
        if parent is not None and parent != self._tree.root:
            self._tree.select_node(parent)

    def action_tree_expand_or_child(self) -> None:
        node = self._tree.cursor_node
        if node is None:
            return
        if node.allow_expand and not node.is_expanded:
            node.expand()
            return
        children = list(node.children)
        if children:
            self._tree.select_node(children[0])

    def action_show_help(self) -> None:
        self.push_screen(HelpScreen())

    def action_open_new(self) -> None:
        """`o` is context-sensitive:

        - cursor on `[+] new session` row → new tmux session (with pi)
        - cursor on a session header / pane → new pi window in that session
        - cursor on nothing useful (empty tree) → fall back to new session
        """
        node = self._tree.cursor_node
        if node is None or not node.data:
            self._open_new_session()
            return
        kind = node.data[0]
        if kind == "new":
            self._open_new_session()
            return
        if kind in ("session", "pane"):
            self._open_window()
            return
        # Defensive fallback for any unrecognized node kind.
        self._open_new_session()

    def _open_new_session(self) -> None:
        default_cwd = self._cursored_cwd() or os.path.expanduser("~")
        self.push_screen(
            NewPiScreen("session", default_cwd),
            self._handle_launch_result,
        )

    def _open_window(self) -> None:
        pane = self._cursored_pane_obj()
        if pane is None:
            # Shouldn't normally happen given the dispatcher above; safe fallback.
            self._open_new_session()
            return
        self._window_target = pane.session
        self.push_screen(
            NewPiScreen("window", pane.cwd),
            self._handle_launch_result,
        )

    def _cursored_cwd(self) -> str | None:
        node = self._tree.cursor_node
        if node and node.data:
            kind, key = node.data
            if kind == "pane":
                entry = self._latest_statuses.get(key)
                if entry is not None:
                    return entry[0].cwd
            elif kind == "session":
                for p, _ in self._latest_statuses.values():
                    if p.session == key:
                        return p.cwd
        return None

    def _cursored_pane_obj(self) -> Pane | None:
        node = self._tree.cursor_node
        if node is None or not node.data:
            return None
        kind, key = node.data
        if kind == "pane":
            entry = self._latest_statuses.get(key)
            return entry[0] if entry else None
        if kind == "session":
            # Pick any pane in the session; window_index will be the same.
            for p, _ in self._latest_statuses.values():
                if p.session == key:
                    return p
        return None

    def _handle_launch_result(self, result) -> None:
        if result is None:
            return
        mode, cwd = result
        try:
            if mode == "session":
                from .tmux import create_pi_session

                name = create_pi_session(cwd)
                self.notify(
                    f"started pi in session {name}",
                    severity="information",
                    timeout=4,
                )
            else:
                from .tmux import create_pi_window

                target = getattr(self, "_window_target", None)
                if target is None:
                    self.notify(
                        "no target session tracked; cursor a session and try again",
                        severity="error",
                        timeout=5,
                    )
                    return
                create_pi_window(target, cwd)
                self.notify(
                    f"started pi in a new window of session {target}",
                    severity="information",
                    timeout=4,
                )
        except TmuxError as exc:
            self.notify(f"launch failed: {exc}", severity="error", timeout=8)
        # Refresh tree immediately so the new agent shows up.
        self._needs_full_rebuild = True
        self._tick()

    def action_quit_monitor(self) -> None:
        self._cleanup_and_exit()

    def _cleanup_and_exit(self) -> None:
        clear_status_widget()
        # Hand the user's client to a real session before we kill monitor.
        # Skip viewer sisters (they're our own bookkeeping).
        try:
            other = next(
                p.session
                for p in list_panes()
                if p.session != MONITOR_SESSION and not is_viewer_session(p.session)
            )
            _tmux("switch-client", "-t", other)
        except (StopIteration, TmuxError):
            pass
        # Kill the active viewer first so its inner tmux client detaches
        # cleanly, then sweep up any orphans before nuking monitor itself.
        if self._active_viewer is not None:
            kill_linked_viewer(self._active_viewer)
            self._active_viewer = None
        cleanup_orphan_viewers()
        try:
            kill_monitor_session()
        except TmuxError:
            pass
        self.exit()


def run() -> int:
    PiMonitorApp().run()
    return 0
