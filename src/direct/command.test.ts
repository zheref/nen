import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../cli/registry.js";
import { directCommand } from "./command.js";
import {
  capture,
  consumerRepo,
  miniFiles,
  MODELS,
  mutatedRegistry,
  mutatedTaxonomy,
  REAL_REGISTRY,
  REAL_TAXONOMY,
  resolveArgs,
  tmpRepo,
  type Json,
} from "./fixtures/harness.js";

const verdict = (...rest: string[]): ReturnType<typeof capture> =>
  capture(resolveArgs(consumerRepo(), "--lang", "swift", "--job", "implementation,unit-tests", "--kind", "product", ...rest));
const CLASSIFIED = ["--lang", "swift", "--job", "implementation", "--kind", "product"];

describe("nen direct -- registration and dispatch", () => {
  it("is registered between dev and effort, with its three subcommands", () => {
    const names = COMMANDS.map((command): string => command.name);
    expect(names.indexOf("direct")).toBe(names.indexOf("dev") + 1);
    expect(names.indexOf("direct")).toBe(names.indexOf("effort") - 1);
    expect(directCommand.subcommands).toEqual(["registry", "resolve", "answer"]);
  });

  it("refuses a bare family, an unknown subcommand and a help request on one it lacks, at exit 2", async () => {
    expect((await capture(["direct"])).code).toBe(2);
    const result = await capture(["direct", "bogus", "--registry", REAL_REGISTRY]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown 'direct' subcommand 'bogus'/);
    expect((await capture(["direct", "bogus", "--help"])).code).toBe(2);
  });
});

describe("nen direct --help -- the usage text names what the verbs take", () => {
  it("names both verbs and every flag the family declares", async () => {
    const result = await capture(["direct", "--help"]);
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    for (const subcommand of directCommand.subcommands ?? []) {
      expect(text, `usage does not name 'nen direct ${subcommand}'`).toContain(`nen direct ${subcommand}`);
    }
    const flags = [...(directCommand.flags.values ?? []), ...(directCommand.flags.booleans ?? []), "repo", "json"];
    for (const flag of flags) expect(text, `usage does not name --${flag}`).toContain(`--${flag}`);
  });

  it("states what the exits mean and the contract line", async () => {
    const text = (await capture(["direct", "--help"])).out.join("\n");
    expect(text).toMatch(/A mismatch is an ANSWER and exits 0/);
    expect(text).toMatch(/refused at exit 2/);
    expect(text).toContain("nen.direct.<verb>/v0.1");
  });
});

