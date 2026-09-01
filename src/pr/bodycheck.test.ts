import { describe, expect, it } from "vitest";
import { BodyCheckError, checkBody } from "./bodycheck.js";

describe("checkBody", () => {
  it("checks every requirement, never stopping at the first miss", () => {
    const report = checkBody("## Summary\nsomething", [
      { name: "summary", pattern: "^## Summary" },
      { name: "test-plan", pattern: "^## Test plan" },
    ]);
    expect(report.results).toHaveLength(2);
    expect(report.results[0]?.satisfied).toBe(true);
    expect(report.results[1]?.satisfied).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("is ok when every requirement is satisfied", () => {
    const report = checkBody("## Summary\n## Test plan\n", [
      { name: "summary", pattern: "## Summary" },
      { name: "test-plan", pattern: "## Test plan" },
    ]);
    expect(report.ok).toBe(true);
  });

  it("throws BodyCheckError for an unparseable pattern", () => {
    expect(() => checkBody("x", [{ name: "bad", pattern: "(" }])).toThrow(BodyCheckError);
  });

  it("refuses an EMPTY requirement list rather than reporting a vacuous pass (review finding)", () => {
    // `[].every(...)` is `true` -- an empty requirements file must never read
    // as "every requirement satisfied".
    expect(() => checkBody("anything at all", [])).toThrow(BodyCheckError);
    expect(() => checkBody("anything at all", [])).toThrow(/empty/);
  });

  it("refuses a requirement missing a string name or pattern", () => {
    expect(() => checkBody("x", [{ name: "", pattern: "x" } as never])).toThrow(BodyCheckError);
    expect(() => checkBody("x", [{ name: "ok", pattern: undefined } as never])).toThrow(BodyCheckError);
  });
});
