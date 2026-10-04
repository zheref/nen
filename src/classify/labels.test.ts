import { describe, expect, it } from "vitest";
import { basename, dirname } from "node:path";
import { capture, mutatedTaxonomy, MINI, REAL } from "./fixtures/harness.js";

describe("nen classify labels", () => {
  it("prints one line per label: name, #colour, description", async () => {
    const result = await capture(["classify", "labels", "--taxonomy", MINI]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "lang/alpha  #1d76db  Needs alpha",
      "lang/beta   #1d76db  Needs beta",
      "job/build   #5319e7  Building the thing",
      "job/test    #5319e7  Testing the thing",
      "4 label(s): 2 lang, 2 job",
    ]);
    expect(result.seams.calls).toEqual([]);
  });

  it("--json carries the contract, the taxonomy path, per-axis counts and the label rows", async () => {
    const result = await capture(["classify", "labels", "--taxonomy", MINI, "--json"]);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(json).toEqual({
      contract: "nen.classify.labels/v0.1",
      taxonomy: MINI,
      axes: { lang: { prefix: "lang/", count: 2 }, job: { prefix: "job/", count: 2 } },
      labels: [
        { name: "lang/alpha", color: "1d76db", description: "Needs alpha", axis: "lang", key: "alpha" },
        { name: "lang/beta", color: "1d76db", description: "Needs beta", axis: "lang", key: "beta" },
        { name: "job/build", color: "5319e7", description: "Building the thing", axis: "job", key: "build" },
        { name: "job/test", color: "5319e7", description: "Testing the thing", axis: "job", key: "test" },
      ],
    });
  });

  it("reads the real taxonomy: 44 labels", async () => {
    const result = await capture(["classify", "labels", "--taxonomy", REAL, "--json"]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out.join("\n")) as { labels: unknown[] }).labels).toHaveLength(44);
  });

  it("resolves a relative --taxonomy against --repo", async () => {
    const result = await capture(["classify", "labels", "--taxonomy", basename(MINI), "--repo", dirname(MINI)]);
    expect(result.code).toBe(0);
  });

  it("needs no --repo and no checkout: --repo is optional on this verb", async () => {
    expect((await capture(["classify", "labels", "--taxonomy", MINI], [], null)).code).toBe(0);
  });

  it("exits 1 on an invalid taxonomy, naming the pointer", async () => {
    const path = mutatedTaxonomy((v): void => {
      v["axes"]["lang"]["keys"][0]["description"] = "x".repeat(101);
    });
    const result = await capture(["classify", "labels", "--taxonomy", path]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/axes\.lang\.keys\[0\]\.description/);
    expect(result.out).toEqual([]);
  });

  it("exits 1 on a taxonomy file that is not there", async () => {
    const result = await capture(["classify", "labels", "--taxonomy", "/nope/none.json"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/ENOENT/);
  });

  it("exits 2 without --taxonomy", async () => {
    const result = await capture(["classify", "labels"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--taxonomy is required/);
  });
});
