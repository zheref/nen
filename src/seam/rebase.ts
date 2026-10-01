/**
 * Is git stopped in the middle of a rebase? ONE reading for every verb that
 * asks (zheref/nen#307): `nen wc catch-up` and `nen shu warmup` used to ask
 * two different questions of the same checkout and could disagree.
 *
 * The question is asked of git, never of `.git/` directly -- and asked as
 * `git rebase --show-current-patch`, NOT as the `REBASE_HEAD` ref: git (2.50
 * and 2.54 measured) leaves that ref behind after a rebase completes, so a
 * check on it reads a FINISHED rebase as one still in progress. Warmup did
 * exactly that, refusing a clean checkout and naming `git rebase --abort` for
 * a rebase that no longer existed.
 *
 * The exit code answers, with no stderr text and so no locale (git 2.54
 * measured, merge backend):
 *
 *   0    a rebase is stopped ON A PATCH -- a conflict, or an `edit` stop.
 *   1    a rebase is paused with NO current patch -- a `break` line or a
 *        failed `exec` line. The rebase state exists; `git show REBASE_HEAD`,
 *        which the option runs, is what failed. The `REBASE_HEAD` check this
 *        replaces missed this stop too.
 *   128  no rebase git will name ("fatal: no rebase in progress"). 128 is
 *        git's generic die() code, so it is ALSO what a `git am` session in
 *        progress answers ("It looks like 'git am' is in progress"). This
 *        reading says nothing about `am`; a caller that must refuse one asks
 *        about it separately.
 *
 * Anything else, including a git killed by a signal (`null`), is an
 * unanswered question, which a caller must never read as "no".
 */

/** The argv, after `git`, that asks the question. */
export const REBASE_IN_PROGRESS_ARGV: readonly string[] = ["rebase", "--show-current-patch"];

/** What the answer means. */
export type RebaseState = "on-patch" | "paused" | "none" | "unknown";

/** How the exit code reads. */
export function rebaseState(exitCode: number | null): RebaseState {
  if (exitCode === 0) return "on-patch";
  if (exitCode === 1) return "paused";
  if (exitCode === 128) return "none";
  return "unknown";
}
