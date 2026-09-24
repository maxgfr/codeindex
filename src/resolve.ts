import { posix } from "node:path";
import { join } from "node:path";
import type { RepoScan } from "./scan.js";
import { readText } from "./walk.js";
import { byStr } from "./sort.js";

// Resolution outcome for a single ref. `external` ⇒ no edge (third-party,
// stdlib, URL, in-page anchor). `dangling` ⇒ an edge that points nowhere real
// (a local target that doesn't exist) — surfaced, never silently dropped.
export type Resolution =
  | { kind: "resolved"; target: string }
  | { kind: "external" }
  | { kind: "dangling"; reason: string };

interface TsPath {
  prefix: string; // text before a trailing "*", or the whole alias if exact
  star: boolean;
  targets: string[]; // path-relative-to-baseUrl, "*" preserved
}

// One tsconfig/jsconfig's alias scope. In a monorepo each package can declare its
// own baseUrl/paths, so we keep them per-config and resolve an import against the
// NEAREST enclosing config (deepest dir first) rather than a single root config.
interface TsConfigScope {
  dir: string; // the config's own directory (posix, "" = repo root) — scope test
  baseUrl: string; // repo-relative posix dir the `targets` resolve against
  // True only when the config (or its extends chain) DECLARES baseUrl: tsc then
  // also resolves a bare name (`components/Card`) against it. `paths` without
  // baseUrl (TS 4.1+) anchors the targets but gives bare names no such base.
  baseUrlSet: boolean;
  paths: TsPath[]; // tsc precedence order: exact aliases, then longest prefix
}

// One subpath of a package.json `exports` map, conditions already flattened into
// an ordered target list (source-ish conditions first, `types` last).
interface ExportEntry {
  key: string; // "." | "./utils" | "./features/*"
  star: boolean;
  targets: string[]; // pkg-dir-relative, "*" preserved in star entries
}

interface WorkspacePackage {
  name: string;
  dir: string; // posix dir of its package.json, "" for root
  exportEntries: ExportEntry[]; // empty when the package declares no `exports`
  mainCandidates: string[]; // source/main/module/types fields, priority order
  tsconfig?: string; // the `tsconfig` field — what `"extends": "<name>"` loads
}

// One package.json's scope for `#subpath` imports. Node resolves `#x` against
// the NEAREST package.json only (named or not), never a further-up one.
interface PackageScope {
  dir: string; // posix dir of the package.json, "" for root
  importEntries: ExportEntry[]; // its `imports` map; empty when it declares none
}

interface GoModule {
  module: string;
  dir: string; // posix dir of go.mod, "" for root
  replaces: { from: string; toDir: string }[]; // in-repo relative replaces only
}

interface RustCrate {
  name: string; // [package].name with "-" mapped to "_" (the in-code identifier)
  dir: string; // posix dir of Cargo.toml, "" for root
  srcDir: string; // dir/src
  rootFile?: string; // src/lib.rs or src/main.rs, whichever exists
}

export interface ResolveContext {
  fileSet: Set<string>;
  dirSet: Set<string>; // every directory that has any file beneath it
  filesByDir: Map<string, string[]>; // dir (posix, "" for root) -> rel files
  tsConfigs: TsConfigScope[]; // nearest-enclosing first (deepest dir wins)
  goModules: GoModule[]; // every in-repo go.mod, deepest dir first
  rustCrates: RustCrate[]; // every in-repo Cargo.toml [package], deepest dir first
  javaRoots: string[]; // dirs that java package paths resolve against
  pyRoots: string[]; // python import roots (sys.path entries), shortest first ("" allowed)
  workspacePackages: WorkspacePackage[]; // monorepo pkg name -> its dir + entry points
  packageScopes: PackageScope[]; // every package.json with its `imports` map, deepest dir first
  cIncludeRoots: string[]; // dirs a C/C++ `#include "x"` resolves against (besides the file's dir)
  rubyLibRoots: string[]; // dirs a Ruby bare `require` resolves against
  phpPsr4: { prefix: string; dir: string }[]; // composer PSR-4 namespace prefix -> dir, longest first
  csharpNamespaces: Map<string, string[]>; // C# namespace -> files declaring it (sorted)
  warnings: string[]; // build-time config issues (e.g. an unparseable tsconfig)
  // Memo of JS/TS resolutions keyed by "<importing dir>\0<spec>" — resolveJs is
  // a pure function of those two (its tsconfig scope, workspace and probe
  // logic only ever look at the importer's DIRECTORY), and a package's files
  // import the same handful of specifiers over and over. Each hit skips ~20
  // normalize+probe rounds. Optional so a hand-built context still works.
  jsMemo?: Map<string, Resolution>;
  // The same memo for Python, same key: resolvePython also only reads the
  // importer's directory (relative base, enclosing roots).
  pyMemo?: Map<string, Resolution>;
  // Per-directory sorted file lists by extension ("<ext>\0<dir>"), for the
  // Go-package / Java-wildcard "first file in the directory" rule.
  dirFilesMemo?: Map<string, string[]>;
}

// Files of `dir` ending in `ext`, sorted — computed once per (ext, dir).
function filesInDir(ctx: ResolveContext, dir: string, ext: string): string[] {
  const memo = (ctx.dirFilesMemo ??= new Map());
  const key = ext + "\0" + dir;
  let list = memo.get(key);
  if (!list) memo.set(key, (list = (ctx.filesByDir.get(dir) ?? []).filter((f) => f.endsWith(ext)).sort()));
  return list;
}

// Extensions walk() skips (images, fonts, media, maps). An import of one of these
// is a real asset dependency handled by a bundler — NOT a broken code edge — so
// it resolves as `external`, never dangling.
const ASSET_EXT = new Set([
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi", ".webm",
  ".wav", ".flac", ".ogg", ".map",
]);

// Extensionless-import probe order. `.ts` before `.tsx` is deliberate (it
// mirrors tsc's own resolution order, and pinned output bytes depend on it) —
// when both `x.ts` and `x.tsx` exist, the plain `.ts` module wins; do NOT
// reorder. The SFC/HTML candidates (.vue/.svelte/.astro/.html/.htm) sit AFTER
// every JS-family extension so they only match when no JS/TS source does —
// appending keeps every pre-existing resolution byte-identical.
const JS_EXT_PROBES = [
  "", ".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".vue", ".svelte", ".astro", ".html", ".htm",
];
const JS_INDEX = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs"];
const JS_TS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
// SFC/HTML importers: a .vue/.svelte/.astro/.html/.htm file's <script> block
// carries ordinary ES imports, so those files resolve through the JS-family
// path exactly like a .tsx file — not through the external/dangling fallback.
const SFC_HTML = new Set([".vue", ".svelte", ".astro", ".html", ".htm"]);
const PY = new Set([".py", ".pyi"]);
const C_CPP = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"]);

// Directory names that hold build output. An exports-map target under one of
// these usually has its source under `src/` (or at the package root) instead.
const BUILD_DIRS = new Set(["dist", "build", "lib", "out", "output", "esm", "cjs", "umd"]);

