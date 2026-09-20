// src/review/scopes.ts -- which review scopes a branch diff RAISES, and which
// of its paths no scope claims.
//
// IT CLASSIFIES AND IT DOES NOT SUMMON. This verb reads a diff and a policy and
// reports the intersection; it opens nothing, requests no review, spends no
// budget and names no gate. That is the whole design, and it is the same line
// ../gates/ready.ts draws for readiness: the classification is mechanical and
// auditable, the decision to act on it belongs to whoever is driving. A verb
// that raised a scope AND summoned its reviewer would be a verb whose dry run
// is a different program from its real one.
//
// AN UNCLAIMED PATH IS REPORTED, NEVER SWALLOWED. A repository whose scope
// table has a hole in it -- a new directory nobody added to any `paths` list --
// looks exactly like a repository whose diff raised no scope there, and the two
// are opposite findings: one is "nothing to review here", the other is "nobody
// is looking at this". So `unclaimed` is a first-class field of the document
// rather than the absence of a row, and a caller who wants "every path is
// claimed" can assert on it.
//
// THREE DOTS, LIKE ../report/data.ts's FILE LIST. `<base>...HEAD` is the
// merge-base diff -- the set a pull request shows -- so a trunk that moved on
// since the branch was cut does not raise a reviewer for somebody else's
// commits. A two-dot diff would raise security review on this effort because
// somebody else touched `hooks/` on main last week.
//
// THE PATH GRAMMAR IS ../report/patterns.ts's, NOT A SECOND ONE. `review.scopes`
// and `report data --tiers` are two tables in one language; see that module's
// header for why there is exactly one matcher.

import { VerbUsageError } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { matchesPattern } from "../report/patterns.js";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";
import type { ReviewScope, Workflow } from "../schema/workflow.js";

export const SCOPES_CONTRACT = "nen.review.scopes/v0.1";

/** One raised scope: the declaration's own fields, plus the paths that raised it. */
export interface RaisedScope {
  readonly scope: string;
  readonly persona: string;
  readonly tier: string;
  readonly budget: number;
  /** The changed paths this scope claims, in diff order. Never empty. */
  readonly paths: readonly string[];
}

export interface ScopesReport {
  readonly contract: string;
  readonly base: string;
  /** How many paths the diff carried. */
  readonly files: number;
  /** Raised scopes only, in the DECLARATION's order -- never the diff's. */
  readonly scopes: readonly RaisedScope[];
  /** Changed paths no declared scope claims. */
  readonly unclaimed: readonly string[];
}

/**
 * `git diff --name-only <base>...HEAD`.
 *
 * NAMES ONLY, not name-status: this verb asks which files a reviewer must read,
 * and a deletion is as much a thing to read as a modification. The rename case
 * is git's own -- `--name-only` prints the destination -- which is the path that
 * exists to be opened, exactly as ../report/data.ts's `path` is.
 */
export function readChangedPaths(seams: Seams, root: string, base: string): readonly string[] {
  const result = seams.run(GIT, ["diff", "--name-only", `${base}...HEAD`], { cwd: root });
  if (result.spawnFailed || result.code !== 0) {
    throw new VerbUsageError(
      `could not read the changed files ('git diff --name-only ${base}...HEAD' failed: ${
        result.spawnFailed ? result.stderr : outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }). Refusing to report an empty diff, which would read as a branch that raises no reviewer at all.`,
    );
  }
  // NO `.trim()` (Copilot, #221). `rawLines` preserves a path's exact bytes on
  // purpose, and git can and does carry a leading or trailing space in one --
  // trimming it here classified the trimmed spelling instead, so a scope's
  // pattern could claim a path that is not in the diff, or miss the one that
  // is, and `unclaimed` would name a path nobody could open. The only thing
  // filtered is the empty string, which is what a trailing newline produces.
  return rawLines(result.stdout).filter((line): boolean => line !== "");
}

/**
 * The classification itself: pure, so it is the half a test can drive with a
 * path list and no git at all.
 *
 * A PATH MAY RAISE SEVERAL SCOPES, and that is the point rather than an
 * accident: `nen/contract.json` is architecture AND security in hatsu's own
 * table, and a first-match-wins reading (which is what `report data`'s TIER
 * table does, deliberately, because a file has one tier) would silently drop
 * the second reviewer. A file has one tier and any number of readers.
 */
export function classifyScopes(
  paths: readonly string[],
  scopes: Readonly<Record<string, ReviewScope>>,
): { readonly scopes: readonly RaisedScope[]; readonly unclaimed: readonly string[] } {
  const raised: RaisedScope[] = [];
  const claimed = new Set<string>();
  for (const [name, scope] of Object.entries(scopes)) {
    const mine = paths.filter((path): boolean =>
      scope.paths.some((pattern): boolean => matchesPattern(path, pattern)),
    );
    if (mine.length === 0) continue;
    for (const path of mine) claimed.add(path);
    raised.push({ scope: name, persona: scope.persona, tier: scope.tier, budget: scope.budget, paths: mine });
  }
  return { scopes: raised, unclaimed: paths.filter((path): boolean => !claimed.has(path)) };
}

export function assembleScopes(
  paths: readonly string[],
  base: string,
  workflow: Workflow,
): ScopesReport {
  const classified = classifyScopes(paths, workflow.review.scopes);
  return {
    contract: SCOPES_CONTRACT,
    base,
    files: paths.length,
    scopes: classified.scopes,
    unclaimed: classified.unclaimed,
  };
}

/** The compact human rendering. `--json` carries the document itself. */
export function renderScopes(report: ScopesReport): readonly string[] {
  const lines = [
    `base '${plainLine(report.base)}': ${report.files} changed file(s)`,
    `raised: ${report.scopes.length === 0 ? "no scope" : `${report.scopes.length} scope(s)`}`,
  ];
  // A PERSONA, A TIER AND A PATH ARE ALL SOMEBODY ELSE'S TEXT (Copilot, #221
  // round 3): the first two come out of a repository's own workflow.json and
  // the third out of a git diff, and a terminal executes a control character
  // rather than printing it. `--json` above carries the bytes unchanged, for
  // the consumer that needs the real value. Same seam, same rule as
  // ../report/objects.ts's and ../pr/threads.ts's renderings.
  for (const scope of report.scopes) {
    lines.push(
      `  ${plainLine(scope.scope)}  ${plainLine(scope.persona)} (${plainLine(scope.tier)}, budget ${scope.budget})  ${scope.paths.length} path(s)`,
    );
    for (const path of scope.paths) lines.push(`      ${plainLine(path)}`);
  }
  // AN EMPTY DIFF IS NOT A CLEAN TABLE (Nobunaga N10). "every changed path is
  // claimed" about zero paths is a sentence that reads as a finding and is
  // not one -- the table was never exercised, so it has been neither proved
  // nor found wanting. The two states get two sentences.
  lines.push(
    report.files === 0
      ? `nothing classified: '${plainLine(report.base)}...HEAD' carries no changed path, so no scope was raised and no gap in the table was tested`
      : report.unclaimed.length === 0
        ? "unclaimed: none -- every changed path is claimed by a declared scope"
        : `unclaimed: ${report.unclaimed.length} path(s) no scope claims -- a hole in the table reads exactly like a clean diff, so it is reported rather than swallowed`,
  );
  for (const path of report.unclaimed) lines.push(`  ${plainLine(path)}`);
  return lines;
}
