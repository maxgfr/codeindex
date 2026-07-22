// Dev-time only: vendor the tree-sitter grammar wasms + the web-tree-sitter
// runtime wasm from node_modules into scripts/grammars/, which is COMMITTED so
// the skill runs with `node` alone (no npm install, no network). Re-run after
// bumping a tree-sitter-* devDependency:  node scripts/fetch-grammars.mjs
//
// The engine bundles the web-tree-sitter JS at build time (tsup inlines it), so
// these packages stay devDependencies — nothing here is needed at skill-use time
// except the committed wasm bytes. copy-bundle.mjs mirrors scripts/grammars/ into
// the skill dir; check:build proves both copies are reproducible.
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
const nm = join(repoRoot, "node_modules");
const outDir = join(scriptsDir, "grammars");

// Canonical language key -> source wasm under node_modules. The key is the file
// name the loader looks up (grammars/<key>.wasm), so it is part of the on-disk
// contract; keep it stable across grammar version bumps.
const GRAMMARS = {
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  python: "tree-sitter-python/tree-sitter-python.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  rust: "tree-sitter-rust/tree-sitter-rust.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
  c: "tree-sitter-c/tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp/tree-sitter-cpp.wasm",
  c_sharp: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  ruby: "tree-sitter-ruby/tree-sitter-ruby.wasm",
  php: "tree-sitter-php/tree-sitter-php.wasm",
};
const RUNTIME = "web-tree-sitter/web-tree-sitter.wasm";

function copyInto(name, rel) {
  const src = join(nm, rel);
  const dst = join(outDir, name);
  copyFileSync(src, dst);
  return statSync(dst).size;
}

// Rebuild the dir from scratch so a removed grammar never lingers.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let total = 0;
const rows = [];
for (const [key, rel] of Object.entries(GRAMMARS)) {
  const size = copyInto(`${key}.wasm`, rel);
  total += size;
  rows.push([`${key}.wasm`, size]);
}
const rtSize = copyInto("web-tree-sitter.wasm", RUNTIME);
total += rtSize;
rows.push(["web-tree-sitter.wasm (runtime)", rtSize]);

for (const [name, size] of rows) {
  process.stdout.write(`${name.padEnd(34)} ${(size / 1024).toFixed(0).padStart(6)} KiB\n`);
}
process.stdout.write(`${"TOTAL".padEnd(34)} ${(total / 1048576).toFixed(2).padStart(6)} MiB\n`);

// Sanity: exactly the expected file count, nothing stray.
const written = readdirSync(outDir).filter((f) => f.endsWith(".wasm"));
const expected = Object.keys(GRAMMARS).length + 1;
if (written.length !== expected) {
  process.stderr.write(`fetch-grammars: expected ${expected} wasm files, wrote ${written.length}\n`);
  process.exit(1);
}
