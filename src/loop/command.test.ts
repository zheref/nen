import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { spawnRunner, type CommandResult, type Seams } from "../seam/exec.js";
import { loopCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

async function capture(
  argv: readonly string[],
  options: { repoFlag?: string | null; json?: boolean } = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = {
    // `loop iterate` asks git for the common directory; nothing else runs.
    run: (command, args, runOptions): CommandResult => {
      if (command !== "git") throw new Error(`loop makes no ${command} call`);
      return spawnRunner(command, args, runOptions);
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("this verb has no watched form");
    },
    platform: "linux",
  };
  const code = await runFamily(
    loopCommand,
    argv,
    options.repoFlag ?? null,
    options.json ?? false,
    io,
    seams,
  );
  return { code, out, err };
}

describe("nen loop slots -- CLI wiring", () => {
  it("exits 1 when a budget is fully occupied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([
      { id: "a", plane: "ci", prOpen: false },
      { id: "b", plane: "ci", prOpen: false },
    ]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/BINDING/);
  });

  it("exits 0 with free slots on both planes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(0);
  });

  it("reports a schema error from the efforts file loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([{ id: "a" }]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/must be "ci" or "local"/);
  });

  it("requires --efforts", async () => {
    expect((await capture(["loop", "slots"])).code).toBe(2);
  });
});

// Issue #52: --local-cap used to default to 7 -- more than three times looser
// than every real caller's own policy of 2, and loose-by-default is the wrong
// direction for a safety cap. The flag is now required, and the refusal follows
// the required-flag convention (exit 2, actionable message).
describe("nen loop slots -- --local-cap is required (issue #52)", () => {
  it("refuses an omitted --local-cap with exit 2 and an actionable message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path]);
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    // The refusal must name the flag, say the old default was removed, and say
    // why -- a guard is chosen, not inherited -- so a caller knows the next step.
    expect(message).toMatch(/--local-cap is required/);
    expect(message).toMatch(/default of 7 was removed/);
    expect(message).toMatch(/chosen, not inherited/);
  });

  it("refuses before reading the efforts file -- a wrong invocation is not masked by file content", async () => {
    const result = await capture(["loop", "slots", "--efforts", "does-not-exist.json"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--local-cap is required/);
  });

  it("honors an explicit --local-cap end-to-end, in the report and the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([
      { id: "local-1", plane: "local", prOpen: false },
      { id: "local-2", plane: "local", prOpen: false },
    ]));
    // Under the old default of 7 these two efforts left 5 free and exit 0;
    // under the caller's actual policy of 2 the budget is BINDING and exit 1.
    const bound = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2", "--json"]);
    expect(bound.code).toBe(1);
    const report = JSON.parse(bound.out.join("\n")) as { local: { cap: number; binding: boolean } };
    expect(report.local).toMatchObject({ cap: 2, occupied: 2, free: 0, binding: true });

    const roomy = await capture(["loop", "slots", "--efforts", path, "--local-cap", "3"]);
    expect(roomy.code).toBe(0);
  });

  it("still defaults --ci-cap to 2 -- the omission errs tight, not loose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { ci: { cap: number } };
    expect(report.ci.cap).toBe(2);
  });
});

