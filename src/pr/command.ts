// src/pr/command.ts -- `nen pr ready`, `nen pr staleness`, `nen pr body-check`
// (main), and (verbs/4-remainders, zheref/nen#4) `nen pr fetch`,
// `nen pr next-blocker`, `nen pr cascade-main`, `nen pr retarget`,
// `nen pr request-reviews`, `nen pr edit-body` -- one "pr" family, nine
// subcommands.
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
  requireRepoFlag,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
  requireTargetFlag,
} from "../cli/command.js";
import { readJsonFile, readTextFile } from "../cli/inputs.js";
import { commaList } from "../cli/comma.js";
import { assertRepoRoot, resolveRepoRoot } from "../repo/root.js";
import { loadGateIdentities } from "../schema/gates.js";
import type { Seams } from "../seam/exec.js";
import { parseTarget, type Target } from "../github/target.js";
import { PR_READY_FLAGS, prReady, resolveIdentities } from "../verbs/pr_ready.js";
import { checkBody, type BodyRequirement } from "./bodycheck.js";
import { computeStaleness, type VerifiedWake } from "./staleness.js";
import { nextBlocker } from "./blocker.js";
import { cascadeMain } from "./cascade.js";
import { fetchPullRequest, type PrSnapshot } from "./fetch.js";
import { retarget } from "./retarget.js";
import { requestReviews } from "./reviewers.js";
import { fetchPrAndKnownBots, isCollaborator, requestBotReviews, type PrAndKnownBots } from "./bots.js";
import { certifyPullRequest, editBodyArgv, writePullRequestBody } from "./editbody.js";

