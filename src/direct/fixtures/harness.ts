// src/direct/fixtures/harness.ts -- test support for the `nen direct` suites.
//
// TEST SUPPORT ONLY. It lives under `fixtures/` so the taxonomy-purity sweep and
// eslint skip it (src/classify/fixtures/harness.ts is the precedent), and nothing
// shipped imports it. It names the fixture vocabulary freely: that is the point
// of a fixture. Paths are built from process.cwd(), never import.meta.url.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFamily, type Io } from "../../index.js";
import { ScriptedSeams } from "../../seam/scripted.js";
import { directCommand } from "../command.js";

const FIXTURES = join(process.cwd(), "src", "direct", "fixtures");

/** Hatsu's real registry and taxonomy, copied verbatim. */
export const REAL_REGISTRY = join(FIXTURES, "direct.registry.json");
export const REAL_TAXONOMY = join(FIXTURES, "classify.taxonomy.json");

/** Loosely typed JSON, so a test can reach into and break a fixture without a cast per access. */
export type Json = Record<string, any>;

export function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}

/** A fresh temp directory standing in for a consumer checkout; `files` are written under it. */
export function tmpRepo(files: Readonly<Record<string, unknown>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-direct-repo-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** The real registry, parsed, handed to `edit`, written to a temp file; returns its path. */
export function mutatedRegistry(edit: (value: Json) => void): string {
  const value = readJson(REAL_REGISTRY);
  edit(value);
  return tmpRepo({ "registry.json": value }) + "/registry.json";
}

/** The real taxonomy, parsed, handed to `edit`, written to a temp file; returns its path. */
export function mutatedTaxonomy(edit: (value: Json) => void): string {
  const value = readJson(REAL_TAXONOMY);
  edit(value);
  return tmpRepo({ "taxonomy.json": value }) + "/taxonomy.json";
}

/** A consumer's nen/workflow.json whose `models` block spells the aliases. */
export const MODELS = {
  claude: { frontier: "fable", deep: "opus", fast: "sonnet" },
  codex: { frontier: "gpt-astra", deep: "gpt-sol" },
  antigravity: { deep: "gemini-pro", fast: "gemini-flash" },
};

/** A consumer checkout with a workflow whose models block is `models` (none when null). */
export function consumerRepo(models: unknown = MODELS): string {
  return tmpRepo({ "nen/workflow.json": models === null ? {} : { models } });
}

export interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

export async function capture(argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams = new ScriptedSeams([], { now: (): Date => new Date("2026-10-04T12:00:00Z") });
  const code = await runFamily(directCommand, argv, null, false, io, seams);
  return { code, out, err };
}

/** The flags every `direct resolve` call needs, over the real fixtures. */
export function resolveArgs(repo: string, ...rest: string[]): string[] {
  return ["direct", "resolve", "--registry", REAL_REGISTRY, "--taxonomy", REAL_TAXONOMY, "--repo", repo, ...rest];
}

// ── a small synthetic vocabulary, so every rule is provable by hand ─────────
//
// Nothing in it resembles the real files on purpose: a derivation that passes
// here AND against the real registry reads both from data. Domains (rule order):
// 1 gov, 2 lib, 3 port, 4 ops, 5 dev; keys in a DIFFERENT order than the
// fallback sentence, which is what the fallback test needs.

export function miniTaxonomyJson(): Json {
  const key = (name: string, extra: Json): Json => ({ key: name, title: name, description: `the ${name}`, ...extra });
  return {
    $schema: "example.classify-taxonomy/v1",
    contract: "example-classify-taxonomy",
    axes: {
      lang: {
        prefix: "lang/",
        color: "1d76db",
        keys: [key("alpha", { code: true }), key("beta", {}), key("gamma", { code: false }), key("delta", { code: true })],
      },
      job: {
        prefix: "job/",
        color: "5319e7",
        keys: [
          key("plain", { weight: 2, phases: { dev: ["D.1"], ops: ["O.1"] } }),
          key("heavy", { weight: 4, phases: { dev: ["D.2"] } }),
          key("light", { weight: 1, phases: { dev: ["D.3"] } }),
          key("mid", { weight: 3, phases: { dev: ["D.4"], gov: ["G.1"] } }),
          key("ops-a", { weight: 1, phases: { ops: ["O.2"] } }),
          key("ops-b", { weight: 2, phases: { ops: ["O.3"] } }),
          key("port-only", { weight: 3, phases: { port: ["P.1"] } }),
          key("lib-only", { weight: 2, phases: { lib: ["L.1"] } }),
          key("odd", { weight: 2, phases: { gov: ["G.2"], lib: ["L.2"] } }),
          key("bare", {}),
        ],
      },
    },
    domains: {
      keys: ["dev", "ops", "port", "gov", "lib"],
      firstMatchWins: true,
      rule: [
        { order: 1, domain: "gov", when: { anyOf: [{ repoKind: ["process"] }, { repoRole: ["canon"] }] }, $comment: "process or canon" },
        { order: 2, domain: "lib", when: { repoKind: ["library"] }, $comment: "library" },
        { order: 3, domain: "port", when: { jobs: { anyKey: ["port-only"] } }, $comment: "the marker job" },
        {
          order: 4,
          domain: "ops",
          when: { anyOf: [{ issueLabels: { any: ["bug", "*:bug"] } }, { jobs: { nonEmpty: true, everyListsOnly: "ops" } }] },
          $comment: "bug, or maintenance only",
        },
        { order: 5, domain: "dev", when: "otherwise", $comment: "otherwise" },
      ],
      fallback: "A job with no phase in the derived domain routes on the first domain it lists, in this order: the derived domain, ops, dev, lib, gov, port.",
    },
    classification: { confidence: { levels: ["high", "low"], applied: ["high"], listed: ["low"] } },
  };
}

const side = (alias: string, surface: string | null, extra: Json = {}): Json => ({ alias, surface, interactive: null, ...extra });

/** The routing every mini job gets by default: a top author wins on s1, a fast author is second. */
export function miniRegistryJson(): Json {
  const phases: Json = {};
  const routing: Json = {};
  const taxonomy = miniTaxonomyJson();
  for (const entry of taxonomy.axes.job.keys as Json[]) {
    routing[entry.key] = {};
    for (const [domain, ids] of Object.entries((entry.phases ?? {}) as Record<string, string[]>)) {
      const id = ids[0] as string;
      phases[id] = { name: `phase ${id}` };
      routing[entry.key][domain] = {
        phase: id,
        phaseName: `phase ${id}`,
        alsoPhases: [],
        cells: { "*": { winner: side("A_TOP", "s1"), runnerUp: side("A_FAST", "s1") } },
      };
    }
  }
  // `bare` has no phases in the taxonomy but the registry may still route it.
  phases["B.1"] = { name: "phase B.1" };
  routing["bare"] = {
    dev: { phase: "B.1", phaseName: "phase B.1", alsoPhases: [], cells: { "*": { winner: side("A_TOP", "s1"), runnerUp: side("A_FAST", "s1") } } },
  };
  const levels = ["low", "medium", "high", "max"];
  return {
    $schema: "example.direct-registry/v1",
    contract: "example-direct-registry",
    snapshot: {
      asOf: "2026-01-02",
      aliases: {
        A_TOP: { primary: "Top 1", modelId: "top-1", fallback: "Max 1" },
        A_MAX: { primary: "Max 1", modelId: null, fallback: "Top 1" },
        R_BOT: { primary: "Bot", modelId: null, fallback: "A_TOP" },
      },
    },
    aliases: {
      A_TOP: { provider: "p1", family: "f-top", surface: "s1", tier: "deep", selection: "the top author" },
      A_MAX: { provider: "p1", family: "f-max", surface: "s1", tier: "frontier", selection: "the escalation" },
      A_FAST: { provider: "p1", family: "f-fast", surface: "s1", tier: "fast", selection: "the fast author" },
      A_EXEC: { provider: "p2", family: "f-exec", surface: "s2", tier: "deep", selection: "the executor" },
      A_CHEAP: { provider: "p3", family: "f-cheap", surface: "s3", tier: "fast", selection: "the cheap editor" },
      R_BOT: { provider: "p3", family: "f-bot", surface: null, tier: null, reviewer: true, selection: "a reviewer" },
    },
    surfaces: {
      $comment: "metadata keys are skipped",
      s1: { label: "S One", modelsKey: "k1", restart: "s1 --model <alias>", interactive: "the s1 desktop", effortControl: "/effort <level>", lookup: "s1 picker" },
      s3: { label: "S Three", modelsKey: "k3", restart: "s3 --model <alias>", interactive: "the s3 IDE", effortControl: "a thinking budget", lookup: "s3 picker" },
      s2: { label: "S Two", modelsKey: "k2", restart: "s2 -m <alias> -c level=<level>", interactive: "the s2 web", effortControl: "reasoning <level>", lookup: "s2 list" },
    },
    nativeInteractive: { alpha: "the alpha IDE", beta: "the beta IDE", gamma: "the prose app", delta: "the alpha IDE" },
    liveLookup: { p1: { cli: "p1 models", docs: ["https://p1.example/models"] }, p2: { cli: null, docs: [] } },
    effort: {
      levels,
      rule: {
        base: "max job weight",
        plusOne: [
          { when: "three or more jobs", key: "manyJobs", threshold: 3 },
          { when: "two or more code languages", key: "manyLangs", threshold: 2 },
          { when: "the derived domain is gov", key: "gov" },
        ],
        bands: { low: [0, 2], medium: [3, 3], high: [4, 4], max: [5, 99] },
      },
      surfaceMap: {
        s1: { low: "low", medium: "medium", high: "high", max: "max" },
        s2: { low: "lo", medium: "mid", high: "hi", max: "xhi" },
        s3: { low: "low", medium: "medium", high: "high", max: "high" },
        $collapsed: "s3 has no top setting",
      },
    },
    aggregation: { precedence: ["A_MAX", "A_TOP", "A_EXEC", "A_FAST", "A_CHEAP", "R_BOT"] },
    mismatch: { compares: ["surface", "model", "effort"], ledger: ".nen/direct/<effort>.json" },
    phases,
    routing,
  };
}

/** Set one cell of a mini registry's routing. */
export function setCell(
  registry: Json,
  job: string,
  domain: string,
  lang: string,
  winner: Json,
  runnerUp: Json = side("A_FAST", "s1"),
): void {
  registry["routing"][job][domain]["cells"][lang] = { winner, runnerUp };
}

export { side };

/** Both mini files, written to a temp directory, plus the loaded pair. */
export function miniFiles(
  editRegistry: (value: Json) => void = (): void => {},
  editTaxonomy: (value: Json) => void = (): void => {},
): { readonly registryPath: string; readonly taxonomyPath: string; readonly dir: string } {
  const registry = miniRegistryJson();
  const taxonomy = miniTaxonomyJson();
  editRegistry(registry);
  editTaxonomy(taxonomy);
  const dir = tmpRepo({ "registry.json": registry, "taxonomy.json": taxonomy });
  return { registryPath: `${dir}/registry.json`, taxonomyPath: `${dir}/taxonomy.json`, dir };
}
