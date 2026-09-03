import { describe, expect, it } from "vitest";
import { FutonResolveError, parseFutonInvocation, resolveFutonRepo, type RepoResolver } from "./futon.js";

describe("parseFutonInvocation -- resolve or refuse, never guess", () => {
  it("parses a bare severity, case-insensitively", () => {
    const result = parseFutonInvocation("BC@HIGH");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        repoToken: "BC",
        band: { severity: "high", plus: false, severities: ["high"] },
        terminal: null,
      });
    }
  });

  it("expands '+' to this band and everything more severe", () => {
    const result = parseFutonInvocation("bc@high+");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.band.severities).toEqual(["critical", "high"]);
  });

  it("a bare severity never sweeps up the highs", () => {
    const result = parseFutonInvocation("bc@medium");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.band.severities).toEqual(["medium"]);
  });

  it("reads the terminal from the LAST whole-word 'then'", () => {
    const result = parseFutonInvocation("bc@high then tag");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.terminal).toBe("tag");
  });

  it("accepts tag+fanout", () => {
    const result = parseFutonInvocation("bc@high+ then tag+fanout");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.terminal).toBe("tag+fanout");
  });

  it("omitting the repo token means 'the repo you are standing in'", () => {
    const result = parseFutonInvocation("@critical");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.repoToken).toBeNull();
  });

  it("refuses an invocation with no '@'", () => {
    const result = parseFutonInvocation("bc high");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/no '@<severity>'/);
  });

  it("refuses an unknown severity, offering a corrected line", () => {
    const result = parseFutonInvocation("bc@urgent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/is not a severity/);
      expect(result.error.correctedLine).toMatch(/^bc@critical$/);
    }
  });

  it("refuses an unrecognized terminal, offering the build-only line", () => {
    const result = parseFutonInvocation("bc@high then ship-it");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.correctedLine).toBe("bc@high then tag");
  });

  it("refuses empty input", () => {
    expect(parseFutonInvocation("   ").ok).toBe(false);
  });
});

const REGISTRY: RepoResolver = {
  productCodes: { BC: "bankai-core", KP: "KroApple", KN: "KroAndroid" },
  maintainedTools: [],
  pendingOnboarding: [],
  byCode: (code): { repo: string; code: string | null } | undefined =>
    code === "KP" ? { repo: "zheref/KroApple", code: "KP" } : undefined,
  byRepo: (repo): { repo: string; code: string | null } | undefined =>
    repo === "zheref/KroApple" ? { repo: "zheref/KroApple", code: "KP" } : undefined,
};

describe("resolveFutonRepo -- resolve or refuse, never a prefix match", () => {
  it("resolves a known consumer code", () => {
    const resolved = resolveFutonRepo(REGISTRY, "KP", "zheref/bankai-core");
    expect(resolved).toEqual({ slug: "zheref/KroApple", code: "KP", isSelf: false });
  });

  it("resolves the registry's OWN code by tail-matching the current checkout", () => {
    const resolved = resolveFutonRepo(REGISTRY, "BC", "zheref/bankai-core");
    expect(resolved).toEqual({ slug: "zheref/bankai-core", code: "BC", isSelf: true });
  });

  it("refuses the registry's own code when standing in a different checkout", () => {
    expect(() => resolveFutonRepo(REGISTRY, "BC", "zheref/KroApple")).toThrow(FutonResolveError);
  });

  it("a null token (no repo given) means the current checkout, always self", () => {
    expect(resolveFutonRepo(REGISTRY, null, "zheref/bankai-core")).toEqual({
      slug: "zheref/bankai-core",
      code: null,
      isSelf: true,
    });
  });

  it("refuses an unresolved token rather than a near-match guess", () => {
    expect(() => resolveFutonRepo(REGISTRY, "Kro", "zheref/bankai-core")).toThrow(/does not resolve/);
  });
});

