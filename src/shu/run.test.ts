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
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { SHU_REPO } from "../schema/fixtures/paths.js";
import { shuCommand } from "./command.js";

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
      expect(result.code).toBe(0);
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
    expect(result.out.join("\n")).toMatch(/FAIL {2}path {2}native\/deps -- not present/);
  });

  it("refuses at exit 2 when a declared env variable is not set", async () => {
    const result = await capture(["build"], { env: {} });
    expect(result.code).toBe(2);
    expect(result.seams.calls).toEqual([]);
    expect(result.out.join("\n")).toMatch(new RegExp(`FAIL {2}env {3}${TOKEN}`));
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
    // `archive` is unsupported on `web`, and `web`'s hosts allow every platform;
    // on a platform the declaration excludes for another verb, the answer must
    // still be 4 rather than sending a developer to a different machine.
    const result = await capture(["archive"], { platform: "win32" });
    expect(result.code).toBe(4);
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
    const result = await capture(["dev", "--json"], { script: [ok("pnpm exec next dev")] });
    const report = JSON.parse(result.out.join("\n")) as {
      log: { mode: string };
      exitCode: number | null;
      steps: readonly { exitCode: number | null }[];
    };
    expect(report.log.mode).toBe("interactive");
    expect(report.exitCode).toBeNull();
    expect(report.steps[0]?.exitCode).toBeNull();
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
    // The scripted seam matches on argv alone, so this asserts the pairing at
    // the point it matters: the run succeeded, and no output carried the value.
    const result = await capture(["run"], { script: [ok("pnpm exec next start")] });
    expect(result.code).toBe(0);
    expect([...result.out, ...result.err].join("\n")).not.toContain(DECLARED_ENV_VALUE);
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

// ── (h) the verbs that are declared and not yet built ──────────────────────

describe("the two verbs that refuse by name", () => {
  for (const verb of ["tools", "warmup"]) {
    it(`'${verb}' refuses at 4 saying it is not implemented yet, and names the release`, async () => {
      const result = await capture([verb]);
      expect(result.code).toBe(4);
      expect(result.err.join("\n")).toMatch(/not implemented yet in this release/);
      expect(result.err.join("\n")).toMatch(/zheref\/nen#91/);
    });
  }
});
