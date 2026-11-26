import { describe, it, expect } from "vitest";
import { keywords, droppedKeywords, rankedKeywords, slugify, rrf, escapeRegExp, clip, clipInline, foldText, subtokens } from "../src/util.js";

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

// Chinese and Japanese put no space between words, so a whole question used to
// be one token that matched nothing. A CJK run is cut into overlapping bigrams
// (Lucene's CJKAnalyzer), on the query side and the indexed side alike.
describe("keywords: CJK bigrams", () => {
  it("cuts a Chinese question into overlapping bigrams", () => {
    expect(keywords("如何计算遣散费")).toEqual(["如何", "何计", "计算", "算遣", "遣散", "散费"]);
  });

  it("cuts Japanese across kanji, hiragana and katakana, keeping voiced kana and ー whole", () => {
    expect(keywords("解雇手当の計算")).toEqual(["解雇", "雇手", "手当", "当の", "の計", "計算"]);
    // NFKD splits が into か + U+3099; the bigram must hold the composed kana.
    expect(keywords("コーヒーが好き")).toEqual(["コー", "ーヒ", "ヒー", "ーが", "が好", "好き"]);
    expect(keywords("ｺｰﾋｰ")).toEqual(keywords("コーヒー")); // half-width folds to full-width
  });

  it("cuts Korean into syllable bigrams, not jamo", () => {
    expect(keywords("퇴직금 계산")).toEqual(["퇴직", "직금", "계산"]);
    expect(keywords("퇴직금계산")).toEqual(["퇴직", "직금", "금계", "계산"]);
  });

  it("keeps a lone CJK character, which is a word, not 1-char noise", () => {
    expect(keywords("用 API")).toEqual(["用", "API"]);
    expect(droppedKeywords("用 a API")).toEqual(["a"]);
  });

  it("yields both kinds of token for mixed text and splits at the script boundary", () => {
    expect(keywords("用户 login")).toEqual(["用户", "login"]);
    expect(keywords("API设计")).toEqual(["API", "设计"]);
    expect(keywords("the 用户 of retryRequest")).toEqual(["用户", "retryRequest"]);
    expect(droppedKeywords("如何计算遣散费")).toEqual([]);
  });

  it("leaves text without CJK exactly as it was", () => {
    expect(keywords("How does the retryRequest function handle a 429 status?")).toEqual(["retryRequest", "function", "429", "status"]);
    expect(keywords("où est København")).toEqual(["ou", "est", "København"]);
    expect(droppedKeywords("how does the default value work")).toEqual(["how", "does", "the", "default", "value", "work"]);
  });

  it("subtokens agrees with keywords, so a query bigram can hit indexed prose", () => {
    expect(subtokens("// 计算遣散费的金额。使用 getUserName 函数")).toEqual([
      "计算", "算遣", "遣散", "散费", "费的", "的金", "金额", "使用", "getusername", "get", "user", "name", "函数",
    ]);
    expect(subtokens("API设计")).toEqual(["api", "设计"]);
    // Idempotent on its own output: extraction stores bigrams and buildDocs
    // passes them through subtokens again; the query side does the same.
    for (const q of ["如何计算遣散费", "コーヒーが好き", "퇴직금계산", "用"]) {
      for (const k of keywords(q)) expect(subtokens(k)).toEqual([k]);
    }
  });
});

describe("foldText", () => {
  it("returns ASCII untouched and folds everything else exactly as NFKD would", () => {
    // ASCII skips the ICU call; the output must be what the slow path gives.
    const plain = "parse_JSONBody retries 429 ~!@#$%^&*()\t\n\u007f";
    expect(foldText(plain)).toBe(plain);
    expect(foldText(plain)).toBe(plain.normalize("NFKD"));
    expect(foldText("café")).toBe("cafe");
    expect(foldText("Ｆｕｌｌwidth ﬁle naïve")).toBe("Fullwidth file naive");
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
