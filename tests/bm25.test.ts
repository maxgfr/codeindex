import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { charTrigrams, diceCoefficient, searchIndex, subtokens } from "../src/bm25.js";
import { stemOf } from "../src/util.js";
import { scanRepo, type RepoScan } from "../src/scan.js";
import type { CodeSymbol, FileRecord } from "../src/types.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

// Hand-built scan fixtures (calls.test.ts style): searchIndex only reads each
// file's rel/symbols/headings/summary, so the minimum FileRecord shape isolates
// each ranking property without a filesystem round-trip.
function sym(name: string, file: string): CodeSymbol {
  return { name, kind: "function", file, line: 1, exported: true, lang: "typescript" };
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
  };
}

// A real on-disk repo, for the field model: `doc` and `body` come from
// EXTRACTION (symbol doc comments, comment/literal prose), so a hand-built
// FileRecord cannot exercise them — only a genuine scan can.
function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-bm25f-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function scanOf(files: FileRecord[]): RepoScan {
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false, excluded: 0, contentUnchanged: false, cacheDirty: true };
}

describe("subtokens", () => {
  it("splits camelCase and keeps the original", () => {
    expect(subtokens("HttpClient")).toEqual(["httpclient", "http", "client"]);
  });

  it("splits snake_case and ACRONYMWord boundaries", () => {
    expect(subtokens("parse_JSONBody")).toEqual(["parse_jsonbody", "parse", "json", "body"]);
  });

  it("folds diacritics and drops 1-char fragments", () => {
    expect(subtokens("café")).toEqual(["cafe"]);
    expect(subtokens("a_b")).toEqual(["a_b"]); // whole survives; 1-char parts dropped
  });
});

