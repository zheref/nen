// src/split/verb.ts -- `nen split verify`: the jujisho completeness proof.

import { readFileSync } from "node:fs";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { verifySplit } from "./verify.js";

const USAGE = `nen split verify -- prove the union of the branches' diffs equals the original.

usage:
  nen split verify --original <path> --branches <path,path,...>

  --original   a unified diff of the ORIGINAL working copy (e.g. from
               'git diff main > original.diff' before any branch was cut).
  --branches   one unified diff per axis branch, comma-separated paths (e.g.
               from 'git diff main...<axis-branch>').

Every hunk in --original must land in EXACTLY ONE of --branches, with the
SAME body -- identity is the hunk's exact text, not just its '@@ ... @@'
header. A hunk in none of them is jujisho's 'leftover hunk' -- invisible in
every PR, and a silent bug by the skill's own words. A hunk in more than one
is reported too: a hunk shared between two axes goes on the LOWER one in the
stack, never duplicated. A hunk whose header lands in exactly one branch but
whose BODY was altered along the way is reported ALTERED, separately from a
clean match. --original naming no hunks at all is refused outright -- an
empty diff is not a proof of completeness. Exits 1 on any missing, duplicated,
altered or extra hunk.`;

export const splitVerb: Verb = {
  name: "split",
  summary: "Prove the union of split branches' diffs equals the original.",
  usage: USAGE,
  flags: { values: ["original", "branches"], booleans: [] },
  run(context: VerbContext): number {
    const [subcommand] = context.args;
    if (subcommand !== "verify") {
      return usage(context.io, `unknown 'split' subcommand '${subcommand ?? "(none)"}'. Try 'split verify'.`);
    }

    const originalPath = context.values["original"];
    const branchesRaw = context.values["branches"];
    if (originalPath === undefined || branchesRaw === undefined) {
      return usage(context.io, "split verify takes --original <path> and --branches <path,path,...>.");
    }
    const branchPaths = branchesRaw
      .split(",")
      .map((item): string => item.trim())
      .filter((item): boolean => item !== "");
    if (branchPaths.length === 0) {
      return usage(context.io, "--branches named no paths.");
    }

    let original: string;
    try {
      original = readFileSync(originalPath, "utf8");
    } catch (error) {
      context.io.err(`nen: could not read --original '${originalPath}': ${String(error)}`);
      return 1;
    }
    const branches: string[] = [];
    for (const path of branchPaths) {
      try {
        branches.push(readFileSync(path, "utf8"));
      } catch (error) {
        context.io.err(`nen: could not read branch diff '${path}': ${String(error)}`);
        return 1;
      }
    }

    const result = verifySplit(original, branches);
    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }

    if (result.error !== null) {
      context.io.err(`nen: ${result.error}`);
      return 1;
    }

    context.io.out(`files: ${result.filesInOriginal} in original, ${result.filesInBranches} across branches`);
    if (result.ok) {
      context.io.out("OK -- every hunk in the original lands in exactly one branch, unaltered, and nothing extra was found.");
      return 0;
    }
    for (const entry of result.missing) {
      context.io.out(`MISSING (in original, in no branch): ${entry.path}  ${entry.header}`);
    }
    for (const entry of result.duplicated) {
      context.io.out(
        `DUPLICATED (in branches ${entry.branches.map((n): string => String(n + 1)).join(", ")}): ${entry.path}  ${entry.header}`,
      );
    }
    for (const entry of result.altered) {
      context.io.out(`ALTERED (in branch ${entry.branch + 1}, header matches but the body does not): ${entry.path}  ${entry.header}`);
      context.io.out(entry.diff);
    }
    for (const entry of result.extra) {
      context.io.out(`EXTRA (in a branch, not in original): ${entry.path}  ${entry.header}`);
    }
    context.io.err("nen: the split is incomplete -- see the missing/duplicated/altered/extra hunks above.");
    return 1;
  },
};
