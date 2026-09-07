#!/usr/bin/env node
// Compare two built checkouts on the SAME source bytes. No network or writes
// outside a disposable directory; stdout is the raw measurement report.
// node scripts/bench/optimization.mjs <baseline-checkout> <candidate-checkout>
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { startMcpClient } from "./mcp-client.mjs";

const self = fileURLToPath(import.meta.url);
const runs = 5;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const digest = (text) => createHash("sha256").update(text).digest("hex");
const load = (root) => import(pathToFileURL(join(root, "scripts/engine.mjs")).href);
function child(args) {
  return JSON.parse(execFileSync(process.execPath, [self, ...args], {
    encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }));
}

async function queries(root, repo, name) {
  const engine = await load(root);
  await engine.ensureGrammars(engine.grammarKeysForExts(engine.walk(repo).files.map((f) => f.ext)));
  const scan = engine.scanRepo(repo);
  const time = () => {
    const start = performance.now();
    // Amortize clock noise without timing serialization. Alternate a hit and a
    // miss so the workload also exercises the absent-name lookup.
    for (let i = 0; i < 1000; i++) engine.findReferences(scan, i % 2 ? name : "__absent_bench_symbol__");
    return (performance.now() - start) / 1000;
  };
  time();
  const samples = Array.from({ length: runs }, time);
  return {
    files: scan.files.length, symbols: scan.files.reduce((n, f) => n + f.symbols.length, 0),
    queryMs: median(samples), querySamples: samples, queryPeakRssKiB: process.resourceUsage().maxRSS,
    answerSha256: digest(JSON.stringify(engine.findReferences(scan, name))),
  };
}

async function mcp(root, repo, name) {
  const client = startMcpClient(process.execPath, [join(root, "scripts/cli.mjs"), "mcp", "--repo", repo]);
  try {
    assert.equal((await client.handshake()).ok, true);
    const sample = async () => {
      const start = performance.now();
      const response = await client.request("tools/call", { name: "find_references", arguments: { name } });
      assert.equal(response.ok, true, response.reason);
      assert.notEqual(response.result.isError, true);
      return { ms: performance.now() - start, text: response.result.content[0].text };
    };
    await sample();
    const samples = [];
    for (let i = 0; i < runs; i++) samples.push(await sample());
    const text = samples[0].text;
    assert(samples.every((sample) => sample.text === text));
    return { mcpMs: median(samples.map((s) => s.ms)), mcpSamples: samples.map((s) => s.ms), responseBytes: Buffer.byteLength(text),
      estimatedTokens: Math.ceil(Buffer.byteLength(text) / 4), mcpAnswerSha256: digest(text) };
  } finally { await client.close(); }
}

async function measure(root, repo, name, editFile) {
  const out = join(repo, ".codeindex");
  const index = () => {
    const start = performance.now();
    const memory = child(["--index", root, repo, out]);
    return { ms: performance.now() - start, rss: memory.peakRssKiB };
  };
  const original = readFileSync(editFile);
  const results = {};
  for (const mode of ["cold", "warm", "incremental"]) {
    const samples = [];
    for (let i = -1; i < runs; i++) {
      if (mode === "cold") rmSync(out, { recursive: true, force: true });
      if (mode === "incremental") writeFileSync(editFile, Buffer.concat([original, Buffer.from(`\n// benchmark edit ${i}\n`)]));
      const sample = index();
      if (i >= 0) samples.push(sample);
    }
    results[mode] = { ms: median(samples.map((s) => s.ms)), peakRssKiB: Math.max(...samples.map((s) => s.rss)), samples };
  }
  writeFileSync(editFile, original);
  index();
  return { ...results, ...child(["--queries", root, repo, name]), ...await mcp(root, repo, name),
    graphSha256: digest(readFileSync(join(out, "graph.json"))),
    symbolsSha256: digest(readFileSync(join(out, "symbols.json"))) };
}

async function compare(baseline, candidate) {
  // Pin both engines to the same grammar assets, including worker/MCP children.
  // A development checkout may have an untracked extended tier installed while
  // the baseline does not; that would compare different extraction capabilities.
  process.env.CODEINDEX_GRAMMAR_DIR = join(baseline, "scripts/grammars");
  const scratch = mkdtempSync(join(tmpdir(), "ci-optimization-"));
  try {
    const repo = join(scratch, "repo");
    const corpora = [
      { name: "mini", source: join(baseline, "tests/fixtures/mini-repo"), symbol: "HttpClient", edit: "src/client.ts" },
      { name: "codeindex", source: baseline, symbol: "findReferences", edit: "src/query.ts" },
      { name: "synthetic", symbol: "target0", edit: "file0.ts" },
    ];
    const report = { node: process.version, runs, warmupRuns: 1, baseline, candidate,
      grammars: process.env.CODEINDEX_GRAMMAR_DIR, corpora: [] };
    for (const corpus of corpora) {
      rmSync(repo, { recursive: true, force: true });
      if (corpus.source) {
        cpSync(corpus.source, repo, { recursive: true,
          filter: (path) => !path.split(/[\\/]/).some((p) => [".git", "node_modules", ".codeindex"].includes(p)) });
      } else {
        mkdirSync(repo);
        for (let i = 0; i < 200; i++) writeFileSync(join(repo, `file${i}.ts`),
          `export function target${i}() { return ${i}; }\n` +
          Array.from({ length: 100 }, (_, j) => `export function symbol${i}_${j}() { return ${j}; }\n`).join(""));
      }
      process.stderr.write(`Measuring ${corpus.name}\n`);
      const before = await measure(baseline, repo, corpus.symbol, join(repo, corpus.edit));
      const after = await measure(candidate, repo, corpus.symbol, join(repo, corpus.edit));
      for (const field of ["files", "symbols", "responseBytes", "answerSha256", "mcpAnswerSha256", "graphSha256", "symbolsSha256"])
        assert.equal(after[field], before[field], `${corpus.name}: ${field} changed`);
      report.corpora.push({ name: corpus.name, before, after });
    }
    return report;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "--index") {
  const engine = await load(args[0]);
  await engine.runCli(["index", "--repo", args[1], "--out", args[2]]);
  console.log(JSON.stringify({ peakRssKiB: process.resourceUsage().maxRSS }));
} else if (mode === "--queries") {
  console.log(JSON.stringify(await queries(...args)));
} else {
  assert(mode && args.length === 1, "Usage: optimization.mjs <baseline-checkout> <candidate-checkout>");
  console.log(JSON.stringify(await compare(resolve(mode), resolve(args[0])), null, 2));
}
