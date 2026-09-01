import { describe, expect, it } from "vitest";
import { classifyEffort, type EffortInput } from "./classify.js";

function input(overrides: Partial<EffortInput> = {}): EffortInput {
  return {
    kind: "child",
    issueState: "open",
    stageLabels: [],
    modeLabelPresent: false,
    hasPr: false,
    prOpen: false,
    prIsDelivery: false,
    integrationBranchAlive: false,
    ...overrides,
  };
}

describe("classifyEffort -- the state-machine check wins over everything", () => {
  it("two stage labels at once is flagged before any of the five classes are considered", () => {
    const result = classifyEffort(
      input({ stageLabels: ["building", "in-review"], hasPr: true, prOpen: true, prIsDelivery: true }),
    );
    expect(result.effortClass).toBe("state-machine-violation");
  });
});

describe("classifyEffort -- the five classes", () => {
  it("an open delivery PR is delivering", () => {
    expect(classifyEffort(input({ hasPr: true, prOpen: true, prIsDelivery: true })).effortClass).toBe("delivering");
  });

  it("a released child with a PR (not delivery) is building", () => {
    expect(classifyEffort(input({ stageLabels: ["building"], hasPr: true, prIsDelivery: false })).effortClass).toBe(
      "building",
    );
  });

  it("a released child with a live branch but no PR yet is still building", () => {
    const result = classifyEffort(input({ stageLabels: ["building"], integrationBranchAlive: true }));
    expect(result.effortClass).toBe("building");
  });

  it("a released child with no branch and no PR is stalled", () => {
    expect(classifyEffort(input({ stageLabels: ["building"] })).effortClass).toBe("stalled");
  });

  it("stalled evidence names a missing reviewer verdict when supplied", () => {
    const result = classifyEffort(input({ stageLabels: ["building"], reviewerVerdictMissing: true }));
    expect(result.effortClass).toBe("stalled");
    expect(result.evidence.join(" ")).toMatch(/died mid-run/);
  });

  it("a G1-approved child with no stage label is queued", () => {
    expect(classifyEffort(input({ modeLabelPresent: true })).effortClass).toBe("queued");
  });

  it("an epic that is closed with a live integration branch is idle", () => {
    const result = classifyEffort(input({ kind: "epic", issueState: "closed", integrationBranchAlive: true }));
    expect(result.effortClass).toBe("idle");
  });

  it("idle wins over delivering for a closed epic even with an open PR somehow still attached", () => {
    const result = classifyEffort(
      input({ kind: "epic", issueState: "closed", integrationBranchAlive: true, hasPr: true, prOpen: true, prIsDelivery: true }),
    );
    expect(result.effortClass).toBe("idle");
  });

  it("nothing at all is undecidable, never guessed", () => {
    expect(classifyEffort(input()).effortClass).toBe("undecidable");
  });
});
