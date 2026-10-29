// src/gates/producer.ts -- does a round check's PRODUCER match the one its
// reviewer declares? (zheref/nen#546)
//
// WHY IT EXISTS. A reviewer whose check IS its round (`round_check_pattern`)
// was satisfied by any definitive-SUCCESS check of that NAME. A name is chosen
// by whoever creates the check, so a pull request that adds a workflow job
// named like the reviewer's check produced the reviewer's round at its own
// head. `round_check_producer` (../schema/gates.ts) states who may produce
// it; this module compares that statement against GitHub's own record of who
// did: the App that created the check suite and, for a GitHub Actions run, the
// workflow file, repository and event of the run attached to that suite.
//
// THREE VERDICTS, AND ONLY ONE OF THEM IS A ROUND:
//   match     the evidence is present and every declared field agrees;
//   mismatch  the evidence is present and names a different producer -- the
//             detail says which, so a reader sees "made by github-actions,
//             not cursor" rather than "no round";
//   missing   evidence a declared field needs was not read (a transport that
//             carries no App, a check suite whose workflow run could not be
//             looked up, a legacy status context). NEVER a match: an unread
//             producer is not a trusted one, so the round stays owed and the
//             detail says what was missing (AC-3).
// A reviewer with NO declared producer always matches: that is the pre-#546
// reading, byte for byte, for every file that does not state the key.
//
// A WORKFLOW PRODUCER BINDS THE RUN, NOT ONLY THE SUITE (hanten round 1 on
// #546, Feitan F1 and F2). A check created with a token lands in the
// github-actions App's EXISTING suite on that commit, so "the suite's run is
// the declared workflow" is not enough: the check's own id must be one of
// that run's JOBS (a job's id is its check run's id). And the run must name
// THIS pull request onto THIS base in its `pull_requests[]`, or a
// `pull_request_target` run of a second pull request from the same head,
// onto a scratch base carrying a modified workflow, would count. Either fact
// unread is `missing`: unverified, owed. A check the run's jobs, read in full,
// do not include is `mismatch`: a known other producer (round 2, N9).
//
// THE PULL-REQUEST CHECK IS DEFENCE IN DEPTH, NOT THE BINDING (round 2,
// Feitan F7). GitHub fills a run's `pull_requests[]` from its head, not its
// trigger, so a `pull_request_target` run of a second pull request from the
// same head lists this one too. What binds a workflow producer is the EVENT
// allowlist at load (../schema/gates.ts's DEFAULT_BRANCH_DEFINITION_EVENTS):
// `pull_request_target` and every event outside it need an opt-in that warns
// that any branch writer can produce the round.
//
// PURE: no network, no clock. The evidence arrives on the check (../github/
// types.ts's `appSlug`, `appId`, `checkSuiteId`) and, for workflows, in the
// `workflowRuns` the transport looked up by check suite (../github/
// pr_state.ts).

import type { RoundCheckProducer } from "../schema/gates.js";

/** The App GitHub Actions creates every workflow run's check suite under. */
export const GITHUB_ACTIONS_APP_SLUG = "github-actions";

/** What a check carries about who produced it; every field optional. */
export interface ProducerEvidence {
  readonly appSlug?: string | null;
  readonly appId?: number | null;
  readonly checkSuiteId?: number | null;
  /**
   * The check run's own id (GraphQL `databaseId`, REST `id`). For a
   * `workflow` producer it must be one of the resolved run's job ids: a job's
   * id IS its check run's id, and a check written into the suite by a token
   * is no job of the run (Feitan F1 on #546).
   */
  readonly checkRunId?: number | null;
}

/** One pull request a workflow run names: its number and its base branch. */
export interface RunPullRequest {
  readonly number: number;
  readonly baseRef: string;
}

/**
 * The GitHub Actions workflow run attached to one check suite, as the
 * transport read it (REST `actions/runs?check_suite_id=` and, when the run
 * could be the producer, `actions/runs/{id}/jobs`). `repository` is
 * `owner/name`. `jobIds` is `null` when the jobs were not read.
 */
export interface WorkflowRunEvidence {
  readonly checkSuiteId: number;
  readonly runId: number | null;
  readonly path: string;
  readonly repository: string;
  readonly event: string;
  readonly pullRequests: readonly RunPullRequest[];
  readonly jobIds: readonly number[] | null;
}

/**
 * What the comparison needs beyond the check itself: the workflow runs read
 * by suite, and the pull request being judged (its number and base branch),
 * which a `workflow` producer's run must name (Feitan F2 on #546). `null`
 * when unknown, which leaves a workflow producer unverified.
 */
export interface ProducerContext {
  readonly workflowRuns: ReadonlyMap<number, WorkflowRunEvidence>;
  readonly pullRequest: RunPullRequest | null;
}

export const EMPTY_PRODUCER_CONTEXT: ProducerContext = { workflowRuns: new Map(), pullRequest: null };

export function producerContext(
  runs: readonly WorkflowRunEvidence[] | undefined,
  pullRequest: RunPullRequest | null | undefined,
): ProducerContext {
  return { workflowRuns: workflowRunsBySuite(runs), pullRequest: pullRequest ?? null };
}

export type ProducerVerdict =
  | { readonly verdict: "match" }
  | { readonly verdict: "mismatch"; readonly detail: string }
  | { readonly verdict: "missing"; readonly detail: string };

