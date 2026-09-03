import { describe, expect, it } from "vitest";
import { evaluateLiveChores, runPreflight, type HoldState, type PreflightInputs } from "./preflight.js";

const UNSET: HoldState = { kind: "unset" };

function inputs(overrides: Partial<PreflightInputs> = {}): PreflightInputs {
  return {
    hold: UNSET,
    holdVarName: "RELEASE_HOLD",
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
        hold: { kind: "held", value: "waiting on legal", recognizedTruthy: false },
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

  describe("RELEASE_HOLD fails CLOSED, never open (review finding)", () => {
    it("a 'not found' gh answer is a genuine, checked 'not set'", () => {
      const report = runPreflight(inputs({ hold: { kind: "unset" } }));
      const row = report.checks.find((c): boolean => c.name === "RELEASE_HOLD");
      expect(row?.ok).toBe(true);
      expect(row?.detail).toBe("not set");
    });

    it("gh failing to spawn does NOT read as 'not set'", () => {
      const report = runPreflight(inputs({ hold: { kind: "unreadable", detail: "gh could not be started" } }));
      const row = report.checks.find((c): boolean => c.name === "RELEASE_HOLD");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toContain("could not be read");
    });

    it("an unauthenticated/scope-denied gh does NOT read as 'not set'", () => {
      const report = runPreflight(inputs({ hold: { kind: "unreadable", detail: "HTTP 403: Resource not accessible" } }));
      const row = report.checks.find((c): boolean => c.name === "RELEASE_HOLD");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toContain("could not be read");
    });
  });

  describe("RELEASE_HOLD's value is parsed, not length-checked (zheref/nen#23)", () => {
    it("a 'clear' hold (explicit falsy value) passes -- but still names the lingering variable", () => {
      const report = runPreflight(inputs({ hold: { kind: "clear", value: "false" } }));
      const row = report.checks.find((c): boolean => c.name === "RELEASE_HOLD");
      expect(row?.ok).toBe(true);
      // Deliberately NOT the bare "not set" of a genuinely absent variable:
      // the operator should see the variable exists and what its value was.
      expect(row?.detail).toContain("not held");
      expect(row?.detail).toContain("'false'");
    });

    it("a recognized-truthy hold prints the plain HELD row", () => {
      const report = runPreflight(inputs({ hold: { kind: "held", value: "true", recognizedTruthy: true } }));
      const row = report.checks.find((c): boolean => c.name === "RELEASE_HOLD");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toBe("HELD: RELEASE_HOLD = 'true'");
    });

    it("an unrecognized value prints the raw value AND the fail-closed reason", () => {
      const report = runPreflight(inputs({ hold: { kind: "held", value: "freeze until Monday", recognizedTruthy: false } }));
      const row = report.checks.find((c): boolean => c.name === "RELEASE_HOLD");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toContain("'freeze until Monday'");
      expect(row?.detail).toContain("fails closed");
    });
  });

  describe("the hold row names the variable actually queried, never a hard-coded RELEASE_HOLD (review finding)", () => {
    it("a custom hold-var name flows into the held row's name and detail", () => {
      const report = runPreflight(inputs({ holdVarName: "FREEZE", hold: { kind: "held", value: "true", recognizedTruthy: true } }));
      const row = report.checks.find((c): boolean => c.name === "FREEZE");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toBe("HELD: FREEZE = 'true'");
    });

    it("a custom hold-var name flows into the clear row -- the occurrence this fix added", () => {
      const report = runPreflight(inputs({ holdVarName: "FREEZE", hold: { kind: "clear", value: "no" } }));
      const row = report.checks.find((c): boolean => c.name === "FREEZE");
      expect(row?.ok).toBe(true);
      expect(row?.detail).toContain("not held: FREEZE = 'no'");
      // The variable this run never queried must appear nowhere in the row.
      expect(row?.detail).not.toContain("RELEASE_HOLD");
    });

    it("a custom hold-var name flows into the fail-closed row", () => {
      const report = runPreflight(inputs({ holdVarName: "FREEZE", hold: { kind: "held", value: "freeze until Monday", recognizedTruthy: false } }));
      const row = report.checks.find((c): boolean => c.name === "FREEZE");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toContain("HELD: FREEZE = 'freeze until Monday'");
      expect(row?.detail).not.toContain("RELEASE_HOLD");
    });
  });

  describe("a caller-supplied fact omitted is NOT the same as asserting none (review finding)", () => {
    it("omitting --critical-issues fails the row rather than reading 'none open'", () => {
      const report = runPreflight(inputs({ openCriticalIssueNumbers: null }));
      expect(report.ok).toBe(false);
      const row = report.checks.find((c): boolean => c.name === "open critical issues");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toContain("not supplied");
    });

    it("--critical-issues '' (given, empty) passes -- an explicit assertion, not a default", () => {
      const report = runPreflight(inputs({ openCriticalIssueNumbers: [] }));
      const row = report.checks.find((c): boolean => c.name === "open critical issues");
      expect(row?.ok).toBe(true);
      expect(row?.detail).toBe("none open");
    });

    it("omitting --live-chores-from fails the row rather than reading 'none live'", () => {
      const report = runPreflight(inputs({ liveChores: null }));
      expect(report.ok).toBe(false);
      const row = report.checks.find((c): boolean => c.name === "CON-36 live chores");
      expect(row?.ok).toBe(false);
      expect(row?.detail).toContain("not supplied");
    });
  });
});
