import { describe, expect, it } from "vitest";
import { VerbUsageError } from "../cli/command.js";
import { loadClassifyTaxonomy } from "../classify/taxonomy.js";
import { loadDirectRegistry } from "./registry.js";
import {
  aggregate,
  checkRegistryAgainstTaxonomy,
  collectPairs,
  compareSession,
  DirectError,
  deriveDomain,
  evaluatePredicate,
  fallbackOrder,
  parseInputs,
  parseSession,
  renderEffort,
  resolveDirection,
  UNDIRECTABLE_JOB,
  UNREAD,
  UNSPELLED,
  type DirectInputs,
  type DomainFacts,
  type DomainVerdict,
  type EffortVerdict,
  type Resolution,
  type ResolvedSide,
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
const NO_SESSION: SessionValues = { surface: null, model: null, effort: null };

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

/** A resolution known to be directable, so a test reads its winner without a null check at every line. */
type Directed = Omit<Resolution, "winner" | "runnerUp" | "effort" | "domain"> & {
  readonly winner: ResolvedSide;
  readonly runnerUp: ResolvedSide | null;
  readonly effort: EffortVerdict;
  readonly domain: DomainVerdict;
};

function direct(c: ResolveContext, given: DirectInputs, session: SessionValues): Directed {
  const result = resolveDirection(c, given, session);
  if (result.winner === null || result.effort === null || result.domain === null) {
    throw new Error(`expected a directable resolution, got ${result.undirectable ?? "nothing"}`);
  }
  return result as Directed;
}

const inputs = (over: Partial<DirectInputs> = {}): DirectInputs => ({
  langs: ["alpha"],
  jobs: ["plain"],
  kind: "product",
  role: null,
  labels: [],
  ...over,
});

describe("evaluatePredicate -- every shape the taxonomy admits", () => {
  const { taxonomy } = context();
  const facts = (over: Partial<DomainFacts> = {}): DomainFacts => ({ kind: "product", role: null, labels: [], jobs: ["plain"], ...over });
  const holds = (when: Json | string, over: Partial<DomainFacts> = {}): boolean => {
    const loaded = context((): void => {}, (v): void => {
      v["domains"]["rule"] = [{ order: 1, domain: "dev", when }, { order: 2, domain: "dev", when: "otherwise" }];
    });
    const row = loaded.taxonomy.domains?.rule[0];
    if (row === undefined) throw new Error("no row");
    return evaluatePredicate(taxonomy, row.when, facts(over));
  };

  it("otherwise always matches", () => {
    expect(holds("otherwise")).toBe(true);
  });

  it("repoKind and repoRole: the value is in the list, verbatim; an absent role matches nothing", () => {
    expect(holds({ repoKind: ["process", "library"] }, { kind: "library" })).toBe(true);
    expect(holds({ repoKind: ["process"] }, { kind: "product" })).toBe(false);
    expect(holds({ repoRole: ["canon"] }, { role: "canon" })).toBe(true);
    expect(holds({ repoRole: ["canon"] }, { role: "consumer" })).toBe(false);
    expect(holds({ repoRole: ["canon"] }, { role: null })).toBe(false);
    // verbatim: nothing here knows the vocabulary
    expect(holds({ repoKind: ["whatever"] }, { kind: "whatever" })).toBe(true);
  });

  it("issueLabels.any: an exact label, or a '*:name' pattern under any namespace", () => {
    expect(holds({ issueLabels: { any: ["bug"] } }, { labels: ["bug"] })).toBe(true);
    expect(holds({ issueLabels: { any: ["bug"] } }, { labels: ["ns:bug"] })).toBe(false);
    expect(holds({ issueLabels: { any: ["*:bug"] } }, { labels: ["ns:bug"] })).toBe(true);
    expect(holds({ issueLabels: { any: ["*:bug"] } }, { labels: ["other:ns:bug"] })).toBe(false);
    expect(holds({ issueLabels: { any: ["*:bug"] } }, { labels: ["bug"] })).toBe(false);
    expect(holds({ issueLabels: { any: ["*:bug"] } }, { labels: [":bug", "ns:bugfix", "bug:ns"] })).toBe(false);
    expect(holds({ issueLabels: { any: ["bug", "*:bug"] } }, { labels: ["x", "ns:bug"] })).toBe(true);
    expect(holds({ issueLabels: { any: ["bug"] } }, { labels: [] })).toBe(false);
  });

  it("jobs.anyKey: the issue carries one of the keys", () => {
    expect(holds({ jobs: { anyKey: ["port-only", "heavy"] } }, { jobs: ["plain", "heavy"] })).toBe(true);
    expect(holds({ jobs: { anyKey: ["port-only"] } }, { jobs: ["plain"] })).toBe(false);
    expect(holds({ jobs: { anyKey: ["port-only"] } }, { jobs: [] })).toBe(false);
  });

  it("jobs.nonEmpty + everyListsOnly: at least one job and each lists phases only under that domain", () => {
    const only = { jobs: { nonEmpty: true, everyListsOnly: "ops" } };
    expect(holds(only, { jobs: ["ops-a", "ops-b"] })).toBe(true);
    expect(holds(only, { jobs: ["ops-a", "plain"] })).toBe(false);
    expect(holds(only, { jobs: [] })).toBe(false);
    // a job whose taxonomy entry states no phases cannot be maintenance-only
    expect(holds(only, { jobs: ["ops-a", "bare"] })).toBe(false);
  });

  it("anyOf: any member matches, nested", () => {
    const either = { anyOf: [{ repoKind: ["process"] }, { anyOf: [{ repoRole: ["canon"] }, { issueLabels: { any: ["x"] } }] }] };
    expect(holds(either, { kind: "process" })).toBe(true);
    expect(holds(either, { role: "canon" })).toBe(true);
    expect(holds(either, { labels: ["x"] })).toBe(true);
    expect(holds(either)).toBe(false);
  });

  it("an unknown predicate shape is refused when the taxonomy loads, by pointer (exit 1 in the verb)", () => {
    for (const [when, pointer] of [
      [{ repoSize: ["big"] }, "domains.rule[0].when.repoSize"],
      [{ repoKind: ["a"], repoRole: ["b"] }, "domains.rule[0].when"],
      [{ jobs: { nonEmpty: false } }, "domains.rule[0].when.jobs"],
      [{ jobs: { nonEmpty: true, everyListsOnly: "nowhere" } }, "domains.rule[0].when.jobs.everyListsOnly"],
      [{ jobs: { anyKey: ["no-such-job"] } }, "domains.rule[0].when.jobs.anyKey[0]"],
      [{ anyOf: [{ bogus: 1 }] }, "domains.rule[0].when.anyOf[0].bogus"],
      [{ repoKind: [] }, "domains.rule[0].when.repoKind"],
      [{ issueLabels: { any: ["bug"], all: ["x"] } }, "domains.rule[0].when.issueLabels.all"],
      [{ jobs: { anyKey: ["plain"], nonEmpty: true } }, "domains.rule[0].when.jobs.nonEmpty"],
      [{ jobs: { nonEmpty: true, everyListsOnly: "ops", extra: 1 } }, "domains.rule[0].when.jobs.extra"],
      [{ repoKind: ["a"], $note: "ok", repoRole: ["b"] }, "domains.rule[0].when"],
      [["otherwise"], "domains.rule[0].when"],
      ["sometimes", "domains.rule[0].when"],
    ] as [Json | string, string][]) {
      let caught: unknown = null;
      try {
        context((): void => {}, (v): void => {
          v["domains"]["rule"][0]["when"] = when;
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as { pointer?: string } | null)?.pointer, JSON.stringify(when)).toBe(pointer);
    }
  });
});

describe("domains.firstMatchWins", () => {
  it("refuses anything but true, by pointer; accepts true or absent", () => {
    for (const value of [false, "true", 1]) {
      let caught: unknown = null;
      try {
        context((): void => {}, (v): void => {
          v["domains"]["firstMatchWins"] = value;
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as { pointer?: string } | null)?.pointer, String(value)).toBe("domains.firstMatchWins");
    }
    expect(() => context((): void => {}, (v): void => {
      v["domains"]["firstMatchWins"] = true;
    })).not.toThrow();
    expect(() => context((): void => {}, (v): void => {
      delete v["domains"]["firstMatchWins"];
    })).not.toThrow();
  });
});

describe("deriveDomain -- the rows, first match wins", () => {
  const { taxonomy } = context();
  const domainOf = (over: Partial<DirectInputs>): [string, number] => {
    const verdict = deriveDomain(taxonomy, inputs(over));
    return [verdict.domain, verdict.rule];
  };

  it("row 1: the process kind, or the canon role", () => {
    expect(domainOf({ kind: "process" })).toEqual(["gov", 1]);
    expect(domainOf({ kind: "product", role: "canon" })).toEqual(["gov", 1]);
    expect(deriveDomain(taxonomy, inputs({ role: "canon" })).because).toBe("process or canon");
  });

  it("row 1 outranks every later row", () => {
    expect(domainOf({ kind: "process", jobs: ["port-only"], labels: ["bug"] })).toEqual(["gov", 1]);
  });

  it("row 2: the library kind", () => {
    expect(domainOf({ kind: "library" })).toEqual(["lib", 2]);
  });

  it("row 3: the marker job, which outranks the bug label", () => {
    expect(domainOf({ jobs: ["plain", "port-only"] })).toEqual(["port", 3]);
    expect(domainOf({ jobs: ["port-only"], labels: ["bug"] })).toEqual(["port", 3]);
  });

  it("row 4: a bug label (plain or namespaced) derives maintenance; another label does not", () => {
    expect(domainOf({ labels: ["bug"] })).toEqual(["ops", 4]);
    expect(domainOf({ labels: ["ns:bug"] })).toEqual(["ops", 4]);
    expect(domainOf({ labels: ["enhancement"] })).toEqual(["dev", 5]);
  });

  it("row 4: every job listing only maintenance phases derives it; one other job breaks that", () => {
    expect(domainOf({ jobs: ["ops-a", "ops-b"] })).toEqual(["ops", 4]);
    expect(domainOf({ jobs: ["ops-a", "plain"] })).toEqual(["dev", 5]);
    expect(domainOf({ jobs: ["ops-a", "bare"] })).toEqual(["dev", 5]);
  });

  it("row 5: otherwise; a library-only job alone is not the library kind", () => {
    expect(domainOf({})).toEqual(["dev", 5]);
    expect(domainOf({ jobs: ["lib-only"] })).toEqual(["dev", 5]);
  });

  it("reads every domain name from the taxonomy: the real file's names come out, not the mini file's", () => {
    const real = loadClassifyTaxonomy("/", REAL_TAXONOMY);
    const rows = real.domains?.rule.map((row): string => row.domain) ?? [];
    const real_ = (over: Partial<DirectInputs>): string => deriveDomain(real, inputs({ jobs: ["implementation"], ...over })).domain;
    expect(real_({ kind: "process" })).toBe(rows[0]);
    expect(real_({ role: "canon" })).toBe(rows[0]);
    expect(real_({ kind: "library" })).toBe(rows[1]);
    expect(real_({ jobs: ["parity"] })).toBe(rows[2]);
    expect(real_({ labels: ["bankai:bug"] })).toBe(rows[3]);
    expect(real_({ jobs: ["ci-cd", "refactor"] })).toBe(rows[3]);
    expect(real_({})).toBe(rows[4]);
  });

  it("refuses, as failures, a taxonomy with no domains block, no rows, or no matching row", () => {
    const none = context((): void => {}, (v): void => {
      delete v["domains"];
    });
    expect(() => deriveDomain(none.taxonomy, inputs())).toThrow(DirectError);
    const empty = context((): void => {}, (v): void => {
      v["domains"]["rule"] = [];
    });
    expect(() => deriveDomain(empty.taxonomy, inputs())).toThrow(/there are no rows/);
    const open = context((): void => {}, (v): void => {
      v["domains"]["rule"].pop();
    });
    expect(() => deriveDomain(open.taxonomy, inputs())).toThrow(/no row matched/);
  });
});

describe("fallbackOrder -- the taxonomy's sentence after its colon, derived domain first", () => {
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

  it("reads only what follows the colon: a domain named in the clause before it does not set the order", () => {
    const clause = { ...domains, fallback: "port work routes on gov first, in this order: the derived domain, lib, ops." };
    expect(fallbackOrder(clause, "dev")).toEqual(["dev", "lib", "ops", "port", "gov"]);
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
    expect(result.pairs.map((pair): string | null => pair.fallbackFrom)).toEqual(["dev", null]);
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

  it("reads the shared cell for every job when no language is given", () => {
    const c = context();
    const { pairs } = collectPairs(c.registry, c.taxonomy, inputs({ langs: [], jobs: ["plain", "heavy"] }), "dev");
    expect(pairs.map((pair): [string, string, string] => [pair.job, pair.lang, pair.cell])).toEqual([
      ["plain", "*", "*"],
      ["heavy", "*", "*"],
    ]);
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

  it("never returns the winner as the runner-up: with none distinct the runner-up is null", () => {
    const result = run({ plain: [side("A_TOP", "s1"), side("A_TOP", "s1")] }, ["plain"]);
    expect(result.runnerUp).toBeNull();
    expect(result.runnerUpSides).toEqual([]);
    // a reviewer runner-up whose stand-in is the winner resolves to the winner: still none distinct
    const standIn = run({ plain: [side("A_TOP", "s1"), side("R_BOT", null, { also: "A_TOP" })] }, ["plain"]);
    expect(standIn.runnerUp).toBeNull();
  });

  it("reads the winning pairs' runner-ups only, never a skipped pair's", () => {
    // heavy's winner is a reviewer with no stand-in (skipped) and its runner-up is a distinct alias;
    // the counted pair's runner-up equals the winner, so there is no distinct runner-up
    const result = run(
      { plain: [side("A_TOP", "s1"), side("A_TOP", "s1")], heavy: [side("R_BOT", null), side("A_EXEC", "s2")] },
      ["plain", "heavy"],
    );
    expect(result.skipped).toHaveLength(1);
    expect(result.runnerUp).toBeNull();
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
    const result = direct(context(), inputs(), NO_SESSION);
    expect(result.winner).toMatchObject({ alias: "A_TOP", surface: "s1", tier: "deep", surfaceAlias: "opus", restart: "s1 --model opus", effortControl: "/effort <level>" });
    expect(result.runnerUp).toMatchObject({ alias: "A_FAST", surfaceAlias: "quick" });
  });

  it("reports 'unspelled' when the workflow has no models block, or no such tier, and keeps the placeholder", () => {
    const none = direct(context((): void => {}, (): void => {}, {}), inputs(), NO_SESSION);
    expect(none.winner.surfaceAlias).toBe(UNSPELLED);
    expect(none.winner.restart).toBe("s1 --model <alias>");
    const noTier = direct(context((): void => {}, (): void => {}, { k1: { fast: "quick" } }), inputs(), NO_SESSION);
    expect(noTier.winner.surfaceAlias).toBe(UNSPELLED);
    expect(noTier.runnerUp?.surfaceAlias).toBe("quick");
  });

  it("reads the surface from the alias, and fills the restart's <alias> and <level> from the workflow and the effort map", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "*", side("A_EXEC", "s2"));
    });
    const result = direct(c, inputs(), NO_SESSION);
    expect(result.winner).toMatchObject({ surface: "s2", surfaceAlias: "exec", restart: "s2 -m exec -c level=lo", effortControl: "reasoning <level>" });
    // the same level through the other surface's own map
    expect(result.runnerUp?.restart).toBe("s1 --model quick");
  });

  it("resolves a reviewer runner-up to its stand-in, always an actionable alias with a surface", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "*", side("A_TOP", "s1"), side("R_BOT", null, { also: "A_EXEC" }));
    });
    const runnerUp = direct(c, inputs(), NO_SESSION).runnerUp;
    expect(runnerUp).toMatchObject({ alias: "A_EXEC", reviewer: false, surface: "s2", surfaceAlias: "exec" });
  });

  it("carries the reviewer product a stand-in stood in for, on the resolved runner-up", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "*", side("A_TOP", "s1"), side("R_BOT", null, { also: "A_EXEC" }));
    });
    const result = direct(c, inputs(), NO_SESSION);
    expect(result.runnerUp).toMatchObject({ alias: "A_EXEC", substituted: "R_BOT" });
    expect(result.winner.substituted).toBeNull();
  });

  it("builds the interactive list: surface, each language's tool, the cell's, deduplicated, nulls dropped", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "*", side("A_TOP", "s1", { interactive: "the alpha IDE" }));
      setCell(v, "heavy", "dev", "*", side("A_TOP", "s1", { interactive: "a cell tool" }));
    });
    const result = direct(c, inputs({ langs: ["alpha", "delta", "beta"], jobs: ["plain", "heavy"] }), NO_SESSION);
    // delta shares alpha's tool; the first cell's tool repeats alpha's; the second cell adds one
    expect(result.winner.interactive).toEqual(["the s1 desktop", "the alpha IDE", "the beta IDE", "a cell tool"]);
  });

  it("quotes the dated snapshot and the provider's live-lookup sources, or null when there are none", () => {
    const result = direct(context(), inputs(), NO_SESSION);
    expect(result.winner.snapshot).toEqual({ asOf: "2026-01-02", primary: "Top 1", modelId: "top-1", fallback: "Max 1" });
    expect(result.winner.liveLookup).toEqual({ cli: "p1 models", docs: ["https://p1.example/models"] });
    expect(result.runnerUp?.snapshot).toBeNull();
  });
});

