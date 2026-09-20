// src/shu/warmup-carry.test.ts -- `nen shu warmup --carry`, the third door
// beside a plain refusal and `--discard`.
//
// SAME HARNESS AS ./warmup.test.ts -- driven through the real dispatch
// (../index.ts's runFamily), with every git call a scripted seam entry so an
// argv this suite did not expect is a FAILURE rather than a silent pass. Kept
// as its own file (rather than folded into ./warmup.test.ts) so the harness
// constants below stay scoped to what `--carry` needs, and so a reader who
// only cares about the third door does not have to wade through the whole of
// the second one to find it.

import { describe, expect, it } from "vitest";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { SHU_REPO } from "../schema/fixtures/paths.js";
import { shuCommand } from "./command.js";

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
  const seams = new ScriptedSeams(options.script ?? [], {
    platform: "linux",
    env: { PLACEHOLDER_LANE_TOKEN: "a value no output may carry" },
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

// ── the goldens, the same strings ./warmup.test.ts uses ─────────────────────

const BRANCH = "carry-idea";
const HEAD = "git branch --show-current";
const IN_PROGRESS = "git rev-list --ignore-missing -1 MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD";
const MERGE_REF = "git rev-parse --verify --quiet MERGE_HEAD";
const REBASE_REF = "git rev-parse --verify --quiet REBASE_HEAD";
const PICK_REF = "git rev-parse --verify --quiet CHERRY_PICK_HEAD";
const STATUS = "git -c core.quotePath=false status --porcelain=v1 -z -uall";
const REMOTES = "git remote";
const TRUNK_REF = "git show-ref --verify --quiet refs/heads/main";
const WORKTREES = "git worktree list --porcelain";
const FETCH = "git fetch origin";
const ANCESTOR = "git merge-base --is-ancestor main origin/main";
const FF_REF = "git branch --force main origin/main";
const NAME_OK = `git check-ref-format --branch ${BRANCH}`;
const LOCAL_REF = `git show-ref --verify --quiet refs/heads/${BRANCH}`;
const REMOTE_REF = `git ls-remote --heads origin refs/heads/${BRANCH}`;
const SWITCH = `git switch -c ${BRANCH} origin/main`;
const DECLARED_BUILD = "pnpm turbo run build";
const PROOF_TREE = "git add -A -- .";
const STASH_MESSAGE = `nen shu warmup --carry ${BRANCH} 2026-01-01T00:00:00.000Z#${process.pid}`;
const STASH_PUSH = `git stash push --include-untracked -m ${STASH_MESSAGE}`;
/** The find-by-message step right after the push: SHA, tab, subject. */
const STASH_SHA = "git stash list --format=%H%x09%s";
const STASH_LIST = "git stash list --format=%H%x09%gd";
const STASH_APPLY = (sha: string): string => `git stash apply ${sha}`;
const STASH_CHECK = (ref: string): string => `git rev-parse --verify --quiet ${ref}`;
const STASH_DROP = (ref: string): string => `git stash drop ${ref}`;
const STASH_LIST_AFTER = "git stash list --format=%H";

const WT_NOBODY = `worktree ${SHU_REPO}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/some-branch\n\n`;

const DIRTY = "?? .env\0?? notes.md\0";
const STASH_SHA_VALUE = "abc123def456abc123def456abc123def456abc";
const STASH_REF = "stash@{0}";
/** `git stash list`'s answer when this run's own entry is the top (and only) one. */
const STASH_LIST_MATCH = `${STASH_SHA_VALUE}\t${STASH_REF}\n`;

/** The order every git call runs in on a tree carried, not discarded, not refused. */
function carryHappyPath(overrides: readonly ScriptedCall[] = []): readonly ScriptedCall[] {
  const base: ScriptedCall[] = [
    ok(HEAD, "some-branch\n"),
    ok(IN_PROGRESS),
    { match: MERGE_REF, result: { code: 1 } },
    { match: REBASE_REF, result: { code: 1 } },
    { match: PICK_REF, result: { code: 1 } },
    ok(STATUS, DIRTY),
    ok(REMOTES, "origin\n"),
    ok(TRUNK_REF),
    ok(WORKTREES, WT_NOBODY),
    ok(NAME_OK, `${BRANCH}\n`),
    { match: LOCAL_REF, result: { code: 1 } },
    ok(STASH_PUSH),
    ok(STASH_SHA, `${STASH_SHA_VALUE}\tOn some-branch: ${STASH_MESSAGE}\n`),
    ok(FETCH),
    ok(ANCESTOR),
    ok(FF_REF),
    ok(REMOTE_REF),
    ok(SWITCH),
    ok(DECLARED_BUILD),
    ok(PROOF_TREE),
    ok(STASH_APPLY(STASH_SHA_VALUE)),
    ok(STASH_LIST, STASH_LIST_MATCH),
    ok(STASH_CHECK(STASH_REF), `${STASH_SHA_VALUE}\n`),
    ok(STASH_DROP(STASH_REF)),
    ok(STASH_LIST_AFTER, ""),
  ];
  const overridden = new Set(overrides.map((entry): string => entry.match));
  return [...overrides, ...base.filter((entry): boolean => !overridden.has(entry.match))];
}

// ── (a) the happy path: stash, warm up, pop ─────────────────────────────────

describe("--carry on a dirty tree", () => {
  it("stashes before the fetch, records the SHA, and pops it back once the build has passed", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], { script: carryHappyPath() });
    expect(result.code).toBe(0);
    const argv = argvOf(result.seams);
    // Stashed BEFORE the fetch or any ref move -- the third door runs where
    // --discard's reset/clean would, and for the same reason: every free
    // question is answered first.
    expect(argv.indexOf(STATUS)).toBeLessThan(argv.indexOf(STASH_PUSH));
    expect(argv.indexOf(STASH_PUSH)).toBeLessThan(argv.indexOf(STASH_SHA));
    expect(argv.indexOf(STASH_SHA)).toBeLessThan(argv.indexOf(FETCH));
    // Listed, then popped by the ref that lookup matched to the SHA read
    // after the push -- never a blind 'stash@{0}' and never the raw SHA,
    // which 'git stash pop' refuses.
    // Restore by SHA first (no index can shift under an object name), then
    // list, check and drop by the re-resolved ref -- never a 'stash pop'.
    expect(argv.indexOf(STASH_APPLY(STASH_SHA_VALUE))).toBeLessThan(argv.indexOf(STASH_LIST));
    expect(argv.indexOf(STASH_LIST)).toBeLessThan(argv.indexOf(STASH_CHECK(STASH_REF)));
    expect(argv.indexOf(STASH_CHECK(STASH_REF))).toBeLessThan(argv.indexOf(STASH_DROP(STASH_REF)));
    expect(argv.some((line): boolean => line.startsWith("git stash pop"))).toBe(false);
    expect(argv.indexOf(DECLARED_BUILD)).toBeLessThan(argv.indexOf(STASH_APPLY(STASH_SHA_VALUE)));
  });

  it("never runs 'git reset --hard' or 'git clean -fd' -- --carry destroys nothing", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], { script: carryHappyPath() });
    expect(result.code).toBe(0);
    const argv = argvOf(result.seams);
    expect(argv).not.toContain("git reset --hard");
    expect(argv).not.toContain("git clean -fd");
  });

  it("reports carry: { requested, stashed, carried, restored } in --json", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--json"], {
      script: carryHappyPath(),
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as {
      carry: { requested: boolean; stashed: string | null; carried: readonly string[]; restored: boolean };
    };
    expect(report.carry).toEqual({
      requested: true,
      stashed: STASH_SHA_VALUE,
      carried: [".env", "notes.md"],
      restored: true,
    });
  });

  it("prints the carried paths and the stash SHA in the text rendering", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], { script: carryHappyPath() });
    const printed = result.out.join("\n");
    expect(printed).toMatch(new RegExp(`carry:.*${STASH_SHA_VALUE}`));
    expect(printed).toMatch(/\.env/);
    expect(printed).toMatch(/notes\.md/);
  });

  it("carries a staged change too, exactly as --discard would have destroyed it", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], {
      script: carryHappyPath([ok(STATUS, "A  staged.ts\0")]),
    });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toContain(STASH_PUSH);
  });
});

