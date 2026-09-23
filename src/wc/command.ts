// src/wc/command.ts -- `nen wc classify` (tensho §2's working-copy table),
// `nen wc squash` (aka's residue: fold a branch's commits into one before it
// is pushed), and -- zheref/nen#227 -- `nen wc catch-up` (./catchup.ts) and
// `nen wc publish` (./publish.ts), so no skill hand-rolls a rebase or a push;
// and -- zheref/nen#241 -- `nen wc worktrees` and `nen wc swap` (./swap.ts),
// so no skill hand-rolls a worktree swap with raw checkout and stash.

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
import { looksLikeRefspecOrForce, PUBLISH_CONTRACT, publish, refuseBranchName } from "./publish.js";
import { performSquash, planSquash, type FoldedCommit, type SquashBase } from "./squash.js";
import {
  listWorktrees,
  PARK_REF,
  STATE_FILE,
  swap,
  SWAP_CONTRACT,
  SwapRefusal,
  swapReturn,
  swapStatus,
  WORKTREES_CONTRACT,
  type SwapOutcome,
} from "./swap.js";

const SQUASH_CONTRACT = "nen.wc.squash/v0.1";

const USAGE = `nen wc classify -- where the current working copy sits, tensho's own table.
nen wc squash -- fold every commit on this branch since --onto into ONE.
nen wc catch-up -- bring this branch up to date with its base; stop on a conflict.
nen wc publish -- push this branch to its upstream's remote; never a force, never the trunk.
nen wc worktrees -- every checkout of this project: branch, dirt, distance, last commit.
nen wc swap -- bring a worktree's committed tree into the core checkout, and put core back.

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
               [--base <branch>] [--dry-run] [--json]

  --onto           the ref this branch is built on top of (e.g. 'main' or
                    'origin/main'). Every commit 'git merge-base <onto> HEAD'
                    finds between there and HEAD is folded; --onto must be an
                    ancestor of HEAD.
  --base           the base branch whose published commits are never folded
                    -- default ${WORKFLOW_FILE}'s branch.base ('main' when
                    the file is absent). Validated by 'git check-ref-format
                    --branch' (exit 2 for --base; exit 1 for a policy value
                    git rejects, naming the file); checked as 'origin/<base>'
                    and '<base>', whichever resolve, with no fetch.
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
outright; any commit in the range already on the BASE ('origin/<base>' or
'<base>') -- what a catch-up merge of the base brings in, every one named
with the ref it is on (zheref/nen#251); refused rather than excluded, because
a fold that skipped them would still flatten the merge; a --message-file that
fails the shape above (every reason named). --dry-run reaches the same
verdict the real call would. Fewer than two commits to fold is NOT a
refusal: exit 0, one line, nothing moves.

MECHANISM: 'git reset --soft <merge-base>' then 'git commit -F
<message-file>', both through the seam, in that order, only once every
refusal above has passed. Never touches a remote except the read-only fetch
the upstream check above makes, never pushes, never force-anything.

--json's contract is '${SQUASH_CONTRACT}': { contract, onto, mergeBase,
folded: [sha, ...], newSha, dryRun, base, baseRefs: [ref, ...] }. folded is
oldest-first; newSha is null for a dry run and for 'nothing to squash'.
baseRefs are the refs the base check ran against; EMPTY means the check was
NOT performed (neither ref resolves, or nothing to squash), never that it
passed. Text output is one line per folded commit (sha and subject), a line
naming the base check, then the new commit -- or, for a dry run, the message
that would have been committed.

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
  nen wc publish --repo <path> [--set-upstream] [--remote <name>] [--dry-run]
                 [--json]

  --set-upstream    push with -u, so the branch tracks <remote>/<branch>.
  --remote <name>   where a branch with NO upstream goes (default origin);
                    refused when the branch already tracks another remote.
  --dry-run         print the push line; push nothing.

Pushes the CURRENT branch to the remote its upstream names, AS the branch
the upstream names -- a local 'feature' tracking fork/topic goes to fork as
'topic', and the fast-forward check below is made against fork/topic, the
ref the push moves -- or to origin (or --remote) under its own name when it
tracks nothing yet: 'git push [-u] <remote> --
refs/heads/<branch>:refs/heads/<destination>', the refspec in full so no
branch NAME can change what the push does. Refused at exit 2: a
detached HEAD; the trunk (${WORKFLOW_FILE}'s branch.base, and main/master
regardless, compared with a leading '+' and 'refs/heads/' taken off); a
branch name 'git check-ref-format --branch' rejects, or one shaped like a
refspec or a force even where git accepts it ('+main' is a branch git will
hold and a force push once it sits in an argv); any argument that looks like
a refspec or a force (a positional, '+', ':', --force); a --remote this
repository does not have. A git that rejects '--end-of-options' on the
fetch (older than 2.24) is refused at exit 2 naming its version -- the
guard is never dropped. When the upstream exists and the local branch is
not a fast-forward of it the push would need a force, and this verb never
forces: needsForce: true, nothing pushed, exit 1.

--json's contract is '${PUBLISH_CONTRACT}': { contract, branch, remote,
destination, upstreamBefore, ahead, needsForce, pushed, dryRun } --
destination is the upstream's branch when one exists, else branch.

worktrees:
  nen wc worktrees --repo <path> [--base main] [--json]

  --repo    ANY checkout of the project -- core or one of its worktrees; the
            core checkout is resolved through 'git rev-parse --git-common-dir'.
  --base    the branch the distance column is measured against, as
            origin/<base> -- default 'main'.

One row per worktree, core first (a prunable one is skipped): a 'core' / 'in'
mark (in = the worktree core is currently holding), the branch or
'(detached)', the uncommitted-path count (untracked included), +ahead/-behind
against origin/<base> ('?' when that range does not resolve), the short HEAD,
the last commit's subject and age, and the path. Read-only; exit 0.

--json's contract is '${WORKTREES_CONTRACT}': { contract, core, base, swap
(the swap record, or null), worktrees: [{ path, mark, branch, head, dirty,
ahead, behind, lastSubject, lastAge }] }.

swap:
  nen wc swap <worktree path | branch | worktree dir name> --repo <path>
              [--take] [--json]
  nen wc swap --return --repo <path> [--json]
  nen wc swap --status --repo <path> [--json]

  <target>   a worktree's path (a relative one resolves against --repo), its
             branch, or its directory name; a name matching two worktrees is
             refused -- pass the path.
  --take     move the BRANCH, not just the commit: the worktree is detached at
             the same commit and core checks the branch out, so a commit made in
             core lands on it. Without it (VIEW, the default) core checks out
             the worktree's HEAD DETACHED and the worktree keeps its branch.
  --return   put core back on its home branch (or detached home commit) and
             restore its parked work; after a take, hand the branch back.
  --status   print the recorded swap, or 'no swap active'.

ONLY COMMITTED WORK TRAVELS: a target worktree with uncommitted changes is
refused. A swap while one is active keeps the FIRST home and picks up the
target's newer commits. A dirty core VIEWING the same commit as the target is
promoted to a take IN PLACE by '<target> --take', its edits kept.

CORE'S OWN WORK IS PARKED, NEVER STASHED -- the stash stack is shared by every
worktree and every session. Uncommitted work in core (untracked included,
ignored never) is written through a temporary index into a commit pinned at
${PARK_REF}, and only then is core cleared ('reset --hard' + 'clean -fd',
never -x). --return restores modified, new and deleted paths exactly, nothing
staged, and drops the ref. The swap record is <common git dir>/${STATE_FILE},
never in the tree. After a swap, any changed project.pbxproj,
Package.resolved, Podfile.lock or Cartfile.resolved is named: the IDE may ask
to reload or re-resolve packages.

EXIT CODES: 0 done. 2 refused before anything moved -- an unknown or
ambiguous target, core itself, no swap to return from, --take on a detached
worktree, a bad argument, not a checkout, ${PARK_REF} still pinned by an
interrupted swap with no swap recorded, or another swap holding the lock
(<common git dir>/${STATE_FILE}.lock). 3 a tree is dirty -- the target on a
swap, core on --return or a re-swap, or a submodule dirty inside core (a park
holds the superproject only) -- every path listed on stderr (and in
'dirty' under --json); nothing moved, and nothing is committed, discarded or
stashed on anyone's behalf. 1 a git step failed part-way; the message says
where, and the parked commit is still pinned.

--json's contract is '${SWAP_CONTRACT}': { contract, action (swap | promote |
return | status), core, coreBranch, head, active, target, branch, mode (view |
take), home, homeSha, parked, reloadHints: [path, ...], dirty ({ checkout,
paths } on exit 3, else null) }. After --return, active is false and the
other fields describe the swap that was undone.`;

