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
      // 0.4.19: Session-name field auto-pre-filled from cwd
      // basename. Default render still submits 'u' as the name
      // when the user doesn't touch the name field.
      name: "u",
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

// ---------------------------------------------------------------------------
// 0.4.19: Session-name field + Tab cycling.
// ---------------------------------------------------------------------------

describe("NewPiScreen session-name field", () => {
  it("renders a Session-name field in session mode pre-filled with the cwd basename", () => {
    const { lastFrame } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/home/u/Projects/foo"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("Session name");
    expect(out).toContain("foo");
  });

  it("hides the Session-name field in window mode", () => {
    const { lastFrame } = render(
      <NewPiScreen
        mode="window"
        defaultCwd="/home/u/Projects/foo"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("Session name");
  });

  it("submits the auto-derived name when the user doesn't touch the name field", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/home/u/Projects/contracts"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith({
      mode: "session",
      cwd: "/home/u/Projects/contracts",
      name: "contracts",
    });
  });

  it("Tab from the cwd field cycles to the name field when no completion is possible", async () => {
    const listDir: ListDir = () => [];
    const onSubmit = vi.fn();
    const { stdin } = render(
      <NewPiScreen
        mode="session"
        defaultCwd="/home/u/Projects/foo"
        onSubmit={onSubmit}
        onCancel={() => {}}
        listDir={listDir}
      />,
    );
    await wait();
    // First Tab: completion is empty (listDir returns []), so
    // focus cycles to the name field.
    stdin.write("\t");
    await wait();
    // Type a custom name; with focus now on the name field, the
    // bytes flow into it instead of the cwd field.
    stdin.write("custom-name");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith({
      mode: "session",
      cwd: "/home/u/Projects/foo",
      // Original auto-derived name is "foo"; user appended
      // "custom-name", giving "foocustom-name".
      name: "foocustom-name",
    });
  });

  it("window mode submits with empty name field (no Session-name UI)", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <NewPiScreen
        mode="window"
        defaultCwd="/home/u/Projects/foo"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await wait();
    stdin.write("\r");
    await wait();
    expect(onSubmit).toHaveBeenCalledWith({
      mode: "window",
      cwd: "/home/u/Projects/foo",
      name: "",
    });
  });
});

describe("deriveSessionName", () => {
  // Re-import is cleaner than poking the rendered DOM.
  it("returns the basename of the path", async () => {
    const { deriveSessionName } = await import("../../src/tui/NewPiScreen.js");
    expect(deriveSessionName("/home/u/Projects/foo")).toBe("foo");
  });

  it("strips trailing slashes", async () => {
    const { deriveSessionName } = await import("../../src/tui/NewPiScreen.js");
    expect(deriveSessionName("/home/u/Projects/foo/")).toBe("foo");
    expect(deriveSessionName("/home/u/Projects/foo///")).toBe("foo");
  });

  it("falls back to 'pi' for empty / root cwds", async () => {
    const { deriveSessionName } = await import("../../src/tui/NewPiScreen.js");
    expect(deriveSessionName("")).toBe("pi");
    expect(deriveSessionName("/")).toBe("pi");
  });
});
