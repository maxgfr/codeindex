// The test that decides whether the browser build is real.
//
// A port of an indexer to a new environment is only worth having if it produces
// the SAME index. So this suite does not check that the browser bundle "works";
// it checks that indexing a repo through the in-memory VFS yields graph.json
// and symbols.json BYTE-IDENTICAL to what the Node build produces from the same
// bytes on disk. Anything less would mean the playground demonstrates a fork
// rather than the engine.
//
// It exercises the SHIPPED ARTIFACT — scripts/engine.browser.mjs, the committed
// file published as `@maxgfr/codeindex/browser` and served by GitHub Pages —
// not a re-resolution of src/. That is the point: the artifact is what users
// run. `pnpm run check:build` keeps it in sync with the source, and CI runs it.
//
// The fixtures are copied to an OS temp dir first, outside any git work tree,
// so `headCommit` returns undefined on the Node side exactly as it does in the
// browser (where child_process reports git as missing). Both sides then agree
// on every field, and the assertion can be plain equality with no normalisation
// hiding a difference.

import { describe, it, expect, beforeAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import { renderSymbolsJson } from "../src/render/symbols-json.js";
import { grammarKeysForExts } from "../src/ast/loader.js";
import { searchIndex } from "../src/bm25.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = new URL("../scripts/engine.browser.mjs", import.meta.url).href;
const GRAMMARS = join(REPO_ROOT, "scripts", "grammars");

// The bundle is plain ESM with no Node-specific imports left in it, so Node can
// load it directly. Typed as `any`: it ships without declarations by design
// (consumers import ./engine.mjs for types), and the shape under test is
// exactly the barrel's, which the rest of the suite already covers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Bundle = any;

let browser: Bundle;

beforeAll(async () => {
  browser = await import(/* @vite-ignore */ BUNDLE);
});

/** Every file under `dir`, as VFS mount records rooted at `mountRoot`. */
function collect(dir: string, mountRoot: string, base = dir): { path: string; size: number; bytes: Uint8Array }[] {
  const out: { path: string; size: number; bytes: Uint8Array }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      out.push(...collect(abs, mountRoot, base));
    } else {
      const bytes = new Uint8Array(readFileSync(abs));
      out.push({ path: `${mountRoot}/${relative(base, abs).split(/[\\/]/).join("/")}`, size: bytes.byteLength, bytes });
    }
  }
  return out;
}

/** Copy a fixture out of the work tree so neither side can see a git repo. */
function isolate(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codeindex-browser-"));
  cpSync(join(REPO_ROOT, "tests", "fixtures", fixture), join(dir, "repo"), { recursive: true });
  return join(dir, "repo");
}

/** Index a fixture inside the bundle's VFS, mounting only the grammars it needs. */
async function indexInBrowser(diskRoot: string): Promise<{ graph: string; symbols: string; scan: Bundle }> {
  const MOUNT = "/repo";
  browser.resetVfs();

  const files = collect(diskRoot, MOUNT);
  browser.mountFiles(files);

  // The same minimal grammar set the playground computes: map the extensions
  // actually present through grammarKeysForExts, and load nothing else.
  const exts = new Set(files.map((f) => extname(f.path).toLowerCase()));
  const keys: string[] = browser.grammarKeysForExts(exts);
  browser.mountRuntime(new Uint8Array(readFileSync(join(GRAMMARS, browser.RUNTIME_WASM))));
  for (const key of keys) {
    browser.mountGrammar(key, new Uint8Array(readFileSync(join(GRAMMARS, browser.grammarWasmName(key)))));
  }
  await browser.ensureGrammars(keys);

  // Every grammar the repo needs must have actually loaded. Without this the
  // suite would still pass if BOTH sides silently fell back to regex — which is
  // the one way a byte-equality test can be vacuously true.
  for (const key of keys) {
    expect(browser.grammarReady(key), `grammar "${key}" did not load in the browser bundle`).toBe(true);
  }

  const artifacts = browser.buildIndexArtifacts(MOUNT);
  return {
    graph: browser.renderGraphJson(artifacts.graph),
    symbols: browser.renderSymbolsJson(artifacts.symbols),
    scan: artifacts.scan,
  };
}

