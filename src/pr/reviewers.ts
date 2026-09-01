// src/pr/reviewers.ts -- `gh pr edit --add-reviewer`, tensho §5's "request
// Copilot on open -- on the maintainer's user token; it registers, where a bot
// token silently no-ops (S6)".
//
// THE REVIEWER NAMES ARE THE CALLER'S DATA. Which reviewer(s) a repository
// wants requested on open is that repository's own configuration
// (../schema/gates.ts's baseReviewers, typically), never a literal this module
// knows. The S6 caveat -- request on the MAINTAINER's token, because a bot
// token no-ops -- is an operational fact about WHICH CREDENTIAL runs `gh`, not
// something this module can enforce from inside a single `gh` call; it is
// carried in the usage text (src/pr/verb.ts) as a warning instead.

import { lines, type Runner } from "../exec/seam.js";
import type { Target } from "../github/target.js";

export function requestReviewsArgv(target: Target, prNumber: number, reviewers: readonly string[]): readonly string[] {
  const argv = ["pr", "edit", String(prNumber), "--repo", target.slug];
  for (const reviewer of reviewers) argv.push("--add-reviewer", reviewer);
  return argv;
}

export interface RequestReviewsResult {
  readonly ok: boolean;
  readonly message: string;
}

export function requestReviews(
  runner: Runner,
  target: Target,
  prNumber: number,
  reviewers: readonly string[],
): RequestReviewsResult {
  if (reviewers.length === 0) {
    return { ok: false, message: "no reviewers named -- --reviewers takes a comma-separated list" };
  }
  const result = runner.run({ bin: "gh", args: [...requestReviewsArgv(target, prNumber, reviewers)] });
  if (result.code !== 0) {
    return {
      ok: false,
      message: `could not request reviewers on ${target.slug}#${prNumber}: ${
        (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`
      }`,
    };
  }
  return { ok: true, message: `requested ${reviewers.join(", ")} on ${target.slug}#${prNumber}` };
}
