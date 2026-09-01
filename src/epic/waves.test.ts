import { describe, expect, it } from "vitest";
import { coordinate, parseChildren, renderProgress, roundHalfEven } from "./waves.js";

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
    ]);
    expect(child).toMatchObject({
      num: 12,
      checked: true,
      blockedBy: [1, 2],
      blocks: [9],
      owner: "alice",
    });
  });

  it("ignores a non-checklist line", () => {
    expect(parseChildren(["just some text", "- [ ] not a number"])).toEqual([]);
  });

  it("defaults an unowned, unblocked child", () => {
    const [child] = parseChildren(["- [ ] #3 a plain child"]);
    expect(child).toMatchObject({ num: 3, checked: false, blockedBy: [], blocks: [], owner: null });
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
});
