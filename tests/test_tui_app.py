"""App-level smoke tests for the TUI.

Drives the live `PiMonitorApp` via Textual's headless `run_test()` Pilot
so we can exercise the cursor model, selection class toggling, and
mount/unmount diff against synthetic pane data \u2014 the parts of the render
path the pure-function tests in `test_tui_render.py` can't reach.

Async test bodies use `asyncio.run()` so we don't need to add
pytest-asyncio as a dev dep.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from unittest.mock import patch

from pi_monitor.state import AgentState, JsonlSnapshot, PaneStatus
from pi_monitor.tmux import Pane
from pi_monitor.tui import PaneRow, PiMonitorApp, SessionGroup


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------


def _pane(pane_id: str, session: str, title: str, *, cwd: str = "/tmp/x") -> Pane:
    """Build a synthetic Pane shaped like what tmux.list_panes returns.
    Keeping the shared bits as defaults so each test only specifies what
    matters to it."""
    # The window/pane indices are arbitrary; the cursor model only sorts
    # within a session by them, so we vary by pane_id alphabetically and
    # let the index follow.
    idx = sum(ord(c) for c in pane_id) % 10
    return Pane(
        pane_id=pane_id,
        target=f"{session}:{idx}.0",
        session=session,
        window_index=idx,
        pane_index=0,
        pid=1000 + idx,
        cwd=cwd,
        title=title,
        command="pi",
    )


def _status(
    pane_id: str,
    state: AgentState,
    *,
    idle: float = 0.0,
    phase: str | None = None,
    tool: str | None = None,
    preview: str | None = None,
    error: str | None = None,
) -> PaneStatus:
    snap: JsonlSnapshot | None = None
    if preview is not None or error is not None:
        snap = JsonlSnapshot(
            mtime=0.0, last_assistant_preview=preview, last_error=error
        )
    return PaneStatus(
        pane_id=pane_id,
        state=state,
        idle_seconds=idle,
        phase=phase,
        current_tool=tool,
        snapshot=snap,
    )


@contextmanager
def _stub_world(panes: list[Pane], statuses: dict[str, PaneStatus]):
    """Patch out every external dependency of `_tick` so the App can run
    in-process without touching tmux, the filesystem, or git. Yields once
    inside the `with` block."""

    def fake_resolve(self, refs):
        # The resolver normally does a lot of work; in tests we just hand
        # back the canned PaneStatus per ref.
        return {r.pane_id: statuses[r.pane_id] for r in refs}

    with patch("pi_monitor.tui.list_panes", return_value=panes), \
         patch("pi_monitor.state.StateResolver.resolve", fake_resolve), \
         patch("pi_monitor.tui.set_status_widget"), \
         patch("pi_monitor.tui.is_viewer_session", return_value=False), \
         patch("pi_monitor.tui.ensure_linked_viewer", return_value="viewer-x"), \
         patch("pi_monitor.tui.viewer_focus_pane"), \
         patch("pi_monitor.tui.viewer_zoom_to_pane"), \
         patch("pi_monitor.tui.attach_right_slot_to_viewer"), \
         patch("pi_monitor.tui.kill_linked_viewer"), \
         patch("pi_monitor.tui.reset_right_slot_to_placeholder"), \
         patch("pi_monitor.tui.cleanup_orphan_viewers"), \
         patch("pi_monitor.tui.kill_monitor_session"), \
         patch("pi_monitor.tui.branch_for_cwd", return_value="main"):
        yield


# ---------------------------------------------------------------------------
# Empty state
# ---------------------------------------------------------------------------


def test_empty_state_renders_welcome():
    """With zero pi panes, the centered welcome block surfaces the brand
    line and both keybinding hints."""

    async def go():
        app = PiMonitorApp()
        with _stub_world([], {}):
            async with app.run_test() as pilot:
                await pilot.pause()
                rendered = str(app._empty_hint.render())
                assert "No pi sessions yet" in rendered
                assert "Press" in rendered
                # The action keys are highlighted; both should appear.
                assert "o" in rendered
                assert "?" in rendered
                assert not app._empty_hint.has_class("hidden")

    asyncio.run(go())


def test_empty_state_title_bar_is_quiet():
    """When the welcome block carries the call-to-action, the title bar
    should stay just the brand."""

    async def go():
        app = PiMonitorApp()
        with _stub_world([], {}):
            async with app.run_test() as pilot:
                await pilot.pause()
                rendered = str(app._title_bar.render())
                assert "pi-monitor" in rendered
                assert "no pi sessions yet" not in rendered.lower()

    asyncio.run(go())


def test_empty_state_cursor_is_on_affordance():
    """With nothing to navigate to, the cursor should sit on the
    `+ new session` affordance and be visibly selected."""

    async def go():
        app = PiMonitorApp()
        with _stub_world([], {}):
            async with app.run_test() as pilot:
                await pilot.pause()
                assert app._current_position() == ("new",)
                assert app._new_session_row.has_class("selected")

    asyncio.run(go())


# ---------------------------------------------------------------------------
# Populated state: cursor model + selection
# ---------------------------------------------------------------------------


def _two_session_world():
    """Two sessions (alphabetically: cape, contracts), 3 panes total.
    Same shape as the screenshot fixture I've been using by hand."""
    panes = [
        _pane("%4", "cape", "ANALYST", cwd="/y"),
        _pane("%5", "cape", "PC", cwd="/y"),
        _pane("%1", "contracts", "PSP7-gateway", cwd="/x"),
    ]
    statuses = {
        "cape:1.0": _status("cape:1.0", AgentState.ERROR, idle=12.0, error="oops"),
        "cape:0.0": _status(
            "cape:0.0", AgentState.WORKING, phase="agent_running"
        ),
        "contracts:5.0": _status(
            "contracts:5.0", AgentState.WORKING, phase="tool_running", tool="bash"
        ),
    }
    # Tmux pane targets are derived from session+window_index in _pane;
    # rebuild them so the resolver maps cleanly. Simpler: rebuild here.
    statuses = {p.target: statuses[list(statuses)[i]] for i, p in enumerate(panes)}
    return panes, statuses


