// The spec family's two cross-cutting pieces of zheref/nen#493: the `spec`
// domain of nen/workflow.json, and the Spec section row a PR body is checked
// against.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkBody } from "../pr/bodycheck.js";
import { parseSectionCatalogue, resolveSections } from "../pr/sections.js";
import { SchemaError } from "../schema/errors.js";
import { defaultSpecPolicy, parseWorkflow } from "../schema/workflow.js";
import { defaultSeams } from "../seam/exec.js";
import { SPEC_SECTION_REQUIREMENT } from "./coverage.js";
import { fixtureCopy, spec } from "./testkit.testkit.js";

const parse = (spec_: unknown): ReturnType<typeof parseWorkflow> => parseWorkflow("nen/workflow.json", { spec: spec_ });

describe("nen/workflow.json's spec domain", () => {
  it("fills the catalogue's defaults and leaves the typed keys null", () => {
    expect(defaultSpecPolicy()).toEqual({
      declared: false,
      clarify: { maxQuestions: 5, maxRounds: 3, maxQuestionsDeclared: false },
      capture: { foldersPerPr: 4 },
      maxBytes: null,
      autonomy: { platformOrder: null, referencePlatform: null, maxInFlight: null, unmetSc: "refuse", convergeFiling: "propose", waveEnds: null },
    });
    expect(parseWorkflow("nen/workflow.json", {}).spec).toEqual(defaultSpecPolicy());
  });

  it("reads every stated key", () => {
    const policy = parse({ clarify: { maxQuestions: 3 }, capture: { foldersPerPr: 2 }, maxBytes: 40000, autonomy: { platformOrder: ["android", "web"], referencePlatform: "android", maxInFlight: { android: 2, web: 1 }, convergeFiling: "file", waveEnds: "all-at-prompt" } }).spec;
    expect(policy).toEqual({
      declared: true,
      clarify: { maxQuestions: 3, maxRounds: 3, maxQuestionsDeclared: true },
      capture: { foldersPerPr: 2 },
      maxBytes: 40000,
      autonomy: { platformOrder: ["android", "web"], referencePlatform: "android", maxInFlight: { android: 2, web: 1 }, unmetSc: "refuse", convergeFiling: "file", waveEnds: "all-at-prompt" },
    });
  });

  it("refuses a value off its range, a near-miss key and a reference platform outside the order, by pointer", () => {
    for (const [value, pointer] of [
      [{ clarify: { maxQuestions: 0 } }, "spec.clarify.maxQuestions"],
      [{ clarify: { maxQuestion: 5 } }, "spec.clarify"],
      [{ maxbytes: 5 }, "spec"],
      [{ autonomy: { unmetSc: "defer" } }, "spec.autonomy.unmetSc"],
      [{ autonomy: { platformOrder: ["web", "web"] } }, "spec.autonomy.platformOrder"],
      [{ autonomy: { platformOrder: ["web"], referencePlatform: "ios" } }, "spec.autonomy.referencePlatform"],
      [{ autonomy: { maxInFlight: { web: -1 } } }, "spec.autonomy.maxInFlight.web"],
    ] as const) {
      let caught: unknown = null;
      try {
        parse(value);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(value)).toBeInstanceOf(SchemaError);
      expect(String((caught as Error).message), JSON.stringify(value)).toContain(pointer);
    }
  });

  it("caps an uncapped --rank with a stated clarify.maxQuestions, and holds files to a stated maxBytes", async () => {
    const repo = fixtureCopy();
    mkdirSync(join(repo, "nen"), { recursive: true });
    writeFileSync(join(repo, "nen", "workflow.json"), JSON.stringify({ spec: { clarify: { maxQuestions: 1 }, maxBytes: 100 } }));
    const run = await spec(["check", "--folder", "specs/001-sample-feature", "--markers", "--rank"], repo, defaultSeams(), true);
    const report = run.json();
    expect(report["ranked"]).toMatchObject({ max: 1, total: 2 });
    expect((report["ranked"] as { shown: unknown[] }).shown).toHaveLength(1);
    expect((report["findings"] as { rule: string; file: string }[]).filter((finding) => finding.rule === "over-max-bytes").map((finding) => finding.file)).toEqual(["specs/001-sample-feature/spec.md", "specs/001-sample-feature/tasks.md"]);
    const explicit = await spec(["check", "--folder", "specs/001-sample-feature", "--markers", "--rank", "--max", "2"], repo, defaultSeams(), true);
    expect(explicit.json()["ranked"]).toMatchObject({ max: 2 });
  });
});

describe("the PR Spec section row", () => {
  const catalogue = parseSectionCatalogue("catalogue", {
    sections: [
      { id: "changes", title: "What this changes for you", level: 1 },
      { id: "spec", title: "Spec", when: "spec" },
    ],
    footer: [],
    families: { build: ["implementation"] },
    precedence: ["build"],
    variants: { "product.build": ["changes"] },
    max: 7,
  });

  it("is admitted by the spec run fact, and body-check fails a missing or an empty section", () => {
    const resolved = resolveSections(catalogue, "product", "build", ["spec"]);
    expect(resolved.sections.map((section) => section.id)).toEqual(["changes", "spec"]);
    const requirements = [...resolved.requirements, SPEC_SECTION_REQUIREMENT];
    const filled = "# What this changes for you\n\nx\n\n## Spec\n\n- F002-SC-001 — satisfied — test ListTest.empty\n";
    expect(checkBody(filled, requirements).ok).toBe(true);
    expect(checkBody("# What this changes for you\n\nx\n", requirements).ok).toBe(false);
    const empty = checkBody("# What this changes for you\n\nx\n\n## Spec\n\n## Next\n", requirements);
    expect(empty.results.find((result) => result.name === "spec-rows")?.satisfied).toBe(false);
    expect(empty.results.find((result) => result.name === "spec")?.satisfied).toBe(true);
  });

  it("is quoted verbatim in docs/USAGE.md", () => {
    const usage = readFileSync(join(process.cwd(), "docs", "USAGE.md"), "utf8");
    expect(usage).toContain(JSON.stringify(SPEC_SECTION_REQUIREMENT));
  });
});
