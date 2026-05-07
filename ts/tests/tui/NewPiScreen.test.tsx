/**
 * NewPiScreen tests. Covers Tab completion, Enter submission, Esc
 * cancellation, and the title swap between session/window modes.
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";

import { NewPiScreen } from "../../src/tui/NewPiScreen.js";
import type { ListDir } from "../../src/tui/dirComplete.js";

async function wait(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("NewPiScreen render", () => {
  it("shows the session-mode title", () => {
    const { lastFrame } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/home/u"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("Launch pi in a new tmux session");
  });

  it("shows the window-mode title", () => {
    const { lastFrame } = render(
      <NewPiScreen
        mode="window"
        defaultCwd="/home/u"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("Launch pi in a new window (current session)");
  });

  it("pre-fills the input with defaultCwd", () => {
    const { lastFrame } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/home/u/proj"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("/home/u/proj");
  });

  it("shows the Tab/Enter/Esc hint line", () => {
    const { lastFrame } = render(
      <NewPiScreen
        mode="session"
        defaultCwd=""
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Tab");
    expect(out).toContain("Enter");
    expect(out).toContain("Esc");
  });
});

describe("NewPiScreen behavior", () => {
  it("calls onCancel on Esc", async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/home/u"
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    await wait();
    // ESC = 0x1b.
    stdin.write("\u001b");
    await wait();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onSubmit({ mode, cwd }) on Enter with non-empty input", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/home/u"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith({
      mode: "session",
      cwd: "/home/u",
    });
  });

  it("calls onCancel (not onSubmit) on Enter when input is whitespace-only", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="   "
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows match candidates after Tab when there are multiple matches", async () => {
    const listDir: ListDir = (p) => {
      if (p === "/x") return ["alpha", "alphabet"];
      return [];
    };
    const { stdin, lastFrame } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/x/al"
        onSubmit={() => {}}
        onCancel={() => {}}
        listDir={listDir}
      />,
    );
    await wait();
    // Tab key.
    stdin.write("\t");
    await wait();
    const out = lastFrame() ?? "";
    expect(out).toContain("alpha");
    expect(out).toContain("alphabet");
  });

  it("auto-completes with trailing slash on a unique match", async () => {
    const listDir: ListDir = (p) => {
      if (p === "/x") return ["only-one"];
      return [];
    };
    const { stdin, lastFrame } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/x/on"
        onSubmit={() => {}}
        onCancel={() => {}}
        listDir={listDir}
      />,
    );
    await wait();
    stdin.write("\t");
    await wait();
    expect(lastFrame() ?? "").toContain("/x/only-one/");
  });
});
