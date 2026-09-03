import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { parseLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";
import {
  attachSub,
  consolidateClose,
  orderingFromTaxonomy,
  planConsolidation,
  readIssue,
  type ConsolidationPlan,
} from "./subissue.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

function taxonomy(): LabelTaxonomy {
  return parseLabelTaxonomy("/x/schemas/labels.json", {
    labels: [
      { name: "ns:sev/critical", color: "b60205", description: "c" },
      { name: "ns:sev/high", color: "d93f0b", description: "h" },
      { name: "ns:sev/low", color: "0e8a16", description: "l" },
      { name: "area:cli", color: "111111", description: "cli" },
      { name: "area:docs", color: "222222", description: "docs" },
    ],
  });
}

function apiResult(number: number, id: number, labels: string[], state = "open"): { stdout: string } {
  return {
    stdout: JSON.stringify({ number, id, title: `issue ${number}`, state, labels: labels.map((name): unknown => ({ name })) }),
  };
}

describe("readIssue -- REST, because 'id' is not in gh issue view --json", () => {
  it("parses number, id, title, state and labels", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/12", result: apiResult(12, 555, ["area:cli"]) },
    ]);
    expect(readIssue(seams, TARGET, 12)).toEqual({
      number: 12,
      id: 555,
      title: "issue 12",
      state: "open",
      labels: ["area:cli"],
      isPullRequest: false,
    });
  });

  // Issue #25: GitHub serves PRs from the same issues/{n} endpoint, and the
  // non-null `pull_request` key is the ONE discriminator -- `gh issue view
  // --json pull_request` does not exist, so this fetch is where the object
  // class must be read.
  it("reads a non-null pull_request as isPullRequest -- issues/{n} serves PRs too", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api repos/zheref/nen/issues/925",
        result: {
          stdout: JSON.stringify({
            number: 925,
            id: 90925,
            title: "some pull request",
            state: "open",
            labels: [],
            pull_request: { url: "https://api.github.com/repos/zheref/nen/pulls/925" },
          }),
        },
      },
    ]);
    expect(readIssue(seams, TARGET, 925).isPullRequest).toBe(true);
  });

  it("throws naming the issue when the read fails", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/12", result: { code: 1, stderr: "not found" } },
    ]);
    expect(() => readIssue(seams, TARGET, 12)).toThrow(/zheref\/nen#12/);
  });
});

describe("attachSub -- resolves id before writing, stops on failure, detects the 404/410 fallback", () => {
  it("resolves each child's id then posts sub_issue_id, not the number", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 200, []) },
      {
        match: "gh api --method POST repos/zheref/nen/issues/1/sub_issues -F sub_issue_id=200",
        result: {},
      },
    ]);
    const report = attachSub(seams, TARGET, 1, [2], false);
    expect(report.attached).toEqual([2]);
    expect(report.failed).toEqual([]);
  });

  it("fails a child whose response carries no id, rather than guessing the number", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/2", result: { stdout: JSON.stringify({ number: 2, title: "x", state: "open", labels: [] }) } },
    ]);
    const report = attachSub(seams, TARGET, 1, [2], false);
    expect(report.failed[0]?.reason).toMatch(/carries no 'id'/);
  });

  it("dry-run logs the call and does not post", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 200, []) },
    ]);
    const report = attachSub(seams, TARGET, 1, [2], true);
    expect(report.attached).toEqual([2]);
    expect(report.log[0]).toMatch(/would run/);
    expect(seams.calls.length).toBe(1); // only the read, never the write
  });

  it("detects a 404/410 as 'endpoint unavailable' and hands back a fallback task list", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 200, []) },
      {
        match: "gh api --method POST repos/zheref/nen/issues/1/sub_issues -F sub_issue_id=200",
        result: { code: 1, stderr: "HTTP 404: Not Found" },
      },
    ]);
    const report = attachSub(seams, TARGET, 1, [2], false);
    expect(report.fallbackTaskList).toEqual(["- [ ] #2"]);
  });

  it("does NOT treat a 422 as an unavailable endpoint", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 200, []) },
      {
        match: "gh api --method POST repos/zheref/nen/issues/1/sub_issues -F sub_issue_id=200",
        result: { code: 1, stderr: "HTTP 422: Unprocessable" },
      },
    ]);
    const report = attachSub(seams, TARGET, 1, [2], false);
    expect(report.fallbackTaskList).toBeNull();
    expect(report.failed[0]?.reason).toMatch(/422/);
  });
});

