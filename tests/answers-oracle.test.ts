// The answer-quality corpus, and the grader that scores against it.
//
// Two halves with very different costs, deliberately separated:
//
//   * GENERATION is opt-in (CODEINDEX_ANSWERS=1). It clones pinned repos,
//     installs their dependencies and runs scip-typescript over them — minutes,
//     and a toolchain CI has no reason to carry. It writes
//     tests/quality/answer-cases.json, which is COMMITTED, exactly like
//     tests/quality/external-oracles.json.
//
//   * GRADING always runs. The grader decides every number in the benchmark
//     table, so a bug in it would silently flatter or damn all three tools at
//     once. It is pure, so there is no excuse for not testing it.
//
// The corpus also gets a standing check that codeindex itself answers it,
// because a benchmark this project can no longer pass is a benchmark this
// project would otherwise quietly stop running.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { casesFromPairs, referenceCasesFromOccurrences, mergeAnswerCorpora, gradeAnswer, gradeFiles, pathsIn, type AnswerCorpus } from "./oracles/answers.js";
import { findSymbol } from "../src/query.js";
import { scanRepo } from "../src/scan.js";

const CORPUS_PATH = fileURLToPath(new URL("./quality/answer-cases.json", import.meta.url));
const CACHE = fileURLToPath(new URL("./.e2e-cache/", import.meta.url));

