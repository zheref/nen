// src/wc/command.ts -- `nen wc classify` (tensho §2's working-copy table),
// `nen wc squash` (aka's residue: fold a branch's commits into one before it
// is pushed), and -- zheref/nen#227 -- `nen wc catch-up` (./catchup.ts) and
// `nen wc publish` (./publish.ts), so no skill hand-rolls a rebase or a push.

import { assertRepoRoot } from "../repo/root.js";
import {
  emit,
  requireRepoFlag,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readTextFile } from "../cli/inputs.js";
import { SchemaError } from "../schema/errors.js";
import { loadWorkflow, WORKFLOW_FILE } from "../schema/workflow.js";
import { CATCH_UP_CONTRACT, catchUp, renderConflicts, type RequestedStrategy } from "./catchup.js";
import { classifyWorkingCopy, readWorkingCopyState } from "./classify.js";
import { messageFileRefusals } from "./messagefile.js";
import { looksLikeRefspecOrForce, PUBLISH_CONTRACT, publish } from "./publish.js";
import { performSquash, planSquash, type FoldedCommit } from "./squash.js";

const SQUASH_CONTRACT = "nen.wc.squash/v0.1";

const USAGE = `nen wc classify -- where the current working copy sits, tensho's own table.
nen wc squash -- fold every commit on this branch since --onto into ONE.
nen wc catch-up -- bring this branch up to date with its base; stop on a conflict.
nen wc publish -- push this branch to origin; never a force, never the trunk.

classify:
  nen wc classify --repo <path> [--base main]

  --base   the PR's target base -- default 'main'. This is where the checkout
           would be cut from, and what a dirty trunk must move off of.

Reports one of: must-move (on the trunk, dirty), on-branch-dirty (on a branch
with uncommitted work -- whether it is the SAME effort as the branch's
existing commits is a judgement this verb hands you evidence for, never
decides), on-branch-clean (nothing to commit). Exits 0 for any of those three
-- this is a report, not a guard. A git command that FAILS (a --base that
does not resolve, an unreadable status) is never folded into one of the three
cases as an empty/zero reading; it is reported as an error on stderr and
exits non-zero instead, in both plain and --json invocations.

A DETACHED HEAD IS CLASSIFIED LIKE ANY OTHER WORKING COPY, not refused: the
classification is decided by trunk-or-not and dirty-or-not, and a detached
HEAD answers both (it is standing on no branch, so it is never the trunk).
'branch' is then null in --json and the text output reads
'branch: (detached HEAD at <short sha>)'. A worktree added with --detach, a
bisect and a rebase step are all ordinary working copies. The one refusal
left is a HEAD that names no branch AND resolves to no commit -- a repository
with no commits yet, where there is nothing to classify.

squash:
  nen wc squash --repo <path> --onto <ref> --message-file <file>
               [--dry-run] [--json]

  --onto           the ref this branch is built on top of (e.g. 'main' or
                    'origin/main'). Every commit 'git merge-base <onto> HEAD'
                    finds between there and HEAD is folded; --onto must be an
                    ancestor of HEAD.
  --message-file    a file holding the new commit's whole message, validated
                    to the SAME shape 'nen commit format' enforces: a
                    Conventional Commits header (<=72 characters, no trailing
                    punctuation), and trailers as 'Key: value' lines in the
                    message's final paragraph. An attribution trailer this
                    repository's ${WORKFLOW_FILE} does not admit is refused,
                    exactly as 'nen commit format' refuses one typed on the
                    command line.
  --dry-run         print the commits that would fold and the message; spawns
                    neither 'git reset' nor 'git commit'.

REFUSES, every one of them BEFORE a single write, all at exit 2: a dirty
working tree (every uncommitted/untracked path named); --onto not an
ancestor of HEAD (what 'git merge-base' found instead, quoted); any commit in
the range already reachable from this branch's upstream (@{upstream},
fetched first through the seam) -- squashing published history is refused
outright; a --message-file that fails the shape above (every reason named).
Fewer than two commits to fold is NOT a refusal: exit 0, one line, nothing
moves.

MECHANISM: 'git reset --soft <merge-base>' then 'git commit -F
<message-file>', both through the seam, in that order, only once every
refusal above has passed. Never touches a remote except the read-only fetch
the upstream check above makes, never pushes, never force-anything.

--json's contract is '${SQUASH_CONTRACT}': { contract, onto, mergeBase,
folded: [sha, ...], newSha, dryRun }. folded is oldest-first; newSha is null
for a dry run and for 'nothing to squash'. Text output is one line per
folded commit (sha and subject), then the new commit -- or, for a dry run,
the message that would have been committed.

catch-up:
  nen wc catch-up --repo <path> --base <ref> [--strategy rebase|merge|auto]
                  [--abort] [--dry-run] [--json]

  --base <ref>      the base branch: validated by 'git check-ref-format
                    --branch' and refused at exit 2 when git rejects it or it
                    is shaped like an option, a refspec or a force -- before
                    any fetch, --dry-run included; then fetched with the
                    refspec in full ('refs/heads/<ref>:refs/remotes/origin/<ref>').
  --strategy        rebase, merge, or auto (default). auto REBASES when no
                    commit of this branch is on its @{upstream} -- the same
                    detection 'wc squash' uses -- and MERGES otherwise,
                    because a rebase rewrites what somebody else may hold.
  --abort           back out an in-progress rebase or merge ('git rebase
                    --abort' / 'git merge --abort') and stop; refused when
                    none is in progress.
  --dry-run         print the strategy and the git line; run neither.

Refuses a dirty tree at exit 2. Already up to date is exit 0 and noOp:
true. ON A CONFLICT nen picks no side: the tree is left exactly as git left
it, every conflicted path is reported with OUR side (always this branch's,
whichever index stage holds it -- 2 on a merge, 3 on a rebase) and THEIR
side (always the base's), capped, '(binary, N bytes)' for a blob with a
NUL, and the abort line is printed, at exit 1.
RESUMING is the same command on the same tree: once the resolutions are
staged, re-run 'nen wc catch-up' with the same --base and --strategy and it
finds the rebase or merge in progress (git rebase --show-current-patch /
MERGE_HEAD) and
continues it -- 'git rebase --continue' under GIT_EDITOR=true, or 'git
commit --no-edit' -- reporting resumed: true; unmerged paths or leftover
conflict markers still staged are reported as conflicted[] again at exit 1
and nothing is continued over them.

--json's contract is '${CATCH_UP_CONTRACT}': { contract, base, strategy
(the one that ran), before, after (null on a dry run or a conflict),
behindBefore, aheadBefore, noOp, conflicted: [{ path, ours, theirs }],
resumed, aborted, dryRun }.

publish:
  nen wc publish --repo <path> [--set-upstream] [--dry-run] [--json]

  --set-upstream    push with -u, so the branch tracks origin/<branch>.
  --dry-run         print the push line; push nothing.

Pushes the CURRENT branch to origin ('git push [-u] origin --
refs/heads/<branch>:refs/heads/<branch>', the refspec in full so no branch
NAME can change what the push does) and nothing else. Refused at exit 2: a
detached HEAD; the trunk (${WORKFLOW_FILE}'s branch.base, and main/master
regardless, compared with a leading '+' and 'refs/heads/' taken off); a
branch name 'git check-ref-format --branch' rejects, or one shaped like a
refspec or a force even where git accepts it ('+main' is a branch git will
hold and a force push once it sits in an argv); any argument that looks like
a refspec or a force (a positional, '+', ':', --force). When the upstream
exists and the local branch is not a fast-forward of it the push would need
a force, and this verb never forces: needsForce: true, nothing pushed, exit
1.

--json's contract is '${PUBLISH_CONTRACT}': { contract, branch, remote,
upstreamBefore, ahead, needsForce, pushed, dryRun }.`;

