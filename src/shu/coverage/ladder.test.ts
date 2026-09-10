// src/shu/coverage/ladder.test.ts -- the pure banding arithmetic `--touched`
// hands its rows through, against the ladder ../coverage.ts loads out of
// `nen/workflow.json`.
//
// THE READER'S OWN TESTS ARE GONE BECAUSE THE READER IS. This module carried a
// stand-in `readLadder` -- a `JSON.parse` with three number checks -- until the
// policy file's real loader landed; its five tests moved with it, and the
// absent-file / malformed-file / missing-block cases are now
// ../../schema/workflow.test.ts's, tested once against the loader every reader
// shares. What is left here is the arithmetic, which was never the loader's.

import { describe, expect, it } from "vitest";
import { bandOf, bandRows } from "./ladder.js";
import { counts, target } from "./shape.js";

const LADDER = { minimum: 80, recommended: 85, ideal: 90 };

describe("bandOf", () => {
  it("places a row on each of the four rungs", () => {
    expect(bandOf(target("a", counts(60, 100), null), LADDER)).toBe("under-minimum");
    expect(bandOf(target("a", counts(82, 100), null), LADDER)).toBe("minimum");
    expect(bandOf(target("a", counts(87, 100), null), LADDER)).toBe("recommended");
    expect(bandOf(target("a", counts(95, 100), null), LADDER)).toBe("ideal");
  });

  it("is inclusive at each boundary, exactly like --threshold's own 'met'", () => {
    expect(bandOf(target("a", counts(80, 100), null), LADDER)).toBe("minimum");
    expect(bandOf(target("a", counts(85, 100), null), LADDER)).toBe("recommended");
    expect(bandOf(target("a", counts(90, 100), null), LADDER)).toBe("ideal");
  });

  it("compares the COUNTS, not the rounded percentage -- same rule as --threshold", () => {
    // 19999/25000 is 79.996%, which rounds to the 80.00% a table would print;
    // a comparison against the rounded number would band it 'minimum' at a
    // minimum of 80, one rounding step past where it actually sits.
    expect(bandOf(target("a", counts(19999, 25000), null), LADDER)).toBe("under-minimum");
  });

  it("is null when there is no ratio to place (0 of 0)", () => {
    expect(bandOf(target("a", counts(0, 0), null), LADDER)).toBeNull();
  });

  it("is null for a null row (nothing was parsed)", () => {
    expect(bandOf(null, LADDER)).toBeNull();
  });
});

describe("bandRows", () => {
  it("attaches 'band' to every row, appended after its existing keys", () => {
    const rows = bandRows([target("a", counts(60, 100), counts(1, 2))], LADDER);
    expect(Object.keys(rows[0] ?? {})).toEqual(["name", "lines", "branches", "band"]);
    expect(rows[0]?.band).toBe("under-minimum");
  });

  it("leaves an empty list empty", () => {
    expect(bandRows([], LADDER)).toEqual([]);
  });
});
