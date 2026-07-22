import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan.js";
import { buildCallerIndex, enclosingSymbol } from "../src/callers.js";
import { categorize } from "../src/categorize.js";
import { detectWorkspaces } from "../src/workspaces.js";
import { gitChurn, changedSince } from "../src/git.js";
import { changeCoupling, rankHotspots } from "../src/coupling.js";
import { renderRepoMap } from "../src/repomap.js";
import { symbolsOverview, findSymbol, findReferences } from "../src/query.js";
import { replaceSymbolBody, insertAfterSymbol, insertBeforeSymbol, resolveUniqueSymbol } from "../src/edit.js";
import { writeMemory, readMemory, deleteMemory, listMemories } from "../src/memory.js";
import { readText as engineRead } from "../src/walk.js";
import { findDeadCode } from "../src/deadcode.js";
import { symbolComplexity, riskHotspots } from "../src/complexity.js";
import { renderMermaid } from "../src/viz.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { grepRepo } from "../src/grep.js";
import { extractCode } from "../src/extract/code.js";
import { extractAst } from "../src/ast/extract.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

describe("regex-tier call extraction", () => {
  it("collects call sites for a language with no AST grammar", () => {
    // Kotlin ships no grammar wasm — the regex tier must still see calls.
    const info = extractCode(
      "a.kt",
      ".kt",
      "fun main() {\n  greet()\n  val x = compute(1)\n  if (x > 0) { log(x) }\n}\n",
    );
    const names = (info.calls ?? []).map((c) => c.name);
    expect(names).toContain("greet");
    expect(names).toContain("compute");
    expect(names).toContain("log");
    expect(names).not.toContain("if");
    expect(names).not.toContain("main"); // def site, not a call
  });

  it("skips keywords, short names, and comment lines", () => {
    const info = extractCode(
      "b.swift",
      ".swift",
      "// setup(ignored)\nfunc run() {\n  while (ready()) { step() }\n  return finish()\n}\n",
    );
    const names = (info.calls ?? []).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["ready", "step", "finish"]));
    expect(names).not.toContain("while");
    expect(names).not.toContain("return");
    expect(names).not.toContain("setup");
  });
});

describe("caller index", () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "ci-callers-"));
    writeFileSync(join(root, "lib.ts"), "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n");
    writeFileSync(
      join(root, "app.ts"),
      'import { greet } from "./lib";\nexport function main(): void {\n  greet("x");\n  greet("y");\n}\n',
    );
    // Python pair — no import gate, unique-name inference.
    writeFileSync(join(root, "util.py"), "def helper():\n    return 1\n");
    writeFileSync(join(root, "run.py"), "from util import helper\n\ndef go():\n    return helper()\n");
    return root;
  }

  it("binds call sites to defs with per-site lines (AST tier)", () => {
    const scan = scanRepo(makeRepo());
    const index = buildCallerIndex(scan);
    const greet = index.get("greet");
    expect(greet).toBeDefined();
    expect(greet!.def.file).toBe("lib.ts");
    expect(greet!.callers).toEqual([
      { file: "app.ts", line: 3 },
      { file: "app.ts", line: 4 },
    ]);
    const helper = index.get("helper");
    expect(helper).toBeDefined();
    expect(helper!.def.file).toBe("util.py");
    expect(helper!.callers.some((c) => c.file === "run.py")).toBe(true);
  });

  it("enclosingSymbol finds the declaration covering a line", () => {
    const scan = scanRepo(makeRepo());
    const enclosing = enclosingSymbol(scan, "app.ts", 3);
    expect(enclosing?.name).toBe("main");
  });
});

