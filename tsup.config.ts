import { defineConfig } from "tsup";

// Two committed, reproducible artifacts (verified by `pnpm run check:build`):
//  - scripts/engine.mjs (+ engine.d.mts): the zero-dependency library bundle
//    consumers vendor; tsup inlines web-tree-sitter's JS, so the only optional
//    sidecar is scripts/grammars/ (wasm — regex tier without it).
//  - scripts/cli.mjs: the thin standalone CLI/MCP wrapper. The engine import
//    stays EXTERNAL (resolved to the sibling engine.mjs at runtime) so the
//    library is not duplicated inside the wrapper.
//
// A THIRD committed artifact, site/playground/engine.browser.mjs, is built by
// scripts/build-browser.mjs rather than from here. It needs to intercept the
// resolution of node builtins, and tsup registers its own node-protocol plugin
// ahead of user plugins — first onResolve result wins, so the interception has
// to own the plugin list outright. See that script for the full reasoning.
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
]);
