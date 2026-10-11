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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { parseProjectBlock } from "../schema/contract.js";
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
): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "nen-shu-select-"));
  try {
    mkdirSync(join(dir, "nen"));
    writeFileSync(join(dir, "nen", "contract.json"), JSON.stringify({ $schema: "nen.contract/v0.1", project }));
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams(script, {
      env: {},
      platform,
      now: (): Date => new Date(Date.UTC(2026, 0, 1)),
    });
    const code = await runFamily(shuCommand, ["shu", ...argv], dir, false, io, seams);
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
            argv: ["vitest", "run", "--reporter=junit", "--outputFile.junit=.nen/focused.junit.xml"],
            each: ["{id}"],
            pattern: "src/[A-Za-z0-9_./-]+\\.test\\.ts",
            artifacts: [".nen/focused.junit.xml"],
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
    });
  });

  it("the same, run for real: the seam takes exactly that argv and nothing else", async () => {
    const argv = [...APPLE_FOCUSED, "-only-testing:KroTests/A", "-only-testing:KroTests/B"];
    const result = await shu(appleProject(), ["test", "--select", "KroTests/A,KroTests/B"], [
      { match: ["xcodebuild", ...argv].join(" "), result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.seams.calls).toHaveLength(1);
    expect(result.seams.calls[0]?.command).toBe("xcodebuild");
    expect(result.seams.calls[0]?.args).toEqual(argv);
  });

  it("a vitest-shaped lane: identifiers appended as positionals; no capture sidecar is recorded", async () => {
    const focused = ["vitest", "run", "--reporter=junit", "--outputFile.junit=.nen/focused.junit.xml"];
    const ids = ["src/shu/run.test.ts", "src/schema/contract.test.ts"];
    const result = await shu(vitestProject(), ["test", "--select", ids.join(",")], [
      { match: ["bunx", ...focused, ...ids].join(" "), result: { code: 0 } },
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
    ["whitespace inside", "Kro Tests", /whitespace or a control character/],
    ["a control character", "KroTests\u0007", /whitespace or a control character/],
    ["a leading dash", "-only-testing:KroTests", /begins with '-'/],
    ["a brace", "KroTests/{id}", /brace/],
    ["a repeat", "KroTests,KroTests", /repeats an identifier/],
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

const GOOD = { exe: "runner", argv: ["some"], each: ["--only={id}"], pattern: "[a-z]+" };

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