function requireTarget(context: CommandContext): Target {
  return parseTarget(requireTargetFlag(context, "It is the GitHub side of the pair; --repo names a checkout on disk and is never used to address the API."));
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
nen pr cascade-main --repo <path> [--trunk main] [--no-push]
nen pr retarget --target <owner/name> --pr <n> --base <branch>
nen pr request-reviews --target <owner/name> --pr <n> [--add-reviewers a,b] [--add-bots id,id] [--dry-run]
nen pr edit-body --target <owner/name> --pr <n> --body-file <path> [--dry-run]

ready:
  Report a pull request's CON-32 readiness: the gate's verdict, the first
  failing conjunct, nothing else. Read-only -- it never labels, merges or
  comments.
  <ref>                       <CODE>#<N> via the target repo's product codes,
                              or a bare <N> with --gh-repo. The '#' may be
                              omitted (AB123 = AB#123); the shorthand reads the
                              LONGEST trailing digit run as the number, so a
                              code that itself ends in a digit needs the '#' --
                              <CODE>#<N> is the unambiguous form.
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
                              instead of the target repo's nen/gates.json.
                              A RELATIVE path is resolved against the --repo
                              root, NOT the current directory; pass an
                              absolute path for a file outside the target
                              repository. The resolved path is what --explain
                              and --json report.
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
                              instead of the target repo's nen/gates.json
                              -- the same flag 'ready' takes, through the same
                              resolver, so a checkout that ships no gates file
                              can still be evaluated. A RELATIVE path is
                              resolved against --repo, NOT the current
                              directory, exactly as it is for 'ready'.

cascade-main:
  Merges (never rebases) the trunk into the current branch and pushes on a
  clean merge. Reports a conflict rather than resolving it.
  --no-push                   Fetch and merge exactly as always, then stop --
                              never push. Still mutates the working tree and
                              index (the merge happens); --json gains
                              'noPush: true'. Exit codes are unchanged: 0 on a
                              clean merge, 1 on a conflict.

retarget:
  gh pr edit --base, for a stacked PR after its predecessor merges.

request-reviews:
  Two routes, chosen per name -- 'gh pr edit --add-reviewer' (once per
  name) for a User or a Team, and GitHub's 'requestReviews' GraphQL
  mutation (botIds, one call for every bot named or resolved) for a Bot,
  because 'gh pr edit --add-reviewer' resolves through
  'requestReviewsByLogin', which never resolves a Bot reviewer at all
  (zheref/nen#160). Request on the MAINTAINER's user token -- a bot
  token silently no-ops on the user route (S6); this verb cannot
  enforce which credential ran it, only warn.
  --add-reviewers <a,b>  Logins, resolved one by one: an entry containing
                         a '/' (an 'org/team' slug) is a TEAM and goes
                         straight to 'gh pr edit --add-reviewer', no
                         lookup; a bare login this pull request already
                         knows as a Bot (its own reviewRequests or
                         timelineItems) is routed to the bot mutation; a
                         bare login that reads as a collaborator of
                         --target is routed to 'gh pr edit --add-reviewer';
                         a bare login that resolves to NEITHER is refused
                         (exit 2), naming it, and pointing at --add-bots.
  --add-bots <id,id>     Bot NODE IDS (GraphQL global ids, e.g.
                         'BOT_xxxxxxxxxxxx'), passed straight through to
                         the mutation's botIds -- the one way to request
                         a bot this pull request has never seen, since
                         nothing short of the id resolves one (see
                         ./bots.ts's header).
  --dry-run              Resolution still runs (this verb is not
                         network-free even here) but nothing is
                         requested; prints which route -- bot, user or
                         team -- each name or id went to instead.

edit-body:
  Replaces the pull request's body OUTRIGHT with the file's bytes -- no
  trimming, no template, the file becomes the body exactly, through
  'gh pr edit --body-file'. --body-file is required; there is no inline
  --body. Refused (exit 2): a missing or unreadable --body-file, an empty
  or whitespace-only one, a non-numeric/non-positive --pr. The number is
  CERTIFIED as a pull request before any write -- unlike 'nen issue
  comment', which deliberately accepts either object class, this verb never
  writes the wrong object: a number that does not read as a pull request
  (the target repository's 'pulls/<n>' answers 404/410) is refused before
  anything changes, worded so it does not claim the number IS an issue --
  only that it is not a pull request -- and points at 'nen issue edit-body'
  next. --dry-run still performs that certifying read (this verb is not
  network-free), then prints the target, the number, the byte count and
  the first and last line of the body instead of writing. --json:
  '{ contract: "nen.pr.edit-body/v0.1", target, number, bytes, written,
  dryRun }'.`;

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
  summary:
    "CON-32 readiness, staleness, body-check, fetch, next-blocker, cascade-main, retarget, request-reviews, edit-body.",
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
      "add-bots",
      "body-file",
    ],
    booleans: ["ready", ...PR_READY_FLAGS.booleans, "delivery-pr", "no-push", "dry-run"],
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
      "edit-body",
    ]);
    // --no-push sits in this family's shared boolean set (above) only because
    // that set has no per-subcommand table (review finding, PR #141) -- so
    // without this, it would parse cleanly and be silently ignored on every
    // OTHER `pr` subcommand, misleading a caller who carried it over from a
    // `cascade-main` invocation. A minimal, local refusal here, rather than
    // the full foreign-flag table `shu`/`issue` have (../shu/command.ts,
    // ../issue/command.ts), because this family has no such table for any of
    // its other subcommand-specific flags yet (`--delivery-pr` has the same
    // gap) and growing one is a bigger change than this flag's own PR.
    if (subcommand !== "cascade-main" && context.args.booleans.has("no-push")) {
      throw new VerbUsageError("--no-push is only read by 'pr cascade-main'.");
    }
    // Same shape, same reason, for edit-body's own two flags -- and, since
    // zheref/nen#160, request-reviews' own --dry-run too (its resolution
    // reads GitHub the same way edit-body's certifying read does, so it
    // earns the identical dry-run-gated shape rather than a bespoke one):
    // a flag left unguarded here would parse cleanly and be silently
    // ignored on every OTHER `pr` subcommand.
    if (subcommand !== "edit-body" && subcommand !== "request-reviews" && context.args.booleans.has("dry-run")) {
      throw new VerbUsageError("--dry-run is only read by 'pr edit-body' and 'pr request-reviews'.");
    }
    if (subcommand !== "edit-body" && context.args.values["body-file"] !== undefined) {
      throw new VerbUsageError("--body-file is only read by 'pr edit-body'.");
    }
    if (subcommand !== "request-reviews" && context.args.values["add-bots"] !== undefined) {
      throw new VerbUsageError("--add-bots is only read by 'pr request-reviews'.");
    }
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
      case "request-reviews":
        return doRequestReviews(context);
      default:
        return editBody(context);
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
  // Usage lists --repo unbracketed: omitting it is refused by name at exit 2,
  // never silently read as "take the reviewer identities from whatever
  // gates file the cwd happens to hold" (zheref/nen#28). AFTER the
  // --reviewers guard above, which is checked first precisely so a bad flag
  // is refused without any filesystem or network work.
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the checkout whose nen/gates.json supplies the reviewer identities."),
  });
  // `--gates <path>` goes through ../verbs/pr_ready.ts's resolveIdentities --
  // THE SAME resolver `pr ready` uses, never a re-spelled copy -- because
  // zheref/nen#20's defect was exactly the two siblings drifting apart:
  // `gates` already sat in this family's declared value flags (spread in from
  // PR_READY_FLAGS for `ready`'s sake), so `next-blocker --gates <path>`
  // PARSED cleanly and was then never read. Silently accepted, zero effect --
  // a caller pointing the flag at a real file to evaluate a checkout that
  // ships no nen/gates.json still got that checkout's own "no such file"
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
  // Usage lists --repo unbracketed: omitting it is refused by name at exit 2
  // -- this verb MUTATES (merges and pushes) whatever repository it is pointed
  // at, so a silent cwd default is exactly the retargeting root.ts's header
  // warns about (zheref/nen#28).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the repository whose current branch the trunk is merged into."),
  });
  const result = cascadeMain(context.seams, root, context.args.values["trunk"] ?? "main", {
    noPush: context.args.booleans.has("no-push"),
  });
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.error !== null || result.conflicted ? 1 : 0;
  }
  for (const line of result.log) context.io.out(line);
  // The placeholder deliberately claims nothing about WHY a side is empty --
  // it covers both "the merge base resolved and this range genuinely had no
  // commits" and "the merge base itself could not be resolved, so this range
  // was never computed at all" (../pr/cascade.ts's collectConflicts()). Only
  // --json's ours[]/theirs[] arrays exist to tell those two apart.
  const commitList = (commits: readonly string[]): string => (commits.length === 0 ? "(no commits found)" : commits.join(", "));
  for (const conflict of result.conflicts) {
    context.io.out(`  ${conflict.path}  (${conflict.kind})`);
    context.io.out(`    ours:   ${commitList(conflict.ours)}`);
    context.io.out(`    theirs: ${commitList(conflict.theirs)}`);
  }
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

