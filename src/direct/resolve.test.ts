import { describe, expect, it } from "vitest";
import { VerbUsageError } from "../cli/command.js";
import { loadClassifyTaxonomy } from "../classify/taxonomy.js";
import { loadDirectRegistry } from "./registry.js";
import {
  aggregate,
  collectPairs,
  compareSession,
  DirectError,
  deriveDomain,
  fallbackOrder,
  parseInputs,
  parseSession,
  renderEffort,
  resolveDirection,
  UNSPELLED,
  type DirectInputs,
  type ResolveContext,
  type SessionValues,
} from "./resolve.js";
import {
  miniFiles,
  REAL_REGISTRY,
  REAL_TAXONOMY,
  setCell,
  side,
  type Json,
} from "./fixtures/harness.js";

const MODELS = { k1: { deep: "opus", frontier: "maxx", fast: "quick" }, k2: { deep: "exec" } };
const NO_SESSION: SessionValues = { surface: null, tier: null, effort: null };

function context(
  editRegistry: (value: Json) => void = (): void => {},
  editTaxonomy: (value: Json) => void = (): void => {},
  models: ResolveContext["models"] = MODELS,
): ResolveContext {
  const { registryPath, taxonomyPath } = miniFiles(editRegistry, editTaxonomy);
  return {
    registry: loadDirectRegistry("/", registryPath),
    taxonomy: loadClassifyTaxonomy("/", taxonomyPath),
    models,
  };
}

const inputs = (over: Partial<DirectInputs> = {}): DirectInputs => ({
  langs: ["alpha"],
  jobs: ["plain"],
  kind: "product",
  role: null,
  issueKind: "none",
  ...over,
});

describe("deriveDomain -- the five rules, each decided on the inputs", () => {
  const { taxonomy } = context();
  const domainOf = (over: Partial<DirectInputs>): [string, number] => {
    const verdict = deriveDomain(taxonomy, inputs(over));
    return [verdict.domain, verdict.rule];
  };

  it("rule 1: the process kind, or the canon role, derives row 1's domain", () => {
    expect(domainOf({ kind: "process" })).toEqual(["gov", 1]);
    expect(domainOf({ kind: "product", role: "canon" })).toEqual(["gov", 1]);
    expect(deriveDomain(taxonomy, inputs({ role: "canon" })).because).toBe("the role is canon");
    expect(deriveDomain(taxonomy, inputs({ kind: "process" })).because).toBe("the kind is process");
  });

  it("rule 1 outranks every later rule", () => {
    expect(domainOf({ kind: "process", jobs: ["port-only"], issueKind: "bug" })).toEqual(["gov", 1]);
  });

  it("rule 2: the library kind derives row 2's domain", () => {
    expect(domainOf({ kind: "library" })).toEqual(["lib", 2]);
  });

  it("rule 3: a carried job whose phases name only row 3's domain, the marker job", () => {
    expect(domainOf({ jobs: ["plain", "port-only"] })).toEqual(["port", 3]);
    // the marker outranks the bug kind (rule 3 sits above rule 4)
    expect(domainOf({ jobs: ["port-only"], issueKind: "bug" })).toEqual(["port", 3]);
    expect(deriveDomain(taxonomy, inputs({ jobs: ["port-only"] })).because).toBe("job port-only lists only the port domain");
  });

  it("rule 4: the bug kind derives row 4's domain; an enhancement does not", () => {
    expect(domainOf({ issueKind: "bug" })).toEqual(["ops", 4]);
    expect(domainOf({ issueKind: "enhancement" })).toEqual(["dev", 5]);
  });

  it("rule 4: every job carried listing only row 4's domain derives it; one other job breaks that", () => {
    expect(domainOf({ jobs: ["ops-a", "ops-b"] })).toEqual(["ops", 4]);
    expect(domainOf({ jobs: ["ops-a", "plain"] })).toEqual(["dev", 5]);
    // a job whose taxonomy entry states no phases cannot count as maintenance-only
    expect(domainOf({ jobs: ["ops-a", "bare"] })).toEqual(["dev", 5]);
  });

  it("rule 5: otherwise row 5's domain; a library-only job alone is not the library kind", () => {
    expect(domainOf({})).toEqual(["dev", 5]);
    expect(domainOf({ jobs: ["lib-only"] })).toEqual(["dev", 5]);
  });

  it("reads every domain name from the taxonomy: the real file's names come out, not the mini file's", () => {
    const real = loadClassifyTaxonomy("/", REAL_TAXONOMY);
    const rows = real.domains?.rule.map((row): string => row.domain) ?? [];
    const real_ = (over: Partial<DirectInputs>): string => deriveDomain(real, inputs({ jobs: ["implementation"], ...over })).domain;
    expect(real_({ kind: "process" })).toBe(rows[0]);
    expect(real_({ kind: "library" })).toBe(rows[1]);
    expect(real_({ jobs: ["parity"] })).toBe(rows[2]);
    expect(real_({ issueKind: "bug" })).toBe(rows[3]);
    expect(real_({})).toBe(rows[4]);
    expect(real_({ jobs: ["ci-cd", "refactor"] })).toBe(rows[3]);
  });

  it("refuses a taxonomy with no domains block, or with other than five rows (a failure, not a typo)", () => {
    const none = context((): void => {}, (v): void => {
      delete v["domains"];
    });
    expect(() => deriveDomain(none.taxonomy, inputs())).toThrow(DirectError);
    const four = context((): void => {}, (v): void => {
      v["domains"]["rule"].pop();
    });
    expect(() => deriveDomain(four.taxonomy, inputs())).toThrow(/found 4 rows/);
  });
});

