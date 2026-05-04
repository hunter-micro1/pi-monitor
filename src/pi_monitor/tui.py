"""Textual TUI for pi-monitor.

Layout:
    ┌──────────────────────────────────────────────────────────┐
    │ title-bar (one line)                                     │
    │ attention-banner (auto-hides when nothing needs help)    │
    │ ╭─ Sessions ───╮  ╭─ <pane title> · model · cost ─────╮  │
    │ │ tree         │  │ preview-header                    │  │
    │ │              │  │ ─────────────────────────────────  │  │
    │ │              │  │ live capture-pane mirror of the   │  │
    │ │              │  │ cursored agent (ANSI-rendered)    │  │
    │ ╰──────────────╯  ╰───────────────────────────────────╯  │
    │ footer (key hints)                                       │
    └──────────────────────────────────────────────────────────┘

The right side is a pure Textual widget; we never `tmux join-pane` user
panes anywhere. To actually interact with the cursored agent the user
presses Tab — which `tmux switch-client`s them into the agent's pane
full-screen. Coming back is whatever they bound the launcher hotkey to
(typically `prefix + M` running `pi-monitor`).
"""

from __future__ import annotations

import os
from pathlib import Path

from rich.markup import escape
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Horizontal
from textual.screen import ModalScreen
from textual.widgets import Footer, Input, Static, Tree

from .notify import Notifier, load_config, save_config
from .state import (
    AgentState,
    InspectorReader,
    InspectorSnapshot,
    PaneRef,
    PaneStatus,
    StateResolver,
)
from .tmux import (
    MONITOR_SESSION,
    Pane,
    TmuxError,
    capture_pane,
    clear_status_widget,
    kill_monitor_session,
    list_panes,
    set_status_widget,
    switch_client_to_pane,
    _tmux,
)

POLL_INTERVAL_S = 0.5

# Pi's `dark` theme color tokens, from
# pi-coding-agent/dist/modes/interactive/theme/dark.json. Used as Rich
# markup colors and as Textual CSS variables in the layout.
PI_ACCENT = "#8abeb7"  # teal
PI_SUCCESS = "#b5bd68"  # green
PI_ERROR = "#cc6666"  # red
PI_WARNING = "#ffff00"  # yellow
PI_MUTED = "#808080"
PI_DIM = "#666666"

# Per-state colors used inside Rich markup strings in the tree.
STATE_COLORS: dict[AgentState, str] = {
    AgentState.IDLE: PI_ERROR,
    AgentState.WORKING: PI_SUCCESS,
    AgentState.STALLED: PI_WARNING,
    AgentState.ERROR: "bright_red",
    AgentState.UNKNOWN: PI_DIM,
    AgentState.NO_PI: "#505050",
}

# Severity passed to Textual's in-TUI toast on transitions.
STATE_TOAST_SEVERITY: dict[AgentState, str] = {
    AgentState.IDLE: "warning",
    AgentState.STALLED: "warning",
    AgentState.ERROR: "error",
}

# Used only by the tmux status-line widget; emoji are dependable in tmux.
STATE_GLYPHS: dict[AgentState, str] = {
    AgentState.IDLE: "🔴",
    AgentState.WORKING: "🟢",
    AgentState.STALLED: "🟡",
    AgentState.ERROR: "❌",
    AgentState.UNKNOWN: "❓",
    AgentState.NO_PI: "⚫",
}

# Width to which we pad state labels in the tree. Determined by the longest
# state word + a one-space gutter. Keeps the title column aligned across rows.
STATE_LABEL_WIDTH = 8  # "stalled ", "working ", "idle    ", etc.

