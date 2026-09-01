import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { checkTaxonomy, openTaxonomy, type SchemaCheck } from "./taxonomy.js";

describe("openTaxonomy", () => {
  it("resolves the root from --repo and reads that repository's files", () => {
    const taxonomy = openTaxonomy({ cwd: process.cwd(), repoFlag: BANKAI_REPO });
    expect(taxonomy.root).toBe(BANKAI_REPO);
    expect(taxonomy.labels().has("bankai:epic")).toBe(true);
    expect(taxonomy.repos().byCode("KP")?.repo).toBe("zheref/KroApple");
    expect(taxonomy.colors().category("status")).toBeDefined();
    expect(taxonomy.gates().reviewer("sasuke")).toBeDefined();
  });

  it("reads an entirely different vocabulary from a different root", () => {
    const taxonomy = openTaxonomy({ repoFlag: ALT_REPO });
    expect(taxonomy.labels().has("akatsuki:migration")).toBe(true);
    expect(taxonomy.labels().has("bankai:epic")).toBe(false);
    expect(taxonomy.gates().reviewer("itachi")).toBeDefined();
  });

  it("is lazy per file: a broken colours file does not break a labels read", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    mkdirSync(join(root, "schemas"));
    writeFileSync(
      join(root, "schemas", "labels.json"),
      JSON.stringify({ labels: [{ name: "x:y/z", color: "aabbcc", description: "d" }] }),
    );
    writeFileSync(join(root, "schemas", "colors.yml"), "categories: [not, a, map]\n");

    const taxonomy = openTaxonomy({ repoFlag: root });
    expect(taxonomy.labels().names()).toEqual(["x:y/z"]);
    expect(() => taxonomy.colors()).toThrow();
  });

  it("caches a failure as well as a success, so a message cannot depend on call count", () => {
    const taxonomy = openTaxonomy({ repoFlag: BANKAI_REPO });
    expect(taxonomy.labels()).toBe(taxonomy.labels());

    const empty = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    const broken = openTaxonomy({ repoFlag: empty });
    let first: unknown;
    let second: unknown;
    try {
      broken.labels();
    } catch (error) {
      first = error;
    }
    try {
      broken.labels();
    } catch (error) {
      second = error;
    }
    expect(first).toBe(second);
  });

  it("refuses a root that does not exist before it reads anything", () => {
    expect(() => openTaxonomy({ repoFlag: join(tmpdir(), "nen-does-not-exist-xyz") })).toThrow(
      /does not exist/,
    );
  });
});

describe("checkTaxonomy", () => {
  it("reports every file's verdict rather than stopping at the first failure", () => {
    const report = checkTaxonomy({ repoFlag: BANKAI_REPO });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c): string => c.file)).toEqual([
      "schemas/labels.json",
      "schemas/repos.json",
      "schemas/colors.yml",
      "schemas/gates.json",
    ]);
    expect(report.checks.every((c): boolean => c.ok)).toBe(true);
    expect(report.checks[0]?.detail).toMatch(/\d+ labels/);
  });

  it("fails overall when a REQUIRED file is unreadable, and names every problem at once", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c): boolean => !c.ok).length).toBe(4);
    for (const check of report.checks) {
      expect(check.detail).toMatch(/no such file/);
      expect(check.path).toContain(root);
    }
  });

  // A root carrying the three required files and whatever gates.json the caller
  // writes (or none).
  function repoWithThreeFiles(gates?: string): string {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    mkdirSync(join(root, "schemas"), { recursive: true });
    // Copy the fixture's own three files rather than re-authoring them, so these
    // cases cannot drift from what the loaders are actually proved against.
    for (const file of ["labels.json", "repos.json", "colors.yml"]) {
      copyFileSync(join(BANKAI_REPO, "schemas", file), join(root, "schemas", file));
    }
    if (gates !== undefined) writeFileSync(join(root, "schemas", "gates.json"), gates);
    return root;
  }

  function gatesCheck(root: string): SchemaCheck | undefined {
    return checkTaxonomy({ repoFlag: root }).checks.find(
      (c): boolean => c.file === "schemas/gates.json",
    );
  }

  it("does not fail overall for a missing gates.json, which only the gate verbs need", () => {
    const root = repoWithThreeFiles();
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(true);
    const gates = gatesCheck(root);
    expect(gates?.ok).toBe(false);
    expect(gates?.required).toBe(false);
    expect(gates?.detail).toMatch(/no such file/);
  });

  it("DOES fail for a gates.json that is present and INVALID", () => {
    // ABSENT and CORRUPT are not the same finding, and treating them alike was a
    // real hole: `required: false` was applied to every way the file could fail,
    // so a gates.json with a malformed pattern, a missing login_pattern or an
    // approver naming an undeclared reviewer reported `warn` and let the whole
    // report pass. A file that IS there and is WRONG is a defect in this
    // repository's taxonomy; only its absence is the tolerable state.
    const invalid = [
      // valid JSON, invalid schema: a reviewer with no login pattern
      ['{"version":1,"reviewers":[{"name":"a"}],"delivery":{}}', /login_pattern/],
      // an approver naming a reviewer that is not declared
      [
        '{"version":1,"reviewers":[{"name":"a","login_pattern":{"pattern":"a","ignoreCase":true}}],"default_approvers":["ghost"],"base_reviewers":["a"],"delivery":{"author_pattern":{"pattern":"b","ignoreCase":true},"head_ref_prefixes":["x/"]}}',
        /not declared/,
      ],
      // an unparseable pattern, which would otherwise match nothing and silently
      // excuse a reviewer from every round
      [
        '{"version":1,"reviewers":[{"name":"a","login_pattern":{"pattern":"a(","ignoreCase":true}}],"default_approvers":["a"],"base_reviewers":["a"],"delivery":{"author_pattern":{"pattern":"b","ignoreCase":true},"head_ref_prefixes":["x/"]}}',
        /valid regular expression/,
      ],
      // not JSON at all
      ["{ not json", /not valid JSON/],
    ] as const;

    for (const [body, message] of invalid) {
      const root = repoWithThreeFiles(body);
      const report = checkTaxonomy({ repoFlag: root });
      const gates = gatesCheck(root);
      expect(gates?.ok, body).toBe(false);
      expect(gates?.required, body).toBe(true);
      expect(gates?.detail, body).toMatch(message);
      expect(report.ok, body).toBe(false);
    }
  });

  it("passes overall for a gates.json that is present and VALID", () => {
    const root = repoWithThreeFiles(
      readFileSync(join(BANKAI_REPO, "schemas", "gates.json"), "utf8"),
    );
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(true);
    expect(gatesCheck(root)?.ok).toBe(true);
  });
});
