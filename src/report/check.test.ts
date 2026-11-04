import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { reportCommand } from "./command.js";

const markdown = '<!-- sample:block desk -->\n<section id="desk">\n<!-- sample:ask -->\n- **A** · choose ⭐\n{{value}}';
const html = '<section id="desk">{{value}}</section>';
async function check(md = markdown, page = html, value = "hello", missing = false, blocks = ["desk"], dataVariant?: unknown): Promise<{ code: number; out: string }> {
  const root = mkdtempSync(join(tmpdir(), "nen-report-check-"));
  try {
    mkdirSync(join(root, "nen")); mkdirSync(join(root, "templates/report-examples"), { recursive: true });
    writeFileSync(join(root, "nen/workflow.json"), JSON.stringify({ reports: { sections: { example: { template: "report", blocks } } } }));
    writeFileSync(join(root, "templates/report.md"), md); if (!missing) writeFileSync(join(root, "templates/report.html"), page);
    writeFileSync(join(root, "templates/report-examples/example.data.json"), JSON.stringify({ value, ...(dataVariant === undefined ? {} : { variant: dataVariant }), ask: { title: "choose" } }));
    const out: string[] = [], err: string[] = [];
    const code = await runFamily(reportCommand, ["report", "check"], root, true, { out: line => out.push(line), err: line => err.push(line) }, defaultSeams());
    return { code, out: out.concat(err).join("\n") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
describe("report template conformance", () => {
  it("renders matching declared blocks in both languages", async () => { expect((await check()).code).toBe(0); });
  it.each([
    { md: markdown.replace("{{value}}", "{{unknown}}"), page: html, rule: "refused render" },
    { md: markdown, page: html, value: "{{remaining}}", rule: "unfilled token" },
    { md: markdown.replace("sample:block desk", "sample:block other"), page: html, rule: "block sequence" },
    { md: markdown, page: '<section id="other">{{value}}</section>', rule: "block sequence" },
    { md: markdown.replace(" ⭐", ""), page: html, rule: "starred options" },
    { md: markdown + "\n- **B** · another ⭐", page: html, rule: "starred options" },
    { md: markdown + "\n| &amp; |", page: html, rule: "escaping shows" },
    { md: markdown + "\n| `{{value}}` |", page: html, value: "a|b", rule: "escaping shows" },
  ])("refuses $rule by variant/template", async ({ md, page, value, rule }) => {
    const result = await check(md, page, value); expect(result.code).toBe(1); expect(result.out).toContain(rule); expect(result.out).toContain("example"); expect(result.out).toContain("templates/report");
  });
  it("refuses reversed multi-block order", async () => {
    const result = await check('<!-- sample:block evidence -->\n' + markdown, html + '<section id="evidence"></section>', "hello", false, ["desk", "evidence"]);
    expect(result.code).toBe(1); expect(result.out).toContain("block sequence");
  });
  it("refuses duplicate HTML blocks", async () => { const result = await check(markdown, html + html); expect(result.code).toBe(1); expect(result.out).toContain("block sequence"); });
  it.each(["other", 123])("applies the actual renderer's variant contract %j", async (variant) => { const result = await check(markdown, html, "hello", false, ["desk"], variant); expect(result.code).toBe(1); expect(result.out).toContain("variant"); });
  it("refuses undeclared HTML sections", async () => { const result = await check(markdown, html + '<section id="surprise">extra</section>'); expect(result.code).toBe(1); expect(result.out).toContain("undeclared:surprise"); });
  it("does not mistake data-id for an actual section id", async () => { expect((await check(markdown, html.replace('id="desk"', 'data-id="desk"'))).code).toBe(1); });
  it("returns wiring for a missing template", async () => { expect((await check(markdown, html, "hello", true)).code).toBe(2); });
});