/** One `--add-reviewers`/`--add-bots` entry's resolved destination, for --dry-run and --json alike. */
interface ReviewerRoute {
  readonly name: string;
  readonly via: "add-reviewers" | "add-bots";
  readonly route: "bot" | "user" | "team";
  /** The bot's resolved node id -- only ever set on a "bot" route. */
  readonly id: string | null;
}

/**
 * `route.route`'s human word for `routeLine()` below -- a `switch` over the
 * three-member union rather than a chained ternary (Copilot review, PR #177):
 * a route this file adds a fourth member to in future gets a compiler error
 * on this function (TypeScript proves the switch exhaustive) instead of a
 * silent fall-through inside one more `? :`.
 */
function routeDetail(route: ReviewerRoute): string {
  switch (route.route) {
    case "bot": {
      // The id is shown only when it is NEW information -- resolved from a
      // --add-reviewers LOGIN. On an --add-bots route `route.id` is always
      // the same string as `route.name`; repeating it would tell the reader
      // nothing `--add-bots BOT_x -> bot [add-bots]` does not already say.
      const showId = route.id !== null && route.via === "add-reviewers";
      return `bot${showId ? ` (id ${route.id})` : ""}`;
    }
    case "team":
      return "team";
    case "user":
      return "user";
  }
}

