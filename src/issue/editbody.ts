// src/issue/editbody.ts -- `nen issue edit-body`: replace one issue's body
// outright, byte for byte, through `gh issue edit --body-file`.
//
// WHY IT EXISTS. `nen issue file` writes an issue's OPENING body once, at
// create time, and there was no mechanised way to REPLACE it afterwards --
// a skill that needed to rewrite a stale plan, a reconciled parent body, or a
// template-filled section had to drop back to a hand-run `gh issue edit
// <n> --body-file <f>` for the one step that changes what an issue says,
// the same gap ./comment.ts's header records for posting. This verb closes
// it for the body specifically: no template, no merge, no diff -- the file's
// bytes become the issue's body, exactly.
//
// WHY IT DOES NOT ACCEPT A PULL REQUEST'S NUMBER, AND `issue comment` DOES.
// GitHub numbers issues and pull requests in one sequence and serves both
// from `issues/{n}`, and ./comment.ts's own header explains why a comment
// accepts either class deliberately: posting a caller's text is what the
// caller asked for either way, and the printed URL makes a mistyped number
// visible on the very next line. REPLACING THE WHOLE BODY IS A DIFFERENT
// ACT. It is not additive -- whatever the object said before is gone -- and
// it is invisible the moment the command exits, the same property that made
// ./subissue.ts's attach/close refuse a pull request rather than accept one
// silently. So this verb certifies the number as an ISSUE, over the same
// `issues/{n}` read `readIssue` already performs for that family, before it
// writes anything at all.
//
// THE FILE IS READ RAW, AND CHECKED BEFORE ANYTHING IS SENT -- the same two
// decisions ./comment.ts's `--body-file` path makes, for the same reasons: a
// `--dry-run` whose printed byte count is not the byte count that would be
// sent is not a dry run, and `gh` is handed the caller's ORIGINAL path
// untouched, so both sides read the same bytes without either one moving.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import type { Target } from "../github/target.js";
import { readIssue } from "./subissue.js";

/**
 * The `gh` call, built once and used by BOTH the dry run and the real write --
 * see ../issue/comment.ts's `commentArgv` for why that matters: the argv a
 * caller approves in a dry run must be the argv that runs, not a rendering of
 * it a later edit can drift away from.
 */
export function editBodyArgv(target: Target, issue: number, bodyFile: string): readonly string[] {
  return ["issue", "edit", String(issue), "--repo", target.slug, "--body-file", bodyFile];
}

/**
 * Refuse (as a usage error, exit 2) when `issue` turns out to name a pull
 * request, BEFORE anything is written.
 *
 * Reuses `readIssue` rather than a second `gh api issues/{n}` call of its
 * own: that function already reads the one endpoint that discriminates both
 * object classes for this family (`pull_request` present on a pull request,
 * absent on a genuine issue), and it is already the certification
 * `attach-sub`/`consolidate-close` run for the same reason -- see
 * ./subissue.ts's header.
 *
 * A USAGE ERROR, NOT `NotAnIssueError`, AND THAT IS A DELIBERATE DIFFERENCE
 * FROM THIS FAMILY'S OTHER OBJECT-CLASS REFUSAL. `attach-sub` and
 * `consolidate-close` throw `NotAnIssueError` (exit 1, a "this specific
 * write was refused" report) because they may be certifying several numbers
 * at once and reporting which ones were the problem. `edit-body` certifies
 * exactly one number that the caller named directly with `--issue`, on a
 * verb whose whole shape says "you are pointed at the wrong family" -- the
 * same class of mistake a malformed flag is. `VerbUsageError` (exit 2) says
 * that plainly, and matches the exit code this verb's own spec requires.
 */
export function certifyIssue(seams: Seams, target: Target, issue: number): void {
  const summary = readIssue(seams, target, issue);
  if (!summary.isPullRequest) return;
  throw new VerbUsageError(
    `#${issue} names a pull request in ${target.slug}, not an issue -- 'nen issue edit-body' replaces an ISSUE's body only, and it is certified before any write, so nothing was changed. ` +
      `Ask 'nen pr edit-body' for the pull request's body instead.`,
  );
}

/** Replace the issue's body. Throws on anything `gh` did not exit 0 on. */
export function writeIssueBody(seams: Seams, target: Target, issue: number, bodyFile: string): void {
  const argv = editBodyArgv(target, issue, bodyFile);
  const result = seams.run(GH, argv);
  if (result.spawnFailed || result.code !== 0) {
    throw new Error(
      `could not replace ${target.slug}#${issue}'s body: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
    );
  }
}
