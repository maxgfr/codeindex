import type { Graph, ModuleNode } from "./types.js";
import { isTestFile } from "./modules.js";
import { byStr } from "./sort.js";

// tests→code mapping, derived from the existing graph — NO new edge kind. The
// evidence is already there: a test file with a resolved import/call/use edge
// into a source file covers it (the same "depends on" kind set `impact` walks).
// Classifying test FILES and projecting the dependency edges through that
// classification keeps degree, Louvain, and the kind ranking untouched.

// Test-file detection by basename, per language convention. JS/TS reuses the
// tier logic's TEST_FILE regex via isTestFile; the rest are the conventional
// names: test_*.py / *_test.py, *_test.go, *Test(s).java|kt / *IT.java,
// *_spec.rb / *_test.rb, *Test.php, *Test(s).cs, *_test.exs.
const BASENAME_PATTERNS = [
  /^test_.*\.py$/i,
  /_test\.py$/i,
  /_test\.go$/,
  /(Test|Tests|IT)\.java$/,
  /(Test|Tests)\.kt$/,
  /_spec\.rb$/,
  /_test\.rb$/,
  /Test\.php$/,
  /(Test|Tests)\.cs$/,
  /_test\.exs$/,
];

// Directory rule: anything under a dedicated test dir is test material. This is
// deliberately NARROWER than the tier logic's TIER2_ANY — examples, docs,
// fixtures and benchmarks are tail, but they are not tests.
const TEST_DIR = /(^|\/)(tests?|__tests?__|spec|specs|e2e)(\/|$)/i;

// Is this repo-relative path a test file? Callers filter to code files; this
// only judges the path.
export function isTestPath(rel: string): boolean {
  if (TEST_DIR.test(rel)) return true;
  if (isTestFile(rel)) return true;
  const base = rel.split("/").pop()!;
  return BASENAME_PATTERNS.some((p) => p.test(base));
}

export interface TestMap {
  testFiles: Set<string>; // rels of code files classified as tests
  testedByFile: Map<string, string[]>; // source rel → sorted covering test rels
  testedByModule: Map<string, string[]>; // module slug → sorted covering test rels
}

// Project the graph's dependency edges through the test classification. A
// test→test edge (helpers, shared setup) is not coverage; neither is a doc-link
// or mention, nor anything dangling. O(F + E), fully deterministic.
export function computeTestMap(graph: Graph): TestMap {
  const testFiles = new Set<string>();
  const moduleOf = new Map<string, string>();
  for (const f of graph.files) {
    moduleOf.set(f.rel, f.module);
    if (f.fileKind === "code" && isTestPath(f.rel)) testFiles.add(f.rel);
  }

  const byFile = new Map<string, Set<string>>();
  const byModule = new Map<string, Set<string>>();
  for (const e of graph.fileEdges) {
    if (e.dangling) continue;
    if (e.kind !== "import" && e.kind !== "use" && e.kind !== "call") continue;
    if (!testFiles.has(e.from) || testFiles.has(e.to)) continue;
    let set = byFile.get(e.to);
    if (!set) byFile.set(e.to, (set = new Set()));
    set.add(e.from);
    const slug = moduleOf.get(e.to);
    if (slug !== undefined) {
      let mset = byModule.get(slug);
      if (!mset) byModule.set(slug, (mset = new Set()));
      mset.add(e.from);
    }
  }

  const sortSets = (m: Map<string, Set<string>>): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const key of [...m.keys()].sort(byStr)) out.set(key, [...m.get(key)!].sort(byStr));
    return out;
  };
  return { testFiles, testedByFile: sortSets(byFile), testedByModule: sortSets(byModule) };
}

// Covering tests for one module: the stored build-time field when present,
// recomputed from the graph otherwise (older graphs, hand-built test literals).
export function testsForModule(graph: Graph, slug: string): string[] {
  const m = graph.modules.find((x) => x.slug === slug);
  if (m?.testedBy) return m.testedBy;
  return computeTestMap(graph).testedByModule.get(slug) ?? [];
}

// Modules that SHOULD have tests but don't: tier ≤ 1, at least one non-test
// code member, declared symbols, and no covering test. Doc-only and tail
// modules are out of scope by construction.
export function untestedModules(graph: Graph): ModuleNode[] {
  const tm = computeTestMap(graph);
  const codeMembers = new Map<string, number>();
  for (const f of graph.files) {
    if (f.fileKind !== "code" || tm.testFiles.has(f.rel)) continue;
    codeMembers.set(f.module, (codeMembers.get(f.module) ?? 0) + 1);
  }
  return graph.modules.filter(
    (m) => m.tier <= 1 && m.symbols > 0 && (codeMembers.get(m.slug) ?? 0) > 0 && !tm.testedByModule.has(m.slug),
  );
}
