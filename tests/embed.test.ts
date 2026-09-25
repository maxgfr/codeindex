import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EMBED_URL,
  EMBED_ASSET_SHA256,
  EMBED_VERSION,
  fetchEmbedModel,
  loadEmbedModel,
  parseEmbedModel,
  resolveEmbedModelDir,
  resolveEmbedPullUrl,
  tryLoadEmbedModel,
  type StaticEmbedModel,
} from "../src/embed/model.js";
import type { EmbedPullTarget } from "../src/engine.js";
import { basicTokenize, encode, intDot, roundHalfToEven, tokenize, wordpiece } from "../src/embed/encode.js";
import { buildEmbeddingIndex, deserializeEmbeddings, embeddingUnits, serializeEmbeddings } from "../src/embed/index.js";
import { explainSemantic, searchSemantic } from "../src/embed/search.js";
import { explainQuery, searchIndex } from "../src/bm25.js";
import { scanRepo, type RepoScan } from "../src/scan.js";
import type { CodeSymbol, FileRecord } from "../src/types.js";

const MODEL_DIR = fileURLToPath(new URL("./fixtures/embed-model", import.meta.url));
const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

function model(): StaticEmbedModel {
  const m = loadEmbedModel(MODEL_DIR);
  if (!m) throw new Error("fixture model failed to load");
  return m;
}

// Hand-built scans (bm25.test.ts style): the embedding tier reads each file's
// rel/symbols/summary/headings only, so a minimal FileRecord isolates behavior.
function sym(name: string, file: string, signature?: string): CodeSymbol {
  return { name, kind: "function", file, line: 1, exported: true, lang: "typescript", ...(signature ? { signature } : {}) };
}
function file(
  rel: string,
  o: { symbols?: string[]; headings?: string[]; summary?: string; kind?: FileRecord["kind"] } = {},
): FileRecord {
  return {
    rel,
    ext: ".ts",
    size: 0,
    lines: 1,
    hash: "h",
    kind: o.kind ?? "code",
    lang: "typescript",
    headings: o.headings ?? [],
    symbols: (o.symbols ?? []).map((n) => sym(n, rel)),
    refs: [],
    ...(o.summary ? { summary: o.summary } : {}),
    ...(o.headings || o.summary ? { title: rel } : {}),
  };
}
function scanOf(files: FileRecord[]): RepoScan {
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false, excluded: 0, contentUnchanged: false, cacheDirty: true };
}

describe("model loading (opt-in by asset)", () => {
  it("loads the tiny fixture model", () => {
    const m = model();
    expect(m.modelId).toBe("codeindex-fixture-tiny-8d");
    expect(m.dim).toBe(8);
    expect(m.vocab.get("auth")).toBe(1);
    expect(m.unkId).toBe(0);
    expect(m.weights.length).toBe(m.vocabSize * m.dim);
  });

  it("resolveEmbedModelDir returns undefined when nothing is present, dir when CODEINDEX_EMBED_DIR is set", () => {
    const before = process.env.CODEINDEX_EMBED_DIR;
    delete process.env.CODEINDEX_EMBED_DIR;
    try {
      // A throwaway repo with no .codeindex/models and cwd without one → undefined.
      const empty = mkdtempSync(join(tmpdir(), "ci-embed-none-"));
      expect(resolveEmbedModelDir(empty)).toBeUndefined();
      process.env.CODEINDEX_EMBED_DIR = MODEL_DIR;
      expect(resolveEmbedModelDir(empty)).toBe(MODEL_DIR);
      rmSync(empty, { recursive: true, force: true });
    } finally {
      if (before === undefined) delete process.env.CODEINDEX_EMBED_DIR;
      else process.env.CODEINDEX_EMBED_DIR = before;
    }
  });
});

