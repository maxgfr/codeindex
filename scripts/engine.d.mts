declare const ENGINE_VERSION = "1.0.0";
declare const SCHEMA_VERSION = 4;
declare const EXTRACTOR_VERSION = 4;
type FileKind = "code" | "doc" | "config" | "asset" | "other";
type EdgeKind = "contains" | "doc-link" | "import" | "call" | "use" | "mention";
type Tier = 0 | 1 | 2;
interface CodeSymbol {
    name: string;
    kind: string;
    file: string;
    line: number;
    endLine?: number;
    parent?: string;
    signature?: string;
    exported: boolean;
    lang: string;
}
interface RawRef {
    kind: "doc-link" | "import";
    spec: string;
}
interface FileRecord {
    rel: string;
    ext: string;
    size: number;
    lines: number;
    hash: string;
    kind: FileKind;
    lang: string;
    title?: string;
    summary?: string;
    headings: string[];
    symbols: CodeSymbol[];
    refs: RawRef[];
    pkg?: string;
    idents?: string[];
    calls?: {
        name: string;
        line: number;
    }[];
    importedNames?: string[];
}
interface FileNode {
    id: string;
    kind: "file";
    rel: string;
    fileKind: FileKind;
    lang: string;
    module: string;
    title?: string;
    summary?: string;
    symbols: number;
    lines: number;
    degIn: number;
    degOut: number;
    pagerank?: number;
    testFile?: true;
}
interface ModuleNode {
    id: string;
    kind: "module";
    slug: string;
    path: string;
    title: string;
    summary: string;
    tier: Tier;
    members: string[];
    symbols: number;
    degIn: number;
    degOut: number;
    community?: number;
    pagerank?: number;
    betweenness?: number;
    testedBy?: string[];
}
interface Edge {
    from: string;
    to: string;
    kind: EdgeKind;
    weight: number;
    dangling?: boolean;
    reason?: string;
    confidence?: "extracted" | "inferred";
}
interface Graph {
    schemaVersion: number;
    version: string;
    commit?: string;
    fileCount: number;
    languages: Record<string, number>;
    files: FileNode[];
    modules: ModuleNode[];
    fileEdges: Edge[];
    moduleEdges: Edge[];
    surprises?: SurpriseEdge[];
}
interface SurpriseEdge {
    from: string;
    to: string;
    kind: EdgeKind;
    weight: number;
    communities: [number, number];
    pairEdges: number;
}
interface SymbolIndex {
    schemaVersion: number;
    defs: Record<string, {
        file: string;
        line: number;
        endLine?: number;
        kind: string;
        exported: boolean;
        lang: string;
        parent?: string;
    }[]>;
    refs: Record<string, string[]>;
}

interface WalkOptions {
    maxFileBytes?: number;
    maxFiles?: number;
}
interface WalkedFile {
    rel: string;
    abs: string;
    size: number;
    ext: string;
    mtimeMs: number;
}
interface WalkResult {
    files: WalkedFile[];
    capped: boolean;
}
declare const DEFAULT_MAX_FILES = 20000;
declare function walk(root: string, opts?: WalkOptions): WalkResult;
declare function readText(abs: string): string;

interface RepoScan {
    root: string;
    commit?: string;
    files: FileRecord[];
    languages: Record<string, number>;
    docText: Map<string, string>;
    mtimes: Map<string, number>;
    capped: boolean;
}
interface ScanOptions {
    include?: string[];
    exclude?: string[];
    maxBytes?: number;
    maxFiles?: number;
    out?: string;
    cache?: Map<string, {
        hash: string;
        record: FileRecord;
        size?: number;
        mtimeMs?: number;
    }>;
    fullHash?: boolean;
}
declare function scanRepo(root: string, opts?: ScanOptions): RepoScan;

declare function compileGlobs(globs: string[] | undefined): ((rel: string) => boolean) | null;

declare const MARKDOWN_EXT: Set<string>;
declare function isDoc(rel: string, ext: string): boolean;
declare function isCode(ext: string): boolean;
declare function classify(rel: string, ext: string): FileKind;

declare function extToLang(ext: string): string;

declare function extractSymbols(rel: string, ext: string, content: string): CodeSymbol[];
declare function languageOf(ext: string): string;

