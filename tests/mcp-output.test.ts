import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OUTPUT_SCHEMAS, structuredContentFor, toolsFor } from "../src/mcp.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

// A JSON Schema checker covering exactly the keywords OUTPUT_SCHEMAS uses:
// type (incl. array-of-type), properties, required, items, oneOf, enum,
// additionalProperties-as-schema. Deliberately hand-rolled — the engine has no
// runtime dependencies and its test suite adds none either. Returns the first
// failure path, or undefined.
function validate(schema: Record<string, unknown>, value: unknown, path = "$"): string | undefined {
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as Record<string, unknown>[];
    const failures = branches.map((b) => validate(b, value, path));
    if (failures.some((f) => f === undefined)) return undefined;
    return `${path}: matched none of ${branches.length} oneOf branches (${failures.join(" | ")})`;
  }
  const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types) {
    const actual =
      value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    const ok = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) return `${path}: expected ${types.join("|")}, got ${actual}`;
  }
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    return `${path}: ${JSON.stringify(value)} not in enum`;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) return `${path}.${key}: required but missing`;
    }
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj && Object.keys(sub).length) {
        const err = validate(sub, obj[key], `${path}.${key}`);
        if (err) return err;
      }
    }
    const extra = schema.additionalProperties;
    if (extra && typeof extra === "object") {
      for (const [key, v] of Object.entries(obj)) {
        if (key in props) continue;
        const err = validate(extra as Record<string, unknown>, v, `${path}.${key}`);
        if (err) return err;
      }
    }
  }
  if (Array.isArray(value) && schema.items && Object.keys(schema.items).length) {
    for (let i = 0; i < value.length; i++) {
      const err = validate(schema.items as Record<string, unknown>, value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  return undefined;
}

// One server session, driven over the real stdio transport.
async function session(calls: { name: string; arguments: Record<string, unknown> }[], version: string) {
  const proc = spawn("node", [CLI, "mcp", "--repo", REPO], { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  let buf = "";
  proc.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as { id: number };
        pending.get(m.id)?.(m as unknown as Record<string, unknown>);
        pending.delete(m.id);
      } catch {
        /* not a response line */
      }
    }
  });
  let id = 0;
  const call = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
    });
  try {
    await call("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const tools = ((await call("tools/list", {})) as { result: { tools: Record<string, unknown>[] } }).result.tools;
    const results: Record<string, Record<string, unknown>> = {};
    for (const c of calls) {
      results[c.name] = ((await call("tools/call", { name: c.name, arguments: c.arguments })) as { result: Record<string, unknown> })
        .result;
    }
    return { tools, results };
  } finally {
    proc.kill();
  }
}

// Every tool that DECLARES an outputSchema, with arguments that exercise it.
// Kept beside OUTPUT_SCHEMAS on purpose: a schema added without a case here
// fails the coverage test below rather than shipping unvalidated.
const CASES: Record<string, Record<string, unknown>> = {
  scan_summary: {},
  graph: {},
  symbols: {},
  callers: {},
  workspaces: {},
  churn: {},
  find_references: { name: "HttpClient" },
  explain_search: { query: "http client retry" },
  lsp_status: {},
  call_graph: { symbol: "HttpClient", depth: 1 },
  hotspots: {},
  coupling: {},
  duplicated_literals: {},
  embed_status: {},
  write_memory: { name: "schema-probe", content: "x" },
  delete_memory: { name: "schema-probe" },
  // The three symbolic edits share a schema and would mutate the fixture, so
  // they are validated against their shared shape in a unit test below instead.
  replace_symbol_body: {},
  insert_after_symbol: {},
  insert_before_symbol: {},
};

const EDIT_TOOLS = ["replace_symbol_body", "insert_after_symbol", "insert_before_symbol"];

