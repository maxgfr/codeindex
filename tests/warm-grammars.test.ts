import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { warmGrammars } from "../src/ast/warm.js";

const BUNDLE = fileURLToPath(new URL("../scripts/engine.mjs", import.meta.url));

const allTmp: string[] = [];
afterAll(() => {
  for (const d of allTmp) rmSync(d, { recursive: true, force: true });
});
function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  allTmp.push(d);
  return d;
}

// Run an ESM snippet in a CHILD process. The grammar loader keeps module-global
// state (`loaded`/`runtimeReady`), so the "nothing resolvable" case cannot be
// asserted in a process where another test already warmed a grammar — it has to
// be a fresh interpreter with its own env.
function runNode(script: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { encoding: "utf8", env },
      (err, stdout, stderr) => {
        const status = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
        res({ stdout: stdout ?? "", stderr: stderr ?? "", status });
      },
    );
  });
}

const TS_SNIPPET = `export class Controller {
  handle(input) { return this.sanitize(input); }
  sanitize(raw) { return raw.trim(); }
}
`;

describe("warmGrammars", () => {
  // THE regression test for the gap this helper closes. It must run in a child:
  // tests/setup.ts warms every grammar before any suite loads, so under vitest
  // the AST tier is ALWAYS on — which is precisely why a consumer forgetting the
  // warm-up was invisible to a green test suite.
  it("flips extraction from the regex tier to AST — measured in a fresh interpreter", async () => {
    const script = `
      const { extractCode, warmGrammars } = await import(${JSON.stringify(BUNDLE)});
      const S = ${JSON.stringify(TS_SNIPPET)};
      const cold = extractCode("a.ts", ".ts", S);
      const res = await warmGrammars({ keys: ["typescript"], pull: false, onNote: () => {} });
      const warm = extractCode("a.ts", ".ts", S);
      const shape = (c) => ({ symbols: c.symbols.map((s) => s.kind + ":" + s.name), idents: c.idents === undefined ? null : c.idents.length, calls: (c.calls ?? []).map((x) => x.name) });
      console.log(JSON.stringify({ cold: shape(cold), warm: shape(warm), res: { tier: res.tier, ready: res.ready, pulled: res.pulled } }));
    `;
    const { stdout, status } = await runNode(script, process.env);
    expect(status).toBe(0);
    const out = JSON.parse(stdout.trim()) as {
      cold: { symbols: string[]; idents: number | null; calls: string[] };
      warm: { symbols: string[]; idents: number | null; calls: string[] };
      res: { tier: string; ready: boolean; pulled: boolean };
    };

    // Un-warmed = the regex tier: the class is found, its methods are not, the
    // AST-only `idents` is absent, and the call list is polluted — `handle` and
    // a duplicated `sanitize` are DEFINITIONS miscounted as call sites.
    expect(out.cold.symbols).toEqual(["class:Controller"]);
    expect(out.cold.idents).toBeNull();
    expect(out.cold.calls).toEqual(["handle", "sanitize", "sanitize", "trim"]);

    // Warmed = AST: both methods appear, idents populate, and the call list
    // drops the false positives.
    expect(out.warm.symbols).toEqual(["class:Controller", "method:handle", "method:sanitize"]);
    expect(out.warm.idents).toBe(1);
    expect(out.warm.calls).toEqual(["sanitize", "trim"]);

    expect(out.res).toEqual({ tier: "adjacent", ready: true, pulled: false });
  });

  it("is idempotent — a second warm-up neither re-pulls nor changes the result", async () => {
    const a = await warmGrammars({ keys: ["typescript"], pull: false, onNote: () => {} });
    const b = await warmGrammars({ keys: ["typescript"], pull: false, onNote: () => {} });
    expect(b).toEqual(a);
  });

  it("NEVER SILENT: with nothing resolvable and no pull, it announces the regex downgrade and still succeeds", async () => {
    // A copied bundle has no adjacent grammars/, the cache home is empty, and
    // the pull is disabled — the exact offline/degraded shape.
    const bundleDir = mk("ci-warm-none-");
    copyFileSync(BUNDLE, join(bundleDir, "engine.mjs"));
    const env = {
      ...process.env,
      CODEINDEX_GRAMMAR_DIR: "",
      ULTRAINDEX_GRAMMAR_DIR: "",
      CODEINDEX_GRAMMARS_DIR: "",
      XDG_CACHE_HOME: mk("ci-warm-cache-"),
      CODEINDEX_NO_GRAMMARS_PULL: "1",
    };
    const script = `
      const { warmGrammars } = await import(${JSON.stringify(join(bundleDir, "engine.mjs"))});
      const r = await warmGrammars({ label: "ultrasec" });
      console.log(JSON.stringify({ tier: r.tier, ready: r.ready, pulled: r.pulled }));
    `;
    const { stdout, stderr, status } = await runNode(script, env);
    expect(status).toBe(0); // a degraded run is still a SUCCESSFUL run
    expect(JSON.parse(stdout.trim())).toEqual({ tier: "none", ready: false, pulled: false });
    expect(stderr).toContain("ultrasec:"); // the caller's label, not "codeindex:"
    expect(stderr).toMatch(/regex tier/);
    expect(stderr).toMatch(/grammars pull/); // tells the user how to fix it
  });

  it("CODEINDEX_NO_GRAMMARS_PULL blocks the network pull even when nothing is resolvable", async () => {
    // A URL that would fail loudly if it were ever fetched.
    const bundleDir = mk("ci-warm-nopull-");
    copyFileSync(BUNDLE, join(bundleDir, "engine.mjs"));
    const env = {
      ...process.env,
      CODEINDEX_GRAMMAR_DIR: "",
      ULTRAINDEX_GRAMMAR_DIR: "",
      CODEINDEX_GRAMMARS_DIR: "",
      XDG_CACHE_HOME: mk("ci-warm-nopull-cache-"),
      CODEINDEX_NO_GRAMMARS_PULL: "1",
      CODEINDEX_GRAMMARS_URL: "http://127.0.0.1:1/never",
    };
    const script = `
      const { warmGrammars } = await import(${JSON.stringify(join(bundleDir, "engine.mjs"))});
      const r = await warmGrammars();
      console.log(JSON.stringify({ pulled: r.pulled, ready: r.ready }));
    `;
    const { stdout, stderr, status } = await runNode(script, env);
    expect(status).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ pulled: false, ready: false });
    expect(stderr).not.toMatch(/fetching grammars/);
  });
});
