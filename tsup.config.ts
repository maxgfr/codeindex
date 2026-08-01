import { defineConfig } from "tsup";

// Two committed, reproducible artifacts (verified by `pnpm run check:build`):
//  - scripts/engine.mjs (+ engine.d.mts): the zero-dependency library bundle
//    consumers vendor; tsup inlines web-tree-sitter's JS, so the only optional
//    sidecar is scripts/grammars/ (wasm — regex tier without it).
//  - scripts/cli.mjs: the thin standalone CLI/MCP wrapper. The engine import
//    stays EXTERNAL (resolved to the sibling engine.mjs at runtime) so the
//    library is not duplicated inside the wrapper.
//  - scripts/engine.browser.mjs (+ engine.browser.d.mts): the same engine
//    resolved against browser shims, published as `@maxgfr/codeindex/browser`.
//    Its JAVASCRIPT is built by scripts/build-browser.mjs, not here: that build
//    has to intercept the resolution of node builtins, and tsup registers its
//    own node-protocol plugin ahead of user plugins — first onResolve result
//    wins, so the interception has to own the plugin list outright. Its TYPES
//    are emitted here, because they are ordinary TypeScript declarations with
//    no such constraint, and hand-writing them would guarantee drift.
export default defineConfig([
  {
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
  },
  {
    entry: { cli: "src/cli-entry.ts" },
    outDir: "scripts",
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    target: "node18",
    platform: "node",
    bundle: true,
    dts: false,
    clean: false,
    minify: false,
    splitting: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    esbuildPlugins: [
      {
        name: "external-engine",
        setup(build) {
          build.onResolve({ filter: /^\.\/engine\.js$/ }, () => ({ path: "./engine.mjs", external: true }));
        },
      },
    ],
  },
  {
    // Declarations only — the JS for this entry comes from
    // scripts/build-browser.mjs. Same public surface as engine.d.mts plus the
    // VFS and grammar-loading API the browser build adds.
    entry: { "engine.browser": "src/browser/entry.ts" },
    outDir: "scripts",
    format: ["esm"],
    dts: { only: true },
    clean: false,
  },
]);
