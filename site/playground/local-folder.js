// Indexing a folder off the user's own disk.
//
// The network path exists because a browser cannot read a repository any other
// way; it is not the point of the playground, and it is the part that breaks —
// one request per file means a few thousand requests for a real monorepo, which
// is enough to trip GitHub's rate limit and lose the whole load. A folder the
// user already has needs none of that.
//
// It also fits the existing pipeline exactly rather than bypassing it. The
// playground's design is "mount a manifest of paths WITH SIZES, let walk()
// choose from sizes alone, only then read bytes" (worker.js, PHASE A/B), and a
// File knows its size without being opened. So a picked folder becomes the same
// manifest a provider returns, walk() applies the same gitignore chains,
// IGNORE_DIRS, lockfile and binary rules, and node_modules is never read rather
// than being read and discarded.
//
// Nothing leaves the machine. There is no upload and no server of ours to
// upload to — the File objects are passed to the worker, which reads them with
// the same FileReader the page would use, and the index is built in memory.

/**
 * Map the files the browser handed back into `{ name, files: [{path, size, file}] }`.
 *
 * The browser reports each file relative to the directory that was picked, so
 * every path starts with that directory's own name — part of the user's disk
 * layout, not of the repository. It is stripped, and doubles as the name shown
 * on the page.
 *
 * @param picked array-like of File (or anything carrying name/size/webkitRelativePath)
 */
export function toManifest(picked) {
  const entries = Array.from(picked ?? []);
  if (!entries.length) throw new Error("That folder has no files in it.");

  const paths = entries.map((file) => segmentsOf(file));

  // A picked directory is the case where every entry sits under one shared
  // first segment. Anything else — a plain multi-file selection, or a drop of
  // several folders — has no root to strip, and stripping a "common" one there
  // would eat a directory that is genuinely part of the tree.
  const roots = new Set(paths.map((segments) => segments[0]));
  const rooted = roots.size === 1 && paths.every((segments) => segments.length > 1);
  const name = rooted ? [...roots][0] : "local files";

  return {
    name,
    files: entries.map((file, index) => ({
      path: `/${(rooted ? paths[index].slice(1) : paths[index]).join("/")}`,
      size: file.size,
      file,
    })),
  };
}

/**
 * The path a File reports, as segments. `webkitRelativePath` is what a folder
 * pick fills in; a plain file pick leaves it empty and only the name is known.
 */
const segmentsOf = (file) =>
  (file.webkitRelativePath || file.name || "")
    .split("/")
    .filter(Boolean);
