import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { searchIndex, subtokens } from "../src/bm25.js";
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

function scanOf(files: FileRecord[]): RepoScan {
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false, excluded: 0 };
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
