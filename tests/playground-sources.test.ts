// The playground's data source: which provider answers, which ref it lands on,
// and what happens when GitHub's rate limit runs out.
//
// Driven with an injected fetch so the decision logic is tested deterministically
// rather than against whatever the network is doing. The live behaviour of both
// providers is covered separately by tests/playground-e2e.test.ts.
//
// The measurements that motivated this ordering, taken on t3-oss/create-t3-turbo
// at the same commit: the GitHub trees API listed 141 blobs and all 141 fetched;
// jsDelivr listed 125, of which 37 no longer existed at that ref (404 on
// raw.githubusercontent too, so genuinely deleted rather than a URL bug). Hence
// GitHub first, jsDelivr only as the rate-limit fallback — and a visible note
// when the fallback is what answered.

import { describe, it, expect } from "vitest";

const SOURCES = new URL("../site/playground/sources.js", import.meta.url).href;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const sources = await import(/* @vite-ignore */ SOURCES);
const { resolveSource, parseRepoInput } = sources as Any;

/** A fetch stand-in driven by a url → response table. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const match = Object.keys(routes).find((pattern) => url.includes(pattern));
    const route = match ? routes[match]! : { status: 404, body: {} };
    return {
      ok: (route.status ?? 200) >= 200 && (route.status ?? 200) < 300,
      status: route.status ?? 200,
      json: async () => route.body ?? {},
    };
  };
  return { impl, calls };
}

const tree = (paths: [string, number][]) => ({
  truncated: false,
  tree: paths.map(([path, size]) => ({ path, type: "blob", size })),
});

describe("playground source resolution", () => {
  it("prefers the GitHub trees API, and reports sizes from it", async () => {
    const { impl, calls } = fakeFetch({
      "api.github.com": { body: tree([["src/index.ts", 120]]) },
    });

    const source = await resolveSource("acme", "thing", "", impl);

    expect(source.provider).toBe("github");
    expect(source.ref).toBe("main");
    expect(source.files).toEqual([{ path: "/src/index.ts", size: 120 }]);
    expect(source.note).toBe("");
    expect(calls[0]).toContain("git/trees/main?recursive=1");
    // jsDelivr must not be consulted at all when GitHub answered.
    expect(calls.some((url) => url.includes("jsdelivr"))).toBe(false);
  });

  it("serves contents from raw.githubusercontent, encoding each path segment", async () => {
    const { impl } = fakeFetch({ "api.github.com": { body: tree([["src/a b/[id].ts", 10]]) } });
    const source = await resolveSource("acme", "thing", "main", impl);

    // Square brackets and spaces are ordinary in real trees (Next.js dynamic
    // routes), and an unencoded path is a 404. The exact string is asserted
    // because a stray double slash also 404s and is invisible by inspection.
    expect(source.contentUrl("/src/a b/[id].ts")).toBe("https://raw.githubusercontent.com/acme/thing/main/src/a%20b/%5Bid%5D.ts");
    expect(source.contentUrl("README.md")).toBe("https://raw.githubusercontent.com/acme/thing/main/README.md");
  });

  it("builds jsDelivr content URLs with exactly one separator too", async () => {
    const { impl } = fakeFetch({
      "api.github.com": { status: 403 },
      "data.jsdelivr.com": { body: { files: [{ name: "/src/a b/[id].ts", size: 10 }] } },
    });
    const source = await resolveSource("acme", "thing", "main", impl);
    expect(source.contentUrl("/src/a b/[id].ts")).toBe("https://cdn.jsdelivr.net/gh/acme/thing@main/src/a%20b/%5Bid%5D.ts");
  });

  it("falls back from main to master", async () => {
    const { impl, calls } = fakeFetch({
      "git/trees/main": { status: 404 },
      "git/trees/master": { body: tree([["gin.go", 90]]) },
    });

    const source = await resolveSource("gin-gonic", "gin", "", impl);

    expect(source.ref).toBe("master");
    expect(source.provider).toBe("github");
    expect(calls[0]).toContain("git/trees/main");
    expect(calls[1]).toContain("git/trees/master");
  });

  it("falls back to jsDelivr when the GitHub rate limit is exhausted, and says so", async () => {
    const { impl, calls } = fakeFetch({
      "api.github.com": { status: 403 },
      "data.jsdelivr.com": { body: { files: [{ name: "/src/index.ts", size: 42 }] } },
    });

    const source = await resolveSource("acme", "thing", "", impl);

    expect(source.provider).toBe("jsdelivr");
    expect(source.files).toEqual([{ path: "/src/index.ts", size: 42 }]);
    // Both caveats surface: why the fallback happened, and what it costs.
    expect(source.note).toMatch(/rate limit/i);
    expect(source.note).toMatch(/snapshots a branch/i);
    // Rate limiting moves to the next PROVIDER, not the next ref — retrying
    // master against a rate-limited API would just burn another request.
    expect(calls.filter((url) => url.includes("api.github.com"))).toHaveLength(1);
  });

  it("flags a truncated GitHub tree instead of indexing a partial one silently", async () => {
    const { impl } = fakeFetch({
      "api.github.com": { body: { truncated: true, tree: [{ path: "a.ts", type: "blob", size: 1 }] } },
    });
    const source = await resolveSource("acme", "huge", "main", impl);
    expect(source.note).toMatch(/truncated/i);
  });

  it("keeps only blobs, never tree entries", async () => {
    const { impl } = fakeFetch({
      "api.github.com": {
        body: { truncated: false, tree: [{ path: "src", type: "tree" }, { path: "src/a.ts", type: "blob", size: 5 }] },
      },
    });
    const source = await resolveSource("acme", "thing", "main", impl);
    expect(source.files).toEqual([{ path: "/src/a.ts", size: 5 }]);
  });

  it("explains what it tried when nothing resolves", async () => {
    const { impl } = fakeFetch({});
    await expect(resolveSource("acme", "missing", "", impl)).rejects.toThrow(/on main or master/);
    await expect(resolveSource("acme", "missing", "dev", impl)).rejects.toThrow(/@dev/);
  });
});

describe("repository input parsing", () => {
  const cases: [string, { owner: string; repo: string; ref: string } | null][] = [
    ["gin-gonic/gin", { owner: "gin-gonic", repo: "gin", ref: "" }],
    ["gin-gonic/gin@v1.9.1", { owner: "gin-gonic", repo: "gin", ref: "v1.9.1" }],
    ["  pallets/flask  ", { owner: "pallets", repo: "flask", ref: "" }],
    ["https://github.com/facebook/react", { owner: "facebook", repo: "react", ref: "" }],
    ["https://github.com/facebook/react.git", { owner: "facebook", repo: "react", ref: "" }],
    ["github.com/vercel/next.js", { owner: "vercel", repo: "next.js", ref: "" }],
    ["https://github.com/vuejs/core/tree/minor", { owner: "vuejs", repo: "core", ref: "minor" }],
    ["https://github.com/vuejs/core/blob/main/README.md", { owner: "vuejs", repo: "core", ref: "main" }],
    ["", null],
    ["not a repo", null],
    ["justaword", null],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      expect(parseRepoInput(input)).toEqual(expected);
    });
  }
});