interface CodeInfo {
    symbols: CodeSymbol[];
    summary?: string;
    refs: RawRef[];
    pkg?: string;
    idents?: string[];
    calls?: {
        name: string;
        line: number;
    }[];
    importedNames?: string[];
}
declare function extractCode(rel: string, ext: string, content: string): CodeInfo;

interface MarkdownInfo {
    title?: string;
    summary?: string;
    headings: string[];
    refs: RawRef[];
}
declare function extractMarkdown(content: string): MarkdownInfo;

declare function grammarKeyForExt(ext: string): string | undefined;
declare function ensureGrammars(keys: Iterable<string>): Promise<void>;
declare function allGrammarKeys(): string[];
declare function grammarReady(key: string): boolean;

interface AstResult {
    symbols: CodeSymbol[];
    refs: RawRef[];
    pkg?: string;
    idents: string[];
    calls: {
        name: string;
        line: number;
    }[];
    importedNames: string[];
}
declare function extractAst(rel: string, ext: string, content: string): AstResult | undefined;

type Resolution = {
    kind: "resolved";
    target: string;
} | {
    kind: "external";
} | {
    kind: "dangling";
    reason: string;
};
interface TsPath {
    prefix: string;
    star: boolean;
    targets: string[];
}
interface TsConfigScope {
    dir: string;
    baseUrl: string;
    paths: TsPath[];
}
interface ExportEntry {
    key: string;
    star: boolean;
    targets: string[];
}
interface WorkspacePackage {
    name: string;
    dir: string;
    exportEntries: ExportEntry[];
    mainCandidates: string[];
}
interface GoModule {
    module: string;
    dir: string;
    replaces: {
        from: string;
        toDir: string;
    }[];
}
interface RustCrate {
    name: string;
    dir: string;
    srcDir: string;
    rootFile?: string;
}
interface ResolveContext {
    fileSet: Set<string>;
    dirSet: Set<string>;
    filesByDir: Map<string, string[]>;
    tsConfigs: TsConfigScope[];
    goModules: GoModule[];
    rustCrates: RustCrate[];
    javaRoots: string[];
    pyRoots: string[];
    workspacePackages: WorkspacePackage[];
    cIncludeRoots: string[];
    rubyLibRoots: string[];
    phpPsr4: {
        prefix: string;
        dir: string;
    }[];
    csharpNamespaces: Map<string, string[]>;
    warnings: string[];
}
declare function buildResolveContext(scan: RepoScan): ResolveContext;
declare function resolveDocLink(fromRel: string, spec: string, ctx: ResolveContext): Resolution;
declare function resolveImport(fromRel: string, ext: string, spec: string, ctx: ResolveContext): Resolution;

interface ModuleInfo {
    slug: string;
    path: string;
    title: string;
    tier: Tier;
    members: string[];
    summary: string;
}
declare function isTestFile(rel: string): boolean;
declare function tierForPath(path: string): Tier | null;
declare function buildModules(scan: RepoScan): {
    modules: ModuleInfo[];
    moduleOf: Map<string, string>;
};

declare function uniqueSymbolDefs(scan: RepoScan): Map<string, string>;
declare function buildGraph(scan: RepoScan, ctx: ResolveContext, modules: ModuleInfo[], moduleOf: Map<string, string>, meta?: {
    version?: string;
    schemaVersion?: number;
}): Graph;

declare function resolveCallEdges(scan: RepoScan, importPairs: Set<string>): Edge[];

declare function pagerankOf(ids: string[], edges: Edge[], damping?: number): Map<string, number>;
declare function betweennessOf(ids: string[], edges: Edge[]): Map<string, number>;
declare function applyCentrality(graph: Graph): string[];

declare function communityOf(graph: Graph, slug: string): number | undefined;
declare function detectCommunities(modules: ModuleNode[], edges: Edge[], previous?: Record<string, string[]>): Map<string, number>;

declare function isTestPath(rel: string): boolean;
interface TestMap {
    testFiles: Set<string>;
    testedByFile: Map<string, string[]>;
    testedByModule: Map<string, string[]>;
}
declare function computeTestMap(graph: Graph): TestMap;
declare function testsForModule(graph: Graph, slug: string): string[];
declare function untestedModules(graph: Graph): ModuleNode[];

