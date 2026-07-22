import { describe, it, expect } from "vitest";
import { keywords, rankedKeywords, slugify, rrf, escapeRegExp, clip, clipInline } from "../src/util.js";

describe("keywords", () => {
  it("drops stopwords and short noise, keeps identifiers", () => {
    const k = keywords("How does the retryRequest function handle a 429 status?");
    expect(k).toContain("retryRequest");
    expect(k).toContain("429");
    expect(k).toContain("status");
    expect(k).not.toContain("the");
    expect(k).not.toContain("does");
  });
  it("dedupes case-insensitively but preserves original token", () => {
    const k = keywords("Backoff backoff BACKOFF");
    expect(k).toEqual(["Backoff"]);
  });
});

describe("rankedKeywords", () => {
  it("ranks numbers and long/identifier tokens before short generic words", () => {
    const r = rankedKeywords("retry on 429 rate limit exponential backoff");
    expect(r[0]).toBe("429"); // a number is the most distinctive
    expect(r.indexOf("exponential")).toBeLessThan(r.indexOf("rate"));
  });
});

describe("slugify", () => {
  it("normalizes a repo URL into a filesystem-safe slug", () => {
    expect(slugify("https://github.com/expressjs/express.git")).toBe("github.com-expressjs-express");
    expect(slugify("git@github.com:a/b.git")).toBe("github.com-a-b");
  });
});

describe("rrf", () => {
  it("fuses ranked lists, rewarding items ranked high across lists", () => {
    const a = [{ k: "x" }, { k: "y" }, { k: "z" }];
    const b = [{ k: "y" }, { k: "x" }, { k: "w" }];
    const fused = rrf([a, b], (i) => i.k);
    // y and x appear high in both; y is #1+#0, x is #0+#1 -> both beat z and w
    const ranked = [...fused.entries()].sort((p, q) => q[1] - p[1]).map(([k]) => k);
    expect(ranked.slice(0, 2).sort()).toEqual(["x", "y"]);
  });
});

describe("misc helpers", () => {
  it("escapeRegExp escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
  });
  it("clip truncates with a marker", () => {
    expect(clip("abcdef", 3)).toContain("truncated");
    expect(clip("ab", 3)).toBe("ab");
  });
  it("clipInline never leaves a dangling inline-code backtick", () => {
    // A long monorepo module summary clipped mid-codespan must stay valid markdown
    // (a balanced backtick), not the broken "… (types" a raw slice would yield.
    const summary = "5 file(s) in `packages/code-du-travail-modeles/src/modeles/common/types/` (typescript).";
    const out = clipInline(summary, 80);
    expect((out.match(/`/g)?.length ?? 0) % 2).toBe(0); // backticks balanced
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("\n"); // single inline line
  });
  it("clipInline returns short strings untouched (sans ellipsis)", () => {
    expect(clipInline("a short summary", 80)).toBe("a short summary");
  });
  it("clipInline never emits an empty inline-code span when a lone backtick is severed", () => {
    // Cut lands right where a code span opens → must NOT become an adjacent ``.
    const out = clipInline("the value is `reallyLongIdentifierThatGetsCut", 18);
    expect(out).not.toContain("``");
    expect((out.match(/`/g)?.length ?? 0) % 2).toBe(0);
  });
  it("clipInline drops a half-open markdown link instead of leaving a dangling '['", () => {
    const out = clipInline("see the [Getting Started guide for more", 16);
    expect(out.lastIndexOf("[")).toBeLessThanOrEqual(out.lastIndexOf("]"));
    expect(out.endsWith("…")).toBe(true);
  });
});
