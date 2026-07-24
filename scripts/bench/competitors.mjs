// Competitor tool detection. Every probe is total: a missing or wrong-shaped
// tool yields { available:false, reason } and NEVER throws, so the harness can
// render `n/a (reason)` instead of crashing. Detection is the single source of
// truth for whether a competitor column is measurable this run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Total spawn wrapper: reports ok/code/stdout/stderr + wall-clock ms, and flags
// a missing binary (ENOENT) rather than throwing. Reused by the orchestrator to
// time competitor commands, so absence is always a value, never an exception.
export function runCmd(cmd, args, opts = {}) {
  const t0 = performance.now();
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      input: opts.input,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 128 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, code: 0, stdout, stderr: "", missing: false, ms: performance.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      code: typeof e?.status === "number" ? e.status : null,
      stdout: e?.stdout?.toString?.() ?? "",
      stderr: e?.stderr?.toString?.() ?? String(e?.message ?? e),
      missing: e?.code === "ENOENT",
      ms: performance.now() - t0,
    };
  }
}

function whichPath(cmd) {
  const r = runCmd("/usr/bin/which", [cmd]);
  const p = r.ok ? r.stdout.trim().split("\n")[0] : "";
  return p && existsSync(p) ? p : undefined;
}

// whichPath with a ~/.local/bin fallback: the uv-installed tools (serena,
// graphify, graphify-mcp) live there and it is not on the default PATH of
// non-interactive shells. Exported for the MCP adapters' standalone fallback.
export function whichOrLocal(cmd) {
  const p = whichPath(cmd);
  if (p) return p;
  const local = join(homedir(), ".local", "bin", cmd);
  return existsSync(local) ? local : undefined;
}

function semver(s) {
  const m = /(\d+\.\d+\.\d+)/.exec(s || "");
  return m ? m[1] : undefined;
}

function detectCtags() {
  const path = whichPath("ctags");
  if (!path) return { name: "ctags", available: false, reason: "not installed" };
  const r = runCmd(path, ["--version"]);
  if (!/Universal Ctags/.test(r.stdout)) {
    return { name: "ctags", available: false, path, reason: "not Universal Ctags" };
  }
  return { name: "ctags", available: true, path, version: semver(r.stdout) };
}

function detectScipTs() {
  const path = whichPath("scip-typescript");
  if (!path) return { name: "scip-typescript", available: false, reason: "not installed" };
  return { name: "scip-typescript", available: true, path, version: semver(runCmd(path, ["--version"]).stdout) };
}

function detectAstGrep() {
  const path = whichPath("ast-grep") || whichPath("sg");
  if (!path) return { name: "ast-grep", available: false, reason: "not installed" };
  return { name: "ast-grep", available: true, path, version: semver(runCmd(path, ["--version"]).stdout) };
}

// True only for the Go/cobra 01x binary — guards against the name collision with
// our own `codeindex` bin (which prints a bare semver and knows `engine.mjs`).
function looksLike01x(bin) {
  const help = runCmd(bin, ["--help"]).stdout;
  if (/engine\.mjs/.test(help)) return false; // that's ours
  return /Available Commands:/.test(help) && /ast-grep/.test(help);
}

// 01x-in/codeindex: env BENCH_01X_BIN wins (explicit path); else probe a PATH
// `codeindex` and accept only if it is the cobra binary. Their tool shells out
// to ast-grep per file, so it is unusable without it (their exit code 3) — we
// gate on ast-grep and report the reason.
function detect01x(env, astGrep) {
  const explicit = env.BENCH_01X_BIN;
  let path;
  if (explicit) {
    if (!existsSync(explicit)) return { name: "01x", available: false, reason: "BENCH_01X_BIN path missing" };
    if (!looksLike01x(explicit)) return { name: "01x", available: false, path: explicit, reason: "BENCH_01X_BIN is not the 01x binary" };
    path = explicit;
  } else {
    const cand = whichPath("codeindex");
    if (!cand) return { name: "01x", available: false, reason: "not installed (set BENCH_01X_BIN)" };
    if (!looksLike01x(cand)) return { name: "01x", available: false, path: cand, reason: "PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)" };
    path = cand;
  }
  const version = semver(runCmd(path, ["version"]).stdout);
  if (!astGrep.available) return { name: "01x", available: false, path, version, reason: "ast-grep missing" };
  return { name: "01x", available: true, path, version };
}

function detectScip(env) {
  const path = env.BENCH_SCIP_BIN && existsSync(env.BENCH_SCIP_BIN) ? env.BENCH_SCIP_BIN : whichPath("scip");
  if (!path) return { name: "scip", available: false, reason: "not installed (optional)" };
  return { name: "scip", available: true, path, version: semver(runCmd(path, ["--version"]).stdout) };
}

// One-line JSON-RPC handshake (initialize + initialized) fed to a stdio MCP
// server through runCmd's input; the server answers `initialize` before the
// stdin EOF ends the session [probed]. Enough to prove a venv can actually
// serve MCP without keeping an async client in the detection path.
const MCP_HANDSHAKE_INPUT = [
  JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "codeindex-bench", version: "0" } },
  }),
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  "",
].join("\n");

// Known-good versions for the three MCP competitors (recorded in the report,
// not enforced): serena 1.6.1, graphifyy 0.9.25, falcon 0.6.4.

