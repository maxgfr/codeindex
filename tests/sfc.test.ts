import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sfcParts } from "../src/extract/sfc.js";
import { extractCode } from "../src/extract/code.js";
import { extractSymbols } from "../src/lang/registry.js";
import { grammarKeysForExts } from "../src/ast/loader.js";
import { familyOf } from "../src/calls.js";
import { scanRepo } from "../src/scan.js";
import { buildArtifactsFromScan } from "../src/pipeline.js";
import { findDeadCode } from "../src/deadcode.js";

// Vue, Svelte and Astro components classified as code but extracted nothing:
// no symbols, no imports, no calls. Every helper a component called read as
// dead code and no edge left a component. Their script is extracted as JS/TS
// now, over a copy of the file with the markup blanked (extract/sfc.ts).

const VUE = [
  "<template>", //                                   1
  "  <div @click=\"onClick\">{{ formatDate(when) }}</div>", // 2
  "</template>", //                                  3
  "", //                                             4
  '<script setup lang="ts" generic="T extends Record<string, unknown>">', // 5
  'import { ref } from "vue";', //                   6
  'import Child from "./Child.vue";', //             7
  'import { helper, formatDate } from "./util";', // 8
  "/** The message. */", //                          9
  'const msg = ref("hi");', //                       10
  "function onClick(e: MouseEvent): void {", //      11
  "  helper(e);", //                                 12
  "}", //                                            13
  "</script>", //                                    14
  "", //                                             15
  "<style scoped>", //                               16
  "div { color: rgba(0, 0, 0, 0.5); }", //           17
  "</style>", //                                     18
].join("\n");

describe("sfcParts", () => {
  it("keeps the script blocks at their own offsets and blanks the rest", () => {
    const parts = sfcParts(".vue", VUE)!;
    expect(parts.ext).toBe(".ts");
    expect(parts.script.length).toBe(VUE.length);
    const lines = parts.script.split("\n");
    expect(lines.length).toBe(VUE.split("\n").length);
    expect(lines[5]).toBe('import { ref } from "vue";');
    expect(lines[11]).toBe("  helper(e);");
    // Markup, tags and style are spaces, not gone.
    expect(lines[1]!.trim()).toBe("");
    expect(lines[4]!.trim()).toBe("");
    expect(lines[16]!.trim()).toBe("");
    // The markup is the complement: the template survives, script and style do not.
    const markup = parts.markup.split("\n");
    expect(parts.markup.length).toBe(VUE.length);
    expect(markup[1]).toContain("formatDate(when)");
    expect(markup[11]!.trim()).toBe("");
    expect(markup[16]!.trim()).toBe("");
  });

  it("reads the script language from `lang`, TS winning over JS", () => {
    expect(sfcParts(".vue", "<script>\nexport default {}\n</script>")!.ext).toBe(".js");
    expect(sfcParts(".vue", '<script lang="tsx">\n</script>')!.ext).toBe(".tsx");
    expect(sfcParts(".vue", "<script lang='jsx'>\n</script>")!.ext).toBe(".jsx");
    expect(sfcParts(".vue", '<script>\n</script>\n<script setup lang="ts">\n</script>')!.ext).toBe(".ts");
    expect(sfcParts(".svelte", "<script lang=ts>\n</script>")!.ext).toBe(".ts");
    // Astro's frontmatter is TypeScript by definition.
    expect(sfcParts(".astro", "---\nconst a = 1;\n---\n<p/>")!.ext).toBe(".ts");
    expect(sfcParts(".ts", "const a = 1;")).toBeUndefined();
  });

  it("skips data blocks, other languages, commented-out blocks and bodiless tags", () => {
    const src = [
      '<script type="application/ld+json">{"import": "x"}</script>',
      '<script lang="coffee">\nimport x from "./coffee"\n</script>',
      '<!-- <script>import y from "./commented"</script> -->',
      '<script src="./external.js" />',
      "<script>",
      'import z from "./real";',
      "</script>",
    ].join("\n");
    const script = sfcParts(".vue", src)!.script;
    expect(script).not.toContain("coffee");
    expect(script).not.toContain("commented");
    expect(script).not.toContain("ld+json");
    expect(script).toContain('import z from "./real";');
  });

  it("keeps Astro's frontmatter and its <script> tags, and nothing in between", () => {
    const src = ["---", 'import Card from "./Card.astro";', "const { title } = Astro.props;", "---", "<h1>{title}</h1>", "<script>", 'import "./client";', "</script>"];
    const kept = new Set([1, 2, 6]);
    expect(sfcParts(".astro", src.join("\n"))!.script.split("\n")).toEqual(
      src.map((line, i) => (kept.has(i) ? line : " ".repeat(line.length))),
    );
  });
});

