import { describe, expect, it } from "vitest";
import { BodyCheckError, checkBody } from "./bodycheck.js";

describe("checkBody", () => {
  const requirements = [{ name: "summary", pattern: "^## (?:✨ )?Summary$" }, { name: "tests", pattern: "^## Tests$" }];
  it("reports exact heading findings by line without changing legacy verdicts", () => {
    const body = "## Summary\n## Extra\n## Tests\n";
    expect(checkBody(body, requirements).ok).toBe(true);
    expect(checkBody(body, requirements, { exact: true })).toMatchObject({ ok: false, findings: [{ line: 2, message: expect.stringContaining("undeclared") }] });
    expect(checkBody("## Tests\n## Summary", requirements, { exact: true }).findings?.[0]).toMatchObject({ line: 2, message: expect.stringContaining("out-of-order") });
    expect(checkBody("## Summary\n## Summary\n## Tests", requirements, { exact: true }).ok).toBe(false);
  });
  it("ignores fenced and commented headings, retains glyphs and physical line numbers", () => {
    const body = "<!--\n## Hidden\n-->\n```md\n## Code\n```\n~~~\n## Code2\n~~~\n## ✨ Summary\n## Tests\n";
    expect(checkBody(body, requirements, { exact: true }).ok).toBe(true);
    expect(checkBody(body + "## Extra", requirements, { exact: true }).findings?.[0]?.line).toBe(12);
    expect(checkBody("```\n## Summary\n## Tests\n```", requirements, { exact: true }).ok).toBe(false);
    expect(checkBody("## ✨ Summary\n## Tests", [{ name: "s", pattern: "^## Summary$" }, requirements[1] as { name: string; pattern: string }], { exact: true }).ok).toBe(false);
  });
  it("caps matched headings and reports ambiguous patterns", () => {
    const eight = Array.from({ length: 8 }, (_, at): { name: string; pattern: string } => ({ name: `h${at}`, pattern: `^## H${at}$` }));
    expect(checkBody(eight.map((_, at): string => `## H${at}`).join("\n"), eight, { exact: true, max: 7 }).findings?.[0]).toMatchObject({ line: 8, message: expect.stringContaining("--max 7") });
    expect(checkBody("## Summary", [requirements[0] as { name: string; pattern: string }, { name: "same", pattern: "Summary" }], { exact: true }).findings?.[0]?.message).toContain("ambiguous");
    expect(() => checkBody("x", requirements, { max: 7 })).toThrow(/requires --exact/);
    expect(() => checkBody("x", requirements, { proseBudget: 0 })).toThrow(/positive/);
  });
  it("does not let invalid backtick fence info hide visible headings", () => {
    const body = "## Summary\ntext\n\n``` `not a fence`\n## Extra\n";
    const onlySummary = [requirements[0] as { name: string; pattern: string }];
    expect(checkBody(body, onlySummary).ok).toBe(true);
    expect(checkBody(body, onlySummary, { exact: true, max: 1 })).toMatchObject({ ok: false, findings: [{ line: 5, message: expect.stringContaining("undeclared") }] });
    expect(checkBody("## Summary\n```bad`\n" + "word ".repeat(151), onlySummary, { proseBudget: 150 }).warnings?.[0]?.words).toBeGreaterThan(150);
  });
  it("excludes short GFM table delimiters and pipe-free continuation rows", () => {
    const body = "## Summary\n| Header | Other |\n| - | - |\n| " + "word ".repeat(151) + "| ignored |\n" + "more ".repeat(151) + "\n\n" + "prose ".repeat(151) + "\n## Tests\nDone";
    expect(checkBody(body, requirements, { proseBudget: 150 }).warnings).toEqual([{ section: "Summary", words: 151, budget: 150 }]);
    const notTable = "## Summary\nprose | prose\n" + "word ".repeat(151) + "\n## Tests";
    expect(checkBody(notTable, requirements, { proseBudget: 150 }).warnings?.[0]?.words).toBe(153);
  });
  it("measures prose without changing the verdict or counting tables, comments, fences or Mermaid", () => {
    const body = `## Summary\n${"word ".repeat(151)}\n| Table words | Ignored |\n| --- | --- |\n<!-- ${"hidden ".repeat(200)} -->\n\`\`\`mermaid\n${"diagram ".repeat(200)}\n\`\`\`\n## Tests\none two`;
    expect(checkBody(body, requirements, { proseBudget: 150 })).toMatchObject({ ok: true, warnings: [{ section: "Summary", words: 151, budget: 150 }] });
  });
  it("checks every requirement, never stopping at the first miss", () => {
    const report = checkBody("## Summary\nsomething", [
      { name: "summary", pattern: "^## Summary" },
      { name: "test-plan", pattern: "^## Test plan" },
    ]);
    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.satisfied).toBe(true);
    expect(report.results[1]?.satisfied).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("is ok when every requirement is satisfied", () => {
    const report = checkBody("## Summary\n## Test plan\n", [
      { name: "summary", pattern: "## Summary" },
      { name: "test-plan", pattern: "## Test plan" },
    ]);
    expect(report.ok).toBe(true);
  });

  it("throws BodyCheckError for an unparseable pattern", () => {
    expect(() => checkBody("x", [{ name: "bad", pattern: "(" }])).toThrow(BodyCheckError);
  });

  it("refuses an EMPTY requirement list rather than reporting a vacuous pass (review finding)", () => {
    // `[].every(...)` is `true` -- an empty requirements file must never read
    // as "every requirement satisfied".
    expect(() => checkBody("anything at all", [])).toThrow(BodyCheckError);
    expect(() => checkBody("anything at all", [])).toThrow(/empty/);
  });

  it("refuses a requirement missing a string name or pattern", () => {
    expect(() => checkBody("x", [{ name: "", pattern: "x" } as never])).toThrow(BodyCheckError);
    expect(() => checkBody("x", [{ name: "ok", pattern: undefined } as never])).toThrow(BodyCheckError);
  });
});