function routeLine(route: ReviewerRoute): string {
  return `  ${route.name} -> ${routeDetail(route)} [${route.via}]`;
}

/**
 * Resolves every `--add-reviewers` login to a route, refusing (exit 2) any
 * BARE login that resolves to neither a known Bot nor a collaborator. See
 * ./bots.ts's header for why a Bot and a User need two different reads to
 * tell apart, and why a login that resolves to neither is refused here
 * rather than handed to `gh pr edit --add-reviewer` on the chance it works.
 *
 * A TEAM SLUG (`org/team`) NEVER REACHES EITHER LOOKUP. `gh pr edit
 * --add-reviewer` resolves a User login and a team slug through the exact
 * same `requestReviewsByLogin` mutation -- the bot detour this function also
 * runs (zheref/nen#160/#174) sits BESIDE that route, not in front of it, and
 * neither of the two reads that gate entry to it can even answer for a team:
 * a Bot node never carries a "/" (its `login` is a plain reviewer handle,
 * see ./bots.ts), and `collaborators(login:)` is a GitHub COLLABORATOR
 * filter that only ever resolves a user, never a team. Refusing a team slug
 * for failing a collaborator check that was never about teams regressed
 * `--add-reviewers org/team` the day #174 added that check in front of
 * every name uniformly; "/" is the one syntactic tell GitHub itself uses to
 * write a team slug, so it is used here to route a team STRAIGHT to the
 * user/team path, resolving nothing first.
 *
 * Returns `null` for `known` when nothing NEEDED the known-bots read --
 * `logins` is empty, or every entry is a team slug -- so `fetchPrAndKnownBots`
 * is skipped entirely rather than spent finding out a bot never named needs
 * no id.
 */
function resolveReviewerLogins(
  seams: Seams,
  target: Target,
  prNumber: number,
  logins: readonly string[],
): { readonly known: PrAndKnownBots | null; readonly routes: readonly ReviewerRoute[]; readonly resolvedBotIds: readonly string[]; readonly userLogins: readonly string[] } {
  if (logins.length === 0) return { known: null, routes: [], resolvedBotIds: [], userLogins: [] };

  let known: PrAndKnownBots | null = null;
  const routes: ReviewerRoute[] = [];
  const resolvedBotIds: string[] = [];
  const userLogins: string[] = [];
  const unresolved: string[] = [];

  for (const login of logins) {
    if (login.includes("/")) {
      userLogins.push(login);
      routes.push({ name: login, via: "add-reviewers", route: "team", id: null });
      continue;
    }
    known ??= fetchPrAndKnownBots(seams, target, prNumber);
    const bot = known.bots.find((candidate): boolean => candidate.login.toLowerCase() === login.toLowerCase());
    if (bot !== undefined) {
      resolvedBotIds.push(bot.id);
      routes.push({ name: login, via: "add-reviewers", route: "bot", id: bot.id });
      continue;
    }
    if (isCollaborator(seams, target, login)) {
      userLogins.push(login);
      routes.push({ name: login, via: "add-reviewers", route: "user", id: null });
      continue;
    }
    unresolved.push(login);
  }

  if (unresolved.length > 0) {
    throw new VerbUsageError(
      `${unresolved.map((login): string => `'${login}'`).join(", ")} ${
        unresolved.length === 1 ? "does" : "do"
      } not resolve to a Bot already known to ${target.slug}#${prNumber} (its own reviewRequests or timelineItems) or a collaborator of ${
        target.slug
      }. A login this pull request has never requested a review from, or received one from, cannot be told apart from a genuine typo -- if ${
        unresolved.length === 1 ? "it is a bot's" : "any of these is a bot's"
      } login, name it by its node id with --add-bots instead.`,
    );
  }

  return { known, routes, resolvedBotIds, userLogins };
}

