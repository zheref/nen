// src/shu/run.test.ts -- the executor, driven through the REAL dispatch
// (../index.ts's runFamily) so the two-stage flag re-parse, the --repo/--json
// merge and the error-to-exit-code mapping are the ones a caller gets, not a
// hand-copy of them.
//
// NO LIVE TOOLCHAIN ANYWHERE IN HERE. Every subprocess is a ScriptedSeams entry,
// which throws on a call nobody scripted -- so "the executor spawned something
// unexpected" is a failure rather than a silent pass. The platform is injected
// too, which is what makes the darwin-only refusal provable on the linux CI lane
// and the win32 one.

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { SHU_REPO } from "../schema/fixtures/paths.js";
import { shuCommand } from "./command.js";
import { INTERACTIVE_VERBS } from "./run.js";

const TOKEN = "PLACEHOLDER_LANE_TOKEN";
/** The one value the fixture declares for a child's environment. */
const DECLARED_ENV_VALUE = "4173";

interface Options {
  readonly script?: readonly ScriptedCall[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly repo?: string;
  /** A clock that advances a second per read, for the duration assertions. */
  readonly ticking?: boolean;
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
  let tick = 0;
  const seams = new ScriptedSeams(options.script ?? [], {
    env: options.env ?? { [TOKEN]: "a value no output may carry" },
    platform: options.platform ?? "linux",
    now: (): Date =>
      new Date(Date.UTC(2026, 0, 1) + (options.ticking === true ? (tick += 1) * 1000 : 0)),
  });
  const code = await runFamily(shuCommand, ["shu", ...argv], options.repo ?? SHU_REPO, false, io, seams);
  return { code, out, err, seams };
}

function ok(match: string): ScriptedCall {
  return { match, result: { code: 0 } };
}

/**
 * Run a verb against a declaration written into a temporary repository.
 *
 * SOME REFUSALS NEED A DECLARATION NOBODY SHOULD HAVE TO READ TWICE. A lane
 * whose `cwd` escapes the repository, a precondition path pointing at
 * `/etc/passwd`, a `path` stated as a LIST -- each is one sentence of JSON that
 * exists to be refused, and putting them in the shared fixture would make every
 * reader of that file wonder which lane was the real one.
 */
async function withDeclaration(
  project: unknown,
  argv: readonly string[],
  options: Options = {},
): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "nen-shu-decl-"));
  try {
    mkdirSync(join(dir, "nen"));
    writeFileSync(
      join(dir, "nen", "contract.json"),
      JSON.stringify({ $schema: "nen.contract/v0.1", project }),
    );
    return await capture(argv, { ...options, repo: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A one-lane project block with one `build`, for the declarations above. */
function oneLane(
  overrides: Readonly<Record<string, unknown>> = {},
  build: unknown = { exe: "placeholder-tool", argv: ["go"] },
): Readonly<Record<string, unknown>> {
  return {
    lanes: { only: { stack: "placeholder-stack", cwd: "." } },
    defaultLane: "only",
    verbs: { only: { build } },
    ...overrides,
  };
}

/** Every argv `--dry-run` printed, in order. */
function wouldRun(out: readonly string[]): readonly string[] {
  return out
    .filter((line): boolean => line.startsWith("would run:"))
    .map((line): string => line.slice("would run:".length).trim());
}

/** Every argv the seam actually took, in order. */
function spawned(seams: ScriptedSeams): readonly string[] {
  return seams.calls.map((call): string => [call.command, ...call.args].join(" "));
}

// ── (a) argv goldens, one per verb the nextjs lane declares ─────────────────
//
// The pairs below ARE the contract: a declaration's argv reaches the seam
// unchanged, token for token, including the multi-step verbs' order.

const NEXTJS_GOLDENS: Readonly<Record<string, readonly string[]>> = {
  build: ["pnpm turbo run build"],
  test: ["pnpm exec vitest run"],
  "ui-test": [
    "pnpm --filter @placeholder/web exec playwright install --with-deps chromium",
    "pnpm --filter @placeholder/web run test:e2e",
  ],
  lint: ["pnpm exec biome check .", "pnpm turbo run lint"],
  coverage: [
    "pnpm --filter @placeholder/core test:coverage",
    "pnpm --filter @placeholder/app test:coverage",
  ],
  dev: ["pnpm exec next dev"],
  run: ["pnpm exec next start"],
};

/**
 * The one verb that RUNS like every other and then does one more thing.
 *
 * `nen shu coverage` goes through this executor unchanged -- same refusals,
 * same order, same spawned argv, same `--dry-run` -- and then parses the report
 * the run produced (../shu/coverage.ts). Two consequences show up below, and
 * both are stated rather than skipped, because the half this file is about is
 * IDENTICAL for it: the argv goldens and the dry-run parity hold verbatim.
 *
 *   1. its exit code after a successful run is the PARSE's. This fixture's
 *      coverage row declares no `artifacts`, so there is no report to read and
 *      the answer is 1 naming the field to declare -- ./coverage.test.ts pins
 *      that from both sides, on a fixture that does declare one.
 *   2. its `--json` document is its own contract (`{contract, lane, stack,
 *      total, targets, threshold, report, exitCode}`), not this one, so there
 *      are no `steps` in it to compare. The executor's report is rendered to
 *      STDERR in that mode instead, which is where the argv still is.
 */
const PARSES_A_REPORT: readonly string[] = ["coverage"];

describe("nen shu -- argv goldens for every verb the nextjs lane declares", () => {
  for (const [verb, argvs] of Object.entries(NEXTJS_GOLDENS)) {
    it(`renders '${verb}' exactly as the declaration states it`, async () => {
      const result = await capture([verb, "--dry-run"]);
      expect(result.code).toBe(0);
      expect(wouldRun(result.out)).toEqual(argvs);
      // A dry run spawns NOTHING. ScriptedSeams throws on an unscripted call,
      // so an empty script is itself half the assertion; the other half is that
      // the call list is empty rather than merely un-thrown.
      expect(result.seams.calls).toEqual([]);
    });

    it(`spawns '${verb}' exactly as the dry run printed it`, async () => {
      const result = await capture([verb], { script: argvs.map(ok) });
      // The tool exited 0 in every case; `coverage` then answers for its
      // second step, which this fixture gives it no report for (see
      // `PARSES_A_REPORT`). What this assertion is about -- the argv -- is the
      // line below, and it is the same line for all seven verbs.
      expect(result.code).toBe(PARSES_A_REPORT.includes(verb) ? 1 : 0);
      expect(spawned(result.seams)).toEqual(argvs);
    });
  }
});

describe("--dry-run parity -- the thing you approve is the thing that runs", () => {
  for (const verb of Object.keys(NEXTJS_GOLDENS)) {
    it(`'${verb}': every 'would run:' line equals the argv the seam takes`, async () => {
      const dry = await capture([verb, "--dry-run"]);
      const wet = await capture([verb], { script: NEXTJS_GOLDENS[verb]?.map(ok) ?? [] });
      expect(wouldRun(dry.out)).toEqual(spawned(wet.seams));
    });

    // The two long-running verbs are absent from THIS half and only this half:
    // `--json` without `--dry-run` is refused for them (stdout belongs to the
    // child), so there is no second document to compare against. Their argv
    // parity is proved by the text assertion above, over the same two runs.
    if (INTERACTIVE_VERBS.includes(verb)) continue;
    // And `coverage`, whose --json document is a different contract with no
    // `steps` in it at all. Its argv parity is proved by the text assertion
    // directly above, over the same two runs -- the same way the two
    // long-running verbs' is.
    if (PARSES_A_REPORT.includes(verb)) continue;

    it(`'${verb}': --json's steps are byte-identical between the two modes`, async () => {
      const dry = JSON.parse((await capture([verb, "--dry-run", "--json"])).out.join("\n")) as {
        steps: readonly { exe: string; argv: readonly string[]; cwd: string }[];
      };
      const wet = JSON.parse(
        (await capture([verb, "--json"], { script: NEXTJS_GOLDENS[verb]?.map(ok) ?? [] })).out.join("\n"),
      ) as { steps: readonly { exe: string; argv: readonly string[]; cwd: string }[] };
      expect(dry.steps.map((step): unknown => ({ exe: step.exe, argv: step.argv, cwd: step.cwd }))).toEqual(
        wet.steps.map((step): unknown => ({ exe: step.exe, argv: step.argv, cwd: step.cwd })),
      );
    });
  }

  it("quotes an argv element containing whitespace, and keeps it ONE element", async () => {
    const result = await capture(["build", "--lane", "native", "--dry-run"], {
      env: { [TOKEN]: "x" },
    });
    expect(wouldRun(result.out)).toEqual([
      "placeholder-build-tool -workspace Placeholder.xcworkspace -scheme 'Placeholder App' build",
    ]);
    // And the element is UNDIVIDED in the machine-readable half, which is what
    // the quotes in the human half exist to warn a reader about: re-splitting
    // that line on spaces produces a different command.
    const json = JSON.parse(
      (await capture(["build", "--lane", "native", "--dry-run", "--json"], { env: { [TOKEN]: "x" } })).out.join(
        "\n",
      ),
    ) as { steps: readonly { argv: readonly string[] }[] };
    expect(json.steps[0]?.argv).toEqual([
      "-workspace",
      "Placeholder.xcworkspace",
      "-scheme",
      "Placeholder App",
      "build",
    ]);
  });
});

// ── (a2) the destination, through all THREE renderings ─────────────────────
//
// THE RISK THIS PR'S ISSUE NAMES BY HAND. A simulator destination is one argv
// element carrying spaces AND commas -- `platform=iOS Simulator,name=iPhone 17
// Pro,OS=26.5` -- and every layer between a declaration and a subprocess is a
// place it can be split: the human line (where quoting is the only thing that
// says where the boundary is), the machine-readable report (which a Windows
// shell may read back), and the seam itself. Two of the three agreeing proves
// nothing about the third, so all three are pinned on ONE row.
//
// IT IS HAND-DECLARED, and that is not a shortcut. `nen shu detect` answers
// neither destination token on any tree -- a destination names a simulator on
// the machine, and detect reads a working tree -- so a golden driven off a
// proposal could never carry this value. The declaration below is exactly what
// a maintainer writes after reading the proposal's note.
describe("one argv element, from the declaration to the seam", () => {
  const DESTINATION = "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5";
  const ARGV: readonly string[] = [
    "-project",
    "Placeholder.xcodeproj",
    "-scheme",
    "Placeholder",
    "-destination",
    DESTINATION,
    "-configuration",
    "Debug",
    "build",
  ];
  const project = oneLane({ hosts: { "*": ["darwin"] } }, { exe: "xcodebuild", argv: ARGV });
  const LINE = `xcodebuild -project Placeholder.xcodeproj -scheme Placeholder -destination '${DESTINATION}' -configuration Debug build`;

  it("prints it as ONE quoted word in the dry run's own line", async () => {
    const result = await withDeclaration(project, ["build", "--dry-run"], { platform: "darwin" });
    expect(result.code).toBe(0);
    expect(wouldRun(result.out)).toEqual([LINE]);
    // The quotes are the information: the same line without them re-splits into
    // three arguments, and that is a different command.
    expect(result.out.join("\n")).toContain(`'${DESTINATION}'`);
  });

  it("carries it undivided in --json, in both modes, byte for byte", async () => {
    const dry = JSON.parse(
      (await withDeclaration(project, ["build", "--dry-run", "--json"], { platform: "darwin" })).out.join(
        "\n",
      ),
    ) as { steps: readonly { argv: readonly string[] }[] };
    expect(dry.steps[0]?.argv).toEqual(ARGV);
    expect(dry.steps[0]?.argv).toHaveLength(9);
    const wet = JSON.parse(
      (
        await withDeclaration(project, ["build", "--json"], {
          platform: "darwin",
          script: [ok(["xcodebuild", ...ARGV].join(" "))],
        })
      ).out.join("\n"),
    ) as { steps: readonly { argv: readonly string[] }[] };
    expect(wet.steps[0]?.argv).toEqual(dry.steps[0]?.argv);
  });

  it("hands it to the seam as one element, with no shell anywhere in between", async () => {
    const result = await withDeclaration(project, ["build"], {
      platform: "darwin",
      script: [ok(["xcodebuild", ...ARGV].join(" "))],
    });
    expect(result.code).toBe(0);
    expect(result.seams.calls).toHaveLength(1);
    expect(result.seams.calls[0]?.command).toBe("xcodebuild");
    expect(result.seams.calls[0]?.args).toEqual(ARGV);
    // The element the seam took is the declaration's own bytes -- no quoting
    // was added on the way in, which is the other half of the human line's
    // quoting being a RENDERING and not an escape.
    expect(result.seams.calls[0]?.args[5]).toBe(DESTINATION);
  });

  // A VALUE MAY CARRY THE QUOTE THE RENDERING USES. A simulator a developer
  // renamed carries an apostrophe, and a line that wrapped it in single quotes
  // and stopped there is one a reader cannot paste: the shell ends the quoted
  // word at the apostrophe and the rest of the destination becomes three more
  // arguments. So the rendering closes, escapes and reopens -- `'\''`, which is
  // the shell's own idiom -- and the SEAM still takes the plain bytes.
  //
  // MUTANT: drop the `.replace(/'/g, "'\\''")` from `renderArgv` and this goes
  // red on the printed line while every other assertion in this file stays
  // green, because nothing else in the suite renders a value with a quote in it.
  it("closes, escapes and reopens a single quote inside a value", async () => {
    const named = "platform=iOS Simulator,name=Sergio's iPhone,OS=26.5";
    const argv = ARGV.map((word): string => (word === DESTINATION ? named : word));
    const renamed = oneLane({ hosts: { "*": ["darwin"] } }, { exe: "xcodebuild", argv });
    const result = await withDeclaration(renamed, ["build", "--dry-run"], { platform: "darwin" });
    expect(result.code).toBe(0);
    expect(wouldRun(result.out)).toEqual([
      "xcodebuild -project Placeholder.xcodeproj -scheme Placeholder -destination 'platform=iOS Simulator,name=Sergio'\\''s iPhone,OS=26.5' -configuration Debug build",
    ]);
    const ran = await withDeclaration(renamed, ["build"], {
      platform: "darwin",
      script: [ok(["xcodebuild", ...argv].join(" "))],
    });
    expect(ran.code).toBe(0);
    expect(ran.seams.calls[0]?.args[5], "the seam takes the apostrophe itself").toBe(named);
  });
});

// ── (b) the report's shape ─────────────────────────────────────────────────

describe("--json -- the pinned key order", () => {
  it("carries exactly these keys, in this order", async () => {
    const result = await capture(["build", "--dry-run", "--json"]);
    expect(Object.keys(JSON.parse(result.out.join("\n")) as object)).toEqual([
      "contract",
      "lane",
      "stack",
      "verb",
      "steps",
      "cwd",
      "env",
      "host",
      "preconditions",
      "exitCode",
      "durationMs",
      "artifacts",
      "log",
    ]);
  });

  it("names the verb's own versioned contract", async () => {
    for (const verb of ["build", "test", "lint"]) {
      const result = await capture([verb, "--dry-run", "--json"]);
      expect((JSON.parse(result.out.join("\n")) as { contract: string }).contract).toBe(
        `nen.shu.${verb}/v0.1`,
      );
    }
  });

  it("pins a step's own key order too", async () => {
    const result = await capture(["build", "--json"], { script: [ok("pnpm turbo run build")] });
    const report = JSON.parse(result.out.join("\n")) as { steps: readonly object[] };
    expect(Object.keys(report.steps[0] ?? {})).toEqual(["exe", "argv", "cwd", "exitCode", "durationMs"]);
  });

  it("reports the TOOL's own exit code in the step, and nen's separately", async () => {
    const result = await capture(["build", "--json"], {
      script: [{ match: "pnpm turbo run build", result: { code: 17 } }],
    });
    const report = JSON.parse(result.out.join("\n")) as {
      steps: readonly { exitCode: number }[];
      exitCode: number;
    };
    expect(report.steps[0]?.exitCode).toBe(17);
    expect(report.exitCode).toBe(1);
    expect(result.code).toBe(1);
  });

  it("tells a dry run from a real one by steps[].exitCode, without a second flag", async () => {
    const dry = JSON.parse((await capture(["build", "--dry-run", "--json"])).out.join("\n")) as {
      steps: readonly { exitCode: number | null }[];
      log: { mode: string };
    };
    expect(dry.steps[0]?.exitCode).toBeNull();
    expect(dry.log.mode).toBe("dry-run");
    const wet = JSON.parse(
      (await capture(["build", "--json"], { script: [ok("pnpm turbo run build")] })).out.join("\n"),
    ) as { steps: readonly { exitCode: number | null }[]; log: { mode: string } };
    expect(wet.steps[0]?.exitCode).toBe(0);
    expect(wet.log.mode).toBe("streamed");
  });

  it("measures durations from the seam's clock, never from Date.now()", async () => {
    const result = await capture(["build", "--json"], {
      script: [ok("pnpm turbo run build")],
      ticking: true,
    });
    const report = JSON.parse(result.out.join("\n")) as {
      durationMs: number;
      steps: readonly { durationMs: number }[];
    };
    expect(report.steps[0]?.durationMs).toBe(1000);
    expect(report.durationMs).toBeGreaterThan(0);
  });

  it("declares artifacts the declaration names, and nothing when it names none", async () => {
    const withOne = JSON.parse((await capture(["build", "--dry-run", "--json"])).out.join("\n")) as {
      artifacts: readonly { kind: string; value: string; exists: boolean }[];
    };
    expect(withOne.artifacts).toEqual([
      { kind: "path", value: "packages/app/.output", exists: false },
    ]);
    const withNone = JSON.parse((await capture(["test", "--dry-run", "--json"])).out.join("\n")) as {
      artifacts: readonly unknown[];
    };
    expect(withNone.artifacts).toEqual([]);
  });
});

// ── (c) preconditions: asserted, never performed ───────────────────────────

describe("preconditions -- asserted and never performed", () => {
  it("reports a satisfied path and a satisfied env, and runs", async () => {
    const result = await capture(["build", "--dry-run", "--json"]);
    const report = JSON.parse(result.out.join("\n")) as {
      preconditions: readonly { kind: string; value: string; satisfied: boolean | null }[];
    };
    expect(report.preconditions).toEqual([
      { kind: "path", value: "deps", satisfied: true },
      { kind: "env", value: TOKEN, satisfied: true },
    ]);
    expect(Object.keys(report.preconditions[0] ?? {})).toEqual(["kind", "value", "satisfied"]);
  });

  it("refuses at exit 2 when a declared path is not there, and spawns nothing", async () => {
    const result = await capture(["build", "--lane", "native"]);
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    expect(result.err.join("\n")).toMatch(/not satisfied/);
    // The kind column is as wide as the widest kind in THIS report -- `native`
    // declares a `command` precondition too, so `path` pads to seven.
    expect(result.out.join("\n")).toMatch(/FAIL {2}path {4}native\/deps -- not present/);
  });

  it("refuses at exit 2 when a declared env variable is not set", async () => {
    const result = await capture(["build"], { env: {} });
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    // `web` declares only `path` and `env`, so the column is four wide.
    expect(result.out.join("\n")).toMatch(new RegExp(`FAIL {2}env {2}${TOKEN}`));
  });

  it("reports a kind it CANNOT assert as such, and refuses -- never as a pass", async () => {
    const result = await capture(["build", "--lane", "native", "--json"]);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.out.join("\n")) as {
      preconditions: readonly { kind: string; satisfied: boolean | null }[];
    };
    expect(report.preconditions).toContainEqual({
      kind: "command",
      value: ["placeholder-probe", "--version"],
      satisfied: null,
    });
    expect(result.err.join("\n")).toMatch(/1 nen cannot assert/);
  });

  it("never PERFORMS a precondition -- the probe argv reaches no seam", async () => {
    const result = await capture(["build", "--lane", "native"]);
    expect(spawned(result.seams)).toEqual([]);
  });

  it("cannot assert an ASSERTABLE kind whose value is a list, and says which", async () => {
    // `path` is a kind nen can check; `["a", "b"]` is not a path. Reading the
    // first element, or the join of them, would be nen guessing which one the
    // declaration meant -- so the row is `satisfied: null` like any other kind
    // it cannot assert, and the run refuses. Flipping that arm to `true` used
    // to leave the whole suite green.
    const result = await withDeclaration(
      oneLane({ preconditions: { only: [{ kind: "path", value: ["deps", "other"] }] } }),
      ["build", "--json"],
    );
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    const report = JSON.parse(result.out.join("\n")) as {
      preconditions: readonly { kind: string; value: unknown; satisfied: boolean | null }[];
    };
    expect(report.preconditions).toEqual([
      { kind: "path", value: ["deps", "other"], satisfied: null },
    ]);
    expect(result.err.join("\n")).toMatch(/1 nen cannot assert/);
  });

  it("reports a path it cannot stat as PRESENT-and-broken, never as absent", async () => {
    // `entryExists` uses `lstatSync(..., { throwIfNoEntry: false })`, so an
    // ABSENT entry comes back as `undefined` and only a real error throws. The
    // catch arm exists for those -- EACCES on a parent, ENOTDIR on a path
    // through a regular file -- and it answers PRESENT: an entry nen cannot
    // read is a repository problem to report, and "the build has not been run
    // yet" is the one thing it is definitely not. Flipping that arm to `false`
    // used to leave the whole suite green.
    //
    // THE TRIGGER IS A PATH THE RUNTIME ITSELF REJECTS, not a path through a
    // file, because the two POSIX errnos above are not portable: on Windows,
    // `lstat` of `file\child` answers "no entry" rather than ENOTDIR, and a
    // test built on that arrives green on two of the three CI lanes and red on
    // the third -- which is exactly what happened. A NUL in the path is
    // refused by node's own argument validation on every platform, before any
    // syscall, and reaches the same arm.
    const result = await withDeclaration(
      oneLane({
        preconditions: { only: [{ kind: "path", value: "not\u0000a-path" }] },
      }),
      ["build", "--dry-run", "--json"],
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as {
      preconditions: readonly { satisfied: boolean | null }[];
    };
    expect(report.preconditions[0]?.satisfied).toBe(true);
  });
});

// ── (c2) the repository boundary ───────────────────────────────────────────

describe("nothing steps outside the tree --repo names", () => {
  // A declaration is the repository's own file, so this is not a trust boundary
  // in the usual sense -- but `../..` is a mistake whose only symptom would
  // otherwise be a verb quietly running somewhere else, and both paths a
  // declaration can state are checked. Neither had a test.

  it("refuses a lane whose cwd escapes the repository, before anything spawns", async () => {
    const result = await withDeclaration(
      { ...oneLane(), lanes: { only: { stack: "placeholder-stack", cwd: "../.." } } },
      ["build"],
    );
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    expect(result.err.join("\n")).toMatch(/project\.lanes\.only\.cwd names '\.\.\/\.\.'/);
    expect(result.err.join("\n")).toMatch(/will not step outside the tree/);
  });

  it("refuses a precondition path that escapes it, and asserts nothing", async () => {
    const result = await withDeclaration(
      oneLane({ preconditions: { only: [{ kind: "path", value: "../../etc/passwd" }] } }),
      ["build", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    expect(result.err.join("\n")).toMatch(
      /project\.preconditions\.only\[0\]\.value names '\.\.\/\.\.\/etc\/passwd'/,
    );
  });

  it("refuses an artifact path that escapes it too", async () => {
    const result = await withDeclaration(
      oneLane({}, { exe: "placeholder-tool", argv: ["go"], artifacts: ["../outside"] }),
      ["build", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/artifacts\[0\] names '\.\.\/outside'/);
  });

  it("accepts a root entry whose name merely STARTS WITH '..' ('..something'), and does not mistake it for an escape", async () => {
    // A bare `rel.startsWith("..")` matches this too -- it is the bug this
    // fixes. `..something` is a real, legitimate entry name (a directory
    // like `..cache` some tools use), and it never leaves the repository:
    // `resolve` treats it as one ordinary path segment, not as a `..` step.
    const result = await withDeclaration(
      { ...oneLane(), lanes: { only: { stack: "placeholder-stack", cwd: "..something" } } },
      ["build", "--dry-run", "--json"],
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { cwd: string };
    // Resolved to a directory literally named '..something' directly under the
    // repository root -- never one level up, which is what the bug did.
    expect(basename(report.cwd)).toBe("..something");
    expect(isAbsolute(report.cwd)).toBe(true);
  });

  it("still refuses a lane cwd of exactly '..'", async () => {
    const result = await withDeclaration(
      { ...oneLane(), lanes: { only: { stack: "placeholder-stack", cwd: ".." } } },
      ["build"],
    );
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    expect(result.err.join("\n")).toMatch(/project\.lanes\.only\.cwd names '\.\.'/);
    expect(result.err.join("\n")).toMatch(/will not step outside the tree/);
  });

  it("still refuses a lane cwd of '../x'", async () => {
    const result = await withDeclaration(
      { ...oneLane(), lanes: { only: { stack: "placeholder-stack", cwd: "../x" } } },
      ["build"],
    );
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    expect(result.err.join("\n")).toMatch(/project\.lanes\.only\.cwd names '\.\.\/x'/);
    expect(result.err.join("\n")).toMatch(/will not step outside the tree/);
  });
});

// ── (d) the refusals, one per exit code ────────────────────────────────────

describe("refusals", () => {
  it("exit 2 naming the file and 'detect' when there is no declaration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-shu-none-"));
    try {
      const result = await capture(["build"], { repo: dir });
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toContain(join(dir, "nen", "contract.json"));
      expect(result.err.join("\n")).toMatch(/nen shu detect/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 2 naming the missing block when the contract carries only a dependency", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-shu-dep-"));
    try {
      mkdirSync(join(dir, "nen"));
      writeFileSync(
        join(dir, "nen", "contract.json"),
        JSON.stringify({
          dependency: {
            minimum: "0.3",
            pinned_ref: "v0.3.0",
            version_probe: ["nen", "--version"],
            bootstrap: { url: "https://example.invalid/x.sh", script_path_in_source: "b/x.sh" },
          },
        }),
      );
      const result = await capture(["build"], { repo: dir });
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/has no "project" block/);
      expect(result.err.join("\n")).toMatch(/>= 0\.3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 1, not 2, for a declaration that is PRESENT and malformed", async () => {
    // The distinction the help text now states: ABSENT (or present with no
    // project block) is a mistyped invocation and exits 2; present and
    // unreadable is a repository defect and exits 1 -- the code every family in
    // this CLI answers an unreadable schema file with. Diverging here would
    // make `shu` the one family where a malformed taxonomy file means something
    // else.
    const dir = mkdtempSync(join(tmpdir(), "nen-shu-bad-"));
    try {
      mkdirSync(join(dir, "nen"));
      writeFileSync(join(dir, "nen", "contract.json"), '{"project": {"lanes": "not an object"}}');
      const result = await capture(["build"], { repo: dir });
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).toContain(join(dir, "nen", "contract.json"));
      // Named pointer and expectation, not a bare "invalid".
      expect(result.err.join("\n")).toMatch(/at project\.[a-zA-Z]+, expected /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 2 naming every declared lane when --lane is unknown", async () => {
    const result = await capture(["build", "--lane", "nope"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/Declared: web, native/);
  });

  it("exit 4 listing the lane's declared verbs when it declares no such verb", async () => {
    const result = await capture(["ui-test", "--lane", "native"]);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toMatch(/declares no 'ui-test'/);
    expect(result.err.join("\n")).toMatch(/It declares: archive, build, release, test\./);
  });

  it("exit 4 quoting the declaration's OWN sentence for an unsupported verb", async () => {
    const result = await capture(["archive"]);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toContain("no packaging step exists; this lane ships as a web application.");
  });

  it("exit 3 naming the host and the platforms the declaration allows", async () => {
    const result = await capture(["release", "--lane", "native"], { platform: "linux" });
    expect(result.code).toBe(3);
    expect(result.err.join("\n")).toMatch(/is declared for darwin; this host is linux/);
    expect(result.seams.calls).toEqual([]);
  });

  it("exit 3 is a fact about the host, not about the day: the same verb runs on darwin", async () => {
    const result = await capture(["release", "--lane", "native", "--dry-run"], { platform: "darwin" });
    // Its lane's preconditions still refuse (2), which is the point: the host
    // check passed, so the refusal moved on to the next gate.
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).not.toMatch(/this host is/);
  });

  it("checks the verb BEFORE the host, because an unsupported verb is unsupported everywhere", async () => {
    // `release` on `web` is the one verb that is BOTH: the declaration marks it
    // unsupported for this lane, AND `hosts.release` allows only darwin. Run on
    // linux, both gates would fire, and the answer must be 4 -- telling a
    // developer to find a mac for a verb that has no answer on any machine is
    // the failure this order exists to prevent.
    //
    // The earlier version of this test used `archive` on `web`, whose hosts are
    // `*` -- so only ONE gate could ever fire and swapping the two blocks in
    // render.ts left it green. That mutant now dies here.
    const conflicted = await capture(["release"], { platform: "linux" });
    expect(conflicted.code).toBe(4);
    expect(conflicted.err.join("\n")).toMatch(/no package or store pipeline/);
    expect(conflicted.err.join("\n")).not.toMatch(/this host is/);
    // And the host gate is real for the same verb on a lane that DOES declare
    // it, which is what makes the assertion above about the order.
    const hosted = await capture(["release", "--lane", "native"], { platform: "linux" });
    expect(hosted.code).toBe(3);
  });

  it("exit 2 naming the placeholder it will not guess at", async () => {
    const result = await capture(["test", "--lane", "native"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/names a placeholder nen cannot substitute: \{scheme\}/);
    // And the refusal lists the closed set, which is the whole answer to "then
    // what may I write" -- the token is refused because it is one of the
    // reference pack's, not because it has braces around it.
    expect(result.err.join("\n")).toMatch(/every other braced argument is passed to the child/);
  });

  it("exit 1 naming the step that failed, and stops there", async () => {
    const result = await capture(["lint"], {
      script: [ok("pnpm exec biome check ."), { match: "pnpm turbo run lint", result: { code: 2 } }],
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/step 2 of 2 failed: pnpm turbo run lint -- exited 2/);
    expect(spawned(result.seams)).toHaveLength(2);
  });

  it("stops a multi-step verb AT the failing step, never running the next one", async () => {
    const result = await capture(["lint"], {
      script: [{ match: "pnpm exec biome check .", result: { code: 1 } }],
    });
    expect(result.code).toBe(1);
    expect(spawned(result.seams)).toEqual(["pnpm exec biome check ."]);
  });

  it("exit 5, not 1, when the declared program cannot be started at all", async () => {
    const result = await capture(["build"], {
      script: [{ match: "pnpm turbo run build", result: { spawnFailed: true } }],
    });
    expect(result.code).toBe(5);
    expect(result.err.join("\n")).toMatch(/could not be started: 'pnpm'/);
    expect(result.err.join("\n")).toMatch(/nen never installs a toolchain/);
  });

  it("nulls the failing step's exitCode and durationMs on a spawn failure -- `code` is meaningless", async () => {
    // -1 is what ../seam/exec.ts's real spawnRunner returns on a spawn
    // failure (its `result.error` branch); scripting it here rather than
    // leaving `code` to the fixture's own default of 0 is what makes this
    // test catch a regression back to `exitCode: result.code` -- 0 would pass
    // either way, -1 would not.
    const result = await capture(["build", "--json"], {
      script: [{ match: "pnpm turbo run build", result: { spawnFailed: true, code: -1 } }],
    });
    expect(result.code).toBe(5);
    const report = JSON.parse(result.out.join("\n")) as {
      steps: readonly { exitCode: number | null; durationMs: number | null }[];
      exitCode: number | null;
    };
    expect(report.steps[0]?.exitCode).toBeNull();
    expect(report.steps[0]?.durationMs).toBeNull();
    // NEN's own exit code is unaffected: still 5, the tool-not-installed
    // family code, never the tool's own (meaningless) -1.
    expect(report.exitCode).toBe(5);
  });

  it("nulls only the step that failed to spawn -- an earlier CAPTURED step keeps its real numbers", async () => {
    const result = await capture(["lint", "--json"], {
      script: [
        ok("pnpm exec biome check ."),
        { match: "pnpm turbo run lint", result: { spawnFailed: true, code: -1 } },
      ],
      ticking: true,
    });
    expect(result.code).toBe(5);
    const report = JSON.parse(result.out.join("\n")) as {
      steps: readonly { exitCode: number | null; durationMs: number | null }[];
    };
    expect(report.steps).toHaveLength(2);
    expect(report.steps[0]?.exitCode).toBe(0);
    expect(report.steps[0]?.durationMs).not.toBeNull();
    expect(report.steps[1]?.exitCode).toBeNull();
    expect(report.steps[1]?.durationMs).toBeNull();
  });

  it("the human rendering says a step 'did not start' rather than claiming an exit code it never produced", async () => {
    const result = await capture(["build"], {
      script: [{ match: "pnpm turbo run build", result: { spawnFailed: true, code: -1 } }],
    });
    expect(result.code).toBe(5);
    const out = result.out.join("\n");
    expect(out).toMatch(/ran: *pnpm turbo run build {2}-- did not start/);
    // Not the "-- exit <code> in <ms>ms" shape a real (captured) result gets,
    // and specifically not a rendering of the meaningless -1.
    expect(out).not.toMatch(/exit -1/);
    expect(out).not.toMatch(/exit null/);
  });

  it("refuses a --target that names no declared target, rather than accepting any word", async () => {
    const result = await capture(["deploy", "--target", "anything"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/declares no targets at all/);
  });

  it("refuses 'deploy' with no --target at all -- there is never a default", async () => {
    const result = await capture(["deploy"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target is required/);
  });
});

// ── (e) the long-running verbs ─────────────────────────────────────────────

describe("the interactive verbs", () => {
  for (const verb of ["dev", "run"]) {
    it(`'${verb}' goes through the INTERACTIVE seam, not the captured one`, async () => {
      const result = await capture([verb], { script: NEXTJS_GOLDENS[verb]?.map(ok) ?? [] });
      expect(result.code).toBe(0);
      expect(result.seams.calls.map((call): boolean => call.interactive)).toEqual([true]);
    });
  }

  it("every other verb goes through the CAPTURED seam", async () => {
    for (const verb of ["build", "test", "lint"]) {
      const result = await capture([verb], { script: NEXTJS_GOLDENS[verb]?.map(ok) ?? [] });
      expect(result.seams.calls.every((call): boolean => !call.interactive)).toBe(true);
    }
  });

  it("prints the pre-flight report BEFORE handing over the terminal", async () => {
    const result = await capture(["dev"], { script: [ok("pnpm exec next dev")] });
    expect(result.code).toBe(0);
    // Nulls, not zeroes: there is no honest exit code for a process that has
    // not started and may not stop for hours.
    expect(result.out.join("\n")).toMatch(/would run|ran/);
    expect(result.out.join("\n")).toMatch(/an interactive verb hands this terminal to the child/);
  });

  for (const verb of ["dev", "run"]) {
    it(`refuses '${verb} --json' rather than interleaving a report with the child's stdout`, async () => {
      // The child INHERITS stdout, so a JSON document printed before the
      // handover is followed on the same stream by however much the child then
      // writes -- and `nen shu dev --json | jq .` reads one object and then a
      // dev server's log lines. Refusing costs one run; emitting it anyway
      // costs a caller their parser, silently.
      const result = await capture([verb, "--json"], { script: [] });
      expect(result.code).toBe(2);
      expect(result.seams.calls).toEqual([]);
      expect(result.err.join("\n")).toMatch(/is long-running/);
      expect(result.err.join("\n")).toMatch(/Pass --dry-run for the same pre-flight/);
    });

    it(`accepts '${verb} --dry-run --json', which is the machine-readable pre-flight`, async () => {
      const result = await capture([verb, "--dry-run", "--json"]);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.out.join("\n")) as {
        log: { mode: string };
        exitCode: number | null;
        steps: readonly { exitCode: number | null }[];
      };
      expect(report.log.mode).toBe("dry-run");
      expect(report.steps[0]?.exitCode).toBeNull();
      expect(result.seams.calls).toEqual([]);
    });
  }

  it("refuses the flag pair BEFORE reading the declaration -- it is about the line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-shu-nodecl-"));
    try {
      const result = await capture(["dev", "--json"], { repo: dir });
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/is long-running/);
      // Not the missing-declaration message: a caller who typed an impossible
      // pair should not need a valid declaration to be told so.
      expect(result.err.join("\n")).not.toMatch(/nen shu detect/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says in the report itself why the pre-flight carries nulls", async () => {
    const result = await capture(["dev"], { script: [ok("pnpm exec next dev")] });
    expect(result.out.join("\n")).toMatch(/--json is refused on a long-running verb/);
  });

  it("--dry-run on an interactive verb starts nothing at all", async () => {
    const result = await capture(["dev", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.seams.calls).toEqual([]);
  });

  it("relays a non-zero interactive exit as 1, naming the command", async () => {
    const result = await capture(["dev"], {
      script: [{ match: "pnpm exec next dev", result: { code: 3 } }],
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/pnpm exec next dev exited 3/);
  });

  for (const verb of ["dev", "run"]) {
    it(`'${verb}': exit 5, naming the step and the spawn failure, when the declared program cannot start`, async () => {
      // Same family code as the captured path (EXIT_TOOL_NOT_INSTALLED = 5),
      // and the same "cannot assert an exit code for a process that never
      // started" shape -- here it holds trivially, because the pre-flight
      // report is built and emitted BEFORE any step of an interactive verb is
      // ever run, so every step's exitCode/durationMs is null regardless of
      // what runInteractive later reports.
      const result = await capture([verb], {
        script: [{ match: NEXTJS_GOLDENS[verb]?.[0] ?? "", result: { spawnFailed: true, code: -1 } }],
      });
      expect(result.code).toBe(5);
      expect(result.err.join("\n")).toMatch(/step 1 of 1 could not be started: 'pnpm'/);
      const report = JSON.parse(
        (
          await capture([verb, "--dry-run", "--json"])
        ).out.join("\n"),
      ) as { steps: readonly { exitCode: number | null; durationMs: number | null }[] };
      // The pre-flight (the only report a real run of this verb ever emits)
      // is proved elsewhere to carry nulls; this pins that a spawn failure
      // changes nothing about that -- there is no SECOND report for an
      // interactive verb to get wrong.
      expect(report.steps[0]?.exitCode).toBeNull();
      expect(report.steps[0]?.durationMs).toBeNull();
    });
  }
});

// ── (f) the environment is names, never values ─────────────────────────────

describe("a declared env value never leaves the declaration", () => {
  it("prints the NAME in the dry run and the value nowhere", async () => {
    const result = await capture(["run", "--dry-run"]);
    expect(result.out.join("\n")).toMatch(/env: +PLACEHOLDER_PORT$/m);
    expect([...result.out, ...result.err].join("\n")).not.toContain(DECLARED_ENV_VALUE);
  });

  it("carries only NAMES in --json", async () => {
    const result = await capture(["run", "--dry-run", "--json"]);
    const text = result.out.join("\n");
    expect((JSON.parse(text) as { env: readonly string[] }).env).toEqual(["PLACEHOLDER_PORT"]);
    expect(text).not.toContain(DECLARED_ENV_VALUE);
  });

  it("still HANDS the value to the child -- the seam gets it, the report does not", async () => {
    // BOTH HALVES, at the one point where they can disagree. The seam records
    // the env it was given, so "the child received the value" is an assertion
    // rather than an inference from the run having succeeded -- and the value
    // still appears in no line of output. Without the first half, dropping
    // `env` from the spawn options entirely would leave this suite green.
    const result = await capture(["run"], { script: [ok("pnpm exec next start")] });
    expect(result.code).toBe(0);
    expect(result.seams.calls[0]?.env).toEqual({ PLACEHOLDER_PORT: DECLARED_ENV_VALUE });
    expect([...result.out, ...result.err].join("\n")).not.toContain(DECLARED_ENV_VALUE);
  });

  it("passes NO env at all for a verb that declares none", async () => {
    const result = await capture(["build"], { script: [ok("pnpm turbo run build")] });
    expect(result.seams.calls[0]?.env).toBeNull();
  });
});

// ── (f2) the directory every step runs in ──────────────────────────────────

describe("a step runs in the lane's own directory, resolved against --repo", () => {
  it("hands the seam the lane cwd, resolved from the repository root", async () => {
    // The scripted seam cannot MATCH on cwd, so a verb that resolved the lane
    // against `process.cwd()` instead of `--repo` produced a call it answered
    // happily. The recorded value is the assertion.
    const result = await capture(["build"], { script: [ok("pnpm turbo run build")] });
    expect(result.seams.calls[0]?.cwd).toBe(SHU_REPO);
    // And the report says the same thing the seam was told.
    const report = JSON.parse(
      (await capture(["build", "--json"], { script: [ok("pnpm turbo run build")] })).out.join("\n"),
    ) as { cwd: string; steps: readonly { cwd: string }[] };
    expect(report.cwd).toBe(SHU_REPO);
    expect(report.steps[0]?.cwd).toBe(SHU_REPO);
  });

  it("runs a lane whose cwd is a subdirectory THERE, not at the root", async () => {
    const result = await capture(["build", "--lane", "native", "--dry-run", "--json"], {
      env: { [TOKEN]: "x" },
      repo: SHU_REPO,
    });
    // `native` declares `cwd: "native"`; its preconditions refuse a real run,
    // so the dry run is where the resolved directory is observable.
    const report = JSON.parse(result.out.join("\n")) as { cwd: string };
    expect(report.cwd).toBe(join(SHU_REPO, "native"));
  });

  it("hands the interactive seam the same directory the captured one gets", async () => {
    const result = await capture(["dev"], { script: [ok("pnpm exec next dev")] });
    expect(result.seams.calls[0]).toMatchObject({ interactive: true, cwd: SHU_REPO });
  });
});

// ── (g) the tool's own output ──────────────────────────────────────────────

describe("a step's own output", () => {
  it("goes to stdout in text mode", async () => {
    const result = await capture(["build"], {
      script: [{ match: "pnpm turbo run build", result: { code: 0, stdout: "built 3 packages\n" } }],
    });
    expect(result.out).toContain("built 3 packages");
  });

  it("goes to STDERR in --json mode, so stdout stays exactly one document", async () => {
    const result = await capture(["build", "--json"], {
      script: [{ match: "pnpm turbo run build", result: { code: 0, stdout: "built 3 packages\n" } }],
    });
    expect(result.err).toContain("built 3 packages");
    expect(() => JSON.parse(result.out.join("\n"))).not.toThrow();
  });
});

// ── (h) NO verb is declared-and-unbuilt any more ───────────────────────────
//
// There were two -- `tools` (zheref/nen#113) and `warmup` (zheref/nen#124) --
// and both are built. The "declared, documented, refuses at 4 by name" shape
// was worth keeping while anything used it, and is worth ASSERTING GONE now
// that nothing does: a regression that re-added either refusal would otherwise
// surface only in the other verb's own suite, and this file is where the
// family's shape is pinned.

describe("no verb answers 4 merely because nen has not built it", () => {
  it("no longer refuses 'tools', which this release implements", async () => {
    // The fixture declares no toolchain and no dependency, so this is the
    // "nothing to check" answer -- exit 0 with a note, never the exit-4 refusal
    // it used to give.
    const result = await capture(["tools"]);
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toMatch(/nothing to check/);
  });

  it("no longer refuses 'warmup', which this release implements", async () => {
    // Refused at 2 for a MISSING FLAG, which is a fact about the invocation --
    // never at 4, which would be a claim that nen has no such verb. Nothing is
    // scripted on the seam, so this also proves the refusal lands before any
    // git call: an unscripted call would throw.
    const result = await capture(["warmup"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--branch is required/);
    expect(result.err.join("\n")).not.toMatch(/not implemented/);
  });
});
