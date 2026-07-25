import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../src/scan.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
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
    const offenders = tsFiles(SRC)
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
