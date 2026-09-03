import { describe, expect, it } from "vitest";
import {
  coordinate,
  DuplicateChildIdError,
  parseChildren,
  renderProgress,
  roundHalfEven,
  UnparsableChecklistError,
} from "./waves.js";

describe("roundHalfEven -- banker's rounding, to match Python's round()", () => {
  it("rounds a half down to the even neighbour", () => {
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(0.5)).toBe(0);
  });
  it("rounds a half up to the even neighbour", () => {
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
  });
  it("rounds non-halves normally", () => {
    expect(roundHalfEven(2.3)).toBe(2);
    expect(roundHalfEven(2.7)).toBe(3);
  });
});

describe("parseChildren -- checklist line parsing", () => {
  it("reads mark, number, blocked-by, blocks and owner", () => {
    const [child] = parseChildren([
      "- [x] #12 **[alice]** blocked by #1, #2 blocks #9",
    ]).children;
    expect(child).toMatchObject({
      num: 12,
      checked: true,
      blockedBy: [1, 2],
      blocks: [9],
      owner: "alice",
    });
  });

  it("ignores a non-checklist line entirely, but SURFACES a checkbox with no reference", () => {
    // #51: `- [ ] not a number` is checkbox-shaped, so it must not vanish --
    // it lands in `unparsed` with a 1-based line number a human can open.
    const result = parseChildren(["just some text", "- [ ] not a number"]);
    expect(result.children).toEqual([]);
    expect(result.unparsed).toEqual([{ line: 2, text: "- [ ] not a number" }]);
  });

  it("defaults an unowned, unblocked child", () => {
    const [child] = parseChildren(["- [ ] #3 a plain child"]).children;
    expect(child).toMatchObject({ num: 3, checked: false, blockedBy: [], blocks: [], owner: null });
  });

  // ---- zheref/nen#51: real-world checklist shapes the literal parser missed.

  it("parses the issue's trailing-reference form: '- [ ] Phase 0a — #101'", () => {
    const { children, unparsed } = parseChildren([
      "- [ ] Phase 0a — #101",
      "- [x] Phase 0b — #102",
    ]);
    expect(unparsed).toEqual([]);
    expect(children.map((c): [number, boolean] => [c.num, c.checked])).toEqual([
      [101, false],
      [102, true],
    ]);
  });

  it("parses a markdown link whose TEXT names the issue: '- [ ] **Child 1** [#570](url)'", () => {
    const { children, unparsed } = parseChildren([
      "- [ ] **Child 1** [#570](https://github.com/o/r/issues/570)",
    ]);
    expect(unparsed).toEqual([]);
    expect(children[0]).toMatchObject({ num: 570, checked: false });
  });

  it("parses a markdown link whose URL is an /issues/N path under unrelated link text", () => {
    const { children } = parseChildren([
      "- [x] **Child 2** [the auth leg](https://github.com/o/r/issues/571)",
    ]);
    expect(children[0]).toMatchObject({ num: 571, checked: true });
  });

  it("resolves an /issues/N URL even with a fragment or query after the number", () => {
    const { children } = parseChildren([
      "- [ ] [seed](https://github.com/o/r/issues/42#issuecomment-1)",
    ]);
    expect(children[0]).toMatchObject({ num: 42 });
  });

  it("still parses the original literal form, and still honours indentation", () => {
    const { children, unparsed } = parseChildren([
      "- [ ] #1 **[alice]**",
      "  - [ ] #2 nested child",
      "\t- [x] Phase — #3",
    ]);
    expect(unparsed).toEqual([]);
    expect(children.map((c): number => c.num)).toEqual([1, 2, 3]);
  });

  it("takes the FIRST reference on the line when several appear", () => {
    const { children } = parseChildren([
      "- [ ] #5 supersedes #9",
      "- [ ] [older](https://github.com/o/r/issues/570) then also #9",
    ]);
    expect(children.map((c): number => c.num)).toEqual([5, 570]);
  });

  it("never reads a 'blocked by'/'blocks' edge as the line's own identity", () => {
    // A checkbox whose ONLY references are dependency edges has no identity of
    // its own; claiming to BE #1 would shadow the real child #1.
    const { children, unparsed } = parseChildren([
      "- [ ] mystery work blocked by #1",
      "- [ ] #2 blocked by #1",
    ]);
    expect(children.map((c): number => c.num)).toEqual([2]);
    expect(unparsed).toEqual([{ line: 1, text: "- [ ] mystery work blocked by #1" }]);
  });

  it("does not read an HTML entity ('&#8212;') or a non-issue URL fragment as a reference", () => {
    const { children, unparsed } = parseChildren([
      "- [ ] Phase 0a &#8212; cleanup",
      "- [ ] [note](https://example.com/page#123)",
    ]);
    expect(children).toEqual([]);
    expect(unparsed.map((entry): number => entry.line)).toEqual([1, 2]);
  });
});

