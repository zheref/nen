// src/wc/ahead.ts -- `nen wc ahead` (zheref/nen#551): how far a branch has
// moved beyond a NAMED reviewed head, read from the clone and nothing else.
//
// WHY. Hatsu's `en` and `sharingan` guard every re-request of a bot review
// round with "count the commits ahead of the last reviewed head" -- a raw
// `git rev-list --count <reviewed-head>..HEAD` beside `git diff --stat`, named
// in en's residue because no verb took a named head (`wc classify` answers only
// against the base). A raw count has three ways to lie: a reviewed head the
// clone never fetched makes rev-list fail, and a caller reading "no number" as
// "no change" skips a round it owed; a force-push or a rebase leaves the
// reviewed head off the branch, where `rev-list --count` still prints a number
// (the commits reachable from HEAD and not from the old head) that is not "how
// much is new since review"; and zero commits is the one answer the guard acts
// on, so it must not share an exit code with anything else.
//
// THE FOUR VERDICTS (AC-4), each with its own exit code (./command.ts):
//   ahead     -- the reviewed head is an ancestor and N > 0 commits lie beyond
//                it; the count, the head's full id and the diff stat. Exit 0.
//   even      -- the reviewed head IS the branch's head: nothing new to review.
//                Exit 3, so `nen wc ahead ... && <re-request>` never fires on
//                zero reviewable change.
//   diverged  -- the reviewed head is not an ancestor of the branch (a
//                force-push, a rebase, a reset behind it). NEVER a count: every
//                count field is null. Exit 1.
//   unreadable -- the clone does not hold one of the two refs as a commit, or
//                git could not answer. Never zero, never "nothing new". Exit 2,
//                with the verdict still printed (and emitted under --json).
//
// READ-ONLY, AND NO FETCH (AS-1). rev-parse, merge-base --is-ancestor,
// rev-list --count and diff --numstat; nothing is written and no remote is
// reached, exactly as `wc overlap` reads merge-base diffs locally. A reviewed
// head the clone does not hold is `unreadable` -- fetching it is the caller's.

import { GIT, outputLines, type Seams } from "../seam/exec.js";

export type AheadVerdict = "ahead" | "even" | "diverged" | "unreadable";

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface AheadReport {
  readonly verdict: AheadVerdict;
  /** `--of` as typed. */
  readonly of: string;
  /** `--of` resolved to a full commit id; null when the clone does not hold it. */
  readonly reviewedHead: string | null;
  /** `--head` as typed (default `HEAD`). */
  readonly head: string;
  /** `--head` resolved to a full commit id; null when it does not resolve. */
  readonly headSha: string | null;
  /** Commits beyond the reviewed head; null unless `ahead` or `even`. */
  readonly ahead: number | null;
  /** Files changed between the two trees (`git diff --numstat <of> <head>`); null unless `ahead` or `even`. */
  readonly files: number | null;
  readonly insertions: number | null;
  readonly deletions: number | null;
  /** Why there is no count: the `diverged` or `unreadable` reason; null otherwise. */
  readonly reason: string | null;
}

/** The exit code each verdict carries (AC-4): the code alone distinguishes all four. */
export const AHEAD_EXIT: Readonly<Record<AheadVerdict, number>> = { ahead: 0, diverged: 1, unreadable: 2, even: 3 };

interface Resolved {
  readonly sha: string | null;
  readonly reason: string | null;
}

const gitReason = (stderr: string, fallback: string): string => outputLines(stderr).join(" ") || fallback;

/** One ref to a full commit id, or the reason it does not resolve. Never a fetch. */
function resolveCommit(seams: Seams, root: string, ref: string, flag: string): Resolved {
  const result = seams.run(GIT, ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (result.spawnFailed) return { sha: null, reason: "git could not be started" };
  const sha = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) {
    return { sha: null, reason: `the clone does not hold ${flag} '${ref}' as a commit (no fetch is made)${result.stderr.trim() === "" ? "" : `: ${gitReason(result.stderr, "")}`}` };
  }
  return { sha, reason: null };
}

/** `git diff --numstat` output to a stat; a binary file counts as a file with no lines. Null when malformed. */
export function parseNumstat(stdout: string): { files: number; insertions: number; deletions: number } | null {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const entry of stdout.split("\0")) {
    const line = entry.replace(/^\n+/, "");
    if (line === "") continue;
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (match === null) return null;
    files += 1;
    if (match[1] !== "-") insertions += Number(match[1]);
    if (match[2] !== "-") deletions += Number(match[2]);
  }
  return { files, insertions, deletions };
}

