import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SchemaError } from "../schema/errors.js";
import { axisOfLabel, loadClassifyTaxonomy, parseClassifyTaxonomy, taxonomyLabels } from "./taxonomy.js";
import { MINI, REAL, readJson, type Json } from "./fixtures/harness.js";

function parse(edit: (value: Json) => void): unknown {
  const value = readJson(MINI);
  edit(value);
  return parseClassifyTaxonomy("/x/tax.json", value);
}

function refusal(edit: (value: Json) => void): SchemaError {
  try {
    parse(edit);
  } catch (error) {
    if (error instanceof SchemaError) return error;
    throw error;
  }
  throw new Error("expected a SchemaError, the file was accepted");
}

describe("parseClassifyTaxonomy -- a valid file", () => {
  it("reads both axes, their prefixes, colours and keys", () => {
    const taxonomy = loadClassifyTaxonomy("/", MINI);
    expect(taxonomy.axes.lang.prefix).toBe("lang/");
    expect(taxonomy.axes.lang.color).toBe("1d76db");
    expect(taxonomy.axes.job.keys.map((entry): string => entry.key)).toEqual(["build", "test"]);
    expect(taxonomy.confidence).toEqual({ levels: ["high", "medium", "low"], applied: ["high", "medium"], listed: ["low"] });
  });

  it("derives the label set as prefix + key, axis colour, key description, in file order", () => {
    expect(taxonomyLabels(loadClassifyTaxonomy("/", MINI))).toEqual([
      { name: "lang/alpha", color: "1d76db", description: "Needs alpha", axis: "lang", key: "alpha" },
      { name: "lang/beta", color: "1d76db", description: "Needs beta", axis: "lang", key: "beta" },
      { name: "job/build", color: "5319e7", description: "Building the thing", axis: "job", key: "build" },
      { name: "job/test", color: "5319e7", description: "Testing the thing", axis: "job", key: "test" },
    ]);
  });

  it("accepts the real taxonomy file, 5 + 39 labels, every description within GitHub's limit", () => {
    const labels = taxonomyLabels(loadClassifyTaxonomy("/", REAL));
    expect(labels.filter((label): boolean => label.axis === "lang")).toHaveLength(5);
    expect(labels.filter((label): boolean => label.axis === "job")).toHaveLength(39);
    expect(labels.every((label): boolean => label.description.length <= 100)).toBe(true);
    expect(new Set(labels.map((label): string => label.name)).size).toBe(44);
  });

  it("resolves a relative path against the repository root, not the process directory", () => {
    const taxonomy = loadClassifyTaxonomy(join(MINI, ".."), basename(MINI));
    expect(taxonomy.path).toBe(MINI);
  });

  it("finds a label's axis by prefix, and null for a label with none", () => {
    const taxonomy = loadClassifyTaxonomy("/", MINI);
    expect(axisOfLabel(taxonomy, "job/anything")).toEqual({ axis: "job", key: "anything" });
    expect(axisOfLabel(taxonomy, "job/")).toBeNull();
    expect(axisOfLabel(taxonomy, "bug")).toBeNull();
  });
});

