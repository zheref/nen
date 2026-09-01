import { describe, expect, it } from "vitest";
import { comparePerf, comparePerfBatch, PerfCompareError } from "./perf.js";

describe("comparePerf -- QA-13's own thresholds, lower is better", () => {
  it("is ok under the 10% threshold", () => {
    expect(comparePerf("cold-launch-ms", 1000, 1050).severity).toBe("ok");
  });

  it("is high just over 10%", () => {
    const result = comparePerf("cold-launch-ms", 1000, 1101);
    expect(result.severity).toBe("high");
    expect(result.regressionPct).toBeCloseTo(10.1, 1);
  });

  it("is critical just over 25%", () => {
    expect(comparePerf("cold-launch-ms", 1000, 1260).severity).toBe("critical");
  });

  it("an improvement (lower measured) is never flagged", () => {
    expect(comparePerf("cold-launch-ms", 1000, 500).severity).toBe("ok");
  });

  it("refuses a zero baseline rather than dividing by it", () => {
    expect(() => comparePerf("x", 0, 5)).toThrow(PerfCompareError);
  });
});

describe("comparePerfBatch", () => {
  it("compares only the metrics actually measured", () => {
    const results = comparePerfBatch(
      [{ metric: "a", value: 100 }, { metric: "b", value: 200 }],
      { a: 130 },
    );
    expect(results.length).toBe(1);
    expect(results[0]?.metric).toBe("a");
    expect(results[0]?.severity).toBe("critical");
  });
});
