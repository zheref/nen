// src/tag/verb.ts -- `nen tag cut --at <sha>`.

import { assertRepoRoot } from "../repo/root.js";
import { defaultRunner, type Runner } from "../exec/seam.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { cutTag } from "./cut.js";

const USAGE = `nen tag cut -- cut a tag pinned at a given SHA, getsuga §4.

usage:
  nen tag cut --repo <path> --name <vX.Y.Z> --at <sha>
             [--message <text>] [--trunk main] [--push]

  --at      REQUIRED, and never defaulted to HEAD. 'Cut from main' is not an
            instruction a script can follow -- pin the exact reconciled
            commit explicitly.
  --push    without it, the tag is created LOCALLY ONLY. A tag is NEVER
            auto-pushed outside this explicit flag -- the same --dry-run-by-
            default discipline every other mutating verb here applies.

Refuses if the name already exists locally or on origin (never re-tagged),
if --at is not an ancestor of origin/--trunk (never tags off-trunk), or if
either existence check itself fails to run (never cut on an unverified name).
The tag is always ANNOTATED (git tag -a) -- --message becomes the tag's
message when given, and defaults to the tag name otherwise.`;

export const tagVerb: Verb = {
  name: "tag",
  summary: "Cut a tag pinned at an explicit SHA; never auto-pushed.",
  usage: USAGE,
  flags: { values: ["name", "at", "message", "trunk"], booleans: ["push"] },
  run(context: VerbContext): number {
    return runTag(context, defaultRunner);
  },
};

export function runTag(context: VerbContext, runner: Runner): number {
  const [subcommand] = context.args;
  if (subcommand !== "cut") {
    return usage(context.io, `unknown 'tag' subcommand '${subcommand ?? "(none)"}'. Try 'tag cut'.`);
  }
  const name = context.values["name"];
  const at = context.values["at"];
  if (name === undefined || at === undefined) {
    return usage(context.io, "tag cut takes --name <vX.Y.Z> and --at <sha>.");
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const result = cutTag(runner, root, {
    name,
    at,
    message: context.values["message"],
    trunk: context.values["trunk"],
    push: context.booleans.has("push"),
  });
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  for (const line of result.log) context.io.out(line);
  if (result.error !== null) {
    context.io.err(`nen: ${result.error}`);
    return 1;
  }
  return 0;
}