// zheref/nen#27: the code-token lookup consults ALL of what the file records --
// slug-shaped product_codes values, and the maintained_tools/pending_onboarding
// lists -- never just consumers[]. The widening is in WHERE a code resolves
// from; the last test pins that a genuine miss is still a refusal.
describe("resolveFutonRepo -- product_codes values and the onboarding lists (zheref/nen#27)", () => {
  it("resolves a slug-valued own code from its own checkout -- the registry standing in itself is not 'not it'", () => {
    const reg: RepoResolver = { ...REGISTRY, productCodes: { BC: "zheref/bankai-core" } };
    expect(resolveFutonRepo(reg, "BC", "zheref/bankai-core")).toEqual({
      slug: "zheref/bankai-core",
      code: "BC",
      isSelf: true,
    });
  });

  it("resolves a slug-valued code from ANY checkout -- the value records the owner, so nothing is guessed", () => {
    const reg: RepoResolver = { ...REGISTRY, productCodes: { BC: "zheref/bankai-core" } };
    expect(resolveFutonRepo(reg, "bc", "zheref/KroApple")).toEqual({
      slug: "zheref/bankai-core",
      code: "BC",
      isSelf: false,
    });
  });

  it("resolves a bare-valued code whose owner pending_onboarding records -- the KC case", () => {
    const reg: RepoResolver = {
      ...REGISTRY,
      productCodes: { ...REGISTRY.productCodes, KC: "KroCloud" },
      pendingOnboarding: ["zheref/KroCloud"],
    };
    expect(resolveFutonRepo(reg, "KC", "zheref/bankai-core")).toEqual({
      slug: "zheref/KroCloud",
      code: "KC",
      isSelf: false,
    });
  });

  it("resolves a bare-valued code whose owner maintained_tools records", () => {
    const reg: RepoResolver = {
      ...REGISTRY,
      productCodes: { ...REGISTRY.productCodes, BS: "bankai-scaffold" },
      maintainedTools: ["zheref/bankai-scaffold"],
    };
    expect(resolveFutonRepo(reg, "bs", "zheref/bankai-core")).toEqual({
      slug: "zheref/bankai-scaffold",
      code: "BS",
      isSelf: false,
    });
  });

  it("resolves a full slug listed only under pending_onboarding, with the code its bare value assigns", () => {
    const reg: RepoResolver = {
      ...REGISTRY,
      productCodes: { ...REGISTRY.productCodes, KC: "KroCloud" },
      pendingOnboarding: ["zheref/KroCloud"],
    };
    expect(resolveFutonRepo(reg, "zheref/KroCloud", "zheref/bankai-core")).toEqual({
      slug: "zheref/KroCloud",
      code: "KC",
      isSelf: false,
    });
  });

  it("a listed slug takes the code whose value records it EXACTLY, not an earlier bare value's tail", () => {
    // Both a bare 'KroCloud' and a full 'zheref/KroCloud' are recorded, bare
    // first. The bare value states no owner -- it may name a different
    // owner's KroCloud entirely -- so the value that spells this slug out in
    // full is the file's own answer, and file order must not overrule it.
    const reg: RepoResolver = {
      ...REGISTRY,
      productCodes: { ...REGISTRY.productCodes, KC: "KroCloud", KX: "zheref/KroCloud" },
      pendingOnboarding: ["zheref/KroCloud"],
    };
    expect(resolveFutonRepo(reg, "zheref/KroCloud", "zheref/bankai-core")).toEqual({
      slug: "zheref/KroCloud",
      code: "KX",
      isSelf: false,
    });
  });

  it("STILL refuses a bare-valued code with no recorded owner from a different checkout -- error, not fallback", () => {
    const reg: RepoResolver = {
      ...REGISTRY,
      pendingOnboarding: ["zheref/KroCloud"],
      maintainedTools: ["zheref/bankai-scaffold"],
    };
    expect(() => resolveFutonRepo(reg, "BC", "zheref/KroApple")).toThrow(FutonResolveError);
    expect(() => resolveFutonRepo(reg, "BC", "zheref/KroApple")).toThrow(/no owner is recorded/);
  });
});
