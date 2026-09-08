// src/shu/coverage.test.ts -- `nen shu coverage`, driven through the REAL
// dispatch (../index.ts's runFamily), against a fixture repository with one lane
// per answer this verb has to have.
//
// NO LIVE TOOLCHAIN AND NO LIVE COVERAGE RUN. Every subprocess is a
// ScriptedSeams entry, which throws on a call nobody scripted; every report is a
// file committed under ../schema/fixtures/shu-coverage-repo/. What is being
// proved is the SECOND half of this verb -- the parse, the threshold, the
// document -- on top of an executor ./run.test.ts already proves.
//
// THE THREE MUTANTS THIS FILE EXISTS TO KILL, each named at its assertion:
//   1. a threshold that moves the exit code;
//   2. a percentage computed from the counts the wrong way round (that one is
//      ./coverage/parse.test.ts's, on a fixture whose two figures differ);
//   3. a dry run that parses the report sitting on disk from a previous run.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { classifyCommand } from "../parse/izanami.js";
import { loadProfilesPack } from "../profiles/pack.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { SHU_COVERAGE_REPO } from "../schema/fixtures/paths.js";
import { shuCommand } from "./command.js";
import { advisoryFor, coverageAdvisories } from "./coverage-defaults.js";
import { parseThreshold } from "./coverage.js";
import { COVERAGE_CONTRACT } from "./coverage/report.js";
import { contractName } from "./run.js";

/** The `web` lane's declared coverage command, which every run below scripts. */
const WEB = "pnpm --filter @placeholder/core test:coverage";
const CORE = "pnpm --filter @placeholder/app test:coverage";
const GONE = "npm run coverage";

interface Options {
  readonly script?: readonly ScriptedCall[];
  readonly repo?: string;
}

interface Captured {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly seams: ScriptedSeams;
}

async function capture(argv: readonly string[], options: Options = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams(options.script ?? [], { platform: "linux", env: {} });
  const code = await runFamily(
    shuCommand,
    ["shu", ...argv],
    options.repo ?? SHU_COVERAGE_REPO,
    false,
    io,
    seams,
  );
  return { code, out, err, seams };
}

function ok(match: string): ScriptedCall {
  return { match, result: { code: 0 } };
}

interface Counts {
  readonly covered: number;
  readonly total: number;
  readonly percent: number | null;
}

interface Document {
  readonly contract: string;
  readonly lane: string;
  readonly stack: string;
  readonly total: { readonly lines: Counts; readonly branches?: Counts } | null;
  readonly targets: readonly { readonly name: string; readonly lines: Counts }[];
  readonly threshold: { readonly value: number; readonly met: boolean | null } | null;
  readonly report: { readonly format: string; readonly path: string } | null;
  readonly exitCode: number;
}

/** The one JSON document on stdout, refusing anything that is not exactly one. */
function document(result: Captured): Document {
  const text = result.out.join("\n");
  expect(text.trimStart().startsWith("{"), "stdout is not one JSON document").toBe(true);
  return JSON.parse(text) as Document;
}

// ── the parse ───────────────────────────────────────────────────────────────

