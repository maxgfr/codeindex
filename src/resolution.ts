// Resolution report: how much of each language's imports (and markdown links)
// the resolver actually turned into edges.
//
// The link-graph is right to drop `external` refs and to keep `dangling` ones
// as edges to nowhere, but it leaves no way to tell "this Kotlin code has no
// in-repo imports" from "nothing here resolves Kotlin imports at all", or to
// notice that a tsconfig the resolver could not parse turned every alias into
// an external package. Whoever is about to trust impact or dead-code answers
// for a language needs that first. This is the same resolveImport /
// resolveDocLink pass buildGraph makes, aggregated per importer language — a
// query over the scan that changes no artifact.
import type { RepoScan } from "./scan.js";
import { hasImportResolver, resolveDocLink, resolveImport } from "./resolve.js";
import { resolveContextFor } from "./derived.js";
import { detectWorkspaces } from "./workspaces.js";
import { byStr } from "./sort.js";

export interface ResolutionOptions {
  lang?: string; // only this language's row
  limit?: number; // top dangling specs / external packages kept per language (default 10)
}

export interface LanguageResolution {
  lang: string;
  files: number; // files of this language in the scan
  filesWithRefs: number;
  refs: number; // import specifiers (link targets for markdown), as extracted
  resolved: number; // an in-repo file: an edge
  external: number; // third-party, stdlib, URL: no edge, by design
  dangling: number; // a local target that does not exist: an edge to nowhere
  unsupported: number; // the importer's extension has no resolver: no edge, ever
  danglingByReason: Record<string, number>;
  topDangling: { spec: string; reason: string; count: number; example: string }[];
  topExternal: { name: string; count: number }[];
  note?: string; // set when the counts mean "the graph cannot be trusted here"
}

export interface ResolutionReport {
  totals: { refs: number; resolved: number; external: number; dangling: number; unsupported: number };
  languages: LanguageResolution[];
  // Config the resolver or the workspace detector could not use (an
  // unparseable tsconfig or package.json, a missing `extends` base…), each of
  // which silently turns resolvable imports into externals. Sorted, deduped.
  warnings: string[];
}

const DEFAULT_LIMIT = 10;
const JS_FAMILY = new Set(["typescript", "javascript", "vue", "svelte", "astro", "html"]);

// The package an external specifier belongs to, so `lodash/fp` and
// `lodash/get` count as one dependency. Display grouping only — nothing
// resolves through it.
function externalName(lang: string, kind: string, spec: string): string {
  // Markdown extraction already drops URLs, so an external link is a link to a
  // directory: its path is its name.
  if (kind === "doc-link") return spec;
  if (JS_FAMILY.has(lang)) {
    if (/^[./]/.test(spec)) return spec; // a relative asset: the path is the name
    const segs = spec.split("/");
    return spec.startsWith("@") && segs.length > 1 ? `${segs[0]}/${segs[1]}` : segs[0]!;
  }
  if (lang === "python") return spec.startsWith(".") ? spec : spec.split(".")[0]!;
  if (lang === "go") {
    // A module path starts with a domain (github.com/org/repo/...); the
    // standard library does not (net/http).
    const segs = spec.split("/");
    return segs[0]!.includes(".") ? segs.slice(0, 3).join("/") : segs[0]!;
  }
  if (lang === "rust") return spec.split("::")[0]!;
  if (lang === "java" || lang === "csharp") return spec.split(".").slice(0, 2).join(".");
  if (lang === "php") return spec.replace(/^\\+/, "").split("\\")[0]!;
  return spec.split("/")[0]!;
}

interface Acc {
  files: number;
  withRefs: number;
  row: Omit<LanguageResolution, "lang" | "files" | "filesWithRefs" | "danglingByReason" | "topDangling" | "topExternal">;
  reasons: Map<string, number>;
  dangling: Map<string, { reason: string; count: number; example: string }>; // spec\0reason → …
  external: Map<string, number>;
  code: boolean; // the language has code files (a row even with zero refs)
}

const byCountThen = <T>(count: (x: T) => number, key: (x: T) => string) => (a: T, b: T): number =>
  count(b) - count(a) || byStr(key(a), key(b));

