import { describe, expect, it } from "vitest";
import { citationsIn, markersIn, parseCitation, proseLines, requirementOf, trailingAnnotation } from "./lines.js";

const CITE = "[src: FX:app/List.kt:10-20 @ 0123abcd · observed]";

describe("proseLines", () => {
  it("skips fenced blocks of either fence char (a shorter run does not close a longer fence) and tracks the heading above each line", () => {
    const lines = proseLines("# Top\na\n````text\n- **FR-9**: hidden\n```\nstill hidden\n````\n## Next\n~~~\nx\n~~~\nb\r\n");
    expect(lines.map((line) => line.text)).toEqual(["# Top", "a", "## Next", "b", ""]);
    expect(lines.find((line) => line.text === "b")?.heading).toBe("Next");
    expect(lines.find((line) => line.text === "b")?.number).toBe(12);
  });
});

describe("citations and markers", () => {
  it("parses the strict citation shape and refuses near misses", () => {
    expect(parseCitation(CITE)).toEqual({ code: "FX", path: "app/List.kt", l1: 10, l2: 20, sha: "0123abcd", tier: "observed", text: CITE });
    for (const bad of [
      "[src: FX:app/List.kt:10 @ 0123abcd · observed]",
      "[src: FX:app/List.kt:10-20 @ 0123abcd · guessed]",
      "[src: fx:app/List.kt:10-20 @ 0123abcd · observed]",
      "[src: FX:app/List.kt:10-20 @ XYZ · observed]",
      "[src: FX:/etc/passwd:1-2 @ 0123abcd · declared]",
      "[src: FX:app/../x:1-2 @ 0123abcd · declared]",
      "[src: FX:app/List.kt:10-20 @ 0123abcd - observed]",
    ]) expect(parseCitation(bad)).toBeNull();
  });

  it("peels the trailing group right to left: citations, markers and malformed brackets", () => {
    expect(trailingAnnotation(`- **FR-001**: x ${CITE} ${CITE}`).citations).toHaveLength(2);
    const mixed = trailingAnnotation("- **FR-001**: x [NEEDS RULING] [UNVERIFIED]  ");
    expect(mixed.markers.map((marker) => marker.kind)).toEqual(["needs-ruling", "unverified"]);
    expect(trailingAnnotation("x [src: nope]").malformed).toEqual(["[src: nope]"]);
    expect(trailingAnnotation("x [NEEDS CLARIFICATION: ]").malformed).toEqual(["[NEEDS CLARIFICATION: ]"]);
    expect(trailingAnnotation(`x ${CITE} trailing words`)).toEqual({ citations: [], markers: [], malformed: [] });
  });

  it("finds markers and citations anywhere on a line", () => {
    expect(markersIn("a [NEEDS CLARIFICATION: why?] b [NEEDS RULING]").map((marker) => marker.kind)).toEqual(["needs-clarification", "needs-ruling"]);
    expect(citationsIn(`see ${CITE} and [src: bad]`).map((entry) => entry.citation === null)).toEqual([false, true]);
  });
});

describe("requirementOf", () => {
  it.each([
    ["- **FR-001**: System MUST x", "FR-001"],
    ["* FR-12: y", "FR-12"],
    ["1. **SC-003** — z", "SC-003"],
    ["### User Story 4 - Title (Priority: P2)", "US-4"],
    ["- **US-2**: story", "US-2"],
  ])("reads %j as defining %s", (line, id) => {
    expect(requirementOf(line)?.id).toBe(id);
  });
  it.each(["Mentions FR-001 in passing", "- T001 builds FR-001", "## Requirements"])("does not read %j as a definition", (line) => {
    expect(requirementOf(line)).toBeNull();
  });
});
