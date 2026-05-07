#!/usr/bin/env bash
#
# pi-monitor smoke test.
#
# Two tiers:
#   - Tier 1 (always runs): subprocess-only checks. Verifies --help and
#     --version, which don't touch tmux. We deliberately do NOT test
#     the "outside tmux" path here -- if the environment already has a
#     tmux server running, the binary will happily bootstrap into it,
#     mutating real state.
#   - Tier 2 (skipped if tmux is missing): isolated tmux server smoke.
#     Spins up a fresh server with TMUX_TMPDIR pointing at a private
#     mktemp, runs the binary as the command of an attached session,
#     captures pane output to verify the TUI renders, sends 'q' to
#     verify the cleanup path. The isolated server is torn down on
#     EXIT so no real tmux state is touched.
#
# Exits 0 on full success, 1 on the first failure. Intended to be run
# via `pnpm smoke` from ts/ after `pnpm build`.

set -euo pipefail

cd "$(dirname "$0")/.."

CLI="$PWD/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
	echo "smoke: $CLI not found. Run 'pnpm build' first." >&2
	exit 1
fi

NODE="${NODE:-node}"
GREEN="\033[0;32m"
RED="\033[0;31m"
NC="\033[0m"

pass() { echo -e "${GREEN}smoke: PASS${NC} $1"; }
fail() { echo -e "${RED}smoke: FAIL${NC} $1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Tier 1 -- subprocess checks, no tmux
# ---------------------------------------------------------------------------

echo "== Tier 1: subprocess checks =="

# 1. --help exits 0 and includes the binary name.
help_out=$("$NODE" "$CLI" --help)
echo "$help_out" | grep -q "pi-monitor" || fail "--help missing 'pi-monitor' in output"
pass "--help"

# 2. --version exits 0 and prints a semver-ish string.
ver_out=$("$NODE" "$CLI" --version)
echo "$ver_out" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+' || fail "--version output not semver: $ver_out"
pass "--version ($ver_out)"

# 3. -h and -V short flags work too.
"$NODE" "$CLI" -h >/dev/null || fail "-h non-zero exit"
"$NODE" "$CLI" -V >/dev/null || fail "-V non-zero exit"
pass "-h / -V short flags"

# ---------------------------------------------------------------------------
# Tier 2 -- isolated tmux server smoke
# ---------------------------------------------------------------------------

if ! command -v tmux >/dev/null 2>&1; then
	echo "== Tier 2: skipped (tmux not on PATH) =="
	echo "smoke: ALL TIERS PASSED (tier 1 only)"
	exit 0
fi

echo "== Tier 2: isolated tmux server =="

# Build an isolated TMUX_TMPDIR. tmux uses this for its socket directory;
# the pi-monitor child inherits the env var so its own tmux subprocess
# calls hit the isolated server, NOT the host's. We also unset TMUX so
# the child doesn't think it's already inside a tmux session before
# launch.
# tmux's default socket path with TMUX_TMPDIR=$X is $X/tmux-$UID/default,
# NOT $X/default. We DO NOT pass -S; instead we let tmux use its default
# socket location (driven by TMUX_TMPDIR) so invocations from inside the
# pi-monitor binary -- which don't pass -S -- resolve to the same socket.
ISO_TMPDIR=$(mktemp -d)

cleanup() {
	env -u TMUX TMUX_TMPDIR="$ISO_TMPDIR" tmux kill-server 2>/dev/null || true
	rm -rf "$ISO_TMPDIR"
}
trap cleanup EXIT INT TERM

run_iso() {
	# Run a tmux command against the isolated server. Sets TMUX_TMPDIR so
	# tmux resolves to $TMUX_TMPDIR/tmux-$UID/default; explicitly clears
	# TMUX so we don't confuse tmux about which client we're in.
	env -u TMUX TMUX_TMPDIR="$ISO_TMPDIR" tmux "$@"
}

# Start a long-lived keepalive session first so the server doesn't quit
# when the host session's command exits. tmux kills the server when its
# last session ends, and the bootstrap path terminates 'host' fast.
run_iso new-session -d -s keepalive -x 200 -y 50 "sleep 3600"

# Now start the host session running pi-monitor. The binary will detect
# it's NOT already in a 'monitor' session (session name = 'host') and
# bootstrap one; switchClientToMonitor will fail because no client is
# attached, but the monitor session is created -- which is what we
# verify next.
run_iso new-session -d -s host -x 200 -y 50 \
	"env -u TMUX TMUX_TMPDIR='$ISO_TMPDIR' '$NODE' '$CLI'; sleep 5"

# Wait up to 5 sec for the monitor session to appear in the isolated
# server.
attempts=0
while ! run_iso has-session -t monitor 2>/dev/null; do
	attempts=$((attempts + 1))
	if [[ $attempts -gt 50 ]]; then
		echo "smoke: monitor session never appeared. host pane:" >&2
		run_iso capture-pane -p -t host:0.0 || true
		fail "monitor session never created"
	fi
	sleep 0.1
done
pass "monitor session created in isolated server"

# Verify the monitor session has 2 panes (TUI on the left, right slot
# placeholder on the right). Bootstrap re-execs pi-monitor as the left
# pane's command, which then takes the inside-monitor path and renders
# the TUI. Give it another moment.
sleep 1.5
pane_count=$(run_iso list-panes -t monitor:0 | wc -l)
if [[ "$pane_count" -ne 2 ]]; then
	echo "smoke: expected 2 panes in monitor session, got $pane_count" >&2
	run_iso list-panes -t monitor:0 >&2 || true
	fail "monitor session pane count != 2"
fi
pass "monitor session has 2 panes"

# Capture the TUI pane and verify the title bar rendered.
tui_out=$(run_iso capture-pane -p -t monitor:0.0)
if ! echo "$tui_out" | grep -q "pi-monitor"; then
	echo "smoke: TUI pane output missing 'pi-monitor' title:" >&2
	echo "$tui_out" >&2
	fail "TUI title bar not rendered"
fi
pass "TUI title bar rendered in pane 0"

# Send 'q' to the TUI pane. App.handleQuit calls tmux.shutdown() which
# kills the monitor session; SIGHUP from tmux closes the pi-monitor
# process inside.
run_iso send-keys -t monitor:0.0 "q"

# Wait up to 5 sec for the monitor session to disappear.
attempts=0
while run_iso has-session -t monitor 2>/dev/null; do
	attempts=$((attempts + 1))
	if [[ $attempts -gt 50 ]]; then
		fail "monitor session did not shut down within 5s of 'q'"
	fi
	sleep 0.1
done
pass "monitor session shut down on 'q'"

echo "smoke: ALL TIERS PASSED"
