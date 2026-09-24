import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scanRepo } from "../src/scan.js";
import { buildResolveContext, resolveImport } from "../src/resolve.js";
import { extractCode } from "../src/extract/code.js";
import { buildModules } from "../src/modules.js";
import { buildGraph } from "../src/graph.js";
import type { Edge } from "../src/types.js";

// Write a set of {relpath: content} files into a fresh temp repo and return its
// full file-level graph — exercises extraction + resolution end to end.
function writeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ui-rl-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}
function graphOf(files: Record<string, string>): Edge[] {
  const scan = scanRepo(writeRepo(files));
  const ctx = buildResolveContext(scan);
  const { modules, moduleOf } = buildModules(scan);
  return buildGraph(scan, ctx, modules, moduleOf).fileEdges;
}
const imp = (edges: Edge[], from: string, to: string) =>
  edges.some((e) => e.from === from && e.to === to && e.kind === "import" && !e.dangling);
const dangling = (edges: Edge[], from: string, reason: string) =>
  edges.some((e) => e.from === from && e.kind === "import" && e.dangling && e.reason === reason);

describe("new-language import resolution", () => {
  it("C/C++: resolves a local #include and dangles a missing one", () => {
    const edges = graphOf({
      "src/app.c": '#include "util.h"\n#include "nope.h"\nint main(){return 0;}\n',
      "src/util.h": "int helper(void);\n",
    });
    expect(imp(edges, "src/app.c", "src/util.h")).toBe(true);
    expect(dangling(edges, "src/app.c", "missing-include")).toBe(true);
  });

  it("C/C++: resolves an #include against an include/ root", () => {
    const edges = graphOf({
      "lib/foo.c": '#include "shared/types.h"\n',
      "lib/include/shared/types.h": "typedef int T;\n",
    });
    // include root "lib/include" makes "shared/types.h" resolve.
    expect(imp(edges, "lib/foo.c", "lib/include/shared/types.h")).toBe(true);
  });

  it("Ruby: resolves require_relative and a bare require against lib/", () => {
    const edges = graphOf({
      "app.rb": 'require_relative "helpers/format"\nrequire "widget"\n',
      "helpers/format.rb": "def fmt; end\n",
      "lib/widget.rb": "class Widget; end\n",
    });
    expect(imp(edges, "app.rb", "helpers/format.rb")).toBe(true);
    expect(imp(edges, "app.rb", "lib/widget.rb")).toBe(true);
  });

  it("PHP: resolves a PSR-4 use and a relative require", () => {
    const edges = graphOf({
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }),
      "src/Service/Mailer.php": "<?php\nnamespace App\\Service;\nclass Mailer {}\n",
      "public/index.php": "<?php\nuse App\\Service\\Mailer;\nrequire './bootstrap.php';\n",
      "public/bootstrap.php": "<?php\n// boot\n",
    });
    expect(imp(edges, "public/index.php", "src/Service/Mailer.php")).toBe(true);
    expect(imp(edges, "public/index.php", "public/bootstrap.php")).toBe(true);
  });

  it("C#: resolves a using to the file declaring that namespace", () => {
    const edges = graphOf({
      "Services/Mailer.cs": "namespace App.Services;\npublic class Mailer {}\n",
      "Program.cs": "using App.Services;\nclass Program { static void Main() {} }\n",
    });
    expect(imp(edges, "Program.cs", "Services/Mailer.cs")).toBe(true);
  });
});

const specsOf = (rel: string, content: string): string[] =>
  extractCode(rel, rel.slice(rel.lastIndexOf(".")), content).refs.map((r) => r.spec);

