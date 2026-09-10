// src/shu/coverage/ladder.ts -- the band a row falls in against the coverage
// ladder (minimum/recommended/ideal) `nen/workflow.json` states.
//
// THIS FILE NO LONGER READS THE FILE, AND THAT IS THE POINT. The first cut of
// `--touched` carried a tiny stand-in reader here -- a `JSON.parse` of
// `nen/workflow.json` that checked three numbers and nothing else -- named in
// its own header as residue, because the policy file's schema and loader did
// not exist yet. They do now (`../../schema/workflow.ts`, validated by `nen
// schema check`), so ../coverage.ts calls `loadWorkflow` and hands the three
// numbers down. A second reader of the same file is exactly the drift the
// stand-in's header promised to avoid: one file, one loader, one set of
// defaults.
//
// WHAT THE LOADER'S DEFAULTS MEAN HERE. `loadWorkflow` answers `present: false`
// with the published defaults -- 80 / 85 / 90 -- rather than "no policy", so a
// repository that has not written a `workflow.json` yet is banded against the
// design's own rungs instead of getting no bands at all. The report says which
// of the two it was (`ladder.present`), so a reader can tell a declared 80 from
// an assumed one; see ./report.ts's `CoverageLadderReport`.
//
// SCOPED TO `--touched`, NEVER TO A PLAIN RUN. The design's own shape for the
// file states `"coverage": { "minimum": 80, "recommended": 85, "ideal": 90,
// "scope": "touched" }` -- the ladder is a policy about the files a CHANGE
// touched, the same scope `--threshold`'s own header already names, and a
// plain `nen shu coverage` has no such set to band. ../coverage.ts reads the
// policy only when `--touched` was given and `--threshold` was not: an
// explicit `--threshold` is the caller overriding the file's policy for this
// one run, not a second number to reconcile against it.
//
// NEVER GATES, same rule as `--threshold`, same reason: this is a REPORT of
// where a row sits, not a verdict this binary is entitled to enforce -- see
// ./report.ts's header for zheref/nen#91 v3 q16.

import { thresholdMet } from "./report.js";
import type { CoverageBand, CoverageMeasure, CoverageTarget } from "./shape.js";

/**
 * The three rungs, and nothing else.
 *
 * STRUCTURAL ON PURPOSE, so that ../../schema/workflow.ts's `CoveragePolicy`
 * (which carries `scope` and `raw` besides) satisfies it without this module
 * importing the schema layer. The banding arithmetic below is pure -- it takes
 * numbers, not a document -- and keeping it that way is what lets ./report.ts
 * hold the reporting shape and the loader hold the reading.
 */
export interface CoverageLadder {
  readonly minimum: number;
  readonly recommended: number;
  readonly ideal: number;
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
