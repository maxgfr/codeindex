// Competitor tool detection. Every probe is total: a missing or wrong-shaped
// tool yields { available:false, reason } and NEVER throws, so the harness can
// render `n/a (reason)` instead of crashing. Detection is the single source of
// truth for whether a competitor column is measurable this run.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

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

// Force every competitor to unavailable — used by the hermetic smoke path so the
// result never depends on what happens to be installed on the machine.
export function noCompetitors() {
  const off = (name) => ({ name, available: false, reason: "--no-competitors" });
  return { ctags: off("ctags"), "scip-typescript": off("scip-typescript"), astGrep: off("ast-grep"), "01x": off("01x"), scip: off("scip") };
}

export function detectCompetitors(env = process.env) {
  const astGrep = detectAstGrep();
  return {
    ctags: detectCtags(),
    "scip-typescript": detectScipTs(),
    astGrep,
    "01x": detect01x(env, astGrep),
    scip: detectScip(env),
  };
}
