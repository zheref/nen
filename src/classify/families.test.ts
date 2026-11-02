// src/classify/families.test.ts -- install-only label families (zheref/nen#590).
//
// `nen classify install` declared and synced the two axes only, so a consumer
// never received the `model/` family hatsu:direct applies. The taxonomy's
// optional root `families` block carries it as data; these tests hold the
// parser, the install set, and the canonical `model/` family end to end.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createArgv, listLabelsArgv } from "../labels/sync.js";
import type { Target } from "../github/target.js";
import { compareDeclaration } from "./install.js";
import { classifyLabels } from "./status.js";
import { installLabels, isForeignLabel, loadClassifyTaxonomy, taxonomyLabels } from "./taxonomy.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import {
  capture,
  gh,
  issueCall,
  landedCalls,
  MINI,
  MINI_LABELS,
  mutatedTaxonomy,
  readJson,
  SLUG,
  tmpRepo,
  type Declared,
  type Json,
} from "./fixtures/harness.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: SLUG };

// The canonical model/ family, as zheref/hatsu and zheref/nen hold it on GitHub
// (read 2026-10-31 with `gh label list --json name,color,description`).
const MODEL_LABELS: readonly Declared[] = [
  { name: "model/claude", color: "0e8a16", description: "hatsu:direct's primary pick is on the Claude line (Anthropic)" },
  { name: "model/gpt", color: "0e8a16", description: "hatsu:direct's primary pick is on the GPT line (OpenAI)" },
  { name: "model/gemini", color: "0e8a16", description: "hatsu:direct's primary pick is on the Gemini line (Google)" },
  { name: "model/grok", color: "0e8a16", description: "hatsu:direct's primary pick is on the Grok line (xAI, served by Cursor)" },
  { name: "model/composer", color: "0e8a16", description: "hatsu:direct's primary pick is on Cursor's Composer line" },
];

const MODEL_FAMILY = {
  prefix: "model/",
  color: "0e8a16",
  keys: MODEL_LABELS.map((label) => {
    const key = label.name.slice("model/".length);
    return { key, title: key, description: label.description };
  }),
};

const withModel = (edit: (value: Json) => void = (): void => {}): string =>
  mutatedTaxonomy((value): void => {
    value["families"] = { $comment: "install-only", model: structuredClone(MODEL_FAMILY) };
    edit(value);
  });

const install = (taxonomy: string, repo: string, ...rest: string[]): string[] => [
  "classify",
  "install",
  "--taxonomy",
  taxonomy,
  "--repo",
  repo,
  ...rest,
];