describe("import extraction: Kotlin, Scala, Dart, Lua, Shell, Elixir", () => {
  it("Kotlin: dotted imports (aliases, wildcards, backquotes) and the package", () => {
    const src = "@file:JvmName(\"M\")\npackage com.acme.`app`\n\nimport com.acme.core.User\nimport com.acme.util.*\nimport com.acme.x.Y as Z\nimport a.`fun`.B\n";
    expect(specsOf("Main.kt", src)).toEqual(["com.acme.core.User", "com.acme.util.*", "com.acme.x.Y", "a.fun.B"]);
    expect(extractCode("Main.kt", ".kt", src).pkg).toBe("com.acme.app");
  });

  it("Scala: clauses, selector groups (renames, hiding, given, wildcard) and chained packages", () => {
    const src = [
      "package com.acme",
      "package app",
      "",
      "import com.acme.core.{User, Admin => A, Hidden => _, given, _}",
      "import scala.collection.mutable, java.util.List",
      "import com.acme.util._",
      "import com.acme.x.Y as Z",
      "import com.acme.multi.{",
      "  One,",
      "  Two // trailing comment",
      "}",
      "",
      "object Main",
    ].join("\n");
    expect(specsOf("Main.scala", src)).toEqual([
      "com.acme.core.User", "com.acme.core.Admin", "com.acme.core.*",
      "scala.collection.mutable", "java.util.List", "com.acme.util.*", "com.acme.x.Y",
      "com.acme.multi.One", "com.acme.multi.Two",
    ]);
    expect(extractCode("Main.scala", ".scala", src).pkg).toBe("com.acme.app");
    // A package object's members live in the package it names.
    expect(extractCode("p.scala", ".scala", "// hdr\npackage com.acme\n\npackage object util {\n}\n").pkg).toBe(
      "com.acme.util",
    );
  });

  it("Dart: import/export/part URIs as written, never `part of`", () => {
    const src = "library a;\nimport 'dart:io';\nimport \"package:app/src/x.dart\" as x;\nexport 'y.dart' show Y;\npart 'a.g.dart';\npart of 'lib.dart';\n";
    expect(specsOf("lib/a.dart", src)).toEqual(["dart:io", "package:app/src/x.dart", "y.dart", "a.g.dart"]);
  });

  it("Lua: every require spelling", () => {
    const src = 'local a = require("lib.a")\nlocal b = require "b"\nlocal c = require(\'c.d-e\')\nlocal d = require(name)\n';
    expect(specsOf("init.lua", src)).toEqual(["lib.a", "b", "c.d-e"]);
  });

  it("Shell: literal and script-relative source paths, never variables or absolute paths", () => {
    const src = [
      "#!/bin/bash",
      "source ./lib/common.sh",
      ". \"$(dirname \"$0\")/env.sh\"",
      "source \"${BASH_SOURCE%/*}/more.sh\" arg",
      "if true; then . helpers.sh; fi",
      "source \"$HOME/.bashrc\"",
      ". /etc/profile",
      "source ~/x.sh",
      "find . -name x",
    ].join("\n");
    expect(specsOf("bin/run.sh", src)).toEqual(["./lib/common.sh", "./env.sh", "./more.sh", "helpers.sh"]);
  });

  it("Elixir: alias/import/require/use modules, multi-alias groups expanded", () => {
    const src = "defmodule MyApp.Web do\n  alias MyApp.{Repo, Accounts.User}\n  import Ecto.Query, only: [from: 2]\n  use MyApp.Schema\n  require Logger\n  alias __MODULE__.X\nend\n";
    expect(specsOf("lib/web.ex", src)).toEqual(["MyApp.Repo", "MyApp.Accounts.User", "Ecto.Query", "MyApp.Schema", "Logger"]);
  });
});

describe("JVM import resolution across Java, Kotlin and Scala", () => {
  const files = {
    "core/src/main/java/com/acme/core/User.java": "package com.acme.core;\npublic class User {}\n",
    "core/src/main/java/com/acme/core/Consts.java": "package com.acme.core;\npublic class Consts { public static final int N = 1; }\n",
    // Kotlin need not mirror its package in its path.
    "kt/src/main/kotlin/KtThing.kt": "package com.acme.kt\n\nclass KtThing\n",
    "kt/src/main/kotlin/util/Helpers.kt": "package com.acme.util\n\nfun helper(): Int = 1\n",
    "kt/src/main/kotlin/util/Color.kt": "package com.acme.util\n\nenum class Color { RED }\n",
    "app/src/main/kotlin/Main.kt": [
      "package com.acme.app",
      "import com.acme.core.User",
      "import com.acme.kt.KtThing",
      "import com.acme.util.helper",
      "import com.acme.util.Color",
      "import com.acme.app.R",
      "import kotlinx.coroutines.launch",
      "fun main() { println(helper()) }",
    ].join("\n"),
    "app/src/main/java/com/acme/app/App.java": [
      "package com.acme.app;",
      "import com.acme.kt.KtThing;",
      "import com.acme.util.HelpersKt;",
      "import static com.acme.core.Consts.*;",
      "public class App {}",
    ].join("\n"),
    "sc/src/main/scala/com/acme/sc/Svc.scala": [
      "package com.acme",
      "package sc",
      "",
      "import com.acme.core.{User, Consts}",
      "import util.Helpers",
      "import com.acme.kt._",
      "",
      "object Svc",
    ].join("\n"),
    "sc/src/main/scala/com/acme/sc/util/Helpers.scala": "package com.acme.sc.util\n\nobject Helpers\n",
  };
  const edges = graphOf(files);
  const main = "app/src/main/kotlin/Main.kt";

  it("links Kotlin to Java classes and to Kotlin declarations by package + name", () => {
    expect(imp(edges, main, "core/src/main/java/com/acme/core/User.java")).toBe(true);
    expect(imp(edges, main, "kt/src/main/kotlin/KtThing.kt")).toBe(true);
    // A top-level function, and a class the declaration list may miss but the stem names.
    expect(imp(edges, main, "kt/src/main/kotlin/util/Helpers.kt")).toBe(true);
    expect(imp(edges, main, "kt/src/main/kotlin/util/Color.kt")).toBe(true);
    // Generated (`R`) and third-party names stay external: no guessed edge.
    expect(edges.filter((e) => e.from === main && e.kind === "import").length).toBe(4);
  });

  it("links Java to Kotlin classes, the `<Stem>Kt` facade and a static wildcard's class", () => {
    const app = "app/src/main/java/com/acme/app/App.java";
    expect(imp(edges, app, "kt/src/main/kotlin/KtThing.kt")).toBe(true);
    expect(imp(edges, app, "kt/src/main/kotlin/util/Helpers.kt")).toBe(true);
    expect(imp(edges, app, "core/src/main/java/com/acme/core/Consts.java")).toBe(true);
  });

  it("links Scala by selector, by a name relative to its package, and by package wildcard", () => {
    const svc = "sc/src/main/scala/com/acme/sc/Svc.scala";
    expect(imp(edges, svc, "core/src/main/java/com/acme/core/User.java")).toBe(true);
    expect(imp(edges, svc, "core/src/main/java/com/acme/core/Consts.java")).toBe(true);
    expect(imp(edges, svc, "sc/src/main/scala/com/acme/sc/util/Helpers.scala")).toBe(true);
    expect(imp(edges, svc, "kt/src/main/kotlin/KtThing.kt")).toBe(true);
  });

  it("gives Kotlin and Scala files their package", () => {
    const scan = scanRepo(writeRepo(files));
    const pkgOf = (rel: string) => scan.files.find((f) => f.rel === rel)?.pkg;
    expect(pkgOf(main)).toBe("com.acme.app");
    expect(pkgOf("sc/src/main/scala/com/acme/sc/Svc.scala")).toBe("com.acme.sc");
  });
});

