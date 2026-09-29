// `build`, `out`, `target` and `tmp` are build output by convention only: they
// are also ordinary package names. Skipped by name, typescript-go's
// tsc/internal/execute/build (7 Go files) vanished from the index and every
// import of it dangled. In a git worktree the walk keeps such a directory when
// git tracks files in it; untracked or gitignored ones stay skipped.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { walk, type WalkSkip } from "../src/walk.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { grepRepo } from "../src/grep.js";

const SOURCES: Record<string, string> = {
  "go.mod": "module example.com/m\n\ngo 1.21\n",
  "main.go": 'package main\n\nimport "example.com/m/pkg/out"\n\nfunc main() { out.Hello() }\n',
  "pkg/out/out.go": 'package out\n\nfunc Hello() string { return "hi" }\n',
  "src/main/java/com/acme/build/Builder.java": "package com.acme.build;\n\npublic class Builder { public void run() {} }\n",
  "src/main/java/com/acme/app/App.java":
    "package com.acme.app;\n\nimport com.acme.build.Builder;\n\npublic class App { void go() { new Builder().run(); } }\n",
};

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

// Tracked sources, plus untracked build output beside them.
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-build-dirs-"));
  write(root, SOURCES);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  write(root, { "build/classes/App.class.txt": "generated\n", "pkg/out/tmp/scratch.go": "package tmp\n" });
  return root;
}

const rels = (root: string, opts = {}): string[] => walk(root, opts).files.map((f) => f.rel).sort();

describe("build-output-named directories git tracks", () => {
  it("are walked, while untracked ones stay skipped", () => {
    const root = repo();
    const skips: WalkSkip[] = [];
    expect(walk(root, { onSkip: (s) => skips.push(s) }).files.map((f) => f.rel).sort()).toEqual(Object.keys(SOURCES).sort());
    const dirs = skips.filter((s) => s.reason === "ignore-dir").map((s) => s.rel).sort();
    expect(dirs).toEqual(["build", "pkg/out/tmp"]);
  });

  it("resolve: the Go import and the Java import land on the indexed files", () => {
    const { graph } = buildIndexArtifacts(repo(), {});
    const edge = (from: string, to: string) =>
      graph.fileEdges.find((e) => e.from === from && e.to === to && e.kind === "import");
    expect(edge("main.go", "pkg/out/out.go")?.dangling).toBeUndefined();
    expect(edge("src/main/java/com/acme/app/App.java", "src/main/java/com/acme/build/Builder.java")).toBeDefined();
    expect(graph.fileEdges.some((e) => e.dangling)).toBe(false);
  });

  it("stay skipped by name outside a git worktree, when gitignored, when listed, or on request", () => {
    const plain = mkdtempSync(join(tmpdir(), "ci-build-dirs-plain-"));
    write(plain, SOURCES);
    expect(rels(plain)).not.toContain("pkg/out/out.go");

    const root = repo();
    expect(rels(root, { ignoreDirs: ["out", "build", ".git"] })).not.toContain("pkg/out/out.go");
    expect(rels(root, { ignoreDirs: ["out"] })).toContain("src/main/java/com/acme/build/Builder.java");
    expect(rels(root, { trackedBuildDirs: false })).not.toContain("pkg/out/out.go");
    writeFileSync(join(root, ".gitignore"), "out/\n");
    expect(rels(root)).not.toContain("pkg/out/out.go");
    expect(rels(root)).toContain("src/main/java/com/acme/build/Builder.java");
  });

  // ripgrep excludes these names with globs and cannot re-include a tracked
  // one, so grep's JS backend keeps the by-name rule: both backends agree.
  it("grep's two backends still search the same files", () => {
    const root = repo();
    const js = grepRepo(root, "Hello|Builder", { noRipgrep: true });
    expect(js.map((h) => h.file)).not.toContain("pkg/out/out.go");
    expect(grepRepo(root, "Hello|Builder")).toEqual(js);
  });
});