describe("parseEmbedModel — shape validation (issue #12: guards the custom-URL pull)", () => {
  // A minimal shape-valid body; each test breaks exactly one field.
  const good = () => ({ modelId: "m", dim: 2, vocab: ["a", "b"], weights: [[1, 0], [0, 1]] });

  it("accepts the fixture model used by the existing suites", () => {
    const raw = JSON.parse(readFileSync(join(MODEL_DIR, "model.json"), "utf8")) as unknown;
    const m = parseEmbedModel(raw, "fixture:model.json");
    expect(m.modelId).toBe("codeindex-fixture-tiny-8d");
    expect(m.dim).toBe(8);
    expect(m.weights.length).toBe(m.vocabSize * m.dim);
  });

  it("rejects a missing modelId, citing the source", () => {
    expect(() => parseEmbedModel({ ...good(), modelId: undefined }, "https://mirror.test/m.json")).toThrow(
      /missing modelId in https:\/\/mirror\.test\/m\.json/,
    );
  });

  it("rejects a non-positive or non-integer dim", () => {
    expect(() => parseEmbedModel({ ...good(), dim: 0 }, "src")).toThrow(/bad dim 0 in src/);
    expect(() => parseEmbedModel({ ...good(), dim: -3 }, "src")).toThrow(/bad dim -3/);
    expect(() => parseEmbedModel({ ...good(), dim: 1.5 }, "src")).toThrow(/bad dim 1\.5/);
  });

  it("rejects a vocab/weights length mismatch", () => {
    expect(() => parseEmbedModel({ ...good(), weights: [[1, 0]] }, "src")).toThrow(
      /vocab\/weights length mismatch in src/,
    );
  });

  it("rejects ragged weight rows", () => {
    expect(() => parseEmbedModel({ ...good(), weights: [[1, 0], [1]] }, "src")).toThrow(
      /row 1 has length 1, expected 2/,
    );
  });
});

// A model.json that exists but does not load is "no usable model", not a
// crash: the README's degradation table promises every row exits 0.
describe("broken model.json degrades instead of failing", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const brokenDir = (body: string): string => {
    const d = mkdtempSync(join(tmpdir(), "ci-embed-bad-"));
    dirs.push(d);
    writeFileSync(join(d, "model.json"), body);
    return d;
  };
  const run = (args: string[], embedDir: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEINDEX_EMBED_DIR: embedDir };
    delete env.CODEINDEX_EMBED_ENDPOINT;
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  };

  it("tryLoadEmbedModel returns the error (naming the file) instead of throwing", () => {
    const shape = brokenDir('{"modelId":"x"}');
    expect(tryLoadEmbedModel(shape)).toEqual({ error: expect.stringMatching(/bad dim undefined in .*model\.json/) });
    const json = brokenDir("{not json");
    expect(tryLoadEmbedModel(json).error).toMatch(/model\.json is not valid JSON/);
    expect(tryLoadEmbedModel(MODEL_DIR).model?.modelId).toBe("codeindex-fixture-tiny-8d");
    expect(tryLoadEmbedModel(undefined)).toEqual({});
  });

  it("`search --semantic` returns the lexical results on exit 0 and names the broken file", () => {
    const bad = brokenDir('{"modelId":"x"}');
    const r = run(["search", "http client retry", "--repo", REPO, "--semantic"], bad);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/semantic search unavailable \(embed model: bad dim undefined in .*model\.json\) — returning lexical results/);
    const lexical = spawnSync(process.execPath, [CLI, "search", "http client retry", "--repo", REPO], { encoding: "utf8" });
    expect(r.stdout).toBe(lexical.stdout);
  });

  it("`embed status` reports the model as present with its error, mode none, exit 0", () => {
    const bad = brokenDir('{"modelId":"x"}');
    const r = run(["embed", "status", "--repo", REPO], bad);
    expect(r.status).toBe(0);
    const status = JSON.parse(r.stdout) as { mode: string; model: { present: boolean; dir?: string; error?: string } };
    expect(status.mode).toBe("none");
    expect(status.model.present).toBe(true);
    expect(status.model.dir).toBe(bad);
    expect(status.model.error).toMatch(/bad dim undefined/);
  });

  it("`index` still writes graph.json + symbols.json, skipping only embeddings.bin", () => {
    const bad = brokenDir("{not json");
    const out = mkdtempSync(join(tmpdir(), "ci-embed-bad-idx-"));
    dirs.push(out);
    const r = run(["index", "--repo", REPO, "--out", out], bad);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/not valid JSON .*embeddings\.bin skipped/);
    expect(existsSync(join(out, "graph.json"))).toBe(true);
    expect(existsSync(join(out, "embeddings.bin"))).toBe(false);
  });
});

