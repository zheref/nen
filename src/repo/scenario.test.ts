import { describe, expect, it } from "vitest";
import { resolveScenario } from "./scenario.js";
import { parseRepoRegistry } from "../schema/repos.js";

// One registry that records repositories in every place the file can: a
// consumer with a scenario, a consumer without one, a maintained tool, a
// pending onboarding, and the registry's own repo as a bare product-code
// value -- so each of the three refusal causes (zheref/nen#28) has a subject.
const REGISTRY = parseRepoRegistry("/x/schemas/repos.json", {
  latest: "v1.0.0",
  consumers: [
    { repo: "zheref/KroApple", consumes: [], scenario: "swiftui-tca-uzf-v2" },
    { repo: "zheref/KroAndroid", consumes: [] },
  ],
  maintained_tools: [{ repo: "zheref/tooling" }],
  pending_onboarding: [{ repo: "zheref/KroCloud" }],
  product_codes: { BC: "bankai-core" },
});

describe("resolveScenario -- a lookup, with the three gaps told apart (zheref/nen#28)", () => {
  it("reads the scenario recorded for a known consumer", () => {
    expect(resolveScenario(REGISTRY, "zheref/KroApple")).toEqual({ ok: true, scenario: "swiftui-tca-uzf-v2" });
  });

  it("names a consumer with no 'scenario' field as exactly that", () => {
    const noScenario = resolveScenario(REGISTRY, "zheref/KroAndroid");
    expect(noScenario.ok).toBe(false);
    if (!noScenario.ok) expect(noScenario.reason).toMatch(/is a consumer .* carries no 'scenario' field/);
  });

  it("names a repo the file records NOWHERE distinctly, listing where it looked", () => {
    const unknown = resolveScenario(REGISTRY, "zheref/unknown");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.reason).toMatch(/is not recorded anywhere/);
      expect(unknown.reason).toMatch(/maintained tool/);
    }
  });

  // The conflation the issue confirmed live: these three used to produce the
  // BYTE-IDENTICAL "not a consumer ... does not know it" refusal a genuinely
  // unrecorded repo gets, even though the file plainly records each of them
  // (./resolve.ts's rule 5 widening, zheref/nen#27).
  it("a pending_onboarding listing is 'recorded, but not a consumer' -- never 'not known'", () => {
    const pending = resolveScenario(REGISTRY, "zheref/KroCloud");
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.reason).toMatch(/is recorded in .*under 'pending_onboarding'/);
      expect(pending.reason).toMatch(/only a consumers\[\] entry carries a 'scenario'/);
      expect(pending.reason).not.toMatch(/does not know it/);
    }
  });

  it("a maintained_tools listing reports its own section", () => {
    const tool = resolveScenario(REGISTRY, "zheref/tooling");
    expect(tool.ok).toBe(false);
    if (!tool.ok) expect(tool.reason).toMatch(/under 'maintained_tools'/);
  });

  it("the registry's own repo -- a bare product-code value -- names the code that records it", () => {
    const own = resolveScenario(REGISTRY, "zheref/bankai-core");
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.reason).toMatch(/as product code 'BC' \('bankai-core'\)/);
  });
});
