import { describe, expect, it } from "vitest";
import {
  checkCompleteness,
  extractChangelogRefs,
  extractFragmentRefs,
  extractMergedPrNumbers,
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
