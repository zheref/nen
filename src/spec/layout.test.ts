import { describe, expect, it } from "vitest";
import { VerbUsageError } from "../cli/command.js";
import { checkRelativePath, matchFolder, parseLayout } from "./layout.js";

describe("parseLayout", () => {
  it("reads Spec Kit's own layout: root, matcher, order", () => {
    const layout = parseLayout("specs/{nnn}-{slug}");
    expect(layout.root).toBe("specs");
    expect(matchFolder(layout, "001-sample-feature")).toEqual({ nnn: "001", slug: "sample-feature" });
    expect(matchFolder(layout, "01-sample")).toBeNull();
    expect(matchFolder(layout, "001-Sample")).toBeNull();
    expect(matchFolder(layout, "001-sample-")).toBeNull();
  });

  it("reads a nested root and a slug-first final segment with literal text", () => {
    const layout = parseLayout("docs/features/{slug}.F{nnn}");
    expect(layout.root).toBe("docs/features");
    expect(matchFolder(layout, "sample.F007")).toEqual({ nnn: "007", slug: "sample" });
    expect(matchFolder(layout, "sampleXF007")).toBeNull();
  });

  it.each(["", "/specs/{nnn}-{slug}", "../specs/{nnn}-{slug}", "specs/../{nnn}-{slug}", "{nnn}-{slug}", "specs/{nnn}", "specs/{nnn}-{slug}-{nnn}", "{slug}/{nnn}-{slug}", "specs/{nnn}-{slug}-{x}", "specs\\{nnn}-{slug}", "specs//{nnn}-{slug}", "C:/specs/{nnn}-{slug}"])("refuses %j at the usage boundary", (pattern) => {
    expect(() => parseLayout(pattern)).toThrow(VerbUsageError);
  });
});

describe("checkRelativePath", () => {
  it("keeps a plain relative path and drops a trailing slash", () => {
    expect(checkRelativePath("folder", "specs/001-sample/")).toBe("specs/001-sample");
  });
  it.each(["", "/abs", "../up", "specs/../x", "-flag", "a//b", "./a", "a\\b"])("refuses %j", (value) => {
    expect(() => checkRelativePath("folder", value)).toThrow(VerbUsageError);
  });
});
