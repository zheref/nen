// src/schema/workflow.test.ts -- the policy loader, held to the two properties
// it exists for: an absent file is a full policy, and a present-and-wrong one
// is refused by pointer rather than defaulted around.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaError } from "./errors.js";
import {
  ATTRIBUTION_TRAILERS,
  DEFAULT_BASE,
  DEFAULT_BRANCH_TEMPLATE,
  WORKFLOW_FILE,
  defaultWorkflow,
  describeWorkflow,
  loadWorkflow,
  parseWorkflow,
  refusedTrailerKeys,
  trailerRefusal,
} from "./workflow.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "nen-workflow-"));
}

/** A root carrying the given policy document, written verbatim. */
function repoWith(body: unknown): string {
  const root = tempRoot();
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(
    join(root, "nen", "workflow.json"),
    typeof body === "string" ? body : JSON.stringify(body),
  );
  return root;
}

/** The SchemaError a malformed document produces, for pointer assertions. */
function refusal(body: unknown): SchemaError {
  try {
    loadWorkflow(repoWith(body));
  } catch (error) {
    if (error instanceof SchemaError) return error;
    throw error;
  }
  throw new Error("expected a SchemaError, got a successful load");
}

describe("loadWorkflow -- an absent file is a POLICY, not an error", () => {
  it("answers present:false with every default, and names the path to create", () => {
    const root = tempRoot();
    const loaded = loadWorkflow(root);
    expect(loaded.present).toBe(false);
    expect(loaded.path).toBe(join(root, "nen", "workflow.json"));
    expect(loaded.raw).toEqual({});
    expect(loaded.workflow).toEqual(defaultWorkflow());
  });

  it("states the whole §3 default set, so a reader can check one number at a time", () => {
    const { workflow } = loadWorkflow(tempRoot());
    expect(workflow.branch).toMatchObject({ template: DEFAULT_BRANCH_TEMPLATE, base: DEFAULT_BASE });
    expect(workflow.iteration.checks).toEqual(["build"]);
    expect(workflow.iteration.lane).toBeNull();
    expect(workflow.tests).toMatchObject({ required: ["test"], extra: [] });
    expect(workflow.coverage).toMatchObject({
      minimum: 80,
      recommended: 85,
      ideal: 90,
      scope: "touched",
    });
    expect(workflow.launch).toMatchObject({ default: null, fallback: null });
    expect(workflow.reports).toMatchObject({
      dir: "Reports",
      retain: "final-only",
      template: "rikugan",
      captures: "Reports/captures",
    });
    expect(workflow.notifications).toMatchObject({ rungs: ["push", "os", "sound"], sound: "Glass" });
    expect(workflow.commits).toMatchObject({
      allowedAttributionTrailers: [],
      forbiddenTrailers: [],
    });
    expect(workflow.monitor).toMatchObject({ maxCycles: 20, pollSeconds: 300 });
  });

  it("invents NO name: models, launch.default and iteration.lane come back empty", () => {
    // The line this loader draws: a default for a SHAPE is a number nobody
    // owns; a default for a NAME would be nen deciding somebody's vocabulary.
    const { workflow } = loadWorkflow(tempRoot());
    expect(workflow.models).toEqual({ rule: null, surfaces: {}, roles: {}, raw: {} });
    expect(workflow.launch.default).toBeNull();
    expect(workflow.iteration.lane).toBeNull();
  });

  it("reads a stray FILE named 'nen' as an absence, exactly as ./source.ts's probe does", () => {
    // A path component that is a file can never hold anything, so this is the
    // same answer a repository with no `nen` entry at all gets. Deciding it
    // from the READ's errno instead made it an UNREADABLE policy -- a much
    // louder thing, and a false one.
    const root = tempRoot();
    writeFileSync(join(root, "nen"), "not a directory\n");
    expect(loadWorkflow(root).present).toBe(false);
  });

  it("does NOT read an unreadable file as an absence", () => {
    // A dangling symlink is present to the probe and fails the read; answering
    // "defaults apply" would run the loop under parameters nobody chose.
    const root = tempRoot();
    mkdirSync(join(root, "nen"), { recursive: true });
    symlinkSync(join(root, "nen", "nothing-here.json"), join(root, "nen", "workflow.json"));
    expect((): unknown => loadWorkflow(root)).toThrow(SchemaError);
  });
});