describe("scoreEffort -- the rule, band by band", () => {
  const effortOf = (over: Partial<DirectInputs>, c: ResolveContext = context()): [number, string] => {
    const effort = direct(c, inputs(over), NO_SESSION).effort;
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
    // a rule naming its own domain beside the key adds on that one instead
    const moved = context((v): void => {
      v["effort"]["rule"]["plusOne"][2] = { when: "the derived domain is lib", key: "libAdd", domain: "lib" };
    });
    expect(effortOf({ jobs: ["plain"], kind: "process" }, moved)).toEqual([2, "low"]);
    expect(effortOf({ jobs: ["lib-only"], kind: "library" }, moved)).toEqual([3, "medium"]);
  });

  it("reports the derivation as the sum's terms, then the one-line rendering", () => {
    const effort = direct(context(), inputs({ jobs: ["heavy", "light", "plain"], kind: "process" }), NO_SESSION).effort;
    expect(effort.derivation).toEqual(["weight 4", "manyJobs", "gov"]);
    expect(renderEffort(effort)).toBe("weight 4 + manyJobs + gov = 6 -> max");
    expect(renderEffort(direct(context(), inputs({ jobs: ["light"] }), NO_SESSION).effort)).toBe("weight 1 = 1 -> low");
  });

  it("maps the level through the winner surface's own control", () => {
    const onS1 = direct(context(), inputs({ jobs: ["heavy"], langs: ["alpha", "beta"] }), NO_SESSION);
    expect(onS1.effort.surfaceEffort).toBe("max");
    const c = context((v): void => {
      setCell(v, "heavy", "dev", "*", side("A_EXEC", "s2"));
    });
    const onS2 = direct(c, inputs({ jobs: ["heavy"], langs: ["alpha", "beta"] }), NO_SESSION);
    expect(onS2.effort.surfaceEffort).toBe("xhi");
  });

  it("refuses, as failures, a job with no weight and a domain add the taxonomy does not know", () => {
    expect(() => direct(context(), inputs({ jobs: ["bare"] }), NO_SESSION)).toThrow(/job 'bare' has no weight/);
    const typo = context((v): void => {
      v["effort"]["rule"]["plusOne"][2] = { when: "x", key: "x", domain: "nowhere" };
    });
    expect(() => direct(typo, inputs(), NO_SESSION)).toThrow(/targets 'nowhere', which is not one of the taxonomy's domains/);
  });
});

