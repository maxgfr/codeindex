// MCP wire concerns: protocol-version negotiation, argument validation, and the
// response-size guard. Everything here is a pure function of its inputs — no
// scan, no filesystem beyond checking whether a persisted artifact exists — so
// it is unit-testable without standing up a server.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { INDEX_DIR } from "../preload.js";

// --- protocol versions -------------------------------------------------------
// The server announced "2024-11-05" hard-coded and never even read the version
// the client asked for. Three revisions have shipped since.
//
// Negotiation is what makes moving forward non-breaking: a client that asks for
// an old revision gets that revision, and every field introduced later is
// withheld — so its responses are exactly the bytes it received before. Newer
// clients opt themselves in simply by asking.
//
// Dates sort lexicographically, so `>=` on the strings is a version comparison.
export const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] as const;
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1]!;

// Feature floors, by the revision that introduced them.
export const ANNOTATIONS_SINCE = "2025-03-26"; // tool behaviour hints
export const RICH_TOOLS_SINCE = "2025-06-18"; // Tool.title, resource_link content

// Validate `arguments` against the tool's declared inputSchema.
//
// There was no validation at all beyond presence checks, and the readers failed
// silently in both directions: str() returns undefined for a non-string, so a
// number where a path belongs became "missing", and every boolean was `=== true`,
// so `"false"` and `1` alike read as false. The caller saw its option ignored
// with no way to tell why.
//
// Only the shapes these schemas actually use are checked (string / number /
// boolean / array / array-of-string, and a string `enum`) — this is a guard
// against silent misreads, not a JSON Schema implementation. The spec (2025-11-25) is explicit that input
// validation failures belong in a Tool Execution Error, not a protocol error,
// precisely so the model can read the message and retry.
//
// The declared `required` list is checked here too, because this runs BEFORE
// the call walks and scans the repo: a missing `namePath` used to be reported
// only after a full walk (13.5 s for the first call on a 66k-file repo).
// Requirements a schema cannot express — `rules` or `configPath`, `lsp` needing
// `name` — stay with callTool and its tool-specific messages.
export function validateArgs(
  schema: { properties?: Record<string, unknown>; required?: readonly string[] },
  args: Record<string, unknown>,
): string | undefined {
  const props = (schema.properties ?? {}) as Record<string, {
    type?: string;
    items?: { type?: string };
    minimum?: number;
    maximum?: number;
    enum?: readonly unknown[];
    description?: string;
  }>;
  for (const key of schema.required ?? []) {
    if (args[key] !== undefined && args[key] !== null) continue;
    const description = props[key]?.description;
    return description ? `\`${key}\` is required (${description})` : `\`${key}\` is required`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const spec = props[key];
    if (!spec?.type) continue; // undeclared extras stay tolerated
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (spec.type === "number") {
      // A numeric string is accepted (num() coerces it); anything else is not.
      const numeric = actual === "number"
        ? value as number
        : actual === "string" && (value as string).trim() !== ""
          ? Number(value as string)
          : NaN;
      if (!Number.isFinite(numeric)) {
        return `\`${key}\` must be a number, got ${actual === "string" ? JSON.stringify(value) : actual}`;
      }
      if (spec.minimum !== undefined && numeric < spec.minimum) return `\`${key}\` must be at least ${spec.minimum}`;
      if (spec.maximum !== undefined && numeric > spec.maximum) return `\`${key}\` must be at most ${spec.maximum}`;
      continue;
    }
    if (spec.type === "array") {
      // "of strings" only where the schema says so: check_rules' `rules` is an
      // array of objects, and telling the caller otherwise sent it astray.
      const strings = spec.items?.type === "string";
      const expected = strings ? "an array of strings" : "an array";
      if (actual !== "array") return `\`${key}\` must be ${expected}, got ${actual}`;
      if (strings && !(value as unknown[]).every((x) => typeof x === "string")) return `\`${key}\` must be ${expected}`;
      continue;
    }
    if (actual !== spec.type) return `\`${key}\` must be a ${spec.type}, got ${actual}`;
    // `direction: "sideways"` used to become "both", and `rank: "pagerank"`
    // lexical, with nothing in the answer to say the option was not understood.
    if (spec.enum && !spec.enum.includes(value)) {
      return `\`${key}\` must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(", ")}, got ${JSON.stringify(value)}`;
    }
  }
  return undefined;
}

