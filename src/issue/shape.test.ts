import { describe, expect, it } from "vitest";
import { checkIssueBody, countQuestions, foldTitle, IssueShapeError, parseCatalogue, selectKind } from "./shape.js";

const CATALOGUE = parseCatalogue({
  contract: "example.issue-sections/v1",
  sections: [
    { id: "problem", title: "Problem", level: 2, content: [{ name: "names a reader", pattern: "\\bmaintainer\\b" }] },
    { id: "ac", title: ["Acceptance criteria", "Acceptance"], level: 2, rows: { prefix: "AC", contiguous: true } },
    { id: "sc", title: "Success criteria", rows: { prefix: "SC", measurable: true } },
    { id: "scope", title: "Scope boundaries", level: 2 },
  ],
  kinds: { feature: ["problem", "ac", "sc", "scope"], bug: ["problem", "ac"] },
  vagueAdjectives: ["fast", "intuitive"],
});

const GOOD = [
  "## 🧭 Problem",
  "",
  "The maintainer cannot see the queue.",
  "",
  "## Acceptance criteria",
  "",
  "- AC-1: the queue renders",
  "- **AC-2**: it refreshes",
  "",
  "## Success criteria",
  "",
  "- SC-1: p95 under 200 ms",
  "- SC-2: 90% of runs",
  "",
  "## Scope boundaries",
  "",
  "Only the queue.",
].join("\n");

describe("parseCatalogue -- the caller's catalogue, refused rather than skipped", () => {
  it("refuses a non-object, an empty section list and a kind naming an undeclared section", () => {
    expect(() => parseCatalogue([])).toThrow(IssueShapeError);
    expect(() => parseCatalogue({ sections: [], kinds: { a: ["x"] } })).toThrow(/non-empty array/);
    expect(() => parseCatalogue({ sections: [{ id: "x", title: "X" }], kinds: { a: ["y"] } })).toThrow(/undeclared section\(s\): y/);
  });

  it("refuses a duplicate id, a bad level, an unparseable content pattern and a row rule without a prefix", () => {
    expect(() => parseCatalogue({ sections: [{ id: "x", title: "X" }, { id: "x", title: "Y" }], kinds: { a: ["x"] } })).toThrow(/declared twice/);
    expect(() => parseCatalogue({ sections: [{ id: "x", title: "X", level: 7 }], kinds: { a: ["x"] } })).toThrow(/level/);
    expect(() => parseCatalogue({ sections: [{ id: "x", title: "X", content: [{ name: "n", pattern: "(" }] }], kinds: { a: ["x"] } })).toThrow(/unparseable/);
    expect(() => parseCatalogue({ sections: [{ id: "x", title: "X", rows: { prefix: "1A" } }], kinds: { a: ["x"] } })).toThrow(/prefix/);
  });

  it("echoes the caller's contract and skips $-keys among kinds", () => {
    const parsed = parseCatalogue({ contract: "c/v1", sections: [{ id: "x", title: "X" }], kinds: { $comment: "note", a: ["x"] } });
    expect(parsed.contract).toBe("c/v1");
    expect(Object.keys(parsed.kinds)).toEqual(["a"]);
  });
});

describe("selectKind -- never picks among several", () => {
  it("takes the asked kind, the only kind, or refuses", () => {
    expect(selectKind(CATALOGUE, "bug")).toBe("bug");
    expect(() => selectKind(CATALOGUE, undefined)).toThrow(/Nen will not pick one/);
    expect(() => selectKind(CATALOGUE, "chore")).toThrow(/not declared/);
    expect(selectKind(parseCatalogue({ sections: [{ id: "x", title: "X" }], kinds: { only: ["x"] } }), undefined)).toBe("only");
  });
});

