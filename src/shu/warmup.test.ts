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
// TWO ENTRIES FOR ONE COMMAND LINE ANSWER IN ORDER, which is what lets this
// file test the thing blocker B1 was about: `--discard` reads the status,
// destroys what it listed, and READS IT AGAIN. A fixture that could only give
// one answer to `git status` could not tell a discard that worked from one that
// silently left a nested repository behind.
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
  /**
   * Fired after each recorded call, with the whole command line.
   *
   * A SCRIPTED `git switch -c` DOES NOT CHECK ANYTHING OUT, so the only way to
   * test "the declaration is re-read on the branch that now exists" is to let a
   * test make the tree change where the real checkout would have. This is that
   * seam, and it is used by exactly the tests that are about it.
   */
  readonly onCall?: (line: string) => void;
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
  if (options.onCall !== undefined) {
    const inner = seams.run;
    const hook = options.onCall;
    seams.run = (command, args, runOptions): ReturnType<typeof inner> => {
      const result = inner(command, args, runOptions);
      hook([command, ...args].join(" "));
      return result;
    };
  }
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
const ORPHANS = "git rev-list --count HEAD --not --branches --remotes";
const IN_PROGRESS = "git rev-list --ignore-missing -1 MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD";
const MERGE_REF = "git rev-parse --verify --quiet MERGE_HEAD";
const REBASE_REF = "git rev-parse --verify --quiet REBASE_HEAD";
const PICK_REF = "git rev-parse --verify --quiet CHERRY_PICK_HEAD";
const STATUS = "git -c core.quotePath=false status --porcelain=v1 -z -uall";
const RESET = "git reset --hard";
const CLEAN = "git clean -fd";
const REMOTES = "git remote";
const TRUNK_REF = "git show-ref --verify --quiet refs/heads/main";
const FETCH = "git fetch origin";
const ANCESTOR = "git merge-base --is-ancestor main origin/main";
const FF_REF = "git branch --force main origin/main";
const FF_MERGE = "git merge --ff-only origin/main";
const NAME_OK = `git check-ref-format --branch ${BRANCH}`;
const LOCAL_REF = `git show-ref --verify --quiet refs/heads/${BRANCH}`;
const REMOTE_REF = `git ls-remote --heads origin refs/heads/${BRANCH}`;
const SWITCH = `git switch -c ${BRANCH} origin/main`;
const DECLARED_BUILD = "pnpm turbo run build";
const DECLARED_TEST = "pnpm exec vitest run";

/** The order every git call runs in on a clean tree that is not on the trunk. */
const CLEAN_ORDER: readonly string[] = [
  HEAD,
  IN_PROGRESS,
  STATUS,
  REMOTES,
  TRUNK_REF,
  NAME_OK,
  LOCAL_REF,
  FETCH,
  ANCESTOR,
  FF_REF,
  REMOTE_REF,
  SWITCH,
];

/**
 * A clean checkout, on a branch that is not the trunk, whose trunk is behind
 * and whose branch name is free. Callers override one entry to make one thing
 * go wrong -- and may pass the SAME match twice to make one command answer
 * differently the second time it is asked.
 */
function happyPath(overrides: readonly ScriptedCall[] = []): readonly ScriptedCall[] {
  const base: ScriptedCall[] = [
    ok(HEAD, "some-branch\n"),
    ok(ORPHANS, "0\n"),
    ok(IN_PROGRESS),
    // `rev-parse --verify --quiet` reports an absent ref AS exit 1, which is
    // the answer and not a failure -- so the default fixture says "none of the
    // three is here", and a test about one of them overrides just that one.
    { match: MERGE_REF, result: { code: 1 } },
    { match: REBASE_REF, result: { code: 1 } },
    { match: PICK_REF, result: { code: 1 } },
    ok(STATUS),
    ok(REMOTES, "origin\n"),
    ok(TRUNK_REF),
    ok(NAME_OK, `${BRANCH}\n`),
    { match: LOCAL_REF, result: { code: 1 } },
    ok(FETCH),
    ok(ANCESTOR),
    ok(FF_REF),
    ok(REMOTE_REF),
    ok(SWITCH),
    ok(DECLARED_BUILD),
    ok(DECLARED_TEST),
    ok(RESET),
    ok(CLEAN),
  ];
  const overridden = new Set(overrides.map((entry): string => entry.match));
  return [...overrides, ...base.filter((entry): boolean => !overridden.has(entry.match))];
}

