// src/pr/cascade.ts -- cascade a trunk branch into the current one, by MERGE.
//
// MERGE, NEVER REBASE. The drive skill (§5) is explicit and this is not a
// style preference: rebasing a branch that is already pushed rewrites commits
// another actor (a CI builder, a reviewer's fork) may already hold, and the
// force-push that follows is the exact operation this whole binary's callers
// refuse to reach for silently. `git merge` is the only cascade a shared branch
// tolerates.
//
// A CONFLICT IS REPORTED, NEVER RESOLVED HERE. This module fetches and merges;
// it does not run `git merge --abort`, does not pick a side, and does not
// push when the merge left conflict markers behind. Resolving a real conflict
// is a judgment call (which side's change is right) that stays with whoever
// is driving -- exactly the "what stays with the LLM" line issue #4 draws
// everywhere else.

import { lines, type Runner } from "../exec/seam.js";

export interface CascadeResult {
  readonly conflicted: boolean;
  readonly pushed: boolean;
  readonly log: readonly string[];
  readonly error: string | null;
}

export function cascadeMain(runner: Runner, cwd: string, trunk = "main"): CascadeResult {
  const log: string[] = [];

  const fetch = runner.run({ bin: "git", args: ["fetch", "origin", trunk], cwd });
  if (fetch.code !== 0) {
    return {
      conflicted: false,
      pushed: false,
      log,
      error: `could not fetch origin/${trunk}: ${(fetch.spawnError ?? lines(fetch.stderr).join(" ")) || `exit ${fetch.code}`}`,
    };
  }
  log.push(`fetched origin/${trunk}`);

  const merge = runner.run({
    bin: "git",
    args: ["merge", "--no-edit", `origin/${trunk}`],
    cwd,
  });
  if (merge.code !== 0) {
    log.push(`merge left conflicts -- resolve them, then commit and push yourself; this cascade never picks a side`);
    return { conflicted: true, pushed: false, log, error: null };
  }
  log.push(`merged origin/${trunk} cleanly`);

  const push = runner.run({ bin: "git", args: ["push"], cwd });
  if (push.code !== 0) {
    return {
      conflicted: false,
      pushed: false,
      log,
      error: `merged cleanly but could not push: ${(push.spawnError ?? lines(push.stderr).join(" ")) || `exit ${push.code}`}`,
    };
  }
  log.push("pushed");
  return { conflicted: false, pushed: true, log, error: null };
}
