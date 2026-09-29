// Shortest paths between two node sets — "how does A reach B" — over any graph
// given as a successor function. Shared by the symbol graph (`callpath`) and
// the file link-graph (`callpath --files`), which differ only in what a step is.
//
// Deterministic by construction: breadth-first by level, every level sorted,
// and the paths listed in lexicographic order of their node ids. Two runs over
// one graph answer the same bytes whatever order the successor function or a
// Map happened to produce; nothing here iterates a collection unsorted into the
// output.
//
// Every shortest path is counted (`pathCount`), but only the first `maxPaths`
// are spelled out: on a dense graph the number of equal-length paths grows
// exponentially with their length, and the first few already say how A
// reaches B.
import { byStr } from "./sort.js";

export interface PathHop {
  node: string;
  via?: string; // the kind of step from the previous hop; absent on the first
}

export interface ShortestPaths {
  hops: number | null; // length of every shortest path; null when none within maxHops
  paths: PathHop[][]; // the first `maxPaths` of them, lexicographic by node ids
  pathCount: number; // how many shortest paths there are in all
}

export function shortestPaths(
  sources: readonly string[],
  targets: ReadonlySet<string>,
  next: (node: string) => Iterable<readonly [node: string, via: string]>,
  maxHops: number,
  maxPaths: number,
): ShortestPaths {
  const start = [...new Set(sources)].sort(byStr);
  const direct = start.filter((s) => targets.has(s));
  if (direct.length) return { hops: 0, paths: direct.slice(0, maxPaths).map((node) => [{ node }]), pathCount: direct.length };

  // node → hop count, and node → (predecessor → step kind) for every
  // predecessor on SOME shortest path. The first kind seen for a pair wins;
  // the frontier is sorted, so that is stable.
  const dist = new Map<string, number>(start.map((s) => [s, 0]));
  const preds = new Map<string, Map<string, string>>();
  const levels: string[][] = [start];
  let found: string[] | undefined;
  for (let d = 1; d <= maxHops && !found; d++) {
    const level: string[] = [];
    for (const node of levels[d - 1]!) {
      for (const [to, via] of next(node)) {
        const seen = dist.get(to);
        if (seen === undefined) {
          dist.set(to, d);
          preds.set(to, new Map());
          level.push(to);
        } else if (seen !== d) continue;
        const p = preds.get(to)!;
        if (!p.has(node)) p.set(node, via);
      }
    }
    if (!level.length) break;
    level.sort(byStr);
    levels.push(level);
    const hit = level.filter((n) => targets.has(n));
    if (hit.length) found = hit;
  }
  if (!found) return { hops: null, paths: [], pathCount: 0 };
  const hops = levels.length - 1;

  // Only nodes some shortest path to a target runs through matter from here.
  const useful = new Set(found);
  const stack = [...found];
  while (stack.length) {
    for (const p of preds.get(stack.pop()!)?.keys() ?? []) {
      if (!useful.has(p)) {
        useful.add(p);
        stack.push(p);
      }
    }
  }
  // Count paths level by level, and list each node's successors for the walk
  // below. Levels are sorted, so every list fills in id order.
  const count = new Map<string, number>();
  const succ = new Map<string, [string, string][]>();
  for (const s of start) if (useful.has(s)) count.set(s, 1);
  for (let d = 1; d <= hops; d++) {
    for (const node of levels[d]!) {
      if (!useful.has(node)) continue;
      let n = 0;
      for (const [p, via] of preds.get(node)!) {
        n += count.get(p) ?? 0;
        const list = succ.get(p);
        if (list) list.push([node, via]);
        else succ.set(p, [[node, via]]);
      }
      count.set(node, n);
    }
  }

  // Depth-first in id order yields the paths lexicographically. Every useful
  // node below the last level has a useful successor, so no branch dead-ends.
  const paths: PathHop[][] = [];
  const walk = (path: PathHop[]): void => {
    if (paths.length >= maxPaths) return;
    const last = path[path.length - 1]!.node;
    if (path.length === hops + 1) {
      paths.push(path.slice());
      return;
    }
    for (const [node, via] of succ.get(last) ?? []) {
      path.push({ node, via });
      walk(path);
      path.pop();
      if (paths.length >= maxPaths) return;
    }
  };
  for (const s of start) if (useful.has(s)) walk([{ node: s }]);
  return { hops, paths, pathCount: found.reduce((n, t) => n + (count.get(t) ?? 0), 0) };
}
