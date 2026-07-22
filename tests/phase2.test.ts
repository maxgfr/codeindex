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
