import { describe, expect, it } from "vitest";
import { gradeAnswer, pathsIn } from "./oracles/answers.js";

const runtime = await import(/* @vite-ignore */ new URL("../scripts/bench/answers.mjs", import.meta.url).href);

describe("live answer benchmark grading", () => {
  const known = new Set(["lib.ts", "app.ts", "other.ts"]);
  const question = { kind: "references", symbol: "Target", declaredIn: "lib.ts", referencedIn: ["app.ts"] };

  it("uses the exact same grader and path resolver as the oracle tests", () => {
    expect(runtime.gradeAnswer).toBe(gradeAnswer);
    expect(runtime.pathsIn).toBe(pathsIn);
  });

  it("excludes declaration paths identically for each reference response shape", () => {
    for (const text of [
      '{"declarations":[{"file":"lib.ts"}],"refs":[{"file":"app.ts"}]}',
      '[{"relative_path":"app.ts"}]',
    ]) expect(runtime.scoreResponse(question, text, known)).toMatchObject({ grade: "correct", precision: 1, recall: 1 });
  });

  it("does not score static fallback or disagreement as LSP references", () => {
    const text = JSON.stringify({ refs: [{ file: "other.ts" }], lsp: {
      ok: true, refs: [{ file: "app.ts" }], agreement: { both: [], lspOnly: ["app.ts"], staticOnly: ["other.ts"] },
    } });
    expect(runtime.scoreResponse(question, text, known, { lsp: true })).toMatchObject({
      grade: "correct", precision: 1, recall: 1, agreement: { staticOnly: ["other.ts"] },
    });
    expect(runtime.scoreResponse(question, '{"lsp":{"ok":false,"reason":"not configured"}}', known, { lsp: true }))
      .toEqual({ measured: false, reason: "not configured" });
  });

  it("preserves per-question agreement evidence in the machine-readable report", async () => {
    const { renderJson } = await import(/* @vite-ignore */ new URL("../scripts/bench/render.mjs", import.meta.url).href);
    const evidence = [{ symbol: "Target", agreement: { both: ["app.ts"], staticOnly: [] } }];
    const report = renderJson({ nominalRuns: 1, sections: [{ id: "answers", headers: [], rows: [], evidence }] }, { date: "test" });
    expect(report.sections[0].evidence).toEqual(evidence);
  });

  it("counts supported failed calls as empty and rejects vacuous measurements", async () => {
    expect(runtime.scoreResponse(question, "app.ts", known, { failed: true })).toMatchObject({ grade: "empty", precision: 0, recall: 0 });
    expect(await runtime.askAll("codeindex", "/unused", [], known)).toEqual({ ok: false, reason: "no compiler-derived questions" });
  });
});