describe("taxonomy families -- parsed as data, never as an axis", () => {
  it("is empty when the file carries none, so every older taxonomy reads as before", () => {
    const taxonomy = loadClassifyTaxonomy("/", MINI);
    expect(taxonomy.families).toEqual([]);
    expect(installLabels(taxonomy).map((label) => label.name)).toEqual(taxonomyLabels(taxonomy).map((label) => label.name));
  });

  it("reads each family's prefix, colour and keys, `$` keys skipped", () => {
    const taxonomy = loadClassifyTaxonomy("/", withModel());
    expect(taxonomy.families).toHaveLength(1);
    expect(taxonomy.families[0]?.name).toBe("model");
    expect(taxonomy.families[0]?.prefix).toBe("model/");
    expect(taxonomy.families[0]?.keys.map((entry) => entry.key)).toEqual(["claude", "gpt", "gemini", "grok", "composer"]);
  });

  it("appends the family labels after the axes', axis null", () => {
    const labels = installLabels(loadClassifyTaxonomy("/", withModel()));
    expect(labels.map((label) => label.name)).toEqual([...MINI_LABELS, ...MODEL_LABELS].map((label) => label.name));
    expect(labels.at(-1)).toEqual({
      name: "model/composer",
      color: "0e8a16",
      description: "hatsu:direct's primary pick is on Cursor's Composer line",
      family: "model",
      key: "composer",
      axis: null,
    });
    expect(labels[0]).toMatchObject({ family: "lang", axis: "lang" });
  });

  it.each([
    ["a family named like an axis", (value: Json): void => { value["families"] = { lang: MODEL_FAMILY }; }, /families\.lang.*names an axis/],
    ["a non-kebab family name", (value: Json): void => { value["families"] = { Model: MODEL_FAMILY }; }, /families\.Model.*kebab-case/],
    ["a prefix overlapping an axis", (value: Json): void => { value["families"] = { model: { ...MODEL_FAMILY, prefix: "lang/x/" } }; }, /families\.model\.prefix.*overlaps axes\.lang\.prefix/],
    ["two overlapping families", (value: Json): void => { value["families"] = { model: MODEL_FAMILY, other: { ...MODEL_FAMILY, prefix: "model/x/" } }; }, /families\.other\.prefix.*overlaps families\.model\.prefix/],
    ["a family with no keys", (value: Json): void => { value["families"] = { model: { ...MODEL_FAMILY, keys: [] } }; }, /families\.model\.keys.*A family with no keys/],
    ["a bad colour", (value: Json): void => { value["families"] = { model: { ...MODEL_FAMILY, color: "#0e8a16" } }; }, /families\.model\.color/],
    ["a block that is not an object", (value: Json): void => { value["families"] = []; }, /families/],
  ])("refuses %s by pointer", (_name, edit, message) => {
    expect(() => loadClassifyTaxonomy("/", mutatedTaxonomy(edit))).toThrow(message);
  });

  it("names a family label foreign only when its key is not carried", () => {
    const taxonomy = loadClassifyTaxonomy("/", withModel());
    expect(isForeignLabel(taxonomy, "model/gpt")).toBe(false);
    expect(isForeignLabel(taxonomy, "model/llama")).toBe(true);
    expect(isForeignLabel(taxonomy, "lang/zeta")).toBe(true);
    expect(isForeignLabel(taxonomy, "bug")).toBe(false);
    expect(isForeignLabel(taxonomy, "model/")).toBe(false);
  });

  it("never classifies on a family: an issue with no model/ label is still classified", () => {
    const status = classifyLabels(loadClassifyTaxonomy("/", withModel()), 1, "t", ["lang/alpha", "job/build", "model/gpt"]);
    expect(status.classified).toBe(true);
    expect(status.unknown).toEqual([]);
    expect(Object.keys(status)).not.toContain("model");
  });
});

