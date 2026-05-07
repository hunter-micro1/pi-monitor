# pi-monitor (TypeScript port)

This directory holds the in-progress TypeScript rewrite of pi-monitor.
The canonical install through 0.3.x is the Python build at the repo
root (`src/pi_monitor/`); this directory is what 0.4.0+ will ship as.

For the rewrite plan and phase-by-phase roadmap, see
[`../docs/REWRITE_PLAN.md`](../docs/REWRITE_PLAN.md).

## Status

Phase 0 — scaffold only. `pnpm dev` prints a banner and exits 0.
Real functionality lands across phases 1–5; track progress in the
plan doc.

## Dev

```bash
cd ts
pnpm install
pnpm dev          # run the cli (currently just prints a banner)
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm check        # biome lint + format check
pnpm format       # biome --write to fix lint/format issues
pnpm build        # tsup bundle to ./dist
```

## Tooling

- **Runtime:** Node 20 LTS
- **Language:** TypeScript 5.x (strict mode)
- **TUI:** Ink 5 (added in phase 4; not yet a dep)
- **Tests:** Vitest + ink-testing-library (phase 4)
- **Lint/format:** Biome 1.9
- **Bundler:** tsup
- **Package manager:** pnpm 10

The choices are pinned in [`../docs/REWRITE_PLAN.md`](../docs/REWRITE_PLAN.md).
Switching mid-port is expensive; please raise it as a follow-up
discussion before changing any of the above.