describe("undirectable and empty axes -- answers, not errors", () => {
  it("an empty job axis is undirectable: nulls everywhere, nothing asked of the registry", () => {
    const result = resolveDirection(context(), inputs({ jobs: [] }), { surface: "s1", model: "opus", effort: "max" });
    expect(result).toMatchObject({ undirectable: UNDIRECTABLE_JOB, domain: null, pairs: [], winner: null, runnerUp: null, effort: null, mismatch: null });
    expect(UNDIRECTABLE_JOB).toBe("job axis empty");
  });

  it("an empty language axis reads the shared cell for every job, and counts no code language", () => {
    const result = direct(context(), inputs({ langs: [], jobs: ["heavy"] }), NO_SESSION);
    expect(result.pairs.map((pair): string => pair.cell)).toEqual(["*"]);
    expect(result.effort).toMatchObject({ score: 4, level: "high" });
  });
});

describe("compareSession -- a mismatch is an answer, compared in the session's own terms", () => {
  const c = context();
  const winner = direct(c, inputs(), NO_SESSION).winner;
  if (winner === null) throw new Error("fixture lost its winner");
  const compare = (session: Partial<SessionValues>, level = "low"): ReturnType<typeof compareSession> =>
    compareSession(c.registry, { surface: null, model: null, effort: null, ...session }, winner, level);

  it("is null when the session gave nothing to compare", () => {
    expect(compare({})).toBeNull();
  });

  it("matches when every given value equals the recommendation, comparing only what was given", () => {
    expect(compare({ surface: "s1", model: "opus", effort: "low" })).toEqual({
      match: true,
      compares: [
        { field: "surface", session: "s1", recommended: "s1", verdict: "match" },
        { field: "model", session: "opus", recommended: "opus", verdict: "match" },
        { field: "effort", session: "low", recommended: "low", verdict: "match" },
      ],
    });
    expect(compare({ surface: "s1" })?.compares.map((entry): string => entry.field)).toEqual(["surface"]);
  });

  it("reports each differing field, and the model by alias against the workflow's spelling", () => {
    expect(compare({ surface: "s2" })?.compares[0]).toEqual({ field: "surface", session: "s2", recommended: "s1", verdict: "mismatch" });
    expect(compare({ model: "quick" })?.compares[0]).toEqual({ field: "model", session: "quick", recommended: "opus", verdict: "mismatch" });
    const effort = compare({ effort: "max" });
    expect(effort?.match).toBe(false);
    expect(effort?.compares[0]).toEqual({ field: "effort", session: "max", recommended: "low", verdict: "mismatch" });
  });

  it("compares effort in DIAL space: a collapsed top matches a session at the dial below it", () => {
    // s3 maps max -> high, so a session at high on s3 matches a recommended max
    expect(compare({ surface: "s3", effort: "high" }, "max")?.compares.at(-1)).toMatchObject({ recommended: "high", verdict: "match" });
    expect(compare({ surface: "s3", effort: "max" }, "high")?.compares.at(-1)).toMatchObject({ verdict: "match" });
    expect(compare({ surface: "s3", effort: "medium" }, "max")?.compares.at(-1)).toMatchObject({ verdict: "mismatch" });
    // on a surface with a dial for every level, max stays distinct from high
    expect(compare({ surface: "s1", effort: "high" }, "max")?.compares.at(-1)).toMatchObject({ verdict: "mismatch" });
    // the dial is read through the session's surface when it gave one
    expect(compare({ surface: "s2", effort: "max" }, "max")?.compares.at(-1)).toMatchObject({ recommended: "xhi", verdict: "match" });
  });

  it("reads the winner's surface for the dial when the session did not say which it is on", () => {
    expect(compare({ effort: "low" }, "low")?.compares[0]).toMatchObject({ recommended: "low", verdict: "match" });
    expect(compare({ surface: UNREAD, effort: "low" }, "low")?.compares.at(-1)).toMatchObject({ verdict: "match" });
  });

  it("marks an unread value unread, never a mismatch, and keeps comparing the rest", () => {
    const result = compare({ surface: UNREAD, model: "quick", effort: UNREAD });
    expect(result?.compares.map((entry): string => entry.verdict)).toEqual(["unread", "mismatch", "unread"]);
    expect(result?.match).toBe(false);
    const allUnread = compare({ surface: UNREAD, model: UNREAD, effort: UNREAD });
    expect(allUnread?.match).toBe(true);
    expect(allUnread?.compares.every((entry): boolean => entry.verdict === "unread")).toBe(true);
  });

  it("flows through resolveDirection without refusing, and never compares a model against an alias the workflow does not spell: that is unread", () => {
    const result = direct(context(), inputs(), { surface: "s2", model: "x", effort: "max" });
    expect(result.mismatch?.compares.map((entry): string => entry.field)).toEqual(["surface", "model", "effort"]);
    const bare = direct(context((): void => {}, (): void => {}, {}), inputs(), { surface: null, model: "opus", effort: null });
    expect(bare.mismatch?.compares).toEqual([{ field: "model", session: "opus", recommended: null, verdict: "unread" }]);
    expect(bare.mismatch?.match).toBe(true);
  });
});

