// src/release/verb.ts -- `nen release resolve-target|self-check`.

import { assertRepoRoot } from "../repo/root.js";
import { defaultRunner, type Runner } from "../exec/seam.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { resolveReleaseTarget, ResolveTargetError } from "./target.js";
import { checkSelfEnumeration, SelfCheckError } from "./selfcheck.js";

const USAGE = `nen release -- resolve a release target, or check a PR's self-enumeration.

usage:
  nen release resolve-target --repo <path> --token <main|last-commit|checkout|hash|branch>
                             [--trunk main]
      getsuga §1: resolves the token to a SHA (re-fetching origin/--trunk
      first) and tests 'git merge-base --is-ancestor <sha> origin/<trunk>' --
      the load-bearing check that a tag is only ever cut on the trunk. A dirty
      'checkout' is refused outright: uncommitted work is not in any commit.
      Exits 1 when the resolved commit is not yet an ancestor.

  nen release self-check --repo <path> --pr-merge-sha <sha>
                         --previous-tag <ref> --cut-point <ref>
      getsuga §3: whether a release PR should list itself -- true iff its own
      merge commit is reachable from --cut-point and not already reachable
      from --previous-tag. A git-mechanical fact, never a judgement.`;

export const releaseVerb: Verb = {
  name: "release",
  summary: "Resolve a release target, or check a PR's self-enumeration.",
  usage: USAGE,
  flags: {
    values: ["token", "trunk", "pr-merge-sha", "previous-tag", "cut-point"],
    booleans: [],
  },
  run(context: VerbContext): number {
    return runRelease(context, defaultRunner);
  },
};

export function runRelease(context: VerbContext, runner: Runner): number {
  const [subcommand] = context.args;
  switch (subcommand) {
    case "resolve-target":
      return resolveTarget(context, runner);
    case "self-check":
      return selfCheck(context, runner);
    default:
      return usage(context.io, `unknown 'release' subcommand '${subcommand ?? "(none)"}'. Run 'nen release --help'.`);
  }
}

function resolveTarget(context: VerbContext, runner: Runner): number {
  const token = context.values["token"];
  if (token === undefined) return usage(context.io, "--token <main|last-commit|checkout|hash|branch> is required.");
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  let result;
  try {
    result = resolveReleaseTarget(runner, root, token, context.values["trunk"] ?? "main");
  } catch (error) {
    if (error instanceof ResolveTargetError) {
      context.io.err(`nen: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.isAncestorOfTrunk ? 0 : 1;
  }
  context.io.out(`${result.token} -> ${result.sha}`);
  context.io.out(
    result.isAncestorOfTrunk
      ? "an ancestor of the trunk -- safe to cut"
      : "NOT an ancestor of the trunk -- it has to reach the trunk first before it can be tagged",
  );
  return result.isAncestorOfTrunk ? 0 : 1;
}

function selfCheck(context: VerbContext, runner: Runner): number {
  const prMergeSha = context.values["pr-merge-sha"];
  const previousTag = context.values["previous-tag"];
  const cutPoint = context.values["cut-point"];
  if (prMergeSha === undefined || previousTag === undefined || cutPoint === undefined) {
    return usage(context.io, "release self-check takes --pr-merge-sha, --previous-tag and --cut-point.");
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  let result;
  try {
    result = checkSelfEnumeration(runner, root, prMergeSha, previousTag, cutPoint);
  } catch (error) {
    if (error instanceof SelfCheckError) {
      context.io.err(`nen: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  context.io.out(
    result.shouldListItself
      ? `#${result.prMergeSha} should list ITSELF -- it falls inside <${result.previousTag}>..<${result.cutPoint}>`
      : `#${result.prMergeSha} should NOT list itself -- it is outside <${result.previousTag}>..<${result.cutPoint}>`,
  );
  return 0;
}