// ── (b) a clean tree: no-op ──────────────────────────────────────────────────

describe("--carry on a clean tree", () => {
  it("issues no stash command at all, and says there was nothing to carry", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], {
      script: carryHappyPath([ok(STATUS, "")]),
    });
    expect(result.code).toBe(0);
    const argv = argvOf(result.seams);
    expect(argv).not.toContain(STASH_PUSH);
    expect(argv).not.toContain(STASH_SHA);
    expect(argv).not.toContain(STASH_LIST);
    expect(argv.some((line): boolean => line.startsWith("git stash pop"))).toBe(false);
    expect(result.out.join("\n")).toMatch(/nothing to carry/);
  });

  it("reports carry: { requested: true, stashed: null, carried: [], restored: true }", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--json"], {
      script: carryHappyPath([ok(STATUS, "")]),
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as {
      carry: { requested: boolean; stashed: string | null; carried: readonly string[]; restored: boolean };
    };
    expect(report.carry).toEqual({ requested: true, stashed: null, carried: [], restored: true });
  });
});

// ── (c) --carry and --discard together: refused, naming both ────────────────

describe("--carry and --discard together", () => {
  it("is refused at exit 2, naming both flags, before a single git call", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--discard"], {
      script: carryHappyPath(),
    });
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const said = result.err.join("\n");
    expect(said).toMatch(/--carry/);
    expect(said).toMatch(/--discard/);
    expect(result.seams.calls).toHaveLength(0);
  });
});

