// src/release/unitcheck.ts -- `nen release unit-check`: whether a pull
// request's changed files stay inside a DECLARED release unit.
//
// WHY THIS IS A NEN VERB AND NOT A PROSE STEP (maintainer's ruling,
// 2026-09-26: "make the three things that are still judged by reading rather
// than by a nen command be deterministic and rely on the nen command if
// they're processes that are meant to be deterministic"). "Does this PR touch
// only the release unit" used to be answered by a human reading a diff; the
// question is mechanical -- a changed-path set compared against a declared
// pattern list -- so it is answered here instead, the same way
// ../review/scopes.ts answers "which reviewer scopes does this diff raise"
// instead of leaving that to a reader's own judgement.
//
// THE PATTERN GRAMMAR IS ../report/patterns.ts's, NOT A SECOND ONE. See that
// module's header, and ../review/scopes.ts's, for why there is exactly one
// path-pattern language in this binary: `src/my-unit/**` claims the same files
// whether it sits in `review.scopes` or in `release.unitPaths`.
//
// `release.unitPaths` UNDECLARED IS A USAGE ERROR (exit 2), NEVER "EVERYTHING
// PASSES" OR "EVERYTHING FAILS". Both silent readings would let this verb
// report a verdict about a boundary the repository never drew -- see
// ../schema/workflow.ts's ReleasePolicy doc comment for the same rule stated
// at the schema layer.

import { matchesPattern } from "../report/patterns.js";
import { parseTarget, targetFromRemote, TargetError, type Target } from "../github/target.js";
import { GH, mustJson, type Seams } from "../seam/exec.js";

export const UNIT_CHECK_CONTRACT = "nen.release.unit-check/v0.1";

export class UnitCheckRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitCheckRefError";
  }
}

/** `<n>` or `<owner/name>#<n>` -- the two forms `--pr` accepts. */
const PR_REF = /^(?:([^\s#]+)#)?([0-9]{1,9})$/;

export interface ResolvedPrRef {
  /** `null` means "this checkout's own origin". */
  readonly slug: string | null;
  readonly number: number;
}

/**
 * `--pr <n|owner/name#n>`, resolved to a slug (or none) and a number.
 *
 * REFUSED, NEVER GUESSED, exactly like every other ref grammar in this binary
 * (../verbs/pr_ready.ts's `resolveRef`, ../pr/command.ts's `requirePrStrict`):
 * an unparseable token is a usage error naming the two forms, not an attempt
 * to salvage a reading from it.
 */
export function resolvePrRef(raw: string): ResolvedPrRef {
  const trimmed = raw.trim();
  const match = PR_REF.exec(trimmed);
  if (match === null) {
    throw new UnitCheckRefError(
      `'${raw}' is not a pull-request reference. Write --pr <n> (this checkout's own repository) or --pr <owner/name>#<n>.`,
    );
  }
  const parsed = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UnitCheckRefError(`'${raw}' names no positive pull-request number.`);
  }
  return { slug: match[1] ?? null, number: parsed };
}

/** Resolves the ref's target: the named slug, or this checkout's own origin. */
export function resolveUnitCheckTarget(seams: Seams, repoRoot: string, ref: ResolvedPrRef): Target {
  if (ref.slug === null) return targetFromRemote(seams, repoRoot);
  try {
    return parseTarget(ref.slug);
  } catch (error) {
    if (error instanceof TargetError) throw new UnitCheckRefError(error.message);
    throw error;
  }
}

interface PrFileEntry {
  readonly filename: string;
  readonly previous_filename?: string;
}

interface PrMetaResponse {
  // GitHub's REST API spells this `changed_files`; some gh-side JSON
  // re-encodings camel-case it as `changedFiles` -- both are read.
  readonly changed_files?: number;
  readonly changedFiles?: number;
}

/** One changed path, and the path it was renamed FROM when it is a rename. */
export interface ChangedFile {
  readonly path: string;
  /** `null` unless this entry is a rename -- then the file's PREVIOUS path. */
  readonly previousPath: string | null;
}

/** GitHub silently caps a pull request's files listing at this many entries. */
export const GITHUB_FILES_CAP = 3000;

export class UnitCheckTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnitCheckTruncatedError";
  }
}

