// src/changelog/reconcile.ts -- the ONE CON-33(c) reconciliation, for every
// verb that reconciles a merge range against a CHANGELOG, together with the
// release-PR allowance (zheref/nen#229).
//
// WHY ONE FUNCTION. `nen changelog completeness` and `nen release preflight`
// answer the same question about the same range, and each used to spell the
// `git log --merges` read, the three extractions and the set difference by
// hand. Two spellings of one rule are two chances to disagree -- the shared
// fragment-directory default in ./completeness.ts exists because they already
// did once (zheref/nen#10 item 5). An allowance that loosens the rule is the
// last thing that may live in only one of them, so the whole reconciliation,
// allowance included, is this module's, and a verb only reads its inputs and
// prints its answer.
//
// THE ALLOWANCE, AND WHY IT IS THIS NARROW. A release proposal introduces the
// dated section before its own pull request exists, so the section cannot
// cite that PR, and the cut point -- the PR's own merge -- always reported it
// missing. Every release paid a follow-up "reconcile" PR to add one number to
// one line (73fa029, ec6f67e, 1e70c3d, deac451; 09741c7 inside #268). The
// allowance reconciles ONE PR without a citation: the terminal PR whose merge
// INTRODUCED the dated section being cut, read from git rather than inferred:
//
//   1. `--range` is `<vPrev>..<vNew>`, and its end commit is a two-parent
//      `Merge pull request #N` merge -- the TERMINAL merge of the range. A
//      range that ends anywhere else has no PR at its end to excuse.
//   2. #N is uncited. A cited PR needs no allowance.
//   3. `--changelog` opens with a DATED section (`## vX.Y.Z` or `### vX.Y.Z`,
//      not `— unreleased`; ./completeness.ts says why), and the CHANGELOG at
//      the terminal merge opens with the SAME dated section: the section being
//      cut is the one this merge carries.
//   4. That dated section is ABSENT at the terminal merge's first parent --
//      the trunk just before the merge -- so it arrived with this merge. An
//      undated `## vX.Y.Z — unreleased` there does not count as present: the
//      PR that DATES it is the one that introduced the dated section.
//   5. No OTHER merge on the PR's own branch (`<first>..<second>` parent)
//      introduced it -- absent at that merge's first parent, present at the
//      merge. EVERY merge counts, a local `git merge` as much as a
//      pull-request merge (this repository merges branches locally: fe35fbb,
//      297ad64). This is what separates AUTHORING the section from CARRYING
//      it: when a release bump reaches a feature branch -- by a PR or by hand
//      -- and a later PR carries that branch to main (the #225 shape
//      zheref/nen#229 names), the carrying merge also passes 4, but another
//      merge on its branch introduced the section, so the carrying PR is a
//      real change the section must still name, and it fails. (In nen's
//      actual v0.12.0 history the section had reached main even earlier,
//      through #221, so #225 fails at 4 there;
//      ./reconcile.integration.test.ts builds the graphs in which only 5 can
//      catch it.) A merge into the release branch AFTER the section was
//      written found it on its own first parent, introduced nothing, and does
//      not block.
//
// "Introduced" is therefore established entirely from commits the range
// already names and CHANGELOG blobs at those commits -- no GitHub call, no PR
// metadata, nothing a later edit to a PR could change. The section is matched
// by VERSION among dated headings, so a later PR that only re-dates or
// re-themes an already-dated heading introduced nothing.
//
// WHAT THIS CANNOT TELL APART, SAID PLAINLY. The history proves that the
// terminal PR's merge introduced the dated section. It does not prove that the
// PR is a release proposal: a DELIVERY PR that opens the dated section itself
// (nen's own #221 did, in b1e0959, inside a 33-file delivery) has the same
// history, and it is excused the same way when it ends the range. One
// conservative edge declines where it could excuse: a `git pull` merge whose
// first parent is a local copy of the branch WITHOUT the section and whose
// second parent is the pushed copy WITH it reads as another merge introducing
// the section (5), even though the same author wrote both.
//
// FAIL CLOSED, ALWAYS. Every git read below that fails, answers in a shape
// this module does not recognise, or names a path it cannot resolve DECLINES
// the allowance (`history-unreadable`, `terminal-unreadable`) -- it never
// throws past the citation check, and it never grants. Declining leaves the
// reconciliation exactly as strict as it was before this allowance existed,
// which is the only safe direction for a check that gates a release tag.
//
// A RANGE IS NEVER AN OPTION. `--range` used to reach `git log` as a bare
// argument, so `--range=--output=<file>..HEAD` made git write the log to a
// file, left nothing to reconcile, and passed the gate (exit 0) -- a false
// pass on a release precondition. This module is now the single place that
// argument reaches git, so it is refused here, before any git call, when any
// revision in it begins with '-', and every revision this module hands git
// sits behind `--end-of-options` besides (git >= 2.24; ../wc/publish.ts
// carries the same guard for the same reason).

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { GIT, must, normalizeEol, outputLines, type Seams } from "../seam/exec.js";
import {
  checkCompleteness,
  datedSections,
  extractChangelogRefs,
  extractFragmentRefs,
  extractMergedPrNumbers,
  openingDatedSection,
  sectionHeadings,
  type CompletenessReport,
  type ReleasePrAllowance,
  type ReleasePrVerdict,
} from "./completeness.js";

