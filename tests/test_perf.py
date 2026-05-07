"""Performance smoke tests.

These aren't fine-grained benchmarks \u2014 they pin down a generous
upper-bound wall-clock for the render pipeline at the load levels real
users hit (a couple dozen agents) and a stress level (100 panes across
20 sessions). The goal is to catch accidental O(N\u00b2) regressions in the
diff path or the selection toggling, not to optimize down to the
millisecond.

Thresholds are intentionally loose so the suite stays green on slow CI
runners while still flagging anything that goes truly off the rails (a
linear loop turning quadratic, or a mount-storm thrashing every tick).
"""

from __future__ import annotations

import asyncio
import time
from contextlib import contextmanager
from unittest.mock import patch

from pi_monitor.state import AgentState, JsonlSnapshot, PaneStatus
from pi_monitor.tmux import Pane
from pi_monitor.tui import PiMonitorApp


# ---------------------------------------------------------------------------
# Fixture: synthetic pane fleets
# ---------------------------------------------------------------------------


def _build_fleet(
    n_sessions: int,
    panes_per_session: int,
) -> tuple[list[Pane], dict[str, PaneStatus]]:
    """Return (panes, statuses) for `n_sessions * panes_per_session` panes,
    spread across distinct cwds so the resolver groups them naturally.

    States rotate through WORKING / IDLE / ERROR / WAITING so the render
    path exercises every state-color branch in the activity tag and
    every snapshot/heartbeat permutation.
    """
    panes: list[Pane] = []
    statuses: dict[str, PaneStatus] = {}
    rotation = [
        ("working_compacting", AgentState.WORKING, "compacting", None),
        ("working_tool", AgentState.WORKING, "tool_running", "bash"),
        ("working_thinking", AgentState.WORKING, "agent_running", None),
        ("idle", AgentState.IDLE, None, None),
        ("error", AgentState.ERROR, None, None),
        ("waiting", AgentState.WAITING, "awaiting_permission", None),
        ("retrying", AgentState.RETRYING, "retrying", None),
    ]
    counter = 0
    for s in range(n_sessions):
        session_name = f"sess{s:02d}"
        cwd = f"/tmp/sess{s:02d}"
        for w in range(panes_per_session):
            counter += 1
            pane_id = f"%{counter}"
            target = f"{session_name}:{w}.0"
            tag, state, phase, tool = rotation[counter % len(rotation)]
            panes.append(
                Pane(
                    pane_id=pane_id,
                    target=target,
                    session=session_name,
                    window_index=w,
                    pane_index=0,
                    pid=10000 + counter,
                    cwd=cwd,
                    title=f"agent{counter}-{tag}",
                    command="pi",
                )
            )
            statuses[target] = PaneStatus(
                pane_id=target,
                state=state,
                idle_seconds=12.0 if state != AgentState.WORKING else 0.0,
                phase=phase,
                current_tool=tool,
                snapshot=JsonlSnapshot(
                    mtime=0.0,
                    last_assistant_preview=f"agent {counter} last said something",
                    last_error="ECONNRESET" if state == AgentState.ERROR else None,
                ),
            )
    return panes, statuses


@contextmanager
def _stub_world(panes, statuses):
    def fake_resolve(self, refs):
        return {r.pane_id: statuses[r.pane_id] for r in refs}

    with (
        patch("pi_monitor.tui.list_panes", return_value=panes),
        patch("pi_monitor.state.StateResolver.resolve", fake_resolve),
        patch("pi_monitor.tui.set_status_widget"),
        patch("pi_monitor.tui.is_viewer_session", return_value=False),
        patch("pi_monitor.tui.ensure_linked_viewer", return_value="viewer-x"),
        patch("pi_monitor.tui.viewer_focus_pane"),
        patch("pi_monitor.tui.viewer_zoom_to_pane"),
        patch("pi_monitor.tui.attach_right_slot_to_viewer"),
        patch("pi_monitor.tui.kill_linked_viewer"),
        patch("pi_monitor.tui.reset_right_slot_to_placeholder"),
        patch("pi_monitor.tui.cleanup_orphan_viewers"),
        patch("pi_monitor.tui.kill_monitor_session"),
        patch("pi_monitor.tui.branch_for_cwd", return_value="main"),
    ):
        yield


# ---------------------------------------------------------------------------
# Tick wall-clock budgets
# ---------------------------------------------------------------------------

# Per-tick wall-clock ceiling. Generous — slow CI runners under heavy
# concurrency can spike a few hundred ms per asyncio.pause cycle. The
# point is to catch regressions where one of the inner loops turns
# accidentally quadratic, not to enforce sub-100ms responsiveness.
TICK_BUDGET_S = 1.5

# How many real ticks to drive after the initial mount. We exclude the
# first tick from per-tick assertions because it pays for the mount
# storm; we measure it separately with its own (looser) budget.
STEADY_STATE_TICKS = 4
INITIAL_TICK_BUDGET_S = 4.0


def _drive_ticks(app: PiMonitorApp, n: int) -> list[float]:
    """Force `n` synchronous _tick() calls back-to-back (skipping the
    set_interval scheduler) and return per-call wall-clock timings."""
    timings: list[float] = []
    for _ in range(n):
        t0 = time.monotonic()
        app._tick()
        timings.append(time.monotonic() - t0)
    return timings


