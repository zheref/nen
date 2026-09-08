// src/shu/warmup.test.ts -- `nen shu warmup`, driven through the REAL dispatch
// (../index.ts's runFamily) so the flag re-parse, the --repo/--json merge and
// the error-to-exit-code mapping are the ones a caller gets.
//
// EVERY GIT CALL IS A SCRIPTED SEAM ENTRY, and ../seam/scripted.ts throws on a
// call nobody scripted -- so "warmup ran a git command this suite did not
// expect" is a FAILURE rather than a silent pass. That is the whole point here:
// this is the one verb in the family that mutates git state, and the argv it
// mutates with is the thing under test. The goldens below are complete command
// lines, in order, not substring matches.
//
// THE REAL `git` IS EXERCISED TOO, in ./warmup.integration.test.ts, against a
// temporary repository with a local bare-ish origin. A scripted seam proves nen
// sends the right argv; it cannot prove those argv mean what this file's author
// thought they meant, and "fetch, fast-forward, branch" is exactly the kind of
// claim that is wrong in a way only git can tell you.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { SHU_REPO } from "../schema/fixtures/paths.js";
import { EMPTY_TREE } from "./fixtures/paths.js";
import { shuCommand } from "./command.js";
import { WARMUP_CONTRACT } from "./warmup.js";

const TOKEN = "PLACEHOLDER_LANE_TOKEN";

interface Options {
  readonly script?: readonly ScriptedCall[];
  readonly repo?: string;
  readonly platform?: NodeJS.Platform;
  /** A clock that advances a second per read, so a duration is a real number. */
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
    env: { [TOKEN]: "a value no output may carry" },
    platform: options.platform ?? "linux",
    now: (): Date =>
      new Date(Date.UTC(2026, 0, 1) + (options.ticking === true ? (tick += 1) * 1000 : 0)),
  });
  const code = await runFamily(shuCommand, ["shu", ...argv], options.repo ?? SHU_REPO, false, io, seams);
  return { code, out, err, seams };
}

function ok(match: string, stdout = ""): ScriptedCall {
  return { match, result: { code: 0, stdout } };
}

/** Every recorded call as the whole command line, in order. */
function argvOf(seams: ScriptedSeams): readonly string[] {
  return seams.calls.map((call): string => [call.command, ...call.args].join(" "));
}

// ── the goldens ─────────────────────────────────────────────────────────────
//
// One constant per step, so a test about ONE of them names it rather than
// indexing into a list, and so the happy-path script and the ordering assertion
// are built from the same strings.

const BRANCH = "my-idea";
const HEAD = "git branch --show-current";
const STATUS = "git -c core.quotePath=false status --porcelain=v1 -z -uall";
const RESTORE = "git checkout -- .";
const CLEAN = "git clean -fd";
const REMOTES = "git remote";
const TRUNK_REF = "git show-ref --verify --quiet refs/heads/main";
const FETCH = "git fetch origin";
const ANCESTOR = "git merge-base --is-ancestor main origin/main";
const FF_REF = "git branch --force main origin/main";
const FF_MERGE = "git merge --ff-only origin/main";
const NAME_OK = `git check-ref-format --branch ${BRANCH}`;
const LOCAL_REF = `git show-ref --verify --quiet refs/heads/${BRANCH}`;
const REMOTE_REF = `git ls-remote --heads origin ${BRANCH}`;
const SWITCH = `git switch -c ${BRANCH} origin/main`;
const DECLARED_BUILD = "pnpm turbo run build";
const DECLARED_TEST = "pnpm exec vitest run";

/**
 * A clean checkout, on a branch that is not the trunk, whose trunk is behind
 * and whose branch name is free. Callers override one entry to make one thing
 * go wrong.
 */
function happyPath(overrides: readonly ScriptedCall[] = []): readonly ScriptedCall[] {
  const base: ScriptedCall[] = [
    ok(HEAD, "some-branch\n"),
    ok(STATUS),
    ok(REMOTES, "origin\n"),
    ok(TRUNK_REF),
    ok(FETCH),
    ok(ANCESTOR),
    ok(FF_REF),
    ok(NAME_OK, `${BRANCH}\n`),
    { match: LOCAL_REF, result: { code: 1 } },
    ok(REMOTE_REF),
    ok(SWITCH),
    ok(DECLARED_BUILD),
    ok(DECLARED_TEST),
    ok(RESTORE),
    ok(CLEAN),
  ];
  const overridden = new Set(overrides.map((entry): string => entry.match));
  return [...overrides, ...base.filter((entry): boolean => !overridden.has(entry.match))];
}

