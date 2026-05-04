"""Entry point for the pi-monitor CLI."""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="pi-monitor",
        description="Live tmux-aware status monitor for pi coding agents.",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Print version and exit.",
    )
    args = parser.parse_args(argv)

    if args.version:
        from . import __version__

        print(__version__)
        return 0

    # Real implementation lands in step 7 (cli wiring + tmux bootstrap).
    print("pi-monitor: scaffold only; full TUI is implemented in subsequent commits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