// "./dist/esm/index.js" → ["src/esm/index.js", "esm/index.js", "src/index.js",
// "index.js"] — peel leading build dirs one at a time, trying both a `src/`
// substitute and a plain drop at each step.
function distToSrcCandidates(target: string): string[] {
  const segs = norm(target).split("/").filter((s) => s !== ".");
  const out: string[] = [];
  let i = 0;
  while (i < segs.length - 1 && BUILD_DIRS.has(segs[i]!)) {
    i++;
    const rest = segs.slice(i).join("/");
    out.push("src/" + rest, rest);
  }
  return out;
}

function norm(p: string): string {
  // posix.normalize keeps ".." that escape the root as a leading "../"; callers
  // treat an escaping path as unresolved.
  return posix.normalize(p).replace(/\/$/, "");
}

function firstThat(fileSet: Set<string>, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const n = norm(c);
    if (fileSet.has(n)) return n;
  }
  return undefined;
}

function byLen(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function tolerantJsonParse(text: string): unknown {
  // tsconfig.json is JSONC: strip // and /* */ comments and trailing commas. This
  // MUST be string-aware — tsconfig glob values like "**/*.ts" or
  // "./src/styled-system/*" contain `/*`, `*/` and `//` that a naive regex
  // stripper mistakes for comment delimiters and shreds the document (a real
  // failure on Next.js tsconfigs that mix a `…/*` path alias with `**/*.ts`
  // includes). So scan char-by-char and only strip comments OUTSIDE strings.
  let stripped = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      stripped += c;
      if (c === "\\") stripped += text[++i] ?? ""; // keep the escaped char verbatim
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      stripped += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      stripped += "\n"; // preserve line structure
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip the closing '/'
    } else {
      stripped += c;
    }
  }
  // Drop trailing commas (a `,` right before a `}` or `]`) — also string-aware,
  // so a path glob value that literally contains `,}` or `,]` is left intact.
  let out = "";
  inStr = false;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") out += stripped[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < stripped.length && (stripped[j] === " " || stripped[j] === "\t" || stripped[j] === "\n" || stripped[j] === "\r")) j++;
      if (stripped[j] === "}" || stripped[j] === "]") continue; // trailing comma → drop
    }
    out += c;
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

// Resolve a tsconfig `extends` target to an in-repo config path, or undefined for
// a package specifier (a node_modules base we don't index) or a missing file.
// A bare non-relative target ("base.json", written without the "./" prefix —
// tsc accepts it) is probed relative to the config's own directory too; only
// when no such file exists is it treated as a package base, so a true package
// extends like "@tsconfig/node18" stays external.
//
// A package base can still be IN the repo: Turborepo's layout is a
// `packages/typescript-config` workspace named `@repo/typescript-config` that
// apps extend as "@repo/typescript-config/base.json". tsc resolves that like a
// module, so we do too against the workspace packages: `<name>` loads the
// package's `tsconfig` field or its tsconfig.json, `<name>/<sub>` loads
// <sub>(.json) or <sub>/tsconfig.json inside it.
function resolveExtends(
  fileSet: Set<string>,
  fromDir: string,
  ext: string,
  packages: WorkspacePackage[],
): string | undefined {
  const base = norm(posix.join(fromDir, ext));
  const cands = ext.endsWith(".json") ? [base] : [base + ".json", posix.join(base, "tsconfig.json")];
  for (const c of cands) if (fileSet.has(c)) return c;
  if (ext.startsWith(".") || ext.startsWith("/")) return undefined;
  for (const pkg of packages) {
    let pkgCands: string[];
    if (ext === pkg.name) {
      pkgCands = [...(pkg.tsconfig ? [pkg.tsconfig] : []), "tsconfig.json"];
    } else if (ext.startsWith(pkg.name + "/")) {
      const sub = ext.slice(pkg.name.length + 1);
      pkgCands = sub.endsWith(".json") ? [sub] : [sub + ".json", posix.join(sub, "tsconfig.json")];
    } else continue;
    for (const c of pkgCands) {
      const p = norm(posix.join(pkg.dir, c));
      if (!p.startsWith("..") && fileSet.has(p)) return p;
    }
    return undefined; // the longest matching package name owns the specifier
  }
  return undefined;
}

interface TsEffective {
  baseUrl?: string; // as written, relative to baseUrlDir (a `${configDir}` prefix kept verbatim)
  baseUrlDir: string; // dir of the config that DECLARED baseUrl
  paths?: Record<string, string[]>; // targets as written, `${configDir}` kept verbatim
  pathsDir: string; // dir of the config that DECLARED paths
}

// The TS 5.5 `${configDir}` template: a path starting with it is relative to
// the config being COMPILED — the leaf that extends a shared base — not to the
// base that wrote it. That is its whole point: one shared base serving many
// projects. So it is carried verbatim through the extends fold and substituted
// per leaf.
const CONFIG_DIR = "${configDir}";

// Read a tsconfig/jsconfig and fold in its `extends` chain (in-repo bases only:
// relative files or workspace packages), child overriding base — so a monorepo
// package whose baseUrl/paths live in a shared base (the dominant
// Nx/Turborepo/lerna layout) still contributes its aliases. baseUrl and paths
// are each tracked with the dir of the config that DECLARED them (TS resolves
// them relative to that file, `${configDir}` aside). Cycles are broken via
// `seen`; a missing relative base is surfaced as a warning.
function readTsConfig(
  root: string,
  fileSet: Set<string>,
  rel: string,
  warnings: string[],
  seen: Set<string>,
  packages: WorkspacePackage[],
): TsEffective | undefined {
  if (seen.has(rel)) return undefined;
  seen.add(rel);
  const cfg = tolerantJsonParse(readText(join(root, rel))) as
    | { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }; extends?: string | string[] }
    | undefined;
  if (cfg === undefined) {
    warnings.push(`unparseable ${rel} — its path aliases were ignored`);
    return undefined;
  }
  const dir = rel.includes("/") ? posix.dirname(rel) : "";
  const eff: TsEffective = { baseUrlDir: "", pathsDir: "" };
  const exts = cfg.extends === undefined ? [] : Array.isArray(cfg.extends) ? cfg.extends : [cfg.extends];
  for (const ext of exts) {
    if (typeof ext !== "string") continue;
    const baseRel = resolveExtends(fileSet, dir, ext, packages);
    if (!baseRel) {
      if (/^\.\.?\//.test(ext)) warnings.push(`${rel} extends "${ext}" which is missing — its path aliases were ignored`);
      continue; // bare specifiers (node_modules tooling bases) carry no repo paths
    }
    const inherited = readTsConfig(root, fileSet, baseRel, warnings, seen, packages);
    if (inherited?.baseUrl !== undefined) {
      eff.baseUrl = inherited.baseUrl;
      eff.baseUrlDir = inherited.baseUrlDir;
    }
    if (inherited?.paths) {
      eff.paths = inherited.paths;
      eff.pathsDir = inherited.pathsDir;
    }
  }
  const co = cfg.compilerOptions;
  if (typeof co?.baseUrl === "string") {
    eff.baseUrl = co.baseUrl;
    eff.baseUrlDir = dir;
  }
  if (co?.paths) {
    eff.paths = co.paths;
    eff.pathsDir = dir;
  }
  return eff;
}

