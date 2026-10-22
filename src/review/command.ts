// src/review/command.ts -- `nen review scopes`: the reviewer half of a branch,
// read off the repository's own `review.scopes` declaration.
//
// `scopes` classifies a diff; `ledger` records the separate review-cycle budget.
// Neither command raises a reviewer or sends anything to GitHub.
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
  refuseExtraPositionals,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { SchemaError } from "../schema/errors.js";
import { assertRepoRoot } from "../repo/root.js";
import { assertBase } from "../report/data.js";
import { loadWorkflow, WORKFLOW_FILE } from "../schema/workflow.js";
import { assembleScopes, readChangedPaths, renderScopes } from "./scopes.js";
import { CYCLE_CONTRACT, CYCLE_MARKER_DIRECTORY, ensureCycle, runCycle } from "./ledger.js";
import { plainLine } from "../cli/plain.js";

const USAGE = `nen review scopes --base <ref> [--repo <path>] [--json]
nen review ledger init|ensure|decide|record|show|recover-first --branch <name> [--repo <path>] [--pr <n>] [--json]

ledger:
  Own the review-cycle ledger under .nen/hanten/<branch-slug>[-pr<N>].cycle.json,
  preserving contract ${CYCLE_CONTRACT} and all historical rows.
  Budgets and persona names come only from nen/workflow.json review.scopes;
  duplicate personas use the smallest declared budget. No built-in defaults.
  init opens a new key; ensure opens only when no earlier trace survives;
  decide --applicable <csv> reports raise/skip-exhausted/not-applicable;
  record --persona <id> --outcome ran|skipped-exhausted appends a pass;
  show reads the ledger; recover-first --confirmed-first-cycle opens a lost
  key ONLY after the maintainer confirms that no review ran under it.
  --pr <n> selects a separate effort key; --base <trunk> is only for ensure.
  ensure checks the workflow base, else origin/HEAD, else main. It reads
  durable <git-common-dir>/${CYCLE_MARKER_DIRECTORY.join("/")}/<key>.opened markers, exactly matched
  -pr<digits> keys, other worktrees and lock age before waiting on a mutex.
  Nen uses .cycle.json.lock as its mutex and retains .cycle.lock as a legacy
  trace. Stop legacy writers before migration; their OS locks are distinct.
  An absent reviewer is hydrated only when personasAtOpen proves they were
  added later; ambiguous unstamped histories require explicit restoration.
  Unknown historical rows remain intact. show/decide never save hydration.

  Ledger exit codes and messages:
    0 opened/present, or the requested ledger operation succeeded.
    1 filesystem failure or lock timeout; nothing is reported as successful.
    2 invalid arguments, missing/malformed history, exhausted budget, second
      init, or absent/malformed review.scopes; restore, never reset counts.
    3 ensure refused: the trunk, HEAD, refs/* or an empty branch.
    4 ensure lost: earlier ledger traces survive; recover the original.
  Human output is concise; --json carries the full operation document.
  Migration guide: docs/REVIEW-LEDGER.md.

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

function runLedger(context: CommandContext): number {
  const action = context.args.positionals[2];
  const known = ["init", "ensure", "decide", "record", "show", "recover-first"];
  if (action === undefined || !known.includes(action)) throw new VerbUsageError(`review ledger needs one of: ${known.join(", ")}.`);
  refuseExtraPositionals(context.args, 3);
  const values = context.args.values;
  const allowed = new Set(["repo", "branch", "pr", ...(action === "ensure" ? ["base"] : []), ...(action === "decide" ? ["applicable"] : []), ...(action === "record" ? ["persona", "outcome"] : [])]);
  for (const flag of Object.keys(values)) if (!allowed.has(flag)) throw new VerbUsageError(`--${flag} is not valid with review ledger ${action}.`);
  const confirmed = context.args.booleans.has("confirmed-first-cycle");
  if (confirmed && action !== "recover-first") throw new VerbUsageError("--confirmed-first-cycle is only valid with recover-first.");
  if (action === "recover-first" && !confirmed) throw new VerbUsageError("recover-first requires --confirmed-first-cycle after the maintainer confirms no review ran under this effort key.");
  const branch = values["branch"];
  if (branch === undefined) throw new VerbUsageError("--branch is required.");
  if (branch.trim() === "" && action !== "ensure") throw new VerbUsageError("--branch must not be empty.");
  const rawPr = values["pr"]?.replace(/^#/, "");
  if (rawPr !== undefined && (!/^\d+$/.test(rawPr) || !Number.isSafeInteger(Number(rawPr)) || Number(rawPr) <= 0)) throw new VerbUsageError("--pr must be a positive PR number.");
  if (action === "record") {
    requireValue(context.args, "persona", "It names the declared reviewer.");
    requireValue(context.args, "outcome", "Use ran or skipped-exhausted.");
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const options = { root, branch, pr: rawPr === undefined ? undefined : Number(rawPr), base: values["base"], seams: context.seams, warn: context.io.err };
  const result = action === "ensure" ? ensureCycle(options) : { code: 0, report: runCycle(options, action, { applicable: values["applicable"], persona: values["persona"], outcome: values["outcome"], confirmed }) };
  const report = result.report;
  emit(context.io, context.json, report, [plainLine(`review ledger ${String(report["ensure"] ?? action)}: ${String(report["path"])}`), ...(report["reason"] === undefined ? [] : [plainLine(String(report["reason"]))]), ...(Array.isArray(report["reviewers"]) ? report["reviewers"].map((row): string => plainLine(`${row.persona}: ${row.used}/${row.max} ${row.action}`)) : [])]);
  return result.code;
}

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
  summary: "Classify review scopes and own per-effort reviewer budget ledgers.",
  usage: USAGE,
  flags: { values: ["base", "branch", "pr", "applicable", "persona", "outcome"], booleans: ["confirmed-first-cycle"] },
  run(context: CommandContext): number {
    const sub = requireSubcommand("review", context.args, SUBCOMMANDS);
    if (sub === "ledger") return runLedger(context);
    refuseExtraPositionals(context.args, 2);
    for (const flag of ["branch", "pr", "applicable", "persona", "outcome"]) if (context.args.values[flag] !== undefined) throw new VerbUsageError(`--${flag} is only valid with review ledger.`);
    if (context.args.booleans.has("confirmed-first-cycle")) throw new VerbUsageError("--confirmed-first-cycle is only valid with review ledger recover-first.");
    return runScopes(context);
  },
};
