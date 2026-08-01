// The playground's engine host. Everything expensive happens here so the UI
// thread never blocks: fetching a repo, mounting it, loading wasm grammars,
// indexing, and answering commands.
//
// This module owns TRANSPORT — messages, network, the VFS mount. What the
// commands mean lives in commands.js, which is testable in Node.
//
// Hand-written ES modules, no build step. Only engine.browser.mjs is generated
// (and committed, and held byte-reproducible by `pnpm run check:build`), which
// keeps GitHub Pages a plain static publish with no dependency install.

import * as engine from "./engine.browser.mjs";
import { buildCommandTable, runCommand, describeCommands } from "./commands.js";
import { summariseIndex } from "./report.js";
import { resolveSource } from "./sources.js";

const MOUNT = "/repo";
const GRAMMAR_CACHE = "codeindex-grammars-v1";

// One request per file — no provider offers a bundle a browser can read (see
// sources.js) — so this is the knob that decides wall-clock. 40 keeps an HTTP/2
// pipeline full without looking like abuse; measured at 141 files in ~2.9 s.
const FETCH_CONCURRENCY = 40;

const commands = buildCommandTable(engine, MOUNT);

/** Current session: null until a repo is loaded, replaced wholesale on reload. */
let session = null;

const post = (message) => self.postMessage(message);
const progress = (phase, detail) => post({ type: "progress", phase, detail });

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "load") {
      post({ type: "loaded", summary: await loadRepo(message) });
    } else if (message.type === "run") {
      const result = runCommand(commands, session, message.command, message.args);
      post({ type: "result", id: message.id, command: message.command, args: message.args, result });
    }
  } catch (error) {
    post({ type: "error", id: message.id, message: String(error?.message ?? error) });
  }
};

/** Run `task` over `items` with a bounded number of requests in flight. */
async function pooled(items, limit, task) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) await task(items[cursor++]);
    }),
  );
}

// ---------------------------------------------------------------------------
// Grammars

