// src/review/command.ts -- `nen review scopes`: the reviewer half of a branch,
// read off the repository's own `review.scopes` declaration.
//
// A FAMILY OF ONE, ON PURPOSE. ../cli/registry.ts's rule is that a family is
// listed when it does something, and "which scopes does this diff raise" is a
// complete question with a complete answer. The verbs that would join it later
// -- raising a reviewer, spending a budget -- are acts, and this one is a read;
// putting the read in its own family now is what keeps `nen review <tab>` from
// meaning "review something" the first time an acting verb arrives.
//
// EXIT 1 IS "THIS REPOSITORY DECLARES NO REVIEW BLOCK", AND IT IS NOT A USAGE
// ERROR. The invocation was right, the flags were right, and the answer is that
// there is nothing here to classify by -- which is a verb's own failure (exit
// 1) rather than a typo (exit 2), on ../index.ts's own distinction: a caller
// retrying a 1 might find a block somebody added, and retrying a 2 never fixes
// a misspelled flag. It is NAMED, with the pointer to write, because a bare
// non-zero here would read as "your diff raised nothing".

import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { SchemaError } from "../schema/errors.js";
import { assertRepoRoot } from "../repo/root.js";
import { assertBase } from "../report/data.js";
import { loadWorkflow, WORKFLOW_FILE } from "../schema/workflow.js";
import { assembleScopes, readChangedPaths, renderScopes } from "./scopes.js";

const USAGE = `nen review scopes --base <ref> [--repo <path>] [--json]

scopes:
  Classify this branch's diff against '<base>...HEAD' (three dots -- the
  merge-base set a pull request shows) by the repository's own
  'review.scopes' block in ${WORKFLOW_FILE}, and report which scopes it
  RAISES and which changed paths no scope claims. READ-ONLY: one git read and
  one file read. It never requests a review, never spends a budget, never
  labels and never opens anything.

  --base <ref>   Required. What this branch is measured against. A ref that
                 does not resolve is refused by name at exit 2 with nothing
                 read.
  --repo <path>  The checkout whose ${WORKFLOW_FILE} declares the scopes, and
                 whose diff is read. Defaults to the current directory.
  --json         The document itself.

  A path may raise SEVERAL scopes -- a file has one tier and any number of
  readers -- so the scope lists overlap by design. Paths are prefixes or
  globs in the same grammar 'nen report data --tiers' reads: a pattern with
  no '*'/'?' is a prefix matched on segment boundaries, one with them is a
  narrow glob ('*' stops at '/', '**' crosses it, '?' is one character).

Exit codes: 0 the classification (whether or not it raised a scope); 1 the
repository declares no 'review' block, named, with the pointer to write; 2 a
missing or unresolvable --base, or a malformed 'review' block (refused by
pointer by the policy loader).`;

const SUBCOMMANDS: readonly string[] = ["scopes"];

function runScopes(context: CommandContext): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const base = requireValue(
    context.args,
    "base",
    "It names the ref this branch is measured against -- the trunk, or the commit the effort was cut from.",
  );
  // `assertBase` IS ../report/data.ts's, NOT A SECOND SPELLING. It refuses an
  // unresolvable ref at exit 2 with the one sentence this repository has about
  // that mistake, and it runs BEFORE the policy is read so a mistyped flag is
  // answered without touching a file.
  assertBase(context.seams, root, base);

  // A MALFORMED POLICY IS EXIT 2 HERE, NOT 1. The loader refuses by pointer,
  // which is the right refusal -- and it is the same CLASS of mistake a
  // mistyped flag is: the invocation was understood, an input this verb was
  // pointed at is wrong, and no retry fixes it. ../index.ts's own distinction
  // is what decides the code, not which layer raised the error; a retry
  // wrapper honouring exit 1 would poll a typo in a JSON file forever.
  let loaded: ReturnType<typeof loadWorkflow>;
  try {
    loaded = loadWorkflow(root);
  } catch (error) {
    if (error instanceof SchemaError) throw new VerbUsageError(error.message);
    /* c8 ignore next -- the loader raises nothing else */
    throw error;
  }
  // `null` IS ABSENT, NOT PRESENT-AND-EMPTY (Copilot, #221). ../schema/
  // workflow.ts's own `block()` reads `undefined` and `null` identically --
  // both mean "this repository states no such block" -- so testing only
  // `undefined` here let `"review": null` through to an empty policy and an
  // exit 0, where the documented answer is exit 1 naming the missing block.
  // One file, one reading of what an absent block is.
  if (loaded.raw["review"] === undefined || loaded.raw["review"] === null) {
    context.io.err(
      `${loaded.path} declares no 'review' block, so there is nothing to classify this diff by. A review policy is '"review": { "scopes": { "<scope>": { "persona": "<name>", "tier": "<models tier>", "budget": <n>, "paths": ["<prefix or glob>", …] } } }' -- the paths are the same grammar 'nen report data --tiers' reads. Nothing was read beyond the policy file.`,
    );
    return 1;
  }

  const report = assembleScopes(readChangedPaths(context.seams, root, base), base, loaded.workflow);
  emit(context.io, context.json, report, renderScopes(report));
  return 0;
}

export const reviewCommand: Command = {
  name: "review",
  subcommands: SUBCOMMANDS,
  summary: "Which review scopes a branch diff raises, off the repository's own review.scopes.",
  usage: USAGE,
  flags: { values: ["base"], booleans: [] },
  run(context: CommandContext): number {
    requireSubcommand("review", context.args, ["scopes"]);
    return runScopes(context);
  },
};
