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

interface PrFilesResponse {
  readonly files: readonly { readonly path: string }[];
}

/**
 * `gh pr view <n> --json files`. ONE CALL, no diff-name-only shell-out: `gh`'s
 * own `--json files` field is exactly the changed-path list this check needs,
 * and reading it through the same `mustJson` seam every other gh-reading verb
 * in this binary uses keeps this verb's failure mode identical to theirs -- a
 * non-JSON or non-zero answer is a ToolError, never an empty file list read as
 * "nothing changed, so nothing is outside the unit".
 */
export function fetchChangedFiles(seams: Seams, target: Target, prNumber: number): readonly string[] {
  const response = mustJson<PrFilesResponse>(seams, GH, [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    target.slug,
    "--json",
    "files",
  ]);
  return response.files.map((file): string => file.path);
}

/** The pure classification: every changed path the declared unit does NOT claim. */
export function outsideReleaseUnit(
  changedFiles: readonly string[],
  unitPaths: readonly string[],
): readonly string[] {
  return changedFiles.filter(
    (path): boolean => !unitPaths.some((pattern): boolean => matchesPattern(path, pattern)),
  );
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
  changedFiles: readonly string[],
): UnitCheckReport {
  const outsideUnit = outsideReleaseUnit(changedFiles, unitPaths);
  return {
    contract: UNIT_CHECK_CONTRACT,
    target: target.slug,
    pr: prNumber,
    unitPaths,
    changedFiles,
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
  for (const path of report.outsideUnit) lines.push(`  outside: ${path}`);
  return lines;
}
