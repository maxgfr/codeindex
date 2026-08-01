// The browser build as a PUBLISHED artifact.
//
// tests/browser-build.test.ts proves the bundle indexes correctly. This one
// proves a consumer can actually reach it: that `@maxgfr/codeindex/browser`
// resolves, that the files it points at are in the npm tarball, and that the
// declarations describe the API the docs promise. Those are all things that
// break silently — a missing `files` entry publishes a package whose exports
// map points at nothing, and nobody notices until an install fails.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

describe("@maxgfr/codeindex/browser", () => {
  it("is exported under an explicit subpath", () => {
    const entry = pkg.exports["./browser"];
    expect(entry, "package.json is missing the ./browser export").toBeTruthy();
    expect(entry.types).toBe("./scripts/engine.browser.d.mts");
    expect(entry.import).toBe("./scripts/engine.browser.mjs");
  });

  it("is NOT a browser condition on the main entry", () => {
    // Deliberate. A `browser` condition would let a bundler swap the Node build
    // for this one silently — and they are not interchangeable, because this
    // one indexes a filesystem the caller supplies rather than one that exists.
    // Swapping it in unasked would produce an empty index, not an error.
    expect(pkg.exports["."].browser).toBeUndefined();
    expect(pkg.browser).toBeUndefined();
  });

  it("ships every file its exports map points at", () => {
    for (const path of ["scripts/engine.browser.mjs", "scripts/engine.browser.d.mts"]) {
      expect(existsSync(join(REPO_ROOT, path)), `${path} does not exist`).toBe(true);
      expect(pkg.files, `${path} is missing from package.json "files"`).toContain(path);
    }
    // The grammars are the AST tier; a browser consumer serves them as assets.
    expect(pkg.files).toContain("scripts/grammars");
  });

  it("declares the browser-only API, not just the shared barrel", () => {
    const types = readFileSync(join(REPO_ROOT, "scripts", "engine.browser.d.mts"), "utf8");
    for (const name of [
      "mountFiles",
      "setFileBytes",
      "hasFileBytes",
      "pruneUnfetched",
      "residentBytes",
      "resetVfs",
      "loadGrammars",
      "mountRuntime",
      "mountGrammar",
      "grammarWasmName",
      "RUNTIME_WASM",
      "MountedFile",
      "GrammarLoad",
    ]) {
      expect(types, `${name} is missing from the browser declarations`).toContain(name);
    }
    // And the shared surface is still there — this is the same engine.
    for (const name of ["buildIndexArtifacts", "searchIndex", "renderGraphJson", "walk"]) {
      expect(types).toContain(name);
    }
  });

  it("carries no import of a node builtin", () => {
    // The failure this catches is specific, and it is the one that actually
    // happened: a build that leaves `import { readFileSync } from "fs"` in the
    // output succeeds, fails in a browser, and under Node silently reads the
    // REAL disk instead of the VFS — so walk() returns zero files against a
    // tree that is demonstrably mounted, with no error anywhere.
    //
    // Only the LEADING import block counts. esbuild hoists every real import to
    // the top of an ESM bundle, and the file also contains the text
    // `import { parentPort } from "node:worker_threads"` inside a template
    // literal — pool.ts builds that string as the source of a worker it may
    // spawn under Node. A naive file-wide regex flags that string and is wrong.
    const bundle = readFileSync(join(REPO_ROOT, "scripts", "engine.browser.mjs"), "utf8");
    const leading: string[] = [];
    for (const line of bundle.split("\n")) {
      const match = line.match(/^import\s[^;]*?from\s*["']([^"']+)["']/);
      if (match) {
        leading.push(match[1]!);
        continue;
      }
      if (line.trim() === "" || line.startsWith("//")) continue;
      break; // first real statement — every hoisted import is behind us
    }
    expect(leading, `top-level imports: ${leading.join(", ") || "(none)"}`).toEqual([]);
  });

  it("is documented for consumers", () => {
    const docs = join(REPO_ROOT, "docs", "BROWSER.md");
    expect(existsSync(docs)).toBe(true);
    expect(pkg.files).toContain("docs/BROWSER.md");
    const text = readFileSync(docs, "utf8");
    expect(text).toContain("@maxgfr/codeindex/browser");
    expect(text).toContain("loadGrammars");
  });

  it("keeps the built bundle in the build and reproducibility scripts", () => {
    expect(pkg.scripts.build).toContain("build-browser.mjs");
    expect(pkg.scripts["check:build"]).toContain("scripts/engine.browser.mjs");
    expect(pkg.scripts["check:build"]).toContain("scripts/engine.browser.d.mts");
  });
});

describe("committed artifacts and the release", () => {
  it("commits every artifact that check:build holds reproducible", () => {
    // The invariant, stated once rather than per-artifact: if `check:build`
    // fails when a file differs from its committed copy, then the release —
    // which bumps ENGINE_VERSION and rebuilds everything — must commit that
    // file too. Miss one and the next release leaves it pinned to the previous
    // version, and the following PR fails check:build for reasons that have
    // nothing to do with it. That is exactly how engine.browser.mjs broke.
    const release = JSON.parse(readFileSync(join(REPO_ROOT, ".releaserc.json"), "utf8"));
    const git = release.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git");
    const assets: string[] = git[1].assets;

    const guarded = pkg.scripts["check:build"]
      .split("git diff --exit-code --")[1]
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    expect(guarded.length).toBeGreaterThan(0);
    for (const path of guarded) {
      const covered = assets.some((asset) => asset === path || asset === `${path}/**` || asset.startsWith(`${path}/`));
      expect(covered, `${path} is verified by check:build but never committed by the release`).toBe(true);
    }
  });
});
