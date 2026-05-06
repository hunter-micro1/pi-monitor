"""Textual TUI for pi-monitor.

The monitor session is a tmux 2-pane window. This file owns only the LEFT
pane: a flat list of pi sessions, each with its panes shown as one-line
rows that surface the agent name, the git branch they're working in, and
their live state.

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
    │ +  new session                           │
    │                                          │
    │ contracts                                │
    │ PSP7-gateway · feature/auth     working  │
    │ POWERBI      · feature/billing  idle 12s │
    │                                          │
    │ cape                                     │
    │ ANALYST      · main             error 12s│
    │ footer (key hints)                       │
    └──────────────────────────────────────────┘

Visual rules the code depends on:

- Everything is `background: transparent`. The terminal's translucency
  shows through end-to-end; no widget paints its own surface.

- No decorative glyphs. State is conveyed by color (the title pulses in
  the success color on WORKING rows, gets the warning/error color on
  IDLE/ERROR/etc.) and by a right-aligned state word (`working`, `idle
  4m`, `error`, `waiting`, `retrying`). Plain `+` and `·` are kept as
  typography, not iconography.

- Horizontal flex inside each row: `name · branch` takes all available
  width and ellipsizes; the state word floats right. So agent names and
  branch names get every cell we can spare on narrow tmux panes.

- Selection fades in/out via a CSS `transition: background` on PaneRow,
  which is the only motion besides the WORKING-color pulse. Keeps the
  feel "alive" without the busyness of a spinning glyph.

Modal dialogs use a lightly-tinted `$surface 70%` so dense input/help
text stays legible over busy backdrops while still reading as a frosted
panel.
"""

from __future__ import annotations

import math
import os
import subprocess
import time
from pathlib import Path

from rich.markup import escape
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Footer, Input, Static

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

# Color-pulse cadence for WORKING rows. 80ms ~ 12 fps which is what npm,
# yarn, kubectl etc. use; smooth without burning cycles. This is the only
# animation timer left after the spinner-glyph pass — it now drives the
# title color pulse on working rows so motion lives in the typography
# itself rather than a side glyph.
PULSE_INTERVAL_S = 0.08
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
# (fmt_row_main, fmt_row_tag, _help_text, ...) stay theme-aware without
# being threaded with an app reference. Tests that need the defaults
# should import them at top of the test, not after instantiating the App.
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
# These are NOT used inside the TUI (the TUI is glyph-free).
STATE_GLYPHS: dict[AgentState, str] = {
    AgentState.IDLE: "🔴",
    AgentState.WORKING: "🟢",
    AgentState.ERROR: "❌",
    AgentState.WAITING: "🟠",
    AgentState.RETRYING: "🔵",
    AgentState.UNKNOWN: "❓",
    AgentState.NO_PI: "⚫",
}


def _new_session_label() -> str:
    """Top-of-list affordance to open the new-session modal. Re-rendered
    on theme change so the accent color stays in sync with the active
    theme. `+` is plain ASCII typography, not an icon."""
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
            ("h / ←", "previous session"),
            ("l / →", "next session"),
            ("g / G", "top / bottom"),
            ("1–9", "jump to Nth pane"),
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
        (("o", "new session (on +) or new window (on a pane)"),),
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
        background: $surface 70%;
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
        background: $surface 70%;
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
        background: $boost 70%;
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
# Git branch resolver (cached)
# ---------------------------------------------------------------------------


_BRANCH_TTL_S = 15.0
_branch_cache: dict[str, tuple[float, str | None]] = {}


