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
import { SHU_COVERAGE_REPO, SHU_REPO } from "../schema/fixtures/paths.js";
import { shuCommand } from "./command.js";
import { coverageAdvisories } from "./coverage-defaults.js";
import { parseThreshold, relativiseName } from "./coverage.js";
import { advisoryFor } from "./coverage/advisory.js";
import { COVERAGE_CONTRACT, thresholdMet } from "./coverage/report.js";
import { counts, measure } from "./coverage/shape.js";
import { contractName } from "./run.js";

/** The `web` lane's declared coverage command, which every run below scripts. */
const WEB = "pnpm --filter @placeholder/core test:coverage";
const CORE = "pnpm --filter @placeholder/app test:coverage";
const GONE = "npm run coverage";

interface Options {
  readonly script?: readonly ScriptedCall[];
  readonly repo?: string;
  /**
   * The child environment the preconditions are asserted against.
   *
   * EMPTY BY DEFAULT, because this file's own fixture declares none. The
   * executor's fixture (`SHU_REPO`) declares an `env` precondition, and a run
   * against it is a run about a declaration written to the design that shipped
   * -- so that one lane states the name it needs.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
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
  const seams = new ScriptedSeams(options.script ?? [], {
    platform: "linux",
    env: options.env ?? {},
  });
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

interface TouchedDoc {
  readonly base: string;
  readonly files: readonly string[];
  readonly matched: readonly string[];
  readonly unmatched: readonly string[];
}

interface LadderDoc {
  readonly minimum: number;
  readonly recommended: number;
  readonly ideal: number;
  readonly source: string;
}

interface Document {
  readonly contract: string;
  readonly lane: string;
  readonly stack: string;
  readonly total: { readonly lines: Counts; readonly branches?: Counts } | null;
  readonly targets: readonly {
    readonly name: string;
    readonly lines: Counts;
    readonly met?: boolean | null;
    readonly band?: string | null;
  }[];
  readonly threshold: { readonly value: number; readonly met: boolean | null } | null;
  readonly report: { readonly format: string; readonly path: string } | null;
  readonly exitCode: number;
  readonly touched: TouchedDoc | null;
  readonly ladder: LadderDoc | null;
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

  it("takes the first artifact whose FORMAT it recognises, not the first artifact", async () => {
    // A coverage verb routinely writes several things -- an HTML tree, notes, a
    // JUnit file, the machine report -- and the machine report is rarely
    // first. The `mixed` lane declares `coverage/notes.md` ahead of
    // `coverage/lcov.info`; a reader of `artifacts[0]` alone would refuse a
    // lane that has declared exactly what it was asked for.
    const result = await capture(["coverage", "--lane", "mixed", "--json"], {
      script: [ok("npm run coverage:all")],
    });
    expect(result.code).toBe(0);
    const parsed = document(result);
    expect(parsed.report).toEqual({ format: "lcov", path: "coverage/lcov.info" });
    expect(parsed.total?.lines).toEqual({ covered: 14, total: 17, percent: 82.35 });
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
  it("carries its ten keys, in order", async () => {
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
      "touched",
      "ladder",
    ]);
  });

  it("'touched' and 'ladder' are null without --touched", async () => {
    const parsed = document(await capture(["coverage", "--json"], { script: [ok(WEB)] }));
    expect(parsed.touched).toBeNull();
    expect(parsed.ladder).toBeNull();
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

  it("compares the COUNTS, not the percentage the table prints", () => {
    // THE FAIL-OPEN MUTANT. 19999 of 25000 lines is 79.996%, which rounds to
    // the 80.00 the table shows -- so a comparison against `percent` reports
    // `met: true` for a project UNDER the bar, in the one direction a
    // pipeline gating on this field cannot survive. One line more and it is
    // genuinely met; the two cases differ by a single line and must differ in
    // the answer.
    const under = measure(counts(19999, 25000), null);
    const exactly = measure(counts(20000, 25000), null);
    expect(under.lines.percent).toBe(80);
    expect(thresholdMet(under, 80)).toBe(false);
    expect(exactly.lines.percent).toBe(80);
    expect(thresholdMet(exactly, 80)).toBe(true);
    // The same shape at the other end: 999999/1000000 is not 100%.
    expect(thresholdMet(measure(counts(999999, 1000000), null), 100)).toBe(false);
    expect(thresholdMet(measure(counts(1000000, 1000000), null), 100)).toBe(true);
    // And nothing to compare stays null rather than becoming a verdict.
    expect(thresholdMet(null, 80)).toBeNull();
    expect(thresholdMet(measure(counts(0, 0), null), 0)).toBeNull();
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
    expect(parseThreshold("100")).toBe(100);
    expect(parseThreshold(" 82.5 ")).toBe(82.5);
    expect((): unknown => parseThreshold("80%")).toThrow(/not a percentage/);
  });

  it("reads DECIMAL digits and nothing else -- '0x50' is not eighty", () => {
    // `Number` also reads hex, binary, exponent and `Infinity`, so
    // `--threshold 0x50` was silently accepted as 80: a caller who typed
    // something else got a number instead of the sentence that would have told
    // them. Every spelling below is a usage error now.
    for (const raw of ["0x50", "0b1010000", "8e1", "1e2", "+80", ".5", "8 0", "Infinity"]) {
      expect((): unknown => parseThreshold(raw), raw).toThrow(/not a percentage/);
    }
    // Surrounding whitespace is still trimmed rather than refused: a shell that
    // handed over ` 80 ` said 80, and nothing else is ambiguous about it.
    expect(parseThreshold(" 80 ")).toBe(80);
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
    const repo = shuRepoWithout();
    try {
      const result = await capture(["coverage"], { repo });
      expect(result.code).toBe(4);
      expect(result.err.join("\n")).toMatch(/declares no 'coverage'/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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

  it("exits 5 when the tool could not be started at all -- AND STILL PRINTS THE REPORT", async () => {
    // ../run.ts hands the report to the sink and then THROWS on this path, so
    // the verb that captures the report is the one that could lose it -- on
    // the one path where the argv that failed is what the reader needs. `nen
    // shu build` prints nine lines and a refusal here; so does this.
    const result = await capture(["coverage"], {
      script: [{ match: WEB, result: { spawnFailed: true, code: -1 } }],
    });
    expect(result.code).toBe(5);
    const text = result.out.join("\n");
    expect(text).toContain("lane:          web  (nextjs)");
    expect(text).toContain(`ran:           ${WEB}  -- did not start`);
    expect(text).toContain("report:        coverage/coverage-summary.json  (istanbul-summary)");
    expect(text).toContain("(nothing parsed -- the run did not succeed");
    // The refusal itself still propagates, in ../command.ts's words.
    expect(result.err.join("\n")).toMatch(/could not be started: 'pnpm'/);
    // And nothing was parsed: the report is on disk and this run did not write it.
    expect(text).not.toContain("82.35");
  });

  it("keeps stdout to ONE document on the exit-5 path under --json", async () => {
    // The same rule as every other path, on the one that throws: `nen shu
    // coverage --json | jq .` reads a document whatever happened, and the
    // executor's own report is beside it on stderr.
    const result = await capture(["coverage", "--json"], {
      script: [{ match: WEB, result: { spawnFailed: true, code: -1 } }],
    });
    expect(result.code).toBe(5);
    const parsed = document(result);
    expect(parsed.exitCode).toBe(5);
    expect(parsed.total).toBeNull();
    expect(parsed.report).toEqual({
      format: "istanbul-summary",
      path: "coverage/coverage-summary.json",
    });
    expect(result.err.some((line): boolean => line.startsWith("lane:          web"))).toBe(true);
    expect(result.out.filter((line): boolean => line.startsWith("lane:"))).toEqual([]);
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

// ── row names are not somebody's home directory ─────────────────────────────

describe("a row name inside the repository is reported relative to it", () => {
  it("relativises an absolute key the reporter wrote, on both separator shapes", () => {
    // nyc and vitest's json-summary write ABSOLUTE keys, so a --json document
    // or a pasted table carries the username and directory layout of whoever
    // ran it -- the same class of leak ./run.ts refuses for a declaration's env
    // VALUES. Both shapes are stated here rather than only this platform's,
    // because a report read on a mac was often written on a CI runner.
    expect(relativiseName("/w/repo", "/w/repo/src/a.ts")).toBe("src/a.ts");
    expect(relativiseName("C:\\Users\\u\\repo", "C:\\Users\\u\\repo\\src\\a.ts")).toBe("src/a.ts");
    // Mixed separators, which is what a POSIX-written path read on win32 is.
    expect(relativiseName("C:\\Users\\u\\repo", "C:/Users/u/repo/src/a.ts")).toBe("src/a.ts");
    // A trailing separator on the root changes nothing.
    expect(relativiseName("/w/repo/", "/w/repo/src/a.ts")).toBe("src/a.ts");
  });

  it("leaves a name that is not inside the repository exactly as written", () => {
    // nen reports what a report states. A row genuinely outside the tree is a
    // fact about the run, not a string to rewrite into a relative path that
    // would resolve somewhere else entirely.
    expect(relativiseName("/w/repo", "/w/other/src/a.ts")).toBe("/w/other/src/a.ts");
    expect(relativiseName("/w/repo", "src/a.ts")).toBe("src/a.ts");
    // A PREFIX IS NOT A PATH BOUNDARY: `/w/repo-2` starts with `/w/repo`.
    expect(relativiseName("/w/repo", "/w/repo-2/src/a.ts")).toBe("/w/repo-2/src/a.ts");
    // And the root itself is left alone rather than becoming an empty name.
    expect(relativiseName("/w/repo", "/w/repo")).toBe("/w/repo");
  });

  it("does it end to end, on a report whose keys are this run's own root", async () => {
    const repo = withProject({
      lanes: { only: { stack: "nextjs", cwd: "." } },
      defaultLane: "only",
      verbs: { only: { coverage: { exe: "x", argv: ["y"], artifacts: ["coverage-summary.json"] } } },
    });
    try {
      // The keys are absolute BECAUSE the fixture is written at run time: no
      // committed file can name a temporary directory, which is exactly why no
      // committed fixture had caught this.
      writeFileSync(
        join(repo, "coverage-summary.json"),
        JSON.stringify({
          total: { lines: { total: 4, covered: 3 } },
          [join(repo, "src", "a.ts")]: { lines: { total: 4, covered: 3 } },
        }),
      );
      const result = await capture(["coverage", "--json"], { repo, script: [ok("x y")] });
      expect(result.code).toBe(0);
      const rows = document(result).targets.map((row): string => row.name);
      expect(rows).toEqual([["src", "a.ts"].join("/")]);
      // The point of the exercise: the temporary root is nowhere in the output.
      expect(result.out.join("\n")).not.toContain(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── a declaration written to the design that was published ──────────────────

describe("a 'report' key the shipped verb does not read is NAMED", () => {
  it("says so, with the pointer and the field that replaced it", async () => {
    // ../schema/fixtures/shu-repo declares `coverage.report` -- zheref/nen#91's
    // v4 §2.10 field -- and no `artifacts`. The schema preserves an unknown key
    // rather than refusing it, so without this the refusal told somebody
    // looking straight at their declared path that they had "declared no
    // artifacts at all".
    const result = await capture(["coverage"], {
      repo: SHU_REPO,
      env: { PLACEHOLDER_LANE_TOKEN: "a value no output may carry" },
      script: [
        ok("pnpm --filter @placeholder/core test:coverage"),
        ok("pnpm --filter @placeholder/app test:coverage"),
      ],
    });
    expect(result.code).toBe(1);
    const message = result.err.join("\n");
    expect(message).toContain("project.verbs.web.coverage.report");
    expect(message).toMatch(/this release does not read/);
    expect(message).toMatch(/reads 'artifacts' instead/);
    expect(message).toContain("project.verbs.web.coverage.artifacts");
  });

  it("says nothing about it on a lane that simply declared nothing", async () => {
    // The sentence is about a key that IS there. A lane with neither field gets
    // the plain refusal, or every reader learns to skip a paragraph.
    const result = await capture(["coverage", "--lane", "core"], { script: [ok(CORE)] });
    expect(result.err.join("\n")).not.toMatch(/this release does not read/);
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

  it("--touched --base does not change the class either way -- THE MUTANT", () => {
    // izanami's coverage row is DRY-run-gated on the exact '--dry-run' token
    // alone; a flag pair this verb ADDED must not become a second way to
    // certify the bare (writing) form read-only, and must not make the
    // explicit --dry-run form stop being certified either.
    expect(classifyCommand("nen shu coverage --repo /x --touched --base main").classification).toBe(
      "mutating",
    );
    expect(
      classifyCommand("nen shu coverage --repo /x --touched --base main --dry-run").classification,
    ).toBe("read-only");
  });

  it("says why the bare form is never certified", () => {
    expect(classifyCommand("nen shu coverage").reason).toMatch(/writes its report tree by definition/);
  });
});

// ── --touched --base <ref> ──────────────────────────────────────────────────

describe("--touched --base <ref>", () => {
  const diff = (base: string): string => `git diff --name-only ${base}...HEAD`;

  it("--touched requires --base, refused at 2 before anything runs", async () => {
    const result = await capture(["coverage", "--touched"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--touched requires --base/);
    expect(result.seams.calls).toEqual([]);
  });

  it("--base is refused without --touched, before anything runs", async () => {
    const result = await capture(["coverage", "--base", "main"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--base is read only with --touched/);
    expect(result.seams.calls).toEqual([]);
  });

  it("both are refused on every other verb rather than accepted and ignored", async () => {
    const touched = await capture(["build", "--touched"]);
    expect(touched.code).toBe(2);
    expect(touched.err.join("\n")).toMatch(/--touched is not read by 'shu build'/);
    const base = await capture(["build", "--base", "main"]);
    expect(base.code).toBe(2);
    expect(base.err.join("\n")).toMatch(/--base is not read by 'shu build'/);
  });

  it("runs git diff AFTER the coverage tool, against the repository root", async () => {
    const result = await capture(["coverage", "--touched", "--base", "main"], {
      script: [ok(WEB), { match: diff("main"), result: { code: 0, stdout: "" } }],
    });
    expect(result.code).toBe(0);
    expect(result.seams.calls.map((call): string => [call.command, ...call.args].join(" "))).toEqual([
      WEB,
      diff("main"),
    ]);
    expect(result.seams.calls[1]?.cwd).toBe(SHU_COVERAGE_REPO);
  });

  it("filters targets to the touched set, file grain, exact-path match", async () => {
    const result = await capture(["coverage", "--touched", "--base", "main", "--json"], {
      script: [
        ok(WEB),
        { match: diff("main"), result: { code: 0, stdout: "packages/core/src/index.ts\nREADME.md\n" } },
      ],
    });
    expect(result.code).toBe(0);
    const parsed = document(result);
    expect(parsed.targets.map((row): string => row.name)).toEqual(["packages/core/src/index.ts"]);
    expect(parsed.touched).toEqual({
      base: "main",
      files: ["packages/core/src/index.ts", "README.md"],
      matched: ["packages/core/src/index.ts"],
      unmatched: ["README.md"],
    });
  });

  it("adds 'met' per row when --threshold is given, against that row's own counts", async () => {
    const result = await capture(
      ["coverage", "--touched", "--base", "main", "--threshold", "80", "--json"],
      {
        script: [
          ok(WEB),
          {
            match: diff("main"),
            result: { code: 0, stdout: "packages/core/src/index.ts\npackages/app/src/main.ts\n" },
          },
        ],
      },
    );
    expect(result.code).toBe(0);
    const parsed = document(result);
    const byName = new Map(parsed.targets.map((row): [string, boolean | null | undefined] => [row.name, row.met]));
    expect(byName.get("packages/core/src/index.ts")).toBe(true); // 84.62%
    expect(byName.get("packages/app/src/main.ts")).toBe(false); // 75%
    // The AGGREGATE 'threshold.met' is unaffected -- it still compares the
    // WHOLE report's total, never the touched subset.
    expect(parsed.threshold).toEqual({ value: 80, met: true });
  });

  it("no threshold: a row carries no 'met' key at all", async () => {
    const result = await capture(["coverage", "--touched", "--base", "main", "--json"], {
      script: [ok(WEB), { match: diff("main"), result: { code: 0, stdout: "packages/core/src/index.ts\n" } }],
    });
    const raw = JSON.parse(result.out.join("\n")) as { targets: readonly Record<string, unknown>[] };
    expect(Object.keys(raw.targets[0] ?? {})).toEqual(["name", "lines", "branches"]);
  });

  it("still never gates: exit 0 even when a touched row misses the bar", async () => {
    const result = await capture(
      ["coverage", "--touched", "--base", "main", "--threshold", "100", "--json"],
      {
        script: [
          ok(WEB),
          { match: diff("main"), result: { code: 0, stdout: "packages/app/src/main.ts\n" } },
        ],
      },
    );
    expect(result.code).toBe(0);
    expect(document(result).targets[0]?.met).toBe(false);
  });

  it("--dry-run still computes the touched set -- nothing to match against yet", async () => {
    const result = await capture(["coverage", "--touched", "--base", "main", "--dry-run", "--json"], {
      script: [{ match: diff("main"), result: { code: 0, stdout: "a.ts\n" } }],
    });
    expect(result.code).toBe(0);
    const parsed = document(result);
    expect(parsed.total).toBeNull();
    expect(parsed.targets).toEqual([]);
    expect(parsed.touched).toEqual({ base: "main", files: ["a.ts"], matched: [], unmatched: ["a.ts"] });
  });

  it("a run that failed still reports the touched set as entirely unmatched, and stays exit 1", async () => {
    const result = await capture(["coverage", "--touched", "--base", "main", "--json"], {
      script: [
        { match: WEB, result: { code: 3 } },
        { match: diff("main"), result: { code: 0, stdout: "a.ts\n" } },
      ],
    });
    expect(result.code).toBe(1);
    expect(document(result).touched?.unmatched).toEqual(["a.ts"]);
  });

  it("a base git cannot diff against surfaces as the tool's own failure, exit 1", async () => {
    const result = await capture(["coverage", "--touched", "--base", "nope", "--json"], {
      script: [
        ok(WEB),
        { match: diff("nope"), result: { code: 128, stderr: "fatal: bad revision 'nope...HEAD'" } },
      ],
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/git diff --name-only nope\.\.\.HEAD.*exited 128/);
  });

  it("package grain (cobertura): a touched file under the package is kept, text says 'BY PACKAGE'", async () => {
    const repo = withProject({
      lanes: { only: { stack: "nextjs", cwd: "." } },
      defaultLane: "only",
      verbs: { only: { coverage: { exe: "x", argv: ["y"], artifacts: ["coverage.cobertura.xml"] } } },
    });
    try {
      writeFileSync(
        join(repo, "coverage.cobertura.xml"),
        '<coverage line-rate="1" lines-covered="4" lines-valid="4"><packages><package name="Placeholder.Core"><classes><class name="C" filename="Core/Store.cs"><lines><line number="1" hits="1"/><line number="2" hits="1"/><line number="3" hits="1"/><line number="4" hits="1"/></lines></class></classes></package></packages></coverage>',
      );
      const result = await capture(["coverage", "--touched", "--base", "main"], {
        repo,
        script: [
          ok("x y"),
          { match: diff("main"), result: { code: 0, stdout: "src/Placeholder/Core/Store.cs\n" } },
        ],
      });
      expect(result.code).toBe(0);
      expect(result.out.join("\n")).toContain("Placeholder.Core");
      expect(result.out.join("\n")).toMatch(/matched BY PACKAGE/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("xccov: descends targets[].files[] under --touched, rows are FILES not targets", async () => {
    const repo = withProject({
      lanes: { only: { stack: "xcode-ios", cwd: "." } },
      defaultLane: "only",
      verbs: { only: { coverage: { exe: "x", argv: ["y"], artifacts: ["xccov-report.json"] } } },
    });
    try {
      writeFileSync(
        join(repo, "xccov-report.json"),
        JSON.stringify({
          coveredLines: 3,
          executableLines: 4,
          targets: [
            {
              name: "Core.framework",
              coveredLines: 3,
              executableLines: 4,
              files: [
                {
                  name: "Store.swift",
                  path: join(repo, "Core", "Store.swift"),
                  coveredLines: 3,
                  executableLines: 4,
                },
              ],
            },
          ],
        }),
      );
      const result = await capture(["coverage", "--touched", "--base", "main", "--json"], {
        repo,
        script: [ok("x y"), { match: diff("main"), result: { code: 0, stdout: "Core/Store.swift\n" } }],
      });
      expect(result.code).toBe(0);
      const parsed = document(result);
      expect(parsed.targets.map((row): string => row.name)).toEqual(["Core/Store.swift"]);
      expect(parsed.touched?.matched).toEqual(["Core/Store.swift"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── the coverage ladder (nen/workflow.json), --threshold absent only ───────

describe("the coverage ladder, when --threshold is absent", () => {
  const LADDER_REPORT = JSON.stringify({
    total: { lines: { total: 17, covered: 14 }, branches: { total: 4, covered: 3 } },
    "packages/core/src/index.ts": {
      lines: { total: 13, covered: 11 },
      branches: { total: 4, covered: 3 },
    },
    "packages/app/src/main.ts": { lines: { total: 4, covered: 3 } },
  });

  function withLadderProject(coverage: unknown): string {
    const repo = withProject({
      lanes: { only: { stack: "nextjs", cwd: "." } },
      defaultLane: "only",
      verbs: { only: { coverage: { exe: "x", argv: ["y"], artifacts: ["coverage-summary.json"] } } },
    });
    writeFileSync(join(repo, "coverage-summary.json"), LADDER_REPORT);
    if (coverage !== undefined) {
      writeFileSync(join(repo, "nen", "workflow.json"), JSON.stringify({ coverage }));
    }
    return repo;
  }

  const DIFF_MAIN = "git diff --name-only main...HEAD";
  const BOTH_TOUCHED = "packages/core/src/index.ts\npackages/app/src/main.ts\n";

  it("bands each touched row against minimum/recommended/ideal -- no key besides 'met' moved", async () => {
    const repo = withLadderProject({ minimum: 80, recommended: 85, ideal: 90, scope: "touched" });
    try {
      const result = await capture(["coverage", "--touched", "--base", "main", "--json"], {
        repo,
        script: [ok("x y"), { match: DIFF_MAIN, result: { code: 0, stdout: BOTH_TOUCHED } }],
      });
      expect(result.code).toBe(0);
      const parsed = document(result);
      const byName = new Map(parsed.targets.map((row): [string, string | null | undefined] => [row.name, row.band]));
      // 11/13 = 84.62% -- at or above minimum(80), below recommended(85).
      expect(byName.get("packages/core/src/index.ts")).toBe("minimum");
      // 3/4 = 75% -- below minimum(80).
      expect(byName.get("packages/app/src/main.ts")).toBe("under-minimum");
      expect(parsed.ladder).toEqual({
        minimum: 80,
        recommended: 85,
        ideal: 90,
        source: "nen/workflow.json",
      });
      // No row carries 'met': there was no --threshold to answer for.
      expect(parsed.targets.every((row): boolean => row.met === undefined)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("bands 'ideal' and 'recommended' too, at the right rungs", async () => {
    // Same report, a lower bar: 84.62% now clears recommended(70) but not
    // ideal(90); 75% clears minimum(50) and recommended(70) but not ideal.
    const repo = withLadderProject({ minimum: 50, recommended: 70, ideal: 90 });
    try {
      const result = await capture(["coverage", "--touched", "--base", "main", "--json"], {
        repo,
        script: [ok("x y"), { match: DIFF_MAIN, result: { code: 0, stdout: BOTH_TOUCHED } }],
      });
      const byName = new Map(document(result).targets.map((row): [string, string | null | undefined] => [row.name, row.band]));
      expect(byName.get("packages/core/src/index.ts")).toBe("recommended");
      expect(byName.get("packages/app/src/main.ts")).toBe("recommended");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an explicit --threshold overrides the ladder entirely: rows carry 'met', 'ladder' stays null", async () => {
    const repo = withLadderProject({ minimum: 80, recommended: 85, ideal: 90 });
    try {
      const result = await capture(
        ["coverage", "--touched", "--base", "main", "--threshold", "80", "--json"],
        { repo, script: [ok("x y"), { match: DIFF_MAIN, result: { code: 0, stdout: BOTH_TOUCHED } }] },
      );
      const parsed = document(result);
      expect(parsed.ladder).toBeNull();
      expect(parsed.targets.every((row): boolean => row.band === undefined)).toBe(true);
      expect(parsed.targets.some((row): boolean => row.met !== undefined)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("no nen/workflow.json: 'ladder' is null and no row carries 'band' -- unchanged from before this existed", async () => {
    const repo = withLadderProject(undefined);
    try {
      const result = await capture(["coverage", "--touched", "--base", "main", "--json"], {
        repo,
        script: [ok("x y"), { match: DIFF_MAIN, result: { code: 0, stdout: BOTH_TOUCHED } }],
      });
      const parsed = document(result);
      expect(parsed.ladder).toBeNull();
      expect(parsed.targets.every((row): boolean => row.band === undefined)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an incomplete coverage block (missing 'ideal') is treated as no ladder, silently", async () => {
    const repo = withLadderProject({ minimum: 80, recommended: 85 });
    try {
      const result = await capture(["coverage", "--touched", "--base", "main", "--json"], {
        repo,
        script: [ok("x y"), { match: DIFF_MAIN, result: { code: 0, stdout: BOTH_TOUCHED } }],
      });
      expect(document(result).ladder).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("is scoped to --touched: a plain run with no --threshold and a workflow.json present bands nothing", async () => {
    const repo = withLadderProject({ minimum: 80, recommended: 85, ideal: 90 });
    try {
      const result = await capture(["coverage", "--json"], { repo, script: [ok("x y")] });
      const parsed = document(result);
      expect(parsed.ladder).toBeNull();
      expect(parsed.targets.every((row): boolean => row.band === undefined)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("prints a 'ladder:' line and a 'band' column, never alongside 'threshold:'", async () => {
    const repo = withLadderProject({ minimum: 80, recommended: 85, ideal: 90 });
    try {
      const result = await capture(["coverage", "--touched", "--base", "main"], {
        repo,
        script: [ok("x y"), { match: DIFF_MAIN, result: { code: 0, stdout: BOTH_TOUCHED } }],
      });
      const text = result.out.join("\n");
      expect(text).toMatch(/^ladder:\s+nen\/workflow\.json -- minimum 80% \/ recommended 85% \/ ideal 90%/m);
      expect(text).not.toMatch(/^threshold:/m);
      expect(text).toMatch(/^ {2}lines\s+branches\s+band\s+target$/m);
      expect(text).toContain("minimum");
      expect(text).toContain("under-minimum");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
