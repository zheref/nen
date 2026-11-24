import { describe, expect, it } from "vitest";
import { assembleRows, referencedIssueNumbers, type RawIssue, type RawPr } from "./fetch.js";

describe("referencedIssueNumbers", () => {
  it("matches a bare #n and a closing-keyword #n", () => {
    expect([...referencedIssueNumbers("see #12")]).toEqual([12]);
    expect([...referencedIssueNumbers("Fixes #7 and refs #9")]).toEqual(expect.arrayContaining([7, 9]));
  });

  // zheref/nen#639: a hex colour in a PR body was read as a reference to #0.
  it("ignores a hex colour, #0, a colour that starts with digits, and an HTML entity", () => {
    expect([...referencedIssueNumbers('<span style="color:#000000">x</span>')]).toEqual([]);
    expect([...referencedIssueNumbers("see #0 and #00")]).toEqual([]);
    expect([...referencedIssueNumbers("background: #123abc;")]).toEqual([]);
    expect([...referencedIssueNumbers("it&#39;s done &#8212; really")]).toEqual([]);
    expect([...referencedIssueNumbers("word#12")]).toEqual([]);
  });

  it("still reads the cross-repository form and a closing keyword", () => {
    expect([...referencedIssueNumbers("covers owner/name#591/AC-1")]).toEqual([591]);
    expect([...referencedIssueNumbers("Closes #591")]).toEqual([591]);
    expect([...referencedIssueNumbers("(#12), #34.")]).toEqual([12, 34]);
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

  it("treats a PR whose only '#' is a hex colour as unreferenced (zheref/nen#639)", () => {
    const prs: RawPr[] = [{ number: 98, title: "style: tint", body: "color: #000001; see owner/name#2/AC-1", createdAt: "2026-01-05T00:00:00Z" }];
    const assembly = assembleRows(issues, prs);
    expect(assembly.rows.find((r): boolean => r.issueNumber === 1)?.prNumbers).toEqual([]);
    expect(assembly.rows.find((r): boolean => r.issueNumber === 2)?.prNumbers).toEqual([98]);
  });

  it("keeps an issue with no PR as its own row", () => {
    const assembly = assembleRows(issues, []);
    expect(assembly.rows).toHaveLength(2);
    expect(assembly.rows.every((r): boolean => r.prNumbers.length === 0)).toBe(true);
  });
});
