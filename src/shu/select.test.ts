// src/shu/select.test.ts -- `nen shu test --select` (zheref/nen#207): one
// declared focused form per lane, expanded per identifier, refused before
// anything spawns when the selection or the declaration cannot be honoured.
//
// NO LIVE TOOLCHAIN. Every subprocess is a ScriptedSeams entry, which throws on
// a call nobody scripted -- so "nothing spawned" is asserted twice over: the
// refusals below script nothing, and `seams.calls` is still checked empty.
// The runner names in these declarations are DATA, exactly as a consumer's
// would be: nen's own code names none of them.

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { fileURLToPath } from "node:url";
import { loadContract, parseProjectBlock, SELECT_RESULT_FORMATS } from "../schema/contract.js";
import { FORMATS } from "./test-report/parse.js";
import { SchemaError } from "../schema/errors.js";
import { shuCommand } from "./command.js";
import { parseSelectionIds } from "./render.js";

interface Captured {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly seams: ScriptedSeams;
}

/** Run `nen shu <argv>` against `project`, written into a throwaway repository. */
async function shu(
  project: unknown,
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  platform: NodeJS.Platform = "darwin",
  seed?: (root: string) => void,
  inspect?: (root: string) => void,
): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "nen-shu-select-"));
  try {
    mkdirSync(join(dir, "nen"));
    writeFileSync(join(dir, "nen", "contract.json"), JSON.stringify({ $schema: "nen.contract/v0.1", project }));
    seed?.(dir);
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams(script, {
      env: {},
      platform,
      now: (): Date => new Date(Date.UTC(2026, 0, 1)),
    });
    const code = await runFamily(shuCommand, ["shu", ...argv], dir, false, io, seams);
    inspect?.(dir);
    return { code, out, err, seams };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every argv the seam took, joined. */
function spawned(seams: ScriptedSeams): readonly string[] {
  return seams.calls.map((call): string => [call.command, ...call.args].join(" "));
}

// ── two runner shapes, both pure data ───────────────────────────────────────

/** An xcodebuild-shaped lane: a coverage-instrumented regression, a focused form. */
const APPLE_REGRESSION = [
  "-scheme",
  "Kro",
  "-destination",
  "platform=iOS Simulator,name=iPhone 17 Pro",
  "-enableCodeCoverage",
  "YES",
  "-resultBundlePath",
  ".nen/aka/regression.xcresult",
  "test",
];
const APPLE_FOCUSED = [
  "-scheme",
  "Kro",
  "-destination",
  "platform=iOS Simulator,name=iPhone 17 Pro",
  "-resultBundlePath",
  ".nen/focused/apple.xcresult",
  "test",
];
const APPLE_PATTERN = "[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*){0,2}";
const APPLE_RESULTS = ".nen/focused/summary.json";

/** An xcresult test summary stating `executed` passing tests. */
function appleSummary(executed: number, skipped = 0): string {
  return JSON.stringify({
    totalTestCount: executed + skipped,
    passedTests: executed,
    failedTests: 0,
    skippedTests: skipped,
  });
}

/** A JUnit document with `cases` passing test cases. */
function junit(cases: number): string {
  const rows = Array.from({ length: cases }, (_, index): string => `<testcase classname="s" name="t${index}" time="0.01"/>`);
  return `<?xml version="1.0"?>\n<testsuites tests="${cases}"><testsuite name="s" tests="${cases}">${rows.join("")}</testsuite></testsuites>\n`;
}

function appleProject(select: unknown = undefined): Record<string, unknown> {
  return {
    lanes: { apple: { stack: "xcode-ios", cwd: "." } },
    defaultLane: "apple",
    hosts: { "*": ["darwin"] },
    verbs: {
      apple: {
        test: {
          exe: "xcodebuild",
          argv: APPLE_REGRESSION,
          artifacts: [".nen/aka/regression.xcresult"],
          env: { REGRESSION_ONLY: "1" },
          ...(select === undefined
            ? {
                select: {
                  exe: "xcodebuild",
                  argv: APPLE_FOCUSED,
                  each: ["-only-testing:{id}"],
                  pattern: APPLE_PATTERN,
                  // THE SUMMARY, NOT THE BUNDLE: nen reads no .xcresult, so an
                  // Apple lane's focused form hands nen the test summary JSON
                  // (here on stdout, written by nen through stdoutTo).
                  stdoutTo: APPLE_RESULTS,
                  results: { path: APPLE_RESULTS, format: "xcresult-summary" },
                  artifacts: [".nen/focused/apple.xcresult"],
                  why: "Focused authored tests: no coverage, a result bundle of their own.",
                },
              }
            : select === null
              ? {}
              : { select }),
        },
      },
    },
  };
}

/** A vitest-shaped lane: identifiers are file paths, appended as positionals. */
function vitestProject(): Record<string, unknown> {
  return {
    lanes: { web: { stack: "bun-cli", cwd: "." } },
    defaultLane: "web",
    verbs: {
      web: {
        test: {
          exe: "bunx",
          argv: ["vitest", "run", "--coverage", "--reporter=junit", "--outputFile.junit=.nen/regression.junit.xml"],
          artifacts: [".nen/regression.junit.xml", "coverage/lcov.info"],
          select: {
            exe: "bunx",
            argv: ["vitest", "run", "--reporter=junit"],
            each: ["{id}"],
            pattern: "src/[A-Za-z0-9_/-]*[A-Za-z0-9_.-]+\\.test\\.ts",
            stdoutTo: ".nen/focused.junit.xml",
            results: { path: ".nen/focused.junit.xml", format: "junit" },
          },
        },
        coverage: {
          exe: "bun",
          argv: ["--eval", "0"],
          artifacts: ["coverage/lcov.info"],
        },
      },
    },
  };
}

// ── (a) exact argv, both shapes, multiple selections ───────────────────────

describe("--select expands the declared focused form, per identifier, in order", () => {
  it("an xcodebuild-shaped lane: one -only-testing per identifier, after the focused base", async () => {
    const ids = ["KroTests/CaptureTests/testInlinePills", "KroTests/InboxTests", "KroTests"];
    const result = await shu(appleProject(), ["test", "--select", ids.join(","), "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    expect(result.seams.calls).toEqual([]);
    const report = JSON.parse(result.out.join("\n")) as {
      steps: { exe: string; argv: string[]; stdoutTo: string | null }[];
      env: string[];
      artifacts: { value: string }[];
      selection: { pointer: string; ids: string[]; pattern: string; each: string[]; appended: string[] };
    };
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]?.exe).toBe("xcodebuild");
    expect(report.steps[0]?.argv).toEqual([
      ...APPLE_FOCUSED,
      "-only-testing:KroTests/CaptureTests/testInlinePills",
      "-only-testing:KroTests/InboxTests",
      "-only-testing:KroTests",
    ]);
    // NOTHING OF THE REGRESSION ROW: no coverage flag, no env, no capture path.
    expect(report.steps[0]?.argv).not.toContain("-enableCodeCoverage");
    expect(report.env).toEqual([]);
    expect(report.artifacts.map((entry): string => entry.value)).toEqual([".nen/focused/apple.xcresult"]);
    expect(report.selection).toEqual({
      pointer: "project.verbs.apple.test.select",
      ids,
      pattern: APPLE_PATTERN,
      each: ["-only-testing:{id}"],
      appended: ids.map((id): string => `-only-testing:${id}`),
      results: { path: APPLE_RESULTS, format: "xcresult-summary" },
      executed: null,
      zeroMatch: null,
    });
  });

  it("the same, run for real: the seam takes exactly that argv and nothing else", async () => {
    const argv = [...APPLE_FOCUSED, "-only-testing:KroTests/A", "-only-testing:KroTests/B"];
    const result = await shu(appleProject(), ["test", "--select", "KroTests/A,KroTests/B"], [
      { match: ["xcodebuild", ...argv].join(" "), result: { code: 0, stdout: appleSummary(2) } },
    ]);
    expect(result.code).toBe(0);
    expect(result.seams.calls).toHaveLength(1);
    expect(result.seams.calls[0]?.command).toBe("xcodebuild");
    expect(result.seams.calls[0]?.args).toEqual(argv);
  });

  it("a vitest-shaped lane: identifiers appended as positionals; no capture sidecar is recorded", async () => {
    const focused = ["vitest", "run", "--reporter=junit"];
    const ids = ["src/shu/run.test.ts", "src/schema/contract.test.ts"];
    const result = await shu(vitestProject(), ["test", "--select", ids.join(",")], [
      { match: ["bunx", ...focused, ...ids].join(" "), result: { code: 0, stdout: junit(3) } },
    ]);
    expect(result.code).toBe(0);
    // THE REGRESSION ROW HERE DECLARES THE COVERAGE CAPTURE, so a bare `test`
    // would fingerprint the tree through git. A focused run must not: the only
    // call is the runner's own.
    expect(spawned(result.seams)).toEqual([["bunx", ...focused, ...ids].join(" ")]);
  });

  it("a multi-argument template expands each identifier into its own pair", async () => {
    const project = appleProject({
      exe: "gradlew-shaped",
      argv: ["test"],
      each: ["--tests", "{id}"],
      pattern: "[A-Za-z0-9_.*]+",
      results: { path: "build/focused-results", format: "junit" },
    });
    const result = await shu(project, ["test", "--select", "a.B,c.D", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("would run:     gradlew-shaped test --tests a.B --tests c.D");
    expect(result.out.some((line): boolean => line.startsWith("selection:") && line.includes("a.B, c.D"))).toBe(true);
  });

  it("a bare `test` is untouched: the regression row, its env, its artifacts, selection null", async () => {
    const result = await shu(appleProject(), ["test", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { steps: { argv: string[] }[]; env: string[]; selection: unknown };
    expect(report.steps[0]?.argv).toEqual(APPLE_REGRESSION);
    expect(report.env).toEqual(["REGRESSION_ONLY"]);
    expect(report.selection).toBeNull();
  });
});

// ── (b) refusals, every one at exit 2 and before anything spawns ───────────

describe("a selection nen cannot honour is refused at exit 2 with nothing spawned", () => {
  const malformed: readonly (readonly [string, string, RegExp])[] = [
    ["empty", "", /names no test identifier/],
    ["only whitespace", "  ", /names no test identifier/],
    ["an empty entry", "KroTests,,KroTests/B", /entry 2 is empty/],
    ["a trailing comma", "KroTests,", /entry 2 is empty/],
    ["whitespace inside", "Kro Tests", /whitespace, a control character/],
    ["a control character", "KroTests\u0007", /whitespace, a control character/],
    ["a leading dash", "-only-testing:KroTests", /begins with '-'/],
    ["a brace", "KroTests/{id}", /brace/],
    ["a repeat", "KroTests,KroTests", /repeats an identifier/],
    ["a zero-width format character", "Kro\u200bTests", /invisible format character/],
    ["a bidi override", "Kro\u202eTests", /invisible format character/],
    ...['"', "%", "^", "&", "|", "<", ">", "!", "`"].map(
      (char): readonly [string, string, RegExp] => [`the metacharacter ${char}`, `Kro${char}Tests`, /cmd\/batch metacharacter/],
    ),
  ];
  for (const [name, value, message] of malformed) {
    it(`refuses ${name}`, async () => {
      const result = await shu(appleProject(), ["test", `--select=${value}`]);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(message);
      expect(result.seams.calls).toEqual([]);
    });
  }

  it("refuses --select with no value at all (the parser's own refusal)", async () => {
    const result = await shu(appleProject(), ["test", "--select"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--select requires a value/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses an identifier the declared pattern does not match whole, naming it", async () => {
    const result = await shu(appleProject(), ["test", "--select", "KroTests/A,Kro.Tests,A/B/C/D"]);
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/'Kro\.Tests', 'A\/B\/C\/D'/);
    expect(err).toContain("project.verbs.apple.test.select.pattern");
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses a lane whose test row declares no select -- never the full regression instead", async () => {
    const result = await shu(appleProject(null), ["test", "--select", "KroTests"], [
      { match: ["xcodebuild", ...APPLE_REGRESSION].join(" "), result: { code: 0 } },
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/declares no focused selection.*never falls back/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses on --dry-run too, before any plan is printed", async () => {
    const result = await shu(appleProject(null), ["test", "--select", "KroTests", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
  });

  it("keeps the host rule: a darwin-only lane on linux is exit 3, nothing spawned", async () => {
    const result = await shu(appleProject(), ["test", "--select", "KroTests"], [], "linux");
    expect(result.code).toBe(3);
    expect(result.seams.calls).toEqual([]);
  });

  it("keeps preconditions: an unmet one is exit 2 with the focused plan reported, nothing spawned", async () => {
    const project = { ...appleProject(), preconditions: { apple: [{ kind: "path", value: "Pods" }] } };
    const result = await shu(project, ["test", "--select", "KroTests", "--json"]);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.out.join("\n")) as { steps: { argv: string[] }[] };
    expect(report.steps[0]?.argv.at(-1)).toBe("-only-testing:KroTests");
    expect(result.seams.calls).toEqual([]);
  });

  it("is refused on every verb but test, as a flag that verb does not read", async () => {
    const result = await shu(appleProject(), ["build", "--select", "KroTests"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--select is not read by 'shu build'/);
    expect(result.seams.calls).toEqual([]);
  });
});

// ── (c) the executed count -- zero is never a pass (the 2026-09-27 AC) ──────

describe("a focused run's declared results decide whether it executed anything", () => {
  const argv = [...APPLE_FOCUSED, "-only-testing:KroUITests/TimelineDraftUITests/test_fastSwipe"];
  const line = ["xcodebuild", ...argv].join(" ");
  const select = ["test", "--select", "KroUITests/TimelineDraftUITests/test_fastSwipe"];

  it("an xcodebuild-shaped run that exits 0 having executed 0 tests is exit 6, flagged in --json", async () => {
    const result = await shu(appleProject(), [...select, "--json"], [
      { match: line, result: { code: 0, stdout: appleSummary(0), stderr: "Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds" } },
    ]);
    expect(result.code).toBe(6);
    expect(result.err.join("\n")).toContain("selection resolved to zero executed tests");
    const report = JSON.parse(result.out.join("\n")) as {
      exitCode: number;
      selection: { executed: number; zeroMatch: boolean; results: { path: string; format: string } };
    };
    expect(report.exitCode).toBe(6);
    expect(report.selection.executed).toBe(0);
    expect(report.selection.zeroMatch).toBe(true);
    expect(report.selection.results).toEqual({ path: APPLE_RESULTS, format: "xcresult-summary" });
  });

  it("skipped tests are not executed ones: all-skipped is still zero, exit 6", async () => {
    const result = await shu(appleProject(), select, [{ match: line, result: { code: 0, stdout: appleSummary(0, 3) } }]);
    expect(result.code).toBe(6);
    expect(result.out.some((row): boolean => row.startsWith("results:") && row.includes("ZERO executed"))).toBe(true);
  });

  it("a non-zero count passes, with the count in --json", async () => {
    const result = await shu(appleProject(), [...select, "--json"], [{ match: line, result: { code: 0, stdout: appleSummary(1) } }]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { exitCode: number; selection: { executed: number; zeroMatch: boolean } };
    expect(report.exitCode).toBe(0);
    expect(report.selection.executed).toBe(1);
    expect(report.selection.zeroMatch).toBe(false);
  });

  it("a missing results file is exit 1, never a pass", async () => {
    const project = appleProject({
      exe: "xcodebuild",
      argv: APPLE_FOCUSED,
      each: ["-only-testing:{id}"],
      pattern: APPLE_PATTERN,
      results: { path: APPLE_RESULTS, format: "xcresult-summary" },
    });
    const result = await shu(project, [...select, "--json"], [{ match: line, result: { code: 0 } }]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/left no results at '\.nen\/focused\/summary\.json'/);
    const report = JSON.parse(result.out.join("\n")) as { exitCode: number; selection: { executed: unknown; zeroMatch: unknown } };
    expect(report.exitCode).toBe(1);
    expect(report.selection.executed).toBeNull();
    expect(report.selection.zeroMatch).toBeNull();
  });

  it("an unparseable results file is exit 1", async () => {
    const result = await shu(appleProject(), select, [{ match: line, result: { code: 0, stdout: "Executed 0 tests" } }]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not be read/);
  });

  it("results in a format other than the declared one are exit 1", async () => {
    const result = await shu(appleProject(), select, [{ match: line, result: { code: 0, stdout: junit(2) } }]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is junit, and the declaration says xcresult-summary/);
  });

  it("a stated total the passed/failed buckets do not cover still counts as executed (N12)", async () => {
    const summary = JSON.stringify({ totalTestCount: 5, passedTests: 0, failedTests: 0, skippedTests: 0 });
    const result = await shu(appleProject(), [...select, "--json"], [{ match: line, result: { code: 0, stdout: summary } }]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out.join("\n")) as { selection: { executed: number } }).selection.executed).toBe(5);
  });

  it("a red run keeps the tool's exit 1 and reads nothing", async () => {
    const result = await shu(appleProject(), [...select, "--json"], [{ match: line, result: { code: 65, stdout: appleSummary(0) } }]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as { selection: { executed: unknown } };
    expect(report.selection.executed).toBeNull();
  });
});

// ── (d) the declared results path is cleared before every focused run (N10) ─

describe("the results path is this run's alone", () => {
  const ids = ["src/a.test.ts"];
  const focusedLine = ["runner", "focused", ...ids].join(" ");

  /** A junit-DIRECTORY lane whose runner's stdout lands at `stdoutTo`, inside it. */
  function directoryProject(stdoutTo: string, resultsPath = ".nen/fj"): Record<string, unknown> {
    return {
      lanes: { web: { stack: "s", cwd: "." } },
      defaultLane: "web",
      verbs: {
        web: {
          test: {
            exe: "runner",
            argv: ["all"],
            artifacts: ["coverage"],
            select: {
              exe: "runner",
              argv: ["focused"],
              each: ["{id}"],
              pattern: "src/[a-z]+\\.test\\.ts",
              stdoutTo,
              results: { path: resultsPath, format: "junit" },
            },
          },
        },
      },
    };
  }

  const seedOld = (root: string): void => {
    mkdirSync(join(root, ".nen", "fj"), { recursive: true });
    writeFileSync(join(root, ".nen", "fj", "old.xml"), junit(3));
  };

  it("an earlier run's file in a results DIRECTORY is not counted: a zero-test run is exit 6", async () => {
    const result = await shu(
      directoryProject(".nen/fj/new.xml"),
      ["test", "--select", ids.join(","), "--json"],
      [{ match: focusedLine, result: { code: 0, stdout: junit(0) } }],
      "darwin",
      seedOld,
      (root): void => {
        expect(existsSync(join(root, ".nen", "fj", "old.xml"))).toBe(false);
        expect(existsSync(join(root, ".nen", "fj", "new.xml"))).toBe(true);
      },
    );
    expect(result.code).toBe(6);
    expect((JSON.parse(result.out.join("\n")) as { selection: { executed: number } }).selection.executed).toBe(0);
  });

  it("a run that writes only a NESTED file is counted as exactly that file", async () => {
    const result = await shu(
      directoryProject(".nen/fj/sub/new.xml"),
      ["test", "--select", ids.join(","), "--json"],
      [{ match: focusedLine, result: { code: 0, stdout: junit(2) } }],
      "darwin",
      seedOld,
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out.join("\n")) as { selection: { executed: number } }).selection.executed).toBe(2);
  });

  it("a results path that is a symlink is refused at exit 2: nothing removed, nothing run", async () => {
    const result = await shu(
      directoryProject(".nen/out.xml"),
      ["test", "--select", ids.join(",")],
      [{ match: focusedLine, result: { code: 0, stdout: junit(1) } }],
      "darwin",
      (root): void => {
        mkdirSync(join(root, ".nen", "real"), { recursive: true });
        writeFileSync(join(root, ".nen", "real", "keep.xml"), junit(1));
        symlinkSync(join(root, ".nen", "real"), join(root, ".nen", "fj"), "dir");
      },
      (root): void => {
        expect(existsSync(join(root, ".nen", "real", "keep.xml"))).toBe(true);
      },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is a symlink/);
    expect(result.seams.calls).toEqual([]);
  });

  it("a results path whose REAL path lands on a regression output is refused at exit 2, nothing removed", async () => {
    const result = await shu(
      directoryProject("focused/new.xml", "focused/new.xml"),
      ["test", "--select", ids.join(",")],
      [{ match: focusedLine, result: { code: 0, stdout: junit(1) } }],
      "darwin",
      (root): void => {
        mkdirSync(join(root, "coverage"), { recursive: true });
        writeFileSync(join(root, "coverage", "new.xml"), "the regression's own");
        symlinkSync(join(root, "coverage"), join(root, "focused"), "dir");
      },
      (root): void => {
        expect(existsSync(join(root, "coverage", "new.xml"))).toBe(true);
      },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/overlapping 'coverage'/);
    expect(result.seams.calls).toEqual([]);
  });

  it("a dry run removes nothing", async () => {
    const result = await shu(
      directoryProject(".nen/fj/new.xml"),
      ["test", "--select", ids.join(","), "--dry-run"],
      [],
      "darwin",
      seedOld,
      (root): void => {
        expect(existsSync(join(root, ".nen", "fj", "old.xml"))).toBe(true);
      },
    );
    expect(result.code).toBe(0);
    expect(result.seams.calls).toEqual([]);
  });
});

describe("parseSelectionIds", () => {
  it("keeps the caller's order and spelling exactly", () => {
    expect(parseSelectionIds("b,a,KroTests/X/testY")).toEqual(["b", "a", "KroTests/X/testY"]);
  });

  it("names every malformed entry in one refusal", () => {
    expect(() => parseSelectionIds("a,,-b,a")).toThrow(/entry 2 is empty; entry 3 '-b' begins with '-'.*; entry 4 'a' repeats/);
  });
});

// ── (c) the declaration, refused at load by pointer ────────────────────────

function load(select: unknown, verb = "test", extra: Record<string, unknown> = {}): unknown {
  return parseProjectBlock("contract.json", {
    lanes: { only: { stack: "s", cwd: "." } },
    verbs: { only: { [verb]: { exe: "runner", argv: ["all"], ...extra, select }, ...(verb === "test" ? {} : { test: { exe: "runner", argv: ["all"] } }) } },
  });
}

const GOOD = {
  exe: "runner",
  argv: ["some"],
  each: ["--only={id}"],
  pattern: "[a-z]+",
  results: { path: "focused/results.xml", format: "junit" },
};

describe("project.verbs.<lane>.test.select -- the schema", () => {
  it("loads a well-formed block onto the test row", () => {
    const project = load(GOOD) as { verbs: { only: { test: { select?: { each: string[] } } } } };
    expect(project.verbs.only.test.select?.each).toEqual(["--only={id}"]);
  });

  const refusals: readonly (readonly [string, () => unknown, string, RegExp])[] = [
    ["on a verb other than test", (): unknown => load(GOOD, "build"), "project.verbs.only.build.select", /on 'test' only/],
    ["on a test seat", (): unknown => parseProjectBlock("c", { lanes: { only: { stack: "s", cwd: "." } }, verbs: { only: { test: { unsupported: "none", select: GOOD } } } }), "project.verbs.only.test.select", /seat/],
    ["a near-miss of its name", (): unknown => load(undefined, "test", { selct: GOOD }), "project.verbs.only.test.selct", /one letter away from 'select'/],
    ["an each with no {id}", (): unknown => load({ ...GOOD, each: ["--all"] }), "project.verbs.only.test.select.each", /names no \{id\}/],
    ["{id} in the base argv", (): unknown => load({ ...GOOD, argv: ["{id}"] }), "project.verbs.only.test.select.argv", /in 'each' only/],
    ["a string argv", (): unknown => load({ ...GOOD, argv: "some thing" }), "project.verbs.only.test.select.argv", /argv ARRAY/],
    ["a missing pattern", (): unknown => load({ ...GOOD, pattern: undefined }), "project.verbs.only.test.select.pattern", /non-empty string/],
    ["a catastrophic pattern", (): unknown => load({ ...GOOD, pattern: "(a+)+" }), "project.verbs.only.test.select.pattern", /exponential/],
    ["an uncompilable pattern", (): unknown => load({ ...GOOD, pattern: "[a-" }), "project.verbs.only.test.select.pattern", /nen can compile/],
    ["a stall guard", (): unknown => load({ ...GOOD, stall: { elapsedMs: 1, quietMs: 1, onStall: { exe: "x", argv: ["y"] } } }), "project.verbs.only.test.select.stall", /untimed/],
    ["a near-miss key inside", (): unknown => load({ ...GOOD, eachs: ["x"] }), "project.verbs.only.test.select.eachs", /'each'/],
    ["a stdoutTo outside the tree", (): unknown => load({ ...GOOD, stdoutTo: "../out.txt" }), "project.verbs.only.test.select.stdoutTo", /\.\./],
    ["an artifact on the regression row's own output", (): unknown => load({ ...GOOD, artifacts: ["out/./results.xml"] }, "test", { artifacts: ["out/results.xml"] }), "project.verbs.only.test.select.artifacts[0]", /overlaps 'out\/results\.xml'/],
    ["a stdoutTo inside the regression's output directory", (): unknown => load({ ...GOOD, stdoutTo: "coverage/focused.txt" }, "test", { artifacts: ["coverage"] }), "project.verbs.only.test.select.stdoutTo", /overlaps 'coverage'/],
    ["a select with no results", (): unknown => load({ ...GOOD, results: undefined }), "project.verbs.only.test.select.results", /is required/],
    ["a results format nen does not read", (): unknown => load({ ...GOOD, results: { path: "r.xml", format: "tap" } }), "project.verbs.only.test.select.results.format", /CLOSED set: junit, assertion-results, xcresult-summary/],
    ["a results path outside the tree", (): unknown => load({ ...GOOD, results: { path: "../r.xml", format: "junit" } }), "project.verbs.only.test.select.results.path", /\.\./],
    ["a results path on the regression output", (): unknown => load({ ...GOOD, results: { path: "Out/Results.XML", format: "junit" } }, "test", { artifacts: ["out/results.xml"] }), "project.verbs.only.test.select.results.path", /overlaps 'out\/results\.xml'/],
    ["a near-miss key inside results", (): unknown => load({ ...GOOD, results: { path: "r.xml", format: "junit", formats: "x" } }), "project.verbs.only.test.select.results.formats", /'format'/],
    ["a pattern that only compiles inside the anchors (N2)", (): unknown => load({ ...GOOD, pattern: "a)|(?:.*" }), "project.verbs.only.test.select.pattern", /on its own/],
    ["an argv element naming the regression output (N3)", (): unknown => load({ ...GOOD, argv: ["run", "--outputFile.junit=./out/results.xml"] }, "test", { artifacts: ["out/results.xml"] }), "project.verbs.only.test.select.argv[1]", /names 'out\/results\.xml'/],
    ["an each element writing into the coverage directory (N3)", (): unknown => load({ ...GOOD, each: ["--only={id}", "-report:Coverage/focused.info"] }, "test", { artifacts: ["coverage"] }), "project.verbs.only.test.select.each[1]", /names 'coverage'/],
    ["an artifact that only normalises onto the regression output (N4)", (): unknown => load({ ...GOOD, artifacts: ["out/x/../results.xml"] }, "test", { artifacts: ["out/results.xml"] }), "project.verbs.only.test.select.artifacts[0]", /overlaps 'out\/results\.xml'/],
    ["an artifact that climbs out after normalising (N4)", (): unknown => load({ ...GOOD, artifacts: ["out/../../x.xml"] }), "project.verbs.only.test.select.artifacts[0]", /outside the repository/],
    ["an artifact differing only in case (N4)", (): unknown => load({ ...GOOD, artifacts: ["OUT/RESULTS.xml"] }, "test", { artifacts: ["out/results.xml"] }), "project.verbs.only.test.select.artifacts[0]", /overlaps/],
    ["an artifact under the capture sidecar directory", (): unknown => load({ ...GOOD, artifacts: [".nen/coverage-capture/x.json"] }), "project.verbs.only.test.select.artifacts[0]", /overlaps '\.nen\/coverage-capture'/],
  ];
  for (const [name, attempt, pointer, message] of refusals) {
    it(`refuses ${name}, by pointer`, () => {
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SchemaError);
      expect((caught as SchemaError).message).toContain(pointer);
      expect((caught as SchemaError).message).toMatch(message);
    });
  }

  it("refuses an output another LANE's regression writes (N4)", () => {
    expect(() =>
      parseProjectBlock("c", {
        lanes: { a: { stack: "s", cwd: "." }, b: { stack: "s", cwd: "." } },
        verbs: {
          a: { test: { exe: "r", argv: ["a"], select: { ...GOOD, results: { path: "b/report.xml", format: "junit" } } } },
          b: { coverage: { exe: "r", argv: ["c"], artifacts: ["b/report.xml"] } },
        },
      }),
    ).toThrow(/project\.verbs\.a\.test\.select\.results\.path.*overlaps 'b\/report\.xml'/);
  });

  it("loads --reporter=junit beside a regression artifact named junit (N11)", () => {
    expect(() => load({ ...GOOD, argv: ["run", "--reporter=junit"] }, "test", { artifacts: ["junit"] })).not.toThrow();
  });

  it("loads a bare test action beside a regression artifact named test (N11)", () => {
    expect(() => load({ ...GOOD, argv: ["-scheme", "Kro", "test"] }, "test", { artifacts: ["test"] })).not.toThrow();
  });

  it("still refuses a path-shaped token naming a single-segment output (N11)", () => {
    expect(() => load({ ...GOOD, argv: ["run", "--out=junit/"] }, "test", { artifacts: ["junit"] })).toThrow(/names 'junit'/);
  });

  it("does not read a bare word in argv as a path (--coverage is not the coverage directory)", () => {
    expect(() => load({ ...GOOD, argv: ["run", "--coverage", "--no-coverage=false"] }, "test", { artifacts: ["coverage"] })).not.toThrow();
  });

  it("the results formats are exactly test-report's", () => {
    expect([...SELECT_RESULT_FORMATS]).toEqual(FORMATS.map((format): string => format.id));
  });

  it("nen's own declared pattern refuses a climbing path and keeps nested files (N8)", () => {
    const contract = loadContract(fileURLToPath(new URL("../..", import.meta.url)));
    const select = contract.project?.verbs["nen"]?.["test"];
    const pattern = select !== undefined && select.kind !== "unsupported" ? select.select?.pattern : undefined;
    expect(pattern).toBeDefined();
    const own = new RegExp(`^(?:${pattern ?? ""})$`);
    expect(own.test("src/shu/select.test.ts")).toBe(true);
    expect(own.test("src/a/b/c.test.ts")).toBe(true);
    expect(own.test("src/../etc/x.test.ts")).toBe(false);
    expect(own.test("src/a/../b.test.ts")).toBe(false);
  });

  it("refuses an artifact that overlaps the lane's coverage row output", () => {
    expect(() =>
      parseProjectBlock("c", {
        lanes: { only: { stack: "s", cwd: "." } },
        verbs: {
          only: {
            test: { exe: "r", argv: ["a"], select: { ...GOOD, artifacts: ["coverage/lcov.info"] } },
            coverage: { exe: "r", argv: ["c"], artifacts: ["coverage/lcov.info"] },
          },
        },
      }),
    ).toThrow(/project\.verbs\.only\.test\.select\.artifacts\[0\].*overlaps 'coverage\/lcov\.info'/);
  });
});