def test_initial_cursor_lands_on_first_pane():
    """With panes present, the cursor should skip past the affordance and
    land on the first pane row \u2014 power users land on a real row after
    the first tick."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                pos = app._current_position()
                assert pos is not None
                assert pos[0] == "pane"

    asyncio.run(go())


def test_j_advances_cursor():
    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                first = app._cursor_idx
                await pilot.press("j")
                await pilot.pause()
                assert app._cursor_idx == first + 1

    asyncio.run(go())


def test_k_retreats_cursor():
    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                await pilot.press("j")
                await pilot.press("j")
                await pilot.pause()
                idx_after_jj = app._cursor_idx
                await pilot.press("k")
                await pilot.pause()
                assert app._cursor_idx == idx_after_jj - 1

    asyncio.run(go())


def test_cursor_clamps_at_bounds():
    """j past the end and k before the start should be no-ops, not
    wraparound or off-by-one errors."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                # Hammer down past the end.
                for _ in range(20):
                    await pilot.press("j")
                await pilot.pause()
                end = app._cursor_idx
                assert end == len(app._cursor_positions) - 1
                # Hammer up past the start.
                for _ in range(20):
                    await pilot.press("k")
                await pilot.pause()
                assert app._cursor_idx == 0

    asyncio.run(go())


def test_selected_class_only_on_cursored_row():
    """Exactly one PaneRow has `.selected` at any time."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                selected = [r for r in app._rows.values() if r.has_class("selected")]
                assert len(selected) == 1
                # And its pane_id matches the cursor's position.
                pos = app._current_position()
                assert pos is not None and pos[0] == "pane"
                assert selected[0].pane_id == pos[1]

    asyncio.run(go())


def test_active_group_class_tracks_cursor():
    """Exactly one SessionGroup has `.active-group`, and it's the one
    containing the cursored pane row."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                # j until we land in 'contracts'; first pane is in cape.
                while True:
                    pos = app._current_position()
                    entry = app._latest_statuses.get(pos[1]) if pos and pos[0] == "pane" else None
                    if entry is not None and entry[0].session == "contracts":
                        break
                    await pilot.press("j")
                    await pilot.pause()
                actives = [
                    n for n, g in app._groups.items() if g.has_class("active-group")
                ]
                assert actives == ["contracts"]

    asyncio.run(go())


