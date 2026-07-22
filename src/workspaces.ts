// Multi-ecosystem workspace/monorepo detection (merged from ultradoc's manifest
// probing and reconstruct's superset): npm/yarn workspaces, pnpm, lerna, nx,
// cargo workspaces, go.work, maven modules. Returns the package list with a
// workspace-level dependency graph (name edges + path edges), one cycle when
// present, a topological order, and a longest-prefix packageOf() matcher.
// Deterministic: packages sorted by dir, edges sorted, no wall-clock.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readText } from "./walk.js";
import { byStr } from "./sort.js";

export type WorkspaceKind = "npm" | "pnpm" | "lerna" | "nx" | "cargo" | "go" | "maven";

export interface WorkspacePackage {
  name: string;
  dir: string; // repo-relative posix path
  kind: WorkspaceKind;
  manifest: string; // repo-relative manifest path that named this package
  dependsOn?: string[]; // sibling package names, sorted
}

export interface WorkspaceInfo {
  packages: WorkspacePackage[];
  cycle?: string[]; // one dependency cycle (first found, deterministic order)
  topoOrder: string[]; // dependency-first package names (cycles appended last)
  packageOf(rel: string): WorkspacePackage | undefined;
}

const WS_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", "coverage"]);
const MAX_RECURSE_DEPTH = 4;