def _capture_initial(app: PiMonitorApp) -> float:
    """Return seconds spent in the on_mount + first _tick path."""
    t0 = time.monotonic()
    # on_mount calls _tick once; the App is constructed by run_test()
    # before we get the pilot, so the first _tick has already happened
    # by the time pilot.pause() returns. We measure a re-tick here
    # which is the closest stand-in for "render this fleet from scratch
    # on a freshly-mounted App" within the run_test harness.
    app._tick()
    return time.monotonic() - t0


# ---------------------------------------------------------------------------
# Steady-state load (typical user)
# ---------------------------------------------------------------------------


def test_render_path_handles_typical_load_in_budget():
    """A realistic user has 5\u201310 sessions with 2\u20133 panes each; 8 sessions
    \u00d7 3 panes = 24 panes is a comfortable steady-state target. Five
    consecutive ticks should each complete well under TICK_BUDGET_S."""

    panes, statuses = _build_fleet(n_sessions=8, panes_per_session=3)
    assert len(panes) == 24

    async def go():
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                timings = _drive_ticks(app, STEADY_STATE_TICKS)

        # Every steady-state tick stays inside the budget.
        slowest = max(timings)
        assert slowest < TICK_BUDGET_S, (
            f"steady-state tick exceeded budget: max {slowest:.3f}s "
            f"(budget {TICK_BUDGET_S}s); all timings = {timings}"
        )

    asyncio.run(go())


# ---------------------------------------------------------------------------
# Stress (power user)
# ---------------------------------------------------------------------------


def test_render_path_handles_100_panes_in_budget():
    """Stress: 20 sessions \u00d7 5 panes = 100 panes. The first tick mounts
    every card and row; subsequent ticks should be cheap because the
    diff path only touches changed rows. We measure both paths
    separately so we can see if one regresses without the other."""

    panes, statuses = _build_fleet(n_sessions=20, panes_per_session=5)
    assert len(panes) == 100

    async def go():
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                # The on_mount/_tick mount storm is already paid; a
                # forced re-tick here mostly exercises the diff path.
                first_again = _capture_initial(app)
                steady = _drive_ticks(app, STEADY_STATE_TICKS)

        assert first_again < INITIAL_TICK_BUDGET_S, (
            f"first re-tick over 100 panes took {first_again:.3f}s "
            f"(budget {INITIAL_TICK_BUDGET_S}s)"
        )
        slowest = max(steady)
        assert slowest < TICK_BUDGET_S, (
            f"steady-state tick over 100 panes exceeded budget: max "
            f"{slowest:.3f}s (budget {TICK_BUDGET_S}s); all = {steady}"
        )

    asyncio.run(go())


# ---------------------------------------------------------------------------
# Cursor nav under load
# ---------------------------------------------------------------------------


def test_cursor_nav_stays_responsive_at_100_panes():
    """50 cursor moves at 100 panes mounted should complete well under
    a second — each move only diffs the previously-selected row/group
    against the new one, so the work per keystroke is O(1) regardless
    of pane count.

    We call `app.action_cursor_down()` directly instead of going through
    `pilot.press("j")`. The Pilot harness pumps each keystroke through
    the asyncio event loop and pays a non-trivial fixed cost per call
    (~400ms here, dominated by Textual's animation timer ticks during
    the implicit pause), which has nothing to do with the production
    keystroke path — in a real terminal, keys go through the input
    driver, not the test harness. Direct method calls measure the
    actual cursor-move code we're trying to pin down: the diff of the
    `.selected` / `.active-group` classes plus the scroll_to_widget
    request on the new target.
    """

    panes, statuses = _build_fleet(n_sessions=20, panes_per_session=5)

    async def go():
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                t0 = time.monotonic()
                for _ in range(50):
                    app.action_cursor_down()
                elapsed = time.monotonic() - t0

        # 50 cursor moves at 100 panes is the kind of thing a power
        # user does in a single "scan the list" gesture. The diff path
        # measured here typically clocks in around 5–20ms total on a
        # warm machine; we assert <500ms to leave loud headroom for
        # slow CI runners while still catching anything that turns
        # accidentally quadratic.
        assert elapsed < 0.5, (
            f"50 cursor moves at 100 panes took {elapsed:.3f}s; expected "
            f"<0.5s. Possible regression in _apply_selection's diff "
            f"— it should only flip classes on the previously-selected "
            f"row/group, not iterate all rows."
        )

    asyncio.run(go())


# ---------------------------------------------------------------------------
# Animation tick
# ---------------------------------------------------------------------------


def test_animation_tick_is_cheap_at_100_panes():
    """The animation timer fires at 12fps (~80ms) and re-paints every
    WORKING row. With 100 panes and the rotation in _build_fleet, ~43%
    are WORKING. A single animation tick should be sub-100ms; we
    measure 30 of them to smooth out timer noise."""

    panes, statuses = _build_fleet(n_sessions=20, panes_per_session=5)

    async def go():
        app = PiMonitorApp()
        with _stub_world(panes, statuses):
            async with app.run_test() as pilot:
                await pilot.pause()
                # Drive the animation path directly so we measure exactly
                # what the spinner timer pays per frame, not Textual's
                # event loop overhead.
                t0 = time.monotonic()
                for _ in range(30):
                    app._animate_working_rows()
                elapsed = time.monotonic() - t0

        per_frame_ms = (elapsed / 30) * 1000
        assert per_frame_ms < 100, (
            f"animation tick averaged {per_frame_ms:.1f}ms over 100 panes; "
            f"budget 100ms (one full 80ms timer interval). Possible "
            f"regression in _animate_working_rows or PaneRow.update_for."
        )

    asyncio.run(go())
