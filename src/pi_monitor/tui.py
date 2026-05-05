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
    │ title-bar                                │
    │ attention-banner (auto-hides)            │
    │ ╭─ Sessions ─────────────────────────╮   │
    │ │ tree                                │   │
    │ ╰────────────────────────────────────╯   │
    │ footer (key hints)                       │
    └──────────────────────────────────────────┘
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

from .notify import Notifier, load_config, save_config
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

# Pi's `dark` theme color tokens, from
# pi-coding-agent/dist/modes/interactive/theme/dark.json. Used as Rich
# markup colors and as Textual CSS variables in the layout.
PI_ACCENT = "#8abeb7"  # teal
PI_SUCCESS = "#b5bd68"  # green
PI_ERROR = "#cc6666"  # red
PI_WARNING = "#ffff00"  # yellow
PI_MUTED = "#808080"
PI_DIM = "#666666"
# Dim end of the working-state pulse. ~50% darker than PI_SUCCESS, but still
# readable. Picked manually to keep mid-pulse text legible on the card-bg.
PI_SUCCESS_DIM = "#7d8347"

# Per-state colors. Traffic-light semantics:
#   working = green (good, leave alone)
#   idle    = yellow (waiting for you)
#   error   = red (broken)
STATE_COLORS: dict[AgentState, str] = {
    AgentState.WORKING: PI_SUCCESS,
    AgentState.IDLE: PI_WARNING,
    AgentState.ERROR: PI_ERROR,
    AgentState.UNKNOWN: PI_DIM,
    AgentState.NO_PI: "#505050",
}

# Severity passed to Textual's in-TUI toast on transitions.
STATE_TOAST_SEVERITY: dict[AgentState, str] = {
    AgentState.IDLE: "warning",
    AgentState.ERROR: "error",
}

# Used only by the tmux status-line widget; emoji are dependable in tmux.
STATE_GLYPHS: dict[AgentState, str] = {
    AgentState.IDLE: "🔴",
    AgentState.WORKING: "🟢",
    AgentState.ERROR: "❌",
    AgentState.UNKNOWN: "❓",
    AgentState.NO_PI: "⚫",
}

# Width to which we pad state labels in the tree. Longest is 'working' (7).
STATE_LABEL_WIDTH = 8

# Synthetic top-of-tree row that, when activated, opens the new-session
# modal. Always present so the user has an explicit, discoverable way to
# create a tmux session without it being context-sensitive.
NEW_SESSION_LABEL = "[bold #8abeb7][+] new session[/bold #8abeb7]"

# Lower number = higher attention priority.
STATE_PRIORITY: dict[AgentState, int] = {
    AgentState.ERROR: 0,
    AgentState.IDLE: 1,
    AgentState.UNKNOWN: 2,
    AgentState.WORKING: 4,
    AgentState.NO_PI: 5,
}

HELP_TEXT = """\
[bold #8abeb7]pi-monitor — keybindings[/bold #8abeb7]

[bold]Navigation[/bold]
  [#8abeb7]j[/#8abeb7] / [#8abeb7]↓[/#8abeb7]      down
  [#8abeb7]k[/#8abeb7] / [#8abeb7]↑[/#8abeb7]      up
  [#8abeb7]h[/#8abeb7] / [#8abeb7]←[/#8abeb7]      collapse / parent
  [#8abeb7]l[/#8abeb7] / [#8abeb7]→[/#8abeb7]      expand / first child
  [#8abeb7]g[/#8abeb7] / [#8abeb7]G[/#8abeb7]      top / bottom
  [#8abeb7]1–9[/#8abeb7]        jump to Nth pane
  [#8abeb7]Space[/#8abeb7]      expand / collapse session

[bold]Interact[/bold]
  [#8abeb7]Enter[/#8abeb7]      attach the cursored agent to the right
              pane (live, fully interactive). Source
              pane stays put in its origin session.
              The 2-pane split stays visible; cursor
              focus stays on the tree.
  [#8abeb7]Tab[/#8abeb7]        focus the right pane (so keys go to
              the agent already attached there)
  [#8abeb7]prefix+←[/#8abeb7]   tmux nav back to the tree pane
  [#8abeb7]C-a[/#8abeb7]        prefix for the inner viewer
              (the right pane is a nested tmux client)

[bold]Spawn[/bold]
  [#8abeb7]o[/#8abeb7]          context-sensitive launch:
              · on [+] new session row → new tmux session
              · on session header / pane → split that session

[bold]View[/bold]
  [#8abeb7]s[/#8abeb7]          cycle sort: tmux ↔ needs-attention-first
  [#8abeb7]Shift+H[/#8abeb7]    toggle showing non-pi panes
  [#8abeb7]r[/#8abeb7]          force refresh

[bold]Notifications[/bold]
  [#8abeb7]m[/#8abeb7]          mute / unmute (desktop + in-app toasts)

[bold]Exit[/bold]
  [#8abeb7]q[/#8abeb7]          kill monitor session + all viewers
  [#8abeb7]?[/#8abeb7]          toggle this help

[dim]press any key to dismiss[/dim]
"""