describe("parseClassifyTaxonomy -- every refusal names its pointer", () => {
  it("refuses a missing axis", () => {
    const error = refusal((v): void => {
      delete v["axes"]["job"];
    });
    expect(error.pointer).toBe("axes.job");
    expect(error.message).toMatch(/missing/);
  });

  it("skips $-prefixed metadata beside and inside the axes: a $comment is not a third axis", () => {
    const taxonomy = parseClassifyTaxonomy("/x/tax.json", ((): Json => {
      const v = readJson(MINI);
      v["axes"]["$comment"] = "a note about the axes";
      v["axes"]["$meta"] = { nested: { anything: [1, 2] } };
      v["axes"]["lang"]["$code"] = "metadata on an axis";
      v["axes"]["lang"]["keys"][0]["$note"] = "metadata on a key";
      return v;
    })());
    expect(Object.keys(taxonomy.axes)).toEqual(["lang", "job"]);
    expect(taxonomy.axes.lang.keys[0]?.key).toBe("alpha");
  });

  it("still refuses a real third axis", () => {
    expect(
      refusal((v): void => {
        v["axes"]["$comment"] = "fine";
        v["axes"]["extra"] = v["axes"]["lang"];
      }).pointer,
    ).toBe("axes.extra");
  });

  it("refuses an axis the contract does not carry", () => {
    const error = refusal((v): void => {
      v["axes"]["domain"] = v["axes"]["lang"];
    });
    expect(error.pointer).toBe("axes.domain");
  });

  it("refuses a duplicate key", () => {
    const error = refusal((v): void => {
      v["axes"]["job"]["keys"][1]["key"] = "build";
    });
    expect(error.pointer).toBe("axes.job.keys[1].key");
    expect(error.message).toMatch(/duplicates axes\.job\.keys\[0\]/);
  });

  it("refuses a colour that is not six hex digits", () => {
    for (const color of ["#1d76db", "1d76d", "zzzzzz"]) {
      const error = refusal((v): void => {
        v["axes"]["lang"]["color"] = color;
      });
      expect(error.pointer).toBe("axes.lang.color");
    }
  });

  it("refuses a description over GitHub's 100 characters", () => {
    const error = refusal((v): void => {
      v["axes"]["lang"]["keys"][0]["description"] = "x".repeat(101);
    });
    expect(error.pointer).toBe("axes.lang.keys[0].description");
    expect(error.message).toMatch(/101 characters/);
  });

  it("accepts a description of exactly 100", () => {
    expect(() =>
      parse((v): void => {
        v["axes"]["lang"]["keys"][0]["description"] = "x".repeat(100);
      }),
    ).not.toThrow();
  });

  it("refuses a prefix that does not end in '/'", () => {
    for (const prefix of ["lang", "lang:", "/"]) {
      const error = refusal((v): void => {
        v["axes"]["lang"]["prefix"] = prefix;
      });
      expect(error.pointer).toBe("axes.lang.prefix");
    }
  });

  it("refuses two prefixes where one sits inside the other", () => {
    const error = refusal((v): void => {
      v["axes"]["job"]["prefix"] = "lang/job/";
    });
    expect(error.pointer).toBe("axes.job.prefix");
    expect(error.message).toMatch(/overlaps/);
  });

  it("refuses a key that is not kebab-case", () => {
    for (const key of ["Alpha", "a_b", "1a", "a b", "-a"]) {
      const error = refusal((v): void => {
        v["axes"]["lang"]["keys"][0]["key"] = key;
      });
      expect(error.pointer).toBe("axes.lang.keys[0].key");
    }
  });

  it("refuses an axis with no keys, and a key with no title", () => {
    expect(
      refusal((v): void => {
        v["axes"]["lang"]["keys"] = [];
      }).pointer,
    ).toBe("axes.lang.keys");
    expect(
      refusal((v): void => {
        delete v["axes"]["lang"]["keys"][0]["title"];
      }).pointer,
    ).toBe("axes.lang.keys[0].title");
  });

  it("refuses a file that is not a v1 classify-taxonomy contract", () => {
    expect(
      refusal((v): void => {
        v["$schema"] = "something-else/v1";
      }).pointer,
    ).toBe("$schema");
    expect(
      refusal((v): void => {
        delete v["contract"];
      }).pointer,
    ).toBe("contract");
  });

  it("refuses a confidence policy that leaves a level undecided or names an unknown one", () => {
    expect(
      refusal((v): void => {
        v["classification"]["confidence"]["listed"] = [];
      }).pointer,
    ).toBe("classification.confidence.levels");
    expect(
      refusal((v): void => {
        v["classification"]["confidence"]["applied"] = ["high", "medium", "bogus"];
      }).pointer,
    ).toBe("classification.confidence.applied[2]");
    expect(
      refusal((v): void => {
        delete v["classification"]["confidence"];
      }).pointer,
    ).toBe("classification.confidence");
  });

  it("names the path it was reading in every message", () => {
    expect(
      refusal((v): void => {
        delete v["axes"]["lang"];
      }).message,
    ).toContain("/x/tax.json");
  });
});

describe("loadClassifyTaxonomy -- the file itself", () => {
  it("refuses a missing file and invalid JSON by path", () => {
    expect(() => loadClassifyTaxonomy("/", "/nope/none.json")).toThrow(/could not be read \(ENOENT\)/);
    const dir = mkdtempSync(join(tmpdir(), "nen-classify-bad-"));
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => loadClassifyTaxonomy(dir, "bad.json")).toThrow(/is not valid JSON/);
  });
});
