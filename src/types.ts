// Single source of truth for the engine version the bundle reports. Kept in
// lockstep with package.json by the release pipeline. Do not edit by hand
// outside a release.
export const ENGINE_VERSION = "2.11.1";

// Bumped whenever the on-disk artifact shape changes, so a consumer can reject
// an index written by an incompatible engine instead of misreading it. The
// numbering continues ultraindex's lineage (this core was extracted from
// ultraindex 5.1.0 at schema v4): v2 added symbols.json, the `use` edge kind,
// per-symbol parent/endLine, and the extraction cache; v3 added the `call` edge
// kind, `Edge.confidence`, and `ModuleNode.community`; v4 added node centrality
// (`pagerank`/`betweenness`), the tests→code fields (`FileNode.testFile`/
// `ModuleNode.testedBy`), and symbols.json `endLine`.
export const SCHEMA_VERSION = 4;

// Identifies the extraction engine's output shape independently of the artifact
// schema. Incremental caches key reused FileRecords on (content hash,
// EXTRACTOR_VERSION); bump this whenever symbol/import extraction changes so a
// stale cache is discarded wholesale rather than mixing old and new records. v3
// added FileRecord.calls (call-site callee names) and importedNames; v4 added
// CommonJS assignment-style JS/TS definitions (`x.y = function () {}`); v5
// populates `calls` on the regex tier too (files without an AST grammar), so
// caller indexes work without the wasm sidecar; v6 added call-site `receiver`
// (the immediate receiver of a qualified call, both tiers) and JS/TS export
// parity with ultradoc (CJS `exports.foo =` / `module.exports = {…}` named
// exports, `export { a, b as c }` local marking, anonymous `export default`
// named after the file stem, `export default Foo` marking the declaration);
// v7 makes an export-alias symbol (`export { b as c }`) mirror the aliased
// local declaration's own kind (e.g. "function") instead of the generic
// "reexport" when it resolves in-file. v8 fixes the C/C++ regex tier
// reporting a function DEFINITION as a call to itself (`void load(void) {`
// yielding a spurious call `load@<defline>`, found during the ultrasec
// consumer migration) by excluding call candidates whose name+line match one
// of the file's own extracted symbols.
export const EXTRACTOR_VERSION = 8;

// How a file is classified. `code` gets symbol/import extraction; `doc` gets
// link/heading extraction; the rest are catalogued but not deeply parsed.
export type FileKind = "code" | "doc" | "config" | "asset" | "other";

// Edge kinds in the link-graph. `contains` is the module→member hierarchy;
// `doc-link` a markdown link; `import` a resolved local code import; `call` a
// resolved cross-file function/method/constructor call (a global second pass over
// collected call sites); `use` a code file referencing another file's unique
// exported symbol (AST-derived, suppressed when an `import` or `call` edge already
// covers the same pair); `mention` a doc naming an exported symbol.
export type EdgeKind = "contains" | "doc-link" | "import" | "call" | "use" | "mention";

// Dependency tier: 0 = foundations (types, utils, config), 1 = features,
// 2 = tail (tests, docs, examples, scripts).
export type Tier = 0 | 1 | 2;

// A symbol extracted deterministically from source (no LLM). Shape matches the
// lifted lang/* extractors.
export interface CodeSymbol {
  name: string;
  kind: string; // function | class | method | const | type | interface | enum | struct | trait | def
  file: string; // relative to repo root
  line: number; // 1-based
  endLine?: number; // 1-based end of the declaration node (AST extractor only)
  parent?: string; // enclosing symbol name for a nested member (AST extractor only)
  signature?: string;
  exported: boolean;
  lang: string;
}

// A raw, UNRESOLVED outbound reference found in a file: a markdown link target,
// or an import specifier as written. Resolution to a real file happens later in
// the graph builder, which is where language/path context lives.
export interface RawRef {
  kind: "doc-link" | "import";
  spec: string; // the target/specifier exactly as written
}

