"""Textual TUI for pi-monitor.

Renders a tree of `<tmux session> → <pi pane>` rows with live status badges,
ticks every 500ms, updates the tmux status-line widget, fires desktop
notifications on transitions into attention states, and lets the user borrow
a selected pane into the monitor session's right slot.
"""

from __future__ import annotations

from pathlib import Path

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Footer, Header, Tree

from .notify import Notifier, load_config, save_config
from .state import AgentState, PaneStatus, StateResolver
from .tmux import (
    MONITOR_SESSION,
    Pane,
    TmuxError,
    borrow_pane,
    clear_status_widget,
    focus_right_slot,
    kill_monitor_session,
    list_panes,
    return_pane,
    set_status_widget,
    _tmux,
)

POLL_INTERVAL_S = 0.5

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
    glyph = STATE_GLYPHS.get(status.state, "•")
    title = pane.title or f"pane {pane.pane_index}"
    cwd = Path(pane.cwd).name or pane.cwd
    state_label = status.state.value
    parts = [glyph, title, f"[{cwd}]", state_label]
    idle = fmt_idle(status.idle_seconds)
    if idle:
        parts.append(idle)
    if borrowed:
        parts.append("· borrowed")
    return " ".join(parts)


def fmt_session_header(session: str, statuses: list[PaneStatus]) -> str:
    badges: list[str] = []
    for state in (AgentState.ERROR, AgentState.STALLED, AgentState.IDLE):
        n = sum(1 for s in statuses if s.state == state)
        if n:
            badges.append(f"{STATE_GLYPHS[state]}{n}")
    suffix = f"  ({' '.join(badges)})" if badges else ""
    return f"▾ {session}{suffix}"


def fmt_status_widget(statuses: list[PaneStatus]) -> str:
    counts: dict[AgentState, int] = {}
    for s in statuses:
        counts[s.state] = counts.get(s.state, 0) + 1
    parts: list[str] = []
    for state in (AgentState.ERROR, AgentState.IDLE, AgentState.STALLED, AgentState.WORKING):
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
    Tree {
        padding: 0 1;
    }
    """

    # Tree handles j/k/up/down/space natively; we add app-wide bindings on
    # top. `enter` becomes a TreeNodeSelected event we handle below.
    BINDINGS = [
        Binding("tab", "focus_right", "→agent"),
        Binding("l", "focus_right", "→agent", show=False),
        Binding("g", "go_top", "top", show=False),
        Binding("G", "go_bottom", "bottom", show=False),
        Binding("s", "cycle_sort", "sort"),
        Binding("H", "toggle_show_non_pi", "show non-pi", show=False),
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

    # -- Composition --------------------------------------------------------

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        yield Tree("pi-monitor", id="tree")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "pi-monitor"
        self._tree: Tree = self.query_one("#tree", Tree)
        self._tree.show_root = False
        self._tree.guide_depth = 2
        self._tree.focus()
        self.set_interval(POLL_INTERVAL_S, self._tick)
        self._tick()

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

        statuses: list[tuple[Pane, PaneStatus]] = []
        for pane in visible:
            status = self.resolver.status_for_pane(pane.target, pane.cwd, pane.is_pi)
            statuses.append((pane, status))

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
        self._render(statuses)

    def _render(self, statuses: list[tuple[Pane, PaneStatus]]) -> None:
        # Group by session, sort within session per current sort mode,
        # then sort sessions alphabetically (stable mental map).
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

        # Capture cursor + expansion state to restore after rebuild.
        prev_cursor = self._tree.cursor_node.data if self._tree.cursor_node else None
        expanded: dict[tuple, bool] = {}
        for child in list(self._tree.root.children):
            if child.data:
                expanded[child.data] = child.is_expanded

        self._tree.root.remove_children()
        for session in sorted(by_session.keys()):
            items = by_session[session]
            header = fmt_session_header(session, [s for _, s in items])
            session_node = self._tree.root.add(
                header, data=("session", session), expand=True
            )
            if expanded.get(("session", session), True) is False:
                session_node.collapse()
            for pane, status in items:
                borrowed = pane.pane_id == self._borrowed_pane_id
                label = fmt_row(pane, status, borrowed)
                session_node.add_leaf(label, data=("pane", pane.pane_id))

        self._restore_cursor(prev_cursor)

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
        self._tick()

    def action_toggle_show_non_pi(self) -> None:
        self.show_non_pi = not self.show_non_pi
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

    def action_quit_monitor(self) -> None:
        self._cleanup_and_exit()

    # -- Borrow / return ----------------------------------------------------

    def _borrow(self, source_pane_id: str) -> None:
        if source_pane_id == self._borrowed_pane_id:
            return
        # Find the pane object so we can cache its origin for re-rendering.
        try:
            origin = next(p for p in list_panes() if p.pane_id == source_pane_id)
        except (StopIteration, TmuxError):
            return

        if self._borrowed_pane_id:
            try:
                return_pane(self._borrowed_pane_id)
            except TmuxError:
                pass

        try:
            borrow_pane(source_pane_id)
        except TmuxError as exc:
            self.notify(f"borrow failed: {exc}", severity="error")
            return

        self._borrowed_pane_id = source_pane_id
        self._borrowed_origin = origin
        self._tick()

    def _cleanup_and_exit(self) -> None:
        if self._borrowed_pane_id:
            try:
                return_pane(self._borrowed_pane_id)
            except TmuxError:
                pass
            self._borrowed_pane_id = None
        clear_status_widget()
        # Hand the user's client to another existing session before we
        # kill the monitor session out from under them.
        try:
            other = next(
                p.session
                for p in list_panes()
                if p.session != MONITOR_SESSION
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
