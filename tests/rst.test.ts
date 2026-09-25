import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractRst } from "../src/extract/rst.js";
import { buildIndexArtifacts } from "../src/pipeline.js";

// Sphinx docs used to be indexed under their file name only: no title, no
// headings, no summary, no links (all 79 of flask's).

const refs = (rel: string, src: string) => extractRst(rel, src).refs.map((r) => `${r.soft ? "~" : ""}${r.spec}`);

describe("extractRst: titles, headings and the summary", () => {
  const doc = [
    ".. rst-class:: hide-header", // a directive before the title
    "",
    "=====================",
    "Application Factories",
    "=====================",
    "",
    ".. image:: _static/logo.svg",
    "    :align: center",
    "",
    "If you already use :doc:`/blueprints`, there are ``better`` ways. More text",
    "follows on the next line.",
    "",
    "Basic Factories",
    "---------------",
    "",
    "A later paragraph is not the summary.",
    "",
    "Using ``create_app``",
    "~~~~~~~~~~~~~~~~~~~~",
  ].join("\n");

  it("reads over- and underlined titles, first one as the title", () => {
    const info = extractRst("docs/patterns/appfactories.rst", doc);
    expect(info.title).toBe("Application Factories");
    expect(info.headings).toEqual(["Application Factories", "Basic Factories", "Using create_app"]);
  });

  it("takes the first sentence of the intro, inline markup reduced to text", () => {
    expect(extractRst("a.rst", doc).summary).toBe("If you already use blueprints, there are better ways.");
  });

  it("does not take a heading, a field list, a list or a lead-in as the summary", () => {
    const src = [
      ":orphan:",
      "",
      "Title",
      "=====",
      "",
      "Here are the steps:",
      "",
      "- one step",
      "",
      "Section",
      "-------",
      "",
      "Belongs to the section.",
    ].join("\n");
    const info = extractRst("b.rst", src);
    expect(info.summary).toBeUndefined();
    expect(info.headings).toEqual(["Title", "Section"]);
  });

  it("does not read markup lines under a paragraph as underlines", () => {
    // `::` introduces a literal block; the block's own `====` table border and
    // its fake title are code, not a section.
    const src = ["Title", "=====", "", "An example::", "", "    Fake", "    ====", "", "Done here."].join("\n");
    expect(extractRst("c.rst", src).headings).toEqual(["Title"]);
  });
});

describe("extractRst: doc links", () => {
  it("reads toctree entries, :doc: roles and includes, relative to the file", () => {
    const src = [
      "Guide",
      "=====",
      "",
      "Start with :doc:`installation`, then :doc:`the tutorial <tutorial/index>`.",
      "See :doc:`Werkzeug's client <werkzeug:test>` too.", // intersphinx: not a file
      "",
      ".. toctree::",
      "   :maxdepth: 2",
      "   :caption: Contents",
      "",
      "   quickstart",
      "   API reference <api>",
      "   self",
      "   https://example.com/external",
      "   patterns/*",
      "",
      ".. note::",
      "   Also read :doc:`config`.",
      "",
      ".. code-block:: rst",
      "",
      "   Not a link: :doc:`example`.",
      "",
      ".. include:: ../CHANGES.rst",
      ".. literalinclude:: ../examples/app.py",
      "   :language: python",
      "",
      "Literal::",
      "",
      "   :doc:`also-not-a-link`",
    ].join("\n");
    expect(refs("docs/index.rst", src)).toEqual([
      "installation.rst",
      "tutorial/index.rst",
      "quickstart.rst",
      "api.rst",
      "config.rst",
      "../CHANGES.rst",
      "../examples/app.py",
    ]);
  });

  it("tries each ancestor as the source root for an absolute document name", () => {
    // `/patterns/javascript` is relative to the Sphinx source directory, which
    // only conf.py's location says: every ancestor is a candidate, and only
    // the one that exists becomes an edge.
    expect(refs("docs/patterns/jquery.rst", "Obsolete, see :doc:`/patterns/javascript` instead.")).toEqual([
      "~patterns/javascript.rst",
      "~../patterns/javascript.rst",
      "~../../patterns/javascript.rst",
    ]);
  });
});

describe("reStructuredText in a scan and its graph", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-rst-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write("docs/conf.py", "project = 'x'\n");
  write("docs/index.rst", "Welcome\n=======\n\nThe docs.\n\n.. toctree::\n\n   patterns/appfactories\n");
  write(
    "docs/patterns/appfactories.rst",
    "Application Factories\n=====================\n\nBuild the app in a function.\n\nSee :doc:`/index` and :doc:`missing`.\n",
  );

  const { scan, graph } = buildIndexArtifacts(root);

  it("records the title, headings and summary", () => {
    const f = scan.files.find((x) => x.rel === "docs/patterns/appfactories.rst")!;
    expect(f.title).toBe("Application Factories");
    expect(f.headings).toEqual(["Application Factories"]);
    expect(f.summary).toBe("Build the app in a function.");
  });

  it("links documents, resolving an absolute name against the right ancestor", () => {
    const links = graph.fileEdges
      .filter((e) => e.kind === "doc-link")
      .map((e) => `${e.from} -> ${e.to}${e.dangling ? " (dangling)" : ""}`)
      .sort();
    expect(links).toEqual([
      "docs/index.rst -> docs/patterns/appfactories.rst",
      "docs/patterns/appfactories.rst -> docs/index.rst",
      "docs/patterns/appfactories.rst -> missing.rst (dangling)",
    ]);
  });
});
