import { defineConfig } from "tsup";

export default defineConfig({
  // Single-entry CLI bundle. tsup outputs an ESM file with a shebang
  // so `chmod +x dist/cli.js` + `npm install -g pi-monitor` puts the
  // executable on PATH.
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Keep the bundle tiny for startup speed; tree-shake everything we
  // don't use. We're a CLI, not a long-running server, so cold-start
  // matters more than build cache.
  treeshake: true,
  splitting: false,
  // Add the `#!/usr/bin/env node` shebang to the output so the
  // package.json `bin` entry works without an explicit interpreter.
  banner: { js: "#!/usr/bin/env node" },
});