describe("a coverage run, parsed", () => {
  it("runs the declared command and reports the report's own numbers", async () => {
    const result = await capture(["coverage", "--json"], { script: [ok(WEB)] });
    expect(result.code).toBe(0);
    expect(result.seams.calls.map((call): string => [call.command, ...call.args].join(" "))).toEqual([WEB]);
    const parsed = document(result);
    expect(parsed.total?.lines).toEqual({ covered: 14, total: 17, percent: 82.35 });
    expect(parsed.total?.branches).toEqual({ covered: 3, total: 4, percent: 75 });
    expect(parsed.report).toEqual({ format: "istanbul-summary", path: "coverage/coverage-summary.json" });
  });

  it("carries a row per target, sorted, each with its own counts", async () => {
    const parsed = document(await capture(["coverage", "--json"], { script: [ok(WEB)] }));
    expect(parsed.targets.map((row): unknown => [row.name, row.lines.percent])).toEqual([
      ["packages/app/src/main.ts", 75],
      ["packages/core/src/index.ts", 84.62],
    ]);
  });

  it("prints the totals, the per-target table and the report path as text", async () => {
    const result = await capture(["coverage"], { script: [ok(WEB)] });
    const text = result.out.join("\n");
    expect(text).toContain("report:        coverage/coverage-summary.json  (istanbul-summary)");
    expect(text).toContain("total:         lines 82.35% (14/17)   branches 75.00% (3/4)");
    expect(text).toContain("targets:");
    expect(text).toMatch(/^ {2}lines\s+branches\s+target$/m);
    expect(text).toMatch(/^ {2}84\.62% \(11\/13\)\s+75\.00% \(3\/4\)\s+packages\/core\/src\/index\.ts$/m);
  });

  it("prints the executor's own report first, exactly as every other verb does", async () => {
    const result = await capture(["coverage"], { script: [ok(WEB)] });
    // The run half, unchanged: the same labels `nen shu build` prints.
    expect(result.out[0]).toBe("lane:          web  (nextjs)");
    expect(result.out.some((line): boolean => line.startsWith(`ran:           ${WEB}`))).toBe(true);
    expect(result.out.some((line): boolean => line.startsWith("artifacts:     coverage/coverage-summary.json"))).toBe(
      true,
    );
    // ...and the coverage half after it, in the same label column. A block
    // indented differently reads as a different program's output.
    const labelColumn = (line: string): number => line.indexOf(line.trim().split(/\s{2,}/)[1] ?? "");
    const lane = result.out.find((line): boolean => line.startsWith("lane:"));
    const report = result.out.find((line): boolean => line.startsWith("report:"));
    expect(labelColumn(report ?? "")).toBe(labelColumn(lane ?? ""));
  });

  it("puts the executor's report on STDERR under --json, so stdout is one document", async () => {
    const result = await capture(["coverage", "--json"], { script: [ok(WEB)] });
    expect(JSON.parse(result.out.join("\n"))).toHaveProperty("contract", COVERAGE_CONTRACT);
    expect(result.err.some((line): boolean => line.startsWith("lane:          web"))).toBe(true);
    expect(result.err.some((line): boolean => line.startsWith(`ran:           ${WEB}`))).toBe(true);
    // Nothing on stdout but the document -- not a stray label, not a table.
    expect(result.out.filter((line): boolean => line.startsWith("lane:"))).toEqual([]);
  });
});

// ── the document ────────────────────────────────────────────────────────────

describe("the --json document", () => {
  it("carries its eight keys, in order", async () => {
    const result = await capture(["coverage", "--threshold", "80", "--json"], { script: [ok(WEB)] });
    expect(Object.keys(JSON.parse(result.out.join("\n")) as object)).toEqual([
      "contract",
      "lane",
      "stack",
      "total",
      "targets",
      "threshold",
      "report",
      "exitCode",
    ]);
  });

  it("orders the keys inside a measure and a row too", async () => {
    const raw = JSON.parse(
      (await capture(["coverage", "--json"], { script: [ok(WEB)] })).out.join("\n"),
    ) as Record<string, Record<string, object>>;
    expect(Object.keys(raw["total"] ?? {})).toEqual(["lines", "branches"]);
    expect(Object.keys((raw["total"]?.["lines"] ?? {}) as object)).toEqual(["covered", "total", "percent"]);
    const rows = raw["targets"] as unknown as readonly object[];
    expect(Object.keys(rows[0] ?? {})).toEqual(["name", "lines"]);
    expect(Object.keys(rows[1] ?? {})).toEqual(["name", "lines", "branches"]);
  });

  it("names the contract, and the executor names the same one for this verb", () => {
    // The string is restated in ./coverage/report.js rather than imported,
    // because importing ./run.js would put the subprocess seam on the import
    // path of every parser. This is the pin that keeps the two spellings equal.
    expect(COVERAGE_CONTRACT).toBe("nen.shu.coverage/v0.1");
    expect(contractName("coverage")).toBe(COVERAGE_CONTRACT);
  });

  it("says which lane and stack answered", async () => {
    const parsed = document(await capture(["coverage", "--lane", "web", "--json"], { script: [ok(WEB)] }));
    expect([parsed.lane, parsed.stack]).toEqual(["web", "nextjs"]);
  });
});

