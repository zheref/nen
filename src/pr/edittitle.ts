// src/pr/edittitle.ts -- `nen pr edit-title`: replace one pull request's title
// from a file, then read it back (zheref/nen#523).
//
// THE SIBLING OF ./editbody.ts, FOR THE OTHER FIELD. Before this verb a skill
// that had to fix a stale title fell back to a raw `gh pr edit --title`, which
// the Nen-first rule forbids. The shape is edit-body's: the number is
// CERTIFIED as a pull request (`pulls/<n>` resolves 200) before any write, the
// private-name guard runs on the new title, and `--dry-run` still performs the
// certifying read. Two things differ, and both are this module's reason to
// exist:
//
//   * THE CERTIFYING READ RETURNS THE CURRENT TITLE. The same `pulls/<n>` call
//     that proves the number is a pull request carries its title, so the dry
//     run can print what would be replaced without a second read.
//   * THE WRITE IS READ BACK. A title is one short string GitHub may normalise
//     (it trims surrounding whitespace, it caps the length), so "gh exited 0"
//     is not proof the title is the file's. The verb reads `pulls/<n>` again
//     after the write and compares exactly; a difference is a finding (exit 1)
//     naming both strings, never a silent success.
//
// THE TITLE TRAVELS ON THE ARGV (`--title <t>`), not on stdin: `gh pr edit`
// has no title-from-stdin form, and an argv element is never re-read from a
// path after the guard checked it -- the hazard zheref/nen#363 closed for the
// body does not exist for an argv string.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import type { Target } from "../github/target.js";

/** The contract id of `--json`. */
export const EDIT_TITLE_CONTRACT = "nen.pr.edit-title/v0.1";

/** The `gh` call, built once and used by BOTH the dry run and the real write. */
export function editTitleArgv(target: Target, pr: number, title: string): readonly string[] {
  return ["pr", "edit", String(pr), "--repo", target.slug, "--title", title];
}

// The two "not found" shapes, exactly as ./editbody.ts reads them (see its
// note on why 410 counts as much as 404).
const HTTP_404_OR_410 = /HTTP (404|410)\b/;

/**
 * Read `pulls/<n>` and return its title. Refuses (a usage error, exit 2) when
 * the number does not read as a pull request -- worded, as edit-body's
 * refusal is, so it never claims the number IS an issue. Any other failure,
 * or an answer with no string title, throws (exit 1).
 */
export function readPullRequestTitle(seams: Seams, target: Target, pr: number, purpose: "certify" | "read back"): string {
  const result = seams.run(GH, ["api", `repos/${target.slug}/pulls/${pr}`]);
  if (result.code !== 0) {
    if (!result.spawnFailed && HTTP_404_OR_410.test(result.stderr) && purpose === "certify") {
      throw new VerbUsageError(
        `#${pr} does not read as a pull request in ${target.slug} (the pulls endpoint answered ${
          /410/.test(result.stderr) ? "410" : "404"
        }) -- 'nen pr edit-title' replaces a PULL REQUEST's title only, and it is certified before any write, so nothing was changed. ` +
          `If #${pr} is an issue, its title is not this verb's to edit.`,
      );
    }
    throw new Error(
      `could not ${purpose === "certify" ? "certify" : "read back"} ${target.slug}#${pr} as a pull request: ${
        result.spawnFailed ? result.stderr : outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`could not ${purpose} ${target.slug}#${pr}: the pulls endpoint did not answer JSON.`);
  }
  const title = typeof parsed === "object" && parsed !== null ? (parsed as { title?: unknown }).title : undefined;
  if (typeof title !== "string") {
    throw new Error(`could not ${purpose} ${target.slug}#${pr}: the pulls endpoint's answer carries no string 'title'.`);
  }
  return title;
}

/** Replace the pull request's title. Throws on anything `gh` did not exit 0 on. */
export function writePullRequestTitle(seams: Seams, target: Target, pr: number, title: string): void {
  const result = seams.run(GH, editTitleArgv(target, pr, title));
  if (result.spawnFailed || result.code !== 0) {
    throw new Error(`could not replace ${target.slug}#${pr}'s title: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
  }
}
