// src/pr/command.ts -- `nen pr ready`, `nen pr staleness`, `nen pr body-check`
// (main), and (verbs/4-remainders, zheref/nen#4) `nen pr fetch`,
// `nen pr next-blocker`, `nen pr cascade-main`, `nen pr retarget`,
// `nen pr request-reviews` -- one "pr" family, eight subcommands.
//
// THREE SUBCOMMANDS, ONE FAMILY. `nen pr ready` (the CON-32 readiness verdict,
// zheref/nen#2) is the ELDER of the three: it landed on main first, as a direct
// case in ../index.ts's dispatcher, before this registry existed. Converging it
// here -- rather than leaving two separate "pr" entry points, one via the
// registry and one hard-coded in ../index.ts -- is what keeps `nen pr <tab>`
// meaning one thing. Its implementation stays in ../verbs/pr_ready.ts unchanged
// (network transport, gate evaluation, --json contract, review record and all);
// this file only adapts the registry's CommandContext into the shape
// prReady() already expects. The five FETCH/NEXT-BLOCKER/CASCADE-MAIN/
// RETARGET/REQUEST-REVIEWS subcommands arrived the same way a wave later
// (verbs/4-remainders): a second "pr" family, independently registered, is
// exactly the two-entry-points mistake the paragraph above already refused
// once, so they join this same family instead of a second one.
//
// `run()` RETURNS `number | Promise<number>` (../cli/command.ts) because
// `ready` reads GitHub over the network and every other subcommand does not --
// see ../verbs/pr_ready.ts for why there is no synchronous alternative.

import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readJsonFile, readTextFile } from "../cli/inputs.js";
import { commaList } from "../cli/comma.js";
import { assertRepoRoot, resolveRepoRoot } from "../repo/root.js";
import { loadGateIdentities } from "../schema/gates.js";
import { parseTarget, type Target } from "../github/target.js";
import { PR_READY_FLAGS, prReady, resolveIdentities } from "../verbs/pr_ready.js";
import { checkBody, type BodyRequirement } from "./bodycheck.js";
import { computeStaleness, type VerifiedWake } from "./staleness.js";
import { nextBlocker } from "./blocker.js";
import { cascadeMain } from "./cascade.js";
import { fetchPullRequest, type PrSnapshot } from "./fetch.js";
import { retarget } from "./retarget.js";
import { requestReviews } from "./reviewers.js";

function requireTarget(context: CommandContext): Target {
  const raw = context.args.values["target"];
  if (raw === undefined) {
    throw new Error(
      "--target owner/name is required. It is the GitHub side of the pair; --repo names a checkout on disk and is never used to address the API.",
    );
  }
  return parseTarget(raw);
}

function requirePr(context: CommandContext): number {
  const raw = context.args.values["pr"];
  const number = Number(raw ?? "");
  if (raw === undefined || !Number.isInteger(number) || number <= 0) {
    throw new VerbUsageError("--pr <number> is required.");
  }
  return number;
}