// serena (oraios/serena, uv tool serena-agent). Language servers are
// provisioned per language on first use into ~/.serena/language_servers, so
// the per-language prerequisites are recorded in `extra` — scenarios gate
// individual repos (`na("gopls missing")`) instead of the whole column.
function detectSerena(env) {
  const explicit = env.BENCH_SERENA_BIN;
  let path;
  if (explicit) {
    if (!existsSync(explicit)) return { name: "serena", available: false, reason: "BENCH_SERENA_BIN path missing" };
    path = explicit;
  } else {
    path = whichOrLocal("serena");
    if (!path) return { name: "serena", available: false, reason: "not installed" };
  }
  if (!/start-mcp-server/.test(runCmd(path, ["--help"]).stdout)) {
    return { name: "serena", available: false, path, reason: "no start-mcp-server subcommand" };
  }
  const version = semver(runCmd(path, ["--version"]).stdout);
  const extra = {
    node: whichPath("node"),
    npm: whichPath("npm"),
    uv: whichPath("uv"),
    gopls: whichPath("gopls"),
    rustAnalyzer: whichPath("rust-analyzer"),
  };
  return { name: "serena", available: true, path, version, extra };
}

// graphify (PyPI `graphifyy`) + its MCP server. `--help` succeeding does NOT
// prove the MCP server runs: the `mcp` import is lazy, so a venv installed
// without the [mcp] extra ships a graphify-mcp that only crashes at serve
// time. Detection therefore handshakes a one-node fixture graph for real.
function detectGraphify(env) {
  const explicit = env.BENCH_GRAPHIFY_BIN;
  let path;
  if (explicit) {
    if (!existsSync(explicit)) return { name: "graphify", available: false, reason: "BENCH_GRAPHIFY_BIN path missing" };
    path = explicit;
  } else {
    path = whichOrLocal("graphify");
    if (!path) return { name: "graphify", available: false, reason: "not installed" };
  }
  const help = runCmd(path, ["--help"]).stdout;
  if (!/\bupdate\b/.test(help) || !/\bquery\b/.test(help)) {
    return { name: "graphify", available: false, path, reason: "--help lacks update/query verbs" };
  }
  const version = semver(runCmd(path, ["--version"]).stdout);
  const mcpExplicit = env.BENCH_GRAPHIFY_MCP_BIN;
  let mcpPath;
  if (mcpExplicit) {
    if (!existsSync(mcpExplicit)) return { name: "graphify", available: false, path, version, reason: "BENCH_GRAPHIFY_MCP_BIN path missing" };
    mcpPath = mcpExplicit;
  } else {
    const sibling = join(dirname(path), "graphify-mcp");
    mcpPath = existsSync(sibling) ? sibling : whichOrLocal("graphify-mcp");
  }
  if (!mcpPath) return { name: "graphify", available: false, path, version, reason: "graphify-mcp not found" };
  try {
    const tmp = mkdtempSync(join(tmpdir(), "bench-graphify-"));
    const graph = join(tmp, "graph.json");
    writeFileSync(graph, JSON.stringify({ input_tokens: 0, output_tokens: 0, nodes: [{ id: "a", label: "a" }], links: [] }));
    const r = runCmd(mcpPath, [graph], { input: MCP_HANDSHAKE_INPUT });
    rmSync(tmp, { recursive: true, force: true });
    if (/No module named 'mcp'/.test(r.stderr)) {
      return {
        name: "graphify", available: false, path, version,
        reason: "graphifyy installed without [mcp] extra (uv tool install --force 'graphifyy[mcp]')",
      };
    }
    if (!/"serverInfo"/.test(r.stdout)) {
      return {
        name: "graphify", available: false, path, version,
        reason: `graphify-mcp handshake failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`,
      };
    }
  } catch (e) {
    return { name: "graphify", available: false, path, version, reason: `mcp probe error: ${e?.message ?? e}` };
  }
  return { name: "graphify", available: true, path, version, extra: { mcpPath } };
}

// falcon (SocialGouv/repo-falcon, Homebrew tap). Single static Go binary; the
// homebrew prefix is probed as a last resort since ~/.local/bin only covers
// the uv tools. NOTE: `falcon version` (subcommand) does not exist — only
// `falcon --version` works.
function detectFalcon(env) {
  const explicit = env.BENCH_FALCON_BIN;
  let path;
  if (explicit) {
    if (!existsSync(explicit)) return { name: "falcon", available: false, reason: "BENCH_FALCON_BIN path missing" };
    path = explicit;
  } else {
    path = whichOrLocal("falcon") ?? (existsSync("/opt/homebrew/bin/falcon") ? "/opt/homebrew/bin/falcon" : undefined);
    if (!path) return { name: "falcon", available: false, reason: "not installed" };
  }
  const help = runCmd(path, ["--help"]).stdout;
  if (!/Index a repository/.test(help) && !/^\s*mcp\b/m.test(help)) {
    return { name: "falcon", available: false, path, reason: "not RepoFalcon (--help lacks index/mcp)" };
  }
  return { name: "falcon", available: true, path, version: semver(runCmd(path, ["--version"]).stdout) };
}

// Force every competitor to unavailable — used by the hermetic smoke path so the
// result never depends on what happens to be installed on the machine.
export function noCompetitors() {
  const off = (name) => ({ name, available: false, reason: "--no-competitors" });
  return {
    ctags: off("ctags"),
    "scip-typescript": off("scip-typescript"),
    astGrep: off("ast-grep"),
    "01x": off("01x"),
    scip: off("scip"),
    serena: off("serena"),
    graphify: off("graphify"),
    falcon: off("falcon"),
  };
}

export function detectCompetitors(env = process.env) {
  const astGrep = detectAstGrep();
  return {
    ctags: detectCtags(),
    "scip-typescript": detectScipTs(),
    astGrep,
    "01x": detect01x(env, astGrep),
    scip: detectScip(env),
    serena: detectSerena(env),
    graphify: detectGraphify(env),
    falcon: detectFalcon(env),
  };
}