// zheref/nen#47. `parse izanagi` refuses an invocation with no cap and then
// never sees iteration 2; `watch until --max-iterations` is a different bound on
// izanami's read-only loop. This is the backstop, and these cases drive it the
// way a caller does -- once per iteration, through a real ledger on disk.
describe("nen loop iterate -- izanagi's cap, enforced across a loop", () => {
  const LINE = "address the backlog until it is empty up to 3";

  function repo(): string {
    return mkdtempSync(join(tmpdir(), "nen-loop-"));
  }

  it("counts each claim and REFUSES the one past the cap, at exit 1", async () => {
    const root = repo();
    for (const expected of [1, 2, 3]) {
      const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
        repoFlag: root,
      });
      expect(result.code, `iteration ${expected}`).toBe(0);
      expect(result.out[0]).toBe(`iteration ${expected}/3 -- address the backlog until it is empty`);
    }
    const past = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    // EXIT 1, NOT 2: the invocation was well-formed and nen did exactly what it
    // was asked, which was to stop here. That is an answer, not a complaint.
    expect(past.code).toBe(1);
    expect(past.err.join("\n")).toContain("all 3 iteration(s)");
  });

  it("refuses a claim that re-types the line with a bigger cap", async () => {
    const root = repo();
    await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    const raised = await capture(
      ["loop", "iterate", "--id", "sweep", "--line", "address the backlog until it is empty up to 30"],
      { repoFlag: root },
    );
    expect(raised.code).toBe(2);
    expect(raised.err.join("\n")).toContain("is not a cap");
  });

  it("releases a loop, and refuses a claim after it", async () => {
    const root = repo();
    await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    const released = await capture(
      ["loop", "iterate", "--id", "sweep", "--line", LINE, "--release", "the condition became true"],
      { repoFlag: root },
    );
    expect(released.code).toBe(0);
    expect(released.out[0]).toContain("released sweep after 1/3");
    const after = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    expect(after.code).toBe(2);
    expect(after.err.join("\n")).toContain("begin a new one under its own --id");
  });

  it("refuses a line the izanagi grammar does not accept", async () => {
    const result = await capture(
      ["loop", "iterate", "--id", "sweep", "--line", "address the backlog until it is empty"],
      { repoFlag: repo() },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("required grammar");
  });

  it("refuses an --id that is not one path segment", async () => {
    const result = await capture(["loop", "iterate", "--id", "../etc", "--line", LINE], {
      repoFlag: repo(),
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("REFUSED rather than sanitised");
  });

  it("keeps two ids on two separate ledgers, with two separate caps", async () => {
    const root = repo();
    const other = "do the other thing until it is done up to 1";
    await capture(["loop", "iterate", "--id", "a", "--line", LINE], { repoFlag: root });
    const b = await capture(["loop", "iterate", "--id", "b", "--line", other], { repoFlag: root });
    expect(b.code).toBe(0);
    expect(b.out[0]).toBe("iteration 1/1 -- do the other thing until it is done");
    // b is at its cap; a is not.
    expect((await capture(["loop", "iterate", "--id", "b", "--line", other], { repoFlag: root })).code).toBe(1);
    expect((await capture(["loop", "iterate", "--id", "a", "--line", LINE], { repoFlag: root })).code).toBe(0);
  });

  it("reports the claim as one --json document", async () => {
    const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
      repoFlag: repo(),
      json: true,
    });
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(document["contract"]).toBe("nen.loop.iterate/v0.1");
    expect(document["claimed"]).toBe(true);
    expect(document["capReached"]).toBe(false);
    expect(document["iterations"]).toBe(1);
    expect(document["remaining"]).toBe(2);
  });

  it("says capReached under --json when the cap refuses a claim", async () => {
    const root = repo();
    const one = "act until done up to 1";
    await capture(["loop", "iterate", "--id", "x", "--line", one], { repoFlag: root });
    const past = await capture(["loop", "iterate", "--id", "x", "--line", one], {
      repoFlag: root,
      json: true,
    });
    expect(past.code).toBe(1);
    const document = JSON.parse(past.out.join("\n")) as Record<string, unknown>;
    expect(document["capReached"]).toBe(true);
    expect(document["claimed"]).toBe(false);
  });

  it("refuses rather than starting again when the ledger cannot be read", async () => {
    // A loop whose count nen cannot read has an unknown number of writes behind
    // it, and beginning at 1 would hand out a whole cap's worth more.
    const root = repo();
    await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    writeFileSync(join(root, ".nen", "loop", "sweep.json"), "{ not json", "utf8");
    const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
      repoFlag: root,
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("Refusing rather than starting the count again");
  });

  it("refuses an UNREADABLE ledger rather than reading it as a loop that never began", async () => {
    // Copilot, PR #185. A blanket catch read EACCES/EPERM/EISDIR as "no ledger",
    // which restarts the count -- handing out a whole fresh cap on exactly the
    // machine that cannot tell how much of the old one was spent. Only "it is
    // not there" means "no ledger". Driven with a DIRECTORY at the ledger's own
    // path, which reproduces the class (EISDIR) without needing chmod, and so
    // behaves the same on every CI lane including the one running as root.
    const root = repo();
    mkdirSync(join(root, ".nen", "loop", "sweep.json"), { recursive: true });
    const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
      repoFlag: root,
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("could not be read");
    expect(result.err.join("\n")).toContain("a whole cap's worth of iterations");
  });

  it("refuses a ledger whose numbers are not meaningful", async () => {
    const root = repo();
    await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], { repoFlag: root });
    const at = join(root, ".nen", "loop", "sweep.json");
    const stored = JSON.parse(readFileSync(at, "utf8")) as Record<string, unknown>;
    writeFileSync(at, JSON.stringify({ ...stored, iterations: 99 }), "utf8");
    const result = await capture(["loop", "iterate", "--id", "sweep", "--line", LINE], {
      repoFlag: root,
    });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("is not a 'nen.loop.iterate/v0.1' ledger");
  });
});

