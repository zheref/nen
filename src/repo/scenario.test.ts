import { describe, expect, it } from "vitest";
import { resolveScenario } from "./scenario.js";
import { parseRepoRegistry, type RepoRegistry } from "../schema/repos.js";

// One registry that records repositories in every place the file can: a
// consumer with a scenario, a consumer without one, a maintained tool, a
// pending onboarding, the registry's own repo as a bare product-code value,
// and a product code whose value is a FULL owner/name slug -- so each of the
// refusal causes (zheref/nen#28, widened by #219), plus both recordedWhere()
// outcomes (zheref/nen#28's second finding), has a subject.
const REGISTRY = parseRepoRegistry("/x/nen/repos.json", {
  latest: "v1.0.0",
  consumers: [
    { repo: "zheref/KroApple", consumes: [], scenario: "swiftui-tca-uzf-v2" },
    { repo: "zheref/KroAndroid", consumes: [] },
  ],
  maintained_tools: [{ repo: "zheref/tooling" }],
  pending_onboarding: [{ repo: "zheref/KroCloud" }],
  product_codes: { BC: "bankai-core", RG: "zheref/registry-tool" },
});

// The shape zheref/nen#219 was filed against, taken from the two tool
// repositories' own registry: `"consumers": []`, both tools under
// maintained_tools[] -- now each stating a scenario -- and each ALSO named by
// a full-slug product code, which is the step resolveToken() matches first.
const TOOLS = parseRepoRegistry("/tools/nen/repos.json", {
  consumers: [],
  maintained_tools: [
    { repo: "zheref/hatsu", role: "Hatsu workflow and skill prose", scenario: "hatsu-plugin" },
    { repo: "zheref/nen", role: "Shared deterministic machinery", scenario: "bun-cli" },
  ],
  pending_onboarding: [{ repo: "zheref/KroCloud", status: "not-a-consumer", scenario: "cloud-functions" }],
  product_codes: { HA: "zheref/hatsu", NN: "zheref/nen" },
});