export interface ReconcileInput {
  /** `<vPrev>..<vNew>`, as `git log --merges` understands it. */
  readonly range: string;
  /** `--changelog` as given: absolute, or relative to the repository root. */
  readonly changelogPath: string;
  /** Its text, already read through the shared reader. */
  readonly changelogText: string;
  /** Scopes changelog link matching to THIS repository. */
  readonly ownerRepo: string;
  /** Fragment file names found in the fragment directory, collated or not. */
  readonly fragmentNames: readonly string[];
}

/**
 * Reconcile every PR merged in `input.range` against the CHANGELOG and the
 * fragments, applying the release-PR allowance where the history proves it.
 * The `git log --merges` read is the one both verbs always ran, so a failure
 * there is the same ToolError it always was; only the allowance's own reads
 * fail closed. A range with a revision beginning with '-' is a usage error
 * (exit 2) before any git call -- see this file's header.
 */
export function reconcileChangelog(seams: Seams, root: string, input: ReconcileInput): CompletenessReport {
  refuseOptionShapedRange(input.range);
  const mergeLog = must(seams, GIT, ["log", "--merges", "--format=%s", "--end-of-options", input.range], { cwd: root });
  const mergedPrNumbers = extractMergedPrNumbers(outputLines(mergeLog.stdout));
  const changelogRefs = extractChangelogRefs(input.changelogText, input.ownerRepo);
  const fragmentRefs = extractFragmentRefs(input.fragmentNames);

  const cited = checkCompleteness({ mergedPrNumbers, changelogRefs, fragmentRefs });
  // NO GIT WORK WHEN NOTHING IS MISSING. The allowance can only ever excuse,
  // so a range that already reconciles has nothing for it to decide, and the
  // clean path runs exactly the one git call it always ran.
  if (cited.ok) return cited;

  const releasePrAllowance = decideReleasePrAllowance(seams, root, input, cited.missing);
  return checkCompleteness({ mergedPrNumbers, changelogRefs, fragmentRefs, releasePrAllowance });
}

/**
 * Refuse, as a usage error, a `--range` any of whose revisions begins with
 * '-'. No revision git accepts is spelled that way, and git reads such a
 * token as an OPTION -- `--output=<file>` sends the merge log to a file and
 * leaves an empty answer that reconciles trivially. `--end-of-options` below
 * already stops git from reading it as one; this refusal says so to the
 * caller at exit 2 rather than letting git fail on a revision it cannot
 * resolve at exit 1.
 */
export function refuseOptionShapedRange(range: string): void {
  const revisions = range.split(/\.{2,3}/);
  if (revisions.some((revision): boolean => revision.startsWith("-"))) {
    throw new VerbUsageError(
      `--range '${range}' has a revision beginning with '-'. A revision never starts with '-', and git would read it as an option (--output=<file> writes the merge log to a file and leaves nothing to reconcile, which would pass this check). Pass '<vPrev>..<vNew>'; nothing was run.`,
    );
  }
}

