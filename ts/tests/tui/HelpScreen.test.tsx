/**
 * HelpScreen + help data tests.
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { HelpScreen } from "../../src/tui/HelpScreen.js";
import { HELP_SECTIONS } from "../../src/tui/helpData.js";

async function wait(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("HELP_SECTIONS", () => {
  it("documents every major action group", () => {
    const headers = HELP_SECTIONS.map((s) => s.header);
    expect(headers).toEqual([
      "Navigation",
      "Interact",
      "Spawn",
      "View",
      "Notifications",
      "Exit",
    ]);
  });

  it("every row has a non-empty key + description", () => {
    for (const section of HELP_SECTIONS) {
      expect(section.rows.length).toBeGreaterThan(0);
      for (const row of section.rows) {
        expect(row.key).not.toBe("");
        expect(row.desc).not.toBe("");
      }
    }
  });

  it("includes the q + ? Exit shortcuts", () => {
    const exit = HELP_SECTIONS.find((s) => s.header === "Exit");
    expect(exit?.rows.map((r) => r.key)).toEqual(["q", "?"]);
  });
});

describe("HelpScreen", () => {
  it("renders the title + every section header", () => {
    const { lastFrame } = render(<HelpScreen onDismiss={() => {}} />);
    const out = lastFrame() ?? "";
    expect(out).toContain("pi-monitor");
    expect(out).toContain("keybindings");
    for (const section of HELP_SECTIONS) {
      expect(out).toContain(section.header);
    }
  });

  it("renders the dismiss hint", () => {
    const { lastFrame } = render(<HelpScreen onDismiss={() => {}} />);
    expect(lastFrame() ?? "").toContain("press any key to dismiss");
  });

  it("renders every keybinding row", () => {
    const { lastFrame } = render(<HelpScreen onDismiss={() => {}} />);
    const out = lastFrame() ?? "";
    // Long descriptions can soft-wrap inside the 64-col card; assert
    // on the first 30 chars so the test pins data presence without
    // depending on Ink's wrap point.
    for (const section of HELP_SECTIONS) {
      for (const row of section.rows) {
        const head = row.desc.slice(0, 30);
        expect(out).toContain(head);
      }
    }
  });

  it("calls onDismiss on any keystroke", async () => {
    const onDismiss = vi.fn();
    const { stdin } = render(<HelpScreen onDismiss={onDismiss} />);
    await wait();
    stdin.write("x");
    await wait();
    expect(onDismiss).toHaveBeenCalled();
  });
});