describe("loadWorkflow -- a present file", () => {
  it("reads a partial document and defaults everything it does not state", () => {
    const loaded = loadWorkflow(repoWith({ coverage: { minimum: 70 } }));
    expect(loaded.present).toBe(true);
    expect(loaded.workflow.coverage.minimum).toBe(70);
    expect(loaded.workflow.coverage.recommended).toBe(85);
    expect(loaded.workflow.branch.base).toBe("main");
  });

  it("preserves an unknown key rather than rejecting it -- the file is the repository's", () => {
    const loaded = loadWorkflow(
      repoWith({ $comment: "ours", cadence: { standup: "daily" }, branch: { note: "ours too" } }),
    );
    expect(loaded.raw["cadence"]).toEqual({ standup: "daily" });
    expect(loaded.workflow.branch.raw["note"]).toBe("ours too");
    // ...and the `$`-keys travel with it, read by nobody.
    expect(loaded.workflow.schema).toBeNull();
    expect(loaded.raw["$comment"]).toBe("ours");
  });

  it("surfaces a string $schema and ignores one of any other shape", () => {
    expect(loadWorkflow(repoWith({ $schema: "nen.workflow/v0.1" })).workflow.schema).toBe(
      "nen.workflow/v0.1",
    );
    expect(loadWorkflow(repoWith({ $schema: { id: 1 } })).workflow.schema).toBeNull();
  });

  it("reads the whole models block, both levels open", () => {
    const { workflow } = loadWorkflow(
      repoWith({
        models: {
          rule: "aliases only",
          surfaceA: { frontier: "alpha", fast: "beta", note: "a sentence" },
          roles: { reviewer: "deep" },
        },
      }),
    );
    expect(workflow.models.rule).toBe("aliases only");
    expect(workflow.models.surfaces["surfaceA"]).toEqual({
      frontier: "alpha",
      fast: "beta",
      note: "a sentence",
    });
    expect(workflow.models.roles).toEqual({ reviewer: "deep" });
  });

  it("refuses a models leaf that is not a string, by pointer", () => {
    const error = refusal({ models: { surfaceA: { frontier: { name: "alpha" } } } });
    expect(error.pointer).toBe("models.surfaceA.frontier");
  });
});

describe("a near-miss key is refused, because an unknown one is PRESERVED", () => {
  // The two rules are one rule: preservation is what would make a typo silent,
  // so the typo is the one key preservation cannot cover.
  it.each([
    [{ coverage: { minimun: 95 } }, "coverage.minimun", "minimum"],
    [{ coverage: { recommeded: 95 } }, "coverage.recommeded", "recommended"],
    [{ branch: { templat: "x/{descriptor}" } }, "branch.templat", "template"],
    [{ iteration: { check: ["build"] } }, "iteration.check", "checks"],
    [{ commits: { forbiddenTrailer: ["X"] } }, "commits.forbiddenTrailer", "forbiddenTrailers"],
    [{ monitor: { maxCycle: 5 } }, "monitor.maxCycle", "maxCycles"],
    [{ coverages: {} }, "coverages", "coverage"],
  ])("refuses %j at its own pointer", (document, pointer, meant) => {
    const error = refusal(document);
    expect(error.pointer).toBe(pointer);
    expect(error.message).toContain(`one letter away from '${meant}'`);
  });

  it("still preserves a key that is NOT a near-miss of anything nen reads", () => {
    const loaded = loadWorkflow(repoWith({ coverage: { minimum: 80, region: "eu" } }));
    expect(loaded.workflow.coverage.raw["region"]).toBe("eu");
  });

  it("applies NO near-miss rule inside models, whose key space is open", () => {
    // A surface is whatever the ecosystem calls it, exactly as
    // `project.verbs` is open -- there is nothing there for a key to silently
    // fail to be, so `rules` beside `rule` is a surface and not a typo.
    const { workflow } = loadWorkflow(repoWith({ models: { rules: { fast: "x" } } }));
    expect(workflow.models.surfaces["rules"]).toEqual({ fast: "x" });
  });
});