function printFoldedCommits(context: CommandContext, folded: readonly FoldedCommit[]): void {
  for (const commit of folded) context.io.out(`  ${commit.sha} ${commit.subject}`);
}

function squashJson(
  onto: string,
  mergeBase: string,
  folded: readonly FoldedCommit[],
  newSha: string | null,
  dryRun: boolean,
  base: string,
  baseRefs: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    contract: SQUASH_CONTRACT,
    onto,
    mergeBase,
    folded: folded.map((commit): string => commit.sha),
    newSha,
    dryRun,
    base,
    baseRefs,
  };
}

/** The base check's own line: which refs it ran against, or that it did NOT run -- never silence read as clean. */
function baseCheckLine(base: SquashBase, baseRefs: readonly string[]): string {
  return baseRefs.length > 0
    ? `base check: none of the folded commits is on ${baseRefs.join(" or ")} (${base.source})`
    : `base check: NOT performed -- neither origin/${base.name} nor ${base.name} resolves here (${base.source})`;
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

  // THE BASE WHOSE PUBLISHED COMMITS ARE NEVER FOLDED (zheref/nen#251): --base
  // when given, held to git's own branch-name rule exactly as 'wc catch-up'
  // holds its --base; otherwise the workflow's branch.base, the same key
  // 'wc publish' reads for the trunk. A policy that will not load is exit 1,
  // on the argument the message-file block above makes.
  let base: SquashBase;
  const baseFlag = context.args.values["base"];
  if (baseFlag !== undefined) {
    const refused = refuseBranchName(context.seams, root, baseFlag, "--base");
    if (refused !== null) throw new VerbUsageError(refused);
    base = { name: baseFlag, source: "--base" };
  } else {
    try {
      const loaded = loadWorkflow(root);
      base = {
        name: loaded.workflow.branch.base,
        source: loaded.present ? `${WORKFLOW_FILE}'s branch.base` : `branch.base's default -- no ${WORKFLOW_FILE}`,
      };
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      context.io.err(
        `nen: ${error.message}. This repository's ${WORKFLOW_FILE} names the base whose published commits a squash never folds, and nen will not squash under a policy it could not read. Run 'nen schema check' for the whole file's verdict, or pass --base.`,
      );
      return 1;
    }
    // THE POLICY'S NAME IS HELD TO GIT'S RULE TOO. The schema admits names git
    // rejects as branches ('main/', 'foo//bar'); both refs built from one
    // would answer "absent" and the base guard would silently not run. Exit 1,
    // not 2, on the argument above: the invocation was right, the repository's
    // own file is not (review finding on zheref/nen#253).
    const refused = refuseBranchName(context.seams, root, base.name, base.source);
    if (refused !== null) {
      context.io.err(
        `nen: ${refused} This repository's ${WORKFLOW_FILE} names the base whose published commits a squash never folds, and nen will not squash with that guard unable to run. Fix branch.base, or pass --base.`,
      );
      return 1;
    }
  }

  const plan = planSquash(context.seams, root, onto, base);
  if (plan.kind === "refused") {
    throw new VerbUsageError(plan.reason);
  }

  if (plan.kind === "nothing-to-squash") {
    if (context.json) {
      context.io.out(JSON.stringify(squashJson(plan.onto, plan.mergeBase, plan.folded, null, dryRun, base.name, []), null, 2));
    } else {
      context.io.out(
        `nothing to squash: ${plan.folded.length} commit(s) since 'git merge-base ${onto} HEAD' (${plan.mergeBase}) -- need at least two to fold.`,
      );
    }
    return 0;
  }

  if (dryRun) {
    if (context.json) {
      context.io.out(
        JSON.stringify(squashJson(plan.onto, plan.mergeBase, plan.folded, null, true, base.name, plan.baseRefs), null, 2),
      );
    } else {
      context.io.out(`would fold ${plan.folded.length} commit(s) onto ${plan.mergeBase} (--onto ${onto}):`);
      printFoldedCommits(context, plan.folded);
      context.io.out(baseCheckLine(base, plan.baseRefs));
      context.io.out("message:");
      for (const line of messageText.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")) {
        context.io.out(`  ${line}`);
      }
    }
    return 0;
  }

  const newSha = performSquash(context.seams, root, plan.mergeBase, messageFilePath);
  if (context.json) {
    context.io.out(
      JSON.stringify(squashJson(plan.onto, plan.mergeBase, plan.folded, newSha, false, base.name, plan.baseRefs), null, 2),
    );
  } else {
    printFoldedCommits(context, plan.folded);
    context.io.out(baseCheckLine(base, plan.baseRefs));
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
      `'${suspicious}' looks like a refspec or a force option, and 'wc publish' takes neither: it pushes the CURRENT branch by name, to the remote its upstream names, and never rewrites what is there. Drop it.`,
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
    remote: context.args.values["remote"] ?? null,
  });
  if (outcome.kind === "refused") throw new VerbUsageError(outcome.reason);
  emit(context.io, context.json, outcome.report, outcome.lines);
  return outcome.report.needsForce ? 1 : 0;
}

