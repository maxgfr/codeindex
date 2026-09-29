import { describe, expect, it } from "vitest";
import { extractMarkdown } from "../src/extract/markdown.js";

const specs = (md: string) => extractMarkdown(md).refs.map((r) => r.spec);

describe("extractMarkdown: setext headings", () => {
  const md = [
    "Setext Title",
    "============",
    "",
    "Intro paragraph about the project.",
    "",
    "Sub Setext",
    "----------",
    "",
    "Body of the section.",
  ].join("\n");

  it("reads `===` as a level-1 heading and `---` as a level-2 one", () => {
    const info = extractMarkdown(md);
    expect(info.headings).toEqual(["Setext Title", "Sub Setext"]);
    expect(info.title).toBe("Setext Title");
  });

  it("takes the summary from the intro, not from the heading text", () => {
    // The title line used to be the first prose line, so it was the summary.
    expect(extractMarkdown(md).summary).toBe("Intro paragraph about the project.");
  });

  it("does not read a thematic break as an underline", () => {
    for (const before of ["", "- a list item", "> a quote", "    indented code"]) {
      expect(extractMarkdown(`Intro text here.\n\n${before}\n---\n`).headings).toEqual([]);
    }
  });

  it("keeps a front-matter title over a setext one", () => {
    const info = extractMarkdown('---\ntitle: "Front"\n---\nSetext\n======\n\nText of the intro.\n');
    expect(info.title).toBe("Front");
    expect(info.headings).toEqual(["Setext"]);
  });

  it("reads an ATX heading indented up to three spaces", () => {
    expect(extractMarkdown("   ## Indented\n").headings).toEqual(["Indented"]);
  });
});

describe("extractMarkdown: code blocks", () => {
  it("ignores links in an indented code block", () => {
    const md = ["Intro.", "", "    # not a heading", "    [indented](docs/indented.md)", "", "[real](docs/real.md)"].join("\n");
    expect(specs(md)).toEqual(["docs/real.md"]);
    expect(extractMarkdown(md).headings).toEqual([]);
  });

  it("reads an indented continuation of a list item as the item's text", () => {
    const md = ["- item", "", "    [continued](docs/item.md)"].join("\n");
    expect(specs(md)).toEqual(["docs/item.md"]);
  });

  it("does not end a fence on a shorter fence inside it", () => {
    // ```` shows a ```-fenced example; the inner ``` used to close it, leaving
    // the example's link live between the two inner fences.
    const md = ["````markdown", "```", "[fake](docs/fake.md)", "```", "````", "", "[real](docs/real.md)"].join("\n");
    expect(specs(md)).toEqual(["docs/real.md"]);
  });

  it("still sees a fence nested in a list item, tab-indented", () => {
    const md = ["- example:", "", "\t```ts", "\t[ID]: uniqueId(),", "\t```", "", "[real](docs/real.md)"].join("\n");
    expect(specs(md)).toEqual(["docs/real.md"]);
  });
});

describe("extractMarkdown: GitHub alerts", () => {
  it("does not take an alert as the summary", () => {
    const md = ["> [!IMPORTANT]", "> This repo has moved to https://example.com/x", "", "A path manipulation library for Dart."].join("\n");
    expect(extractMarkdown(md).summary).toBe("A path manipulation library for Dart.");
  });
});