// The structuredContent for a tool response, or undefined when there must not
// be one.
//
// Emitted only when ALL of these hold, because the spec requires a declared
// outputSchema to be honoured by every structured result:
//   * the tool declares an outputSchema (see OUTPUT_SCHEMAS),
//   * the response was NOT replaced by the size guard — the truncation notice
//     is a different shape and would not conform (it is sent with isError,
//     which is what exempts it from the schema),
//   * the text parses to a JSON object (never an array: structuredContent is
//     specified as an object).
// The text block is left exactly as it was, so this is purely additive and
// content stays the serialization of structuredContent, as the spec asks.
export function structuredContentFor(text: string, capped: boolean, hasSchema: boolean): Record<string, unknown> | undefined {
  if (capped || !hasSchema) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

export function negotiateProtocol(requested: unknown): string {
  return typeof requested === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL;
}

// --- response size guard -----------------------------------------------------
// Several tools returned unbounded payloads. On facebook/react (7091 files):
// graph 9.4 MB, symbols 6.3 MB, callers 6.0 MB, dead_code 771 KB — roughly
// 2.35M, 1.57M, 1.51M and 193k tokens. A single `graph` call does not merely
// bloat an agent's context, it exceeds what any MCP client can accept, so the
// call fails and the turn is wasted.
//
// The guard is deliberately NOT a default page size: below the limit a response
// is byte-identical to what it always was. Above it, the response could not be
// consumed by any client anyway, so replacing it with something actionable
// cannot regress a working call — it converts a hard failure into a usable
// answer that says how big the payload is, where the artifact already sits on
// disk, and which narrower tool answers the question. The server sends that
// notice as a tool execution error (isError): the model reads it and retries
// narrower, and a client validating against the tool's outputSchema skips it.
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

// What to steer a caller toward when their request is too large, in the
// arguments THAT tool takes: a generic "pass a `limit`" sent find_symbol
// callers after an argument that does not exist (it takes `maxResults`).
// tests/mcp.test.ts checks every backticked name here against the tool's own
// inputSchema, so a hint cannot drift from the schema it points into.
const NARROWER: Record<string, string> = {
  graph: "pass `scope` to a subdirectory (or `include`/`exclude` globs), or use repo_map / mermaid for an overview",
  symbols: "pass `name` to look up one symbol, or `concise` for locations only; find_symbol / symbols_overview answer narrower questions",
  callers: "pass `name` to look up one symbol's call sites, or `concise` for locations only",
  dead_code: "pass a `limit`, or `scope` to a subdirectory",
  duplicated_literals: "pass a `limit`, raise `minFiles`/`minCount`, or pass `scope` to a subdirectory",
  find_references: "the symbol is referenced very widely — pass `concise`, or ask callers for the call sites alone",
  find_symbol: "lower `maxResults`, or drop `includeBody`/pass `concise`",
  symbols_overview: "the file declares a great many symbols — pass `concise`",
  grep: "lower `maxHits`, or restrict with `globs` or `scope`",
  search: "lower `limit`, or pass `scope` to a subdirectory",
  explain_search: "lower `limit`, or pass `scope` to a subdirectory",
  complexity: "lower `top`, or pass one `file`",
  call_graph: "lower `depth`, or follow one `direction`",
  type_hierarchy: "pass `name` to look up one type",
  mermaid: "lower `maxEdges`, or focus on one `module`",
  repo_map: "lower `budgetTokens`",
  onboard: "lower `budgetTokens`",
  hotspots: "pass `since` to count recent history only",
  churn: "pass `since` to count recent history only",
  coupling: "pass `since` to mine recent history only",
  check_rules: "narrow the rule set, or pass `scope` to a subdirectory",
};

// The persisted artifact that can BE a tool's answer, when `codeindex index`
// wrote one — far more useful to hand back than a truncated blob.
const ARTIFACT_FOR: Record<string, string> = { graph: "graph.json", symbols: "symbols.json" };

// Whether the artifact on disk holds exactly the withheld payload.
//
// It was offered whenever the file EXISTED: after an edit since the last
// `codeindex index` the notice said "the full result is already on disk"
// about a symbols.json that lacked the new symbol. Only byte equality proves
// the claim (the persisted rendering may end in one extra newline). The size
// check keeps a stale artifact to one stat; the read happens only on a size
// match, and only for a response already too large to send.
function artifactState(path: string, text: string, bytes: number): "identical" | "stale" | "absent" {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "absent";
  }
  if (size !== bytes && size !== bytes + 1) return "stale";
  try {
    const disk = readFileSync(path, "utf8");
    return disk === text || disk === text + "\n" ? "identical" : "stale";
  } catch {
    return "absent";
  }
}

// `wholeRepo` is false for a request the artifact cannot answer however
// fresh it is — a `scope`d graph, one symbol's entry, a concise projection —
// and then no artifact is mentioned at all.
export function capResponse(text: string, tool: string, repo: string, maxBytes: number, wholeRepo = true): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const artifactName = wholeRepo && Object.hasOwn(ARTIFACT_FOR, tool) ? ARTIFACT_FOR[tool] : undefined;
  const artifact = artifactName ? join(repo, INDEX_DIR, artifactName) : undefined;
  const state = artifact ? artifactState(artifact, text, bytes) : undefined;
  const refresh = `codeindex index --repo ${repo} --out ${join(repo, INDEX_DIR)}`;
  return (
    JSON.stringify(
      {
        truncated: true,
        tool,
        bytes,
        maxBytes,
        reason:
          "This response exceeds the configured limit and was withheld rather than sent as an unusable partial payload.",
        narrower: Object.hasOwn(NARROWER, tool)
          ? NARROWER[tool]
          : "narrow the request with the arguments this tool's inputSchema offers",
        ...(state === "identical"
          ? { artifact, artifactNote: "The full result is on disk here, byte-for-byte what this call would have returned — read it directly if you need all of it." }
          : state === "stale"
            ? { artifactNote: `The artifact at ${artifact} does not match this answer (the repository changed since it was written, or it was indexed with other options). Run \`${refresh}\` to refresh it, then read it.` }
            : state === "absent"
              ? { artifactNote: `Run \`${refresh}\` to get this as a file.` }
              : {}),
      },
      null,
      2,
    ) + "\n"
  );
}

// When capResponse withheld a payload AND the artifact is on disk, hand the
// client a resource_link to it. Returns undefined for every normal response —
// this only ever adds a second content block to a capped one.
export function resourceLinkFor(text: string, tool: string): Record<string, unknown> | undefined {
  const artifactName = ARTIFACT_FOR[tool];
  if (!artifactName) return undefined;
  let parsed: { truncated?: boolean; artifact?: string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return undefined; // a normal (non-JSON, or non-capped) response
  }
  if (parsed.truncated !== true || typeof parsed.artifact !== "string") return undefined;
  return {
    type: "resource_link",
    uri: pathToFileURL(parsed.artifact).href,
    name: artifactName,
    description: `The full ${tool} result this call was too large to inline.`,
    mimeType: "application/json",
  };
}