describe("Dart, Lua, Shell and Elixir import resolution", () => {
  it("Dart: relative imports, parts and package: URIs of an in-repo pubspec", () => {
    const edges = graphOf({
      "app/pubspec.yaml": "name: my_app\ndependencies:\n  flutter:\n    sdk: flutter\n",
      "app/lib/main.dart": [
        "import 'package:flutter/material.dart';",
        "import 'package:my_app/src/util.dart';",
        "import 'src/widgets.dart';",
        "import 'dart:async';",
        "part 'main.g.dart';",
        "import 'nope.dart';",
      ].join("\n"),
      "app/lib/src/util.dart": "int helper() => 1;\n",
      "app/lib/src/widgets.dart": "class W {}\n",
    });
    const main = "app/lib/main.dart";
    expect(imp(edges, main, "app/lib/src/util.dart")).toBe(true);
    expect(imp(edges, main, "app/lib/src/widgets.dart")).toBe(true);
    // An uncommitted build_runner output is not a broken import; a missing file is.
    expect(edges.some((e) => e.from === main && e.to === "main.g.dart")).toBe(false);
    expect(edges.filter((e) => e.from === main && e.dangling).map((e) => e.to)).toEqual(["nope.dart"]);
  });

  it("Lua: a/b.lua and a/b/init.lua under the repo root, lua/ dirs and the file's own dir", () => {
    const edges = graphOf({
      "init.lua": 'require("config.options")\nrequire("plugin")\nrequire("socket")\n',
      "lua/config/options.lua": "return {}\n",
      "lua/plugin/init.lua": "return {}\n",
      "game/main.lua": 'local p = require "player"\n',
      "game/player.lua": "return {}\n",
    });
    expect(imp(edges, "init.lua", "lua/config/options.lua")).toBe(true);
    expect(imp(edges, "init.lua", "lua/plugin/init.lua")).toBe(true);
    expect(imp(edges, "game/main.lua", "game/player.lua")).toBe(true);
    expect(edges.some((e) => e.from === "init.lua" && e.dangling)).toBe(false);
  });

  it("Shell: a sourced file relative to the script or to the repo root, misses external", () => {
    const edges = graphOf({
      "scripts/build.sh": '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\nsource scripts/env.sh\nsource .venv/bin/activate\n',
      "scripts/lib.sh": "x() { :; }\n",
      "scripts/env.sh": "export A=1\n",
    });
    expect(imp(edges, "scripts/build.sh", "scripts/lib.sh")).toBe(true);
    expect(imp(edges, "scripts/build.sh", "scripts/env.sh")).toBe(true);
    expect(edges.some((e) => e.from === "scripts/build.sh" && e.dangling)).toBe(false);
  });

  it("Elixir: an aliased module resolves to the file defining it, nested modules included", () => {
    const root = writeRepo({
      "lib/my_app/accounts.ex": "defmodule MyApp.Accounts do\n  defmodule User do\n    defstruct [:id]\n  end\nend\n",
      "lib/my_app/repo.ex": "defmodule MyApp.Repo do\nend\n",
      "lib/my_app_web/controller.ex": "defmodule MyAppWeb.Controller do\n  alias MyApp.{Repo, Accounts.User}\n  import Ecto.Query\nend\n",
    });
    const ctx = buildResolveContext(scanRepo(root));
    const from = "lib/my_app_web/controller.ex";
    expect(resolveImport(from, ".ex", "MyApp.Repo", ctx)).toEqual({ kind: "resolved", target: "lib/my_app/repo.ex" });
    expect(resolveImport(from, ".ex", "MyApp.Accounts.User", ctx)).toEqual({
      kind: "resolved",
      target: "lib/my_app/accounts.ex",
    });
    expect(resolveImport(from, ".ex", "Ecto.Query", ctx).kind).toBe("external");
  });
});
