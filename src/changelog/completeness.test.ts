import { describe, expect, it } from "vitest";
import {
  checkCompleteness,
  datedSections,
  describeReleasePrAllowance,
  extractChangelogRefs,
  extractFragmentRefs,
  extractMergedPrNumbers,
  openingDatedSection,
  sectionHeadings,
  type ReleasePrAllowance,
} from "./completeness.js";

describe("extractMergedPrNumbers", () => {
  it("parses GitHub's merge-commit subject and skips a branch-sync merge", () => {
    expect(
      extractMergedPrNumbers(["Merge pull request #42 from x/y", "merge: sync origin/main into feature"]),
    ).toEqual([42]);
  });
});

describe("extractChangelogRefs", () => {
  it("scopes to the given owner/repo -- a foreign-repo link with the same number does not count", () => {
    const text = "see https://github.com/zheref/nen/pull/12 and https://github.com/zheref/other/pull/12";
    expect(extractChangelogRefs(text, "zheref/nen")).toEqual([12]);
  });
});

describe("extractFragmentRefs", () => {
  it("parses the leading numeric prefix, uncollated fragments included", () => {
    expect(extractFragmentRefs(["7-slug.md", "no-number.md"])).toEqual([7]);
  });
});

describe("checkCompleteness", () => {
  it("is ok when every merged PR is referenced by the changelog or a fragment", () => {
    const report = checkCompleteness({ mergedPrNumbers: [1, 2], changelogRefs: [1], fragmentRefs: [2] });
    expect(report.ok).toBe(true);
  });

  it("reports every missing PR, sorted, not just the first", () => {
    const report = checkCompleteness({ mergedPrNumbers: [3, 1, 2], changelogRefs: [], fragmentRefs: [] });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([1, 2, 3]);
  });
});

// zheref/nen#229 -- the release-PR allowance, as the pure half sees it: a
// DECISION arrives (./reconcile.ts makes it from the history) and this module
// excuses at most the one PR it names, and only when it says `applied`.
describe("checkCompleteness -- the release-PR allowance excuses one PR, and only when applied", () => {
  const applied: ReleasePrAllowance = {
    applied: true,
    verdict: "applied",
    pr: 222,
    mergeSha: "a".repeat(40),
    firstParentSha: "b".repeat(40),
    section: "v0.12.0",
    carriedBy: null,
    detail: "the range ends at its merge aaaaaaa, which introduced v0.12.0",
  };

  it("reconciles the applied PR and carries the decision into the report", () => {
    const report = checkCompleteness({ mergedPrNumbers: [221, 222], changelogRefs: [221], fragmentRefs: [], releasePrAllowance: applied });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.releasePrAllowance).toBe(applied);
  });

  it("still names every OTHER uncited PR -- the allowance is never wider than one", () => {
    const report = checkCompleteness({ mergedPrNumbers: [220, 221, 222], changelogRefs: [221], fragmentRefs: [], releasePrAllowance: applied });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([220]);
  });

  it("excuses nothing when the decision DECLINED, even though it names the PR", () => {
    const declined: ReleasePrAllowance = { ...applied, applied: false, verdict: "section-carried", carriedBy: 222, pr: 225 };
    const report = checkCompleteness({ mergedPrNumbers: [221, 222, 225], changelogRefs: [221, 222], fragmentRefs: [], releasePrAllowance: declined });
    expect(report.missing).toEqual([225]);
    expect(report.releasePrAllowance?.verdict).toBe("section-carried");
  });

  it("excuses nothing from an 'applied' decision that names no PR", () => {
    const report = checkCompleteness({ mergedPrNumbers: [5], changelogRefs: [], fragmentRefs: [], releasePrAllowance: { ...applied, pr: null } });
    expect(report.missing).toEqual([5]);
  });

  it("reports a null decision when none was supplied -- the citation check as it always was", () => {
    const report = checkCompleteness({ mergedPrNumbers: [1], changelogRefs: [1], fragmentRefs: [] });
    expect(report).toEqual({ missing: [], ok: true, releasePrAllowance: null });
  });
});