const USAGE = `nen pr ready <ref> [--explain] [--gh-repo <owner/name>] [--reviewers <a,b,c>] [--approvers <a,b>] [--round-policy strict|bounded] [--exclude-run <id>] [--gates <path>] [--token-env <VAR>]
nen pr staleness --wakes-from <path> --last-activity <ISO> --now <ISO> [--ready] [--min-verified-wakes <n>] [--idle-minutes <n>]
nen pr body-check --body-from <path> --requirements-from <path>
nen pr fetch --target <owner/name> --pr <n>
nen pr next-blocker --target <owner/name> --pr <n> --repo <path> [--reviewers a,b] [--policy bounded|strict] [--delivery-pr] [--gates <path>]
nen pr cascade-main --repo <path> [--trunk main]
nen pr retarget --target <owner/name> --pr <n> --base <branch>
nen pr request-reviews --target <owner/name> --pr <n> --add-reviewers a,b

ready:
  Report a pull request's CON-32 readiness: the gate's verdict, the first
  failing conjunct, nothing else. Read-only -- it never labels, merges or
  comments.
  <ref>                       <CODE>#<N> via the target repo's product codes,
                              or a bare <N> with --gh-repo.
  --gh-repo <owner/name>      The repository, when the ref is a bare number.
  --explain                   The conjunct table, in evaluation order, plus
                              what the gate does NOT decide.
  --reviewers <a,b,c>         The configured reviewer set (mirrors the shell
                              gate's flag). Also the identity source of last
                              resort -- see --gates.
  --approvers <a,b>           The approval set, when identities come from flags.
  --round-policy <p>          strict | bounded. Default bounded.
  --exclude-run <id>          Drop one Actions run's own checks (CON-36 clause
                              3; pass it only from inside that run's own job).
  --gates <path>              Read reviewer identities from this gates file
                              instead of the target repo's schemas/gates.json.
  --token-env <VAR>           Environment variable holding the token. Default
                              GH_TOKEN; never picked up ambiently.

staleness:
  A pull request is STALE at >=2 verified no-commit wakes AND >=60 minutes
  idle (both defaults, overridable). Stale + Ready is the one case a merge is
  permitted without a human.
  --wakes-from <path>   A JSON array of { at, noCommit }.

body-check:
  Every requirement is checked; never stops at the first miss.
  --requirements-from <path>  A JSON array of { name, pattern } -- this
                              repository's own template convention, never a
                              literal shipped here.

fetch:
  One typed snapshot: head SHA, mergeability, the check rollup, reviews
  PER COMMIT, review threads with resolution state, pending review
  requests.

next-blocker:
  The FIRST blocking condition, fixed order: conflict -> red required
  check -> owed reviewer round -> unresolved thread -> missing body
  requirement ('## How to verify', CON-17). Exits 1 when something blocks,
  0 when this check finds nothing -- the adversarial confirmation pass
  stays human. NOTE: the changelog.d/ fragment half of CON-33(a) is
  diff-shaped and not checked here; see ../pr/blocker.ts's header.
  --gates <path>              Read reviewer identities from this gates file
                              instead of the target repo's schemas/gates.json
                              -- the same flag 'ready' takes, so a checkout
                              that ships no gates file can still be evaluated.

cascade-main:
  Merges (never rebases) the trunk into the current branch and pushes on a
  clean merge. Reports a conflict rather than resolving it.

retarget:
  gh pr edit --base, for a stacked PR after its predecessor merges.

request-reviews:
  gh pr edit --add-reviewer, once per name. Request on the MAINTAINER's
  user token -- a bot token silently no-ops on this call (S6); this verb
  cannot enforce which credential ran it, only warn.`;

/**
 * `--<flag> <ISO-8601>`, refused by name AND VALUE when it does not parse
 * (review finding). Left unrefused, an unparseable instant survived as
 * `Date.parse` NaN, through `Math.max(0, NaN)`, into "NaN/60 idle minute(s)"
 * on the human line and `"idleMinutes": null` in --json, at exit 0 -- a
 * machine consumer of --json cannot distinguish "computed zero-ish idle time"
 * from "could not parse the timestamp at all", and neither can a human
 * reading a bare `null`.
 */
function requireIsoInstant(context: CommandContext, flag: string, why: string): string {
  const value = requireValue(context.args, flag, why);
  if (Number.isNaN(Date.parse(value))) {
    throw new VerbUsageError(`--${flag} '${value}' is not a parseable ISO-8601 instant. ${why}`);
  }
  return value;
}

// EVERY WAKE ELEMENT IS VALIDATED, NOT TRUTHINESS-TESTED (review finding).
// `wake.noCommit` read straight off unvalidated JSON would let the STRING
// "false" -- truthy in JavaScript -- count toward the threshold that
// authorizes the one merge a non-human actor may make. Each element must be
// an object with a string `at` and a BOOLEAN `noCommit`, or this refuses by
// index rather than silently coercing.
function validateWakes(raw: unknown, path: string): VerifiedWake[] {
  if (!Array.isArray(raw)) {
    throw new VerbUsageError(`'${path}' must be a JSON array of { at, noCommit }.`);
  }
  return raw.map((item, index): VerifiedWake => {
    if (typeof item !== "object" || item === null) {
      throw new VerbUsageError(`'${path}': element ${index} is not an object.`);
    }
    const at = (item as Record<string, unknown>)["at"];
    const noCommit = (item as Record<string, unknown>)["noCommit"];
    if (typeof at !== "string") {
      throw new VerbUsageError(`'${path}': element ${index} has no string 'at'.`);
    }
    if (typeof noCommit !== "boolean") {
      throw new VerbUsageError(
        `'${path}': element ${index} has 'noCommit' of type ${typeof noCommit}, not a boolean -- a truthy non-boolean (e.g. the string "false") must never count toward the merge-permitting threshold.`,
      );
    }
    return { at, noCommit };
  });
}