export function resolutionReport(scan: RepoScan, opts: ResolutionOptions = {}): ResolutionReport {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const ctx = resolveContextFor(scan);
  const accs = new Map<string, Acc>();
  for (const f of scan.files) {
    if (opts.lang !== undefined && f.lang !== opts.lang) continue;
    let acc = accs.get(f.lang);
    if (!acc) {
      acc = {
        files: 0,
        withRefs: 0,
        row: { refs: 0, resolved: 0, external: 0, dangling: 0, unsupported: 0 },
        reasons: new Map(),
        dangling: new Map(),
        external: new Map(),
        code: false,
      };
      accs.set(f.lang, acc);
    }
    acc.files++;
    if (f.kind === "code") acc.code = true;
    if (f.refs.length) acc.withRefs++;
    for (const ref of f.refs) {
      acc.row.refs++;
      if (ref.kind === "import" && !hasImportResolver(f.ext)) {
        acc.row.unsupported++;
        continue;
      }
      const r = ref.kind === "doc-link" ? resolveDocLink(f.rel, ref.spec, ctx) : resolveImport(f.rel, f.ext, ref.spec, ctx);
      if (r.kind === "resolved") {
        acc.row.resolved++;
      } else if (r.kind === "external") {
        acc.row.external++;
        const name = externalName(f.lang, ref.kind, ref.spec);
        acc.external.set(name, (acc.external.get(name) ?? 0) + 1);
      } else {
        acc.row.dangling++;
        acc.reasons.set(r.reason, (acc.reasons.get(r.reason) ?? 0) + 1);
        const key = `${ref.spec}\0${r.reason}`;
        const hit = acc.dangling.get(key);
        if (!hit) acc.dangling.set(key, { reason: r.reason, count: 1, example: f.rel });
        else {
          hit.count++;
          if (byStr(f.rel, hit.example) < 0) hit.example = f.rel;
        }
      }
    }
  }
  if (opts.lang !== undefined && !accs.size) {
    const known = Object.keys(scan.languages).sort(byStr).join(", ");
    throw new Error(`no indexed files in language "${opts.lang}"${known ? ` — one of: ${known}` : ""}`);
  }

  const totals = { refs: 0, resolved: 0, external: 0, dangling: 0, unsupported: 0 };
  const languages: LanguageResolution[] = [];
  for (const lang of [...accs.keys()].sort(byStr)) {
    const acc = accs.get(lang)!;
    // Config-only languages (json, yaml…) carry no refs by nature: a row of
    // zeros there says nothing. A code language with zero refs does.
    if (!acc.code && acc.row.refs === 0 && opts.lang === undefined) continue;
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += acc.row[k];
    const danglingByReason: Record<string, number> = {};
    for (const reason of [...acc.reasons.keys()].sort(byStr)) danglingByReason[reason] = acc.reasons.get(reason)!;
    const topDangling = [...acc.dangling.entries()]
      .map(([key, v]) => ({ spec: key.slice(0, key.indexOf("\0")), reason: v.reason, count: v.count, example: v.example }))
      .sort(byCountThen((d) => d.count, (d) => `${d.spec}\0${d.reason}`))
      .slice(0, limit);
    const topExternal = [...acc.external.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort(byCountThen((e) => e.count, (e) => e.name))
      .slice(0, limit);
    const row: LanguageResolution = {
      lang,
      files: acc.files,
      filesWithRefs: acc.withRefs,
      ...acc.row,
      danglingByReason,
      topDangling,
      topExternal,
    };
    const note = noteFor(row);
    if (note) row.note = note;
    languages.push(row);
  }

  const warnings = [...new Set([...ctx.warnings, ...detectWorkspaces(scan.root).warnings])].sort(byStr);
  return { totals, languages, warnings };
}

function noteFor(row: LanguageResolution): string | undefined {
  // Markdown refs are links, resolved by resolveDocLink; everything else is an import.
  const noun = row.lang === "markdown" ? "link" : "import";
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (row.refs === 0) return `no ${noun}s extracted from ${plural(row.files, "file")} — this language gets no ${noun} edges`;
  if (row.unsupported === row.refs) {
    return `no import resolver for this language — its ${plural(row.refs, "import")} never become edges`;
  }
  if (row.resolved === 0 && row.dangling === 0) return `every ${noun} is external — no in-repo ${noun} edges for this language`;
  if (row.dangling > row.resolved) {
    return noun === "link"
      ? "more links dangle than resolve — broken relative links in the docs"
      : "more imports dangle than resolve — check path aliases and `warnings` before trusting impact or dead-code answers";
  }
  return undefined;
}
