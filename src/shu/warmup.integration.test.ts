// src/shu/warmup.integration.test.ts -- `nen shu warmup` against the REAL git,
// in a temporary repository with a real (local) `origin`.
//
// WHY THIS EXISTS BESIDE THE SCRIPTED SUITE. ./warmup.test.ts proves nen sends
// the argv it means to send, which is the half a recorded seam can prove. It
// cannot prove those argv MEAN what this verb's author thought: that
// `git branch --force <trunk> origin/<trunk>` really advances a branch that is
// not checked out, that `git merge --ff-only` really is the form for one that
// is, that `git switch -c <name> origin/<trunk>` really cuts from the tip the
// fetch just brought down, and that `git clean -fd` really leaves an ignored
// file alone. Every one of those is a claim about git, and only git can answer
// it. Three of them were spelled a different way in an earlier draft of this
// verb and were wrong in a way no scripted test could have caught.
//
// IT IS THE ONLY TEST IN THIS REPOSITORY THAT RUNS A REAL SUBPROCESS FOR A
// VERB, and it is deliberately small: one clone, four commits, three
// invocations, no network. It SKIPS rather than fails where `git` is not on
// PATH -- a machine without git is not a machine this rule was broken on -- and
// the skip is loud in the reporter rather than silent.
//
// NO GLOBAL CONFIG IS DISABLED, on purpose. `GIT_CONFIG_GLOBAL=/dev/null` is
// the usual trick and it is a POSIX path, so it would make this file behave
// differently on the win32 CI lane -- which is the exact class of defect this
// repository's matrix exists to catch. Identity is passed per-invocation with
// `-c` instead, which works identically everywhere.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { shuCommand } from "./command.js";

/** The identity every commit below is made with. Nobody's, and never read back. */
const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];