describe("fallbackOrder -- the taxonomy's sentence, derived domain first", () => {
  const { taxonomy } = context();
  const domains = taxonomy.domains;
  if (domains === null) throw new Error("fixture lost its domains block");

  it("follows the order the sentence names them, not the keys order", () => {
    expect(fallbackOrder(domains, "dev")).toEqual(["dev", "ops", "lib", "gov", "port"]);
    expect(fallbackOrder(domains, "port")).toEqual(["port", "ops", "dev", "lib", "gov"]);
  });

  it("appends a domain the sentence does not name, in keys order, and matches whole words only", () => {
    const quiet = { ...domains, fallback: "try ops first, then devices" };
    expect(fallbackOrder(quiet, "lib")).toEqual(["lib", "ops", "dev", "port", "gov"]);
  });
});

describe("collectPairs -- one cell per (job, language)", () => {
  it("reads the language's own cell when there is one, else the shared cell", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "alpha", side("A_EXEC", "s2"));
    });
    const { pairs } = collectPairs(c.registry, c.taxonomy, inputs({ langs: ["alpha", "beta"] }), "dev");
    expect(pairs.map((pair): [string, string, string] => [pair.lang, pair.cell, pair.winner.alias])).toEqual([
      ["alpha", "alpha", "A_EXEC"],
      ["beta", "*", "A_TOP"],
    ]);
  });

  it("routes a job with no phase in the domain on the first domain it lists, and says so", () => {
    const c = context();
    const result = collectPairs(c.registry, c.taxonomy, inputs({ jobs: ["lib-only", "plain"] }), "dev");
    expect(result.fallbacks).toEqual(["fallback: lib-only has no dev phase; routed on lib"]);
    expect(result.pairs.map((pair): [string, string, string] => [pair.job, pair.domain, pair.phase])).toEqual([
      ["lib-only", "lib", "L.1"],
      ["plain", "dev", "D.1"],
    ]);
  });

  it("orders the substitution by the taxonomy's sentence: lib before gov, though gov precedes it in keys", () => {
    const c = context();
    const { pairs } = collectPairs(c.registry, c.taxonomy, inputs({ jobs: ["odd"] }), "dev");
    expect(pairs[0]?.domain).toBe("lib");
  });

  it("refuses a job the registry does not route, as a failure", () => {
    const c = context((v): void => {
      delete v["routing"]["plain"];
    });
    expect(() => collectPairs(c.registry, c.taxonomy, inputs(), "dev")).toThrow(/there is no job 'plain'/);
  });

  it("reads the shared cell for a prose language in the real registry", () => {
    const registry = loadDirectRegistry("/", REAL_REGISTRY);
    const taxonomy = loadClassifyTaxonomy("/", REAL_TAXONOMY);
    const withProse = collectPairs(registry, taxonomy, inputs({ langs: ["prose", "swift"], jobs: ["implementation"] }), "feature").pairs;
    expect(withProse.map((pair): string => pair.cell)).toEqual(["*", "swift"]);
  });

  it("keeps a stand-in for a reviewer winner and names the alias it stood in for", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "*", side("R_BOT", null, { also: "A_EXEC" }));
    });
    const winner = collectPairs(c.registry, c.taxonomy, inputs(), "dev").pairs[0]?.winner;
    expect(winner).toMatchObject({ alias: "A_EXEC", surface: "s2", substituted: "R_BOT" });
  });
});

