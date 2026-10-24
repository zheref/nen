import { describe, expect, it } from "vitest";
import { CollateError, collateChangelog, collateIntoChangelog, renderDatedSection, sortFragments } from "./collate.js";

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

  it("refuses with neither an Unreleased header nor a dated release heading", () => {
    expect(() => collateIntoChangelog("no header here", "v1.1.0", "theme", [{ name: "1-a.md", content: "x\n" }])).toThrow(/no '### Unreleased' header and no dated release heading/);
  });

  it("never drops a '## v<prev>' heading under an empty Unreleased (zheref/nen#504)", () => {
    const mixed = "# Changelog\n\n### Unreleased\n\n## v0.26.0 — 2026-10-22\n\nRelease unit paragraph.\n\n### Added\n\n- old\n";
    const result = collateChangelog(mixed, "v0.27.0", "theme", [{ name: "1-a.md", content: "- new\n" }], { date: "2026-10-23" });
    // The new section takes the dated heading's form and level, with a blank line before it (#515 F1).
    expect(result.heading).toBe("## v0.27.0 — 2026-10-23");
    expect(result.text).toBe(
      "# Changelog\n\n### Unreleased\n_(nothing awaiting release.)_\n\n## v0.27.0 — 2026-10-23\n\ntheme\n\n- new\n\n## v0.26.0 — 2026-10-22\n\nRelease unit paragraph.\n\n### Added\n\n- old\n",
    );
  });

  it("does not count a '## v<prev>' section's bullets as Unreleased entries (#515 F2)", () => {
    const shaped = "### Unreleased\n\n## v0.26.0 — 2026-10-22\n\n- **old** one\n- **old** two\n";
    expect(collateChangelog(shaped, "v0.27.0", "t", [{ name: "a.md", content: "- new\n" }], { date: "2026-10-23" }).heading).toBe("## v0.27.0 — 2026-10-23");
  });

  it("writes the inserted lines with a CRLF file's own line ending (#515 F11)", () => {
    const crlf = "# C\r\n\r\n## v1.0.0 — 2026-01-01\r\n\r\n- old\r\n";
    const text = collateChangelog(crlf, "v1.1.0", "t", [{ name: "a.md", content: "- new\n" }], { date: "2026-02-01" }).text;
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text).toBe("# C\r\n\r\n## v1.1.0 — 2026-02-01\r\n\r\nt\r\n\r\n- new\r\n\r\n## v1.0.0 — 2026-01-01\r\n\r\n- old\r\n");
  });
});

describe("collateChangelog -- no Unreleased: anchored on the top dated section (zheref/nen#504)", () => {
  // This repository's own CHANGELOG head shape (AC-3).
  const head =
    "# Changelog\n\nAll notable changes to nen. Versions are git tags on `main`.\n\n## v0.27.0 — 2026-10-22\n\nRelease unit for `v0.26.0..v0.27.0`: [#501](u).\n\n### Breaking / consumer notes\n\n- **No repin.**\n\n## v0.26.0 — 2026-10-22\n\n- older\n";
  const fragments = [
    { name: "a.md", content: "- first\n" },
    { name: "b.md", content: "- second\n- more\n" },
  ];

  it("inserts above the top dated section in its level and date form, leaving every existing line byte-identical", () => {
    const result = collateChangelog(head, "v0.28.0", "Small verbs and triage.", fragments, { date: "2026-10-23" });
    expect(result.anchor).toBe("dated-section");
    expect(result.heading).toBe("## v0.28.0 — 2026-10-23");
    const at = head.indexOf("## v0.27.0");
    expect(result.text.slice(0, at)).toBe(head.slice(0, at));
    expect(result.text.endsWith(head.slice(at))).toBe(true);
    expect(result.text.slice(at, result.text.length - (head.length - at))).toBe(
      "## v0.28.0 — 2026-10-23\n\nSmall verbs and triage.\n\n- first\n- second\n- more\n\n",
    );
  });

  it("writes the theme as the suffix when the top heading carries no date, at that heading's level", () => {
    const themed = "### v1.0.0 — prior\n- **old** entry\n";
    const result = collateChangelog(themed, "1.1.0", "theme", fragments);
    expect(result.heading).toBe("### v1.1.0 — theme");
    expect(result.text).toBe("### v1.1.0 — theme\n\n- first\n- second\n- more\n\n### v1.0.0 — prior\n- **old** entry\n");
  });

  it("refuses a dated changelog with no date given, and a date that is not a calendar day", () => {
    expect(() => collateChangelog(head, "v0.28.0", "t", fragments)).toThrow(/no release date was given/);
    expect(() => collateChangelog(head, "v0.28.0", "t", fragments, { date: "2026-02-30" })).toThrow(/not a calendar date/);
  });

  it("renders the same section for the preview and the write (one pure function)", () => {
    const a = collateChangelog(head, "v0.28.0", "t", fragments, { date: "2026-10-23" });
    const b = collateChangelog(head, "v0.28.0", "t", [...fragments].reverse(), { date: "2026-10-23" });
    expect(a).toEqual(b);
  });
});
