import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractImports, maskJs, maskPython } from "../src/extract/imports.js";
import { extractCode } from "../src/extract/code.js";
import { extractAst } from "../src/ast/extract.js";
import { allGrammarKeys, ensureGrammars } from "../src/ast/loader.js";
import { scanRepo } from "../src/scan.js";
import { buildResolveContext } from "../src/resolve.js";
import { buildModules } from "../src/modules.js";
import { buildGraph } from "../src/graph.js";
import type { RawRef } from "../src/types.js";

const specs = (ext: string, src: string): string[] => extractImports(ext, src).map((r) => r.spec);
// Soft refs marked with a trailing "~", so one exact list shows both kinds.
const marked = (refs: RawRef[]): string[] => refs.map((r) => (r.soft ? `${r.spec}~` : r.spec));

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-imports-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function importEdges(root: string): string[] {
  const scan = scanRepo(root);
  const { modules, moduleOf } = buildModules(scan);
  const graph = buildGraph(scan, buildResolveContext(scan), modules, moduleOf);
  return graph.fileEdges
    .filter((e) => e.kind === "import")
    .map((e) => `${e.from} -> ${e.to}${e.dangling ? " (dangling)" : ""}`);
}

describe("masking keeps offsets and lines", () => {
  it("blanks JS comments, string bodies, template text and regex bodies — nothing else", () => {
    const src = 'const a = "x/*y*/"; // c\n/* b\n */ const re = /[\'"]/g; `t ${n} u`;\n';
    const masked = maskJs(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split("\n").length).toBe(src.split("\n").length);
    expect(masked).toBe('const a = "      ";     \n    \n    const re = /    /g; `  ${n}  `;\n');
  });

  it("blanks Python comments and every string, docstrings across lines", () => {
    const src = 'x = 1  # from a import b\n"""\nfrom flask import Flask\n"""\ny = f\'{z}\'\n';
    const masked = maskPython(src);
    expect(masked.length).toBe(src.length);
    expect(masked).toBe('x = 1                   \n"""\n                       \n"""\ny = f\'   \'\n');
  });
});

