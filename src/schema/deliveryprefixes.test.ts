// Tests for the nen/gates.json#delivery.head_ref_prefixes drift row
// (zheref/nen#657, AC-3): the declared delivery prefixes against the branch
// template's first-segment fills.

import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../testing/tempdir.js";
import { BANKAI_REPO } from "./fixtures/paths.js";
import { branchFirstSegmentFills, checkTaxonomy, deliveryPrefixDrift, type SchemaCheck } from "./taxonomy.js";
import { parseModels } from "./workflow.js";

const ROW = "nen/gates.json#delivery.head_ref_prefixes";

const MODELS = parseModels("t", {
  rule: "a sentence, never a fill",
  claude: { frontier: "fable", deep: "opus" },
  codex: { frontier: "astra", deep: "astra", $note: "metadata" },
  cursor: { fast: "composer", note: "prose, not an alias" },
  roles: { reviewer: "deep" },
});

const delivery = (headRefPrefixes: string[], labels: string[] = []): { headRefPrefixes: string[]; labels: string[] } => ({
  headRefPrefixes,
  labels,
});

describe("branchFirstSegmentFills", () => {
  it("reads every surface and alias for a {model} first segment, skipping rule, roles, note and $ keys, repeats collapsed", () => {
    expect(branchFirstSegmentFills("{model}/{persona}/{descriptor}", MODELS)).toEqual({
      segment: "{model}",
      fills: ["claude", "fable", "opus", "codex", "astra", "cursor", "composer"],
    });
  });

  it("reads a literal first segment as its own single fill, and another token as unfixable", () => {
    expect(branchFirstSegmentFills("delivery/{descriptor}", MODELS)).toEqual({ segment: "delivery", fills: ["delivery"] });
    expect(branchFirstSegmentFills("{persona}/{descriptor}", MODELS)).toEqual({ segment: "{persona}", fills: null });
    expect(branchFirstSegmentFills("{descriptor}", MODELS)).toEqual({ segment: "{descriptor}", fills: null });
    expect(branchFirstSegmentFills("x-{model}/{descriptor}", MODELS).fills).toBeNull();
  });
});

describe("deliveryPrefixDrift", () => {
  const template = { template: "{model}/{persona}/{descriptor}" };
  const all = ["claude/", "fable/", "opus/", "codex/", "astra/", "cursor/", "composer/"];

  it("covered: every fill starts with a declared prefix", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery(all))).toMatchObject({ kind: "covered", fills: all.map((p) => p.slice(0, -1)) });
  });

  it("a shorter prefix covers a longer fill; the comparison is case-sensitive", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery(["c", "fable/", "opus/", "astra/"])).kind).toBe("covered");
    const upper = deliveryPrefixDrift(template, MODELS, delivery([...all.filter((p) => p !== "opus/"), "Opus/"]));
    expect(upper).toMatchObject({ kind: "uncovered", uncovered: ["opus"] });
  });

  it("uncovered: names every fill no prefix covers -- the pre-#657 'codex/'-only list", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery(["codex/"]))).toMatchObject({
      kind: "uncovered",
      uncovered: ["claude", "fable", "opus", "astra", "cursor", "composer"],
    });
  });

  it("a prefix longer than the fill does not cover it", () => {
    expect(deliveryPrefixDrift({ template: "delivery/{descriptor}" }, MODELS, delivery(["delivery/x/"]))).toMatchObject({
      kind: "uncovered",
      uncovered: ["delivery"],
    });
  });

  it("literal first segment: covered when literal + '/' is covered", () => {
    expect(deliveryPrefixDrift({ template: "delivery/{descriptor}" }, MODELS, delivery(["delivery/"])).kind).toBe("covered");
    expect(deliveryPrefixDrift({ template: "delivery/{descriptor}" }, MODELS, delivery(["codex/"]))).toMatchObject({
      kind: "uncovered",
      uncovered: ["delivery"],
    });
  });

  it("another token, or a {model} template with no surface, is not checked and says why", () => {
    const persona = deliveryPrefixDrift({ template: "{persona}/{descriptor}" }, MODELS, delivery(["codex/"]));
    expect(persona.kind).toBe("not-checked");
    expect(persona.kind === "not-checked" ? persona.reason : "").toMatch(/starts with '\{persona\}', a token no declared list fixes/);
    const empty = deliveryPrefixDrift(template, parseModels("t", undefined), delivery(["codex/"]));
    expect(empty.kind === "not-checked" ? empty.reason : "").toMatch(/models block declares no surface/);
  });

  it("label-only: no prefix declared, so prefixes are not checked", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery([], ["ship"]))).toEqual({ kind: "label-only", labels: ["ship"] });
  });
});