/** One declared producer, rendered the way a verdict names it. */
export function describeProducer(producer: RoundCheckProducer): string {
  if (producer.kind === "app") return `app '${producer.slug}' (id ${producer.id})`;
  return `workflow ${producer.repository}/${producer.path} on ${producer.events.join("|")}`;
}

/** Index a list of workflow-run evidence by check suite, first entry winning. */
export function workflowRunsBySuite(
  runs: readonly WorkflowRunEvidence[] | undefined,
): ReadonlyMap<number, WorkflowRunEvidence> {
  const map = new Map<number, WorkflowRunEvidence>();
  for (const run of runs ?? []) if (!map.has(run.checkSuiteId)) map.set(run.checkSuiteId, run);
  return map;
}

/**
 * Does a run's file, repository and event match a `workflow` producer? The
 * part of the comparison that can say MISMATCH -- the transport asks it to
 * decide whether a run's jobs are worth reading at all.
 */
export function workflowRunMatches(
  producer: Extract<RoundCheckProducer, { kind: "workflow" }>,
  run: Pick<WorkflowRunEvidence, "path" | "repository" | "event">,
): ProducerVerdict {
  const wanted = describeProducer(producer);
  if (run.repository.toLowerCase() !== producer.repository.toLowerCase() || run.path !== producer.path) {
    return { verdict: "mismatch", detail: `produced by workflow ${run.repository}/${run.path}, not ${wanted}` };
  }
  if (!producer.events.includes(run.event)) {
    return { verdict: "mismatch", detail: `produced by ${run.repository}/${run.path} on '${run.event}', not ${wanted}` };
  }
  return { verdict: "match" };
}

/** Does a run name this pull request, on this base (Feitan F2)? */
export function runNamesPullRequest(run: Pick<WorkflowRunEvidence, "pullRequests">, pullRequest: RunPullRequest | null): boolean {
  return (
    pullRequest !== null &&
    run.pullRequests.some((entry): boolean => entry.number === pullRequest.number && entry.baseRef === pullRequest.baseRef)
  );
}

export function matchProducer(
  producer: RoundCheckProducer | null | undefined,
  evidence: ProducerEvidence,
  context: ProducerContext,
): ProducerVerdict {
  if (producer === null || producer === undefined) return { verdict: "match" };
  const wanted = describeProducer(producer);
  const slug = typeof evidence.appSlug === "string" && evidence.appSlug !== "" ? evidence.appSlug : null;
  if (slug === null) {
    return { verdict: "missing", detail: `no producing App was read for the check, so it cannot be shown to be ${wanted}` };
  }
  if (producer.kind === "app") {
    if (slug.toLowerCase() !== producer.slug) {
      return { verdict: "mismatch", detail: `produced by app '${slug}', not ${wanted}` };
    }
    const id = typeof evidence.appId === "number" ? evidence.appId : null;
    if (id === null) {
      return { verdict: "missing", detail: `the producing App's id was not read, so app '${slug}' cannot be shown to be ${wanted}` };
    }
    if (id !== producer.id) {
      return { verdict: "mismatch", detail: `produced by app '${slug}' with id ${id}, not ${wanted}` };
    }
    return { verdict: "match" };
  }
  if (slug.toLowerCase() !== GITHUB_ACTIONS_APP_SLUG) {
    return { verdict: "mismatch", detail: `produced by app '${slug}', not by a GitHub Actions run of ${wanted}` };
  }
  const suite = typeof evidence.checkSuiteId === "number" ? evidence.checkSuiteId : null;
  if (suite === null) {
    return { verdict: "missing", detail: `no check suite was read for the check, so its workflow run cannot be shown to be ${wanted}` };
  }
  const run = context.workflowRuns.get(suite);
  if (run === undefined) {
    return { verdict: "missing", detail: `the workflow run of check suite ${suite} was not read, so it cannot be shown to be ${wanted}` };
  }
  const file = workflowRunMatches(producer, run);
  if (file.verdict !== "match") return file;
  if (!runNamesPullRequest(run, context.pullRequest)) {
    const pr = context.pullRequest;
    return {
      verdict: "missing",
      detail:
        pr === null
          ? `the pull request being judged is unknown, so run ${run.runId ?? "?"} of check suite ${suite} cannot be tied to it`
          : `run ${run.runId ?? "?"} of check suite ${suite} does not name pull request #${pr.number} onto '${pr.baseRef}', so it cannot be shown to be this pull request's ${wanted}`,
    };
  }
  if (run.jobIds === null) {
    return { verdict: "missing", detail: `the jobs of run ${run.runId ?? "?"} were not read, so the check cannot be shown to be one of them` };
  }
  const checkRunId = typeof evidence.checkRunId === "number" ? evidence.checkRunId : null;
  if (checkRunId === null) {
    return { verdict: "missing", detail: `the check run's id was not read, so it cannot be shown to be a job of run ${run.runId ?? "?"}` };
  }
  // The jobs were read IN FULL and the check is not one of them: that is a
  // known other producer -- a check written into the suite -- so MISMATCH,
  // which lets `producerScopedChecks` drop it before the latest-by-name
  // reduction (hanten round 2, Nobunaga N9, Feitan F8).
  if (!run.jobIds.includes(checkRunId)) {
    return {
      verdict: "mismatch",
      detail: `check run ${checkRunId} is not a job of run ${run.runId ?? "?"} (${run.repository}/${run.path}): a check written into the suite is not the workflow's own`,
    };
  }
  return { verdict: "match" };
}
