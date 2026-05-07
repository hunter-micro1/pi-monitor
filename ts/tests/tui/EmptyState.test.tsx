/**
 * EmptyState welcome-card snapshot tests.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { EmptyState } from "../../src/tui/EmptyState.js";

describe("EmptyState", () => {
  it("renders the welcome heading", () => {
    const { lastFrame } = render(<EmptyState />);
    expect(lastFrame() ?? "").toContain("No pi sessions yet");
  });

  it("documents the o + ? key bindings inline", () => {
    const { lastFrame } = render(<EmptyState />);
    const out = lastFrame() ?? "";
    expect(out).toContain("Press");
    expect(out).toContain("o");
    expect(out).toContain("launch a new agent");
    expect(out).toContain("?");
    expect(out).toContain("see all keybindings");
  });
});
