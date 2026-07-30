import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAMPLE_CAP,
  detectTools,
  diffCtags,
  diffThreeWay,
  isFileNamespace,
  lastFailure,
  parseCtagsJson,
  parseCtagsMaps,
  parseScipSymbol,
} from "./oracles/external-diff.js";
import type { ExternalDiff } from "./oracles/external-diff.js";

// Tests for the external symbol oracle (tests/oracles/external-diff.ts), split
// in two by cost:
//
//   ALWAYS ON — detection is well-formed, and the two parsers that decode the
//   external tools are exercised on hand-written input. These need no external
//   tool and no repo, so they run in `pnpm test` and are the regression teeth
//   that matter: a parser that silently mis-reads ctags JSON or a SCIP symbol
//   string would fabricate agreement, which is the one failure this whole oracle
//   exists to prevent.
//
//   CODEINDEX_ORACLE=1 — the real measurements. They clone-cache six pinned
//   repos, build our index, run universal-ctags, and (for the three-way) `pnpm
//   install` + `scip-typescript index` a monorepo. Minutes, not seconds, so
//   `pnpm test` stays fast:
//       CODEINDEX_ORACLE=1 pnpm vitest run tests/oracles-external-diff.test.ts
//
// Every external-tool test is gated on availability, never on hope: no ctags or
// no scip-typescript means SKIPPED, not red.
const ORACLE = process.env.CODEINDEX_ORACLE === "1";

const tools = detectTools();
const CACHE = fileURLToPath(new URL("./.e2e-cache", import.meta.url));

// Same cache layout and shallow-fetch as tests/e2e-real-repos.test.ts
// `clonePinned`, so an already-populated cache is reused and nothing
// re-downloads. Duplicated rather than imported because that helper is private
// to its own suite.
function clonePinned(slug: string, sha: string): string {
  const dir = join(CACHE, `${slug.replace("/", "__")}@${sha.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/${slug}`);
  git("fetch", "-q", "--depth", "1", "origin", sha);
  git("checkout", "-q", "FETCH_HEAD");
  return dir;
}

function report(label: string, d: ExternalDiff): void {
  /* eslint-disable no-console */
  console.log(
    `\n${label}  [${d.universe} files all participants looked at]\n` +
      `  ours=${d.ours}  ctags=${d.ctags}  scip=${d.scip}  agreeAll=${d.agreeAll}\n` +
      `  ctagsRecall=${d.ctagsRecall}  scipRecall=${d.scipRecall}  ` +
      `scipNotCtags=${d.scipNotCtags}  oursOnly(surplus)=${d.oursOnly}  unparsedScip=${d.unparsedScipSymbols}`,
  );
  for (const [name, list] of [
    ["ctagsOnly", d.ctagsOnly],
    ["scipOnly", d.scipOnly],
  ] as const) {
    console.log(`  ${name} (${list.length}):`);
    for (const s of list) console.log(`    ${s}`);
  }
  /* eslint-enable no-console */
}

// A capped sample must announce its own truncation — a silently cut list reads
// as a complete one, which is the same lie as a silent drop.
function expectWellFormedSample(list: string[]): void {
  expect(list.length).toBeLessThanOrEqual(SAMPLE_CAP + 1);
  if (list.length === SAMPLE_CAP + 1) {
    expect(list[SAMPLE_CAP]).toMatch(new RegExp(`^\\+\\d+ more \\(cap ${SAMPLE_CAP}\\)$`));
  }
}

// The five readings must stay SEPARATE and internally consistent. Fusing them
// into one "accuracy" is the mistake the oracle exists to avoid, so the counts
// are checked to be a real partition of a real set.
function expectCoherentReadings(d: ExternalDiff): void {
  expect(d.universe).toBeGreaterThan(0);
  expect(d.agreeAll).toBeLessThanOrEqual(Math.min(d.ours, d.ctags, d.scip || d.ours));
  expect(d.oursOnly).toBeLessThanOrEqual(d.ours);
  expect(d.scipNotCtags).toBeLessThanOrEqual(d.scip);
  for (const r of [d.ctagsRecall, d.scipRecall]) {
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThanOrEqual(1);
  }
  expectWellFormedSample(d.ctagsOnly);
  expectWellFormedSample(d.scipOnly);
}

