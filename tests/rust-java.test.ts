import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scanRepo } from "../src/scan.js";
import { buildResolveContext, resolveImport } from "../src/resolve.js";
import { extractCode } from "../src/extract/code.js";
import { buildIndexArtifacts } from "../src/pipeline.js";

// Import edges for Rust (mod/use, crate/self/super, cross-crate) and Java
// (package→source-root mapping, wildcards, nested classes).

const CARGO = fileURLToPath(new URL("./fixtures/mini-cargo", import.meta.url));
const MAVEN = fileURLToPath(new URL("./fixtures/mini-maven", import.meta.url));
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

function scratchRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ui-rs-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("extractCode: Rust mod/use specs", () => {
  it("captures mod declarations but not inline mod blocks", () => {
    const info = extractCode("src/lib.rs", ".rs", "pub mod engine;\nmod util;\nmod inline { pub fn x() {} }\n");
    const specs = info.refs.map((r) => r.spec);
    expect(specs).toContain("mod engine");
    expect(specs).toContain("mod util");
    expect(specs).not.toContain("mod inline");
  });
  it("expands brace groups, strips aliases and globs", () => {
    const info = extractCode("src/a.rs", ".rs", "use crate::x::{y, z::w as W};\nuse crate::deep::*;\n");
    const specs = info.refs.map((r) => r.spec);
    expect(specs).toContain("crate::x::y");
    expect(specs).toContain("crate::x::z::w");
    expect(specs).toContain("crate::deep");
  });
});

describe("resolveImport — Rust", () => {
  const ctx = buildResolveContext(scanRepo(CARGO));
  const from = "crates/core/src/lib.rs";
  it("resolves `mod` in both layouts (name.rs and name/mod.rs)", () => {
    expect(resolveImport(from, ".rs", "mod engine", ctx)).toEqual({
      kind: "resolved",
      target: "crates/core/src/engine.rs",
    });
    expect(resolveImport(from, ".rs", "mod store", ctx)).toEqual({
      kind: "resolved",
      target: "crates/core/src/store/mod.rs",
    });
  });
  it("resolves `mod` declared in a non-root file to its child dir (2018 layout)", () => {
    expect(resolveImport("crates/core/src/engine.rs", ".rs", "mod pipeline", ctx)).toEqual({
      kind: "resolved",
      target: "crates/core/src/engine/pipeline.rs",
    });
  });
  it("resolves crate:: paths, peeling trailing item segments", () => {
    expect(resolveImport("crates/core/src/engine.rs", ".rs", "crate::store::Store", ctx)).toEqual({
      kind: "resolved",
      target: "crates/core/src/store/mod.rs",
    });
  });
  it("resolves super:: to the parent module's own file when the leaf is an item", () => {
    expect(resolveImport("crates/core/src/engine/pipeline.rs", ".rs", "super::Engine", ctx)).toEqual({
      kind: "resolved",
      target: "crates/core/src/engine.rs",
    });
  });
  it("resolves a sibling in-repo crate (with -→_ name mapping)", () => {
    expect(resolveImport("crates/app/src/main.rs", ".rs", "mini_core::engine::Engine", ctx)).toEqual({
      kind: "resolved",
      target: "crates/core/src/engine.rs",
    });
  });
  it("keeps std and third-party crates external", () => {
    expect(resolveImport("crates/app/src/main.rs", ".rs", "std::collections::HashMap", ctx).kind).toBe("external");
    expect(resolveImport("crates/app/src/main.rs", ".rs", "serde::Deserialize", ctx).kind).toBe("external");
  });
  it("flags a declared-but-missing mod as dangling", () => {
    const root = scratchRepo({
      "Cargo.toml": '[package]\nname = "solo"\nversion = "0.1.0"\n',
      "src/lib.rs": "mod missing;\n",
    });
    const c = buildResolveContext(scanRepo(root));
    expect(resolveImport("src/lib.rs", ".rs", "mod missing", c)).toEqual({
      kind: "dangling",
      reason: "missing-module",
    });
  });
  it("builds the cargo workspace with zero dangling edges", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ui-cargo-")), ".ultraindex");
    const { graph } = buildIndexArtifacts(CARGO);
    expect(graph.fileEdges.filter((e) => e.dangling)).toEqual([]);
    expect(
      graph.fileEdges.some((e) => e.from === "crates/app/src/main.rs" && e.to === "crates/core/src/engine.rs"),
    ).toBe(true);
  });
});

describe("resolveImport — Java", () => {
  const ctx = buildResolveContext(scanRepo(MAVEN));
  const from = "service/src/main/java/com/acme/api/Server.java";
  it("resolves a cross-root import via package mapping", () => {
    expect(resolveImport(from, ".java", "com.acme.core.model.User", ctx)).toEqual({
      kind: "resolved",
      target: "core/src/main/java/com/acme/core/model/User.java",
    });
  });
  it("resolves a wildcard import to the package's first type", () => {
    expect(resolveImport(from, ".java", "com.acme.core.util.*", ctx)).toEqual({
      kind: "resolved",
      target: "core/src/main/java/com/acme/core/util/Strings.java",
    });
  });
  it("resolves a nested-class import by peeling trailing segments", () => {
    expect(resolveImport(from, ".java", "com.acme.core.model.User.Builder", ctx)).toEqual({
      kind: "resolved",
      target: "core/src/main/java/com/acme/core/model/User.java",
    });
  });
  it("keeps stdlib and third-party packages external", () => {
    expect(resolveImport(from, ".java", "java.util.List", ctx).kind).toBe("external");
    expect(resolveImport(from, ".java", "com.google.common.collect.ImmutableList", ctx).kind).toBe("external");
  });
  it("builds the maven layout with zero dangling edges", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ui-maven-")), ".ultraindex");
    const { graph } = buildIndexArtifacts(MAVEN);
    expect(graph.fileEdges.filter((e) => e.dangling)).toEqual([]);
    expect(graph.fileEdges.some((e) => e.from === from && e.to.endsWith("User.java"))).toBe(true);
  });
});