/**
 * `gh api --paginate repos/{slug}/pulls/{n}/files`, not `gh pr view --json
 * files` -- that field is ITSELF paginated by `gh` without `--paginate`
 * ever being offered for it, so a large pull request's changed-path list
 * silently truncated with no signal this check could read. `--paginate`
 * walks every page of the REST endpoint directly, but WITHOUT `--slurp` it
 * writes each page's own JSON array to stdout back-to-back -- one page, one
 * array, no wrapping structure joining them -- which is not one parseable
 * JSON document once there is more than one page. `--slurp` is what turns
 * that into a single JSON array OF each page's array, which `JSON.parse`
 * can read, and which this function then flattens back into one changed-file
 * list.
 *
 * THE PR'S OWN `changed_files` COUNT IS CROSS-CHECKED against what the files
 * endpoint actually returned, and a mismatch -- or hitting GitHub's
 * documented 3000-file cap on this endpoint -- is refused rather than
 * silently reported as a possibly-incomplete unit-check verdict: this verb
 * exists so the answer is mechanical, and a mechanical answer over a
 * truncated list is worse than no answer.
 */
export function fetchChangedFiles(seams: Seams, target: Target, prNumber: number): readonly ChangedFile[] {
  const pages = mustJson<readonly (readonly PrFileEntry[])[]>(seams, GH, [
    "api",
    "--paginate",
    "--slurp",
    `repos/${target.slug}/pulls/${prNumber}/files`,
  ]);
  const entries = pages.flat();
  const meta = mustJson<PrMetaResponse>(seams, GH, ["api", `repos/${target.slug}/pulls/${prNumber}`]);
  const declared = meta.changed_files ?? meta.changedFiles;
  if (declared !== undefined && declared !== entries.length) {
    throw new UnitCheckTruncatedError(
      `'${target.slug}#${prNumber}' reports ${declared} changed file(s), but the files endpoint returned ${entries.length} -- the list is truncated, so a unit-check verdict off it would be a guess about files this check never saw.`,
    );
  }
  if (entries.length >= GITHUB_FILES_CAP) {
    throw new UnitCheckTruncatedError(
      `'${target.slug}#${prNumber}' has ${entries.length} changed file(s), at or past GitHub's ${GITHUB_FILES_CAP}-file cap on this endpoint -- the true changed-file set cannot be read past this point, so no unit-check verdict is given.`,
    );
  }
  return entries.map((entry): ChangedFile => ({ path: entry.filename, previousPath: entry.previous_filename ?? null }));
}

/**
 * The pure classification: every changed path the declared unit does NOT
 * claim. A RENAME'S PREVIOUS PATH IS CHECKED TOO -- a file the unit now owns
 * that was renamed in FROM outside it is still a change outside the unit's
 * declared boundary, not a change the unit can claim just because its new
 * name happens to sit inside.
 */
export function outsideReleaseUnit(
  changedFiles: readonly ChangedFile[],
  unitPaths: readonly string[],
): readonly string[] {
  const claims = (path: string): boolean => unitPaths.some((pattern): boolean => matchesPattern(path, pattern));
  const outside: string[] = [];
  for (const file of changedFiles) {
    const previousOutside = file.previousPath !== null && !claims(file.previousPath);
    if (!claims(file.path) || previousOutside) outside.push(file.path);
  }
  return outside;
}

export interface UnitCheckReport {
  readonly contract: string;
  readonly target: string;
  readonly pr: number;
  readonly unitPaths: readonly string[];
  readonly changedFiles: readonly string[];
  readonly outsideUnit: readonly string[];
  readonly ok: boolean;
}

export function assembleUnitCheck(
  target: Target,
  prNumber: number,
  unitPaths: readonly string[],
  changedFiles: readonly ChangedFile[],
): UnitCheckReport {
  const outsideUnit = outsideReleaseUnit(changedFiles, unitPaths);
  return {
    contract: UNIT_CHECK_CONTRACT,
    target: target.slug,
    pr: prNumber,
    unitPaths,
    changedFiles: changedFiles.map((file): string => file.path),
    outsideUnit,
    ok: outsideUnit.length === 0,
  };
}

export function renderUnitCheck(report: UnitCheckReport): readonly string[] {
  const lines = [
    `${report.target}#${report.pr}: ${report.changedFiles.length} changed file(s), unit '${report.unitPaths.join(", ")}'`,
    report.ok
      ? "every changed path is inside the release unit"
      : `${report.outsideUnit.length} path(s) outside the release unit`,
  ];
  // FEI-7: each path printed via JSON.stringify, so a path carrying a quote,
  // control character or leading/trailing space is unambiguous in the text
  // rendering rather than blending into the line around it.
  for (const path of report.outsideUnit) lines.push(`  outside: ${JSON.stringify(path)}`);
  return lines;
}
