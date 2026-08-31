// The optional LSP tier.
//
// Three layers, deliberately separated so the untestable part stays small:
//   1. the codec, with no process at all — where framing actually breaks
//   2. the session, against an in-memory transport — where the state machine
//      (timeouts, dead servers, missing capabilities) actually breaks
//   3. the whole path through the REAL spawn, against a fake language server
//      committed under tests/fixtures/lsp — so CI needs no language server
//
// Plus the one property the whole design exists to protect: the tier cannot
// change graph.json/symbols.json bytes.

import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createFramer, encodeMessage, fileUri, relFromUri, locationsToRefs } from "../src/lsp/protocol.js";
import { openLspSession, LspTimeout, type LspTransport } from "../src/lsp/client.js";
import { parseLspConfig, resolveLspConfigPath, serverForLang, loadLspConfig } from "../src/lsp/config.js";
import { spawnLspTransport } from "../src/lsp/spawn.js";
import { agreementOf, columnOfSymbol } from "../src/lsp/refs.js";
import { lspStatus, referencesWithLsp } from "../src/lsp/index.js";
import { findReferences } from "../src/query.js";
import { scanRepo } from "../src/scan.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import { renderSymbolsJson } from "../src/render/symbols-json.js";

const MINI = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/lsp/fake-server.mjs", import.meta.url));

/** A repo copy with an .codeindex/lsp.json pointing at the fake server. */
function repoWithConfig(refs: { file: string; line: number; character?: number }[], mode = "ok"): string {
  const dir = mkdtempSync(join(tmpdir(), "codeindex-lsp-"));
  const repo = join(dir, "repo");
  cpSync(MINI, repo, { recursive: true });
  mkdirSync(join(repo, ".codeindex"), { recursive: true });
  writeFileSync(
    join(repo, ".codeindex", "lsp.json"),
    JSON.stringify({
      version: 1,
      servers: [
        {
          id: "fake",
          languages: ["typescript", "javascript"],
          command: process.execPath,
          args: [FAKE],
          env: { FAKE_LSP_MODE: mode, FAKE_LSP_ROOT: repo, FAKE_LSP_REFS: JSON.stringify(refs) },
          timeoutMs: 4000,
          startupTimeoutMs: 8000,
        },
      ],
    }),
  );
  return repo;
}

describe("LSP framing codec", () => {
  const drain = (framer: ReturnType<typeof createFramer>, chunks: string[]): unknown[] =>
    chunks.flatMap((chunk) => framer.push(chunk));

  it("reassembles a frame split across chunk boundaries", () => {
    const wire = encodeMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const framer = createFramer();
    // Split mid-header, then mid-body — the two places a naive reader breaks.
    const messages = drain(framer, [wire.slice(0, 8), wire.slice(8, 30), wire.slice(30)]);
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("counts BYTES, not characters, for a multi-byte body split across chunks", () => {
    // "café" is 5 bytes and 4 UTF-16 units. A reader that measures the string
    // truncates every message after this one — silently, and forever.
    const wire = encodeMessage({ jsonrpc: "2.0", id: 2, result: { name: "café_déjà_vu" } });
    const bytes = new TextEncoder().encode(wire);
    const framer = createFramer();
    // Cut in the middle of a multi-byte sequence.
    const cut = bytes.length - 6;
    const messages = drain2(framer, [bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 2, result: { name: "café_déjà_vu" } }]);
  });

  it("tolerates an unknown header and a stray Content-Type", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 3, result: 7 });
    const wire = `Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`;
    expect(createFramer().push(wire)).toEqual([{ jsonrpc: "2.0", id: 3, result: 7 }]);
  });

  it("resynchronises past a header block with no length and an absurd one", () => {
    const good = encodeMessage({ jsonrpc: "2.0", id: 4, result: "after" });
    // A header block with no Content-Length must not stall the stream forever…
    expect(createFramer().push(`X-Nonsense: 1\r\n\r\n${good}`)).toEqual([{ jsonrpc: "2.0", id: 4, result: "after" }]);
    // …and neither must one whose length is beyond the frame cap, which is an
    // unbounded allocation driven by a process we did not write.
    expect(createFramer().push(`Content-Length: 999999999999\r\n\r\n${good}`)).toEqual([{ jsonrpc: "2.0", id: 4, result: "after" }]);
  });

  it("drops a frame whose body is not JSON without losing the session", () => {
    const framer = createFramer();
    expect(framer.push("Content-Length: 5\r\n\r\nnotjs")).toEqual([]);
    expect(framer.push(encodeMessage({ jsonrpc: "2.0", id: 5, result: 1 }))).toEqual([{ jsonrpc: "2.0", id: 5, result: 1 }]);
  });

  function drain2(framer: ReturnType<typeof createFramer>, chunks: Uint8Array[]): unknown[] {
    return chunks.flatMap((chunk) => framer.push(chunk));
  }
});

