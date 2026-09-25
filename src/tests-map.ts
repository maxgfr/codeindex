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
  return TEST_DIR.test(rel) || isTestCaseFile(rel);
}

// Is the FILE ITSELF a test by its name (test_x.py, x_test.go, x.test.ts…)?
// Narrower than isTestPath: a helper under tests/ is test material, but only a
// test-case file is a leaf nothing else calls into.
export function isTestCaseFile(rel: string): boolean {
  if (isTestFile(rel)) return true;
  const base = rel.split("/").pop()!;
  return BASENAME_PATTERNS.some((p) => p.test(base));
}

export interface TestMap {
  testFiles: Set<string>; // rels of code files classified as tests
  testedByFile: Map<string, string[]>; // source rel → sorted covering test rels
  testedByModule: Map<string, string[]>; // module slug → sorted covering test rels
}

// A test NAMED after its subject, in the same directory: `x.test.ts` /
// `x.spec.ts` (or `__tests__/x.test.ts`) → `x.ts`, `test_x.py` / `x_test.py` →
// `x.py`, `x_test.go` → `x.go`, `x_spec.rb` → `x.rb`, `XTest.java` → `X.java`
// (and Maven's src/test ↔ src/main mirror). The candidate paths; the caller
// keeps those that exist.
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
function testSubjects(rel: string): string[] {
  const slash = rel.lastIndexOf("/");
  const dir = slash === -1 ? "" : rel.slice(0, slash + 1);
  const base = rel.slice(slash + 1);
  let m: RegExpExecArray | null;
  if ((m = /^(.+)\.(?:test|spec)(\.[cm]?[jt]sx?)$/.exec(base))) {
    const dirs = [dir];
    // Jest's `__tests__/x.test.ts` sits one level below `x.ts`.
    if (/(^|\/)__tests__\/$/.test(dir)) dirs.push(dir.slice(0, -"__tests__/".length));
    return dirs.flatMap((d) => [m![2]!, ...JS_EXTS.filter((e) => e !== m![2])].map((e) => d + m![1] + e));
  }
  if ((m = /^test_(.+)\.py$/.exec(base) ?? /^(.+)_test\.py$/.exec(base))) return [dir + m[1] + ".py"];
  if ((m = /^(.+)_test\.go$/.exec(base))) return [dir + m[1] + ".go"];
  if ((m = /^(.+)_(?:spec|test)\.rb$/.exec(base))) return [dir + m[1] + ".rb"];
  if ((m = /^(.+?)(?:Tests?|IT)\.(java|kt)$/.exec(base))) {
    const own = dir + m[1] + "." + m[2];
    const main = own.replace(/(^|\/)src\/test\//, "$1src/main/");
    return main === own ? [own] : [own, main];
  }
  return [];
}

// Project the graph's dependency edges through the test classification. A
// test→test edge (helpers, shared setup) is not coverage; neither is a doc-link
// or mention, nor anything dangling. Two more kinds of evidence need no edge:
// a test named after its subject (testSubjects) covers it, and a Go `_test.go`
// file — compiled INTO its package — covers every non-test file of its
// directory: gin's render_test.go exercises render.go through the Render
// interface, and path_test.go the unexported cleanPath. O(F + E), fully
// deterministic.
export function computeTestMap(graph: Graph): TestMap {
  const testFiles = new Set<string>();
  const moduleOf = new Map<string, string>();
  const sources = new Set<string>(); // non-test code files
  const goSources = new Map<string, string[]>(); // dir → its non-test .go files
  for (const f of graph.files) {
    moduleOf.set(f.rel, f.module);
    if (f.fileKind !== "code") continue;
    if (isTestPath(f.rel)) {
      testFiles.add(f.rel);
      continue;
    }
    sources.add(f.rel);
    if (f.rel.endsWith(".go")) {
      const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
      const list = goSources.get(dir);
      if (list) list.push(f.rel);
      else goSources.set(dir, [f.rel]);
    }
  }

  const byFile = new Map<string, Set<string>>();
  const byModule = new Map<string, Set<string>>();
  const cover = (test: string, source: string): void => {
    let set = byFile.get(source);
    if (!set) byFile.set(source, (set = new Set()));
    set.add(test);
    const slug = moduleOf.get(source);
    if (slug !== undefined) {
      let mset = byModule.get(slug);
      if (!mset) byModule.set(slug, (mset = new Set()));
      mset.add(test);
    }
  };
  for (const e of graph.fileEdges) {
    if (e.dangling) continue;
    if (e.kind !== "import" && e.kind !== "use" && e.kind !== "call") continue;
    if (!testFiles.has(e.from) || testFiles.has(e.to)) continue;
    cover(e.from, e.to);
  }
  for (const t of testFiles) {
    for (const s of testSubjects(t)) if (sources.has(s)) cover(t, s);
    if (t.endsWith("_test.go")) {
      const dir = t.includes("/") ? t.slice(0, t.lastIndexOf("/")) : "";
      for (const s of goSources.get(dir) ?? []) cover(t, s);
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
