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
  renderCloseComment,
  unknownPlaceholders,
  unmatchedBraces,
  DEFAULT_CLOSE_COMMENT,
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

  // ROUND-TWO REVIEW: `closeComments` is DOCUMENTED as empty when the attach
  // stage fails -- "reporting the texts that WOULD have gone out would read as
  // a list of things that did" -- and nothing pinned it. A one-line mutation
  // (rendering the templates before the stage check, or returning them in the
  // early-return branch) silently turns a --json caller's evidence of what was
  // posted into a list of what was not. Asserted with a caller-supplied
  // template, because the default's rendering is the one a reader would most
  // readily mistake for a record of a real close.
  it("reports NO close comments when the attach stage failed -- not the ones it would have posted", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: { code: 1, stderr: "boom" } },
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 20, []) },
      { match: "gh api --method POST repos/zheref/nen/issues/9/sub_issues -F sub_issue_id=20", result: {} },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1, 2]), false, {
      template: "Absorbed by section A of #{parent}.",
      perChild: new Map(),
    });
    // #2 DID attach -- so this is the partial case, where a report that listed
    // the would-be texts would be at its most convincing and most wrong.
    expect(report.attached).toEqual([2]);
    expect(report.failed.length).toBe(1);
    expect(report.closeComments).toEqual([]);
    expect(report.closed).toEqual([]);
    // The three attach-stage calls and no fourth: a close whose comment was
    // rendered AND sent would be red here rather than only in the field above.
    expect(seams.calls.length).toBe(3);
  });

  it("dry-run never calls close", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, []) },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1]), true);
    expect(report.closed).toEqual([1]);
    expect(seams.calls.length).toBe(1);
  });

  // --- the caller-supplied close comment (zheref/nen#29) ----------------------

  // BACK-COMPAT, PINNED AT THE ARGV. Omitting the channel must post the exact
  // bytes the fixed implementation posted -- and the assertion is on the argv
  // the Runner saw, not on a report field, because the argv is what GitHub gets.
  it("with NO close-comment supplied, posts the historical fixed string byte for byte", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, []) },
      { match: "gh api --method POST repos/zheref/nen/issues/9/sub_issues -F sub_issue_id=10", result: {} },
      { match: "gh issue close 1 --repo zheref/nen --comment Consolidated into #9.", result: {} },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1]), false);
    expect(report.closed).toEqual([1]);
    expect(seams.calls[2]?.args).toEqual([
      "issue",
      "close",
      "1",
      "--repo",
      "zheref/nen",
      "--comment",
      "Consolidated into #9.",
    ]);
    expect(report.closeComments).toEqual([{ child: 1, body: "Consolidated into #9." }]);
    // The old log line CLAIMED the comment names the parent; with the default
    // it still does, byte-identically, so a transcript diff against an older
    // run is empty.
    expect(report.log).toContain("closed #1 with a comment naming #9");
  });

  it("a template equal to the default renders the same bytes -- the default IS a template", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, []) },
      { match: "gh api --method POST repos/zheref/nen/issues/9/sub_issues -F sub_issue_id=10", result: {} },
      { match: "gh issue close 1 --repo zheref/nen --comment Consolidated into #9.", result: {} },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1]), false, {
      template: DEFAULT_CLOSE_COMMENT,
      perChild: new Map(),
    });
    expect(report.closeComments).toEqual([{ child: 1, body: "Consolidated into #9." }]);
  });

  it("a supplied template substitutes {parent} and {child} for EVERY child", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, []) },
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 20, []) },
      { match: "gh api --method POST repos/zheref/nen/issues/9/sub_issues -F sub_issue_id=10", result: {} },
      { match: "gh api --method POST repos/zheref/nen/issues/9/sub_issues -F sub_issue_id=20", result: {} },
      { match: "gh issue close 1 --repo zheref/nen --comment #1 folded into #9.", result: {} },
      { match: "gh issue close 2 --repo zheref/nen --comment #2 folded into #9.", result: {} },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1, 2]), false, {
      template: "#{child} folded into #{parent}.",
      perChild: new Map(),
    });
    expect(report.closed).toEqual([1, 2]);
    expect(report.closeComments).toEqual([
      { child: 1, body: "#1 folded into #9." },
      { child: 2, body: "#2 folded into #9." },
    ]);
    // The parent-naming claim is dropped where it is no longer guaranteed.
    expect(report.log).toContain("closed #1 with the caller-supplied close comment");
  });

  // THE CASE THE ISSUE ACTUALLY DESCRIBES: each absorbed member closed with a
  // comment naming WHICH section absorbed it -- text that differs per child, so
  // one template cannot express it.
  it("a per-child map gives each child its own text, and each may still use the placeholders", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, []) },
      { match: "gh api repos/zheref/nen/issues/2", result: apiResult(2, 20, []) },
      { match: "gh api --method POST repos/zheref/nen/issues/9/sub_issues -F sub_issue_id=10", result: {} },
      { match: "gh api --method POST repos/zheref/nen/issues/9/sub_issues -F sub_issue_id=20", result: {} },
      { match: "gh issue close 1 --repo zheref/nen --comment Absorbed by section A of #9.", result: {} },
      { match: "gh issue close 2 --repo zheref/nen --comment Absorbed by section B of #9.", result: {} },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1, 2]), false, {
      template: null,
      perChild: new Map([
        [1, "Absorbed by section A of #{parent}."],
        [2, "Absorbed by section B of #{parent}."],
      ]),
    });
    expect(report.closeComments).toEqual([
      { child: 1, body: "Absorbed by section A of #9." },
      { child: 2, body: "Absorbed by section B of #9." },
    ]);
  });

  it("dry-run prints the RENDERED close comment and still posts nothing", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/1", result: apiResult(1, 10, []) },
    ]);
    const report = consolidateClose(seams, TARGET, plan([1]), true, {
      template: "Absorbed by section A of #{parent}.",
      perChild: new Map(),
    });
    expect(report.log).toContain(
      "would run: gh issue close 1 --repo zheref/nen --comment Absorbed by section A of #9.",
    );
    expect(seams.calls.length).toBe(1); // only the id read, never a close
  });
});

