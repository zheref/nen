// src/wc/catchup.integration.test.ts -- `nen wc catch-up` and `nen wc publish`,
// against the REAL git, in a temporary repository with a real (bare, local)
// `origin`.
//
// WHY THIS EXISTS BESIDE ./command.test.ts. That suite proves nen sends the
// argv it means to send. It cannot prove the claims about git those argv
// rest on: that on a REBASE the index really holds origin/<base> in stage 2
// and the replayed commit in stage 3 (the reverse of a merge), so that the
// report's `ours` really is this branch's side under either strategy; that a
// non-ASCII or spaced path really comes back by its own name once
// `core.quotePath` is off; that `git rebase --continue` really finishes what
// a staged resolution started; that `--abort` really restores HEAD; that a
// push spelled as `refs/heads/<b>:refs/heads/<b>` really sets the upstream
// under `-u`; and that a branch git will hold as `+main` is refused BEFORE
// the push that would have forced `main`. Every one is a claim about git,
// and only git can answer it.
//
// THE FIXTURE IS ./squash.integration.test.ts's OWN SHAPE (a bare origin
// here, because a push into a checked-out branch is refused by git itself):
// pinned `core.autocrlf=false` and `protocol.file.allow=always`, a repo-local
// identity so the commits the VERB makes (rebase, merge, the continue) have
// one on a runner with no ambient config, a floor of git 2.28 for
// `init --initial-branch`, and a loud SKIP where no usable git is on PATH.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { wcCommand } from "./command.js";

const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];
const PINNED = ["-c", "core.autocrlf=false", "-c", "protocol.file.allow=always"];