function readJson(path: string): Record<string, unknown> | undefined {
  const raw = readText(path);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function tomlSectionBody(toml: string, section: string): string | null {
  const re = new RegExp(`^\\[${section}\\]\\s*$([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))`, "m");
  const m = toml.match(re);
  return m ? m[1]! : null;
}

function tomlStringArray(body: string, key: string): string[] {
  const m = body.match(new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return m[1]!
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
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

// Identify a directory as a package: read whichever manifest names it.
function packageAt(root: string, dir: string, kind: WorkspaceKind): WorkspacePackage | undefined {
  const abs = join(root, dir);
  const pkgJson = join(abs, "package.json");
  if (existsSync(pkgJson)) {
    const pkg = readJson(pkgJson);
    const name = typeof pkg?.name === "string" && pkg.name ? pkg.name : dir.split("/").pop()!;
    return { name, dir, kind, manifest: `${dir}/package.json` };
  }
  const cargo = join(abs, "Cargo.toml");
  if (existsSync(cargo)) {
    const body = tomlSectionBody(readText(cargo), "package");
    const name = body?.match(/name\s*=\s*["']([^"']+)["']/)?.[1] ?? dir.split("/").pop()!;
    return { name, dir, kind: "cargo", manifest: `${dir}/Cargo.toml` };
  }
  const gomod = join(abs, "go.mod");
  if (existsSync(gomod)) {
    const name = readText(gomod).match(/^module\s+(\S+)/m)?.[1] ?? dir.split("/").pop()!;
    return { name, dir, kind: "go", manifest: `${dir}/go.mod` };
  }
  const pom = join(abs, "pom.xml");
  if (existsSync(pom)) {
    const name = readText(pom).match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1] ?? dir.split("/").pop()!;
    return { name, dir, kind: "maven", manifest: `${dir}/pom.xml` };
  }
  return undefined;
}

function addPackage(root: string, dir: string, found: Map<string, WorkspacePackage>, kind: WorkspaceKind): void {
  const clean = dir.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!clean || found.has(clean)) return;
  const pkg = packageAt(root, clean, kind);
  if (pkg) found.set(clean, pkg);
}

function collectRecursive(
  root: string,
  base: string,
  found: Map<string, WorkspacePackage>,
  kind: WorkspaceKind,
  depth: number,
): void {
  if (depth > MAX_RECURSE_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(join(root, base), { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || WS_SKIP_DIRS.has(ent.name)) continue;
    const sub = base ? `${base}/${ent.name}` : ent.name;
    addPackage(root, sub, found, kind);
    collectRecursive(root, sub, found, kind, depth + 1);
  }
}

function expandPattern(root: string, raw: string, found: Map<string, WorkspacePackage>, kind: WorkspaceKind): void {
  const pat = raw.replace(/\/+$/, "");
  if (pat.endsWith("/**")) {
    collectRecursive(root, pat.slice(0, -3), found, kind, 0);
  } else if (pat.endsWith("/*")) {
    const base = pat.slice(0, -2);
    let entries;
    try {
      entries = readdirSync(join(root, base), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) addPackage(root, `${base}/${ent.name}`, found, kind);
    }
  } else {
    addPackage(root, pat, found, kind);
  }
}

interface WsPattern {
  pattern: string;
  kind: WorkspaceKind;
}

function npmFamilyPatterns(root: string): { positives: WsPattern[]; negations: string[] } {
  const positives: WsPattern[] = [];
  const negations: string[] = [];
  const push = (raw: string, kind: WorkspaceKind): void => {
    const t = raw.trim();
    if (!t) return;
    if (t.startsWith("!")) negations.push(t.slice(1));
    else positives.push({ pattern: t, kind });
  };
  const pkg = readJson(join(root, "package.json"));
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

function fallbackNpmPatterns(root: string): WsPattern[] {
  const lerna = readJson(join(root, "lerna.json"));
  if (lerna && Array.isArray(lerna.packages)) {
    return (lerna.packages as unknown[])
      .filter((x): x is string => typeof x === "string")
      .map((pattern) => ({ pattern, kind: "lerna" as const }));
  }
  const nx = readJson(join(root, "nx.json"));
  if (nx) {
    const layout = (nx.workspaceLayout ?? {}) as { appsDir?: unknown; libsDir?: unknown };
    const appsDir = typeof layout.appsDir === "string" ? layout.appsDir : "apps";
    const libsDir = typeof layout.libsDir === "string" ? layout.libsDir : "libs";
    return [...new Set([appsDir, libsDir])].map((dir) => ({ pattern: `${dir}/*`, kind: "nx" as const }));
  }
  return [];
}

function detectCargoMembers(root: string, found: Map<string, WorkspacePackage>): void {
  const toml = readText(join(root, "Cargo.toml"));
  if (!toml) return;
  const body = tomlSectionBody(toml, "workspace");
  if (!body) return;
  const members = tomlStringArray(body, "members");
  if (!members.length) return;
  const excludes = tomlStringArray(body, "exclude").map(wsGlobToRegExp);
  const candidates = new Map<string, WorkspacePackage>();
  for (const pat of members) expandPattern(root, pat, candidates, "cargo");
  for (const [dir, pkg] of candidates) {
    if (excludes.some((re) => re.test(dir))) continue;
    if (!found.has(dir)) found.set(dir, pkg);
  }
}

function detectGoWork(root: string, found: Map<string, WorkspacePackage>): void {
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
    addPackage(root, dir, found, "go");
  }
}

function detectMavenModules(root: string, found: Map<string, WorkspacePackage>): void {
  const pom = readText(join(root, "pom.xml"));
  if (!pom) return;
  const modules = pom.match(/<modules>([\s\S]*?)<\/modules>/)?.[1];
  if (!modules) return;
  for (const m of modules.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)) {
    addPackage(root, m[1]!, found, "maven");
  }
}

// --- workspace dependency edges -------------------------------------------

function npmEdges(root: string, pkg: WorkspacePackage, byName: Set<string>): string[] {
  const manifest = readJson(join(root, pkg.dir, "package.json"));
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
  for (const m of pom.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const aid = m[1]!.match(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/)?.[1];
    if (aid && aid !== pkg.name && byName.has(aid)) edges.add(aid);
  }
  return [...edges];
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
  const found = new Map<string, WorkspacePackage>();

  const { positives, negations } = npmFamilyPatterns(root);
  const npmPatterns = positives.length ? positives : fallbackNpmPatterns(root);
  if (npmPatterns.length) {
    const candidates = new Map<string, WorkspacePackage>();
    for (const { pattern, kind } of npmPatterns) expandPattern(root, pattern, candidates, kind);
    const negRes = negations.map(wsGlobToRegExp);
    for (const [dir, pkg] of candidates) {
      if (negRes.some((re) => re.test(dir))) continue;
      found.set(dir, pkg);
    }
  }
  detectCargoMembers(root, found);
  detectGoWork(root, found);
  detectMavenModules(root, found);

  const packages = [...found.values()].sort((a, b) => byStr(a.dir, b.dir));

  const byName = new Set(packages.map((p) => p.name));
  const byDir = new Map(packages.map((p) => [p.dir, p.name]));
  for (const pkg of packages) {
    const edges =
      pkg.kind === "cargo"
        ? cargoEdges(root, pkg, byName, byDir)
        : pkg.kind === "go"
          ? goPkgEdges(root, pkg, byName, byDir)
          : pkg.kind === "maven"
            ? mavenEdges(root, pkg, byName)
            : npmEdges(root, pkg, byName);
    if (edges.length) pkg.dependsOn = edges.sort(byStr);
  }

  const byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  return {
    packages,
    cycle: findCycle(packages),
    topoOrder: topoOrder(packages),
    packageOf: (rel: string) => byDepth.find((p) => rel === p.dir || rel.startsWith(p.dir + "/")),
  };
}
