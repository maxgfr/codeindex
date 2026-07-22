import { defineConfig } from "tsup";

// Bundles the engine into a single, dependency-free ESM file
// (scripts/engine.mjs) plus its type declarations (scripts/engine.d.mts).
// Consumers vendor those two files; tsup inlines web-tree-sitter's JS so the
// bundle needs no npm install — the only optional sidecar is scripts/grammars/
// (wasm), without which the engine runs on its regex tier. The committed bundle
// is verified reproducible in CI via `pnpm run check:build`.
export default defineConfig({
  entry: { engine: "src/engine.ts" },
  outDir: "scripts",
  format: ["esm"],
  outExtension: () => ({ js: ".mjs" }),
  target: "node18",
  platform: "node",
  bundle: true,
  dts: true,
  clean: false,
  minify: false,
  splitting: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
