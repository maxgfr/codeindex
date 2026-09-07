import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callersWithLsp, referencesWithLsp } from "../src/lsp/index.js";
import { scanRepo } from "../src/scan.js";
import { findReferences } from "../src/query.js";
import { createFramer, encodeMessage, type LspMessage } from "../src/lsp/protocol.js";
import { openLspSession, LspIncomingCallsError, type LspTransport } from "../src/lsp/client.js";

function transportFor(answer: (message: LspMessage) => unknown): LspTransport {
  const framer = createFramer();
  let receive: (chunk: string) => void;
  return {
    onData(callback) { receive = callback; },
    onExit() {},
    close() {},
    write(chunk) {
      for (const message of framer.push(chunk)) {
        if (message.id === undefined) continue;
        const result = answer(message);
        receive(encodeMessage(result instanceof Error
          ? { jsonrpc: "2.0", id: message.id, error: {code: -32000, message: result.message} }
          : { jsonrpc: "2.0", id: message.id, result }));
      }
    },
  };
}

const range = (line: number, character = 0) => ({ start: { line, character }, end: { line, character: character + 1 } });

describe("LSP incoming callers", () => {
  it("preserves prepared server data and reports call ranges rather than caller declaration positions", async () => {
    const item = { name: "target", kind: 12, uri: "file:///repo/target.ts", range: range(0), selectionRange: range(0), data: { opaque: ["token", 7] } };
    const caller = { name: "invoke", kind: 12, uri: "file:///repo/caller.ts", range: range(1), selectionRange: range(1, 9) };
    const session = await openLspSession(transportFor((message) => {
      if (message.method === "initialize") return { capabilities: { callHierarchyProvider: {} } };
      if (message.method === "textDocument/prepareCallHierarchy") {
        expect(message.params).toEqual({ textDocument: { uri: "file:///repo/target.ts" }, position: { line: 0, character: 16 } });
        return [item];
      }
      if (message.method === "callHierarchy/incomingCalls") {
        expect(message.params).toEqual({ item });
        return [{ from: caller, fromRanges: [range(8, 2), range(5, 4), range(5, 4)] }];
      }
      return null;
    }), { root: "/repo" });
    expect(session.capabilities.callHierarchy).toBe(true);
    expect(await session.incomingCalls("target.ts", 1, 16)).toEqual([
      { file: "caller.ts", line: 6, character: 4, caller: { name: "invoke", kind: 12, file: "caller.ts", line: 2, character: 9 } },
      { file: "caller.ts", line: 9, character: 2, caller: { name: "invoke", kind: 12, file: "caller.ts", line: 2, character: 9 } },
    ]);
    await session.shutdown();
  });
});

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

