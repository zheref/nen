import { describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALT_REPO, BANKAI_REPO, LEGACY_REPO } from "./fixtures/paths.js";
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
    mkdirSync(join(root, "nen"));
    writeFileSync(
      join(root, "nen", "labels.json"),
      JSON.stringify({ labels: [{ name: "x:y/z", color: "aabbcc", description: "d" }] }),
    );
    writeFileSync(join(root, "nen", "colors.yml"), "categories: [not, a, map]\n");

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
      "nen/labels.json",
      "nen/repos.json",
      "nen/colors.yml",
      "nen/gates.json",
      "nen/contract.json",
      "nen/workflow.json",
    ]);
    expect(report.checks.every((c): boolean => c.ok)).toBe(true);
    expect(report.checks[0]?.detail).toMatch(/\d+ labels/);
  });

  it("fails overall when a REQUIRED file is unreadable, and names every problem at once", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(false);
    // Four, not six: the optional contract and the optional policy are the two
    // rows whose ABSENCE is a pass rather than a finding -- and they say two
    // different things about it, which is the point of having two sentences.
    expect(report.checks.filter((c): boolean => !c.ok).length).toBe(4);
    const optional = ["nen/contract.json", "nen/workflow.json"];
    for (const check of report.checks.filter((c): boolean => !optional.includes(c.file))) {
      expect(check.detail).toMatch(/no such file/);
      expect(check.path).toContain(root);
    }
    const contract = report.checks.find((c): boolean => c.file === "nen/contract.json");
    expect(contract?.ok).toBe(true);
    expect(contract?.detail).toBe("absent (optional)");
    const workflow = report.checks.find((c): boolean => c.file === "nen/workflow.json");
    expect(workflow?.ok).toBe(true);
    expect(workflow?.required).toBe(false);
    // "defaults apply", NOT "optional": an absent policy is a full policy made
    // of defaults, and an absent contract is nothing to read at all.
    expect(workflow?.detail).toBe("absent (defaults apply)");
    expect(workflow?.path).toBe(join(root, "nen", "workflow.json"));
  });

  it("names BOTH locations in the not-found message, so a caller knows the fallback exists", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    const labels = checkTaxonomy({ repoFlag: root }).checks[0];
    expect(labels?.detail).toContain("'nen/labels.json'");
    expect(labels?.detail).toContain("'schemas/labels.json'");
    // …and the path it names as the one to CREATE is the canonical one.
    expect(labels?.path).toBe(join(root, "nen", "labels.json"));
  });

  // A root carrying the three required files and whatever gates.json the caller
  // writes (or none).
  function repoWithThreeFiles(gates?: string): string {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    // Copy the fixture's own three files rather than re-authoring them, so these
    // cases cannot drift from what the loaders are actually proved against.
    for (const file of ["labels.json", "repos.json", "colors.yml"]) {
      copyFileSync(join(BANKAI_REPO, "nen", file), join(root, "nen", file));
    }
    if (gates !== undefined) writeFileSync(join(root, "nen", "gates.json"), gates);
    return root;
  }

  function gatesCheck(root: string): SchemaCheck | undefined {
    return checkTaxonomy({ repoFlag: root }).checks.find(
      (c): boolean => c.file === "nen/gates.json",
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
      readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8"),
    );
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(true);
    expect(gatesCheck(root)?.ok).toBe(true);
  });
});