describe("the close-comment template vocabulary", () => {
  it("substitutes the BARE numbers, so the caller writes the '#' and can spell a cross-repo form", () => {
    expect(renderCloseComment("owner/name#{parent} absorbed {child}", 9, 1)).toBe(
      "owner/name#9 absorbed 1",
    );
  });

  it("renders the frozen default to the string the fixed implementation posted", () => {
    expect(renderCloseComment(DEFAULT_CLOSE_COMMENT, 9, 1)).toBe("Consolidated into #9.");
  });

  it("accepts the two words of the vocabulary and substitutes nothing else", () => {
    expect(unknownPlaceholders("see {parent} and {child}")).toEqual([]);
    expect(renderCloseComment("a { b } c", 9, 1)).toBe("a { b } c");
  });

  // An unrecognised placeholder would otherwise be POSTED LITERALLY onto a
  // public timeline by a verb that closes issues, with exit 0.
  it("names every unknown placeholder, deduplicated, so one round trip fixes them all", () => {
    expect(unknownPlaceholders("{parnet} and {section} and {parnet}")).toEqual([
      "{parnet}",
      "{section}",
    ]);
    expect(unknownPlaceholders("{}")).toEqual(["{}"]);
  });

  // REVIEW FINDING: the guard used to match only brace runs whose interior was
  // word characters, so these three -- the three shapes a human actually
  // mistypes -- were neither refused NOR substituted, and went out literally at
  // exit 0. `{{parent}}` was the worst: the INNER braces matched, so it posted
  // the genuinely baffling `#{1}`.
  it.each([
    ["{{parent}}", "the Handlebars/Jinja spelling"],
    ["{ parent }", "a space inside the braces"],
    ["{parent }", "a trailing space"],
    ["{ parent}", "a leading space"],
    ['{"a": 1}', "JSON, which is refused rather than passed through"],
  ])("refuses the brace run %s (%s) instead of posting it as typed", (run) => {
    expect(unknownPlaceholders(`Absorbed into #${run}.`)).toEqual([run]);
  });

  // The pass-through half of the same finding: even reached directly, render
  // must not turn `#{{parent}}` into `#{1}`. The CLI refuses it first, but a
  // renderer that substitutes what the guard rejects is one refactor away from
  // being the whole bug again.
  it("substitutes nothing inside a brace run the guard rejects", () => {
    expect(renderCloseComment("#{{parent}}", 9, 1)).toBe("#{{parent}}");
    expect(renderCloseComment("#{ parent }", 9, 1)).toBe("#{ parent }");
    expect(renderCloseComment("#{parent }", 9, 1)).toBe("#{parent }");
  });
});

// ROUND-TWO REVIEW FINDING. The brace-RUN guard above requires braces on BOTH
// sides, which is a shape a dropped closing brace does not have: `#{parent`
// matched nothing, so it was neither refused nor substituted and went out
// literally on a REAL close, at exit 0, onto a public timeline. That is the
// same defect the `{{parent}}` round fixed, one keystroke over -- and a
// dropped brace is at least as common a typo as an extra one.
describe("unmatched braces -- the half a brace-run scan structurally cannot see", () => {
  it.each([
    ["#{parent", "{parent"],
    ["{child absorbed", "{child"],
    ["parent} of #9", "}"],
    ["{", "{"],
  ])("reports the stray brace in '%s'", (template, offender) => {
    expect(unmatchedBraces(template)).toEqual([offender]);
  });

  it("says nothing about a WELL-FORMED run -- its braces are not strays", () => {
    expect(unmatchedBraces("Consolidated into #{parent}.")).toEqual([]);
    expect(unmatchedBraces("#{{parent}} and { parent } and {}")).toEqual([]);
  });

  it("reports each stray once, in first-appearance order", () => {
    expect(unmatchedBraces("{parent and {child and {parent")).toEqual(["{parent", "{child"]);
  });

  // The two faults are reported by two functions because they are two
  // mistakes: an unknown WORD versus a missing BRACE. A template with one of
  // each must be fully described by the pair -- neither may swallow the other.
  it("splits the two brace faults cleanly between the two reports", () => {
    expect(unknownPlaceholders("{section} absorbed #{parent")).toEqual(["{section}"]);
    expect(unmatchedBraces("{section} absorbed #{parent")).toEqual(["{parent"]);
  });

  // The renderer's half: even reached directly, an unmatched brace passes
  // through byte for byte rather than being half-substituted.
  it("substitutes nothing around an unmatched brace", () => {
    expect(renderCloseComment("Consolidated into #{parent", 9, 1)).toBe("Consolidated into #{parent");
  });
});