function doRequestReviews(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const reviewerLogins = commaList(context.args.values["add-reviewers"]);
  const explicitBotIds = commaList(context.args.values["add-bots"]);
  const dryRun = context.args.booleans.has("dry-run");

  if (reviewerLogins.length === 0 && explicitBotIds.length === 0) {
    const message =
      "no reviewers named -- --add-reviewers takes a comma-separated list of logins, or --add-bots a comma-separated list of node ids";
    emit(context.io, context.json, { ok: false, message }, [message]);
    return 1;
  }

  // RESOLUTION RUNS EVEN UNDER --dry-run -- the same "not network-free"
  // shape edit-body's own --dry-run already has (it still certifies the
  // number over GitHub): the whole point of resolving before requesting is
  // that a caller learns where each name WOULD go, or that one resolves to
  // neither, without this verb ever attempting a write `gh` would refuse.
  const { known, routes: reviewerRoutes, resolvedBotIds, userLogins } = resolveReviewerLogins(
    context.seams,
    target,
    prNumber,
    reviewerLogins,
  );
  const botRoutes: ReviewerRoute[] = explicitBotIds.map((id): ReviewerRoute => ({ name: id, via: "add-bots", route: "bot", id }));
  const routes = [...reviewerRoutes, ...botRoutes];
  // Deduped by id: an id named twice (once via --add-bots, once resolved
  // from a --add-reviewers login the mutation already knows by that same
  // id) is one entry in botIds, not two -- `union:true` does not need the
  // duplicate and a repeated id tells a reader nothing a single one does not.
  const botIds = [...new Set([...resolvedBotIds, ...explicitBotIds])];

  if (dryRun) {
    const lines = [`would request review on ${target.slug}#${prNumber}:`, ...routes.map(routeLine)];
    emit(context.io, context.json, { ok: true, dryRun: true, routing: routes, message: lines.join("\n") }, lines);
    return 0;
  }

  const results: Array<{ readonly ok: boolean; readonly message: string }> = [];
  if (userLogins.length > 0) {
    results.push(requestReviews(context.seams, target, prNumber, userLogins));
  }
  if (botIds.length > 0) {
    // `known` is already populated whenever any --add-reviewers login
    // resolved to a bot; a caller who named bots ONLY via --add-bots never
    // triggered that read, so the pull request's own node id -- the
    // mutation's pullRequestId -- is fetched here instead.
    const pullRequestId = known?.pullRequestId ?? fetchPrAndKnownBots(context.seams, target, prNumber).pullRequestId;
    results.push(requestBotReviews(context.seams, target, prNumber, pullRequestId, botIds));
  }

  const ok = results.every((result): boolean => result.ok);
  const lines = results.map((result): string => result.message);
  // JOINED WITH A NEWLINE, matching the human rendering line for line
  // (Copilot review, PR #174) -- both routes running in the same call
  // prints two lines to the terminal, and `--json`'s `message` field
  // silently collapsing them with a space would be a fact the human
  // rendering states plainly and the JSON rendering blurs.
  emit(context.io, context.json, { ok, routing: routes, message: lines.join("\n") }, lines);
  return ok ? 0 : 1;
}

/**
 * The first and last line of a body, for --dry-run's summary.
 *
 * PREVIEW ONLY -- the trailing newline stripped here and the separator split
 * on are never fed back into `body` or `bytes`, which stay exactly what was
 * read off disk. Splitting on a bare "\n" left a CRLF file's last displayed
 * line carrying a trailing "\r" (Copilot review): a caller reading `last
 * line: done\r` could not tell whether that was really in the file or an
 * artifact of this rendering. `/\r?\n/` treats CRLF as one line break for
 * the preview without touching how the actual write reads the file.
 */
