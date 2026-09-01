import { describe, expect, it } from "vitest";
import { derive, GateError, matchesPattern } from "./derive.js";

describe("matchesPattern", () => {
  it("matches an exact path", () => {
    expect(matchesPattern("CONSTITUTION.md", "CONSTITUTION.md")).toBe(true);
    expect(matchesPattern("other.md", "CONSTITUTION.md")).toBe(false);
  });

  it("matches a directory prefix ending '/', at any depth", () => {
    expect(matchesPattern("handbooks/a/b.md", "handbooks/")).toBe(true);
    expect(matchesPattern("handbooksx/a.md", "handbooks/")).toBe(false);
  });

  it("matches a glob whose '*' CROSSES '/' -- the shell's own semantics", () => {
    expect(matchesPattern("handbooks/a/b.md", "handbooks/*")).toBe(true);
    expect(matchesPattern("handbooks/a.md", "handbooks/*")).toBe(true);
  });
});

describe("derive", () => {
  const sets = { policy: ["CONSTITUTION.md", "schemas/*"], process: [".github/workflows/*"] };

  it("derives G4 for a policy-path hit", () => {
    const result = derive(["CONSTITUTION.md"], sets);
    expect(result.gate).toBe("G4");
    expect(result.basis).toMatch(/policy\/spec/);
  });

  it("derives G4 for a process-surface hit, with a DIFFERENT basis", () => {
    const result = derive([".github/workflows/ci.yml"], sets);
    expect(result.gate).toBe("G4");
    expect(result.basis).toMatch(/process surface/);
  });

  it("derives G2 when neither set is touched", () => {
    const result = derive(["src/a.ts"], sets);
    expect(result.gate).toBe("G2");
  });

  it("reports a correction when the asserted gate disagrees, and the DERIVED gate stands", () => {
    const result = derive(["CONSTITUTION.md"], sets, "G2");
    expect(result.gate).toBe("G4");
    expect(result.corrected).toBe(true);
    expect(result.asserted).toBe("G2");
  });

  it("reports no correction when the assertion agrees", () => {
    const result = derive(["src/a.ts"], sets, "G2");
    expect(result.corrected).toBe(false);
  });

  it("refuses when BOTH path sets are empty -- no default set is carried", () => {
    expect(() => derive(["x"], { policy: [], process: [] })).toThrow(GateError);
  });

  it("always carries the readiness note: this is the diff's half only", () => {
    expect(derive(["x"], sets).readinessNote).toMatch(/NO GATE/);
  });
});