function staleness(context: CommandContext): number {
  const wakesPath = requireValue(context.args, "wakes-from", "The verified-wake history to reason over.");
  const lastActivity = requireIsoInstant(context, "last-activity", "The pull request's last-activity instant.");
  const now = requireIsoInstant(context, "now", "Read once, never the live clock -- so a replay is reproducible.");
  const ready = context.args.booleans.has("ready");
  const minVerifiedWakes = context.args.values["min-verified-wakes"];
  const idleMinutes = context.args.values["idle-minutes"];
  if (minVerifiedWakes !== undefined && !/^\d+$/.test(minVerifiedWakes)) {
    throw new VerbUsageError(`--min-verified-wakes takes a whole number, got '${minVerifiedWakes}'.`);
  }
  if (idleMinutes !== undefined && !/^\d+$/.test(idleMinutes)) {
    throw new VerbUsageError(`--idle-minutes takes a whole number, got '${idleMinutes}'.`);
  }

  const cwd = resolveRepoRoot({ repoFlag: context.repoFlag });
  const wakes = validateWakes(readJsonFile<unknown>(wakesPath, cwd), wakesPath);

  const result = computeStaleness({
    wakes,
    lastActivityAt: lastActivity,
    now,
    ready,
    ...(minVerifiedWakes === undefined ? {} : { minVerifiedWakes: Number.parseInt(minVerifiedWakes, 10) }),
    ...(idleMinutes === undefined ? {} : { idleMinutes: Number.parseInt(idleMinutes, 10) }),
  });

  const lines = [
    result.stale ? "stale" : "not stale",
    result.mergePermitted ? "merge PERMITTED (stale + Ready)" : "merge not permitted",
    ...result.reasons,
  ];
  emit(context.io, context.json, result, lines);
  return 0;
}

function bodyCheck(context: CommandContext): number {
  const bodyPath = requireValue(context.args, "body-from", "The pull-request body to check.");
  const requirementsPath = requireValue(context.args, "requirements-from", "This repository's own template requirements.");

  const cwd = resolveRepoRoot({ repoFlag: context.repoFlag });
  const body = readTextFile(bodyPath, cwd);
  const requirements = readJsonFile<readonly BodyRequirement[]>(requirementsPath, cwd);

  const report = checkBody(body, requirements);
  const satisfiedCount = report.results.filter((result): boolean => result.satisfied).length;
  // A VERDICT LINE ALWAYS PRINTS (review finding): zero output must never be a
  // passing result a caller's script can mistake for "nothing to report".
  const lines = [
    `${satisfiedCount}/${report.results.length} requirement(s) satisfied`,
    ...report.results.map((result): string => `${result.satisfied ? "ok" : "MISSING"}  ${result.name}`),
  ];
  emit(context.io, context.json, report, lines);
  return report.ok ? 0 : 1;
}

// `ready`'s FLAGS AND POSITIONALS PASS THROUGH TO prReady() UNCHANGED --
// ../verbs/pr_ready.ts owns its own parsing of --gh-repo/--reviewers/etc and
// its own ref grammar; this adapts only the CALLING CONVENTION.
//
// `context.json` (already the OR of the head-stage and family-stage --json,
// per ../index.ts's runFamily) is folded into the boolean set passed down,
// because prReady() itself reads `input.booleans.has("json")` -- it predates
// the registry and was never written to take a pre-resolved `json: boolean`
// the way this file's `staleness`/`bodyCheck` are. Without this fold, `nen
// --json pr ready <ref>` (the flag typed BEFORE the family name) would
// silently print the human report instead of the machine one.
function ready(context: CommandContext): Promise<number> {
  const booleans = new Set(context.args.booleans);
  if (context.json) booleans.add("json");
  return prReady(
    {
      positionals: context.args.positionals,
      values: context.args.values,
      booleans,
      repoFlag: context.repoFlag,
    },
    context.io,
  );
}

export const prCommand: Command = {
  name: "pr",
  summary: "CON-32 readiness, staleness, body-check, fetch, next-blocker, cascade-main, retarget, request-reviews.",
  usage: USAGE,
  flags: {
    values: [
      "wakes-from",
      "last-activity",
      "now",
      "min-verified-wakes",
      "idle-minutes",
      "body-from",
      "requirements-from",
      ...PR_READY_FLAGS.values,
      "target",
      "pr",
      "policy",
      "trunk",
      "base",
      "add-reviewers",
    ],
    booleans: ["ready", ...PR_READY_FLAGS.booleans, "delivery-pr"],
  },
  run(context: CommandContext): number | Promise<number> {
    const subcommand = requireSubcommand("pr", context.args, [
      "ready",
      "staleness",
      "body-check",
      "fetch",
      "next-blocker",
      "cascade-main",
      "retarget",
      "request-reviews",
    ]);
    switch (subcommand) {
      case "ready":
        return ready(context);
      case "staleness":
        return staleness(context);
      case "body-check":
        return bodyCheck(context);
      case "fetch":
        return fetch(context);
      case "next-blocker":
        return blocker(context);
      case "cascade-main":
        return cascade(context);
      case "retarget":
        return doRetarget(context);
      default:
        return doRequestReviews(context);
    }
  },
};

