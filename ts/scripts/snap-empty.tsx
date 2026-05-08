/** Empty-state snapshot. */
import { render } from "ink-testing-library";
import { createElement } from "react";
import { App } from "../src/tui/App.js";

const { lastFrame } = render(
  createElement(App, {
    getEntries: () => [],
    branchForCwd: () => null,
    pollIntervalMs: 9999,
    pulseIntervalMs: 9999,
    notificationsEnabled: false,
  }),
);
setTimeout(() => {
  process.stdout.write(`${lastFrame() ?? ""}\n`);
  process.exit(0);
}, 100);
