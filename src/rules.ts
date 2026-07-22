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
//     orphans — code files with no resolved in/out edges, excluding
//               entrypoint-looking basenames (index/main/cli/…).
// Violations are sorted deterministically (rule, from, to, kind) so two runs on
// the same graph are byte-identical.
import type { EdgeKind, Graph } from "./types.js";
import { compileGlobs } from "./glob.js";
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
  builtin: "cycles" | "orphans";
  severity?: RuleSeverity;
  comment?: string;
}

export type ArchRule = ForbiddenEdgeRule | BuiltinRule;

export interface RuleViolation {
  rule: string;
  from: string;
  to: string; // for a cycle: the full path, "a -> b -> a"
  kind: EdgeKind | "cycle" | "orphan";
  severity: RuleSeverity;
  comment?: string;
}

const EDGE_KINDS = new Set<string>(["contains", "doc-link", "import", "call", "use", "mention"]);
const SEVERITIES = new Set<string>(["error", "warn"]);
const BUILTINS = new Set<string>(["cycles", "orphans"]);

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
]);

function isEntrypointLike(rel: string): boolean {
  const base = rel.split("/").pop()!;
  const stem = base.split(".")[0]!.toLowerCase();
  return ENTRYPOINT_STEMS.has(stem);
}

function toList(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v];
}

// Validate an untrusted rules payload (CLI --config file, MCP inline JSON) into
// a typed rules array. Accepts either a bare array or a `{ rules: [...] }`
// wrapper. Throws a descriptive error on the first malformed entry.
export function parseRules(input: unknown): ArchRule[] {
  const raw = Array.isArray(input) ? input : (input as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(raw)) throw new Error("rules config must be an array (or an object with a `rules` array)");
  return raw.map((entry, i) => {
    const at = `rules[${i}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${at}: must be an object`);
    const r = entry as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name) throw new Error(`${at}: \`name\` (non-empty string) is required`);
    if (r.severity !== undefined && !SEVERITIES.has(r.severity as string))
      throw new Error(`${at} (${r.name}): \`severity\` must be "error" or "warn"`);
    if (r.comment !== undefined && typeof r.comment !== "string")
      throw new Error(`${at} (${r.name}): \`comment\` must be a string`);
    if (r.builtin !== undefined) {
      if (!BUILTINS.has(r.builtin as string))
        throw new Error(`${at} (${r.name}): \`builtin\` must be "cycles" or "orphans"`);
      return { name: r.name, builtin: r.builtin, severity: r.severity, comment: r.comment } as BuiltinRule;
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
export function checkRules(graph: Graph, rules: ArchRule[]): RuleViolation[] {
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

  for (const rule of rules) {
    if ("builtin" in rule) {
      if (rule.builtin === "cycles") {
        for (const c of findImportCycles(graph)) {
          emit(rule, { from: c.start, to: c.path.join(" -> "), kind: "cycle" });
        }
      } else {
        for (const f of graph.files) {
          if (f.fileKind !== "code" || f.degIn !== 0 || f.degOut !== 0) continue;
          if (isEntrypointLike(f.rel)) continue;
          emit(rule, { from: f.rel, to: f.rel, kind: "orphan" });
        }
      }
      continue;
    }
    const fromMatch = compileGlobs(toList(rule.from));
    const toMatch = compileGlobs(toList(rule.to));
    if (!fromMatch || !toMatch) continue; // empty glob list — matches nothing
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
