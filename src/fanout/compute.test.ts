import { describe, expect, it } from "vitest";
import { computeFanout } from "./compute.js";
import type { RepoRegistry } from "../schema/repos.js";

function registryOf(consumers: RepoRegistry["consumers"]): RepoRegistry {
  return {
    path: "schemas/repos.json",
    latest: null,
    consumers,
    productCodes: {},
    byRepo: (): undefined => undefined,
    byCode: (): undefined => undefined,
    affectedBy: (): readonly [] => [],
  };
}

describe("computeFanout", () => {
  it("marks a consumer affected when its consumes intersects the changed set", () => {
    const registry = registryOf([
      { repo: "o/a", pinned: null, consumes: ["build.yml"], scenario: null, phases: [], auth: null, notes: null, code: "A", callerPins: {} },
    ]);
    const rows = computeFanout(registry, ["build.yml"]);
    expect(rows).toEqual([
      { repo: "o/a", code: "A", status: "affected", matchedWorkflows: ["build.yml"], basis: expect.stringContaining("build.yml") },
    ]);
  });

  it("gives every unaffected consumer an EXPLICIT n/a row with a basis", () => {
    const registry = registryOf([
      { repo: "o/b", pinned: null, consumes: ["other.yml"], scenario: null, phases: [], auth: null, notes: null, code: "B", callerPins: {} },
    ]);
    const rows = computeFanout(registry, ["build.yml"]);
    expect(rows[0]?.status).toBe("n/a");
    expect(rows[0]?.basis).toContain("other.yml");
  });

  it("names a consumer with no consumed workflows explicitly", () => {
    const registry = registryOf([
      { repo: "o/c", pinned: null, consumes: [], scenario: null, phases: [], auth: null, notes: null, code: null, callerPins: {} },
    ]);
    expect(computeFanout(registry, ["build.yml"])[0]?.basis).toMatch(/declares no consumed workflows/);
  });
});