describe("git churn + changed files", () => {
  it("counts per-file commits and reports changed files since a ref", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-churn-"));
    git(root, "init", "-q");
    writeFileSync(join(root, "a.txt"), "1\n");
    writeFileSync(join(root, "b.txt"), "1\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "one");
    writeFileSync(join(root, "a.txt"), "2\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "two");

    const { churn, ok } = gitChurn(root);
    expect(ok).toBe(true);
    expect(churn.get("a.txt")).toBe(2);
    expect(churn.get("b.txt")).toBe(1);

    writeFileSync(join(root, "a.txt"), "3\n"); // worktree edit
    writeFileSync(join(root, "new.txt"), "x\n"); // untracked
    const changed = changedSince(root, "HEAD");
    expect(changed.has("a.txt")).toBe(true);
    expect(changed.has("new.txt")).toBe(true);
    expect(changed.has("b.txt")).toBe(false);
  });

  it("degrades loudly outside a git repo", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-nogit-"));
    const { churn, ok } = gitChurn(root);
    expect(ok).toBe(false);
    expect(churn.size).toBe(0);
  });
});

describe("categorize", () => {
  it.each([
    ["src/app.ts", ".ts", "code"],
    ["src/app.test.ts", ".ts", "test"],
    ["tests/helper.py", ".py", "test"],
    ["package.json", ".json", "config"],
    ["vite.config.ts", ".ts", "config"],
    ["prisma/schema.prisma", ".prisma", "schema"],
    ["db/migrations/001.sql", ".sql", "schema"],
    ["locales/fr.json", ".json", "i18n"],
    ["README.md", ".md", "doc"],
    ["styles/main.scss", ".scss", "style"],
    ["logo.png", ".png", "asset"],
    ["data/rows.csv", ".csv", "data"],
    ["LICENSE", "", "other"],
  ])("%s -> %s", (rel, ext, expected) => {
    expect(categorize(rel as string, ext as string)).toBe(expected);
  });
});

