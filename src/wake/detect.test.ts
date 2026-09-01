import { describe, expect, it } from "vitest";
import {
  alreadyFlagged,
  alreadyRedriven,
  decideActions,
  hasActiveRun,
  isRedrivableConclusion,
  isRedrivableEvent,
  isSwallowed,
  pickSwallowedRuns,
  type WorkflowRun,
} from "./detect.js";

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "1",
    conclusion: "action_required",
    htmlUrl: "https://example.invalid/runs/1",
    event: "pull_request",
    createdAt: "2026-01-01T00:00:00Z",
    workflowId: "10",
    status: "completed",
    ...overrides,
  };
}

describe("isSwallowed / isRedrivableConclusion", () => {
  it("recognizes both swallowed conclusions, and only those", () => {
    expect(isSwallowed("action_required")).toBe(true);
    expect(isSwallowed("startup_failure")).toBe(true);
    expect(isSwallowed("failure")).toBe(false);
    expect(isSwallowed("success")).toBe(false);
  });

  it("only action_required is redrivable -- startup_failure reproduces 4-for-4", () => {
    expect(isRedrivableConclusion("action_required")).toBe(true);
    expect(isRedrivableConclusion("startup_failure")).toBe(false);
  });
});

describe("isRedrivableEvent", () => {
  it("accepts the finite self-heal/review whitelist", () => {
    expect(isRedrivableEvent("pull_request")).toBe(true);
    expect(isRedrivableEvent("check_suite")).toBe(true);
  });

  it("excludes 'issues' (a fresh build, out of scope) and anything unknown", () => {
    expect(isRedrivableEvent("issues")).toBe(false);
    expect(isRedrivableEvent("workflow_dispatch")).toBe(false);
  });
});

describe("pickSwallowedRuns", () => {
  it("filters to swallowed conclusions, newest first", () => {
    const runs = [
      run({ id: "1", createdAt: "2026-01-01T00:00:00Z" }),
      run({ id: "2", conclusion: "success" }),
      run({ id: "3", createdAt: "2026-01-02T00:00:00Z", conclusion: "startup_failure" }),
    ];
    expect(pickSwallowedRuns(runs).map((r): string => r.id)).toEqual(["3", "1"]);
  });
});

describe("hasActiveRun", () => {
  it("is true only for a DIFFERENT run of the SAME workflow that is in_progress/queued", () => {
    const runs = [
      run({ id: "1", workflowId: "10", status: "action_required" }),
      run({ id: "2", workflowId: "10", status: "in_progress" }),
      run({ id: "3", workflowId: "99", status: "queued" }),
    ];
    expect(hasActiveRun(runs, "1", "10")).toBe(true); // run 2, same workflow, active
    expect(hasActiveRun(runs, "3", "99")).toBe(false); // no OTHER active run of wf 99
    expect(hasActiveRun(runs, "2", "10")).toBe(false); // run 1 is not active
  });
});

describe("alreadyFlagged / alreadyRedriven", () => {
  it("matches the stamp for its own run id and not a numeric superstring", () => {
    const comments = [{ body: "<!-- nen-wake-guard flag run_id=12 at=2026-01-01T00:00:00Z -->" }];
    expect(alreadyFlagged(comments, "nen-wake-guard", "12")).toBe(true);
    expect(alreadyFlagged(comments, "nen-wake-guard", "1")).toBe(false);
    expect(alreadyRedriven(comments, "nen-wake-guard", "12")).toBe(false);
  });
});

