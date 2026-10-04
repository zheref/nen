import { existsSync, readdirSync, readFileSync } from "node:fs";
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

describe("nen direct -- registration and dispatch", () => {
  it("is registered between dev and effort, with its two subcommands", () => {
    const names = COMMANDS.map((command): string => command.name);
    expect(names.indexOf("direct")).toBe(names.indexOf("dev") + 1);
    expect(names.indexOf("direct")).toBe(names.indexOf("effort") - 1);
    expect(directCommand.subcommands).toEqual(["registry", "resolve"]);
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
    expect(result.out.at(-1)).toBe("10 alias(es), 4 surface(s), 39 routed job(s), 167 cell(s)");
  });

  it("--json: contract, registry, snapshot, aliases, surfaces, liveLookup and counts", async () => {
    const result = await capture(["direct", "registry", "--registry", REAL_REGISTRY, "--json"]);
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Json;
    expect(Object.keys(document)).toEqual(["contract", "registry", "snapshot", "aliases", "surfaces", "liveLookup", "counts"]);
    expect(document["contract"]).toBe("nen.direct.registry/v0.1");
    expect(document["registry"]).toBe(REAL_REGISTRY);
    expect(document["snapshot"]["asOf"]).toBe("2026-10-04");
    expect(document["counts"]).toEqual({ aliases: 10, routingJobs: 39, routingCells: 167 });
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
    const result = await verdict("--surface", "codex", "--tier", "opus", "--effort", "medium");
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(result.out[0]).toMatch(/^\| +\| alias +\| surface\/tier +\| model alias +\| restart +\|$/);
    expect(result.out[2]).toMatch(/^\| winner +\| SEMANTIC_FRONTIER +\| claude-code\/deep +\| opus +\| claude --model opus/);
    expect(result.out[3]).toMatch(/^\| runner-up +\| BALANCED_AUTHOR +\| claude-code\/fast +\| sonnet +\|/);
    expect(text).toContain("interactive: the Claude desktop app or claude.ai, the same model family");
    expect(text).toContain("pair implementation x swift: SEMANTIC_FRONTIER, runner-up BALANCED_AUTHOR  [feature, FEAT.DEV.013 Feature implementation, cell swift]");
    expect(text).toContain("domain: feature (rule 5: nothing above applied)");
    expect(text).toContain("effort: weight 2 = 2 -> low (claude-code: low)");
    expect(text).toContain("mismatch: surface codex != claude-code; effort medium != low");
    expect(text.indexOf("pair ")).toBeLessThan(text.indexOf("domain:"));
    expect(text.indexOf("domain:")).toBeLessThan(text.indexOf("effort:"));
    expect(text.indexOf("effort:")).toBeLessThan(text.indexOf("mismatch:"));
  });

  it("a mismatch is an answer: exit 0, and a match says so", async () => {
    expect((await verdict("--surface", "codex")).code).toBe(0);
    const matched = await verdict("--surface", "claude-code", "--tier", "opus", "--effort", "low");
    expect(matched.code).toBe(0);
    expect(matched.out.join("\n")).toContain("mismatch: none (session matches on surface, tier, effort)");
  });

  it("prints no mismatch line when the session gave nothing", async () => {
    expect((await verdict()).out.join("\n")).not.toContain("mismatch");
  });

  it("derives the process domain and the max effort for a canon repository's heavy jobs", async () => {
    const result = await capture(resolveArgs(consumerRepo(), "--lang", "prose", "--job", "requirements,architecture,review", "--kind", "process", "--role", "canon", "--json"));
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Json;
    expect(document["domain"]).toMatchObject({ rule: 1 });
    expect(document["effort"]).toMatchObject({ weight: 4, level: "max", derivation: ["weight 4", "manyJobs", "aigov"], score: 6 });
  });
});

