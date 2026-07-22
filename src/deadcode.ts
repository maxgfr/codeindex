// Dead-code candidates over the static index, in two honestly-labeled tiers:
// "unreferenced" — an exported definition no call site binds to AND no file's
// identifier/mention pass references (highest confidence); "uncalled" — files
// reference the name (re-export, type position, config string) but no call
// site binds. Strictly more principled than name-blacklist heuristics: test
// files and entrypoint-looking files are excluded as ROOTS (their exports are
// consumed externally), not by substring matching.
import type { CodeSymbol } from "./types.js";
import type { RepoScan } from "./scan.js";
import { buildCallerIndex } from "./callers.js";
import { computeSymbolRefs } from "./render/symbols-json.js";
import { isTestPath } from "./tests-map.js";
import { byStr } from "./sort.js";

const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);
// Files whose exports are consumed from OUTSIDE the repo (bins, entrypoints,
// public API barrels) — their symbols are never dead-code candidates.
const ENTRYPOINT_RE = /(^|\/)(index|main|cli|app|server|engine)\.[a-z]+$/;

export interface DeadSymbol {
  name: string;
  file: string;
  line: number;
  kind: string;
  tier: "unreferenced" | "uncalled";
}

export function findDeadCode(scan: RepoScan): DeadSymbol[] {
  const callers = buildCallerIndex(scan);
  const refs = computeSymbolRefs(scan);
  const out: DeadSymbol[] = [];
  const consider = (s: CodeSymbol): boolean =>
    s.exported && !REFERENCE_KINDS.has(s.kind) && !isTestPath(s.file) && !ENTRYPOINT_RE.test(s.file);

  for (const f of scan.files) {
    for (const s of f.symbols) {
      if (!consider(s)) continue;
      const entry = callers.get(s.name) ?? callers.get(`${s.name}@${s.file}`);
      const hasCallers = !!entry && entry.def.file === s.file && entry.callers.length > 0;
      if (hasCallers) continue;
      const referenced = (refs.get(s.name)?.size ?? 0) > 0;
      out.push({ name: s.name, file: s.file, line: s.line, kind: s.kind, tier: referenced ? "uncalled" : "unreferenced" });
    }
  }
  return out.sort((a, b) => byStr(a.tier, b.tier) || byStr(a.file, b.file) || a.line - b.line);
}
