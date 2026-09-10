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

  it("names the canonical path in the not-found message, and no legacy path when there is none", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    const labels = checkTaxonomy({ repoFlag: root }).checks[0];
    expect(labels?.detail).toContain("'nen/labels.json'");
    expect(labels?.detail).not.toContain("schemas/labels.json");
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

  it("a CANONICAL read with no legacy copy has nothing to report", () => {
    const check = labelsCheck(migrated());
    expect(check.file).toBe("nen/labels.json");
    expect(check.ok).toBe(true);
    expect(check.legacy).toBe(false);
    expect(check.note).toBeNull();
    expect(checkTaxonomy({ repoFlag: migrated() }).deprecations).toEqual([]);
  });

  it("an UN-MIGRATED repository REFUSES exactly like an absent one, naming the migration", () => {
    // THE FALLBACK'S REPLACEMENT, PROVED AGAINST A REAL FIXTURE. Through
    // v0.4.0 this repository PASSED, every row read from `schemas/`. From
    // v0.5.0 a `schemas/`-only file is the same repository state as no file at
    // all: every required row FAILS, and the only thing that changed is that
    // the refusal names the way out.
    const root = LEGACY_REPO;
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(false);
    const check = report.checks[0];
    expect(check?.file).toBe("nen/labels.json");
    expect(check?.ok).toBe(false);
    expect(check?.required).toBe(true);
    expect(check?.detail).toContain("'nen/labels.json'");
    expect(check?.detail).toContain("'schemas/labels.json'");
    expect(check?.detail).toContain("nen scaffold init --accept-detected");
    expect(check?.detail).toContain("v0.5.0");
    // Detected, but not a note: the failing row's `detail` already names the
    // migration, so `note` (which feeds `deprecations`) stays empty rather
    // than repeating the same sentence a second way.
    expect(check?.legacy).toBe(true);
    expect(check?.note).toBeNull();
    expect(report.deprecations).toEqual([]);
  });

  it("a LEFTOVER schemas/ copy is a WARN, never a FAIL, since nen/ is the only file read", () => {
    // MUTATION GUARD FOR THE SIMPLIFICATION. Through v0.4.0 this exact setup
    // (different bytes on each side) FAILED the report -- now `nen/` is the
    // only file anything reads, so the leftover is clutter to delete, not a
    // correctness risk, and letting it fail the report again would be the
    // regression this test exists to catch.
    const root = migrated('{"labels":[]}');
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(true);
    const check = report.checks[0];
    expect(check?.ok).toBe(true);
    expect(check?.legacy).toBe(true);
    expect(check?.note).toContain("git rm schemas/labels.json");
    expect(check?.note).toContain("schemas/labels.json");
    expect(check?.note).toContain("nen/labels.json");
    expect(check?.note).toContain("v0.5.0");
    expect(report.deprecations.some((d): boolean => d.includes("nen/labels.json"))).toBe(true);
  });

  it("the leftover note fires even when the schemas/ copy itself cannot be opened", () => {
    // Detection is a STAT, never a READ: `nen schema check` no longer opens
    // the legacy file at all (nothing does, any more), so a `schemas/` entry
    // that is not even openable -- a directory in this case -- still counts as
    // a leftover to clean up.
    const root = migrated();
    mkdirSync(join(root, "schemas", "labels.json"), { recursive: true });
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(true);
    const check = report.checks[0];
    expect(check?.ok).toBe(true);
    expect(check?.legacy).toBe(true);
    expect(check?.note).toContain("schemas/labels.json");
  });

  it.skipIf(process.platform === "win32")(
    "the leftover note does NOT fire when the canonical file itself is broken",
    () => {
      // THE CASE THAT MADE THIS A FINDING, CARRIED FORWARD. Advising "delete
      // the leftover" rests entirely on `nen/labels.json` being the working
      // copy -- which is exactly what is NOT true here, so the note stays
      // silent and the row's own FAIL (by real errno) is the only thing said.
      const root = migrated('{"labels":[]}');
      rmSync(join(root, "nen", "labels.json"));
      symlinkSync("labels.json", join(root, "nen", "labels.json"));
      const report = checkTaxonomy({ repoFlag: root });
      expect(report.ok).toBe(false);
      const check = report.checks[0];
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain("ELOOP");
      expect(check?.legacy).toBe(true);
      expect(check?.note).toBeNull();
      expect(report.deprecations).toEqual([]);
    },
  );

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