describe("aggregate -- the winner and the runner-up", () => {
  const run = (cells: Record<string, [Json, Json?]>, jobs: string[]): ReturnType<typeof aggregate> => {
    const c = context((v): void => {
      for (const [job, [winner, runnerUp]] of Object.entries(cells)) setCell(v, job, "dev", "*", winner, runnerUp);
    });
    return aggregate(c.registry, collectPairs(c.registry, c.taxonomy, inputs({ jobs }), "dev").pairs);
  };

  it("the alias that wins the most pairs wins; the next most frequent is the runner-up", () => {
    const result = run({ heavy: [side("A_EXEC", "s2")] }, ["plain", "heavy", "light"]);
    expect(result.winner).toBe("A_TOP");
    expect(result.runnerUp).toBe("A_EXEC");
    expect(result.tally).toEqual({ A_TOP: 2, A_EXEC: 1 });
  });

  it("a tie goes to the registry's precedence, earlier first, whatever order the pairs came in", () => {
    expect(run({ plain: [side("A_EXEC", "s2")] }, ["plain", "heavy"]).winner).toBe("A_TOP");
    expect(run({ heavy: [side("A_EXEC", "s2")] }, ["heavy", "plain"]).winner).toBe("A_TOP");
    expect(run({ plain: [side("A_MAX", "s1")], heavy: [side("A_FAST", "s1")] }, ["heavy", "plain"]).winner).toBe("A_MAX");
  });

  it("with one winning alias, the runner-up is the winning pairs' most frequent runner-up", () => {
    const result = run(
      { plain: [side("A_TOP", "s1"), side("A_FAST", "s1")], heavy: [side("A_TOP", "s1"), side("A_EXEC", "s2")], light: [side("A_TOP", "s1"), side("A_EXEC", "s2")] },
      ["plain", "heavy", "light"],
    );
    expect(result.winner).toBe("A_TOP");
    expect(result.runnerUp).toBe("A_EXEC");
  });

  it("with no distinct runner-up anywhere, the first pair's runner-up stands", () => {
    const result = run({ plain: [side("A_TOP", "s1"), side("A_TOP", "s1")] }, ["plain"]);
    expect(result.runnerUp).toBe("A_TOP");
  });

  it("a reviewer alias is never the winner: its stand-in is used when the cell gives one", () => {
    const result = run(
      { plain: [side("R_BOT", null, { also: "A_EXEC" })], heavy: [side("R_BOT", null, { also: "A_EXEC" })], light: [side("A_TOP", "s1")] },
      ["plain", "heavy", "light"],
    );
    expect(result.winner).toBe("A_EXEC");
    expect(result.skipped).toEqual([]);
  });

  it("with no stand-in the pair is skipped, reported, and never counted", () => {
    const result = run({ plain: [side("R_BOT", null)], heavy: [side("R_BOT", null)] }, ["plain", "heavy", "light"]);
    expect(result.winner).toBe("A_TOP");
    expect(result.skipped).toEqual([
      { job: "plain", lang: "alpha", alias: "R_BOT" },
      { job: "heavy", lang: "alpha", alias: "R_BOT" },
    ]);
    expect(result.tally).toEqual({ A_TOP: 1 });
  });

  it("refuses, as a failure, when every pair's winner is a reviewer with no stand-in", () => {
    expect(() => run({ plain: [side("R_BOT", null)] }, ["plain"])).toThrow(DirectError);
  });
});

