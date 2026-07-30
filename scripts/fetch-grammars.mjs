// Dev-time only: vendor the tree-sitter grammar wasms + the web-tree-sitter
// runtime wasm from node_modules into scripts/grammars/, which is COMMITTED so
// the skill runs with `node` alone (no npm install, no network). Re-run after
// bumping a tree-sitter-* devDependency:  node scripts/fetch-grammars.mjs
//
// The engine bundles the web-tree-sitter JS at build time (tsup inlines it), so
// these packages stay devDependencies — nothing here is needed at skill-use time
// except the committed wasm bytes. copy-bundle.mjs mirrors scripts/grammars/ into
// the skill dir; check:build proves both copies are reproducible.
//
// TWO TIERS.
//
//   CORE      committed to git (scripts/grammars/). Every consumer gets these
//             with no network and no install, which is the whole vendoring model.
//   EXTENDED  NOT committed (scripts/grammars-extended/, gitignored). Written by
//             `node scripts/fetch-grammars.mjs --extended` and packaged into the
//             per-release `grammars-<version>.tar.gz` asset, so they arrive via
//             `codeindex grammars pull` instead of via the repo.
//
// The split exists because these six add ~6.7 MiB of wasm for languages most
// repos do not contain. Committing them would grow the repo and every vendoring
// consumer's checkout for a benefit only some of them can use; without a pull
// they are simply absent, and the engine falls back to the regex tier exactly as
// it does today for any language with no grammar.
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);
const nm = join(repoRoot, "node_modules");
const outDir = join(scriptsDir, "grammars");
const extDir = join(scriptsDir, "grammars-extended");

// Canonical language key -> source wasm under node_modules. The key is the file
// name the loader looks up (grammars/<key>.wasm), so it is part of the on-disk
// contract; keep it stable across grammar version bumps.
const CORE = {
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
  scala: "tree-sitter-scala/tree-sitter-scala.wasm",
  bash: "tree-sitter-bash/tree-sitter-bash.wasm",
  lua: "@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm",
};

// Pull-only tier. Languages with a published wasm but no room in the committed
// set. NOTE on what is NOT here: Swift and Markdown publish no prebuilt wasm on
// npm at all (only grammar sources), so they stay on the regex tier; and the
// config/markup grammars (json, yaml, toml, html, css) were left out
// deliberately — they parse cleanly but declare nothing an agent would look up
// by name, so they would cost wasm weight for no symbol recall.
//
// Dart is also absent, for a harder reason: `tree-sitter-dart` DOES publish a
// wasm, but web-tree-sitter 0.26 cannot load it (Language.load rejects — an ABI
// mismatch). Shipping it would put 742 KiB in the asset that never loads and
// advertise AST support that silently degrades, so Dart gets a regex extractor
// (src/lang/dart.ts) instead. Revisit when the grammar republishes.
const EXTENDED = {
  kotlin: "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
  elixir: "tree-sitter-elixir/tree-sitter-elixir.wasm",
  zig: "@tree-sitter-grammars/tree-sitter-zig/tree-sitter-zig.wasm",
  hcl: "@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-hcl.wasm",
  terraform: "@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-terraform.wasm",
  solidity: "tree-sitter-solidity/tree-sitter-solidity.wasm",
};

const RUNTIME = "web-tree-sitter/web-tree-sitter.wasm";

// `--extended` writes the pull-only tier instead of the committed one. Two
// separate dirs, never mixed: `check:build` diffs scripts/grammars against git,
// and a stray extended wasm in there would fail it on every machine that ran the
// flag.
const extended = process.argv.includes("--extended");
const grammars = extended ? EXTENDED : CORE;
const targetDir = extended ? extDir : outDir;

function copyInto(name, rel) {
  const src = join(nm, rel);
  const dst = join(targetDir, name);
  copyFileSync(src, dst);
  return statSync(dst).size;
}

// Rebuild the dir from scratch so a removed grammar never lingers.
rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });

let total = 0;
const rows = [];
for (const [key, rel] of Object.entries(grammars)) {
  const size = copyInto(`${key}.wasm`, rel);
  total += size;
  rows.push([`${key}.wasm`, size]);
}
// The runtime ships with the COMMITTED tier only: the extended tarball is
// extracted into the same cache dir, where the core runtime already sits, and a
// second copy would just be dead bytes in the asset.
if (!extended) {
  const rtSize = copyInto("web-tree-sitter.wasm", RUNTIME);
  total += rtSize;
  rows.push(["web-tree-sitter.wasm (runtime)", rtSize]);
}

process.stdout.write(`${extended ? "EXTENDED (pull-only)" : "CORE (committed)"}\n`);
for (const [name, size] of rows) {
  process.stdout.write(`${name.padEnd(34)} ${(size / 1024).toFixed(0).padStart(6)} KiB\n`);
}
process.stdout.write(`${"TOTAL".padEnd(34)} ${(total / 1048576).toFixed(2).padStart(6)} MiB\n`);

// Sanity: exactly the expected file count, nothing stray.
const written = readdirSync(targetDir).filter((f) => f.endsWith(".wasm"));
const expected = Object.keys(grammars).length + (extended ? 0 : 1);
if (written.length !== expected) {
  process.stderr.write(`fetch-grammars: expected ${expected} wasm files, wrote ${written.length}\n`);
  process.exit(1);
}