async function fetchWasm(name) {
  const url = new URL(`./grammars/${name}`, self.location.href).href;
  // Cached so a second repo — and every reload — skips the download entirely.
  // Grammar wasm is immutable per release, so there is nothing to invalidate.
  const cache = self.caches ? await caches.open(GRAMMAR_CACHE) : null;
  const hit = cache ? await cache.match(url) : null;
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const response = await fetch(url);
  if (!response.ok) throw new Error(`grammar ${name}: HTTP ${response.status}`);
  if (cache) await cache.put(url, response.clone());
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Load exactly the grammars the walked extensions call for — grammarKeysForExts
 * is the engine's own answer to "which ones does this repo need", so a Go repo
 * pays 217 KB and never touches the 5.4 MB C# grammar.
 *
 * Returns the tier ACTUALLY achieved. A failed wasm fetch silently drops the
 * engine to the regex tier, and a playground that claims an AST tier it did not
 * get would be lying about the one thing it exists to demonstrate.
 */
async function loadGrammars(exts) {
  const keys = engine.grammarKeysForExts(exts);
  if (!keys.length) return { tier: "regex", loaded: [], failed: [], note: "no language in this repo ships a grammar" };

  try {
    engine.mountRuntime(await fetchWasm(engine.RUNTIME_WASM));
  } catch (error) {
    return { tier: "regex", loaded: [], failed: keys, note: `tree-sitter runtime unavailable (${error.message})` };
  }

  await Promise.all(
    keys.map(async (key) => {
      try {
        engine.mountGrammar(key, await fetchWasm(engine.grammarWasmName(key)));
      } catch {
        // Left unmounted: ensureGrammars records it as failed and that language
        // uses the regex tier, which is the engine's normal degradation.
      }
    }),
  );
  await engine.ensureGrammars(keys);

  const loaded = keys.filter((key) => engine.grammarReady(key)).sort();
  const failed = keys.filter((key) => !engine.grammarReady(key)).sort();
  return {
    tier: loaded.length ? "ast" : "regex",
    loaded,
    failed,
    note: failed.length ? `${failed.join(", ")} could not load; those languages use the regex tier` : "",
  };
}

// ---------------------------------------------------------------------------
// Load

async function loadRepo({ owner, repo, ref, maxFiles, maxBytes }) {
  session = null;
  engine.resetVfs();

  progress("manifest", `reading ${owner}/${repo}${ref ? `@${ref}` : ""}`);
  const source = await resolveSource(owner, repo, ref);

  // PHASE A — mount the manifest with sizes but NO contents.
  //
  // This is what makes "only download what the engine would index" true rather
  // than aspirational. lstatSync is satisfied by size alone, so the real walk()
  // runs here: gitignore chains, IGNORE_DIRS, LOCKFILES, BINARY_EXT, the 1 MiB
  // per-file cap. Not one of those rules is reimplemented in the playground,
  // and the `capped` flag the UI shows is the engine's own.
  progress("manifest", `${source.files.length.toLocaleString()} files listed via ${source.provider}`);
  engine.mountFiles(source.files.map((file) => ({ path: `${MOUNT}${file.path}`, size: file.size })));

  // The one thing walk needs real bytes for. They are tiny and few.
  const ignores = source.files.filter((file) => file.path.endsWith("/.gitignore") || file.path === "/.gitignore");
  await pooled(ignores, FETCH_CONCURRENCY, async (file) => {
    const response = await fetch(source.contentUrl(file.path));
    if (response.ok) engine.setFileBytes(`${MOUNT}${file.path}`, new Uint8Array(await response.arrayBuffer()));
  });

  const planned = engine.walk(MOUNT, { maxFiles });
  if (!planned.files.length) throw new Error("The walk kept no files — this ref may contain no indexable source.");

  // A byte budget on top of the file cap, applied in walk order. Walk order is
  // deterministic, so which files a budget drops is reproducible rather than a
  // function of whichever response arrived first.
  let selected = planned.files;
  let cappedByBytes = false;
  let running = 0;
  for (let i = 0; i < planned.files.length; i++) {
    running += planned.files[i].size;
    if (running > maxBytes) {
      selected = planned.files.slice(0, i);
      cappedByBytes = true;
      break;
    }
  }

  // PHASE B — fetch only what the walk kept.
  progress("fetch", `downloading ${selected.length.toLocaleString()} of ${source.files.length.toLocaleString()} files`);
  let done = 0;
  let unreadable = 0;
  await pooled(selected, FETCH_CONCURRENCY, async (file) => {
    const response = await fetch(source.contentUrl(`/${file.rel}`));
    if (response.ok) engine.setFileBytes(file.abs, new Uint8Array(await response.arrayBuffer()));
    else if (response.status === 429) throw new Error("The CDN is rate-limiting this browser. Wait a minute, or lower the file cap.");
    else unreadable++;
    if (++done % 25 === 0 || done === selected.length) {
      progress("fetch", `${done.toLocaleString()} / ${selected.length.toLocaleString()} files`);
    }
  });

  // Whatever the budget excluded is still mounted as a size-only entry. Drop it
  // now, so the scan's own walk sees exactly what was downloaded and no phantom
  // empty file reaches the index.
  const pruned = engine.pruneUnfetched();

  progress("grammars", "loading tree-sitter grammars");
  const grammars = await loadGrammars(new Set(selected.map((file) => file.ext)));

  progress("index", "walk → extract → resolve → graph");
  const startedAt = performance.now();
  const artifacts = engine.buildIndexArtifacts(MOUNT);
  const elapsedMs = Math.round(performance.now() - startedAt);

  session = { owner, repo, ref: source.ref, artifacts, grammars };

  return summariseIndex(engine, session, {
    manifestFiles: source.files.length,
    walkedFiles: planned.files.length,
    selected: selected.length,
    excluded: planned.excluded,
    pruned,
    unreadable,
    capped: planned.capped || cappedByBytes,
    cappedBy: planned.capped ? "file cap" : cappedByBytes ? "byte budget" : "",
    elapsedMs,
    provider: source.provider,
    providerNote: source.note,
  });
}

post({ type: "ready", engineVersion: engine.ENGINE_VERSION, commands: describeCommands(commands) });