describe("nen direct registry", () => {
  it("prints the snapshot date, one line per alias, the surfaces and the live lookup", async () => {
    const result = await capture(["direct", "registry", "--registry", REAL_REGISTRY]);
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toContain("snapshot asOf 2026-10-04");
    expect(result.out).toContain(
      "SEMANTIC_FRONTIER    anthropic  claude-opus      claude-code/deep      snapshot: Claude Opus 5.5 (claude-opus-5-5)",
    );
    expect(text).toMatch(/PR_QUALITY_REVIEW +cursor +bugbot +- +snapshot: Cursor Bugbot \(reviewer\)/);
    expect(text).toContain("surfaces:");
    expect(text).toMatch(/claude-code +Claude Code +models\.claude/);
    expect(text).toContain("live lookup:");
    expect(text).toMatch(/openai +cli: codex debug models/);
    expect(result.out.at(-1)).toBe("10 alias(es), 4 surface(s), 39 routed job(s), 204 cell(s)");
  });

  it("--json: contract, registry, snapshot, aliases, surfaces, liveLookup and counts", async () => {
    const result = await capture(["direct", "registry", "--registry", REAL_REGISTRY, "--json"]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Json;
    expect(Object.keys(document)).toEqual(["contract", "registry", "snapshot", "aliases", "surfaces", "liveLookup", "counts"]);
    expect(document["contract"]).toBe("nen.direct.registry/v0.1");
    expect(document["registry"]).toBe(REAL_REGISTRY);
    expect(document["snapshot"]["asOf"]).toBe("2026-10-04");
    expect(document["counts"]).toEqual({ aliases: 10, routingJobs: 39, routingCells: 204 });
  });

  it("resolves a relative --registry against --repo, not the process directory", async () => {
    const repo = tmpRepo({ "reg.json": JSON.parse(readFileSync(REAL_REGISTRY, "utf8")) });
    const result = await capture(["direct", "registry", "--registry", "reg.json", "--repo", repo]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe(`registry ${join(repo, "reg.json")}`);
  });

  it("exits 2 without --registry, 1 on an invalid file naming the pointer, 1 on a missing one", async () => {
    expect((await capture(["direct", "registry"])).code).toBe(2);
    const bad = mutatedRegistry((v): void => {
      v["aggregation"]["precedence"].pop();
    });
    const result = await capture(["direct", "registry", "--registry", bad]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/at aggregation\.precedence/);
    expect((await capture(["direct", "registry", "--registry", "/nope/none.json"])).code).toBe(1);
  });
});

describe("nen direct resolve -- human output over the real fixtures", () => {
  it("prints the verdict table, the pairs, the domain and effort lines, in that order", async () => {
    const result = await verdict("--surface", "codex", "--model", "opus", "--effort", "medium");
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(result.out[0]).toMatch(/^\| +\| alias +\| surface\/tier +\| model alias +\| restart +\|$/);
    expect(result.out[2]).toMatch(/^\| winner +\| SEMANTIC_FRONTIER +\| claude-code\/deep +\| opus +\| claude --model opus \(then \/effort low\)/);
    expect(result.out[3]).toMatch(/^\| runner-up +\| BALANCED_AUTHOR +\| claude-code\/fast +\| sonnet +\|/);
    expect(text).toContain("interactive: the Claude desktop app or claude.ai, the same model family");
    expect(text).toContain("pair implementation x swift: SEMANTIC_FRONTIER, runner-up BALANCED_AUTHOR  [feature, FEAT.DEV.013 Feature implementation, cell swift]");
    expect(text).toMatch(/domain: feature \(rule 5: .+\)/);
    expect(text).toContain("effort: weight 2 = 2 -> low (claude-code: low)");
    expect(text).toContain("mismatch: yes (surface codex != claude-code; model match; effort medium != low)");
    expect(text.indexOf("pair ")).toBeLessThan(text.indexOf("domain:"));
    expect(text.indexOf("domain:")).toBeLessThan(text.indexOf("effort:"));
    expect(text.indexOf("effort:")).toBeLessThan(text.indexOf("mismatch:"));
  });

  it("a mismatch is an answer: exit 0, and a match says so; unread is reported, never a mismatch", async () => {
    expect((await verdict("--surface", "codex")).code).toBe(0);
    const matched = await verdict("--surface", "claude-code", "--model", "opus", "--effort", "low");
    expect(matched.code).toBe(0);
    expect(matched.out.join("\n")).toContain("mismatch: no (surface match; model match; effort match)");
    const unread = await verdict("--surface", "unread", "--model", "unread", "--effort", "unread");
    expect(unread.code).toBe(0);
    expect(unread.out.join("\n")).toContain("mismatch: no (surface unread; model unread; effort unread)");
  });

  it("prints no mismatch line when the session gave nothing", async () => {
    expect((await verdict()).out.join("\n")).not.toContain("mismatch");
  });

  it("derives the process domain and the max effort for a canon repository's heavy jobs, from --kind and --role verbatim", async () => {
    const result = await capture(resolveArgs(consumerRepo(), "--lang", "prose", "--job", "requirements,architecture,review", "--kind", "process", "--role", "canon", "--json"));
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Json;
    expect(document["domain"]).toMatchObject({ rule: 1 });
    expect(document["effort"]).toMatchObject({ weight: 4, level: "max", derivation: ["weight 4", "manyJobs", "aigov"], score: 6 });
  });

  it("derives the maintenance domain from a bug label, plain or namespaced, passed as --labels", async () => {
    for (const labels of ["bug", "ns:bug", "enhancement,ns:bug"]) {
      const result = await capture(resolveArgs(consumerRepo(), ...CLASSIFIED, "--labels", labels, "--json"));
      expect(((JSON.parse(result.out.join("\n")) as Json)["domain"] as Json)["rule"], labels).toBe(4);
    }
    const none = await capture(resolveArgs(consumerRepo(), ...CLASSIFIED, "--labels", "enhancement", "--json"));
    expect(((JSON.parse(none.out.join("\n")) as Json)["domain"] as Json)["rule"]).toBe(5);
  });

  it("an empty --job, or none, is the answer 'undirectable: job axis empty': one line, exit 0", async () => {
    for (const job of [["--job", ""], []]) {
      const result = await capture(resolveArgs(consumerRepo(), "--lang", "swift", "--kind", "product", ...job, "--surface", "codex"));
      expect(result.code).toBe(0);
      expect(result.out).toEqual(["undirectable: job axis empty"]);
    }
    const json = JSON.parse((await capture(resolveArgs(consumerRepo(), "--kind", "product", "--json"))).out.join("\n")) as Json;
    expect(json).toMatchObject({ undirectable: "job axis empty", domain: null, winner: null, runnerUp: null, effort: null, mismatch: null, pairs: [] });
  });

  it("an empty --lang, or none, reads the shared cell for every job", async () => {
    for (const lang of [["--lang", ""], []]) {
      const result = await capture(resolveArgs(consumerRepo(), "--job", "implementation", "--kind", "product", ...lang, "--json"));
      expect(result.code).toBe(0);
      expect(((JSON.parse(result.out.join("\n")) as Json)["pairs"] as Json[]).map((pair): string => pair["cell"])).toEqual(["*"]);
    }
  });

  it("names the codex restart with the workflow's alias and the effort map's dial", async () => {
    const repo = consumerRepo({ codex: { frontier: "gpt-astra-alias", deep: "gpt-sol-alias" } });
    const result = await capture(resolveArgs(repo, "--lang", "typescript", "--job", "release", "--kind", "product", "--json"));
    const winner = (JSON.parse(result.out.join("\n")) as Json)["winner"] as Json;
    expect(winner["surface"]).toBe("codex");
    expect(winner["restart"]).toBe(`codex -m ${winner["surfaceAlias"]} -c model_reasoning_effort=${((JSON.parse(result.out.join("\n")) as Json)["effort"] as Json)["surfaceEffort"]}`);
    expect(winner["surfaceAlias"]).toBe("gpt-astra-alias");
  });
});

describe("nen direct resolve -- a runner-up distinct from the winner, or none", () => {
  it("says 'runner-up: none distinct' when every candidate is the winner (a reviewer's stand-in is the winner)", async () => {
    const result = await capture(resolveArgs(consumerRepo(), "--lang", "typescript", "--job", "security", "--kind", "library"));
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toContain("runner-up: none distinct");
    expect(text).not.toMatch(/\| runner-up/);
    expect(text).toContain("pair security x typescript: EXECUTION_FRONTIER, runner-up EXECUTION_FRONTIER (for PR_SECURITY_REVIEW)");
    const json = JSON.parse((await capture(resolveArgs(consumerRepo(), "--lang", "typescript", "--job", "security", "--kind", "library", "--json"))).out.join("\n")) as Json;
    expect(json["runnerUp"]).toBeNull();
    expect(json["winner"]["alias"]).toBe("EXECUTION_FRONTIER");
  });

  it("names the reviewer product a distinct runner-up stands in for", async () => {
    const result = await capture(resolveArgs(consumerRepo(), "--lang", "typescript", "--job", "review", "--kind", "product", "--labels", "bug", "--json"));
    const json = JSON.parse(result.out.join("\n")) as Json;
    expect(json["runnerUp"]).toMatchObject({ reviewer: false, substituted: "PR_QUALITY_REVIEW" });
  });

  it("an unspelled model is unread, never a mismatch", async () => {
    const result = await capture(resolveArgs(consumerRepo(null), ...CLASSIFIED, "--model", "opus"));
    expect(result.out.join("\n")).toContain("mismatch: no (model unread)");
  });
});

describe("nen direct resolve --json", () => {
  it("has the documented top-level keys and the winner's resolved fields", async () => {
    const result = await verdict("--json");
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Json;
    expect(Object.keys(document)).toEqual(["contract", "inputs", "undirectable", "domain", "pairs", "aggregate", "winner", "runnerUp", "effort", "mismatch", "effortId", "record"]);
    expect(document["contract"]).toBe("nen.direct.resolve/v0.1");
    expect(document["inputs"]).toEqual({ langs: ["swift"], jobs: ["implementation", "unit-tests"], kind: "product", role: null, labels: [], surface: null, model: null, effort: null });
    expect(document["undirectable"]).toBeNull();
    expect(document["domain"]).toMatchObject({ domain: "feature", rule: 5, fallbacks: [] });
    expect(document["pairs"]).toHaveLength(2);
    expect(document["pairs"][0]).toMatchObject({ job: "implementation", lang: "swift", fallbackFrom: null, cell: "swift" });
    expect(document["winner"]).toMatchObject({
      alias: "SEMANTIC_FRONTIER",
      provider: "anthropic",
      family: "claude-opus",
      surface: "claude-code",
      tier: "deep",
      surfaceAlias: "opus",
      effortControl: "/effort low|medium|high|max",
    });
    expect(document["winner"]["snapshot"]).toMatchObject({ asOf: "2026-10-04", primary: "Claude Opus 5.5" });
    expect(document["winner"]["liveLookup"]["docs"]).toHaveLength(2);
    expect(document["effort"]).toMatchObject({ score: 2, level: "low", surfaceEffort: "low" });
    expect(document["mismatch"]).toBeNull();
    expect(document["effortId"]).toBeNull();
    expect(document["record"]).toBeNull();
  });

  it("carries mismatch.compares with a verdict per value the session gave", async () => {
    const document = JSON.parse((await verdict("--json", "--surface", "codex", "--model", "opus", "--effort", "unread")).out.join("\n")) as Json;
    expect(document["mismatch"]).toEqual({
      match: false,
      compares: [
        { field: "surface", session: "codex", recommended: "claude-code", verdict: "mismatch" },
        { field: "model", session: "opus", recommended: "opus", verdict: "match" },
        { field: "effort", session: "unread", recommended: "low", verdict: "unread" },
      ],
    });
  });

  it("compares effort in dial space: a session at high on a collapsed surface matches a recommended max", async () => {
    // the process-and-canon route drives the real taxonomy to max; cursor and antigravity have no top setting
    const argv = (surface: string, effort: string): string[] =>
      resolveArgs(consumerRepo(), "--lang", "prose", "--job", "requirements", "--kind", "process", "--role", "canon", "--surface", surface, "--effort", effort, "--json");
    const collapsed = JSON.parse((await capture(argv("cursor", "high"))).out.join("\n")) as Json;
    expect(collapsed["effort"]["level"]).toBe("max");
    expect(collapsed["mismatch"]["compares"].at(-1)).toMatchObject({ field: "effort", recommended: "high", verdict: "match" });
    const dialed = JSON.parse((await capture(argv("claude-code", "high"))).out.join("\n")) as Json;
    expect(dialed["mismatch"]["compares"].at(-1)).toMatchObject({ recommended: "max", verdict: "mismatch" });
  });

  it("reports the surface alias as 'unspelled' when the workflow has no models block, or no workflow at all", async () => {
    for (const repo of [consumerRepo(null), tmpRepo()]) {
      const result = await capture(resolveArgs(repo, ...CLASSIFIED, "--json"));
      expect(result.code).toBe(0);
      expect((JSON.parse(result.out.join("\n")) as Json)["winner"]["surfaceAlias"]).toBe("unspelled");
    }
  });

  it("spells the alias from the workflow's models block through the existing loader", async () => {
    const repo = consumerRepo({ ...MODELS, claude: { deep: "a-different-alias" } });
    const document = JSON.parse((await capture(resolveArgs(repo, ...CLASSIFIED, "--json"))).out.join("\n")) as Json;
    expect(document["winner"]["surfaceAlias"]).toBe("a-different-alias");
  });
});

describe("nen direct resolve -- exit codes", () => {
  const base = (repo: string, ...rest: string[]): string[] => resolveArgs(repo, ...rest);

  it("exits 2 on every missing required flag, naming it", async () => {
    const repo = consumerRepo();
    const full = ["--kind", "product"];
    for (const flag of ["--registry", "--taxonomy", "--repo", "--kind"]) {
      const argv = base(repo, ...full);
      const at = argv.indexOf(flag);
      const without = [...argv.slice(0, at), ...argv.slice(at + 2)];
      const result = await capture(without);
      expect(result.code, `without ${flag}`).toBe(2);
      expect(result.err.join("\n")).toContain(flag);
    }
  });

  it("exits 2 on an unknown language or job key, naming the valid set", async () => {
    const repo = consumerRepo();
    const lang = await capture(base(repo, "--lang", "cobol", "--job", "implementation", "--kind", "product"));
    expect(lang.code).toBe(2);
    expect(lang.err.join("\n")).toMatch(/unknown language key 'cobol'. Valid: swift, kotlin, typescript, csharp, prose/);
    const job = await capture(base(repo, "--lang", "swift", "--job", "dancing", "--kind", "product"));
    expect(job.code).toBe(2);
    expect(job.err.join("\n")).toMatch(/unknown job key 'dancing'. Valid: discovery/);
  });

  it("exits 2 on an empty --kind or --role, a surface the registry lacks, or an effort outside its levels; the old flags are gone", async () => {
    const repo = consumerRepo();
    const classified = (...flags: string[]): string[] => base(repo, "--lang", "swift", "--job", "implementation", ...flags);
    const cases: [string[], RegExp][] = [
      [classified("--kind", ""), /--kind/],
      [classified("--kind", "product", "--role", ""), /--role is empty/],
      [classified("--kind", "product", "--surface", "nowhere"), /--surface 'nowhere' is not one of: claude-code, codex, cursor, antigravity, unread/],
      [classified("--kind", "product", "--effort", "extreme"), /--effort 'extreme' is not one of: low, medium, high, max, unread/],
      [classified("--kind", "product", "--issue-kind", "bug"), /issue-kind/],
      [classified("--kind", "product", "--tier", "opus"), /tier/],
    ];
    for (const [argv, pattern] of cases) {
      const result = await capture(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err.join("\n")).toMatch(pattern);
    }
  });

  it("passes a kind and role the verb has never heard of through verbatim", async () => {
    const result = await capture(resolveArgs(consumerRepo(), "--lang", "swift", "--job", "implementation", "--kind", "unheard-of", "--role", "also-new", "--json"));
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out.join("\n")) as Json)["inputs"]).toMatchObject({ kind: "unheard-of", role: "also-new" });
  });

  it("exits 1, not 2, for an invalid registry, an invalid taxonomy, an unknown predicate shape, or a malformed workflow", async () => {
    const badRegistry = mutatedRegistry((v): void => {
      v["routing"]["implementation"]["feature"]["cells"]["*"]["winner"]["alias"] = "GHOST";
    });
    const a = await capture(["direct", "resolve", "--registry", badRegistry, "--taxonomy", REAL_TAXONOMY, "--repo", consumerRepo(), ...CLASSIFIED]);
    expect(a.code).toBe(1);
    expect(a.err.join("\n")).toMatch(/GHOST/);
    const badTaxonomy = mutatedTaxonomy((v): void => {
      delete v["axes"]["job"];
    });
    expect((await capture(["direct", "resolve", "--registry", REAL_REGISTRY, "--taxonomy", badTaxonomy, "--repo", consumerRepo(), ...CLASSIFIED])).code).toBe(1);
    const unknownShape = mutatedTaxonomy((v): void => {
      v["domains"]["rule"][0]["when"] = { repoSize: ["big"] };
    });
    const shape = await capture(["direct", "resolve", "--registry", REAL_REGISTRY, "--taxonomy", unknownShape, "--repo", consumerRepo(), ...CLASSIFIED]);
    expect(shape.code).toBe(1);
    expect(shape.err.join("\n")).toMatch(/at domains\.rule\[0\]\.when\.repoSize/);
    const malformed = tmpRepo({ "nen/workflow.json": "{ not json" });
    expect((await capture(resolveArgs(malformed, ...CLASSIFIED))).code).toBe(1);
  });

  it("exits 1 when the two files disagree: a cell under a language, or a routing domain, the taxonomy lacks", async () => {
    const cell = mutatedRegistry((v): void => {
      v["routing"]["implementation"]["feature"]["cells"]["cobol"] = v["routing"]["implementation"]["feature"]["cells"]["*"];
    });
    const a = await capture(["direct", "resolve", "--registry", cell, "--taxonomy", REAL_TAXONOMY, "--repo", consumerRepo(), ...CLASSIFIED]);
    expect(a.code).toBe(1);
    expect(a.err.join("\n")).toMatch(/at routing\.implementation\.feature\.cells\.cobol/);
    const domain = mutatedRegistry((v): void => {
      v["routing"]["implementation"]["elsewhere"] = v["routing"]["implementation"]["feature"];
    });
    const b = await capture(["direct", "resolve", "--registry", domain, "--taxonomy", REAL_TAXONOMY, "--repo", consumerRepo(), ...CLASSIFIED]);
    expect(b.code).toBe(1);
    expect(b.err.join("\n")).toMatch(/at routing\.implementation\.elsewhere/);
  });

  it("exits 1 when the registry cannot route what the taxonomy names", async () => {
    const registry = mutatedRegistry((v): void => {
      delete v["routing"]["implementation"];
    });
    const result = await capture(["direct", "resolve", "--registry", registry, "--taxonomy", REAL_TAXONOMY, "--repo", consumerRepo(), ...CLASSIFIED]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/there is no job 'implementation'/);
  });

  it("exits 1 for a taxonomy with no weight on a carried job", async () => {
    const taxonomy = mutatedTaxonomy((v): void => {
      delete v["axes"]["job"]["keys"].find((entry: Json): boolean => entry["key"] === "implementation")["weight"];
    });
    const result = await capture(["direct", "resolve", "--registry", REAL_REGISTRY, "--taxonomy", taxonomy, "--repo", consumerRepo(), ...CLASSIFIED]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/job 'implementation' has no weight/);
  });

  it("resolves a relative --registry and --taxonomy against --repo", async () => {
    const repo = tmpRepo({
      "r.json": JSON.parse(readFileSync(REAL_REGISTRY, "utf8")),
      "t.json": JSON.parse(readFileSync(REAL_TAXONOMY, "utf8")),
    });
    const result = await capture(["direct", "resolve", "--registry", "r.json", "--taxonomy", "t.json", "--repo", repo, ...CLASSIFIED]);
    expect(result.code).toBe(0);
  });

  it("works on a small synthetic vocabulary too: the derivation reads data, not names", async () => {
    const { registryPath, taxonomyPath } = miniFiles();
    const result = await capture(["direct", "resolve", "--registry", registryPath, "--taxonomy", taxonomyPath, "--repo", consumerRepo(), "--lang", "alpha", "--job", "plain", "--kind", "process", "--json"]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Json;
    expect(document["domain"]).toMatchObject({ domain: "gov", rule: 1 });
    expect(document["effort"]).toMatchObject({ derivation: ["weight 2", "gov"], level: "medium" });
  });
});

