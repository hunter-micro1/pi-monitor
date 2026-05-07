/**
 * NotificationBanner snapshot tests. Pure presentation; auto-dismiss
 * behavior is owned by App and covered in App.test.tsx.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { NotificationBanner } from "../../src/tui/NotificationBanner.js";

describe("NotificationBanner", () => {
  it("renders title + body separated by a centered dot", () => {
    const { lastFrame } = render(
      <NotificationBanner
        notification={{
          title: "pi-monitor \u00b7 %17",
          body: "agent state: idle",
          severity: "normal",
        }}
      />,
    );
    const out = lastFrame() ?? "";
    expect(out).toContain("pi-monitor");
    expect(out).toContain("%17");
    expect(out).toContain("agent state: idle");
  });

  it("uses a rounded border", () => {
    const { lastFrame } = render(
      <NotificationBanner
        notification={{
          title: "x",
          body: "y",
          severity: "normal",
        }}
      />,
    );
    expect(lastFrame() ?? "").toMatch(/[\u256d\u256e\u2570\u256f]/);
  });

  it("renders without throwing for both severities", () => {
    expect(() =>
      render(
        <NotificationBanner
          notification={{ title: "a", body: "b", severity: "normal" }}
        />,
      ),
    ).not.toThrow();
    expect(() =>
      render(
        <NotificationBanner
          notification={{ title: "a", body: "b", severity: "critical" }}
        />,
      ),
    ).not.toThrow();
  });
});