describe("renderProgress", () => {
  it("renders a bar, percentage and citation", () => {
    const text = renderProgress(1, 4, "UZF-1");
    expect(text).toContain("**1/4**");
    expect(text).toContain("25%");
    expect(text).toContain("UZF-1");
  });

  it("handles zero children without dividing by zero", () => {
    expect(renderProgress(0, 0, "UZF-1")).toContain("0%");
  });
});

describe("coordinate -- the full choreography", () => {
  const body = [
    "intro text",
    "",
    "- [ ] #1 **[alice]**",
    "- [ ] #2 **[bob]** blocked by #1",
    "- [ ] #3 **[carol]** blocked by #99",
  ].join("\n");

  it("flips the completed child idempotently", () => {
    const first = coordinate(body, 1, new Set(), 3, "UZF-1");
    expect(first.body).toMatch(/- \[x\] #1/);
    const second = coordinate(first.body, 1, new Set(), 3, "UZF-1");
    expect(second.summary.done).toBe(1);
  });

  it("prepends a progress block when none exists, replaces it when it does", () => {
    const first = coordinate(body, null, new Set(), 3, "UZF-1");
    expect(first.body.indexOf("## Progress")).toBe(0);
    const second = coordinate(first.body, 1, new Set(), 3, "UZF-1");
    expect(second.body.match(/## Progress/g)?.length).toBe(1);
  });

  it("releases only children whose declared blockers are ALL known and checked", () => {
    // #2 is blocked by #1, unchecked -- not released. #3 is blocked by #99, an
    // unknown id -- never clears the gate, so #3 is not released either.
    const result = coordinate(body, null, new Set(), 3, "UZF-1");
    expect(result.summary.release.map((r): number => r.child)).toEqual([1]);
  });

  it("honours the inverse 'blocks' edge declared on the blocking child", () => {
    const inverse = ["- [ ] #1 **[a]** blocks #2", "- [ ] #2 **[b]**"].join("\n");
    const result = coordinate(inverse, null, new Set(), 3, "UZF-1");
    expect(result.summary.release.map((r): number => r.child)).toEqual([1]);
    const after = coordinate(inverse, 1, new Set(), 3, "UZF-1");
    expect(after.summary.release.map((r): number => r.child)).toEqual([2]);
  });

  it("releases in declared source order and respects the cap", () => {
    const three = ["- [ ] #1", "- [ ] #2", "- [ ] #3"].join("\n");
    const result = coordinate(three, null, new Set(), 2, "UZF-1");
    expect(result.summary.release.map((r): number => r.child)).toEqual([1, 2]);
  });

  it("in-flight children occupy a slot only while unchecked", () => {
    const three = ["- [ ] #1", "- [ ] #2", "- [ ] #3"].join("\n");
    const result = coordinate(three, null, new Set([1]), 2, "UZF-1");
    // #1 occupies a slot (in flight, unchecked), leaving one free for #2.
    expect(result.summary.release.map((r): number => r.child)).toEqual([2]);
  });

  it("a merged in-flight child (now checked) no longer occupies a slot", () => {
    const two = ["- [x] #1", "- [ ] #2", "- [ ] #3"].join("\n");
    const result = coordinate(two, null, new Set([1]), 1, "UZF-1");
    expect(result.summary.release.map((r): number => r.child)).toEqual([2]);
  });

  // Review finding #18: a duplicated checklist id diverged from the Python
  // original's per-object `checked` tracking (last-wins) once the port
  // unioned checked numbers into a Set -- Python: done=1/2 (50%),
  // satisfied(5)=false (reads the LAST duplicate, unchecked); nen before the
  // fix: done=2/2 (100%), satisfied(5)=true -- a wave could release against
  // a blocker that was not, in truth, done. Refusing outright (rather than
  // picking either tie-break silently) is the fix.
  it("refuses (DuplicateChildIdError) rather than silently reading a duplicated checklist id either way", () => {
    const duplicated = ["- [x] #5 **[alice]**", "- [ ] #5 **[bob]**"].join("\n");
    expect(() => coordinate(duplicated, null, new Set(), 3, "UZF-1")).toThrow(DuplicateChildIdError);
    try {
      coordinate(duplicated, null, new Set(), 3, "UZF-1");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateChildIdError);
      expect((error as DuplicateChildIdError).duplicates).toEqual([5]);
      expect((error as Error).message).toMatch(/#5/);
    }
  });

  it("a duplicated id used as a BLOCKER also refuses, rather than computing a wave against it", () => {
    const body2 = ["- [x] #5 **[a]**", "- [ ] #5 **[b]**", "- [ ] #6 **[c]** blocked by #5"].join("\n");
    expect(() => coordinate(body2, null, new Set(), 3, "UZF-1")).toThrow(DuplicateChildIdError);
  });

  it("does not refuse when every id is unique, even with several children", () => {
    const fine = ["- [ ] #1", "- [ ] #2", "- [ ] #3"].join("\n");
    expect(() => coordinate(fine, null, new Set(), 3, "UZF-1")).not.toThrow();
  });

  // ---- zheref/nen#51: the issue's own reproduction, end to end.

  it("computes the wave for the trailing-reference body that used to read {total:0, done:0}", () => {
    const trailing = ["## Children", "", "- [ ] Phase 0a — #101", "- [x] Phase 0b — #102"].join("\n");
    const result = coordinate(trailing, null, new Set(), 3, "CON-9");
    expect(result.summary).toMatchObject({ total: 2, done: 1 });
    expect(result.summary.release.map((r): number => r.child)).toEqual([101]);
    expect(result.summary.unparsed).toEqual([]);
  });

  it("flips a trailing-reference or markdown-link line by mark only, preserving the author's text verbatim", () => {
    // The `## Children` heading matters: the progress rewriter replaces from
    // `## Progress` to the NEXT `## ` heading, so a checklist that follows the
    // prepended progress block needs one to survive a second pass.
    const body51 = [
      "## Children",
      "",
      "- [ ] Phase 0a — #101",
      "- [ ] **Child 1** [#570](https://github.com/o/r/issues/570)",
    ].join("\n");
    const first = coordinate(body51, 101, new Set(), 3, "UZF-1");
    expect(first.body).toContain("- [x] Phase 0a — #101");
    const second = coordinate(first.body, 570, new Set(), 3, "UZF-1");
    expect(second.body).toContain("- [x] **Child 1** [#570](https://github.com/o/r/issues/570)");
    expect(second.summary).toMatchObject({ total: 2, done: 2 });
  });

  it("carries unresolvable checkboxes into the summary instead of dropping them", () => {
    const mixed = ["- [ ] #1", "- [ ] write the docs"].join("\n");
    const result = coordinate(mixed, null, new Set(), 3, "UZF-1");
    expect(result.summary).toMatchObject({ total: 1, done: 0 });
    expect(result.summary.unparsed).toEqual([{ line: 2, text: "- [ ] write the docs" }]);
  });

  it("refuses (UnparsableChecklistError) a body whose checkboxes are ALL unresolvable, naming the lines", () => {
    // {total:0, done:0} from a body full of checkboxes would be the silent
    // wrong result #51 is about -- indistinguishable from a truly empty epic.
    const opaque = ["- [ ] first thing", "- [x] second thing"].join("\n");
    try {
      coordinate(opaque, null, new Set(), 3, "UZF-1");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnparsableChecklistError);
      expect((error as UnparsableChecklistError).unparsed.map((entry): number => entry.line)).toEqual([1, 2]);
      expect((error as Error).message).toMatch(/none carries a resolvable child reference/);
      expect((error as Error).message).toMatch(/'#123'/);
    }
  });

  it("does NOT refuse a body with no checkboxes at all -- genuinely empty stays {total:0, done:0, unparsed:[]}", () => {
    const result = coordinate("just prose, no checklist", null, new Set(), 3, "UZF-1");
    expect(result.summary).toMatchObject({ total: 0, done: 0 });
    expect(result.summary.unparsed).toEqual([]);
  });
});