describe("the coverage ladder", () => {
  it("accepts an ascending ladder, equal rungs included", () => {
    const { workflow } = loadWorkflow(
      repoWith({ coverage: { minimum: 90, recommended: 90, ideal: 90 } }),
    );
    expect(workflow.coverage.minimum).toBe(90);
  });

  it("refuses one that does not ascend, and will not guess which rung was mistyped", () => {
    const error = refusal({ coverage: { minimum: 95, ideal: 80 } });
    expect(error.pointer).toBe("coverage");
    expect(error.message).toContain("does not ascend");
    expect(error.message).toContain("minimum <= recommended <= ideal");
  });

  it("refuses a fraction, naming the unit", () => {
    const error = refusal({ coverage: { minimum: 0.85 } });
    expect(error.pointer).toBe("coverage.minimum");
    expect(error.message).toContain("PERCENTAGES");
  });

  it.each([-1, 101])("refuses %i, which no run could report honestly", (value) => {
    expect(refusal({ coverage: { minimum: value } }).pointer).toBe("coverage.minimum");
  });

  it("refuses a rung that is not a number at all", () => {
    expect(refusal({ coverage: { ideal: "90" } }).pointer).toBe("coverage.ideal");
  });
});

describe("branch.template and branch.base", () => {
  it("refuses a template with no {descriptor}: one branch name for every effort", () => {
    const error = refusal({ branch: { template: "{model}/{persona}" } });
    expect(error.pointer).toBe("branch.template");
    expect(error.message).toContain("{descriptor}");
  });

  it("accepts any other shape that carries it", () => {
    const { workflow } = loadWorkflow(repoWith({ branch: { template: "feature/{descriptor}" } }));
    expect(workflow.branch.template).toBe("feature/{descriptor}");
  });

  it.each(['ma"in', "main$(id)", "-main", "a/../b", "main branch"])(
    "refuses '%s' as a trunk: it is interpolated into a generated hook",
    (base) => {
      expect(refusal({ branch: { base } }).pointer).toBe("branch.base");
    },
  );

  it("accepts the trunk names real repositories use", () => {
    for (const base of ["main", "master", "develop", "release/1.x", "trunk_2"]) {
      expect(loadWorkflow(repoWith({ branch: { base } })).workflow.branch.base).toBe(base);
    }
  });
});

describe("reports paths are repo-relative and inert", () => {
  it.each(["/etc", "../outside", "a/../..", "Reports\nnode_modules"])(
    "refuses reports.dir '%s'",
    (dir) => {
      expect(refusal({ reports: { dir } }).pointer).toBe("reports.dir");
    },
  );

  it("refuses the same shapes under reports.captures", () => {
    expect(refusal({ reports: { captures: "/tmp/x" } }).pointer).toBe("reports.captures");
  });

  it("accepts a nested repo-relative directory", () => {
    expect(loadWorkflow(repoWith({ reports: { dir: "docs/reports" } })).workflow.reports.dir).toBe(
      "docs/reports",
    );
  });
});