describe("URI mapping", () => {
  it("round-trips a path with spaces and brackets", () => {
    const root = "/tmp/repo";
    const rel = "src/a b/[id].ts";
    expect(fileUri(root, rel)).toBe("file:///tmp/repo/src/a%20b/%5Bid%5D.ts");
    expect(relFromUri(root, fileUri(root, rel))).toBe(rel);
  });

  it("round-trips canonical Windows file URIs", () => {
    const root = "C:\\work\\repo";
    const rel = "src\\a b.ts";
    expect(fileUri(root, rel)).toBe("file:///C:/work/repo/src/a%20b.ts");
    expect(relFromUri(root, "file:///C:/work/repo/src/a%20b.ts")).toBe("src/a b.ts");
  });

  it("emits and accepts canonical Windows UNC file URIs", () => {
    const root = "\\\\server\\share\\repo";
    const rel = "src\\a b.ts";
    expect(fileUri(root, rel)).toBe("file://server/share/repo/src/a%20b.ts");
    expect(relFromUri(root, "file://server/share/repo/src/a%20b.ts")).toBe("src/a b.ts");
  });

  it("refuses a URI outside the repository rather than inventing a path", () => {
    // A definition in node_modules or the standard library is real, but has no
    // repo-relative path — reporting one would name a file that does not exist.
    expect(relFromUri("/tmp/repo", "file:///usr/lib/node_modules/x/index.d.ts")).toBeUndefined();
    expect(relFromUri("/tmp/repo", "http://example.com/x.ts")).toBeUndefined();
  });

  it("normalises all three shapes the spec allows, 0-based to 1-based, sorted", () => {
    const root = "/tmp/repo";
    const raw = [
      { uri: `file://${root}/src/z.ts`, range: { start: { line: 4, character: 2 } } },
      { targetUri: `file://${root}/src/a.ts`, targetSelectionRange: { start: { line: 0, character: 7 } } },
      { uri: `file://${root}/src/z.ts`, range: { start: { line: 4, character: 2 } } }, // duplicate
      { uri: "file:///elsewhere/x.ts", range: { start: { line: 0, character: 0 } } }, // outside
    ];
    expect(locationsToRefs(root, raw)).toEqual([
      { file: "src/a.ts", line: 1, character: 7 },
      { file: "src/z.ts", line: 5, character: 2 },
    ]);
    // A single Location, not an array, is also legal.
    expect(locationsToRefs(root, { uri: `file://${root}/src/one.ts`, range: { start: { line: 2, character: 0 } } })).toEqual([
      { file: "src/one.ts", line: 3, character: 0 },
    ]);
    expect(locationsToRefs(root, null)).toEqual([]);
  });
});