describe("resolveScenario -- a lookup, with the gaps told apart (zheref/nen#28)", () => {
  it("reads the scenario recorded for a known consumer", () => {
    expect(resolveScenario(REGISTRY, "zheref/KroApple")).toEqual({ ok: true, scenario: "swiftui-tca-uzf-v2" });
  });

  // zheref/nen#219 criterion 6: a consumer recorded ONLY under consumers[]
  // gets the pre-#219 sentence byte for byte.
  it("names a consumer with no 'scenario' field as exactly that, in the unchanged sentence", () => {
    expect(resolveScenario(REGISTRY, "zheref/KroAndroid")).toEqual({
      ok: false,
      reason:
        "'zheref/KroAndroid' is a consumer in /x/nen/repos.json, but its entry carries no 'scenario' field. Add one to the entry to record which scenario governs it.",
    });
  });

  it("names a repo the file records NOWHERE distinctly, listing where it looked", () => {
    const unknown = resolveScenario(REGISTRY, "zheref/unknown");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.reason).toMatch(/is not recorded anywhere/);
      expect(unknown.reason).toMatch(/maintained tool/);
    }
  });

  // The conflation zheref/nen#28 confirmed live: these used to produce the
  // BYTE-IDENTICAL "not a consumer ... does not know it" refusal a genuinely
  // unrecorded repo gets, even though the file plainly records each of them
  // (./resolve.ts's rule 5 widening, zheref/nen#27).
  it("a pending_onboarding listing is 'recorded' -- never 'not known' -- and its remedy is its own row", () => {
    const pending = resolveScenario(REGISTRY, "zheref/KroCloud");
    expect(pending.ok).toBe(false);
    if (!pending.ok) {
      expect(pending.reason).toMatch(/is recorded in .*under 'pending_onboarding'/);
      expect(pending.reason).toMatch(/its row there carries no 'scenario' field/);
      expect(pending.reason).toMatch(/Add one to its pending_onboarding\[\] row/);
      expect(pending.reason).not.toMatch(/does not know it/);
    }
  });

  // zheref/nen#219 criterion 3: the remedy names the section the target is
  // ALREADY in, and never tells the caller to re-file a maintained tool as a
  // consumer -- which is what the old "record it under consumers[] with a
  // 'scenario'" sentence did.
  it("a maintained_tools listing with no scenario is sent to its own maintained_tools[] row, never to consumers[]", () => {
    const tool = resolveScenario(REGISTRY, "zheref/tooling");
    expect(tool.ok).toBe(false);
    if (!tool.ok) {
      expect(tool.reason).toMatch(/is recorded in \/x\/nen\/repos\.json \(under 'maintained_tools'\)/);
      expect(tool.reason).toMatch(/Add one to its maintained_tools\[\] row/);
      expect(tool.reason).not.toMatch(/record it under consumers/);
      expect(tool.reason).not.toMatch(/only a consumers\[\] entry carries/);
    }
  });

  // zheref/nen#28's second finding: a bare product_codes value (no owner
  // anywhere in the file) matched only by NAME HALF (resolveToken()'s rule
  // 3.5c) is NOT the same claim as the registry recording 'zheref/bankai-core'
  // -- the owner half came from the caller's own token. The wording must say
  // so, while still naming the code so the caller can find it.
  it("the registry's own repo -- a bare product-code value matched by name half -- is named WITHOUT claiming the slug itself is recorded", () => {
    const own = resolveScenario(REGISTRY, "zheref/bankai-core");
    expect(own.ok).toBe(false);
    if (!own.ok) {
      expect(own.reason).toMatch(/is not itself recorded in/);
      expect(own.reason).toMatch(/bare product code 'BC' \('bankai-core'\), which names no owner/);
      expect(own.reason).not.toMatch(/'zheref\/bankai-core' is recorded in/);
    }
  });

  // The other side of the same distinction: a product_codes value that IS the
  // full owner/name slug, matched EXACTLY (rule 3.5a) rather than by name
  // half -- the registry genuinely does record this slug, so "is recorded"
  // stays the accurate claim.
  it("a product code recording the FULL owner/name slug exactly is reported as genuinely recorded", () => {
    const exact = resolveScenario(REGISTRY, "zheref/registry-tool");
    expect(exact.ok).toBe(false);
    if (!exact.ok) {
      expect(exact.reason).toMatch(/'zheref\/registry-tool' is recorded in .*as product code 'RG' \('zheref\/registry-tool'\)/);
      expect(exact.reason).not.toMatch(/is not itself recorded/);
    }
  });

  // zheref/nen#219 criterion 3, for the two product-code causes: the
  // repository has no row yet, and which section a row belongs in is a fact
  // only the caller knows. The remedy lays out what each section is FOR
  // rather than naming consumers[] alone.
  it("a repo recorded only by a product code is told what each section is for, not sent to consumers[] alone", () => {
    for (const slug of ["zheref/registry-tool", "zheref/bankai-core"]) {
      const result = resolveScenario(REGISTRY, slug);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/under maintained_tools\[\] if it is one of this registry's own tool repositories/);
        expect(result.reason).toMatch(/pending_onboarding\[\] if it has not adopted the machinery yet/);
        expect(result.reason).toMatch(/consumers\[\] if it consumes it/);
        expect(result.reason).not.toMatch(/record '[^']*' under consumers\[\] there/);
      }
    }
  });
});

