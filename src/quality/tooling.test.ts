import { describe, expect, it } from "vitest";
import { parseToolingTable, resolveTooling } from "./tooling.js";

const TABLE_JSON = JSON.stringify({
  "swiftui-tca-uzf-v2": { e2e: "XCUITest", adversarial: "swift-testing", notUsed: ["Appium", "Selenium"] },
});

describe("parseToolingTable", () => {
  it("parses a well-formed object", () => {
    expect(Object.keys(parseToolingTable(TABLE_JSON))).toEqual(["swiftui-tca-uzf-v2"]);
  });

  it("refuses an array or a scalar", () => {
    expect(() => parseToolingTable("[]")).toThrow();
    expect(() => parseToolingTable("1")).toThrow();
  });
});

describe("resolveTooling -- a lookup, never a table baked into this binary", () => {
  it("resolves a known scenario, defaulting absent fields", () => {
    const table = parseToolingTable(TABLE_JSON);
    const result = resolveTooling(table, "swiftui-tca-uzf-v2");
    expect(result.ok).toBe(true);
    expect(result.tooling).toEqual({
      e2e: "XCUITest",
      adversarial: "swift-testing",
      notUsed: ["Appium", "Selenium"],
      perfHarness: null,
      perfDiagnosis: null,
    });
  });

  it("refuses an unknown scenario, naming the ones it does know", () => {
    const table = parseToolingTable(TABLE_JSON);
    const result = resolveTooling(table, "unknown-scenario");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/swiftui-tca-uzf-v2/);
  });
});