# ---------------------------------------------------------------------------
# Render-path: cards + rows mount in the right shape
# ---------------------------------------------------------------------------


def test_session_groups_mount_alphabetically():
    """Cards land in alphabetical session-name order so the layout is
    deterministic across launches."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                names = [
                    c.session
                    for c in app._session_list.children
                    if isinstance(c, SessionGroup)
                ]
                assert names == sorted(names)
                assert names == ["cape", "contracts"]

    asyncio.run(go())


def test_pane_row_carries_three_text_children():
    """Every PaneRow has #row-top (with #row-main + #row-tag inside) and
    #row-activity, in that order. Header-first child order is the bit
    that broke during an earlier rewrite when compose() raced against
    explicit mounts; this test pins it down."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                row = next(iter(app._rows.values()))
                child_ids = [c.id for c in row.children]
                # Top half (a Container) is mounted first, activity line second.
                assert child_ids == ["row-top", "row-activity"]
                # The top container holds main + tag in left-to-right order.
                top = row.children[0]
                inner_ids = [c.id for c in top.children]
                assert inner_ids == ["row-main", "row-tag"]

    asyncio.run(go())


def test_session_card_header_appears_before_rows():
    """Diagnostic regression: an earlier rewrite mounted the session
    border-title-via-Static *after* the rows because of compose timing,
    leaving it visually below the rows. Now we set it as `border_title`
    on the SessionGroup itself, but pin the invariant just in case
    someone re-introduces a header child."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                cape = app._groups["cape"]
                # The card uses border_title (no header child Static) for
                # the session name. Children must be PaneRows only.
                assert all(isinstance(c, PaneRow) for c in cape.children)
                assert "cape" in str(cape.border_title)

    asyncio.run(go())


def test_activity_description_renders_in_row_activity():
    """The dim second line of each row should pick up the activity text
    from heartbeat/snapshot \u2014 the whole point of the two-line layout."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                # Find the row for cape's WORKING+tool_running pane (PC) and
                # check its activity Static says 'executing bash'.
                for pane_id, row in app._rows.items():
                    entry = app._latest_statuses.get(pane_id)
                    if entry is None:
                        continue
                    pane, status = entry
                    if (
                        status.phase == "tool_running"
                        and status.current_tool == "bash"
                    ):
                        assert "executing bash" in str(row._activity.render())
                        return
                raise AssertionError("no tool_running+bash row found in fixture")

    asyncio.run(go())


# ---------------------------------------------------------------------------
# Jump (1-9)
# ---------------------------------------------------------------------------


def test_jump_to_nth_pane_skips_affordance():
    """Pressing `1` lands on the first PANE (not the affordance), `2`
    on the second, etc."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                await pilot.press("1")
                await pilot.pause()
                pos = app._current_position()
                assert pos is not None and pos[0] == "pane"
                # First pane in display order is cape's first pane.
                first_pane_id = pos[1]
                # Jump to '2' to confirm it's a different pane.
                await pilot.press("2")
                await pilot.pause()
                second = app._current_position()
                assert second is not None and second[0] == "pane"
                assert second[1] != first_pane_id

    asyncio.run(go())


def test_jump_out_of_range_is_noop():
    """Jumping to a number bigger than the pane count should leave the
    cursor where it is, not crash, not wrap."""

    async def go():
        panes, statuses = _two_session_world()
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                await pilot.press("1")
                await pilot.pause()
                before = app._cursor_idx
                # Fixture has 3 panes; press 9 should be a no-op.
                await pilot.press("9")
                await pilot.pause()
                assert app._cursor_idx == before

    asyncio.run(go())