describe("decideActions", () => {
  it("redrives an action_required run on a redrivable event with no active sibling", () => {
    const actions = decideActions({
      runs: [run()],
      comments: [],
      now: "2026-01-01T01:00:00Z",
      marker: "nen-wake-guard",
      maxRunsPerPr: 3,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("redrive");
    expect(actions[0]?.commentBody).toContain("redrive run_id=1");
  });

  it("flags rather than redrives a startup_failure", () => {
    const actions = decideActions({
      runs: [run({ conclusion: "startup_failure" })],
      comments: [],
      now: "2026-01-01T01:00:00Z",
      marker: "nen-wake-guard",
      maxRunsPerPr: 3,
    });
    expect(actions[0]?.kind).toBe("flag-not-redrivable");
  });

  it("flags rather than redrives an out-of-scope event", () => {
    const actions = decideActions({
      runs: [run({ event: "workflow_dispatch" })],
      comments: [],
      now: "2026-01-01T01:00:00Z",
      marker: "nen-wake-guard",
      maxRunsPerPr: 3,
    });
    expect(actions[0]?.kind).toBe("flag-not-redrivable");
  });

  it("falls back to a human flag once a run is still swallowed after one redrive", () => {
    const comments = [{ body: "<!-- nen-wake-guard redrive run_id=1 at=2026-01-01T00:00:00Z -->" }];
    const actions = decideActions({
      runs: [run()],
      comments,
      now: "2026-01-01T02:00:00Z",
      marker: "nen-wake-guard",
      maxRunsPerPr: 3,
    });
    expect(actions[0]?.kind).toBe("flag-already-redriven");
  });

  it("never redrives a run a second time once redriven AND flagged", () => {
    const comments = [
      { body: "<!-- nen-wake-guard redrive run_id=1 at=2026-01-01T00:00:00Z -->" },
      { body: "<!-- nen-wake-guard flag run_id=1 at=2026-01-01T02:00:00Z -->" },
    ];
    const actions = decideActions({
      runs: [run()],
      comments,
      now: "2026-01-01T03:00:00Z",
      marker: "nen-wake-guard",
      maxRunsPerPr: 3,
    });
    expect(actions[0]?.kind).toBe("skip-already-handled");
  });

  it("skips a redrive that would race a same-workflow run already redriven this tick", () => {
    const runs = [
      run({ id: "1", workflowId: "10", createdAt: "2026-01-02T00:00:00Z" }),
      run({ id: "2", workflowId: "10", createdAt: "2026-01-01T00:00:00Z" }),
    ];
    const actions = decideActions({
      runs,
      comments: [],
      now: "2026-01-01T03:00:00Z",
      marker: "nen-wake-guard",
      maxRunsPerPr: 3,
    });
    expect(actions[0]?.kind).toBe("redrive"); // run 1, newest first
    expect(actions[1]?.kind).toBe("skip-workflow-redriven-this-tick");
  });

  it("skips a redrive while another run of the same workflow is active", () => {
    const runs = [run({ id: "1", workflowId: "10" }), run({ id: "2", workflowId: "10", status: "in_progress", conclusion: "success" })];
    const actions = decideActions({
      runs,
      comments: [],
      now: "2026-01-01T03:00:00Z",
      marker: "nen-wake-guard",
      maxRunsPerPr: 3,
    });
    expect(actions[0]?.kind).toBe("skip-active-run");
  });

  it("counts only actions TAKEN toward the cap, never rows merely examined", () => {
    const comments = [
      { body: "<!-- nen-wake-guard redrive run_id=1 at=2026-01-01T00:00:00Z -->" },
      { body: "<!-- nen-wake-guard flag run_id=1 at=2026-01-01T00:00:00Z -->" },
    ];
    const runs = [
      run({ id: "1", createdAt: "2026-01-03T00:00:00Z" }), // already handled -- no-op
      run({ id: "2", createdAt: "2026-01-02T00:00:00Z" }), // genuinely actionable
    ];
    const actions = decideActions({
      runs,
      comments,
      now: "2026-01-01T03:00:00Z",
      marker: "nen-wake-guard",
      maxRunsPerPr: 1,
    });
    expect(actions[0]?.kind).toBe("skip-already-handled");
    expect(actions[1]?.kind).toBe("redrive"); // not starved by the no-op ahead of it
  });
});