describe("tokenizer + wordpiece", () => {
  it("splits camelCase, folds diacritics, lowercases", () => {
    expect(basicTokenize("verifyAuthToken")).toEqual(["verify", "auth", "token"]);
    expect(basicTokenize("HTTPClient")).toEqual(["http", "client"]);
    expect(basicTokenize("café_login")).toEqual(["cafe", "login"]);
  });

  it("greedy longest-match wordpiece with ## continuations", () => {
    const m = model();
    expect(wordpiece("auth", m)).toEqual([m.vocab.get("auth")]);
    // "authtoken" → "auth" + "##token"
    expect(wordpiece("authtoken", m)).toEqual([m.vocab.get("auth"), m.vocab.get("##token")]);
    // unsplittable word → UNK
    expect(wordpiece("zzzzz", m)).toEqual([m.unkId]);
  });

  it("tokenize concatenates wordpieces across words in order", () => {
    const m = model();
    expect(tokenize("verifyAuthToken", m)).toEqual([
      m.vocab.get("verify"),
      m.vocab.get("auth"),
      m.vocab.get("token"),
    ]);
  });
});

describe("roundHalfToEven", () => {
  it("rounds halves to the nearest even integer (not half-up)", () => {
    expect(roundHalfToEven(0.5)).toBe(0);
    expect(roundHalfToEven(1.5)).toBe(2);
    expect(roundHalfToEven(2.5)).toBe(2);
    expect(roundHalfToEven(-0.5)).toBe(0);
    expect(roundHalfToEven(-1.5)).toBe(-2);
    expect(roundHalfToEven(3.2)).toBe(3);
    expect(roundHalfToEven(3.7)).toBe(4);
  });
});