// ── (d) the push itself fails ────────────────────────────────────────────────

describe("the stash push fails", () => {
  it("refuses at exit 1, quoting the failed step, before any fetch or ref move", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], {
      script: carryHappyPath([{ match: STASH_PUSH, result: { code: 1, stderr: "cannot save the current index state" } }]),
    });
    expect(result.code).toBe(1);
    const argv = argvOf(result.seams);
    expect(argv).not.toContain(FETCH);
    expect(argv).not.toContain(STASH_SHA);
    expect(result.err.join("\n")).toMatch(/git stash push --include-untracked/);
    expect(result.err.join("\n")).toMatch(/cannot save the current index state/);
  });
});

// ── (e) the pop conflicts or fails ───────────────────────────────────────────

describe("the stash apply fails after everything else succeeded", () => {
  it("does NOT drop the stash, prints the SHA and the exact recovery command, and exits 1", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], {
      script: carryHappyPath([
        { match: STASH_APPLY(STASH_SHA_VALUE), result: { code: 1, stderr: "CONFLICT (content): merge conflict" } },
      ]),
    });
    expect(result.code).toBe(1);
    const said = result.err.join("\n");
    expect(said).toMatch(new RegExp(`git stash apply ${STASH_SHA_VALUE}`));
    expect(said).toMatch(/NOT dropped/);
    expect(said).toMatch(/CONFLICT \(content\)/);
    // The branch cut stays in place -- nothing after the failed pop is undone.
    expect(argvOf(result.seams)).toContain(SWITCH);
  });

  it("reports restored: false and the stash SHA in --json when the apply fails", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--json"], {
      script: carryHappyPath([{ match: STASH_APPLY(STASH_SHA_VALUE), result: { code: 1, stderr: "conflict" } }]),
    });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as {
      carry: { requested: boolean; stashed: string | null; carried: readonly string[]; restored: boolean };
    };
    expect(report.carry.requested).toBe(true);
    expect(report.carry.stashed).toBe(STASH_SHA_VALUE);
    expect(report.carry.restored).toBe(false);
  });
});

// ── (e') the SHA is no longer on the stash list when the drop is due ────────

describe("the carried stash was dropped by hand before the restore", () => {
  it("restores anyway -- the apply addresses the object, not the list -- and says nothing was left to drop", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], {
      script: carryHappyPath([ok(STASH_LIST, "")]),
    });
    expect(result.code).toBe(0);
    const argv = argvOf(result.seams);
    expect(argv).toContain(STASH_APPLY(STASH_SHA_VALUE));
    expect(argv.some((line): boolean => line.startsWith("git stash drop") || line.startsWith("git stash pop"))).toBe(false);
    expect(result.err.join("\n")).toMatch(/no longer on 'git stash list'/);
  });

  it("reports restored: true in --json", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--json"], {
      script: carryHappyPath([ok(STASH_LIST, "")]),
    });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { carry: { stashed: string | null; restored: boolean } };
    expect(report.carry.stashed).toBe(STASH_SHA_VALUE);
    expect(report.carry.restored).toBe(true);
  });
});

// ── (e-race) the stack moved between the check and the drop ────────────────