describe("checkTaxonomy -- the nen/gates.json#delivery.head_ref_prefixes row", () => {
  const gatesWith = (deliveryBlock: unknown): unknown => ({
    ...(JSON.parse(readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>),
    delivery: deliveryBlock,
  });
  const withPrefixes = (prefixes: string[], labels: string[] = []): unknown =>
    gatesWith({ author_pattern: { pattern: "^me$", ignoreCase: false }, head_ref_prefixes: prefixes, labels });
  const WORKFLOW = { branch: { template: "{model}/{persona}/{descriptor}" }, models: { claude: { frontier: "fable" }, codex: { deep: "sol" } } };

  function rowOf(files: { gates?: unknown; workflow?: unknown }): { row: SchemaCheck | undefined; ok: boolean; files: string[] } {
    const root = makeTempDir("nen-delivery-prefixes-");
    try {
      mkdirSync(join(root, "nen"), { recursive: true });
      for (const file of ["labels.json", "repos.json", "colors.yml"]) copyFileSync(join(BANKAI_REPO, "nen", file), join(root, "nen", file));
      const write = (name: string, value: unknown): void =>
        writeFileSync(join(root, "nen", name), typeof value === "string" ? value : JSON.stringify(value));
      if (files.gates !== undefined) write("gates.json", files.gates);
      if (files.workflow !== undefined) write("workflow.json", files.workflow);
      const report = checkTaxonomy({ repoFlag: root });
      return { row: report.checks.find((c): boolean => c.file === ROW), ok: report.ok, files: report.checks.map((c) => c.file) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("AC-1 regression: nen's own committed nen/gates.json and nen/workflow.json read ok, every fill covered", () => {
    const row = checkTaxonomy({ repoFlag: process.cwd() }).checks.find((c): boolean => c.file === ROW);
    expect(row?.ok).toBe(true);
    expect(row?.required).toBe(false);
    expect(row?.detail).toMatch(/^\d+ first-segment fills of nen\/workflow\.json branch\.template covered \(/);
    for (const fill of ["claude", "fable", "opus", "codex", "astra", "cursor"]) expect(row?.detail).toContain(`'${fill}'`);
  });

  it("sits immediately under the deploy.defaultTarget row", () => {
    const { files } = rowOf({ gates: withPrefixes(["claude/", "fable/", "codex/", "sol/"]), workflow: WORKFLOW });
    expect(files.indexOf(ROW)).toBe(files.indexOf("nen/workflow.json#deploy.defaultTarget") + 1);
  });

  it("covered: an ok row", () => {
    const { row, ok } = rowOf({ gates: withPrefixes(["claude/", "fable/", "codex/", "sol/"]), workflow: WORKFLOW });
    expect(row).toMatchObject({ ok: true, required: false });
    expect(ok).toBe(true);
  });

  it("uncovered: a warn row naming both files, every uncovered prefix and the fix -- the report's exit is unchanged", () => {
    const { row, ok } = rowOf({ gates: withPrefixes(["codex/"]), workflow: WORKFLOW });
    expect(row).toMatchObject({ ok: false, required: false });
    expect(ok).toBe(true);
    expect(row?.detail).toBe(
      "drift: nen/workflow.json branch.template '{model}/{persona}/{descriptor}' cuts branches starting 'claude/', 'fable/', 'sol/', which no nen/gates.json delivery.head_ref_prefixes entry ('codex/') covers, so a pull request from such a branch is never a CON-40 delivery PR. Add each prefix to nen/gates.json delivery.head_ref_prefixes, or change nen/workflow.json branch.template",
    );
  });

  it("literal first segment, covered and uncovered", () => {
    const literal = { branch: { template: "delivery/{descriptor}" } };
    expect(rowOf({ gates: withPrefixes(["delivery/"]), workflow: literal }).row?.ok).toBe(true);
    const drift = rowOf({ gates: withPrefixes(["codex/"]), workflow: literal }).row;
    expect(drift?.ok).toBe(false);
    expect(drift?.detail).toContain("cuts branches starting 'delivery/'");
  });

  it("a non-model token first segment is not checked, and says why", () => {
    const { row } = rowOf({ gates: withPrefixes(["codex/"]), workflow: { branch: { template: "{persona}/{descriptor}" } } });
    expect(row?.ok).toBe(true);
    expect(row?.detail).toMatch(/^not checked -- nen\/workflow\.json branch\.template '\{persona\}\/\{descriptor\}' starts with '\{persona\}'/);
  });

  it("label-only delivery block", () => {
    const { row } = rowOf({ gates: withPrefixes([], ["ship"]), workflow: WORKFLOW });
    expect(row).toMatchObject({ ok: true, detail: "label-only, prefixes not checked (delivery.labels: 'ship')" });
  });

  it("absent workflow.json or absent gates.json: not checked, never a silent pass", () => {
    expect(rowOf({ gates: withPrefixes(["codex/"]) }).row?.detail).toMatch(/^not checked -- no nen\/workflow\.json/);
    expect(rowOf({ workflow: WORKFLOW }).row?.detail).toMatch(/^not checked -- nen\/gates\.json is absent/);
  });

  it("unreadable gates.json or workflow.json: not read -- see that row", () => {
    const badGates = rowOf({ gates: "{ not json", workflow: WORKFLOW }).row;
    expect(badGates).toMatchObject({ ok: true, required: false, detail: "not read -- nen/gates.json did not load; see that row" });
    const badWorkflow = rowOf({ gates: withPrefixes(["codex/"]), workflow: "{ not json" }).row;
    expect(badWorkflow).toMatchObject({ ok: true, required: false, detail: "not read -- nen/workflow.json did not load; see that row" });
  });

  it("a freshly seeded gates.json under the shipped workflow template reads no drift", () => {
    const seeds = JSON.parse(readFileSync(join(process.cwd(), "templates", "seeds.json"), "utf8")) as {
      seeds: { file: string; document?: unknown }[];
    };
    const template = JSON.parse(readFileSync(join(process.cwd(), "templates", "workflow.json"), "utf8")) as { document: unknown };
    const seed = seeds.seeds.find((s) => s.file === "nen/gates.json")?.document;
    const { row } = rowOf({ gates: seed, workflow: template.document });
    expect(row).toMatchObject({ ok: true });
    expect(row?.detail).toMatch(/fills of nen\/workflow\.json branch\.template covered/);
  });
});