describe("nen direct resolve --record", () => {
  it("writes the whole result plus effortId and recordedAt under .nen/direct/, the id percent-encoded like nen usage record", async () => {
    const repo = consumerRepo();
    const id = "NN-IS-#12";
    const result = await capture(resolveArgs(repo, ...CLASSIFIED, "--record", id, "--json"));
    expect(result.code).toBe(0);
    const file = join(repo, ".nen", "direct", `${encodeURIComponent(id)}.json`);
    expect(file.endsWith("NN-IS-%2312.json")).toBe(true);
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8")) as Json;
    expect(written["recordedAt"]).toBe("2026-10-04T12:00:00.000Z");
    expect(written["effortId"]).toBe(id);
    expect(written["contract"]).toBe("nen.direct.resolve/v0.1");
    expect(written["winner"]["alias"]).toBe("SEMANTIC_FRONTIER");
    expect(written["record"]).toBe(file);
    const printed = JSON.parse(result.out.join("\n")) as Json;
    expect(printed["record"]).toBe(file);
    expect(printed["effortId"]).toBe(id);
    // never under the repository's declarations
    expect(readdirSync(repo).sort()).toEqual([".nen", "nen"]);
    expect(readdirSync(join(repo, "nen"))).toEqual(["workflow.json"]);
  });

  it("encodes a slash or a colon in the id, so the file stays directly under .nen/direct/", async () => {
    const repo = consumerRepo();
    for (const id of ["sonnet/kurapika/direct-verbs", "inline-2026-10-04T12:00:00Z"]) {
      expect((await capture(resolveArgs(repo, ...CLASSIFIED, "--record", id))).code).toBe(0);
    }
    expect(readdirSync(join(repo, ".nen", "direct")).sort()).toEqual([
      "inline-2026-10-04T12%3A00%3A00Z.json",
      "sonnet%2Fkurapika%2Fdirect-verbs.json",
    ]);
  });

  it("names the written path in the human output, last", async () => {
    const repo = consumerRepo();
    const result = await capture(resolveArgs(repo, ...CLASSIFIED, "--record", "an-effort"));
    expect(result.out.at(-1)).toBe(`recorded ${join(repo, ".nen", "direct", "an-effort.json")}`);
  });

  it("records an undirectable answer too", async () => {
    const repo = consumerRepo();
    const result = await capture(resolveArgs(repo, "--kind", "product", "--record", "inline-x"));
    expect(result.out).toEqual(["undirectable: job axis empty", `recorded ${join(repo, ".nen", "direct", "inline-x.json")}`]);
  });

  it("refuses a traversal at exit 2 and writes nothing, anywhere", async () => {
    for (const id of ["..", "../escape", "a/../../escape", "/abs/path", "C:/abs", "a\\b", ""]) {
      const repo = consumerRepo();
      const result = await capture(resolveArgs(repo, ...CLASSIFIED, "--record", id));
      expect(result.code, `--record '${id}'`).toBe(2);
      expect(result.err.join("\n")).toMatch(/--record .* is refused/);
      expect(existsSync(join(repo, ".nen")), `--record '${id}' wrote`).toBe(false);
    }
  });

  it("refuses the traversal before it reads anything: a bad registry does not outrank it", async () => {
    const bad = mutatedRegistry((v): void => {
      delete v["aliases"];
    });
    const result = await capture(["direct", "resolve", "--registry", bad, "--taxonomy", REAL_TAXONOMY, "--repo", consumerRepo(), ...CLASSIFIED, "--record", "../x"]);
    expect(result.code).toBe(2);
  });

  it("writes nothing when the resolution itself fails", async () => {
    const repo = consumerRepo();
    const result = await capture(resolveArgs(repo, "--lang", "cobol", "--job", "implementation", "--kind", "product", "--record", "an-effort"));
    expect(result.code).toBe(2);
    expect(existsSync(join(repo, ".nen"))).toBe(false);
  });
});

