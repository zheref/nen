import { describe, expect, it } from "vitest";
import { resolveScenario } from "./scenario.js";
import { parseRepoRegistry } from "../schema/repos.js";

const REGISTRY = parseRepoRegistry("/x/schemas/repos.json", {
  latest: "v1.0.0",
  consumers: [{ repo: "zheref/KroApple", consumes: [], scenario: "swiftui-tca-uzf-v2" }, { repo: "zheref/KroAndroid", consumes: [] }],
  product_codes: {},
});

describe("resolveScenario -- a lookup, with the two gaps told apart", () => {
  it("reads the scenario recorded for a known consumer", () => {
    expect(resolveScenario(REGISTRY, "zheref/KroApple")).toEqual({ ok: true, scenario: "swiftui-tca-uzf-v2" });
  });

  it("names an unrecorded consumer distinctly from a recorded one with no scenario", () => {
    const noScenario = resolveScenario(REGISTRY, "zheref/KroAndroid");
    expect(noScenario.ok).toBe(false);
    if (!noScenario.ok) expect(noScenario.reason).toMatch(/carries no 'scenario'/);

    const notAConsumer = resolveScenario(REGISTRY, "zheref/unknown");
    expect(notAConsumer.ok).toBe(false);
    if (!notAConsumer.ok) expect(notAConsumer.reason).toMatch(/is not a consumer/);
  });
});
