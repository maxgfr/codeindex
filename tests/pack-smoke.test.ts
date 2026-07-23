import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Proves the npm-library surface end to end, from the outside: a real
// `npm pack` tarball, extracted into a scratch node_modules/ and imported by
// a standalone Node process (so Node's real `exports` resolution runs, not a
// vitest/tsup shortcut), plus a real `tsc` run against the shipped `types`
// condition. Package.json's `files`/`exports`/`main`/`types` are the product
// under test here — not engine.mjs itself.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const FORBIDDEN_FILES = ["scripts/postbuild.mjs", "scripts/sync-version.mjs", "scripts/fetch-grammars.mjs"];

let tmp: string;
let packFiles: string[];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ci-pack-smoke-"));

  // 1. `npm pack` for real, from the repo root, into the scratch dir.
  const packOut = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const packResults = JSON.parse(packOut) as { filename: string; files: { path: string }[] }[];
  const packResult = packResults[0];
  if (!packResult) throw new Error("npm pack --json produced no output entries");
  packFiles = packResult.files.map((f) => f.path);
  const tarball = join(tmp, packResult.filename);

  // 2. Extract the tarball into a real node_modules/@maxgfr/codeindex, stripping
  // the `package/` prefix npm wraps every entry in.
  const pkgDir = join(tmp, "node_modules", "@maxgfr", "codeindex");
  mkdirSync(pkgDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", pkgDir, "--strip-components=1"]);

  writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
}, 60_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("npm pack contents", () => {
  it("includes the consumer-facing files", () => {
    expect(packFiles).toContain("scripts/engine.mjs");
    expect(packFiles).toContain("scripts/engine.d.mts");
    expect(packFiles).toContain("scripts/cli.mjs");
    expect(packFiles).toContain("docs/MIGRATION.md");
    expect(packFiles.some((f) => /^scripts\/grammars\/.*\.wasm$/.test(f))).toBe(true);
  });

  it("excludes maintainer-only scripts and any future bench/ tree", () => {
    for (const forbidden of FORBIDDEN_FILES) {
      expect(packFiles).not.toContain(forbidden);
    }
    expect(packFiles.some((f) => f.startsWith("scripts/bench/"))).toBe(false);
  });

  it("ships the embed tier CODE but NEVER a model asset (models stay out of the tarball)", () => {
    // The deterministic static-embedding tier ships as source (src/embed/*.ts).
    expect(packFiles.some((f) => /^src\/embed\/.*\.ts$/.test(f))).toBe(true);
    // …but no model weights/vocab/embeddings ever enter the package.
    const modelAsset = /(^|\/)(model\.json|embeddings\.bin|weights\.bin)$|\.(safetensors|onnx|gguf)$/;
    const offenders = packFiles.filter((f) => modelAsset.test(f));
    expect(offenders).toEqual([]);
  });
});

describe("Node resolution of the `exports` field", () => {
  it("resolves the root import and runs it in a standalone Node process", () => {
    const main = join(tmp, "main.mjs");
    writeFileSync(
      main,
      [
        'import { scanRepo, ENGINE_VERSION } from "@maxgfr/codeindex";',
        "",
        'if (typeof ENGINE_VERSION !== "string" || ENGINE_VERSION.length === 0) {',
        '  throw new Error("ENGINE_VERSION should be a non-empty string, got: " + ENGINE_VERSION);',
        "}",
        'if (typeof scanRepo !== "function") {',
        '  throw new Error("scanRepo should be a function, got: " + typeof scanRepo);',
        "}",
      ].join("\n"),
    );

    execFileSync(process.execPath, [main], { cwd: tmp, encoding: "utf8" });
  });
});

describe("the `types` condition", () => {
  it("type-checks a consumer importing the package with tsc", () => {
    const check = join(tmp, "check.ts");
    writeFileSync(
      check,
      [
        'import { scanRepo, ENGINE_VERSION } from "@maxgfr/codeindex";',
        "",
        "const version: string = ENGINE_VERSION;",
        "const scan: typeof scanRepo = scanRepo;",
        "void version;",
        "void scan;",
      ].join("\n"),
    );
    writeFileSync(
      join(tmp, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          moduleResolution: "bundler",
          module: "esnext",
          target: "esnext",
          noEmit: true,
          strict: true,
        },
      }),
    );

    // typescript is a devDependency of the repo; npx resolves its local `tsc`
    // by walking up from cwd (the repo root), while `-p` points tsc at the
    // scratch tsconfig/check.ts pair.
    execFileSync("npx", ["tsc", "-p", tmp], { cwd: REPO_ROOT, encoding: "utf8" });
  });
});
