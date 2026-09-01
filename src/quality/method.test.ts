import { describe, expect, it } from "vitest";
import { validateMethodBlock, type MethodBlock } from "./method.js";

function block(overrides: Partial<MethodBlock> = {}): MethodBlock {
  return {
    device: "iPhone 15",
    os: "iOS 18.1",
    releaseConfig: true,
    debuggerAttached: false,
    sampleSize: 5,
    firstDiscarded: true,
    median: 120,
    p90: 180,
    thermalState: "nominal",
    networkCondition: "wifi",
    ...overrides,
  };
}

describe("validateMethodBlock -- QA-15's six requirements", () => {
  it("passes a complete block", () => {
    expect(validateMethodBlock(block())).toEqual([]);
  });

  it("flags every gap at once, not just the first", () => {
    const refusals = validateMethodBlock(
      block({ device: "", releaseConfig: false, debuggerAttached: true, sampleSize: 3, firstDiscarded: false, median: null, p90: null, thermalState: null, networkCondition: null }),
    );
    expect(refusals.length).toBe(9);
  });

  it("flags a sample size under 5", () => {
    expect(validateMethodBlock(block({ sampleSize: 4 })).some((r): boolean => r.includes("minimum of 5"))).toBe(true);
  });

  it("flags a debugger attached", () => {
    expect(validateMethodBlock(block({ debuggerAttached: true })).some((r): boolean => r.includes("debugger"))).toBe(true);
  });

  it("flags a missing thermal or network condition", () => {
    expect(validateMethodBlock(block({ thermalState: "" })).length).toBeGreaterThan(0);
    expect(validateMethodBlock(block({ networkCondition: null })).length).toBeGreaterThan(0);
  });
});
