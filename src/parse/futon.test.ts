import { describe, expect, it } from "vitest";
import { FutonResolveError, parseFutonInvocation, resolveFutonRepo, type RepoResolver } from "./futon.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";

describe("parseFutonInvocation -- resolve or refuse, never guess", () => {
  it("parses a bare severity, case-insensitively", () => {
    const result = parseFutonInvocation("BC@HIGH");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        repoToken: "BC",
        band: { severity: "high", plus: false, severities: ["high"] },
        label: null,
        terminal: null,
        then: null,
      });
    }
  });

  it("expands '+' to this band and everything more severe", () => {
    const result = parseFutonInvocation("bc@high+");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.band?.severities).toEqual(["critical", "high"]);
  });

  it("a bare severity never sweeps up the highs", () => {
    const result = parseFutonInvocation("bc@medium");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.band?.severities).toEqual(["medium"]);
  });

  it("reads the terminal from the whole-word 'then'", () => {
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

  it("reads any non-severity token as an exact label, never expanded", () => {
    const result = parseFutonInvocation("bc@bug then tag");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ repoToken: "bc", band: null, label: "bug", terminal: "tag", then: { kind: "terminal", terminal: "tag" } });
    }
  });

  it("keeps a label's case and spaces, stripping surrounding quotes", () => {
    const result = parseFutonInvocation('@"Good First Issue"');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.label).toBe("Good First Issue");
  });

  it("preserves boundary spaces inside a quoted selector", () => {
    const result = parseFutonInvocation('@" bug "');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.label).toBe(" bug ");
  });

  it("still trims an unquoted selector", () => {
    const result = parseFutonInvocation("bc@ bug ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.label).toBe("bug");
  });

  it("keeps a trailing '+' as part of the label when the token before it is not a severity (F6)", () => {
    const result = parseFutonInvocation("bc@c++");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.band).toBeNull();
      expect(result.value.label).toBe("c++");
    }
  });

  it("refuses an empty selector, offering a corrected line", () => {
    const result = parseFutonInvocation("bc@");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.correctedLine).toBe("bc@critical");
  });

  it("classifies kebab tokens after 'then' as a skill chain", () => {
    const result = parseFutonInvocation("hatsu@bug then hatsu:getsuga+kagutsuchi@testflight+mugetsu@github");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.terminal).toBeNull();
      expect(result.value.then).toEqual({
        kind: "skills",
        steps: [
          { skill: "hatsu:getsuga", target: null },
          { skill: "kagutsuchi", target: "testflight" },
          { skill: "mugetsu", target: "github" },
        ],
      });
    }
  });

  // F3: 'tag'/'fanout' are the terminal's own vocabulary and are reserved as
  // chain step names -- a chain naming either alongside other steps escapes
  // the terminal's self-repo rule and must be refused, not silently chained.
  it("refuses 'tag' inside a multi-step chain, suggesting the bare terminal (F3)", () => {
    const result = parseFutonInvocation("bc@high then tag+mugetsu");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/reserved step names/);
      expect(result.error.correctedLine).toBe("bc@high then tag");
    }
  });

  it("refuses 'tag'+'fanout' alongside another step, suggesting the terminal and the remainder (F3)", () => {
    const result = parseFutonInvocation("bc@high then tag+fanout+getsuga");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/reserved step names/);
      expect(result.error.correctedLine).toBe("bc@high then tag+fanout");
    }
  });

  // F4: a mistyped terminal is refused with the corrected line, not silently
  // accepted as an ordinary (nonexistent) single-step skill chain.
  it("refuses a near-miss single-token terminal, offering 'then tag' (F4)", () => {
    const result = parseFutonInvocation("bc@high then tga");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/not a recognized terminal/);
      expect(result.error.correctedLine).toBe("bc@high then tag");
    }
  });

  it("refuses a near-miss 'tag+fanout', offering the corrected terminal (F4)", () => {
    const result = parseFutonInvocation("bc@high then tag+fanuot");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/not a recognized terminal/);
      expect(result.error.correctedLine).toBe("bc@high then tag+fanout");
    }
  });

  // F5: the 'then' split needs whitespace on both sides, and never fires
  // inside a quoted selector.
  it("does not split on 'then' with no whitespace after it -- it is part of the label (F5)", () => {
    const result = parseFutonInvocation("nen@then-review");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.label).toBe("then-review");
      expect(result.value.then).toBeNull();
    }
  });

  it("does not split on a 'then' living inside a quoted selector (F5)", () => {
    const result = parseFutonInvocation('nen@"ready then ship"');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.label).toBe("ready then ship");
      expect(result.value.then).toBeNull();
    }
  });

  // F12: spacing around the chain operator is normalized before classifying,
  // and an empty step between '+'s is a malformed chain, refused at exit 2.
  it("normalizes spaces around '+' before classifying a chain (F12)", () => {
    const result = parseFutonInvocation("bc@high then getsuga + mugetsu");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.then).toEqual({
        kind: "skills",
        steps: [
          { skill: "getsuga", target: null },
          { skill: "mugetsu", target: null },
        ],
      });
    }
  });

  it("refuses an empty chain part as a malformed chain (F12)", () => {
    const result = parseFutonInvocation("bc@high then a++b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/malformed chain/);
  });

  it("a single skill is a one-step chain", () => {
    const result = parseFutonInvocation("bc@high then getsuga");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.then).toEqual({ kind: "skills", steps: [{ skill: "getsuga", target: null }] });
  });

  it("keeps anything else after the FIRST 'then' as prose, verbatim", () => {
    const result = parseFutonInvocation("@bug then fan out to every consumer, then tell me");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.label).toBe("bug");
      expect(result.value.then).toEqual({ kind: "prose", text: "fan out to every consumer, then tell me" });
    }
  });

  it("refuses a 'then' that names nothing, offering the build-only line", () => {
    const result = parseFutonInvocation("bc@high then");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.correctedLine).toBe("bc@high");
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

// zheref/nen#17: against a REAL loaded registry -- the bankai fixture's
// product_codes nests a `$comment`, the same shape the live bankai-core file
// carries. A code-token resolution that walked product_codes without skipping
// it would both (a) list '$comment' among the codes an unresolved token's
// refusal names, and (b) let the comment's own prose participate in the
// bare-value matching resolveFutonRepo and codeRecordedFor perform.
describe("resolveFutonRepo -- a nested $comment never surfaces, against a REAL loaded registry (zheref/nen#17)", () => {
  it("an unresolved token's refusal lists only the real codes", () => {
    const registry = loadRepoRegistry(BANKAI_REPO);
    try {
      resolveFutonRepo(registry, "nope", "zheref/bankai-core");
      expect.unreachable("'nope' is not a code, slug or name in the bankai fixture");
    } catch (error) {
      expect(error).toBeInstanceOf(FutonResolveError);
      const message = (error as FutonResolveError).message;
      expect(message).toMatch(/product_codes \(BC, BS, KP, KN, KW, KC\)/);
      expect(message).not.toContain("$comment");
    }
  });

  it("the loaded registry's productCodes carries none of the file's $comment", () => {
    const registry = loadRepoRegistry(BANKAI_REPO);
    expect(registry.productCodes["$comment"]).toBeUndefined();
  });
});