// An external stdio server, so tests cover actual spawn, framing and lifecycle.
const SERVER = String.raw`
const send = (id, result) => {
  const body = JSON.stringify({jsonrpc:"2.0", id, result});
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
};
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    const {id, method, params} = message;
    if (method === "initialize") send(id, {capabilities: {callHierarchyProvider: process.env.MODE !== "nocaps", referencesProvider: process.env.MODE !== "nocaps"}});
    if (method === "textDocument/prepareCallHierarchy") {
      if (process.env.MODE === "crash") process.exit(3);
      if (process.env.MODE === "hang") continue;
      if (process.env.EXT && !params.textDocument.uri.endsWith(process.env.EXT)) {
        send(id, null); continue;
      }
      const range = {start: params.position, end: params.position};
      send(id, [{name: "target", kind: 12, uri: params.textDocument.uri, range, selectionRange: range, data: {token: "required"}}]);
    }
    if (method === "callHierarchy/incomingCalls") {
      if (params.item.data.token !== "required") process.exit(4);
      const uri = params.item.uri.replace(/[^/]+$/, "caller" + (process.env.EXT || ".ts"));
      const range = {start: {line: 1, character: 9}, end: {line: 1, character: 15}};
      send(id, [{from: {name: "invoke", kind: 12, uri, range, selectionRange: range}, fromRanges: [{start: {line: 5, character: 2}, end: {line: 5, character: 8}}]}]);
    }
    if (method === "textDocument/references") {
      const uri = params.textDocument.uri;
      const range = {start: {line: 3, character: 2}, end: {line: 3, character: 8}};
      send(id, uri.endsWith(process.env.EXT) ? [{uri: uri.replace(/[^/]+$/, "caller" + process.env.EXT), range}] : []);
    }
    if (method === "shutdown") send(id, null);
    if (method === "exit") process.exit(0);
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function fixture(mode = "ok", extraServers = false) {
  const root = mkdtempSync(join(tmpdir(), "codeindex-callers-"));
  temporary.push(root);
  writeFileSync(join(root, "target.ts"), "export function target() {}\n");
  mkdirSync(join(root, ".codeindex"));
  const servers = [{ id: "ts", languages: ["typescript"], command: process.execPath, args: ["-e", SERVER], env: { MODE: mode, EXT: ".ts" }, timeoutMs: 100, startupTimeoutMs: 2000 }];
  if (extraServers) {
    writeFileSync(join(root, "target.py"), "def target():\n    pass\n");
    servers.push({ ...servers[0]!, id: "py", languages: ["python"], env: { MODE: mode, EXT: ".py" } });
  }
  writeFileSync(join(root, ".codeindex/lsp.json"), JSON.stringify({version: 1, servers}));
  return { root, scan: scanRepo(root) };
}

describe("callersWithLsp", () => {
  it("finds typed callers from a declaration even when static analysis found none", async () => {
    const {root, scan} = fixture();
    const statik = {error: "no tracked callers", detail: ["preserved"]};
    const answer = await callersWithLsp(scan, root, "target", statik);
    expect(answer.error).toBe(statik.error);
    expect(answer.detail).toBe(statik.detail);
    expect(answer.lsp).toEqual({
      server: "ts", ok: true,
      calls: [{file: "caller.ts", line: 6, character: 2, caller: {name: "invoke", kind: 12, file: "caller.ts", line: 2, character: 9}}],
      agreement: {both: [], lspOnly: ["caller.ts"], staticOnly: []},
    });
  });
  it("routes homonyms to their own language servers and permits exact name@file selection", async () => {
    const {root, scan} = fixture("ok", true);
    const statik = {callers: [{file: "caller.ts", line: 6}, {file: "static.ts", line: 8, confidence: "unique-name"}]};
    const before = JSON.stringify(statik);
    const answer = await callersWithLsp(scan, root, "target", statik);
    expect(answer.lsp?.ok).toBe(true);
    expect(answer.lsp?.server).toBe("py, ts");
    expect(answer.lsp?.calls.map((call) => call.file)).toEqual(["caller.py", "caller.ts"]);
    expect(answer.lsp?.agreement).toEqual({both: ["caller.ts"], lspOnly: ["caller.py"], staticOnly: ["static.ts"]});
    expect(JSON.stringify(statik)).toBe(before);
    expect(answer.callers).toBe(statik.callers);
    const selected = await callersWithLsp(scan, root, "target@target.py", statik);
    expect(selected.lsp?.server).toBe("py");
    expect(selected.lsp?.calls.map((call) => call.file)).toEqual(["caller.py"]);
  });

  it.each(["nocaps", "crash", "hang"])("keeps static callers and names %s failures", async (mode) => {
    const {root, scan} = fixture(mode);
    const statik = {callers: [{file: "caller.ts", line: 6}], def: {file: "target.ts"}};
    const answer = await callersWithLsp(scan, root, "target", statik);
    expect(answer.callers).toBe(statik.callers);
    expect(answer.def).toBe(statik.def);
    expect(answer.lsp?.ok).toBe(false);
    expect(answer.lsp?.reason).toMatch(mode === "nocaps" ? /does not provide/ : mode === "crash" ? /exited/ : /exceeded/);
  });

  it("labels missing config, declaration and binary without throwing", async () => {
    const {root, scan} = fixture();
    expect((await callersWithLsp(scan, root, "unknown", {})).lsp?.reason).toMatch(/no declaration/);
    writeFileSync(join(root, ".codeindex/lsp.json"), JSON.stringify({version: 1, servers: [{id: "absent", languages: ["typescript"], command: "codeindex-lsp-command-that-does-not-exist"}]}));
    expect((await callersWithLsp(scan, root, "target", {})).lsp?.reason).toMatch(/not on PATH/);
    writeFileSync(join(root, ".codeindex/lsp.json"), "{");
    expect((await callersWithLsp(scan, root, "target", {})).lsp?.ok).toBe(false);
    rmSync(join(root, ".codeindex/lsp.json"));
    expect((await callersWithLsp(scan, root, "target", {})).lsp?.reason).toMatch(/no LSP server configured/);
  });

});

it("retains completed incoming calls if a later prepared item fails", async () => {
  const item = {name: "target", kind: 12, uri: "file:///repo/target.ts", range: range(0), selectionRange: range(0)};
  const session = await openLspSession(transportFor((message) => {
    if (message.method === "initialize") return {capabilities: {callHierarchyProvider: true}};
    if (message.method === "textDocument/prepareCallHierarchy") return [{...item, data: 1}, {...item, data: 2}];
    if (message.method === "callHierarchy/incomingCalls") {
      if ((message.params as {item: {data: number}}).item.data === 2) return new Error("second item failed");
      return [{from: {...item, name: "caller", uri: "file:///repo/caller.ts"}, fromRanges: [range(4)]}];
    }
    return null;
  }), {root: "/repo"});
  let failure: unknown;
  try { await session.incomingCalls("target.ts", 1, 0); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(LspIncomingCallsError);
  expect((failure as LspIncomingCallsError).calls.map((call) => [call.file, call.line])).toEqual([["caller.ts", 5]]);
  expect((failure as Error).message).toContain("second item failed");
  await session.shutdown();
});

it("keeps successful server evidence when another language server is unavailable", async () => {
  const {root, scan} = fixture("ok", true);
  const path = join(root, ".codeindex/lsp.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.servers[1].env.MODE = "crash";
  writeFileSync(path, JSON.stringify(config));
  const answer = await callersWithLsp(scan, root, "target", {callers: [{file: "caller.ts", line: 6}]});
  expect(answer.lsp?.ok).toBe(false);
  expect(answer.lsp?.reason).toMatch(/py:.*exited/);
  expect(answer.lsp?.calls.map((call) => call.file)).toEqual(["caller.ts"]);
  expect(answer.lsp?.agreement).toEqual({both: ["caller.ts"], lspOnly: [], staticOnly: []});
});

it("treats no prepared item as an empty result and never requests an unsupported capability", async () => {
  for (const supported of [true, false]) {
    const methods: string[] = [];
    const session = await openLspSession(transportFor((message) => {
      methods.push(message.method!);
      if (message.method === "initialize") return {capabilities: {callHierarchyProvider: supported}};
      return null;
    }), {root: "/repo"});
    expect(await session.incomingCalls("target.ts", 1, 0)).toEqual([]);
    expect(methods.includes("textDocument/prepareCallHierarchy")).toBe(supported);
    expect(methods).not.toContain("callHierarchy/incomingCalls");
    await session.shutdown();
  }
});

it("queries references for cross-language homonyms through each matching server", async () => {
  const {root, scan} = fixture("ok", true);
  const statik = findReferences(scan, "target");
  expect(statik.defs.map((def) => def.lang).sort()).toEqual(["python", "typescript"]);
  const answer = await referencesWithLsp(scan, root, "target", statik);
  expect(answer.lsp?.ok).toBe(true);
  expect(answer.lsp?.refs.map((ref) => ref.file)).toEqual(["caller.py", "caller.ts"]);
  expect(answer.defs).toBe(statik.defs);
  expect(answer.callSites).toBe(statik.callSites);
  expect(answer.referencingFiles).toBe(statik.referencingFiles);
});
