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
//
// USERS AND TEAMS ONLY (zheref/nen#160). `gh pr edit --add-reviewer` resolves
// a login through GitHub's `requestReviewsByLogin` mutation, which never
// resolves a `Bot` -- Copilot's own reviewer login included. ../pr/command.ts's
// doRequestReviews() resolves each `--add-reviewers` login BEFORE it reaches
// this module, and only a login that resolves as a collaborator (a User) is
// still handed to requestReviews() below; one that resolves as a Bot is
// routed to ./bots.ts's requestBotReviews() instead, through a different
// GraphQL mutation entirely. See that module's header for the whole story.

import { GH, outputLines, type Seams } from "../seam/exec.js";
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
  seams: Seams,
  target: Target,
  prNumber: number,
  reviewers: readonly string[],
): RequestReviewsResult {
  // NAMES THIS VERB'S OWN FLAG, `--add-reviewers` -- not `--reviewers`, which
  // belongs to `pr ready`/`pr next-blocker`. This refusal was written when
  // the flag here was still spelled `--reviewers` and never updated when it
  // became `--add-reviewers` (zheref/nen#95); the behaviour was always
  // correct -- nothing requested, exit 1 -- only the flag it named was wrong.
  if (reviewers.length === 0) {
    return { ok: false, message: "no reviewers named -- --add-reviewers takes a comma-separated list" };
  }
  const result = seams.run(GH, [...requestReviewsArgv(target, prNumber, reviewers)]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `could not request reviewers on ${target.slug}#${prNumber}: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
    };
  }
  return { ok: true, message: `requested ${reviewers.join(", ")} on ${target.slug}#${prNumber}` };
}
