// src/shu/coverage/ladder.test.ts -- `nen/workflow.json`'s coverage ladder:
// the tiny stand-in reader (residue -- see ./ladder.ts's own header), and the
// pure banding arithmetic it hands rows through.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bandOf, bandRows, readLadder } from "./ladder.js";
import { counts, target } from "./shape.js";

function withWorkflow(coverage: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-coverage-ladder-"));
  mkdirSync(join(dir, "nen"));
  if (coverage !== undefined) {
    writeFileSync(join(dir, "nen", "workflow.json"), JSON.stringify({ coverage }));
  }
  return dir;
}

describe("readLadder", () => {
  it("reads minimum/recommended/ideal off nen/workflow.json", () => {
    const repo = withWorkflow({ minimum: 80, recommended: 85, ideal: 90, scope: "touched" });
    try {
      expect(readLadder(repo)).toEqual({ minimum: 80, recommended: 85, ideal: 90 });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is null when the file does not exist -- no refusal, this file is optional", () => {
    const repo = mkdtempSync(join(tmpdir(), "nen-coverage-ladder-"));
    try {
      expect(readLadder(repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is null on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-coverage-ladder-"));
    mkdirSync(join(dir, "nen"));
    writeFileSync(join(dir, "nen", "workflow.json"), "{ not json");
    try {
      expect(readLadder(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is null when there is no 'coverage' block at all", () => {
    // withWorkflow(undefined) creates 'nen/' but skips the file; write one
    // here with a DIFFERENT top-level key and no 'coverage' at all.
    const repo = withWorkflow(undefined);
    writeFileSync(join(repo, "nen", "workflow.json"), JSON.stringify({ branch: { base: "main" } }));
    try {
      expect(readLadder(repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is null when any of the three is missing or not a finite number", () => {
    for (const coverage of [
      { minimum: 80, recommended: 85 }, // no ideal
      { minimum: 80, recommended: 85, ideal: "90" }, // a string, not a number
      { minimum: 80, recommended: 85, ideal: Infinity },
      {},
    ]) {
      const repo = withWorkflow(coverage);
      try {
        expect(readLadder(repo), JSON.stringify(coverage)).toBeNull();
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });
});

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
