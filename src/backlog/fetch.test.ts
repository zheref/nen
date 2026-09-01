import { describe, expect, it } from "vitest";
import { assembleRows, referencedIssueNumbers, type RawIssue, type RawPr } from "./fetch.js";

describe("referencedIssueNumbers", () => {
  it("matches a bare #n and a closing-keyword #n", () => {
    expect([...referencedIssueNumbers("see #12")]).toEqual([12]);
    expect([...referencedIssueNumbers("Fixes #7 and refs #9")]).toEqual(expect.arrayContaining([7, 9]));
  });
});

describe("assembleRows", () => {
  const issues: RawIssue[] = [
    { number: 1, title: "Issue one", labels: ["a"], createdAt: "2026-01-01T00:00:00Z" },
    { number: 2, title: "Issue two", labels: [], createdAt: "2026-01-02T00:00:00Z" },
  ];

  it("puts an issue and its PRs in one row", () => {
    const prs: RawPr[] = [
      { number: 10, title: "fix #1", body: "closes #1", createdAt: "2026-01-03T00:00:00Z" },
    ];
    const assembly = assembleRows(issues, prs);
    const row = assembly.rows.find((r): boolean => r.issueNumber === 1);
    expect(row?.prNumbers).toEqual([10]);
  });

  it("gives an unreferenced PR its own row", () => {
    const prs: RawPr[] = [{ number: 99, title: "orphan work", body: "no reference here", createdAt: "2026-01-04T00:00:00Z" }];
    const assembly = assembleRows(issues, prs);
    const row = assembly.rows.find((r): boolean => r.prNumbers.includes(99));
    expect(row?.issueNumber).toBeNull();
  });

  it("keeps an issue with no PR as its own row", () => {
    const assembly = assembleRows(issues, []);
    expect(assembly.rows).toHaveLength(2);
    expect(assembly.rows.every((r): boolean => r.prNumbers.length === 0)).toBe(true);
  });
});