// Finding D2 / autonomy-loop#1 of Hatsu's SDD plan: the ledger lived in the
// effort worktree's own `.nen/`, which a worktree cleanup removes, and ENOENT
// then read as "no loop began" -- a whole fresh cap. These drive the durable
// home, the lost-ledger rule and the one-time migration through real git.
describe("nen loop iterate -- the ledger lives in the git common directory", () => {
  const LINE = "address the backlog until it is empty up to 3";

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  }

  /** A repository with one commit and one linked worktree. */
  function repoWithWorktree(): { core: string; worktree: string; common: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "nen-loop-git-")));
    const core = join(base, "core");
    mkdirSync(core);
    git(core, "init", "-q", "-b", "main");
    git(core, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = join(base, "wt");
    git(core, "worktree", "add", "-q", "-b", "effort", worktree);
    return { core, worktree, common: join(core, ".git") };
  }

  it("resolves the ledger against the common dir from a linked worktree", async () => {
    const { core, worktree, common } = repoWithWorktree();
    const result = await capture(["loop", "iterate", "--id", "en-NN-1", "--line", LINE], {
      repoFlag: worktree,
      json: true,
    });
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    // Compared as real paths: git may spell the directory differently from
    // tmpdir() (macOS /private, Windows short names) while naming the same file.
    expect(realpathSync.native(String(document["path"]))).toBe(
      realpathSync.native(join(common, ".nen", "loop", "en-NN-1.json")),
    );
    expect(document["durable"]).toBe(true);
    expect(document["migratedFrom"]).toBeNull();
    expect(existsSync(join(common, ".nen", "loop", "en-NN-1.opened"))).toBe(true);
    expect(existsSync(join(worktree, ".nen", "loop", "en-NN-1.json"))).toBe(false);
    // The SAME loop, claimed from the main checkout, continues the count.
    const second = await capture(["loop", "iterate", "--id", "en-NN-1", "--line", LINE], { repoFlag: core });
    expect(second.code).toBe(0);
    expect(second.out[0]).toBe("iteration 2/3 -- address the backlog until it is empty");
  });

  it("keeps the count when the effort worktree is removed", async () => {
    const { core, worktree } = repoWithWorktree();
    await capture(["loop", "iterate", "--id", "en-NN-2", "--line", LINE], { repoFlag: worktree });
    git(core, "worktree", "remove", "--force", worktree);
    const after = await capture(["loop", "iterate", "--id", "en-NN-2", "--line", LINE], { repoFlag: core });
    expect(after.code).toBe(0);
    expect(after.out[0]).toBe("iteration 2/3 -- address the backlog until it is empty");
  });

  it("reads a missing ledger with no marker as a fresh loop", async () => {
    const { worktree } = repoWithWorktree();
    const result = await capture(["loop", "iterate", "--id", "fresh", "--line", LINE], { repoFlag: worktree });
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("iteration 1/3 -- address the backlog until it is empty");
  });

  it("refuses a missing ledger beside its .opened marker with exit 2, 'ledger lost'", async () => {
    const { worktree, common } = repoWithWorktree();
    await capture(["loop", "iterate", "--id", "lost", "--line", LINE], { repoFlag: worktree });
    unlinkSync(join(common, ".nen", "loop", "lost.json"));
    const result = await capture(["loop", "iterate", "--id", "lost", "--line", LINE], { repoFlag: worktree });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("ledger lost");
    expect(result.out).toEqual([]);
    // And a release of a lost loop is refused the same way, not as "never begun".
    const release = await capture(
      ["loop", "iterate", "--id", "lost", "--line", LINE, "--release", "done"],
      { repoFlag: worktree },
    );
    expect(release.code).toBe(2);
    expect(release.err.join("\n")).toContain("ledger lost");
  });

  it("migrates a ledger an earlier build of this change left at <common>/nen/loop/ to <common>/.nen/loop/ once", async () => {
    const { worktree, common } = repoWithWorktree();
    const legacy = mkdtempSync(join(tmpdir(), "nen-loop-"));
    await capture(["loop", "iterate", "--id", "spelt", "--line", LINE], { repoFlag: legacy });
    mkdirSync(join(common, "nen", "loop"), { recursive: true });
    writeFileSync(join(common, "nen", "loop", "spelt.json"), readFileSync(join(legacy, ".nen", "loop", "spelt.json"), "utf8"), "utf8");
    const result = await capture(["loop", "iterate", "--id", "spelt", "--line", LINE], { repoFlag: worktree });
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("iteration 2/3 -- address the backlog until it is empty");
    expect(existsSync(join(common, "nen", "loop", "spelt.json"))).toBe(false);
    expect(existsSync(join(common, ".nen", "loop", "spelt.json"))).toBe(true);
  });

  it("refuses a --repo that does not exist at exit 2 and creates nothing", async () => {
    const base = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const missing = join(base, "does", "not", "exist");
    const result = await capture(["loop", "iterate", "--id", "z", "--line", "x until y up to 2"], { repoFlag: missing });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("does not exist");
    expect(existsSync(join(base, "does"))).toBe(false);
  });

  it("serialises parallel claims from separate processes: N granted claims leave iterations === N", async () => {
    const { core, common } = repoWithWorktree();
    const entry = join(process.cwd(), "src", "index.ts");
    const claims = Array.from({ length: 8 }, () =>
      new Promise<number>((done) => {
        execFile(process.execPath.endsWith("bun") ? process.execPath : "bun", [entry, "loop", "iterate", "--repo", core, "--id", "race", "--line", "fix it until green up to 50"], (error) => done(error === null ? 0 : ((error as { code?: number }).code ?? 1)));
      }),
    );
    const codes = await Promise.all(claims);
    const granted = codes.filter((code) => code === 0).length;
    const ledger = JSON.parse(readFileSync(join(common, ".nen", "loop", "race.json"), "utf8")) as { iterations: number };
    expect(ledger.iterations).toBe(granted);
    expect(granted).toBe(8);
  }, 60_000);

  it("applies the lost-ledger rule in the worktree-local fallback too", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-loop-"));
    await capture(["loop", "iterate", "--id", "lost", "--line", LINE], { repoFlag: root });
    expect(existsSync(join(root, ".nen", "loop", "lost.opened"))).toBe(true);
    unlinkSync(join(root, ".nen", "loop", "lost.json"));
    const result = await capture(["loop", "iterate", "--id", "lost", "--line", LINE], { repoFlag: root });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("ledger lost");
  });

  it("migrates a ledger from the old worktree-local path once, and reports it", async () => {
    const { worktree, common } = repoWithWorktree();
    // Begin the loop the way an older build did: worktree-local, no marker.
    const legacy = mkdtempSync(join(tmpdir(), "nen-loop-"));
    await capture(["loop", "iterate", "--id", "old", "--line", LINE], { repoFlag: legacy });
    const legacyLedger = readFileSync(join(legacy, ".nen", "loop", "old.json"), "utf8");
    mkdirSync(join(worktree, ".nen", "loop"), { recursive: true });
    const oldPath = join(worktree, ".nen", "loop", "old.json");
    writeFileSync(oldPath, legacyLedger, "utf8");

    const result = await capture(["loop", "iterate", "--id", "old", "--line", LINE], {
      repoFlag: worktree,
      json: true,
    });
    expect(result.code).toBe(0);
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(document["iterations"]).toBe(2);
    expect(realpathSync.native(dirname(String(document["migratedFrom"])))).toBe(realpathSync.native(dirname(oldPath)));
    expect(result.err.join("\n")).toContain("migrated loop ledger 'old'");
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(join(common, ".nen", "loop", "old.json"))).toBe(true);

    // Once: the next claim reads the durable home and reports nothing moved.
    const next = await capture(["loop", "iterate", "--id", "old", "--line", LINE], {
      repoFlag: worktree,
      json: true,
    });
    expect(next.code).toBe(0);
    expect((JSON.parse(next.out.join("\n")) as Record<string, unknown>)["migratedFrom"]).toBeNull();
    expect(next.err).toEqual([]);
  });

  it("marks a migrated loop opened even when the claim after the move is refused at the cap", async () => {
    const { worktree, common } = repoWithWorktree();
    const one = "act until done up to 1";
    const legacy = mkdtempSync(join(tmpdir(), "nen-loop-"));
    await capture(["loop", "iterate", "--id", "full", "--line", one], { repoFlag: legacy });
    mkdirSync(join(worktree, ".nen", "loop"), { recursive: true });
    writeFileSync(
      join(worktree, ".nen", "loop", "full.json"),
      readFileSync(join(legacy, ".nen", "loop", "full.json"), "utf8"),
      "utf8",
    );
    const capped = await capture(["loop", "iterate", "--id", "full", "--line", one], { repoFlag: worktree });
    expect(capped.code).toBe(1);
    unlinkSync(join(common, ".nen", "loop", "full.json"));
    const lost = await capture(["loop", "iterate", "--id", "full", "--line", one], { repoFlag: worktree });
    expect(lost.code).toBe(2);
    expect(lost.err.join("\n")).toContain("ledger lost");
  });

  it("finds and migrates an older build's ledger left in ANOTHER worktree", async () => {
    const { core, worktree, common } = repoWithWorktree();
    const legacy = mkdtempSync(join(tmpdir(), "nen-loop-"));
    await capture(["loop", "iterate", "--id", "elsewhere", "--line", LINE], { repoFlag: legacy });
    mkdirSync(join(worktree, ".nen", "loop"), { recursive: true });
    writeFileSync(
      join(worktree, ".nen", "loop", "elsewhere.json"),
      readFileSync(join(legacy, ".nen", "loop", "elsewhere.json"), "utf8"),
      "utf8",
    );
    // Claimed from the MAIN checkout, not the worktree that holds the old file.
    const result = await capture(["loop", "iterate", "--id", "elsewhere", "--line", LINE], { repoFlag: core });
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("iteration 2/3 -- address the backlog until it is empty");
    expect(existsSync(join(worktree, ".nen", "loop", "elsewhere.json"))).toBe(false);
    expect(existsSync(join(common, ".nen", "loop", "elsewhere.opened"))).toBe(true);
  });

  it("refuses an older build's ledger in two worktrees at once", async () => {
    const { core, worktree } = repoWithWorktree();
    const legacy = mkdtempSync(join(tmpdir(), "nen-loop-"));
    await capture(["loop", "iterate", "--id", "split", "--line", LINE], { repoFlag: legacy });
    const text = readFileSync(join(legacy, ".nen", "loop", "split.json"), "utf8");
    for (const at of [core, worktree]) {
      mkdirSync(join(at, ".nen", "loop"), { recursive: true });
      writeFileSync(join(at, ".nen", "loop", "split.json"), text, "utf8");
    }
    const result = await capture(["loop", "iterate", "--id", "split", "--line", LINE], { repoFlag: core });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("2 homes at once");
  });

  it("refuses a ledger found in both homes rather than choosing a count", async () => {
    const { worktree, common } = repoWithWorktree();
    await capture(["loop", "iterate", "--id", "twice", "--line", LINE], { repoFlag: worktree });
    mkdirSync(join(worktree, ".nen", "loop"), { recursive: true });
    writeFileSync(
      join(worktree, ".nen", "loop", "twice.json"),
      readFileSync(join(common, ".nen", "loop", "twice.json"), "utf8"),
      "utf8",
    );
    const result = await capture(["loop", "iterate", "--id", "twice", "--line", LINE], { repoFlag: worktree });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("2 homes at once");
  });

  it("refuses an unrecognised file at the old path rather than migrating it", async () => {
    const { worktree, common } = repoWithWorktree();
    mkdirSync(join(worktree, ".nen", "loop"), { recursive: true });
    writeFileSync(join(worktree, ".nen", "loop", "junk.json"), "{ not json", "utf8");
    const result = await capture(["loop", "iterate", "--id", "junk", "--line", LINE], { repoFlag: worktree });
    expect(result.code).toBe(2);
    expect(existsSync(join(common, ".nen", "loop", "junk.json"))).toBe(false);
    expect(existsSync(join(worktree, ".nen", "loop", "junk.json"))).toBe(true);
  });
});