function git(cwd: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function mustGit(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.code}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Is there a `git` here, new enough for this fixture to build itself?
 *
 * 2.28 is `git init --initial-branch`, which is what lets this file state the
 * trunk's name instead of depending on the host's `init.defaultBranch` -- and
 * a fixture that silently built a `master` on one machine and a `main` on
 * another would be testing the machine. The VERB needs less than that (2.22 for
 * `branch --show-current`, 2.23 for `switch`), so this floor is the fixture's
 * and not the contract's. A host below it SKIPS: an old git is not a machine
 * this rule was broken on, and failing there would be a red build that says
 * nothing about the code.
 */
function usableGit(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return false;
  const version = /(\d+)\.(\d+)/.exec(probe.stdout ?? "");
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return major > 2 || (major === 2 && minor >= 28);
}

const HAVE_GIT = usableGit();

/**
 * Line endings are pinned OFF, per repository, and this is not a detail.
 *
 * Git for Windows installs with `core.autocrlf=true`, so a file committed with
 * LF is checked out with CRLF -- and every `writeFileSync` below writes LF.
 * Without this, "is the tree clean" would answer differently on the win32 CI
 * lane than on the other two, which is the exact class of platform-conditional
 * defect this repository's matrix exists to catch.
 */
function pinLineEndings(repo: string): void {
  mustGit(repo, ["config", "core.autocrlf", "false"]);
}

async function warmup(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(shuCommand, ["shu", ...argv], null, false, io, defaultSeams());
  return { code, out, err };
}

describe.skipIf(!HAVE_GIT)("nen shu warmup, against the real git", () => {
  let root = "";
  let upstream = "";
  let work = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nen-warmup-git-"));
    upstream = join(root, "upstream");
    work = join(root, "work");
    mkdirSync(upstream);

    // `--initial-branch` rather than a config edit, so this does not depend on
    // whatever `init.defaultBranch` the host happens to carry.
    mustGit(upstream, ["init", "--quiet", "--initial-branch=main"]);
    pinLineEndings(upstream);
    writeFileSync(join(upstream, "README.md"), "root\n");
    // The ignore rule is in the ROOT commit, so every branch cut from the trunk
    // carries it. Committing it only in the clone would make `cache/` ignored on
    // one branch and untracked on the one warmup then cuts, and the test would
    // be measuring the fixture rather than the verb.
    writeFileSync(join(upstream, ".gitignore"), "cache/\n");
    mustGit(upstream, ["add", "README.md", ".gitignore"]);
    mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "root"]);

    mustGit(root, ["clone", "--quiet", upstream, work]);
    pinLineEndings(work);

    // The trunk moves AFTER the clone: this is the whole point of the fetch and
    // the fast-forward, and a clone that was already current would prove
    // neither.
    writeFileSync(join(upstream, "README.md"), "root\nsecond\n");
    mustGit(upstream, ["add", "README.md"]);
    mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "second"]);
  });

  afterAll(() => {
    if (root === "") return;
    try {
      // `maxRetries` and a swallowed failure, because a `.git` object store is
      // read-only on win32 and a temp directory the OS will not release is not
      // a finding about this verb -- it is a red afterAll hiding a green suite.
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS keeps it; the tmpdir is the OS's to reap */
    }
  });

  it("fetches, fast-forwards the trunk it is standing on, and cuts the branch from the new tip", async () => {
    const behind = mustGit(work, ["rev-parse", "HEAD"]);
    const ahead = mustGit(upstream, ["rev-parse", "HEAD"]);
    expect(behind).not.toBe(ahead);

    const result = await warmup(["warmup", "--repo", work, "--branch", "first-idea"]);
    expect(result.err.join("\n")).toMatch(/no declaration -- build\/test verification skipped/);
    expect(result.code).toBe(0);

    expect(mustGit(work, ["branch", "--show-current"])).toBe("first-idea");
    expect(mustGit(work, ["rev-parse", "HEAD"])).toBe(ahead);
    // The LOCAL trunk moved too, which is the half a caller notices tomorrow.
    expect(mustGit(work, ["rev-parse", "main"])).toBe(ahead);
    expect(result.out.join("\n")).toMatch(/ran: {11}git merge --ff-only origin\/main/);
  });

  it("moves the trunk ref without touching the tree when the checkout is NOT on it", async () => {
    // Standing on `first-idea` from the test above. The trunk advances again.
    writeFileSync(join(upstream, "README.md"), "root\nsecond\nthird\n");
    mustGit(upstream, ["add", "README.md"]);
    mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "third"]);
    const ahead = mustGit(upstream, ["rev-parse", "HEAD"]);

    const result = await warmup(["warmup", "--repo", work, "--branch", "second-idea"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/ran: {11}git branch --force main origin\/main/);
    expect(mustGit(work, ["branch", "--show-current"])).toBe("second-idea");
    expect(mustGit(work, ["rev-parse", "main"])).toBe(ahead);
    expect(mustGit(work, ["rev-parse", "HEAD"])).toBe(ahead);
  });

  it("refuses a name that is already a branch, and leaves the checkout where it was", async () => {
    const before = mustGit(work, ["branch", "--show-current"]);
    const result = await warmup(["warmup", "--repo", work, "--branch", "first-idea"]);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/is already a local branch here/);
    expect(mustGit(work, ["branch", "--show-current"])).toBe(before);
  });

  it("refuses a dirty tree, then with --discard destroys the untracked work and SPARES the ignored file", async () => {
    writeFileSync(join(work, "README.md"), "edited\n");
    writeFileSync(join(work, "scratch.txt"), "untracked\n");
    mkdirSync(join(work, "cache"), { recursive: true });
    writeFileSync(join(work, "cache", "expensive.bin"), "hours of work\n");

    const refused = await warmup(["warmup", "--repo", work, "--branch", "third-idea"]);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toMatch(/carries 2 uncommitted path\(s\)/);
    expect(refused.err.join("\n")).toMatch(/scratch\.txt/);
    // The ignored file is not even LISTED: it is not dirty, and nothing here
    // would remove it.
    expect(refused.err.join("\n")).not.toMatch(/expensive\.bin/);

    const discarded = await warmup(["warmup", "--repo", work, "--branch", "third-idea", "--discard"]);
    expect(discarded.code).toBe(0);
    expect(mustGit(work, ["branch", "--show-current"])).toBe("third-idea");
    expect(mustGit(work, ["status", "--porcelain=v1", "-uall"])).toBe("");
    // The one assertion this whole file is worth writing for.
    expect(readdirSync(join(work, "cache"))).toEqual(["expensive.bin"]);
  });

  it("refuses a DIVERGED trunk rather than dropping the commits only the local one has", async () => {
    const diverged = join(root, "diverged");
    mustGit(root, ["clone", "--quiet", upstream, diverged]);
    pinLineEndings(diverged);
    writeFileSync(join(diverged, "local-only.txt"), "mine\n");
    mustGit(diverged, ["add", "local-only.txt"]);
    mustGit(diverged, [...WHO, "commit", "--quiet", "-m", "mine"]);
    const mine = mustGit(diverged, ["rev-parse", "HEAD"]);

    writeFileSync(join(upstream, "theirs.txt"), "theirs\n");
    mustGit(upstream, ["add", "theirs.txt"]);
    mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "theirs"]);

    const result = await warmup(["warmup", "--repo", diverged, "--branch", "nope"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/has DIVERGED from origin\/main/);
    // Nothing was moved, and nothing was cut.
    expect(mustGit(diverged, ["rev-parse", "main"])).toBe(mine);
    expect(git(diverged, ["show-ref", "--verify", "--quiet", "refs/heads/nope"]).code).toBe(1);
  });

  it("refuses a repository with no 'origin' before it fetches anything", async () => {
    const lonely = join(root, "lonely");
    mkdirSync(lonely);
    mustGit(lonely, ["init", "--quiet", "--initial-branch=main"]);
    pinLineEndings(lonely);
    writeFileSync(join(lonely, "a.txt"), "a\n");
    mustGit(lonely, ["add", "a.txt"]);
    mustGit(lonely, [...WHO, "commit", "--quiet", "-m", "root"]);

    const result = await warmup(["warmup", "--repo", lonely, "--branch", "x"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no remote named 'origin'/);
  });

  it("under --dry-run, changes nothing at all", async () => {
    const before = {
      branch: mustGit(work, ["branch", "--show-current"]),
      head: mustGit(work, ["rev-parse", "HEAD"]),
      refs: mustGit(work, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    };
    const result = await warmup(["warmup", "--repo", work, "--branch", "never-created", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/^would run: {5}git fetch origin$/m);
    expect({
      branch: mustGit(work, ["branch", "--show-current"]),
      head: mustGit(work, ["rev-parse", "HEAD"]),
      refs: mustGit(work, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    }).toEqual(before);
  });
});