describe("orderingFromTaxonomy -- declaration order as the weaker fallback", () => {
  it("reads leaf names in the family's declared order", () => {
    expect(orderingFromTaxonomy(taxonomy(), "ns:sev").order).toEqual(["critical", "high", "low"]);
  });
});

describe("planConsolidation -- label union minus severity, severity MAX only", () => {
  it("unions non-severity labels and takes the strongest severity", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, ["ns:sev/low", "area:cli"]) },
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 20, ["ns:sev/critical", "area:docs"]) },
    ]);
    const plan = planConsolidation(seams, TARGET, 99, [1, 2], taxonomy(), "ns:sev");
    expect(plan.labelUnion).toEqual(["area:cli", "area:docs"]);
    expect(plan.severity).toBe("ns:sev/critical");
    expect(plan.severitySetBy).toBe(2);
    expect(plan.toClose).toEqual([1, 2]);
    // With the family NAMED, the reduction is reachable and nothing is left
    // unreduced -- the refusal below is only for the omitted-flag case.
    expect(plan.unreducedFamilies).toEqual([]);
  });

  it("does not close an already-closed child, and notes it", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, [], "closed") },
    ]);
    const plan = planConsolidation(seams, TARGET, 99, [1], taxonomy(), "");
    expect(plan.toClose).toEqual([]);
    expect(plan.notes.some((n): boolean => n.includes("already closed"))).toBe(true);
  });

  // Issue #22: with severityFamily === "" the reduction branch is unreachable
  // (no real label's family string equals ""), so every severity label used to
  // union silently. The plan must now SAY which families would collide.
  it("reports a family whose labels would union several-at-once when no severity family is named", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, ["ns:sev/high", "area:cli"]) },
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 20, ["ns:sev/low", "area:docs"]) },
    ]);
    const plan = planConsolidation(seams, TARGET, 99, [1, 2], taxonomy(), "");
    expect(plan.unreducedFamilies).toEqual([
      { family: "ns:sev", labels: ["ns:sev/high", "ns:sev/low"] },
    ]);
  });

  it("reports nothing unreduced when no child carries two labels of one family", () => {
    const seams = new ScriptedSeams([
      // One slash-family label in total, plus leafless labels that have no
      // family members to collide with: nothing the reduction would have
      // caught, so the omitted flag stays legitimate.
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, ["ns:sev/high", "area:cli"]) },
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 20, ["area:docs"]) },
    ]);
    const plan = planConsolidation(seams, TARGET, 99, [1, 2], taxonomy(), "");
    expect(plan.unreducedFamilies).toEqual([]);
    expect(plan.labelUnion).toEqual(["area:cli", "area:docs", "ns:sev/high"]);
  });

  it("does not report a collision when two children carry the SAME family label", () => {
    // The union dedupes, the parent ends with ONE label from the family --
    // which is exactly what a reduction would have produced. Not a violation.
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, ["ns:sev/high"]) },
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 20, ["ns:sev/high"]) },
    ]);
    const plan = planConsolidation(seams, TARGET, 99, [1, 2], taxonomy(), "");
    expect(plan.unreducedFamilies).toEqual([]);
  });
});

describe("consolidateClose -- file -> attach -> close, stops before closes on attach failure", () => {
  function plan(children: number[]): ConsolidationPlan {
    return {
      parent: 9,
      children: children.map((n): { number: number; id: number | null; title: string; state: string; labels: string[]; isPullRequest: boolean } => ({
        number: n,
        id: n * 10,
        title: `#${n}`,
        state: "open",
        labels: [],
        isPullRequest: false,
      })),
      labelUnion: [],
      severity: null,
      severitySetBy: null,
      toClose: children,
      unreducedFamilies: [],
      notes: [],
    };
  }

  it("closes every child with a comment naming the parent, after attaching all", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, []) },
      { match: "gh api --method POST repos/zheref/nen/issues/9/sub_issues -F sub_issue_id=10", result: {} },
      { match: "gh issue close 1 --repo zheref/nen --comment Consolidated into #9.", result: {} },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1]), false);
    expect(report.closed).toEqual([1]);
    expect(report.failed).toEqual([]);
  });

  it("stops before any close when an attach fails", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: { code: 1, stderr: "boom" } },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1]), false);
    expect(report.closed).toEqual([]);
    expect(report.failed.length).toBe(1);
    expect(report.log.some((l): boolean => l.includes("STOPPED"))).toBe(true);
  });

  it("dry-run never calls close", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, []) },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1]), true);
    expect(report.closed).toEqual([1]);
    expect(seams.calls.length).toBe(1);
  });
});
