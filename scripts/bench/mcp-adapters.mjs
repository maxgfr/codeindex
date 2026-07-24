// Per-server MCP adapters for the benchmark harness. Consumed by
// mcp-probe.mjs (import contract in its header comment): adapterFor(server,
// opts) returns pure config + pure functions — the probe and bench.mjs own
// ALL timing. Every adapter is total: a missing binary surfaces as a spawn
// failure ({ok:false} from the MCP client) or {ok:false, reason} from
// prime(), never an exception.
//
// Known-good versions (recorded, not enforced): serena 1.6.1 (serena-agent),
// graphifyy 0.9.25 with the [mcp] extra, falcon v0.6.4, codeindex 2.13.0.
// Tool names and parameter schemas below were verified against the real
// servers via live tools/list on 2026-07-24.
//
// Members beyond the probe contract (used by the bench orchestrator, ignored
// by the probe):
//   perRepoSupport(repoLang) -> null | reason-string
//     Language gate; only falcon excludes anything (rust). Synthetic
//     --repo-dir repos carry lang "auto" and MUST pass every gate, so gates
//     are positive exclusions only — never equality checks on a lang list.
//   cleanCold(dir) -> void
//     Removes on-disk artifacts so the next BUILD is cold. Used by the bench
//     cold/determinism scenarios; the probe never calls it — MCP sessions run
//     on primed artifacts (graphify-mcp and `falcon mcp serve` cannot even
//     start without their artifact files).

import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCmd, whichOrLocal } from "./competitors.mjs";

// npm-install-class ceiling for prime/cold-index ops (spec timeout policy).
const PRIME_TIMEOUT_MS = 600_000;

// Sanitized spawn env shared by ALL competitor prime/MCP spawns: strips LLM
// API keys so the keyless code paths are what we time (graphify would
// otherwise reach for LLM-labeled clustering), and opts serena out of usage
// reporting. PATH passes through unchanged — node/npm/gopls/rust-analyzer
// must stay reachable; detection hands us absolute binary paths anyway.
export function benchEnv() {
  const env = { ...process.env, SERENA_USAGE_REPORTING: "false" };
  for (const k of [
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
  ]) delete env[k];
  return env;
}

// tools/list entries arrive from the probe as full tool objects
// ({name, inputSchema}); bare name strings are tolerated for older callers.
function toolMap(tools) {
  const m = new Map();
  for (const t of tools ?? []) {
    if (typeof t === "string") m.set(t, { name: t });
    else if (t?.name) m.set(t.name, t);
  }
  return m;
}

// First tool present from a preference-ordered name list.
function pickTool(map, prefs) {
  for (const n of prefs) if (map.has(n)) return map.get(n);
  return undefined;
}

// Schema-driven param choice: first preferred property the tool's inputSchema
// actually declares; falls back to the head of the list when only bare names
// were introspectable.
function pickParam(tool, prefs) {
  const props = tool?.inputSchema?.properties;
  if (props) for (const p of prefs) if (p in props) return p;
  return prefs[0];
}

const joinText = (result) => (result?.content ?? []).map((c) => c?.text ?? "").join("");
const rmrf = (p) => rmSync(p, { recursive: true, force: true });
const primeReason = (r) =>
  r.missing ? "binary missing" : ((r.stderr || r.stdout || "").trim().replace(/\s+/g, " ").slice(0, 300) || `exit ${r.code}`);

