// `node:url` for the browser build. Only fileURLToPath/pathToFileURL are used,
// and only to locate module-adjacent directories.
//
// In the browser `import.meta.url` is an https: URL, so fileURLToPath would
// throw on it. It never gets the chance: resolveGrammarsTier checks
// CODEINDEX_GRAMMAR_DIR and returns before reaching the module-relative probe
// (ast/loader.ts:106-112), and the playground always sets that variable. This
// shim degrades to the URL's pathname rather than throwing, so that ordering is
// a belt-and-braces guarantee instead of a load-bearing one.

export function fileURLToPath(url: string | URL): string {
  const href = typeof url === "string" ? url : url.href;
  try {
    return decodeURIComponent(new URL(href).pathname);
  } catch {
    return href;
  }
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${path.startsWith("/") ? "" : "/"}${path}`);
}

export { URL, URLSearchParams };

export default { fileURLToPath, pathToFileURL, URL, URLSearchParams };
