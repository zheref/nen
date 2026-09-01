// src/wake/detect.ts -- the swallowed-wake decision engine behind `nen wake
// verify`.
//
// PORTED FROM bankai-core's `scripts/detect_swallowed_wakes.sh` (27 KB;
// bankai-core#273, #398, #443, #624, #671 -- the incident numbers cited below
// are that script's own). This module carries its DECISION LOGIC -- which run
// is swallowed, which is redrivable, which is safe to redrive this tick --
// as PURE functions, so the whole engine is testable without a network or a
// live repository; the shell mixed decision and `gh` calls in one script,
// which is exactly what BC-9 (a script with real branching and no test) is
// the auto-reject for. ../wake/command.ts is the seam-driven half: it fetches
// the inputs this module decides over and executes the actions this module
// returns.
//
// A SWALLOWED RUN is one that produced no check, no job, no log and no
// annotation, and so is indistinguishable from "nothing happened" to every
// downstream consumer:
//
//   action_required  GitHub gated the triggering actor; approval never came
//                    (bankai-core#273).
//   startup_failure  the workflow could not start at all (bankai-core#671).
//                    BC-PR-#660 and BC-PR-#610 each sat 11 hours in this
//                    state, both MERGEABLE/CLEAN, both showing zero checks.
//
// They share a shape and a blind spot, which is why they share a scanner.
// They do NOT share a remedy: `action_required` is redrivable (the run is
// intact and merely un-approved); `startup_failure` is NOT -- bankai-core#671
// measured re-firing it 4-for-4 reproducing the same failure, because the
// condition is per-branch and persistent, not transient. Re-running it would
// spend the one permitted redrive attempt reproducing the failure and then
// stamp the PR handled.
//
// THE AGENT-AUTHOR AND STAMP VOCABULARY ARE PARAMETERS, NOT LITERALS. The
// original scopes its scan to a hard-coded list of six bot logins and stamps
// its idempotency markers with its own persona's name in the HTML comment
// body -- as TWO DISTINCT PHRASES, `bankai swallowed-wake-guard` for a flag
// and `bankai swallowed-wake-redrive` for a redrive, each already the full
// literal `already_flagged`/`already_redriven` grep against
// (detect_swallowed_wakes.sh:178/190) -- not one marker with a kind word
// appended. Both are exactly the "names are data" violation the Akatsuki
// migration's §3 exists to end: a binary that shipped one repository's agent
// logins would scan for the wrong authors everywhere else. So the author
// filter is a caller-supplied pattern (`nen wake verify --author-pattern
// <regex>`) and the idempotency stamps are two caller-supplied FULL marker
// phrases -- `--flag-marker` (default `nen-wake-guard`) and
// `--redrive-marker` (default `nen-wake-redrive`) -- rather than one marker
// with " flag"/" redrive" appended by this code: a single shared marker has
// no value that reproduces the source's two distinct phrases, so a migration
// caller pointing both nen and the still-running shell sweep at the same
// repository could set these to the source's exact strings and have each
// recognise the other's stamps (review finding). DISCLOSED GAP: at their
// DEFAULTS the stamps are still not byte-identical to the source's, so the
// two are interoperable only once a migration caller sets both flags to the
// source's literal phrases.

export type SwallowedConclusion = "action_required" | "startup_failure";

export function isSwallowed(conclusion: string): conclusion is SwallowedConclusion {
  return conclusion === "action_required" || conclusion === "startup_failure";
}

/**
 * True iff re-running the run has any chance of a different outcome.
 * `startup_failure` is per-branch and persistent, never transient
 * (bankai-core#671, measured 4-for-4) -- so it is detected but never redriven.
 */
export function isRedrivableConclusion(conclusion: string): boolean {
  return conclusion === "action_required";
}

// The finite, cited whitelist of SELF-HEAL/REVIEW wake events (bankai-core#398
// scope). These are GitHub's own event-type vocabulary -- not a persona or a
// repository's taxonomy -- so they are named directly, the same way
// ../gates/predicates.ts names `CheckConclusion`/`ReviewState`. Deliberately
// excludes `issues` (a fresh build, never scoped to a PR branch this scanner
// reaches) and anything else not in this list: a future GitHub event this
// module does not yet understand fails CLOSED to the detect-only path rather
// than being silently auto-redriven.
const REDRIVABLE_EVENTS: ReadonlySet<string> = new Set([
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "pull_request",
  "check_suite",
]);

export function isRedrivableEvent(event: string): boolean {
  return REDRIVABLE_EVENTS.has(event);
}

export interface WorkflowRun {
  readonly id: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
  readonly event: string;
  readonly createdAt: string;
  readonly workflowId: string;
  readonly status: string;
}