// Conditions ordered by how likely they are to point at committed source rather
// than build output. `types` goes dead last: a stray .d.ts is a worse node than
// any runtime entry. Unknown conditions (browser, deno, …) sit in between.
const CONDITION_PRIORITY = ["source", "ts", "import", "module", "require", "node", "default"];
const MAX_EXPORT_TARGETS = 8; // cap leaves per subpath — exports maps can be deep

function conditionRank(key: string): number {
  const i = CONDITION_PRIORITY.indexOf(key);
  if (i !== -1) return i;
  return key === "types" ? CONDITION_PRIORITY.length + 1 : CONDITION_PRIORITY.length;
}

// Flatten one subpath's value (string | array | nested conditions object) into an
// ordered candidate list. We collect EVERY string leaf rather than picking one
// condition: an indexer wants "the first candidate that exists in the repo", not
// Node's single runtime answer.
function flattenExportTargets(value: unknown, out: string[]): void {
  if (out.length >= MAX_EXPORT_TARGETS) return;
  if (typeof value === "string") {
    if (!out.includes(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) flattenExportTargets(v, out);
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => conditionRank(a) - conditionRank(b) || (a < b ? -1 : a > b ? 1 : 0));
    for (const k of keys) flattenExportTargets((value as Record<string, unknown>)[k], out);
  }
}

// Parse a package.json `exports` field into ordered entries: exact keys before
// wildcard keys, longer keys first (Node's pattern precedence, simplified).
function parseExportEntries(exportsField: unknown): ExportEntry[] {
  if (exportsField === undefined || exportsField === null) return [];
  const entries: ExportEntry[] = [];
  const push = (key: string, value: unknown) => {
    const targets: string[] = [];
    flattenExportTargets(value, targets);
    if (targets.length) entries.push({ key, star: key.includes("*"), targets });
  };
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    push(".", exportsField);
  } else if (typeof exportsField === "object") {
    const keys = Object.keys(exportsField);
    if (keys.every((k) => k === "." || k.startsWith("./"))) {
      for (const k of keys) push(k, (exportsField as Record<string, unknown>)[k]);
    } else {
      // A bare conditions object ({"import": …, "require": …}) describes ".".
      push(".", exportsField);
    }
  }
  entries.sort((a, b) => Number(a.star) - Number(b.star) || b.key.length - a.key.length || (a.key < b.key ? -1 : 1));
  return entries;
}

// Parse a package.json `imports` field (`"#internal/*": "./src/lib/*.ts"`) into
// the same ordered entries as `exports` — same value grammar, same precedence;
// only the keys differ (`#…` instead of `./…`).
function parseImportEntries(importsField: unknown): ExportEntry[] {
  if (importsField === null || typeof importsField !== "object" || Array.isArray(importsField)) return [];
  const entries: ExportEntry[] = [];
  for (const [key, value] of Object.entries(importsField)) {
    if (!key.startsWith("#")) continue;
    const targets: string[] = [];
    flattenExportTargets(value, targets);
    if (targets.length) entries.push({ key, star: key.includes("*"), targets });
  }
  entries.sort((a, b) => Number(a.star) - Number(b.star) || b.key.length - a.key.length || byStr(a.key, b.key));
  return entries;
}

// The targets of the first entry matching `key` (entries are already in
// precedence order), with a wildcard entry's `*` filled in; undefined when no
// entry matches. Shared by `exports` subpaths and `imports` specifiers.
function matchEntryTargets(entries: ExportEntry[], key: string): string[] | undefined {
  for (const entry of entries) {
    if (!entry.star) {
      if (entry.key === key) return entry.targets;
      continue;
    }
    const starAt = entry.key.indexOf("*");
    const pre = entry.key.slice(0, starAt);
    const post = entry.key.slice(starAt + 1);
    if (!key.startsWith(pre) || !key.endsWith(post) || key.length < pre.length + post.length) continue;
    const fill = key.slice(pre.length, key.length - post.length);
    return entry.targets.map((t) => t.replace(/\*/g, fill));
  }
  return undefined;
}

