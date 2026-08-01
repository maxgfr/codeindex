#!/usr/bin/env node
// Builds scripts/engine.browser.mjs — the SAME engine as scripts/engine.mjs,
// resolved against browser shims instead of node builtins. Committed like the
// other artifacts and held byte-reproducible by `pnpm run check:build`.
//
// It lives in scripts/ rather than in the site because it is a PUBLISHED
// artifact: npm consumers import it as `@maxgfr/codeindex/browser`. The Pages
// deploy copies it into site/playground/ alongside the grammars, which keeps
// GitHub Pages a plain static publish and keeps one generated file in git
// instead of two copies of it.
//
// WHY NOT A THIRD tsup TARGET. This build's whole job is to intercept the
// resolution of node builtins, and tsup registers its own node-protocol plugin
// ahead of any user plugin. esbuild takes the FIRST onResolve result, so tsup's
// plugin wins and resolves `node:fs` to an external bare "fs". The build still
// succeeds; the output just carries `import { readFileSync } from "fs"`
// statements that no browser can load — and that Node satisfies from the real
// disk, so it fails silently rather than loudly. Owning the plugin list here
// removes that ordering hazard entirely.
//
// Determinism: esbuild is pinned in package.json and its output is a pure
// function of (input, options), so two builds of an unchanged tree are
// byte-identical — the same property check:build already enforces for the Node
// artifacts.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const shim = (name) => join(root, "src", "browser", `${name}.ts`);

// Node builtins the engine imports. Matched under both spellings because the
// source is not uniform about the `node:` prefix and third-party code inside
// the bundle (web-tree-sitter) uses the bare form.
const BUILTINS = "fs|path|crypto|os|url|child_process|worker_threads|readline|zlib";

const browserShims = {
  name: "browser-shims",
  setup(build) {
    // `namespace: "file"` is load-bearing, not decoration. A plugin-resolved
    // path with no namespace gets a DIFFERENT module identity from the same
    // file reached by ordinary relative resolution — so src/browser/fs.ts would
    // be instantiated twice: once for `node:fs` (what walk.ts reads) and once
    // for `./fs.js` (what the playground's mount API writes). Two instances
    // means two VFS maps, and every mount would land in a filesystem the engine
    // cannot see.
    build.onResolve({ filter: new RegExp(`^(node:)?(${BUILTINS})$`) }, (args) => ({
      path: shim(args.path.replace(/^node:/, "")),
      namespace: "file",
    }));

    // web-tree-sitter probes for a Node environment before falling back to its
    // fetch/XHR loaders. That branch is dead here — ENVIRONMENT_IS_NODE is
    // false in a browser, and ensureGrammars hands the runtime an explicit
    // wasmBinary so it never reaches for a loader at all — but esbuild still
    // has to resolve the specifiers statically. Empty modules satisfy it
    // without pulling any of Node's machinery into the bundle.
    build.onResolve({ filter: /^(node:)?(fs[/]promises|module)$/ }, () => ({ path: "node-only", namespace: "browser-empty" }));
    build.onLoad({ filter: /.*/, namespace: "browser-empty" }, () => ({
      contents: "export const createRequire = () => { throw new Error('node-only API in the browser build'); };\nexport default {};\n",
      loader: "js",
    }));
  },
};

const outfile = join(root, "scripts", "engine.browser.mjs");

await build({
  entryPoints: [join(root, "src", "browser", "entry.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  // Minified because this artifact is served over the wire to a browser rather
  // than vendored into a repo, where the Node bundle's readability matters.
  minify: true,
  sourcemap: false,
  legalComments: "none",
  plugins: [browserShims],
  // Buffer and process are free identifiers in the engine source (walk.ts's
  // decoder, loader.ts's env reads). Injection substitutes both without editing
  // a line of that source.
  inject: [shim("globals")],
});

console.log(`build-browser: ${outfile}`);