describe("resolveScenario -- maintained_tools[] and pending_onboarding[] rows carry a scenario too (zheref/nen#219)", () => {
  // Criterion 1, in the exact registry shape the issue quotes: the product
  // code match (rule 3.5a) is what resolveToken() returns for both tools, and
  // the scenario is still read off the maintained_tools[] row.
  it("reads a maintained tool's scenario off its own maintained_tools[] row", () => {
    expect(resolveScenario(TOOLS, "zheref/hatsu")).toEqual({ ok: true, scenario: "hatsu-plugin" });
    expect(resolveScenario(TOOLS, "zheref/nen")).toEqual({ ok: true, scenario: "bun-cli" });
  });

  // Criterion 2: the same holds for pending_onboarding[].
  it("reads a pending onboarding's scenario off its own pending_onboarding[] row", () => {
    expect(resolveScenario(TOOLS, "zheref/KroCloud")).toEqual({ ok: true, scenario: "cloud-functions" });
  });

  it("matches the listed row case-insensitively, as every other registry lookup does", () => {
    expect(resolveScenario(TOOLS, "ZHEREF/Nen")).toEqual({ ok: true, scenario: "bun-cli" });
  });

  // Criterion 6: a consumers[] entry that states a scenario is read exactly
  // as before when the same repository is also a maintained tool whose row
  // states none -- the bankai-scaffold shape the live registry carries.
  it("a consumer that is ALSO a maintained tool keeps its consumers[] scenario", () => {
    const both = parseRepoRegistry("/b/nen/repos.json", {
      consumers: [{ repo: "zheref/bankai-scaffold", consumes: [], scenario: "scaffold" }],
      maintained_tools: [{ repo: "zheref/bankai-scaffold", role: "scaffolder" }],
    });
    expect(resolveScenario(both, "zheref/bankai-scaffold")).toEqual({ ok: true, scenario: "scaffold" });
  });

  it("a repository has ONE scenario: the same value stated on two of its rows is read", () => {
    const agree = parseRepoRegistry("/b/nen/repos.json", {
      consumers: [{ repo: "zheref/bankai-scaffold", consumes: [], scenario: "scaffold" }],
      maintained_tools: [{ repo: "zheref/bankai-scaffold", scenario: "scaffold" }],
    });
    expect(resolveScenario(agree, "zheref/bankai-scaffold")).toEqual({ ok: true, scenario: "scaffold" });
  });

  it("a consumer whose entry states none is read off its maintained_tools[] row when that row states one", () => {
    const listedOnly = parseRepoRegistry("/b/nen/repos.json", {
      consumers: [{ repo: "zheref/bankai-scaffold", consumes: [] }],
      maintained_tools: [{ repo: "zheref/bankai-scaffold", scenario: "scaffold" }],
    });
    expect(resolveScenario(listedOnly, "zheref/bankai-scaffold")).toEqual({ ok: true, scenario: "scaffold" });
  });

  // Cause 4: reading either value would be a guess about which one governs
  // the repository, so neither is read -- and both rows are named.
  it("refuses rows that state DIFFERENT scenarios, naming each row and value", () => {
    const conflict = parseRepoRegistry("/b/nen/repos.json", {
      consumers: [{ repo: "zheref/bankai-scaffold", consumes: [], scenario: "scaffold" }],
      maintained_tools: [{ repo: "zheref/bankai-scaffold", scenario: "tooling" }],
    });
    expect(resolveScenario(conflict, "zheref/bankai-scaffold")).toEqual({
      ok: false,
      reason:
        "'zheref/bankai-scaffold' is recorded in /b/nen/repos.json with more than one scenario -- 'scaffold' (its consumers[] entry), 'tooling' (its maintained_tools[] row). A repository has one scenario, and reading any one of these would be a guess about which governs it. Make its rows agree, or state it on one row only.",
    });
  });

  it("refuses a conflict between two listed rows, compared exactly (a scenario is a directory name)", () => {
    const conflict = parseRepoRegistry("/b/nen/repos.json", {
      consumers: [],
      maintained_tools: [{ repo: "o/tool", scenario: "Scaffold" }],
      pending_onboarding: [{ repo: "o/tool", scenario: "scaffold" }],
    });
    const result = resolveScenario(conflict, "o/tool");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/'Scaffold' \(its maintained_tools\[\] row\), 'scaffold' \(its pending_onboarding\[\] row\)/);
    }
  });

  it("a consumer recorded under maintained_tools too, with no scenario anywhere, is told a scenario on either row is read", () => {
    const neither = parseRepoRegistry("/b/nen/repos.json", {
      consumers: [{ repo: "zheref/bankai-scaffold", consumes: [] }],
      maintained_tools: [{ repo: "zheref/bankai-scaffold" }],
    });
    const result = resolveScenario(neither, "zheref/bankai-scaffold");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/is a consumer in .*its entry carries no 'scenario' field/);
      expect(result.reason).toMatch(/It is also recorded under 'maintained_tools', where it carries none either/);
    }
  });

  it("a repo listed in BOTH non-consumer sections with no scenario names both, and sends the caller to the first", () => {
    const twice = parseRepoRegistry("/b/nen/repos.json", {
      consumers: [],
      maintained_tools: [{ repo: "o/tool" }],
      pending_onboarding: [{ repo: "o/tool" }],
    });
    const result = resolveScenario(twice, "o/tool");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/\(under 'maintained_tools' and 'pending_onboarding'\)/);
      expect(result.reason).toMatch(/none of its rows there carries a 'scenario' field/);
      expect(result.reason).toMatch(/Add one to its maintained_tools\[\] row/);
    }
  });

  // `listed` is optional in the type for a registry assembled by hand. Its
  // slug lists are still read as rows stating no scenario, so the refusal
  // names the section the repo is in rather than claiming it is recorded
  // nowhere a scenario could live.
  it("a hand-assembled registry without `listed` still names the section its slug lists record", () => {
    const handBuilt: RepoRegistry = { ...REGISTRY, listed: undefined };
    const result = resolveScenario(handBuilt, "zheref/tooling");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/\(under 'maintained_tools'\), but its row there carries no 'scenario' field/);
    expect(resolveScenario(handBuilt, "zheref/KroApple")).toEqual({ ok: true, scenario: "swiftui-tca-uzf-v2" });
  });
});
