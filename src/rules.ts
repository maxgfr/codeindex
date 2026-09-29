// Architecture rules (issue #4): dependency-cruiser-style assertions validated
// against the built Graph — a deterministic CI gate with zero dependencies.
// Two rule shapes:
//   forbidden edge  {name, from, to, kind?, severity?, comment?} — no resolved
//     file edge may go from a path matching `from` to one matching `to`
//     (globs use src/glob.ts compileGlobs semantics; `kind` narrows to specific
//     edge kinds, default all);
//   builtin         {name, builtin: "cycles" | "orphans", severity?, comment?}
//     cycles  — module-level import cycles (each strongly-connected component
//               is reported once, as a canonical shortest cycle from its
//               lexicographically smallest module);
//     orphans — code files nothing connects to: no resolved in/out edge,
//               not a test, not entrypoint-looking (index/main/cli/…), in a
//               language the repo's imports reach at all, and — for Go, Java,
//               Kotlin and Scala, where a directory is a package whose files
//               see each other without imports — in a package nothing
//               connects to either;
//     literals — values with no single source of truth (see literals.ts):
//               a constant holds the value and other files rewrite it, or
//               several constants hold the same one. Computed from the scan
//               (CheckRulesOptions.scan) with the rule's own thresholds.
// A forbidden rule whose `from` or `to` globs match no indexed file can never
// fire; it is reported as an `unmatched` warning instead of passing silently.
// Violations are sorted deterministically (rule, from, to, kind) so two runs on
// the same graph are byte-identical.
import type { EdgeKind, Graph, LiteralDuplication } from "./types.js";
import type { RepoScan } from "./scan.js";
import { compileGlobs } from "./glob.js";
import { findLiteralDuplications } from "./literals.js";
import { byStr } from "./sort.js";

export type RuleSeverity = "error" | "warn";

export interface ForbiddenEdgeRule {
  name: string;
  from: string | string[]; // glob(s) over the source file's repo-relative path
  to: string | string[]; // glob(s) over the target file's repo-relative path
  kind?: EdgeKind[]; // restrict to these edge kinds (default: all)
  severity?: RuleSeverity; // default "error"
  comment?: string; // rationale, echoed on each violation
}

export interface BuiltinRule {
  name: string;
  builtin: "cycles" | "orphans" | "literals";
  // `literals` only: report tiers at or above this actionability. Defaults to
  // "bypassed", i.e. a helper exists and is being ignored — the tier that names
  // a fix. "uncentralized" also flags values nothing owns yet, which is a
  // design decision rather than a defect and is noisy as a gate.
  tiers?: LiteralDuplication["tier"][];
  // `literals` only: the thresholds of `codeindex literals` (--min-files,
  // --min-count, --include-tests), with the same defaults.
  minFiles?: number;
  minCount?: number;
  includeTests?: boolean;
  severity?: RuleSeverity;
  comment?: string;
}

export interface CheckRulesOptions {
  // The scan the graph was built from. The `literals` builtin needs it to see
  // every duplication: graph.json carries a 24-entry headline sorted
  // competing-first, so a gate on `bypassed` read from it alone passed while
  // `codeindex literals` listed violations. Without a scan the rule falls back
  // to that headline, which is complete only when it holds fewer than 24.
  scan?: RepoScan;
}

export type ArchRule = ForbiddenEdgeRule | BuiltinRule;

export interface RuleViolation {
  rule: string;
  from: string;
  to: string; // for a cycle: the full path, "a -> b -> a"
  kind: EdgeKind | "cycle" | "orphan" | "literal" | "unmatched";
  severity: RuleSeverity;
  comment?: string;
}

// Every EdgeKind, checked both ways by the compiler: a kind added to the union
// and not here (as extends/implements once were) fails to build instead of
// being rejected in configs.
const EDGE_KIND_TABLE: Record<EdgeKind, true> = {
  contains: true,
  "doc-link": true,
  import: true,
  call: true,
  extends: true,
  implements: true,
  use: true,
  mention: true,
};
const EDGE_KINDS = new Set<string>(Object.keys(EDGE_KIND_TABLE));
const SEVERITIES = new Set<string>(["error", "warn"]);
const BUILTINS = new Set<string>(["cycles", "orphans", "literals"]);
const TIERS = new Set<string>(["competing", "bypassed", "uncentralized"]);
// The keys each rule shape reads. Anything else is a typo (`sevrity`, `tier`)
// that would otherwise leave a default in force without a word.
const COMMON_KEYS = ["name", "severity", "comment"];
const FORBIDDEN_KEYS = new Set([...COMMON_KEYS, "from", "to", "kind"]);
const BUILTIN_KEYS = new Set([...COMMON_KEYS, "builtin"]);
const LITERALS_KEYS = new Set([...BUILTIN_KEYS, "tiers", "minFiles", "minCount", "includeTests"]);
// Gate default: the two tiers that name a concrete fix.
const GATED_TIERS: LiteralDuplication["tier"][] = ["competing", "bypassed"];

