"""Textual TUI for pi-monitor.

Renders a tree of `<tmux session> → <pi pane>` rows with live status badges,
ticks every 500ms, updates the tmux status-line widget, fires desktop
notifications on transitions into attention states, and lets the user borrow
a selected pane into the monitor session's right slot.
"""

from __future__ import annotations

from pathlib import Path

from rich.markup import escape
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container
from textual.widgets import Footer, Static, Tree

from .notify import Notifier, load_config, save_config
from .state import AgentState, PaneRef, PaneStatus, StateResolver
from .tmux import (
    MONITOR_SESSION,
    Pane,
    TmuxError,
    borrow_pane,
    clear_status_widget,
    focus_right_slot,
    kill_monitor_session,
    list_panes,
    monitor_has_pi_panes,
    return_pane,
    set_status_widget,
    _tmux,
)

POLL_INTERVAL_S = 0.5

# Pi's `dark` theme color tokens (from
# pi-coding-agent/dist/modes/interactive/theme/dark.json). Used as Rich
# markup colors in the tree and as Textual CSS variables in the layout.
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

# Lower number = higher attention priority. Used by the "status" sort mode
# and by the status-line widget's badge order.
STATE_PRIORITY: dict[AgentState, int] = {
    AgentState.ERROR: 0,
    AgentState.STALLED: 1,
    AgentState.IDLE: 2,
    AgentState.UNKNOWN: 3,
    AgentState.WORKING: 4,
    AgentState.NO_PI: 5,
}


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


def fmt_row(pane: Pane, status: PaneStatus, borrowed: bool) -> str:
    """Rich markup string. Layout:  ` ●  Title  · cwd          state · idle`.

    All user-supplied text (title, cwd) is `rich.markup.escape`d to neutralize
    any literal `[` characters in pane titles / paths.
    """
    color = STATE_COLORS.get(status.state, "grey50")
    title = escape(pane.title or f"pane {pane.pane_index}")
    cwd = escape(Path(pane.cwd).name or pane.cwd)
    state_label = status.state.value
    idle = fmt_idle(status.idle_seconds)

    parts = [f"[{color}]●[/{color}]  {title}"]
    if cwd:
        parts.append(f"  [dim]· {cwd}[/dim]")
    parts.append(f"   [{color}]{state_label}[/{color}]")
    if idle:
        parts.append(f" [dim]· {idle}[/dim]")
    if borrowed:
        parts.append("  [bold cyan]→ right[/bold cyan]")
    return "".join(parts)


