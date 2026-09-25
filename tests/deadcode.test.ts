import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanRepo } from "../src/scan.js";
import { findDeadCode, type DeadSymbol } from "../src/deadcode.js";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-deadcode-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const tierOf = (dead: DeadSymbol[], name: string): string | undefined => dead.find((d) => d.name === name)?.tier;

describe("deadcode: what counts as a reference", () => {
  // `Scaffold` and `ScaffoldBase` are used identically; only the second was
  // "distinctive" enough for symbols.json refs, so the first was reported
  // with the highest confidence as unreferenced.
  const root = repo({
    "a.ts": [
      "export class Scaffold {}",
      "export class ScaffoldBase {}",
      "export class Lone {}",
      "export type Options = { x: number };",
      "export const LIMIT = 3;",
      "export function pick(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
    "b.ts": [
      "import { Scaffold, ScaffoldBase, LIMIT, type Options } from './a';",
      "class App extends Scaffold {}",
      "class App2 extends ScaffoldBase {}",
      "export function useIt(o: Options): number {",
      "  return o.x + LIMIT;",
      "}",
      "",
    ].join("\n"),
    "c.py": "class Tag:\n    pass\n\n\nclass TagTuple(Tag):\n    pass\n\n\nclass Unused:\n    pass\n\n\nREGISTRY = [TagTuple]\n",
    "d.py": "from c import Tag\n\n\ndef run(x):\n    return x.go()\n",
    "e.py": "def go():\n    return 1\n",
  });
  const dead = findDeadCode(scanRepo(root));

  it("an imported, extended name is never 'unreferenced', whatever its length", () => {
    expect(tierOf(dead, "Scaffold")).toBe("uncalled");
    expect(tierOf(dead, "ScaffoldBase")).toBe("uncalled");
    expect(tierOf(dead, "Lone")).toBe("unreferenced");
    expect(tierOf(dead, "pick")).toBe("unreferenced");
  });

  it("a same-name call site that binds nowhere makes a callable 'uncalled', not 'unreferenced'", () => {
    // `x.go()` on an untyped receiver never binds to e.py's `go`, but it may
    // well reach it: at most 'uncalled'.
    expect(tierOf(dead, "go")).toBe("uncalled");
  });

  it("a name used in its own file, outside its declaration, is in use", () => {
    expect(tierOf(dead, "TagTuple")).toBe("uncalled");
    expect(tierOf(dead, "Unused")).toBe("unreferenced");
  });

  it("by default only callables are candidates; --kinds all adds the unreferenced others only", () => {
    expect(dead.map((d) => d.kind).filter((k) => !["class", "function"].includes(k))).toEqual([]);
    const every = findDeadCode(scanRepo(root), { kinds: "all" });
    // Options (a type), LIMIT (a const) and `x` (a property) are all named in b.ts.
    expect(every.filter((d) => ["Options", "LIMIT", "x"].includes(d.name))).toEqual([]);
    expect(every.find((d) => d.name === "REGISTRY")).toMatchObject({ kind: "const", tier: "unreferenced" });
  });
});

describe("deadcode: roots", () => {
  it("never flags protocol names, tail files unless asked, or test files", () => {
    const root = repo({
      "pkg/m.py": "class Box:\n    def __enter__(self):\n        return self\n\n    def __exit__(self, *a):\n        return None\n",
      "pkg/use.py": "from pkg.m import Box\n\n\ndef make():\n    return Box()\n",
      "examples/demo.ts": "export function demoOnly(): number {\n  return 1;\n}\n",
      "tests/helpers.ts": "export function fixtureHelper(): number {\n  return 1;\n}\n",
      "src/k.ts": "export class K {\n  constructor() {}\n}\n",
    });
    const scan = scanRepo(root);
    const names = findDeadCode(scan).map((d) => d.name);
    expect(names).not.toContain("__enter__");
    expect(names).not.toContain("__exit__");
    expect(names).not.toContain("constructor");
    expect(names).not.toContain("demoOnly");
    expect(names).not.toContain("fixtureHelper");
    expect(findDeadCode(scan, { includeTail: true }).map((d) => d.name)).toContain("demoOnly");
  });

  it("the package's public API is a root: package.json entries, what they re-export, and its classes' members", () => {
    const root = repo({
      // The manifest names build output; the source is found behind it.
      "package.json": JSON.stringify({ name: "lib", main: "./dist/index.js", bin: { tool: "scripts/tool.mjs" } }),
      "src/index.ts": "export { api, Service } from './api';\nexport * from './more';\n",
      "src/api.ts": [
        "export function api(): number {",
        "  return 1;",
        "}",
        "export class Service {",
        "  run(): number {",
        "    return 2;",
        "  }",
        "}",
        "export function internalOnly(): number {",
        "  return 3;",
        "}",
        "",
      ].join("\n"),
      "src/more.ts": "export function viaStar(): number {\n  return 4;\n}\n",
      "src/tool.ts": "export function toolMain(): void {}\n",
      // Not an entry any more: `app` was a project-specific basename.
      "src/app.ts": "export function appHelper(): number {\n  return 5;\n}\n",
    });
    const names = findDeadCode(scanRepo(root)).map((d) => d.name);
    expect(names).not.toContain("api");
    expect(names).not.toContain("Service");
    expect(names).not.toContain("run");
    expect(names).not.toContain("viaStar");
    expect(names).not.toContain("toolMain"); // scripts/tool.mjs → src/tool.ts
    expect(names).toContain("internalOnly");
    expect(names).toContain("appHelper");
  });

  it("a Python package's __init__ re-exports and pyproject scripts are roots, with the bases of public classes", () => {
    const root = repo({
      "pyproject.toml": '[project]\nname = "pkg"\n\n[project.scripts]\npkg = "pkg.cli:main"\n',
      "pkg/__init__.py": "from .core import Engine as Engine\n",
      "pkg/base.py": "class Base:\n    def shared(self):\n        return 1\n",
      "pkg/core.py": "from .base import Base\n\n\nclass Engine(Base):\n    def start(self):\n        return 2\n\n\ndef hidden():\n    return 3\n",
      "pkg/cli.py": "def main():\n    return 0\n\n\ndef other():\n    return 1\n",
    });
    const names = findDeadCode(scanRepo(root)).map((d) => d.name);
    expect(names).not.toContain("Engine");
    expect(names).not.toContain("start");
    expect(names).not.toContain("shared"); // a member of a public class's base
    expect(names).not.toContain("main");
    expect(names).toContain("other");
    expect(names).toContain("hidden");
  });

  it("without a manifest, index/main/cli basenames are the entries", () => {
    const root = repo({
      "src/index.ts": "export { a } from './a';\n",
      "src/a.ts": "export function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return 2;\n}\n",
    });
    const names = findDeadCode(scanRepo(root)).map((d) => d.name);
    expect(names).not.toContain("a");
    expect(names).toContain("b");
  });
});