// ---------------------------------------------------------------------------
// Always on — no external tool, no repo.
// ---------------------------------------------------------------------------
describe("detectTools", () => {
  it("returns well-formed statuses for both tools without throwing", () => {
    const t = detectTools();
    expect(Object.keys(t).sort()).toEqual(["ctags", "scipTs"]);
    expect(t.ctags.name).toBe("ctags");
    expect(t.scipTs.name).toBe("scip-typescript");
    for (const s of [t.ctags, t.scipTs]) {
      expect(typeof s.available).toBe("boolean");
      // Absence is a VALUE: unavailable always says why, available never has to.
      if (s.available) {
        expect(s.path && existsSync(s.path)).toBe(true);
        expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
      } else {
        expect(s.reason && s.reason.length > 0).toBe(true);
      }
    }
  });

  it("is total: repeated probing never throws and never changes its answer", () => {
    expect(JSON.stringify(detectTools())).toBe(JSON.stringify(detectTools()));
  });
});

describe("parseCtagsJson", () => {
  it("reads the documented tag shape and normalises paths", () => {
    const stdout = [
      '{"_type": "tag", "name": "getBaseUrl", "path": "./src/utils/base-url.ts", "line": 3, "kind": "function"}',
      '{"_type": "tag", "name": "Post", "path": "packages\\\\db\\\\src\\\\schema.ts", "line": 9, "kind": "constant"}',
    ].join("\n");
    const { tags, malformed } = parseCtagsJson(stdout);
    expect(malformed).toBe(0);
    expect(tags).toEqual([
      { name: "getBaseUrl", path: "src/utils/base-url.ts", line: 3, kind: "function" },
      { name: "Post", path: "packages/db/src/schema.ts", line: 9, kind: "constant" },
    ]);
  });

  it("counts malformed lines instead of throwing or dropping them", () => {
    const { tags, malformed } = parseCtagsJson(
      [
        "",
        "   ",
        "{not json",
        "[1,2,3]", // JSON, but not a tag object
        '{"_type": "tag", "path": "a.ts"}', // no name
        '{"_type": "tag", "name": "x"}', // no path
        '{"_type": "tag", "name": "ok", "path": "a.ts", "line": 1, "kind": "function"}',
      ].join("\n"),
    );
    // Blank lines are not errors; the four broken records are, and none of them
    // may vanish silently — a vanished ctags tag reads as agreement.
    expect(malformed).toBe(4);
    expect(tags.map((t) => t.name)).toEqual(["ok"]);
  });

  it("skips ctags' non-tag records without calling them malformed", () => {
    const { tags, malformed } = parseCtagsJson(
      [
        '{"_type": "ptag", "name": "JSON_OUTPUT_VERSION", "parserName": "", "path": "", "value": "0.0"}',
        '{"_type": "tag", "name": "ok", "path": "a.ts", "line": 1, "kind": "function"}',
      ].join("\n"),
    );
    expect(malformed).toBe(0);
    expect(tags.map((t) => t.name)).toEqual(["ok"]);
  });

  it("keeps a name that contains a colon intact", () => {
    // ctags' Yaml and Asciidoc parsers emit names with ':' in them. The (file,
    // name) key must not be split on it — that would compare the wrong pair.
    const { tags } = parseCtagsJson(
      '{"_type": "tag", "name": "@typescript-eslint/no-explicit-any", "path": "eslint.config.mjs", "line": 4, "kind": "string"}',
    );
    expect(tags[0]!.name).toBe("@typescript-eslint/no-explicit-any");
    expect(tags[0]!.path).toBe("eslint.config.mjs");
  });

  it("defaults line and kind rather than rejecting a tag that lacks them", () => {
    const { tags, malformed } = parseCtagsJson('{"_type": "tag", "name": "x", "path": "a.ts"}');
    expect(malformed).toBe(0);
    expect(tags).toEqual([{ name: "x", path: "a.ts", line: 0, kind: "" }]);
  });
});

describe("parseCtagsMaps", () => {
  it("splits extensions from whole-name patterns and counts what it will not model", () => {
    const maps = parseCtagsMaps(
      [
        "Unknown ",
        "BibLaTeX", // a language with no patterns at all
        "TypeScript *.ts *.tsx *.mts *.cts",
        "CMake    CMakeLists.txt *.cmake",
        "Asm      *.A51 *.29[kK] *.s",
        "Vim      [._]vimrc vimrc",
        "Ant      build.xml *.build.xml *.xml",
      ].join("\n"),
    );
    expect([...maps.extensions].sort()).toEqual(
      [".a51", ".build.xml", ".cmake", ".cts", ".mts", ".s", ".ts", ".tsx", ".xml"].sort(),
    );
    expect([...maps.filenames].sort()).toEqual(["CMakeLists.txt", "build.xml", "vimrc"]);
    // `*.29[kK]` and `[._]vimrc` carry character classes; counted, not guessed at.
    expect(maps.unsupportedPatterns).toBe(2);
  });

  it("survives an empty listing without inventing maps", () => {
    const maps = parseCtagsMaps("");
    expect(maps.extensions.size).toBe(0);
    expect(maps.filenames.size).toBe(0);
  });
});