# Lower number = higher attention priority.
STATE_PRIORITY: dict[AgentState, int] = {
    AgentState.ERROR: 0,
    AgentState.STALLED: 1,
    AgentState.IDLE: 2,
    AgentState.UNKNOWN: 3,
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
  [#8abeb7]Enter[/#8abeb7] / [#8abeb7]Tab[/#8abeb7]   switch tmux client to the cursored
                  agent (full-screen). Re-launch
                  pi-monitor (e.g. [#8abeb7]prefix+M[/#8abeb7]) to come back.

[bold]Spawn[/bold]
  [#8abeb7]o[/#8abeb7]          launch pi in a new tmux session
  [#8abeb7]Shift+O[/#8abeb7]    split the cursored session, launch pi

[bold]View[/bold]
  [#8abeb7]s[/#8abeb7]          cycle sort: tmux ↔ needs-attention-first
  [#8abeb7]Shift+H[/#8abeb7]    toggle showing non-pi panes
  [#8abeb7]r[/#8abeb7]          force refresh

[bold]Notifications[/bold]
  [#8abeb7]m[/#8abeb7]          mute / unmute (desktop + in-app toasts)

[bold]Exit[/bold]
  [#8abeb7]q[/#8abeb7]          kill monitor session
  [#8abeb7]?[/#8abeb7]          toggle this help

[dim]press any key to dismiss[/dim]
"""


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.0f}k"
    return str(n)


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
            extra = (
                f"  [dim]+{len(matches) - 6} more[/dim]"
                if len(matches) > 6
                else ""
            )
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
            full = "~" + full[len(home):]
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


def fmt_row(pane: Pane, status: PaneStatus) -> str:
    """Rich markup string for a tree leaf.

    Layout:  `<state>  Title  · cwd  · idle`

    No leading glyph. State word is colored + bold + fixed-width so the
    title column always lines up. Reads like `gh pr list` or `kubectl get
    pods` output — typography does the work, not iconography.
    """
    color = STATE_COLORS.get(status.state, "grey50")
    state_label = status.state.value.ljust(STATE_LABEL_WIDTH)
    title = escape(pane.title or f"pane {pane.pane_index}")
    cwd = escape(Path(pane.cwd).name or pane.cwd)
    idle = fmt_idle(status.idle_seconds)

    parts = [f"[bold {color}]{state_label}[/bold {color}] {title}"]
    if cwd:
        parts.append(f"  [dim]· {cwd}[/dim]")
    if idle:
        parts.append(f"  [dim]· {idle}[/dim]")
    return "".join(parts)


def fmt_session_header(session: str, statuses: list[PaneStatus]) -> str:
    """`Session       1 stalled · 1 idle` (counts only for attention states).

    No glyphs; colored count text on the right.
    """
    name = escape(session)
    counts: list[str] = []
    for state in (AgentState.ERROR, AgentState.STALLED, AgentState.IDLE):
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
        AgentState.STALLED,
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

    Single-screen layout: title-bar, attention-banner, horizontal split of
    tree (left, fixed-width) + preview (right, flexible), footer.
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

    #main-row {
        layout: horizontal;
        height: 1fr;
        width: 100%;
    }

    #tree-wrap {
        width: 38;
        border: round $pi-border-muted;
        border-title-color: $pi-accent;
        border-title-style: bold;
        border-title-align: left;
        background: $pi-card-bg;
        margin: 1 0 0 1;
        padding: 0;
    }

    #preview-wrap {
        width: 1fr;
        border: round $pi-border-muted;
        border-title-color: $pi-accent;
        border-title-style: bold;
        border-title-align: left;
        background: $pi-card-bg;
        margin: 1 1 0 1;
        padding: 0;
    }

    #preview-header {
        height: 3;
        padding: 0 1;
        background: $pi-card-bg;
        color: white;
    }

    #preview-body {
        background: $pi-card-bg;
        color: white;
        padding: 0 1;
        width: 100%;
        height: 1fr;
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
        Binding("tab", "interact", "→agent"),
        Binding("g", "go_top", "top", show=False),
        Binding("G", "go_bottom", "bottom", show=False),
        Binding("s", "cycle_sort", "sort"),
        Binding("shift+h", "toggle_show_non_pi", "show non-pi", show=False),
        Binding("r", "refresh_now", "refresh", show=False),
        Binding("m", "toggle_mute", "mute"),
        Binding("o", "new_session", "new"),
        Binding("O", "split_pane", "split", show=False),
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
        self.inspector_reader = InspectorReader()
        self.show_non_pi = False
        self.sort_mode = self.config.get("sort_mode", "tmux")
        self._first_tick = True
        self._last_labels: dict[tuple[str, str], str] = {}
        self._needs_full_rebuild = True
        self._latest_statuses: dict[str, tuple[Pane, PaneStatus]] = {}
        # Last preview content cached so we skip redraws when nothing changed.
        self._last_preview_target: str | None = None
        self._last_preview_capture: str = ""

    # -- Composition --------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Static("pi-monitor", id="title-bar")
        yield Static("", id="attention-banner", classes="hidden")
        with Horizontal(id="main-row"):
            with Container(id="tree-wrap"):
                yield Tree("Sessions", id="tree")
            with Container(id="preview-wrap"):
                yield Static("", id="preview-header")
                yield Static("", id="preview-body")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "pi-monitor"
        self._title_bar: Static = self.query_one("#title-bar", Static)
        self._attention_banner: Static = self.query_one("#attention-banner", Static)
        self._tree_wrap: Container = self.query_one("#tree-wrap", Container)
        self._tree_wrap.border_title = "Sessions"
        self._preview_wrap: Container = self.query_one("#preview-wrap", Container)
        self._preview_wrap.border_title = "Preview"
        self._preview_header: Static = self.query_one("#preview-header", Static)
        self._preview_body: Static = self.query_one("#preview-body", Static)
        self._tree: Tree = self.query_one("#tree", Tree)
        self._tree.show_root = False
        self._tree.guide_depth = 2
        self._tree.focus()
        self.notifier.on_transition = self._on_transition
        self.set_interval(POLL_INTERVAL_S, self._tick)
        self._tick()
        self._refresh_preview()

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

        visible = [p for p in all_panes if p.session != MONITOR_SESSION]
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
        self._refresh_preview()

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
            counts.get(s, 0)
            for s in (AgentState.ERROR, AgentState.STALLED, AgentState.IDLE)
        )
        if attention_total == 0:
            self._attention_banner.add_class("hidden")
            self._attention_banner.update("")
            return

        parts: list[str] = []
        for state, label in (
            (AgentState.ERROR, "error"),
            (AgentState.STALLED, "stalled"),
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
        for session in desired_sessions:
            items = by_session[session]
            header = fmt_session_header(session, [s for _, s in items])
            sess_key = ("session", session)
            sess_node = self._tree.root.add(header, data=sess_key, expand=True)
            self._last_labels[sess_key] = header
            if expanded.get(sess_key, True) is False:
                sess_node.collapse()
            for pane, status in items:
                label = fmt_row(pane, status)
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

        for name in desired_sessions:
            items = by_session[name]
            header = fmt_session_header(name, [s for _, s in items])
            sess_key = ("session", name)

            if name not in sess_nodes:
                sess_node = self._tree.root.add(header, data=sess_key, expand=True)
                sess_nodes[name] = sess_node
                self._last_labels[sess_key] = header
                for pane, status in items:
                    label = fmt_row(pane, status)
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
                label = fmt_row(pane, status)
                pane_key = ("pane", pane.pane_id)
                if pane.pane_id in pane_nodes:
                    if self._last_labels.get(pane_key) != label:
                        pane_nodes[pane.pane_id].set_label(label)
                        self._last_labels[pane_key] = label
                else:
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
        """Enter on a pane row: switch tmux client to that pane (full-screen)."""
        node = event.node
        if not node.data or node.data[0] != "pane":
            return
        self._jump_to_pane(node.data[1])

    def on_tree_node_highlighted(self, event) -> None:
        """Cursor moved; refresh the preview for the new selection."""
        self._refresh_preview()

    # -- Preview ------------------------------------------------------------

    def _refresh_preview(self) -> None:
        if not hasattr(self, "_preview_body"):
            return
        node = self._tree.cursor_node if hasattr(self, "_tree") else None
        if node is None or not node.data:
            self._render_preview_placeholder("Cursor a pane to preview its agent.")
            return
        kind, key = node.data
        if kind == "session":
            sess_panes = [
                (p, s) for p, s in self._latest_statuses.values() if p.session == key
            ]
            self._render_preview_session(key, sess_panes)
            return
        if kind == "pane":
            entry = self._latest_statuses.get(key)
            if entry is None:
                self._render_preview_placeholder(f"No data for pane {escape(str(key))}")
                return
            pane, status = entry
            self._render_preview_pane(pane, status)

    def _render_preview_placeholder(self, msg: str) -> None:
        self._preview_wrap.border_title = "Preview"
        self._preview_header.update("")
        self._preview_body.update(f"[dim]{msg}[/dim]")
        self._last_preview_target = None
        self._last_preview_capture = ""

    def _render_preview_session(
        self, session_name: str, panes: list[tuple[Pane, PaneStatus]]
    ) -> None:
        self._preview_wrap.border_title = f"Preview · {escape(session_name)}"
        if not panes:
            self._preview_header.update("")
            self._preview_body.update(
                f"[dim]Session {escape(session_name)} has no visible panes.[/dim]"
            )
            return

        counts: dict[AgentState, int] = {}
        for _, s in panes:
            counts[s.state] = counts.get(s.state, 0) + 1

        header_line = f"[bold {PI_ACCENT}]{escape(session_name)}[/bold {PI_ACCENT}]"
        sub_parts = [f"{len(panes)} panes"]
        for state in (
            AgentState.ERROR,
            AgentState.STALLED,
            AgentState.IDLE,
            AgentState.WORKING,
        ):
            n = counts.get(state, 0)
            if n:
                color = STATE_COLORS[state]
                sub_parts.append(f"[{color}]{n} {state.value}[/{color}]")
        self._preview_header.update(
            f"{header_line}\n[dim]{'  ·  '.join(sub_parts)}[/dim]"
        )
        self._preview_body.update(
            "[dim]Select a pane to see its live agent screen.[/dim]"
        )
        self._last_preview_target = None
        self._last_preview_capture = ""

    def _render_preview_pane(self, pane: Pane, status: PaneStatus) -> None:
        # Header: title + tmux address + state · model · cost · tool
        title = escape(pane.title or f"pane {pane.pane_index}")
        color = STATE_COLORS.get(status.state, PI_DIM)
        state_seg = f"[bold {color}]{status.state.value}[/bold {color}]"
        idle = fmt_idle(status.idle_seconds)

        snap: InspectorSnapshot | None = (
            self.inspector_reader.read(status.session_file)
            if status.session_file
            else None
        )

        meta_parts = [state_seg]
        if idle:
            meta_parts.append(f"[dim]{idle}[/dim]")
        if snap and snap.model:
            meta_parts.append(f"[dim]·[/dim] [dim]{escape(snap.model)}[/dim]")
        if snap and snap.cumulative_cost:
            meta_parts.append(f"[dim]·[/dim] [bold]${snap.cumulative_cost:.2f}[/bold]")
        if snap and (snap.cumulative_input or snap.cumulative_output):
            meta_parts.append(
                f"[dim]·[/dim] [dim]{_fmt_tokens(snap.cumulative_input)} / "
                f"{_fmt_tokens(snap.cumulative_output)} tokens[/dim]"
            )
        if snap and snap.current_tool:
            meta_parts.append(
                f"[dim]·[/dim] [{PI_ACCENT}]{escape(snap.current_tool)}[/{PI_ACCENT}] running"
            )

        line1 = f"[bold {PI_ACCENT}]{title}[/bold {PI_ACCENT}]  [dim]· {escape(pane.target)}[/dim]"
        line2 = "  ".join(meta_parts)
        self._preview_wrap.border_title = (
            f"Preview · {escape(pane.title or pane.target)}"
        )
        self._preview_header.update(f"{line1}\n{line2}")

        # Body: live capture-pane mirror.
        try:
            captured = capture_pane(pane.target)
        except TmuxError:
            self._preview_body.update("[dim](could not capture pane)[/dim]")
            self._last_preview_target = pane.target
            self._last_preview_capture = ""
            return

        # Skip the redraw if nothing changed since last tick (cheap).
        if (
            self._last_preview_target == pane.target
            and captured == self._last_preview_capture
        ):
            return
        self._last_preview_target = pane.target
        self._last_preview_capture = captured

        # Strip trailing blank lines for a tighter visual.
        body_text = captured.rstrip()
        if not body_text:
            self._preview_body.update("[dim](empty pane)[/dim]")
            return
        self._preview_body.update(Text.from_ansi(body_text))

    # -- Actions ------------------------------------------------------------

    def action_interact(self) -> None:
        """Tab: switch tmux client to the cursored pane (full-screen)."""
        node = self._tree.cursor_node
        if node is None or not node.data:
            return
        kind, key = node.data
        if kind != "pane":
            return
        self._jump_to_pane(key)

    def _jump_to_pane(self, pane_id: str) -> None:
        entry = self._latest_statuses.get(pane_id)
        if entry is None:
            return
        pane, _ = entry
        try:
            switch_client_to_pane(pane)
        except TmuxError as exc:
            self.notify(f"could not switch: {exc}", severity="error", timeout=8)

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

    def action_new_session(self) -> None:
        """`o`: prompt for a directory and launch a new tmux session running pi."""
        default_cwd = self._cursored_cwd() or os.path.expanduser("~")
        self.push_screen(
            NewPiScreen("session", default_cwd),
            self._handle_launch_result,
        )

    def action_split_pane(self) -> None:
        """`O`: prompt for a directory and split the cursored session's window."""
        pane = self._cursored_pane_obj()
        if pane is None:
            self.notify(
                "cursor a session or pane to choose where to split",
                severity="warning",
                timeout=5,
            )
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
        # Hand the user's client to another existing session before we
        # kill the monitor session out from under them.
        try:
            other = next(
                p.session for p in list_panes() if p.session != MONITOR_SESSION
            )
            _tmux("switch-client", "-t", other)
        except (StopIteration, TmuxError):
            pass
        try:
            kill_monitor_session()
        except TmuxError:
            pass
        self.exit()


def run() -> int:
    PiMonitorApp().run()
    return 0
