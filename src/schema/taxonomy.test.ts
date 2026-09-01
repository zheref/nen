import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { checkTaxonomy, openTaxonomy } from "./taxonomy.js";

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

  it("does not fail overall for a missing gates.json, which only the gate verbs need", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    mkdirSync(join(root, "schemas"), { recursive: true });
    // Copy the fixture's own three files rather than re-authoring them, so this
    // case cannot drift from what the loaders are actually proved against.
    for (const file of ["labels.json", "repos.json", "colors.yml"]) {
      copyFileSync(join(BANKAI_REPO, "schemas", file), join(root, "schemas", file));
    }
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(true);
    const gates = report.checks.find((c): boolean => c.file === "schemas/gates.json");
    expect(gates?.ok).toBe(false);
    expect(gates?.required).toBe(false);
  });
});