// Java and C# resolution run on per-context indexes (one Map read per lookup)
// instead of probing every source root / scanning every namespace per import.
// A RepoScan built in memory: buildResolveContext only reads manifests (none
// here) from disk, so the layout needs no files.
function memScan(files: { rel: string; pkg?: string }[]) {
  return {
    root: "/nonexistent",
    files: files.map((f) => ({ ...f, ext: f.rel.slice(f.rel.lastIndexOf(".")), symbols: [], refs: [] })),
    languages: {},
    docText: new Map(),
  } as unknown as Parameters<typeof buildResolveContext>[0];
}

describe("resolveImport — Java/C# indexes", () => {
  it("keeps the shortest source root's file when two roots hold the same name", () => {
    const ctx = buildResolveContext(
      memScan([
        { rel: "a/src/com/x/Util.java", pkg: "com.x" },
        { rel: "src/com/x/Util.java", pkg: "com.x" },
        { rel: "src/com/y/Only.java", pkg: "com.y" },
        { rel: "a/src/com/z/B.java", pkg: "com.z" },
        { rel: "a/src/com/z/A.java", pkg: "com.z" },
      ]),
    );
    expect(ctx.javaRoots).toEqual(["src", "a/src"]);
    const from = "a/src/com/z/B.java";
    expect(resolveImport(from, ".java", "com.x.Util", ctx)).toEqual({ kind: "resolved", target: "src/com/x/Util.java" });
    // The shorter root has no com/z: the wildcard falls to the next root's dir,
    // and names its first file whatever order the files came in.
    expect(resolveImport(from, ".java", "com.z.*", ctx)).toEqual({ kind: "resolved", target: "a/src/com/z/A.java" });
    expect(resolveImport(from, ".java", "com.y.Only.Inner.m", ctx)).toEqual({
      kind: "resolved",
      target: "src/com/y/Only.java",
    });
    // A package dir is not a type, and a peel stops at two segments.
    expect(resolveImport(from, ".java", "com.y", ctx).kind).toBe("external");
    expect(resolveImport(from, ".java", "com.q.R", ctx).kind).toBe("external");
  });

  it("resolves a Maven repo with hundreds of source roots without a per-root probe", () => {
    const files: { rel: string; pkg: string }[] = [];
    for (let m = 0; m < 100; m++) {
      for (const kind of ["main", "test"]) {
        for (let i = 0; i < 10; i++) {
          files.push({ rel: `m${m}/src/${kind}/java/com/acme/m${m}/${kind}/C${i}.java`, pkg: `com.acme.m${m}.${kind}` });
        }
      }
    }
    const ctx = buildResolveContext(memScan(files));
    expect(ctx.javaRoots.length).toBe(200);
    const specs = ["java.util.List", "org.slf4j.Logger", "java.util.concurrent.*", "com.google.common.base.Strings"];
    specs.push("javax.inject.Inject", "org.junit.jupiter.api.Test", "java.io.File", "reactor.core.publisher.Mono");
    const t0 = performance.now();
    for (const f of files) for (const s of specs) expect(resolveImport(f.rel, ".java", s, ctx).kind).toBe("external");
    // 16,000 external specs: ~8s with a probe of all 200 roots per segment
    // peeled, a few ms with the index. The bound only catches a regression.
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(resolveImport(files[0]!.rel, ".java", "com.acme.m42.test.C7", ctx)).toEqual({
      kind: "resolved",
      target: "m42/src/test/java/com/acme/m42/test/C7.java",
    });
  });

  it("resolves a C# parent namespace to the byStr-first file under it, exact namespace first", () => {
    const ctx = buildResolveContext(
      memScan([
        { rel: "z/Acme.Core.cs", pkg: "Acme.Core" },
        { rel: "b/Acme.Core.Io.cs", pkg: "Acme.Core.Io" },
        { rel: "a/Acme.Web.cs", pkg: "Acme.Web" },
        { rel: "c/AcmeTools.cs", pkg: "AcmeTools" },
      ]),
    );
    const from = "c/AcmeTools.cs";
    expect(resolveImport(from, ".cs", "Acme", ctx)).toEqual({ kind: "resolved", target: "a/Acme.Web.cs" });
    expect(resolveImport(from, ".cs", "Acme.Core", ctx)).toEqual({ kind: "resolved", target: "z/Acme.Core.cs" });
    expect(resolveImport(from, ".cs", "Acme.Core.Io", ctx)).toEqual({ kind: "resolved", target: "b/Acme.Core.Io.cs" });
    // A dotted prefix, not a string prefix: `Acm` names no namespace.
    expect(resolveImport(from, ".cs", "Acm", ctx).kind).toBe("external");
    expect(resolveImport(from, ".cs", "System.Linq", ctx).kind).toBe("external");
  });
});
