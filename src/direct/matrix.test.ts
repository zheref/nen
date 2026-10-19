// src/direct/matrix.test.ts -- `nen direct matrix` (zheref/nen#426), held to `nen direct resolve`.
//
// The matrix claims to own no rule: every cell is what `resolve` answers. So the
// proof is a comparison, not a re-statement -- each cell below is checked against
// the JSON `direct resolve` prints for the cell's own witness issue, through the
// same CLI entry point a consumer calls. The real fixtures (Hatsu's registry and
// taxonomy) are compared EXHAUSTIVELY; the mini vocabulary builds the edges the real
// files do not carry (a reviewer winning with and without a stand-in, a winner that
// is its own runner-up, an unweighted or unrouted job, a tie across jobs).

import { describe, expect, it } from "vitest";
import {
  capture,
  consumerRepo,
  miniFiles,
  mutatedRegistry,
  REAL_REGISTRY,
  REAL_TAXONOMY,
  setCell,
  side,
  type Json,
} from "./fixtures/harness.js";

const matrixArgs = (repo: string, registry: string, taxonomy: string, ...rest: string[]): string[] => [
  "direct", "matrix", "--registry", registry, "--taxonomy", taxonomy, "--repo", repo, ...rest,
];

async function matrixJson(repo: string, registry: string, taxonomy: string, ...rest: string[]): Promise<Json> {
  const result = await capture(matrixArgs(repo, registry, taxonomy, ...rest, "--json"));
  expect(result.code, result.err.join("\n")).toBe(0);
  return JSON.parse(result.out.join("\n")) as Json;
}

/** The `resolve` argv a witness spells, plus the cell's language (none for the shared column). */
function witnessArgs(witness: Json, lang: string): string[] {
  const argv = ["--kind", witness["kind"], "--job", (witness["jobs"] as string[]).join(",")];
  if (witness["role"] !== null) argv.push("--role", witness["role"]);
  if ((witness["labels"] as string[]).length > 0) argv.push("--labels", (witness["labels"] as string[]).join(","));
  if (lang !== "*") argv.push("--lang", lang);
  return argv;
}

async function resolveJson(repo: string, registry: string, taxonomy: string, argv: readonly string[]): Promise<Json> {
  const result = await capture(["direct", "resolve", "--registry", registry, "--taxonomy", taxonomy, "--repo", repo, ...argv, "--json"]);
  expect(result.code, `${argv.join(" ")}\n${result.err.join("\n")}`).toBe(0);
  return JSON.parse(result.out.join("\n")) as Json;
}

function entryOf(matrix: Json, job: string, domain: string): Json {
  const row = (matrix["jobs"] as Json[]).find((entry): boolean => entry["job"] === job) as Json;
  return (row["domains"] as Json[]).find((entry): boolean => entry["domain"] === domain) as Json;
}

function cellOf(matrix: Json, job: string, domain: string, lang: string): Json {
  return (entryOf(matrix, job, domain)["cells"] as Json[]).find((cell): boolean => cell["lang"] === lang) as Json;
}

/**
 * Hold one cell to `resolve` on its witness. A witness of the job alone is the
 * issue the cell describes, so the whole answer must be equal; a witness that
 * needed companions shares the domain and the job's own pairs, which must be equal.
 */
async function expectAgrees(repo: string, registry: string, taxonomy: string, entry: Json, cell: Json): Promise<void> {
  const witness = entry["witness"] as Json;
  const resolved = await resolveJson(repo, registry, taxonomy, witnessArgs(witness, cell["lang"]));
  const where = `${cell["pair"]["job"]} x ${entry["domain"]} x ${cell["lang"]}`;
  expect(resolved["domain"]["domain"], where).toBe(entry["domain"]);
  expect(resolved["domain"]["rule"], where).toBe(witness["rule"]);
  const own = (resolved["pairs"] as Json[]).find((pair): boolean => pair["job"] === cell["pair"]["job"] && pair["lang"] === cell["pair"]["lang"]);
  expect(own, where).toEqual(cell["pair"]);
  const note = entry["fallback"];
  if (note === null) {
    expect(resolved["domain"]["fallbacks"] as string[], where).not.toContainEqual(expect.stringMatching(new RegExp(`^fallback: ${cell["pair"]["job"]} `)));
  } else {
    expect(resolved["domain"]["fallbacks"], where).toContain(note);
  }
  expect(entry["witnessIsCell"], where).toBe((witness["jobs"] as string[]).length === 1);
  if (entry["witnessIsCell"] === true) {
    expect(resolved["winner"], where).toEqual(cell["winner"]);
    expect(resolved["runnerUp"], where).toEqual(cell["runnerUp"]);
    expect(resolved["effort"], where).toEqual(cell["effort"]);
    expect(resolved["aggregate"], where).toEqual(cell["aggregate"]);
  }
}

