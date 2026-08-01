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
import { pooled, fetchWithRetry, failureBudget } from "./fetch-pool.js";

const MOUNT = "/repo";
const GRAMMAR_CACHE = "codeindex-grammars-v1";

// One request per file — no provider offers a bundle a browser can read (see
// sources.js) — so this is the knob that decides wall-clock. 40 keeps an HTTP/2
// pipeline full without looking like abuse; measured at 141 files in ~2.9 s.
// At the other end of the scale that is ~2,900 requests for a repo the size of
// socialgouv/code-du-travail-numerique, where a transient refusal is a
// certainty rather than a risk — which is why the pool retries (fetch-pool.js)
// instead of treating one 429 as the end of the load.
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
    } else if (message.type === "loadLocal") {
      post({ type: "loaded", summary: await loadLocal(message) });
    } else if (message.type === "run") {
      const result = runCommand(commands, session, message.command, message.args);
      post({ type: "result", id: message.id, command: message.command, args: message.args, result });
    }
  } catch (error) {
    post({ type: "error", id: message.id, message: String(error?.message ?? error) });
  }
};

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

// Picking the minimal grammar set, mounting it in the right order and
// reporting the achieved tier is `engine.loadGrammars` — shipped with the
// browser build precisely because every consumer needs that same sequence. All
// this module supplies is the transport above: same-origin, Cache-API-backed.

// ---------------------------------------------------------------------------
// Load

/**
 * A transport refusing to hand over a file, as opposed to not having it.
 * Carries only the cause; indexManifest adds how far the load had got, which is
 * the part that tells the user whether they hit a limit or a broken repo.
 */
class TransportError extends Error {}

/**
 * PHASE A → PHASE B → index. Shared by both sources, because they differ in
 * exactly one thing: where a file's bytes come from.
 *
 * @param manifest  [{ path, size }] — paths rooted at "/", sizes REQUIRED
 * @param readBytes (path, signal) => Uint8Array | null — null means "listed but
 *                  not served", which is counted as unreadable rather than
 *                  indexed as an empty file
 */
async function indexManifest({ manifest, readBytes, maxFiles, maxBytes, verb, escapeHatch, session: identity, provider, providerNote }) {
  // PHASE A — mount the manifest with sizes but NO contents.
  //
  // This is what makes "only read what the engine would index" true rather
  // than aspirational. lstatSync is satisfied by size alone, so the real walk()
  // runs here: gitignore chains, IGNORE_DIRS, LOCKFILES, BINARY_EXT, the 1 MiB
  // per-file cap. Not one of those rules is reimplemented in the playground,
  // and the `capped` flag the UI shows is the engine's own.
  engine.mountFiles(manifest.map((file) => ({ path: `${MOUNT}${file.path}`, size: file.size })));

  // The one thing walk needs real bytes for. They are tiny and few.
  const ignores = manifest.filter((file) => file.path.endsWith("/.gitignore") || file.path === "/.gitignore");
  await pooled(ignores, FETCH_CONCURRENCY, async (file, signal) => {
    const bytes = await readBytes(file.path, signal);
    if (bytes) engine.setFileBytes(`${MOUNT}${file.path}`, bytes);
  });

  const planned = engine.walk(MOUNT, { maxFiles });
  if (!planned.files.length) throw new Error("The walk kept no files — this source may contain no indexable code.");

  // An OPTIONAL byte budget on top of the optional file cap. Neither is set by
  // default — the whole repository is indexed, which is also walk()'s own
  // default. When one is set it applies in walk order, and walk order is
  // deterministic, so which files a budget drops is reproducible rather than a
  // function of whichever response happened to arrive first.
  let selected = planned.files;
  let cappedByBytes = false;
  if (maxBytes) {
    let running = 0;
    for (let i = 0; i < planned.files.length; i++) {
      running += planned.files[i].size;
      if (running > maxBytes) {
        selected = planned.files.slice(0, i);
        cappedByBytes = true;
        break;
      }
    }
  }

  // PHASE B — read only what the walk kept.
  progress("fetch", `${verb} ${selected.length.toLocaleString()} of ${manifest.length.toLocaleString()} files`);
  let done = 0;
  let unreadable = 0;
  const refusals = failureBudget(selected.length);

  try {
    await pooled(selected, FETCH_CONCURRENCY, async (file, signal) => {
      let bytes;
      try {
        bytes = await readBytes(`/${file.rel}`, signal);
      } catch (error) {
        // A refusal this file could not get past. Within budget it is dropped
        // like any other unreadable file — the alternative is losing an
        // otherwise complete index because one request in a few thousand was
        // unlucky. Past the budget the transport, not the file, is the problem.
        if (signal.aborted || !(error instanceof TransportError) || !refusals.spend()) throw error;
        bytes = null;
      }
      if (bytes) engine.setFileBytes(file.abs, bytes);
      else unreadable++;
      if (++done % 25 === 0 || done === selected.length) {
        progress("fetch", `${done.toLocaleString()} / ${selected.length.toLocaleString()} files`);
      }
    });
  } catch (error) {
    // Every way a large load dies mid-stream reads the same to the user — the
    // files stopped arriving — and they share the same ways out, so they are
    // said in the same words rather than surfacing a bare "Failed to fetch".
    if (error instanceof TransportError) {
      throw new Error(`${error.message} after ${done.toLocaleString()} of ${selected.length.toLocaleString()} files. ${escapeHatch}`);
    }
    throw error;
  }

  // Whatever the budget excluded is still mounted as a size-only entry. Drop it
  // now, so the scan's own walk sees exactly what was downloaded and no phantom
  // empty file reaches the index.
  const pruned = engine.pruneUnfetched();

  progress("grammars", "loading tree-sitter grammars");
  const grammars = await engine.loadGrammars(new Set(selected.map((file) => file.ext)), fetchWasm);

  progress("index", "walk → extract → resolve → graph");
  const startedAt = performance.now();
  const artifacts = engine.buildIndexArtifacts(MOUNT);
  const elapsedMs = Math.round(performance.now() - startedAt);

  session = { ...identity, artifacts, grammars };

  return summariseIndex(engine, session, {
    manifestFiles: manifest.length,
    walkedFiles: planned.files.length,
    selected: selected.length,
    excluded: planned.excluded,
    pruned,
    unreadable,
    capped: planned.capped || cappedByBytes,
    cappedBy: planned.capped ? "file cap" : cappedByBytes ? "byte budget" : "",
    elapsedMs,
    provider,
    providerNote,
  });
}

