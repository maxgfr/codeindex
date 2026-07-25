// MCP wire concerns: protocol-version negotiation, argument validation, and the
// response-size guard. Everything here is a pure function of its inputs — no
// scan, no filesystem beyond checking whether a persisted artifact exists — so
// it is unit-testable without standing up a server.
import { existsSync } from "node:fs";
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
// boolean / array-of-string) — this is a guard against silent misreads, not a
// JSON Schema implementation. The spec (2025-11-25) is explicit that input
// validation failures belong in a Tool Execution Error, not a protocol error,
// precisely so the model can read the message and retry.
// Required-ness stays with callTool, which raises tool-specific messages
// ("`rules` (or `configPath`) is required"); duplicating it here would only let
// the two drift.
export function validateArgs(
  schema: { properties?: Record<string, unknown> },
  args: Record<string, unknown>,
): string | undefined {
  const props = (schema.properties ?? {}) as Record<string, { type?: string; items?: { type?: string } }>;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const spec = props[key];
    if (!spec?.type) continue; // undeclared extras stay tolerated
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (spec.type === "number") {
      // A numeric string is accepted (num() coerces it); anything else is not.
      if (actual === "number") continue;
      if (actual === "string" && Number.isFinite(Number(value as string)) && (value as string).trim() !== "") continue;
      return `\`${key}\` must be a number, got ${actual === "string" ? JSON.stringify(value) : actual}`;
    }
    if (spec.type === "array") {
      if (actual !== "array") return `\`${key}\` must be an array of strings, got ${actual}`;
      if (spec.items?.type === "string" && !(value as unknown[]).every((x) => typeof x === "string")) {
        return `\`${key}\` must be an array of strings`;
      }
      continue;
    }
    if (actual !== spec.type) return `\`${key}\` must be a ${spec.type}, got ${actual}`;
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
//     is a different shape and would not conform,
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
// disk, and which narrower tool answers the question.
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

// What to steer a caller toward when their whole-repo request is too large.
const NARROWER: Record<string, string> = {
  graph: "pass `scope` to a subdirectory, or use repo_map / mermaid for an overview",
  symbols: "pass `name` to look up one symbol, or use find_symbol / symbols_overview",
  callers: "pass `name` to look up one symbol's call sites",
  dead_code: "pass `scope` to a subdirectory",
  find_references: "the symbol is referenced very widely — narrow with `scope` on a graph query",
  check_rules: "narrow the rule set, or pass `scope` to a subdirectory",
};

// The persisted artifact backing a tool, when a `codeindex index` already wrote
// one — far more useful to hand back than a truncated blob.
const ARTIFACT_FOR: Record<string, string> = { graph: "graph.json", symbols: "symbols.json" };

export function capResponse(text: string, tool: string, repo: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const artifact = ARTIFACT_FOR[tool] ? join(repo, INDEX_DIR, ARTIFACT_FOR[tool]!) : undefined;
  return (
    JSON.stringify(
      {
        truncated: true,
        tool,
        bytes,
        maxBytes,
        reason:
          "This response exceeds the configured limit and was withheld rather than sent as an unusable partial payload.",
        narrower: NARROWER[tool] ?? "narrow the request with `scope`, `include`/`exclude`, or a `limit`",
        ...(artifact && existsSync(artifact)
          ? { artifact, artifactNote: "The full result is already on disk here — read it directly if you need all of it." }
          : artifact
            ? { artifactNote: `Run \`codeindex index --repo ${repo} --out ${join(repo, INDEX_DIR)}\` to get this as a file.` }
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
