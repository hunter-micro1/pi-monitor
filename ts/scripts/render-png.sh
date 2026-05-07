#!/usr/bin/env bash
# Render the App into an isolated tmux pane, capture the ANSI output,
# convert to HTML, and screenshot via Chrome headless. Output: a PNG
# at the path passed as $1 (default /tmp/pi-monitor-render.png).

set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${1:-/tmp/pi-monitor-render.png}"
NODE="${NODE:-node}"
HTML="/tmp/pi-monitor-render.html"

ISO=$(mktemp -d)
trap "env -u TMUX TMUX_TMPDIR=$ISO tmux kill-server 2>/dev/null; rm -rf $ISO" EXIT

run_iso() {
  env -u TMUX TMUX_TMPDIR="$ISO" tmux "$@"
}

# Keep the server alive after the snapshot pane exits.
run_iso new-session -d -s ka "sleep 3600"

# Run snapshot.tsx (which renders the App fixture and exits) inside a
# pane. When it exits we'll capture-pane the static frame.
run_iso new-session -d -s host -x 120 -y 30 \
  "env -u TMUX -u CI TMUX_TMPDIR='$ISO' pnpm tsx scripts/snapshot.tsx; sleep 2"

# Wait for the render to complete (snapshot.tsx prints its frame and
# the trailing 'sleep 2' keeps the pane alive long enough to capture).
sleep 2

# Capture with -e to preserve ANSI escape codes.
run_iso capture-pane -e -p -t host:0.0 > /tmp/pi-monitor-render.ansi

# Convert ANSI to HTML via a tiny node script.
"$NODE" -e '
const fs = require("node:fs");
const ansi = fs.readFileSync("/tmp/pi-monitor-render.ansi", "utf8");

// Minimal ANSI 24-bit + 256 + standard color converter. Handles the
// subset Ink emits (SGR sequences for fg/bg color + bold/dim).
const SGR = /\x1b\[([\d;]*)m/g;

let html = "";
let openSpans = 0;
let lastIdx = 0;

const STD = ["#000","#cd3131","#0dbc79","#e5e510","#2472c8","#bc3fbc","#11a8cd","#e5e5e5",
             "#666","#f14c4c","#23d18b","#f5f543","#3b8eea","#d670d6","#29b8db","#fff"];

// 256-color palette: 0-15 standard, 16-231 a 6x6x6 RGB cube, 232-255 grayscale.
const CUBE = [0, 95, 135, 175, 215, 255];
function xterm256(n) {
  if (n < 16) return STD[n];
  if (n < 232) {
    const i = n - 16;
    return `rgb(${CUBE[Math.floor(i/36)]},${CUBE[Math.floor((i%36)/6)]},${CUBE[i%6]})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

function reset() {
  let s = "";
  while (openSpans > 0) { s += "</span>"; openSpans -= 1; }
  return s;
}

function span(style) {
  openSpans += 1;
  return `<span style="${style}">`;
}

function consume(params) {
  // Empty params or just "0" => reset.
  if (params === "" || params === "0") return reset();
  let out = "";
  const parts = params.split(";").map(Number);
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (p === 0) { out += reset(); i++; continue; }
    if (p === 1) { out += span("font-weight:bold"); i++; continue; }
    if (p === 2) { out += span("opacity:0.6"); i++; continue; }
    if (p === 7) { out += span("filter:invert(1)"); i++; continue; }
    if (p >= 30 && p <= 37) { out += span(`color:${STD[p-30]}`); i++; continue; }
    if (p >= 90 && p <= 97) { out += span(`color:${STD[p-90+8]}`); i++; continue; }
    if (p === 38 && parts[i+1] === 2) {
      const [r,g,b] = [parts[i+2], parts[i+3], parts[i+4]];
      out += span(`color:rgb(${r},${g},${b})`);
      i += 5; continue;
    }
    if (p === 38 && parts[i+1] === 5) {
      out += span(`color:${xterm256(parts[i+2])}`);
      i += 3; continue;
    }
    if (p === 48 && parts[i+1] === 2) {
      const [r,g,b] = [parts[i+2], parts[i+3], parts[i+4]];
      out += span(`background-color:rgb(${r},${g},${b})`);
      i += 5; continue;
    }
    if (p === 48 && parts[i+1] === 5) {
      out += span(`background-color:${xterm256(parts[i+2])}`);
      i += 3; continue;
    }
    if (p === 39) { /* default fg */ i++; continue; }
    if (p === 49) { /* default bg */ i++; continue; }
    // Unhandled \u2014 advance.
    i++;
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let match;
while ((match = SGR.exec(ansi)) !== null) {
  html += escapeHtml(ansi.slice(lastIdx, match.index));
  html += consume(match[1]);
  lastIdx = match.index + match[0].length;
}
html += escapeHtml(ansi.slice(lastIdx));
html += reset();

const full = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body { background:#1a1b26; color:#c0caf5; font-family:"DejaVu Sans Mono","SF Mono",Menlo,monospace;
       font-size:14px; line-height:1.4; padding:16px; margin:0;
       white-space:pre; tab-size:8; }
</style></head><body>${html}</body></html>`;

fs.writeFileSync("'"$HTML"'", full);
console.log("html written");
'

# Screenshot via headless Chrome. --window-size + --hide-scrollbars +
# --force-device-scale-factor=2 for crispness.
google-chrome --headless --disable-gpu \
  --hide-scrollbars \
  --force-device-scale-factor=2 \
  --window-size=1100,520 \
  --screenshot="$OUT" \
  "file://$HTML" 2>/dev/null

echo "rendered: $OUT"