/** A `nen/contract.json` written into a temporary repository. */
async function withDeclaration(
  project: unknown,
  argv: readonly string[],
  options: Options = {},
): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "nen-warmup-"));
  try {
    mkdirSync(join(dir, "nen"));
    writeFileSync(join(dir, "nen", "contract.json"), JSON.stringify({ $schema: "nen.contract/v0.1", project }));
    return await capture(argv, { ...options, repo: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── (a) the order, which IS the design ──────────────────────────────────────

describe("the steps, in the one order they may run in", () => {
  it("classifies, then fetches, then branches, then verifies", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--tests"], { script: happyPath() });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toEqual([
      HEAD,
      STATUS,
      REMOTES,
      TRUNK_REF,
      FETCH,
      ANCESTOR,
      FF_REF,
      NAME_OK,
      LOCAL_REF,
      REMOTE_REF,
      SWITCH,
      DECLARED_BUILD,
      DECLARED_TEST,
    ]);
  });

  it("runs every git call in the repository --repo names, never in the process's own cwd", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], { script: happyPath() });
    const gitCalls = result.seams.calls.filter((call): boolean => call.command === "git");
    expect(gitCalls.length).toBeGreaterThan(8);
    for (const call of gitCalls) expect(call.cwd).toBe(SHU_REPO);
  });

  it("checks the branch-name and the branch-exists questions AFTER the fetch", async () => {
    // A stale remote-tracking ref would report a branch absent that the real
    // remote already has, so the existence question is only honest once the
    // fetch has answered.
    const argv = argvOf((await capture(["warmup", "--branch", BRANCH], { script: happyPath() })).seams);
    expect(argv.indexOf(FETCH)).toBeLessThan(argv.indexOf(REMOTE_REF));
    expect(argv.indexOf(FETCH)).toBeLessThan(argv.indexOf(SWITCH));
  });

  it("omits the declared test unless --tests is given", async () => {
    const argv = argvOf((await capture(["warmup", "--branch", BRANCH], { script: happyPath() })).seams);
    expect(argv).toContain(DECLARED_BUILD);
    expect(argv).not.toContain(DECLARED_TEST);
  });

  it("fast-forwards with a merge when the checkout is ON the trunk, and with a ref move when it is not", async () => {
    const onTrunk = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(HEAD, "main\n"), ok(FF_MERGE)]),
    });
    expect(onTrunk.code).toBe(0);
    expect(argvOf(onTrunk.seams)).toContain(FF_MERGE);
    expect(argvOf(onTrunk.seams)).not.toContain(FF_REF);

    const offTrunk = await capture(["warmup", "--branch", BRANCH], { script: happyPath() });
    expect(argvOf(offTrunk.seams)).toContain(FF_REF);
    expect(argvOf(offTrunk.seams)).not.toContain(FF_MERGE);
  });

  it("reports a detached HEAD rather than erroring on it", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], { script: happyPath([ok(HEAD, "\n")]) });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/HEAD is DETACHED -- reported, not an error/);
    // Detached is "not on the trunk", so the ref-moving form applies.
    expect(argvOf(result.seams)).toContain(FF_REF);
  });
});

// ── (b) --discard, and the -x that is never there ───────────────────────────