/** Every SWALLOWED run, newest first (bankai-core#624: examine every one, not just the latest). */
export function pickSwallowedRuns(runs: readonly WorkflowRun[]): WorkflowRun[] {
  return runs
    .filter((run): boolean => run.conclusion !== null && isSwallowed(run.conclusion))
    .slice()
    .sort((a, b): number => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/**
 * True iff another run of the SAME workflow (the granularity at which this
 * repository's job-level concurrency groups actually collide, bankai-core#443)
 * is `in_progress` or `queued` right now, other than `runId` itself.
 */
export function hasActiveRun(
  runs: readonly WorkflowRun[],
  runId: string,
  workflowId: string,
): boolean {
  return runs.some(
    (run): boolean =>
      run.id !== runId &&
      run.workflowId === workflowId &&
      (run.status === "in_progress" || run.status === "queued"),
  );
}

export interface StampedComment {
  readonly body: string;
}

// `marker` is a FULL phrase here -- no kind word is appended by this
// function. That is what lets a caller set `--flag-marker`/`--redrive-marker`
// to the source's own two distinct phrases and have this match them exactly
// (review finding: a single marker with " flag"/" redrive" appended had no
// value that could ever equal the source's stamps).
function hasStamp(comments: readonly StampedComment[], marker: string, runId: string): boolean {
  const pattern = new RegExp(`${escapeRegExp(marker)}.*run_id=${escapeRegExp(runId)}(?![0-9])`);
  return comments.some((comment): boolean => pattern.test(comment.body));
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function alreadyFlagged(comments: readonly StampedComment[], flagMarker: string, runId: string): boolean {
  return hasStamp(comments, flagMarker, runId);
}

export function alreadyRedriven(comments: readonly StampedComment[], redriveMarker: string, runId: string): boolean {
  return hasStamp(comments, redriveMarker, runId);
}

export function flagStamp(flagMarker: string, runId: string, now: string): string {
  return `<!-- ${flagMarker} run_id=${runId} at=${now} -->`;
}

export function redriveStamp(redriveMarker: string, runId: string, now: string): string {
  return `<!-- ${redriveMarker} run_id=${runId} at=${now} -->`;
}

// flagBody / redriveBody -- THE FULL, CONCLUSION-SELECTED COMMENT, not just the
// idempotency marker. Ported from flag_body/redrive_body
// (detect_swallowed_wakes.sh:196-227): the source's own header calls the
// CONCLUSION-selected wording "load-bearing rather than cosmetic", because the
// `action_required` text tells a human to `gh run rerun` while that remedy is
// FALSE for a `startup_failure` (bankai-core#671 measured re-firing it 4-for-4
// reproducing the same failure). Surfacing the swallowed run to a human is the
// whole purpose of #273; the stamp alone is only the idempotency marker that
// lets a later tick recognise its own prior comment, not the message a human
// reads. The stamp is kept as the TRAILING line so `hasStamp`'s substring match
// still finds it inside the larger body.
export function flagBody(params: {
  readonly flagMarker: string;
  readonly runId: string;
  readonly htmlUrl: string;
  readonly now: string;
  readonly conclusion: string;
  readonly note?: string;
}): string {
  const { flagMarker, runId, htmlUrl, now, conclusion, note } = params;
  let lead: string;
  let detail: string;
  if (conclusion === "startup_failure") {
    lead = `Dead run detected -- a workflow run on this PR's branch concluded 'startup_failure' and never executed: ${htmlUrl}`;
    detail = `The workflow could not start: zero jobs, no log, no annotation, and no check run. Do not 'gh run rerun' it -- re-firing the same event against the same tree reproduces the failure; this has been measured to reproduce every time.`;
  } else {
    lead = `Swallowed wake detected -- a workflow run on this PR's branch concluded 'action_required' and never executed: ${htmlUrl}`;
    detail = `GitHub gated this run's triggering actor and no approval followed, so it sat at 0 job runs -- indistinguishable from silence to every downstream consumer. Re-run it by hand ('gh run rerun ${runId}') once you've confirmed why it was gated, or re-trigger the underlying event.`;
  }
  const leadWithNote = note === undefined || note === "" ? lead : `${lead}\n\n${note}`;
  return `${leadWithNote}\n\n${detail}\n\n${flagStamp(flagMarker, runId, now)}`;
}

export function redriveBody(params: {
  readonly redriveMarker: string;
  readonly runId: string;
  readonly htmlUrl: string;
  readonly now: string;
  readonly event: string;
}): string {
  const { redriveMarker, runId, htmlUrl, now, event } = params;
  const lead = `Swallowed wake auto-redriven -- a '${event}' self-heal/review run on this PR's branch concluded 'action_required' and never executed; it has been auto-redriven via 'gh run rerun ${runId}': ${htmlUrl}`;
  const detail = `This run is redriven at most once -- if it is STILL swallowed on the next sweep, this falls back to a detect-only flag for a human ('gh run rerun ${runId}' by hand once you've confirmed why it keeps gating).`;
  return `${lead}\n\n${detail}\n\n${redriveStamp(redriveMarker, runId, now)}`;
}

// --- the decision --------------------------------------------------------

export type ActionKind =
  | "redrive"
  | "flag-already-redriven"
  | "flag-not-redrivable"
  | "skip-already-handled"
  | "skip-active-run"
  | "skip-workflow-redriven-this-tick"
  | "cap-reached";

export interface PlannedAction {
  readonly kind: ActionKind;
  readonly run: WorkflowRun;
  readonly reason: string;
  /** The comment body to post, when this action posts one. */
  readonly commentBody: string | null;
}

export interface DecideInput {
  readonly runs: readonly WorkflowRun[];
  readonly comments: readonly StampedComment[];
  readonly now: string;
  readonly flagMarker: string;
  readonly redriveMarker: string;
  readonly maxRunsPerPr: number;
}

/**
 * Decide the action for every swallowed run on one PR, in the source's own
 * order and with its own per-PR cap (`handled` counts ACTIONS TAKEN, never
 * rows examined -- BC-PR-#632: counting on entry starved an older genuinely
 * actionable run behind a persistently already-handled one).
 */
export function decideActions(input: DecideInput): PlannedAction[] {
  const swallowed = pickSwallowedRuns(input.runs);
  const actions: PlannedAction[] = [];
  const redrivenThisTick = new Set<string>();
  let handled = 0;

  for (const run of swallowed) {
    if (handled >= input.maxRunsPerPr) {
      actions.push({
        kind: "cap-reached",
        run,
        reason: `per-PR cap of ${input.maxRunsPerPr} swallowed run(s) reached this tick -- the rest wait for the next one`,
        commentBody: null,
      });
      continue;
    }
    const conclusion = run.conclusion ?? "";

    if (alreadyRedriven(input.comments, input.redriveMarker, run.id)) {
      if (alreadyFlagged(input.comments, input.flagMarker, run.id)) {
        actions.push({
          kind: "skip-already-handled",
          run,
          reason: `run ${run.id} already redriven and flagged`,
          commentBody: null,
        });
        continue;
      }
      actions.push({
        kind: "flag-already-redriven",
        run,
        reason: `run ${run.id} was already auto-redriven once and is STILL swallowed -- falling back to a human flag`,
        commentBody: flagBody({
          flagMarker: input.flagMarker,
          runId: run.id,
          htmlUrl: run.htmlUrl,
          now: input.now,
          conclusion,
          note: `This run was already auto-redriven once and is still '${conclusion}' -- needs a human, not another auto-redrive.`,
        }),
      });
      handled += 1;
      continue;
    }

    if (!isRedrivableConclusion(conclusion)) {
      if (alreadyFlagged(input.comments, input.flagMarker, run.id)) {
        actions.push({
          kind: "skip-already-handled",
          run,
          reason: `run ${run.id} already flagged`,
          commentBody: null,
        });
        continue;
      }
      actions.push({
        kind: "flag-not-redrivable",
        run,
        reason: `conclusion '${conclusion}' is not redrivable -- reproduces on re-fire rather than clearing`,
        commentBody: flagBody({
          flagMarker: input.flagMarker,
          runId: run.id,
          htmlUrl: run.htmlUrl,
          now: input.now,
          conclusion,
          note: `Not auto-redriven: a '${conclusion}' reproduces on re-fire rather than clearing, so a rerun would spend the one permitted attempt reproducing it and then stamp this PR as handled.`,
        }),
      });
      handled += 1;
      continue;
    }

    if (!isRedrivableEvent(run.event)) {
      if (alreadyFlagged(input.comments, input.flagMarker, run.id)) {
        actions.push({
          kind: "skip-already-handled",
          run,
          reason: `run ${run.id} already flagged`,
          commentBody: null,
        });
        continue;
      }
      actions.push({
        kind: "flag-not-redrivable",
        run,
        reason: `event '${run.event}' is outside the self-heal/review scope`,
        commentBody: flagBody({
          flagMarker: input.flagMarker,
          runId: run.id,
          htmlUrl: run.htmlUrl,
          now: input.now,
          conclusion,
          note: `Not auto-redriven: '${run.event}' is outside the self-heal/review scope.`,
        }),
      });
      handled += 1;
      continue;
    }

    if (redrivenThisTick.has(run.workflowId)) {
      actions.push({
        kind: "skip-workflow-redriven-this-tick",
        run,
        reason: `shares workflow_id ${run.workflowId} with a run already redriven THIS TICK -- redriving both would enter the same concurrency group and race`,
        commentBody: null,
      });
      continue;
    }
    if (hasActiveRun(input.runs, run.id, run.workflowId)) {
      actions.push({
        kind: "skip-active-run",
        run,
        reason: `another run of this same workflow is still in_progress/queued on this branch -- redriving could cancel it via a shared concurrency group`,
        commentBody: null,
      });
      continue;
    }

    redrivenThisTick.add(run.workflowId);
    actions.push({
      kind: "redrive",
      run,
      reason: `swallowed '${conclusion}' on a redrivable event -- auto-redriving via 'gh run rerun ${run.id}'`,
      commentBody: redriveBody({
        redriveMarker: input.redriveMarker,
        runId: run.id,
        htmlUrl: run.htmlUrl,
        now: input.now,
        event: run.event,
      }),
    });
    handled += 1;
  }

  return actions;
}
