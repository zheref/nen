// Tests for ./producer.ts -- the three verdicts of a round check's producer
// comparison (zheref/nen#546). The predicate-level fixtures (correct, wrong,
// missing, same-name impersonation) live in ./predicates.test.ts and
// ./ready.test.ts; this file pins the comparison itself.

import { describe, expect, it } from "vitest";
import {
  EMPTY_PRODUCER_CONTEXT,
  describeProducer,
  matchProducer,
  producerContext,
  workflowRunsBySuite,
  type ProducerContext,
  type WorkflowRunEvidence,
} from "./producer.js";
import type { RoundCheckProducer } from "../schema/gates.js";

const APP: RoundCheckProducer = { kind: "app", slug: "cursor", id: 1210556 };
const WORKFLOW: RoundCheckProducer = {
  kind: "workflow",
  path: ".github/workflows/review.yml",
  repository: "zheref/hatsu",
  events: ["pull_request_target"],
  trustsPullRequestRevision: false,
};
const PR = { number: 7, baseRef: "main" };
const RUN: WorkflowRunEvidence = {
  checkSuiteId: 9,
  runId: 900,
  path: ".github/workflows/review.yml",
  repository: "zheref/hatsu",
  event: "pull_request_target",
  pullRequests: [PR],
  jobIds: [41, 42],
};
const ctx = (run: Partial<WorkflowRunEvidence> = {}, pullRequest = PR): ProducerContext => producerContext([{ ...RUN, ...run }], pullRequest);
const ACTIONS = { appSlug: "github-actions", checkSuiteId: 9, checkRunId: 42 };

describe("matchProducer", () => {
  it("no declared producer always matches -- the pre-#546 reading", () => {
    expect(matchProducer(null, {}, EMPTY_PRODUCER_CONTEXT)).toEqual({ verdict: "match" });
    expect(matchProducer(undefined, { appSlug: "anything" }, EMPTY_PRODUCER_CONTEXT)).toEqual({ verdict: "match" });
  });

  it("an App producer matches on its slug AND its id", () => {
    expect(matchProducer(APP, { appSlug: "cursor", appId: 1210556 }, EMPTY_PRODUCER_CONTEXT).verdict).toBe("match");
    expect(matchProducer(APP, { appSlug: "Cursor", appId: 1210556 }, EMPTY_PRODUCER_CONTEXT).verdict).toBe("match");
    expect(matchProducer(APP, { appSlug: "cursor" }, EMPTY_PRODUCER_CONTEXT).verdict).toBe("missing");
    expect(matchProducer(APP, { appSlug: "cursor", appId: 2 }, EMPTY_PRODUCER_CONTEXT).verdict).toBe("mismatch");
    expect(matchProducer(APP, { appSlug: "cursor-bugbot", appId: 1210556 }, EMPTY_PRODUCER_CONTEXT).verdict).toBe("mismatch");
    expect(matchProducer(APP, {}, EMPTY_PRODUCER_CONTEXT).verdict).toBe("missing");
    expect(matchProducer(APP, { appSlug: "" }, EMPTY_PRODUCER_CONTEXT).verdict).toBe("missing");
  });

  it("a workflow producer needs GitHub Actions, a read suite, and the declared file, repository and event", () => {
    expect(matchProducer(WORKFLOW, ACTIONS, ctx())).toEqual({ verdict: "match" });
    expect(matchProducer(WORKFLOW, ACTIONS, ctx({ repository: "ZHEREF/Hatsu" })).verdict).toBe("match");
    expect(matchProducer(WORKFLOW, { ...ACTIONS, appSlug: "cursor" }, ctx()).verdict).toBe("mismatch");
    expect(matchProducer(WORKFLOW, { appSlug: "github-actions", checkRunId: 42 }, ctx()).verdict).toBe("missing");
    expect(matchProducer(WORKFLOW, { ...ACTIONS, checkSuiteId: 8 }, ctx()).verdict).toBe("missing");
    expect(matchProducer(WORKFLOW, ACTIONS, ctx({ repository: "fork/hatsu" })).verdict).toBe("mismatch");
    expect(matchProducer(WORKFLOW, ACTIONS, ctx({ path: ".github/workflows/Review.yml" })).verdict).toBe("mismatch");
    expect(matchProducer(WORKFLOW, ACTIONS, ctx({ event: "pull_request" }))).toEqual({
      verdict: "mismatch",
      detail: "produced by zheref/hatsu/.github/workflows/review.yml on 'pull_request', not workflow zheref/hatsu/.github/workflows/review.yml on pull_request_target",
    });
  });

  it("F1: the check must be one of the run's JOBS -- a check written into the trusted suite is not the run's own", () => {
    const foreign = matchProducer(WORKFLOW, { ...ACTIONS, checkRunId: 77 }, ctx());
    expect(foreign.verdict).toBe("missing");
    expect(foreign.verdict !== "match" && foreign.detail).toContain("check run 77 is not a job of run 900");
    expect(matchProducer(WORKFLOW, ACTIONS, ctx({ jobIds: null })).verdict).toBe("missing");
    expect(matchProducer(WORKFLOW, { appSlug: "github-actions", checkSuiteId: 9 }, ctx()).verdict).toBe("missing");
  });

  it("F2: the run must name THIS pull request onto THIS base", () => {
    const scratchBase = matchProducer(WORKFLOW, ACTIONS, ctx({ pullRequests: [{ number: 8, baseRef: "scratch" }] }));
    expect(scratchBase.verdict).toBe("missing");
    expect(scratchBase.verdict !== "match" && scratchBase.detail).toContain("does not name pull request #7 onto 'main'");
    expect(matchProducer(WORKFLOW, ACTIONS, ctx({ pullRequests: [{ number: 7, baseRef: "scratch" }] })).verdict).toBe("missing");
    expect(matchProducer(WORKFLOW, ACTIONS, ctx({ pullRequests: [] })).verdict).toBe("missing");
    expect(matchProducer(WORKFLOW, ACTIONS, producerContext([RUN], null)).verdict).toBe("missing");
  });

  it("describes each producer the way a verdict names it", () => {
    expect(describeProducer(APP)).toBe("app 'cursor' (id 1210556)");
    expect(describeProducer(WORKFLOW)).toBe("workflow zheref/hatsu/.github/workflows/review.yml on pull_request_target");
  });

  it("indexes workflow runs by suite, first entry winning", () => {
    const map = workflowRunsBySuite([RUN, { ...RUN, event: "push" }]);
    expect(map.get(9)?.event).toBe("pull_request_target");
    expect(workflowRunsBySuite(undefined).size).toBe(0);
  });
});