describe("checkIssueBody", () => {
  it("passes a body carrying every section, content rule and row rule", () => {
    const report = checkIssueBody(GOOD, CATALOGUE, "feature");
    expect(report.misses).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rows.map((row) => row.id)).toEqual(["AC-1", "AC-2", "SC-1", "SC-2"]);
    expect(report.sections.map((section) => section.status)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("folds a leading glyph and letter case in a heading", () => {
    expect(foldTitle("🧭  Problem ")).toBe("problem");
    expect(checkIssueBody(GOOD.replace("## 🧭 Problem", "## PROBLEM"), CATALOGUE, "bug").ok).toBe(true);
  });

  it("reports every miss at once: missing, empty, content, row order, unmeasurable", () => {
    const body = [
      "## Problem",
      "It is slow.",
      "## Acceptance criteria",
      "- AC-1: one",
      "- AC-3: three",
      "- AC-3: again",
      "## Success criteria",
      "- SC-1: users are happy",
      "## Scope boundaries",
      "<!-- fill me -->",
    ].join("\n");
    const report = checkIssueBody(body, CATALOGUE, "feature");
    expect(report.ok).toBe(false);
    expect(report.misses.map((miss) => `${miss.section}:${miss.kind}:${miss.line}`)).toEqual([
      "problem:content:1",
      "ac:row-order:5",
      "ac:row-order:6",
      "sc:row-unmeasurable:8",
      "scope:empty:9",
    ]);
  });

  it("reports a missing section and a row section with no row", () => {
    const report = checkIssueBody("## Problem\nThe maintainer.\n## Acceptance\nprose only\n", CATALOGUE, "feature");
    expect(report.misses.map((miss) => `${miss.section}:${miss.kind}`)).toEqual(["ac:no-rows", "sc:missing", "scope:missing"]);
  });

  it("holds a declared level, and never reads a heading or a row inside fenced code or a comment", () => {
    const body = ["### Problem", "The maintainer.", "```", "## Acceptance criteria", "- AC-1: x", "```", "<!-- ## Scope boundaries -->"].join("\n");
    const report = checkIssueBody(body, CATALOGUE, "bug");
    expect(report.misses.map((miss) => `${miss.section}:${miss.kind}`)).toEqual(["problem:missing", "ac:missing"]);
  });

  it("does not count a fenced row toward contiguity", () => {
    const body = ["## Problem", "The maintainer.", "## Acceptance criteria", "- AC-1: a", "```", "- AC-5: example", "```", "- AC-2: b"].join("\n");
    expect(checkIssueBody(body, CATALOGUE, "bug").ok).toBe(true);
  });

  it("reports vague adjectives as advisories, never as misses, and not inside inline code", () => {
    const report = checkIssueBody(GOOD.replace("Only the queue.", "A fast, Intuitive queue; not `fast` here."), CATALOGUE, "feature");
    expect(report.ok).toBe(true);
    expect(report.advisories).toEqual([
      { kind: "vague", word: "fast", line: 17 },
      { kind: "vague", word: "intuitive", line: 17 },
    ]);
  });
});

describe("countQuestions -- counts, never decides", () => {
  it("counts open rows with their gate, resolved rows and NEEDS markers", () => {
    const report = countQuestions(
      [
        "## Open questions",
        "- OQ-1 (G4): which store? [NEEDS CLARIFICATION: store]",
        "- ~~OQ-2~~ → A: the local one",
        "- ~~OQ-3~~ -> A: none",
        "* OQ-4 (G5): who owns it?",
        "Prose naming [NEEDS HR-4: question] inline.",
      ].join("\n"),
    );
    expect(report.counts).toEqual({ open: 2, resolved: 2, needsMarkers: 2, unrecognised: 0 });
    expect(report.open).toEqual([
      { id: "OQ-1", number: 1, gate: "G4", line: 2 },
      { id: "OQ-4", number: 4, gate: "G5", line: 5 },
    ]);
    expect(report.needsMarkers.map((marker) => marker.label)).toEqual(["CLARIFICATION", "HR-4"]);
  });

  it("lists an OQ row in neither shape as unrecognised, and ignores fenced code, inline code and comments", () => {
    const report = countQuestions(
      ["- OQ-1 no gate here", "- ~~OQ-2~~ resolved without an answer", "```", "- OQ-9 (G4): example", "```", "`[NEEDS CLARIFICATION: x]`", "<!-- - OQ-8 (G4): hidden -->"].join("\n"),
    );
    expect(report.counts).toEqual({ open: 0, resolved: 0, needsMarkers: 0, unrecognised: 2 });
    expect(report.unrecognised.map((row) => row.line)).toEqual([1, 2]);
  });

  it("reads an empty body as zero of everything", () => {
    expect(countQuestions("").counts).toEqual({ open: 0, resolved: 0, needsMarkers: 0, unrecognised: 0 });
  });
});