describe("outputSchema / structuredContent", () => {
  it("declares a schema for exactly the tools whose response is always an object", async () => {
    const { tools } = await session([], "2025-11-25");
    const declared = tools.filter((t) => t.outputSchema).map((t) => t.name as string);
    expect(declared.sort()).toEqual(Object.keys(OUTPUT_SCHEMAS).sort());
    // The tools deliberately left out: array responses, argument-dependent
    // shapes, and plain text. Pinned so a future "just add a schema" does not
    // silently start emitting a structuredContent that cannot conform.
    for (const name of ["symbols_overview", "find_symbol", "grep", "check_rules", "list_memories", "dead_code", "complexity", "search", "repo_map", "mermaid", "read_memory"]) {
      expect(OUTPUT_SCHEMAS[name], name).toBeUndefined();
    }
  }, 60_000);

  it("every declared schema has a case exercising it", () => {
    expect(Object.keys(OUTPUT_SCHEMAS).sort()).toEqual(Object.keys(CASES).sort());
  });

  it("validates the REAL response of every schema-declaring tool", async () => {
    const names = Object.keys(CASES).filter((n) => !EDIT_TOOLS.includes(n));
    const { results } = await session(
      names.map((name) => ({ name, arguments: CASES[name]! })),
      "2025-11-25",
    );
    for (const name of names) {
      const res = results[name]!;
      expect(res.isError, `${name} errored: ${JSON.stringify(res.content)}`).not.toBe(true);
      const structured = res.structuredContent as Record<string, unknown> | undefined;
      expect(structured, `${name} must carry structuredContent`).toBeDefined();
      // The spec asks the text block to be the serialization of the structured
      // result — assert it, rather than letting the two drift.
      const text = (res.content as { type: string; text: string }[])[0]!.text;
      expect(JSON.parse(text), `${name}: text and structuredContent disagree`).toEqual(structured);
      const err = validate(OUTPUT_SCHEMAS[name]!, structured);
      expect(err, `${name}: ${err}`).toBeUndefined();
    }
  }, 120_000);

  it("sends neither schema nor structuredContent to a 2024-11-05 client", async () => {
    const { tools, results } = await session([{ name: "scan_summary", arguments: {} }], "2024-11-05");
    expect(tools.every((t) => t.outputSchema === undefined)).toBe(true);
    expect(results.scan_summary!.structuredContent).toBeUndefined();
  }, 60_000);
});

describe("structuredContentFor", () => {
  it("returns the parsed object for a schema-declaring tool", () => {
    expect(structuredContentFor('{"a":1}', false, true)).toEqual({ a: 1 });
  });

  it("stays silent when the response was capped — the notice would not conform", () => {
    expect(structuredContentFor('{"truncated":true}', true, true)).toBeUndefined();
  });

  it("stays silent without a declared schema", () => {
    expect(structuredContentFor('{"a":1}', false, false)).toBeUndefined();
  });

  it("refuses arrays and non-JSON: structuredContent is specified as an object", () => {
    expect(structuredContentFor("[1,2]", false, true)).toBeUndefined();
    expect(structuredContentFor("not json", false, true)).toBeUndefined();
    expect(structuredContentFor("null", false, true)).toBeUndefined();
  });
});

describe("the symbolic edits share one result shape", () => {
  it("validates an EditResult against the declared schema", () => {
    const sample = { file: "src/client.ts", symbol: "HttpClient", startLine: 5, endLine: 9 };
    for (const name of EDIT_TOOLS) {
      expect(validate(OUTPUT_SCHEMAS[name]!, sample), name).toBeUndefined();
    }
  });

  it("the schema is the same object shape for all three", () => {
    const [a, b, c] = EDIT_TOOLS.map((n) => JSON.stringify(OUTPUT_SCHEMAS[n]));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

describe("toolsFor gates outputSchema on the negotiated version", () => {
  it("withholds it below 2025-06-18 and includes it at or above", () => {
    const below = toolsFor(undefined, "2025-03-26") as { name: string; outputSchema?: unknown }[];
    expect(below.every((t) => t.outputSchema === undefined)).toBe(true);
    for (const version of ["2025-06-18", "2025-11-25"]) {
      const at = toolsFor(undefined, version) as { name: string; outputSchema?: unknown }[];
      expect(at.filter((t) => t.outputSchema).length, version).toBe(Object.keys(OUTPUT_SCHEMAS).length);
    }
  });
});