describe("encode — determinism (the heart of the tier)", () => {
  it("encodes the SAME text to byte-identical int8 twice", () => {
    const m = model();
    const a = encode(m, "verifyAuthToken");
    const b = encode(m, "verifyAuthToken");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("produces a unit-ish int8 vector with the expected quantized values", () => {
    const m = model();
    // "AuthService" → [auth, service]; service is a zero row → pooled=[0.5,0..],
    // norm 0.5 → unit [1,0..] → ×127 = 127.
    const v = encode(m, "AuthService");
    expect([...v]).toEqual([127, 0, 0, 0, 0, 0, 0, 0]);
    // "verifyAuthToken" → auth dim + token dim, equal → ×(1/√2)×127 = 90.
    const v2 = encode(m, "verifyAuthToken");
    expect([...v2]).toEqual([90, 90, 0, 0, 0, 0, 0, 0]);
  });

  it("all-OOV / empty text encodes to an all-zero vector (no NaN)", () => {
    const m = model();
    expect([...encode(m, "")]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...encode(m, "zzzzz qqqqq")]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // UNK rows are zero
  });

  it("intDot is an exact integer dot product", () => {
    const m = model();
    const q = encode(m, "auth token");
    const doc = encode(m, "verifyAuthToken");
    expect(intDot(q, doc)).toBe(90 * 90 + 90 * 90);
  });
});

describe("embeddings index — serialize / determinism", () => {
  const scan = scanOf([
    file("src/auth/service.ts", { symbols: ["AuthService", "verifyAuthToken"] }),
    file("src/http/client.ts", { symbols: ["HttpClient", "retryRequest"] }),
    file("src/billing/invoice.ts", { symbols: ["InvoiceBuilder"] }),
    file("docs/guide.md", { kind: "doc", headings: ["Payment charge"], summary: "How to charge a payment." }),
  ]);

  it("builds one record per (deduped) symbol plus a file-level record for symbol-less files", () => {
    const idx = buildEmbeddingIndex(scan, model());
    expect(idx.embedVersion).toBe(EMBED_VERSION);
    expect(idx.modelId).toBe("codeindex-fixture-tiny-8d");
    const forAuth = idx.records.filter((r) => r.file === "src/auth/service.ts");
    expect(forAuth.map((r) => r.symbol)).toEqual(["AuthService", "verifyAuthToken"]);
    // doc has no symbols → one file-level record
    const forDoc = idx.records.filter((r) => r.file === "docs/guide.md");
    expect(forDoc.length).toBe(1);
    expect(forDoc[0]!.symbol).toBeUndefined();
  });

  it("a symbol unit carries its doc comment; a re-export gets no unit of its own", () => {
    const rel = "src/index.ts";
    const barrel = file(rel);
    barrel.symbols = [
      { ...sym("retryRequest", rel), kind: "reexport" },
      { ...sym("*", rel), kind: "reexport-all" },
    ];
    const def = file("src/http/retry.ts", { summary: "Retry helpers." });
    def.symbols = [{ ...sym("retryRequest", def.rel, "retryRequest(n)"), line: 4, doc: "Resend a failed request with backoff." }];
    const units = embeddingUnits(scanOf([barrel, def]));
    expect(units).toEqual([
      // the pure barrel is still represented, by a file-level unit
      { file: rel, text: "\n\nsrc index.ts" },
      {
        file: "src/http/retry.ts",
        symbol: "retryRequest",
        line: 4,
        text: "retryRequest\nretryRequest(n)\nResend a failed request with backoff.\nRetry helpers.\nsrc http retry.ts",
      },
    ]);
  });

  it("serialize → deserialize round-trips byte-identically", () => {
    const idx = buildEmbeddingIndex(scan, model());
    const bin = serializeEmbeddings(idx);
    const back = deserializeEmbeddings(bin);
    expect(Buffer.from(serializeEmbeddings(back)).equals(Buffer.from(bin))).toBe(true);
    expect(back.records.length).toBe(idx.records.length);
    expect([...back.records[0]!.vec]).toEqual([...idx.records[0]!.vec]);
  });

  it("TWO independent builds → embeddings.bin byte-identical", () => {
    const a = serializeEmbeddings(buildEmbeddingIndex(scan, model()));
    const b = serializeEmbeddings(buildEmbeddingIndex(scanOf(scan.files), model()));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("searchSemantic — RRF fusion + degradation", () => {
  const scan = scanOf([
    file("src/auth/service.ts", { symbols: ["AuthService", "verifyAuthToken"] }),
    file("src/http/client.ts", { symbols: ["HttpClient", "retryRequest"] }),
    file("src/billing/invoice.ts", { symbols: ["InvoiceBuilder"] }),
  ]);

  it("ranks the semantically-closest file first and reports the matching symbol", () => {
    const m = model();
    const idx = buildEmbeddingIndex(scan, m);
    const results = searchSemantic(scan, "auth token", idx, { model: m });
    expect(results[0]!.file).toBe("src/auth/service.ts");
    expect(results[0]!.semanticSymbol).toBe("verifyAuthToken");
  });

  it("is deterministic: two runs are byte-identical JSON", () => {
    const m = model();
    const idx = buildEmbeddingIndex(scan, m);
    const a = searchSemantic(scan, "retry request", idx, { model: m });
    const b = searchSemantic(scan, "retry request", idx, { model: m });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a[0]!.file).toBe("src/http/client.ts");
  });

  it("degrades to pure lexical when no model is supplied (no throw, results still returned)", () => {
    const idx = buildEmbeddingIndex(scan, model());
    const semantic = searchSemantic(scan, "auth", idx, { model: undefined });
    const lexical = searchSemantic(scan, "auth", idx, { model: undefined });
    expect(semantic.map((r) => r.file)).toEqual(lexical.map((r) => r.file));
    expect(semantic.every((r) => r.semanticSymbol === undefined)).toBe(true);
    expect(semantic[0]!.file).toBe("src/auth/service.ts");
  });
});

// The fused list used to drop every lexical option but `fuzzy`, and every
// lexical field but matchedTerms/topSymbols/fuzzyTerms, and the CLI printed the
// LEXICAL verdict ("No file matches") above rows the embedding side had found.
describe("explainSemantic — lexical options, fields and an honest verdict", () => {
  const withLines = (rel: string, decls: [string, number][]): FileRecord => ({
    ...file(rel),
    symbols: decls.map(([name, line]) => ({ ...sym(name, rel), line })),
  });
  const scan = scanOf([
    withLines("src/auth/service.ts", [["AuthService", 3], ["verifyAuthToken", 9]]),
    withLines("src/http/client.ts", [["HttpClient", 4], ["retryRequest", 12]]),
    withLines("src/billing/invoice.ts", [["InvoiceBuilder", 7]]),
  ]);
  const m = model();
  const idx = buildEmbeddingIndex(scan, m);

  it("a row the lexical side ranked keeps all its lexical fields", () => {
    const [lex] = searchIndex(scan, "retry request");
    const [fused] = searchSemantic(scan, "retry request", idx, { model: m });
    expect(fused).toEqual({ ...lex, score: fused!.score, semanticSymbol: "retryRequest" });
    expect(fused!.line).toBe(12);
    expect(fused!.symbolHits).toEqual([{ name: "retryRequest", kind: "function", line: 12 }]);
    expect(fused!.matchedFields).toEqual(["name"]);
  });

  it("a row only the embedding side found points at its closest symbol's line", () => {
    // "password" shares the auth dimension in the fixture model, and no word.
    expect(searchIndex(scan, "password")).toEqual([]);
    const results = searchSemantic(scan, "password", idx, { model: m });
    expect(results).toEqual([
      { file: "src/auth/service.ts", score: results[0]!.score, matchedTerms: [], topSymbols: [], line: 3, semanticSymbol: "AuthService" },
    ]);
  });

  it("`exact` drops the lexical side's bridged-only rows, as it does without --semantic", () => {
    const loose = searchSemantic(scan, "authh", idx, { model: m });
    expect(loose.map((r) => [r.file, r.bridgedOnly])).toEqual([["src/auth/service.ts", true]]);
    expect(searchIndex(scan, "authh", { exact: true })).toEqual([]);
    // "authh" is out of the model's vocabulary, so the embedding side has
    // nothing either: the bridged row is gone rather than relabelled.
    expect(searchSemantic(scan, "authh", idx, { model: m, exact: true })).toEqual([]);
    const both = searchSemantic(scan, "authh password", idx, { model: m, exact: true });
    expect(both.map((r) => r.file)).toEqual(["src/auth/service.ts"]);
    expect(both[0]!.bridgedOnly).toBeUndefined();
    expect(both[0]!.fuzzyTerms).toBeUndefined();
    expect(both[0]!.matchedTerms).toEqual([]);
  });

  it("the verdict describes the fused rows: embedding-only answers are weak, never 'No file matches'", () => {
    const { results, explain } = explainSemantic(scan, "password", idx, { model: m });
    expect(results.length).toBe(1);
    expect(explain).toMatchObject({ verdict: "weak", resultCount: 1, bridgedOnlyResults: 0, semanticOnlyResults: 1 });
    expect(explain.note).toBe(
      'No file in this index defines or mentions "password". The 1 result below: 1 embedding neighbour with no lexical match (see semanticSymbol).',
    );
    const mixed = explainSemantic(scan, "authh client", idx, { model: m }).explain;
    expect(mixed.verdict).toBe("match");
    expect(mixed.note).toBeUndefined();
    const bridged = explainSemantic(scan, "authh zzqx", idx, { model: m }).explain;
    expect(bridged.verdict).toBe("weak");
    expect(bridged.note).toBe(
      'Nothing matched the query verbatim (the term zzqx appears nowhere in this index). The 1 result below: 1 near match ("authh" → auth).',
    );
  });

  it("with nothing on either side, the lexical sentence stands", () => {
    const { results, explain } = explainSemantic(scan, "zzqx", idx, { model: m });
    expect(results).toEqual([]);
    expect(explain.verdict).toBe("none");
    expect(explain.note).toBe(explainQuery(scan, "zzqx").explain.note);
  });

  it("degraded (no model) it IS explainQuery, options included", () => {
    for (const opts of [{}, { exact: true }, { rank: "graph" as const, limit: 1 }, { fuzzy: false }]) {
      expect(explainSemantic(scan, "authh client", idx, opts)).toEqual(explainQuery(scan, "authh client", opts));
    }
  });
});

describe("CLI embed + search --semantic", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });
  const runWithModel = (args: string[]): { stdout: string; status: number } => {
    try {
      const stdout = execFileSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        env: { ...process.env, CODEINDEX_EMBED_DIR: MODEL_DIR },
      });
      return { stdout, status: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { stdout: err.stdout ?? "", status: err.status ?? 1 };
    }
  };
  const runNoModel = (args: string[]): { stdout: string; stderr: string; status: number } => {
    const env = { ...process.env };
    delete env.CODEINDEX_EMBED_DIR;
    const r = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
    return { stdout: r, stderr: "", status: 0 };
  };

  it("`embed status` reports the present model as JSON", () => {
    const { stdout } = runWithModel(["embed", "status", "--repo", REPO]);
    const parsed = JSON.parse(stdout) as { model: { present: boolean; modelId?: string }; embedVersion: number };
    expect(parsed.model.present).toBe(true);
    expect(parsed.model.modelId).toBe("codeindex-fixture-tiny-8d");
    expect(parsed.embedVersion).toBe(EMBED_VERSION);
  });

  it("`embed build` writes embeddings.bin; two builds are byte-identical", () => {
    const out1 = mkdtempSync(join(tmpdir(), "ci-embed-b1-"));
    const out2 = mkdtempSync(join(tmpdir(), "ci-embed-b2-"));
    tmpDirs.push(out1, out2);
    runWithModel(["embed", "build", "--repo", REPO, "--out", out1]);
    runWithModel(["embed", "build", "--repo", REPO, "--out", out2]);
    const a = readFileSync(join(out1, "embeddings.bin"));
    const b = readFileSync(join(out2, "embeddings.bin"));
    expect(a.equals(b)).toBe(true);
  });

  it("`index` writes embeddings.bin alongside graph.json when a model is present", () => {
    const out = mkdtempSync(join(tmpdir(), "ci-embed-idx-"));
    tmpDirs.push(out);
    runWithModel(["index", "--repo", REPO, "--out", out]);
    expect(existsSync(join(out, "graph.json"))).toBe(true);
    expect(existsSync(join(out, "embeddings.bin"))).toBe(true);
  });

  it("`search --semantic` with a model returns fused JSON, byte-identical across runs", () => {
    // "http client retry" all appear in the mini-repo (HttpClient / request /
    // "HTTP client with retry") and in the fixture model vocab, so both tiers fire.
    const a = runWithModel(["search", "http client retry", "--repo", REPO, "--semantic"]);
    const b = runWithModel(["search", "http client retry", "--repo", REPO, "--semantic"]);
    expect(a.stdout).toBe(b.stdout);
    expect(a.status).toBe(0);
    const parsed = JSON.parse(a.stdout) as { file: string; semanticSymbol?: string }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]!.file).toBe("src/client.ts");
    // the embedding tier attributed a symbol to the top file
    expect(parsed.some((r) => r.semanticSymbol !== undefined)).toBe(true);
  });

  it("`search --semantic --explain` wraps the fused rows with their verdict; the stderr note agrees with stdout", () => {
    // "password" shares the auth dimension in the fixture model, and no word
    // with this repo.
    const repo = mkdtempSync(join(tmpdir(), "ci-embed-explain-"));
    tmpDirs.push(repo);
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "auth.ts"), "export class AuthService {}\n");
    writeFileSync(join(repo, "src", "http.ts"), "export function httpClient() {}\n");
    const env: NodeJS.ProcessEnv = { ...process.env, CODEINDEX_EMBED_DIR: MODEL_DIR };
    delete env.CODEINDEX_EMBED_ENDPOINT;
    const r = spawnSync(process.execPath, [CLI, "search", "password", "--repo", repo, "--semantic", "--explain"], { encoding: "utf8", env });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as {
      results: { file: string; line?: number; semanticSymbol?: string }[];
      explain: { verdict: string; semanticOnlyResults: number; resultCount: number; note?: string };
    };
    expect(out.results).toEqual([expect.objectContaining({ file: "src/auth.ts", line: 1, semanticSymbol: "AuthService", matchedTerms: [] })]);
    expect(out.explain).toMatchObject({ verdict: "weak", resultCount: out.results.length, semanticOnlyResults: out.results.length });
    expect(r.stderr).toBe(`codeindex: ${out.explain.note}\n`);
    expect(r.stderr).not.toMatch(/No file matches/);
    // Without --explain the same rows come back as the bare array.
    const bare = spawnSync(process.execPath, [CLI, "search", "password", "--repo", repo, "--semantic"], { encoding: "utf8", env });
    expect(JSON.parse(bare.stdout)).toEqual(out.results);
  });

  it("DEGRADATION: `search --semantic` WITHOUT a model → lexical results, exit 0", () => {
    const { stdout, status } = runNoModel(["search", "http client retry", "--repo", REPO, "--semantic"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { file: string; semanticSymbol?: string }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((r) => r.semanticSymbol === undefined)).toBe(true);
  });
});

