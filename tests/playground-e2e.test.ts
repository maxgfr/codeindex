// The playground's fetch pipeline, end to end, against the live network.
//
// Opt-in (CODEINDEX_PLAYGROUND_E2E=1) because it depends on GitHub and jsDelivr
// being reachable — the same reason tests/e2e-real-repos.test.ts is gated.
// Everything else about the playground is covered offline; this is the piece
// that can only be proven against the real thing:
//
//   · that a provider answers with a file list carrying sizes,
//   · that a browser-origin request for each file is actually allowed,
//   · and — the load-bearing claim — that mounting that list with SIZES BUT NO
//     CONTENT is enough for walk() to pick the download list, so the playground
//     never downloads a repository just to throw most of it away.
//
// It replicates worker.js's flow rather than importing it: worker.js is a
// module worker that owns `self` and postMessage, neither of which exists here.
// The parts that carry the logic — sources.js, the VFS, the engine — are real.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const RUN = process.env.CODEINDEX_PLAYGROUND_E2E === "1";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUNDLE = new URL("../scripts/engine.browser.mjs", import.meta.url).href;
const GRAMMARS = join(REPO_ROOT, "scripts", "grammars");
const SOURCES = new URL("../site/playground/sources.js", import.meta.url).href;
const POOL = new URL("../site/playground/fetch-pool.js", import.meta.url).href;
const MOUNT = "/repo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let engine: Any;
let resolveSource: Any;
// The real pool and the real per-file retry, not a copy of them. A copy is what
// this file used to carry, and a copy cannot notice when the shipped one starts
// behaving differently — which is precisely the bug that froze the page on a
// 2,900-file repository.
let pooled: Any;
let fetchWithRetry: Any;

/** worker.js's loadRepo, minus the messaging — using the real source layer. */
async function loadRepo(owner: string, repo: string, maxFiles: number, maxBytes: number) {
  engine.resetVfs();

  const source = await resolveSource(owner, repo, "");
  const manifest = { files: source.files };

  // PHASE A — sizes only, no bytes.
  engine.mountFiles(source.files.map((file: Any) => ({ path: `${MOUNT}${file.path}`, size: file.size })));
  const ignores = source.files.filter((file: Any) => file.path.endsWith("/.gitignore"));
  await pooled(ignores, 20, async (file: Any, signal: AbortSignal) => {
    const response = await fetchWithRetry(source.contentUrl(file.path), { signal });
    if (response.ok) engine.setFileBytes(`${MOUNT}${file.path}`, new Uint8Array(await response.arrayBuffer()));
  });

  const planned = engine.walk(MOUNT, { maxFiles });

  let selected = planned.files;
  let running = 0;
  for (let i = 0; i < planned.files.length; i++) {
    running += planned.files[i].size;
    if (running > maxBytes) {
      selected = planned.files.slice(0, i);
      break;
    }
  }

  // PHASE B — fetch only what the walk kept.
  // A provider's list and its content endpoint can disagree (jsDelivr's branch
  // snapshot lags its CDN, so it lists files that no longer exist). Not
  // something the playground can fix, so what matters is that it degrades
  // honestly: the file is counted, pruned, and never indexed as empty.
  let unreadable = 0;
  await pooled(selected, 40, async (file: Any, signal: AbortSignal) => {
    const response = await fetchWithRetry(source.contentUrl(`/${file.rel}`), { signal });
    if (response.ok) engine.setFileBytes(file.abs, new Uint8Array(await response.arrayBuffer()));
    else unreadable++;
  });
  const pruned = engine.pruneUnfetched();

  const keys: string[] = engine.grammarKeysForExts(new Set(selected.map((file: Any) => file.ext)));
  engine.mountRuntime(new Uint8Array(readFileSync(join(GRAMMARS, engine.RUNTIME_WASM))));
  for (const key of keys) engine.mountGrammar(key, new Uint8Array(readFileSync(join(GRAMMARS, engine.grammarWasmName(key)))));
  await engine.ensureGrammars(keys);

  return { source, manifest, planned, selected, pruned, unreadable, keys, artifacts: engine.buildIndexArtifacts(MOUNT) };
}

describe.skipIf(!RUN)("playground against the live network", () => {
  beforeAll(async () => {
    engine = await import(/* @vite-ignore */ BUNDLE);
    ({ resolveSource } = await import(/* @vite-ignore */ SOURCES));
    ({ pooled, fetchWithRetry } = await import(/* @vite-ignore */ POOL));
  });

  it("indexes gin-gonic/gin end to end, on the AST tier", async () => {
    const { source, manifest, planned, selected, artifacts, keys, unreadable } = await loadRepo("gin-gonic", "gin", 1500, 12_000_000);

    // gin lives on master, so this also exercises the main -> master fallback.
    expect(source.ref).toBe("master");
    expect(["github", "jsdelivr"]).toContain(source.provider);

    // The walk must have thrown work away — that is the mechanism under test.
    expect(manifest.files.length).toBeGreaterThan(planned.files.length);
    expect(selected.length).toBeGreaterThan(50);

    expect(keys).toContain("go");
    expect(engine.grammarReady("go"), "the Go grammar must load, or this proves nothing about the AST tier").toBe(true);

    expect(artifacts.graph.files.length).toBe(selected.length - unreadable);
    expect(Object.keys(artifacts.symbols.defs).length).toBeGreaterThan(200);
    expect(artifacts.graph.fileEdges.length).toBeGreaterThan(0);
    expect(artifacts.graph.languages.go).toBeGreaterThan(50);

    // EVERY indexed file has real contents behind it. This is the guarantee
    // pruneUnfetched exists for: a file the CDN refused must be absent, not
    // present and empty.
    for (const file of artifacts.graph.files) {
      expect(engine.hasFileBytes(`${MOUNT}/${file.rel}`), `${file.rel} was indexed without bytes`).toBe(true);
    }
  }, 180_000);

  it("picks the download list from sizes alone, before fetching content", async () => {
    engine.resetVfs();
    const source = await resolveSource("pallets", "flask", "");
    const manifest = { files: source.files };

    engine.mountFiles(source.files.map((file: Any) => ({ path: `${MOUNT}${file.path}`, size: file.size })));
    const planned = engine.walk(MOUNT, { maxFiles: 1500 });

    // Not one content byte has been fetched at this point, yet the walk has a
    // complete, filtered keep-list — with lockfiles, binaries and ignored
    // directories already gone.
    expect(planned.files.length).toBeGreaterThan(0);
    expect(planned.files.length).toBeLessThan(manifest.files.length);
    expect(planned.files.some((file: Any) => file.rel.includes("node_modules"))).toBe(false);
    expect(planned.files.every((file: Any) => file.size <= 1024 * 1024)).toBe(true);
    expect(engine.residentBytes()).toBe(0);
  }, 120_000);

  it("honours the byte budget and keeps the remainder out of the index", async () => {
    const { planned, selected, pruned, unreadable } = await loadRepo("gin-gonic", "gin", 1500, 200_000);
    expect(selected.length).toBeLessThan(planned.files.length);
    // Pruning covers everything mounted without contents: what the walk never
    // wanted, what the budget cut, and what the CDN refused. The exact count is
    // manifest-shaped and not worth pinning; that it happened, and what it
    // guarantees downstream, is.
    expect(pruned).toBeGreaterThan(planned.files.length - selected.length);
    // The guarantee: a second walk sees only what was actually downloaded.
    expect(engine.walk(MOUNT).files.length).toBe(selected.length - unreadable);
  }, 180_000);
});
