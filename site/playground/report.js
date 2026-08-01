// Turns a finished load into the numbers the page shows.
//
// Split out of worker.js for the same reason commands.js is: it reads a dozen
// field names off the engine's artifacts, and getting one wrong does not throw
// — it renders "undefined" in a stat tile. That is exactly how `graph.edges`
// (the field is `fileEdges`) survived review here, so this is covered by
// tests/playground-commands.test.ts against a real index.

/**
 * @param engine   the browser engine bundle
 * @param loaded   { owner, repo, ref, artifacts, grammars }
 * @param counters { manifestFiles, walkedFiles, excluded, selected, pruned, unreadable, capped, cappedBy, elapsedMs }
 */
export function summariseIndex(engine, loaded, counters) {
  const { artifacts } = loaded;
  return {
    owner: loaded.owner,
    repo: loaded.repo,
    ref: loaded.ref,
    engineVersion: engine.ENGINE_VERSION,

    // How to name this index on screen. A repository has an owner and a ref
    // worth showing; a folder off the user's disk has neither, and rendering
    // it through the same template produced "/my-repo@".
    label: loaded.owner ? `${loaded.owner}/${loaded.repo}@${loaded.ref}` : loaded.repo,
    sourceLabel: { github: "the GitHub trees API", local: "the folder you opened", jsdelivr: "jsDelivr" }[counters.provider] ?? counters.provider,

    // What the manifest offered, what the walk kept, what actually got indexed.
    // Reported as three separate numbers because they are three different
    // things, and collapsing them is how a cap becomes invisible.
    manifestFiles: counters.manifestFiles,
    walkedFiles: counters.walkedFiles,
    selectedFiles: counters.selected,
    indexedFiles: artifacts.graph.files.length,
    excluded: counters.excluded,
    pruned: counters.pruned,
    unreadable: counters.unreadable,
    capped: counters.capped,
    cappedBy: counters.cappedBy,

    // Which provider answered, and any caveat that comes with it. Named rather
    // than hidden: an index built from jsDelivr's branch snapshot is not the
    // same thing as one built from the GitHub tree, and the page should say so.
    provider: counters.provider ?? "",
    providerNote: counters.providerNote ?? "",

    elapsedMs: counters.elapsedMs,
    residentBytes: engine.residentBytes(),

    symbolCount: Object.keys(artifacts.symbols.defs).length,
    edgeCount: artifacts.graph.fileEdges.length,
    moduleEdgeCount: artifacts.graph.moduleEdges.length,
    moduleCount: artifacts.graph.modules.length,
    languages: artifacts.graph.languages ?? {},

    grammars: loaded.grammars,
  };
}