// One request per file against a CDN that rate-limits, so this is the path with
// failure modes: retries live in fetch-pool.js, and what survives them stops
// the whole pool rather than letting a dead load keep reporting progress.
async function loadRepo({ owner, repo, ref, maxFiles, maxBytes }) {
  session = null;
  engine.resetVfs();

  progress("manifest", `reading ${owner}/${repo}${ref ? `@${ref}` : ""}`);
  const source = await resolveSource(owner, repo, ref);
  progress("manifest", `${source.files.length.toLocaleString()} files listed via ${source.provider}`);

  const readBytes = async (path, signal) => {
    let response;
    try {
      response = await fetchWithRetry(source.contentUrl(path), { signal });
    } catch (error) {
      // The pool is already shutting this load down over an earlier failure —
      // that first error is the one worth reporting, not this abort.
      if (signal.aborted) throw error;
      // Otherwise the request did not merely fail, it never completed: after
      // the retries and their backoff the connection is still being refused.
      // A browser reports that as a bare "Failed to fetch", which on its own
      // tells the user nothing about what to do next.
      throw new TransportError("The connection to GitHub was refused");
    }
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    // Still refusing after the retries and their backoff: the limit is not a
    // blip, and no amount of waiting inside this load will clear it.
    if (response.status === 429) throw new TransportError("GitHub is rate-limiting this browser");
    return null; // listed by the provider, not served by it
  };

  return indexManifest({
    manifest: source.files,
    readBytes,
    maxFiles,
    maxBytes,
    verb: "downloading",
    escapeHatch:
      "A repository this size needs one request per file, and a few thousand in a row is enough to trip a limit. " +
      "Wait a few minutes, index part of it by adding ?files=1500 to this page's URL, or use “Open a local folder” — that reads from disk and never touches the network.",
    session: { owner, repo, ref: source.ref },
    provider: source.provider,
    providerNote: source.note,
  });
}

// The same pipeline with the network taken out. A File already knows its size,
// so PHASE A costs nothing and walk() still picks the keep-list from sizes
// alone — node_modules is never read rather than read and thrown away.
async function loadLocal({ name, files, maxFiles, maxBytes }) {
  session = null;
  engine.resetVfs();

  progress("manifest", `${files.length.toLocaleString()} files in ${name}`);

  const byPath = new Map(files.map((file) => [file.path, file.file]));
  const readBytes = async (path) => {
    const file = byPath.get(path);
    return file ? new Uint8Array(await file.arrayBuffer()) : null;
  };

  return indexManifest({
    manifest: files,
    readBytes,
    maxFiles,
    maxBytes,
    verb: "reading",
    escapeHatch: "Try opening the folder again.",
    session: { owner: "", repo: name, ref: "" },
    provider: "local",
    providerNote: "",
  });
}

post({ type: "ready", engineVersion: engine.ENGINE_VERSION, commands: describeCommands(commands) });