function git(cwd: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function mustGit(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.code}: ${result.stderr}`);
  return result.stdout.trim();
}

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

function pin(repo: string): void {
  mustGit(repo, ["config", "core.autocrlf", "false"]);
  mustGit(repo, ["config", "user.name", "nen test"]);
  mustGit(repo, ["config", "user.email", "nen@example.invalid"]);
  mustGit(repo, ["config", "commit.gpgsign", "false"]);
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly doc: Record<string, unknown>;
}

async function wc(argv: readonly string[], json = true): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(wcCommand, ["wc", ...argv], null, json, io, defaultSeams());
  const doc = json && out.length > 0 ? (JSON.parse(out.join("\n")) as Record<string, unknown>) : {};
  return { code, out, err, doc };
}

type Conflict = { path: string; ours: string | null; theirs: string | null };
const conflicts = (run: Run): Conflict[] => run.doc["conflicted"] as Conflict[];

let root = "";
let origin = "";
let seed = "";

/** A commit on `main` at the origin, made through the seed clone, touching `files`. */
function advanceMain(files: Readonly<Record<string, string>>, message: string): void {
  mustGit(seed, [...PINNED, "pull", "--quiet", "--ff-only", "origin", "main"]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(seed, path, ".."), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  mustGit(seed, ["add", "-A"]);
  mustGit(seed, [...WHO, "commit", "--quiet", "-m", message]);
  mustGit(seed, [...PINNED, "push", "--quiet", "origin", "main"]);
}

/** A fresh clone on a new branch cut from main, with one commit touching `files`. */
function branchWith(name: string, files: Readonly<Record<string, string>>, message = `feat: ${name}`): string {
  const work = join(root, name.replace(/[^A-Za-z0-9]/g, "_"));
  mustGit(root, [...PINNED, "clone", "--quiet", origin, work]);
  pin(work);
  mustGit(work, ["switch", "--quiet", "-c", name]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  mustGit(work, ["add", "-A"]);
  mustGit(work, [...WHO, "commit", "--quiet", "-m", message]);
  return work;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nen-wc-catchup-git-"));
  origin = join(root, "origin.git");
  mustGit(root, [...PINNED, "init", "--quiet", "--bare", "--initial-branch=main", origin]);
  seed = join(root, "seed");
  mustGit(root, [...PINNED, "clone", "--quiet", origin, seed]);
  pin(seed);
  writeFileSync(join(seed, "README.md"), "root\n");
  mustGit(seed, ["add", "README.md"]);
  mustGit(seed, [...WHO, "commit", "--quiet", "-m", "root"]);
  mustGit(seed, [...PINNED, "push", "--quiet", "-u", "origin", "main"]);
});

afterAll(() => {
  if (root === "") return;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS keeps it; the tmpdir is the OS's to reap */
  }
});

describe.skipIf(!HAVE_GIT)("nen wc catch-up, against the real git", () => {
  it("REBASE conflict: `ours` is this branch's side even though git holds it in stage 3, and a staged resolution resumes", async () => {
    const work = branchWith("rebase-conflict", { "README.md": "branch side\n" });
    advanceMain({ "README.md": "main side\n" }, "docs: main side");
    const before = mustGit(work, ["rev-parse", "HEAD"]);

    const stopped = await wc(["catch-up", "--repo", work, "--base", "main"]);
    expect(stopped.code).toBe(1);
    expect(stopped.doc["strategy"]).toBe("rebase");
    expect(stopped.doc["after"]).toBeNull();
    // What git actually holds: stage 2 is origin/main, stage 3 the replayed commit.
    expect(mustGit(work, ["show", ":2:README.md"])).toBe("main side");
    expect(mustGit(work, ["show", ":3:README.md"])).toBe("branch side");
    expect(conflicts(stopped)).toEqual([{ path: "README.md", ours: "branch side\n", theirs: "main side\n" }]);
    expect(git(work, ["rebase", "--show-current-patch"]).code).toBe(0);

    // The same command, unresolved: conflicted again, nothing continued.
    const again = await wc(["catch-up", "--repo", work, "--base", "main"]);
    expect(again.code).toBe(1);
    expect(again.doc["resumed"]).toBe(false);
    expect(conflicts(again).map((c): string => c.path)).toEqual(["README.md"]);

    // Resolve, stage, re-run: the rebase finishes on top of main.
    writeFileSync(join(work, "README.md"), "both sides\n");
    mustGit(work, ["add", "README.md"]);
    const resumed = await wc(["catch-up", "--repo", work, "--base", "main"]);
    expect(resumed.code).toBe(0);
    expect(resumed.doc["resumed"]).toBe(true);
    expect(resumed.doc["strategy"]).toBe("rebase");
    // git leaves REBASE_HEAD behind after the rebase completes (measured on
    // 2.50); the verb asks `rebase --show-current-patch`, which does not lie.
    expect(git(work, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]).code).toBe(0);
    expect(git(work, ["rebase", "--show-current-patch"]).code).not.toBe(0);
    expect(mustGit(work, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(mustGit(work, ["rev-list", "--count", "origin/main..HEAD"])).toBe("1");
    expect(mustGit(work, ["merge-base", "--is-ancestor", "origin/main", "HEAD"])).toBe("");
    expect(mustGit(work, ["show", "HEAD:README.md"])).toBe("both sides");
    // And the NEXT run is an ordinary one, not a second continue.
    const next = await wc(["catch-up", "--repo", work, "--base", "main"]);
    expect(next.code).toBe(0);
    expect(next.doc).toMatchObject({ noOp: true, resumed: false });
  });

  it("MERGE conflict (the branch is published): `ours` is stage 2, and --abort restores HEAD", async () => {
    const work = branchWith("merge-conflict", { "README.md": "published side\n" });
    advanceMain({ "README.md": "main again\n" }, "docs: main again");
    mustGit(work, [...PINNED, "push", "--quiet", "-u", "origin", "merge-conflict"]);
    const before = mustGit(work, ["rev-parse", "HEAD"]);

    const stopped = await wc(["catch-up", "--repo", work, "--base", "main"]);
    expect(stopped.code).toBe(1);
    expect(stopped.doc["strategy"]).toBe("merge");
    expect(mustGit(work, ["show", ":2:README.md"])).toBe("published side");
    expect(mustGit(work, ["show", ":3:README.md"])).toBe("main again");
    expect(conflicts(stopped)).toEqual([{ path: "README.md", ours: "published side\n", theirs: "main again\n" }]);
    expect(git(work, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).code).toBe(0);

    const aborted = await wc(["catch-up", "--repo", work, "--base", "main", "--abort"]);
    expect(aborted.code).toBe(0);
    expect(aborted.doc).toMatchObject({ strategy: "merge", aborted: true, resumed: false, after: before });
    expect(git(work, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).code).not.toBe(0);
    expect(mustGit(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(mustGit(work, ["status", "--porcelain=v1", "-uall"])).toBe("");
  });

  it("a non-ASCII path and a spaced path come back by their own names, with both sides read (N3)", async () => {
    const work = branchWith("awkward-paths", { "docs/ünï.md": "branch ü\n", "sp ace.txt": "branch space\n" });
    // Cut before main adds the same two paths, so both are add/add conflicts.
    advanceMain({ "docs/ünï.md": "main ü\n", "sp ace.txt": "main space\n" }, "docs: two awkward paths");
    const stopped = await wc(["catch-up", "--repo", work, "--base", "main", "--strategy", "merge"]);
    expect(stopped.code).toBe(1);
    // git's own default would C-quote the first one; the verb asks for the bytes.
    expect(mustGit(work, ["diff", "--name-only", "--diff-filter=U"])).toContain('"docs/\\303\\274n\\303\\257.md"');
    const byPath = new Map(conflicts(stopped).map((c): [string, Conflict] => [c.path, c]));
    expect([...byPath.keys()].sort()).toEqual(["docs/ünï.md", "sp ace.txt"]);
    expect(byPath.get("docs/ünï.md")).toEqual({ path: "docs/ünï.md", ours: "branch ü\n", theirs: "main ü\n" });
    expect(byPath.get("sp ace.txt")).toEqual({ path: "sp ace.txt", ours: "branch space\n", theirs: "main space\n" });
    const text = await wc(["catch-up", "--repo", work, "--base", "main", "--strategy", "merge"], false);
    expect(text.out.join("\n")).toContain("  docs/ünï.md\n    ours  :\n      branch ü\n    theirs:\n      main ü");
    mustGit(work, ["merge", "--abort"]);
  });

  it("a clean catch-up rebases the unpublished branch onto the fresh origin/main", async () => {
    const work = branchWith("clean-rebase", { "mine.txt": "mine\n" });
    advanceMain({ "other.txt": "unrelated\n" }, "chore: unrelated");
    const result = await wc(["catch-up", "--repo", work, "--base", "main"]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ strategy: "rebase", noOp: false, conflicted: [], behindBefore: 1, aheadBefore: 1 });
    expect(mustGit(work, ["merge-base", "--is-ancestor", "origin/main", "HEAD"])).toBe("");
    expect(mustGit(work, ["rev-list", "--count", "origin/main..HEAD"])).toBe("1");
    const noOp = await wc(["catch-up", "--repo", work, "--base", "main"]);
    expect(noOp.code).toBe(0);
    expect(noOp.doc["noOp"]).toBe(true);
  });
});

describe.skipIf(!HAVE_GIT)("nen wc publish, against the real git", () => {
  it("pushes the branch as refs/heads/<b>:refs/heads/<b>, and -u sets the upstream", async () => {
    const work = branchWith("plain-push", { "push.txt": "push\n" });
    const sha = mustGit(work, ["rev-parse", "HEAD"]);
    const result = await wc(["publish", "--repo", work, "--set-upstream"]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ branch: "plain-push", remote: "origin", upstreamBefore: null, pushed: true, needsForce: false });
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/plain-push"]).split(/\s+/)[0]).toBe(sha);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "plain-push@{upstream}"])).toBe("origin/plain-push");
    // A second commit, pushed without -u: fetched, fast-forward, ahead counted.
    writeFileSync(join(work, "push.txt"), "push more\n");
    mustGit(work, ["add", "-A"]);
    mustGit(work, [...WHO, "commit", "--quiet", "-m", "feat: more"]);
    const more = await wc(["publish", "--repo", work]);
    expect(more.code).toBe(0);
    expect(more.doc).toMatchObject({ upstreamBefore: "origin/plain-push", ahead: 1, pushed: true });
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/plain-push"]).split(/\s+/)[0]).toBe(mustGit(work, ["rev-parse", "HEAD"]));
  });

  it("refuses a branch git holds as `+main` -- the argv that would have force-pushed main -- and pushes nothing (S1)", async () => {
    const work = branchWith("+main", { "sneaky.txt": "sneaky\n" });
    expect(mustGit(work, ["symbolic-ref", "--short", "HEAD"])).toBe("+main");
    const mainBefore = mustGit(work, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0];
    const result = await wc(["publish", "--repo", work, "--set-upstream"], false);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'\+main' is the trunk/);
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]).toBe(mainBefore);
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/+main"])).toBe("");
    // A `+` on a non-trunk name is refused as a force shape, after git accepted the name.
    const plus = branchWith("+feature", { "plus.txt": "plus\n" });
    const shaped = await wc(["publish", "--repo", plus, "--set-upstream"], false);
    expect(shaped.code).toBe(2);
    expect(shaped.err.join("\n")).toMatch(/'\+feature' looks like a refspec or a force option/);
    expect(mustGit(plus, ["ls-remote", "origin"])).not.toContain("+feature");
  });

  it("reports needsForce at exit 1 and pushes nothing when the upstream moved past the local branch", async () => {
    const work = branchWith("diverged", { "d.txt": "one\n" });
    mustGit(work, [...PINNED, "push", "--quiet", "-u", "origin", "diverged"]);
    // Somebody else moves the remote branch.
    const other = join(root, "diverged-other");
    mustGit(root, [...PINNED, "clone", "--quiet", "--branch", "diverged", origin, other]);
    pin(other);
    writeFileSync(join(other, "d.txt"), "theirs\n");
    mustGit(other, ["add", "-A"]);
    mustGit(other, [...WHO, "commit", "--quiet", "-m", "feat: elsewhere"]);
    mustGit(other, [...PINNED, "push", "--quiet", "origin", "diverged"]);
    const remote = mustGit(other, ["rev-parse", "HEAD"]);
    // And this clone rewrites its own.
    mustGit(work, [...WHO, "commit", "--quiet", "--amend", "--no-edit", "-m", "feat: rewritten"]);
    const result = await wc(["publish", "--repo", work]);
    expect(result.code).toBe(1);
    expect(result.doc).toMatchObject({ needsForce: true, pushed: false, upstreamBefore: "origin/diverged" });
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/diverged"]).split(/\s+/)[0]).toBe(remote);
  });
});