/** Run a swap-family call, turning its refusal into the family's exit 2. */
function swapCall<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof SwapRefusal) throw new VerbUsageError(error.message);
    throw error;
  }
}

function extraPositionals(context: CommandContext): string[] {
  return [...context.args.positionals.slice(2), ...context.args.passthrough];
}

function doWorktrees(context: CommandContext): number {
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It names any checkout of the project whose worktrees are listed."),
  });
  const extra = extraPositionals(context);
  if (extra.length > 0) throw new VerbUsageError(`'wc worktrees' takes no positional argument; got '${extra[0]}'.`);
  const base = context.args.values["base"] ?? "main";
  const { report, lines } = swapCall(() => listWorktrees(context.seams, root, base));
  emit(context.io, context.json, report, lines);
  return 0;
}

function doSwap(context: CommandContext): number {
  // --repo unbracketed: this verb checks out, parks and clears whatever
  // project it is pointed at (zheref/nen#28's rule).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It names any checkout of the project whose core checkout is swapped."),
  });
  if (context.args.values["base"] !== undefined) {
    throw new VerbUsageError("--base is not read by 'wc swap'; it measures 'wc worktrees'' distance column. A flag accepted and ignored is worse than one refused.");
  }
  const take = context.args.booleans.has("take");
  const back = context.args.booleans.has("return");
  const status = context.args.booleans.has("status");
  const targets = extraPositionals(context);
  if (back && status) throw new VerbUsageError("--return and --status are two different questions; ask one.");
  if ((back || status) && take) throw new VerbUsageError(`--take moves a branch INTO core; it has no meaning with --${back ? "return" : "status"}.`);
  if ((back || status) && targets.length > 0) {
    throw new VerbUsageError(`--${back ? "return" : "status"} takes no target; got '${targets[0]}'.`);
  }
  if (targets.length > 1) throw new VerbUsageError(`one target only; got ${targets.map((token): string => `'${token}'`).join(", ")}.`);

  let outcome: SwapOutcome;
  if (back) outcome = swapCall(() => swapReturn(context.seams, root));
  else if (status) outcome = swapCall(() => swapStatus(context.seams, root));
  else {
    const target = targets[0];
    if (target === undefined || target.trim() === "") {
      throw new VerbUsageError("'wc swap' needs a target -- a worktree path, a branch or a worktree directory name -- or --return / --status.");
    }
    outcome = swapCall(() => swap(context.seams, root, target, take));
  }

  if (outcome.kind === "dirty") {
    if (context.json) context.io.out(JSON.stringify(outcome.report, null, 2));
    context.io.err(`nen wc: ${outcome.message}`);
    for (const path of outcome.report.dirty?.paths ?? []) context.io.err(path);
    return 3;
  }
  emit(context.io, context.json, outcome.report, outcome.lines);
  return 0;
}