describe("answer grading", () => {
  const known = new Set(["src/client.ts", "src/util.ts", "packages/app/src/test/gipGapFixtures.ts"]);

  it("separates a precise answer from a correct-but-buried one", () => {
    // Both found it. Only one of them saved the reader four files.
    expect(gradeAnswer("src/client.ts", ["src/client.ts"])).toBe("correct");
    expect(gradeAnswer("src/client.ts", ["src/util.ts", "src/client.ts"])).toBe("incomplete");
  });

  it("keeps saying nothing apart from saying something false", () => {
    // A tool that returns nothing costs a follow-up. One that returns the wrong
    // file costs a wrong edit, so the two must not share a bucket.
    expect(gradeAnswer("src/client.ts", [])).toBe("empty");
    expect(gradeAnswer("src/client.ts", ["src/util.ts"])).toBe("wrong");
  });

  it("resolves path prefixes only when the repository makes them unambiguous", () => {
    expect(pathsIn("/abs/repo/src/client.ts", known)).toEqual(["src/client.ts"]);
    expect(pathsIn("src/test/gipGapFixtures.ts", known)).toEqual(["packages/app/src/test/gipGapFixtures.ts"]);
    const ambiguous = new Set(["apps/a/src/index.ts", "apps/b/src/index.ts"]);
    expect(pathsIn("src/index.ts", ambiguous)).toEqual([]);
    expect(gradeAnswer("apps/a/src/index.ts", ["src/index.ts"])).toBe("wrong");
    expect(gradeAnswer("src/client.ts", ["src/client.ts", "src/client.ts"])).toBe("correct");
  });

  it("extracts paths shape-first, so the grader is not part of the comparison", () => {
    // Three servers, three JSON shapes. A per-server extractor would make the
    // grader a variable in the experiment.
    const serena = '{"relative_path": "src/client.ts", "body": "class HttpClient {}"}';
    const graphify = '{"node": {"file": "src/client.ts"}, "score": 0.9}';
    const codeindex = '[{"file":"src/client.ts","line":4,"kind":"class"}]';
    for (const text of [serena, graphify, codeindex]) {
      expect(pathsIn(text, known)).toEqual(["src/client.ts"]);
    }
    // A path the repo does not contain is not an answer — it is a version
    // number, a package name, or prose that happens to have a dot in it.
    expect(pathsIn("see react-dom@18.2.0 and lodash.merge", known)).toEqual([]);
  });

  it("recognizes framework route filenames without truncating bracket and dollar segments", () => {
    const routes = new Set(["app/[trpc]/route.ts", "routes/api/trpc.$.ts"]);
    expect(pathsIn(JSON.stringify([...routes]), routes)).toEqual([...routes].sort());
  });

  it("scores reference sets for precision and recall independently", () => {
    expect(gradeFiles(["a.ts", "b.ts"], ["a.ts", "extra.ts"])).toMatchObject({ grade: "incomplete", precision: 0.5, recall: 0.5 });
    expect(gradeFiles(["a.ts", "b.ts"], ["a.ts"])).toMatchObject({ grade: "incomplete", precision: 1, recall: 0.5 });
    expect(gradeFiles(["a.ts"], [])).toMatchObject({ grade: "empty", precision: 0, recall: 0 });
    expect(gradeFiles(["a.ts"], ["a.ts", "a.ts"])).toMatchObject({ grade: "correct", precision: 1, recall: 1 });
  });

  it("derives general references from symbol identity and excludes definitions and same-file uses", () => {
    const occurrence = (file: string, symbol: string, name: string, definition = false) => ({ file, symbol, name, definition });
    const occurrences = [
      occurrence("lib.ts", "id#Target", "Target", true),
      // A monorepo index can repeat a document in several TS projects.
      occurrence("lib.ts", "id#Target", "Target", true),
      occurrence("lib.ts", "id#Target", "Target"),
      occurrence("app.ts", "id#Target", "Target"),
      occurrence("app.ts", "id#Target", "Target"),
      occurrence("types.ts", "id#Target", "Target"),
      occurrence("false-positive.ts", "other#Target", "Target"),
      occurrence("a.ts", "id#Shared", "Shared", true),
      occurrence("b.ts", "other#Shared", "Shared", true),
    ];
    expect(referenceCasesFromOccurrences("fixture", occurrences)).toEqual([
      { repo: "fixture", kind: "references", symbol: "Target", declaredIn: "lib.ts", distractors: [], referencedIn: ["app.ts", "types.ts"] },
    ]);
    expect(referenceCasesFromOccurrences("fixture", [...occurrences].reverse())).toEqual(referenceCasesFromOccurrences("fixture", occurrences));
  });

  it("keeps only questions with exactly one right answer", () => {
    const cases = casesFromPairs("acme/thing", [
      { file: "src/a.ts", name: "OnlyHere" },
      // Declared twice — "correct" would depend on which one came back first,
      // so grading it would measure luck rather than quality.
      { file: "src/b.ts", name: "Ambiguous" },
      { file: "src/c.ts", name: "Ambiguous" },
      // Too short: `New` matches half a Go repo by substring, and a tool would
      // be graded correct for a coincidence.
      { file: "src/d.ts", name: "New" },
      // scip-typescript's module descriptor, not a declaration anyone searches.
      { file: "src/module.ts", name: "module" },
    ]);
    expect(cases.map((c) => c.symbol)).toEqual(["OnlyHere"]);
  });

  it("retains unselected compiler cases and their provenance during a bounded refresh", () => {
    const oldCase = { repo: "old", symbol: "OldSymbol", declaredIn: "old.ts", distractors: [] };
    const newCase = { repo: "new", symbol: "NewSymbol", declaredIn: "new.ts", distractors: [] };
    const previous: AnswerCorpus = { generatedAt: "before", tool: "compiler v1", cases: [oldCase], revisions: { old: "old-sha" } };
    const generated: AnswerCorpus = { generatedAt: "now", tool: "compiler v2", cases: [newCase], unavailable: [{ repo: "old", reason: "not selected" }] };
    const merged = mergeAnswerCorpora(previous, generated, ["new"]);
    expect(merged.cases).toEqual([oldCase, newCase]);
    expect(merged.provenance?.old).toEqual({ generatedAt: "before", tool: "compiler v1", revision: "old-sha", refreshed: false });
    expect(merged.provenance?.new?.refreshed).toBe(true);
    expect(merged.unavailable?.[0]?.reason).toContain("prior compiler cases retained");
    expect(mergeAnswerCorpora(previous, generated).cases).toEqual([newCase]);
  });

  it("selects deterministically, so the question set is a ratchet and not a sample", () => {
    const declarations = ["Zeta", "Alpha", "Middle"].map((name, i) => ({ file: `src/${i}.ts`, name }));
    expect(casesFromPairs("r", declarations, 2).map((c) => c.symbol)).toEqual(["Alpha", "Middle"]);
    // Same set, different input order — same questions. Sampling would not.
    expect(casesFromPairs("r", [...declarations].reverse(), 2).map((c) => c.symbol)).toEqual(["Alpha", "Middle"]);
  });
});

