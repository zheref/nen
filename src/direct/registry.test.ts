import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SchemaError } from "../schema/errors.js";
import { countRoutingCells, loadDirectRegistry, parseDirectRegistry, SHARED_CELL } from "./registry.js";
import { miniRegistryJson, REAL_REGISTRY, readJson, type Json } from "./fixtures/harness.js";

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

  it("counts 39 routed jobs and 204 cells, every entry carrying the shared cell", () => {
    expect(Object.keys(registry.routing)).toHaveLength(39);
    expect(countRoutingCells(registry)).toBe(204);
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

  it("refuses a mismatch block that is not the contract this binary implements", () => {
    for (const compares of [["surface", "tier", "effort"], ["surface", "model"], ["model", "surface", "effort"], []]) {
      expect(
        refusal((v): void => {
          v["mismatch"]["compares"] = compares;
        }).pointer,
        JSON.stringify(compares),
      ).toBe("mismatch.compares");
    }
    expect(
      refusal((v): void => {
        v["mismatch"]["ledger"] = ".nen/other/<effort>.json";
      }).pointer,
    ).toBe("mismatch.ledger");
  });

  it("refuses a non-reviewer alias without a surface or without a tier; a reviewer may have neither", () => {
    expect(
      refusal((v): void => {
        v["aliases"]["BALANCED_AUTHOR"]["surface"] = null;
      }).pointer,
    ).toBe("aliases.BALANCED_AUTHOR.surface");
    const noTier = refusal((v): void => {
      v["aliases"]["BALANCED_AUTHOR"]["tier"] = null;
    });
    expect(noTier.pointer).toBe("aliases.BALANCED_AUTHOR.tier");
    expect(noTier.message).toMatch(/Only an alias marked 'reviewer: true'/);
    // the real file's two reviewers carry neither and still load
    expect(() => loadDirectRegistry("/", REAL_REGISTRY)).not.toThrow();
  });

  it("refuses a top band that ends below the highest reachable score, naming it", () => {
    // 4 (the highest job weight) + 3 adds = 7; a top band ending at 5 leaves 6 and 7 placed nowhere
    const error = refusal((v): void => {
      v["effort"]["rule"]["bands"]["max"] = [5, 5];
    });
    expect(error.pointer).toBe("effort.rule.bands.max");
    expect(error.message).toMatch(/ends at 5, but the highest reachable score is 7/);
    // exactly the reachable maximum is enough
    expect(() =>
      refusal((v): void => {
        v["effort"]["rule"]["bands"]["max"] = [5, 7];
      }),
    ).toThrow(/expected a SchemaError, the file was accepted/);
    // another add raises the bar
    expect(
      refusal((v): void => {
        v["effort"]["rule"]["bands"]["max"] = [5, 7];
        v["effort"]["rule"]["plusOne"].push({ when: "x", key: "extra" });
      }).pointer,
    ).toBe("effort.rule.bands.max");
  });

  it("refuses a routing phaseName that differs from phases[phase].name", () => {
    const error = refusal((v): void => {
      v["routing"]["discovery"]["feature"]["phaseName"] = "A different name";
    });
    expect(error.pointer).toBe("routing.discovery.feature.phaseName");
    expect(error.message).toMatch(/phases\.FEAT\.DEV\.001\.name is/);
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

function lineAliases(value: Json): void {
  for (const [name, alias] of Object.entries(value["aliases"] as Record<string, Json>)) {
    if (alias["reviewer"] === true) continue;
    alias["line"] = name.toLowerCase();
  }
}

describe("picks.fallbackRule, escalation and the recommended condition", () => {
  it("refuses an escalation that does not name an alias, whether or not the fallback rule is declared", () => {
    const value = miniRegistryJson();
    value["aliases"]["A_TOP"]["escalation"] = "NO_SUCH_ALIAS";
    expect(() => parseDirectRegistry("/x/registry.json", value)).toThrow(/aliases\.A_TOP\.escalation/);
  });

  it("refuses an actionable alias with no line when picks.fallbackRule is declared", () => {
    const value = miniRegistryJson();
    value["picks"] = { fallbackRule: "the actionable runner-up differs in provider or surface" };
    expect(() => parseDirectRegistry("/x/registry.json", value)).toThrow(/aliases\.A_TOP\.line/);
  });

  it("refuses a cell whose actionable runner-up shares the winner's provider and surface", () => {
    const value = miniRegistryJson();
    lineAliases(value);
    value["picks"] = { fallbackRule: "the actionable runner-up differs in provider or surface" };
    expect(() => parseDirectRegistry("/x/registry.json", value)).toThrow(/routing\.plain\.dev\.cells\.\*\.runnerUp/);
  });

  it("accepts the rule once every actionable runner-up sits in another pool, and a null escalation", () => {
    const value = miniRegistryJson();
    lineAliases(value);
    value["aliases"]["A_TOP"]["escalation"] = null;
    for (const domains of Object.values(value["routing"] as Record<string, Json>)) {
      for (const entry of Object.values(domains)) {
        for (const cell of Object.values((entry as Json)["cells"] as Record<string, Json>)) {
          cell["runnerUp"] = { alias: "A_EXEC", surface: "s2", interactive: null };
        }
      }
    }
    value["picks"] = { fallbackRule: "the actionable runner-up differs in provider or surface" };
    expect(parseDirectRegistry("/x/registry.json", value).picks.fallbackRule).toMatch(/another pool|differs/);
  });

  it("refuses a recommended condition this binary does not know", () => {
    const value = miniRegistryJson();
    value["picks"] = { recommended: { when: { anyOf: [{ maxJobWeight: 4 }] }, then: "the frontier", else: "primary" } };
    expect(() => parseDirectRegistry("/x/registry.json", value)).toThrow(/picks\.recommended\.then/);
  });

  it("refuses a within set that is not the three picks once each", () => {
    const value = miniRegistryJson();
    value["mismatch"]["within"] = { set: ["primary", "primary", "fallback"] };
    expect(() => parseDirectRegistry("/x/registry.json", value)).toThrow(/mismatch\.within\.set/);
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
