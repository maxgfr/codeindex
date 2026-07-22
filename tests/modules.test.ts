import { describe, it, expect } from "vitest";
import { tierForPath } from "../src/modules.js";

describe("tierForPath", () => {
  it("treats a test segment ANYWHERE in the path as tail (tier 2)", () => {
    expect(tierForPath("pkg/src/conventions/1483/__tests__/indemnite-licenciement")).toBe(2);
    expect(tierForPath("src/tool/__tests__/agreements")).toBe(2);
    expect(tierForPath("docs/guide")).toBe(2);
  });
  it("treats foundations leaves as tier 0", () => {
    expect(tierForPath("src/utils")).toBe(0);
    expect(tierForPath("packages/x/src/common/types")).toBe(0);
    expect(tierForPath("(root)")).toBe(0);
  });
  it("leaves a plain feature path undecided (null)", () => {
    expect(tierForPath("src/modules/documents")).toBeNull();
    expect(tierForPath("packages/frontend/src/modules/outils")).toBeNull();
  });
  it("does not misclassify 'documents' as docs", () => {
    expect(tierForPath("src/modules/documents")).not.toBe(2);
  });
});