/**
 * The end commit of a `<vPrev>..<vNew>` range -- `HEAD` when the right side
 * is empty, as git reads `v1..` -- or null for any other shape. A symmetric
 * `a...b` range and a bare ref have no single terminal commit, so they are
 * not guessed at. (Git refuses `..` inside a ref name, so the first `..` is
 * always the range operator.)
 */
export function rangeEnd(range: string): string | null {
  if (range.includes("...")) return null;
  const at = range.indexOf("..");
  if (at === -1 || range.includes("..", at + 2)) return null;
  const end = range.slice(at + 2);
  return end === "" ? "HEAD" : end;
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const PR_MERGE = /^Merge pull request #(\d+)/;

interface CommitFacts {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly subject: string;
}

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };

function failed(args: readonly string[], why: string): { readonly ok: false; readonly detail: string } {
  return { ok: false, detail: `'git ${args.join(" ")}' ${why}` };
}

function whyItFailed(result: { code: number; stderr: string; spawnFailed: boolean }): string {
  if (result.spawnFailed) return "could not be started";
  const said = outputLines(result.stderr)[0];
  return `exited ${result.code}${said === undefined ? "" : `: ${said}`}`;
}

/** `%H%x09%P%x09%s` lines -> commits, or a refusal naming the line that did not parse. */
function parseCommitLines(args: readonly string[], stdout: string): Read<CommitFacts[]> {
  const commits: CommitFacts[] = [];
  for (const line of outputLines(stdout)) {
    const [sha, parents, ...subject] = line.split("\t");
    const parentList = (parents ?? "").split(" ").filter((parent): boolean => parent !== "");
    if (sha === undefined || !SHA.test(sha) || !parentList.every((parent): boolean => SHA.test(parent))) {
      return failed(args, `answered a line that is not '<sha>\\t<parents>\\t<subject>': '${line}'`);
    }
    commits.push({ sha, parents: parentList, subject: subject.join("\t") });
  }
  return { ok: true, value: commits };
}

function readCommits(seams: Seams, root: string, args: readonly string[]): Read<CommitFacts[]> {
  const result = seams.run(GIT, args, { cwd: root });
  if (result.spawnFailed || result.code !== 0) return failed(args, whyItFailed(result));
  return parseCommitLines(args, result.stdout);
}

interface PrMerge {
  readonly pr: number;
  /** The branch the PR merged INTO, just before it did. */
  readonly firstParent: string;
  /** The PR's own head. */
  readonly secondParent: string;
}

/**
 * A commit read as a pull-request merge: exactly two parents and GitHub's
 * `Merge pull request #N` subject. Anything else -- a squash, an octopus, a
 * branch-sync merge -- is not one, and is null.
 */
function asPrMerge(commit: CommitFacts): PrMerge | null {
  const [firstParent, secondParent, ...more] = commit.parents;
  if (firstParent === undefined || secondParent === undefined || more.length > 0) return null;
  const match = PR_MERGE.exec(commit.subject);
  return match?.[1] === undefined ? null : { pr: Number.parseInt(match[1], 10), firstParent, secondParent };
}

/**
 * The CHANGELOG's text at one commit, `null` when the file is not in that
 * commit's tree, or a refusal. `ls-tree` is asked first because it is the one
 * read that tells "not there" (exit 0, no entry) apart from "could not look"
 * (a non-zero exit) -- `git show <sha>:<path>` exits 128 for both, and reading
 * a failed lookup as "absent" would GRANT the allowance at condition 4.
 */
function changelogAt(seams: Seams, root: string, sha: string, path: string): Read<string | null> {
  const lsArgs = ["ls-tree", "-z", sha, "--", path];
  const listed = seams.run(GIT, lsArgs, { cwd: root });
  if (listed.spawnFailed || listed.code !== 0) return failed(lsArgs, whyItFailed(listed));
  const entries = listed.stdout.split("\0").filter((entry): boolean => entry.trim() !== "");
  if (entries.length === 0) return { ok: true, value: null };
  const entry = /^\d+ blob ([0-9a-f]+)\t/.exec(entries[0] ?? "");
  if (entries.length !== 1 || entry?.[1] === undefined) {
    return failed(lsArgs, `did not answer exactly one file entry for '${path}'`);
  }
  const blobArgs = ["cat-file", "blob", entry[1]];
  const blob = seams.run(GIT, blobArgs, { cwd: root });
  if (blob.spawnFailed || blob.code !== 0) return failed(blobArgs, whyItFailed(blob));
  return { ok: true, value: normalizeEol(blob.stdout) };
}

