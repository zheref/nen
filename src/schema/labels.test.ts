import { describe, expect, it } from "vitest";
import { SchemaError } from "./errors.js";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import {
  decomposeLabelName,
  loadLabelTaxonomy,
  MAX_DESCRIPTION_LENGTH,
  parseLabelTaxonomy,
} from "./labels.js";

describe("loadLabelTaxonomy -- reads the TARGET repository", () => {
  it("reads whatever vocabulary the target repo carries", () => {
    const bankai = loadLabelTaxonomy(BANKAI_REPO);
    const alt = loadLabelTaxonomy(ALT_REPO);

    // The SAME accessor, against two files with nothing in common. Neither set
    // of names appears anywhere in the shipped tree.
    expect(bankai.has("bankai:severity/high")).toBe(true);
    expect(bankai.has("akatsuki:impact/blocker")).toBe(false);
    expect(alt.has("akatsuki:impact/blocker")).toBe(true);
    expect(alt.has("bankai:severity/high")).toBe(false);
  });

  it("groups by namespace and family structurally, with the caller naming both", () => {
    const bankai = loadLabelTaxonomy(BANKAI_REPO);
    const alt = loadLabelTaxonomy(ALT_REPO);

    expect(bankai.inFamily("bankai", "severity").map((l): string => l.name)).toEqual([
      "bankai:severity/critical",
      "bankai:severity/high",
      "bankai:severity/medium",
      "bankai:severity/low",
    ]);
    expect(alt.inFamily("akatsuki", "impact").map((l): string => l.name)).toEqual([
      "akatsuki:impact/blocker",
      "akatsuki:impact/minor",
    ]);
    expect(alt.inNamespace("akatsuki").length).toBe(alt.labels.length);
    expect(alt.inNamespace("bankai")).toEqual([]);
  });

  it("carries colour and description through unchanged", () => {
    const label = loadLabelTaxonomy(BANKAI_REPO).get("bankai:severity/high");
    expect(label).toEqual({
      name: "bankai:severity/high",
      color: "d93f0b",
      description: "Must fix before merge/release",
    });
  });

  it("is a LOUD, actionable error when the file is absent -- never a built-in default", () => {
    expect(() => loadLabelTaxonomy("/definitely/not/a/repo")).toThrow(SchemaError);
    expect(() => loadLabelTaxonomy("/definitely/not/a/repo")).toThrow(
      /no such file[\s\S]*--repo/,
    );
    // The negative that matters: it does not quietly succeed with a fallback.
    let value: unknown = "not thrown";
    try {
      value = loadLabelTaxonomy("/definitely/not/a/repo");
    } catch {
      value = undefined;
    }
    expect(value).toBeUndefined();
  });
});

describe("parseLabelTaxonomy -- validation", () => {
  const at = "/fake/schemas/labels.json";

  it("refuses a non-object root", () => {
    expect(() => parseLabelTaxonomy(at, [])).toThrow(/expected an object/);
  });

  it("refuses an empty label list", () => {
    expect(() => parseLabelTaxonomy(at, { labels: [] })).toThrow(/is empty/);
  });

  it("refuses a colour that is not six bare hex digits", () => {
    for (const color of ["#d93f0b", "d93f0", "zzzzzz", ""]) {
      expect(() =>
        parseLabelTaxonomy(at, { labels: [{ name: "x", color, description: "d" }] }),
      ).toThrow(SchemaError);
    }
  });

  it("refuses a description over GitHub's limit, naming the length", () => {
    const description = "x".repeat(MAX_DESCRIPTION_LENGTH + 1);
    expect(() =>
      parseLabelTaxonomy(at, { labels: [{ name: "x", color: "aabbcc", description }] }),
    ).toThrow(new RegExp(`is ${MAX_DESCRIPTION_LENGTH + 1} characters`));
  });

  it("accepts a description exactly at the limit", () => {
    const description = "x".repeat(MAX_DESCRIPTION_LENGTH);
    expect(
      parseLabelTaxonomy(at, { labels: [{ name: "x", color: "aabbcc", description }] }).labels
        .length,
    ).toBe(1);
  });

  it("refuses a duplicate name, naming both indices", () => {
    expect(() =>
      parseLabelTaxonomy(at, {
        labels: [
          { name: "x", color: "aabbcc", description: "a" },
          { name: "x", color: "ddeeff", description: "b" },
        ],
      }),
    ).toThrow(/duplicates labels\[0\]\.name/);
  });

  it("points at the offending entry by index", () => {
    try {
      parseLabelTaxonomy(at, {
        labels: [
          { name: "a", color: "aabbcc", description: "a" },
          { name: "b", color: "nope", description: "b" },
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).pointer).toBe("labels[1].color");
      expect((error as SchemaError).path).toBe(at);
    }
  });
});

describe("decomposeLabelName", () => {
  it("splits <namespace>:<family>/<leaf> without knowing any of them", () => {
    expect(decomposeLabelName("bankai:severity/high")).toEqual({
      namespace: "bankai",
      family: "severity",
      leaf: "high",
    });
    expect(decomposeLabelName("akatsuki:phase/landed")).toEqual({
      namespace: "akatsuki",
      family: "phase",
      leaf: "landed",
    });
  });

  it("reports the parts a name does not carry as null", () => {
    expect(decomposeLabelName("bankai:epic")).toEqual({
      namespace: "bankai",
      family: "epic",
      leaf: null,
    });
    expect(decomposeLabelName("bug")).toEqual({
      namespace: null,
      family: null,
      leaf: null,
    });
  });
});
