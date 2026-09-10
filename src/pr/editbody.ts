// src/pr/editbody.ts -- `nen pr edit-body`: replace one pull request's body
// outright, byte for byte, through `gh pr edit --body-file`.
//
// THE SAME PRIMITIVE ../issue/editbody.ts IS, FOR THE OTHER OBJECT CLASS, and
// most of that module's header applies unchanged: no template, no merge, the
// file's bytes become the body exactly, read raw and checked before anything
// is sent so a `--dry-run` byte count is the byte count that would actually
// be sent.
//
// WHY THIS SIDE'S CERTIFICATION IS ITS OWN CALL, NOT A SHARED ONE. GitHub
// numbers issues and pull requests in one sequence, and `issues/{n}` serves
// both -- which is exactly why ../issue/subissue.ts's `readIssue` can tell
// them apart FROM THE ISSUE SIDE. The `pr` family does not import from the
// `issue` family (each owns its own reads, the way `pr`/`issue` already
// duplicate `requireTarget` rather than share one), so this module reads the
// endpoint that answers the question from the OTHER direction instead:
// `pulls/{n}` resolves 200 for a genuine pull request and 404/410 for
// anything else sharing that number (an issue, or nothing at all) -- the
// exact "read the object first" seam this verb's own spec asks for.
//
// A 404/410 IS NOT PROOF THE NUMBER NAMES AN ISSUE, and the refusal below
// says so honestly rather than overclaiming: `pulls/{n}` cannot distinguish
// "this is an issue" from "this number does not exist at all". Both cases are
// too far from a pull request for this verb to write to them, so both refuse
// the same way -- with a wording that points at `issue edit-body` as the next
// step rather than asserting a fact this one read did not establish.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import type { Target } from "../github/target.js";

/**
 * The `gh` call, built once and used by BOTH the dry run and the real write --
 * see ../issue/comment.ts's `commentArgv` for why that matters.
 */
export function editBodyArgv(target: Target, pr: number, bodyFile: string): readonly string[] {
  return ["pr", "edit", String(pr), "--repo", target.slug, "--body-file", bodyFile];
}

// 404 and 410 are the two shapes GitHub answers "not found" with on this
// endpoint -- ../issue/subissue.ts's own `is404or410` names the same pair for
// the sub-issues endpoint, for the same reason: a 410 (Gone) means "this used
// to resolve and no longer does", which is exactly as much "not a pull
// request right now" as a 404 is, and treating only 404 as the refusal shape
// would let a gone/deleted number fall through to the generic "could not
// certify" failure below instead of naming what it actually is.
const HTTP_404_OR_410 = /HTTP (404|410)\b/;

/**
 * Refuse (as a usage error, exit 2) when `pr` does not read as a pull
 * request, BEFORE anything is written. See this file's header for why the
 * refusal cannot claim the number names an issue -- only that it does not
 * name a pull request.
 */
export function certifyPullRequest(seams: Seams, target: Target, pr: number): void {
  const result = seams.run(GH, ["api", `repos/${target.slug}/pulls/${pr}`]);
  if (result.code === 0) return;
  if (!result.spawnFailed && HTTP_404_OR_410.test(result.stderr)) {
    throw new VerbUsageError(
      `#${pr} does not read as a pull request in ${target.slug} (the pulls endpoint answered ${
        /410/.test(result.stderr) ? "410" : "404"
      }) -- 'nen pr edit-body' replaces a PULL REQUEST's body only, and it is certified before any write, so nothing was changed. ` +
        `If #${pr} is an issue, ask 'nen issue edit-body' instead.`,
    );
  }
  throw new Error(
    `could not certify ${target.slug}#${pr} as a pull request: ${
      result.spawnFailed ? result.stderr : outputLines(result.stderr).join(" ") || `exit ${result.code}`
    }`,
  );
}

/** Replace the pull request's body. Throws on anything `gh` did not exit 0 on. */
export function writePullRequestBody(seams: Seams, target: Target, pr: number, bodyFile: string): void {
  const argv = editBodyArgv(target, pr, bodyFile);
  const result = seams.run(GH, argv);
  if (result.spawnFailed || result.code !== 0) {
    throw new Error(
      `could not replace ${target.slug}#${pr}'s body: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
    );
  }
}
