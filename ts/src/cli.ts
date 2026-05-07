/**
 * pi-monitor — TypeScript rewrite, phase 0 (scaffold only).
 *
 * Right now this just prints a banner and exits 0. The real
 * implementation lands across phases 1–5; see `docs/REWRITE_PLAN.md`
 * at the repo root.
 *
 * No shebang in source: tsup's `banner.js` injects `#!/usr/bin/env
 * node` at bundle time, so the published `dist/cli.js` has it. If we
 * also wrote one here we'd end up with a duplicate at the top of the
 * bundle and Node would refuse to parse it as JavaScript.
 */

const VERSION = "0.4.0-alpha.0";

function main(): number {
  // Keep this minimal: any setup code that lands here must be
  // idempotent and safe to run before the TUI is wired up. Real
  // entry-point work (signal handlers, term-mode setup, App.run)
  // lands in phase 5.
  process.stdout.write(
    `pi-monitor ${VERSION} (TypeScript port, in progress)\nPhase 0 scaffold — see docs/REWRITE_PLAN.md for the roadmap.\n`,
  );
  return 0;
}

process.exitCode = main();
