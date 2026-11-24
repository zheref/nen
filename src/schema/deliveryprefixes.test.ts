// Tests for the nen/gates.json#delivery.head_ref_prefixes drift row
// (zheref/nen#657, AC-3): the declared delivery prefixes against the fixed
// heads of the branches the template cuts, and the holistic-pass hazard of a
// list that covers every one of them (hanten round 1, Chrollo 1).

import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../testing/tempdir.js";
import { BANKAI_REPO } from "./fixtures/paths.js";
import { branchTemplateHeads, checkTaxonomy, deliveryPrefixDrift, type SchemaCheck } from "./taxonomy.js";
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

const reasonOf = (verdict: ReturnType<typeof deliveryPrefixDrift>): string => (verdict.kind === "not-judged" ? verdict.reason : "");

describe("branchTemplateHeads", () => {
  it("renders one head per {model} fill -- every surface and alias, skipping rule, roles, a tier keyed note and $ keys, repeats collapsed", () => {
    expect(branchTemplateHeads("{model}/{persona}/{descriptor}", MODELS)).toEqual({
      heads: ["claude/", "fable/", "opus/", "codex/", "astra/", "cursor/", "composer/"],
      reason: null,
    });
  });

  it("a literal first segment is its own head, and a mixed one is cut at the first token", () => {
    expect(branchTemplateHeads("delivery/{descriptor}", MODELS).heads).toEqual(["delivery/"]);
    expect(branchTemplateHeads("delivery-{descriptor}", MODELS).heads).toEqual(["delivery-"]);
    expect(branchTemplateHeads("x-{model}/{descriptor}", MODELS).heads).toContain("x-claude/");
    expect(branchTemplateHeads("{model}-bot/{descriptor}", MODELS).heads).toContain("opus-bot/");
  });

  it("a leading non-model token, a {model} with no surface, or an empty first segment has no head, with the reason", () => {
    expect(branchTemplateHeads("{persona}/{descriptor}", MODELS).reason).toMatch(/starts with '\{persona\}', a token whose value no declaration fixes/);
    expect(branchTemplateHeads("{descriptor}", MODELS).reason).toMatch(/starts with '\{descriptor\}'/);
    expect(branchTemplateHeads("{model}/{descriptor}", parseModels("t", undefined)).reason).toMatch(/models block declares no surface/);
    expect(branchTemplateHeads("/{descriptor}", MODELS).reason).toMatch(/starts with an empty segment/);
  });
});

describe("deliveryPrefixDrift", () => {
  const template = { template: "{model}/{persona}/{descriptor}" };
  const all = ["claude/", "fable/", "opus/", "codex/", "astra/", "cursor/", "composer/"];

  it("covered: every head starts with a declared prefix", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery(all))).toEqual({ kind: "covered", heads: all, extra: [] });
  });

  it("a shorter prefix covers a longer head; the comparison is case-sensitive", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery(["c", "fable/", "opus/", "astra/"])).kind).toBe("covered");
    const upper = deliveryPrefixDrift(template, MODELS, delivery([...all.filter((p) => p !== "opus/"), "Opus/"]));
    expect(upper).toMatchObject({ kind: "uncovered", uncovered: ["opus/"] });
  });

  it("uncovered: names every head no prefix covers -- the pre-#657 'codex/'-only list", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery(["codex/"]))).toMatchObject({
      kind: "uncovered",
      uncovered: ["claude/", "fable/", "opus/", "astra/", "cursor/", "composer/"],
    });
  });

  it("a prefix longer than the head does not cover it (it matches only some branches)", () => {
    expect(deliveryPrefixDrift({ template: "delivery-{descriptor}" }, MODELS, delivery(["delivery-x"]))).toMatchObject({
      kind: "uncovered",
      uncovered: ["delivery-"],
    });
    expect(deliveryPrefixDrift({ template: "delivery-{descriptor}" }, MODELS, delivery(["delivery-"])).kind).toBe("covered");
  });

  it("literal first segment: covered when literal + '/' is covered", () => {
    expect(deliveryPrefixDrift({ template: "delivery/{descriptor}" }, MODELS, delivery(["delivery/"])).kind).toBe("covered");
    expect(deliveryPrefixDrift({ template: "delivery/{descriptor}" }, MODELS, delivery(["codex/"]))).toMatchObject({
      kind: "uncovered",
      uncovered: ["delivery/"],
    });
  });

  it("a prefix that covers no head is allowed and listed as extra, never drift", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery([...all, "integration/"]))).toEqual({ kind: "covered", heads: all, extra: ["integration/"] });
  });

  it("another leading token, or a {model} template with no surface, is not judged and says why", () => {
    expect(reasonOf(deliveryPrefixDrift({ template: "{persona}/{descriptor}" }, MODELS, delivery(["codex/"])))).toMatch(/starts with '\{persona\}'/);
    expect(reasonOf(deliveryPrefixDrift(template, parseModels("t", undefined), delivery(["codex/"])))).toMatch(/models block declares no surface/);
  });

  it("label-only: no prefix declared, so prefixes are not checked", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery([], ["ship"]))).toEqual({ kind: "label-only", labels: ["ship"] });
  });

  it("holistic reviewer + full coverage is the holistic-wide hazard; partial coverage is narrow on purpose; label-only is neither", () => {
    expect(deliveryPrefixDrift(template, MODELS, delivery(all), ["sasuke"])).toEqual({ kind: "holistic-wide", heads: all, reviewers: ["sasuke"], extra: [] });
    expect(deliveryPrefixDrift(template, MODELS, delivery(["integration/"]), ["sasuke"])).toEqual({
      kind: "narrow",
      heads: all,
      uncovered: all,
      reviewers: ["sasuke"],
    });
    expect(deliveryPrefixDrift(template, MODELS, delivery([], ["ship"]), ["sasuke"]).kind).toBe("label-only");
  });

  it("a head fixed before {model} is judged by its literal even when models declares no surface (NN-PR-#677 J)", () => {
    const none = parseModels("t", undefined);
    expect(branchTemplateHeads("release/{model}/{descriptor}", none)).toEqual({ heads: ["release/"], reason: null });
    expect(deliveryPrefixDrift({ template: "release/{model}/{descriptor}" }, none, delivery(["release/"])).kind).toBe("covered");
    expect(deliveryPrefixDrift({ template: "release/{model}/{descriptor}" }, none, delivery(["codex/"]))).toMatchObject({ kind: "uncovered", uncovered: ["release/"] });
    expect(branchTemplateHeads("{model}/{descriptor}", none).reason).toMatch(/models block declares no surface/);
    expect(branchTemplateHeads("{persona}/{model}/{descriptor}", none).reason).toMatch(/starts with '\{persona\}'/);
  });
});