def fmt_session_header(session: str, statuses: list[PaneStatus]) -> str:
    """`Session  ●N ●M` (counts only for attention states)."""
    name = escape(session)
    badges: list[str] = []
    for state in (AgentState.ERROR, AgentState.STALLED, AgentState.IDLE):
        n = sum(1 for s in statuses if s.state == state)
        if n:
            color = STATE_COLORS[state]
            badges.append(f"[{color}]●{n}[/{color}]")
    suffix = f"  {' '.join(badges)}" if badges else ""
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
    """The pi-monitor TUI. Single screen: header + tree + footer."""

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
        border: round $pi-border-muted;
        border-title-color: $pi-accent;
        border-title-style: bold;
        border-title-align: left;
        background: $pi-card-bg;
        margin: 1 1 0 1;
        padding: 0;
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

    # Vim-style hjkl on top of arrow-key navigation:
    #   h - collapse current node, or jump to parent if already collapsed
    #   j - down (Tree binds arrows by default; we add j/k aliases)
    #   k - up
    #   l - expand current node, or step into first child if already expanded
    # Tab keeps its tmux-pane-focus job. `enter` -> TreeNodeSelected (below).
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
        Binding("q", "quit_monitor", "quit"),
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
        self._borrowed_pane_id: str | None = None
        self._borrowed_origin: Pane | None = None
        self._first_tick = True
        # Tracks the rendered label for each tree node so we can skip
        # `set_label` calls when nothing changed (avoids flicker).
        self._last_labels: dict[tuple[str, str], str] = {}
        # Forces the next render to fully rebuild instead of diffing.
        # Set on user-initiated changes that re-order nodes (sort, filter).
        self._needs_full_rebuild = True

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
        self._attention_banner: Static = self.query_one(
            "#attention-banner", Static
        )
        self._tree_wrap: Container = self.query_one("#tree-wrap", Container)
        self._tree_wrap.border_title = "Sessions"
        self._tree: Tree = self.query_one("#tree", Tree)
        self._tree.show_root = False
        self._tree.guide_depth = 2
        self._tree.focus()
        # Pipe Notifier transitions into the in-TUI toast.
        self.notifier.on_transition = self._on_transition
        self.set_interval(POLL_INTERVAL_S, self._tick)
        self._tick()

    def _on_transition(
        self,
        pane_id: str,
        state: AgentState,
        title: str,
        body: str,
    ) -> None:
        """Called by Notifier when a pane transitions into an attention state.
        Shows a Textual toast in the bottom-right of the monitor TUI."""
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

        # The monitor session itself never appears in the tree. Anything
        # currently borrowed will be parented in monitor:0.1; we still want
        # to show it in its origin position with a "borrowed" tag, so we
        # graft the borrowed pane back into its origin session below.
        visible = [p for p in all_panes if p.session != MONITOR_SESSION]
        if not self.show_non_pi:
            visible = [p for p in visible if p.is_pi]

        if self._borrowed_origin and self._borrowed_pane_id:
            origins = [p for p in visible if p.pane_id == self._borrowed_pane_id]
            if not origins:
                # The borrowed pane lives in monitor:0.1 right now. Splice
                # in our cached origin metadata so it shows in the right
                # session.
                visible.append(self._borrowed_origin)

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

        # Notifications: seed on first tick to avoid flooding with "idle".
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

        set_status_widget(fmt_status_widget([s for _, s in statuses]))
        self._update_chrome([s for _, s in statuses])
        self._render(statuses)

    def _update_chrome(self, all_statuses: list[PaneStatus]) -> None:
        """Refresh the title bar and the attention banner from current state."""
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
            parts.append(f"[{color}]● {n} {label}[/{color}]")
        msg = "  ·  ".join(parts)
        self._attention_banner.update(
            f"{msg}  [dim]· press 1–9 to jump[/dim]"
        )
        self._attention_banner.remove_class("hidden")

    def _render(self, statuses: list[tuple[Pane, PaneStatus]]) -> None:
        """Diff-based update: existing nodes get their labels updated in place;
        only added/removed panes touch the tree topology. Cursor and expand
        state survive naturally because we never remove the node we're on.
        Full rebuild only on `_needs_full_rebuild` (sort/filter changes).
        """
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
                borrowed = pane.pane_id == self._borrowed_pane_id
                label = fmt_row(pane, status, borrowed)
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
        # Index existing session nodes by name.
        sess_nodes: dict[str, object] = {}
        for child in self._tree.root.children:
            if child.data and child.data[0] == "session":
                sess_nodes[child.data[1]] = child

        # Drop sessions that no longer exist.
        live = set(desired_sessions)
        for name, node in list(sess_nodes.items()):
            if name not in live:
                node.remove()
                self._last_labels.pop(("session", name), None)
                del sess_nodes[name]

        # Add or update each session.
        for name in desired_sessions:
            items = by_session[name]
            header = fmt_session_header(name, [s for _, s in items])
            sess_key = ("session", name)

            if name not in sess_nodes:
                # New session: append. Order may be slightly off until next
                # full rebuild, which is rare and intentional.
                sess_node = self._tree.root.add(header, data=sess_key, expand=True)
                sess_nodes[name] = sess_node
                self._last_labels[sess_key] = header
                for pane, status in items:
                    borrowed = pane.pane_id == self._borrowed_pane_id
                    label = fmt_row(pane, status, borrowed)
                    pane_key = ("pane", pane.pane_id)
                    sess_node.add_leaf(label, data=pane_key)
                    self._last_labels[pane_key] = label
                continue

            sess_node = sess_nodes[name]
            if self._last_labels.get(sess_key) != header:
                sess_node.set_label(header)
                self._last_labels[sess_key] = header

            # Diff panes within the session.
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
                borrowed = pane.pane_id == self._borrowed_pane_id
                label = fmt_row(pane, status, borrowed)
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
        """Enter / mouse-click on a row. On a pane row, borrow it. On a
        session header, the tree's default toggles expansion (we no-op)."""
        node = event.node
        if not node.data or node.data[0] != "pane":
            return
        self._borrow(node.data[1])

    # -- Actions ------------------------------------------------------------

    def action_focus_right(self) -> None:
        try:
            focus_right_slot()
        except TmuxError:
            pass

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
        """Vim `h`: collapse the current node, or jump to its parent if it's
        already collapsed (or it's a leaf)."""
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
        """Vim `l`: expand the current node, or step into the first child if
        already expanded. No-op on a leaf with no children."""
        node = self._tree.cursor_node
        if node is None:
            return
        if node.allow_expand and not node.is_expanded:
            node.expand()
            return
        children = list(node.children)
        if children:
            self._tree.select_node(children[0])

    def action_quit_monitor(self) -> None:
        self._cleanup_and_exit()

    # -- Borrow / return ----------------------------------------------------

    def _borrow(self, source_pane_id: str) -> None:
        if source_pane_id == self._borrowed_pane_id:
            return
        # Find the pane object so we can cache its origin for return_pane.
        try:
            origin = next(p for p in list_panes() if p.pane_id == source_pane_id)
        except (StopIteration, TmuxError):
            return

        # Return any previously borrowed pane FIRST, before we kill the right
        # slot in borrow_pane. If the return fails, we must NOT proceed —
        # otherwise we'd kill a real pi pane.
        if self._borrowed_pane_id and self._borrowed_origin is not None:
            try:
                return_pane(self._borrowed_pane_id, self._borrowed_origin.session)
            except TmuxError as exc:
                self.notify(
                    f"refusing to swap: could not return previous pane: {exc}",
                    severity="error",
                    timeout=10,
                )
                return
            self._borrowed_pane_id = None
            self._borrowed_origin = None

        try:
            borrow_pane(source_pane_id)
        except TmuxError as exc:
            self.notify(f"borrow failed: {exc}", severity="error", timeout=10)
            return

        self._borrowed_pane_id = source_pane_id
        self._borrowed_origin = origin
        self._tick()

    def _cleanup_and_exit(self) -> None:
        # Step 1: try to return any borrowed pane to its origin.
        if self._borrowed_pane_id and self._borrowed_origin is not None:
            try:
                return_pane(self._borrowed_pane_id, self._borrowed_origin.session)
                self._borrowed_pane_id = None
                self._borrowed_origin = None
            except TmuxError as exc:
                # CRITICAL: do NOT kill the monitor session if the borrowed
                # pane is still parked there. Better to leave it alive so
                # the user can rescue manually than to silently destroy a
                # real pi process.
                self.notify(
                    f"could not return borrowed pane: {exc}\n"
                    "Leaving the monitor session alive so you can rescue "
                    "manually with `tmux move-pane` or by attaching.",
                    severity="error",
                    timeout=15,
                )
                self.exit()
                return

        # Step 2: even after the explicit return above succeeded, double-check
        # nothing pi-shaped is still parked in monitor (defense in depth).
        if monitor_has_pi_panes():
            self.notify(
                "Monitor session still contains a pi pane after cleanup. "
                "Leaving it alive; rescue manually with `tmux attach -t monitor`.",
                severity="error",
                timeout=15,
            )
            self.exit()
            return

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