function printFoldedCommits(context: CommandContext, folded: readonly FoldedCommit[]): void {
  for (const commit of folded) context.io.out(`  ${commit.sha} ${commit.subject}`);
}

function squashJson(
  onto: string,
  mergeBase: string,
  folded: readonly FoldedCommit[],
  newSha: string | null,
  dryRun: boolean,
): Readonly<Record<string, unknown>> {
  return {
    contract: SQUASH_CONTRACT,
    onto,
    mergeBase,
    folded: folded.map((commit): string => commit.sha),
    newSha,
    dryRun,
  };
}

function squash(context: CommandContext): number {
  // Usage lists --repo unbracketed: omitting it is refused by name at exit 2
  // -- this verb RESETS and COMMITS whatever repository it is pointed at, so
  // a silent cwd default is exactly the retargeting ../repo/root.ts's header
  // warns about (zheref/nen#28).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the working tree being squashed -- this verb resets the branch and commits."),
  });
  const onto = requireValue(context.args, "onto", "The ref this branch is built on top of.");
  const messageFilePath = requireValue(
    context.args,
    "message-file",
    "The file holding the new commit's whole message.",
  );
  const dryRun = context.args.booleans.has("dry-run");

  // THE MESSAGE FILE IS CHECKED FIRST, before any git call: it has no git
  // dependency and no side effect, so validating it first means a caller
  // with an obviously-broken file never pays for a fetch that could not have
  // helped them.
  const messageText = readTextFile(
    messageFilePath,
    root,
    "It is the message the folded commit will carry -- a squash reads no other source for it.",
  );
  let shapeRefusals: readonly string[];
  try {
    shapeRefusals = messageFileRefusals(root, messageText);
  } catch (error) {
    // A POLICY THAT WILL NOT LOAD IS EXIT 1, NOT 2, exactly as ../commit/
    // command.ts's own trailer-policy read: the invocation was correct, the
    // repository's own file is not, and a message shaped under a policy nen
    // could not read is a message nobody actually checked.
    if (!(error instanceof SchemaError)) throw error;
    context.io.err(
      `nen: ${error.message}. This repository's ${WORKFLOW_FILE} states which attribution trailers a commit may carry, and nen will not squash under a policy it could not read. Run 'nen schema check' for the whole file's verdict.`,
    );
    return 1;
  }
  if (shapeRefusals.length > 0) {
    throw new VerbUsageError(
      [
        `--message-file '${messageFilePath}' does not have the shape 'nen commit format' enforces:`,
        ...shapeRefusals.map((reason): string => `  - ${reason}`),
      ].join("\n"),
    );
  }

  const plan = planSquash(context.seams, root, onto);
  if (plan.kind === "refused") {
    throw new VerbUsageError(plan.reason);
  }

  if (plan.kind === "nothing-to-squash") {
    if (context.json) {
      context.io.out(JSON.stringify(squashJson(plan.onto, plan.mergeBase, plan.folded, null, dryRun), null, 2));
    } else {
      context.io.out(
        `nothing to squash: ${plan.folded.length} commit(s) since 'git merge-base ${onto} HEAD' (${plan.mergeBase}) -- need at least two to fold.`,
      );
    }
    return 0;
  }

  if (dryRun) {
    if (context.json) {
      context.io.out(JSON.stringify(squashJson(plan.onto, plan.mergeBase, plan.folded, null, true), null, 2));
    } else {
      context.io.out(`would fold ${plan.folded.length} commit(s) onto ${plan.mergeBase} (--onto ${onto}):`);
      printFoldedCommits(context, plan.folded);
      context.io.out("message:");
      for (const line of messageText.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")) {
        context.io.out(`  ${line}`);
      }
    }
    return 0;
  }

  const newSha = performSquash(context.seams, root, plan.mergeBase, messageFilePath);
  if (context.json) {
    context.io.out(JSON.stringify(squashJson(plan.onto, plan.mergeBase, plan.folded, newSha, false), null, 2));
  } else {
    printFoldedCommits(context, plan.folded);
    context.io.out(`squashed into ${newSha}`);
  }
  return 0;
}