function bodyBookends(body: string): { readonly first: string; readonly last: string } {
  const withoutTrailingNewline = body.replace(/\r?\n$/, "");
  const lines = withoutTrailingNewline.split(/\r?\n/);
  return { first: lines[0] ?? "", last: lines[lines.length - 1] ?? "" };
}

// `--pr` IS READ WITH THE HOUSE `/^\d+$/` GUARD HERE, deliberately NOT
// through this file's own `requirePr()` above (`Number(raw ?? "")`, which
// accepts `1e3` as 1000 and `0x0c` as 12). ../issue/command.ts's `comment()`
// draws the same line for the same reason and records it at length: a
// MUTATING verb that reads a number takes the strict form, because a looser
// read would silently overwrite the wrong object's body. `requirePr()`
// predates that discipline and is left as it is for its own four callers
// (fetch/next-blocker/retarget/request-reviews) -- not this change's fix to
// make.
function requirePrStrict(context: CommandContext): number {
  const raw = context.args.values["pr"];
  if (raw === undefined) {
    throw new VerbUsageError("edit-body takes --pr <n>.");
  }
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) <= 0) {
    throw new VerbUsageError(
      `edit-body takes --pr <n>: a positive whole number, digits only -- got '${raw}'. A looser read would accept '1e3' as 1000 and '0x0c' as 12 and replace the wrong pull request's body.`,
    );
  }
  return Number.parseInt(raw, 10);
}

function editBody(context: CommandContext): number {
  const target = requireTarget(context);
  const pr = requirePrStrict(context);

  const bodyFile = context.args.values["body-file"];
  if (bodyFile === undefined) {
    throw new VerbUsageError(
      "edit-body takes --body-file <path>: a body typed on the command line is a body nobody reviewed, and this verb REPLACES the pull request's body outright.",
    );
  }

  // READ RAW AND CHECKED BEFORE ANYTHING IS SENT -- ../issue/command.ts's
  // comment() makes the same two decisions for the same reasons: a
  // --dry-run byte count that is not the byte count that would be sent is
  // not a dry run, and `gh` is handed this SAME path untouched.
  const body = readTextFile(
    bodyFile,
    process.cwd(),
    "--body-file names the bytes this verb writes as the pull request's new body, so an unreadable one is refused rather than replacing it with nothing.",
    true,
  );
  if (body.trim() === "") {
    throw new VerbUsageError(
      `--body-file '${bodyFile}' is empty (or holds only whitespace). Replacing a pull request's body with nothing is never what a caller meant, and it is never assumed.`,
    );
  }

  // CERTIFIED BEFORE ANY WRITE -- see ./editbody.ts's header for why a
  // number that does not read as a pull request is refused (exit 2) rather
  // than accepted the way 'issue comment' accepts either object class.
  certifyPullRequest(context.seams, target, pr);

  const bytes = Buffer.byteLength(body, "utf8");
  const argv = editBodyArgv(target, pr, bodyFile);

  if (context.args.booleans.has("dry-run")) {
    if (context.json) {
      context.io.out(
        JSON.stringify(
          { contract: "nen.pr.edit-body/v0.1", target: target.slug, number: pr, bytes, written: false, dryRun: true },
          null,
          2,
        ),
      );
      return 0;
    }
    const { first, last } = bodyBookends(body);
    context.io.out(`would run: gh ${argv.join(" ")}`);
    context.io.out(`target: ${target.slug}`);
    context.io.out(`number: ${pr}`);
    context.io.out(`bytes: ${bytes}`);
    context.io.out(`first line: ${first}`);
    context.io.out(`last line: ${last}`);
    return 0;
  }

  writePullRequestBody(context.seams, target, pr, bodyFile);
  if (context.json) {
    context.io.out(
      JSON.stringify(
        { contract: "nen.pr.edit-body/v0.1", target: target.slug, number: pr, bytes, written: true, dryRun: false },
        null,
        2,
      ),
    );
    return 0;
  }
  context.io.out(`replaced ${target.slug}#${pr}'s body (${bytes} byte(s))`);
  return 0;
}