/**
 * `--changelog` as a path git can read out of a commit: relative to the
 * repository root (git runs there, and resolves a relative path against its
 * cwd), `/`-separated on every platform. Null when the file is not inside the
 * root -- a CHANGELOG copied elsewhere has no history this check can read.
 * Both sides are realpath'd so a root reached through a symlink (macOS's
 * `/tmp` is `/private/tmp`) still contains its own files.
 */
function pathInRepo(root: string, changelogPath: string): string | null {
  const full = isAbsolute(changelogPath) ? changelogPath : resolvePath(root, changelogPath);
  let inside: string;
  try {
    inside = relative(realpathSync(root), realpathSync(full));
  } catch {
    return null;
  }
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  return inside.split(sep).join("/");
}

const short = (sha: string): string => sha.slice(0, 7);

interface Known {
  readonly pr?: number | null;
  readonly mergeSha?: string | null;
  readonly firstParentSha?: string | null;
  readonly section?: string | null;
  readonly carriedBy?: number | null;
}

function verdict(kind: ReleasePrVerdict, detail: string, known: Known = {}): ReleasePrAllowance {
  return {
    applied: kind === "applied",
    verdict: kind,
    pr: known.pr ?? null,
    mergeSha: known.mergeSha ?? null,
    firstParentSha: known.firstParentSha ?? null,
    section: known.section ?? null,
    carriedBy: known.carriedBy ?? null,
    detail,
  };
}


/** The PR a merge commit merged, when it is GitHub's two-parent `Merge pull request #N`; else null (a local merge). */
function prOf(commit: CommitFacts): number | null {
  return asPrMerge(commit)?.pr ?? null;
}

/**
 * Decide the release-PR allowance for a range whose citation check left
 * `uncited` PRs. The five conditions in this file's header, in order; the
 * first that fails is the verdict.
 */