export function readAhead(seams: Seams, root: string, of: string, head: string): AheadReport {
  const none = { ahead: null, files: null, insertions: null, deletions: null };
  const reviewed = resolveCommit(seams, root, of, "--of");
  const tip = resolveCommit(seams, root, head, "--head");
  if (reviewed.sha === null || tip.sha === null) {
    const reason = [reviewed.reason, tip.reason].filter((line): line is string => line !== null).join("; ");
    return { verdict: "unreadable", of, reviewedHead: reviewed.sha, head, headSha: tip.sha, ...none, reason };
  }
  const known = { reviewedHead: reviewed.sha, headSha: tip.sha };
  const ancestry = seams.run(GIT, ["-C", root, "merge-base", "--is-ancestor", reviewed.sha, tip.sha]);
  if (ancestry.spawnFailed || (ancestry.code !== 0 && ancestry.code !== 1)) {
    const reason = ancestry.spawnFailed ? "git could not be started" : `git could not say whether --of is an ancestor of --head: ${gitReason(ancestry.stderr, `merge-base exit ${ancestry.code}`)}`;
    return { verdict: "unreadable", of, reviewedHead: known.reviewedHead, head, headSha: known.headSha, ...none, reason };
  }
  if (ancestry.code === 1) {
    return {
      verdict: "diverged",
      of,
      reviewedHead: known.reviewedHead,
      head,
      headSha: known.headSha,
      ...none,
      reason: `${reviewed.sha} is not an ancestor of ${tip.sha} -- a force-push, a rebase or a reset behind the reviewed head; no count is the answer`,
    };
  }
  if (reviewed.sha === tip.sha) {
    return { verdict: "even", of, reviewedHead: known.reviewedHead, head, headSha: known.headSha, ahead: 0, files: 0, insertions: 0, deletions: 0, reason: null };
  }
  const unread = (reason: string): AheadReport => ({ verdict: "unreadable", of, reviewedHead: known.reviewedHead, head, headSha: known.headSha, ...none, reason });
  const count = seams.run(GIT, ["-C", root, "rev-list", "--count", `${reviewed.sha}..${tip.sha}`]);
  if (count.spawnFailed) return unread("git could not be started");
  const ahead = Number(count.stdout.trim());
  if (count.code !== 0 || !/^\d+$/.test(count.stdout.trim())) return unread(`git rev-list --count failed: ${gitReason(count.stderr, `exit ${count.code}`)}`);
  // An ancestor that is not the head always has at least one commit beyond it;
  // a zero here is git disagreeing with itself, never "even".
  if (ahead === 0) return unread(`git rev-list counted 0 commits between two different commits ${reviewed.sha} and ${tip.sha}`);
  const diff = seams.run(GIT, ["-C", root, "diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", reviewed.sha, tip.sha, "--"]);
  if (diff.spawnFailed) return unread("git could not be started");
  const stat = diff.code === 0 ? parseNumstat(diff.stdout) : null;
  if (stat === null) return unread(`git diff --numstat failed: ${gitReason(diff.stderr, `exit ${diff.code}`)}`);
  return { verdict: "ahead", of, reviewedHead: known.reviewedHead, head, headSha: known.headSha, ahead, ...stat, reason: null };
}

export function renderAhead(report: AheadReport): readonly string[] {
  const lines: string[] = [];
  if (report.verdict === "ahead") lines.push(`verdict: ahead ${report.ahead ?? 0}`);
  else if (report.verdict === "even") lines.push("verdict: even (no commit beyond the reviewed head; nothing new to review)");
  else if (report.verdict === "diverged") lines.push(`verdict: diverged (${report.reason ?? ""})`);
  else lines.push(`verdict: unreadable (${report.reason ?? ""}; never read as nothing new)`);
  lines.push(`reviewed head: ${report.reviewedHead ?? "(unresolved)"} (--of ${report.of})`);
  lines.push(`head: ${report.headSha ?? "(unresolved)"} (--head ${report.head})`);
  if (report.files !== null) lines.push(`diff: ${report.files} file(s), +${report.insertions ?? 0} -${report.deletions ?? 0}`);
  return lines;
}