// A basename that looks like an entrypoint — excluded from the orphans check,
// because nothing is EXPECTED to import a main/cli/server entry.
const ENTRYPOINT_STEMS = new Set([
  "index",
  "main",
  "app",
  "application",
  "cli",
  "server",
  "entry",
  "entrypoint",
  "setup",
  "conftest",
  "__init__",
  "__main__",
  "mod",
  "lib",
  // Loaded by a server or a framework from configuration, never imported.
  "wsgi",
  "asgi",
  "manage",
]);

// Languages whose unit of visibility is the directory. A Go file calling an
// unexported helper in a sibling file, or a Java class using a package-private
// one, creates no edge — the import resolves to one representative file of the
// package — so file-level emptiness says nothing about such a file.
const PACKAGE_DIR_LANGS = new Set(["go", "java", "kotlin", "scala"]);

const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

function findOrphans(graph: Graph): string[] {
  // Languages some resolved code edge (import, call, use, inheritance)
  // reaches, at either end. A language nothing can import (SQL, shell, a lone
  // .proto) has no such edge by construction, and listing its files says
  // nothing about dead code.
  const langOf = new Map(graph.files.map((f) => [f.rel, f.lang]));
  const importable = new Set<string>();
  for (const e of graph.fileEdges) {
    if (e.dangling || e.kind === "contains" || e.kind === "doc-link" || e.kind === "mention") continue;
    const from = langOf.get(e.from);
    const to = langOf.get(e.to);
    if (from !== undefined) importable.add(from);
    if (to !== undefined) importable.add(to);
  }
  // A package is connected when anything points into it (the import's
  // representative may even be a _test.go file) or a non-test file in it
  // reaches out. A test's own imports do not make the code it tests live.
  const connectedPackages = new Set<string>();
  for (const f of graph.files) {
    if (!PACKAGE_DIR_LANGS.has(f.lang)) continue;
    if (f.degIn > 0 || (f.degOut > 0 && !f.testFile)) connectedPackages.add(`${f.lang}\0${dirOf(f.rel)}`);
  }
  const out: string[] = [];
  for (const f of graph.files) {
    if (f.fileKind !== "code" || f.degIn !== 0 || f.degOut !== 0) continue;
    if (f.testFile || !importable.has(f.lang) || isEntrypointLike(f.rel)) continue;
    if (PACKAGE_DIR_LANGS.has(f.lang) && connectedPackages.has(`${f.lang}\0${dirOf(f.rel)}`)) continue;
    out.push(f.rel);
  }
  return out;
}

function isEntrypointLike(rel: string): boolean {
  const base = rel.split("/").pop()!;
  const stem = base.split(".")[0]!.toLowerCase();
  return ENTRYPOINT_STEMS.has(stem);
}

