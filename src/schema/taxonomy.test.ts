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
      // The two POINTER rows (zheref/nen#220) sit immediately under the policy
      // row they read out of, and name a pointer rather than a second file --
      // the `#` is what tells a machine reader which rows are which.
      "nen/workflow.json#reports.sections",
      "nen/workflow.json#review.scopes",
      "nen/workflow.json#profile",
      "nen/workflow.json#runners",
      "nen/workflow.json#deploy.defaultTarget",
      "nen/workflow.json#release",
      "nen/decisions.json",
    ]);
    expect(report.checks.every((c): boolean => c.ok)).toBe(true);
    expect(report.checks[0]?.detail).toMatch(/\d+ labels/);
  });

  it("fails overall when a REQUIRED file is unreadable, and names every problem at once", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-"));
    const report = checkTaxonomy({ repoFlag: root });
    expect(report.ok).toBe(false);
    // Three, not seven: the optional contract, the optional policy, the
    // optional colour vocabulary (v0.11.0, zheref/nen#216) and the optional
    // decision matrix are the rows whose ABSENCE is a pass rather than a
    // finding -- and each says a different thing about it, which is the point
    // of having four sentences.
    expect(report.checks.filter((c): boolean => !c.ok).length).toBe(3);
    const optional = [
      "nen/contract.json",
      "nen/workflow.json",
      "nen/workflow.json#reports.sections",
      "nen/workflow.json#review.scopes",
      "nen/workflow.json#profile",
      "nen/workflow.json#runners",
      "nen/workflow.json#deploy.defaultTarget",
      "nen/workflow.json#release",
      "nen/colors.yml",
      "nen/decisions.json",
    ];
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

  it("validates checks.excluded (zheref/nen#249): counts a valid one, fails a malformed one", () => {
    const fixture = JSON.parse(readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>;
    const ruling = { name: "check (Windows, x)", reason: "no runner", ruled: "2026-09-22", until: { condition: "a runner exists" } };
    const valid = repoWithThreeFiles(JSON.stringify({ ...fixture, checks: { excluded: [ruling] } }));
    expect(gatesCheck(valid)?.ok).toBe(true);
    expect(gatesCheck(valid)?.detail).toMatch(/, 1 declared check exclusion$/);
    const malformed = repoWithThreeFiles(
      JSON.stringify({ ...fixture, checks: { excluded: [{ ...ruling, ruled: "yesterday" }] } }),
    );
    expect(gatesCheck(malformed)?.ok).toBe(false);
    expect(gatesCheck(malformed)?.detail).toMatch(/checks\.excluded\[0\]\.ruled/);
    expect(checkTaxonomy({ repoFlag: malformed }).ok).toBe(false);
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
    expect(check?.note).toContain("git rm -r schemas/labels.json");
    expect(check?.note).toContain("rm -r schemas/labels.json if it was never committed");
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

// ── nen/workflow.json#deploy.defaultTarget (zheref/nen#300) ─────────────────

describe("checkTaxonomy and deploy.defaultTarget -- the pointer row that reads two files", () => {
  const ROW = "nen/workflow.json#deploy.defaultTarget";

  /** The three required files, plus whatever policy and contract a case writes. */
  function repo(files: { workflow?: unknown; contract?: unknown | string } = {}): string {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-deploy-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    for (const file of ["labels.json", "repos.json", "colors.yml"]) {
      copyFileSync(join(BANKAI_REPO, "nen", file), join(root, "nen", file));
    }
    if (files.workflow !== undefined) {
      writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify(files.workflow));
    }
    if (files.contract !== undefined) {
      writeFileSync(
        join(root, "nen", "contract.json"),
        typeof files.contract === "string" ? files.contract : JSON.stringify(files.contract),
      );
    }
    return root;
  }

  /** A contract whose project declares exactly these destinations. */
  function declaring(targets: Readonly<Record<string, unknown>>): unknown {
    return {
      $schema: "nen.contract/v0.1",
      project: {
        lanes: { only: { stack: "placeholder-stack", cwd: "." } },
        defaultLane: "only",
        verbs: { only: { build: { exe: "placeholder-tool", argv: ["go"] } } },
        targets,
      },
    };
  }

  function rowOf(root: string): { report: ReturnType<typeof checkTaxonomy>; row: SchemaCheck | undefined } {
    const report = checkTaxonomy({ repoFlag: root });
    return { report, row: report.checks.find((c): boolean => c.file === ROW) };
  }

  it("sits immediately under the runners row, and reads ok when no policy file exists", () => {
    const { report, row } = rowOf(repo());
    const files = report.checks.map((c): string => c.file);
    expect(files.indexOf(ROW)).toBe(files.indexOf("nen/workflow.json#runners") + 1);
    expect(row?.ok).toBe(true);
    expect(row?.required).toBe(false);
    expect(row?.detail).toBe("none declared (no policy file)");
  });

  it("reads ok when the policy states no name -- absent key or explicit null", () => {
    for (const workflow of [{}, { deploy: {} }, { deploy: { defaultTarget: null } }]) {
      const { report, row } = rowOf(repo({ workflow }));
      expect(row?.ok, JSON.stringify(workflow)).toBe(true);
      expect(row?.detail, JSON.stringify(workflow)).toMatch(/^none declared/);
      expect(report.ok, JSON.stringify(workflow)).toBe(true);
    }
  });

  it("passes a name that IS a key of project.targets marked nonProduction, and says so", () => {
    const { report, row } = rowOf(
      repo({
        workflow: { deploy: { defaultTarget: "testflight" } },
        contract: declaring({ testflight: { nonProduction: true }, staging: {} }),
      }),
    );
    expect(row?.ok).toBe(true);
    expect(row?.detail).toBe("'testflight' (a nonProduction key of nen/contract.json → project.targets)");
    expect(report.ok).toBe(true);
  });

  it("FAILS a declared target that is NOT marked nonProduction -- absent or false (Feitan F2)", () => {
    for (const production of [{ why: "the internal beta channel -- non-production" }, { nonProduction: false }]) {
      const { report, row } = rowOf(
        repo({ workflow: { deploy: { defaultTarget: "live" } }, contract: declaring({ live: production }) }),
      );
      expect(row?.ok, JSON.stringify(production)).toBe(false);
      expect(row?.required, JSON.stringify(production)).toBe(true);
      expect(report.ok, JSON.stringify(production)).toBe(false);
      expect(row?.detail).toMatch(/at deploy\.defaultTarget, names 'live', which nen\/contract\.json declares without "nonProduction": true/);
      expect(row?.detail).toContain("a default deploy destination must be declared nonProduction");
    }
  });

  it("WARNS, not fails, on a marked target with no command line (unsupported)", () => {
    const { report, row } = rowOf(
      repo({
        workflow: { deploy: { defaultTarget: "preview" } },
        contract: declaring({ preview: { nonProduction: true, unsupported: "the host's git integration deploys it" } }),
      }),
    );
    expect(row?.ok).toBe(false);
    expect(row?.required).toBe(false);
    expect(report.ok).toBe(true);
    expect(row?.detail).toMatch(/'preview' is a declared nonProduction target with no command line \(unsupported\)/);
  });

  it("never prints a name raw -- ESC, CR and an RLO override are escaped, in the default AND the declared keys", () => {
    const hostile = "test\u001b[2J\rflight\u202e";
    const { row } = rowOf(
      repo({ workflow: { deploy: { defaultTarget: hostile } }, contract: declaring({ [`staging\u001b[31m`]: {} }) }),
    );
    expect(row?.ok).toBe(false);
    for (const raw of ["\u001b", "\r", "\u202e"]) expect(row?.detail).not.toContain(raw);
    expect(row?.detail).toContain('names "test\\u001b[2J\\rflight\\u202e"');
    expect(row?.detail).toContain('declares project.targets: "staging\\u001b[31m"');
  });

  it("FAILS a DANGLING name by pointer, listing what IS declared and naming a one-edit neighbour", () => {
    const { report, row } = rowOf(
      repo({ workflow: { deploy: { defaultTarget: "testflght" } }, contract: declaring({ testflight: {}, staging: {} }) }),
    );
    expect(row?.ok).toBe(false);
    expect(row?.required).toBe(true);
    expect(report.ok).toBe(false);
    expect(row?.detail).toMatch(/workflow\.json: at deploy\.defaultTarget, names 'testflght', which is not a key of project\.targets/);
    expect(row?.detail).toContain("nen/contract.json declares project.targets: 'staging', 'testflight'.");
    expect(row?.detail).toContain("It is one edit from 'testflight'.");
    // The POLICY row itself loaded: the dangling name is a cross-file fact, and
    // this row is the one that says it.
    expect(report.checks.find((c): boolean => c.file === "nen/workflow.json")?.ok).toBe(true);
  });

  it("FAILS a name when the contract declares no targets -- or is absent altogether", () => {
    const empty = rowOf(repo({ workflow: { deploy: { defaultTarget: "testflight" } }, contract: declaring({}) }));
    expect(empty.row?.ok).toBe(false);
    expect(empty.row?.required).toBe(true);
    expect(empty.row?.detail).toContain("nen/contract.json declares no project.targets at all.");
    expect(empty.row?.detail).not.toContain("one edit from");

    const absent = rowOf(repo({ workflow: { deploy: { defaultTarget: "testflight" } } }));
    expect(absent.row?.ok).toBe(false);
    expect(absent.row?.required).toBe(true);
    expect(absent.report.ok).toBe(false);
    expect(absent.row?.detail).toContain("nen/contract.json declares no project.targets at all.");
  });

  it("FAILS a NON-STRING name by pointer on the policy row, and does not repeat it", () => {
    const { report, row } = rowOf(
      repo({ workflow: { deploy: { defaultTarget: 7 } }, contract: declaring({ testflight: {} }) }),
    );
    expect(report.ok).toBe(false);
    const policy = report.checks.find((c): boolean => c.file === "nen/workflow.json");
    expect(policy?.ok).toBe(false);
    expect(policy?.required).toBe(true);
    expect(policy?.detail).toMatch(/at deploy\.defaultTarget, expected a non-empty string, got/);
    expect(row?.ok).toBe(true);
    expect(row?.detail).toMatch(/^not read -- nen\/workflow\.json did not load; see that row/);
  });

  it("FAILS a NEAR-MISS key by pointer on the policy row", () => {
    const { report } = rowOf(
      repo({ workflow: { deploy: { defaultTaget: "testflight" } }, contract: declaring({ testflight: {} }) }),
    );
    expect(report.ok).toBe(false);
    const policy = report.checks.find((c): boolean => c.file === "nen/workflow.json");
    expect(policy?.ok).toBe(false);
    expect(policy?.detail).toMatch(/at deploy\.defaultTaget, is one letter away from 'defaultTarget'/);
  });

  it("does not pass a name it could not check against a contract that did not load", () => {
    const { report, row } = rowOf(
      repo({ workflow: { deploy: { defaultTarget: "testflight" } }, contract: "{ not json" }),
    );
    expect(report.ok).toBe(false);
    expect(row?.ok).toBe(false);
    // The contract row already fails the report and names the cause; this row
    // says it could not check, rather than failing twice in two voices.
    expect(row?.required).toBe(false);
    expect(row?.detail).toMatch(/^not checked -- names 'testflight', but nen\/contract\.json did not load/);
  });
});

describe("nen/workflow.json#release row (zheref/nen#348)", () => {
  function reportFor(workflow?: unknown): ReturnType<typeof checkTaxonomy> {
    const root = mkdtempSync(join(tmpdir(), "nen-taxonomy-release-"));
    if (workflow !== undefined) {
      mkdirSync(join(root, "nen"));
      writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify(workflow));
    }
    return checkTaxonomy({ repoFlag: root });
  }

  it("reports the declared exact, pattern, keyed, line-bound and deletion-only entries", () => {
    const report = reportFor({ release: { unitPaths: ["=CHANGELOG.md", "releases/**", { path: "package.json", keys: ["version"] }, { path: "src/version.ts", lines: ["^VERSION=[0-9]+$"] }, { path: "changelog.d/", deleteOnly: true }] } });
    const row = report.checks.find((check): boolean => check.file === "nen/workflow.json#release");
    expect(row).toMatchObject({ ok: true, required: false });
    expect(row?.detail).toBe("5 entry(s): 1 exact path(s), 1 prefix/glob(s), 1 key-bound, 1 line-bound, 1 deletion-only");
  });

  it("distinguishes no policy, an undeclared unit and an unreadable policy", () => {
    expect(reportFor().checks.find((check): boolean => check.file === "nen/workflow.json#release")?.detail).toBe("none declared (no policy file)");
    expect(reportFor({}).checks.find((check): boolean => check.file === "nen/workflow.json#release")?.detail).toContain("undeclared unit");
    const report = reportFor({ release: { unitPaths: [{ path: "file", lines: ["["] }] } });
    expect(report.checks.find((check): boolean => check.file === "nen/workflow.json")).toMatchObject({ ok: false, detail: expect.stringContaining("release.unitPaths[0].lines[0]") });
    expect(report.checks.find((check): boolean => check.file === "nen/workflow.json#release")?.detail).toContain("not read -- nen/workflow.json did not load");
  });
});