describe("checkTaxonomy -- the nen/gates.json#delivery.head_ref_prefixes row", () => {
  const BANKAI_GATES = JSON.parse(readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown> & {
    reviewers: Record<string, unknown>[];
  };
  /** The bankai fixture's gates with this delivery block; holistic-pass flags kept only when asked. */
  const gatesWith = (deliveryBlock: unknown, holistic = false): unknown => ({
    ...BANKAI_GATES,
    reviewers: BANKAI_GATES.reviewers.map((reviewer) => {
      if (holistic) return reviewer;
      const rest = { ...reviewer };
      delete rest["delivery_holistic_pass"];
      return rest;
    }),
    delivery: deliveryBlock,
  });
  const withPrefixes = (prefixes: string[], labels: string[] = [], holistic = false): unknown =>
    gatesWith({ author_pattern: { pattern: "^me$", ignoreCase: false }, head_ref_prefixes: prefixes, labels }, holistic);
  const WORKFLOW = { branch: { template: "{model}/{persona}/{descriptor}" }, models: { claude: { frontier: "fable" }, codex: { deep: "sol" } } };
  const FULL = ["claude/", "fable/", "codex/", "sol/"];

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

  it("AC-1 regression: nen's own committed nen/gates.json and nen/workflow.json read ok, every head covered", () => {
    const row = checkTaxonomy({ repoFlag: process.cwd() }).checks.find((c): boolean => c.file === ROW);
    expect(row?.ok).toBe(true);
    expect(row?.required).toBe(false);
    expect(row?.detail).toMatch(/^\d+ branch heads of nen\/workflow\.json branch\.template covered \(/);
    for (const head of ["claude/", "fable/", "opus/", "codex/", "astra/", "cursor/"]) expect(row?.detail).toContain(`'${head}'`);
  });

  it("sits immediately under the deploy.defaultTarget row", () => {
    const { files } = rowOf({ gates: withPrefixes(FULL), workflow: WORKFLOW });
    expect(files.indexOf(ROW)).toBe(files.indexOf("nen/workflow.json#deploy.defaultTarget") + 1);
  });

  it("covered with no holistic reviewer: an ok row, extra prefixes listed as allowed", () => {
    const { row, ok } = rowOf({ gates: withPrefixes([...FULL, "integration/"]), workflow: WORKFLOW });
    expect(row).toMatchObject({ ok: true, required: false });
    expect(row?.detail).toBe(
      "4 branch heads of nen/workflow.json branch.template covered ('claude/', 'fable/', 'codex/', 'sol/'); also declared, covering no template head (allowed, not drift): 'integration/'",
    );
    expect(ok).toBe(true);
  });

  it("holistic reviewer + full coverage: a warn naming the reviewers and the fix, exit unchanged", () => {
    const { row, ok } = rowOf({ gates: withPrefixes(FULL, [], true), workflow: WORKFLOW });
    expect(row).toMatchObject({ ok: false, required: false });
    expect(ok).toBe(true);
    expect(row?.detail).toMatch(/^every branch nen\/workflow\.json branch\.template cuts \('claude\/', 'fable\/', 'codex\/', 'sol\/'\) starts with a nen\/gates\.json delivery\.head_ref_prefixes entry, and 'sasuke', 'tenma' declare delivery_holistic_pass: true/);
    expect(row?.detail).toMatch(/those reviewers owe one holistic pass instead of a round at head\. Narrow delivery\.head_ref_prefixes to the prefixes only delivery branches carry, ones the everyday template does not produce \(that reads ok\), or drop delivery_holistic_pass from those reviewers$/);
  });

  it("holistic-wide agrees in number with one reviewer and carries extra prefixes", () => {
    const one = gatesWith({ author_pattern: { pattern: "^me$", ignoreCase: false }, head_ref_prefixes: [...FULL, "integration/"], labels: [] }, true) as {
      reviewers: Record<string, unknown>[];
    };
    one.reviewers = one.reviewers.map((reviewer) => {
      if (reviewer["name"] !== "tenma") return reviewer;
      const rest = { ...reviewer };
      delete rest["delivery_holistic_pass"];
      return rest;
    });
    const { row } = rowOf({ gates: one, workflow: WORKFLOW });
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("'sasuke' declares delivery_holistic_pass: true");
    expect(row?.detail).toContain("that reviewer owes one holistic pass");
    expect(row?.detail).toMatch(/or drop delivery_holistic_pass from that reviewer; also declared, covering no template head \(allowed, not drift\): 'integration\/'$/);
  });

  it("the bankai shape -- holistic reviewers, ['integration/'] and the {model} template -- reads ok, narrow on purpose", () => {
    const { row, ok } = rowOf({ gates: withPrefixes(["integration/"], [], true), workflow: WORKFLOW });
    expect(row).toMatchObject({ ok: true, required: false });
    expect(ok).toBe(true);
    expect(row?.detail).toBe(
      "narrow on purpose: 4 of 4 branch heads of nen/workflow.json branch.template not covered ('claude/', 'fable/', 'codex/', 'sol/') while 'sasuke', 'tenma' declare delivery_holistic_pass: true, so CON-40's carve-out applies only to head refs starting 'integration/' -- not drift",
    );
  });

  it("a literal one-head template fully covered beside a holistic reviewer is still holistic-wide", () => {
    const { row } = rowOf({ gates: withPrefixes(["delivery/"], [], true), workflow: { branch: { template: "delivery/{descriptor}" } } });
    expect(row?.ok).toBe(false);
    expect(row?.detail).toMatch(/^every branch nen\/workflow\.json branch\.template cuts \('delivery\/'\)/);
  });

  it("holistic reviewer + label-only: no holistic warn", () => {
    expect(rowOf({ gates: withPrefixes([], ["ship"], true), workflow: WORKFLOW }).row).toMatchObject({ ok: true, detail: "label-only, prefixes not checked (delivery.labels: 'ship')" });
  });

  it("uncovered: a warn row naming both files, every uncovered head and the fix -- the report's exit is unchanged", () => {
    const { row, ok } = rowOf({ gates: withPrefixes(["codex/"]), workflow: WORKFLOW });
    expect(row).toMatchObject({ ok: false, required: false });
    expect(ok).toBe(true);
    expect(row?.detail).toBe(
      "drift: nen/workflow.json branch.template '{model}/{persona}/{descriptor}' cuts branches starting 'claude/', 'fable/', 'sol/', which no nen/gates.json delivery.head_ref_prefixes entry ('codex/') covers, so a pull request from such a branch is never a CON-40 delivery PR. Add each prefix to nen/gates.json delivery.head_ref_prefixes, or change nen/workflow.json branch.template",
    );
  });

  it("literal and mixed first segments, covered and uncovered", () => {
    expect(rowOf({ gates: withPrefixes(["delivery/"]), workflow: { branch: { template: "delivery/{descriptor}" } } }).row?.ok).toBe(true);
    const drift = rowOf({ gates: withPrefixes(["codex/"]), workflow: { branch: { template: "delivery/{descriptor}" } } }).row;
    expect(drift?.ok).toBe(false);
    expect(drift?.detail).toContain("cuts branches starting 'delivery/'");
    expect(rowOf({ gates: withPrefixes(["delivery-"]), workflow: { branch: { template: "delivery-{descriptor}" } } }).row?.ok).toBe(true);
  });

  it("a leading non-model token is a warn that says why, never a pass", () => {
    const { row, ok } = rowOf({ gates: withPrefixes(["codex/"]), workflow: { branch: { template: "{persona}/{descriptor}" } } });
    expect(row).toMatchObject({ ok: false, required: false });
    expect(ok).toBe(true);
    expect(row?.detail).toMatch(/^cannot judge -- nen\/workflow\.json branch\.template '\{persona\}\/\{descriptor\}' starts with '\{persona\}'/);
  });

  it("label-only delivery block", () => {
    const { row } = rowOf({ gates: withPrefixes([], ["ship"]), workflow: WORKFLOW });
    expect(row).toMatchObject({ ok: true, detail: "label-only, prefixes not checked (delivery.labels: 'ship')" });
  });

  it("absent workflow.json or absent gates.json: not checked, said so", () => {
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
    expect(row?.detail).toMatch(/branch heads of nen\/workflow\.json branch\.template covered/);
  });
});
