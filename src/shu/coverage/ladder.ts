// src/shu/coverage/ladder.ts -- `nen/workflow.json`'s coverage ladder
// (minimum/recommended/ideal), and the band a row falls in against it.
//
// RESIDUE, NAMED AS SUCH: THE REAL LOADER DOES NOT EXIST YET. The workflow
// policy file's schema and loader (`src/schema/workflow.ts`, validated by `nen
// schema check`) is landing in a sibling change; until it does, `readLadder`
// below reads the THREE numbers this verb needs straight off the JSON file,
// with no validation beyond "are these three finite numbers" -- no `$schema`
// check, no report of an otherwise-malformed document, nothing this verb does
// not itself need. When the real loader lands, this function is replaced by a
// call into it and this file's own JSON.parse goes away; every sentence in
// this header is written to make that swap obvious rather than to justify a
// permanent second reader of the same file.
//
// SCOPED TO `--touched`, NEVER TO A PLAIN RUN. The design's own shape for the
// file states `"coverage": { "minimum": 80, "recommended": 85, "ideal": 90,
// "scope": "touched" }` -- the ladder is a policy about the files a CHANGE
// touched, the same scope `--threshold`'s own header already names, and a
// plain `nen shu coverage` has no such set to band. ../coverage.ts reads this
// module only when `--touched` was given and `--threshold` was not: an
// explicit `--threshold` is the caller overriding the file's policy for this
// one run, not a second number to reconcile against it.
//
// NEVER GATES, same rule as `--threshold`, same reason: this is a REPORT of
// where a row sits, not a verdict this binary is entitled to enforce -- see
// ./report.ts's header for zheref/nen#91 v3 q16.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { thresholdMet } from "./report.js";
import type { CoverageBand, CoverageMeasure, CoverageTarget } from "./shape.js";

export interface CoverageLadder {
  readonly minimum: number;
  readonly recommended: number;
  readonly ideal: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `<repoRoot>/nen/workflow.json`'s `coverage.{minimum,recommended,ideal}`.
 *
 * NULL ON ANYTHING THIS TINY READ CANNOT ANSWER FOR -- no file, unreadable
 * text, invalid JSON, no `coverage` block, or any of the three not a finite
 * number -- rather than a refusal. `--threshold` is optional and so is this
 * file: a repository that has not adopted `workflow.json` yet must see
 * `coverage --touched` work exactly as it always did, silently, rather than
 * fail a run over a policy file it never declared. The real loader (once it
 * lands) is the place a genuinely malformed `workflow.json` gets reported --
 * this tiny stand-in only ever falls back to "no ladder", never to a refusal.
 */
export function readLadder(repoRoot: string): CoverageLadder | null {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, "nen", "workflow.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const coverage = (parsed as Readonly<Record<string, unknown>>)["coverage"];
  if (typeof coverage !== "object" || coverage === null) return null;
  const { minimum, recommended, ideal } = coverage as Readonly<Record<string, unknown>>;
  if (!isFiniteNumber(minimum) || !isFiniteNumber(recommended) || !isFiniteNumber(ideal)) return null;
  return { minimum, recommended, ideal };
}

/**
 * Which rung `row` is on, or null when there is no ratio to place (0 of 0).
 *
 * BUILT OUT OF `thresholdMet`, THE SAME COMPARISON `--threshold` USES -- on
 * the counts, never the rounded percentage the table prints, for the reason
 * ./report.ts's own header gives: a row half a rounding step from a rung must
 * not be placed on the wrong side of it.
 */
export function bandOf(row: CoverageMeasure | null, ladder: CoverageLadder): CoverageBand | null {
  if (thresholdMet(row, ladder.ideal) === true) return "ideal";
  if (thresholdMet(row, ladder.recommended) === true) return "recommended";
  const met = thresholdMet(row, ladder.minimum);
  if (met === null) return null; // no ratio at all (0 of 0) -- not a rung, an absence
  return met ? "minimum" : "under-minimum";
}

/** Every row, with its own `band` attached against `ladder`. */
export function bandRows(rows: readonly CoverageTarget[], ladder: CoverageLadder): readonly CoverageTarget[] {
  return rows.map((row): CoverageTarget => ({ ...row, band: bandOf(row, ladder) }));
}