// Parse a go.mod's `replace` directives (single-line and block form), keeping
// only relative targets that stay inside the repo — those are the directives
// that rewire one in-repo module onto another's source tree.
function parseGoReplaces(text: string, modDir: string): { from: string; toDir: string }[] {
  const out: { from: string; toDir: string }[] = [];
  const addLine = (line: string) => {
    const m = /^\s*([^\s=]+)(?:\s+v\S+)?\s*=>\s*(\S+)(?:\s+v\S+)?\s*$/.exec(line);
    if (!m) return;
    const target = m[2]!;
    if (!/^\.\.?\//.test(target)) return; // a module-path replacement, not a local dir
    const toDir = norm(posix.join(modDir, target));
    if (toDir.startsWith("..")) return; // escapes the repo — nothing to link to
    out.push({ from: m[1]!, toDir });
  };
  for (const m of text.matchAll(/^[ \t]*replace[ \t]+([^(\r\n][^\r\n]*)$/gm)) addLine(m[1]!);
  for (const b of text.matchAll(/^[ \t]*replace[ \t]*\(([\s\S]*?)\)/gm)) {
    for (const line of b[1]!.split(/\r?\n/)) addLine(line);
  }
  return out;
}

// Build the repo-wide context resolution needs: the file set, a dir→files index,
// tsconfig path aliases, the go module paths, and python roots. Read once.
export function buildResolveContext(scan: RepoScan): ResolveContext {
  const fileSet = new Set(scan.files.map((f) => f.rel));
  const filesByDir = new Map<string, string[]>();
  const dirSet = new Set<string>();
  for (const f of scan.files) {
    const dir = f.rel.includes("/") ? posix.dirname(f.rel) : "";
    let list = filesByDir.get(dir);
    if (!list) filesByDir.set(dir, (list = []));
    list.push(f.rel);
    // Record every ancestor directory so a doc link to a real folder (even one
    // with no README) isn't mistaken for a broken link.
    let d = dir;
    while (d) {
      if (dirSet.has(d)) break;
      dirSet.add(d);
      d = d.includes("/") ? posix.dirname(d) : "";
    }
  }

  // Workspace packages: map each in-repo package.json `name` to its directory so
  // bare cross-package imports (`@scope/pkg`) resolve to in-repo source, not
  // "external". Longest name first so `@scope/a-b` wins over `@scope/a`. Also
  // keep its `exports` map and main-ish fields — modern monorepo packages route
  // subpath imports (`@scope/pkg/utils`) through `exports`, and probing those
  // declared entry points beats guessing `src/index`. Parsed BEFORE tsconfigs:
  // a tsconfig may `extends` a config shipped by one of these packages.
  const warnings: string[] = [];
  const pkgWarnings: string[] = []; // appended after the tsconfig ones (their historic order)
  const workspacePackages: WorkspacePackage[] = [];
  const packageScopes: PackageScope[] = [];
  for (const rel of fileSet) {
    if (rel !== "package.json" && !rel.endsWith("/package.json")) continue;
    // Parse with the same JSONC-tolerant path as tsconfig (some package.json carry
    // comments/trailing commas); a truly unparseable one is surfaced, not silently
    // dropped — losing it erases every cross-package edge for that workspace.
    const pkg = tolerantJsonParse(readText(join(scan.root, rel))) as
      | {
          name?: string;
          exports?: unknown;
          imports?: unknown;
          source?: unknown;
          main?: unknown;
          module?: unknown;
          types?: unknown;
          tsconfig?: unknown;
        }
      | undefined;
    if (pkg === undefined) {
      pkgWarnings.push(`unparseable ${rel} — skipped for workspace resolution`);
      continue;
    }
    const dir = rel.includes("/") ? posix.dirname(rel) : "";
    // Every package.json bounds a `#subpath` scope, named or not.
    packageScopes.push({ dir, importEntries: parseImportEntries(pkg.imports) });
    if (typeof pkg.name !== "string") continue;
    const mainCandidates = [pkg.source, pkg.main, pkg.module, pkg.types].filter(
      (v): v is string => typeof v === "string",
    );
    workspacePackages.push({
      name: pkg.name,
      dir,
      exportEntries: parseExportEntries(pkg.exports),
      mainCandidates,
      ...(typeof pkg.tsconfig === "string" ? { tsconfig: pkg.tsconfig } : {}),
    });
  }
  workspacePackages.sort((a, b) => b.name.length - a.name.length);
  packageScopes.sort((a, b) => b.dir.length - a.dir.length || byStr(a.dir, b.dir));

  // tsconfig/jsconfig path aliases. Collect EVERY config, not just the root one
  // (each monorepo package declares its own baseUrl/paths), and fold in each
  // config's `extends` chain so aliases declared in a shared base config still
  // resolve. An import resolves against the nearest enclosing config. Unparseable
  // or missing configs surface as build warnings rather than vanishing silently.
  const tsConfigs: TsConfigScope[] = [];
  for (const rel of fileSet) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    // Nx-style repos often have NO root tsconfig.json — only a tsconfig.base.json
    // that per-project configs extend. Accept it as a root-scope config so its
    // `@org/*` aliases resolve even for files outside any per-project config.
    // Root only: a nested tsconfig.base.json is always reached via `extends`.
    const isRootBase = rel === "tsconfig.base.json";
    if (base !== "tsconfig.json" && base !== "jsconfig.json" && !isRootBase) continue;
    const dir = rel.includes("/") ? posix.dirname(rel) : "";
    const eff = readTsConfig(scan.root, fileSet, rel, warnings, new Set<string>(), workspacePackages);
    // A config contributes when it declares aliases OR a baseUrl: CRA/Next.js
    // style `"baseUrl": "src"` with no `paths` is how `import "components/Card"`
    // resolves, and dropping it lost every such import without a trace.
    if (!eff || (!eff.paths && eff.baseUrl === undefined)) continue;
    // `paths` resolve against baseUrl when set (relative to the config that
    // declared baseUrl), else relative to the config that declared `paths`.
    const baseUrl =
      eff.baseUrl === undefined
        ? eff.pathsDir
        : eff.baseUrl.startsWith(CONFIG_DIR)
          ? norm(posix.join(dir, eff.baseUrl.slice(CONFIG_DIR.length))).replace(/^\.$/, "")
          : norm(posix.join(eff.baseUrlDir, eff.baseUrl)).replace(/^\.$/, "");
    // A `${configDir}` target is this leaf's dir, re-expressed relative to
    // baseUrl so resolveJs keeps joining every target the same way.
    const fromBase = posix.relative(baseUrl, dir) || ".";
    const tsPaths: TsPath[] = [];
    for (const [alias, targets] of Object.entries(eff.paths ?? {})) {
      if (!Array.isArray(targets)) continue;
      const star = alias.endsWith("*");
      tsPaths.push({
        prefix: star ? alias.slice(0, -1) : alias,
        star,
        targets: targets
          .filter((t): t is string => typeof t === "string")
          .map((t) => (t.startsWith(CONFIG_DIR) ? posix.join(fromBase, t.slice(CONFIG_DIR.length)) : t)),
      });
    }
    // tsc's precedence, not object order: an exact alias beats any pattern, and
    // among patterns the longest prefix wins (findBestPatternMatch). First-match
    // in declaration order sent "@/components/Button" to "@/*" whenever that
    // broader pattern happened to be listed first.
    tsPaths.sort(
      (a, b) => Number(a.star) - Number(b.star) || b.prefix.length - a.prefix.length || byStr(a.prefix, b.prefix),
    );
    if (!tsPaths.length && eff.baseUrl === undefined) continue; // nothing affects resolution
    tsConfigs.push({ dir, baseUrl, baseUrlSet: eff.baseUrl !== undefined, paths: tsPaths });
  }
  // Nearest-enclosing first: deepest dir wins; the root ("") is the fallback.
  tsConfigs.sort((a, b) => b.dir.length - a.dir.length);
  warnings.push(...pkgWarnings);

  // Every go.mod, not just the one nearest the root — multi-module repos (a Go
  // service beside a Go CLI) are normal. Deepest dir first so the module
  // enclosing an importing file is found by a simple scan.
  const goModules: GoModule[] = [];
  for (const rel of fileSet) {
    if (rel !== "go.mod" && !rel.endsWith("/go.mod")) continue;
    const text = readText(join(scan.root, rel));
    const m = /^\s*module\s+(\S+)/m.exec(text);
    if (!m) continue;
    const dir = rel.includes("/") ? posix.dirname(rel) : "";
    goModules.push({ module: m[1]!, dir, replaces: parseGoReplaces(text, dir) });
  }
  goModules.sort((a, b) => b.dir.length - a.dir.length || (a.dir < b.dir ? -1 : 1));

  // Rust crates: every Cargo.toml with a [package] section. The crate's in-code
  // name maps "-" to "_" (cargo's identifier rule); deepest dir first so the
  // crate enclosing an importing file is found by a simple scan.
  const rustCrates: RustCrate[] = [];
  for (const rel of fileSet) {
    if (rel !== "Cargo.toml" && !rel.endsWith("/Cargo.toml")) continue;
    const text = readText(join(scan.root, rel));
    // [package] name = "x" — section-scoped so a [dependencies] entry named
    // `name` can't masquerade as the crate name.
    const m = /\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms.exec(text);
    if (!m) continue; // a virtual workspace manifest — no crate of its own
    const dir = rel.includes("/") ? posix.dirname(rel) : "";
    const srcDir = norm(posix.join(dir, "src")).replace(/^\.$/, "");
    const rootFile = firstThat(fileSet, [posix.join(srcDir, "lib.rs"), posix.join(srcDir, "main.rs")]);
    rustCrates.push({ name: m[1]!.replace(/-/g, "_"), dir, srcDir, rootFile });
  }
  rustCrates.sort((a, b) => b.dir.length - a.dir.length || (a.dir < b.dir ? -1 : 1));

  // Java source roots: a file at X/com/a/b/C.java declaring `package com.a.b`
  // anchors X as a root — covers src/main/java, Maven/Gradle multi-module, any
  // layout, with zero extra file reads (the package came along with the scan).
  const javaRoots = new Set<string>();
  for (const f of scan.files) {
    if (f.ext !== ".java" || !f.pkg) continue;
    const dir = f.rel.includes("/") ? posix.dirname(f.rel) : "";
    const pkgPath = f.pkg.replace(/\./g, "/");
    if (dir === pkgPath) javaRoots.add("");
    else if (dir.endsWith("/" + pkgPath)) javaRoots.add(dir.slice(0, -pkgPath.length - 1));
  }

  // Python import roots: the sys.path entries an absolute `import a.b` resolves
  // against. A package dir is NOT one — Python 3 has no implicit relative
  // imports, and treating `src/flask/` as a root bound the stdlib's
  // `import typing` to src/flask/typing.py (and every other stdlib name to a
  // same-named package module), while never adding the `src/` that `import
  // flask` actually needs. The roots are, as mypy's crawl-up finds them:
  //  - the repo root;
  //  - the dir holding a TOP-LEVEL package: a dir with __init__.py whose parent
  //    has none and sits inside no regular package (`src/` in a src layout,
  //    `lib/` in ansible's);
  //  - every pyproject.toml / setup.py / setup.cfg dir, and its `src/` if any
  //    (src-layout single modules and namespace packages have no __init__.py to
  //    anchor on).
  // Known gap, shared with mypy: a PEP 420 namespace dir (`google/cloud/`, no
  // __init__.py) looks like a root too, so a stdlib-named package under it
  // (`google/cloud/logging/`) still captures `import logging`.
  const pyPkgDirs = new Set<string>();
  const pyRootSet = new Set<string>([""]);
  for (const rel of fileSet) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    const dir = rel.includes("/") ? posix.dirname(rel) : "";
    if (base === "__init__.py" || base === "__init__.pyi") pyPkgDirs.add(dir);
    else if (base === "pyproject.toml" || base === "setup.py" || base === "setup.cfg") {
      pyRootSet.add(dir);
      const src = dir ? dir + "/src" : "src";
      if (dirSet.has(src)) pyRootSet.add(src);
    }
  }
  for (const pkgDir of pyPkgDirs) {
    if (!pkgDir) continue; // a package AT the repo root: nothing above it to hold it
    const parent = pkgDir.includes("/") ? posix.dirname(pkgDir) : "";
    let inPackage = false;
    for (let d = parent; d && !inPackage; d = d.includes("/") ? posix.dirname(d) : "") inPackage = pyPkgDirs.has(d);
    if (!inPackage) pyRootSet.add(parent);
  }

  // C/C++ include roots: dirs literally named include/inc, plus the repo root, so
  // `#include "a/b.h"` resolves whether written relative to the file or to a root.
  const cIncludeRoots = new Set<string>([""]);
  for (const d of dirSet) {
    const base = d.slice(d.lastIndexOf("/") + 1);
    if (base === "include" || base === "inc" || base === "src") cIncludeRoots.add(d);
  }

  // Ruby lib roots: dirs named lib, plus the repo root, for bare `require`.
  const rubyLibRoots = new Set<string>([""]);
  for (const d of dirSet) if (d.slice(d.lastIndexOf("/") + 1) === "lib") rubyLibRoots.add(d);

  // PHP PSR-4: every composer.json's autoload(+autoload-dev).psr-4 maps a
  // namespace prefix onto a directory (relative to the composer.json). Longest
  // prefix first so a more specific mapping wins.
  const phpPsr4: { prefix: string; dir: string }[] = [];
  for (const rel of fileSet) {
    if (rel !== "composer.json" && !rel.endsWith("/composer.json")) continue;
    const composer = tolerantJsonParse(readText(join(scan.root, rel))) as
      | { autoload?: { "psr-4"?: Record<string, string | string[]> }; "autoload-dev"?: { "psr-4"?: Record<string, string | string[]> } }
      | undefined;
    if (!composer) {
      warnings.push(`unparseable ${rel} — skipped for PHP PSR-4 resolution`);
      continue;
    }
    const baseDir = rel.includes("/") ? posix.dirname(rel) : "";
    for (const block of [composer.autoload?.["psr-4"], composer["autoload-dev"]?.["psr-4"]]) {
      if (!block) continue;
      for (const [prefix, dirs] of Object.entries(block)) {
        for (const d of Array.isArray(dirs) ? dirs : [dirs]) {
          if (typeof d !== "string") continue;
          phpPsr4.push({ prefix: prefix.replace(/\\+$/, ""), dir: norm(posix.join(baseDir, d)).replace(/^\.$/, "") });
        }
      }
    }
  }
  phpPsr4.sort((a, b) => b.prefix.length - a.prefix.length);

  // C# namespaces: file's `namespace X.Y` (captured as pkg) → the files declaring
  // it, so `using X.Y;` resolves to in-repo source (Java's model, applied to C#).
  const csharpNamespaces = new Map<string, string[]>();
  for (const f of scan.files) {
    if (f.ext !== ".cs" || !f.pkg) continue;
    let arr = csharpNamespaces.get(f.pkg);
    if (!arr) csharpNamespaces.set(f.pkg, (arr = []));
    arr.push(f.rel);
  }
  for (const arr of csharpNamespaces.values()) arr.sort(byStr);

  return {
    fileSet,
    dirSet,
    filesByDir,
    tsConfigs,
    goModules,
    rustCrates,
    javaRoots: [...javaRoots].sort(byLen),
    pyRoots: [...pyRootSet].sort(byLen),
    workspacePackages,
    packageScopes,
    cIncludeRoots: [...cIncludeRoots].sort(byLen),
    rubyLibRoots: [...rubyLibRoots].sort(byLen),
    phpPsr4,
    csharpNamespaces,
    warnings,
  };
}

