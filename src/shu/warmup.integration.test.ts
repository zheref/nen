// src/shu/warmup.integration.test.ts -- `nen shu warmup` against the REAL git,
// in a temporary repository with a real (local) `origin`.
//
// WHY THIS EXISTS BESIDE THE SCRIPTED SUITE. ./warmup.test.ts proves nen sends
// the argv it means to send, which is the half a recorded seam can prove. It
// cannot prove those argv MEAN what this verb's author thought: that
// `git branch --force <trunk> origin/<trunk>` really advances a branch that is
// not checked out, that `git merge --ff-only` really is the form for one that
// is, that `git switch -c <name> origin/<trunk>` really cuts from the tip the
// fetch just brought down, that `git reset --hard` really destroys a STAGED
// change where `git checkout -- .` does not, that `git clean -fd` really leaves
// an ignored file alone AND really refuses to delete a nested repository, and
// that `ls-remote --heads origin refs/heads/x` really does not match a
// `refs/heads/feat/x` that is already there. Every one of those is a claim
// about git, and only git can answer it. Several of them were spelled a
// different way in an earlier draft of this verb and were wrong in a way no
// scripted test could have caught.
//
// IT IS THE ONLY TEST IN THIS REPOSITORY THAT RUNS A REAL SUBPROCESS FOR A
// VERB, and it is deliberately small: one clone, a handful of commits, no
// network at all. It SKIPS rather than fails where `git` is not on PATH -- a
// machine without git is not a machine this rule was broken on -- and the skip
// is loud in the reporter rather than silent.
//
// LINE ENDINGS ARE PINNED AT THE CLONE, NOT AFTER IT, and that is blocker B3.
// Git for Windows installs with a GLOBAL `core.autocrlf=true`, and the CI
// matrix runs windows-latest: a `git clone` under that global writes every
// working-tree file with CRLF, and a per-repository pin applied AFTERWARDS
// flips the setting without rewriting the files -- so `git status` reports the
// whole tree modified and warmup correctly refuses a dirty tree where this file
// asserts 0. The fix is to pin it ON THE CLONE ITSELF (`git -c
// core.autocrlf=false clone`), which decides how the checkout is written; the
// per-repository pin stays as well, for every later command. One test below
// SIMULATES that global through `GIT_CONFIG_GLOBAL` so the fix is pinned on the
// POSIX lanes too rather than only being true on a machine none of the authors
// has.
//
// THE USER'S OWN GLOBAL CONFIG IS NEVER TOUCHED. `GIT_CONFIG_GLOBAL=/dev/null`
// is the usual trick and it is a POSIX path, so it would make this file behave
// differently on the win32 lane. Where a global has to exist for a test, it is
// a file this test wrote in its own temp directory, pointed at by
// `GIT_CONFIG_GLOBAL` for the length of that one test and restored afterwards.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { shuCommand } from "./command.js";

/** The identity every commit below is made with. Nobody's, and never read back. */
const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];

/**
 * The configuration every `init` and `clone` below is made under.
 *
 * `core.autocrlf=false` DECIDES HOW THE CHECKOUT IS WRITTEN, which a
 * per-repository pin applied after the fact cannot undo -- see this file's
 * header. `protocol.file.allow=always` is git >= 2.38's refusal to fetch a
 * submodule over the `file://` transport, lifted here because the "remote" in
 * this fixture is a directory two levels up and there is no network involved.
 */
