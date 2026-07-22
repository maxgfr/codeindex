// Multi-ecosystem workspace/monorepo detection (merged from ultradoc's manifest
// probing and reconstruct's superset): npm/yarn workspaces, pnpm, lerna, nx,
// cargo workspaces, go.work, maven modules, uv workspaces (pyproject), Composer
// path repositories, and Gradle settings includes. Returns the package list
// with a workspace-level dependency graph (name edges + path edges), one cycle
// when present, a topological order, malformed-manifest warnings, and a
// longest-prefix packageOf() matcher. Deterministic: packages sorted by dir,
// edges and warnings sorted, no wall-clock.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readText } from "./walk.js";
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

function readJson(path: string, label?: string, warnings?: string[]): Record<string, unknown> | undefined {
  const raw = readText(path);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    if (label && warnings) warnings.push(`malformed ${label}: not a JSON object`);
    return undefined;
  } catch (e) {
    if (label && warnings) {
      const reason = String(e instanceof Error ? e.message : e).split("\n")[0];
      warnings.push(`malformed ${label}: ${reason}`);
    }
    return undefined;
  }
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
  const pnpm = readText(join(root, "pnpm-workspace.yaml"));
  let inPackages = false;
  for (const line of pnpm.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^packages\s*:/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
    if (m) push(m[1]!.trim(), "pnpm");
  }
  return { positives, negations };
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

function detectGoWork(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  const gowork = readText(join(root, "go.work"));
  if (!gowork) return;
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

function detectMavenModules(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  const pom = readText(join(root, "pom.xml"));
  if (!pom) return;
  const modules = pom.match(/<modules>([\s\S]*?)<\/modules>/)?.[1];
  if (!modules) return;
  for (const m of modules.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
    addPackage(root, m[1]!, found, "maven", warnings);
  }
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
// `include("x")` — a `:`-separated project path maps to a directory path.
function detectGradleIncludes(root: string, found: Map<string, WorkspacePackage>, warnings: string[]): void {
  for (const f of ["settings.gradle", "settings.gradle.kts"]) {
    const text = readText(join(root, f));
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*include[\s(]/.test(line)) continue;
      for (const m of line.matchAll(/["']([^"']+)["']/g)) {
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

function gradleEdges(root: string, pkg: WorkspacePackage, byName: Set<string>, byDir: Map<string, string>): string[] {
  for (const f of ["build.gradle", "build.gradle.kts"]) {
    const text = readText(join(root, pkg.dir, f));
    if (!text) continue;
    const edges = new Set<string>();
    // implementation project(':libs:core') — a project path is a dir path.
    for (const m of text.matchAll(/project\s*\(\s*["']:?([^"']+)["']\s*\)/g)) {
      const path = m[1]!.replace(/:/g, "/");
      const target = byDir.get(path) ?? (byName.has(path) ? path : undefined);
      if (target && target !== pkg.name) edges.add(target);
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
      return gradleEdges(root, pkg, byName, byDir);
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
  for (const pkg of packages) {
    const edges = edgesFor(root, pkg, byName, byDir, warnings);
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
