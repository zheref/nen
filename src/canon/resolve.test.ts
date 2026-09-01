import { describe, expect, it } from "vitest";
import { resolveCanon } from "./resolve.js";

describe("resolveCanon -- always-load (caller data) + exactly one derived stack path", () => {
  it("derives the stack path directly from the scenario, default leaf", () => {
    const result = resolveCanon({ scenario: "swiftui-tca-uzf-v2", alwaysLoad: [], stackDir: "handbooks/stacks" });
    expect(result.stackHandbook).toBe("handbooks/stacks/swiftui-tca-uzf-v2/architecture.md");
  });

  it("takes a caller-supplied leaf", () => {
    const result = resolveCanon({
      scenario: "compose-uzf-v2",
      alwaysLoad: [],
      stackDir: "handbooks/stacks",
      leaf: "rules/07-testing.md",
    });
    expect(result.stackHandbook).toBe("handbooks/stacks/compose-uzf-v2/rules/07-testing.md");
  });

  it("normalizes a trailing slash on stackDir", () => {
    const result = resolveCanon({ scenario: "x", alwaysLoad: [], stackDir: "handbooks/stacks/" });
    expect(result.stackHandbook).toBe("handbooks/stacks/x/architecture.md");
  });

  it("carries the always-load list through unchanged -- it is the caller's data", () => {
    const alwaysLoad = ["handbooks/a.md", "handbooks/b.md"];
    expect(resolveCanon({ scenario: "x", alwaysLoad, stackDir: "d" }).alwaysLoad).toEqual(alwaysLoad);
  });
});