describe("nen direct matrix -- the real registry, every cell held to resolve", () => {
  const repo = consumerRepo();

  it("enumerates every job in every domain, the shared column and each language", async () => {
    const matrix = await matrixJson(repo, REAL_REGISTRY, REAL_TAXONOMY);
    expect(matrix["contract"]).toBe("nen.direct.matrix/v0.1");
    expect(matrix["languages"][0]).toBe("*");
    expect(matrix["counts"]).toMatchObject({ jobs: 39, domains: 5, unreachable: 2, skipped: 0 });
    expect(matrix["counts"]["reachable"] + matrix["counts"]["unreachable"]).toBe(39 * 5);
    expect(matrix["counts"]["cells"]).toBe(matrix["counts"]["reachable"] * (matrix["languages"] as string[]).length);
    expect(matrix["search"]).toEqual({ kinds: ["unlisted", "process", "library"], roles: [null, "canon"], labels: [[], ["bug"], ["ns:bug"]], maxCompanions: 2 });
    expect(matrix["domains"][0]).toEqual({ domain: "feature", fallbackOrder: ["feature", "maintenance", "library", "aigov", "parity"] });
  });

  it("agrees with direct resolve on every reachable cell (the exhaustive comparison)", async () => {
    const matrix = await matrixJson(repo, REAL_REGISTRY, REAL_TAXONOMY);
    let compared = 0;
    for (const job of matrix["jobs"] as Json[]) {
      for (const entry of job["domains"] as Json[]) {
        for (const cell of entry["cells"] as Json[]) {
          await expectAgrees(repo, REAL_REGISTRY, REAL_TAXONOMY, entry, cell);
          compared += 1;
        }
      }
    }
    expect(compared).toBe(matrix["counts"]["cells"]);
  }, 120_000);

  it("a phase fallback: a job with no phase in the domain names its route, as resolve does", async () => {
    const matrix = await matrixJson(repo, REAL_REGISTRY, REAL_TAXONOMY, "--job", "ci-cd", "--domain", "feature");
    const entry = entryOf(matrix, "ci-cd", "feature");
    expect(entry).toMatchObject({ reachable: true, routedOn: "maintenance", fallbackFrom: "feature", fallback: "fallback: ci-cd has no feature phase; routed on maintenance" });
    // ci-cd lists only maintenance, so alone it derives maintenance: the witness needs a companion.
    expect(entry["witness"]["jobs"]).toHaveLength(2);
    await expectAgrees(repo, REAL_REGISTRY, REAL_TAXONOMY, entry, cellOf(matrix, "ci-cd", "feature", "swift"));
  });

  it("a reviewer runner-up resolves to its stand-in and says so, as resolve does", async () => {
    const matrix = await matrixJson(repo, REAL_REGISTRY, REAL_TAXONOMY, "--job", "review", "--domain", "maintenance");
    const cell = cellOf(matrix, "review", "maintenance", "*");
    expect(cell["pair"]["runnerUp"]).toMatchObject({ alias: "EXECUTION_FRONTIER", substituted: "PR_QUALITY_REVIEW" });
    expect(cell["runnerUp"]).toMatchObject({ alias: "EXECUTION_FRONTIER", substituted: "PR_QUALITY_REVIEW" });
    await expectAgrees(repo, REAL_REGISTRY, REAL_TAXONOMY, entryOf(matrix, "review", "maintenance"), cell);
  });

  it("the shared column and a language without its own cell both read '*'; prose always does", async () => {
    const matrix = await matrixJson(repo, REAL_REGISTRY, REAL_TAXONOMY, "--job", "implementation", "--domain", "feature");
    const entry = entryOf(matrix, "implementation", "feature");
    expect(cellOf(matrix, "implementation", "feature", "*")["cell"]).toBe("*");
    expect(cellOf(matrix, "implementation", "feature", "prose")["cell"]).toBe("*");
    for (const cell of entry["cells"] as Json[]) await expectAgrees(repo, REAL_REGISTRY, REAL_TAXONOMY, entry, cell);
  });

  it("effort: the domain add moves a weight-3 job across the medium/high band edge", async () => {
    const matrix = await matrixJson(repo, REAL_REGISTRY, REAL_TAXONOMY, "--job", "review");
    expect(cellOf(matrix, "review", "feature", "*")["effort"]).toMatchObject({ score: 3, level: "medium", derivation: ["weight 3"] });
    expect(cellOf(matrix, "review", "aigov", "*")["effort"]).toMatchObject({ score: 4, level: "high", derivation: ["weight 3", "aigov"] });
  });

  it("a domain no issue carrying the job can derive is unreachable, with no cells", async () => {
    const matrix = await matrixJson(repo, REAL_REGISTRY, REAL_TAXONOMY, "--job", "parity");
    for (const domain of ["feature", "maintenance"]) {
      expect(entryOf(matrix, "parity", domain)).toEqual({ domain, reachable: false, witness: null, witnessIsCell: false, routedOn: null, fallbackFrom: null, phase: null, phaseName: null, fallback: null, cells: [] });
    }
    // resolve agrees: the job's own marker row decides before maintenance or feature can.
    const resolved = await resolveJson(repo, REAL_REGISTRY, REAL_TAXONOMY, ["--kind", "unlisted", "--labels", "bug", "--job", "parity,ci-cd"]);
    expect(resolved["domain"]["domain"]).toBe("parity");
    expect(entryOf(matrix, "parity", "aigov")["reachable"]).toBe(true);
  });

  it("is self-hosted: nen's own nen/workflow.json spells the aliases the same way resolve does", async () => {
    const self = process.cwd();
    const matrix = await matrixJson(self, REAL_REGISTRY, REAL_TAXONOMY, "--job", "implementation,security", "--domain", "feature,library");
    for (const job of matrix["jobs"] as Json[]) {
      for (const entry of job["domains"] as Json[]) {
        for (const cell of entry["cells"] as Json[]) await expectAgrees(self, REAL_REGISTRY, REAL_TAXONOMY, entry, cell);
      }
    }
  });
});