// Serve `body` (with `status`) on a throwaway loopback port for one pull.
async function serveOnce(body: string, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/model.json`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

describe("embed pull — default URL + sha256 verification", () => {
  const prevUrl = process.env.CODEINDEX_EMBED_URL;
  const prevDir = process.env.CODEINDEX_EMBED_DIR;
  afterEach(() => {
    if (prevUrl === undefined) delete process.env.CODEINDEX_EMBED_URL;
    else process.env.CODEINDEX_EMBED_URL = prevUrl;
    if (prevDir === undefined) delete process.env.CODEINDEX_EMBED_DIR;
    else process.env.CODEINDEX_EMBED_DIR = prevDir;
  });

  it("EmbedPullTarget is exported from the barrel and types resolveEmbedPullUrl()'s return", () => {
    delete process.env.CODEINDEX_EMBED_URL;
    // Type-level guard: this annotation stops compiling if the barrel drops the
    // EmbedPullTarget export or resolveEmbedPullUrl()'s return shape drifts.
    const target: EmbedPullTarget | undefined = resolveEmbedPullUrl();
    expect(target?.url).toBe(DEFAULT_EMBED_URL);
  });

  it("resolveEmbedPullUrl falls back to the built-in default WITH the pinned sha256 when env is unset", () => {
    delete process.env.CODEINDEX_EMBED_URL;
    const r = resolveEmbedPullUrl();
    expect(r.url).toBe(DEFAULT_EMBED_URL);
    expect(r.sha256).toBe(EMBED_ASSET_SHA256);
    expect(DEFAULT_EMBED_URL).toMatch(/^https:\/\/github\.com\/.*\/releases\/download\/embed-model-v1\/model\.json$/);
    expect(EMBED_ASSET_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("CODEINDEX_EMBED_URL wins and carries NO sha256 (custom mirror keeps the un-verified behavior)", () => {
    process.env.CODEINDEX_EMBED_URL = "  https://example.test/m.json  ";
    const r = resolveEmbedPullUrl();
    expect(r.url).toBe("https://example.test/m.json"); // trimmed
    expect(r.sha256).toBeUndefined();
  });

  it("fetchEmbedModel returns the body when the sha256 matches (default-URL path)", async () => {
    const body = JSON.stringify({ modelId: "x", dim: 1, vocab: ["a"], weights: [[1]] });
    const sha = createHash("sha256").update(body).digest("hex");
    const srv = await serveOnce(body);
    try {
      await expect(fetchEmbedModel(srv.url, sha)).resolves.toBe(body);
    } finally {
      await srv.close();
    }
  });

  it("fetchEmbedModel THROWS on a sha256 mismatch (corrupt/tampered default asset → nothing usable returned)", async () => {
    const body = JSON.stringify({ modelId: "x", dim: 1, vocab: ["a"], weights: [[1]] });
    const srv = await serveOnce(body);
    try {
      await expect(fetchEmbedModel(srv.url, "0".repeat(64))).rejects.toThrow(/sha256 mismatch/);
    } finally {
      await srv.close();
    }
  });

  it("fetchEmbedModel with NO expected sha256 (custom URL) skips verification entirely", async () => {
    const body = "not even json but the fetch helper does not care";
    const srv = await serveOnce(body);
    try {
      await expect(fetchEmbedModel(srv.url)).resolves.toBe(body);
    } finally {
      await srv.close();
    }
  });

  it("fetchEmbedModel throws on a non-2xx response", async () => {
    const srv = await serveOnce("nope", 404);
    try {
      await expect(fetchEmbedModel(srv.url, undefined)).rejects.toThrow(/HTTP 404/);
    } finally {
      await srv.close();
    }
  });

  it("CLI `embed pull` fetches from CODEINDEX_EMBED_URL, writes model.json, and `embed status` reports it", async () => {
    // The mock server runs in THIS process, so the child must be spawned
    // ASYNCHRONOUSLY — execFileSync would block the event loop and the server
    // could never answer the child's fetch.
    const run = (args: string[], env: NodeJS.ProcessEnv): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile(process.execPath, [CLI, ...args], { encoding: "utf8", env }, (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });
    const fixture = readFileSync(join(MODEL_DIR, "model.json"), "utf8");
    const srv = await serveOnce(fixture);
    const dest = mkdtempSync(join(tmpdir(), "ci-embed-pull-"));
    tmpDirs.push(dest);
    try {
      const env = { ...process.env, CODEINDEX_EMBED_URL: srv.url, CODEINDEX_EMBED_DIR: dest };
      delete (env as Record<string, string | undefined>).CODEINDEX_EMBED_ENDPOINT;
      await run(["embed", "pull", "--repo", REPO], env);
      expect(existsSync(join(dest, "model.json"))).toBe(true);
      const status = await run(["embed", "status", "--repo", REPO], env);
      const parsed = JSON.parse(status) as { mode: string; model: { present: boolean; modelId?: string } };
      expect(parsed.mode).toBe("static");
      expect(parsed.model.present).toBe(true);
      expect(parsed.model.modelId).toBe("codeindex-fixture-tiny-8d");
    } finally {
      await srv.close();
    }
  });

  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });
});
