// src/pr/verb.ts -- `nen pr …`: fetch a PR whole, name its first blocker,
// cascade trunk in, and retarget after a stack's first PR merges.

import { assertRepoRoot } from "../repo/root.js";
import { loadGateIdentities } from "../schema/gates.js";
import { defaultRunner, type Runner } from "../exec/seam.js";
import { parseTarget, type Target } from "../github/target.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { fetchPullRequest, type PrSnapshot } from "./fetch.js";
import { nextBlocker } from "./blocker.js";
import { cascadeMain } from "./cascade.js";
import { retarget } from "./retarget.js";
import { requestReviews } from "./reviewers.js";

function requireTarget(context: VerbContext): Target {
  const raw = context.values["target"];
  if (raw === undefined) {
    throw new Error("--target owner/name is required.");
  }
  return parseTarget(raw);
}

function requirePr(context: VerbContext): number {
  const raw = context.values["pr"];
  const number = Number(raw ?? "");
  if (raw === undefined || !Number.isInteger(number) || number <= 0) {
    throw new UsageErrorLike("--pr <number> is required.");
  }
  return number;
}

// A tiny local marker so callers below can turn it into exit 2 without
// importing cli/args.ts's UsageError, which is reserved for the flag parser.
class UsageErrorLike extends Error {}

function commaList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item): string => item.trim())
    .filter((item): boolean => item !== "");
}

const USAGE = `nen pr -- fetch a pull request whole, name its first blocker, cascade trunk in, retarget.

usage:
  nen pr fetch --target <owner/name> --pr <n>
      One typed snapshot: head SHA, mergeability, the check rollup, reviews
      PER COMMIT, review threads with resolution state, pending review
      requests.

  nen pr next-blocker --target <owner/name> --pr <n> --repo <path>
                      [--reviewers a,b] [--policy bounded|strict] [--delivery-pr]
      The FIRST blocking condition, fixed order: conflict -> red required
      check -> owed reviewer round -> unresolved thread -> missing body
      requirement ('## How to verify', CON-17). Exits 1 when something blocks,
      0 when this check finds nothing -- the adversarial confirmation pass
      stays human. NOTE: the changelog.d/ fragment half of CON-33(a) is
      diff-shaped and not checked here; see src/pr/blocker.ts's header.

  nen pr cascade-main --repo <path> [--trunk main]
      Merges (never rebases) the trunk into the current branch and pushes on a
      clean merge. Reports a conflict rather than resolving it.

  nen pr retarget --target <owner/name> --pr <n> --base <branch>
      gh pr edit --base, for a stacked PR after its predecessor merges.

  nen pr request-reviews --target <owner/name> --pr <n> --add-reviewers a,b
      gh pr edit --add-reviewer, once per name. Request on the MAINTAINER's
      user token -- a bot token silently no-ops on this call (S6); this verb
      cannot enforce which credential ran it, only warn.`;

export const prVerb: Verb = {
  name: "pr",
  summary: "Fetch a PR whole, name its first blocker, cascade trunk in, retarget.",
  usage: USAGE,
  flags: {
    values: ["target", "pr", "reviewers", "policy", "trunk", "base", "add-reviewers"],
    booleans: ["delivery-pr"],
  },
  run(context: VerbContext): number {
    return runPr(context, defaultRunner);
  },
};

export function runPr(context: VerbContext, runner: Runner): number {
  const [subcommand] = context.args;
  try {
    switch (subcommand) {
      case "fetch":
        return fetch(context, runner);
      case "next-blocker":
        return blocker(context, runner);
      case "cascade-main":
        return cascade(context, runner);
      case "retarget":
        return doRetarget(context, runner);
      case "request-reviews":
        return doRequestReviews(context, runner);
      default:
        return usage(context.io, `unknown 'pr' subcommand '${subcommand ?? "(none)"}'. Run 'nen pr --help'.`);
    }
  } catch (error) {
    if (error instanceof UsageErrorLike) return usage(context.io, error.message);
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function printSnapshot(context: VerbContext, snapshot: PrSnapshot): void {
  context.io.out(`#${snapshot.pr.number} ${snapshot.title}`);
  context.io.out(`  ${snapshot.pr.headRef} -> ${snapshot.pr.baseRef}  ${snapshot.pr.headSha}`);
  context.io.out(`  mergeable: ${snapshot.pr.mergeable}  mergeStateStatus: ${snapshot.mergeStateStatus}`);
  context.io.out(`  checks: ${snapshot.checks.length}  reviews: ${snapshot.reviews.length}  review requests: ${snapshot.reviewRequests.length}`);
  const unresolved = snapshot.reviewThreads.filter((thread): boolean => !thread.isResolved).length;
  context.io.out(
    `  review threads: ${snapshot.reviewThreads.length} (${unresolved} unresolved)${snapshot.threadsTruncated ? "  WARNING: page was full, more may exist" : ""}`,
  );
}

function fetch(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const snapshot = fetchPullRequest(runner, target, prNumber);
  if (context.json) {
    context.io.out(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  printSnapshot(context, snapshot);
  return 0;
}

function blocker(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const identities = loadGateIdentities(root);
  const snapshot = fetchPullRequest(runner, target, prNumber);
  const result = nextBlocker(identities, snapshot, {
    reviewers: context.values["reviewers"] === undefined ? undefined : commaList(context.values["reviewers"]),
    policy: context.values["policy"] === "strict" ? "strict" : context.values["policy"] === "bounded" ? "bounded" : undefined,
    deliveryPr: context.booleans.has("delivery-pr"),
  });
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.kind === "none" ? 0 : 1;
  }
  context.io.out(`#${prNumber}: ${result.kind}`);
  context.io.out(`  ${result.detail}`);
  return result.kind === "none" ? 0 : 1;
}

function cascade(context: VerbContext, runner: Runner): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const result = cascadeMain(runner, root, context.values["trunk"] ?? "main");
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.error !== null || result.conflicted ? 1 : 0;
  }
  for (const line of result.log) context.io.out(line);
  if (result.error !== null) {
    context.io.err(`nen: ${result.error}`);
    return 1;
  }
  if (result.conflicted) return 1;
  return 0;
}

function doRetarget(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const base = context.values["base"];
  if (base === undefined || base.trim() === "") {
    return usage(context.io, "--base <branch> is required.");
  }
  const result = retarget(runner, target, prNumber, base);
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  context.io.out(result.message);
  return result.ok ? 0 : 1;
}

function doRequestReviews(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const reviewers = commaList(context.values["add-reviewers"]);
  const result = requestReviews(runner, target, prNumber, reviewers);
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  context.io.out(result.message);
  return result.ok ? 0 : 1;
}
