import { describe, expect, it } from "vitest";
import { evaluateLiveChores, runPreflight, type PreflightInputs } from "./preflight.js";

function inputs(overrides: Partial<PreflightInputs> = {}): PreflightInputs {
  return {
    holdValue: null,
    openCriticalIssueNumbers: [],
    liveChores: [],
    fragmentFilesAtCutPoint: [],
    missingChangelogPrs: [],
    tagAlreadyExists: false,
    tag: "v1.1.0",
    ...overrides,
  };
}

describe("evaluateLiveChores", () => {
  it("is live only when all three parts hold", () => {
    const results = evaluateLiveChores([
      { name: "a", issueOpen: true, integrationBranchExists: true, openPrTargetsIntegrationOrMain: true },
      { name: "b", issueOpen: true, integrationBranchExists: true, openPrTargetsIntegrationOrMain: false },
    ]);
    expect(results[0]?.live).toBe(true);
    expect(results[1]?.live).toBe(false);
  });
});

describe("runPreflight", () => {
  it("passes every check when every input is clean", () => {
    const report = runPreflight(inputs());
    expect(report.ok).toBe(true);
    expect(report.checks.every((c): boolean => c.ok)).toBe(true);
  });

  it("reports EVERY failing precondition, never stopping at the first", () => {
    const report = runPreflight(
      inputs({
        holdValue: "waiting on legal",
        openCriticalIssueNumbers: [7],
        tagAlreadyExists: true,
        tag: "v1.1.0",
      }),
    );
    expect(report.ok).toBe(false);
    const failing = report.checks.filter((c): boolean => !c.ok).map((c): string => c.name);
    expect(failing).toEqual(["RELEASE_HOLD", "open critical issues", "tag does not already exist"]);
  });

  it("names a live chore without deciding whether it blocks the cut", () => {
    const report = runPreflight(
      inputs({
        liveChores: [{ name: "chore-x", issueOpen: true, integrationBranchExists: true, openPrTargetsIntegrationOrMain: true }],
      }),
    );
    const chore = report.checks.find((c): boolean => c.name === "CON-36 live chores");
    expect(chore?.ok).toBe(false);
    expect(chore?.detail).toContain("chore-x");
    expect(chore?.detail).toMatch(/G5/);
  });
});