describe("workspace detection", () => {
  it("detects pnpm/npm monorepo packages with dependency edges", () => {
    const info = detectWorkspaces(join(FIXTURES, "mini-monorepo"));
    expect(info.packages.length).toBeGreaterThan(0);
    for (const p of info.packages) expect(["npm", "pnpm"]).toContain(p.kind);
  });

  it("detects cargo workspace members", () => {
    const info = detectWorkspaces(join(FIXTURES, "mini-cargo"));
    expect(info.packages.some((p) => p.kind === "cargo")).toBe(true);
  });

  it("builds edges, topo order and reports cycles on a synthetic monorepo", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-ws-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", workspaces: ["packages/*"] }));
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    mkdirSync(join(root, "packages", "b"), { recursive: true });
    writeFileSync(join(root, "packages", "a", "package.json"), JSON.stringify({ name: "a", dependencies: { b: "*" } }));
    writeFileSync(join(root, "packages", "b", "package.json"), JSON.stringify({ name: "b" }));

    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => p.name)).toEqual(["a", "b"]);
    expect(info.packages[0]!.dependsOn).toEqual(["b"]);
    expect(info.topoOrder).toEqual(["b", "a"]);
    expect(info.cycle).toBeUndefined();
    expect(info.packageOf("packages/a/src/x.ts")?.name).toBe("a");

    // Introduce a cycle: b depends on a.
    writeFileSync(join(root, "packages", "b", "package.json"), JSON.stringify({ name: "b", dependencies: { a: "*" } }));
    const cyclic = detectWorkspaces(root);
    expect(cyclic.cycle).toBeDefined();
  });

  it("detects maven modules", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-maven-"));
    writeFileSync(
      join(root, "pom.xml"),
      "<project><artifactId>parent</artifactId><modules><module>core</module><module>web</module></modules></project>",
    );
    mkdirSync(join(root, "core"));
    mkdirSync(join(root, "web"));
    writeFileSync(join(root, "core", "pom.xml"), "<project><artifactId>core</artifactId></project>");
    writeFileSync(
      join(root, "web", "pom.xml"),
      "<project><artifactId>web</artifactId><dependencies><dependency><groupId>g</groupId><artifactId>core</artifactId></dependency></dependencies></project>",
    );
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => p.name)).toEqual(["core", "web"]);
    expect(info.packages.find((p) => p.name === "web")!.dependsOn).toEqual(["core"]);
    expect(info.topoOrder).toEqual(["core", "web"]);
  });
});

describe("grepRepo backend parity", () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "ci-grep-"));
    writeFileSync(join(root, "a.ts"), "export const alphaToken = 1;\nconst other = 2;\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "b.ts"), "// alphaToken again\nexport const beta = alphaToken;\n");
    return root;
  }

  it("both backends return identical sorted hits", () => {
    const root = makeRepo();
    const js = grepRepo(root, "alphaToken", { noRipgrep: true });
    const auto = grepRepo(root, "alphaToken");
    expect(js.length).toBe(3);
    expect(auto).toEqual(js);
  });

  it("applies globs and maxHits after sorting", () => {
    const root = makeRepo();
    const hits = grepRepo(root, "alphaToken", { globs: ["sub/**"], noRipgrep: true });
    expect(hits.every((h) => h.file.startsWith("sub/"))).toBe(true);
    const capped = grepRepo(root, "alphaToken", { maxHits: 1, noRipgrep: true });
    expect(capped).toEqual([{ file: "a.ts", line: 1, text: "export const alphaToken = 1;" }]);
  });
});

describe("C/C++ AST tier", () => {
  it("extracts C function/struct symbols and call sites via tree-sitter", () => {
    const c = extractAst(
      "m.c",
      ".c",
      "#include <stdio.h>\n\nstruct point { int x; };\n\nint add(int a, int b) {\n  return a + b;\n}\n\nint main(void) {\n  printf(\"%d\", add(1, 2));\n  return 0;\n}\n",
    );
    expect(c).toBeDefined();
    const names = c!.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("function:add");
    expect(names).toContain("function:main");
    expect(names).toContain("struct:point");
    expect(c!.calls.map((x) => x.name)).toEqual(expect.arrayContaining(["add", "printf"]));
  });

  it("extracts C++ class/namespace symbols", () => {
    const cpp = extractAst(
      "w.cpp",
      ".cpp",
      "namespace app {\nclass Widget {\n public:\n  int size();\n};\n\nint Widget::size() { return 1; }\n}\n\nint use() {\n  app::Widget w;\n  return w.size();\n}\n",
    );
    expect(cpp).toBeDefined();
    const names = cpp!.symbols.map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("namespace:app");
    expect(names).toContain("class:Widget");
    expect(names).toContain("function:use");
  });
});

describe("change coupling + hotspots", () => {
  it("mines co-change pairs and ranks hotspots deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-coupling-"));
    git(root, "init", "-q");
    const w = (rel: string, content: string) => {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    w("a.ts", "export const a = 1;\n");
    w("b.ts", "export const b = 1;\n");
    w("c.ts", "export const c = 1;\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    for (let i = 0; i < 4; i++) {
      w("a.ts", `export const a = ${i + 2};\n`);
      w("b.ts", `export const b = ${i + 2};\n`);
      git(root, "add", "-A");
      git(root, "commit", "-qm", `pair ${i}`);
    }
    const { ok, couplings } = changeCoupling(root, { minTogether: 3 });
    expect(ok).toBe(true);
    expect(couplings[0]).toMatchObject({ a: "a.ts", b: "b.ts", together: 5, strength: 1 });
    expect(couplings.some((c) => c.a === "c.ts" || c.b === "c.ts")).toBe(false); // only co-changed once

    const scan = scanRepo(root);
    const { churn } = gitChurn(root);
    const hotspots = rankHotspots(scan, churn);
    expect(hotspots[0]!.rel).toBe("a.ts");
    expect(hotspots[0]!.commits).toBe(5);
  });

  it("degrades loudly outside a git repo", () => {
    const { ok, couplings } = changeCoupling(mkdtempSync(join(tmpdir(), "ci-nocoup-")));
    expect(ok).toBe(false);
    expect(couplings).toEqual([]);
  });
});

describe("repo map", () => {
  it("renders a deterministic, budget-bounded map led by high-PageRank files", () => {
    const { scan, graph } = buildIndexArtifacts(join(FIXTURES, "mini-repo"));
    const map = renderRepoMap(scan, graph, { budgetTokens: 400 });
    expect(map).toBe(renderRepoMap(scan, graph, { budgetTokens: 400 }));
    expect(map.length).toBeLessThanOrEqual(400 * 4 + 200); // budget + footer slack
    expect(map).toContain("repo map");
    expect(map).toMatch(/\d+: /); // line-numbered signatures
    const tiny = renderRepoMap(scan, graph, { budgetTokens: 60 });
    expect(tiny.length).toBeLessThan(map.length);
  });
});

describe("symbol query API", () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "ci-query-"));
    writeFileSync(
      join(root, "widget.ts"),
      "export class Widget {\n  size(): number {\n    return 1;\n  }\n}\n\nexport function makeWidget(): Widget {\n  return new Widget();\n}\n",
    );
    writeFileSync(join(root, "app.ts"), 'import { makeWidget } from "./widget";\nexport const w = makeWidget();\n');
    writeFileSync(join(root, "README.md"), "Use `makeWidget` to build widgets.\n");
    return root;
  }

  it("symbolsOverview lists a file's declarations in order", () => {
    const scan = scanRepo(makeRepo());
    const names = symbolsOverview(scan, "widget.ts").map((s) => `${s.kind}:${s.name}`);
    expect(names).toEqual(["class:Widget", "method:size", "function:makeWidget"]);
  });

  it("findSymbol supports name paths, substring and bodies", () => {
    const scan = scanRepo(makeRepo());
    const method = findSymbol(scan, "Widget/size");
    expect(method).toHaveLength(1);
    expect(method[0]!.parent).toBe("Widget");
    const body = findSymbol(scan, "makeWidget", { includeBody: true })[0]!;
    expect(body.body).toContain("return new Widget()");
    const fuzzy = findSymbol(scan, "widg", { substring: true });
    expect(fuzzy.map((m) => m.name)).toContain("Widget");
    expect(fuzzy.map((m) => m.name)).toContain("makeWidget");
  });

  it("findReferences merges precise call sites with file-level references", () => {
    const scan = scanRepo(makeRepo());
    const refs = findReferences(scan, "makeWidget");
    expect(refs.defs[0]!.file).toBe("widget.ts");
    expect(refs.callSites).toEqual([{ file: "app.ts", line: 2 }]);
    expect(refs.referencingFiles).toContain("app.ts");
    expect(refs.referencingFiles).toContain("README.md"); // doc mention tier
  });
});

describe("symbolic editing", () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "ci-edit-"));
    writeFileSync(
      join(root, "calc.ts"),
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n",
    );
    return root;
  }

  it("replaceSymbolBody swaps exactly the declaration's line span", () => {
    const root = makeRepo();
    const scan = scanRepo(root);
    const res = replaceSymbolBody(scan, "add", "export function add(a: number, b: number): number {\n  return b + a;\n}");
    expect(res).toMatchObject({ file: "calc.ts", startLine: 1, endLine: 3 });
    const content = engineRead(join(root, "calc.ts"));
    expect(content).toContain("return b + a;");
    expect(content).toContain("return a - b;"); // neighbour untouched
    expect(content).not.toContain("return a + b;");
  });

  it("insertAfterSymbol keeps a blank line and insertBeforeSymbol pushes down", () => {
    const root = makeRepo();
    let scan = scanRepo(root);
    insertAfterSymbol(scan, "add", "export function mul(a: number, b: number): number {\n  return a * b;\n}");
    const afterInsert = engineRead(join(root, "calc.ts"));
    expect(afterInsert).toMatch(/}\n\nexport function mul/);
    expect(afterInsert.indexOf("mul")).toBeLessThan(afterInsert.indexOf("sub"));
    scan = scanRepo(root); // re-scan: spans moved
    insertBeforeSymbol(scan, "sub", "// subtraction below\n");
    expect(engineRead(join(root, "calc.ts"))).toMatch(/subtraction below[\s\S]*function sub/);
  });

  it("ambiguity and misses error with actionable candidates", () => {
    const root = makeRepo();
    writeFileSync(join(root, "calc2.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
    const scan = scanRepo(root);
    expect(() => resolveUniqueSymbol(scan, "add")).toThrow(/ambiguous.*calc/s);
    expect(resolveUniqueSymbol(scan, "add", "calc2.ts").file).toBe("calc2.ts");
    expect(() => resolveUniqueSymbol(scan, "nonexistent")).toThrow(/no symbol matches/);
  });
});

describe("project memories", () => {
  it("write/list/read/delete with topic subdirectories and traversal defense", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-mem-"));
    writeMemory(root, "core", "# Core\nThe project map.\n");
    writeMemory(root, "topics/build", "pnpm build");
    expect(listMemories(root)).toEqual(["core", "topics/build"]);
    expect(readMemory(root, "core")).toContain("project map");
    expect(readMemory(root, "mem:topics/build.md")).toBe("pnpm build\n"); // prefix/suffix tolerated
    expect(readMemory(root, "missing")).toBeUndefined();
    expect(deleteMemory(root, "core")).toBe(true);
    expect(listMemories(root)).toEqual(["topics/build"]);
    expect(() => writeMemory(root, "../escape", "x")).toThrow(/invalid memory name/);
    expect(() => writeMemory(root, "a/../../b", "x")).toThrow(/invalid memory name/);
  });
});

describe("dead code, complexity, mermaid", () => {
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "ci-dead-"));
    writeFileSync(join(root, "used.ts"), "export function used(): number {\n  return 1;\n}\n");
    writeFileSync(
      join(root, "dead.ts"),
      "export function neverCalled(): number {\n  if (Math.random() > 0.5 && Date.now() > 0) {\n    return 2;\n  }\n  return 3;\n}\n",
    );
    writeFileSync(join(root, "consumer.ts"), 'import { used } from "./used";\nexport const v = used();\n');
    return root;
  }

  it("findDeadCode tiers unreferenced exports and spares called ones", () => {
    const scan = scanRepo(makeRepo());
    const dead = findDeadCode(scan);
    const names = dead.map((d) => d.name);
    expect(names).toContain("neverCalled");
    expect(names).not.toContain("used");
    expect(dead.find((d) => d.name === "neverCalled")!.tier).toBe("unreferenced");
  });

  it("symbolComplexity counts branches; riskHotspots multiplies by churn", () => {
    const root = makeRepo();
    const scan = scanRepo(root);
    const cx = symbolComplexity(scan);
    const dead = cx.find((c) => c.name === "neverCalled")!;
    expect(dead.complexity).toBeGreaterThanOrEqual(3); // if + && + ternary-free base
    const risks = riskHotspots(scan, new Map([["dead.ts", 10]]));
    expect(risks[0]!.file).toBe("dead.ts");
    expect(risks[0]!.score).toBe(11 * risks[0]!.complexity);
  });

  it("renderMermaid emits a deterministic module diagram", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-mmd-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib", "core.ts"), "export const core = 1;\n");
    writeFileSync(join(root, "src", "app.ts"), 'import { core } from "../lib/core";\nexport const a = core;\n');
    const { graph } = buildIndexArtifacts(root);
    const mmd = renderMermaid(graph);
    expect(mmd).toContain("graph LR");
    expect(mmd).toContain("-->");
    expect(renderMermaid(graph)).toBe(mmd);
  });
});