describe("nen direct answer", () => {
  const CLASSIFIED_ARGS = ["--lang", "swift", "--job", "implementation", "--kind", "product"];
  const answer = (repo: string, ...rest: string[]): ReturnType<typeof capture> => capture(["direct", "answer", "--repo", repo, ...rest]);
  const recorded = async (repo: string, id: string): Promise<string> => {
    const result = await capture(resolveArgs(repo, ...CLASSIFIED_ARGS, "--record", id, "--json"));
    expect(result.code).toBe(0);
    return join(repo, ".nen", "direct", `${encodeURIComponent(id)}.json`);
  };

  it("writes decision { answer, answeredAt } into the record resolve filed, and echoes it with --json", async () => {
    const repo = consumerRepo();
    const file = await recorded(repo, "NN-IS-#12");
    const result = await answer(repo, "--record", "NN-IS-#12", "--answer", "stop", "--json");
    expect(result.code).toBe(0);
    const decision = { answer: "stop", answeredAt: "2026-10-04T12:00:00.000Z" };
    expect(JSON.parse(result.out.join("\n"))).toEqual({ contract: "nen.direct.answer/v0.1", record: file, decision });
    const written = JSON.parse(readFileSync(file, "utf8")) as Json;
    expect(written["decision"]).toEqual(decision);
    expect(readFileSync(file, "utf8").endsWith("}\n")).toBe(true);
  });

  it("leaves every other field byte-equal: the file differs from the original only by the decision", async () => {
    const repo = consumerRepo();
    const file = await recorded(repo, "an-effort");
    const before = readFileSync(file, "utf8");
    await answer(repo, "--record", "an-effort", "--answer", "continue");
    const after = readFileSync(file, "utf8");
    const original = JSON.parse(before) as Json;
    const changed = JSON.parse(after) as Json;
    const { decision, ...rest } = changed;
    expect(decision).toEqual({ answer: "continue", answeredAt: "2026-10-04T12:00:00.000Z" });
    expect(rest).toEqual(original);
    // and exactly the bytes resolve would have written for that document plus the decision
    expect(after).toBe(`${JSON.stringify({ ...original, decision }, null, 2)}\n`);
    expect(after.startsWith(before.slice(0, before.lastIndexOf("\n}")))).toBe(true);
  });

  it("replaces an earlier answer; the last word stands", async () => {
    const repo = consumerRepo();
    const file = await recorded(repo, "an-effort");
    await answer(repo, "--record", "an-effort", "--answer", "continue");
    await answer(repo, "--record", "an-effort", "--answer", "stop");
    expect((JSON.parse(readFileSync(file, "utf8")) as Json)["decision"]["answer"]).toBe("stop");
  });

  it("prints a short human confirmation", async () => {
    const repo = consumerRepo();
    const file = await recorded(repo, "an-effort");
    const result = await answer(repo, "--record", "an-effort", "--answer", "continue");
    expect(result.out).toEqual(["answered continue at 2026-10-04T12:00:00.000Z", `recorded ${file}`]);
  });

  it("exits 1 naming the path when no record exists, and creates nothing", async () => {
    const repo = consumerRepo();
    const result = await answer(repo, "--record", "never-resolved", "--answer", "continue");
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain(join(repo, ".nen", "direct", "never-resolved.json"));
    expect(existsSync(join(repo, ".nen"))).toBe(false);
  });

  it("exits 1 for a record that is not a JSON object, and does not rewrite it", async () => {
    const repo = tmpRepo({ ".nen/direct/broken.json": "{ not json", ".nen/direct/list.json": "[1]" });
    for (const id of ["broken", "list"]) {
      const before = readFileSync(join(repo, ".nen", "direct", `${id}.json`), "utf8");
      const result = await answer(repo, "--record", id, "--answer", "stop");
      expect(result.code, id).toBe(1);
      expect(readFileSync(join(repo, ".nen", "direct", `${id}.json`), "utf8")).toBe(before);
    }
  });

  it("exits 1 for a record that is not a resolve document, or one filed for another effort, and does not rewrite it", async () => {
    const repo = consumerRepo();
    const filed = await recorded(repo, "NN-IS-#12");
    const copied = join(repo, ".nen", "direct", "copied.json");
    writeFileSync(copied, readFileSync(filed));
    writeFileSync(join(repo, ".nen", "direct", "empty.json"), "{}\n");
    for (const [id, why] of [
      ["copied", /records the effort "NN-IS-#12", not 'copied'/],
      ["empty", /is not a nen\.direct\.resolve\/v0\.1 record \(contract: null\)/],
    ] as const) {
      const file = join(repo, ".nen", "direct", `${id}.json`);
      const before = readFileSync(file, "utf8");
      const result = await answer(repo, "--record", id, "--answer", "stop");
      expect(result.code, id).toBe(1);
      expect(result.err.join("\n"), id).toMatch(why);
      expect(readFileSync(file, "utf8"), id).toBe(before);
    }
  });

  it("writes under the ledger lock and by rename: no lock or temp file is left beside the record", async () => {
    const repo = consumerRepo();
    const file = await recorded(repo, "an-effort");
    expect((await answer(repo, "--record", "an-effort", "--answer", "continue")).code).toBe(0);
    expect(readdirSync(join(repo, ".nen", "direct"))).toEqual([`${encodeURIComponent("an-effort")}.json`]);
    expect((JSON.parse(readFileSync(file, "utf8")) as Json)["decision"]["answer"]).toBe("continue");
  });

  it("exits 2 for an answer that is not continue or stop, naming the valid ones", async () => {
    const repo = consumerRepo();
    await recorded(repo, "an-effort");
    for (const bad of ["maybe", "Continue", ""]) {
      const result = await answer(repo, "--record", "an-effort", "--answer", bad);
      expect(result.code, `--answer '${bad}'`).toBe(2);
    }
    expect((await answer(repo, "--record", "an-effort", "--answer", "maybe")).err.join("\n")).toMatch(/--answer 'maybe' is not one of: continue, stop/);
  });

  it("exits 2 for a missing --record, --answer or --repo", async () => {
    const repo = consumerRepo();
    expect((await capture(["direct", "answer", "--repo", repo, "--answer", "stop"])).code).toBe(2);
    expect((await capture(["direct", "answer", "--repo", repo, "--record", "x"])).code).toBe(2);
    expect((await capture(["direct", "answer", "--record", "x", "--answer", "stop"])).code).toBe(2);
  });

  it("refuses a traversal at exit 2, the same refusals as resolve --record, and reads nothing outside .nen/direct/", async () => {
    for (const id of ["..", "../escape", "a/../../escape", "/abs/path", "C:/abs", "a\\b", ""]) {
      const repo = consumerRepo();
      const result = await answer(repo, "--record", id, "--answer", "stop");
      expect(result.code, `--record '${id}'`).toBe(2);
      // an empty value is the flag missing; every other id is refused by name
      expect(result.err.join("\n")).toMatch(id === "" ? /--record is required/ : /--record .* is refused/);
      expect(existsSync(join(repo, ".nen")), `--record '${id}' wrote`).toBe(false);
    }
  });

  it("encodes the id like resolve: a slash id finds its flat file", async () => {
    const repo = consumerRepo();
    const file = await recorded(repo, "sonnet/kurapika/x");
    expect((await answer(repo, "--record", "sonnet/kurapika/x", "--answer", "continue")).code).toBe(0);
    expect((JSON.parse(readFileSync(file, "utf8")) as Json)["decision"]["answer"]).toBe("continue");
  });
});