function firstExisting(ctx: ResolveContext, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const n = norm(c);
    if (n && !n.startsWith("..") && ctx.fileSet.has(n)) return n;
  }
  return undefined;
}

// Markdown relative link → a real file. Strips anchors/queries; probes .md/.mdx
// and directory README/index. External/anchor targets return `external`.
export function resolveDocLink(fromRel: string, spec: string, ctx: ResolveContext): Resolution {
  let target = spec.split("#")[0]!.split("?")[0]!;
  if (!target) return { kind: "external" }; // pure in-page anchor
  if (target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target)) return { kind: "external" };
  // A leading "/" is repo-root-relative — how GitHub/GitLab render
  // `[bench](/BENCHMARKS.md)` — not relative to the linking file's dir.
  const rooted = target.startsWith("/");
  const base = rooted || !fromRel.includes("/") ? "" : posix.dirname(fromRel);
  let p = norm(posix.join(base, rooted ? target.slice(1) : target));
  if (p === ".") p = ""; // the repo root itself (`/`, or `./` from a root doc)
  if (p.startsWith("..")) return { kind: "dangling", reason: "escapes-repo-root" };
  const hit = firstExisting(ctx, [
    p, p + ".md", p + ".mdx",
    posix.join(p, "README.md"), posix.join(p, "readme.md"),
    posix.join(p, "index.md"), posix.join(p, "index.mdx"),
  ]);
  if (hit) return { kind: "resolved", target: hit };
  // A link to a real directory (even one without a README/index) is valid — it's
  // just not a file-node edge. Don't cry "broken link".
  if (!p || ctx.dirSet.has(p)) return { kind: "external" };
  return { kind: "dangling", reason: "missing-target" };
}

