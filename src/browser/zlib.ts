// `node:zlib` for the browser build. Reachable only from ast/grammars-pull.ts,
// which is stubbed: the browser fetches individual .wasm files over HTTP rather
// than unpacking a release tarball, so there is nothing to gunzip.
//
// Note for anyone extending this: the browser has DecompressionStream("gzip")
// natively, so a real implementation is available — it is just asynchronous,
// while gunzipSync is not. Any future use should call DecompressionStream
// directly at an async boundary instead of trying to make this synchronous.

export function gunzipSync(): never {
  throw new Error("zlib.gunzipSync is not available in the browser build (use DecompressionStream at an async boundary)");
}

export function gzipSync(): never {
  throw new Error("zlib.gzipSync is not available in the browser build");
}

export default { gunzipSync, gzipSync };
