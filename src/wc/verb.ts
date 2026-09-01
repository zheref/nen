// src/wc/verb.ts -- `nen wc classify`: tensho §2's working-copy table.

import { assertRepoRoot } from "../repo/root.js";
import { defaultRunner, type Runner } from "../exec/seam.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { classifyWorkingCopy, readWorkingCopyState } from "./classify.js";

const USAGE = `nen wc classify -- where the current working copy sits, tensho's own table.

usage:
  nen wc classify --repo <path> [--base main]

  --base   the PR's target base -- default 'main'. This is where the checkout
           would be cut from, and what a dirty trunk must move off of.

Reports one of: must-move (on the trunk, dirty), on-branch-dirty (on a branch
with uncommitted work -- whether it is the SAME effort as the branch's
existing commits is a judgement this verb hands you evidence for, never
decides), on-branch-clean (nothing to commit). Always exits 0 -- this is a
report, not a guard.`;

export const wcVerb: Verb = {
  name: "wc",
  summary: "Classify the working copy against tensho's four-case table.",
  usage: USAGE,
  flags: { values: ["base"], booleans: [] },
  run(context: VerbContext): number {
    return runWc(context, defaultRunner);
  },
};

export function runWc(context: VerbContext, runner: Runner): number {
  const [subcommand] = context.args;
  if (subcommand !== "classify") {
    return usage(context.io, `unknown 'wc' subcommand '${subcommand ?? "(none)"}'. Try 'wc classify'.`);
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const base = context.values["base"] ?? "main";
  const state = readWorkingCopyState(runner, root, base);
  const result = classifyWorkingCopy(state);

  if (context.json) {
    context.io.out(JSON.stringify({ state, result }, null, 2));
    return 0;
  }
  context.io.out(`case: ${result.case}`);
  for (const line of result.evidence) context.io.out(`  ${line}`);
  return 0;
}