describe("nen direct -- each verb takes only its own flags", () => {
  const repo = consumerRepo();
  const classified = ["--lang", "swift", "--job", "implementation", "--kind", "product"];

  it("refuses a flag another verb owns, at exit 2, naming the flag and its owners", async () => {
    const cases: [string[], RegExp][] = [
      [["direct", "registry", "--registry", REAL_REGISTRY, "--record", "x"], /--record is not a flag of 'direct registry'; it belongs to 'direct resolve', 'direct answer'/],
      [["direct", "registry", "--registry", REAL_REGISTRY, "--taxonomy", REAL_TAXONOMY], /--taxonomy is not a flag of 'direct registry'; it belongs to 'direct resolve'/],
      [resolveArgs(repo, ...classified, "--answer", "stop"), /--answer is not a flag of 'direct resolve'; it belongs to 'direct answer'/],
      [["direct", "answer", "--repo", repo, "--record", "x", "--answer", "stop", "--registry", REAL_REGISTRY], /--registry is not a flag of 'direct answer'; it belongs to 'direct registry', 'direct resolve'/],
      [["direct", "answer", "--repo", repo, "--record", "x", "--answer", "stop", "--job", "plan"], /--job is not a flag of 'direct answer'/],
    ];
    for (const [argv, pattern] of cases) {
      const result = await capture(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err.join("\n")).toMatch(pattern);
    }
  });

  it("still passes every flag a verb owns", async () => {
    expect((await capture(["direct", "registry", "--registry", REAL_REGISTRY, "--repo", repo, "--json"])).code).toBe(0);
    const everyFlag = resolveArgs(repo, ...classified, "--role", "consumer", "--labels", "bug", "--surface", "claude-code", "--model", "opus", "--effort", "low", "--record", "all-flags", "--json");
    expect((await capture(everyFlag)).code).toBe(0);
    expect((await capture(["direct", "answer", "--repo", repo, "--record", "all-flags", "--answer", "continue", "--json"])).code).toBe(0);
  });
});