describe("describeReleasePrAllowance -- the one line both verbs print", () => {
  const base: ReleasePrAllowance = {
    applied: true,
    verdict: "applied",
    pr: 268,
    mergeSha: "f".repeat(40),
    firstParentSha: "5".repeat(40),
    section: "v0.15.1",
    carriedBy: null,
    detail: "WHY",
  };

  it("names an applied PR and the RULE that let it through -- never claims it IS the release PR", () => {
    expect(describeReleasePrAllowance(base)).toBe("#268 reconciled by the CON-33(c) release-PR allowance: WHY");
  });

  it("says why a terminal PR that is still missing was NOT reconciled", () => {
    expect(describeReleasePrAllowance({ ...base, applied: false, verdict: "section-on-first-parent" })).toBe(
      "#268 not reconciled by the release-PR allowance: WHY",
    );
  });

  it("stays silent when there is nothing to add to the missing list", () => {
    expect(describeReleasePrAllowance(null)).toBeNull();
    expect(describeReleasePrAllowance({ ...base, applied: false, verdict: "terminal-pr-cited" })).toBeNull();
    expect(describeReleasePrAllowance({ ...base, applied: false, verdict: "terminal-not-pr-merge", pr: null })).toBeNull();
  });
});

describe("datedSections / openingDatedSection -- both heading levels this family writes", () => {
  it("reads nen's own '## vX.Y.Z — date' and collate's '### vX.Y.Z — theme', top to bottom", () => {
    const text = "# Changelog\n\n### Unreleased\n\n## v0.15.1 — 2026-09-28\n\ntext\n\n### Fixed\n\n### v0.15.0 — theme\n";
    expect(datedSections(text)).toEqual(["v0.15.1", "v0.15.0"]);
    expect(openingDatedSection(text)).toBe("v0.15.1");
  });

  it("keeps a pre-release suffix, reads a bare version heading as dated, and tolerates a CRLF line", () => {
    expect(datedSections("## v1.2.0-rc.1 — 2026-01-01\r\n## v1.1.0\r\n")).toEqual(["v1.2.0-rc.1", "v1.1.0"]);
  });

  it("is null for a CHANGELOG with no versioned heading -- Keep-a-Changelog's '## [1.2.3]' and a level-4 heading are not one", () => {
    expect(openingDatedSection("# Changelog\n\n## [1.2.3] - 2026-01-01\n#### v1.0.0\n##v2.0.0\n")).toBeNull();
  });
});

// zheref/nen#229, the review settlement's ruling on the issue's literal
// wording: the allowance covers the PR that introduced the DATED section, so
// `## vX.Y.Z — unreleased` is not dated. Read as dated, it excused the
// delivery PR that OPENED the heading (1c3ff7f, #242) and declined the
// release PR that dated it (#246) -- the reverse of the issue.
describe("a heading whose trailing text is 'unreleased' is NOT dated", () => {
  it("is kept as a versioned heading, marked undated, in every spelling this family has used", () => {
    const text = [
      "## v0.14.0 — unreleased",
      "## v0.13.3 - Unreleased",
      "## v0.13.2 (unreleased)",
      "### v0.13.1 — _UNRELEASED_",
      "## v0.13.0 — 2026-09-20",
      "## v0.12.9 — unreleased fixes",
    ].join("\n");
    expect(sectionHeadings(text)).toEqual([
      { version: "v0.14.0", dated: false },
      { version: "v0.13.3", dated: false },
      { version: "v0.13.2", dated: false },
      { version: "v0.13.1", dated: false },
      { version: "v0.13.0", dated: true },
      // Only the exact word is undated; a theme that merely begins with it is a theme.
      { version: "v0.12.9", dated: true },
    ]);
    expect(datedSections(text)).toEqual(["v0.13.0", "v0.12.9"]);
  });

  it("a CHANGELOG OPENING with an unreleased heading cuts no dated section -- the dated one below it is not skipped to", () => {
    expect(openingDatedSection("# Changelog\n\n## v0.14.0 — unreleased\n\n## v0.13.1 — 2026-09-21\n")).toBeNull();
  });

  it("the same version, once dated, is the dated section", () => {
    expect(openingDatedSection("# Changelog\n\n## v0.14.0 — 2026-09-22\n\n## v0.13.1 — 2026-09-21\n")).toBe("v0.14.0");
  });
});