describe("nen direct resolve --json", () => {
  it("has the documented top-level keys and the winner's resolved fields", async () => {
    const result = await verdict("--json");
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Json;
    expect(Object.keys(document)).toEqual(["contract", "inputs", "domain", "pairs", "aggregate", "winner", "runnerUp", "effort", "mismatch", "record"]);
    expect(document["contract"]).toBe("nen.direct.resolve/v0.1");
    expect(document["inputs"]).toEqual({ langs: ["swift"], jobs: ["implementation", "unit-tests"], kind: "product", role: null, issueKind: "none", surface: null, tier: null, effort: null });
    expect(document["domain"]).toMatchObject({ domain: "feature", rule: 5, fallbacks: [] });
    expect(document["pairs"]).toHaveLength(2);
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
    expect(document["record"]).toBeNull();
  });

  it("carries the mismatch object, differences by field", async () => {
    const document = JSON.parse((await verdict("--json", "--surface", "codex", "--tier", "opus")).out.join("\n")) as Json;
    expect(document["mismatch"]).toEqual({
      compared: ["surface", "tier"],
      match: false,
      differences: [{ field: "surface", session: "codex", recommended: "claude-code" }],
    });
  });

  it("reports the surface alias as 'unspelled' when the workflow has no models block, or no workflow at all", async () => {
    for (const repo of [consumerRepo(null), tmpRepo()]) {
      const result = await capture(resolveArgs(repo, "--lang", "swift", "--job", "implementation", "--kind", "product", "--json"));
      expect(result.code).toBe(0);
      expect((JSON.parse(result.out.join("\n")) as Json)["winner"]["surfaceAlias"]).toBe("unspelled");
    }
  });

  it("spells the alias from the workflow's models block through the existing loader", async () => {
    const repo = consumerRepo({ ...MODELS, claude: { deep: "a-different-alias" } });
    const document = JSON.parse((await capture(resolveArgs(repo, "--lang", "swift", "--job", "implementation", "--kind", "product", "--json"))).out.join("\n")) as Json;
    expect(document["winner"]["surfaceAlias"]).toBe("a-different-alias");
  });
});