/** A `nen/contract.json` written into a temporary repository. */
function writeDeclaration(dir: string, project: unknown): void {
  mkdirSync(join(dir, "nen"), { recursive: true });
  writeFileSync(join(dir, "nen", "contract.json"), JSON.stringify({ $schema: "nen.contract/v0.1", project }));
}

async function withDeclaration(
  project: unknown,
  argv: readonly string[],
  options: Options = {},
): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "nen-warmup-"));
  try {
    writeDeclaration(dir, project);
    return await capture(argv, { ...options, repo: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A repository whose declaration CHANGES at the moment `git switch -c` runs --
 * the moment a real checkout would have replaced the file on disk.
 */
async function withDeclarationChangingAtCheckout(
  before: unknown | null,
  after: unknown | null,
  argv: readonly string[],
  options: Options = {},
): Promise<Captured> {
  const dir = mkdtempSync(join(tmpdir(), "nen-warmup-switch-"));
  try {
    if (before !== null) writeDeclaration(dir, before);
    return await capture(argv, {
      ...options,
      repo: dir,
      onCall: (line): void => {
        if (line !== SWITCH) return;
        if (after === null) rmSync(join(dir, "nen", "contract.json"), { force: true });
        else writeDeclaration(dir, after);
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ONE_LANE = {
  lanes: { web: { stack: "s", cwd: "." } },
  defaultLane: "web",
  verbs: { web: { build: { exe: "placeholder-tool", argv: ["build"] } } },
};
const DECLARED_PLACEHOLDER = "placeholder-tool build";

// ── (a) the order, which IS the design ──────────────────────────────────────

describe("the steps, in the one order they may run in", () => {
  it("classifies, then fetches, then branches, then verifies", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--tests"], { script: happyPath() });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toEqual([...CLEAN_ORDER, DECLARED_BUILD, DECLARED_TEST]);
  });

  it("runs every git call in the repository --repo names, never in the process's own cwd", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], { script: happyPath() });
    const gitCalls = result.seams.calls.filter((call): boolean => call.command === "git");
    expect(gitCalls.length).toBeGreaterThan(8);
    for (const call of gitCalls) expect(call.cwd).toBe(SHU_REPO);
  });

  it("checks whether the name is already on the remote AFTER the fetch", async () => {
    // A stale remote-tracking ref would report a branch absent that the real
    // remote already has, so the existence question is only honest once the
    // fetch has answered. The LOCAL half of that question needs no fetch, and
    // is asked earlier for blocker B2's reason.
    const argv = argvOf((await capture(["warmup", "--branch", BRANCH], { script: happyPath() })).seams);
    expect(argv.indexOf(FETCH)).toBeLessThan(argv.indexOf(REMOTE_REF));
    expect(argv.indexOf(FETCH)).toBeLessThan(argv.indexOf(SWITCH));
  });

  it("asks every question that needs no mutation BEFORE the discard destroys anything", async () => {
    // Blocker B2. A name git will not accept, a missing 'origin', a --from that
    // is not a branch and a name that is already taken are each answerable from
    // the tree as it stands -- so each of them must be answered before the one
    // step that destroys a developer's work, not after it.
    const argv = argvOf(
      (
        await capture(["warmup", "--branch", BRANCH, "--discard"], {
          script: happyPath([ok(STATUS, "?? a.txt\0"), ok(STATUS, "")]),
        })
      ).seams,
    );
    for (const check of [REMOTES, TRUNK_REF, NAME_OK, LOCAL_REF]) {
      expect(argv.indexOf(check), check).toBeLessThan(argv.indexOf(RESET));
      expect(argv.indexOf(check), check).toBeLessThan(argv.indexOf(CLEAN));
    }
    // The fetch is the ONE thing that must follow, and it destroys nothing.
    expect(argv.indexOf(CLEAN)).toBeLessThan(argv.indexOf(FETCH));
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

  it("reports a detached HEAD that reaches nothing of its own, rather than erroring on it", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], { script: happyPath([ok(HEAD, "\n")]) });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/HEAD is DETACHED and reaches no commit of its own/);
    // Detached is "not on the trunk", so the ref-moving form applies.
    expect(argvOf(result.seams)).toContain(FF_REF);
    // The orphan count is only asked when HEAD is detached.
    expect(argvOf(result.seams)).toContain(ORPHANS);
  });

  it("does not ask for an orphan count when HEAD is on a branch", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], { script: happyPath() });
    expect(argvOf(result.seams)).not.toContain(ORPHANS);
  });
});