function toList(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

// Parse a rules file's text. The error names the file and the position but
// never echoes its content: over MCP the path comes from the client.
export function parseRulesText(text: string, source: string): ArchRule[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    const pos = /position (\d+)/.exec(e instanceof Error ? e.message : "");
    let where = "";
    if (pos) {
      const before = text.slice(0, Number(pos[1]));
      const line = before.split("\n").length;
      where = ` (line ${line}, column ${before.length - before.lastIndexOf("\n")})`;
    }
    throw new Error(`rules config ${source} is not valid JSON${where}`);
  }
  try {
    return parseRules(payload);
  } catch (e) {
    throw new Error(`rules config ${source}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Validate an untrusted rules payload (CLI --config file, MCP inline JSON) into
// a typed rules array. Accepts either a bare array or a `{ rules: [...] }`
// wrapper. Throws a descriptive error on the first malformed entry.
export function parseRules(input: unknown): ArchRule[] {
  const raw = Array.isArray(input) ? input : (input as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(raw)) throw new Error("rules config must be an array (or an object with a `rules` array)");
  return raw.map((entry, i) => {
    const at = `rules[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`${at}: must be an object`);
    const r = entry as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name) throw new Error(`${at}: \`name\` (non-empty string) is required`);
    const allowed = r.builtin === undefined ? FORBIDDEN_KEYS : r.builtin === "literals" ? LITERALS_KEYS : BUILTIN_KEYS;
    const unknown = Object.keys(r).filter((k) => !allowed.has(k)).sort(byStr);
    if (unknown.length) {
      const shape = r.builtin === undefined ? "a forbidden-edge rule" : `builtin "${String(r.builtin)}"`;
      throw new Error(`${at} (${r.name}): unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `\`${k}\``).join(", ")} — ${shape} takes ${[...allowed].join(", ")}`);
    }
    if (r.severity !== undefined && !SEVERITIES.has(r.severity as string))
      throw new Error(`${at} (${r.name}): \`severity\` must be "error" or "warn"`);
    if (r.comment !== undefined && typeof r.comment !== "string")
      throw new Error(`${at} (${r.name}): \`comment\` must be a string`);
    if (r.builtin !== undefined) {
      if (!BUILTINS.has(r.builtin as string))
        throw new Error(`${at} (${r.name}): \`builtin\` must be "cycles", "orphans" or "literals"`);
      // A tier typo, or a bare string, used to select nothing: the gate passed.
      if (r.tiers !== undefined) {
        const ok = Array.isArray(r.tiers) && r.tiers.length > 0 && r.tiers.every((t) => TIERS.has(t as string));
        if (!ok) throw new Error(`${at} (${r.name}): \`tiers\` must be a non-empty array of ${[...TIERS].join(", ")}`);
      }
      for (const key of ["minFiles", "minCount"] as const) {
        const v = r[key];
        if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v >= 1))
          throw new Error(`${at} (${r.name}): \`${key}\` must be a positive integer`);
      }
      if (r.includeTests !== undefined && typeof r.includeTests !== "boolean")
        throw new Error(`${at} (${r.name}): \`includeTests\` must be a boolean`);
      return {
        name: r.name,
        builtin: r.builtin,
        severity: r.severity,
        comment: r.comment,
        ...(r.tiers !== undefined ? { tiers: r.tiers } : {}),
        ...(r.minFiles !== undefined ? { minFiles: r.minFiles } : {}),
        ...(r.minCount !== undefined ? { minCount: r.minCount } : {}),
        ...(r.includeTests !== undefined ? { includeTests: r.includeTests } : {}),
      } as BuiltinRule;
    }
    const glob = (field: "from" | "to"): string | string[] => {
      const v = r[field];
      const ok = typeof v === "string" ? v.length > 0 : Array.isArray(v) && v.length > 0 && v.every((g) => typeof g === "string" && g);
      if (!ok) throw new Error(`${at} (${r.name}): \`${field}\` must be a glob or a non-empty array of globs`);
      return v as string | string[];
    };
    const from = glob("from");
    const to = glob("to");
    if (r.kind !== undefined) {
      const ok = Array.isArray(r.kind) && r.kind.every((k) => EDGE_KINDS.has(k as string));
      if (!ok) throw new Error(`${at} (${r.name}): \`kind\` must be an array of edge kinds (${[...EDGE_KINDS].join(", ")})`);
    }
    return { name: r.name, from, to, kind: r.kind, severity: r.severity, comment: r.comment } as ForbiddenEdgeRule;
  });
}

// Module-level import cycles. One violation per strongly-connected component
// (iterative Tarjan over the import-kind module edges), rendered as a canonical
// cycle: BFS from the SCC's smallest module along sorted adjacency, closing
// through the (nearest, then smallest) member with an edge back to the start.
function findImportCycles(graph: Graph): { start: string; path: string[] }[] {
  const adj = new Map<string, string[]>();
  for (const e of graph.moduleEdges) {
    if (e.kind !== "import") continue;
    let list = adj.get(e.from);
    if (!list) adj.set(e.from, (list = []));
    list.push(e.to);
  }
  for (const list of adj.values()) list.sort(byStr);
  const nodes = [...adj.keys()].sort(byStr);

  // Iterative Tarjan SCC.
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (indexOf.has(root)) continue;
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    while (work.length) {
      const frame = work[work.length - 1]!;
      const v = frame.node;
      if (frame.next === 0) {
        indexOf.set(v, counter);
        low.set(v, counter);
        counter++;
        stack.push(v);
        onStack.add(v);
      }
      const targets = adj.get(v) ?? [];
      if (frame.next < targets.length) {
        const w = targets[frame.next]!;
        frame.next++;
        if (!indexOf.has(w)) work.push({ node: w, next: 0 });
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, indexOf.get(w)!));
      } else {
        if (low.get(v) === indexOf.get(v)) {
          const scc: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
            if (w === v) break;
          }
          if (scc.length > 1) sccs.push(scc);
        }
        work.pop();
        const parent = work[work.length - 1];
        if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(v)!));
      }
    }
  }

  const cycles: { start: string; path: string[] }[] = [];
  for (const scc of sccs) {
    const members = new Set(scc);
    const start = [...scc].sort(byStr)[0]!;
    // BFS within the SCC from `start`; parent links reconstruct the path.
    const parent = new Map<string, string | null>([[start, null]]);
    const order: string[] = [start];
    for (let i = 0; i < order.length; i++) {
      const v = order[i]!;
      for (const w of adj.get(v) ?? []) {
        if (!members.has(w) || parent.has(w)) continue;
        parent.set(w, v);
        order.push(w);
      }
    }
    // The closing hop: the BFS-nearest (then smallest) member with an edge back
    // to start. BFS `order` is deterministic, so `closer` is too.
    const closer = order.find((v) => (adj.get(v) ?? []).includes(start) && v !== start) ??
      // Degenerate (shouldn't happen in an SCC): fall back to start itself.
      start;
    const path: string[] = [];
    for (let v: string | null = closer; v !== null; v = parent.get(v) ?? null) path.unshift(v);
    path.push(start);
    cycles.push({ start, path });
  }
  return cycles;
}

