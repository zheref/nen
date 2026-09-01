// src/wc/command.ts -- `nen wc classify`: tensho §2's working-copy table.

import { assertRepoRoot } from "../repo/root.js";
import { requireSubcommand, type Command, type CommandContext } from "../cli/command.js";
import { classifyWorkingCopy, readWorkingCopyState } from "./classify.js";

const USAGE = `nen wc classify -- where the current working copy sits, tensho's own table.

usage:
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
non-zero instead, in both plain and --json invocations.`;

export const wcCommand: Command = {
  name: "wc",
  summary: "Classify the working copy against tensho's four-case table.",
  usage: USAGE,
  flags: { values: ["base"], booleans: [] },
  run(context: CommandContext): number {
    requireSubcommand("wc", context.args, ["classify"]);
    const root = assertRepoRoot({ repoFlag: context.repoFlag });
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
