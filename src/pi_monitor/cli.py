"""Entry point for the pi-monitor CLI.

Behaviour:
  * Outside the monitor tmux session: create the session if needed (its left
    pane runs `python -m pi_monitor`, which re-enters this CLI inside the
    monitor session and renders the TUI), run crash recovery to break out
    any orphaned panes, then `tmux switch-client` into the monitor.
  * Inside the monitor tmux session: skip the bootstrap and run the TUI.

We don't try to handle the "no tmux at all" case beyond a clear error — the
whole tool only makes sense inside tmux.
"""

from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys

from . import __version__


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pi-monitor",
        description="Live tmux-aware status monitor for pi coding agents.",
    )
    parser.add_argument(
        "--version", action="store_true", help="Print version and exit."
    )
    args = parser.parse_args(argv)

    if args.version:
        print(__version__)
        return 0

    if shutil.which("tmux") is None:
        print("pi-monitor: tmux not found in PATH.", file=sys.stderr)
        return 2

    if not _tmux_server_running():
        print(
            "pi-monitor: no tmux server running. "
            "Start tmux first (e.g. `tmux new -s work`).",
            file=sys.stderr,
        )
        return 2

    if _inside_monitor_session():
        return _run_tui()
    return _bootstrap_and_switch()


# ---------------------------------------------------------------------------
# Bootstrap path (outside monitor session)
# ---------------------------------------------------------------------------


def _bootstrap_and_switch() -> int:
    # Late imports so `--version` doesn't pay the textual import cost.
    from .tmux import (
        ensure_monitor_session,
        switch_client_to_monitor,
        TmuxError,
    )

    left_command = _self_invocation()
    try:
        ensure_monitor_session(left_command=left_command)
        switch_client_to_monitor()
    except TmuxError as exc:
        print(f"pi-monitor: tmux error: {exc}", file=sys.stderr)
        return 1
    return 0


def _run_tui() -> int:
    from .tui import run

    return run()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tmux_server_running() -> bool:
    return subprocess.run(["tmux", "has-session"], capture_output=True).returncode == 0


def _inside_monitor_session() -> bool:
    """Return True iff this process's tmux pane is inside the monitor session."""
    if "TMUX" not in os.environ:
        return False
    result = subprocess.run(
        ["tmux", "display-message", "-p", "#{session_name}"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return False
    return result.stdout.strip() == "monitor"


def _self_invocation() -> str:
    """Command tmux should run in the monitor session's left pane to launch
    the TUI. Uses the same Python interpreter we're running under so
    venv/uv-tool installs work without depending on PATH."""
    return f"{shlex.quote(sys.executable)} -m pi_monitor"


if __name__ == "__main__":
    sys.exit(main())
