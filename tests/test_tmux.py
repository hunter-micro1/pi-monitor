"""Tests for tmux pane-title sanitization.

pi-tui renders/clears inline images with Kitty graphics APC sequences;
tmux copies the APC payload into pane_title, so a pi pane's title gets
clobbered with raw control data like `Ga=d,d=A,q=2`. `_sanitize_pane_title`
must drop those so they never surface as an agent name. Mirror of the TS
`sanitizePaneTitle` tests in `ts/tests/tmux/panes.test.ts`.
"""

from __future__ import annotations

import pytest

from pi_monitor.tmux import _sanitize_pane_title

LEAKED = [
    "Ga=d,d=A,q=2",  # delete all images
    "Ga=d,d=I,i=12345,q=2",  # delete one image by id
    "Ga=T,f=100,q=2;iVBORw0KGgoAAAANS",  # transmit + display (base64)
    "Ga=T,f=100,q=2,m=1;iVBORw0K",  # chunked first frame
    "Gm=1;Zm9vYmFy",  # continuation chunk
    "Gm=0;",  # final (empty) chunk
]

GENUINE = [
    "",
    "agent",
    "long agent name here",
    "\u03c0 - patent-search - apps",
    "Architecture diagram: design end to end cost estimation system",
    "Gatsby build",  # starts with G but is not key=value graphics data
    "G=2",  # no graphics-style key letter before '='
]


@pytest.mark.parametrize("title", LEAKED)
def test_strips_leaked_kitty_graphics_payloads(title: str) -> None:
    assert _sanitize_pane_title(title) == ""


@pytest.mark.parametrize("title", GENUINE)
def test_leaves_genuine_titles_untouched(title: str) -> None:
    assert _sanitize_pane_title(title) == title
