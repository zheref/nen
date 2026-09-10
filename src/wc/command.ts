// src/wc/command.ts -- `nen wc classify` (tensho §2's working-copy table)
// and `nen wc squash` (aka's residue: fold a branch's commits into one
// before it is pushed).

import { assertRepoRoot } from "../repo/root.js";
import {
  requireRepoFlag,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readTextFile } from "../cli/inputs.js";
import { SchemaError } from "../schema/errors.js";
import { WORKFLOW_FILE } from "../schema/workflow.js";
import { classifyWorkingCopy, readWorkingCopyState } from "./classify.js";
import { messageFileRefusals } from "./messagefile.js";
import { performSquash, planSquash, type FoldedCommit } from "./squash.js";

const SQUASH_CONTRACT = "nen.wc.squash/v0.1";

const USAGE = `nen wc classify -- where the current working copy sits, tensho's own table.
nen wc squash -- fold every commit on this branch since --onto into ONE.

classify:
  nen wc classify --repo <path> [--base main]

  --base   the PR's target base -- default 'main'. This is where the checkout
           would be cut from, and what a dirty trunk must move off of.

Reports one of: must-move (on the trunk, dirty), on-branch-dirty (on a branch
with uncommitted work -- whether it is the SAME effort as the branch's
existing commits is a judgement this verb hands you evidence for, never
decides), on-branch-clean (nothing to commit). Exits 0 for any of those three
-- this is a report, not a guard. A git command that FAILS (a detached HEAD,
a --base that does not resolve) is never folded into one of the three cases
as an empty/zero reading; it is reported as an error on stderr and exits
non-zero instead, in both plain and --json invocations.

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
the message that would have been committed.`;

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

export const wcCommand: Command = {
  name: "wc",
  summary: "Classify the working copy against tensho's four-case table, or squash it onto its base.",
  usage: USAGE,
  flags: { values: ["base", "onto", "message-file"], booleans: ["dry-run"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("wc", context.args, ["classify", "squash"]);
    if (subcommand === "squash") return squash(context);

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
    for (const line of result.evidence) context.io.out(`  ${line}`);
    return 0;
  },
};
