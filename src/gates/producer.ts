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
}

/**
 * The GitHub Actions workflow run attached to one check suite, as the
 * transport read it (REST `actions/runs?check_suite_id=`). `repository` is
 * `owner/name`.
 */
export interface WorkflowRunEvidence {
  readonly checkSuiteId: number;
  readonly path: string;
  readonly repository: string;
  readonly event: string;
}

export type ProducerVerdict =
  | { readonly verdict: "match" }
  | { readonly verdict: "mismatch"; readonly detail: string }
  | { readonly verdict: "missing"; readonly detail: string };

/** One declared producer, rendered the way a verdict names it. */
export function describeProducer(producer: RoundCheckProducer): string {
  if (producer.kind === "app") {
    return `app '${producer.slug}'${producer.id === null ? "" : ` (id ${producer.id})`}`;
  }
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

export function matchProducer(
  producer: RoundCheckProducer | null | undefined,
  evidence: ProducerEvidence,
  workflowRuns: ReadonlyMap<number, WorkflowRunEvidence>,
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
    if (producer.id !== null) {
      const id = typeof evidence.appId === "number" ? evidence.appId : null;
      if (id === null) {
        return { verdict: "missing", detail: `the producing App's id was not read, so app '${slug}' cannot be shown to be ${wanted}` };
      }
      if (id !== producer.id) {
        return { verdict: "mismatch", detail: `produced by app '${slug}' with id ${id}, not ${wanted}` };
      }
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
  const run = workflowRuns.get(suite);
  if (run === undefined) {
    return { verdict: "missing", detail: `the workflow run of check suite ${suite} was not read, so it cannot be shown to be ${wanted}` };
  }
  if (run.repository.toLowerCase() !== producer.repository.toLowerCase() || run.path !== producer.path) {
    return { verdict: "mismatch", detail: `produced by workflow ${run.repository}/${run.path}, not ${wanted}` };
  }
  if (!producer.events.includes(run.event)) {
    return { verdict: "mismatch", detail: `produced by ${run.repository}/${run.path} on '${run.event}', not ${wanted}` };
  }
  return { verdict: "match" };
}