export function decideReleasePrAllowance(
  seams: Seams,
  root: string,
  input: ReconcileInput,
  uncited: readonly number[],
): ReleasePrAllowance {
  // 1. The range's terminal merge.
  const end = rangeEnd(input.range);
  if (end === null) {
    return verdict("range-not-two-dot", `--range '${input.range}' is not '<vPrev>..<vNew>', so it has no single terminal merge to excuse`);
  }
  // THE END SITS BEHIND `--end-of-options`. Through the verbs an end
  // beginning with '-' never gets here -- reconcileChangelog refuses it as a
  // usage error before any git call -- so there is no special case for it:
  // called directly, git is handed it as a revision, cannot resolve it, and
  // `terminal-unreadable` below is then the literal truth.
  const terminalArgs = ["log", "-1", "--no-show-signature", "--format=%H%x09%P%x09%s", "--end-of-options", `${end}^{commit}`, "--"];
  const terminalRead = readCommits(seams, root, terminalArgs);
  const terminal = terminalRead.ok ? terminalRead.value[0] : undefined;
  if (!terminalRead.ok || terminal === undefined) {
    return verdict("terminal-unreadable", `the range's end '${end}' could not be read: ${terminalRead.ok ? "git answered no commit" : terminalRead.detail}`);
  }
  const terminalPr = asPrMerge(terminal);
  if (terminalPr === null) {
    return verdict(
      "terminal-not-pr-merge",
      `the range ends at ${short(terminal.sha)}, which is not a two-parent 'Merge pull request #N' merge, so there is no PR at its end to excuse`,
      { mergeSha: terminal.sha },
    );
  }
  const { pr, firstParent: firstParentSha, secondParent: secondParentSha } = terminalPr;
  const known: Known = { pr, mergeSha: terminal.sha, firstParentSha };

  // 2. Nothing to excuse when the terminal PR is already cited.
  if (!uncited.includes(pr)) {
    return verdict("terminal-pr-cited", `the range's terminal PR #${pr} is already cited, so the allowance has nothing to excuse`, known);
  }

  // 3. The DATED section being cut, and the same dated section at the terminal merge.
  const section = openingDatedSection(input.changelogText);
  if (section === null) {
    const opening = sectionHeadings(input.changelogText)[0];
    return verdict(
      "no-dated-section",
      opening === undefined
        ? "--changelog has no '## vX.Y.Z' or '### vX.Y.Z' heading, so no dated section is being cut"
        : `--changelog opens with ${opening.version} marked unreleased, which is not a dated section, so no dated section is being cut`,
      known,
    );
  }
  const withSection: Known = { ...known, section };
  const path = pathInRepo(root, input.changelogPath);
  if (path === null) {
    return verdict(
      "changelog-outside-repo",
      `--changelog does not resolve to a file inside the repository, so whether #${pr}'s merge introduced ${section} cannot be read from its history`,
      withSection,
    );
  }
  const atTerminal = changelogAt(seams, root, terminal.sha, path);
  if (!atTerminal.ok) return verdict("history-unreadable", `${atTerminal.detail}; the allowance fails closed`, withSection);
  const openedWith = atTerminal.value === null ? null : openingDatedSection(atTerminal.value);
  if (openedWith !== section) {
    return verdict(
      "section-not-at-terminal",
      `${path} at the merge ${short(terminal.sha)} opens with ${openedWith === null ? "no dated section" : `the dated section ${openedWith}`}, not ${section} -- the --changelog given is not the one this range cuts`,
      withSection,
    );
  }

  // 4. Absent, DATED, on the trunk just before the merge. An undated
  //    `## vX.Y.Z — unreleased` there is not the dated section.
  const atFirstParent = changelogAt(seams, root, firstParentSha, path);
  if (!atFirstParent.ok) return verdict("history-unreadable", `${atFirstParent.detail}; the allowance fails closed`, withSection);
  if (atFirstParent.value !== null && datedSections(atFirstParent.value).includes(section)) {
    return verdict(
      "section-on-first-parent",
      `${section} was already on the trunk, dated, at the merge's first parent ${short(firstParentSha)}, so #${pr}'s merge did not introduce it`,
      withSection,
    );
  }

  // 5. Introduced on the PR's own branch -- by no OTHER merge on it, a local
  //    `git merge` included. Only a merge whose first parent lacked the dated
  //    section and which carries it brought the section in.
  const branchArgs = ["log", "--merges", "--no-show-signature", "--format=%H%x09%P%x09%s", "--end-of-options", `${firstParentSha}..${secondParentSha}`, "--"];
  const branchMerges = readCommits(seams, root, branchArgs);
  if (!branchMerges.ok) return verdict("history-unreadable", `${branchMerges.detail}; the allowance fails closed`, withSection);
  for (const merge of branchMerges.value) {
    const mergeFirstParent = merge.parents[0];
    if (mergeFirstParent === undefined) continue;
    const atMerge = changelogAt(seams, root, merge.sha, path);
    if (!atMerge.ok) return verdict("history-unreadable", `${atMerge.detail}; the allowance fails closed`, withSection);
    if (atMerge.value === null || !datedSections(atMerge.value).includes(section)) continue;
    const beforeMerge = changelogAt(seams, root, mergeFirstParent, path);
    if (!beforeMerge.ok) return verdict("history-unreadable", `${beforeMerge.detail}; the allowance fails closed`, withSection);
    if (beforeMerge.value === null || !datedSections(beforeMerge.value).includes(section)) {
      const carrier = prOf(merge);
      const by = carrier === null ? `the local merge ${merge.sha}` : `#${carrier}'s merge ${short(merge.sha)}`;
      return verdict(
        "section-carried",
        `${section} was introduced on #${pr}'s branch by ${by}, so #${pr} carried the dated section rather than introducing it, and must be cited like any other change`,
        { ...withSection, carriedBy: carrier },
      );
    }
  }

  return verdict(
    "applied",
    `the range ends at its merge ${short(terminal.sha)}, which introduced the dated section ${section} -- absent at the first parent ${short(firstParentSha)}, and introduced by no other merge on its branch`,
    withSection,
  );
}