// Validate `rules` against the built graph. Pure and deterministic: violations
// are fully sorted; severity defaults to "error"; a rule's `comment` (when set)
// is echoed onto each of its violations.
export function checkRules(graph: Graph, rules: ArchRule[], opts: CheckRulesOptions = {}): RuleViolation[] {
  const out: RuleViolation[] = [];
  const emit = (rule: ArchRule, v: Omit<RuleViolation, "rule" | "severity" | "comment">): void => {
    out.push({
      rule: rule.name,
      ...v,
      severity: rule.severity ?? "error",
      ...(rule.comment !== undefined ? { comment: rule.comment } : {}),
    });
  };
  const fileSet = new Set(graph.files.map((f) => f.rel));
  // One literals pass per distinct threshold set, shared by the rules using it.
  const literalRuns = new Map<string, LiteralDuplication[]>();
  const duplicationsFor = (rule: BuiltinRule): LiteralDuplication[] => {
    if (!opts.scan) return graph.literalDuplications ?? [];
    const key = `${rule.minFiles ?? ""}\0${rule.minCount ?? ""}\0${rule.includeTests === true}`;
    let dups = literalRuns.get(key);
    if (!dups) {
      dups = findLiteralDuplications(opts.scan, {
        minFiles: rule.minFiles,
        minCount: rule.minCount,
        includeTests: rule.includeTests,
      }).duplications;
      literalRuns.set(key, dups);
    }
    return dups;
  };

  for (const rule of rules) {
    if ("builtin" in rule) {
      if (rule.builtin === "cycles") {
        for (const c of findImportCycles(graph)) {
          emit(rule, { from: c.start, to: c.path.join(" -> "), kind: "cycle" });
        }
      } else if (rule.builtin === "literals") {
        const wanted = new Set(rule.tiers?.length ? rule.tiers : GATED_TIERS);
        for (const d of duplicationsFor(rule)) {
          if (!wanted.has(d.tier)) continue;
          // `from` is where the value is DEFINED (or the first site rewriting
          // it, when nothing defines it) and `to` names the value, so a CI log
          // line reads as "this constant, this value" without opening the JSON.
          const origin = d.holders[0] ?? d.literals[0]!;
          emit(rule, {
            from: `${origin.file}:${origin.line}`,
            to: `${d.tier} ${JSON.stringify(d.value)} (${d.count} sites, ${d.files} files)`,
            kind: "literal",
          });
        }
      } else {
        for (const rel of findOrphans(graph)) emit(rule, { from: rel, to: rel, kind: "orphan" });
      }
      continue;
    }
    const fromMatch = compileGlobs(toList(rule.from));
    const toMatch = compileGlobs(toList(rule.to));
    if (!fromMatch || !toMatch) continue; // empty glob list — matches nothing
    // A glob side matching no indexed file (a typo, a moved directory) makes
    // the rule vacuous: it passes forever. Always a warning, whatever the
    // rule's severity — the rule is misconfigured, the architecture is not
    // shown to be wrong.
    let vacuous = false;
    for (const [side, match] of [["from", fromMatch], ["to", toMatch]] as const) {
      if (graph.files.some((f) => match(f.rel))) continue;
      vacuous = true;
      out.push({ rule: rule.name, from: toList(rule[side]).join(", "), to: `\`${side}\` matches no indexed file`, kind: "unmatched", severity: "warn" });
    }
    if (vacuous) continue;
    const kinds = rule.kind?.length ? new Set<string>(rule.kind) : null;
    for (const e of graph.fileEdges) {
      if (e.dangling || !fileSet.has(e.to)) continue;
      if (kinds && !kinds.has(e.kind)) continue;
      if (!fromMatch(e.from) || !toMatch(e.to)) continue;
      emit(rule, { from: e.from, to: e.to, kind: e.kind });
    }
  }

  out.sort((a, b) => byStr(a.rule, b.rule) || byStr(a.from, b.from) || byStr(a.to, b.to) || byStr(a.kind, b.kind));
  return out;
}