function resolveJs(fromRel: string, rawSpec: string, ctx: ResolveContext): Resolution {
  const probe = (p: string): string | undefined =>
    firstExisting(ctx, [...JS_EXT_PROBES.map((e) => p + e), ...JS_INDEX.map((i) => posix.join(p, i))]);
  // TS/NodeNext style writes `import "./x.js"` for a source file `x.ts` — so if a
  // direct probe misses, retry with the JS-ish extension stripped.
  const tryResolve = (p: string): string | undefined => {
    const hit = probe(p);
    if (hit) return hit;
    const noJs = p.replace(/\.(js|jsx|mjs|cjs)$/, "");
    return noJs !== p ? probe(noJs) : undefined;
  };
  // Probe a package-dir-relative entry-point path, then dist→src remaps of it:
  // exports/imports maps usually point at compiled output (`./dist/esm/index.js`)
  // while only the source tree is committed — peel build dirs and retry under `src/`.
  const probeEntry = (pkgDir: string, entry: string): string | undefined => {
    for (const cand of [entry, ...distToSrcCandidates(entry)]) {
      const hit = tryResolve(norm(posix.join(pkgDir, cand)));
      if (hit) return hit;
    }
    return undefined;
  };

  // A bundler resource query (Vite `?worker`/`?inline`/`?url`/`?raw`, webpack
  // `?raw`) picks HOW a file loads, not WHICH file: probe without it. The raw
  // specifier still names a dangling edge (graph.ts writes `ref.spec`).
  const q = rawSpec.indexOf("?");
  const spec = q === -1 ? rawSpec : rawSpec.slice(0, q);
  if (!spec) return { kind: "external" };

  if (spec.startsWith(".")) {
    const base = fromRel.includes("/") ? posix.dirname(fromRel) : "";
    const p = norm(posix.join(base, spec));
    if (p.startsWith("..")) return { kind: "dangling", reason: "escapes-repo-root" };
    const hit = tryResolve(p);
    return hit ? { kind: "resolved", target: hit } : { kind: "dangling", reason: "missing-module" };
  }

  // tsconfig path aliases (e.g. "@/x" -> "src/x"), nearest enclosing config first.
  let aliasFallback: Resolution | undefined;
  let bareBase: string | undefined; // baseUrl of the nearest in-scope config declaring one
  for (const cfg of ctx.tsConfigs) {
    if (cfg.dir && fromRel !== cfg.dir && !fromRel.startsWith(cfg.dir + "/")) continue; // out of scope
    if (bareBase === undefined && cfg.baseUrlSet) bareBase = cfg.baseUrl;
    let matched = false;
    for (const tp of cfg.paths) {
      if (!(tp.star ? spec.startsWith(tp.prefix) : spec === tp.prefix)) continue;
      matched = true;
      const suffix = tp.star ? spec.slice(tp.prefix.length) : "";
      let targetTreeExists = false;
      for (const t of tp.targets) {
        const resolved = tp.star ? t.replace(/\*/, suffix) : t;
        const p = norm(posix.join(cfg.baseUrl, resolved));
        const hit = tryResolve(p);
        if (hit) return { kind: "resolved", target: hit };
        const tdir = p.includes("/") ? posix.dirname(p) : "";
        if (ctx.dirSet.has(tdir) || ctx.fileSet.has(p)) targetTreeExists = true;
      }
      // Prefix matched but nothing resolved. Remember the verdict — a real broken
      // import into an in-repo dir is dangling; an absent target tree (a generated
      // `styled-system/` codegen dir, not committed) is external (no false
      // dangling) — but DON'T return yet: a workspace package may still claim this
      // specifier (an alias prefix like "@app/*" can overlap a workspace pkg name).
      aliasFallback = targetTreeExists ? { kind: "dangling", reason: "alias-unresolved" } : { kind: "external" };
      break;
    }
    if (matched) break; // the nearest matching config wins; stop scanning broader ones
  }

  // baseUrl: tsc resolves any bare name against it after `paths` — even after a
  // pattern matched and missed. Only a hit counts: third-party names come
  // through here too, and a miss must stay external, never dangling. A rooted
  // "/x" is not a bare name (tsc never applies baseUrl to it).
  if (bareBase !== undefined && !spec.startsWith("/")) {
    const hit = tryResolve(norm(posix.join(bareBase, spec)));
    if (hit) return { kind: "resolved", target: hit };
  }

  // package.json `imports` (`#internal/x`): matched in the nearest package.json
  // only — Node never consults a further-up one — with the same target
  // flattening and dist→src probing as `exports`. A bare-package target, or one
  // resolving nowhere, stays external: a '#' name is never a workspace package.
  if (spec.startsWith("#")) {
    const scope = ctx.packageScopes.find((s) => !s.dir || fromRel.startsWith(s.dir + "/"));
    const targets = scope ? matchEntryTargets(scope.importEntries, spec) : undefined;
    for (const t of targets ?? []) {
      const hit = scope && t.startsWith("./") ? probeEntry(scope.dir, t) : undefined;
      if (hit) return { kind: "resolved", target: hit };
    }
    return aliasFallback ?? { kind: "external" };
  }

  // Monorepo workspace package: resolve `@scope/pkg`(`/subpath`) to in-repo source.
  for (const pkg of ctx.workspacePackages) {
    if (spec !== pkg.name && !spec.startsWith(pkg.name + "/")) continue;
    const sub = spec.slice(pkg.name.length).replace(/^\//, "");
    // 1) The declared `exports` map — first matching key wins (Node precedence:
    //    exact before wildcard, longest first — already sorted at parse time).
    //    A matching key that resolves nowhere falls through to the heuristics.
    for (const t of matchEntryTargets(pkg.exportEntries, sub ? "./" + sub : ".") ?? []) {
      const hit = probeEntry(pkg.dir, t);
      if (hit) return { kind: "resolved", target: hit };
    }
    // 2) Declared main-ish fields for the bare specifier.
    if (!sub) {
      for (const m of pkg.mainCandidates) {
        const hit = probeEntry(pkg.dir, m);
        if (hit) return { kind: "resolved", target: hit };
      }
    }
    // 3) Naive convention probing — bundler/tsconfig setups legitimately bypass
    //    `exports`, so this stays as the final fallback (no false dangling).
    const bases = sub
      ? [posix.join(pkg.dir, "src", sub), posix.join(pkg.dir, sub)]
      : [posix.join(pkg.dir, "src", "index"), posix.join(pkg.dir, "index"), posix.join(pkg.dir, "src")];
    for (const b of bases) {
      const hit = tryResolve(norm(b));
      if (hit) return { kind: "resolved", target: hit };
    }
    return { kind: "external" }; // workspace pkg, but compiled-only/unmapped — no false dangling
  }

  // An alias prefix matched but neither it nor a workspace package resolved.
  return aliasFallback ?? { kind: "external" }; // else a bare third-party / built-in
}

function resolvePython(fromRel: string, spec: string, ctx: ResolveContext): Resolution {
  const probeModule = (dir: string, dotted: string): string | undefined => {
    const sub = dotted ? dotted.replace(/\./g, "/") : "";
    const base = norm(posix.join(dir, sub));
    return firstExisting(ctx, [base + ".py", base + ".pyi", posix.join(base, "__init__.py")]);
  };

  if (spec.startsWith(".")) {
    const dots = /^\.+/.exec(spec)![0].length;
    const rest = spec.slice(dots);
    const base = fromRel.includes("/") ? posix.dirname(fromRel) : "";
    // 1 dot = current package (the file's dir); each extra dot goes up one.
    let dir = base;
    for (let i = 1; i < dots; i++) dir = dir.includes("/") ? posix.dirname(dir) : "";
    const hit = rest
      ? probeModule(dir, rest)
      : firstExisting(ctx, [posix.join(norm(dir), "__init__.py")]);
    return hit ? { kind: "resolved", target: hit } : { kind: "dangling", reason: "missing-module" };
  }

  // Absolute import: only an edge if it resolves inside the repo; otherwise it
  // is a third-party/stdlib import — external, not dangling. Roots enclosing the
  // importer go first, nearest first, so in a multi-project repo a file's own
  // project wins a top-level name two projects share; then every other root,
  // shortest first (pyRoots' order).
  const enclosing: string[] = [];
  const others: string[] = [];
  for (const root of ctx.pyRoots) {
    (!root || fromRel.startsWith(root + "/") ? enclosing : others).push(root);
  }
  for (const root of [...enclosing.reverse(), ...others]) {
    const hit = probeModule(root, spec);
    if (hit) return { kind: "resolved", target: hit };
  }
  return { kind: "external" };
}

function resolveGo(fromRel: string, spec: string, ctx: ResolveContext): Resolution {
  if (!ctx.goModules.length) return { kind: "external" };
  // Go imports a package (directory); resolve to the lexicographically-first
  // NON-test .go file in that dir as the representative node. A `_test.go` file
  // is not part of the package an importer links against — picking one (it
  // only has to sort first: `api_test.go` < `handler.go`) made production code
  // look like it depends on a test. A test-only dir falls back to its first file.
  const probePkg = (dir: string): Resolution => {
    const d = norm(dir).replace(/^\.$/, "");
    const inDir = filesInDir(ctx, d, ".go");
    const rep = inDir.find((f) => !f.endsWith("_test.go")) ?? inDir[0];
    return rep ? { kind: "resolved", target: rep } : { kind: "dangling", reason: "missing-package" };
  };
  // The importing file's own module (nearest enclosing; goModules is deepest-first).
  const home = ctx.goModules.find((g) => !g.dir || fromRel === g.dir || fromRel.startsWith(g.dir + "/"));
  // (i) The home module's `replace` directives rewrite the import path before
  // normal lookup — exactly the go toolchain's order.
  if (home) {
    for (const r of home.replaces) {
      if (spec !== r.from && !spec.startsWith(r.from + "/")) continue;
      const sub = spec.slice(r.from.length).replace(/^\//, "");
      return probePkg(posix.join(r.toDir, sub));
    }
  }
  // (ii) The home module's own path, then (iii) every other in-repo module —
  // cross-module imports are the point of a multi-module repo.
  const ordered = home ? [home, ...ctx.goModules.filter((g) => g !== home)] : ctx.goModules;
  for (const g of ordered) {
    if (spec !== g.module && !spec.startsWith(g.module + "/")) continue;
    const sub = spec.slice(g.module.length).replace(/^\//, "");
    return probePkg(posix.join(g.dir, sub));
  }
  return { kind: "external" };
}

function resolveRust(fromRel: string, spec: string, ctx: ResolveContext): Resolution {
  if (!ctx.rustCrates.length) return { kind: "external" };
  // Probe a module path: `dir/name.rs` (2018 layout) or `dir/name/mod.rs` (2015).
  const probeMod = (dir: string, name: string): string | undefined =>
    firstExisting(ctx, [posix.join(dir, name + ".rs"), posix.join(dir, name, "mod.rs")]);
  // Walk a `::` path under a base dir, longest prefix first — trailing segments
  // are items (fn/struct), not files, so peel until a module file matches.
  const walkPath = (baseDir: string, segs: string[]): string | undefined => {
    for (let n = segs.length; n >= 1; n--) {
      const dir = norm(posix.join(baseDir, ...segs.slice(0, n - 1)));
      const hit = probeMod(dir, segs[n - 1]!);
      if (hit) return hit;
    }
    return undefined;
  };

  const fromDir = fromRel.includes("/") ? posix.dirname(fromRel) : "";
  const stem = fromRel.slice(fromRel.lastIndexOf("/") + 1).replace(/\.rs$/, "");
  const isRootish = stem === "mod" || stem === "lib" || stem === "main";
  // The directory the importing file's CHILD modules live in.
  const childDir = isRootish ? fromDir : posix.join(fromDir, stem);

  if (spec.startsWith("mod ")) {
    const name = spec.slice(4);
    // A declared `mod` MUST exist as a file — safe to call dangling. Probe the
    // edition-correct dir first, then the sibling dir (lenient on mixed layouts).
    const hit = probeMod(childDir, name) ?? (isRootish ? undefined : probeMod(fromDir, name));
    return hit ? { kind: "resolved", target: hit } : { kind: "dangling", reason: "missing-module" };
  }

  const segs = spec.split("::").map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return { kind: "external" };
  const head = segs[0]!;

  // The crate enclosing the importing file (deepest dir first).
  const home = ctx.rustCrates.find((c) => !c.dir || fromRel === c.dir || fromRel.startsWith(c.dir + "/"));

  let baseDir: string | undefined;
  let rest: string[] = [];
  if (head === "crate" && home) {
    baseDir = home.srcDir;
    rest = segs.slice(1);
  } else if (head === "self") {
    baseDir = childDir;
    rest = segs.slice(1);
  } else if (head === "super") {
    // One `super` per leading segment; the importing file's own module dir is
    // childDir, so the first super lands on fromDir (for rootish, its parent).
    let dir = isRootish ? (fromDir.includes("/") ? posix.dirname(fromDir) : "") : fromDir;
    let i = 1;
    while (i < segs.length && segs[i] === "super") {
      dir = dir.includes("/") ? posix.dirname(dir) : "";
      i++;
    }
    baseDir = dir;
    rest = segs.slice(i);
  } else {
    // A bare first segment may be a sibling in-repo crate (`other_crate::…`).
    const target = ctx.rustCrates.find((c) => c.name === head);
    if (target) {
      const walked = walkPath(target.srcDir, segs.slice(1));
      if (walked) return { kind: "resolved", target: walked };
      if (target.rootFile) return { kind: "resolved", target: target.rootFile };
    }
    return { kind: "external" }; // std/serde/… or an unmapped re-export
  }

  if (!rest.length) return { kind: "external" }; // `use crate;` style — no edge
  const hit = walkPath(baseDir, rest);
  if (hit) return { kind: "resolved", target: hit };
  // No module file matched — the leaf is usually an ITEM (fn/struct) defined in
  // the module that owns baseDir; point the edge at that owning file. For the
  // crate root that's lib.rs/main.rs; for a subdir, `<dir>.rs` or `<dir>/mod.rs`.
  if (home && baseDir === home.srcDir && home.rootFile) return { kind: "resolved", target: home.rootFile };
  const ownerDir = baseDir.includes("/") ? posix.dirname(baseDir) : "";
  const ownerName = baseDir.slice(baseDir.lastIndexOf("/") + 1);
  const owner = ownerName ? probeMod(ownerDir, ownerName) : undefined;
  if (owner && owner !== fromRel) return { kind: "resolved", target: owner };
  // Still nothing — the path may route through `pub use` re-exports or inline
  // `mod {}` blocks we don't model. External, never false-dangling.
  return { kind: "external" };
}

function resolveJava(spec: string, ctx: ResolveContext): Resolution {
  if (!ctx.javaRoots.length) return { kind: "external" };
  const probe = (pkgPath: string): string | undefined => {
    for (const root of ctx.javaRoots) {
      const p = norm(posix.join(root, pkgPath));
      // Wildcard import: the package directory — resolve to its
      // lexicographically-first .java file (the Go-package pattern).
      if (p.endsWith("/*") || p === "*") {
        const dir = p === "*" ? "" : p.slice(0, -2);
        const inDir = filesInDir(ctx, dir, ".java");
        if (inDir.length) return inDir[0];
        continue;
      }
      if (ctx.fileSet.has(p + ".java")) return p + ".java";
    }
    return undefined;
  };

  const path = spec.replace(/\./g, "/");
  let hit = probe(path);
  if (!hit && !spec.endsWith(".*")) {
    // `import com.a.Outer.Inner` (nested class) or `import static com.a.C.m` —
    // peel trailing segments until a type file matches.
    const segs = path.split("/");
    for (let n = segs.length - 1; n >= 2 && !hit; n--) {
      hit = probe(segs.slice(0, n).join("/"));
    }
  }
  // stdlib/third-party (java.util.*, com.google.*) simply never match a root.
  return hit ? { kind: "resolved", target: hit } : { kind: "external" };
}

// C/C++: local `#include "x"` relative to the including file, then each include
// root. Unresolved quoted includes are dangling (they read as an in-repo intent).
function resolveC(fromRel: string, spec: string, ctx: ResolveContext): Resolution {
  const fromDir = fromRel.includes("/") ? posix.dirname(fromRel) : "";
  const hit = firstExisting(ctx, [posix.join(fromDir, spec), ...ctx.cIncludeRoots.map((r) => posix.join(r, spec))]);
  return hit ? { kind: "resolved", target: hit } : { kind: "dangling", reason: "missing-include" };
}

// Ruby: `require_relative` (we normalised to a leading "./") resolves against the
// file's dir; a bare `require` resolves against lib roots, else it is a gem/stdlib.
function resolveRuby(fromRel: string, spec: string, ctx: ResolveContext): Resolution {
  if (spec.startsWith(".")) {
    const fromDir = fromRel.includes("/") ? posix.dirname(fromRel) : "";
    const base = norm(posix.join(fromDir, spec));
    const hit = firstExisting(ctx, [base + ".rb", posix.join(base, "index.rb")]);
    return hit ? { kind: "resolved", target: hit } : { kind: "dangling", reason: "missing-module" };
  }
  for (const root of ctx.rubyLibRoots) {
    const hit = firstExisting(ctx, [posix.join(root, spec + ".rb")]);
    if (hit) return { kind: "resolved", target: hit };
  }
  return { kind: "external" };
}

// PHP: relative `require/include` against the file's dir; `use Namespace\Class`
// against composer PSR-4 (longest prefix wins). Unmatched namespaces are external.
function resolvePhp(fromRel: string, spec: string, ctx: ResolveContext): Resolution {
  if (spec.startsWith(".")) {
    const fromDir = fromRel.includes("/") ? posix.dirname(fromRel) : "";
    const base = norm(posix.join(fromDir, spec));
    const hit = firstExisting(ctx, [base, base + ".php"]);
    return hit ? { kind: "resolved", target: hit } : { kind: "dangling", reason: "missing-module" };
  }
  const ns = spec.replace(/^\\+/, "");
  for (const { prefix, dir } of ctx.phpPsr4) {
    if (prefix && ns !== prefix && !ns.startsWith(prefix + "\\")) continue;
    const rest = prefix ? ns.slice(prefix.length).replace(/^\\+/, "") : ns;
    const hit = firstExisting(ctx, [posix.join(dir, rest.replace(/\\/g, "/")) + ".php"]);
    if (hit) return { kind: "resolved", target: hit };
  }
  return { kind: "external" };
}

// C#: `using X.Y` → files declaring `namespace X.Y` (exact), else the first file
// of any namespace nested under it. Unmatched namespaces are system/third-party.
function resolveCsharp(spec: string, ctx: ResolveContext): Resolution {
  const exact = ctx.csharpNamespaces.get(spec);
  if (exact?.length) return { kind: "resolved", target: exact[0]! };
  let best: string | undefined;
  for (const [ns, files] of ctx.csharpNamespaces) {
    if (ns === spec || ns.startsWith(spec + ".")) {
      const f = files[0]!;
      if (best === undefined || byStr(f, best) < 0) best = f;
    }
  }
  return best ? { kind: "resolved", target: best } : { kind: "external" };
}

// Resolve an import specifier for a file of the given extension.
export function resolveImport(
  fromRel: string,
  ext: string,
  spec: string,
  ctx: ResolveContext,
): Resolution {
  if (JS_TS.has(ext) || SFC_HTML.has(ext)) {
    // Asset imports (`import logo from './x.svg'`) target files walk() skips on
    // purpose — a bundler dependency, not a broken code edge. JS-family only:
    // elsewhere the text after the last dot is a name, not an extension —
    // Python `from .map import f`, Java `import com.acme.Map`, C# `using X.Svg`.
    const dot = spec.lastIndexOf(".");
    if (dot !== -1 && ASSET_EXT.has(spec.slice(dot).toLowerCase().replace(/[?#].*$/, ""))) {
      return { kind: "external" };
    }
    const dir = fromRel.includes("/") ? posix.dirname(fromRel) : "";
    const key = dir + "\0" + spec;
    const memo = (ctx.jsMemo ??= new Map());
    let r = memo.get(key);
    if (!r) memo.set(key, (r = resolveJs(fromRel, spec, ctx)));
    // A copy per caller: Resolution is a flat record, and a shared object would
    // let one consumer's edit reach every later import of the same spec.
    return { ...r };
  }
  if (PY.has(ext)) {
    // Memoized like JS (a package's modules repeat the same imports), which
    // also keeps a big repo's absolute stdlib imports from re-probing every
    // root per file.
    const dir = fromRel.includes("/") ? posix.dirname(fromRel) : "";
    const key = dir + "\0" + spec;
    const memo = (ctx.pyMemo ??= new Map());
    let r = memo.get(key);
    if (!r) memo.set(key, (r = resolvePython(fromRel, spec, ctx)));
    return { ...r };
  }
  if (ext === ".go") return resolveGo(fromRel, spec, ctx);
  if (ext === ".rs") return resolveRust(fromRel, spec, ctx);
  if (ext === ".java") return resolveJava(spec, ctx);
  if (C_CPP.has(ext)) return resolveC(fromRel, spec, ctx);
  if (ext === ".rb" || ext === ".rake") return resolveRuby(fromRel, spec, ctx);
  if (ext === ".php") return resolvePhp(fromRel, spec, ctx);
  if (ext === ".cs") return resolveCsharp(spec, ctx);
  return { kind: "external" };
}