describe("browser bundle", () => {
  // mini-repo covers three grammars (TypeScript, Go, Python) plus markdown;
  // the monorepos add workspace detection and cross-package resolution, which
  // is where a path-shim difference would show up first.
  for (const fixture of ["mini-repo", "nx-monorepo", "mixed-monorepo"]) {
    it(`produces byte-identical artifacts to the Node build for ${fixture}`, async () => {
      const diskRoot = isolate(fixture);

      const node = buildIndexArtifacts(diskRoot);
      const nodeGraph = renderGraphJson(node.graph);
      const nodeSymbols = renderSymbolsJson(node.symbols);

      // Guard against the vacuous pass: if the Node side found no symbols there
      // would be nothing for the browser side to disagree about.
      expect(Object.keys(node.symbols.defs).length).toBeGreaterThan(0);
      expect(node.graph.files.length).toBeGreaterThan(0);

      const web = await indexInBrowser(diskRoot);

      expect(web.graph).toBe(nodeGraph);
      expect(web.symbols).toBe(nodeSymbols);
    });
  }

  it("keeps the walk's own filtering policy, rather than reimplementing it", async () => {
    const diskRoot = isolate("mini-repo");
    browser.resetVfs();
    browser.mountFiles(collect(diskRoot, "/repo"));

    const web = browser.walk("/repo");
    const node = (await import("../src/walk.js")).walk(diskRoot);

    expect(web.files.map((f: { rel: string }) => f.rel)).toEqual(node.files.map((f) => f.rel));
    expect(web.capped).toBe(node.capped);
    expect(web.excluded).toBe(node.excluded);
  });

  it("decides the download list from sizes alone, before any content is fetched", async () => {
    // This is the two-phase mount the playground relies on: mount the manifest
    // with NO bytes, and walk() still returns the exact keep-list — which is
    // what makes "only download what the engine would index" true rather than
    // aspirational.
    const diskRoot = isolate("mini-repo");
    const all = collect(diskRoot, "/repo");

    browser.resetVfs();
    browser.mountFiles(
      all.map((f) => ({
        path: f.path,
        size: f.size,
        // Phase A fetches .gitignore contents only; everything else is metadata.
        bytes: f.path.endsWith("/.gitignore") ? f.bytes : undefined,
      })),
    );

    const skeletonWalk = browser.walk("/repo");
    expect(skeletonWalk.files.length).toBeGreaterThan(0);

    browser.resetVfs();
    browser.mountFiles(all);
    const fullWalk = browser.walk("/repo");

    expect(skeletonWalk.files.map((f: { rel: string }) => f.rel)).toEqual(fullWalk.files.map((f: { rel: string }) => f.rel));
  });

  it("runs BM25 search over an index built in the VFS", async () => {
    const diskRoot = isolate("mini-repo");
    const web = await indexInBrowser(diskRoot);
    const node = buildIndexArtifacts(diskRoot);

    const webHits = browser.searchIndex(web.scan, "client");
    const nodeHits = searchIndex(node.scan, "client");

    expect(webHits.length).toBeGreaterThan(0);
    expect(webHits.map((h: { file: string; score: number }) => [h.file, h.score])).toEqual(nodeHits.map((h) => [h.file, h.score]));
  });

  it("reports git as unavailable instead of guessing a commit", async () => {
    const diskRoot = isolate("mini-repo");
    const web = await indexInBrowser(diskRoot);
    expect(web.scan.commit).toBeUndefined();
  });

  it("invalidates a cached scan after a same-size VFS edit", () => {
    browser.resetVfs();
    const before = new TextEncoder().encode("export const aa = 1;\n");
    const after = new TextEncoder().encode("export const bb = 2;\n");
    browser.mountFiles([{ path: "/repo/a.ts", size: before.byteLength, bytes: before }]);
    const first = browser.scanRepo("/repo");
    const cache = new Map(first.files.map((f: Bundle) => [f.rel, { hash: f.hash, record: f, size: f.size, mtimeMs: first.mtimes.get(f.rel) }]));

    browser.setFileBytes("/repo/a.ts", after);
    const second = browser.scanRepo("/repo", { cache });

    expect(second.files[0].symbols.map((s: Bundle) => s.name)).toContain("bb");
    expect(second.files[0].symbols.map((s: Bundle) => s.name)).not.toContain("aa");
    expect(second.files[0].hash).not.toBe(first.files[0].hash);
  });

  it("round-trips embedding artifacts through the browser bundle", () => {
    const index = {
      embedVersion: 1,
      modelId: "fixture",
      dim: 3,
      records: [{ file: "src/a.ts", symbol: "a", line: 2, vec: new Int8Array([-128, 0, 127]) }],
    };
    const bytes = browser.serializeEmbeddings(index);
    const view = bytes.subarray(0);
    const decoded = browser.deserializeEmbeddings(view);
    expect(decoded).toEqual(index);
  });

  it("retries a grammar after it becomes available later", async () => {
    browser.resetVfs();
    const runtime = new Uint8Array(readFileSync(join(GRAMMARS, browser.RUNTIME_WASM)));
    const first = await browser.loadGrammars(new Set([".scala"]), async (name: string) => {
      if (name === "scala.wasm") throw new Error("not mounted yet");
      return runtime;
    });
    expect(first.failed).toEqual(["scala"]);

    const second = await browser.loadGrammars(new Set([".scala"]), async (name: string) => {
      return new Uint8Array(readFileSync(join(GRAMMARS, name)));
    });
    expect(second.failed).toEqual([]);
    expect(second.loaded).toEqual(["scala"]);
  });
});