describe("another stash lands between the ref check and the drop", () => {
  it("puts the foreign entry back with 'git stash store', leaves its own on the list, and still exits 0 restored", async () => {
    const foreign = "ffff000000000000000000000000000000000000";
    const ref = "stash@{1}";
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], {
      script: carryHappyPath([
        // Before the drop: a foreign entry on top, this run's own below it.
        ok(STASH_LIST, `${foreign}\tstash@{0}\n${STASH_SHA_VALUE}\t${ref}\n`),
        ok(STASH_CHECK(ref), `${STASH_SHA_VALUE}\n`),
        ok(STASH_DROP(ref)),
        // After the drop: this run's own SHA is STILL listed -- the drop took the foreign one.
        ok(STASH_LIST_AFTER, `${STASH_SHA_VALUE}\n`),
        ok(`git stash store -m restored by nen shu warmup: dropped by mistake while dropping ${STASH_SHA_VALUE} ${foreign}`),
      ]),
    });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams)).toContain(`git stash store -m restored by nen shu warmup: dropped by mistake while dropping ${STASH_SHA_VALUE} ${foreign}`);
    const said = result.err.join("\n");
    expect(said).toMatch(new RegExp(`the drop took ${foreign} instead of ${STASH_SHA_VALUE}`));
    expect(said).toMatch(/put back with 'git stash store/);
  });

  it("refuses the drop when the ref no longer names the SHA at the check", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], {
      script: carryHappyPath([ok(STASH_CHECK(STASH_REF), "0000000000000000000000000000000000000000\n")]),
    });
    expect(result.code).toBe(0);
    expect(argvOf(result.seams).some((line): boolean => line.startsWith("git stash drop"))).toBe(false);
    expect(result.err.join("\n")).toMatch(/no longer names/);
  });
});

// ── (e'') a failure between the push and the pop still names the SHA ───────

describe("a failure between the stash push and the pop", () => {
  it("names the SHA and 'git stash apply <sha>' on a fetch failure, and keeps restored: false", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--json"], {
      script: carryHappyPath([{ match: FETCH, result: { code: 1, stderr: "could not resolve host" } }]),
    });
    expect(result.code).toBe(1);
    const said = result.err.join("\n");
    expect(said).toMatch(new RegExp(`git stash apply ${STASH_SHA_VALUE}`));
    const report = JSON.parse(result.out.join("\n")) as {
      carry: { requested: boolean; stashed: string | null; carried: readonly string[]; restored: boolean };
    };
    expect(report.carry.stashed).toBe(STASH_SHA_VALUE);
    expect(report.carry.restored).toBe(false);
  });

  it("names the SHA and 'git stash apply <sha>' when the trunk has diverged", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry"], {
      script: carryHappyPath([{ match: ANCESTOR, result: { code: 1 } }]),
    });
    expect(result.code).toBe(2);
    const said = result.err.join("\n");
    expect(said).toMatch(new RegExp(`git stash apply ${STASH_SHA_VALUE}`));
  });
});

// ── (f) --dry-run: prints the stash/pop commands, executes neither ──────────

describe("--carry under --dry-run", () => {
  it("prints 'would run:' for the stash push and the pop, and runs neither", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--dry-run"], {
      script: [ok(WORKTREES, WT_NOBODY)],
    });
    expect(result.code).toBe(0);
    const printed = result.out.join("\n");
    expect(printed).toMatch(/would run:\s+git stash push --include-untracked/);
    expect(printed).toMatch(/would run:\s+git stash list --format=%H%x09%s/);
    expect(printed).toMatch(/would run:\s+git stash list --format=%H%x09%gd/);
    expect(printed).toMatch(/would run:\s+git stash apply/);
    expect(printed).not.toMatch(/git stash pop/);
    expect(printed).not.toMatch(/ran:\s+git stash/);
    // The one command a dry run performs at all is the worktree read.
    expect(argvOf(result.seams)).toEqual([WORKTREES]);
  });

  it("reports carry: { requested: true, stashed: null, carried: [], restored: true } under --dry-run", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--dry-run", "--json"], {
      script: [ok(WORKTREES, WT_NOBODY)],
    });
    const report = JSON.parse(result.out.join("\n")) as {
      carry: { requested: boolean; stashed: string | null; carried: readonly string[]; restored: boolean };
    };
    expect(report.carry).toEqual({ requested: true, stashed: null, carried: [], restored: true });
  });

  it("omits every --carry line when the flag was not given", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--dry-run"], { script: [ok(WORKTREES, WT_NOBODY)] });
    const printed = result.out.join("\n");
    expect(printed).not.toMatch(/stash/);
  });
});

// ── (g) --tests: the pop still runs after the test, not just the build ──────

describe("--carry with --tests", () => {
  it("pops after the test, not merely after the build", async () => {
    const result = await capture(["warmup", "--branch", BRANCH, "--carry", "--tests"], {
      script: carryHappyPath([
        ok(DECLARED_BUILD),
        ok(PROOF_TREE),
        ok("pnpm exec vitest run"),
      ]),
    });
    expect(result.code).toBe(0);
    const argv = argvOf(result.seams);
    expect(argv.indexOf("pnpm exec vitest run")).toBeLessThan(argv.indexOf(STASH_APPLY(STASH_SHA_VALUE)));
  });
});