const STRATEGIES: readonly RequestedStrategy[] = ["rebase", "merge", "auto"];

function doCatchUp(context: CommandContext): number {
  // --repo unbracketed: this verb rebases or merges whatever tree it is
  // pointed at (zheref/nen#28's rule).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the working tree being caught up -- this verb rebases or merges the current branch."),
  });
  const base = requireValue(context.args, "base", "The base branch this one is caught up to, fetched as origin/<base>.");
  const strategyRaw = context.args.values["strategy"] ?? "auto";
  if (!STRATEGIES.includes(strategyRaw as RequestedStrategy)) {
    throw new VerbUsageError(`--strategy '${strategyRaw}' is not one of ${STRATEGIES.join(", ")}.`);
  }
  const outcome = catchUp(context.seams, root, {
    base,
    strategy: strategyRaw as RequestedStrategy,
    dryRun: context.args.booleans.has("dry-run"),
    abort: context.args.booleans.has("abort"),
  });
  if (outcome.kind === "refused") throw new VerbUsageError(outcome.reason);
  const { report, lines } = outcome;
  emit(context.io, context.json, report, [...lines, ...renderConflicts(report.conflicted)]);
  return report.conflicted.length > 0 ? 1 : 0;
}

function doPublish(context: CommandContext): number {
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the working tree whose current branch is pushed."),
  });
  // ANYTHING AFTER THE SUBCOMMAND IS A REFSPEC SOMEBODY MEANT, and this verb
  // takes none: it pushes the current branch, by name, and nothing else.
  const extra = [...context.args.positionals.slice(2), ...context.args.passthrough];
  const suspicious = extra.find((token): boolean => looksLikeRefspecOrForce(token)) ?? extra[0];
  if (suspicious !== undefined) {
    throw new VerbUsageError(
      `'${suspicious}' looks like a refspec or a force option, and 'wc publish' takes neither: it pushes the CURRENT branch to origin by name and never rewrites what is there. Drop it.`,
    );
  }
  let base: string;
  try {
    base = loadWorkflow(root).workflow.branch.base;
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    context.io.err(`nen: ${error.message}. This repository's ${WORKFLOW_FILE} names the trunk this verb refuses to push, and nen will not publish under a policy it could not read. Run 'nen schema check' for the whole file's verdict.`);
    return 1;
  }
  const outcome = publish(context.seams, root, {
    base,
    setUpstream: context.args.booleans.has("set-upstream"),
    dryRun: context.args.booleans.has("dry-run"),
  });
  if (outcome.kind === "refused") throw new VerbUsageError(outcome.reason);
  emit(context.io, context.json, outcome.report, outcome.lines);
  return outcome.report.needsForce ? 1 : 0;
}