// ---------------------------------------------------------------------------
// codeindex (self, over MCP). Symmetric with falcon/graphify: prime() writes a
// persisted .codeindex/ index (`codeindex index --out`) and the MCP server
// PRELOADS it on the first tool call — a pure optimization, the served
// responses stay byte-identical to a cold build (mcp.ts's preloadSession, guarded
// by the same T4 stat/sha freshness oracle the CLI's index fastpath uses). So
// activation loads-not-rebuilds, exactly the falcon pattern; the parse cost lives
// in the Cold index column. `repo` is REQUIRED in every tool's arguments even
// though the server could infer it from cwd [probed]; the preload keys off it.
function codeindexAdapter(opts) {
  // engine.mjs is a pure module (no main guard); the runnable entry is cli.mjs.
  const cli = opts.engine ?? fileURLToPath(new URL("../cli.mjs", import.meta.url));
  return {
    key: "codeindex",
    perRepoSupport: () => null, // all 7 repos
    spawn(dir) { return { cmd: process.execPath, args: [cli, "mcp"], cwd: dir }; },
    // Prime a persisted index the MCP server preloads on activation — the same
    // untimed one-time build the other servers do (falcon index / graphify
    // update). --out <dir>/.codeindex is exactly where mcp.ts's preload looks.
    prime(dir) {
      const r = runCmd(process.execPath, [cli, "index", "--repo", dir, "--out", join(dir, ".codeindex")],
        { cwd: dir, env: benchEnv(), timeoutMs: PRIME_TIMEOUT_MS });
      return r.ok ? { ok: true } : { ok: false, reason: primeReason(r) };
    },
    cleanCold(dir) { rmrf(join(dir, ".codeindex")); }, // nothing global is written
    tasks(tools) {
      const m = toolMap(tools);
      return {
        find: m.has("find_symbol")
          ? (ctx) => ({ name: "find_symbol", arguments: { repo: ctx.dir, namePath: ctx.symbol } })
          : undefined,
        refs: m.has("find_references")
          ? (ctx) => ({ name: "find_references", arguments: { repo: ctx.dir, name: ctx.symbol } })
          : undefined,
        overview: m.has("symbols_overview")
          ? (ctx) => ({ name: "symbols_overview", arguments: { repo: ctx.dir, file: ctx.file } })
          : undefined,
      };
    },
    extractText: joinText,
    defFileFrom(text) {
      try { return JSON.parse(text)?.[0]?.file; } catch { return undefined; }
    },
  };
}

// ---------------------------------------------------------------------------
// serena (oraios/serena, serena-agent 1.6.1). The MCP server speaks stdio
// with Click BOOLEAN flags in value style; dashboard/GUI stay off so stdout
// carries only JSON-RPC (startup INFO lines go to stderr) [probed].
function serenaAdapter(opts) {
  const bin = opts.bin ?? whichOrLocal("serena");
  return {
    key: "serena",
    // All 7 repos: per-language LS prerequisites (gopls, rust-analyzer,
    // node/npm, uv) are recorded by detectSerena().extra and gated per repo
    // by the orchestrator — not here.
    perRepoSupport: () => null,
    spawn(dir) {
      return {
        cmd: bin,
        args: [
          "start-mcp-server", "--project", dir,
          "--context", "agent", "--mode", "no-onboarding", "--mode", "no-memories",
          "--transport", "stdio",
          "--enable-web-dashboard", "false", "--open-web-dashboard", "false",
          "--enable-gui-log-window", "false",
          "--log-level", "ERROR", "--tool-timeout", "110",
        ],
        cwd: dir,
        env: benchEnv(),
      };
    },
    // One `project index` on the scratch copy so MCP calls hit the MD5
    // content-hash cache; also absorbs the one-time per-language language-
    // server download into ~/.serena/language_servers (machine warmup).
    // On a repo without .serena/project.yml, auto-generation asks one
    // interactive [y/N] question PER additionally-detected language; a bare
    // EOF aborts the whole index ("Error: EOF when reading a line" [probed]).
    // Newlines take the default (N: main language only) — total and
    // language-agnostic, and needed on EVERY cold run since cleanCold removes
    // the generated project.yml along with the cache.
    prime(dir) {
      if (!bin) return { ok: false, reason: "serena binary not found" };
      const r = runCmd(bin, ["project", "index", dir, "--log-level", "ERROR", "--timeout", "30"],
        { cwd: dir, env: benchEnv(), input: "\n".repeat(64), timeoutMs: PRIME_TIMEOUT_MS });
      return r.ok ? { ok: true } : { ok: false, reason: primeReason(r) };
    },
    // Project cache only. NEVER touch ~/.serena — deleting it would re-trigger
    // language-server downloads mid-benchmark.
    cleanCold(dir) { rmrf(join(dir, ".serena")); },
    tasks(tools) {
      const m = toolMap(tools);
      const find = m.get("find_symbol");
      const refs = m.get("find_referencing_symbols");
      const over = m.get("get_symbols_overview");
      // v1.6.1 renamed find_symbol's param to name_path_pattern (its schema no
      // longer lists a name_path alias [probed]); find_referencing_symbols
      // STILL takes name_path, plus the REQUIRED relative_path of the file
      // holding the definition — parsed from the find response (defFileFrom).
      const findParam = pickParam(find, ["name_path_pattern", "name_path"]);
      return {
        find: find
          ? (ctx) => ({ name: "find_symbol", arguments: { [findParam]: ctx.symbol, include_body: false } })
          : undefined,
        refs: refs
          ? (ctx) => (ctx.defFile
            ? { name: "find_referencing_symbols", arguments: { name_path: ctx.symbol, relative_path: ctx.defFile } }
            : undefined) // def file unparseable -> task renders n/a, never a bad call
          : undefined,
        overview: over
          ? (ctx) => ({ name: "get_symbols_overview", arguments: { relative_path: ctx.file } })
          : undefined,
      };
    },
    extractText: joinText,
    defFileFrom(text) {
      // find_symbol returns a JSON list of matches carrying relative_path.
      try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.symbols) ? parsed.symbols : [];
        const p = arr[0]?.relative_path ?? arr[0]?.location?.relative_path;
        return typeof p === "string" ? p : undefined;
      } catch { return undefined; }
    },
  };
}