describe("nen direct resolve -- exit codes", () => {
  const base = (repo: string, ...rest: string[]): string[] => resolveArgs(repo, ...rest);

  it("exits 2 on every missing flag, naming it", async () => {
    const repo = consumerRepo();
    const full = ["--lang", "swift", "--job", "implementation", "--kind", "product"];
    for (const flag of ["--registry", "--taxonomy", "--repo", "--lang", "--job", "--kind"]) {
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

  it("exits 2 on an unknown kind, role, issue kind, surface or effort level", async () => {
    const repo = consumerRepo();
    const classified = (kind: string, ...flags: string[]): string[] =>
      base(repo, "--lang", "swift", "--job", "implementation", "--kind", kind, ...flags);
    const cases: [string[], RegExp][] = [
      [classified("service"), /--kind 'service' is not one of: product, process, library, unknown/],
      [classified("product", "--role", "owner"), /--role 'owner' is not one of: canon, consumer, unregistered/],
      [classified("product", "--issue-kind", "chore"), /--issue-kind 'chore' is not one of: bug, enhancement, none/],
      [classified("product", "--surface", "nowhere"), /--surface 'nowhere' is not one of: claude-code, codex, cursor, antigravity/],
      [classified("product", "--effort", "extreme"), /--effort 'extreme' is not one of: low, medium, high, max/],
    ];
    for (const [argv, pattern] of cases) {
      const result = await capture(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err.join("\n")).toMatch(pattern);
    }
  });

  it("exits 1, not 2, for an invalid registry, an invalid taxonomy, or a malformed workflow", async () => {
    const ok = ["--lang", "swift", "--job", "implementation", "--kind", "product"];
    const badRegistry = mutatedRegistry((v): void => {
      v["routing"]["implementation"]["feature"]["cells"]["*"]["winner"]["alias"] = "GHOST";
    });
    const a = await capture(["direct", "resolve", "--registry", badRegistry, "--taxonomy", REAL_TAXONOMY, "--repo", consumerRepo(), ...ok]);
    expect(a.code).toBe(1);
    expect(a.err.join("\n")).toMatch(/GHOST/);
    const badTaxonomy = mutatedTaxonomy((v): void => {
      delete v["axes"]["job"];
    });
    expect((await capture(["direct", "resolve", "--registry", REAL_REGISTRY, "--taxonomy", badTaxonomy, "--repo", consumerRepo(), ...ok])).code).toBe(1);
    const malformed = tmpRepo({ "nen/workflow.json": "{ not json" });
    expect((await capture(resolveArgs(malformed, ...ok))).code).toBe(1);
  });

  it("exits 1 when the registry cannot route what the taxonomy names", async () => {
    const registry = mutatedRegistry((v): void => {
      delete v["routing"]["implementation"];
    });
    const result = await capture(["direct", "resolve", "--registry", registry, "--taxonomy", REAL_TAXONOMY, "--repo", consumerRepo(), "--lang", "swift", "--job", "implementation", "--kind", "product"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/there is no job 'implementation'/);
  });

  it("exits 1 for a taxonomy with no weight on a carried job", async () => {
    const taxonomy = mutatedTaxonomy((v): void => {
      delete v["axes"]["job"]["keys"].find((entry: Json): boolean => entry["key"] === "implementation")["weight"];
    });
    const result = await capture(["direct", "resolve", "--registry", REAL_REGISTRY, "--taxonomy", taxonomy, "--repo", consumerRepo(), "--lang", "swift", "--job", "implementation", "--kind", "product"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/job 'implementation' has no weight/);
  });

  it("resolves a relative --registry and --taxonomy against --repo", async () => {
    const repo = tmpRepo({
      "r.json": JSON.parse(readFileSync(REAL_REGISTRY, "utf8")),
      "t.json": JSON.parse(readFileSync(REAL_TAXONOMY, "utf8")),
    });
    const result = await capture(["direct", "resolve", "--registry", "r.json", "--taxonomy", "t.json", "--repo", repo, "--lang", "swift", "--job", "implementation", "--kind", "product"]);
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
  const classification = ["--lang", "swift", "--job", "implementation", "--kind", "product"];

  it("writes the whole result plus recordedAt under .nen/direct/, creating the directories", async () => {
    const repo = consumerRepo();
    const result = await capture(resolveArgs(repo, ...classification, "--record", "sonnet/kurapika/direct-verbs", "--json"));
    expect(result.code).toBe(0);
    const file = join(repo, ".nen", "direct", "sonnet", "kurapika", "direct-verbs.json");
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8")) as Json;
    expect(written["recordedAt"]).toBe("2026-10-04T12:00:00.000Z");
    expect(written["contract"]).toBe("nen.direct.resolve/v0.1");
    expect(written["winner"]["alias"]).toBe("SEMANTIC_FRONTIER");
    expect(written["record"]).toBe(file);
    expect((JSON.parse(result.out.join("\n")) as Json)["record"]).toBe(file);
    // never under the repository's declarations
    expect(readdirSync(repo).sort()).toEqual([".nen", "nen"]);
    expect(readdirSync(join(repo, "nen"))).toEqual(["workflow.json"]);
  });

  it("names the written path in the human output, last", async () => {
    const repo = consumerRepo();
    const result = await capture(resolveArgs(repo, ...classification, "--record", "an-effort"));
    expect(result.out.at(-1)).toBe(`recorded ${join(repo, ".nen", "direct", "an-effort.json")}`);
  });

  it("refuses a traversal at exit 2 and writes nothing, anywhere", async () => {
    for (const name of ["..", "../escape", "a/../../escape", "/abs/path", "C:/abs", "a\\b", "a//b", "a/./b", "trailing/", ""]) {
      const repo = consumerRepo();
      const result = await capture(resolveArgs(repo, ...classification, "--record", name));
      expect(result.code, `--record '${name}'`).toBe(2);
      expect(result.err.join("\n")).toMatch(/--record .* is refused/);
      expect(existsSync(join(repo, ".nen")), `--record '${name}' wrote`).toBe(false);
    }
  });

  it("refuses the traversal before it reads anything: a bad registry does not outrank it", async () => {
    const bad = mutatedRegistry((v): void => {
      delete v["aliases"];
    });
    const result = await capture(["direct", "resolve", "--registry", bad, "--taxonomy", REAL_TAXONOMY, "--repo", consumerRepo(), ...classification, "--record", "../x"]);
    expect(result.code).toBe(2);
  });

  it("writes nothing when the resolution itself fails", async () => {
    const repo = consumerRepo();
    const result = await capture(resolveArgs(repo, "--lang", "cobol", "--job", "implementation", "--kind", "product", "--record", "an-effort"));
    expect(result.code).toBe(2);
    expect(existsSync(join(repo, ".nen"))).toBe(false);
  });
});
