import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../src/scan.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
const TESTS = join(ROOT, "tests");

// This walker is hand-rolled rather than the engine's, so it has none of
// walk()'s exclusions and will happily descend into anything under tests/.
// `pnpm test:e2e` leaves several GB of pinned clones — node_modules included —
// in tests/.e2e-cache/, which turned this guard into a five-second timeout on
// any machine that had ever run the e2e suite. Skipped here rather than in the
// caller because every future user of tsFiles wants the same thing: our own
// source, not a checkout of somebody else's.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name.startsWith(".") || SKIP_DIRS.has(e.name) ? [] : tsFiles(join(dir, e.name));
    return e.name.endsWith(".ts") ? [join(dir, e.name)] : [];
  });
}

// A literal NUL byte in a source file makes git, grep and file(1) treat the
// whole file as binary — and makes codeindex drop it from its own index,
// because readText's whole-buffer NUL sniff correctly reads a NUL as "binary".
//
// src/graph.ts used one as its internal EdgeKey separator and was therefore
// invisible to the tool it belongs to: 0 symbols, 0 lines, no diff, no grep
// hit, silently. The separator is written as an escape now, which is the same
// character at runtime. These tests pin the property for the whole source tree
// rather than for that one file.
describe("the engine's own sources stay indexable", () => {
  it("contains no literal NUL byte", () => {
    // Scans tests/ as well as src/, because the defect RECURRED there while this
    // guard was watching only src/: two engine modules and one test-oracle module
    // each grew a literal NUL as a Map-key separator. A guard whose scope is
    // narrower than the mistake is not a guard, and a `tests/` file read as
    // binary is just as invisible to git, grep and this engine as a `src/` one.
    // tests/fixtures/ is DATA, not source: a fixture is allowed to be exotic on
    // purpose (that is what makes it a fixture), so it is out of scope here.
    const offenders = [...tsFiles(SRC), ...tsFiles(TESTS).filter((f) => !f.includes(`${sep}fixtures${sep}`))]
      .filter((f) => readFileSync(f).includes(0))
      .map((f) => f.slice(ROOT.length));
    expect(offenders).toEqual([]);
  });

  it("yields symbols for every non-trivial engine module", () => {
    const scan = scanRepo(ROOT, {});
    const empty = scan.files
      .filter((f) => f.rel.startsWith("src/") && f.rel.endsWith(".ts") && f.size > 2000 && f.symbols.length === 0)
      .map((f) => f.rel);
    expect(empty).toEqual([]);
  });
});
