import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EMBED_VERSION, loadEmbedModel, resolveEmbedModelDir, type StaticEmbedModel } from "../src/embed/model.js";
import { basicTokenize, encode, intDot, roundHalfToEven, tokenize, wordpiece } from "../src/embed/encode.js";
import { buildEmbeddingIndex, deserializeEmbeddings, serializeEmbeddings } from "../src/embed/index.js";
import { searchSemantic } from "../src/embed/search.js";
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
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false, excluded: 0 };
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

  it("DEGRADATION: `search --semantic` WITHOUT a model → lexical results, exit 0", () => {
    const { stdout, status } = runNoModel(["search", "http client retry", "--repo", REPO, "--semantic"]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { file: string; semanticSymbol?: string }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((r) => r.semanticSymbol === undefined)).toBe(true);
  });
});
