import type { Graph } from "../types.js";
import { byStr } from "../sort.js";

function sortObject(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj).sort(byStr)) out[k] = obj[k]!;
  return out;
}

// Serialize the graph to stable, pretty JSON. Every array is already sorted
// deterministically by the graph builder; we only normalize the language map's
// key order here so two builds of an unchanged repo are byte-identical.
export function renderGraphJson(graph: Graph): string {
  const ordered: Graph = { ...graph, languages: sortObject(graph.languages) };
  return JSON.stringify(ordered, null, 2) + "\n";
}
