import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SchemaError } from "../schema/errors.js";
import { countRoutingCells, loadDirectRegistry, parseDirectRegistry, SHARED_CELL } from "./registry.js";
import { REAL_REGISTRY, readJson, type Json } from "./fixtures/harness.js";

function refusal(edit: (value: Json) => void): SchemaError {
  const value = readJson(REAL_REGISTRY);
  edit(value);
  try {
    parseDirectRegistry("/x/registry.json", value);
  } catch (error) {
    if (error instanceof SchemaError) return error;
    throw error;
  }
  throw new Error("expected a SchemaError, the file was accepted");
}

describe("parseDirectRegistry -- the real file", () => {
  const registry = loadDirectRegistry("/", REAL_REGISTRY);

  it("reads the snapshot date, the aliases, the surfaces and the live-lookup sources", () => {
    expect(registry.snapshot.asOf).toBe("2026-10-04");
    expect(Object.keys(registry.aliases)).toHaveLength(10);
    expect(Object.keys(registry.snapshot.aliases)).toHaveLength(10);
    expect(Object.keys(registry.surfaces)).toHaveLength(4);
    expect(registry.surfaces["claude-code"]?.modelsKey).toBe("claude");
    expect(registry.liveLookup["openai"]?.cli).toBe("codex debug models");
    expect(registry.liveLookup["google"]?.cli).toBeNull();
  });

  it("reads the effort ladder: four levels, partitioned bands, a row per surface", () => {
    expect(registry.effort.levels).toEqual(["low", "medium", "high", "max"]);
    expect(registry.effort.rule.bands["max"]).toEqual([5, 99]);
    expect(registry.effort.rule.plusOne.map((add): string | number | null => add.threshold)).toEqual([3, 2, null]);
    expect(Object.keys(registry.effort.surfaceMap).sort()).toEqual(Object.keys(registry.surfaces).sort());
  });

  it("ranks every alias once, and marks the reviewers", () => {
    expect([...registry.precedence].sort()).toEqual(Object.keys(registry.aliases).sort());
    expect(Object.entries(registry.aliases).filter(([, alias]): boolean => alias.reviewer)).toHaveLength(2);
  });

  it("counts 39 routed jobs and 167 cells, every entry carrying the shared cell", () => {
    expect(Object.keys(registry.routing)).toHaveLength(39);
    expect(countRoutingCells(registry)).toBe(167);
    for (const domains of Object.values(registry.routing)) {
      for (const entry of Object.values(domains)) expect(entry.cells[SHARED_CELL]).toBeDefined();
    }
  });

  it("keeps a reviewer cell's substitute and a null surface", () => {
    const reviewCell = registry.routing["review"]?.["maintenance"]?.cells[SHARED_CELL];
    expect(reviewCell?.runnerUp.surface).toBeNull();
    expect(reviewCell?.runnerUp.also).not.toBeNull();
  });

  it("resolves a relative path against the repository root, not the process directory", () => {
    expect(loadDirectRegistry(join(REAL_REGISTRY, ".."), basename(REAL_REGISTRY)).path).toBe(REAL_REGISTRY);
  });
});

