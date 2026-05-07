/**
 * Keybinding help text, organized into sections. Mirrors
 * `HELP_SECTIONS` in `tui.py`. The `HelpScreen` component renders
 * this directly; tests pin the structure so accidentally dropping a
 * section is caught.
 */

export interface HelpRow {
  readonly key: string;
  readonly desc: string;
}

export interface HelpSection {
  readonly header: string;
  readonly rows: readonly HelpRow[];
}

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    header: "Navigation",
    rows: [
      { key: "j / \u2193", desc: "down" },
      { key: "k / \u2191", desc: "up" },
      { key: "h / \u2190", desc: "previous session" },
      { key: "l / \u2192", desc: "next session" },
      { key: "g / G", desc: "top / bottom" },
      { key: "1\u20139", desc: "jump to Nth pane" },
    ],
  },
  {
    header: "Interact",
    rows: [
      {
        key: "j / k",
        desc: "hover previews the agent live in the right pane",
      },
      {
        key: "Enter",
        desc: "commit \u2014 focus the right pane so keys go to the agent",
      },
      { key: "Tab", desc: "same as Enter for a pane row" },
      { key: "prefix+\u2190", desc: "tmux nav back to the tree pane" },
      { key: "C-a z", desc: "inner viewer: unzoom to see siblings" },
      {
        key: 'C-a " / %',
        desc: "inner viewer: split inside the right slot",
      },
    ],
  },
  {
    header: "Spawn",
    rows: [{ key: "o", desc: "new session (on +) or new window (on a pane)" }],
  },
  {
    header: "View",
    rows: [
      { key: "t", desc: "cycle theme" },
      { key: "s", desc: "cycle sort: tmux \u2194 needs-attention-first" },
      { key: "Shift+H", desc: "toggle non-pi panes" },
      { key: "r", desc: "force refresh" },
    ],
  },
  {
    header: "Notifications",
    rows: [{ key: "m", desc: "mute / unmute (desktop + in-app toasts)" }],
  },
  {
    header: "Exit",
    rows: [
      { key: "q", desc: "kill monitor session + all viewers" },
      { key: "?", desc: "toggle this help" },
    ],
  },
];