const SWAP_ONLY_BOOLEANS: readonly string[] = ["take", "return", "status"];

export const wcCommand: Command = {
  name: "wc",
  subcommands: ["classify", "squash", "catch-up", "publish", "worktrees", "swap"],
  summary: "Classify the working copy, squash it, catch it up, publish it, list the worktrees, or swap one into core.",
  usage: USAGE,
  flags: {
    values: ["base", "onto", "message-file", "strategy", "remote"],
    booleans: ["dry-run", "abort", "set-upstream", "take", "return", "status"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("wc", context.args, ["classify", "squash", "catch-up", "publish", "worktrees", "swap"]);
    // `--remote` IS PUBLISH'S ALONE; accepted and ignored elsewhere it would be
    // an instruction silently dropped (../commit/command.ts's rule).
    if (subcommand !== "publish" && context.args.values["remote"] !== undefined) {
      throw new VerbUsageError(`--remote is not read by 'wc ${subcommand}'; only 'wc publish' takes it. A flag accepted and ignored is worse than one refused.`);
    }
    // --take / --return / --status ARE SWAP'S ALONE, by the same rule.
    const stray = SWAP_ONLY_BOOLEANS.find((flag): boolean => context.args.booleans.has(flag));
    if (subcommand !== "swap" && stray !== undefined) {
      throw new VerbUsageError(`--${stray} is not read by 'wc ${subcommand}'; only 'wc swap' takes it. A flag accepted and ignored is worse than one refused.`);
    }
    if (subcommand === "squash") return squash(context);
    if (subcommand === "catch-up") return doCatchUp(context);
    if (subcommand === "publish") return doPublish(context);
    if (subcommand === "worktrees") return doWorktrees(context);
    if (subcommand === "swap") return doSwap(context);

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