describe("nen classify install -- the model/ family (AC-1)", () => {
  it("reports every model/ label absent on a consumer that declares only the axes", async () => {
    const result = await capture(install(withModel(), tmpRepo({ labels: MINI_LABELS })));
    expect(result.code).toBe(1);
    expect(result.out).toEqual([
      ...MINI_LABELS.map((label) => `present  ${label.name}`),
      ...MODEL_LABELS.map((label) => `absent   ${label.name}`),
    ]);
    expect(result.err.join("\n")).toMatch(/5 of 9 label\(s\) not installed \(5 absent, 0 drift\)/);
  });

  it("--write declares the full family with the canonical colours and descriptions", async () => {
    const repo = tmpRepo({ labels: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }] });
    const result = await capture(install(withModel(), repo, "--write"));
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toBe("written: 9 added, 0 updated");
    const written = readJson(join(repo, "nen", "labels.json"))["labels"] as Declared[];
    expect(written.slice(5)).toEqual(MODEL_LABELS);
    expect((await capture(install(withModel(), repo))).code).toBe(0);
  });

  it("the canonical family matches nen's own landed declaration", () => {
    const own = loadLabelTaxonomy(process.cwd());
    for (const label of MODEL_LABELS) {
      expect(own.get(label.name), label.name).toMatchObject({ color: label.color, description: label.description });
    }
    const report = compareDeclaration(loadClassifyTaxonomy("/", withModel()), own);
    expect(report.entries.filter((entry) => entry.name.startsWith("model/"))).toEqual(
      MODEL_LABELS.map((label) => ({ name: label.name, status: "present" })),
    );
  });

  it("updates a drifted model/ label in place and lists an unknown one as foreign, untouched", async () => {
    const repo = tmpRepo({
      labels: [...MINI_LABELS, { ...MODEL_LABELS[1], color: "ffffff" }, { name: "model/llama", color: "0e8a16", description: "retired" }],
    });
    const result = await capture(install(withModel(), repo, "--write"));
    expect(result.code).toBe(0);
    expect(result.out).toContain("update  model/gpt");
    expect(result.out).toContain("foreign  model/llama  (declared, not in the taxonomy; left alone)");
    const written = readJson(join(repo, "nen", "labels.json"))["labels"] as Declared[];
    expect(written.find((label) => label.name === "model/gpt")).toEqual(MODEL_LABELS[1]);
    expect(written.find((label) => label.name === "model/llama")).toEqual({ name: "model/llama", color: "0e8a16", description: "retired" });
  });

  it("--sync creates the model/ labels on GitHub once the declaration is landed", async () => {
    const all = [...MINI_LABELS, ...MODEL_LABELS];
    const repo = tmpRepo({ labels: all });
    const script = all.map((label) => ({ match: gh(...createArgv(TARGET, label)), result: {} }));
    const result = await capture(install(withModel(), repo, "--sync", "--target", SLUG), [
      ...landedCalls({ labels: all }),
      { match: gh(...listLabelsArgv(TARGET)), result: { stdout: "[[]]" } },
      ...script,
    ]);
    expect(result.code).toBe(0);
    expect(result.out.slice(4)).toEqual(MODEL_LABELS.map((label) => `created: ${label.name}`));
  });

  it("--sync refuses while the default branch lacks the family, naming it", async () => {
    const all = [...MINI_LABELS, ...MODEL_LABELS];
    const result = await capture(install(withModel(), tmpRepo({ labels: all }), "--sync", "--target", SLUG), landedCalls({ labels: MINI_LABELS }));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/5 label\(s\) absent or drifted there \(model\/claude, model\/gpt, model\/gemini, model\/grok, model\/composer\)/);
  });
});

describe("nen classify labels -- lists the families too", () => {
  it("prints the family labels and counts them", async () => {
    const result = await capture(["classify", "labels", "--taxonomy", withModel(), "--repo", "/"]);
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toBe("9 label(s): 2 lang, 2 job, 5 model");
    expect(result.out.some((line) => line.startsWith("model/gpt") && line.includes("#0e8a16"))).toBe(true);
  });

  it("--json carries the families block and each label's family", async () => {
    const result = await capture(["classify", "labels", "--taxonomy", withModel(), "--repo", "/", "--json"]);
    const json = JSON.parse(result.out.join("\n")) as { families: unknown; labels: { name: string; axis: string | null; family: string }[] };
    expect(json.families).toEqual({ model: { prefix: "model/", count: 5 } });
    expect(json.labels.find((label) => label.name === "model/grok")).toMatchObject({ axis: null, family: "model" });
    expect(json.labels[0]).toMatchObject({ axis: "lang", family: "lang" });
  });
});

describe("nen classify status -- GitHub must hold the family too", () => {
  it("names a model/ label absent on GitHub", async () => {
    const all = [...MINI_LABELS, ...MODEL_LABELS];
    const onGithub = all.filter((label) => label.name !== "model/grok").map((label) => ({ name: label.name }));
    const result = await capture(
      ["classify", "status", "--taxonomy", withModel(), "--repo", tmpRepo({ labels: all }), "--target", SLUG, "--issue", "1", "--json"],
      [
        issueCall(1, ["lang/alpha", "job/build"]),
        { match: gh("label", "list", "--repo", SLUG, "--limit", "500", "--json", "name,color,description"), result: { stdout: JSON.stringify(onGithub) } },
      ],
    );
    const doc = JSON.parse(result.out.join("\n")) as { declared: { status: string }; github: { missing: string[] } };
    expect(doc.declared.status).toBe("ok");
    expect(doc.github.missing).toEqual(["model/grok"]);
  });
});
