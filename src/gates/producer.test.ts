// Tests for ./producer.ts -- the three verdicts of a round check's producer
// comparison (zheref/nen#546). The predicate-level fixtures (correct, wrong,
// missing, same-name impersonation) live in ./predicates.test.ts and
// ./ready.test.ts; this file pins the comparison itself.

import { describe, expect, it } from "vitest";
import { describeProducer, matchProducer, workflowRunsBySuite, type WorkflowRunEvidence } from "./producer.js";
import type { RoundCheckProducer } from "../schema/gates.js";

const APP: RoundCheckProducer = { kind: "app", slug: "cursor", id: null };
const PINNED: RoundCheckProducer = { kind: "app", slug: "cursor", id: 1210556 };
const WORKFLOW: RoundCheckProducer = {
  kind: "workflow",
  path: ".github/workflows/review.yml",
  repository: "zheref/hatsu",
  events: ["pull_request_target", "workflow_run"],
};
const RUN: WorkflowRunEvidence = { checkSuiteId: 9, path: ".github/workflows/review.yml", repository: "zheref/hatsu", event: "workflow_run" };
const RUNS = workflowRunsBySuite([RUN]);

describe("matchProducer", () => {
  it("no declared producer always matches -- the pre-#546 reading", () => {
    expect(matchProducer(null, {}, new Map())).toEqual({ verdict: "match" });
    expect(matchProducer(undefined, { appSlug: "anything" }, new Map())).toEqual({ verdict: "match" });
  });

  it("an App producer matches on its slug, and on its id only when pinned", () => {
    expect(matchProducer(APP, { appSlug: "cursor" }, new Map()).verdict).toBe("match");
    expect(matchProducer(APP, { appSlug: "Cursor" }, new Map()).verdict).toBe("match");
    expect(matchProducer(PINNED, { appSlug: "cursor", appId: 1210556 }, new Map()).verdict).toBe("match");
    expect(matchProducer(PINNED, { appSlug: "cursor" }, new Map()).verdict).toBe("missing");
    expect(matchProducer(PINNED, { appSlug: "cursor", appId: 2 }, new Map()).verdict).toBe("mismatch");
    expect(matchProducer(APP, { appSlug: "cursor-bugbot" }, new Map()).verdict).toBe("mismatch");
    expect(matchProducer(APP, {}, new Map()).verdict).toBe("missing");
    expect(matchProducer(APP, { appSlug: "" }, new Map()).verdict).toBe("missing");
  });

  it("a workflow producer needs GitHub Actions, a read suite, and the declared file, repository and event", () => {
    const actions = { appSlug: "github-actions", checkSuiteId: 9 };
    expect(matchProducer(WORKFLOW, actions, RUNS)).toEqual({ verdict: "match" });
    expect(matchProducer(WORKFLOW, actions, workflowRunsBySuite([{ ...RUN, repository: "ZHEREF/Hatsu" }])).verdict).toBe("match");
    expect(matchProducer(WORKFLOW, { appSlug: "cursor", checkSuiteId: 9 }, RUNS).verdict).toBe("mismatch");
    expect(matchProducer(WORKFLOW, { appSlug: "github-actions" }, RUNS).verdict).toBe("missing");
    expect(matchProducer(WORKFLOW, { appSlug: "github-actions", checkSuiteId: 8 }, RUNS).verdict).toBe("missing");
    expect(matchProducer(WORKFLOW, actions, workflowRunsBySuite([{ ...RUN, repository: "fork/hatsu" }])).verdict).toBe("mismatch");
    expect(matchProducer(WORKFLOW, actions, workflowRunsBySuite([{ ...RUN, path: ".github/workflows/Review.yml" }])).verdict).toBe("mismatch");
    expect(matchProducer(WORKFLOW, actions, workflowRunsBySuite([{ ...RUN, event: "pull_request" }]))).toEqual({
      verdict: "mismatch",
      detail: "produced by zheref/hatsu/.github/workflows/review.yml on 'pull_request', not workflow zheref/hatsu/.github/workflows/review.yml on pull_request_target|workflow_run",
    });
  });

  it("describes each producer the way a verdict names it", () => {
    expect(describeProducer(APP)).toBe("app 'cursor'");
    expect(describeProducer(PINNED)).toBe("app 'cursor' (id 1210556)");
    expect(describeProducer(WORKFLOW)).toBe("workflow zheref/hatsu/.github/workflows/review.yml on pull_request_target|workflow_run");
  });

  it("indexes workflow runs by suite, first entry winning", () => {
    const map = workflowRunsBySuite([RUN, { ...RUN, event: "push" }]);
    expect(map.get(9)?.event).toBe("workflow_run");
    expect(workflowRunsBySuite(undefined).size).toBe(0);
  });
});
