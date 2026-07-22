import { describe, it, expect } from "vitest";
import { extractCode } from "../src/extract/code.js";

// UIDX-1: a file opening with the ubiquitous `/*!` "preserve" banner (Express,
// jQuery, Bootstrap, Lodash, moment, …) must NOT derive the garbage summary "!".
// topDocComment stripped `/*` from `/*!`, left "!", and the first-sentence regex
// treated "!" as a complete sentence. The banner should yield a meaningful
// sentence or an EMPTY (undefined) summary — never "!".
describe("extractCode: `/*!` preserve-banner summaries (UIDX-1)", () => {
  it("does not turn an Express-style `/*!` banner into the summary \"!\"", () => {
    const src = [
      "/*!",
      " * express",
      " * Copyright(c) 2009-2013 TJ Holowaychuk",
      " * MIT Licensed",
      " */",
      "",
      "'use strict';",
      "module.exports = require('./lib/express');",
      "",
    ].join("\n");
    const info = extractCode("index.js", ".js", src);
    expect(info.summary).not.toBe("!");
    // The banner has no descriptive prose (just the lib name + license), so an
    // empty summary is the honest answer; whatever it is, it can't be "!".
    if (info.summary !== undefined) {
      expect(info.summary).not.toContain("!");
      expect(info.summary.length).toBeGreaterThan(1);
    }
  });

  it("does not turn a jQuery-style `/*!` banner into the summary \"!\"", () => {
    const src = [
      "/*!",
      " * jQuery JavaScript Library v3.6.0",
      " * https://jquery.com/",
      " *",
      " * Copyright OpenJS Foundation and other contributors",
      " * Released under the MIT license",
      " */",
      "function x(){}",
      "",
    ].join("\n");
    const info = extractCode("jquery.js", ".js", src);
    expect(info.summary).not.toBe("!");
    // A real descriptive line exists — keep it, drop the license/URL noise.
    expect(info.summary).toBe("jQuery JavaScript Library v3.6.0");
  });

  it("strips the closing delimiter so a banner never yields a bare \"/\"", () => {
    const src = [
      "/**",
      " * @license",
      " * Lodash <https://lodash.com/>",
      " * Copyright OpenJS Foundation and other contributors",
      " * Released under MIT license <https://lodash.com/license>",
      " */",
      ";(function() {}());",
      "",
    ].join("\n");
    const info = extractCode("lodash.js", ".js", src);
    expect(info.summary).not.toBe("!");
    if (info.summary !== undefined) {
      expect(info.summary.endsWith("/")).toBe(false);
      expect(info.summary).not.toBe("/");
    }
  });
});
