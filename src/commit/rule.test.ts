// src/commit/rule.test.ts -- the one subject-case tuple validator, held to the
// facts both of its callers rely on: WHERE in the tuple a fault is, and
// whether commitlint itself refuses it at load (zheref/nen#263).

import { describe, expect, it } from "vitest";
import { CONFIG_CONVENTIONAL, CONVENTIONAL_SUBJECT_CASE, parseSubjectCaseTuple } from "./rule.js";

describe("parseSubjectCaseTuple", () => {
  it("reads the three accepted shapes: [0] alone, a two-item rule, a three-item rule", () => {
    expect(parseSubjectCaseTuple([0])).toEqual({ ok: true, spec: { level: 0, when: "always", checks: [] } });
    expect(parseSubjectCaseTuple([2, "always"])).toEqual({ ok: true, spec: { level: 2, when: "always", checks: [] } });
    expect(parseSubjectCaseTuple([1, "never", "upper-case"])).toEqual({ ok: true, spec: { level: 1, when: "never", checks: [{ when: "always", case: "upper-case" }] } });
  });

  it.each([
    ["not an array", "never", "", true],
    ["a bad level", [3, "never"], "[0]", true],
    ["a wrong length", [2], "", true],
    ["a bad condition", [2, "sometimes"], "[1]", true],
    ["an unknown bare case", [2, "never", "shouty-case"], "[2]", false],
    ["an unknown listed case", [2, "never", ["lower-case", "shouty-case"]], "[2][1]", false],
  ])("points at %s, and says whether commitlint refuses it at load", (_name, value, at, refusedAtLoad) => {
    const result = parseSubjectCaseTuple(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.at).toBe(at);
      expect(result.refusedAtLoad).toBe(refusedAtLoad);
    }
  });

  it("carries config-conventional's published default under its package name", () => {
    expect(CONFIG_CONVENTIONAL).toBe("@commitlint/config-conventional");
    expect(CONVENTIONAL_SUBJECT_CASE).toEqual({
      level: 2,
      when: "never",
      checks: ["sentence-case", "start-case", "pascal-case", "upper-case"].map((name) => ({ when: "always", case: name })),
    });
  });
});