// ── the threshold ───────────────────────────────────────────────────────────

describe("--threshold reports and never gates", () => {
  it("met: the number cleared the bar, and the exit code is the run's", async () => {
    const result = await capture(["coverage", "--threshold", "80", "--json"], { script: [ok(WEB)] });
    expect(document(result).threshold).toEqual({ value: 80, met: true });
    expect(result.code).toBe(0);
  });

  it("NOT met: still exit 0 -- THE MUTANT. A threshold that fails the run is red here", async () => {
    const result = await capture(["coverage", "--threshold", "95", "--json"], { script: [ok(WEB)] });
    expect(document(result).threshold).toEqual({ value: 95, met: false });
    // nen never decides whether a number is good enough (zheref/nen#91, v3 q16):
    // the tool exited 0, so nen exits 0, whatever the bar says.
    expect(result.code).toBe(0);
  });

  it("met exactly at the bar", async () => {
    const result = await capture(["coverage", "--threshold", "82.35", "--json"], { script: [ok(WEB)] });
    expect(document(result).threshold).toEqual({ value: 82.35, met: true });
  });

  it("absent: the key is null rather than a bar nobody asked for", async () => {
    expect(document(await capture(["coverage", "--json"], { script: [ok(WEB)] })).threshold).toBeNull();
  });

  it("null when there is no percentage to compare it with", async () => {
    const result = await capture(["coverage", "--dry-run", "--threshold", "80", "--json"]);
    expect(document(result).threshold).toEqual({ value: 80, met: null });
  });

  it("prints the verdict and the reason it is not a gate", async () => {
    const result = await capture(["coverage", "--threshold", "95"], { script: [ok(WEB)] });
    expect(result.out.join("\n")).toContain("threshold:     95% -- NOT met.");
    expect(result.out.join("\n")).toMatch(/REPORTED and never enforced/);
    expect(result.code).toBe(0);
  });

  it("refuses a value it cannot read, before anything is spawned", async () => {
    // The last two are spelled with `=` because ../cli/args.ts refuses a
    // separate value that begins with `-` before this verb ever sees it -- also
    // exit 2, and its own test's subject rather than this one's.
    for (const value of ["high", "", "101", "=-1", "=1e3"]) {
      const argv = value.startsWith("=") ? [`--threshold${value}`] : ["--threshold", value];
      const result = await capture(["coverage", ...argv]);
      expect(result.code, value).toBe(2);
      expect(result.err.join("\n"), value).toMatch(/is not a percentage between 0 and 100/);
      expect(result.seams.calls).toEqual([]);
    }
  });

  it("is refused on every other verb rather than accepted and ignored", async () => {
    const result = await capture(["build", "--threshold", "80"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--threshold is not read by 'shu build'/);
  });

  it("parses the flag the same way the verb does", () => {
    expect(parseThreshold(null)).toBeNull();
    expect(parseThreshold("0")).toBe(0);
    expect(parseThreshold(" 82.5 ")).toBe(82.5);
    expect((): unknown => parseThreshold("80%")).toThrow(/not a percentage/);
  });
});

// ── the executor's contract, unchanged ──────────────────────────────────────

describe("the executor is the same executor", () => {
  it("--dry-run runs NOTHING and parses NOTHING -- THE STALE-REPORT MUTANT", async () => {
    // The report is on disk. A dry run that read it would report a previous
    // run's numbers for a command it did not execute, which is the most
    // believable wrong answer this verb can give.
    const result = await capture(["coverage", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    expect(result.seams.calls).toEqual([]);
    const parsed = document(result);
    expect(parsed.total).toBeNull();
    expect(parsed.targets).toEqual([]);
    expect(result.out.join("\n")).not.toContain("82.35");
    expect(result.out.join("\n")).not.toContain("14");
  });

  it("still says which report the real run WOULD parse", async () => {
    const parsed = document(await capture(["coverage", "--dry-run", "--json"]));
    expect(parsed.report).toEqual({ format: "istanbul-summary", path: "coverage/coverage-summary.json" });
    expect(parsed.exitCode).toBe(0);
  });

  it("prints the argv it would run, on stderr under --json", async () => {
    const result = await capture(["coverage", "--dry-run", "--json"]);
    expect(result.err.some((line): boolean => line === `would run:     ${WEB}`)).toBe(true);
  });

  it("tells a dry run from a real one with no dryRun boolean", async () => {
    // exitCode 0 with a null total is produced by nothing else: a successful
    // run whose report could not be read exits 1.
    const dry = document(await capture(["coverage", "--dry-run", "--json"]));
    expect([dry.exitCode, dry.total]).toEqual([0, null]);
    const wet = document(await capture(["coverage", "--json"], { script: [ok(WEB)] }));
    expect(wet.exitCode).toBe(0);
    expect(wet.total).not.toBeNull();
  });

  it("refuses an unknown lane at 2, before anything runs", async () => {
    const result = await capture(["coverage", "--lane", "nope"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--lane 'nope' is not a lane this repository declares/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses a lane that declares no coverage at 4, in the declaration's words", async () => {
    const result = await capture(["coverage"], { repo: shuRepoWithout() });
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toMatch(/declares no 'coverage'/);
  });

  it("exits 1 when the tool fails, and parses nothing", async () => {
    const result = await capture(["coverage", "--json"], {
      script: [{ match: WEB, result: { code: 3 } }],
    });
    expect(result.code).toBe(1);
    const parsed = document(result);
    // A REPORT FROM A RUN THAT FAILED MAY BE A PREVIOUS RUN'S, and nen cannot
    // tell by looking. The file is right there and is not read.
    expect(parsed.total).toBeNull();
    expect(parsed.exitCode).toBe(1);
    expect(result.out.join("\n")).not.toContain("82.35");
  });

  it("exits 5 when the tool could not be started at all", async () => {
    const result = await capture(["coverage"], {
      script: [{ match: WEB, result: { spawnFailed: true, code: -1 } }],
    });
    expect(result.code).toBe(5);
  });

  it("keeps the precondition table where a human can read it", async () => {
    const repo = withProject({
      lanes: { only: { stack: "nextjs", cwd: "." } },
      defaultLane: "only",
      preconditions: { only: [{ kind: "path", value: "not-here", why: "deliberately absent" }] },
      verbs: { only: { coverage: { exe: "x", argv: ["y"] } } },
    });
    try {
      const result = await capture(["coverage"], { repo });
      expect(result.code).toBe(2);
      expect(result.out.join("\n")).toMatch(/FAIL {2}path not-here -- not present/);
      expect(result.seams.calls).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── no report to parse ──────────────────────────────────────────────────────

describe("a run with no report to parse", () => {
  it("exits 1 naming the field to declare, and quotes the pack's advisory", async () => {
    const result = await capture(["coverage", "--lane", "core", "--json"], { script: [ok(CORE)] });
    expect(result.code).toBe(1);
    const parsed = document(result);
    expect(parsed.report).toBeNull();
    expect(parsed.total).toBeNull();
    expect(parsed.exitCode).toBe(1);
    const message = result.err.join("\n");
    expect(message).toMatch(/declares no artifacts at all/);
    expect(message).toMatch(/project\.verbs\.core\.coverage\.artifacts/);
    // The advisory is the PACK's sentence, and it says nen did not look there.
    expect(message).toContain("coverage/lcov.info");
    expect(message).toMatch(/ADVISORY, and nen did not look there/);
  });

  it("lists the formats it reads when the declared artifact is not one", async () => {
    const result = await capture(["coverage", "--lane", "native"], {
      script: [ok("placeholder-build-tool test -enableCodeCoverage YES")],
    });
    expect(result.code).toBe(1);
    const message = result.err.join("\n");
    expect(message).toMatch(/recognises none of them as a coverage report: coverage\/notes\.md/);
    expect(message).toMatch(/istanbul-summary/);
    expect(message).toMatch(/lcov/);
    // xcode-ios has no conventional location, and the pack says why rather
    // than inventing one.
    expect(message).toMatch(/records no conventional report location for 'xcode-ios'/);
  });

  it("exits 1 naming the path when the declared report is not there", async () => {
    const result = await capture(["coverage", "--lane", "gone", "--json"], { script: [ok(GONE)] });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/no coverage report at coverage\/gone\/coverage-summary\.json/);
    // The document still names the report it went looking for, so a machine
    // reader can tell "no artifact declared" from "the artifact is missing".
    expect(document(result).report).toEqual({
      format: "istanbul-summary",
      path: "coverage/gone/coverage-summary.json",
    });
  });

  it("says WHICH of the four things left it with nothing to parse", async () => {
    // One null total, four causes. A machine reader has `exitCode` and
    // `report` to tell them apart; a human gets the sentence.
    const cases: readonly (readonly [Captured, string])[] = [
      [await capture(["coverage", "--dry-run"]), "this was a dry run"],
      [
        await capture(["coverage"], { script: [{ match: WEB, result: { code: 3 } }] }),
        "the run did not succeed",
      ],
      [
        await capture(["coverage", "--lane", "core"], { script: [ok(CORE)] }),
        "the run succeeded and this lane declares no report nen reads",
      ],
      [
        await capture(["coverage", "--lane", "gone"], { script: [ok(GONE)] }),
        "the run succeeded and its report could not be read",
      ],
    ];
    for (const [result, why] of cases) {
      expect(result.out.join("\n"), why).toContain(`(nothing parsed -- ${why}`);
    }
  });

  it("says so on a dry run too, without failing the dry run", async () => {
    const result = await capture(["coverage", "--lane", "core", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toMatch(/declares no artifacts at all/);
  });
});

// ── the catalogue half ──────────────────────────────────────────────────────

describe("the advisory comes from the pack, as data", () => {
  const advisories = coverageAdvisories();

  it("carries one entry per profile the pack ships", () => {
    expect(Object.keys(advisories).sort()).toEqual([...loadProfilesPack().ids].sort());
  });

  it("states a reason for every stack, and a path only where one is conventional", () => {
    for (const [stack, advisory] of Object.entries(advisories)) {
      expect(advisory.why, stack).not.toBe("");
      expect(advisory.source, stack).not.toBe("");
    }
    // One of the seven has a conventional location; the other six say why they
    // do not, which is the finding rather than a gap in the data.
    const withPath = Object.entries(advisories).filter(([, entry]): boolean => entry.path !== null);
    expect(withPath.map(([stack]): string => stack)).toEqual(["nextjs"]);
  });

  it("answers for a stack the pack has never heard of", () => {
    expect(advisoryFor(advisories, "invented")).toMatch(/carries no profile for stack 'invented'/);
  });
});

// ── izanami ─────────────────────────────────────────────────────────────────

describe("the automation-policy row is unchanged", () => {
  it("refuses the bare form and admits the dry run, --threshold or not", () => {
    expect(classifyCommand("nen shu coverage --repo /x").classification).toBe("mutating");
    expect(classifyCommand("nen shu coverage --repo /x --threshold 80").classification).toBe("mutating");
    expect(classifyCommand("nen shu coverage --repo /x --dry-run").classification).toBe("read-only");
    expect(classifyCommand("nen shu coverage --repo /x --dry-run --threshold 80").classification).toBe(
      "read-only",
    );
  });

  it("says why the bare form is never certified", () => {
    expect(classifyCommand("nen shu coverage").reason).toMatch(/writes its report tree by definition/);
  });
});

// ── fixtures written for one refusal each ───────────────────────────────────

function withProject(project: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-shu-coverage-"));
  mkdirSync(join(dir, "nen"));
  writeFileSync(
    join(dir, "nen", "contract.json"),
    JSON.stringify({ $schema: "nen.contract/v0.1", project }),
  );
  return dir;
}

/** A repository whose lane declares every verb but this one. */
function shuRepoWithout(): string {
  return withProject({
    lanes: { only: { stack: "nextjs", cwd: "." } },
    defaultLane: "only",
    verbs: { only: { build: { exe: "x", argv: ["y"] } } },
  });
}