describe("checkTaxonomy and the schemas/ migration", () => {
  function labelsCheck(root: string): SchemaCheck {
    const check = checkTaxonomy({ repoFlag: root }).checks[0];
    if (check === undefined) throw new Error("no labels row");
    return check;
  }

  // A migrated repository, plus whatever legacy copy the case wants.
  function migrated(legacyLabels?: string): string {
    const root = mkdtempSync(join(tmpdir(), "nen-migration-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    for (const file of ["labels.json", "repos.json", "colors.yml"]) {
      copyFileSync(join(BANKAI_REPO, "nen", file), join(root, "nen", file));
    }
    if (legacyLabels !== undefined) {
      mkdirSync(join(root, "schemas"), { recursive: true });
      writeFileSync(join(root, "schemas", "labels.json"), legacyLabels);
    }
    return root;
  }

  it("a CANONICAL read says so and has nothing to report", () => {
    const check = labelsCheck(migrated());
    expect(check.location).toBe("nen");
    expect(check.file).toBe("nen/labels.json");
    expect(check.ok).toBe(true);
    expect(check.note).toBeNull();
    expect(check.shadowed).toBe(false);
    expect(checkTaxonomy({ repoFlag: migrated() }).deprecations).toEqual([]);
  });

  it("a LEGACY read loads, names the canonical path, and dates the removal", () => {
    const root = LEGACY_REPO;
    const report = checkTaxonomy({ repoFlag: root });
    // It still PASSES -- the whole point of the fallback is that an
    // un-migrated repository keeps working through the v0.4 line.
    expect(report.ok).toBe(true);
    const check = report.checks[0];
    expect(check?.location).toBe("schemas");
    expect(check?.file).toBe("schemas/labels.json");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toMatch(/\d+ labels/);
    expect(check?.note).toContain("nen/labels.json");
    expect(check?.note).toContain("v0.5.0");
    expect(check?.shadowed).toBe(false);
    // Every one of the four legacy reads is named in `deprecations`, so a
    // machine reader sees the migration state without parsing prose.
    expect(report.deprecations.length).toBe(4);
    expect(report.deprecations[0]).toContain("schemas/labels.json");
  });

  it("a SHADOWED leftover with different bytes FAILS the report, naming both paths", () => {
    // MUTATION GUARD. Drop the shadow finding, or let it pass as a warning,
    // and this goes green-to-red: the repository has two answers, nen picked
    // one silently, and nothing else on screen would say so.
    const root = migrated('{"labels":[]}');
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(false);
    const check = report.checks[0];
    expect(check?.shadowed).toBe(true);
    // The file still LOADED, from the canonical location.
    expect(check?.ok).toBe(true);
    expect(check?.location).toBe("nen");
    expect(check?.note).toContain("SHADOWED LEFTOVER");
    expect(check?.note).toContain("schemas/labels.json");
    expect(check?.note).toContain("nen/labels.json");
    expect(report.deprecations.some((d): boolean => d.includes("SHADOWED"))).toBe(true);
  });

  it("an UNCOMPARABLE pair fails the report WITHOUT claiming the bytes differ", () => {
    // The state the shadow check used to describe as `different`, which made
    // the row assert three things nobody had checked. It still FAILS -- "we
    // could not prove they agree" is the fail-closed reading either way -- but
    // the sentence it fails with is now true.
    const root = migrated();
    mkdirSync(join(root, "schemas", "labels.json"), { recursive: true });
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(false);
    const check = report.checks[0];
    expect(check?.shadow).toBe("unknown");
    expect(check?.shadowed).toBe(true);
    // The canonical file loaded fine; it is the comparison that could not run.
    expect(check?.ok).toBe(true);
    expect(check?.location).toBe("nen");
    expect(check?.note).toContain("UNVERIFIED LEFTOVER");
    // The errno is NAMED, which is what makes the row actionable at all.
    expect(check?.note).toContain("EISDIR");
    expect(check?.note).not.toContain("bytes DIFFER");
    expect(check?.note).not.toContain("SHADOWED LEFTOVER");
    expect(report.deprecations.some((d): boolean => d.includes("UNVERIFIED"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does NOT tell an operator to delete the legacy copy when the nen/ one is the broken one",
    () => {
      // THE CASE THAT MADE THIS A FINDING. With the canonical copy unreadable,
      // the old sentence said the bytes DIFFER, that nen read 'nen/labels.json'
      // (it did not), and that the legacy copy should be deleted -- which is
      // the only file the repository has left that works.
      const root = migrated('{"labels":[]}');
      rmSync(join(root, "nen", "labels.json"));
      symlinkSync("labels.json", join(root, "nen", "labels.json"));
      const check = checkTaxonomy({ repoFlag: root }).checks[0];
      expect(check?.shadow).toBe("unknown");
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain("ELOOP");
      expect(check?.note).toContain("UNVERIFIED LEFTOVER");
      expect(check?.note).toContain("ELOOP");
      expect(check?.note).not.toMatch(/Delete it/);
      expect(check?.note).not.toContain("Nen read 'nen/labels.json'");
    },
  );

  it("a SHADOWED leftover with IDENTICAL bytes is ok, with a note", () => {
    const root = migrated(readFileSync(join(BANKAI_REPO, "nen", "labels.json"), "utf8"));
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(true);
    const check = report.checks[0];
    expect(check?.ok).toBe(true);
    expect(check?.shadowed).toBe(false);
    expect(check?.location).toBe("nen");
    expect(check?.note).toContain("identical copy");
    expect(check?.note).toContain("schemas/labels.json");
  });

  /** One row by NAME. Position stopped being an identity when a sixth row landed. */
  function rowFor(root: string, file: string): SchemaCheck | undefined {
    return checkTaxonomy({ repoFlag: root }).checks.find((c): boolean => c.file === file);
  }

  it("reports the contract row: absent is ok, present is validated, broken FAILS", () => {
    const absent = rowFor(migrated(), "nen/contract.json");
    expect(absent?.file).toBe("nen/contract.json");
    expect(absent?.ok).toBe(true);
    expect(absent?.required).toBe(false);
    expect(absent?.detail).toBe("absent (optional)");

    const present = rowFor(BANKAI_REPO, "nen/contract.json");
    expect(present?.ok).toBe(true);
    expect(present?.detail).toContain("dependency (nen >= 0.3, pinned v0.3.0)");
    expect(present?.detail).toContain("project (2 lanes: web, android");

    // ALT_REPO carries the dependency-only shape, and the row says only that.
    const alt = rowFor(ALT_REPO, "nen/contract.json");
    expect(alt?.ok).toBe(true);
    expect(alt?.detail).toContain("dependency (nen >= 0.1, pinned v0.1.0)");
    expect(alt?.detail).not.toContain("project (");

    // Present and WRONG fails, exactly like a present-and-wrong gates.json --
    // "optional" is about absence, never about being malformed.
    const broken = migrated();
    writeFileSync(join(broken, "nen", "contract.json"), '{"dependency":{"minimum":"0.3"}}');
    const report = checkTaxonomy({ repoFlag: broken });
    expect(report.ok).toBe(false);
    const row = report.checks.find((c): boolean => c.file === "nen/contract.json");
    expect(row?.ok).toBe(false);
    expect(row?.required).toBe(true);
    expect(row?.detail).toMatch(/pinned_ref/);
  });

  it("reports the policy row: absent applies defaults, present names the ladder, broken FAILS", () => {
    const root = migrated();
    const absent = rowFor(root, "nen/workflow.json");
    expect(absent?.ok).toBe(true);
    expect(absent?.required).toBe(false);
    expect(absent?.detail).toBe("absent (defaults apply)");

    // A file that IS there is summarised by what it decides -- the ladder, the
    // branch template and the trunk -- because those are the three a reader
    // checks a repository's policy against.
    writeFileSync(
      join(root, "nen", "workflow.json"),
      JSON.stringify({ coverage: { minimum: 70, recommended: 75, ideal: 95 } }),
    );
    const present = rowFor(root, "nen/workflow.json");
    expect(present?.ok).toBe(true);
    expect(present?.detail).toContain("coverage 70/75/95 (touched)");
    expect(present?.detail).toContain("branch '{model}/{persona}/{descriptor}' off 'main'");

    // Present and WRONG fails by POINTER, exactly like a present-and-wrong
    // contract -- "optional" is about absence, never about being malformed.
    writeFileSync(
      join(root, "nen", "workflow.json"),
      JSON.stringify({ coverage: { minimum: 95, ideal: 80 } }),
    );
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(false);
    const row = report.checks.find((c): boolean => c.file === "nen/workflow.json");
    expect(row?.ok).toBe(false);
    expect(row?.required).toBe(true);
    expect(row?.detail).toMatch(/at coverage, states a ladder that does not ascend/);
  });
});