describe("a dirty working copy", () => {
  const DIRTY = "1M tracked.ts\0?? .env\0?? notes.md\0".replace("1", " ");

  it("refuses at 2, listing every path that would be lost, and stops before the fetch", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(STATUS, DIRTY)]),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const said = result.err.join("\n");
    expect(said).toMatch(/carries 3 uncommitted path\(s\)/);
    expect(said).toMatch(/ {2}M tracked\.ts/);
    expect(said).toMatch(/\?\? \.env {2}\[secret-shape\]/);
    expect(said).toMatch(/\?\? notes\.md/);
    expect(said).toMatch(/pass --discard/);
    expect(argvOf(result.seams)).toEqual([HEAD, STATUS]);
  });

  it("says, in the refusal itself, that ignored files are never touched", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], { script: happyPath([ok(STATUS, DIRTY)]) });
    expect(result.err.join("\n")).toMatch(/Ignored files are NEVER touched/);
    expect(result.err.join("\n")).toMatch(/without -x/);
  });

  it("with --discard, prints the exact list and then destroys it", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([ok(STATUS, DIRTY)]),
    });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toEqual([
      HEAD,
      STATUS,
      RESTORE,
      CLEAN,
      REMOTES,
      TRUNK_REF,
      FETCH,
      ANCESTOR,
      FF_REF,
      NAME_OK,
      LOCAL_REF,
      REMOTE_REF,
      SWITCH,
      DECLARED_BUILD,
    ]);
    const printed = result.out.join("\n");
    expect(printed).toMatch(/discarding 3 uncommitted path\(s\)/);
    expect(printed).toMatch(/\?\? \.env {2}\[secret-shape\]/);
  });

  it("with --discard on a CLEAN tree, discards nothing at all", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], { script: happyPath() });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).not.toContain(RESTORE);
    expect(argvOf(result.seams)).not.toContain(CLEAN);
  });

  it("NEVER passes -x to git clean, in any form of the verb", async () => {
    // The one assertion this file exists for. `git clean -fdx` deletes ignored
    // files -- a developer's caches, their .env, their build output -- and a
    // warm-up that did that would be destroying things nobody could have known
    // it would touch. Swept across every call of every shape, not just the one.
    for (const argv of [
      ["warmup", "--branch", BRANCH, "--discard"],
      ["warmup", "--branch", BRANCH, "--discard", "--tests"],
      ["warmup", "--branch", BRANCH, "--discard", "--dry-run"],
    ]) {
      const result = await capture(argv, { script: happyPath([ok(STATUS, DIRTY)]) });
      for (const call of result.seams.calls) {
        expect(call.args, `in ${argv.join(" ")}`).not.toContain("-x");
        expect(call.args, `in ${argv.join(" ")}`).not.toContain("-fdx");
      }
      expect(result.out.join("\n")).not.toMatch(/clean -\S*x/);
    }
  });

  it("refuses rather than reading an UNREADABLE status as a clean one", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: STATUS, result: { code: 128, stderr: "not a git repository" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/Refusing to treat an unreadable working copy as a clean one/);
  });
});

// ── (c) the refusals, one per decision this verb will not make ──────────────

describe("every refusal is exit 2 with the evidence, and prints no document", () => {
  it("refuses a repository with no 'origin', listing the remotes it does have", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(REMOTES, "upstream\nfork\n")]),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/no remote named 'origin'/);
    expect(result.err.join("\n")).toMatch(/it knows: upstream, fork/);
    expect(argvOf(result.seams)).toEqual([HEAD, STATUS, REMOTES]);
  });

  it("refuses when there is no local 'main' and no --from, naming the flag", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: TRUNK_REF, result: { code: 1 } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no local branch 'main'/);
    expect(result.err.join("\n")).toMatch(/Name the trunk with --from/);
    // BEFORE the fetch: there is no point touching a remote for a trunk that
    // does not exist here.
    expect(argvOf(result.seams)).not.toContain(FETCH);
  });

  it("refuses a --from that is not a local branch, saying what --from means", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--from", "trunk"], {
      script: happyPath([{ match: "git show-ref --verify --quiet refs/heads/trunk", result: { code: 1 } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--from 'trunk' is not a local branch/);
    expect(result.err.join("\n")).toMatch(/names the LOCAL trunk/);
  });

  it("refuses a DIVERGED trunk instead of fast-forwarding over it", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: ANCESTOR, result: { code: 1 } }]),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/has DIVERGED from origin\/main/);
    expect(result.err.join("\n")).toMatch(/never resolves a divergence/);
    expect(argvOf(result.seams)).not.toContain(FF_REF);
    expect(argvOf(result.seams)).not.toContain(FF_MERGE);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
  });

  it("distinguishes 'could not test reachability' from 'diverged'", async () => {
    // `merge-base --is-ancestor` reports its verdict AS the exit code, so a
    // code ABOVE 1 is git failing to answer -- and reading that as "diverged"
    // would refuse a repository whose trunk is perfectly fine.
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: ANCESTOR, result: { code: 128, stderr: "Not a valid object name" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not test whether the local 'main' is behind/);
    expect(result.err.join("\n")).not.toMatch(/DIVERGED/);
  });

  it("refuses a branch name git will not accept, quoting git's own refusal", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: NAME_OK, result: { code: 128, stderr: "fatal: not a valid branch name" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/not a branch name git will accept/);
    expect(result.err.join("\n")).toMatch(/not a valid branch name/);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
  });

  it("refuses a name that is already a LOCAL branch, and never reuses it", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(LOCAL_REF)]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is already a local branch here/);
    expect(result.err.join("\n")).toMatch(/never reuses, resets or force-moves one/);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
  });

  it("refuses a name that is already a branch on origin", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(REMOTE_REF, `abc123\trefs/heads/${BRANCH}\n`)]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/already exists on origin/);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
  });

  it("refuses an UNVERIFIED name rather than assuming a failed look-up means absent", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: REMOTE_REF, result: { code: 128, stderr: "Could not read from remote" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/never created on an unverified name/);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
  });

  it("refuses a --branch that begins with '-' before git can read it as an option", async () => {
    const result = await capture(["warmup", "--branch=--force"], { script: happyPath() });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/starts with '-', which git reads as an option/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses a --from that begins with '-' the same way", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--from=-f"], { script: happyPath() });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--from '-f' starts with '-'/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses an unknown --lane BEFORE a single git call", async () => {
    // A caller who mistyped a lane must not have their working copy cleaned to
    // find out. This is a fact about the command line, and it is answered from
    // the command line.
    const result = await capture(["warmup", "--branch", BRANCH, "--lane", "nope"], { script: happyPath() });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--lane 'nope' is not a lane this repository declares/);
    expect(result.seams.calls).toEqual([]);
  });

  it("refuses --lane against a repository that declares none", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--lane", "web"], {
      repo: EMPTY_TREE,
      script: happyPath(),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/declares no lanes at all/);
    expect(result.seams.calls).toEqual([]);
  });

  it("requires --branch by name, and --repo by name", async () => {
    const noBranch = await capture(["warmup"], { script: happyPath() });
    expect(noBranch.code).toBe(2);
    expect(noBranch.err.join("\n")).toMatch(/--branch is required/);
    expect(noBranch.err.join("\n")).toMatch(/never invents a branch name/);

    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams([], { platform: "linux" });
    const code = await runFamily(shuCommand, ["shu", "warmup", "--branch", BRANCH], null, false, io, seams);
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--repo <path> is required/);
    expect(seams.calls).toEqual([]);
  });
});

