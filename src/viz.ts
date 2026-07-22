// Mermaid rendering of the module graph — inline-renderable in Claude, GitHub
// and most markdown viewers with zero infrastructure (the counter to graph-DB
// browsers). Deterministic: sorted nodes/edges, stable ids.
import type { Graph } from "./types.js";
import { byStr } from "./sort.js";

export interface MermaidOptions {
  // Restrict to one module's neighborhood (the module plus every module it
  // touches, either direction).
  module?: string;
  maxEdges?: number; // default 80 — keeps diagrams renderable
}

const sanitizeId = (slug: string): string => slug.replace(/[^\w]/g, "_");

export function renderMermaid(graph: Graph, opts: MermaidOptions = {}): string {
  const maxEdges = opts.maxEdges ?? 80;
  let edges = [...graph.moduleEdges].filter((e) => !e.dangling);
  if (opts.module) {
    edges = edges.filter((e) => e.from === opts.module || e.to === opts.module);
  }
  edges.sort((a, b) => b.weight - a.weight || byStr(a.from, b.from) || byStr(a.to, b.to));
  const dropped = Math.max(0, edges.length - maxEdges);
  edges = edges.slice(0, maxEdges);

  const shown = new Set<string>();
  for (const e of edges) {
    shown.add(e.from);
    shown.add(e.to);
  }
  if (opts.module) shown.add(opts.module);

  const lines: string[] = ["graph LR"];
  for (const m of [...graph.modules].sort((a, b) => byStr(a.slug, b.slug))) {
    if (!shown.has(m.slug)) continue;
    lines.push(`  ${sanitizeId(m.slug)}["${m.slug}${m.tier === 0 ? " (core)" : ""}"]`);
  }
  for (const e of edges) {
    const label = e.kind === "import" ? "" : `|${e.kind}|`;
    lines.push(`  ${sanitizeId(e.from)} -->${label} ${sanitizeId(e.to)}`);
  }
  if (dropped) lines.push(`  %% ${dropped} lighter edges omitted (maxEdges=${maxEdges})`);
  return lines.join("\n") + "\n";
}