describe("searchIndex", () => {
  it('answers "where is auth handled?" via subtoken matches on symbol names', () => {
    const scan = scanOf([
      file("src/auth/service.ts", { symbols: ["AuthService", "verifyAuthToken"] }),
      file("src/billing/invoice.ts", { symbols: ["InvoiceBuilder"] }),
    ]);
    const results = searchIndex(scan, "where is auth handled?");
    expect(results.length).toBe(1);
    expect(results[0]!.file).toBe("src/auth/service.ts");
    expect(results[0]!.matchedTerms).toEqual(["auth"]);
    expect(results[0]!.topSymbols).toEqual(["AuthService", "verifyAuthToken"]);
  });

  it("matches file path segments when no symbol matches", () => {
    const scan = scanOf([
      file("src/payments/stripe.ts", { symbols: ["charge"] }),
      file("src/other/thing.ts", { symbols: ["helper"] }),
    ]);
    const results = searchIndex(scan, "payments");
    expect(results.map((r) => r.file)).toEqual(["src/payments/stripe.ts"]);
    expect(results[0]!.topSymbols).toEqual([]); // no symbol carries the term
  });

  it("matches markdown headings and the summary line", () => {
    const scan = scanOf([
      file("docs/guide.md", { kind: "doc", headings: ["Getting started", "Rate limiting"], summary: "How to configure the proxy." }),
      file("docs/other.md", { kind: "doc", headings: ["Changelog"] }),
    ]);
    expect(searchIndex(scan, "rate limiting")[0]!.file).toBe("docs/guide.md");
    expect(searchIndex(scan, "configure the proxy")[0]!.file).toBe("docs/guide.md");
  });

  it("folds diacritics on both sides (query 'cafe' finds symbol 'café')", () => {
    const scan = scanOf([file("src/menu.ts", { symbols: ["café"] })]);
    const results = searchIndex(scan, "cafe");
    expect(results.length).toBe(1);
    expect(results[0]!.topSymbols).toEqual(["café"]);
  });

  it("ranks the file where all terms co-occur above partial matches", () => {
    const scan = scanOf([
      file("src/http/client.ts", { symbols: ["HttpClient", "retryRequest"] }),
      file("src/http/server.ts", { symbols: ["HttpServer"] }),
      file("src/queue/retry.ts", { symbols: ["retryLater"] }),
    ]);
    const results = searchIndex(scan, "http client retry");
    expect(results[0]!.file).toBe("src/http/client.ts");
    expect(results[0]!.matchedTerms).toEqual(["client", "http", "retry"]);
  });

  it("breaks 4-dp score ties by path (stable, deterministic)", () => {
    const scan = scanOf([
      file("src/b.ts", { symbols: ["target"] }),
      file("src/a.ts", { symbols: ["target"] }),
    ]);
    const results = searchIndex(scan, "target");
    expect(results.map((r) => r.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(results[0]!.score).toBe(results[1]!.score);
  });

  it("reports scores at fixed 4-dp precision and honors `limit`", () => {
    const scan = scanOf([
      file("src/a.ts", { symbols: ["needle"] }),
      file("src/b.ts", { symbols: ["needle", "other"] }),
      file("src/c.ts", { symbols: ["needle", "more", "stuff"] }),
    ]);
    const results = searchIndex(scan, "needle");
    for (const r of results) expect(r.score).toBe(Number(r.score.toFixed(4)));
    expect(searchIndex(scan, "needle", { limit: 2 }).length).toBe(2);
  });

  it("returns [] for an empty or all-stopword query", () => {
    const scan = scanOf([file("src/a.ts", { symbols: ["thing"] })]);
    expect(searchIndex(scan, "")).toEqual([]);
    expect(searchIndex(scan, "how does the it work?")).toEqual([]);
  });

  it("is deterministic across two independent scans of the same repo", () => {
    const a = searchIndex(scanRepo(REPO), "http client retry");
    const b = searchIndex(scanRepo(REPO), "http client retry");
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a[0]!.file).toBe("src/client.ts");
  });
});

describe("charTrigrams / diceCoefficient", () => {
  it("pads with two boundary sentinels on each side before slicing 3-grams", () => {
    expect(charTrigrams("term")).toEqual(new Set(["^^t", "^te", "ter", "erm", "rm$", "m$$"]));
  });

  it("scores identical sets at 1 and disjoint sets at 0", () => {
    expect(diceCoefficient(charTrigrams("auth"), charTrigrams("auth"))).toBe(1);
    expect(diceCoefficient(charTrigrams("auth"), charTrigrams("zzzzz"))).toBe(0);
  });
});

describe("searchIndex fuzzy trigram fallback (df==0 query terms)", () => {
  it('RED→GREEN: a typo ("authh") expands to the vocab term "auth" (Dice >= 0.6) and finds the file', () => {
    const scan = scanOf([
      file("src/auth/service.ts", { symbols: ["AuthService", "verifyAuthToken"] }),
      file("src/billing/invoice.ts", { symbols: ["InvoiceBuilder"] }),
    ]);
    const results = searchIndex(scan, "authh");
    expect(results.length).toBe(1);
    expect(results[0]!.file).toBe("src/auth/service.ts");
    expect(results[0]!.matchedTerms).toEqual([]); // "authh" itself never appears verbatim
    expect(results[0]!.topSymbols).toEqual(["AuthService", "verifyAuthToken"]);
    expect(results[0]!.fuzzyTerms).toEqual(["authh"]);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("does not fuzzy-match a term with low character-trigram similarity (stays unmatched)", () => {
    const scan = scanOf([file("src/auth/service.ts", { symbols: ["AuthService"] })]);
    expect(searchIndex(scan, "zzzzzzz")).toEqual([]);
  });

  it("`fuzzy: false` disables the fallback: the same typo now yields no result", () => {
    const scan = scanOf([file("src/auth/service.ts", { symbols: ["AuthService"] })]);
    expect(searchIndex(scan, "authh", { fuzzy: false })).toEqual([]);
  });

  it("is deterministic across two independent scans of the same repo (fuzzy path included)", () => {
    const a = searchIndex(scanRepo(REPO), "clientt"); // typo of the real fixture term "client"
    const b = searchIndex(scanRepo(REPO), "clientt");
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a[0]!.file).toBe("src/client.ts");
    expect(a[0]!.fuzzyTerms).toEqual(["clientt"]);
  });

  it("REGRESSION: a query whose every term already matches (df>0) stays byte-identical whether fuzzy is on or off", () => {
    const scan = scanOf([
      file("src/http/client.ts", { symbols: ["HttpClient", "retryRequest"] }),
      file("src/http/server.ts", { symbols: ["HttpServer"] }),
      file("src/queue/retry.ts", { symbols: ["retryLater"] }),
    ]);
    const withDefault = searchIndex(scan, "http client retry");
    const withFuzzyExplicit = searchIndex(scan, "http client retry", { fuzzy: true });
    const withFuzzyOff = searchIndex(scan, "http client retry", { fuzzy: false });
    const json = JSON.stringify(withDefault);
    expect(JSON.stringify(withFuzzyExplicit)).toBe(json);
    expect(JSON.stringify(withFuzzyOff)).toBe(json);
    expect(json).not.toContain("fuzzyTerms");
    expect(withDefault[0]!.file).toBe("src/http/client.ts");
    expect(withDefault[0]!.matchedTerms).toEqual(["client", "http", "retry"]);
  });
});

describe("CLI search", () => {
  const run = (args: string[]): string => execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

  it("emits ranked JSON, byte-identical across two runs", () => {
    const a = run(["search", "http client retry", "--repo", REPO]);
    const b = run(["search", "http client retry", "--repo", REPO]);
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as { file: string; score: number; matchedTerms: string[] }[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]!.file).toBe("src/client.ts");
    expect(parsed[0]!.score).toBeGreaterThan(0);
  });
});

// --- BM25F: the field model, and the two fields that make prose findable ------
describe("searchIndex: BM25F fields", () => {
  it("finds a file by a phrase that appears ONLY in a doc comment", () => {
    // The regression this whole field model exists for: nothing in the path or
    // any symbol name says "exponential backoff", so a name-only index returns
    // nothing at all — not a low rank, no result.
    const repo = repoWith({
      "src/net.ts": [
        "/** Retry a request with exponential backoff and jitter. */",
        "export function send(url: string): string {",
        "  return url;",
        "}",
        "",
      ].join("\n"),
      "src/other.ts": "export function unrelated(): number {\n  return 1;\n}\n",
    });
    const hits = searchIndex(scanRepo(repo), "exponential backoff");
    expect(hits[0]!.file).toBe("src/net.ts");
    expect(hits[0]!.matchedFields).toContain("doc");
  });

  it("finds a file by a phrase that appears only in a NON-doc comment (the body field)", () => {
    const repo = repoWith({
      "src/limits.ts": [
        "// A token bucket per client key, refilled at a steady rate.",
        "export class Bucket {}",
        "",
      ].join("\n"),
      "src/other.ts": "export function unrelated(): number {\n  return 1;\n}\n",
    });
    const hits = searchIndex(scanRepo(repo), "refilled at a steady rate");
    expect(hits[0]!.file).toBe("src/limits.ts");
    expect(hits[0]!.matchedFields).toContain("body");
  });

  it("ranks a symbol-name match above a prose-only match for the same term", () => {
    const repo = repoWith({
      "named.ts": "export function throttle(): void {}\n",
      "prosed.ts": "// Something about throttle behaviour here.\nexport function other(): void {}\n",
    });
    const hits = searchIndex(scanRepo(repo), "throttle");
    expect(hits.map((h) => h.file)).toEqual(["named.ts", "prosed.ts"]);
  });

  it("anchors a result at the matched declaration's line", () => {
    const repo = repoWith({
      "a.ts": ["export function first(): void {}", "", "export function target(): void {}", ""].join("\n"),
    });
    const hit = searchIndex(scanRepo(repo), "target")[0]!;
    expect(hit.line).toBe(3);
    expect(hit.symbolHits).toEqual([{ name: "target", kind: "function", line: 3 }]);
  });

  it("demotes a test file below the code it tests, unless the query asks for tests", () => {
    const repo = repoWith({
      "src/parser.ts": "export function parser(): void {}\n",
      "tests/parser.test.ts": "export function parserTest(): void {}\n",
    });
    const scan = scanRepo(repo);
    expect(searchIndex(scan, "parser")[0]!.file).toBe("src/parser.ts");
    // The demotion is intent-aware: asking for the test must still find it.
    expect(searchIndex(scan, "parser test")[0]!.file).toBe("tests/parser.test.ts");
  });

  it("prefers a whole-identifier match over a subtoken match", () => {
    const repo = repoWith({
      "whole.ts": "export function payload(): void {}\n",
      "part.ts": "export function payloadEncoderRegistryFactory(): void {}\n",
    });
    expect(searchIndex(scanRepo(repo), "payload")[0]!.file).toBe("whole.ts");
  });
});

describe("searchIndex: stem fallback", () => {
  it('rescues an inflected query term: "caching" finds a doc comment saying "cache"', () => {
    const repo = repoWith({
      "store.ts": "/** A read-through cache with per-entry expiry. */\nexport class Memo {}\n",
      "other.ts": "export function unrelated(): void {}\n",
    });
    const hits = searchIndex(scanRepo(repo), "caching");
    expect(hits[0]!.file).toBe("store.ts");
    expect(hits[0]!.fuzzyTerms).toEqual(["caching"]);
  });

  it("prefers the literal term over the stemmed one", () => {
    const repo = repoWith({
      "exact.ts": "// handles retries for us\nexport function a1(): void {}\n",
      "stemmed.ts": "// handles retry for us\nexport function a2(): void {}\n",
    });
    expect(searchIndex(scanRepo(repo), "retries")[0]!.file).toBe("exact.ts");
  });

  it("`fuzzy: false` disables the stem fallback too", () => {
    const repo = repoWith({ "store.ts": "/** A read-through cache. */\nexport class Memo {}\n" });
    expect(searchIndex(scanRepo(repo), "caching", { fuzzy: false })).toEqual([]);
  });

  it("leaves a query whose terms all match untouched by either fallback", () => {
    const repo = repoWith({ "a.ts": "/** A read-through cache. */\nexport class Memo {}\n" });
    const scan = scanRepo(repo);
    expect(JSON.stringify(searchIndex(scan, "cache", { fuzzy: true }))).toBe(
      JSON.stringify(searchIndex(scan, "cache", { fuzzy: false })),
    );
  });
});

describe("searchIndex: rank modes", () => {
  it("defaults to lexical and accepts an explicit structural prior", () => {
    const repo = repoWith({
      "hub.ts": "export function hub(): void {}\n",
      "leaf.ts": 'import { hub } from "./hub.js";\nexport function leaf(): void {\n  hub();\n}\n',
    });
    const scan = scanRepo(repo);
    const lexical = searchIndex(scan, "hub", { rank: "lexical" });
    expect(JSON.stringify(searchIndex(scan, "hub"))).toBe(JSON.stringify(lexical));
    // The graph mode must produce a well-formed, deterministic result too.
    const graph = searchIndex(scan, "hub", { rank: "graph" });
    expect(graph[0]!.file).toBe("hub.ts");
    expect(JSON.stringify(graph)).toBe(JSON.stringify(searchIndex(scan, "hub", { rank: "graph" })));
  });
});

describe("stemOf", () => {
  it("maps inflections of one word onto a single stem", () => {
    expect(stemOf("caching")).toBe(stemOf("cache"));
    expect(stemOf("cached")).toBe(stemOf("cache"));
    expect(stemOf("retries")).toBe(stemOf("retry"));
    expect(stemOf("retrying")).toBe(stemOf("retry"));
    expect(stemOf("rates")).toBe(stemOf("rate"));
    expect(stemOf("handling")).toBe(stemOf("handle"));
  });

  it("leaves short tokens and non-inflected words alone", () => {
    expect(stemOf("id")).toBe("id");
    expect(stemOf("api")).toBe("api");
    expect(stemOf("class")).toBe("class");
    expect(stemOf("status")).toBe("status");
    expect(stemOf("basis")).toBe("basis");
  });

  it("does not conflate unrelated words", () => {
    expect(stemOf("cache")).not.toBe(stemOf("cash"));
    expect(stemOf("handler")).not.toBe(stemOf("handle"));
  });
});