// ── (d) a step that RAN and failed: exit 1, and nothing rolled back ─────────

describe("a failed step", () => {
  it("exits 1, names the step, and says nothing is rolled back", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: FETCH, result: { code: 128, stderr: "could not read from remote" } }]),
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/git fetch origin failed -- could not read from remote/);
    expect(result.err.join("\n")).toMatch(/Nothing is rolled back/);
  });

  it("still emits the report, so the caller can see the state it was left in", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], {
      script: happyPath([{ match: SWITCH, result: { code: 128, stderr: "fatal" } }]),
    });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as { exitCode: number; steps: readonly { argv: string[] }[] };
    expect(report.exitCode).toBe(1);
    // The fast-forward DID happen, and the document says so -- that is the
    // state the working copy is now in.
    expect(report.steps.map((step): string => step.argv.join(" "))).toContain(FF_REF);
  });

  it("does not clean when the tracked restore itself failed", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([ok(STATUS, "?? a.txt\0"), { match: RESTORE, result: { code: 1, stderr: "no" } }]),
    });
    expect(result.code).toBe(1);
    expect(argvOf(result.seams)).not.toContain(CLEAN);
    expect(result.err.join("\n")).toMatch(/Nothing was cleaned/);
  });
});

// ── (e) the delegation into the executor ────────────────────────────────────