declare function computeSurprises(graph: Graph): SurpriseEdge[];
declare function isSurprising(graph: Graph, from: string, to: string): boolean;

declare function computeSymbolRefs(scan: RepoScan): Map<string, Set<string>>;
declare function buildSymbolIndex(scan: RepoScan, refs?: Map<string, Set<string>>): SymbolIndex;
declare function renderSymbolsJson(index: SymbolIndex): string;

declare function renderGraphJson(graph: Graph): string;

interface BuildIndexOptions extends ScanOptions {
    meta?: {
        version?: string;
        schemaVersion?: number;
    };
    previousCommunities?: Record<string, string[]>;
}
interface IndexArtifacts {
    scan: RepoScan;
    graph: Graph;
    symbols: SymbolIndex;
}
declare function buildIndexArtifacts(repo: string, opts?: BuildIndexOptions): IndexArtifacts;

declare function headCommit(dir: string): string | undefined;
interface DiffFile {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    oldPath?: string;
    binary?: boolean;
    linesAdded?: number;
    linesDeleted?: number;
}
interface Hunk {
    start: number;
    end: number;
    approx?: boolean;
}
interface DiffSpec {
    mergeBase?: string;
    staged?: boolean;
}
declare function isGitWorktree(dir: string): boolean;
declare function resolveBaseRef(dir: string, base?: string): {
    ref: string;
    mergeBase: string;
    note?: string;
} | {
    error: string;
};
declare function diffFiles(dir: string, spec: DiffSpec): DiffFile[];
declare function diffHunks(dir: string, spec: DiffSpec): Map<string, Hunk[]>;
declare function untrackedFiles(dir: string): string[];

declare function sha1(s: string): string;
declare function shortHash(s: string, n?: number): string;

declare function byStr(a: string, b: string): number;
declare function byKey<T>(keyOf: (x: T) => string): (a: T, b: T) => number;

interface ShResult {
    ok: boolean;
    status: number | null;
    stdout: string;
    stderr: string;
    missing: boolean;
}
declare function sh(cmd: string, args: string[], opts?: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}): ShResult;
declare function have(cmd: string): boolean;
declare function slugify(input: string): string;
declare function clip(s: string, max: number): string;
declare function clipInline(s: string, max: number): string;
declare function escapeRegExp(s: string): string;
declare function foldText(s: string): string;
declare function keywords(question: string): string[];
declare function rankedKeywords(question: string): string[];
declare function rrf<T>(lists: T[][], keyOf: (item: T) => string, k?: number): Map<string, number>;

export { type BuildIndexOptions, type CodeInfo, type CodeSymbol, DEFAULT_MAX_FILES, type DiffFile, type DiffSpec, ENGINE_VERSION, EXTRACTOR_VERSION, type Edge, type EdgeKind, type FileKind, type FileNode, type FileRecord, type Graph, type Hunk, type IndexArtifacts, MARKDOWN_EXT, type MarkdownInfo, type ModuleInfo, type ModuleNode, type RawRef, type RepoScan, type Resolution, type ResolveContext, SCHEMA_VERSION, type ScanOptions, type ShResult, type SurpriseEdge, type SymbolIndex, type TestMap, type Tier, type WalkOptions, type WalkResult, type WalkedFile, allGrammarKeys, applyCentrality, betweennessOf, buildGraph, buildIndexArtifacts, buildModules, buildResolveContext, buildSymbolIndex, byKey, byStr, classify, clip, clipInline, communityOf, compileGlobs, computeSurprises, computeSymbolRefs, computeTestMap, detectCommunities, diffFiles, diffHunks, ensureGrammars, escapeRegExp, extToLang, extractAst, extractCode, extractMarkdown, extractSymbols, foldText, grammarKeyForExt, grammarReady, have, headCommit, isCode, isDoc, isGitWorktree, isSurprising, isTestFile, isTestPath, keywords, languageOf, pagerankOf, rankedKeywords, readText, renderGraphJson, renderSymbolsJson, resolveBaseRef, resolveCallEdges, resolveDocLink, resolveImport, rrf, scanRepo, sh, sha1, shortHash, slugify, testsForModule, tierForPath, uniqueSymbolDefs, untestedModules, untrackedFiles, walk };
