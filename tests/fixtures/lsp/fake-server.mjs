// A language server that is not one.
//
// It speaks the same Content-Length framing over stdio as a real one and
// answers from a static table, so the whole spawn → initialize → didOpen →
// references → shutdown path is exercised by the REAL spawnLspTransport with
// no language server installed anywhere. Same doctrine as tests/endpoint.test.ts,
// which starts a real HTTP server in-process rather than mocking fetch.
//
// FAKE_LSP_MODE selects a failure to rehearse:
//   ok       (default) answer normally
//   nocaps   initialize succeeds but advertises no referencesProvider
//   hang     accept initialize, then never answer anything again
//   crash    exit non-zero right after initialize
//   garbage  emit an unframed log line before each real frame
//   slow     delay every reply past a short per-request budget
//
// FAKE_LSP_REFS is a JSON array of {file, line, character} the server reports,
// relative to FAKE_LSP_ROOT.

const MODE = process.env.FAKE_LSP_MODE ?? "ok";
const ROOT = process.env.FAKE_LSP_ROOT ?? process.cwd();
const REFS = JSON.parse(process.env.FAKE_LSP_REFS ?? "[]");

const encoder = new TextEncoder();

function send(message) {
  const body = JSON.stringify(message);
  // Byte length, not string length — the same trap the client codec has to
  // avoid, and the fixture has to get it right for the test to mean anything.
  const length = encoder.encode(body).byteLength;
  if (MODE === "garbage") process.stdout.write("[info] a stray log line with no frame around it\n");
  process.stdout.write(`Content-Length: ${length}\r\n\r\n${body}`);
}

const reply = (id, result) => {
  if (MODE === "slow") setTimeout(() => send({ jsonrpc: "2.0", id, result }), 3000).unref?.();
  else send({ jsonrpc: "2.0", id, result });
};

const fileUri = (rel) =>
  "file://" +
  `${ROOT.replace(/\/+$/, "")}/${rel}`
    .split("/")
    .map((segment, i) => (i === 0 ? segment : encodeURIComponent(segment)))
    .join("/");

let buffer = Buffer.alloc(0);
let initialized = false;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("utf8"));
    if (!match) {
      buffer = buffer.subarray(end + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
    buffer = buffer.subarray(end + 4 + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    handle(message);
  }
});

function handle(message) {
  const { id, method } = message;
  if (method === "initialize") {
    initialized = true;
    const capabilities =
      MODE === "nocaps"
        ? { hoverProvider: true }
        : { referencesProvider: true, definitionProvider: true, implementationProvider: { workDoneProgress: false } };
    reply(id, { capabilities, serverInfo: { name: "fake-lsp", version: "1.0.0" } });
    return;
  }
  if (!initialized) return;
  if (MODE === "hang") return; // accepted, never answered
  // Die on the first real question rather than on a timer: a timer races the
  // client and makes the test flaky in the direction that hides the bug.
  if (MODE === "crash" && method !== "exit") process.exit(3);

  if (method === "textDocument/references" || method === "textDocument/definition") {
    reply(
      id,
      REFS.map((ref) => ({
        uri: fileUri(ref.file),
        // LSP is 0-based; the fixture is written in the engine's 1-based lines
        // so the test data reads like the source it describes.
        range: { start: { line: ref.line - 1, character: ref.character ?? 0 }, end: { line: ref.line - 1, character: (ref.character ?? 0) + 1 } },
      })),
    );
    return;
  }
  if (method === "shutdown") {
    reply(id, null);
    return;
  }
  if (method === "exit") process.exit(0);
}

// A server whose stdin closes has no client left.
process.stdin.on("end", () => process.exit(0));