describe("parseInputs and parseSession -- usage refusals name the valid set", () => {
  const { registry, taxonomy } = context();
  const raw = { langs: ["alpha"], jobs: ["plain"], kind: "product", role: null, labels: [] };

  it("accepts a valid classification, passing kind and role through verbatim", () => {
    expect(parseInputs(taxonomy, raw)).toEqual({ langs: ["alpha"], jobs: ["plain"], kind: "product", role: null, labels: [] });
    expect(parseInputs(taxonomy, { ...raw, kind: "anything", role: "else", labels: ["a", "a", "b"] })).toMatchObject({ kind: "anything", role: "else", labels: ["a", "b"] });
  });

  it("drops a repeated key, and accepts empty axes", () => {
    expect(parseInputs(taxonomy, { ...raw, langs: ["alpha", "alpha"] }).langs).toEqual(["alpha"]);
    expect(parseInputs(taxonomy, { ...raw, langs: [], jobs: [] })).toMatchObject({ langs: [], jobs: [] });
  });

  it("refuses an unknown language or job key, naming the valid keys", () => {
    expect(() => parseInputs(taxonomy, { ...raw, langs: ["nope"] })).toThrow(/unknown language key 'nope'. Valid: alpha, beta, gamma, delta/);
    expect(() => parseInputs(taxonomy, { ...raw, jobs: ["nope", "plain"] })).toThrow(/unknown job key 'nope'. Valid: plain, heavy/);
  });

  it("refuses only an empty kind or role", () => {
    expect(() => parseInputs(taxonomy, { ...raw, kind: " " })).toThrow(VerbUsageError);
    expect(() => parseInputs(taxonomy, { ...raw, role: "" })).toThrow(VerbUsageError);
  });

  it("refuses a surface the registry lacks and an effort outside its levels, both accepting unread", () => {
    expect(() => parseSession(registry, { surface: "nowhere", model: null, effort: null })).toThrow(/--surface 'nowhere' is not one of: s1, s3, s2, unread/);
    expect(() => parseSession(registry, { surface: null, model: null, effort: "extreme" })).toThrow(/--effort 'extreme' is not one of: low, medium, high, max, unread/);
    expect(parseSession(registry, { surface: UNREAD, model: UNREAD, effort: UNREAD })).toEqual({ surface: UNREAD, model: UNREAD, effort: UNREAD });
    expect(parseSession(registry, { surface: "s1", model: "anything", effort: "max" })).toEqual({ surface: "s1", model: "anything", effort: "max" });
  });
});

