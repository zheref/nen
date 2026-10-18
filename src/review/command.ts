// Review scope classification and the repository-owned review-cycle ledger.
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
import { runCycle, type CycleAction } from "./ledger.js";
import { assembleScopes, readChangedPaths, renderScopes } from "./scopes.js";

const USAGE = `nen review ledger <init|ensure|decide|record|show|recover-first|migrate>
  --branch <name> [--pr <positive-number>] [--repo <path>] [--json]
  ensure: [--base <trunk>]
  decide: [--applicable <comma-separated-personas>] (empty/omitted means none)
  record: --persona <declared-persona> --outcome ran|skipped-exhausted
  recover-first: --confirmed-first-cycle
  migrate: --confirmed-no-legacy-writers

ledger:
  A local hatsu.hanten.cycle/v0.1 ledger in .nen/hanten/<branch-slug>[-prN].cycle.json.
  Personas and minimum repeated-persona budgets come from this repo's review.scopes.
  init opens one exact effort key; ensure opens only without earlier traces.
  decide/show read counts; record spends/records an invocation atomically.
  recover-first requires confirmation that NO review ran under a lost effort key.
  Lost, missing or inconsistent history is restored, never reset or hydrated.

  Legacy documents require explicit migrate --confirmed-no-legacy-writers AFTER
  stopping ALL Python writers. Migration keeps an exact .cycle.json.legacy backup.
  Nen uses a separate exclusive .cycle.lock.nen-mutex directory; it does NOT
  coordinate with Python locks. An interrupted mutex is never removed by age:
  stop writers, inspect ownership evidence and restore before retrying.
  The persistent .cycle.lock's age survives release; git-common-dir opened
  markers and other worktrees prevent ensure from minting a lost budget.
  All ledger operations take this mutex (including show/decide).
  Ledger exits: 0 success; 1 no declared reviewers or I/O failure; 2 invalid input,
  history, migration or held mutex; ensure additionally 3 trunk/not-branch, 4 lost.

nen review scopes --base <ref> [--repo <path>] [--json]

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
  globs in the same grammar 'nen report data --tiers' reads: '=path' names
  one exact path; without '=', a pattern with
  no '*'/'?' is a prefix matched on segment boundaries, one with them is a
  narrow glob ('*' stops at '/', '**' crosses it, '?' is one character).

Exit codes: 0 the classification (whether or not it raised a scope); 1 the
repository declares no 'review' block, named, with the pointer to write; 2 a
missing or unresolvable --base, or a malformed 'review' block (refused by
pointer by the policy loader).`;

const SUBCOMMANDS: readonly string[] = ["scopes", "ledger"];
const ACTIONS: readonly CycleAction[] = ["init", "ensure", "decide", "record", "show", "recover-first", "migrate"];

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

async function runLedger(context: CommandContext): Promise<number> {
  const action = context.args.positionals[2];
  if (!ACTIONS.includes(action as CycleAction) || context.args.positionals.length !== 3) {
    throw new VerbUsageError(`review ledger needs one action: ${ACTIONS.join(", ")}`);
  }
  const allowed = new Set(["repo", "branch", "pr", ...(action === "ensure" ? ["base"] : []),
    ...(action === "decide" ? ["applicable"] : []), ...(action === "record" ? ["persona", "outcome"] : [])]);
  for (const flag of Object.keys(context.args.values)) {
    if (!allowed.has(flag)) throw new VerbUsageError(`--${flag} is not valid with review ledger ${action}`);
  }
  if (action === "record") {
    requireValue(context.args, "persona", "Name the declared reviewer.");
    requireValue(context.args, "outcome", "Use ran or skipped-exhausted.");
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  try {
    const result = await runCycle(action as CycleAction, {
      root, branch: requireValue(context.args, "branch", "Name this effort's branch."),
      pr: context.args.values["pr"], base: context.args.values["base"],
      applicable: context.args.values["applicable"], persona: context.args.values["persona"],
      outcome: context.args.values["outcome"],
      confirmedFirstCycle: context.args.booleans.has("confirmed-first-cycle"),
      confirmedNoLegacyWriters: context.args.booleans.has("confirmed-no-legacy-writers"),
    }, context.seams);
    if (result.code === 1) context.io.err(String(result.document["error"]));
    else emit(context.io, context.json, result.document, [JSON.stringify(result.document, null, 2)]);
    return result.code;
  } catch (error) {
    if (error instanceof SchemaError) throw new VerbUsageError(error.message);
    throw error;
  }
}

export const reviewCommand: Command = {
  name: "review",
  subcommands: SUBCOMMANDS,
  summary: "Classify review scopes and maintain repository-owned review-cycle budgets.",
  usage: USAGE,
  flags: { values: ["base", "branch", "pr", "applicable", "persona", "outcome"], booleans: ["confirmed-first-cycle", "confirmed-no-legacy-writers"] },
  run(context: CommandContext): number | Promise<number> {
    const subcommand = requireSubcommand("review", context.args, SUBCOMMANDS);
    if (subcommand === "ledger") return runLedger(context);
    if (context.args.positionals.length !== 2 || Object.keys(context.args.values).some((flag) => !["repo", "base"].includes(flag)) || context.args.booleans.has("confirmed-first-cycle") || context.args.booleans.has("confirmed-no-legacy-writers")) throw new VerbUsageError("review scopes only accepts --base, --repo and --json");
    return runScopes(context);
  },
};
