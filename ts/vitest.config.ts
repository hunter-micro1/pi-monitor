import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live next to or beneath src/ as `*.test.ts`. Phase-1 logic
    // ports + phase-4 TUI snapshot tests will both go in `tests/`.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    globals: false,
    // Vitest's default reporter is fine; we don't need anything fancier
    // until the suite grows.
    reporters: ["default"],
  },
});