describe("checkRegistryAgainstTaxonomy -- the two loaded files must agree", () => {
  it("refuses a routing cell key that is neither the shared cell nor a taxonomy language", () => {
    const c = context((v): void => {
      setCell(v, "plain", "dev", "nolang", side("A_TOP", "s1"));
    });
    expect(() => direct(c, inputs(), NO_SESSION)).toThrow(/at routing\.plain\.dev\.cells\.nolang, is neither the shared '\*' cell/);
    let caught: unknown = null;
    try {
      resolveDirection(c, inputs({ jobs: [] }), NO_SESSION);
    } catch (error) {
      caught = error;
    }
    expect((caught as { pointer?: string } | null)?.pointer).toBe("routing.plain.dev.cells.nolang");
  });

  it("refuses a routing domain that is not one of the taxonomy's domains", () => {
    const c = context((v): void => {
      v["routing"]["plain"]["nowhere"] = v["routing"]["plain"]["dev"];
    });
    expect(() => direct(c, inputs(), NO_SESSION)).toThrow(/at routing\.plain\.nowhere, names domain "nowhere"/);
  });

  it("accepts the real pair, and the mini pair", () => {
    const registry = loadDirectRegistry("/", REAL_REGISTRY);
    const taxonomy = loadClassifyTaxonomy("/", REAL_TAXONOMY);
    expect(() => checkRegistryAgainstTaxonomy(registry, taxonomy)).not.toThrow();
    const c = context();
    expect(() => checkRegistryAgainstTaxonomy(c.registry, c.taxonomy)).not.toThrow();
  });
});
