// src/scaffold/workflow-default.test.ts -- the default policy document nen
// writes into somebody else's repository, held to the two properties that make
// it safe to ship.
//
//   1. IT PARSES. Every byte of it goes through ../schema/workflow.ts's own
//      loader here, so a document nen would write and then refuse to read
//      cannot ship -- which is the exact shape of failure a bundled data file
//      has, and it would land on a user's first `nen schema check` rather than
//      in this suite.
//   2. IT AGREES WITH THE LOADER'S DEFAULTS. The pack restates in JSON what
//      `defaultWorkflow()` states in TypeScript, so that a repository which
//      DELETES the file behaves exactly like one that keeps it as written. Two
//      statements of one set of numbers is two statements that can drift; this
//      is the assertion that says they have not.
//
// `models` IS THE ONE DELIBERATE DISAGREEMENT, and it is asserted as such
// below: nen has no default for it, because a default there would be nen
// inventing a name, while the pack offers a starting matrix a maintainer edits
// or deletes.

import { describe, expect, it } from "vitest";
import { defaultWorkflow, parseWorkflow, type Workflow } from "../schema/workflow.js";
import { TEMPLATE_DIRECTORY, WORKFLOW_TEMPLATE_FILE, defaultWorkflowDocument } from "./templates.js";

const WHERE = `${TEMPLATE_DIRECTORY}/${WORKFLOW_TEMPLATE_FILE}`;

function parsed(lane: string | null = null, trailers: readonly string[] = []): Workflow {
  return parseWorkflow(WHERE, defaultWorkflowDocument({ lane, allowedAttributionTrailers: trailers }));
}

describe("the bundled default policy document", () => {
  it("is what the loader reads it as -- nen never writes a file it would refuse", () => {
    expect((): unknown => parsed()).not.toThrow();
  });

  it("states, key for key, the defaults an ABSENT file applies", () => {
    // Everything but `models`, which is the stated exception, and the two
    // fields a caller's own values are written into.
    const packed = parsed();
    const built = defaultWorkflow();
    for (const block of ["branch", "tests", "coverage", "launch", "reports", "notifications", "monitor"] as const) {
      expect(
        { ...packed[block], raw: {} },
        `${WHERE} disagrees with defaultWorkflow() about '${block}'`,
      ).toEqual({ ...built[block], raw: {} });
    }
    expect(packed.iteration.checks).toEqual(built.iteration.checks);
    expect(packed.commits.forbiddenTrailers).toEqual(built.commits.forbiddenTrailers);
  });

  it("carries a model matrix the loader has no default for, and reads every leaf", () => {
    const { models } = parsed();
    expect(models.rule).not.toBeNull();
    expect(Object.keys(models.surfaces).length).toBeGreaterThan(0);
    expect(Object.keys(models.roles).length).toBeGreaterThan(0);
    for (const tiers of Object.values(models.surfaces)) {
      for (const alias of Object.values(tiers)) expect(typeof alias).toBe("string");
    }
    // ...and the loader itself still invents none of it.
    expect(defaultWorkflow().models.surfaces).toEqual({});
  });

  it("writes the caller's lane and trailer keys, and nothing else of theirs", () => {
    const document = defaultWorkflowDocument({
      lane: "web",
      allowedAttributionTrailers: ["X-Agent", "X-Run"],
    });
    const policy = parseWorkflow(WHERE, document);
    expect(policy.iteration.lane).toBe("web");
    expect(policy.commits.allowedAttributionTrailers).toEqual(["X-Agent", "X-Run"]);
    // The two overlays are the ONLY difference from the pack's own bytes.
    expect(policy.branch.template).toBe(defaultWorkflow().branch.template);
    expect(policy.coverage.minimum).toBe(defaultWorkflow().coverage.minimum);
  });

  it("returns a FRESH document on every call, so one run's lane cannot leak into the next", () => {
    const first = defaultWorkflowDocument({ lane: "web", allowedAttributionTrailers: ["A"] });
    const second = defaultWorkflowDocument({ lane: null, allowedAttributionTrailers: [] });
    expect((first["iteration"] as Record<string, unknown>)["lane"]).toBe("web");
    expect((second["iteration"] as Record<string, unknown>)["lane"]).toBeNull();
    // Mutating one must not reach the module-level import the other reads.
    (first["coverage"] as Record<string, unknown>)["minimum"] = 1;
    expect(
      (defaultWorkflowDocument({ lane: null, allowedAttributionTrailers: [] })[
        "coverage"
      ] as Record<string, unknown>)["minimum"],
    ).toBe(defaultWorkflow().coverage.minimum);
  });

  it("is a document a human can read: it says what the file is and that keys are optional", () => {
    const document = defaultWorkflowDocument({ lane: null, allowedAttributionTrailers: [] });
    expect(typeof document["$comment"]).toBe("string");
    expect(String(document["$comment"])).toContain("nen/contract.json");
    expect(document["$schema"]).toBe("nen.workflow/v0.1");
  });
});
