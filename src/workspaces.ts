// Multi-ecosystem workspace/monorepo detection (merged from ultradoc's manifest
// probing and reconstruct's superset): npm/yarn workspaces, pnpm, lerna, nx,
// cargo workspaces, go.work (or, without one, every nested go.mod), nested
// maven modules, uv workspaces (pyproject), Composer path repositories, and
// Gradle settings includes. Returns the package list with a workspace-level
// dependency graph (name edges + path edges), one cycle when present, a
// topological order, malformed-manifest warnings, and a longest-prefix
// packageOf() matcher; checkWorkspaceDeps() then compares those declared edges
// with the link-graph's real imports. Deterministic: packages sorted by dir,
// edges and warnings sorted, no wall-clock.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Graph } from "./types.js";
import { readText } from "./walk.js";
import { tolerantJsonParse } from "./resolve.js";
import { byStr } from "./sort.js";
import { escapeRegExp } from "./util.js";

export type WorkspaceKind =
  | "npm"
  | "pnpm"
  | "lerna"
  | "nx"
  | "cargo"
  | "go"
  | "maven"
  | "uv"
  | "composer"
  | "gradle";

export interface WorkspacePackage {
  name: string;
  dir: string; // repo-relative posix path
  kind: WorkspaceKind;
  manifest: string; // repo-relative manifest path that named this package
  // Free-text description when the naming manifest carries one (package.json,
  // composer.json, pyproject [project]/[tool.poetry], Cargo [package]).
  description?: string;
  dependsOn?: string[]; // sibling package names, sorted
}

export interface WorkspaceInfo {
  packages: WorkspacePackage[];
  cycle?: string[]; // one dependency cycle (first found, deterministic order)
  topoOrder: string[]; // dependency-first package names (cycles appended last)
  // Malformed manifests met during detection (e.g. an unparseable
  // package.json). The member dir is still registered — named by its full dir
  // path — and the reason lands here instead of being silently dropped.
  // Deduplicated and sorted for determinism.
  warnings: string[];
  packageOf(rel: string): WorkspacePackage | undefined;
}

const WS_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "coverage"]);
const MAX_RECURSE_DEPTH = 4;

// Manifests are read with the resolver's JSONC tolerance (comments, trailing
// commas): the same package.json must not be valid for import resolution yet
// "malformed" here. Strict JSON.parse runs first only so a genuinely broken
// file is reported with the parser's own reason.
function readJson(path: string, label?: string, warnings?: string[]): Record<string, unknown> | undefined {
  const raw = readText(path);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = tolerantJsonParse(raw);
    if (parsed === undefined) {
      if (label && warnings) {
        const reason = String(e instanceof Error ? e.message : e).split("\n")[0];
        warnings.push(`malformed ${label}: ${reason}`);
      }
      return undefined;
    }
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  if (label && warnings) warnings.push(`malformed ${label}: not a JSON object`);
  return undefined;
}

function tomlSectionBody(toml: string, section: string): string | null {
  const re = new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "m");
  const m = toml.match(re);
  return m ? m[1]! : null;
}

