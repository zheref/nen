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
import { assertPreconditions, INTERACTIVE_VERBS } from "./run.js";
import {
  LAUNCHING_VERBS,
  renderArgv,
  type RenderedInvocation,
  type RenderedPrecondition,
} from "./render.js";

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

/**
 * Every DECLARED argv the seam actually took, in order.
 *
 * NEN'S OWN `git` CALLS ARE NOT PART OF THIS, and the filter is the point of
 * the helper rather than a convenience: what these goldens pin is that a
 * repository's declaration reaches the seam token for token. A green `build`
 * also asks git for the working copy's tree so it can record a build proof
 * (../shu/proof.ts) -- a command NEN chose, like `shu evidence`'s own `git
 * diff` -- and folding that into the goldens would make every one of them a
 * statement about two unrelated things. The proof's own calls are pinned in
 * ./proof.test.ts, where they are the subject.
 */
function spawned(seams: ScriptedSeams): readonly string[] {
  return seams.calls
    .filter((call): boolean => call.command !== "git")
    .map((call): string => [call.command, ...call.args].join(" "));
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
    // The DECLARED calls: a green `build` also asks git for a tree hash, which
    // `spawned` filters out for the reason its own comment gives.
    expect(spawned(result.seams)).toHaveLength(1);
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
      "target",
      "steps",
      "cwd",
      "env",
      "host",
      "preconditions",
      "exitCode",
      "durationMs",
      "artifacts",
      "log",
      "proof",
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
    expect(Object.keys(report.steps[0] ?? {})).toEqual([
      "exe",
      "argv",
      "cwd",
      "exitCode",
      "durationMs",
      "stall",
    ]);
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

// ── (c3) assertPreconditions asserts the pointer AS GIVEN ─────────────────
//
// A DIRECT UNIT TEST OF ./run.ts's `assertPreconditions`, not driven through
// `withDeclaration` -- unlike everywhere else in this file. The contract this
// pins ("whatever `RenderedPrecondition.pointer` says IS the value pointer,
// and this function appends nothing to it") has no real declaration that
// exercises the target-row half of it: `resolveTarget` in ./render.ts only
// ever hands `assertPreconditions` an `env`-kind row for a target's
// `requiresEnv`, and `env` never reaches `insideRepo` -- the one place a
// pointer is rendered into a message -- so a real `nen shu deploy` can never
// show the difference. Constructing a `path`-kind row shaped the way a target
// row IS ADDRESSED (`project.targets.<name>.requiresEnv[<i>]`, already the
// leaf) is the only way to prove `assertPreconditions` never appends `.value`
// to a pointer that is already one.

function planWith(preconditions: readonly RenderedPrecondition[]): RenderedInvocation {
  return {
    lane: "only",
    stack: "placeholder-stack",
    verb: "deploy",
    target: null,
    cwdRelative: ".",
    steps: [],
    env: {},
    host: { platform: "linux", supported: true, declared: null },
    preconditions,
    artifacts: [],
    why: null,
  };
}

describe("assertPreconditions asserts entry.pointer verbatim", () => {
  it("a lane-shaped pointer, which already carries '.value'", () => {
    const plan = planWith([
      {
        kind: "path",
        value: "../../etc/passwd",
        why: null,
        // What ./render.ts's `lanePreconditions` now builds: the leaf itself.
        pointer: "project.preconditions.only[0].value",
      },
    ]);
    expect(() => assertPreconditions(plan, SHU_REPO, new ScriptedSeams([]))).toThrow(
      /^project\.preconditions\.only\[0\]\.value names '\.\.\/\.\.\/etc\/passwd'/,
    );
  });

  it("a target-shaped pointer, appending nothing -- the regression this pins", () => {
    // No real declaration produces a `path`-kind row at this address (a
    // target's `requiresEnv` is always `env`-kind); this constructs the shape
    // directly to prove the function's own contract, independent of what
    // today's callers happen to pass it.
    const plan = planWith([
      {
        kind: "path",
        value: "../../etc/passwd",
        why: null,
        // What ./render.ts's `resolveTarget` builds for a `requiresEnv` row:
        // already the leaf, with NO '.value' to append.
        pointer: "project.targets.production.requiresEnv[0]",
      },
    ]);
    expect(() => assertPreconditions(plan, SHU_REPO, new ScriptedSeams([]))).toThrow(
      /^project\.targets\.production\.requiresEnv\[0\] names '\.\.\/\.\.\/etc\/passwd'/,
    );
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
    expect(result.err.join("\n")).toMatch(/Declared: web, native, pages, device\./);
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

  it("exit 2 naming every declared lane when --lane is unknown, even on the verb with a destination", async () => {
    // THE LANE STILL COMES FIRST. `deploy`'s destination is resolved after the
    // lane and the verb, which is what makes a seat reachable -- but "after the
    // lane" has to mean the LANE's refusal wins when the lane is the thing that
    // is wrong, or the new order would have traded one unreachable refusal for
    // another.
    const result = await capture(["deploy", "--lane", "nope", "--target", "preview"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--lane 'nope' is not a lane this repository declares/);
  });
});

// ── (d.1) `deploy`: the destination, and the order it is resolved in ────────
//
// THE FIXTURE CARRIES BOTH HALVES OF THE ORDER ON PURPOSE. `web`'s `deploy` is
// an `unsupported` SEAT and `pages`'s is a runnable row, so every assertion
// below about "which fact answers first" is made against a declaration rather
// than against a mock.

/** The environment a real deploy needs, with values no output may carry. */
const DEPLOY_ENV: Readonly<Record<string, string>> = {
  [TOKEN]: "a value no output may carry",
  PLACEHOLDER_DEPLOY_TOKEN: "TOKEN-VALUE-THAT-MUST-NEVER-BE-PRINTED",
  PLACEHOLDER_DEPLOY_ORG: "ORG-VALUE-THAT-MUST-NEVER-BE-PRINTED",
};

/** The declaration's own env value for the `pages` lane's deploy row. */
const DECLARED_DEPLOY_VALUE = "a declared value no output may carry";

interface TargetReport {
  readonly target: { readonly name: string; readonly args: readonly string[]; readonly requiresEnv: readonly string[] } | null;
}

describe("nen shu deploy -- the seat, the destination, and which answers first", () => {
  it("answers a SEAT at exit 4 with the declaration's own reason, whatever --target says", async () => {
    // THE FINDING THIS ORDER EXISTS FOR. `--target` used to be a usage gate in
    // front of the declaration, so a lane whose `deploy` the repository seats
    // as unsupported could never say so: every form of the line answered "no
    // targets declared", which sends a maintainer to write a `targets` block
    // that cannot make the row runnable. Three forms, one answer.
    for (const argv of [
      ["deploy"],
      ["deploy", "--target", "preview"],
      ["deploy", "--target", "not-a-declared-target"],
    ]) {
      const result = await capture(argv);
      expect(result.code, argv.join(" ")).toBe(4);
      expect(result.err.join("\n"), argv.join(" ")).toContain(
        "no target is wired. Declare one under `targets` before nen will run this.",
      );
      expect(result.seams.calls, argv.join(" ")).toEqual([]);
    }
  });

  it("answers the SEAT even when the TARGET is the one with no command line", async () => {
    // THE PAIR THE WHOLE ORDER ARGUMENT RESTS ON, and both halves are exit 4:
    // the lane's seat and the destination's `unsupported` are each terminal, so
    // whichever answers, a caller learns a fact that no retype changes. The
    // LANE's is the one that must win -- it is true of every destination, while
    // the target's is true of this one -- so the sentence a reader gets is the
    // lane's own.
    const result = await capture(["deploy", "--target", "provider-integration"]);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toContain(
      "no target is wired. Declare one under `targets` before nen will run this.",
    );
    // And NOT the destination's, which would send a maintainer to fix the one
    // target instead of the lane that cannot deploy at all.
    expect(result.err.join("\n")).not.toContain("hosting provider's git integration");
    expect(result.seams.calls).toEqual([]);
  });

  it("answers the HOST at 3 before a --target that names nothing", async () => {
    // The other unpinned pair: `project.hosts` is a fact about this MACHINE and
    // the destination is a fact about the command line, so the machine answers
    // first -- retyping the target on a host the declaration excludes could not
    // have helped, and exit 3 is the code a caller routes to another runner on.
    const result = await withDeclaration(
      oneLane({
        verbs: { only: { deploy: { exe: "placeholder-deploy-tool", argv: ["publish"] } } },
        targets: { prod: {} },
        hosts: { deploy: ["darwin"] },
      }),
      ["deploy", "--target", "not-a-declared-target"],
      { platform: "linux" },
    );
    expect(result.code).toBe(3);
    expect(result.err.join("\n")).toMatch(
      /'deploy' on lane 'only' \(placeholder-stack\) is declared for darwin; this host is linux/,
    );
    expect(result.seams.calls).toEqual([]);
  });

  it("asks for the destination -- byte-ordered -- once the lane HAS a deploy to send", async () => {
    const result = await capture(["deploy", "--lane", "pages"]);
    expect(result.code).toBe(2);
    // Byte order, not declaration order: the fixture writes them staging,
    // production, preview, provider-integration.
    expect(result.err.join("\n")).toMatch(
      /Declared under project\.targets: preview, production, provider-integration, staging\./,
    );
    expect(result.err.join("\n")).toMatch(/there is no default -- not even when exactly one target/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses a --target that names no declared target, rather than accepting any word", async () => {
    const result = await capture(["deploy", "--lane", "pages", "--target", "anything"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(
      /--target 'anything' is not declared under project\.targets\. Declared: preview, production, provider-integration, staging\./,
    );
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses a --target naming an inherited object member as the undeclared target it is", async () => {
    // `project.targets["constructor"]` is a function on any ordinary object, so
    // a lookup asking `!== undefined` would accept this, read `args` off a
    // function and deploy. The map is prototype-less AND the lookup uses
    // hasOwnProperty; this pins the answer a caller gets either way.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      const result = await capture(["deploy", "--lane", "pages", "--target", inherited]);
      expect(result.code, inherited).toBe(2);
      expect(result.err.join("\n"), inherited).toContain(
        `--target '${inherited}' is not declared under project.targets.`,
      );
      expect(result.seams.calls, inherited).toEqual([]);
    }
  });

  it("prints the block to paste when the repository declares no targets at all", async () => {
    const result = await withDeclaration(
      oneLane({ verbs: { only: { deploy: { exe: "placeholder-deploy-tool", argv: ["publish"] } } } }),
      ["deploy"],
    );
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    expect(message).toMatch(/declares no targets at all/);
    // THE SHAPE IS IN THE REFUSAL, not in a document it points at: "declare a
    // target" is advice a reader then has to go and look up.
    expect(message).toContain('"targets": { "<name>": { "args": ["<argument appended to the deploy argv>"], "requiresEnv": ["<VARIABLE_NAME>"], "why": "<what this destination is>" } }');
    expect(message).toMatch(/never reads the value of/);
  });

  it("refuses a destination that has NO COMMAND LINE at all at exit 4, in the repo's words", async () => {
    const result = await capture(["deploy", "--lane", "pages", "--target", "provider-integration"]);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toContain(
      "the push to the default branch IS the deploy here, through the hosting provider's git integration.",
    );
    expect(result.seams.calls).toEqual([]);
  });

  it("appends the target's args to the lane's declared argv, and spawns exactly that", async () => {
    const argv = "placeholder-deploy-tool publish --dir public --env staging";
    const dry = await capture(["deploy", "--lane", "pages", "--target", "staging", "--dry-run"], {
      env: DEPLOY_ENV,
    });
    expect(dry.code).toBe(0);
    expect(wouldRun(dry.out)).toEqual([argv]);
    // A DRY RUN SPAWNS NOTHING -- the whole reason izanami certifies this one
    // form of a verb that otherwise writes to somebody else's infrastructure.
    expect(dry.seams.calls).toEqual([]);
    const wet = await capture(["deploy", "--lane", "pages", "--target", "staging", "--run"], {
      env: DEPLOY_ENV,
      script: [ok(argv)],
    });
    expect(wet.code).toBe(0);
    expect(spawned(wet.seams)).toEqual([argv]);
    // The thing you approve is the thing that runs, for this verb too.
    expect(wouldRun(dry.out)).toEqual(spawned(wet.seams));
  });

  it("changes the argv with the destination -- two targets are not one command", async () => {
    const staging = await capture(["deploy", "--lane", "pages", "--target", "staging", "--dry-run"], {
      env: DEPLOY_ENV,
    });
    const production = await capture(
      ["deploy", "--lane", "pages", "--target", "production", "--dry-run"],
      { env: DEPLOY_ENV },
    );
    expect(wouldRun(staging.out)).toEqual([
      "placeholder-deploy-tool publish --dir public --env staging",
    ]);
    expect(wouldRun(production.out)).toEqual([
      "placeholder-deploy-tool publish --dir public --env production",
    ]);
  });

  it("runs a name-only target's row exactly as declared, and still demands the name", async () => {
    const result = await capture(["deploy", "--lane", "pages", "--target", "preview", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(wouldRun(result.out)).toEqual(["placeholder-deploy-tool publish --dir public"]);
  });

  it("refuses a target that appends onto a MULTI-STEP row rather than guessing the step", async () => {
    const result = await withDeclaration(
      oneLane({
        verbs: {
          only: {
            deploy: {
              steps: [
                { exe: "placeholder-site-tool", argv: ["build"] },
                { exe: "placeholder-deploy-tool", argv: ["publish"] },
              ],
            },
          },
        },
        targets: { prod: { args: ["--prod"] } },
      }),
      ["deploy", "--target", "prod", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(
      /appends 1 argument \(--prod\), and 'deploy' on lane 'only' declares 2 steps/,
    );
    expect(result.err.join("\n")).toMatch(/will not guess which of them reaches the destination/);
    expect(result.seams.calls).toEqual([]);
  });

  // THE SAME RISK AS THE `target:` LINE, ONE LAYER UP. This refusal printed a
  // target's appended args with `args.join(" ")` too -- the exact un-quoted
  // join the `target:` line's `(appends: ...)` tail was fixed away from. A
  // target whose args carry a space -- `["--branch", "two words"]` -- read as
  // THREE arguments instead of two. The expected quoting is computed from
  // `renderArgv` itself rather than hand-typed, so this cannot drift from
  // what the fix actually calls; no shell ever sees this string (it is a
  // message, not a spawned argv), so the same single-quote escaping is
  // correct on Windows and POSIX alike.
  it("quotes a target's appended args in the multi-step refusal too", async () => {
    const result = await withDeclaration(
      oneLane({
        verbs: {
          only: {
            deploy: {
              steps: [
                { exe: "placeholder-site-tool", argv: ["build"] },
                { exe: "placeholder-deploy-tool", argv: ["publish"] },
              ],
            },
          },
        },
        targets: { prod: { args: ["--branch", "two words"] } },
      }),
      ["deploy", "--target", "prod", "--dry-run"],
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    const quoted = renderArgv({ exe: "--branch", argv: ["two words"] });
    expect(err).toContain(`appends 2 arguments (${quoted})`);
    // The space-carrying argument survives as ONE quoted element.
    expect(quoted).toContain("'two words'");
    // The un-quoted join this test guards against would print exactly this
    // substring -- three bare tokens where the destination declared two.
    expect(err).not.toContain("(--branch two words)");
    expect(result.seams.calls).toEqual([]);
  });

  it("runs a multi-step deploy when the target appends nothing -- the refusal is about the args", async () => {
    const result = await withDeclaration(
      oneLane({
        verbs: {
          only: {
            deploy: {
              steps: [
                { exe: "placeholder-site-tool", argv: ["build"] },
                { exe: "placeholder-deploy-tool", argv: ["publish"] },
              ],
            },
          },
        },
        targets: { prod: { why: "the one destination this row already names" } },
      }),
      ["deploy", "--target", "prod", "--dry-run"],
    );
    expect(result.code).toBe(0);
    expect(wouldRun(result.out)).toEqual([
      "placeholder-site-tool build",
      "placeholder-deploy-tool publish",
    ]);
  });

  // ── the destination's environment: NAMES, asserted; values, never ─────────

  it("asserts a target's requiresEnv as env preconditions, byte-ordered, and refuses at 2", async () => {
    const result = await capture(["deploy", "--lane", "pages", "--target", "production"], {
      env: { [TOKEN]: "x" },
    });
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    const out = result.out.join("\n");
    expect(out).toMatch(/FAIL {2}env {2}PLACEHOLDER_DEPLOY_ORG -- not set in this environment/);
    expect(out).toMatch(/FAIL {2}env {2}PLACEHOLDER_DEPLOY_TOKEN -- not set in this environment/);
    // Byte order: the declaration writes TOKEN first and ORG second.
    expect(out.indexOf("PLACEHOLDER_DEPLOY_ORG")).toBeLessThan(out.indexOf("PLACEHOLDER_DEPLOY_TOKEN"));
  });

  it("passes when the variables are set -- and never reads, compares or prints a value", async () => {
    const argv = "placeholder-deploy-tool publish --dir public --env production";
    const result = await capture(
      ["deploy", "--lane", "pages", "--target", "production", "--run", "--json"],
      { env: DEPLOY_ENV, script: [ok(argv)] },
    );
    expect(result.code).toBe(0);
    expect(spawned(result.seams)).toEqual([argv]);
    const everything = [...result.out, ...result.err].join("\n");
    // The two the TARGET requires, and the one the DECLARATION supplies to the
    // child: three values, three ways for one of them to leak, none of them.
    expect(everything).not.toContain("MUST-NEVER-BE-PRINTED");
    expect(everything).not.toContain(DECLARED_DEPLOY_VALUE);
    expect(everything).toContain("PLACEHOLDER_DEPLOY_TOKEN");
    expect(everything).toContain("PLACEHOLDER_DEPLOY_CHANNEL");
  });

  it("keeps the declared env VALUE out of the dry run and out of the refusals too", async () => {
    const dry = await capture(["deploy", "--lane", "pages", "--target", "staging", "--dry-run"], {
      env: DEPLOY_ENV,
    });
    const refused = await capture(["deploy", "--lane", "pages", "--target", "staging"], {
      env: { [TOKEN]: "x" },
    });
    for (const result of [dry, refused]) {
      const everything = [...result.out, ...result.err].join("\n");
      expect(everything).not.toContain(DECLARED_DEPLOY_VALUE);
      expect(everything).not.toContain("MUST-NEVER-BE-PRINTED");
    }
  });

  // ── the report ───────────────────────────────────────────────────────────

  it("names the destination in --json, with its own pinned key order", async () => {
    const result = await capture(
      ["deploy", "--lane", "pages", "--target", "production", "--dry-run", "--json"],
      { env: DEPLOY_ENV },
    );
    const report = JSON.parse(result.out.join("\n")) as TargetReport;
    expect(Object.keys(report.target ?? {})).toEqual(["name", "args", "requiresEnv"]);
    expect(report.target).toEqual({
      name: "production",
      args: ["--env", "production"],
      // Byte-ordered, unlike the declaration.
      requiresEnv: ["PLACEHOLDER_DEPLOY_ORG", "PLACEHOLDER_DEPLOY_TOKEN"],
    });
  });

  it("carries target: null on every verb that has no destination", async () => {
    for (const verb of ["build", "test", "lint"]) {
      const result = await capture([verb, "--dry-run", "--json"]);
      expect((JSON.parse(result.out.join("\n")) as TargetReport).target, verb).toBeNull();
    }
  });

  it("prints the destination above the argv in the human rendering", async () => {
    const result = await capture(["deploy", "--lane", "pages", "--target", "staging", "--dry-run"], {
      env: DEPLOY_ENV,
    });
    const out = result.out.join("\n");
    expect(out).toMatch(
      /target: {8}staging {2}\(appends: --env staging\) {2}requires env: PLACEHOLDER_DEPLOY_TOKEN/,
    );
    expect(out.indexOf("target:")).toBeLessThan(out.indexOf("would run:"));
    // A destination that adds nothing says so rather than printing an empty
    // pair of brackets a reader has to interpret.
    const bare = await capture(["deploy", "--lane", "pages", "--target", "preview", "--dry-run"]);
    expect(bare.out.join("\n")).toMatch(/target: {8}preview {2}\(appends no argument\)/);
  });

  // THE RISK THIS TEST PINS: `report.target.args.join(" ")` reads back
  // cleanly for `--env staging` above only because none of ITS tokens carry a
  // space or a quote. A target whose args do -- `["--note", "two words",
  // "it's"]` -- is exactly the case `renderArgv` exists for: `join(" ")`
  // would print `--note two words it's`, which a reader re-splits into FOUR
  // arguments instead of three. So this pins the `target:` line's quoted
  // tail against the SAME quoted tail the `would run:` line prints for the
  // identical tokens, rather than hand-typing an expected string that could
  // drift from `renderArgv`'s own escaping.
  it("quotes a target's appended args in the report exactly as the would-run line does", async () => {
    const project = oneLane({
      verbs: { only: { deploy: { exe: "placeholder-deploy-tool", argv: ["publish"] } } },
      targets: { prod: { args: ["--note", "two words", "it's"] } },
    });
    const result = await withDeclaration(project, ["deploy", "--target", "prod", "--dry-run"]);
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    const appended = /\(appends: ([^)]+)\)/.exec(out);
    expect(appended).not.toBeNull();
    const quotedTail = appended?.[1] ?? "";
    // The middle argument carries a space, so it must survive as ONE quoted
    // element -- the un-quoted join this test guards against would print it
    // as two.
    expect(quotedTail).toContain("'two words'");
    expect(quotedTail).not.toBe(["--note", "two words", "it's"].join(" "));
    // Same substring, same place, in the `would run:` line -- the target's
    // args are the tail of that argv, quoted by the very same `renderArgv`.
    expect(wouldRun(result.out)).toEqual([`placeholder-deploy-tool publish ${quotedTail}`]);
    // `--json` is unaffected: it already carries the raw, unquoted array.
    const json = await withDeclaration(project, ["deploy", "--target", "prod", "--dry-run", "--json"]);
    const report = JSON.parse(json.out.join("\n")) as TargetReport;
    expect(report.target?.args).toEqual(["--note", "two words", "it's"]);
  });

  it("prints NO document on stdout for any of its refusals under --json", async () => {
    const refusals: readonly (readonly string[])[] = [
      ["deploy", "--json"],
      ["deploy", "--lane", "pages", "--json"],
      ["deploy", "--lane", "pages", "--target", "anything", "--json"],
      ["deploy", "--lane", "pages", "--target", "provider-integration", "--json"],
    ];
    for (const argv of refusals) {
      const result = await capture(argv);
      expect(result.code, argv.join(" ")).not.toBe(0);
      expect(result.out, argv.join(" ")).toEqual([]);
    }
  });
});

// ── (d.2) `deploy --run`: the second gate, and the one that decides ─────────
//
// `--target` says WHERE and `--run` says NOW, and NEITHER IMPLIES THE OTHER.
// Every other verb in this family spawns something inside a directory the
// caller is standing in and can be undone by running it again; this one puts
// bytes on somebody else's infrastructure, where "run it again" is not a
// repair. So it is dry-run-first, exactly as `nen label apply --run` and `nen
// wake fire --run` are.

describe("nen shu deploy --run -- nothing is sent without it", () => {
  const PLAN = "placeholder-deploy-tool publish --dir public --env staging";
  const GATED = ["deploy", "--lane", "pages", "--target", "staging"] as const;

  it("prints the FULLY RESOLVED plan and spawns nothing, at exit 0", async () => {
    const result = await capture([...GATED], { env: DEPLOY_ENV });
    expect(result.code).toBe(0);
    // The destination is substituted into the argv -- this is the resolved
    // plan, not a template a reader has to finish in their head.
    expect(wouldRun(result.out)).toEqual([PLAN]);
    const out = result.out.join("\n");
    expect(out).toMatch(/target: {8}staging {2}\(appends: --env staging\)/);
    // The preconditions are ASSERTED, not skipped: the report says ok, which is
    // the fact a reader is checking before they add --run.
    expect(out).toMatch(/ok {4}env {2}PLACEHOLDER_DEPLOY_TOKEN/);
    // NOTHING WAS STARTED. ScriptedSeams throws on an unscripted call, so an
    // empty script is half the assertion and the empty call list is the rest.
    expect(result.seams.calls).toEqual([]);
    expect(result.err.join("\n")).toMatch(
      /nothing was sent: 'deploy' acts only with --run\./,
    );
  });

  it("sends exactly what the gated form printed, once --run is given", async () => {
    const gated = await capture([...GATED], { env: DEPLOY_ENV });
    const sent = await capture([...GATED, "--run"], { env: DEPLOY_ENV, script: [ok(PLAN)] });
    expect(sent.code).toBe(0);
    // The thing you approve is the thing that runs -- the same property the
    // whole family's `--dry-run` carries, now on the default form of this verb.
    expect(spawned(sent.seams)).toEqual(wouldRun(gated.out));
    expect(sent.err.join("\n")).not.toMatch(/nothing was sent/);
  });

  it("says nothing about --run on the verbs that have no destination", async () => {
    // The gate is TARGETED_VERBS', not the family's: `build` still spawns on a
    // bare line, and a sentence about a flag it does not read would be noise.
    const result = await capture(["build"], { script: [ok("pnpm turbo run build")] });
    expect(result.code).toBe(0);
    expect(spawned(result.seams)).toEqual(["pnpm turbo run build"]);
    expect(result.err.join("\n")).not.toMatch(/--run/);
  });

  it("refuses --run together with --dry-run at 2, before it reads anything", async () => {
    for (const argv of [
      ["deploy", "--lane", "pages", "--target", "staging", "--run", "--dry-run"],
      ["deploy", "--run", "--dry-run"],
      // A declaration this repository does not have: the pair is a fact about
      // the command line, so it answers before the file is even opened.
      ["deploy", "--run", "--dry-run", "--repo", tmpdir()],
    ]) {
      const result = await capture(argv, { env: DEPLOY_ENV });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err.join("\n"), argv.join(" ")).toMatch(
        /was given both --run and --dry-run/,
      );
      expect(result.seams.calls, argv.join(" ")).toEqual([]);
      expect(result.out, argv.join(" ")).toEqual([]);
    }
  });

  it("refuses --run on every verb in the family that is not 'deploy'", async () => {
    // ./command.ts's per-subcommand flag table, so `nen shu build --run` cannot
    // parse cleanly and be silently ignored -- and cannot be read as an action.
    for (const verb of ["build", "test", "lint", "coverage", "detect", "tools"]) {
      const result = await capture([verb, "--run"]);
      expect(result.code, verb).toBe(2);
      expect(result.err.join("\n"), verb).toMatch(/--run is not read by 'shu /);
      expect(result.seams.calls, verb).toEqual([]);
    }
  });

  it("is ONE json document and no more, with the advisory on stderr", async () => {
    const result = await capture([...GATED, "--json"], { env: DEPLOY_ENV });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as {
      readonly steps: readonly { readonly exitCode: number | null }[];
      readonly log: { readonly mode: string };
    };
    // "Was anything executed" is told the way it is told everywhere in this
    // report: a null step exit code and the log mode. There is no `dryRun`
    // boolean, and there is no second one for `--run` either.
    expect(report.steps.map((step): number | null => step.exitCode)).toEqual([null]);
    expect(report.log.mode).toBe("dry-run");
    expect(result.err.join("\n")).toMatch(/nothing was sent/);
  });

  it("still refuses an unmet precondition at 2 -- the gate is not a way past it", async () => {
    const result = await capture([...GATED], { env: { [TOKEN]: "x" } });
    expect(result.code).toBe(2);
    expect(result.out.join("\n")).toMatch(/FAIL {2}env {2}PLACEHOLDER_DEPLOY_TOKEN/);
    expect(result.seams.calls).toEqual([]);
  });

  it("answers the SEAT and the destination before it ever looks at --run", async () => {
    // The gate is the LAST thing decided, so `--run` never turns a refusal into
    // a different refusal -- and never into a run.
    for (const argv of [
      ["deploy", "--run"],
      ["deploy", "--lane", "pages", "--run"],
      ["deploy", "--lane", "pages", "--target", "nope", "--run"],
      ["deploy", "--lane", "pages", "--target", "provider-integration", "--run"],
    ]) {
      const result = await capture(argv, { env: DEPLOY_ENV });
      expect([2, 4], argv.join(" ")).toContain(result.code);
      expect(result.seams.calls, argv.join(" ")).toEqual([]);
    }
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

// ── (i) launch targets: `dev`/`run --target <name>` ────────────────────────
//
// THE VERB BECOMES THREE THINGS AND THE TESTS CHECK ALL THREE, in order and
// across the two seams: the device probe is CAPTURED (nen has to read it), the
// lane's own verb is INTERACTIVE (it always was), and the after-steps are
// captured again. `ScriptedSeams` records which seam took each call, so "the
// probe went through the interactive seam" would fail here rather than pass
// quietly and hang a real terminal.

/** A one-lane declaration with a `dev` and whatever launch block a test needs. */
function launchable(
  launch: unknown,
  dev: unknown = { exe: "placeholder-tool", argv: ["serve"] },
): Readonly<Record<string, unknown>> {
  return {
    lanes: { only: { stack: "placeholder-stack", cwd: "." } },
    defaultLane: "only",
    verbs: { only: { dev } },
    launch,
  };
}

describe("dev/run --target: the flag is OPTIONAL and names a device", () => {
  it("runs the lane's declared dev untouched when no --target is given", async () => {
    // THE COMPATIBILITY PROMISE. The fixture declares four launch targets; a
    // bare `dev` must still be the line it was before any of them existed.
    const result = await capture(["dev"], { script: [ok("pnpm exec next dev")] });
    expect(result.code).toBe(0);
    expect(spawned(result.seams)).toEqual(["pnpm exec next dev"]);
    expect(result.out.join("\n")).not.toMatch(/^target:/m);
  });

  it("refuses a --target the launch block does not declare, listing what it does", async () => {
    const result = await capture(["dev", "--target", "nope"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("is not declared under project.launch");
    expect(result.err.join("\n")).toContain("Declared: bench, farm, handset, install, sim.");
    expect(result.seams.calls).toEqual([]);
  });

  it("answers a target with no command line at all at 4, in the repo's own words", async () => {
    const result = await capture(["dev", "--target", "farm"]);
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toContain("device farm's own web console");
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses a target declared for the OTHER long-running verb", async () => {
    // `dev` and `run` are different BUILDS. Carrying a target across would
    // install a production binary from a debug target's after-steps, reporting
    // success the whole way.
    const result = await capture(["dev", "--target", "bench"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("is declared for 'run', and this is 'dev'");
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses --target on a verb that takes none", async () => {
    const result = await capture(["build", "--target", "sim"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("not read by 'shu build'");
  });
});

describe("a launch dry run prints all three thirds and spawns nothing", () => {
  it("prints the probe, the verb and the after-step, tokens UNFILLED", async () => {
    const result = await capture(["dev", "--target", "handset", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(wouldRun(result.out)).toEqual([
      "placeholder-device-tool list --json",
      "pnpm exec next dev",
      "placeholder-installer install --device {device.id}",
    ]);
    // NOTHING WAS SPAWNED -- the probe included. That is what makes `--dry-run`
    // the form ../parse/izanami.ts can certify read-only on these two verbs.
    expect(result.seams.calls).toEqual([]);
  });

  it("says what a real run would substitute, and reads the id from the probe", async () => {
    const result = await capture(["dev", "--target", "handset", "--dry-run"]);
    expect(result.out.join("\n")).toContain(
      "substitutes:   {device.id} <- the id of device 'Placeholder Handset Pro', read from the probe above",
    );
  });

  it("says a SIMULATED device is its own id, since there is no probe to read", async () => {
    const result = await capture(["dev", "--target", "sim", "--dry-run"]);
    expect(wouldRun(result.out)).toEqual([
      "pnpm exec next dev --placeholder-simulated",
      "placeholder-launcher open --device {device.id}",
    ]);
    expect(result.out.join("\n")).toContain(
      "{device.id} <- 'Placeholder Handset 9' itself -- a simulated device is addressed by its name",
    );
  });

  it("carries the target as one document under --dry-run --json", async () => {
    const result = await capture(["dev", "--target", "handset", "--dry-run", "--json"]);
    const report = JSON.parse(result.out.join("\n")) as {
      target: { name: string; verb: string; device: { name: string; id: string | null }; after: unknown[] };
      steps: readonly { exe: string }[];
    };
    expect(report.target.name).toBe("handset");
    expect(report.target.verb).toBe("dev");
    expect(report.target.device).toEqual({ name: "Placeholder Handset Pro", kind: null, id: null });
    expect(report.target.after).toEqual([
      { exe: "placeholder-installer", argv: ["install", "--device", "{device.id}"] },
    ]);
    expect(report.steps.map((step): string => step.exe)).toEqual([
      "placeholder-device-tool",
      "pnpm",
      "placeholder-installer",
    ]);
  });

  it("still refuses --json without --dry-run: the child owns stdout", async () => {
    const result = await capture(["dev", "--target", "sim", "--json"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("is long-running");
  });
});

describe("a real launch: probe, hand over, then the after-steps", () => {
  const PROBED = JSON.stringify({
    devices: [
      { name: "Placeholder Other", udid: "OTHER-0000" },
      { name: "Placeholder Handset Pro", udid: "U-0001" },
    ],
  });

  it("resolves the id, substitutes it, and runs the three in order across two seams", async () => {
    const result = await capture(["dev", "--target", "handset"], {
      script: [
        { match: "placeholder-device-tool list --json", result: { code: 0, stdout: PROBED } },
        ok("pnpm exec next dev"),
        ok("placeholder-installer install --device U-0001"),
      ],
    });
    expect(result.code).toBe(0);
    expect(spawned(result.seams)).toEqual([
      "placeholder-device-tool list --json",
      "pnpm exec next dev",
      "placeholder-installer install --device U-0001",
    ]);
    expect(result.seams.calls.map((call): boolean => call.interactive)).toEqual([false, true, false]);
    expect(result.out.join("\n")).toContain("id U-0001");
  });

  it("spawns no probe for a simulated device: its name IS its id", async () => {
    const result = await capture(["dev", "--target", "sim"], {
      script: [
        ok("pnpm exec next dev --placeholder-simulated"),
        ok("placeholder-launcher open --device Placeholder Handset 9"),
      ],
    });
    expect(result.code).toBe(0);
    expect(spawned(result.seams)).toEqual([
      "pnpm exec next dev --placeholder-simulated",
      "placeholder-launcher open --device Placeholder Handset 9",
    ]);
  });

  it("refuses at 5, listing what the probe DID offer, and starts nothing", async () => {
    const result = await capture(["dev", "--target", "handset"], {
      script: [
        {
          match: "placeholder-device-tool list --json",
          result: { code: 0, stdout: JSON.stringify({ devices: [{ name: "Placeholder Other" }] }) },
        },
      ],
    });
    expect(result.code).toBe(5);
    expect(result.err.join("\n")).toContain("'Placeholder Handset Pro' is not among the devices");
    expect(result.err.join("\n")).toContain("'Placeholder Other'");
    // The verb never started: an unscripted call would have thrown, and the
    // recorded list is the probe alone.
    expect(spawned(result.seams)).toEqual(["placeholder-device-tool list --json"]);
  });

  it("refuses at 5 when the probe named the device and gave no id", async () => {
    const result = await capture(["dev", "--target", "handset"], {
      script: [
        {
          match: "placeholder-device-tool list --json",
          result: { code: 0, stdout: JSON.stringify([{ name: "Placeholder Handset Pro" }]) },
        },
      ],
    });
    expect(result.code).toBe(5);
    expect(result.err.join("\n")).toContain("gave nen no id for it");
  });

  it("refuses at 5 when the probe itself could not be started", async () => {
    const result = await capture(["dev", "--target", "handset"], {
      script: [
        { match: "placeholder-device-tool list --json", result: { spawnFailed: true, stderr: "no such file" } },
      ],
    });
    expect(result.code).toBe(5);
    expect(result.err.join("\n")).toContain("the device probe could not be started");
  });

  it("exits 1 when the probe ran and failed, and launches nothing", async () => {
    const result = await capture(["dev", "--target", "handset"], {
      script: [{ match: "placeholder-device-tool list --json", result: { code: 3, stderr: "not authorised" } }],
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("the device probe failed");
    expect(spawned(result.seams)).toEqual(["placeholder-device-tool list --json"]);
  });

  it("does not run the after-steps when the verb itself did not exit 0", async () => {
    // Installing a build that failed to build is not a thing to attempt.
    const result = await capture(["dev", "--target", "sim"], {
      script: [{ match: "pnpm exec next dev --placeholder-simulated", result: { code: 2 } }],
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("was not run");
    expect(spawned(result.seams)).toEqual(["pnpm exec next dev --placeholder-simulated"]);
  });

  it("exits 1 on a failing after-step, saying which half of the launch failed", async () => {
    const result = await capture(["dev", "--target", "sim"], {
      script: [
        ok("pnpm exec next dev --placeholder-simulated"),
        {
          match: "placeholder-launcher open --device Placeholder Handset 9",
          result: { code: 7, stderr: "device is locked" },
        },
      ],
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("The build ran; getting it onto the device did not.");
  });

  it("refuses at 5 when an after-step's program is not installed", async () => {
    const result = await capture(["dev", "--target", "sim"], {
      script: [
        ok("pnpm exec next dev --placeholder-simulated"),
        {
          match: "placeholder-launcher open --device Placeholder Handset 9",
          result: { spawnFailed: true, stderr: "no such file" },
        },
      ],
    });
    expect(result.code).toBe(5);
    expect(result.err.join("\n")).toContain("after-step 1 of 1 could not be started");
  });
});

describe("the tokens a launch target may name, and what must exist to fill them", () => {
  it("substitutes {artifact} with the FIRST artifact the verb declares", async () => {
    const result = await withDeclaration(
      launchable(
        {
          box: {
            verb: "dev",
            device: { name: "Bench", kind: "simulator" },
            after: [{ exe: "placeholder-installer", argv: ["put", "{artifact}", "--on", "{device.id}"] }],
          },
        },
        { exe: "placeholder-tool", argv: ["serve"], artifacts: ["out/app", "out/second"] },
      ),
      ["dev", "--target", "box"],
      { script: [ok("placeholder-tool serve"), ok("placeholder-installer put out/app --on Bench")] },
    );
    expect(result.code).toBe(0);
    expect(spawned(result.seams)).toEqual([
      "placeholder-tool serve",
      "placeholder-installer put out/app --on Bench",
    ]);
  });

  it("refuses {artifact} on a verb that declares none, before anything spawns", async () => {
    const result = await withDeclaration(
      launchable({
        box: {
          verb: "dev",
          device: { name: "Bench", kind: "simulator" },
          after: [{ exe: "placeholder-installer", argv: ["put", "{artifact}"] }],
        },
      }),
      ["dev", "--target", "box", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("declares no artifacts");
  });

  it("refuses {device.id} on a target that declares no device", async () => {
    const result = await withDeclaration(
      launchable({
        box: { verb: "dev", after: [{ exe: "placeholder-launcher", argv: ["open", "{device.id}"] }] },
      }),
      ["dev", "--target", "box", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("names {device.id} in an after-step and declares no device");
  });

  it("refuses a device that says neither how to find its id nor that it needs none", async () => {
    const result = await withDeclaration(
      launchable({ box: { verb: "dev", device: { name: "Bench", kind: "handset" } } }),
      ["dev", "--target", "box", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("says neither how to find its id nor that it needs none");
  });

  it("refuses a target's args on a multi-step verb, naming the DEVICE", async () => {
    const result = await withDeclaration(
      launchable(
        { box: { verb: "dev", args: ["--flag"], device: { name: "Bench", kind: "simulator" } } },
        { steps: [{ exe: "placeholder-tool", argv: ["one"] }, { exe: "placeholder-tool", argv: ["two"] }] },
      ),
      ["dev", "--target", "box", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("will not guess which of them reaches the device");
  });

  it("refuses one of the reference pack's own placeholders in an after-step", async () => {
    const result = await withDeclaration(
      launchable({
        box: {
          verb: "dev",
          device: { name: "Bench", kind: "simulator" },
          after: [{ exe: "placeholder-launcher", argv: ["open", "{scheme}"] }],
        },
      }),
      ["dev", "--target", "box", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("{scheme}");
  });
});

// ── (i.2) the two per-target overrides: `lane` and `artifact` ──────────────
//
// THE TWO DEFAULTS A LAUNCH TARGET IS THE WRONG PLACE FOR. `defaultLane` is the
// lane a developer ITERATES in, and `artifacts[0]` is the thing a lane BUILDS --
// while a launch is the one operation that cares about a DEVICE build and the
// thing an installer TAKES, which are routinely a different lane and a later
// artifact. The fixture's `install` row declares both at once, because in the
// field they arrive together: the signed package the second lane produces.

describe("a launch target may name its own lane, and the verb is read from THAT lane", () => {
  it("runs the target's lane rather than defaultLane, end to end", async () => {
    const result = await capture(["dev", "--target", "install"], {
      script: [
        {
          match: "placeholder-device-tool list --json",
          result: {
            code: 0,
            stdout: JSON.stringify({
              devices: [{ name: "Placeholder Handset Pro", udid: "U-0001" }],
            }),
          },
        },
        ok("placeholder-build-tool -destination generic/platform=placeholder-device build"),
        ok(
          "placeholder-installer install --device U-0001 build/device/Placeholder.signed",
        ),
      ],
    });
    expect(result.code).toBe(0);
    // THE MIDDLE THIRD IS THE `device` LANE'S ARGV, not `web`'s `pnpm exec next
    // dev`. That one line is the whole feature: without it the installer would
    // put a simulator build on a handset and report success.
    expect(spawned(result.seams)).toEqual([
      "placeholder-device-tool list --json",
      "placeholder-build-tool -destination generic/platform=placeholder-device build",
      "placeholder-installer install --device U-0001 build/device/Placeholder.signed",
    ]);
    expect(result.out.join("\n")).toContain("lane:          device");
  });

  it("says on the target line WHOSE decision the lane was", async () => {
    // `lane:` already carries the name. What it cannot say is whether the
    // caller asked for it, and a cross-lane launch mistaken for one is exactly
    // the misreading this clause exists to prevent.
    const result = await capture(["dev", "--target", "install", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain(
      "target:        install  (appends no argument)  -- on lane 'device', which this target declares",
    );
    // AND A TARGET THAT NAMES NO LANE SAYS NOTHING -- the clause is not decoration.
    const plain = await capture(["dev", "--target", "sim", "--dry-run"]);
    expect(plain.out.join("\n")).toContain("target:        sim  (appends: --placeholder-simulated)");
    expect(plain.out.join("\n")).not.toContain("which this target declares");
  });

  it("refuses an EXPLICIT --lane that disagrees with the target's own", async () => {
    // TWO STATED FACTS, AND NEN PICKS BETWEEN STATED FACTS NOWHERE. Honouring
    // the flag would run the wrong build; honouring the declaration would
    // ignore an instruction the caller typed.
    const result = await capture(["dev", "--lane", "web", "--target", "install", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain(
      "--lane 'web' and launch target 'install' disagree: project.launch.install.lane says 'device'",
    );
    expect(result.seams.calls).toEqual([]);
  });

  it("accepts a --lane that AGREES, because there is nothing to pick between", async () => {
    const result = await capture(["dev", "--lane", "device", "--target", "install", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("lane:          device");
  });

  it("reaches a target whose lane is the ONLY one declaring the verb", async () => {
    // THE CASE THE FIXTURE CANNOT MAKE, and the one the key exists for. In the
    // fixture `web` declares its own `dev`, so the override is a preference:
    // the launch renders on `web` first and would have worked either way. Here
    // the default lane declares no `dev` at all, so if the target's lane is
    // read AFTER the invocation has been rendered, the run is refused at exit 4
    // by the very lane the declaration overrode -- and `--lane device`, the flag
    // this key exists to make unnecessary, becomes the only way through.
    const project = {
      lanes: {
        web: { stack: "placeholder-web", cwd: "." },
        device: { stack: "placeholder-device", cwd: "." },
      },
      defaultLane: "web",
      verbs: {
        web: { build: { exe: "placeholder-web-tool", argv: ["build"] } },
        device: {
          dev: {
            exe: "placeholder-build-tool",
            argv: ["build"],
            artifacts: ["build/Placeholder.app"],
          },
        },
      },
      launch: {
        install: {
          verb: "dev",
          lane: "device",
          after: [{ exe: "placeholder-installer", argv: ["install", "{artifact}"] }],
        },
      },
    };
    const result = await withDeclaration(project, ["dev", "--target", "install", "--dry-run"], {
      platform: "darwin",
    });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("lane:          device");
    expect(result.out.join("\n")).toContain("would run:     placeholder-build-tool build");
    // AND WITHOUT THE FIX this is the line that came back instead:
    expect(result.err.join("\n")).not.toContain("lane 'web' (placeholder-web) declares no 'dev'");
  });

  it("still lets the target's OWN refusals speak first, on the caller's lane", async () => {
    // `launchLane` answers null for a seat, for the other verb and for an
    // undeclared name, so each of those sentences is still about the lane the
    // caller named rather than one they never typed.
    const project = {
      lanes: {
        web: { stack: "placeholder-web", cwd: "." },
        device: { stack: "placeholder-device", cwd: "." },
      },
      defaultLane: "web",
      verbs: {
        web: { dev: { exe: "placeholder-web-tool", argv: ["dev"] } },
        device: { dev: { exe: "placeholder-build-tool", argv: ["build"] } },
      },
      launch: {
        // A SEATED TARGET CARRIES NO `lane` -- the loader refuses the pair -- so
        // this is the arm where there is nothing for `launchLane` to read.
        seated: { unsupported: "no device is wired up yet." },
        // AND THIS ONE HAS A LANE and belongs to the other verb, which is the
        // arm where `launchLane` has a value and deliberately does not use it.
        shipped: {
          verb: "run",
          lane: "device",
          after: [{ exe: "placeholder-installer", argv: ["put"] }],
        },
      },
    };
    const seat = await withDeclaration(project, ["dev", "--target", "seated", "--dry-run"], {
      platform: "darwin",
    });
    expect(seat.code).toBe(4);
    expect(seat.err.join("\n")).toContain("no device is wired up yet.");
    expect(seat.err.join("\n")).toContain("on lane 'web' (placeholder-web)");

    const other = await withDeclaration(project, ["dev", "--target", "shipped", "--dry-run"], {
      platform: "darwin",
    });
    expect(other.code).toBe(2);
    expect(other.err.join("\n")).toContain(
      "launch target 'shipped' is declared for 'run', and this is 'dev'",
    );
  });
});

describe("a launch token written into `args` is refused, not delivered as itself", () => {
  it("refuses {artifact} in project.launch.<name>.args at exit 2", async () => {
    // SUBSTITUTION REACHES `after` AND NOWHERE ELSE. `unsubstituted` cannot
    // catch this: it filters on the REFUSED set, which excludes both launch
    // tokens by construction, so before this refusal the token reached the
    // child argv verbatim.
    const project = oneLane(
      {
        verbs: {
          only: {
            dev: {
              exe: "placeholder-tool",
              argv: ["serve"],
              artifacts: ["build/Placeholder.app"],
            },
          },
        },
        launch: {
          box: {
            verb: "dev",
            args: ["--out", "{artifact}"],
            after: [{ exe: "placeholder-installer", argv: ["put", "{artifact}"] }],
          },
        },
      },
      undefined,
    );
    const result = await withDeclaration(project, ["dev", "--target", "box", "--dry-run"], {
      platform: "darwin",
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain(
      "launch target 'box' names {artifact} in project.launch.box.args",
    );
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses {device.id} there too, and names both when both are written", async () => {
    const project = oneLane(
      {
        verbs: { only: { dev: { exe: "placeholder-tool", argv: ["serve"] } } },
        launch: {
          box: {
            verb: "dev",
            args: ["--device", "{device.id}"],
            device: { name: "Placeholder Simulator", kind: "simulator" },
            after: [{ exe: "placeholder-installer", argv: ["put", "{device.id}"] }],
          },
        },
      },
      undefined,
    );
    const result = await withDeclaration(project, ["dev", "--target", "box", "--dry-run"], {
      platform: "darwin",
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain(
      "launch target 'box' names {device.id} in project.launch.box.args",
    );
    expect(result.err.join("\n")).toContain("in the target's 'after' steps only");
  });
});

describe("a launch target may name the artifact {artifact} stands for", () => {
  it("substitutes the target's own path, not the verb's first entry", async () => {
    // The fixture's `device` lane declares TWO artifacts, in build order; the
    // installer takes the second, and `{artifact}` alone can only ever be the
    // first.
    const result = await capture(["dev", "--target", "install"], {
      script: [
        {
          match: "placeholder-device-tool list --json",
          result: {
            code: 0,
            stdout: JSON.stringify([{ name: "Placeholder Handset Pro", udid: "U-9" }]),
          },
        },
        ok("placeholder-build-tool -destination generic/platform=placeholder-device build"),
        ok("placeholder-installer install --device U-9 build/device/Placeholder.signed"),
      ],
    });
    expect(result.code).toBe(0);
    expect(spawned(result.seams).at(-1)).toBe(
      "placeholder-installer install --device U-9 build/device/Placeholder.signed",
    );
  });

  it("names the override AS an override on the dry run's substitutes line", async () => {
    // A path that is not `artifacts[0]`, printed with no explanation, reads as
    // nen having taken the wrong entry rather than as the declaration saying so.
    const result = await capture(["dev", "--target", "install", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(wouldRun(result.out)).toEqual([
      "placeholder-device-tool list --json",
      "placeholder-build-tool -destination generic/platform=placeholder-device build",
      "placeholder-installer install --device {device.id} {artifact}",
    ]);
    expect(result.out.join("\n")).toContain(
      "{artifact} <- build/device/Placeholder.signed  (project.launch.install.artifact, not the verb's own)",
    );
    // THE `artifacts:` LINE STILL SAYS WHAT THE VERB DECLARES. The two answer
    // different questions -- what this build produces, and what this target
    // installs -- and collapsing them would hide the override rather than show it.
    expect(result.out.join("\n")).toContain("build/device/Placeholder.app");
    expect(result.seams.calls).toEqual([]);
  });

  it("carries lane and artifact in the --dry-run --json document", async () => {
    const result = await capture(["dev", "--target", "install", "--dry-run", "--json"]);
    const report = JSON.parse(result.out.join("\n")) as {
      lane: string;
      target: { name: string; lane: string | null; artifact: string | null };
    };
    expect(report.lane).toBe("device");
    expect(report.target.lane).toBe("device");
    expect(report.target.artifact).toBe("build/device/Placeholder.signed");
  });

  it("leaves both null on a target that declares neither", async () => {
    const result = await capture(["dev", "--target", "handset", "--dry-run", "--json"]);
    const report = JSON.parse(result.out.join("\n")) as {
      target: { lane: string | null; artifact: string | null };
    };
    expect(report.target.lane).toBeNull();
    expect(report.target.artifact).toBeNull();
  });

  it("lets a target's artifact stand in for a verb that declares none", async () => {
    // The refusal above ("declares no artifacts") is about a token nothing can
    // fill. A target that supplies the path HAS filled it, so the refusal must
    // not fire -- and the after-step gets the declared path.
    const result = await withDeclaration(
      launchable({
        box: {
          verb: "dev",
          artifact: "out/signed/app",
          device: { name: "Bench", kind: "simulator" },
          after: [{ exe: "placeholder-installer", argv: ["put", "{artifact}"] }],
        },
      }),
      ["dev", "--target", "box"],
      { script: [ok("placeholder-tool serve"), ok("placeholder-installer put out/signed/app")] },
    );
    expect(result.code).toBe(0);
    expect(spawned(result.seams).at(-1)).toBe("placeholder-installer put out/signed/app");
  });

  it("refuses an artifact that resolves outside the tree, before anything spawns", async () => {
    const result = await withDeclaration(
      launchable({
        box: {
          verb: "dev",
          artifact: "../outside/app",
          device: { name: "Bench", kind: "simulator" },
          after: [{ exe: "placeholder-installer", argv: ["put", "{artifact}"] }],
        },
      }),
      ["dev", "--target", "box", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("project.launch.box.artifact names '../outside/app'");
    expect(result.err.join("\n")).toContain("resolves outside the repository");
    // A DRY RUN THAT PRINTED THE PLAN FIRST would have told the caller the
    // declaration is fine, which is why the check runs before the report.
    expect(result.out.join("\n")).not.toContain("would run:");
    expect(result.seams.calls).toEqual([]);
  });

  it("leaves the after-step's tokens UNFILLED while still saying what it would read", async () => {
    // THE DRY RUN'S WHOLE CONTRACT, ON THE ONE SUBSTITUTION THAT NEEDS NO PROBE.
    // `{artifact}` is knowable without spawning anything, and it would be easy
    // to fill it in the printed step "because we know it" -- which would make
    // the two tokens on the same line behave differently and make the printed
    // argv something other than what a real run would compose from. So the step
    // keeps BOTH tokens as themselves, and the `substitutes:` line is where the
    // value is stated. The `--json` document says the same thing twice over:
    // `after` verbatim, `target.artifact` resolved.
    const result = await capture(["dev", "--target", "install", "--dry-run", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as {
      target: { artifact: string | null; after: readonly { argv: readonly string[] }[] };
      artifacts: readonly { value: string }[];
      log: { mode: string };
    };
    expect(report.target.after[0]?.argv).toEqual([
      "install",
      "--device",
      "{device.id}",
      "{artifact}",
    ]);
    expect(report.target.artifact).toBe("build/device/Placeholder.signed");
    // AND THE `artifacts` DOCUMENT IS STILL THE VERB'S OWN LIST, both entries in
    // declaration order, with the override sitting beside it rather than inside it.
    expect(report.artifacts.map((entry): string => entry.value)).toEqual([
      "build/device/Placeholder.app",
      "build/device/Placeholder.signed",
    ]);
    expect(report.log.mode).toBe("dry-run");
    expect(result.seams.calls).toEqual([]);
  });

  it("renders the same on `run`, which is the other verb a target may hang off", async () => {
    // `LAUNCHING_VERBS` is two, and every rule above was proved on `dev`. A
    // target on `run` is a PRODUCTION build -- the one whose signed artifact is
    // most likely to be the second entry -- so the overrides have to render
    // there too, and on the lane the target names rather than the default.
    const result = await withDeclaration(
      {
        lanes: {
          quick: { stack: "placeholder-stack", cwd: "." },
          shipping: { stack: "placeholder-stack", cwd: "." },
        },
        defaultLane: "quick",
        verbs: {
          quick: { run: { exe: "placeholder-tool", argv: ["serve"] } },
          shipping: {
            run: { exe: "placeholder-tool", argv: ["serve", "--release"], artifacts: ["out/app"] },
          },
        },
        launch: {
          ship: {
            verb: "run",
            lane: "shipping",
            artifact: "out/app.signed",
            device: { name: "Bench", kind: "simulator" },
            after: [{ exe: "placeholder-installer", argv: ["put", "{artifact}", "{device.id}"] }],
          },
        },
      },
      ["run", "--target", "ship", "--dry-run"],
    );
    expect(result.code).toBe(0);
    expect(wouldRun(result.out)).toEqual([
      "placeholder-tool serve --release",
      "placeholder-installer put {artifact} {device.id}",
    ]);
    expect(result.out.join("\n")).toContain("lane:          shipping");
    expect(result.out.join("\n")).toContain(
      "-- on lane 'shipping', which this target declares",
    );
    expect(result.out.join("\n")).toContain(
      "{artifact} <- out/app.signed  (project.launch.ship.artifact, not the verb's own)",
    );
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses an artifact no after-step names, rather than reading a path nowhere", async () => {
    const result = await withDeclaration(
      launchable({
        box: {
          verb: "dev",
          artifact: "out/signed/app",
          device: { name: "Bench", kind: "simulator" },
          after: [{ exe: "placeholder-launcher", argv: ["open", "{device.id}"] }],
        },
      }),
      ["dev", "--target", "box", "--dry-run"],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("declares an artifact and no after-step names {artifact}");
  });
});

describe("a launch target hangs off a verb that hands over the terminal", () => {
  it("names exactly the verbs that go through the interactive seam", () => {
    // THE TWO LISTS MUST AGREE, and they are computed in different modules for
    // different reasons: `INTERACTIVE_VERBS` is about which seam a verb uses,
    // `LAUNCHING_VERBS` is the schema's closed set for `project.launch.<n>.verb`.
    // A launch target hanging off a CAPTURED verb would resolve a device and
    // then never hand anybody a terminal.
    expect([...LAUNCHING_VERBS].sort()).toEqual([...INTERACTIVE_VERBS].sort());
  });
});

describe("a name two devices carry is a refusal, not a choice", () => {
  it("exits 5 naming both candidates, and launches nothing", async () => {
    // `Placeholder Handset Pro` is the fixture's declared name; a probe whose
    // output carries it on two id-bearing lines -- the device and a longer one
    // it is the beginning of -- is exactly the case a plain `includes` cannot
    // tell apart, so nen resolves neither.
    const result = await capture(["dev", "--target", "handset"], {
      script: [
        {
          match: "placeholder-device-tool list --json",
          result: {
            code: 0,
            stdout: [
              "Placeholder Handset Pro      PH-0001  connected",
              "Placeholder Handset Pro Max  PH-0002  connected",
            ].join("\n"),
          },
        },
      ],
    });
    expect(result.code).toBe(5);
    expect(result.err.join("\n")).toContain("matches 2 of the probe's own lines");
    expect(result.err.join("\n")).toContain("PH-0001");
    expect(result.err.join("\n")).toContain("PH-0002");
    expect(spawned(result.seams)).toEqual(["placeholder-device-tool list --json"]);
  });

  it("exits 5 when two JSON objects share the name and disagree about the id", async () => {
    const result = await capture(["dev", "--target", "handset"], {
      script: [
        {
          match: "placeholder-device-tool list --json",
          result: {
            code: 0,
            stdout: JSON.stringify([
              { name: "Placeholder Handset Pro", udid: "U-1" },
              { name: "Placeholder Handset Pro", udid: "U-2" },
            ]),
          },
        },
      ],
    });
    expect(result.code).toBe(5);
    expect(result.err.join("\n")).toContain("matches 2 devices the probe reported");
  });
});

// ── the stall guard ─────────────────────────────────────────────────────────
//
// NOTHING HERE SLEEPS. The budgets below are three minutes and one minute, and
// every one of these tests runs in microseconds: the scripted streaming seam
// (../seam/scripted.ts) replays a TIMELINE the fixture states, and the elapsed/
// quiet arithmetic it feeds the guard is the seam's own `outputWindow` -- the
// same function the real runner calls against a real clock. So what is proved
// here is the guard's decisions, on the numbers a declaration writes, without a
// single real millisecond.
//
// THE REMEDY IS THE REPOSITORY'S. `placeholder-killer` is a fixture name; nen
// has no idea what it does and never will. ./purity.test.ts is what keeps that
// true of the shipped modules.

const KILLER = "placeholder-killer -9 -f placeholder-pattern";

const STALL_GUARD = {
  elapsedMs: 180_000,
  quietMs: 60_000,
  onStall: { exe: "placeholder-killer", argv: ["-9", "-f", "placeholder-pattern"] },
};

/** A one-lane declaration whose `build` carries a stall guard. */
function guarded(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return oneLane({}, { exe: "placeholder-tool", argv: ["go"], stall: { ...STALL_GUARD, ...overrides } });
}

/** A scripted build whose timeline is a list of instants. */
function timeline(
  events: readonly { atMs: number; stream?: "stdout" | "stderr"; text?: string }[],
  code = 0,
  exitAtMs?: number,
): ScriptedCall {
  return {
    match: "placeholder-tool go",
    result: { code, stream: { events, ...(exitAtMs === undefined ? {} : { exitAtMs }) } },
  };
}

interface StallJson {
  readonly steps: readonly {
    readonly exitCode: number | null;
    readonly stall: {
      readonly elapsedMs: number;
      readonly quietMs: number;
      readonly maxStrikes: number;
      readonly onStall: { readonly exe: string; readonly argv: readonly string[] };
      readonly strikes: number;
      readonly at: readonly number[];
      readonly stalled: boolean;
    } | null;
  }[];
  readonly exitCode: number;
}

const stallOf = (result: Captured): StallJson["steps"][number]["stall"] =>
  (JSON.parse(result.out.join("\n")) as StallJson).steps[0]?.stall ?? null;

describe("a stall guard: BOTH budgets, the repository's own remedy, and no kill", () => {
  it("prints the budgets and the remedy on a dry run, and spawns nothing", async () => {
    const result = await withDeclaration(guarded(), ["build", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain(
      `on stall:      after 180000ms elapsed AND 60000ms with no output: ${KILLER}  (up to 2 times)`,
    );
    expect(result.seams.calls).toEqual([]);
  });

  it("carries the declared guard in --json even when nothing ran", async () => {
    const result = await withDeclaration(guarded(), ["build", "--dry-run", "--json"]);
    expect(stallOf(result)).toEqual({
      elapsedMs: 180_000,
      quietMs: 60_000,
      maxStrikes: 2,
      onStall: { exe: "placeholder-killer", argv: ["-9", "-f", "placeholder-pattern"] },
      strikes: 0,
      at: [],
      stalled: false,
    });
  });

  it("fires NOTHING while the step keeps talking", async () => {
    const result = await withDeclaration(guarded(), ["build", "--json"], {
      script: [
        timeline([
          { atMs: 100_000, stream: "stdout", text: "still compiling\n" },
          // Well past the elapsed budget, but it spoke 10 seconds ago.
          { atMs: 190_000, stream: "stdout", text: "still going\n" },
          { atMs: 200_000 },
          { atMs: 250_000, stream: "stdout", text: "linking\n" },
          { atMs: 300_000 },
        ]),
      ],
    });
    expect(result.code).toBe(0);
    expect(stallOf(result)).toMatchObject({ strikes: 0, at: [], stalled: false });
    expect(spawned(result.seams)).toEqual(["placeholder-tool go"]);
  });

  it("fires NOTHING on a long quiet stretch that is still inside the elapsed budget", async () => {
    // THE HALF OF THE RULE THAT MATTERS MOST. This step has said nothing for its
    // whole life -- 170 seconds of silence, well past the 60-second quiet window
    // -- and is not touched, because it is not yet past the elapsed budget. A
    // guard that acted on silence alone would kill a healthy compile here.
    const result = await withDeclaration(guarded(), ["build", "--json"], {
      script: [timeline([{ atMs: 100_000 }, { atMs: 170_000 }], 0, 175_000)],
    });
    expect(result.code).toBe(0);
    expect(stallOf(result)).toMatchObject({ strikes: 0, stalled: false });
    expect(spawned(result.seams)).toEqual(["placeholder-tool go"]);
  });

  it("runs the declared remedy once BOTH budgets are past, and resets the quiet window", async () => {
    const result = await withDeclaration(guarded(), ["build", "--json"], {
      script: [
        timeline([
          { atMs: 100_000, stream: "stdout", text: "compiling\n" },
          // 185s in, 85s quiet: past both. One strike.
          { atMs: 185_000 },
          // 200s in, and only 15s since the remedy ran -- the reset is why this
          // tick does not fire a second one.
          { atMs: 200_000 },
          { atMs: 210_000, stream: "stdout", text: "unwedged, linking\n" },
        ], 0, 220_000),
        { match: KILLER, result: { code: 0 } },
      ],
    });
    expect(result.code).toBe(0);
    expect(stallOf(result)).toMatchObject({ strikes: 1, at: [185_000], stalled: false });
    // The remedy went through the CAPTURED seam, like every other declared step.
    expect(spawned(result.seams)).toEqual(["placeholder-tool go", KILLER]);
    expect(result.err.join("\n")).toContain("strike 1 of 2");
  });

  it("recovering after every strike is the guard WORKING: the run is green", async () => {
    const result = await withDeclaration(guarded(), ["build", "--json"], {
      script: [
        timeline([
          { atMs: 185_000 },
          { atMs: 250_000 },
          { atMs: 260_000, stream: "stdout", text: "done\n" },
        ], 0, 270_000),
        { match: KILLER, result: { code: 0 } },
      ],
    });
    expect(result.code).toBe(0);
    expect(stallOf(result)).toMatchObject({ strikes: 2, stalled: false });
    expect((JSON.parse(result.out.join("\n")) as StallJson).steps[0]?.exitCode).toBe(0);
  });

  it("stalls at exit 1 once every strike is spent, WITHOUT killing the step", async () => {
    const result = await withDeclaration(guarded(), ["build", "--json"], {
      script: [
        timeline([{ atMs: 185_000 }, { atMs: 250_000 }, { atMs: 320_000 }], 0, 999_999),
        { match: KILLER, result: { code: 0 } },
      ],
    });
    expect(result.code).toBe(1);
    const stall = stallOf(result);
    expect(stall).toMatchObject({ strikes: 2, at: [185_000, 250_000], stalled: true });
    // NO CODE, because the step never gave one: nen stopped waiting and left it
    // running. A number here would be a verdict nobody reached.
    expect((JSON.parse(result.out.join("\n")) as StallJson).steps[0]?.exitCode).toBeNull();
    // TWO REMEDIES AND NOT ONE MORE THING. Every call the seam took is either
    // the declared step or the declared remedy -- nen signalled nothing.
    expect(spawned(result.seams)).toEqual(["placeholder-tool go", KILLER, KILLER]);
    const err = result.err.join("\n");
    expect(err).toContain("is STALLED");
    expect(err).toContain("STILL RUNNING and is yours to stop");
  });

  it("honours a declared maxStrikes instead of the default two", async () => {
    const result = await withDeclaration(guarded({ maxStrikes: 1 }), ["build", "--json"], {
      script: [
        timeline([{ atMs: 185_000 }, { atMs: 250_000 }], 0, 999_999),
        { match: KILLER, result: { code: 0 } },
      ],
    });
    expect(result.code).toBe(1);
    expect(stallOf(result)).toMatchObject({ maxStrikes: 1, strikes: 1, stalled: true });
  });

  it("says so, and carries on, when the declared remedy cannot be started", async () => {
    // The step has NOT failed -- it may still recover on its own -- and what
    // has failed is the repository's own remedy. That is a fact its maintainer
    // needs and not a reason for nen to give up on a running process.
    const result = await withDeclaration(guarded(), ["build", "--json"], {
      script: [
        timeline([{ atMs: 185_000 }, { atMs: 260_000, stream: "stdout", text: "recovered\n" }], 0, 270_000),
        { match: KILLER, result: { spawnFailed: true, stderr: "not found" } },
      ],
    });
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toContain("the declared remedy could not be started");
    expect(stallOf(result)).toMatchObject({ strikes: 1, stalled: false });
  });

  it("reports a remedy's own non-zero exit and never acts on it", async () => {
    // The canonical remedy is a targeted kill, and a kill that matched nothing
    // exits non-zero -- the ordinary answer when the wedged process is already
    // gone.
    const result = await withDeclaration(guarded(), ["build", "--json"], {
      script: [
        timeline([{ atMs: 185_000 }, { atMs: 260_000, stream: "stdout", text: "on we go\n" }], 0, 270_000),
        { match: KILLER, result: { code: 1, stderr: "no process matched" } },
      ],
    });
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toContain("no process matched");
  });

  it("relays a watched step's output as LINES, however the chunks fell", async () => {
    const result = await withDeclaration(guarded(), ["build"], {
      script: [
        timeline([
          { atMs: 1, stream: "stdout", text: "half a li" },
          { atMs: 2, stream: "stdout", text: "ne\nand another\n" },
          { atMs: 3, stream: "stdout", text: "no trailing newline" },
        ]),
      ],
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain("half a line");
    expect(result.out).toContain("and another");
    // FLUSHED AT THE END: a tool whose last line carries no newline still said it.
    expect(result.out).toContain("no trailing newline");
  });

  it("applies an invocation-level guard to every step that declares none", async () => {
    const project = oneLane({}, {
      steps: [
        { exe: "placeholder-tool", argv: ["one"] },
        { exe: "placeholder-tool", argv: ["two"], stall: { ...STALL_GUARD, elapsedMs: 1_000, quietMs: 500 } },
      ],
      stall: STALL_GUARD,
    });
    const result = await withDeclaration(project, ["build", "--dry-run", "--json"]);
    const report = JSON.parse(result.out.join("\n")) as StallJson;
    expect(report.steps[0]?.stall).toMatchObject({ elapsedMs: 180_000, quietMs: 60_000 });
    // THE STEP'S OWN WINS. A multi-step row is routinely one slow compile and
    // three fast bookkeeping commands.
    expect(report.steps[1]?.stall).toMatchObject({ elapsedMs: 1_000, quietMs: 500 });
  });

  it("leaves an unguarded step on the captured seam, untouched", async () => {
    const result = await withDeclaration(oneLane(), ["build", "--json"], {
      script: [{ match: "placeholder-tool go", result: { code: 0 } }],
    });
    expect(result.code).toBe(0);
    expect(stallOf(result)).toBeNull();
    expect(result.seams.calls[0]?.streamed).toBeUndefined();
  });

  it("refuses a guard on a verb whose output nen never sees", async () => {
    const project = oneLane(
      { verbs: { only: { dev: { exe: "placeholder-tool", argv: ["serve"], stall: STALL_GUARD } } } },
    );
    const result = await withDeclaration(project, ["dev", "--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("nen cannot honour one on this verb");
    expect(result.err.join("\n")).toContain("build, test, ui-test, lint, archive, coverage, test-report");
  });

  it("refuses a budget that is not a positive whole number, by pointer, at load", async () => {
    for (const [block, pointer] of [
      [{ elapsedMs: 0 }, "stall.elapsedMs"],
      [{ quietMs: -1 }, "stall.quietMs"],
      [{ elapsedMs: 1.5 }, "stall.elapsedMs"],
      [{ maxStrikes: 0 }, "stall.maxStrikes"],
    ] as const) {
      const result = await withDeclaration(guarded(block), ["build", "--dry-run"]);
      expect(result.code, JSON.stringify(block)).toBe(1);
      expect(result.err.join("\n")).toContain(`project.verbs.only.build.${pointer}`);
    }
  });

  it("refuses a remedy written as a string -- there is no shell to hand it to", async () => {
    const result = await withDeclaration(
      guarded({ onStall: "placeholder-killer -9 placeholder-pattern" }),
      ["build", "--dry-run"],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("project.verbs.only.build.stall.onStall");
  });

  it("refuses a guard with no remedy at all", async () => {
    const result = await withDeclaration(
      { ...oneLane({}, { exe: "placeholder-tool", argv: ["go"], stall: { elapsedMs: 1, quietMs: 1 } }) },
      ["build", "--dry-run"],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("stall.onStall");
  });

  it("refuses a key one spelling away from one it reads, naming the key it meant", async () => {
    const result = await withDeclaration(
      guarded({ maxStrike: 3 } as unknown as Record<string, number>),
      ["build", "--dry-run"],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("maxStrikes");
  });
});
