import { describe, expect, it } from "vitest";
import { parseIzanagiInvocation } from "./izanagi.js";

describe("parseIzanagiInvocation -- the cap is required grammar, never defaulted", () => {
  it("parses task, condition and cap", () => {
    const result = parseIzanagiInvocation("retry the build until it is green up to 3");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ task: "retry the build", condition: "it is green", cap: 3 });
    }
  });

  it("refuses an invocation with no 'up to <N>' at all", () => {
    const result = parseIzanagiInvocation("retry the build until it is green");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/no 'up to <N>'/);
      expect(result.error.correctedLine).toBe("retry the build until it is green up to <N>");
    }
  });

  it("refuses a non-integer or non-positive cap", () => {
    expect(parseIzanagiInvocation("x until y up to zero").ok).toBe(false);
    expect(parseIzanagiInvocation("x until y up to 0").ok).toBe(false);
    expect(parseIzanagiInvocation("x until y up to -1").ok).toBe(false);
  });

  it("matches 'until' and 'up to' on their LAST whole-word occurrence", () => {
    // The condition itself mentions "up to" in prose; the cap clause is still
    // found correctly because it is the LAST occurrence.
    const result = parseIzanagiInvocation(
      "retry the build until it scales up to capacity up to 5",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.condition).toBe("it scales up to capacity");
      expect(result.value.cap).toBe(5);
    }
  });

  it("refuses when the task or condition is empty", () => {
    expect(parseIzanagiInvocation("until green up to 3").ok).toBe(false);
    expect(parseIzanagiInvocation("do it until  up to 3").ok).toBe(false);
  });

  it("refuses empty input", () => {
    expect(parseIzanagiInvocation("").ok).toBe(false);
  });
});