describe("nen direct matrix -- the edges, on the mini vocabulary", () => {
  const repo = consumerRepo({ k1: { deep: "top", fast: "fast", frontier: "max" }, k2: { deep: "exec" }, k3: { fast: "cheap" } });
  const routed = ["plain", "heavy", "light", "mid", "ops-a", "ops-b", "port-only", "lib-only", "odd"].join(",");

  it("a reviewer winner with a stand-in counts as its stand-in; without one the cell is skipped", async () => {
    const { registryPath, taxonomyPath } = miniFiles((v): void => {
      setCell(v, "plain", "dev", "*", side("R_BOT", null, { also: "A_EXEC" }));
      setCell(v, "light", "dev", "*", side("R_BOT", null));
    });
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "plain,light", "--domain", "dev");
    const standIn = cellOf(matrix, "plain", "dev", "*");
    expect(standIn).toMatchObject({ skipped: false, winner: { alias: "A_EXEC", surface: "s2", substituted: "R_BOT" } });
    await expectAgrees(repo, registryPath, taxonomyPath, entryOf(matrix, "plain", "dev"), standIn);
    const skipped = cellOf(matrix, "light", "dev", "alpha");
    expect(skipped).toMatchObject({ skipped: true, winner: null, runnerUp: null, aggregate: null, effort: { level: "low", surfaceEffort: null } });
    expect(skipped["pair"]["winner"]).toMatchObject({ alias: "R_BOT", substituted: null });
    expect(matrix["counts"]["skipped"]).toBe((matrix["languages"] as string[]).length);
    // resolve refuses that issue alone (exit 1), which is why the matrix reports it rather than a winner.
    const alone = await capture(["direct", "resolve", "--registry", registryPath, "--taxonomy", taxonomyPath, "--repo", repo, "--kind", "unlisted", "--job", "light"]);
    expect(alone.code).toBe(1);
    expect(alone.err.join("\n")).toMatch(/reviewer alias with no stand-in \(R_BOT\)/);
  });

  it("a winner that is also its own runner-up leaves the runner-up none distinct, as resolve does", async () => {
    const { registryPath, taxonomyPath } = miniFiles((v): void => {
      setCell(v, "plain", "dev", "*", side("A_TOP", "s1"), side("A_TOP", "s1"));
    });
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "plain", "--domain", "dev");
    const cell = cellOf(matrix, "plain", "dev", "*");
    expect(cell["runnerUp"]).toBeNull();
    await expectAgrees(repo, registryPath, taxonomyPath, entryOf(matrix, "plain", "dev"), cell);
  });

  it("a language's own cell is read for a code language, never for a non-code one", async () => {
    const { registryPath, taxonomyPath } = miniFiles((v): void => {
      setCell(v, "plain", "dev", "alpha", side("A_EXEC", "s2"));
      setCell(v, "plain", "dev", "gamma", side("A_EXEC", "s2"));
    });
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "plain", "--domain", "dev");
    expect(cellOf(matrix, "plain", "dev", "alpha")).toMatchObject({ cell: "alpha", winner: { alias: "A_EXEC" } });
    expect(cellOf(matrix, "plain", "dev", "gamma")).toMatchObject({ cell: "*", winner: { alias: "A_TOP" } });
    const entry = entryOf(matrix, "plain", "dev");
    for (const cell of entry["cells"] as Json[]) await expectAgrees(repo, registryPath, taxonomyPath, entry, cell);
  });

  it("a tie across a multi-job witness: each job keeps its own pair, and resolve's tally breaks the tie by precedence", async () => {
    // ops-a lists only ops, so alone it derives ops: in dev its witness carries a companion.
    const { registryPath, taxonomyPath } = miniFiles((v): void => {
      setCell(v, "ops-a", "ops", "*", side("A_EXEC", "s2"));
    });
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "ops-a", "--domain", "dev");
    const entry = entryOf(matrix, "ops-a", "dev");
    expect(entry).toMatchObject({ routedOn: "ops", fallbackFrom: "dev" });
    expect(entry["witness"]["jobs"]).toEqual(["ops-a", "plain"]);
    const cell = cellOf(matrix, "ops-a", "dev", "*");
    expect(cell["winner"]["alias"]).toBe("A_EXEC");
    await expectAgrees(repo, registryPath, taxonomyPath, entry, cell);
    // The witness issue is a 1-1 tie (A_EXEC for ops-a, A_TOP for plain): precedence ranks A_TOP first.
    const resolved = await resolveJson(repo, registryPath, taxonomyPath, witnessArgs(entry["witness"], "*"));
    expect(resolved["aggregate"]["tally"]).toEqual({ A_TOP: 1, A_EXEC: 1 });
    expect(resolved["winner"]["alias"]).toBe("A_TOP");
    // ...which is why the entry says one resolve call does NOT reproduce this cell.
    expect(entry["witnessIsCell"]).toBe(false);
    expect(entryOf(await matrixJson(repo, registryPath, taxonomyPath, "--job", "plain", "--domain", "dev"), "plain", "dev")["witnessIsCell"]).toBe(true);
  });

  it("effort band edges: the domain add, the shared column and a single language, held to resolve", async () => {
    const { registryPath, taxonomyPath } = miniFiles();
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "mid,heavy,light", "--domain", "dev,gov");
    expect(cellOf(matrix, "mid", "dev", "*")["effort"]).toMatchObject({ score: 3, level: "medium" });
    expect(cellOf(matrix, "mid", "gov", "*")["effort"]).toMatchObject({ score: 4, level: "high", derivation: ["weight 3", "gov"] });
    expect(cellOf(matrix, "heavy", "dev", "alpha")["effort"]).toMatchObject({ score: 4, level: "high" });
    expect(cellOf(matrix, "heavy", "gov", "alpha")["effort"]).toMatchObject({ score: 5, level: "max", surfaceEffort: "max" });
    expect(cellOf(matrix, "light", "dev", "*")["effort"]).toMatchObject({ score: 1, level: "low" });
    for (const job of matrix["jobs"] as Json[]) {
      for (const entry of job["domains"] as Json[]) {
        for (const cell of entry["cells"] as Json[]) await expectAgrees(repo, registryPath, taxonomyPath, entry, cell);
      }
    }
  });

  it("finds witnesses through kind, role and label rows, and names the rule row", async () => {
    const { registryPath, taxonomyPath } = miniFiles();
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "plain");
    expect(entryOf(matrix, "plain", "gov")["witness"]).toEqual({ kind: "unlisted", role: "canon", labels: [], jobs: ["plain"], rule: 1, because: "process or canon" });
    expect(entryOf(matrix, "plain", "lib")["witness"]).toMatchObject({ kind: "library", rule: 2 });
    expect(entryOf(matrix, "plain", "ops")["witness"]).toMatchObject({ labels: ["bug"], rule: 4 });
    expect(entryOf(matrix, "plain", "port")["witness"]).toMatchObject({ jobs: ["plain", "port-only"], rule: 3 });
    expect(entryOf(matrix, "plain", "dev")["witness"]).toMatchObject({ kind: "unlisted", role: null, labels: [], jobs: ["plain"], rule: 5 });
  });

  it("a witness may need two companions: a key job that itself trips an earlier everyListsOnly row", async () => {
    // Row 3 now takes an issue whose every job lists only ops; row 4 puts ops-b in port.
    // ops-a and ops-b both list only ops, so [ops-a, ops-b] still derives ops: port needs
    // a third job that lists another domain, and the search's second companion finds it.
    const { registryPath, taxonomyPath } = miniFiles(undefined, (t): void => {
      t["domains"]["rule"][2] = { order: 3, domain: "ops", when: { jobs: { nonEmpty: true, everyListsOnly: "ops" } }, $comment: "ops only" };
      t["domains"]["rule"][3] = { order: 4, domain: "port", when: { jobs: { anyKey: ["ops-b"] } }, $comment: "the ops-b marker" };
    });
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "ops-a", "--domain", "port");
    const entry = entryOf(matrix, "ops-a", "port");
    expect(entry).toMatchObject({ reachable: true, routedOn: "ops", fallbackFrom: "port" });
    expect(entry["witness"]).toMatchObject({ jobs: ["ops-a", "plain", "ops-b"], rule: 4 });
    for (const cell of entry["cells"] as Json[]) await expectAgrees(repo, registryPath, taxonomyPath, entry, cell);
  });

  it("re-suffixes the unnamed kind when a rule names it", async () => {
    const { registryPath, taxonomyPath } = miniFiles(undefined, (t): void => {
      t["domains"]["rule"][1]["when"] = { repoKind: ["library", "unlisted"] };
    });
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "plain");
    expect(matrix["search"]["kinds"]).toEqual(["unlisted-2", "process", "library", "unlisted"]);
  });

  it("re-suffixes the wildcard label namespace when a literal pattern uses it, so a later label row stays reachable", async () => {
    // Row 3 names 'ns:bug' literally; row 4 names '*:bug'. A candidate 'ns:bug' would match
    // row 3 first and ops would read unreachable for every job that reaches it only by label.
    const { registryPath, taxonomyPath } = miniFiles(undefined, (t): void => {
      t["domains"]["rule"][2] = { order: 3, domain: "port", when: { issueLabels: { any: ["ns:bug"] } }, $comment: "the literal" };
      t["domains"]["rule"][3] = { order: 4, domain: "ops", when: { issueLabels: { any: ["*:bug"] } }, $comment: "any namespace" };
    });
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "plain");
    expect(matrix["search"]["labels"]).toEqual([[], ["ns:bug"], ["ns-2:bug"]]);
    const entry = entryOf(matrix, "plain", "ops");
    expect(entry).toMatchObject({ reachable: true, witnessIsCell: true, witness: { labels: ["ns-2:bug"], rule: 4 } });
    for (const cell of entry["cells"] as Json[]) await expectAgrees(repo, registryPath, taxonomyPath, entry, cell);
  });

  it("prints a table a person reads, with the unreachable rows and the counts", async () => {
    const { registryPath, taxonomyPath } = miniFiles();
    const result = await capture(matrixArgs(repo, registryPath, taxonomyPath, "--job", "port-only,ops-a"));
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/^\| job +\| domain +\| routed on +\| phase +\| lang +\| cell +\| winner +\| runner-up +\| effort +\|$/);
    expect(result.out.join("\n")).toMatch(/\| port-only +\| dev +\| unreachable /);
    expect(result.out.join("\n")).toMatch(/\| ops-a +\| dev +\| ops \(fallback\) +\| O\.2 /);
    expect(result.out.at(-1)).toMatch(/^2 job\(s\) x 5 domain\(s\): \d+ reachable, \d+ unreachable; \d+ cell\(s\), 0 skipped$/);
  });

  it("refuses what it cannot route, by name, at exit 1", async () => {
    const { registryPath, taxonomyPath } = miniFiles();
    // `bare` has no weight: the effort score cannot be built (resolve's refusal, verbatim).
    const unweighted = await capture(matrixArgs(repo, registryPath, taxonomyPath, "--job", "bare"));
    expect(unweighted.code).toBe(1);
    expect(unweighted.err.join("\n")).toMatch(/job 'bare' has no weight/);
    const unrouted = await capture(matrixArgs(repo, mutatedRegistry((v): void => {
      delete v["routing"]["implementation"];
    }), REAL_TAXONOMY, "--job", "implementation"));
    expect(unrouted.code).toBe(1);
    expect(unrouted.err.join("\n")).toMatch(/at routing, there is no job 'implementation'/);
    expect((await capture(matrixArgs(repo, registryPath, taxonomyPath, "--job", routed))).code).toBe(0);
  });

  it("refuses an unknown or empty filter, a missing flag and another verb's flag, at exit 2", async () => {
    const { registryPath, taxonomyPath } = miniFiles();
    const cases: [string[], RegExp][] = [
      [matrixArgs(repo, registryPath, taxonomyPath, "--job", "nope"), /--job names unknown job key 'nope'. Valid: plain, heavy/],
      [matrixArgs(repo, registryPath, taxonomyPath, "--domain", "nope,also"), /--domain names unknown domain keys 'nope', 'also'. Valid: dev, ops, port, gov, lib/],
      [matrixArgs(repo, registryPath, taxonomyPath, "--domain", ","), /--domain is empty/],
      [["direct", "matrix", "--registry", registryPath, "--repo", repo], /--taxonomy/],
      [["direct", "matrix", "--registry", registryPath, "--taxonomy", taxonomyPath], /--repo/],
      [matrixArgs(repo, registryPath, taxonomyPath, "--kind", "product"), /--kind is not a flag of 'direct matrix'; it belongs to 'direct resolve'/],
      [["direct", "resolve", "--registry", registryPath, "--taxonomy", taxonomyPath, "--repo", repo, "--kind", "x", "--domain", "dev"], /--domain is not a flag of 'direct resolve'; it belongs to 'direct matrix'/],
    ];
    for (const [argv, pattern] of cases) {
      const result = await capture(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err.join("\n")).toMatch(pattern);
    }
  });

  it("orders the filtered rows by the taxonomy, never by the flag", async () => {
    const { registryPath, taxonomyPath } = miniFiles();
    const matrix = await matrixJson(repo, registryPath, taxonomyPath, "--job", "light,plain", "--domain", "gov,dev");
    expect((matrix["jobs"] as Json[]).map((job): string => job["job"])).toEqual(["plain", "light"]);
    expect((matrix["domains"] as Json[]).map((entry): string => entry["domain"])).toEqual(["dev", "gov"]);
    expect(matrix["inputs"]).toMatchObject({ jobs: ["light", "plain"], domains: ["gov", "dev"] });
  });
});