// ── (a2) a detached HEAD that is carrying work ──────────────────────────────

describe("a detached HEAD with commits of its own", () => {
  it("refuses at 2 naming the count and the reflog, before anything is fetched", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(HEAD, "\n"), ok(ORPHANS, "3\n")]),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const said = result.err.join("\n");
    expect(said).toMatch(/HEAD is DETACHED and carries 3 commit\(s\)/);
    expect(said).toMatch(/reflog -- which expires/);
    expect(said).toMatch(/git branch <name>/);
    expect(argvOf(result.seams)).toEqual([HEAD, ORPHANS]);
  });

  it("refuses rather than assuming zero when the count cannot be read", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(HEAD, "\n"), { match: ORPHANS, result: { code: 128, stderr: "bad revision" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not count the commits that only HEAD reaches/);
    expect(result.err.join("\n")).toMatch(/an unasked question is never answered "none"/);
  });

  it("refuses when the count is not a number at all", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(HEAD, "\n"), ok(ORPHANS, "not-a-number\n")]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/answered something that is not a number/);
  });

  it("refuses a detached HEAD with exactly one orphan in the singular", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(HEAD, "\n"), ok(ORPHANS, "1\n")]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/carries 1 commit\(s\)/);
    expect(result.err.join("\n")).toMatch(/moves HEAD away from that commit/);
  });
});

// ── (a3) a half-finished merge, rebase or cherry-pick ───────────────────────