describe("extractCode on single-file components", () => {
  it("extracts a Vue component's symbols, imports and calls at their real lines", () => {
    const info = extractCode("src/Comp.vue", ".vue", VUE);
    expect(info.symbols.map((s) => `${s.kind} ${s.name}@${s.line} ${s.lang}`)).toEqual([
      "const msg@10 vue",
      "function onClick@11 vue",
    ]);
    expect(info.symbols.find((s) => s.name === "msg")!.doc).toBe("The message.");
    expect(info.refs.map((r) => r.spec)).toEqual(["vue", "./Child.vue", "./util"]);
    // Script calls from the AST, template calls from the markup; CSS is not markup.
    expect(info.calls).toEqual([
      { name: "formatDate", line: 2 },
      { name: "helper", line: 12 },
      { name: "ref", line: 10 },
    ]);
    expect(info.importedNames).toEqual(["formatDate", "helper", "ref"]);
    // Import specifiers are modelled as refs, never as duplicated literals.
    expect(info.literals?.some((l) => l.value === "./util")).toBe(false);
  });

  it("gives the same symbols on the regex tier", () => {
    const parts = sfcParts(".vue", VUE)!;
    expect(extractSymbols("src/Comp.vue", parts.ext, parts.script).map((s) => `${s.name}@${s.line}`)).toEqual([
      "msg@10",
      "onClick@11",
    ]);
  });

  it("treats Svelte props and Astro frontmatter exports as not exported, a module script's as exported", () => {
    const svelte = [
      '<script context="module" lang="ts">',
      "export function preload(): void {}",
      "</script>",
      '<script lang="ts">',
      "  export let label: string;",
      "  export function focus(): void {}",
      "</script>",
      "<button>{label}</button>",
    ].join("\n");
    const exp = (rel: string, ext: string, src: string) =>
      Object.fromEntries(extractCode(rel, ext, src).symbols.map((s) => [s.name, s.exported]));
    expect(exp("B.svelte", ".svelte", svelte)).toEqual({ preload: true, label: false, focus: false });
    // Svelte 5 spells the module script with a bare attribute.
    expect(exp("B.svelte", ".svelte", "<script module>\nexport const x = 1;\n</script>")).toEqual({ x: true });
    const astro = "---\nexport interface Props { title: string }\nexport async function getStaticPaths() { return []; }\n---\n<h1/>";
    expect(exp("P.astro", ".astro", astro)).toMatchObject({ Props: false, getStaticPaths: false });
    // A Vue <script> block's named exports are real module exports.
    expect(exp("V.vue", ".vue", "<script>\nexport const shared = 1;\nexport default {}\n</script>")).toEqual({ shared: true });
  });

  it("warms the JS/TS grammars a component's script needs", () => {
    expect(grammarKeysForExts([".vue"])).toEqual(["javascript", "tsx", "typescript"]);
    expect(grammarKeysForExts([".astro"])).toEqual(["typescript"]);
  });

  it("binds component calls in the JS family", () => {
    for (const lang of ["vue", "svelte", "astro"]) expect(familyOf(lang)).toBe(familyOf("typescript"));
  });
});

describe("components in the graph", () => {
  function repo(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "ci-sfc-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  }

  it("draws import and call edges from components, and keeps their helpers alive", () => {
    const root = repo({
      "src/util.ts": "export function helper(x?: unknown) {}\nexport function formatDate(d?: unknown) { return d; }\nexport function unused() {}\n",
      "src/Comp.vue": VUE,
      "src/Child.vue": "<template><p/></template>\n",
      "src/Btn.svelte": '<script lang="ts">\n  import { helper } from "./util";\n  export let label: string;\n  function handle() { helper(); }\n</script>\n<button on:click={handle}>{label}</button>\n',
    });
    const scan = scanRepo(root);
    const { graph } = buildArtifactsFromScan(scan);
    expect(graph.fileEdges.map((e) => `${e.from} -${e.kind}-> ${e.to}`)).toEqual([
      "src/Btn.svelte -call-> src/util.ts",
      "src/Btn.svelte -import-> src/util.ts",
      "src/Comp.vue -import-> src/Child.vue",
      "src/Comp.vue -call-> src/util.ts",
      "src/Comp.vue -import-> src/util.ts",
    ]);
    // The helpers a component calls — from its script or its template — are
    // not dead; the one nothing calls still is, and a prop never is.
    expect(findDeadCode(scan).map((d) => `${d.name} ${d.tier}`)).toEqual(["unused unreferenced"]);
  });
});
