// src/schema/canonlint.test.ts -- nen/workflow.json `canon.lint` (zheref/nen#481):
// the declared home of the canon prose lint's rules contract and baseline, and
// the `nen/workflow.json#canon.lint` schema-check row that validates both files
// with the readers `nen canon lint` runs.

import { afterAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTaxonomy, type SchemaCheck } from "./taxonomy.js";
import { parseWorkflow } from "./workflow.js";

const CONTRACT = join(process.cwd(), "src", "canon", "fixtures", "prose.lint.json");
const scratch = mkdtempSync(join(tmpdir(), "nen-canon-lint-schema-"));
afterAll((): void => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

function repo(workflow: unknown, files: Record<string, string> = {}): string {
  const root = join(scratch, `repo-${++n}`);
  mkdirSync(join(root, "nen"), { recursive: true });
  mkdirSync(join(root, "contracts"), { recursive: true });
  writeFileSync(join(root, "nen/workflow.json"), JSON.stringify(workflow));
  copyFileSync(CONTRACT, join(root, "contracts/prose.lint.json"));
  writeFileSync(join(root, "contracts/prose.lint.baseline.json"), '{"findings":[]}\n');
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
  return root;
}

const row = (root: string): SchemaCheck | undefined => checkTaxonomy({ repoFlag: root }).checks.find((check): boolean => check.file.endsWith("#canon.lint"));
const DECLARED = { canon: { lint: { rules: "contracts/prose.lint.json", baseline: "contracts/prose.lint.baseline.json" } } };

describe("nen/workflow.json canon.lint (zheref/nen#481)", () => {
  it("reads rules, baseline and skillPaths; baseline and skillPaths are optional", () => {
    const w = parseWorkflow("<doc>", { canon: { lint: { rules: "contracts/prose.lint.json", baseline: "b.json", skillPaths: ["claude/skills/*/SKILL.md"] } } });
    expect(w.canon?.lint).toEqual({ rules: "contracts/prose.lint.json", baseline: "b.json", skillPaths: ["claude/skills/*/SKILL.md"] });
    expect(parseWorkflow("<doc>", { canon: { lint: { rules: "r.json" } } }).canon?.lint).toEqual({ rules: "r.json", baseline: null, skillPaths: null });
    expect(parseWorkflow("<doc>", {}).canon).toBeNull();
  });

  it("refuses a lint block with no rules, a climbing or absolute path, an empty skillPaths and a near-miss key", () => {
    expect(() => parseWorkflow("<doc>", { canon: { lint: {} } })).toThrow(/canon\.lint\.rules.*is required/);
    expect(() => parseWorkflow("<doc>", { canon: { lint: { rules: "../r.json" } } })).toThrow(/canon\.lint\.rules.*repository-relative/);
    expect(() => parseWorkflow("<doc>", { canon: { lint: { rules: "/etc/r.json" } } })).toThrow(/canon\.lint\.rules/);
    expect(() => parseWorkflow("<doc>", { canon: { lint: { rules: "r.json", baseline: "" } } })).toThrow(/canon\.lint\.baseline/);
    expect(() => parseWorkflow("<doc>", { canon: { lint: { rules: "r.json", skillPaths: [] } } })).toThrow(/canon\.lint\.skillPaths.*empty array/);
    expect(() => parseWorkflow("<doc>", { canon: { lint: { rule: "r.json" } } })).toThrow(/canon\.lint/);
  });
});

describe("the nen/workflow.json#canon.lint schema-check row", () => {
  it("appears only when the block is declared", () => {
    expect(row(repo({}))).toBeUndefined();
  });

  it("validates the rules contract as nen.prose-lint/v0.1 and the baseline's shape", () => {
    const check = row(repo(DECLARED));
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/rules contracts\/prose\.lint\.json \(nen\.prose-lint\/v0\.1\): 12 rules; baseline contracts\/prose\.lint\.baseline\.json: 0 rows/);
  });

  it("fails, required, on an invalid contract, an unknown $schema, a malformed or growing-key baseline and a never-baselined rule", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ "contracts/prose.lint.json": "{ nope" }, /prose\.lint\.json is not valid JSON/],
      [{ "contracts/prose.lint.json": JSON.stringify({ $schema: "other/v9", paths: { include: [] }, rules: [] }) }, /\$schema/],
      [{ "contracts/prose.lint.json": JSON.stringify({ paths: { include: [] }, rules: [{ id: "PL-01", class: "nonsense", severity: "fail" }] }) }, /unknown class/],
      [{ "contracts/prose.lint.baseline.json": JSON.stringify({ findings: [{ path: "a", rule: "PL-05", text: "x", count: 0 }] }) }, /malformed row/],
      [{ "contracts/prose.lint.baseline.json": JSON.stringify({ findings: [], extra: 1 }) }, /unknown top-level key "extra"/],
      [{ "contracts/prose.lint.baseline.json": JSON.stringify({ findings: [{ path: "a", rule: "PL-03", text: "x", count: 1 }] }) }, /PL-03 is never baselined/],
    ];
    for (const [files, needle] of cases) {
      const check = row(repo(DECLARED, files));
      expect(check?.ok, JSON.stringify(files)).toBe(false);
      expect(check?.required).toBe(true);
      expect(check?.detail).toMatch(needle);
    }
  });

  it("a declared file that is absent, outside the root or not UTF-8 is a FAIL, never a pass", () => {
    const absent = row(repo({ canon: { lint: { rules: "contracts/none.json" } } }));
    expect(absent?.ok).toBe(false);
    expect(absent?.detail).toMatch(/contracts\/none\.json: could not read \(ENOENT\)/);
    const root = repo(DECLARED);
    const outside = join(scratch, `outside-${n}.json`);
    writeFileSync(outside, '{"findings":[]}');
    rmSync(join(root, "contracts/prose.lint.baseline.json"));
    symlinkSync(outside, join(root, "contracts/prose.lint.baseline.json"));
    expect(row(root)?.detail).toMatch(/leaves the root/);
    const bytes = repo(DECLARED);
    writeFileSync(join(bytes, "contracts/prose.lint.baseline.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    expect(row(bytes)?.detail).toMatch(/not valid UTF-8/);
  });
});