describe("parseScipSymbol", () => {
  // Every string below is REAL scip-typescript 0.4.0 output, copied out of an
  // index of t3-oss/create-t3-turbo. scip-typescript leaves display_name empty
  // (800 of 800 symbols), so this parser is the only source of a name — a wrong
  // answer here silently rewrites the authoritative side of the comparison.
  const P = "scip-typescript npm @acme/expo HEAD ";

  it("extracts the name from each declaration descriptor", () => {
    expect(parseScipSymbol(`${P}src/utils/\`base-url.ts\`/getBaseUrl.`)).toMatchObject({
      kind: "declaration",
      name: "getBaseUrl",
    });
    expect(parseScipSymbol(`${P}src/app/\`index.tsx\`/PostCard().`)).toMatchObject({
      kind: "declaration",
      name: "PostCard",
    });
    expect(parseScipSymbol(`${P}src/\`index.ts\`/Auth#`)).toMatchObject({ kind: "declaration", name: "Auth" });
    expect(parseScipSymbol(`${P}src/\`m.ts\`/thing!`)).toMatchObject({ kind: "declaration", name: "thing" });
  });

  it("reads a backtick-escaped name, including a doubled backtick", () => {
    // `[id].tsx` is a real Expo route file; the escaped form is the only way a
    // path or an exotic identifier can appear in a symbol string.
    expect(parseScipSymbol(`${P}src/app/post/\`[id].tsx\`/Post().`)).toMatchObject({
      kind: "declaration",
      name: "Post",
    });
    expect(parseScipSymbol(`${P}\`a.ts\`/\`we\`\`ird\`.`)).toMatchObject({
      kind: "declaration",
      name: "we`ird",
    });
  });

  it("classifies a nameless local as local, not as unparsed", () => {
    expect(parseScipSymbol("local 2")).toEqual({ kind: "local" });
    expect(parseScipSymbol("local 4~")).toEqual({ kind: "local" });
  });

  it("excludes parameters, type parameters and anonymous-literal members", () => {
    // A parameter or type parameter is not a declaration any definition indexer
    // publishes, and `meta` (`name<int>:`) is scip-typescript's descriptor for an
    // object-/type-literal key whose trailing integer is NOT in the source. All
    // are recognised and set aside — never counted as a name, never as unparsed.
    const A = "scip-typescript npm @acme/auth HEAD ";
    for (const sym of [
      `${A}src/\`index.ts\`/initAuth().(options)`,
      `${A}src/\`index.ts\`/initAuth().[TExtraPlugins]`,
      `${A}src/\`index.ts\`/initAuth().(options)typeLiteral0:baseUrl.`,
      `${A}src/\`schema.ts\`/title1:`,
      `${A}src/\`auth-schema.ts\`/onDelete0:`,
    ]) {
      expect(parseScipSymbol(sym), sym).toEqual({ kind: "anonymous-scope" });
    }
  });

  it("reports what it cannot decode instead of guessing a name", () => {
    for (const sym of [
      "",
      "not a symbol",
      "scip-typescript npm @acme/expo HEAD", // no descriptors at all
      "scip-typescript npm @acme/expo HEAD src/`unterminated.ts/x.", // unclosed escape
      "scip-typescript npm @acme/expo HEAD trailing~garbage", // no descriptor suffix
      "scip-typescript npm @acme/expo HEAD foo(1)", // method's ')' not followed by '.'
    ]) {
      expect(parseScipSymbol(sym), sym).toEqual({ kind: "unparsed" });
    }
  });

  it("tells a Document's own module symbol apart from a real module augmentation", () => {
    const own = parseScipSymbol(`${P}src/utils/\`base-url.ts\`/`);
    expect(own).toMatchObject({ kind: "declaration", name: "base-url.ts" });
    // It names the FILE, not anything declared in it, so it must not count.
    expect(isFileNamespace(own, "apps/expo/src/utils/base-url.ts")).toBe(true);

    // `declare module '@tanstack/react-router'` also ends in a namespace, and it
    // IS a declaration — which is why the check compares against the basename
    // rather than rejecting every trailing namespace.
    const aug = parseScipSymbol(
      "scip-typescript npm @acme/tanstack-start HEAD src/`routeTree.gen.ts`/`'@tanstack/react-router'`/",
    );
    expect(aug).toMatchObject({ kind: "declaration", name: "'@tanstack/react-router'" });
    expect(isFileNamespace(aug, "apps/tanstack-start/src/routeTree.gen.ts")).toBe(false);
  });

  it("never throws, whatever bytes arrive", () => {
    for (const s of ["`", "``", "local", "a b c d", "\u0000", "( )", "[", "x#y", "  "]) {
      expect(() => parseScipSymbol(s)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// CODEINDEX_ORACLE=1 — the real measurements.
// ---------------------------------------------------------------------------

// The three-way needs the target repo's dependencies installed, because
// scip-typescript type-checks for real.
describe.skipIf(!ORACLE || !tools.ctags.available || !tools.scipTs.available)(
  "three-way differential: ours vs universal-ctags vs scip-typescript",
  () => {
    it(
      "measures create-t3-turbo against a compiler-backed authority",
      { timeout: 1_800_000 },
      () => {
        const dir = clonePinned("t3-oss/create-t3-turbo", "8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee");
        const d = diffThreeWay(dir, "t3-oss/create-t3-turbo");
        // A failed install or a broken index is a SKIP with a reason, never a
        // red suite — but the reason has to reach the reader.
        if (!d) {
          // eslint-disable-next-line no-console
          console.log(`three-way unavailable: ${lastFailure()}`);
          expect(lastFailure()).toBeTruthy();
          return;
        }
        report("t3-oss/create-t3-turbo (three-way)", d);
        expectCoherentReadings(d);

        // Every symbol string in the index decoded. This is the tooth that
        // catches scip-typescript changing its descriptor grammar under us:
        // undecoded symbols would otherwise quietly shrink the authoritative
        // side and inflate our recall.
        expect(d.unparsedScipSymbols).toBe(0);

        // Ratchets pinned just under the measured baseline (scipRecall 1.0000,
        // ctagsRecall 0.7244 over a 53-file universe). The commit is pinned, so
        // only a real extraction regression can move these.
        expect(d.scip).toBeGreaterThan(50);
        expect(d.scipRecall).toBeGreaterThanOrEqual(0.97);
        expect(d.ctagsRecall).toBeGreaterThanOrEqual(0.65);

        // The surplus row is an ADVANTAGE, not an error: ctags and
        // scip-typescript are definition indexers, so what we extract beyond a
        // definition cannot appear in their output and must land here.
        expect(d.oursOnly).toBeGreaterThan(0);
      },
    );
  },
);

// ctags reaches ~40 languages, so it is the breadth reading — and it needs no
// install, which is why more repos are affordable here than in the three-way.
// The ratchets are the measured baselines, minus a little headroom.
const CTAGS_REPOS: { slug: string; sha: string; minCtagsRecall: number }[] = [
  { slug: "pallets/flask", sha: "36e4a824f340fdee7ed50937ba8e7f6bc7d17f81", minCtagsRecall: 0.88 }, // measured 0.9145
  { slug: "gin-gonic/gin", sha: "34dac209ffb6ef85cc78c5d217bbb7ad001d68fd", minCtagsRecall: 0.88 }, // measured 0.9127
  { slug: "BurntSushi/ripgrep", sha: "59e318f5ace48db54f37bb67c152535bc17fa153", minCtagsRecall: 0.95 }, // measured 0.9799
  { slug: "nrwl/nx-examples", sha: "0808ace9640cdae6fbbc9b000292383ea6d78c9f", minCtagsRecall: 0.6 }, // measured 0.6880
  { slug: "t3-oss/create-t3-turbo", sha: "8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee", minCtagsRecall: 0.65 }, // measured 0.7244
  {
    // The lowest recall of the six, and the clearest demonstration that a ctags
    // gap is not automatically OUR gap: the misses are overwhelmingly
    // function-body `const`s and quoted eslint-config object keys, which ctags
    // tags and a definition index deliberately does not.
    slug: "socialgouv/code-du-travail-numerique",
    sha: "886297ad7ce94d6377863d8fbf88e24f696dd3b7",
    minCtagsRecall: 0.55, // measured 0.6086
  },
];

describe.skipIf(!ORACLE || !tools.ctags.available)("breadth differential: ours vs universal-ctags", () => {
  it.each(CTAGS_REPOS)("$slug", { timeout: 900_000 }, ({ slug, sha, minCtagsRecall }) => {
    const d = diffCtags(clonePinned(slug, sha), slug);
    if (!d) {
      // eslint-disable-next-line no-console
      console.log(`${slug}: ctags diff unavailable: ${lastFailure()}`);
      expect(lastFailure()).toBeTruthy();
      return;
    }
    report(slug, d);
    expectCoherentReadings(d);
    // scip did not participate here, so its columns are ABSENCE, not agreement.
    expect(d.scip).toBe(0);
    expect(d.scipOnly).toEqual([]);
    expect(d.scipNotCtags).toBe(0);
    expect(d.ctags).toBeGreaterThan(0);
    expect(d.ctagsRecall).toBeGreaterThanOrEqual(minCtagsRecall);
  });
});