describe("a working copy in the middle of an operation", () => {
  it("refuses at 2 naming the ref and its own --abort, and never treats it as an ordinary dirty tree", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([ok(IN_PROGRESS, "abc123\n"), ok(MERGE_REF, "abc123\n")]),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const said = result.err.join("\n");
    expect(said).toMatch(/in the middle of an operation \(MERGE_HEAD exists\)/);
    expect(said).toMatch(/git merge --abort/);
    expect(said).toMatch(/--discard does not clear it/);
    // Nothing was discarded, nothing was fetched.
    expect(argvOf(result.seams)).not.toContain(RESET);
    expect(argvOf(result.seams)).not.toContain(FETCH);
  });

  it("names a rebase and a cherry-pick by their own aborts", async () => {
    const rebase = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(IN_PROGRESS, "abc\n"), ok(REBASE_REF, "abc\n")]),
    });
    expect(rebase.err.join("\n")).toMatch(/git rebase --abort/);

    const pick = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(IN_PROGRESS, "abc\n"), ok(PICK_REF, "abc\n")]),
    });
    expect(pick.err.join("\n")).toMatch(/git cherry-pick --abort/);
  });

  it("still refuses when the probes disagree with the detector, pointing at git status", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(IN_PROGRESS, "abc\n")]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'git status' says which one it is/);
  });

  it("refuses rather than reading an unanswerable in-progress check as a 'no'", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: IN_PROGRESS, result: { code: 128, stderr: "fatal" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not tell whether a merge, rebase or cherry-pick is in progress/);
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
    expect(argvOf(result.seams)).toEqual([HEAD, IN_PROGRESS, STATUS]);
  });

  it("says, in the refusal itself, that ignored files are never touched", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], { script: happyPath([ok(STATUS, DIRTY)]) });
    expect(result.err.join("\n")).toMatch(/Ignored files are NEVER touched/);
    expect(result.err.join("\n")).toMatch(/without -x/);
  });

  it("renders a path containing a newline on ONE line, escaped", async () => {
    // `core.quotePath=false` plus `-z` means git hands the raw bytes over, and
    // a path printed across two lines reads as two paths -- the second of which
    // is a file that does not exist.
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(STATUS, "?? two\nlines.txt\0")]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("?? two\\nlines.txt");
    expect(result.err.join("\n")).not.toContain("\nlines.txt");
  });

  it("with --discard, prints the exact list, destroys it, and READS THE TREE AGAIN", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([ok(STATUS, DIRTY), ok(STATUS, "")]),
    });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toEqual([
      HEAD,
      IN_PROGRESS,
      STATUS,
      REMOTES,
      TRUNK_REF,
      NAME_OK,
      LOCAL_REF,
      RESET,
      CLEAN,
      STATUS,
      FETCH,
      ANCESTOR,
      FF_REF,
      REMOTE_REF,
      SWITCH,
      DECLARED_BUILD,
    ]);
    const printed = result.out.join("\n");
    expect(printed).toMatch(/discarding 3 uncommitted path\(s\)/);
    expect(printed).toMatch(/\?\? \.env {2}\[secret-shape\]/);
    expect(printed).toMatch(/clean -- the discard did what it said/);
  });

  it("uses 'git reset --hard' for the tracked half, so a STAGED change is destroyed too", async () => {
    // Blocker B1's other half. `git checkout -- .` restores the working tree
    // FROM THE INDEX, so a staged change survives in both and is carried onto
    // the new branch by the flag that promised to destroy it.
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([ok(STATUS, "A  staged.ts\0"), ok(STATUS, "")]),
    });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toContain(RESET);
    expect(argvOf(result.seams)).not.toContain("git checkout -- .");
  });

  it("with --discard on a CLEAN tree, discards nothing at all and does not re-read", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], { script: happyPath() });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).not.toContain(RESET);
    expect(argvOf(result.seams)).not.toContain(CLEAN);
    expect(argvOf(result.seams).filter((line): boolean => line === STATUS)).toHaveLength(1);
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
      const result = await capture(argv, { script: happyPath([ok(STATUS, DIRTY), ok(STATUS, "")]) });
      for (const call of result.seams.calls) {
        expect(call.args, `in ${argv.join(" ")}`).not.toContain("-x");
        expect(call.args, `in ${argv.join(" ")}`).not.toContain("-fdx");
        expect(call.args, `in ${argv.join(" ")}`).not.toContain("-ff");
        expect(call.args, `in ${argv.join(" ")}`).not.toContain("-ffd");
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

// ── (b2) the discard is CHECKED, not assumed ────────────────────────────────

describe("what --discard did not manage to discard", () => {
  const NESTED = "?? sub/\0";

  it("refuses at 2 listing what survived, and quotes git's own words", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard", "--json"], {
      script: happyPath([
        ok(STATUS, NESTED),
        ok(STATUS, NESTED),
        { match: CLEAN, result: { code: 0, stdout: "Skipping repository sub/\n" } },
      ]),
    });
    expect(result.code).toBe(2);
    const said = result.err.join("\n");
    expect(said).toMatch(/--discard ran and the working copy at .* is STILL not clean: 1 path\(s\) survived it/);
    expect(said).toMatch(/\?\? sub\//);
    expect(said).toMatch(/'git clean -fd' said, for its part:/);
    expect(said).toMatch(/Skipping repository sub\//);
    expect(said).toMatch(/NESTED REPOSITORY/);
    expect(said).toMatch(/never passes -ff/);
    expect(said).toMatch(/Nothing has been fetched and no ref has moved/);
    // Nothing beyond the discard ran.
    expect(argvOf(result.seams)).not.toContain(FETCH);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
  });

  it("carries the report on stdout, because this refusal already destroyed something", async () => {
    // The rule everywhere else is "exit 2 prints no document". It cannot hold
    // here and stay honest: two destructive commands have run, and the list of
    // what they ran is the only thing that says which state the tree is in.
    const result = await capture(["warmup", "--branch", BRANCH, "--discard", "--json"], {
      script: happyPath([ok(STATUS, NESTED), ok(STATUS, NESTED)]),
    });
    expect(result.code).toBe(2);
    const report = JSON.parse(result.out.join("\n")) as {
      exitCode: number;
      steps: readonly { argv: string[] }[];
    };
    expect(report.exitCode).toBe(2);
    expect(report.steps.map((step): string => step.argv.join(" "))).toContain(RESET);
    expect(report.steps.map((step): string => step.argv.join(" "))).toContain(CLEAN);
  });

  it("names the dirty-submodule half too, on a survivor with no trailing slash", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([ok(STATUS, " M vendor\0"), ok(STATUS, " M vendor\0")]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/SUBMODULE/);
    expect(result.err.join("\n")).toMatch(/without --recurse-submodules/);
    expect(result.err.join("\n")).toMatch(/\(none here\)/);
  });

  it("refuses rather than reading an unreadable re-read as a clean tree", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([
        ok(STATUS, "?? a.txt\0"),
        { match: STATUS, result: { code: 128, stderr: "gone" } },
      ]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not be read again afterwards/);
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
    expect(argvOf(result.seams)).toEqual([HEAD, IN_PROGRESS, STATUS, REMOTES]);
  });

  it("refuses an unreadable remote list rather than treating it as absent", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: REMOTES, result: { code: 128, stderr: "fatal" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/never treated as an absent one, nor as a present one/);
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

  it("distinguishes 'git could not answer' from 'there is no such trunk'", async () => {
    // `show-ref --verify --quiet` reports its verdict AS the exit code: 0 found,
    // 1 absent. Anything above 1 is git failing to answer, and reading that as
    // "absent" would refuse a repository whose trunk is right there.
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: TRUNK_REF, result: { code: 129, stderr: "usage: git show-ref" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not determine whether 'main' is a local branch/);
    expect(result.err.join("\n")).not.toMatch(/no local branch 'main'/);
  });

  it("distinguishes the same way for the BRANCH's own existence check", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: LOCAL_REF, result: { code: 129, stderr: "usage: git show-ref" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(
      /could not determine whether 'my-idea' already exists locally/,
    );
    expect(result.err.join("\n")).toMatch(/never created on an unverified name/);
    expect(argvOf(result.seams)).not.toContain(FETCH);
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
    expect(result.err.join("\n")).toMatch(/Nothing has been discarded, fetched or moved/);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
  });

  it("refuses a mistyped --branch BEFORE --discard destroys anything", async () => {
    // Blocker B2, stated as the case it was found on: a typo in a branch name
    // must not cost a caller their uncommitted work.
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([
        ok(STATUS, "?? precious.txt\0"),
        { match: NAME_OK, result: { code: 128, stderr: "fatal: not a valid branch name" } },
      ]),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(argvOf(result.seams)).toEqual([HEAD, IN_PROGRESS, STATUS, REMOTES, TRUNK_REF, NAME_OK]);
    expect(argvOf(result.seams)).not.toContain(RESET);
    expect(argvOf(result.seams)).not.toContain(CLEAN);
    expect(argvOf(result.seams)).not.toContain(FETCH);
    expect(argvOf(result.seams)).not.toContain(FF_REF);
  });

  it("refuses a name that is already a LOCAL branch, and never reuses it", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(LOCAL_REF)]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is already a local branch here/);
    expect(result.err.join("\n")).toMatch(/never reuses, resets or force-moves one/);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
    expect(argvOf(result.seams)).not.toContain(FETCH);
  });

  it("asks the remote about the FULL ref, so 'x' is not matched by 'feat/x'", async () => {
    // `ls-remote` matches a bare pattern against the tail of every ref on slash
    // boundaries, so a bare 'x' would match refs/heads/feat/x and refuse a name
    // that is free.
    const result = await capture(["warmup", "--branch", BRANCH], { script: happyPath() });
    expect(argvOf(result.seams)).toContain(`git ls-remote --heads origin refs/heads/${BRANCH}`);
    expect(argvOf(result.seams)).not.toContain(`git ls-remote --heads origin ${BRANCH}`);
  });

  it("refuses a name that is already a branch on origin", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([ok(REMOTE_REF, `abc123\trefs/heads/${BRANCH}\n`)]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/already exists on origin/);
    expect(argvOf(result.seams)).not.toContain(SWITCH);
  });

  it("carries the report when THAT refusal is reached, because the trunk has already moved", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], {
      script: happyPath([ok(REMOTE_REF, `abc123\trefs/heads/${BRANCH}\n`)]),
    });
    expect(result.code).toBe(2);
    const report = JSON.parse(result.out.join("\n")) as {
      exitCode: number;
      steps: readonly { argv: string[] }[];
    };
    expect(report.exitCode).toBe(2);
    expect(report.steps.map((step): string => step.argv.join(" "))).toContain(FF_REF);
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

  it("does not clean when the tracked reset itself failed", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([ok(STATUS, "?? a.txt\0"), { match: RESET, result: { code: 1, stderr: "no" } }]),
    });
    expect(result.code).toBe(1);
    expect(argvOf(result.seams)).not.toContain(CLEAN);
    expect(result.err.join("\n")).toMatch(/Nothing was cleaned/);
  });

  it("exits 1 when the clean itself fails, saying the tracked half already ran", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard"], {
      script: happyPath([ok(STATUS, "?? a.txt\0"), { match: CLEAN, result: { code: 1, stderr: "permission denied" } }]),
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/git clean -fd failed -- permission denied/);
    expect(result.err.join("\n")).toMatch(/Tracked files were already restored/);
  });

  it("exits 1 when the fast-forward itself fails", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: FF_REF, result: { code: 1, stderr: "cannot force update" } }]),
    });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/git branch --force main origin\/main failed/);
  });

  it("refuses at 2 when the current branch cannot be read at all", async () => {
    const result = await capture(["warmup", "--branch", BRANCH], {
      script: happyPath([{ match: HEAD, result: { code: 128, stderr: "not a git repository" } }]),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not read the current branch/);
    expect(result.out).toEqual([]);
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

  it("gives a delegate that rendered NOTHING a row of its own, with the reason", async () => {
    // Without it the last row of the report is a SUCCESSFUL build sitting beside
    // an exit code of 4, which reads as "the build failed with 4".
    const result = await withDeclaration(
      {
        lanes: { only: { stack: "s", cwd: "." } },
        defaultLane: "only",
        verbs: {
          only: {
            build: { exe: "placeholder-tool", argv: ["build"] },
            test: { unsupported: "this lane has no test suite yet" },
          },
        },
      },
      ["warmup", "--branch", BRANCH, "--tests", "--json"],
      { script: happyPath([ok(DECLARED_PLACEHOLDER)]) },
    );
    expect(result.code).toBe(4);
    const report = JSON.parse(result.out.join("\n")) as {
      steps: readonly Record<string, unknown>[];
    };
    const last = report.steps[report.steps.length - 1];
    expect(Object.keys(last ?? {})).toEqual(["kind", "argv", "exitCode", "durationMs", "note"]);
    expect(last?.["kind"]).toBe("test");
    expect(last?.["argv"]).toEqual([]);
    expect(last?.["exitCode"]).toBeNull();
    expect(last?.["durationMs"]).toBeNull();
    expect(String(last?.["note"])).toMatch(/refused before it rendered a single command/);
    expect(String(last?.["note"])).toMatch(/no test suite yet/);
  });

  it("renders that row as words rather than as an empty command line", async () => {
    const result = await withDeclaration(
      {
        lanes: { only: { stack: "s", cwd: "." } },
        defaultLane: "only",
        verbs: {
          only: {
            build: { exe: "placeholder-tool", argv: ["build"] },
            test: { unsupported: "this lane has no test suite yet" },
          },
        },
      },
      ["warmup", "--branch", BRANCH, "--tests"],
      { script: happyPath([ok(DECLARED_PLACEHOLDER)]) },
    );
    expect(result.code).toBe(4);
    expect(result.out.join("\n")).toMatch(/\(nothing was rendered, so nothing was run\)/);
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

  it("reports a delegated 2 as 1, and never as a refusal with a document beside it", async () => {
    // The executor's 2 is "this verb could not be performed as declared" -- an
    // unmet precondition. Warmup's 2 means "nen refused and changed nothing",
    // which by this point is false: the trunk is fast-forwarded and the branch
    // is checked out. So it is a step that ran and did not pass, which is 1.
    const result = await withDeclaration(
      {
        lanes: { only: { stack: "s", cwd: "." } },
        defaultLane: "only",
        verbs: { only: { build: { exe: "placeholder-tool", argv: ["build"] } } },
        preconditions: { only: [{ kind: "path", value: "never-built", why: "the dependencies must be installed" }] },
      },
      ["warmup", "--branch", BRANCH, "--json"],
      { script: happyPath([ok(DECLARED_PLACEHOLDER)]) },
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as { exitCode: number };
    expect(report.exitCode).toBe(1);
    expect(result.err.join("\n")).toMatch(/the executor answered 2; warmup exits 1/);
    expect(result.err.join("\n")).toMatch(/preconditions? on lane 'only'/);
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

// ── (e2) the declaration is the BRANCH's, not the tree the run started in ───

describe("the declaration is re-read after the checkout", () => {
  it("verifies against a project block the trunk gained, instead of reporting there is none", async () => {
    const result = await withDeclarationChangingAtCheckout(
      null,
      ONE_LANE,
      ["warmup", "--branch", BRANCH],
      { script: happyPath([ok(DECLARED_PLACEHOLDER)]) },
    );
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toContain(DECLARED_PLACEHOLDER);
    expect(result.err.join("\n")).toMatch(/declared no project block and 'my-idea' .* does/);
    expect(result.err.join("\n")).toMatch(/Verifying on lane 'web'/);
    expect(result.err.join("\n")).not.toMatch(/no declaration -- build\/test verification skipped/);
  });

  it("resolves the lane from the branch's declaration when the trunk renamed it", async () => {
    const result = await withDeclarationChangingAtCheckout(
      ONE_LANE,
      {
        lanes: { site: { stack: "s", cwd: "." } },
        defaultLane: "site",
        verbs: { site: { build: { exe: "placeholder-tool", argv: ["build"] } } },
      },
      ["warmup", "--branch", BRANCH, "--json"],
      { script: happyPath([ok(DECLARED_PLACEHOLDER)]) },
    );
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toMatch(
      /the lane resolved before the fetch was 'web' and the declaration on 'my-idea' resolves 'site'/,
    );
    const report = JSON.parse(result.out.join("\n")) as { lane: string | null };
    expect(report.lane).toBe("site");
  });

  it("refuses at 2, with the report, when --lane names a lane the branch no longer declares", async () => {
    const result = await withDeclarationChangingAtCheckout(
      {
        lanes: { web: { stack: "s", cwd: "." }, site: { stack: "s", cwd: "." } },
        defaultLane: "web",
        verbs: {
          web: { build: { exe: "placeholder-tool", argv: ["build"] } },
          site: { build: { exe: "placeholder-tool", argv: ["build"] } },
        },
      },
      ONE_LANE,
      ["warmup", "--branch", BRANCH, "--lane", "site", "--json"],
      { script: happyPath() },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/the declaration on THAT branch cannot answer the lane/);
    expect(result.err.join("\n")).toMatch(/--lane 'site' is not a lane this repository declares/);
    // The git half DID happen, so the document says so.
    const report = JSON.parse(result.out.join("\n")) as { exitCode: number; lane: string | null };
    expect(report.exitCode).toBe(2);
    expect(report.lane).toBeNull();
  });

  it("skips verification, and says so, when the branch carries no declaration the trunk had", async () => {
    const result = await withDeclarationChangingAtCheckout(
      ONE_LANE,
      null,
      ["warmup", "--branch", BRANCH],
      { script: happyPath() },
    );
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toMatch(/declared a project block \(lane 'web'\), and 'my-idea' .* does not/);
    expect(result.err.join("\n")).toMatch(/no declaration -- build\/test verification skipped/);
    expect(argvOf(result.seams)).not.toContain(DECLARED_PLACEHOLDER);
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
    expect(argvOf(result.seams)).toEqual(CLEAN_ORDER);
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
  const PLANNED: readonly string[] = [
    HEAD,
    ORPHANS,
    IN_PROGRESS,
    STATUS,
    REMOTES,
    TRUNK_REF,
    NAME_OK,
    LOCAL_REF,
    FETCH,
    ANCESTOR,
    FF_REF,
    REMOTE_REF,
    SWITCH,
  ];

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
      ...PLANNED,
      DECLARED_BUILD,
      DECLARED_TEST,
    ]);
  });

  it("adds the three discard commands, in order, when --discard is given", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--dry-run", "--discard", "--json"], {
      script: happyPath(),
    });
    const report = JSON.parse(result.out.join("\n")) as { steps: readonly { argv: string[] }[] };
    const printed = report.steps.map((step): string => step.argv.join(" "));
    expect(printed.slice(0, 11)).toEqual([
      HEAD,
      ORPHANS,
      IN_PROGRESS,
      STATUS,
      REMOTES,
      TRUNK_REF,
      NAME_OK,
      LOCAL_REF,
      RESET,
      CLEAN,
      STATUS,
    ]);
  });

  it("says the orphan count only runs on a detached HEAD, and that the tree is re-read", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--dry-run", "--discard"], {
      script: happyPath(),
    });
    const text = result.out.join("\n");
    expect(text).toMatch(/ONLY on a detached HEAD/);
    expect(text).toMatch(/the working copy is READ AGAIN/);
    expect(text).toMatch(/is git half-way through something\?/);
  });

  it("prints 'would run', never 'ran', and reports no exit code for anything", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--dry-run"], { script: happyPath() });
    const text = result.out.join("\n");
    expect(text).toMatch(/^would run: {5}git branch --show-current$/m);
    expect(text).not.toMatch(/^ran:/m);
    expect(text).not.toMatch(/-- exit /);
  });

  it("still prints the git plan when the verification half would not pass, and says which is which", async () => {
    // A dry run whose declared build cannot even be RENDERED -- an unmet
    // precondition, an unsupported host -- has found something real. Both
    // halves are wanted: the commands the git side would run, AND the reason
    // the other side would not. The code is the delegate's.
    const result = await withDeclaration(
      {
        lanes: { only: { stack: "s", cwd: "." } },
        defaultLane: "only",
        verbs: { only: { build: { exe: "placeholder-tool", argv: ["build"] } } },
        hosts: { build: ["darwin"] },
      },
      ["warmup", "--branch", BRANCH, "--dry-run"],
      { script: happyPath(), platform: "linux" },
    );
    expect(result.code).toBe(3);
    expect(result.seams.calls).toEqual([]);
    expect(result.out.join("\n")).toMatch(/would run: {5}git fetch origin/);
    expect(result.err.join("\n")).toMatch(/nothing ran, and the declared 'build' would not pass/);
  });

  it("maps a dry run's delegated 2 to 1 there too, so the two forms agree", async () => {
    const result = await withDeclaration(
      {
        lanes: { only: { stack: "s", cwd: "." } },
        defaultLane: "only",
        verbs: { only: { build: { exe: "placeholder-tool", argv: ["build"] } } },
        preconditions: { only: [{ kind: "path", value: "never-built", why: "install first" }] },
      },
      ["warmup", "--branch", BRANCH, "--dry-run"],
      { script: happyPath() },
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/the executor answered 2, reported above; warmup exits 1/);
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

  it("prints NO document on a refusal that changed nothing", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--json"], {
      script: happyPath([{ match: ANCESTOR, result: { code: 1 } }]),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
  });

  it("prints the document on a refusal that already changed something", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--discard", "--json"], {
      script: happyPath([ok(STATUS, "?? a.txt\0"), ok(STATUS, ""), { match: ANCESTOR, result: { code: 1 } }]),
    });
    expect(result.code).toBe(2);
    const report = JSON.parse(result.out.join("\n")) as { exitCode: number };
    expect(report.exitCode).toBe(2);
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

  it("says in the family usage that --repo is bracketed everywhere but 'warmup'", async () => {
    const out: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (): void => {} };
    await runFamily(shuCommand, ["shu", "--help"], SHU_REPO, false, io, new ScriptedSeams([]));
    expect(out.join("\n")).toMatch(/--repo.*is REQUIRED on 'warmup'/s);
  });
});