describe("JS/TS import scan", () => {
  it("ignores imports quoted in JSDoc examples, comments, template literals and strings", () => {
    const src = [
      "/**",
      " * Usage:",
      ' *   import { b } from "./b";',
      ' *   const c = require("./c");',
      " */",
      "export function a() {}",
      '// import { d } from "./d";',
      'const code = `import { e } from "./e";`;',
      "const msg = \"please import this from 'x'\";",
      "out.push(`} from \"./visitor.ts\";`);",
    ].join("\n");
    expect(specs(".ts", src)).toEqual([]);
  });

  it("still finds every real form, in the historical pass order (from, bare, require, dynamic)", () => {
    const src = [
      'const lazy = import("./dyn");',
      'const cjs = require("./req");',
      'import "./side-effect";',
      "import {",
      "  a, // a trailing comment with a ' quote",
      "  b as c,",
      '} from "./multi";',
      'import type { T } from "./types";',
      'import def, * as ns from "./both";',
      'export * from "./star";',
      'export * as space from "./star-ns";',
      'export { "a-b" as ab } from "./string-name";',
      'import x = require("./ts-equals");',
      'import{min}from"./minified";',
      'const data = await import("./data.json", { with: { type: "json" } });',
    ].join("\n");
    expect(specs(".ts", src)).toEqual([
      "./multi", "./types", "./both", "./star", "./star-ns", "./string-name", "./minified",
      "./side-effect",
      "./req", "./ts-equals",
      "./dyn", "./data.json",
    ]);
  });

  it("keeps code inside a template interpolation and survives quotes in regex literals", () => {
    const src = [
      "const re = /['\"`]/g;",
      'const s = `${require("./inside")} } from "./not-an-import"`;',
      "const half = total / 2; const other = require('./after-division');",
    ].join("\n");
    expect(specs(".js", src)).toEqual(["./inside", "./after-division"]);
  });

  it("keeps the JSDoc type imports a checkJs codebase depends on", () => {
    const src = [
      '/** @typedef {import("./compiler").Compiler} Compiler */',
      '/** @import { Hook } from "./hooks" */',
      "/**",
      " * @import { A,",
      " *   B }",
      ' * from "./wrapped"',
      " */",
      "/** @example",
      ' * import { nope } from "./example";',
      " */",
    ].join("\n");
    expect(specs(".js", src).sort()).toEqual(["./compiler", "./hooks", "./wrapped"]);
  });

  it("stays linear on a large quote-free module (previously ~11 s)", () => {
    // Every `export` used to scan lazily to the next quote: the end of the file.
    const fns = Array.from({ length: 20000 }, (_, i) => `export function g${i}(a){return a+${i}}`).join("\n");
    const lists = Array.from({ length: 20000 }, (_, i) => `export { v${i} }`).join("\n");
    for (const src of [fns, lists]) {
      const t0 = performance.now();
      expect(specs(".js", src)).toEqual([]);
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });
});

describe("Python import scan", () => {
  it("emits one soft candidate per imported name, joined onto the module path", () => {
    const src = [
      "from __future__ import annotations",
      "import os, sys  # trailing comment no longer hides both",
      "from . import cli",
      "from .. import up as u",
      "from .pkg import mod, other as o",
      "from flask import json as j, Flask",
      "from star import *",
      "from multi import (",
      "    first,  # why",
      "    second as s,",
      ")",
      "from cont import a, \\",
      "    b",
      "import x; import y",
    ].join("\n");
    expect(marked(extractImports(".py", src))).toEqual([
      "__future__",
      "os", "sys",
      ".", ".cli~",
      "..", "..up~",
      ".pkg", ".pkg.mod~", ".pkg.other~",
      "flask", "flask.json~", "flask.Flask~",
      "star",
      "multi", "multi.first~", "multi.second~",
      "cont", "cont.a~", "cont.b~",
      "x", "y",
    ]);
  });

  it("lets a hard ref win over a soft one, at the hard ref's own position", () => {
    const src = "from . import json\nfrom .app import App\nfrom .json import dumps\n";
    expect(marked(extractImports(".py", src))).toEqual([".", ".app", ".app.App~", ".json", ".json.dumps~"]);
  });

  it("ignores example code in docstrings and comments", () => {
    const src = [
      '"""Module doc.',
      "",
      "    from flask import Flask",
      "    import tomllib",
      '"""',
      "# from commented import out",
      "def f():",
      "    '''from single import quoted'''",
      "    from real import thing",
    ].join("\n");
    expect(marked(extractImports(".py", src))).toEqual(["real", "real.thing~"]);
  });
});

describe("PHP import scan", () => {
  it("expands group and comma uses, skips trait uses, captures directory-anchored includes", () => {
    const src = [
      "<?php",
      "namespace App\\Services;",
      "",
      "use App\\Models\\User;",
      "use App\\Contracts\\{Runnable, Closeable as C};",
      "use function App\\helpers\\fmt;",
      "use \\Lib\\A, Lib\\B as BB;",
      "require_once __DIR__ . '/helpers.php';",
      "require dirname(__FILE__) . '/same.php';",
      "require dirname(__DIR__) . '/../up2.php';",
      "include dirname(__DIR__, 2) . '/deep.php';",
      "require 'plain.php';",
      "",
      "final class Svc implements Runnable",
      "{",
      "    use LoggerTrait;",
      "    use A, B { A::x insteadof B; }",
      "    public function run() { $f = function () use ($x) { return $x; }; }",
      "}",
      "use After\\TopLevel;",
    ].join("\n");
    expect(specs(".php", src)).toEqual([
      "App\\Models\\User",
      "App\\Contracts\\Runnable",
      "App\\Contracts\\Closeable",
      "App\\helpers\\fmt",
      "Lib\\A",
      "Lib\\B",
      "After\\TopLevel",
      "./helpers.php",
      "./same.php",
      "../../up2.php",
      "../../deep.php",
      "./plain.php",
    ]);
  });
});

describe("extractAst reports the same imports as the index", () => {
  beforeAll(async () => {
    await ensureGrammars(allGrammarKeys());
  });

  const samples: Record<string, [string, string[]]> = {
    "mod.py": [
      "from __future__ import annotations\nimport os, sys\nfrom . import sibling\nfrom ..parent import thing\n",
      ["__future__", "os", "sys", ".", ".sibling~", "..parent", "..parent.thing~"],
    ],
    "svc.go": [
      'package p\n\nimport (\n\t"fmt"\n\t"net/http"\n\t_ "embed"\n)\nimport "os"\n',
      ["fmt", "net/http", "embed", "os"],
    ],
    "A.java": [
      "package com.acme;\nimport java.util.List;\nimport static com.acme.util.Str.fmt;\nimport com.acme.util.*;\nclass A {}\n",
      ["java.util.List", "com.acme.util.Str.fmt", "com.acme.util.*"],
    ],
    "cjs.js": ['const a = require("./a");\nexport * from "./b";\nconst c = import("./c");\n', ["./b", "./a", "./c"]],
    "x.ts": ['export { q } from "./q";\nimport type { T } from "./t";\n', ["./q", "./t"]],
    "Svc.php": ["<?php\nuse App\\Models\\{User, Post};\nclass Svc { use T; }\n", ["App\\Models\\User", "App\\Models\\Post"]],
    "lib.rs": ["mod a;\nuse crate::b::{c, d};\n", ["mod a", "crate::b::c", "crate::b::d"]],
    "P.cs": ["using System.Text;\nnamespace Acme.App;\nclass P {}\n", ["System.Text"]],
  };

  for (const [file, [src, expected]] of Object.entries(samples)) {
    it(file, () => {
      const ext = file.slice(file.lastIndexOf("."));
      const ast = extractAst(file, ext, src)!;
      const code = extractCode(file, ext, src);
      expect(marked(ast.refs)).toEqual(expected);
      expect(ast.refs).toEqual(code.refs);
      expect(ast.pkg).toBe(code.pkg);
    });
  }

  it("reads the package of Java and C# files", () => {
    expect(extractAst("A.java", ".java", "package com.acme;\nclass A {}\n")!.pkg).toBe("com.acme");
    expect(extractAst("P.cs", ".cs", "namespace Acme.App;\nclass P {}\n")!.pkg).toBe("Acme.App");
  });
});

describe("import edges end to end", () => {
  it("links `from . import sibling` to the submodule, not only the package", () => {
    const root = repo({
      "pkg/__init__.py": "",
      "pkg/sibling.py": "X = 1\n",
      "pkg/sub/__init__.py": "",
      "pkg/sub/other.py": "Y = 1\n",
      "pkg/mod.py": "from . import sibling\nfrom .sub import other\nfrom .sibling import X\n",
    });
    expect(importEdges(root)).toEqual([
      "pkg/mod.py -> pkg/__init__.py",
      "pkg/mod.py -> pkg/sibling.py",
      "pkg/mod.py -> pkg/sub/__init__.py",
      "pkg/mod.py -> pkg/sub/other.py",
    ]);
  });

  it("draws no edge from a docstring example or a JSDoc usage example", () => {
    const root = repo({
      "app/__init__.py": "",
      "app/core.py": '"""Use it like this:\n\n    from app.fixture import thing\n"""\nVALUE = 1\n',
      "app/fixture.py": "thing = 1\n",
      "web/a.ts": '/**\n * import { b } from "./b";\n */\nexport const a = 1;\nconst t = `import c from "./c"`;\n',
      "web/b.ts": "export const b = 1;\n",
      "web/c.ts": "export const c = 1;\n",
    });
    expect(importEdges(root)).toEqual([]);
  });
});
