# Contributing to pi-monitor

Thanks for your interest. This file is the short version of "how to set
up dev, run the suite, and ship a patch." For the why-it-works-this-way
side of the codebase, the docstrings at the top of `state.py`,
`tui.py`, and `notify.py` are the primary source of truth.

---

## Dev environment

You need:

- **Python 3.9+** (CI matrix covers 3.9 and 3.13)
- **uv** ([install](https://docs.astral.sh/uv/getting-started/installation/))
- **tmux 3.2+** (for actually running pi-monitor; not required for the
  test suite)
- **git** (for the branch column in the tree)

```bash
git clone https://github.com/hshayde/pi-monitor
cd pi-monitor
uv sync
```

`uv sync` installs the runtime dep (`textual`, `psutil`) plus the dev
group (`pytest`, `ruff`) declared in `[dependency-groups]`. No extra
opt-in needed.

To run pi-monitor itself against your local checkout:

```bash
uv tool install -e . --force
```

The `-e` flag makes the install editable, so subsequent edits to
`src/pi_monitor/` take effect on the next `pi-monitor` launch without
reinstalling.

---

## Run the suite

The whole test suite is a single command and finishes in ~15 s:

```bash
uv run pytest
```

For a faster feedback loop on a single file:

```bash
uv run pytest tests/test_tui_render.py -v
```

Lint:

```bash
uv run ruff check src/ tests/
```

Both `pytest` and `ruff check` run on every push and PR via GitHub
Actions (Python 3.9 + 3.13 matrix). The CI workflow lives at
`.github/workflows/ci.yml` and also builds the wheel + sdist on green
to guard against package-config breakage.

---

## Test layout

The suite is split by surface:

| File | What it covers |
|------|----------------|
| `tests/test_state.py` | JSONL parsing, snapshot diffing, state inference, the per-cwd claim resolver. |
| `tests/test_heartbeat.py` | Heartbeat reader: freshness window, schema validation, the JSONL fast-path. |
| `tests/test_notify.py` | Notifier transitions, debounce, retry-error suppression. |
| `tests/test_tui_render.py` | Pure-function format helpers (`fmt_row_main`, `_activity_tag`, `_activity_description`, `_working_verb`, `branch_for_cwd` with mocked subprocess). |
| `tests/test_tui_app.py` | App-level interactions via Textual's `run_test()` Pilot: cursor model, `.selected`/`.active-group` toggling, mount/unmount diff, keybindings (s/t/m/?/shift+h/o), spawn-modal flow. |
| `tests/test_cross_platform.py` | Notification dispatch (notify-send / osascript / no-transport) and the psutil-backed process resolver against mocked exceptions. |
| `tests/test_perf.py` | Performance regression guards: typical 24-pane load, 100-pane stress, cursor nav O(1) under load, animation tick budget. |

Async test bodies use plain `asyncio.run(go())` so we don't need
`pytest-asyncio`. App-level tests stub every external call (tmux,
git, notify-send, psutil descendants) via the shared `_stub_world`
contextmanager in `test_tui_app.py`.

---

## Code style

- **Ruff is the formatter.** Run `uv run ruff format src/ tests/`
  before sending a patch (CI doesn't auto-format, but the editor
  hooks in this repo do, so most diffs are already clean).
- **Comments explain *why*, not *what*.** The hot paths in `state.py`
  and `tui.py` are heavily commented; new contributions should match
  that bar. Look at `_claim_session_file` for the canonical example
  of inline reasoning about a tricky algorithm.
- **No glyphs in the TUI.** State is conveyed by color (state tints
  on titles, state words on the right) and typography (bold +
  brightness hierarchy). Box-drawing characters used by Textual's
  `border: round` are structural, not decorative \u2014 they're fine.
- **Backwards compatibility on `state.py`'s public API.** Several
  attributes (`_proc_starttime`, `find_pi_pid_for_pane`,
  `PaneStatus`, `JsonlSnapshot`) are monkeypatched by tests across
  the suite. Keep their names + signatures stable across refactors.

---

## Visual changes

If you're touching the TUI, capture a snapshot to confirm. The fastest
loop:

1. Start a real pi session (`pi "say hi"` in any tmux pane), then
   another (`pi "echo two"`) so the monitor has fixtures to render.
2. Bind a tmux key to open the monitor:

   ```tmux
   bind-key m run-shell 'pi-monitor'
   ```

3. Reload (`tmux source ~/.tmux.conf`) and `prefix + m`.

For a deterministic snapshot (e.g. for a PR description), you can use
Textual's headless `App.run_test()` API to render with synthetic data
and `app.save_screenshot()` to dump an SVG. Several tests in
`tests/test_tui_app.py` use this pattern; copy one as a starting point.

---

## Submitting a patch

1. Branch off `main`. Keep the change focused; if you find yourself
   touching `state.py` *and* `tui.py` *and* the heartbeat extension in
   the same PR, that's usually a sign to split.
2. Commits with imperative subject lines (`feat(tui): ...`,
   `fix(state): ...`, `test(render): ...`). Bodies should explain the
   *why* and call out anything subtle a reviewer needs to know.
3. Update `CHANGELOG.md` under an `## [Unreleased]` section if your
   change is user-visible. (Maintainers will move it to a real version
   block at release time.)
4. Open a PR against `main`. CI will run automatically. Once green,
   request review.
5. The wheel and sdist are built on every CI run; you don't need to
   build them locally to verify packaging.

---

## Releases

Maintainers cut a release by:

1. Bumping `version` in `pyproject.toml`.
2. Moving the `[Unreleased]` block in `CHANGELOG.md` to the new
   version + date.
3. Committing both with a `release: X.Y.Z \u2014 ...` message.
4. Tagging `git tag -a vX.Y.Z -m "Release X.Y.Z"` and pushing the tag.
5. Building (`uv build`) and publishing (`uv publish`) when ready.
6. Cutting a GitHub release with the wheel + sdist
   (`gh release create vX.Y.Z dist/* --notes-from-tag`).

CI doesn't auto-publish to PyPI; that's a deliberate human-in-the-loop
gate.

---

## Filing issues

Include:

- `pi-monitor --version` (or the commit SHA you're running).
- `tmux -V`.
- OS / terminal emulator / Python version.
- For "it doesn't render right": a screenshot or, if possible, the SVG
  output of `app.save_screenshot()`.
- For "it crashes on launch": the full traceback.

For visual issues, also check [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
\u2014 most "doesn't look right" reports map to a known fix there
(translucency setup, branch column timing, heartbeat extension not
installed).