describe("the build/test verification, delegated to the executor", () => {
  it("runs the lane's DECLARED argv, in the lane's own directory", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--tests"], { script: happyPath() });
    expect(result.code).toBe(0);
    const declared = result.seams.calls.filter((call): boolean => call.command !== "git");
    expect(declared.map((call): string => [call.command, ...call.args].join(" "))).toEqual([
      DECLARED_BUILD,
      DECLARED_TEST,
    ]);
    for (const call of declared) expect(call.cwd).toBe(SHU_REPO);
  });

  it("does not run the declared test when the declared build failed", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--tests"], {
      script: happyPath([{ match: DECLARED_BUILD, result: { code: 2 } }]),
    });
    expect(result.code).toBe(1);
    expect(argvOf(result.seams)).not.toContain(DECLARED_TEST);
    expect(result.err.join("\n")).toMatch(/the declared 'build' did not pass on lane 'web'/);
    expect(result.err.join("\n")).toMatch(/nothing is rolled back/);
  });

  it("carries the delegate's per-step exit code and duration into its own report", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], {
      script: happyPath(),
      ticking: true,
    });
    const report = JSON.parse(result.out.join("\n")) as {
      steps: readonly { kind: string; argv: string[]; exitCode: number | null; durationMs: number | null }[];
    };
    const build = report.steps.find((step): boolean => step.kind === "build");
    expect(build?.argv).toEqual(["pnpm", "turbo", "run", "build"]);
    expect(build?.exitCode).toBe(0);
    expect(build?.durationMs).toBeGreaterThan(0);
  });

  it("passes exit 5 through when the declared program could not be started", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: DECLARED_BUILD, result: { spawnFailed: true, stderr: "ENOENT" } }]),
    });
    expect(result.code).toBe(5);
  });

  it("passes exit 4 through when the lane declares the build unsupported", async () => {
    const result = await withDeclaration(
      {
        lanes: { only: { stack: "s", cwd: "." } },
        defaultLane: "only",
        verbs: { only: { build: { unsupported: "this lane is a library; there is nothing to build" } } },
      },
      ["warmup", "--branch", BRANCH],
      { script: happyPath() },
    );
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toMatch(/there is nothing to build/);
  });

  it("passes exit 3 through when the declaration restricts the build to another host", async () => {
    const result = await withDeclaration(
      {
        lanes: { only: { stack: "s", cwd: "." } },
        defaultLane: "only",
        verbs: { only: { build: { exe: "placeholder-tool", argv: ["build"] } } },
        hosts: { build: ["darwin"] },
      },
      ["warmup", "--branch", BRANCH],
      { script: happyPath(), platform: "linux" },
    );
    expect(result.code).toBe(3);
  });

  it("keeps stdout exactly ONE document while relaying the build's own output to stderr", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], {
      script: happyPath([{ match: DECLARED_BUILD, result: { code: 0, stdout: "built 3 packages\n" } }]),
    });
    expect(result.code).toBe(0);
    expect(result.err).toContain("built 3 packages");
    expect(() => JSON.parse(result.out.join("\n"))).not.toThrow();
  });
});

// ── (f) a repository with no declaration ────────────────────────────────────

describe("a repository that declares nothing", () => {
  it("warms the working copy, says verification was skipped, and exits 0", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      repo: EMPTY_TREE,
      script: happyPath(),
    });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toEqual([
      HEAD,
      STATUS,
      REMOTES,
      TRUNK_REF,
      FETCH,
      ANCESTOR,
      FF_REF,
      NAME_OK,
      LOCAL_REF,
      REMOTE_REF,
      SWITCH,
    ]);
    expect(result.err.join("\n")).toMatch(/no declaration -- build\/test verification skipped/);
    expect(result.err.join("\n")).toMatch(/shu detect --repo/);
  });

  it("reports lane: null in --json rather than inventing one", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], {
      repo: EMPTY_TREE,
      script: happyPath(),
    });
    const report = JSON.parse(result.out.join("\n")) as { lane: string | null; exitCode: number };
    expect(report.lane).toBeNull();
    expect(report.exitCode).toBe(0);
  });
});

// ── (g) --dry-run spawns NOTHING ────────────────────────────────────────────

describe("--dry-run", () => {
  it("records zero calls on the seam -- not even the fetch", async () => {
    for (const argv of [
      ["warmup", "--branch", BRANCH, "--dry-run"],
      ["warmup", "--branch", BRANCH, "--dry-run", "--tests"],
      ["warmup", "--branch", BRANCH, "--dry-run", "--discard"],
      ["warmup", "--branch", BRANCH, "--dry-run", "--json"],
    ]) {
      const result = await capture(argv, { script: happyPath() });
      expect(result.code, argv.join(" ")).toBe(0);
      expect(result.seams.calls, argv.join(" ")).toEqual([]);
    }
  });

  it("prints every git command AND the declared toolchain command, in the order they would run", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--dry-run", "--tests", "--json"], {
      script: happyPath(),
    });
    const report = JSON.parse(result.out.join("\n")) as { steps: readonly { argv: string[] }[] };
    expect(report.steps.map((step): string => step.argv.join(" "))).toEqual([
      HEAD,
      STATUS,
      REMOTES,
      TRUNK_REF,
      FETCH,
      ANCESTOR,
      FF_REF,
      NAME_OK,
      LOCAL_REF,
      REMOTE_REF,
      SWITCH,
      DECLARED_BUILD,
      DECLARED_TEST,
    ]);
  });

  it("adds the two discard commands, in order, when --discard is given", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--dry-run", "--discard", "--json"], {
      script: happyPath(),
    });
    const report = JSON.parse(result.out.join("\n")) as { steps: readonly { argv: string[] }[] };
    const printed = report.steps.map((step): string => step.argv.join(" "));
    expect(printed.slice(0, 4)).toEqual([HEAD, STATUS, RESTORE, CLEAN]);
  });

  it("prints 'would run', never 'ran', and reports no exit code for anything", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--dry-run"], { script: happyPath() });
    const text = result.out.join("\n");
    expect(text).toMatch(/^would run: {5}git branch --show-current$/m);
    expect(text).not.toMatch(/^ran:/m);
    expect(text).not.toMatch(/-- exit /);
  });

  it("says which line a real run would spell differently, rather than reading git to find out", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--dry-run"], { script: happyPath() });
    expect(result.out.join("\n")).toMatch(/a dry run reads no git state, so it cannot know which/);
  });
});