describe("LSP session state machine (no process)", () => {
  /** A transport driven by hand, so timing is a test input rather than a race. */
  function memoryTransport(): LspTransport & { reply(message: unknown): void; sent: string[]; die(): void } {
    let onData: ((chunk: string) => void) | undefined;
    let onExit: ((code: number | null) => void) | undefined;
    const sent: string[] = [];
    return {
      sent,
      write: (chunk) => void sent.push(chunk),
      onData: (cb) => void (onData = cb as (chunk: string) => void),
      onExit: (cb) => void (onExit = cb),
      close: () => {},
      reply: (message) => onData?.(encodeMessage(message as never)),
      die: () => onExit?.(1),
    };
  }

  const initialize = (t: ReturnType<typeof memoryTransport>, capabilities: unknown): void => {
    // The client sends `initialize` synchronously as id 1.
    t.reply({ jsonrpc: "2.0", id: 1, result: { capabilities } });
  };

  it("gates each request on the capability the server advertised", async () => {
    const transport = memoryTransport();
    const opening = openLspSession(transport, { root: "/tmp/repo" });
    initialize(transport, { hoverProvider: true });
    const session = await opening;

    expect(session.capabilities.references).toBe(false);
    // No round trip is even attempted — asking a server that said no just
    // spends a timeout to be told no again.
    const before = transport.sent.length;
    expect(await session.references("src/a.ts", 1, 0)).toEqual([]);
    expect(transport.sent.length).toBe(before);
  });

  it("accepts a provider advertised as an options object, not only as true", async () => {
    const transport = memoryTransport();
    const opening = openLspSession(transport, { root: "/tmp/repo" });
    initialize(transport, { referencesProvider: { workDoneProgress: true }, definitionProvider: true });
    const session = await opening;
    expect(session.capabilities.references).toBe(true);
    expect(session.capabilities.definition).toBe(true);
  });

  it("times out ONE request without poisoning the session", async () => {
    const transport = memoryTransport();
    const opening = openLspSession(transport, { root: "/tmp/repo", timeoutMs: 30 });
    initialize(transport, { referencesProvider: true });
    const session = await opening;

    await expect(session.references("src/a.ts", 1, 0)).rejects.toBeInstanceOf(LspTimeout);

    // The next request still works — a server warming its index must not cost
    // every later question.
    const second = session.references("src/b.ts", 2, 0);
    await new Promise((r) => setTimeout(r, 1));
    transport.reply({ jsonrpc: "2.0", id: 3, result: [{ uri: "file:///tmp/repo/src/b.ts", range: { start: { line: 1, character: 4 } } }] });
    expect(await second).toEqual([{ file: "src/b.ts", line: 2, character: 4 }]);
  });

  it("fails every in-flight request when the server dies", async () => {
    const transport = memoryTransport();
    const opening = openLspSession(transport, { root: "/tmp/repo" });
    initialize(transport, { referencesProvider: true });
    const session = await opening;

    const pending = session.references("src/a.ts", 1, 0);
    transport.die();
    await expect(pending).rejects.toThrow(/exited/);
  });

  it("ignores a server-initiated notification and a reply that arrives after its timeout", async () => {
    const transport = memoryTransport();
    const opening = openLspSession(transport, { root: "/tmp/repo", timeoutMs: 20 });
    initialize(transport, { referencesProvider: true });
    const session = await opening;

    transport.reply({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "indexing" } });
    await expect(session.references("src/a.ts", 1, 0)).rejects.toBeInstanceOf(LspTimeout);
    // The late answer must be dropped, not routed to the next waiter.
    expect(() => transport.reply({ jsonrpc: "2.0", id: 2, result: [] })).not.toThrow();
  });

  it("surfaces a server error response as a rejection", async () => {
    const transport = memoryTransport();
    const opening = openLspSession(transport, { root: "/tmp/repo" });
    initialize(transport, { referencesProvider: true });
    const session = await opening;

    const pending = session.references("src/a.ts", 1, 0);
    await new Promise((r) => setTimeout(r, 1));
    transport.reply({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "internal error" } });
    await expect(pending).rejects.toThrow(/internal error/);
  });
});