function tomlStringArray(body: string, key: string): string[] {
  const m = body.match(new RegExp(`${escapeRegExp(key)}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return m[1]!
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function tomlString(body: string | null, key: string): string | undefined {
  return body?.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1];
}

// Glob for workspace patterns/negations (npm semantics: `*` one level, `**`
// crossing, match a prefix so `packages/*` covers the package dir itself).
function wsGlobToRegExp(pat: string): RegExp {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") {
      if (pat[i + 1] === "*") {
        re += ".*";
        i++;
        if (pat[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}($|/)`);
}

// --- per-manifest package probes ------------------------------------------
// Each probe identifies `dir` through one manifest kind; packageAt() runs them
// in a kind-aware order. When a manifest exists but names nothing (or cannot
// be parsed), the FULL dir path is the name — basenames collide across trees
// (`packages/a/utils` vs `packages/b/utils`).

function probeNodePkg(root: string, dir: string, kind: WorkspaceKind, warnings: string[]): WorkspacePackage | undefined {
  const path = join(root, dir, "package.json");
  if (!existsSync(path)) return undefined;
  const manifest = `${dir}/package.json`;
  const pkg = readJson(path, manifest, warnings);
  const out: WorkspacePackage = {
    name: typeof pkg?.name === "string" && pkg.name ? pkg.name : dir,
    dir,
    kind,
    manifest,
  };
  if (typeof pkg?.description === "string" && pkg.description) out.description = pkg.description;
  return out;
}

function probeCargo(root: string, dir: string): WorkspacePackage | undefined {
  const path = join(root, dir, "Cargo.toml");
  if (!existsSync(path)) return undefined;
  const body = tomlSectionBody(readText(path), "package");
  const out: WorkspacePackage = {
    name: tomlString(body, "name") ?? dir,
    dir,
    kind: "cargo",
    manifest: `${dir}/Cargo.toml`,
  };
  const description = tomlString(body, "description");
  if (description) out.description = description;
  return out;
}

function probeGoMod(root: string, dir: string): WorkspacePackage | undefined {
  const path = join(root, dir, "go.mod");
  if (!existsSync(path)) return undefined;
  const name = readText(path).match(/^module\s+(\S+)/m)?.[1] ?? dir;
  return { name, dir, kind: "go", manifest: `${dir}/go.mod` };
}

function probeMaven(root: string, dir: string): WorkspacePackage | undefined {
  const path = join(root, dir, "pom.xml");
  if (!existsSync(path)) return undefined;
  return { name: ownArtifactId(readText(path)) ?? dir, dir, kind: "maven", manifest: `${dir}/pom.xml` };
}

function probePyproject(root: string, dir: string): WorkspacePackage | undefined {
  const path = join(root, dir, "pyproject.toml");
  if (!existsSync(path)) return undefined;
  const toml = readText(path);
  const project = tomlSectionBody(toml, "project");
  const poetry = tomlSectionBody(toml, "tool.poetry");
  const out: WorkspacePackage = {
    name: tomlString(project, "name") ?? tomlString(poetry, "name") ?? dir,
    dir,
    kind: "uv",
    manifest: `${dir}/pyproject.toml`,
  };
  const description = tomlString(project, "description") ?? tomlString(poetry, "description");
  if (description) out.description = description;
  return out;
}

function probeComposer(root: string, dir: string, warnings: string[]): WorkspacePackage | undefined {
  const path = join(root, dir, "composer.json");
  if (!existsSync(path)) return undefined;
  const manifest = `${dir}/composer.json`;
  const pkg = readJson(path, manifest, warnings);
  const out: WorkspacePackage = {
    name: typeof pkg?.name === "string" && pkg.name ? pkg.name : dir,
    dir,
    kind: "composer",
    manifest,
  };
  if (typeof pkg?.description === "string" && pkg.description) out.description = pkg.description;
  return out;
}

// Nx projects may carry NO package.json — `project.json` alone names them.
function probeNxProject(root: string, dir: string, warnings: string[]): WorkspacePackage | undefined {
  const path = join(root, dir, "project.json");
  if (!existsSync(path)) return undefined;
  const manifest = `${dir}/project.json`;
  const proj = readJson(path, manifest, warnings);
  return {
    name: typeof proj?.name === "string" && proj.name ? proj.name : dir,
    dir,
    kind: "nx",
    manifest,
  };
}

function probeGradle(root: string, dir: string): WorkspacePackage | undefined {
  for (const f of ["build.gradle", "build.gradle.kts"]) {
    if (existsSync(join(root, dir, f))) {
      // Gradle build files carry no project name — settings.gradle assigns
      // paths, so the full dir path IS the identity.
      return { name: dir, dir, kind: "gradle", manifest: `${dir}/${f}` };
    }
  }
  return undefined;
}

// Identify a directory as a package: probe manifests in a kind-aware order.
// The discovering ecosystem's manifest wins the name — a go.work member with a
// coexisting package.json is a Go module and takes its name from go.mod; a uv
// member is a Python package first; Composer path repos read composer.json
// first. The generic tail still identifies packages of other ecosystems, and
// project.json (nx) is probed last everywhere so project.json-only members
// are never invisible.
function packageAt(root: string, dir: string, kind: WorkspaceKind, warnings: string[]): WorkspacePackage | undefined {
  const node = () => probeNodePkg(root, dir, kind, warnings);
  const cargo = () => probeCargo(root, dir);
  const gomod = () => probeGoMod(root, dir);
  const maven = () => probeMaven(root, dir);
  const py = () => probePyproject(root, dir);
  const composer = () => probeComposer(root, dir, warnings);
  const nx = () => probeNxProject(root, dir, warnings);
  const gradle = () => probeGradle(root, dir);
  const probes =
    kind === "go"
      ? [gomod, node, cargo, maven, py, composer, nx]
      : kind === "uv"
        ? [py, node, cargo, gomod, maven, composer, nx]
        : kind === "composer"
          ? [composer, node, py, cargo, gomod, maven, nx]
          : kind === "gradle"
            ? [node, maven, cargo, gomod, py, composer, nx, gradle]
            : [node, cargo, gomod, maven, py, composer, nx];
  for (const probe of probes) {
    const pkg = probe();
    if (pkg) return pkg;
  }
  return undefined;
}

// A child pom's FIRST <artifactId> usually belongs to its <parent> block —
// strip that block (and <dependencies>, whose entries also carry artifactIds)
// before reading the module's own coordinate.
function ownArtifactId(pom: string): string | undefined {
  const stripped = pom.replace(/<parent>[\s\S]*?<\/parent>/g, "").replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "");
  return stripped.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1];
}

function addPackage(
  root: string,
  dir: string,
  found: Map<string, WorkspacePackage>,
  kind: WorkspaceKind,
  warnings: string[],
): void {
  const clean = dir.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean || clean === "." || found.has(clean)) return;
  if (clean.split("/").includes("..")) return; // never leave the repo root
  const pkg = packageAt(root, clean, kind, warnings);
  if (pkg) found.set(clean, pkg);
}

// --- glob expansion --------------------------------------------------------

function isDirAt(root: string, rel: string): boolean {
  try {
    return statSync(join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

function subdirsOf(root: string, base: string): string[] {
  let entries;
  try {
    entries = readdirSync(base ? join(root, base) : root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !WS_SKIP_DIRS.has(e.name))
    .map((e) => (base ? `${base}/${e.name}` : e.name))
    .sort(byStr);
}

function descendantsOf(root: string, base: string, depth: number, out: string[]): void {
  if (depth > MAX_RECURSE_DEPTH) return;
  for (const sub of subdirsOf(root, base)) {
    out.push(sub);
    descendantsOf(root, sub, depth + 1, out);
  }
}

// Segment-based expansion of one workspace glob into existing directories:
// `*` spans one level, a partial segment (`libs-*`) filters that level, `**`
// matches this level plus every descendant (bounded) — so nested patterns
// like `packages/*/plugins/*` expand at arbitrary depth. Wildcards never
// enter dot-dirs or WS_SKIP_DIRS (npm's own expansion skips node_modules
// likewise); literal segments always resolve.
function expandGlobDirs(root: string, pat: string): string[] {
  const segs = pat.split("/").filter((s) => s && s !== ".");
  if (segs.includes("..")) return [];
  let dirs: string[] = [""];
  for (const seg of segs) {
    const next = new Set<string>();
    if (seg === "**") {
      for (const d of dirs) {
        if (d) next.add(d);
        const desc: string[] = [];
        descendantsOf(root, d, 0, desc);
        for (const s of desc) next.add(s);
      }
    } else if (seg.includes("*")) {
      const re = new RegExp(`^${seg.split("*").map(escapeRegExp).join("[^/]*")}$`);
      for (const d of dirs) {
        for (const sub of subdirsOf(root, d)) {
          if (re.test(sub.split("/").pop()!)) next.add(sub);
        }
      }
    } else {
      for (const d of dirs) {
        const cand = d ? `${d}/${seg}` : seg;
        if (isDirAt(root, cand)) next.add(cand);
      }
    }
    dirs = [...next];
    if (!dirs.length) return [];
  }
  return dirs.filter(Boolean);
}

function expandPattern(
  root: string,
  raw: string,
  found: Map<string, WorkspacePackage>,
  kind: WorkspaceKind,
  warnings: string[],
): void {
  const pat = raw.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!pat) return;
  if (!pat.includes("*")) {
    addPackage(root, pat, found, kind, warnings);
    return;
  }
  for (const dir of expandGlobDirs(root, pat)) addPackage(root, dir, found, kind, warnings);
}

interface WsPattern {
  pattern: string;
  kind: WorkspaceKind;
}

function npmFamilyPatterns(root: string, warnings: string[]): { positives: WsPattern[]; negations: string[] } {
  const positives: WsPattern[] = [];
  const negations: string[] = [];
  const push = (raw: string, kind: WorkspaceKind): void => {
    const t = raw.trim();
    if (!t) return;
    if (t.startsWith("!")) negations.push(t.slice(1));
    else positives.push({ pattern: t, kind });
  };
  const pkg = readJson(join(root, "package.json"), "package.json", warnings);
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) {
    for (const x of ws) if (typeof x === "string") push(x, "npm");
  } else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    for (const x of (ws as { packages: unknown[] }).packages) if (typeof x === "string") push(x, "npm");
  }
  for (const pattern of pnpmPackagePatterns(readText(join(root, "pnpm-workspace.yaml")))) push(pattern, "pnpm");
  return { positives, negations };
}

// A YAML comment starts at a `#` that opens the line or follows whitespace,
// outside quotes.
function stripYamlComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

const unquoteYaml = (s: string): string => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

// pnpm-workspace.yaml `packages:` in either YAML sequence style: the block form
// (`- 'packages/*'` lines, indented or at the key's own column) or the flow
// form (`packages: ["packages/*", 'tools/*']`, which may span lines). Reading
// only the block form made a valid flow-style workspace look empty.
function pnpmPackagePatterns(yaml: string): string[] {
  const out: string[] = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!.match(/^packages\s*:(.*)$/);
    if (!head) continue;
    let flow = stripYamlComment(head[1]!).trim();
    if (flow.startsWith("[")) {
      while (!flow.includes("]") && i + 1 < lines.length) flow += " " + stripYamlComment(lines[++i]!);
      const close = flow.indexOf("]");
      // Items split on commas outside quotes: a quoted glob may hold one.
      for (const m of flow.slice(1, close === -1 ? undefined : close).matchAll(/\s*(?:"([^"]*)"|'([^']*)'|([^,]+))/g)) {
        const v = (m[1] ?? m[2] ?? m[3]!).trim();
        if (v) out.push(v);
      }
      continue;
    }
    // Block form: every following line that is indented, blank, or a `- `
    // entry at column 0 belongs to this key.
    while (i + 1 < lines.length && /^(\s|-(\s|$)|$)/.test(lines[i + 1]!)) {
      const m = stripYamlComment(lines[++i]!).match(/^\s*-\s*(.*)$/);
      const v = m ? unquoteYaml(m[1]!) : "";
      if (v) out.push(v);
    }
  }
  return out;
}

function fallbackNpmPatterns(root: string, warnings: string[]): WsPattern[] {
  const lerna = readJson(join(root, "lerna.json"), "lerna.json", warnings);
  if (lerna && Array.isArray(lerna.packages)) {
    return (lerna.packages as unknown[])
      .filter((x): x is string => typeof x === "string")
      .map((pattern) => ({ pattern, kind: "lerna" as const }));
  }
  const nx = readJson(join(root, "nx.json"), "nx.json", warnings);
  if (nx) {
    const layout = (nx.workspaceLayout ?? {}) as { appsDir?: unknown; libsDir?: unknown };
    const appsDir = typeof layout.appsDir === "string" ? layout.appsDir : "apps";
    const libsDir = typeof layout.libsDir === "string" ? layout.libsDir : "libs";
    return [...new Set([appsDir, libsDir])].map((dir) => ({ pattern: `${dir}/*`, kind: "nx" as const }));
  }
  return [];
}

function detectCargoMembers(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  const toml = readText(join(root, "Cargo.toml"));
  if (!toml) return;
  const body = tomlSectionBody(toml, "workspace");
  if (!body) return;
  const members = tomlStringArray(body, "members");
  if (!members.length) return;
  const excludes = tomlStringArray(body, "exclude").map(wsGlobToRegExp);
  const candidates = new Map<string, WorkspacePackage>();
  for (const pat of members) expandPattern(root, pat, candidates, "cargo", warnings);
  for (const [dir, pkg] of candidates) {
    if (excludes.some((re) => re.test(dir))) continue;
    if (!found.has(dir)) found.set(dir, pkg);
  }
}

// Directories the go tool itself never builds from — vendored copies, testdata
// and `_`-prefixed dirs (dot-dirs are skipped everywhere already) — plus the
// fixture dirs other ecosystems keep test repos in: a Go fixture module inside
// a JS project's tests/fixtures is not a workspace member.
const GO_SKIP_DIRS = new Set(["vendor", "testdata", "fixtures", "__fixtures__"]);

// Every nested go.mod under `base`, bounded like the glob walker. One readdir
// per directory answers both "is there a go.mod here" and "where next".
function goModDirs(root: string, base: string, depth: number, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(base ? join(root, base) : root, { withFileTypes: true });
  } catch {
    return;
  }
  if (base && entries.some((e) => e.name === "go.mod" && !e.isDirectory())) out.push(base);
  if (depth > MAX_RECURSE_DEPTH) return;
  const subs = entries
    .filter((e) => e.isDirectory() && !/^[._]/.test(e.name) && !WS_SKIP_DIRS.has(e.name) && !GO_SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort(byStr);
  for (const name of subs) goModDirs(root, base ? `${base}/${name}` : name, depth + 1, out);
}

// go.work lists the workspace modules explicitly. Without one, a repo can still
// hold several modules side by side (a service beside a CLI beside a shared
// lib) — the import resolver already links across every in-repo go.mod, so the
// workspace view lists each nested module too instead of reporting none.
function detectGoWork(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  const gowork = readText(join(root, "go.work"));
  if (!gowork) {
    if (existsSync(join(root, "go.work"))) return; // an empty go.work still declares the workspace
    const dirs: string[] = [];
    goModDirs(root, "", 0, dirs);
    for (const dir of dirs) addPackage(root, dir, found, "go", warnings);
    return;
  }
  const dirs: string[] = [];
  for (const block of gowork.matchAll(/^use\s*\(([\s\S]*?)\)/gm)) {
    for (const line of block[1]!.split(/\r?\n/)) {
      const t = line.replace(/\/\/.*$/, "").trim();
      if (t) dirs.push(t);
    }
  }
  for (const m of gowork.matchAll(/^use\s+([^\s(]+)/gm)) dirs.push(m[1]!);
  for (const dir of dirs) {
    if (dir === "." || dir === "./") continue;
    addPackage(root, dir, found, "go", warnings);
  }
}

// Maven reactor modules. A module that is itself an aggregator lists its own
// <modules>, relative to ITS pom — nested reactors are the norm in large Maven
// builds, and reading only the root pom dropped every leaf module along with
// the dependency edges pointing at them. Every <modules> block counts (profiles
// add modules too); XML comments are stripped first, since a commented-out
// <module> is a disabled one. A <module> may name a pom file instead of a dir.
function detectMavenModules(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  const seen = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_RECURSE_DEPTH || seen.has(dir)) return;
    seen.add(dir);
    const pom = readText(join(root, dir, "pom.xml")).replace(/<!--[\s\S]*?-->/g, "");
    for (const block of pom.matchAll(/<modules>([\s\S]*?)<\/modules>/g)) {
      for (const m of block[1]!.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
        const spec = m[1]!.endsWith(".xml") ? posix.dirname(m[1]!) : m[1]!;
        const child = posix.normalize(posix.join(dir || ".", spec)).replace(/\/+$/, "");
        if (child === "." || child === ".." || child.startsWith("../")) continue; // never leave the repo root
        addPackage(root, child, found, "maven", warnings);
        visit(child, depth + 1);
      }
    }
  };
  visit("", 0);
}

// uv workspaces: [tool.uv.workspace] members/exclude in the root pyproject.
function detectUvMembers(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  const toml = readText(join(root, "pyproject.toml"));
  if (!toml) return;
  const body = tomlSectionBody(toml, "tool.uv.workspace");
  if (!body) return;
  const members = tomlStringArray(body, "members");
  if (!members.length) return;
  const excludes = tomlStringArray(body, "exclude").map(wsGlobToRegExp);
  const candidates = new Map<string, WorkspacePackage>();
  for (const pat of members) expandPattern(root, pat, candidates, "uv", warnings);
  for (const [dir, pkg] of candidates) {
    if (excludes.some((re) => re.test(dir))) continue;
    if (!found.has(dir)) found.set(dir, pkg);
  }
}

// Composer path repositories: { "repositories": [{ "type": "path", "url": … }] }
// — the url may be a glob (packages/*), same expansion as npm patterns.
function detectComposerPathRepos(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  const composer = readJson(join(root, "composer.json"), "composer.json", warnings);
  const repos = composer?.repositories;
  if (!Array.isArray(repos)) return;
  for (const r of repos) {
    if (!r || typeof r !== "object") continue;
    const { type, url } = r as { type?: unknown; url?: unknown };
    if (type === "path" && typeof url === "string" && url) expandPattern(root, url, found, "composer", warnings);
  }
}

// Gradle multi-project builds: settings.gradle(.kts) `include ':a', ':b:c'` or
// `include("x")` — a `:`-separated project path maps to a directory path. Both
// DSLs let the argument list span lines: inside parentheses (the usual Kotlin
// layout, one project per line) or, in Groovy, continued after a trailing
// comma. Reading line by line kept only the projects on the `include` line.
function detectGradleIncludes(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  for (const f of ["settings.gradle", "settings.gradle.kts"]) {
    const text = readText(join(root, f));
    if (!text) continue;
    // Comments out first (a commented include is a disabled one); `://` is a
    // URL inside a string, not a comment.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const call of code.matchAll(/^[ \t]*include\b[ \t]*(\([^)]*\)|(?:[^\n]*,[ \t]*\r?\n)*[^\n]*)/gm)) {
      for (const m of call[1]!.matchAll(/["']([^"']+)["']/g)) {
        const dir = m[1]!.replace(/^:/, "").replace(/:/g, "/");
        if (dir) addPackage(root, dir, found, "gradle", warnings);
      }
    }
  }
}

// --- workspace dependency edges -------------------------------------------

function npmEdges(root: string, pkg: WorkspacePackage, byName: Set<string>, warnings: string[]): string[] {
  const manifest = readJson(join(root, pkg.dir, "package.json"), `${pkg.dir}/package.json`, warnings);
  if (!manifest) return [];
  const edges = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = manifest[field];
    if (!deps || typeof deps !== "object") continue;
    for (const dep of Object.keys(deps)) {
      if (dep !== pkg.name && byName.has(dep)) edges.add(dep);
    }
  }
  return [...edges];
}

function normalizeDepPath(fromDir: string, rel: string): string {
  const parts = `${fromDir}/${rel}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function cargoEdges(root: string, pkg: WorkspacePackage, byName: Set<string>, byDir: Map<string, string>): string[] {
  const toml = readText(join(root, pkg.dir, "Cargo.toml"));
  if (!toml) return [];
  const edges = new Set<string>();
  for (const section of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    const body = tomlSectionBody(toml, section);
    if (!body) continue;
    for (const line of body.split(/\r?\n/)) {
      const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
      if (!kv) continue;
      const dep = kv[1]!;
      if (dep !== pkg.name && byName.has(dep)) {
        edges.add(dep);
        continue;
      }
      const pathDep = kv[2]!.match(/path\s*=\s*["']([^"']+)["']/);
      if (pathDep) {
        const target = byDir.get(normalizeDepPath(pkg.dir, pathDep[1]!));
        if (target && target !== pkg.name) edges.add(target);
      }
    }
  }
  return [...edges];
}

function goPkgEdges(root: string, pkg: WorkspacePackage, byName: Set<string>, byDir: Map<string, string>): string[] {
  const gomod = readText(join(root, pkg.dir, "go.mod"));
  if (!gomod) return [];
  const edges = new Set<string>();
  for (const m of gomod.matchAll(/^\s*(?:require\s+)?([^\s/(][^\s]*)\s+v[^\s]+/gm)) {
    const dep = m[1]!;
    if (dep !== pkg.name && byName.has(dep)) edges.add(dep);
  }
  for (const m of gomod.matchAll(/^\s*(?:replace\s+)?(\S+)(?:\s+\S+)?\s*=>\s*(\.\.?\/\S+)/gm)) {
    const target = byDir.get(normalizeDepPath(pkg.dir, m[2]!));
    if (target && target !== pkg.name) edges.add(target);
  }
  return [...edges];
}

function mavenEdges(root: string, pkg: WorkspacePackage, byName: Set<string>): string[] {
  const pom = readText(join(root, pkg.dir, "pom.xml"));
  if (!pom) return [];
  const edges = new Set<string>();
  // Only <dependency> entries count as edges; the <parent> coordinate is a
  // build-inheritance link, not a workspace dependency.
  for (const m of pom.replace(/<parent>[\s\S]*?<\/parent>/g, "").matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const aid = m[1]!.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1];
    if (aid && aid !== pkg.name && byName.has(aid)) edges.add(aid);
  }
  return [...edges];
}

function uvEdges(root: string, pkg: WorkspacePackage, byName: Set<string>): string[] {
  const toml = readText(join(root, pkg.dir, "pyproject.toml"));
  if (!toml) return [];
  const edges = new Set<string>();
  // [project] dependencies = ["sibling", "requests>=2"] — bare name prefix.
  const project = tomlSectionBody(toml, "project");
  if (project) {
    for (const dep of tomlStringArray(project, "dependencies")) {
      const name = dep.match(/^[A-Za-z0-9_.-]+/)?.[0];
      if (name && name !== pkg.name && byName.has(name)) edges.add(name);
    }
  }
  // [tool.uv.sources] sibling = { workspace = true }
  const sources = tomlSectionBody(toml, "tool.uv.sources");
  if (sources) {
    for (const line of sources.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*\{[^}]*workspace\s*=\s*true/);
      if (m && m[1] !== pkg.name && byName.has(m[1]!)) edges.add(m[1]!);
    }
  }
  return [...edges];
}

function composerEdges(root: string, pkg: WorkspacePackage, byName: Set<string>, warnings: string[]): string[] {
  const manifest = readJson(join(root, pkg.dir, "composer.json"), `${pkg.dir}/composer.json`, warnings);
  if (!manifest) return [];
  const edges = new Set<string>();
  for (const field of ["require", "require-dev"]) {
    const deps = manifest[field];
    if (!deps || typeof deps !== "object") continue;
    for (const dep of Object.keys(deps)) {
      if (dep !== pkg.name && byName.has(dep)) edges.add(dep);
    }
  }
  return [...edges];
}

// Gradle's type-safe project accessor for a project dir: `libs/my-core` is
// `projects.libs.myCore` (each path segment camelCased on `-`/`_`).
function gradleAccessor(dir: string): string {
  return dir
    .split("/")
    .map((seg) => seg.replace(/[-_]+([A-Za-z0-9])/g, (_, c: string) => c.toUpperCase()))
    .join(".");
}

function gradleEdges(
  root: string,
  pkg: WorkspacePackage,
  byName: Set<string>,
  byDir: Map<string, string>,
  accessors: Map<string, string>,
): string[] {
  for (const f of ["build.gradle", "build.gradle.kts"]) {
    const text = readText(join(root, pkg.dir, f));
    if (!text) continue;
    const edges = new Set<string>();
    // implementation project(':libs:core') / project(path: ':libs:core', …) —
    // a project path is a dir path.
    for (const m of text.matchAll(/project\s*\(\s*(?:path\s*[:=]\s*)?["']:?([^"']+)["']/g)) {
      const path = m[1]!.replace(/:/g, "/");
      const target = byDir.get(path) ?? (byName.has(path) ? path : undefined);
      if (target && target !== pkg.name) edges.add(target);
    }
    // implementation(projects.libs.core) — Gradle 7+ type-safe accessors. The
    // longest dotted prefix naming a project wins, so a trailing property
    // (`projects.libs.core.dependencyProject`) does not hide the edge.
    for (const m of text.matchAll(/\bprojects((?:\.[A-Za-z_]\w*)+)/g)) {
      const segs = m[1]!.slice(1).split(".");
      for (let n = segs.length; n > 0; n--) {
        const target = accessors.get(segs.slice(0, n).join("."));
        if (!target) continue;
        if (target !== pkg.name) edges.add(target);
        break;
      }
    }
    return [...edges];
  }
  return [];
}

function edgesFor(
  root: string,
  pkg: WorkspacePackage,
  byName: Set<string>,
  byDir: Map<string, string>,
  accessors: Map<string, string>,
  warnings: string[],
): string[] {
  switch (pkg.kind) {
    case "cargo":
      return cargoEdges(root, pkg, byName, byDir);
    case "go":
      return goPkgEdges(root, pkg, byName, byDir);
    case "maven":
      return mavenEdges(root, pkg, byName);
    case "uv":
      return uvEdges(root, pkg, byName);
    case "composer":
      return composerEdges(root, pkg, byName, warnings);
    case "gradle":
      return gradleEdges(root, pkg, byName, byDir, accessors);
    default:
      return npmEdges(root, pkg, byName, warnings);
  }
}

function findCycle(packages: WorkspacePackage[]): string[] | undefined {
  const deps = new Map(packages.map((p) => [p.name, [...(p.dependsOn ?? [])].sort(byStr)]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (name: string): string[] | null => {
    state.set(name, "visiting");
    stack.push(name);
    for (const dep of deps.get(name) ?? []) {
      if (!deps.has(dep)) continue;
      if (state.get(dep) === "visiting") return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(name, "done");
    return null;
  };
  for (const name of [...deps.keys()].sort(byStr)) {
    if (!state.has(name)) {
      const found = visit(name);
      if (found) return found;
    }
  }
  return undefined;
}

function topoOrder(packages: WorkspacePackage[]): string[] {
  const remaining = new Map(packages.map((p) => [p.name, new Set(p.dependsOn ?? [])]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => !remaining.has(d)))
      .map(([name]) => name)
      .sort(byStr);
    if (!ready.length) {
      // A cycle — append what's left in stable order rather than looping.
      order.push(...[...remaining.keys()].sort(byStr));
      break;
    }
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
    }
  }
  return order;
}

export function detectWorkspaces(root: string): WorkspaceInfo {
  const warnings: string[] = [];
  const found = new Map<string, WorkspacePackage>();

  const { positives, negations } = npmFamilyPatterns(root, warnings);
  const npmPatterns = positives.length ? positives : fallbackNpmPatterns(root, warnings);
  if (npmPatterns.length) {
    const candidates = new Map<string, WorkspacePackage>();
    for (const { pattern, kind } of npmPatterns) expandPattern(root, pattern, candidates, kind, warnings);
    const negRes = negations.map(wsGlobToRegExp);
    for (const [dir, pkg] of candidates) {
      if (negRes.some((re) => re.test(dir))) continue;
      found.set(dir, pkg);
    }
  }
  detectCargoMembers(root, found, warnings);
  detectGoWork(root, found, warnings);
  detectMavenModules(root, found, warnings);
  detectUvMembers(root, found, warnings);
  detectComposerPathRepos(root, found, warnings);
  detectGradleIncludes(root, found, warnings);

  const packages = [...found.values()].sort((a, b) => byStr(a.dir, b.dir));

  const byName = new Set(packages.map((p) => p.name));
  const byDir = new Map(packages.map((p) => [p.dir, p.name]));
  const accessors = new Map(packages.map((p) => [gradleAccessor(p.dir), p.name]));
  for (const pkg of packages) {
    const edges = edgesFor(root, pkg, byName, byDir, accessors, warnings);
    if (edges.length) pkg.dependsOn = edges.sort(byStr);
  }

  const byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  return {
    packages,
    cycle: findCycle(packages),
    topoOrder: topoOrder(packages),
    warnings: [...new Set(warnings)].sort(byStr),
    packageOf: (rel: string) => byDepth.find((p) => rel === p.dir || rel.startsWith(p.dir + "/")),
  };
}

// --- declared vs actual dependencies ----------------------------------------

export interface UndeclaredDependency {
  from: string; // importing package
  to: string; // sibling package it imports without declaring it
  files: number; // distinct importing files
  example: string; // the first of them, sorted
}

export interface WorkspaceCheck {
  ok: boolean; // no undeclared cross-package import
  undeclared: UndeclaredDependency[];
  // Declared sibling dependencies no resolved import uses. Informational: a
  // package can be a real dependency without being imported (a CLI, a shared
  // config, a compiled-only entry the resolver cannot map), so it never fails
  // the check.
  unusedDeclared: { from: string; to: string }[];
}

// Nx derives project dependencies from imports (tsconfig paths) instead of
// declaring them, so an import with no manifest entry is how it is supposed to
// work — its members are left out of the check entirely.
const INFERRED_DEPS = new Set<WorkspaceKind>(["nx"]);
// Kinds whose declared sibling dependencies exist to be imported by code. A
// Maven/Gradle/uv/Composer declaration also carries runtime-only and plugin
// wiring that an import graph cannot see, so "unused" would mostly be noise.
const CODE_LEVEL_DEPS = new Set<WorkspaceKind>(["npm", "pnpm", "lerna", "cargo", "go"]);

// Compare the manifests' declared workspace dependencies with the resolved
// import edges of the link-graph. An import of a sibling package that the
// importer's manifest does not declare works in a hoisted local checkout and
// breaks the isolated install, the publish, or `go mod tidy` — nothing else in
// the toolchain says so before that. Deterministic: sorted by (from, to).
export function checkWorkspaceDeps(info: WorkspaceInfo, graph: Pick<Graph, "fileEdges">): WorkspaceCheck {
  // "from\0to" package names → the pair and its importing files.
  const imported = new Map<string, { from: WorkspacePackage; to: WorkspacePackage; files: Set<string> }>();
  for (const e of graph.fileEdges) {
    if (e.kind !== "import" || e.dangling) continue;
    const from = info.packageOf(e.from);
    const to = info.packageOf(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from.name}\0${to.name}`;
    let pair = imported.get(key);
    if (!pair) imported.set(key, (pair = { from, to, files: new Set() }));
    pair.files.add(e.from);
  }
  const undeclared: UndeclaredDependency[] = [];
  for (const { from, to, files } of imported.values()) {
    if (INFERRED_DEPS.has(from.kind) || from.dependsOn?.includes(to.name)) continue;
    const sorted = [...files].sort(byStr);
    undeclared.push({ from: from.name, to: to.name, files: sorted.length, example: sorted[0]! });
  }
  const unusedDeclared: { from: string; to: string }[] = [];
  for (const pkg of info.packages) {
    if (!CODE_LEVEL_DEPS.has(pkg.kind)) continue;
    for (const dep of pkg.dependsOn ?? []) {
      if (!imported.has(`${pkg.name}\0${dep}`)) unusedDeclared.push({ from: pkg.name, to: dep });
    }
  }
  const byPair = (a: { from: string; to: string }, b: { from: string; to: string }): number =>
    byStr(a.from, b.from) || byStr(a.to, b.to);
  return { ok: undeclared.length === 0, undeclared: undeclared.sort(byPair), unusedDeclared: unusedDeclared.sort(byPair) };
}

// The JSON the `workspaces` CLI command and MCP tool print. `warnings` and
// `check` appear only when there is something to say, so the output of a
// clean, unchecked workspace stays byte-identical to earlier releases.
export function workspaceReport(info: WorkspaceInfo, check?: WorkspaceCheck): Record<string, unknown> {
  const out: Record<string, unknown> = { packages: info.packages, cycle: info.cycle ?? null, topoOrder: info.topoOrder };
  if (info.warnings.length) out.warnings = info.warnings;
  if (check) out.check = check;
  return out;
}