// ── (h) the --json contract ─────────────────────────────────────────────────

describe("the --json contract", () => {
  it("carries the published keys in the published order", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], { script: happyPath() });
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual([
      "contract",
      "repo",
      "trunk",
      "remote",
      "branch",
      "discard",
      "steps",
      "lane",
      "exitCode",
    ]);
    expect(report["contract"]).toBe(WARMUP_CONTRACT);
    expect(report["trunk"]).toBe("main");
    expect(report["remote"]).toBe("origin");
    expect(report["branch"]).toBe(BRANCH);
    expect(report["discard"]).toBe(false);
    expect(report["lane"]).toBe("web");
    expect(report["exitCode"]).toBe(0);
  });

  it("gives every step the same five keys, in the same order", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json", "--tests"], {
      script: happyPath(),
      ticking: true,
    });
    const report = JSON.parse(result.out.join("\n")) as { steps: readonly Record<string, unknown>[] };
    expect(report.steps.length).toBeGreaterThan(10);
    for (const step of report.steps) {
      expect(Object.keys(step)).toEqual(["kind", "argv", "exitCode", "durationMs", "note"]);
      expect(["git", "build", "test"]).toContain(step["kind"]);
    }
  });

  it("uses --from for the trunk when it is given", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--from", "trunk", "--json", "--dry-run"], {
      script: happyPath(),
    });
    const report = JSON.parse(result.out.join("\n")) as { trunk: string; steps: readonly { argv: string[] }[] };
    expect(report.trunk).toBe("trunk");
    expect(report.steps.map((step): string => step.argv.join(" "))).toContain(
      "git switch -c my-idea origin/trunk",
    );
  });

  it("prints NO document on a refusal, so a reader never has to tell one from an error", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], {
      script: happyPath([{ match: ANCESTOR, result: { code: 1 } }]),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
  });

  it("never leaks a declared env VALUE into the document or the text", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], { script: happyPath() });
    expect(result.out.join("\n")).not.toContain("a value no output may carry");
    expect(result.err.join("\n")).not.toContain("a value no output may carry");
  });
});

// ── (i) the family's surface ────────────────────────────────────────────────

describe("the verb's place in the family", () => {
  it("reads its own flags and refuses a sibling's", async () => {
    const foreign = await capture(["warmup", "--branch", BRANCH, "--target", "x"], { script: happyPath() });
    expect(foreign.code).toBe(2);
    expect(foreign.err.join("\n")).toMatch(/--target is not read by 'shu warmup'/);

    const mine = await capture(["build", "--discard"], { script: happyPath() });
    expect(mine.code).toBe(2);
    expect(mine.err.join("\n")).toMatch(/--discard is not read by 'shu build'/);
  });

  it("documents both warmups in the family help, and says which is which", async () => {
    const out: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (): void => {} };
    await runFamily(shuCommand, ["shu", "--help"], SHU_REPO, false, io, new ScriptedSeams([]));
    const help = out.join("\n");
    expect(help).toMatch(/Warm a WORKING COPY for iteration/);
    expect(help).toMatch(/NOT 'nen warmup', which sweeps a REGISTRY/);
    expect(help).toMatch(/--branch <name> {2}'warmup' only/);
    expect(help).toMatch(/--discard {8}'warmup' only/);
    expect(help).toMatch(/NEVER 'git\s+clean -x'/);
    expect(help).not.toMatch(/not implemented yet/);
  });
});