export const wcCommand: Command = {
  name: "wc",
  subcommands: ["classify", "squash", "catch-up", "publish"],
  summary: "Classify the working copy, squash it onto its base, catch it up with its base, or publish it.",
  usage: USAGE,
  flags: { values: ["base", "onto", "message-file", "strategy"], booleans: ["dry-run", "abort", "set-upstream"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("wc", context.args, ["classify", "squash", "catch-up", "publish"]);
    if (subcommand === "squash") return squash(context);
    if (subcommand === "catch-up") return doCatchUp(context);
    if (subcommand === "publish") return doPublish(context);

    // Usage lists --repo unbracketed: omitting it is refused by name at exit 2,
    // never silently read as "classify wherever this process happens to be
    // standing" (zheref/nen#28).
    const root = assertRepoRoot({
      repoFlag: requireRepoFlag(context, "It names the working tree being classified."),
    });
    const base = context.args.values["base"] ?? "main";
    const state = readWorkingCopyState(context.seams, root, base);
    const result = classifyWorkingCopy(state);

    if (context.json) {
      context.io.out(JSON.stringify({ state, result }, null, 2));
      return 0;
    }
    context.io.out(`case: ${result.case}`);
    // THE BRANCH IS A LINE OF ITS OWN, and it is the same line on every path:
    // a name, or where a detached HEAD is standing. A reader who has to infer
    // "detached" from the absence of a branch name is a reader who will not.
    context.io.out(
      `branch: ${state.branch === null ? `(detached HEAD at ${state.detachedAt ?? "(unknown)"})` : state.branch}`,
    );
    for (const line of result.evidence) context.io.out(`  ${line}`);
    return 0;
  },
};