describe("resolveDirection -- each side resolved", () => {
  it("spells the surface alias from the consumer's models block, and the restart line with it", () => {
    const result = resolveDirection(context(), inputs(), NO_SESSION);
    expect(result.winner).toMatchObject({ alias: "A_TOP", surface: "s1", tier: "deep", surfaceAlias: "opus", restart: "s1 --model opus", effortControl: "/effort <level>" });
    expect(result.runnerUp).toMatchObject({ alias: "A_FAST", surfaceAlias: "quick" });
  });

  it("reports 'unspelled' when the workflow has no models block, or no such tier, and keeps the placeholder", () => {
    const none = resolveDirection(context((): void => {}, (): void => {}, {}), inputs(), NO_SESSION);
    expect(none.winner.surfaceAlias).toBe(UNSPELLED);
    expect(none.winner.restart).toBe("s1 --model <alias>");
    const noTier = resolveDirection(context((): void => {}, (): void => {}, { k1: { fast: "quick" } }), inputs(), NO_SESSION);
    expect(noTier.winner.surfaceAlias).toBe(UNSPELLED);
    expect(noTier.runnerUp.surfaceAlias).toBe("quick");
  });

  it("lets the cell's surface override the alias's default", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "*", side("A_TOP", "s2"));
    });
    const winner = resolveDirection(c, inputs(), NO_SESSION).winner;
    expect(winner).toMatchObject({ surface: "s2", surfaceAlias: "exec", restart: "s2 -m exec", effortControl: "reasoning <level>" });
  });

  it("gives a reviewer runner-up no surface, no spelling and no restart", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "*", side("A_TOP", "s1"), side("R_BOT", null));
    });
    const runnerUp = resolveDirection(c, inputs(), NO_SESSION).runnerUp;
    expect(runnerUp).toMatchObject({ alias: "R_BOT", reviewer: true, surface: null, surfaceAlias: null, restart: null, effortControl: null });
  });

  it("builds the interactive list: surface, each language's tool, the cell's, deduplicated, nulls dropped", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "*", side("A_TOP", "s1", { interactive: "the alpha IDE" }));
      setCell(v, "heavy", "dev", "*", side("A_TOP", "s1", { interactive: "a cell tool" }));
    });
    const result = resolveDirection(c, inputs({ langs: ["alpha", "delta", "beta"], jobs: ["plain", "heavy"] }), NO_SESSION);
    // delta shares alpha's tool; the first cell's tool repeats alpha's; the second cell adds one
    expect(result.winner.interactive).toEqual(["the s1 desktop", "the alpha IDE", "the beta IDE", "a cell tool"]);
  });

  it("quotes the dated snapshot and the provider's live-lookup sources, or null when there are none", () => {
    const result = resolveDirection(context(), inputs(), NO_SESSION);
    expect(result.winner.snapshot).toEqual({ asOf: "2026-01-02", primary: "Top 1", modelId: "top-1", fallback: "Max 1" });
    expect(result.winner.liveLookup).toEqual({ cli: "p1 models", docs: ["https://p1.example/models"] });
    expect(result.runnerUp.snapshot).toBeNull();
  });
});