// Standing check: whatever the corpus says, this engine still answers it. A
// benchmark whose own author's tool has quietly regressed is worse than none.
describe.runIf(existsSync(CORPUS_PATH))("codeindex answers the committed corpus", () => {
  it("finds each symbol in the file the compiler says declares it", async (context) => {
    const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as AnswerCorpus;
    const bench = (await import(/* @vite-ignore */ new URL("../scripts/bench/repos.mjs", import.meta.url).href)) as unknown as {
      REPOS: { slug: string; sha: string }[];
      clonePinned: (repo: { slug: string }) => string;
    };
    const dirOf = new Map(bench.REPOS.map((r) => [r.slug, join(CACHE, `${r.slug.replace("/", "__")}@${r.sha.slice(0, 12)}`)]));

    const byRepo = new Map<string, typeof corpus.cases>();
    for (const c of corpus.cases.filter((c) => c.kind !== "references")) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c]);

    let measured = 0;
    for (const [slug, cases] of byRepo) {
      const base = dirOf.get(slug);
      // The pinned clone is not on this machine — the corpus stays portable,
      // the check simply has nothing to run against here.
      const repoDir = base && existsSync(base) ? base : undefined;
      if (!repoDir) {
        process.stderr.write(`answers: not measured ${slug} — pinned clone unavailable\n`);
        continue;
      }
      measured++;
      const scan = scanRepo(repoDir);
      const graded = cases.map((c) => gradeAnswer(c.declaredIn, findSymbol(scan, c.symbol).map((m) => m.file)));
      const wrong = graded.filter((g) => g === "wrong" || g === "empty").length;
      expect(wrong / graded.length, `${slug}: ${wrong}/${graded.length} missed`).toBeLessThanOrEqual(0.1);
    }
    if (!measured) context.skip("No pinned answer corpus clones available; not measured");
  }, 120_000);
});

// Opt-in: minutes, a network, and a toolchain. Writes the committed corpus.
describe.runIf(process.env.CODEINDEX_ANSWERS === "1")("answer corpus generation", () => {
  it("derives questions from scip-typescript and writes them", async () => {
    const { scipAnswerIndex, lastFailure } = await import("./oracles/external-diff.js");
    const bench = (await import(/* @vite-ignore */ new URL("../scripts/bench/repos.mjs", import.meta.url).href)) as unknown as {
      REPOS: { slug: string; lang: string }[];
      clonePinned: (repo: { slug: string }) => string;
    };
    const { REPOS, clonePinned } = bench;

    const cases: AnswerCorpus["cases"] = [];
    const unavailable: NonNullable<AnswerCorpus["unavailable"]> = [];
    const revisions: Record<string, string> = {};
    let version = "";
    const selected = process.env.CODEINDEX_ANSWERS_REPOS?.split(",");
    for (const repo of REPOS.filter((r) => r.lang === "typescript")) {
      if (selected && !selected.includes(repo.slug)) {
        unavailable.push({ repo: repo.slug, reason: "not selected for this bounded corpus generation" });
        continue;
      }
      const dir = clonePinned(repo);
      const index = scipAnswerIndex(dir);
      if (!index) {
        unavailable.push({ repo: repo.slug, reason: lastFailure() ?? "unknown" });
        // Named, not swallowed: a corpus silently missing a repo would make the
        // benchmark look narrower than it is for no stated reason.
        process.stderr.write(`answers: skipping ${repo.slug} — ${lastFailure() ?? "unknown"}\n`);
        continue;
      }
      // The SLUG, never `dir`: a corpus keyed on this machine's clone path
      // matches nothing anywhere else, which would make it look empty rather
      // than portable.
      version = index.version;
      const { execFileSync } = await import("node:child_process");
      revisions[repo.slug] = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      cases.push(...casesFromPairs(repo.slug, index.declarations), ...referenceCasesFromOccurrences(repo.slug, index.occurrences));
    }

    expect(cases.length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.kind === "references").length, "compiler corpus must contain measured reference questions").toBeGreaterThan(0);
    const previous = existsSync(CORPUS_PATH) ? JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as AnswerCorpus : undefined;
    const corpus = mergeAnswerCorpora(previous, { generatedAt: new Date().toISOString(), tool: `scip-typescript ${version}`, cases, unavailable, revisions }, selected);
    writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  }, 3_600_000);
});