// ---------------------------------------------------------------------------
// graphify (PyPI graphifyy 0.9.25) + graphify-mcp. The MCP server serves a
// prebuilt graph.json (positional arg); prime() builds it with
// `graphify update`.
function graphifyAdapter(opts) {
  const bin = opts.bin ?? whichOrLocal("graphify");
  const sibling = bin ? join(dirname(bin), "graphify-mcp") : undefined;
  const mcpBin = opts.mcpBin ?? (sibling && existsSync(sibling) ? sibling : whichOrLocal("graphify-mcp"));
  const graphPath = (dir) => join(dir, "graphify-out", "graph.json");
  return {
    key: "graphify",
    perRepoSupport: () => null, // TS/JS, Python, Go, Rust all in the base install
    spawn(dir) { return { cmd: mcpBin, args: [graphPath(dir)], cwd: dir, env: benchEnv() }; },
    // WITHOUT --no-cluster, deliberately: the keyless run was probed to exit 0
    // with clustering computed locally (Louvain, seed=42, communities stay
    // unnamed) and graph.json byte-stable across runs — so the default path
    // costs nothing in determinism and keeps get_community meaningful.
    // --no-cluster stays the documented fallback ONLY if the Smoke phase shows
    // pathological clustering time on a big repo (spec §2.2) — flip it there.
    prime(dir) {
      if (!bin) return { ok: false, reason: "graphify binary not found" };
      // cwd = the scratch dir itself: it is .git-free, so graph.json omits
      // built_at_commit (which would embed the HEAD of whatever cwd we ran
      // in) and byte-stability holds for the determinism scenario.
      const r = runCmd(bin, ["update", dir], { cwd: dir, env: benchEnv(), timeoutMs: PRIME_TIMEOUT_MS });
      return r.ok ? { ok: true } : { ok: false, reason: primeReason(r) };
    },
    cleanCold(dir) { rmrf(join(dir, "graphify-out")); }, // nothing global is written
    tasks(tools) {
      const m = toolMap(tools);
      const findTool = pickTool(m, ["get_node", "query_graph"]);
      const refs = m.get("get_neighbors");
      return {
        // Node labels match case-insensitively and tolerantly (`greet()`
        // matched by bare `greet`) [probed]; query_graph is the degraded path
        // when a build ever stops serving get_node.
        find: findTool
          ? (ctx) => (findTool.name === "get_node"
            ? { name: "get_node", arguments: { label: ctx.symbol } }
            : { name: "query_graph", arguments: { question: ctx.symbol, token_budget: 2000 } })
          : undefined,
        // Incoming calls/imports edges ARE the references.
        refs: refs ? (ctx) => ({ name: "get_neighbors", arguments: { label: ctx.symbol } }) : undefined,
        // file-overview: no reliable counterpart. File nodes are labeled by
        // BASENAME, which collides on real repos, and the miss-fallback to
        // query_graph needs a response-dependent retry the probe's one-call
        // task contract cannot express. Reported n/a by design.
        overview: undefined,
      };
    },
    extractText: joinText,
  };
}

