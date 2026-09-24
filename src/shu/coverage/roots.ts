// src/shu/coverage/roots.ts -- which directory a coverage report's own row
// names are relative to, and the rewrite that makes them repo-relative. Pure:
// the one filesystem question it asks ("is this repo-relative path a file?")
// is a function it is HANDED, so this directory stays text-in-shape-out
// (../../profiles/inertness.test.ts's rule for it).
//
// WHY THIS EXISTS -- zheref/nen#236. A workspace monorepo runs its coverage
// tool once per member, and each member's tool writes its LCOV `SF:` lines
// relative to THAT MEMBER (`SF:src/domain/endeavor/Defer.ts` inside
// `packages/core/coverage/lcov.info`), while `git diff --name-only` names the
// same file relative to the REPOSITORY (`packages/core/src/domain/endeavor/
// Defer.ts`). Joined as-is, the two never meet: 0 of 58 touched files matched
// on the repository that reported it, at exit 0. The report is not wrong and
// neither is git; the join was missing the root each report was written from.
//
// HOW THE ROOT IS INFERRED, AND WHY THIS RULE. A report does not state its own
// root -- LCOV has no header for it, and Istanbul's summary keys are whatever
// the reporter was configured to write -- so nen proposes a small, ordered set
// of candidates and lets the TREE decide among them:
//
//   1. `artifact` -- the artifact's own directory with ONE trailing `coverage`
//      segment removed (`packages/core/coverage/lcov.info` -> `packages/core`).
//      `coverage/` is the directory every JS/TS coverage tool in the reference
//      pack writes into by default, under the package it ran in, so its parent
//      is the likeliest place the run was rooted. Proposed ONLY when that
//      segment is there: an artifact at `build/reports/lcov.info` says nothing
//      about where its run started, and guessing `build/reports` would be a
//      root nobody's tool uses.
//   2. `lane-cwd` -- the lane's declared `cwd`, which is where nen ran the
//      tool. The right answer for a single-package lane rooted in a
//      subdirectory, whatever its report is called.
//   3. `repo-root` -- the repository itself, which is where every row already
//      was before this module existed. Keeping it as a candidate is what makes
//      a single-package repository (lane cwd == artifact root == repo root)
//      reach EXACTLY the answer it always had.
//
// Each candidate is scored by how many of the report's relative row names name
// a file that EXISTS under it, and the highest score wins; a tie goes to the
// earlier candidate in the list above. Existence is the only evidence on disk
// that says "this is the directory these names were written from", and it is
// asked of the working tree the run just measured -- so a report whose files
// are all there picks the root that finds them, and a report whose files are
// NOT there (a fixture, a deleted tree) falls back to the order above rather
// than to a coin toss. The root is chosen ONCE PER ARTIFACT, never per row:
// one tool run has one root, and a per-row choice could join two rows of one
// report against two different directories and call both correct.
//
// WHAT IS NEVER REBASED. An ABSOLUTE row name is already anchored, and
// ../../coverage.ts's `relativiseName` makes it repo-relative (or leaves it,
// if it lies outside the tree) exactly as it always has. A relative name that
// would climb out of the repository once joined (`../../elsewhere.ts`) is left
// exactly as the report wrote it, for the same reason an outside-the-tree
// absolute name is: it is a fact about the run, not a path to invent. And a
// PACKAGE-grain report (cobertura, jacoco) is not rebased at all -- its rows
// are package names, not paths, and `touchedByPackage` already matches them
// anywhere inside a touched path.

import { posix } from "node:path";
import type { CoverageTarget } from "./shape.js";

/** Which candidate a root came from -- carried into `--json` so the join is auditable. */
export type RootBasis = "artifact" | "lane-cwd" | "repo-root";

export interface RootCandidate {
  /** Repo-relative, `/`-separated; `""` is the repository root itself. */
  readonly root: string;
  readonly basis: RootBasis;
}

export interface ResolvedRoot extends RootCandidate {
  /** How many of the report's relative row names name a file under `root`. */
  readonly onDisk: number;
  /** How many relative row names there were to test -- the denominator. */
  readonly relative: number;
}

function toSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/** A row name that is anchored already: POSIX-absolute, a drive letter, or a UNC path. */
export function isAbsoluteName(name: string): boolean {
  const slashed = toSlashes(name);
  return slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed);
}

/** `a/b/` -> `a/b`, `.` -> `` -- the one spelling of a repo-relative directory. */
function normaliseDir(value: string): string {
  const normal = posix.normalize(toSlashes(value));
  const trimmed = normal.endsWith("/") ? normal.slice(0, -1) : normal;
  return trimmed === "." ? "" : trimmed;
}

/**
 * The candidate roots for one artifact, in preference order, deduplicated.
 *
 * `artifactPath` and `laneCwd` are both REPO-RELATIVE. A duplicate keeps its
 * EARLIER basis, so a single-package repository reports `artifact` for the
 * root `coverage/lcov.info` implies -- which is also the lane cwd and the repo
 * root -- rather than a basis that depends on which spelling came last.
 */
export function rootCandidates(artifactPath: string, laneCwd: string): readonly RootCandidate[] {
  const candidates: RootCandidate[] = [];
  const directory = posix.dirname(toSlashes(artifactPath));
  const segments = normaliseDir(directory).split("/").filter((part): boolean => part !== "");
  if (segments[segments.length - 1] === "coverage") {
    candidates.push({ root: segments.slice(0, -1).join("/"), basis: "artifact" });
  }
  candidates.push({ root: normaliseDir(laneCwd), basis: "lane-cwd" });
  candidates.push({ root: "", basis: "repo-root" });
  const seen = new Set<string>();
  return candidates.filter((candidate): boolean => {
    if (seen.has(candidate.root)) return false;
    seen.add(candidate.root);
    return true;
  });
}

/**
 * `root` + `name`, repo-relative and `/`-separated -- or null when the join
 * would leave the repository (a `..` that climbs past the root).
 */
export function joinUnder(root: string, name: string): string | null {
  const joined = posix.normalize(root === "" ? toSlashes(name) : `${root}/${toSlashes(name)}`);
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return null;
  return joined;
}

/**
 * Pick one root for one report, by how many of its rows exist under each
 * candidate. Ties -- including the all-zero tie of a tree with none of the
 * files on it -- go to the EARLIER candidate.
 */
export function resolveRoot(
  rows: readonly CoverageTarget[],
  candidates: readonly RootCandidate[],
  exists: (repoRelative: string) => boolean,
): ResolvedRoot {
  const relative = rows.filter((row): boolean => !isAbsoluteName(row.name));
  /* c8 ignore next -- rootCandidates always returns at least the repo root */
  const first = candidates[0] ?? { root: "", basis: "repo-root" as const };
  let best: ResolvedRoot = { ...first, onDisk: -1, relative: relative.length };
  for (const candidate of candidates) {
    let onDisk = 0;
    for (const row of relative) {
      const joined = joinUnder(candidate.root, row.name);
      if (joined !== null && exists(joined)) onDisk += 1;
    }
    if (onDisk > best.onDisk) best = { ...candidate, onDisk, relative: relative.length };
  }
  return best;
}

/**
 * Every RELATIVE row name rewritten to be repo-relative under `root`.
 *
 * Absolute names are returned untouched -- the caller's `relativiseName` owns
 * those -- and so is a relative name whose join would leave the repository.
 */
export function rebaseRows(rows: readonly CoverageTarget[], root: string): readonly CoverageTarget[] {
  return rows.map((row): CoverageTarget => rebaseOne(row, root));
}

function rebaseOne(row: CoverageTarget, root: string): CoverageTarget {
  if (isAbsoluteName(row.name)) return row;
  const joined = joinUnder(root, row.name);
  // AT THE REPOSITORY ROOT THE NAME IS KEPT BYTE-FOR-BYTE, not normalised: a
  // single-package repository's rows print exactly as they did before this
  // module existed (zheref/nen#236 acceptance 6), backslashes and all.
  if (joined === null || root === "") return row;
  return joined === row.name ? row : { ...row, name: joined };
}