describe("LSP config", () => {
  it("rejects a malformed config with the field that is wrong", () => {
    expect(() => parseLspConfig({ version: 2, servers: [] })).toThrow(/version/);
    expect(() => parseLspConfig({ version: 1 })).toThrow(/servers/);
    expect(() => parseLspConfig({ version: 1, servers: [{ id: "a" }] })).toThrow(/command/);
    expect(() => parseLspConfig({ version: 1, servers: [{ id: "a", command: "x" }] })).toThrow(/languages/);
    // Two servers sharing an id would make their answers indistinguishable in
    // the very field meant to tell them apart.
    expect(() =>
      parseLspConfig({
        version: 1,
        servers: [
          { id: "a", command: "x", languages: ["go"] },
          { id: "a", command: "y", languages: ["rust"] },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("maps a language to its server, and nothing to none", () => {
    const config = parseLspConfig({
      version: 1,
      servers: [{ id: "ts", command: "x", languages: ["typescript", "tsx"] }],
    });
    expect(serverForLang(config, "tsx")?.id).toBe("ts");
    expect(serverForLang(config, "go")).toBeUndefined();
  });

  it("treats an absent config as 'not asked for', never as an error", () => {
    const empty = mkdtempSync(join(tmpdir(), "codeindex-nolsp-"));
    expect(loadLspConfig(empty)).toBeUndefined();
    expect(resolveLspConfigPath(empty).source).toBe("none");
  });

  it("lets CODEINDEX_LSP_CONFIG=off disable a repo that has one", () => {
    const repo = repoWithConfig([]);
    expect(resolveLspConfigPath(repo).source).toBe("repo");
    const previous = process.env.CODEINDEX_LSP_CONFIG;
    try {
      process.env.CODEINDEX_LSP_CONFIG = "off";
      expect(resolveLspConfigPath(repo)).toEqual({ path: undefined, source: "none" });
      expect(loadLspConfig(repo)).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEINDEX_LSP_CONFIG;
      else process.env.CODEINDEX_LSP_CONFIG = previous;
    }
  });
});

describe("agreement matrix", () => {
  it("splits the two answers into corroborated, lsp-only and static-only", () => {
    const statik = {
      defs: [{ name: "x", kind: "function", file: "src/def.ts", line: 1, exported: true, lang: "typescript" }],
      callSites: [{ file: "src/caller.ts", line: 3, name: "x" }],
      referencingFiles: ["src/homonym.ts"],
    } as never;
    const agreement = agreementOf(
      [
        { file: "src/def.ts", line: 1 },
        { file: "src/caller.ts", line: 3 },
        { file: "src/missed.ts", line: 9 },
      ],
      statik,
    );
    expect(agreement.both).toEqual(["src/caller.ts", "src/def.ts"]);
    // What the static tier under-recalled…
    expect(agreement.lspOnly).toEqual(["src/missed.ts"]);
    // …and where the homonyms are. This is the field a replace-merge destroys,
    // and the only evidence the static tier over-reported.
    expect(agreement.staticOnly).toEqual(["src/homonym.ts"]);
  });

  it("derives a column from source rather than persisting one", () => {
    // CodeSymbol carries no column on purpose; LSP needs one.
    expect(columnOfSymbol(MINI, "src/client.ts", 1, "definitely-not-there")).toBe(0);
  });
});

describe("the tier end to end, through the real spawn", () => {
  it("annotates the static answer and reports the disagreement", async () => {
    const repo = repoWithConfig([
      { file: "src/client.ts", line: 1, character: 0 },
      { file: "src/only-lsp-knows.ts", line: 2, character: 4 },
    ]);
    const scan = scanRepo(repo);
    const statik = findReferences(scan, "HttpClient");
    const annotated = await referencesWithLsp(scan, repo, "HttpClient", statik);

    expect(annotated.lsp?.ok).toBe(true);
    expect(annotated.lsp?.server).toBe("fake");
    expect(annotated.lsp?.refs.map((r) => r.file)).toContain("src/only-lsp-knows.ts");
    expect(annotated.lsp?.agreement.lspOnly).toContain("src/only-lsp-knows.ts");

    // Union, never replace: the three static tiers come back untouched.
    expect(annotated.defs).toEqual(statik.defs);
    expect(annotated.callSites).toEqual(statik.callSites);
    expect(annotated.referencingFiles).toEqual(statik.referencingFiles);
  }, 30_000);

  it("degrades to the static answer, with a reason, for every way it can fail", async () => {
    const scan = scanRepo(MINI);
    const statik = findReferences(scan, "HttpClient");

    // No config at all → no `lsp` block whatsoever, byte-compatible.
    expect(await referencesWithLsp(scan, MINI, "HttpClient", statik)).toEqual(statik);

    for (const [mode, pattern] of [
      ["nocaps", /does not provide/],
      ["hang", /exceeded|closed/],
      ["crash", /exited|closed|exceeded/],
    ] as const) {
      const repo = repoWithConfig([{ file: "src/client.ts", line: 1 }], mode);
      const repoScan = scanRepo(repo);
      const repoStatic = findReferences(repoScan, "HttpClient");
      const result = await referencesWithLsp(repoScan, repo, "HttpClient", repoStatic);
      expect(result.lsp?.ok, mode).toBe(false);
      expect(result.lsp?.reason ?? "", mode).toMatch(pattern);
      // Whatever went wrong, the static answer is intact.
      expect(result.defs, mode).toEqual(repoStatic.defs);
      expect(result.referencingFiles, mode).toEqual(repoStatic.referencingFiles);
    }
  }, 60_000);

  it("reports a binary that is not installed as absent, not as a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeindex-lsp-missing-"));
    const repo = join(dir, "repo");
    cpSync(MINI, repo, { recursive: true });
    mkdirSync(join(repo, ".codeindex"), { recursive: true });
    writeFileSync(
      join(repo, ".codeindex", "lsp.json"),
      JSON.stringify({ version: 1, servers: [{ id: "ghost", languages: ["typescript"], command: "definitely-not-a-binary-9f3a" }] }),
    );
    const scan = scanRepo(repo);
    const statik = findReferences(scan, "HttpClient");
    const result = await referencesWithLsp(scan, repo, "HttpClient", statik);
    expect(result.lsp?.ok).toBe(false);
    expect(result.lsp?.reason).toContain("definitely-not-a-binary-9f3a");
  }, 20_000);

  it("survives a server that writes unframed log lines to stdout", async () => {
    const repo = repoWithConfig([{ file: "src/client.ts", line: 1 }], "garbage");
    const scan = scanRepo(repo);
    const result = await referencesWithLsp(scan, repo, "HttpClient", findReferences(scan, "HttpClient"));
    expect(result.lsp?.ok).toBe(true);
    expect(result.lsp?.refs.map((r) => r.file)).toEqual(["src/client.ts"]);
  }, 30_000);

  it("spawnLspTransport reports an absent command through onExit, not a throw", async () => {
    const transport = spawnLspTransport({ id: "x", languages: ["typescript"], command: "definitely-not-a-binary-9f3a" }, MINI);
    expect(transport).toBeDefined();
    const code = await new Promise<number | null>((resolve) => transport!.onExit(resolve));
    expect(code).toBeNull();
  }, 20_000);
});

describe("lsp status", () => {
  it("answers 'none' with no config, and spawns nothing", async () => {
    const status = await lspStatus(scanRepo(MINI), MINI);
    expect(status.mode).toBe("none");
    expect(status.servers).toEqual([]);
    expect(status.source).toBe("none");
  });

  it("reports each server, its PATH resolution and the files it claims", async () => {
    const repo = repoWithConfig([]);
    const status = await lspStatus(scanRepo(repo), repo);
    expect(status.mode).toBe("configured");
    expect(status.source).toBe("repo");
    expect(status.servers[0]!.id).toBe("fake");
    expect(status.servers[0]!.onPath).toBe(true); // process.execPath
    expect(status.servers[0]!.filesInRepo).toBeGreaterThan(0);
    // Languages nothing covers are named rather than left as a silent gap.
    expect(status.unmappedLanguages).toContain("python");
    // Default is the cheap answer: no probe, so no capabilities.
    expect(status.servers[0]!.capabilities).toBeUndefined();
  }, 20_000);

  it("--probe reads the capabilities a server really advertises", async () => {
    const repo = repoWithConfig([]);
    const status = await lspStatus(scanRepo(repo), repo, true);
    expect(status.servers[0]!.reachable).toBe(true);
    expect(status.servers[0]!.capabilities).toEqual({
      references: true,
      definition: true,
      implementation: true,
      typeHierarchy: false,
    });
  }, 30_000);
});

// The property the whole file layout exists to protect.
describe("the tier cannot change the artifacts", () => {
  it("renders byte-identical graph.json and symbols.json with the config present and answering", async () => {
    // Both sides are temp copies so the ONLY difference between them is the
    // config file. Comparing against tests/fixtures/mini-repo in place would
    // compare git metadata too — it sits inside this repository's own history
    // and stamps a HEAD commit the copies do not have.
    const bare = join(mkdtempSync(join(tmpdir(), "codeindex-nolsp-")), "repo");
    cpSync(MINI, bare, { recursive: true });
    const withoutConfig = buildIndexArtifacts(bare);
    const repo = repoWithConfig([{ file: "src/client.ts", line: 1 }]);

    // Not just present — actually used, so this cannot pass by the tier never
    // having run.
    const scan = scanRepo(repo);
    const annotated = await referencesWithLsp(scan, repo, "HttpClient", findReferences(scan, "HttpClient"));
    expect(annotated.lsp?.ok).toBe(true);

    const withConfig = buildIndexArtifacts(repo);
    // The config lives under .codeindex/, which walk.ts already ignores — that
    // single path choice is what makes this unconditional. At the repo root it
    // would be a walked file and this assertion would fail on the file count.
    expect(renderGraphJson(withConfig.graph)).toBe(renderGraphJson(withoutConfig.graph));
    expect(renderSymbolsJson(withConfig.symbols)).toBe(renderSymbolsJson(withoutConfig.symbols));
  }, 30_000);
});