describe("nen direct --record -- the filesystem is asked, not just the spelling", () => {
  const classified = ["--lang", "swift", "--job", "implementation", "--kind", "product"];
  const outside = (): string => mkdtempSync(join(tmpdir(), "nen-direct-outside-"));

  it("refuses at exit 2 a .nen/direct directory that is a symlink out of --repo, and writes nothing there", async () => {
    const repo = consumerRepo();
    const away = outside();
    mkdirSync(join(repo, ".nen"));
    symlinkSync(away, join(repo, ".nen", "direct"), "dir");
    const result = await capture(resolveArgs(repo, ...classified, "--record", "an-effort"));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/outside the repository/);
    expect(readdirSync(away)).toEqual([]);
  });

  it("refuses an existing record that is a symlink to a file outside, and leaves that file untouched", async () => {
    const repo = consumerRepo();
    const away = outside();
    const victim = join(away, "victim.json");
    writeFileSync(victim, "{}\n");
    mkdirSync(join(repo, ".nen", "direct"), { recursive: true });
    symlinkSync(victim, join(repo, ".nen", "direct", "an-effort.json"), "file");
    const resolved = await capture(resolveArgs(repo, ...classified, "--record", "an-effort"));
    expect(resolved.code).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe("{}\n");
    const answered = await capture(["direct", "answer", "--repo", repo, "--record", "an-effort", "--answer", "stop"]);
    expect(answered.code).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe("{}\n");
  });

  it("refuses a dangling symlink record, which would otherwise create its target outside", async () => {
    const repo = consumerRepo();
    const away = outside();
    mkdirSync(join(repo, ".nen", "direct"), { recursive: true });
    symlinkSync(join(away, "not-yet.json"), join(repo, ".nen", "direct", "an-effort.json"), "file");
    const result = await capture(resolveArgs(repo, ...classified, "--record", "an-effort"));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/symbolic link|outside the repository/);
    expect(readdirSync(away)).toEqual([]);
  });

  it("a symlinked directory that stays inside the repository is still a plain contained path", async () => {
    const repo = consumerRepo();
    mkdirSync(join(repo, "real-direct"), { recursive: true });
    mkdirSync(join(repo, ".nen"));
    symlinkSync(join(repo, "real-direct"), join(repo, ".nen", "direct"), "dir");
    expect((await capture(resolveArgs(repo, ...classified, "--record", "an-effort"))).code).toBe(0);
    expect(readdirSync(join(repo, "real-direct"))).toEqual(["an-effort.json"]);
  });
});

describe("nen direct resolve -- --lang and --job are optional in the synopsis", () => {
  it("brackets both in the usage text", async () => {
    const text = (await capture(["direct", "--help"])).out.join("\n");
    expect(text).toContain("[--lang <a,b>] [--job <c,d>]");
  });
});