// Everything extracted from one file in a single pass. The unit the graph and
// renderers consume; nothing here requires the model.
export interface FileRecord {
  rel: string; // posix path relative to repo root
  ext: string;
  size: number;
  lines: number;
  hash: string; // sha1 of content — the staleness oracle
  kind: FileKind;
  lang: string;
  title?: string; // markdown H1, or basename for code
  summary?: string; // one-line: first doc paragraph / top doc-comment
  headings: string[]; // markdown section headings
  symbols: CodeSymbol[]; // declared symbols (capped per file)
  refs: RawRef[]; // unresolved outbound links/imports
  pkg?: string; // Java: the file's `package` declaration — anchors source roots
  idents?: string[]; // distinctive identifiers referenced (transient — feeds `use` edges, not persisted)
  // Unresolved call-site callee names (cap 512, deduped by name+line, sorted by
  // name then line). Transient-ish: consumed by the graph builder's global call
  // resolution pass, not surfaced in the graph itself. `receiver` is the simple
  // name of the IMMEDIATE receiver of a qualified call — `axios.get(...)` →
  // {name: "get", receiver: "axios"}, `a.b.c(...)` → {name: "c", receiver: "b"}
  // — absent for a bare call (`get()`) or a computed/complex receiver
  // (`fetch().then(...)`). Receiver-gated sink catalogs (ultrasec) key on it.
  calls?: { name: string; line: number; receiver?: string }[];
  // JS/TS named-import bindings (cap 256, deduped, sorted) — feeds the JS/TS
  // import-evidence gate in call resolution.
  importedNames?: string[];
}

// A node in the link-graph. Files and modules are both nodes.
export interface FileNode {
  id: string; // == rel
  kind: "file";
  rel: string;
  fileKind: FileKind;
  lang: string;
  module: string; // owning module slug
  title?: string;
  summary?: string;
  symbols: number;
  lines: number;
  degIn: number;
  degOut: number;
  // File-graph PageRank scaled by the file count (average file ≈ 1.0), 4 dp.
  // Absent only on graphs built before centrality existed.
  pagerank?: number;
  // Present (true) only when the path classifies as a test file (tests-map.ts).
  testFile?: true;
}

export interface ModuleNode {
  id: string; // == slug
  kind: "module";
  slug: string;
  path: string; // directory path (or "(root)")
  title: string;
  summary: string;
  tier: Tier;
  members: string[]; // member file rels, sorted
  symbols: number; // total declared symbols across members
  degIn: number;
  degOut: number;
  // Navigation community (a Louvain cluster of related modules), 0-based; id 0 is
  // the largest cluster. OPTIONAL/additive: never affects slugs or lexical
  // ranking. Absent only on graphs built before communities existed.
  community?: number;
  // Module-graph PageRank scaled by the module count (average ≈ 1.0), 4 dp.
  pagerank?: number;
  // Normalized undirected Brandes betweenness, [0,1], 6 dp. Absent when the
  // BETWEENNESS_MAX_NODES guard skipped the pass.
  betweenness?: number;
  // Sorted test-file rels with a resolved import/call/use edge into a member —
  // "which tests cover this module". Absent when none do.
  testedBy?: string[];
}

// A directed edge. For a resolved edge `to` is a node id; for a dangling edge
// `to` is the unresolved spec and `dangling` is set with a `reason`.
export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
  dangling?: boolean;
  reason?: string;
  // Only `call` edges set this. extracted = an import between the files
  // corroborates the call; inferred = resolved by a unique name match without
  // import evidence.
  confidence?: "extracted" | "inferred";
}

// The full machine graph, persisted as graph.json by consumers. Holds BOTH
// file-level and module-level nodes/edges. Deliberately carries NO wall-clock
// timestamp so two builds of an unchanged repo are byte-identical.
export interface Graph {
  schemaVersion: number;
  version: string;
  commit?: string; // stable for a given HEAD
  fileCount: number;
  languages: Record<string, number>;
  files: FileNode[];
  modules: ModuleNode[];
  fileEdges: Edge[];
  moduleEdges: Edge[];
  // Surprising cross-community couplings (see surprise.ts), capped and sorted
  // (pairEdges asc, from, to). Absent when none were found.
  surprises?: SurpriseEdge[];
}

// A dependency edge that is one of at most 2 links between two otherwise-
// separate communities — an architectural leak worth extra review attention.
export interface SurpriseEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  weight: number;
  communities: [number, number]; // [community(from), community(to)]
  pairEdges: number; // total module edges between the two communities
}

// A persisted symbol table (symbols.json), emitted so `symbols <name>` queries
// can answer "where is X defined?" without re-scanning the repo. `defs` maps a
// symbol name to its definition sites; `refs` maps a name to the files that
// reference it (populated by the use/mention pass). Deterministically ordered.
export interface SymbolIndex {
  schemaVersion: number;
  // `endLine` mirrors CodeSymbol.endLine (AST extractor only).
  defs: Record<
    string,
    { file: string; line: number; endLine?: number; kind: string; exported: boolean; lang: string; parent?: string }[]
  >;
  refs: Record<string, string[]>;
}