def _truncate(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


class HelpScreen(ModalScreen):
    """Modal overlay listing every keybinding. Any key dismisses."""

    DEFAULT_CSS = """
    HelpScreen {
        align: center middle;
        background: rgba(0,0,0,0.7);
    }
    HelpScreen > #help-dialog {
        width: 60;
        height: auto;
        max-height: 80%;
        padding: 1 2;
        border: round #5f87ff;
        background: #1e1e24;
        color: white;
    }
    HelpScreen > #help-dialog > Static {
        width: 100%;
    }
    """

    def compose(self) -> ComposeResult:
        with Container(id="help-dialog"):
            yield Static(HELP_TEXT)

    def on_key(self, event) -> None:
        self.dismiss()


class NewPiScreen(ModalScreen):
    """Prompt for a directory to launch a new pi agent in.

    Returns a tuple `(mode, cwd)` on Enter, or `None` on Esc. The caller
    distinguishes 'session' (new tmux session) vs 'split' (split current)
    via the `mode` it passed in at construction.
    """

    DEFAULT_CSS = """
    NewPiScreen {
        align: center middle;
        background: rgba(0,0,0,0.7);
    }
    NewPiScreen > #new-pi-dialog {
        width: 70;
        height: auto;
        padding: 1 2;
        border: round #5f87ff;
        background: #1e1e24;
        color: white;
    }
    NewPiScreen #new-pi-title {
        color: #8abeb7;
        text-style: bold;
    }
    NewPiScreen #new-pi-matches {
        color: #808080;
        height: auto;
        max-height: 5;
        margin-top: 1;
        padding: 0;
    }
    NewPiScreen #new-pi-hint {
        color: #808080;
        margin-top: 1;
    }
    NewPiScreen Input {
        margin-top: 1;
        background: #18181e;
        color: white;
        border: tall #505050;
    }
    NewPiScreen Input:focus {
        border: tall #8abeb7;
    }
    """

    BINDINGS = [
        Binding("escape", "cancel", "cancel"),
        # priority=True so the modal grabs Tab before Input's focus-traversal.
        Binding("tab", "complete", "complete", priority=True, show=False),
    ]

    def __init__(self, mode: str, default_cwd: str) -> None:
        super().__init__()
        self.mode = mode  # "session" or "split"
        self.default_cwd = default_cwd

    def compose(self) -> ComposeResult:
        title = (
            "Launch pi in a new tmux session"
            if self.mode == "session"
            else "Launch pi in a new split (current session)"
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
    for state in (AgentState.ERROR, AgentState.IDLE):
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
        AgentState.IDLE,
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

    CSS = """
    /* Pi `dark` theme tokens, mirrored into Textual CSS vars. */
    $pi-bg: #18181e;
    $pi-card-bg: #1e1e24;
    $pi-accent: #8abeb7;
    $pi-border: #5f87ff;
    $pi-border-accent: #00d7ff;
    $pi-border-muted: #505050;
    $pi-success: #b5bd68;
    $pi-error: #cc6666;
    $pi-warning: #ffff00;
    $pi-muted: #808080;
    $pi-dim: #666666;
    $pi-selected-bg: #3a3a4a;

    Screen {
        background: $pi-bg;
        color: white;
        layout: vertical;
    }

    #title-bar {
        height: 1;
        padding: 0 2;
        background: $pi-bg;
        color: $pi-accent;
        text-style: bold;
    }

    #attention-banner {
        height: 1;
        padding: 0 2;
        background: $pi-card-bg;
        color: $pi-warning;
    }

    #attention-banner.hidden {
        display: none;
    }

    #tree-wrap {
        height: 1fr;
        width: 100%;
        border: round $pi-border-muted;
        border-title-color: $pi-accent;
        border-title-style: bold;
        border-title-align: left;
        background: $pi-card-bg;
        margin: 1 1 0 1;
        padding: 0;
    }

    Tree {
        background: $pi-card-bg;
        color: white;
        padding: 1 1;
    }

    Tree > .tree--cursor {
        background: $pi-selected-bg;
        color: white;
        text-style: bold;
    }

    Tree > .tree--guides {
        color: $pi-border-muted;
    }

    Footer {
        background: $pi-bg;
        color: $pi-muted;
    }

    Footer > .footer-key--key {
        background: $pi-bg;
        color: $pi-accent;
        text-style: bold;
    }

    Footer > .footer-key--description {
        background: $pi-bg;
        color: $pi-muted;
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
        self._first_tick = True
        self._last_labels: dict[tuple[str, str], str] = {}
        self._needs_full_rebuild = True
        self._latest_statuses: dict[str, tuple[Pane, PaneStatus]] = {}
        # The viewer session currently attached in the right tmux pane (or
        # None when the right pane is at its placeholder).
        self._active_viewer: str | None = None
        # Animation state: spinner frame counter.
        self._spinner_frame = 0

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
        self.set_interval(POLL_INTERVAL_S, self._tick)
        self.set_interval(SPINNER_INTERVAL_S, self._animate_working_rows)
        self._tick()

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
        pulse_color = _lerp_color(PI_SUCCESS_DIM, PI_SUCCESS, fraction)
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
                self.notifier.transition(
                    pane.target,
                    status.state,
                    title=f"pi · {pane.session}/{pane.title}",
                    body=Path(pane.cwd).name or pane.cwd,
                )

        self._latest_statuses = {p.pane_id: (p, s) for p, s in statuses}

        set_status_widget(fmt_status_widget([s for _, s in statuses]))
        self._update_chrome([s for _, s in statuses])
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

    def _update_chrome(self, all_statuses: list[PaneStatus]) -> None:
        counts: dict[AgentState, int] = {}
        for s in all_statuses:
            counts[s.state] = counts.get(s.state, 0) + 1

        total = sum(counts.values())
        mute_tag = "" if self.notifier.enabled else "  · muted"
        sort_tag = f"sort:{self.sort_mode}"
        self._title_bar.update(
            f"pi-monitor  ·  {total} pane{'s' if total != 1 else ''}  ·  {sort_tag}{mute_tag}"
        )

        attention_total = sum(
            counts.get(s, 0) for s in (AgentState.ERROR, AgentState.IDLE)
        )
        if attention_total == 0:
            self._attention_banner.add_class("hidden")
            self._attention_banner.update("")
            return

        parts: list[str] = []
        for state, label in (
            (AgentState.ERROR, "error"),
            (AgentState.IDLE, "idle"),
        ):
            n = counts.get(state, 0)
            if not n:
                continue
            color = STATE_COLORS[state]
            parts.append(f"[bold {color}]{n} {label}[/bold {color}]")
        msg = "  [dim]·[/dim]  ".join(parts)
        self._attention_banner.update(f"{msg}  [dim]· press 1–9 to jump[/dim]")
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
        new_label = NEW_SESSION_LABEL
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
        if target_data is None:
            return
        for sess_node in self._tree.root.children:
            if sess_node.data == target_data:
                self._tree.select_node(sess_node)
                return
            for leaf in sess_node.children:
                if leaf.data == target_data:
                    self._tree.select_node(leaf)
                    return

    # -- Tree event ---------------------------------------------------------

    def on_tree_node_selected(self, event) -> None:
        """Enter on a row.

        - on `[+] new session`: open the new-session modal
        - on a pane: borrow that agent into the right tmux pane. Cursor
          focus stays on the tree so the user can keep navigating; Tab
          hands the keyboard to the right pane when they're ready.
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
            entry = self._latest_statuses.get(node.data[1])
            if entry is None:
                return
            self._borrow_into_right_slot(entry[0])

    # -- Right slot management ---------------------------------------------

    def _borrow_into_right_slot(self, pane: Pane) -> None:
        """Make the right tmux pane show `pane` interactively, without
        moving the source pane. We:

        1. Ensure a session-group sister of `pane.session` exists.
        2. Set that viewer's current window+pane to `pane`'s coordinates.
        3. If the right slot was attached to a different viewer (i.e. a
           different source session), respawn it with `tmux attach` to the
           new viewer, then kill the old viewer.

        The 2-pane monitor split (tree on the left, agent on the right)
        stays as configured. Cursor focus stays on the tree so the user
        can keep navigating; Tab (`action_focus_right`) is the explicit
        handoff to the right pane when they're ready to type.
        """
        try:
            viewer = ensure_linked_viewer(pane.session)
            viewer_focus_pane(viewer, pane.window_index, pane.pane_index)

            if self._active_viewer != viewer:
                attach_right_slot_to_viewer(viewer)
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

        - cursor on `[+] new session` row → new tmux session
        - cursor on a session header / pane → split that session
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
            self._open_split()
            return
        # Defensive fallback for any unrecognized node kind.
        self._open_new_session()

    def _open_new_session(self) -> None:
        default_cwd = self._cursored_cwd() or os.path.expanduser("~")
        self.push_screen(
            NewPiScreen("session", default_cwd),
            self._handle_launch_result,
        )

    def _open_split(self) -> None:
        pane = self._cursored_pane_obj()
        if pane is None:
            # Shouldn't normally happen given the dispatcher above; safe fallback.
            self._open_new_session()
            return
        self._split_target = f"{pane.session}:{pane.window_index}"
        self.push_screen(
            NewPiScreen("split", pane.cwd),
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
                from .tmux import split_pi_pane

                target = getattr(self, "_split_target", None)
                if target is None:
                    self.notify(
                        "no split target tracked; cursor a pane and try again",
                        severity="error",
                        timeout=5,
                    )
                    return
                split_pi_pane(target, cwd)
                self.notify(
                    f"started pi in split on {target}",
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
