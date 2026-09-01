import { describe, expect, it } from "vitest";
import { resolveCanon } from "./resolve.js";

const ALWAYS_LOAD = ["handbooks/a.md", "handbooks/b.md"];

describe("resolveCanon -- always-load (caller data) + exactly one derived stack path", () => {
  it("derives the stack path directly from the scenario, default leaf", () => {
    const result = resolveCanon({ scenario: "swiftui-tca-uzf-v2", alwaysLoad: ALWAYS_LOAD, stackDir: "handbooks/stacks" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stackHandbook).toBe("handbooks/stacks/swiftui-tca-uzf-v2/architecture.md");
  });

  it("takes a caller-supplied leaf", () => {
    const result = resolveCanon({
      scenario: "compose-uzf-v2",
      alwaysLoad: ALWAYS_LOAD,
      stackDir: "handbooks/stacks",
      leaf: "rules/07-testing.md",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stackHandbook).toBe("handbooks/stacks/compose-uzf-v2/rules/07-testing.md");
  });

  it("normalizes a trailing slash on stackDir", () => {
    const result = resolveCanon({ scenario: "x", alwaysLoad: ALWAYS_LOAD, stackDir: "handbooks/stacks/" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stackHandbook).toBe("handbooks/stacks/x/architecture.md");
  });

  it("carries the always-load list through unchanged -- it is the caller's data", () => {
    const result = resolveCanon({ scenario: "x", alwaysLoad: ALWAYS_LOAD, stackDir: "d" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.alwaysLoad).toEqual(ALWAYS_LOAD);
  });

  // Review finding #19: an empty --always-load used to resolve silently
  // ("this repository loads nothing unconditionally") instead of refusing.
  it("refuses an empty always-load list rather than silently resolving 'nothing unconditionally'", () => {
    const result = resolveCanon({ scenario: "x", alwaysLoad: [], stackDir: "d" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/named no paths/);
  });

  it("refuses an empty scenario", () => {
    const result = resolveCanon({ scenario: "", alwaysLoad: ALWAYS_LOAD, stackDir: "d" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a plain token/);
  });

  it("refuses '.' and '..' as a scenario", () => {
    expect(resolveCanon({ scenario: ".", alwaysLoad: ALWAYS_LOAD, stackDir: "d" }).ok).toBe(false);
    expect(resolveCanon({ scenario: "..", alwaysLoad: ALWAYS_LOAD, stackDir: "d" }).ok).toBe(false);
  });

  it("refuses a scenario containing a forward slash, which would traverse outside --stack-dir", () => {
    const result = resolveCanon({ scenario: "../../etc", alwaysLoad: ALWAYS_LOAD, stackDir: "d" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a plain token/);
  });

  // Review finding: the guard only rejected '/', but on Windows '\' is also a
  // path separator, and `scenario` is loaded as an unconstrained string from
  // JSON -- so a value like '..\..\etc' used to pass and derive a path that
  // escapes --stack-dir once used with filesystem APIs.
  it("refuses a scenario containing a backslash, Windows' own path separator", () => {
    const result = resolveCanon({ scenario: "..\\..\\etc", alwaysLoad: ALWAYS_LOAD, stackDir: "d" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a plain token/);
  });

  it("refuses a scenario that is a single backslash-separated segment with no leading dots", () => {
    expect(resolveCanon({ scenario: "a\\b", alwaysLoad: ALWAYS_LOAD, stackDir: "d" }).ok).toBe(false);
  });

  it("refuses a scenario starting or ending with '.', '_' or '-' even without a separator", () => {
    expect(resolveCanon({ scenario: ".hidden", alwaysLoad: ALWAYS_LOAD, stackDir: "d" }).ok).toBe(false);
    expect(resolveCanon({ scenario: "trailing.", alwaysLoad: ALWAYS_LOAD, stackDir: "d" }).ok).toBe(false);
    expect(resolveCanon({ scenario: "-leading", alwaysLoad: ALWAYS_LOAD, stackDir: "d" }).ok).toBe(false);
  });

  it("accepts a plain token scenario with interior dots, underscores and hyphens", () => {
    const result = resolveCanon({ scenario: "swiftui_tca.v2-beta", alwaysLoad: ALWAYS_LOAD, stackDir: "d" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stackHandbook).toBe("d/swiftui_tca.v2-beta/architecture.md");
  });
});