const PINNED = ["-c", "core.autocrlf=false", "-c", "protocol.file.allow=always"];

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
 * The per-repository half of the line-ending pin.
 *
 * The clone above it decided how the files were WRITTEN; this decides how every
 * later command reads them, so a `writeFileSync` of LF content in a test below
 * is not reported as a modification on a host whose global says otherwise.
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
    mustGit(upstream, [...PINNED, "init", "--quiet", "--initial-branch=main"]);
    pinLineEndings(upstream);
    writeFileSync(join(upstream, "README.md"), "root\n");
    // The ignore rule is in the ROOT commit, so every branch cut from the trunk
    // carries it. Committing it only in the clone would make `cache/` ignored on
    // one branch and untracked on the one warmup then cuts, and the test would
    // be measuring the fixture rather than the verb.
    writeFileSync(join(upstream, ".gitignore"), "cache/\n");
    mustGit(upstream, ["add", "README.md", ".gitignore"]);
    mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "root"]);

    mustGit(root, [...PINNED, "clone", "--quiet", upstream, work]);
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
    expect(result.out.join("\n")).toContain("ran:           git merge --ff-only origin/main");
  });

  it("moves the trunk ref without touching the tree when the checkout is NOT on it", async () => {
    // Standing on `first-idea` from the test above. The trunk advances again.
    writeFileSync(join(upstream, "README.md"), "root\nsecond\nthird\n");
    mustGit(upstream, ["add", "README.md"]);
    mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "third"]);
    const ahead = mustGit(upstream, ["rev-parse", "HEAD"]);

    const result = await warmup(["warmup", "--repo", work, "--branch", "second-idea"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("ran:           git branch --force main origin/main");
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

  it("refuses a dirty tree, then with --discard destroys the untracked AND STAGED work and SPARES the ignored file", async () => {
    writeFileSync(join(work, "README.md"), "edited\n");
    writeFileSync(join(work, "scratch.txt"), "untracked\n");
    // STAGED, which is the half `git checkout -- .` restores from the index and
    // therefore does not destroy at all -- blocker B1.
    writeFileSync(join(work, "staged.txt"), "added to the index\n");
    mustGit(work, ["add", "staged.txt"]);
    mkdirSync(join(work, "cache"), { recursive: true });
    writeFileSync(join(work, "cache", "expensive.bin"), "hours of work\n");

    const refused = await warmup(["warmup", "--repo", work, "--branch", "third-idea"]);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toMatch(/carries 3 uncommitted path\(s\)/);
    expect(refused.err.join("\n")).toContain("scratch.txt");
    expect(refused.err.join("\n")).toContain("staged.txt");
    // The ignored file is not even LISTED: it is not dirty, and nothing here
    // would remove it.
    expect(refused.err.join("\n")).not.toContain("expensive.bin");

    const discarded = await warmup(["warmup", "--repo", work, "--branch", "third-idea", "--discard"]);
    expect(discarded.code).toBe(0);
    expect(mustGit(work, ["branch", "--show-current"])).toBe("third-idea");
    // THE OUTCOME, not the argv: the tree is clean afterwards, and the staged
    // file is gone from the index and from disk rather than riding along.
    expect(mustGit(work, ["status", "--porcelain=v1", "-uall"])).toBe("");
    expect(existsSync(join(work, "staged.txt"))).toBe(false);
    expect(existsSync(join(work, "scratch.txt"))).toBe(false);
    // The one assertion this whole file is worth writing for.
    expect(readdirSync(join(work, "cache"))).toEqual(["expensive.bin"]);
  });

  it("refuses at 2 when --discard leaves an untracked NESTED REPOSITORY behind", async () => {
    // `git clean -fd` will not delete a directory that is a git repository, and
    // nen never passes the second -f that would: that directory may carry
    // commits that exist nowhere else. So the discard runs, the tree is read
    // AGAIN, and what survived is named rather than being reported as clean.
    const nest = join(root, "nested-case");
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, nest]);
    pinLineEndings(nest);
    mkdirSync(join(nest, "vendored"), { recursive: true });
    mustGit(join(nest, "vendored"), [...PINNED, "init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(nest, "vendored", "theirs.txt"), "not ours to delete\n");

    const result = await warmup(["warmup", "--repo", nest, "--branch", "never-cut", "--discard"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is STILL not clean/);
    expect(result.err.join("\n")).toContain("vendored/");
    expect(result.err.join("\n")).toMatch(/NESTED REPOSITORY/);
    // Refused, named -- and the repository is still there.
    expect(existsSync(join(nest, "vendored", ".git"))).toBe(true);
    // Nothing was fetched and no branch was cut.
    expect(git(nest, ["show-ref", "--verify", "--quiet", "refs/heads/never-cut"]).code).toBe(1);
    // The report IS on stdout here, because the discard already destroyed work.
    expect(result.out.join("\n")).toContain("git reset --hard");
  });

  it("refuses at 2 when --discard leaves a DIRTY SUBMODULE behind", async () => {
    // Same shape, different reason: `git reset --hard` is run without
    // --recurse-submodules on purpose. A submodule is its own repository with
    // its own uncommitted work, and --discard is scoped to the one --repo names.
    const host = join(root, "submodule-host");
    mkdirSync(host);
    mustGit(host, [...PINNED, "init", "--quiet", "--initial-branch=main"]);
    pinLineEndings(host);
    writeFileSync(join(host, "a.txt"), "a\n");
    mustGit(host, ["add", "a.txt"]);
    mustGit(host, [...WHO, "commit", "--quiet", "-m", "root"]);
    mustGit(host, [...PINNED, ...WHO, "submodule", "add", "--quiet", upstream, "vendor"]);
    mustGit(host, [...WHO, "commit", "--quiet", "-m", "vendor"]);

    const clone = join(root, "submodule-clone");
    mustGit(root, [...PINNED, "clone", "--quiet", "--recurse-submodules", host, clone]);
    pinLineEndings(clone);
    writeFileSync(join(clone, "vendor", "README.md"), "someone was working in here\n");

    const result = await warmup(["warmup", "--repo", clone, "--branch", "never-cut", "--discard"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is STILL not clean/);
    expect(result.err.join("\n")).toContain("vendor");
    expect(result.err.join("\n")).toMatch(/SUBMODULE/);
    expect(git(clone, ["show-ref", "--verify", "--quiet", "refs/heads/never-cut"]).code).toBe(1);
  });

  it("refuses a mistyped --branch BEFORE --discard destroys anything", async () => {
    // Blocker B2, against the real `git check-ref-format`: `my..idea` is a name
    // git will not accept, and finding that out must not cost the caller the
    // file sitting uncommitted next to them.
    const guarded = join(root, "guarded");
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, guarded]);
    pinLineEndings(guarded);
    const trunkBefore = mustGit(guarded, ["rev-parse", "main"]);
    writeFileSync(join(guarded, "precious.txt"), "an afternoon of work\n");

    const result = await warmup(["warmup", "--repo", guarded, "--branch", "my..idea", "--discard"]);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/is not a branch name git will accept/);
    expect(result.err.join("\n")).toMatch(/Nothing has been discarded, fetched or moved/);
    // The file is still there and the trunk has not moved.
    expect(existsSync(join(guarded, "precious.txt"))).toBe(true);
    expect(mustGit(guarded, ["rev-parse", "main"])).toBe(trunkBefore);
  });

  it("does not read 'feat/x' on the remote as 'x' already existing", async () => {
    // `ls-remote` matches a bare pattern against the TAIL of every ref on slash
    // boundaries, so `--branch x` asked with a bare name would match
    // refs/heads/feat/x and refuse a name that is free. Spelling the ref in full
    // is the fix, and only the real ls-remote can prove it.
    mustGit(upstream, ["branch", "feat/x"]);
    const tail = join(root, "tail-match");
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, tail]);
    pinLineEndings(tail);

    const result = await warmup(["warmup", "--repo", tail, "--branch", "x"]);
    expect(result.err.join("\n")).not.toMatch(/already exists on origin/);
    expect(result.code).toBe(0);
    expect(mustGit(tail, ["branch", "--show-current"])).toBe("x");

    // And the exact name IS still refused.
    const taken = await warmup(["warmup", "--repo", tail, "--branch", "feat/x"]);
    expect(taken.code).toBe(2);
    expect(taken.err.join("\n")).toMatch(/already exists on origin/);
  });

  it("refuses a detached HEAD that carries commits nothing else reaches", async () => {
    const detached = join(root, "detached");
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, detached]);
    pinLineEndings(detached);
    mustGit(detached, ["checkout", "--quiet", "--detach", "HEAD"]);
    writeFileSync(join(detached, "orphan.txt"), "only HEAD knows about this\n");
    mustGit(detached, ["add", "orphan.txt"]);
    mustGit(detached, [...WHO, "commit", "--quiet", "-m", "orphan"]);
    const orphan = mustGit(detached, ["rev-parse", "HEAD"]);

    const result = await warmup(["warmup", "--repo", detached, "--branch", "never-cut"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/HEAD is DETACHED and carries 1 commit\(s\)/);
    expect(result.err.join("\n")).toMatch(/reflog/);
    // HEAD is exactly where it was, and no branch was cut.
    expect(mustGit(detached, ["rev-parse", "HEAD"])).toBe(orphan);
    expect(git(detached, ["show-ref", "--verify", "--quiet", "refs/heads/never-cut"]).code).toBe(1);
  });

  it("refuses a working copy stopped in the middle of a merge, naming the abort", async () => {
    const conflicted = join(root, "conflicted");
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, conflicted]);
    pinLineEndings(conflicted);
    mustGit(conflicted, ["checkout", "--quiet", "-b", "theirs"]);
    writeFileSync(join(conflicted, "README.md"), "theirs\n");
    mustGit(conflicted, ["add", "README.md"]);
    mustGit(conflicted, [...WHO, "commit", "--quiet", "-m", "theirs"]);
    mustGit(conflicted, ["checkout", "--quiet", "main"]);
    writeFileSync(join(conflicted, "README.md"), "ours\n");
    mustGit(conflicted, ["add", "README.md"]);
    mustGit(conflicted, [...WHO, "commit", "--quiet", "-m", "ours"]);
    // A conflicted merge, left where it stopped.
    expect(git(conflicted, [...WHO, "merge", "theirs"]).code).not.toBe(0);

    const result = await warmup(["warmup", "--repo", conflicted, "--branch", "never-cut", "--discard"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/in the middle of an operation \(MERGE_HEAD exists\)/);
    expect(result.err.join("\n")).toContain("git merge --abort");
    expect(git(conflicted, ["show-ref", "--verify", "--quiet", "refs/heads/never-cut"]).code).toBe(1);
  });

  it("refuses a DIVERGED trunk rather than dropping the commits only the local one has", async () => {
    const diverged = join(root, "diverged");
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, diverged]);
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
    mustGit(lonely, [...PINNED, "init", "--quiet", "--initial-branch=main"]);
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

  // ── the trunk, checked out in another worktree (zheref/nen#168) ───────────
  //
  // THE CLAIM ONLY GIT CAN ANSWER: `git branch --force main origin/main` really
  // is refused when another worktree has `main` checked out, and `git switch -c
  // <name> origin/main` really does not need that ref moved first. The first
  // half is asserted against git directly, right here, so this test fails
  // loudly the day git stops refusing rather than silently proving nothing.
  it("cuts from origin/main without touching a trunk ANOTHER worktree holds", async () => {
    const primary = join(root, "primary");
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, primary]);
    pinLineEndings(primary);
    // The standard shape: the primary checkout stands on the trunk, and the
    // effort gets a linked worktree of the SAME repository beside it.
    const linked = join(root, "linked");
    mustGit(primary, ["worktree", "add", "--quiet", linked, "-b", "holding"]);
    expect(mustGit(primary, ["branch", "--show-current"])).toBe("main");

    // Git really does refuse -- the failure this issue is about.
    const refused = git(linked, ["branch", "--force", "main", "origin/main"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toMatch(/used by worktree/);

    const trunkBefore = mustGit(primary, ["rev-parse", "main"]);
    const result = await warmup(["warmup", "--repo", linked, "--branch", "worktree-idea"]);
    expect(result.code).toBe(0);
    const printed = result.out.join("\n");
    expect(printed).toMatch(/trunk held by worktree .*; cutting from origin\/main directly/);
    expect(printed).not.toContain("git branch --force main origin/main");
    expect(printed).not.toContain("git merge --ff-only");

    // The branch was cut, from the tip the fetch brought down.
    expect(mustGit(linked, ["branch", "--show-current"])).toBe("worktree-idea");
    expect(mustGit(linked, ["rev-parse", "HEAD"])).toBe(mustGit(linked, ["rev-parse", "origin/main"]));
    // And the other worktree is exactly as it was: still on the trunk, still
    // pointing where it did. Nothing here was that worktree's to move.
    expect(mustGit(primary, ["branch", "--show-current"])).toBe("main");
    expect(mustGit(primary, ["rev-parse", "main"])).toBe(trunkBefore);
  });

  it("--dry-run predicts that skip too, rather than printing a command git would refuse", async () => {
    // The second half of zheref/nen#168: the plan used to print `git branch
    // --force main origin/main` and exit 0 while the real run failed on that
    // exact line. A plan that does not predict the failure is worse than none.
    const primary = join(root, "dry-primary");
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, primary]);
    pinLineEndings(primary);
    const linked = join(root, "dry-linked");
    mustGit(primary, ["worktree", "add", "--quiet", linked, "-b", "dry-holding"]);

    const before = mustGit(linked, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const result = await warmup(["warmup", "--repo", linked, "--branch", "never-cut", "--dry-run"]);
    expect(result.code).toBe(0);
    const printed = result.out.join("\n");
    expect(printed).toMatch(/trunk held by worktree .*; cutting from origin\/main directly/);
    expect(printed).not.toContain("git branch --force main origin/main");
    expect(printed).toMatch(/^would run: {5}git switch -c never-cut origin\/main$/m);
    // Still a dry run: the one command it performed moved nothing.
    expect(mustGit(linked, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before);
  });

  // ── the win32 line-ending trap, simulated ─────────────────────────────────
  //
  // Blocker B3, pinned where every lane runs it. The failure it guards is a
  // whole-tree false "dirty": with a global `core.autocrlf=true` a clone writes
  // CRLF, and a per-repository pin applied afterwards changes the reading
  // without rewriting the files. This test makes that global real for the
  // length of one test, through a config file it wrote itself, and asserts the
  // clone-time pin holds the tree clean anyway.
  it("survives a global core.autocrlf=true, because the pin is on the clone", async () => {
    const home = join(root, "fake-global");
    mkdirSync(home, { recursive: true });
    const config = join(home, "gitconfig");
    writeFileSync(config, "[core]\n\tautocrlf = true\n");

    const previous = process.env["GIT_CONFIG_GLOBAL"];
    process.env["GIT_CONFIG_GLOBAL"] = config;
    try {
      // The global really is in force for git subprocesses now.
      expect(mustGit(root, ["config", "--global", "core.autocrlf"])).toBe("true");

      const crlf = join(root, "crlf-case");
      mustGit(root, [...PINNED, "clone", "--quiet", upstream, crlf]);
      pinLineEndings(crlf);

      // Nothing has been edited, so nothing may be reported as modified. Without
      // the clone-time pin this is ` M .gitignore` and ` M README.md`.
      expect(mustGit(crlf, ["status", "--porcelain=v1", "-uall"])).toBe("");

      const result = await warmup(["warmup", "--repo", crlf, "--branch", "crlf-idea"]);
      expect(result.err.join("\n")).not.toMatch(/uncommitted path\(s\)/);
      expect(result.code).toBe(0);
      expect(mustGit(crlf, ["branch", "--show-current"])).toBe("crlf-idea");
    } finally {
      if (previous === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = previous;
    }
  });
});