function printSnapshot(context: CommandContext, snapshot: PrSnapshot): void {
  context.io.out(`#${snapshot.pr.number} ${snapshot.title}`);
  context.io.out(`  ${snapshot.pr.headRef} -> ${snapshot.pr.baseRef}  ${snapshot.pr.headSha}`);
  context.io.out(`  mergeable: ${snapshot.pr.mergeable}  mergeStateStatus: ${snapshot.mergeStateStatus}`);
  context.io.out(`  checks: ${snapshot.checks.length}  reviews: ${snapshot.reviews.length}  review requests: ${snapshot.reviewRequests.length}`);
  const unresolved = snapshot.reviewThreads.filter((thread): boolean => !thread.isResolved).length;
  // No truncation caveat here: ../pr/fetch.ts's fetchPullRequest() now walks
  // reviewThreads to completion or throws, so `snapshot.reviewThreads` is
  // never a partial page by the time this prints (zheref/nen#14's fact-check).
  context.io.out(`  review threads: ${snapshot.reviewThreads.length} (${unresolved} unresolved)`);
}

function fetch(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const snapshot = fetchPullRequest(context.seams, target, prNumber);
  if (context.json) {
    context.io.out(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  printSnapshot(context, snapshot);
  return 0;
}

function blocker(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const reviewersRaw = context.args.values["reviewers"];
  const reviewers = reviewersRaw === undefined ? undefined : commaList(reviewersRaw);
  if (reviewersRaw !== undefined && reviewers?.length === 0) {
    // "" or "," or " , " all comma-split to an empty array. Treating that as
    // an override (no reviewers, nothing owed) rather than a usage error
    // would silently retire the owed-reviewer-round conjunct the moment a
    // caller's script passes an unset variable through --reviewers "$VAR".
    // Checked before the fetch below, so a bad flag is refused without a
    // network round trip.
    throw new VerbUsageError(
      "--reviewers named no reviewers. Omit the flag to use the repository's declared set; an empty list would silently retire the owed-round check.",
    );
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  // `--gates <path>` goes through ../verbs/pr_ready.ts's resolveIdentities --
  // THE SAME resolver `pr ready` uses, never a re-spelled copy -- because
  // zheref/nen#20's defect was exactly the two siblings drifting apart:
  // `gates` already sat in this family's declared value flags (spread in from
  // PR_READY_FLAGS for `ready`'s sake), so `next-blocker --gates <path>`
  // PARSED cleanly and was then never read. Silently accepted, zero effect --
  // a caller pointing the flag at a real file to evaluate a checkout that
  // ships no schemas/gates.json still got that checkout's own "no such file"
  // refusal, which reads as "the flag didn't help" rather than "the flag
  // doesn't exist". The empty reviewer/approver lists below are unreachable
  // padding, not a semantic choice: resolveIdentities consults its
  // flags-identity fallback only when the gates flag is undefined, and this
  // branch runs only when it is not. next-blocker's own --reviewers stays
  // what it always was -- an override handed to nextBlocker() below, never an
  // identity SOURCE.
  const gatesFlag = context.args.values["gates"];
  const identities =
    gatesFlag === undefined
      ? loadGateIdentities(root)
      : resolveIdentities(root, gatesFlag, [], []).identities;
  const snapshot = fetchPullRequest(context.seams, target, prNumber);
  const result = nextBlocker(identities, snapshot, {
    reviewers,
    policy: context.args.values["policy"] === "strict" ? "strict" : context.args.values["policy"] === "bounded" ? "bounded" : undefined,
    deliveryPr: context.args.booleans.has("delivery-pr"),
  });
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.kind === "none" ? 0 : 1;
  }
  context.io.out(`#${prNumber}: ${result.kind}`);
  context.io.out(`  ${result.detail}`);
  return result.kind === "none" ? 0 : 1;
}

function cascade(context: CommandContext): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const result = cascadeMain(context.seams, root, context.args.values["trunk"] ?? "main");
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

function doRetarget(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const base = context.args.values["base"];
  if (base === undefined || base.trim() === "") {
    throw new VerbUsageError("--base <branch> is required.");
  }
  const result = retarget(context.seams, target, prNumber, base);
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  context.io.out(result.message);
  return result.ok ? 0 : 1;
}

function doRequestReviews(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const reviewers = commaList(context.args.values["add-reviewers"]);
  const result = requestReviews(context.seams, target, prNumber, reviewers);
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  context.io.out(result.message);
  return result.ok ? 0 : 1;
}