describe("parseDirectRegistry -- every refusal names its pointer", () => {
  it("refuses a routing cell whose alias is not declared", () => {
    const error = refusal((v): void => {
      v["routing"]["discovery"]["feature"]["cells"]["*"]["winner"]["alias"] = "NO_SUCH_ALIAS";
    });
    expect(error.pointer).toBe("routing.discovery.feature.cells.*.winner.alias");
    expect(error.message).toMatch(/not one of aliases/);
  });

  it("refuses a cell's runnerUp alias, and a substitute alias, that are not declared", () => {
    expect(
      refusal((v): void => {
        v["routing"]["discovery"]["feature"]["cells"]["*"]["runnerUp"]["alias"] = "NO_SUCH_ALIAS";
      }).pointer,
    ).toBe("routing.discovery.feature.cells.*.runnerUp.alias");
    expect(
      refusal((v): void => {
        v["routing"]["review"]["maintenance"]["cells"]["*"]["runnerUp"]["also"] = "NO_SUCH_ALIAS";
      }).pointer,
    ).toBe("routing.review.maintenance.cells.*.runnerUp.also");
  });

  it("refuses a cell or alias surface the registry does not declare", () => {
    expect(
      refusal((v): void => {
        v["routing"]["discovery"]["feature"]["cells"]["*"]["winner"]["surface"] = "nowhere";
      }).pointer,
    ).toBe("routing.discovery.feature.cells.*.winner.surface");
    expect(
      refusal((v): void => {
        v["aliases"]["SEMANTIC_FRONTIER"]["surface"] = "nowhere";
      }).pointer,
    ).toBe("aliases.SEMANTIC_FRONTIER.surface");
  });

  it("refuses a cell whose surface is not its alias's surface, in either direction", () => {
    const moved = refusal((v): void => {
      v["routing"]["discovery"]["feature"]["cells"]["*"]["winner"]["surface"] = "codex";
    });
    expect(moved.pointer).toBe("routing.discovery.feature.cells.*.winner.surface");
    expect(moved.message).toMatch(/must equal its alias's surface/);
    expect(
      refusal((v): void => {
        v["routing"]["discovery"]["feature"]["cells"]["*"]["runnerUp"]["surface"] = null;
      }).pointer,
    ).toBe("routing.discovery.feature.cells.*.runnerUp.surface");
  });

  it("refuses a reviewer runner-up with no stand-in, and a stand-in that is itself a reviewer", () => {
    expect(
      refusal((v): void => {
        delete v["routing"]["review"]["maintenance"]["cells"]["*"]["runnerUp"]["also"];
      }).pointer,
    ).toBe("routing.review.maintenance.cells.*.runnerUp.also");
    expect(
      refusal((v): void => {
        v["routing"]["review"]["maintenance"]["cells"]["*"]["runnerUp"]["also"] = "PR_SECURITY_REVIEW";
      }).message,
    ).toMatch(/names reviewer alias/);
  });

  it("refuses a domain add that names a domain on a count add", () => {
    expect(
      refusal((v): void => {
        v["effort"]["rule"]["plusOne"][0]["domain"] = "x";
      }).pointer,
    ).toBe("effort.rule.plusOne[0].domain");
  });

  it("skips every $-prefixed key it walks: a metadata key is never an alias, surface, domain or row", () => {
    const value = readJson(REAL_REGISTRY);
    value["aliases"]["$note"] = "ignored";
    value["surfaces"]["$note"] = "ignored";
    value["effort"]["surfaceMap"]["$note"] = "ignored";
    value["routing"]["$note"] = "ignored";
    value["routing"]["discovery"]["$note"] = "ignored";
    value["routing"]["discovery"]["feature"]["cells"]["$note"] = "ignored";
    value["nativeInteractive"]["$note"] = "ignored";
    value["phases"]["$note"] = "ignored";
    value["effort"]["rule"]["bands"]["$note"] = "ignored";
    const registry = parseDirectRegistry("/x/registry.json", value);
    expect(Object.keys(registry.surfaces)).toHaveLength(4);
    expect(Object.keys(registry.aliases)).toHaveLength(10);
    expect(Object.keys(registry.effort.surfaceMap)).toHaveLength(4);
    expect(Object.keys(registry.routing)).toHaveLength(39);
    expect(Object.keys(registry.routing["discovery"]?.["feature"]?.cells ?? {})).toEqual(["*"]);
  });

  it("refuses a surface whose modelsKey is not a string", () => {
    const error = refusal((v): void => {
      v["surfaces"]["codex"]["modelsKey"] = 7;
    });
    expect(error.pointer).toBe("surfaces.codex.modelsKey");
  });

  it("refuses an effort block that does not have four levels, or whose surface map misses one", () => {
    expect(
      refusal((v): void => {
        v["effort"]["levels"] = ["low", "medium", "high"];
      }).pointer,
    ).toBe("effort.levels");
    expect(
      refusal((v): void => {
        delete v["effort"]["surfaceMap"]["codex"]["max"];
      }).pointer,
    ).toBe("effort.surfaceMap.codex.max");
    expect(
      refusal((v): void => {
        delete v["effort"]["surfaceMap"]["cursor"];
      }).pointer,
    ).toBe("effort.surfaceMap.cursor");
  });

  it("refuses bands that leave a gap, overlap, or are not a pair", () => {
    expect(
      refusal((v): void => {
        v["effort"]["rule"]["bands"]["medium"] = [4, 4];
      }).pointer,
    ).toBe("effort.rule.bands.medium");
    expect(
      refusal((v): void => {
        v["effort"]["rule"]["bands"]["high"] = [3, 4];
      }).pointer,
    ).toBe("effort.rule.bands.high");
    expect(
      refusal((v): void => {
        v["effort"]["rule"]["bands"]["low"] = [0];
      }).pointer,
    ).toBe("effort.rule.bands.low");
    expect(
      refusal((v): void => {
        delete v["effort"]["rule"]["bands"]["max"];
      }).pointer,
    ).toBe("effort.rule.bands.max");
  });

  it("refuses a count add with no threshold, and a threshold on a domain add", () => {
    expect(
      refusal((v): void => {
        delete v["effort"]["rule"]["plusOne"][0]["threshold"];
      }).pointer,
    ).toBe("effort.rule.plusOne[0].threshold");
    expect(
      refusal((v): void => {
        v["effort"]["rule"]["plusOne"][2]["threshold"] = 1;
      }).pointer,
    ).toBe("effort.rule.plusOne[2].threshold");
  });

  it("refuses a precedence that misses, repeats or invents an alias", () => {
    const missing = refusal((v): void => {
      v["aggregation"]["precedence"].pop();
    });
    expect(missing.pointer).toBe("aggregation.precedence");
    expect(missing.message).toMatch(/does not rank alias PR_SECURITY_REVIEW/);
    expect(
      refusal((v): void => {
        v["aggregation"]["precedence"][1] = v["aggregation"]["precedence"][0];
      }).pointer,
    ).toBe("aggregation.precedence[1]");
    expect(
      refusal((v): void => {
        v["aggregation"]["precedence"][0] = "NO_SUCH_ALIAS";
      }).pointer,
    ).toBe("aggregation.precedence[0]");
  });

  it("refuses a snapshot date that is not a calendar date", () => {
    for (const asOf of ["2026-13-01", "2026-02-30", "yesterday", "2026-1-1"]) {
      const error = refusal((v): void => {
        v["snapshot"]["asOf"] = asOf;
      });
      expect(error.pointer).toBe("snapshot.asOf");
    }
  });

  it("refuses a snapshot row for an alias the registry lacks", () => {
    const error = refusal((v): void => {
      v["snapshot"]["aliases"]["GHOST"] = { primary: "a", modelId: null, fallback: "b" };
    });
    expect(error.pointer).toBe("snapshot.aliases.GHOST");
  });

  it("refuses a routing entry without the shared cell, a phase that is not declared, a job with no domain", () => {
    expect(
      refusal((v): void => {
        delete v["routing"]["discovery"]["feature"]["cells"]["*"];
      }).pointer,
    ).toBe("routing.discovery.feature.cells.*");
    expect(
      refusal((v): void => {
        v["routing"]["discovery"]["feature"]["phase"] = "NO.PHASE.000";
      }).pointer,
    ).toBe("routing.discovery.feature.phase");
    expect(
      refusal((v): void => {
        v["routing"]["discovery"] = {};
      }).pointer,
    ).toBe("routing.discovery");
  });

  it("refuses a file that is not a v1 direct-registry contract", () => {
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

  it("names the path it was reading in every message", () => {
    expect(
      refusal((v): void => {
        delete v["aliases"];
      }).message,
    ).toContain("/x/registry.json");
  });
});

describe("loadDirectRegistry -- the file itself", () => {
  it("refuses a missing file and invalid JSON by path", () => {
    expect(() => loadDirectRegistry("/", "/nope/none.json")).toThrow(/could not be read \(ENOENT\)/);
    const dir = mkdtempSync(join(tmpdir(), "nen-direct-bad-"));
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => loadDirectRegistry(dir, "bad.json")).toThrow(/is not valid JSON/);
  });
});