describe("scoreEffort -- the rule, band by band", () => {
  const effortOf = (over: Partial<DirectInputs>, c: ResolveContext = context()): [number, string] => {
    const effort = resolveDirection(c, inputs(over), NO_SESSION).effort;
    return [effort.score, effort.level];
  };

  it("bands the score at every boundary: 1-2 low, 3 medium, 4 high, 5 and up max", () => {
    expect(effortOf({ jobs: ["light"] })).toEqual([1, "low"]);
    expect(effortOf({ jobs: ["plain"] })).toEqual([2, "low"]);
    expect(effortOf({ jobs: ["mid"] })).toEqual([3, "medium"]);
    expect(effortOf({ jobs: ["heavy"] })).toEqual([4, "high"]);
    expect(effortOf({ jobs: ["heavy"], langs: ["alpha", "beta"] })).toEqual([5, "max"]);
  });

  it("adds one for many jobs, at the registry's threshold", () => {
    expect(effortOf({ jobs: ["plain", "light"] })).toEqual([2, "low"]);
    expect(effortOf({ jobs: ["plain", "light", "heavy"] })).toEqual([5, "max"]);
    expect(effortOf({ jobs: ["light", "plain", "mid"] })).toEqual([4, "high"]);
  });

  it("adds one for many CODE languages, reading the taxonomy's flag: an absent flag counts, false does not", () => {
    expect(effortOf({ jobs: ["heavy"], langs: ["alpha", "gamma"] })).toEqual([4, "high"]);
    expect(effortOf({ jobs: ["heavy"], langs: ["alpha", "beta"] })).toEqual([5, "max"]);
    expect(effortOf({ jobs: ["heavy"], langs: ["gamma", "alpha", "delta"] })).toEqual([5, "max"]);
    expect(effortOf({ jobs: ["heavy"], langs: ["gamma"] })).toEqual([4, "high"]);
  });

  it("adds one when the derived domain is the one the registry's rule names, read from the data", () => {
    expect(effortOf({ jobs: ["plain"], kind: "process" })).toEqual([3, "medium"]);
    expect(effortOf({ jobs: ["plain"], role: "canon" })).toEqual([3, "medium"]);
    // a rule naming another domain adds on that one instead
    const moved = context((v): void => {
      v["effort"]["rule"]["plusOne"][2] = { when: "the derived domain is lib", key: "lib" };
    });
    expect(effortOf({ jobs: ["plain"], kind: "process" }, moved)).toEqual([2, "low"]);
    expect(effortOf({ jobs: ["lib-only"], kind: "library" }, moved)).toEqual([3, "medium"]);
  });

  it("reports the derivation as the sum's terms, then the one-line rendering", () => {
    const effort = resolveDirection(context(), inputs({ jobs: ["heavy", "light", "plain"], kind: "process" }), NO_SESSION).effort;
    expect(effort.derivation).toEqual(["weight 4", "manyJobs", "gov"]);
    expect(renderEffort(effort)).toBe("weight 4 + manyJobs + gov = 6 -> max");
    expect(renderEffort(resolveDirection(context(), inputs({ jobs: ["light"] }), NO_SESSION).effort)).toBe("weight 1 = 1 -> low");
  });

  it("maps the level through the winner surface's own control", () => {
    const onS1 = resolveDirection(context(), inputs({ jobs: ["heavy"], langs: ["alpha", "beta"] }), NO_SESSION);
    expect(onS1.effort.surfaceEffort).toBe("max");
    const c = context((v): void => {
      setCell(v, "heavy", "dev", "*", side("A_EXEC", "s2"));
    });
    const onS2 = resolveDirection(c, inputs({ jobs: ["heavy"], langs: ["alpha", "beta"] }), NO_SESSION);
    expect(onS2.effort.surfaceEffort).toBe("xhi");
  });

  it("refuses, as failures, a job with no weight and a domain add the taxonomy does not know", () => {
    expect(() => resolveDirection(context(), inputs({ jobs: ["bare"] }), NO_SESSION)).toThrow(/job 'bare' has no weight/);
    const typo = context((v): void => {
      v["effort"]["rule"]["plusOne"][2] = { when: "x", key: "nowhere" };
    });
    expect(() => resolveDirection(typo, inputs(), NO_SESSION)).toThrow(/neither a count rule nor one of the taxonomy's domains/);
  });
});

describe("compareSession -- a mismatch is an answer", () => {
  const winner = resolveDirection(context(), inputs(), NO_SESSION).winner;

  it("is null when the session gave nothing to compare", () => {
    expect(compareSession(NO_SESSION, winner, "low")).toBeNull();
  });

  it("matches when every given value equals the recommendation, comparing only what was given", () => {
    expect(compareSession({ surface: "s1", tier: "opus", effort: "low" }, winner, "low")).toEqual({
      compared: ["surface", "tier", "effort"],
      match: true,
      differences: [],
    });
    expect(compareSession({ surface: "s1", tier: null, effort: null }, winner, "low")?.compared).toEqual(["surface"]);
  });

  it("reports each differing field with the session's value and the recommended one", () => {
    expect(compareSession({ surface: "s2", tier: null, effort: null }, winner, "low")?.differences).toEqual([
      { field: "surface", session: "s2", recommended: "s1" },
    ]);
    expect(compareSession({ surface: null, tier: "quick", effort: null }, winner, "low")?.differences).toEqual([
      { field: "tier", session: "quick", recommended: "opus" },
    ]);
    const effort = compareSession({ surface: null, tier: null, effort: "max" }, winner, "low");
    expect(effort?.match).toBe(false);
    expect(effort?.differences).toEqual([{ field: "effort", session: "max", recommended: "low" }]);
  });

  it("reports all three at once, and flows through resolveDirection without refusing", () => {
    const result = resolveDirection(context(), inputs(), { surface: "s2", tier: "x", effort: "max" });
    expect(result.mismatch?.differences.map((difference): string => difference.field)).toEqual(["surface", "tier", "effort"]);
  });

  it("compares a tier against 'unspelled' when the workflow does not spell the alias", () => {
    const result = resolveDirection(context((): void => {}, (): void => {}, {}), inputs(), { surface: null, tier: "opus", effort: null });
    expect(result.mismatch?.differences).toEqual([{ field: "tier", session: "opus", recommended: UNSPELLED }]);
  });
});

describe("parseInputs and parseSession -- usage refusals name the valid set", () => {
  const { registry, taxonomy } = context();
  const raw = { langs: ["alpha"], jobs: ["plain"], kind: "product", role: null, issueKind: null };

  it("accepts a valid classification and defaults the issue kind to none", () => {
    expect(parseInputs(taxonomy, raw)).toEqual({ langs: ["alpha"], jobs: ["plain"], kind: "product", role: null, issueKind: "none" });
  });

  it("drops a repeated key", () => {
    expect(parseInputs(taxonomy, { ...raw, langs: ["alpha", "alpha"] }).langs).toEqual(["alpha"]);
  });

  it("refuses an unknown language or job key, naming the valid keys", () => {
    expect(() => parseInputs(taxonomy, { ...raw, langs: ["nope"] })).toThrow(/unknown language key 'nope'. Valid: alpha, beta, gamma, delta/);
    expect(() => parseInputs(taxonomy, { ...raw, jobs: ["nope", "plain"] })).toThrow(/unknown job key 'nope'. Valid: plain, heavy/);
  });

  it("refuses an empty list, an unknown kind, role or issue kind", () => {
    expect(() => parseInputs(taxonomy, { ...raw, langs: [] })).toThrow(VerbUsageError);
    expect(() => parseInputs(taxonomy, { ...raw, jobs: [] })).toThrow(VerbUsageError);
    expect(() => parseInputs(taxonomy, { ...raw, kind: "service" })).toThrow(/--kind 'service' is not one of: product, process, library, unknown/);
    expect(() => parseInputs(taxonomy, { ...raw, role: "owner" })).toThrow(/--role 'owner' is not one of: canon, consumer, unregistered/);
    expect(() => parseInputs(taxonomy, { ...raw, issueKind: "chore" })).toThrow(/--issue-kind 'chore' is not one of: bug, enhancement, none/);
  });

  it("refuses a surface the registry lacks and an effort outside its levels", () => {
    expect(() => parseSession(registry, { surface: "nowhere", tier: null, effort: null })).toThrow(/--surface 'nowhere' is not one of: s1, s2/);
    expect(() => parseSession(registry, { surface: null, tier: null, effort: "extreme" })).toThrow(/--effort 'extreme' is not one of: low, medium, high, max/);
    expect(parseSession(registry, { surface: "s1", tier: "anything", effort: "max" })).toEqual({ surface: "s1", tier: "anything", effort: "max" });
  });
});
