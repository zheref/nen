import { describe, expect, it } from "vitest";
import { CollateError, collateIntoChangelog, renderDatedSection, sortFragments } from "./collate.js";

describe("sortFragments", () => {
  it("is IDEMPOTENT -- applied twice it is the same order as once", () => {
    // Relied upon rather than assumed: `collateIntoChangelog` sorts whatever it
    // is handed (its own guarantee about the section it renders) and
    // ../changelog/command.ts sorts to decide the one order it reports
    // (zheref/nen#34). Two applications, one order -- and if that ever stopped
    // being true, the manifest and the section would part company again.
    const input = [
      { name: "10-a.md", content: "a" },
      { name: "30-c.md", content: "c" },
      { name: "no-prefix.md", content: "z" },
      { name: "20-b.md", content: "b" },
    ];
    const once = sortFragments(input);
    expect(sortFragments(once)).toEqual(once);
    expect(once.map((f): string => f.name)).toEqual([
      "30-c.md",
      "20-b.md",
      "10-a.md",
      "no-prefix.md",
    ]);
  });

  it("sorts newest-first by leading numeric prefix, no-prefix last", () => {
    const fragments = [
      { name: "5-old.md", content: "" },
      { name: "20-new.md", content: "" },
      { name: "no-number.md", content: "" },
    ];
    expect(sortFragments(fragments).map((f): string => f.name)).toEqual(["20-new.md", "5-old.md", "no-number.md"]);
  });
});

describe("renderDatedSection", () => {
  it("renders the header and each fragment, ensuring a trailing newline per fragment", () => {
    const out = renderDatedSection("v1.2.0", "theme", [
      { name: "1-a.md", content: "- **A** thing" },
      { name: "2-b.md", content: "- **B** thing\n" },
    ]);
    expect(out).toBe("### v1.2.0 — theme\n- **A** thing\n- **B** thing\n");
  });
});

describe("collateIntoChangelog", () => {
  const base = "### Unreleased\n_(nothing awaiting release.)_\n\n### v1.0.0 — prior\n- **old** entry\n";

  it("inserts the new dated section below an empty Unreleased", () => {
    const out = collateIntoChangelog(base, "v1.1.0", "theme", [{ name: "1-a.md", content: "- **A** thing\n" }]);
    expect(out).toContain("### v1.1.0 — theme");
    expect(out.indexOf("### v1.1.0")).toBeLessThan(out.indexOf("### v1.0.0"));
    expect(out).toContain("### v1.0.0 — prior");
  });

  it("refuses when Unreleased still has entries", () => {
    const dirty = "### Unreleased\n- **X** thing\n\n### v1.0.0 — prior\n";
    expect(() => collateIntoChangelog(dirty, "v1.1.0", "theme", [{ name: "1-a.md", content: "x\n" }])).toThrow(CollateError);
  });

  it("refuses with no fragments", () => {
    expect(() => collateIntoChangelog(base, "v1.1.0", "theme", [])).toThrow(CollateError);
  });

  it("refuses with no Unreleased header", () => {
    expect(() => collateIntoChangelog("no header here", "v1.1.0", "theme", [{ name: "1-a.md", content: "x\n" }])).toThrow(CollateError);
  });
});