def branch_for_cwd(cwd: str) -> str | None:
    """Return the current git branch for `cwd`, with a 15s TTL cache.

    Returns the short branch name (e.g., "main", "feature/foo") or None
    when the cwd isn't a git checkout, the HEAD is detached, or the
    `git` invocation fails for any reason. Detached HEADs intentionally
    return None — there's no branch to display, and showing the SHA
    just adds visual noise.

    The cache amortizes the subprocess cost: at our 0.5s tick cadence
    a 15s TTL means each cwd hits `git` at most every ~30 ticks, so the
    render path stays cheap even with a dozen panes.
    """
    if not cwd:
        return None
    now = time.monotonic()
    cached = _branch_cache.get(cwd)
    if cached is not None and now - cached[0] < _BRANCH_TTL_S:
        return cached[1]
    try:
        result = subprocess.run(
            ["git", "-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=0.4,
        )
        branch = (
            result.stdout.strip() if result.returncode == 0 and result.stdout else None
        )
    except (subprocess.TimeoutExpired, OSError):
        branch = None
    _branch_cache[cwd] = (now, branch)
    return branch


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


def _state_tag(
    state: AgentState,
    idle_seconds: float,
    *,
    working_color: str | None = None,
) -> str:
    """Right-side state word for a pane row, colored by state.

    Verbs are short on purpose so the right column reads as a status badge
    rather than a sentence. WORKING uses `working_color` when given so it
    pulses in lockstep with the title.
    """
    color = STATE_COLORS.get(state, "grey50")
    if state == AgentState.WORKING:
        c = working_color or color
        return f"[{c}]working[/{c}]"
    if state == AgentState.IDLE:
        idle = fmt_idle(idle_seconds)
        verb = f"idle {idle}" if idle else "idle"
        return f"[{color}]{verb}[/{color}]"
    if state == AgentState.ERROR:
        idle = fmt_idle(idle_seconds)
        verb = f"error {idle}" if idle else "error"
        return f"[{color}]{verb}[/{color}]"
    if state == AgentState.WAITING:
        return f"[{color}]waiting[/{color}]"
    if state == AgentState.RETRYING:
        return f"[{color}]retrying[/{color}]"
    if state == AgentState.NO_PI:
        return f"[{color}]no pi[/{color}]"
    return f"[{color}]unknown[/{color}]"


def fmt_row_main(
    pane: Pane,
    status: PaneStatus,
    branch: str | None,
    *,
    working_color: str | None = None,
) -> str:
    """Markup for the LEFT half of a pane row: `name  · branch`.

    The agent name is bold; on WORKING rows it's also tinted with the
    pulse color so the title visibly breathes. Other states keep the
    title in $foreground (neutral) and rely on the right-aligned state
    word for color — that way the eye scans WORKING (active motion) vs
    everything-else (calm) without a glyph in front of every line.

    Branch is dim and prefixed with `· ` so it reads as metadata. When
    the cwd isn't a git checkout we drop the entire branch fragment
    (no awkward `· (none)` placeholder).
    """
    name_raw = pane.title or f"pane {pane.pane_index}"
    name = escape(name_raw)
    if status.state == AgentState.WORKING:
        c = working_color or STATE_COLORS[AgentState.WORKING]
        title = f"[bold {c}]{name}[/bold {c}]"
    else:
        title = f"[bold]{name}[/bold]"
    if branch:
        return f"{title}  [dim]· {escape(branch)}[/dim]"
    return title


def fmt_row_tag(
    status: PaneStatus,
    *,
    working_color: str | None = None,
) -> str:
    """Markup for the RIGHT half of a pane row: just the state word."""
    return _state_tag(status.state, status.idle_seconds, working_color=working_color)


def fmt_session_header(session: str) -> str:
    """Markup for a session group header. Plain bold name in the live
    accent color — no border, no chip, no disclosure arrow."""
    return f"[bold {ACCENT}]{escape(session)}[/bold {ACCENT}]"


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
# Widgets — SessionGroup / PaneRow
# ---------------------------------------------------------------------------


class _SessionScroll(VerticalScroll):
    """VerticalScroll whose arrow-key scroll bindings are redirected to
    the App's cursor-nav actions.

    Textual's `ScrollableContainer` ancestor binds up/down/left/right to
    scroll the container, which would intercept those keys before our
    App-level cursor bindings fire. We rebind them on the subclass so the
    focused widget's bindings (this scroll's) point at the App actions
    directly. PageUp / PageDown / Home / End stay as the inherited
    scroll-aware defaults so users still get fast vertical paging in
    long lists.
    """

    BINDINGS = [
        Binding("up", "app.cursor_up", show=False),
        Binding("down", "app.cursor_down", show=False),
        Binding("left", "app.prev_card", show=False),
        Binding("right", "app.next_card", show=False),
    ]


class PaneRow(Container):
    """One pane inside a SessionGroup.

    Two children laid out horizontally: `#row-main` takes all flexible
    width (and ellipsizes when the agent name + branch don't fit); the
    `#row-tag` floats on the right with auto width for the state word.
    The flex split is what gives agent names every cell we can spare on
    narrow tmux panes.

    Selection is a CSS class toggle — `transition: background` on the
    row makes the bg tint fade in/out smoothly when the cursor moves,
    which is the visual cue replacing the glyph rail of the previous
    design.
    """

    DEFAULT_CSS = """
    PaneRow {
        height: 1;
        width: 100%;
        layout: horizontal;
        padding: 0 2;
        background: transparent;
        color: $foreground;
        transition: background 180ms in_out_cubic;
    }
    PaneRow.selected {
        background: $primary 18%;
    }
    PaneRow > #row-main {
        width: 1fr;
        height: 1;
        background: transparent;
        text-overflow: ellipsis;
        text-wrap: nowrap;
    }
    PaneRow > #row-tag {
        width: auto;
        height: 1;
        padding: 0 0 0 2;
        background: transparent;
        text-wrap: nowrap;
    }
    """

    def __init__(self, pane_id: str) -> None:
        # Pre-construct the children and pass them as positional args to
        # Container.__init__ so they're materialized through Container's
        # default `compose` immediately. Yielding them from a subclass
        # `compose` instead races against subsequent explicit `mount`
        # calls in the App's render path, which can leave child order
        # inverted on the first paint.
        self._main = Static("", id="row-main", markup=True)
        self._tag = Static("", id="row-tag", markup=True)
        super().__init__(self._main, self._tag)
        self.pane_id = pane_id

    def update_for(
        self,
        pane: Pane,
        status: PaneStatus,
        branch: str | None,
        *,
        working_color: str | None = None,
    ) -> None:
        """Refresh both halves of the row from the latest snapshot."""
        self._main.update(
            fmt_row_main(pane, status, branch, working_color=working_color)
        )
        self._tag.update(fmt_row_tag(status, working_color=working_color))


class SessionGroup(Container):
    """One session group. No border, no chip, no disclosure arrow — just
    a bold name header with a 1-row top margin to separate it from the
    previous group, and the PaneRow children flowing beneath.

    Visual structure is carried by negative space alone, matching the
    Mux/Warp sidebar pattern of "list with strong typography, not boxed
    cards".
    """

    DEFAULT_CSS = """
    SessionGroup {
        height: auto;
        width: 100%;
        margin: 1 0 0 0;
        padding: 0;
        background: transparent;
    }
    SessionGroup > .session-header {
        height: 1;
        padding: 0 2;
        background: transparent;
        text-style: bold;
    }
    """

    def __init__(self, session: str) -> None:
        # Empty Container; the App's render path mounts the header
        # explicitly right after mounting the group so it's queued
        # before any rows. (Yielding the header from `compose` or
        # passing it to Container.__init__ races against the explicit
        # row mounts and ends up appended last.)
        super().__init__()
        self.session = session
        self._header = Static(
            fmt_session_header(session),
            classes="session-header",
            markup=True,
        )

    def refresh_header(self) -> None:
        """Re-render the session-header label — used after a theme cycle
        so the accent color tracks the new palette."""
        self._header.update(fmt_session_header(self.session))


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


class PiMonitorApp(App):
    """The pi-monitor TUI.

    Renders the session list in the LEFT tmux pane of the monitor session.
    The RIGHT tmux pane is owned by tmux and reset/respawned via this
    class when the user picks an agent (see `_borrow_into_right_slot`).
    """

    # Layout uses Textual's theme variables ($primary, $accent, $surface,
    # $foreground, $foreground-muted, ...) so swapping the active theme
    # rethemes the whole UI for free. Everything in the column is
    # transparent — Screen, chrome bars, the VerticalScroll itself, and
    # SessionGroup backgrounds — so any translucency the user has
    # configured in their terminal shows through end-to-end. There are
    # no card borders, no glyphs, and no spinners; visual hierarchy
    # comes from typography (bold names, dim metadata), color (state
    # tints on titles + state words), and motion (smooth selection-bg
    # transitions plus the WORKING-row title pulse driven from the App's
    # animation timer).
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

    #session-list {
        height: 1fr;
        width: 100%;
        background: transparent;
        padding: 0;
        scrollbar-size: 1 1;
    }

    #new-session-affordance {
        height: 1;
        padding: 0 2;
        margin: 1 0 0 0;
        background: transparent;
        color: $foreground-muted;
        transition: background 180ms in_out_cubic;
    }

    #new-session-affordance.selected {
        background: $primary 18%;
        text-style: bold;
    }

    #empty-hint {
        height: 1;
        padding: 0 2;
        margin: 1 0 0 0;
        background: transparent;
        color: $foreground-muted;
    }

    #empty-hint.hidden {
        display: none;
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
        Binding("h", "prev_card", "←", show=False),
        Binding("j", "cursor_down", "↓", show=False),
        Binding("k", "cursor_up", "↑", show=False),
        Binding("l", "next_card", "→", show=False),
        Binding("up", "cursor_up", "↑", show=False),
        Binding("down", "cursor_down", "↓", show=False),
        Binding("left", "prev_card", "←", show=False),
        Binding("right", "next_card", "→", show=False),
        Binding("enter", "select", "open", show=False),
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

        # Render state. Groups keyed by session name, rows keyed by pane
        # id; both diffed against resolver output every tick.
        self._groups: dict[str, SessionGroup] = {}
        self._rows: dict[str, PaneRow] = {}
        self._latest_statuses: dict[str, tuple[Pane, PaneStatus]] = {}
        # Ordering preserved so insertion-order matches display order.
        self._group_order: list[str] = []

        # Cursor model: positions is a flat list of selectable rows in
        # display order; idx points into it. Position tuples are either
        # ("new",) or ("pane", pane_id).
        self._cursor_positions: list[tuple] = [("new",)]
        self._cursor_idx: int = 0

        # The viewer session currently attached in the right tmux pane (or
        # None when the right pane is at its placeholder).
        self._active_viewer: str | None = None
        # Animation: monotonic seconds-since-mount used for the WORKING
        # title pulse phase. Keeping it as a float (not a frame counter)
        # decouples the pulse from the timer cadence; if we change the
        # interval, the visible motion stays the same.
        self._pulse_t0: float = time.monotonic()

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
        with _SessionScroll(id="session-list"):
            yield Static(_new_session_label(), id="new-session-affordance")
            yield Static("", id="empty-hint", classes="hidden")
        yield Footer()

    def on_mount(self) -> None:
        self.title = "pi-monitor"
        self._title_bar: Static = self.query_one("#title-bar", Static)
        self._attention_banner: Static = self.query_one("#attention-banner", Static)
        self._session_list: _SessionScroll = self.query_one(
            "#session-list", _SessionScroll
        )
        self._new_session_row: Static = self.query_one(
            "#new-session-affordance", Static
        )
        self._empty_hint: Static = self.query_one("#empty-hint", Static)
        # Pull initial palette from the saved theme before the first tick
        # so the very first render uses the right colors.
        self.theme = self._theme_name
        self._refresh_state_colors()
        self._apply_selection()
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
        # Take focus so our App-level bindings receive keystrokes. The
        # session list itself is a VerticalScroll; we don't want the user
        # to have to click before keys work.
        self._session_list.can_focus = True
        self._session_list.focus()
        self.notifier.on_transition = self._on_transition
        self.set_interval(POLL_INTERVAL_S, self._tick)
        self.set_interval(PULSE_INTERVAL_S, self._animate_working_rows)
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
        STATE_COLORS[AgentState.UNKNOWN] = palette["foreground-muted"]
        # NO_PI used to be the same RGB as UNKNOWN with only the alpha
        # different, which Textual ignores. Blend it halfway toward
        # `$surface` so the two states are *visually* distinguishable
        # while staying clearly de-emphasized.
        STATE_COLORS[AgentState.NO_PI] = _lerp_color(
            palette["foreground-disabled"][:7], surface_solid, 0.5
        )
        ACCENT = palette["primary"]
        # Pulse dim end: blend success with $background (the theme's deepest
        # base color, what shows through the transparent rows) at 50% so
        # the dim end of the working title pulse stays legible across both
        # light and dark themes.
        WORKING_PULSE_DIM = _lerp_color(
            palette["success"][:7], palette["background"][:7], 0.5
        )

    # -- Animation ---------------------------------------------------------

    def _pulse_color(self) -> str:
        """Current WORKING-pulse color. Sine wave between dim and bright
        success over PULSE_PERIOD_S; 0.55..1.0 keeps the dim end legible."""
        elapsed = (time.monotonic() - self._pulse_t0) % PULSE_PERIOD_S
        fraction = 0.55 + 0.45 * math.sin(2 * math.pi * elapsed / PULSE_PERIOD_S)
        if fraction < 0:
            fraction = 0.0
        elif fraction > 1:
            fraction = 1.0
        return _lerp_color(
            WORKING_PULSE_DIM, STATE_COLORS[AgentState.WORKING], fraction
        )

    def _animate_working_rows(self) -> None:
        """Repaint every WORKING row with the current pulse color. Called
        on PULSE_INTERVAL_S; cheap because we only touch rows whose state
        is actually WORKING (other rows are owned by the slow tick)."""
        if not hasattr(self, "_session_list"):
            return
        pulse = self._pulse_color()
        for pane_id, row in self._rows.items():
            entry = self._latest_statuses.get(pane_id)
            if entry is None:
                continue
            pane, status = entry
            if status.state != AgentState.WORKING:
                continue
            row.update_for(
                pane,
                status,
                branch_for_cwd(pane.cwd),
                working_color=pulse,
            )

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
        """Render the title bar (brand + always-on stat counts + view info)
        and the attention banner (top issue + count of the rest).

        Counts are rendered as colored words (`2 working · 1 idle`) — no
        leading bullet glyph. Zero counts render in dim so the layout
        stays stable as panes come and go.
        """
        counts: dict[AgentState, int] = {}
        for _, s in statuses:
            counts[s.state] = counts.get(s.state, 0) + 1
        total = sum(counts.values())

        brand = f"[bold {ACCENT}]pi-monitor[/bold {ACCENT}]"
        if total == 0:
            self._title_bar.update(
                f"{brand}   [dim]no pi sessions yet · press [/dim]"
                f"[bold {ACCENT}]o[/bold {ACCENT}][dim] to launch one[/dim]"
            )
            self._update_attention_banner(statuses, counts)
            return

        chips: list[str] = []
        for state, label in (
            (AgentState.WORKING, "working"),
            (AgentState.IDLE, "idle"),
            (AgentState.ERROR, "error"),
        ):
            n = counts.get(state, 0)
            color = STATE_COLORS[state] if n else "grey50"
            chips.append(f"[{color}]{n} {label}[/{color}]")
        chips_str = "  [dim]·[/dim]  ".join(chips)

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

        self._update_attention_banner(statuses, counts)

    def _update_attention_banner(
        self,
        statuses: list[tuple[Pane, PaneStatus]],
        counts: dict[AgentState, int],
    ) -> None:
        """Surface the single most-attention-needing pane by name. If more
        panes also need attention, append `+N more`. Hide entirely when
        nothing's stuck.

        Highest priority wins: ERROR > WAITING > IDLE. Among the same
        state we pick the longest-idle pane (oldest issue first).
        """
        attention_total = sum(
            counts.get(s, 0)
            for s in (AgentState.ERROR, AgentState.WAITING, AgentState.IDLE)
        )
        if attention_total == 0:
            self._attention_banner.add_class("hidden")
            self._attention_banner.update("")
            return

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
        self._attention_banner.update(
            f"[bold]{target}[/bold]  [{color}]{verb}{idle_part}[/{color}]"
            f"{rest_part}  [dim]· press 1–9 to jump[/dim]"
        )
        self._attention_banner.remove_class("hidden")

    def _render(self, statuses: list[tuple[Pane, PaneStatus]]) -> None:
        """Diff the desired group/row state against `_groups` / `_rows`
        and mount/unmount/update widgets in place."""
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

        # Remove dead groups.
        for name in list(self._groups.keys()):
            if name not in by_session:
                group = self._groups.pop(name)
                for child in list(group.children):
                    if isinstance(child, PaneRow):
                        self._rows.pop(child.pane_id, None)
                group.remove()

        pulse = self._pulse_color()

        for name in desired_sessions:
            items = by_session[name]
            if name not in self._groups:
                group = SessionGroup(name)
                self._groups[name] = group
                # Mount before the empty-hint sentinel so groups stack
                # above it; the hint sits at the very bottom of the list.
                self._session_list.mount(group, before=self._empty_hint)
                # Queue the header right after, so subsequent row mounts
                # land below it. Textual flushes mount() calls FIFO
                # within a turn, so this preserves header-first order
                # without needing to await each AwaitMount.
                group.mount(group._header)
            else:
                group = self._groups[name]

            desired_pane_ids = [p.pane_id for p, _ in items]
            existing_rows: dict[str, PaneRow] = {
                child.pane_id: child
                for child in group.children
                if isinstance(child, PaneRow)
            }

            for pid, row in existing_rows.items():
                if pid not in desired_pane_ids:
                    row.remove()
                    self._rows.pop(pid, None)

            for pane, status in items:
                branch = branch_for_cwd(pane.cwd)
                if pane.pane_id in existing_rows and pane.pane_id in self._rows:
                    row = self._rows[pane.pane_id]
                    # WORKING rows are owned by the pulse timer; let it
                    # repaint them so it doesn't fight our frame.
                    if status.state == AgentState.WORKING:
                        continue
                    row.update_for(pane, status, branch)
                else:
                    row = PaneRow(pane.pane_id)
                    self._rows[pane.pane_id] = row
                    group.mount(row)
                    row.update_for(
                        pane,
                        status,
                        branch,
                        working_color=pulse,
                    )

        self._group_order = list(desired_sessions)

        if not desired_sessions:
            self._empty_hint.update(
                "[dim]no pi sessions yet · press [/dim]"
                f"[bold {ACCENT}]o[/bold {ACCENT}]"
                "[dim] to launch one[/dim]"
            )
            self._empty_hint.remove_class("hidden")
        else:
            self._empty_hint.add_class("hidden")

        # Refresh the affordance label so theme changes update its accent.
        self._new_session_row.update(_new_session_label())

        self._rebuild_cursor_positions()
        self._apply_selection()

    # -- Cursor model ------------------------------------------------------

    def _rebuild_cursor_positions(self) -> None:
        """Walk the visible group/row structure and recompute the cursor
        position list. Preserves the current cursor when its target is
        still visible; otherwise lands on the first pane row.
        """
        prev_pos = (
            self._cursor_positions[self._cursor_idx]
            if 0 <= self._cursor_idx < len(self._cursor_positions)
            else None
        )

        positions: list[tuple] = [("new",)]
        for name in self._group_order:
            group = self._groups.get(name)
            if group is None:
                continue
            for child in group.children:
                if isinstance(child, PaneRow):
                    positions.append(("pane", child.pane_id))

        self._cursor_positions = positions
        if prev_pos is not None:
            try:
                self._cursor_idx = positions.index(prev_pos)
                return
            except ValueError:
                pass
        # Fallback: prefer the first pane over the affordance so power
        # users land on a real row after the very first tick.
        if len(positions) > 1:
            self._cursor_idx = 1
        else:
            self._cursor_idx = 0

    def _current_position(self) -> tuple | None:
        if 0 <= self._cursor_idx < len(self._cursor_positions):
            return self._cursor_positions[self._cursor_idx]
        return None

    def _apply_selection(self) -> None:
        """Reflect the cursor on the actual widgets — toggle the
        `.selected` class on the row that owns the current position,
        scroll it into view, and trigger a hover-preview if it's a pane
        row. Selection bg fades in/out via the row's CSS transition."""
        pos = self._current_position()
        if pos == ("new",):
            self._new_session_row.add_class("selected")
        else:
            self._new_session_row.remove_class("selected")

        target_row: PaneRow | None = None
        for pane_id, row in self._rows.items():
            if pos is not None and pos[0] == "pane" and pos[1] == pane_id:
                row.add_class("selected")
                target_row = row
            else:
                row.remove_class("selected")

        try:
            if target_row is not None:
                self._session_list.scroll_to_widget(target_row, animate=False)
            elif pos == ("new",):
                self._session_list.scroll_to_widget(
                    self._new_session_row, animate=False
                )
        except Exception:
            # Scroll target may not be mounted yet on the very first tick;
            # the next tick will catch up.
            pass

        if pos is not None and pos[0] == "pane":
            entry = self._latest_statuses.get(pos[1])
            if entry is not None:
                self._borrow_into_right_slot(entry[0])

    def _move_cursor(self, new_idx: int) -> None:
        """Clamp + apply. Single chokepoint so we don't have to re-style
        from every keybinding."""
        if not self._cursor_positions:
            return
        new_idx = max(0, min(new_idx, len(self._cursor_positions) - 1))
        if new_idx == self._cursor_idx:
            return
        self._cursor_idx = new_idx
        self._apply_selection()

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

    # -- Cursor / nav actions ----------------------------------------------

    def action_cursor_down(self) -> None:
        self._move_cursor(self._cursor_idx + 1)

    def action_cursor_up(self) -> None:
        self._move_cursor(self._cursor_idx - 1)

    def action_prev_card(self) -> None:
        """h / ←: jump to the first row of the previous session."""
        target = self._neighbour_card(direction=-1)
        if target is not None:
            self._move_cursor(target)

    def action_next_card(self) -> None:
        """l / →: jump to the first row of the next session."""
        target = self._neighbour_card(direction=1)
        if target is not None:
            self._move_cursor(target)

    def _neighbour_card(self, direction: int) -> int | None:
        """Find the cursor index of the first pane row of the
        previous/next session relative to the current cursor.
        """
        positions = self._cursor_positions
        if not positions:
            return None
        current_card = self._card_for_position(self._current_position())
        if not self._group_order:
            return None
        if current_card is None:
            target_card = (
                self._group_order[0] if direction > 0 else self._group_order[-1]
            )
        else:
            try:
                idx = self._group_order.index(current_card)
            except ValueError:
                return None
            new_idx = idx + direction
            if new_idx < 0 or new_idx >= len(self._group_order):
                return None
            target_card = self._group_order[new_idx]
        for i, pos in enumerate(positions):
            if pos[0] != "pane":
                continue
            entry = self._latest_statuses.get(pos[1])
            if entry is not None and entry[0].session == target_card:
                return i
        return None

    def _card_for_position(self, pos: tuple | None) -> str | None:
        """Return the session name for a pane position, else None."""
        if pos is None or pos[0] != "pane":
            return None
        entry = self._latest_statuses.get(pos[1])
        return entry[0].session if entry is not None else None

    def action_go_top(self) -> None:
        if not self._cursor_positions:
            return
        for i, pos in enumerate(self._cursor_positions):
            if pos[0] == "pane":
                self._move_cursor(i)
                return
        self._move_cursor(0)

    def action_go_bottom(self) -> None:
        if not self._cursor_positions:
            return
        for i in range(len(self._cursor_positions) - 1, -1, -1):
            if self._cursor_positions[i][0] == "pane":
                self._move_cursor(i)
                return
        self._move_cursor(len(self._cursor_positions) - 1)

    def action_jump(self, n: int) -> None:
        """1–9: jump to the Nth pane in display order (skipping the
        affordance). Out-of-range presses are no-ops."""
        count = 0
        for i, pos in enumerate(self._cursor_positions):
            if pos[0] != "pane":
                continue
            count += 1
            if count == n:
                self._move_cursor(i)
                return

    def action_select(self) -> None:
        """Enter: act on the cursored row.

        - On `+ new session`: open the new-session modal.
        - On a pane row: ensure the right pane previews this agent and
          hand keyboard focus to the right pane (so subsequent keys go to
          the agent, not to pi-monitor).
        """
        pos = self._current_position()
        if pos is None:
            return
        if pos[0] == "new":
            self._open_new_session()
            return
        if pos[0] == "pane":
            entry = self._latest_statuses.get(pos[1])
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

    # -- Other actions ----------------------------------------------------

    def action_cycle_sort(self) -> None:
        self.sort_mode = "status" if self.sort_mode == "tmux" else "tmux"
        self.config["sort_mode"] = self.sort_mode
        save_config(self.config)
        self._tick()

    def action_cycle_theme(self) -> None:
        """Cycle through the curated theme list, persist the choice, and
        refresh state colors so titles + tags + headers pick up the new
        accents.
        """
        idx = THEMES.index(self._theme_name) if self._theme_name in THEMES else 0
        self._theme_name = THEMES[(idx + 1) % len(THEMES)]
        self.theme = self._theme_name
        self.config["theme"] = self._theme_name
        save_config(self.config)
        self._refresh_state_colors()
        # Re-render group headers (their accent color comes from the live
        # ACCENT and we just bumped it).
        for group in self._groups.values():
            group.refresh_header()
        self._tick()
        self.notify(f"theme: {self._theme_name}", timeout=2)

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

    def action_show_help(self) -> None:
        self.push_screen(HelpScreen())

    def action_open_new(self) -> None:
        """`o` is context-sensitive:

        - cursor on `+ new session` row → new tmux session (with pi)
        - cursor on a pane → new pi window in that pane's session
        - cursor on nothing useful (empty list) → fall back to new session
        """
        pos = self._current_position()
        if pos is None or pos[0] == "new":
            self._open_new_session()
            return
        if pos[0] == "pane":
            self._open_window()
            return
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
            self._open_new_session()
            return
        self._window_target = pane.session
        self.push_screen(
            NewPiScreen("window", pane.cwd),
            self._handle_launch_result,
        )

    def _cursored_cwd(self) -> str | None:
        pane = self._cursored_pane_obj()
        return pane.cwd if pane is not None else None

    def _cursored_pane_obj(self) -> Pane | None:
        pos = self._current_position()
        if pos is None or pos[0] != "pane":
            return None
        entry = self._latest_statuses.get(pos[1])
        return entry[0] if entry is not None else None

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