// ---------------------------------------------------------------------------
// falcon (SocialGouv/repo-falcon v0.6.4, single static Go binary). MCP serves
// prebuilt parquet artifacts; prime() is `falcon index`.
function falconAdapter(opts) {
  const bin = opts.bin
    ?? whichOrLocal("falcon")
    ?? (existsSync("/opt/homebrew/bin/falcon") ? "/opt/homebrew/bin/falcon" : undefined);
  const artifacts = (dir) => join(dir, ".falcon", "artifacts");
  return {
    key: "falcon",
    // v0.6.4 indexes Go/JS-TS/Python/Java only — the ONLY positive exclusion
    // in the harness. lang "auto" (synthetic --repo-dir repos) passes.
    perRepoSupport: (repoLang) => (repoLang === "rust" ? "rust not supported" : null),
    spawn(dir) {
      // NDJSON JSON-RPC on stdout, logs on stderr [probed]. `mcp serve` loads
      // index-only artifacts fine — no snapshot step needed.
      return {
        cmd: bin,
        args: ["mcp", "serve", "--snapshot", artifacts(dir), "--repo", dir, "--log-level", "error"],
        cwd: dir,
        env: benchEnv(),
      };
    },
    prime(dir) {
      if (!bin) return { ok: false, reason: "falcon binary not found" };
      const r = runCmd(bin, ["index", "--repo", dir, "--out", artifacts(dir), "--log-level", "error"],
        { cwd: dir, env: benchEnv(), timeoutMs: PRIME_TIMEOUT_MS });
      return r.ok ? { ok: true } : { ok: false, reason: primeReason(r) };
    },
    cleanCold(dir) { rmrf(join(dir, ".falcon")); }, // never creates ~/.falcon
    tasks(tools) {
      const m = toolMap(tools);
      // Resolved at runtime from tools/list (v0.6.4 serves exactly 7 falcon_*
      // tools); preference lists tolerate an upstream un-prefixing rename.
      const lookup = pickTool(m, ["falcon_symbol_lookup", "symbol_lookup"]);
      const fileCtx = pickTool(m, ["falcon_file_context", "file_context"]);
      if (lookup || fileCtx) {
        process.stderr.write(
          `[falcon adapter] resolved tools: find/refs=${lookup?.name ?? "-"} overview=${fileCtx?.name ?? "-"}\n`,
        );
      }
      const nameParam = pickParam(lookup, ["name", "query", "symbol"]);
      const pathParam = pickParam(fileCtx, ["path", "file"]);
      return {
        find: lookup ? (ctx) => ({ name: lookup.name, arguments: { [nameParam]: ctx.symbol } }) : undefined,
        // v0.6.4 has NO separate references tool: the symbol-lookup response
        // embeds callers/callees/references, so refs times the SAME call as
        // find — the report's section note must say so.
        refs: lookup ? (ctx) => ({ name: lookup.name, arguments: { [nameParam]: ctx.symbol } }) : undefined,
        overview: fileCtx ? (ctx) => ({ name: fileCtx.name, arguments: { [pathParam]: ctx.file } }) : undefined,
      };
    },
    extractText: joinText,
  };
}

// ---------------------------------------------------------------------------
// opts: { dir, bin, mcpBin, engine } — absolute paths from the probe's CLI
// flags; every path is optional (adapters fall back to detection-style
// resolution so the probe also works standalone). Unknown server -> undefined.
export function adapterFor(server, opts = {}) {
  switch (server) {
    case "codeindex": return codeindexAdapter(opts);
    case "serena": return serenaAdapter(opts);
    case "graphify": return graphifyAdapter(opts);
    case "falcon": return falconAdapter(opts);
    default: return undefined;
  }
}
