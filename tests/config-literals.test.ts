import { describe, expect, it } from "vitest";
import { extractConfigLiterals } from "../src/extract/config.js";

const values = (src: string) => (extractConfigLiterals(src) ?? []).map((l) => `${l.line} ${l.kind} ${l.value}`);

describe("config literals: one value per scalar", () => {
  it("records an unquoted number once, as a number", () => {
    // Each was also a string ("8080", "30", "1_000_000"), so every numeric
    // setting was a duplicate of itself in the literals analysis.
    expect(values("server:\n  port: 8080\n")).toEqual(["2 number 8080"]);
    expect(values("[tool.x]\ntimeout = 30 # seconds\nbig = 1_000_000\n")).toEqual([
      "3 number 1000000",
      "2 number 30",
    ]);
    expect(values("port=8080\n")).toEqual(["1 number 8080"]);
  });

  it("keeps a non-numeric scalar whole, without the digits inside it", () => {
    // A time was three unrelated numbers (12, 30, 45) plus the string.
    expect(values("time: 12:30:45\n")).toEqual(["1 string 12:30:45"]);
    expect(values("host: db.internal:5432\n")).toEqual(["1 string db.internal:5432"]);
    expect(values("version: 1.2.3\n")).toEqual(["1 string 1.2.3"]);
  });

  it("still reads numbers in flow collections and after anchors", () => {
    expect(values("ports: [8080, 8443]\n")).toEqual(["1 number 8080", "1 number 8443"]);
    expect(values("anchor: &a 25\n")).toEqual(["1 number 25"]);
    expect(values('{ "port": 8080, "name": "api" }\n')).toEqual(["1 number 8080", "1 string api", "1 string name", "1 string port"]);
  });

  it("reads a YAML sequence entry's mapping", () => {
    expect(values("containers:\n  - image: nginx:1.25\n  - containerPort: 8080\n")).toEqual([
      "3 number 8080",
      "2 string nginx:1.25",
    ]);
  });

  it("unescapes a doubled quote in a single-quoted scalar, and takes backslashes literally", () => {
    // `'it''s'` was read as "it" and then "s".
    expect(values("msg: 'it''s here'\n")).toEqual(["1 string it's here"]);
    expect(values("dir: 'C:\\tmp\\' # a comment\n")).toEqual(["1 string C:\\tmp\\"]);
    expect(values('esc: "say \\"hi\\""\n')).toEqual(['1 string say \\"hi\\"']);
  });
});