describe("commits -- the trailer policy", () => {
  it("reads both lists as trailer KEYS", () => {
    const { workflow } = loadWorkflow(
      repoWith({ commits: { allowedAttributionTrailers: ["X-Agent"], forbiddenTrailers: ["Q-Z"] } }),
    );
    expect(workflow.commits.allowedAttributionTrailers).toEqual(["X-Agent"]);
    expect(workflow.commits.forbiddenTrailers).toEqual(["Q-Z"]);
  });

  it.each(["X-Agent: value", "X Agent", "-X", "X.Agent", "^X"])(
    "refuses '%s', which is not a key a hook can match on",
    (key) => {
      expect(refusal({ commits: { allowedAttributionTrailers: [key] } }).pointer).toBe(
        "commits.allowedAttributionTrailers[0]",
      );
    },
  );

  it("refuses a key listed as BOTH allowed and forbidden, rather than picking", () => {
    const error = refusal({
      commits: { allowedAttributionTrailers: ["Signed-off-by"], forbiddenTrailers: ["signed-off-by"] },
    });
    expect(error.pointer).toBe("commits");
    expect(error.message).toContain("both allowed and forbidden");
  });
});

describe("refusedTrailerKeys / trailerRefusal", () => {
  const policy = (
    allowedAttributionTrailers: readonly string[],
    forbiddenTrailers: readonly string[] = [],
  ): { allowedAttributionTrailers: readonly string[]; forbiddenTrailers: readonly string[]; raw: Readonly<Record<string, unknown>> } => ({
    allowedAttributionTrailers,
    forbiddenTrailers,
    raw: {},
  });

  it("refuses every attribution-shaped key by default -- nothing is admitted unasked", () => {
    const refused = refusedTrailerKeys(policy([])).map((key): string => key.toLowerCase());
    for (const key of ATTRIBUTION_TRAILERS) expect(refused).toContain(key.toLowerCase());
    // ...and each of them ONCE. The enumeration carries two spellings of the
    // same trailer because both are written in the wild; matching ignores case,
    // so emitting both would put two identical greps in the generated hook.
    expect(new Set(refused).size).toBe(refused.length);
  });

  it("drops a key the repository admits, in any spelling of it", () => {
    const refused = refusedTrailerKeys(policy(["signed-off-by"]));
    expect(refused.some((key): boolean => key.toLowerCase() === "signed-off-by")).toBe(false);
    expect(refused).toContain("Co-Authored-By");
  });

  it("adds every forbiddenTrailers key, and lists no key twice", () => {
    const refused = refusedTrailerKeys(policy([], ["X-Agent", "co-authored-by"]));
    expect(refused).toContain("X-Agent");
    expect(refused.filter((key): boolean => key.toLowerCase() === "co-authored-by")).toHaveLength(1);
  });

  it("matches a caller's key without regard to case, as every reader of the commit will", () => {
    expect(trailerRefusal(policy([]), "co-authored-by")).toBe("Co-Authored-By");
    expect(trailerRefusal(policy([]), "  Claude-Session  ")).toBe("Claude-Session");
    expect(trailerRefusal(policy([]), "Closes")).toBeNull();
    expect(trailerRefusal(policy(["Co-Authored-By"]), "CO-AUTHORED-BY")).toBeNull();
  });
});

describe("describeWorkflow", () => {
  it("names the ladder, the template and the trunk -- the three a reader checks", () => {
    const line = describeWorkflow(
      parseWorkflow("<doc>", { coverage: { minimum: 70, recommended: 75, ideal: 95 } }),
    );
    expect(line).toContain("coverage 70/75/95 (touched)");
    expect(line).toContain(`branch '${DEFAULT_BRANCH_TEMPLATE}' off 'main'`);
    expect(line).toContain("checks: build");
  });

  it("says '(none)' rather than nothing when a repository declares no check", () => {
    expect(describeWorkflow(parseWorkflow("<doc>", { iteration: { checks: [] } }))).toContain(
      "checks: (none)",
    );
  });
});

describe("the file's own name is stated once", () => {
  it("is under the committed nen/, never the generated .nen/", () => {
    expect(WORKFLOW_FILE).toBe("nen/workflow.json");
  });
});
