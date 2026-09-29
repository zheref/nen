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

  it("a branch tracking fork/<b> is pushed to fork and its fast-forward is judged against fork, while origin stays untouched (zheref/nen#231)", async () => {
    const work = branchWith("to-fork", { "fork.txt": "fork\n" });
    const fork = join(root, "fork.git");
    mustGit(root, [...PINNED, "init", "--quiet", "--bare", "--initial-branch=main", fork]);
    mustGit(work, ["remote", "add", "fork", fork]);
    mustGit(work, [...PINNED, "push", "--quiet", "-u", "fork", "to-fork"]);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "to-fork@{upstream}"])).toBe("fork/to-fork");
    writeFileSync(join(work, "fork.txt"), "fork more\n");
    mustGit(work, ["add", "-A"]);
    mustGit(work, [...WHO, "commit", "--quiet", "-m", "feat: more on the fork"]);
    const result = await wc(["publish", "--repo", work]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ remote: "fork", upstreamBefore: "fork/to-fork", ahead: 1, pushed: true, needsForce: false });
    expect(mustGit(work, ["ls-remote", "fork", "refs/heads/to-fork"]).split(/\s+/)[0]).toBe(mustGit(work, ["rev-parse", "HEAD"]));
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/to-fork"])).toBe("");
    // Asking for origin while the branch tracks fork is refused, and nothing moves.
    const contradicted = await wc(["publish", "--repo", work, "--remote", "origin"], false);
    expect(contradicted.code).toBe(2);
    expect(contradicted.err.join("\n")).toMatch(/tracks 'fork\/to-fork', so without --set-upstream it is pushed to 'fork'/);
    expect(contradicted.err.join("\n")).toMatch(/pass --set-upstream --remote origin/);
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/to-fork"])).toBe("");
    // A fresh branch with no upstream goes where --remote says.
    mustGit(work, ["switch", "--quiet", "-c", "to-fork-fresh"]);
    const fresh = await wc(["publish", "--repo", work, "--set-upstream", "--remote", "fork"]);
    expect(fresh.code).toBe(0);
    expect(fresh.doc).toMatchObject({ remote: "fork", upstreamBefore: null, pushed: true });
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "to-fork-fresh@{upstream}"])).toBe("fork/to-fork-fresh");
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/to-fork-fresh"])).toBe("");
  });

  it("the #271 fixture: a stacked branch cut with a FOREIGN upstream is refused, then --set-upstream publishes it under its own name and rewrites the upstream -- the base branch never moves", async () => {
    // The base effort, published: the branch whose pull request the stacked commit must never reach.
    const base = branchWith("stack-base", { "base.txt": "base\n" });
    mustGit(base, [...PINNED, "push", "--quiet", "-u", "origin", "stack-base"]);
    const baseSha = mustGit(base, ["ls-remote", "origin", "refs/heads/stack-base"]).split(/\s+/)[0];
    // The stacked effort, cut the way `shu warmup --from stack-base` cut it before #271: TRACKING the base.
    const work = join(root, "stacked");
    mustGit(root, [...PINNED, "clone", "--quiet", origin, work]);
    pin(work);
    mustGit(work, ["switch", "--quiet", "-c", "stacked", "--track", "origin/stack-base"]);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "stacked@{upstream}"])).toBe("origin/stack-base");
    writeFileSync(join(work, "stacked.txt"), "stacked\n");
    mustGit(work, ["add", "-A"]);
    mustGit(work, [...WHO, "commit", "--quiet", "-m", "feat: the stacked effort"]);

    // A bare publish -- and its dry run -- refuse at exit 2, naming both names; nothing moves anywhere.
    for (const argv of [["publish", "--repo", work], ["publish", "--repo", work, "--dry-run"]]) {
      const refused = await wc(argv, false);
      expect(refused.code, argv.join(" ")).toBe(2);
      expect(refused.out).toEqual([]);
      expect(refused.err.join("\n")).toMatch(/'stacked' tracks 'origin\/stack-base', whose branch 'stack-base' is not 'stacked'/);
      expect(refused.err.join("\n")).toMatch(/Pass --set-upstream to publish 'stacked' to 'origin\/stacked'/);
    }
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/stack-base"]).split(/\s+/)[0]).toBe(baseSha);
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/stacked"])).toBe("");
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "stacked@{upstream}"])).toBe("origin/stack-base");

    // --set-upstream: published under its OWN name, the upstream rewritten, the base untouched.
    const published = await wc(["publish", "--repo", work, "--set-upstream"]);
    expect(published.code).toBe(0);
    expect(published.doc).toMatchObject({ branch: "stacked", remote: "origin", destination: "stacked", upstreamBefore: "origin/stack-base", ahead: 1, needsForce: false, pushed: true, retargetedUpstream: true });
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/stacked"]).split(/\s+/)[0]).toBe(mustGit(work, ["rev-parse", "HEAD"]));
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/stack-base"]).split(/\s+/)[0]).toBe(baseSha);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "stacked@{upstream}"])).toBe("origin/stacked");

    // From here a bare publish is an ordinary one: its upstream is its own name.
    writeFileSync(join(work, "stacked.txt"), "stacked more\n");
    mustGit(work, ["add", "-A"]);
    mustGit(work, [...WHO, "commit", "--quiet", "-m", "feat: more on the stacked effort"]);
    const again = await wc(["publish", "--repo", work]);
    expect(again.code).toBe(0);
    expect(again.doc).toMatchObject({ destination: "stacked", upstreamBefore: "origin/stacked", ahead: 1, pushed: true, retargetedUpstream: false });
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/stack-base"]).split(/\s+/)[0]).toBe(baseSha);
  });

  it("a branch tracking origin/main -- `git worktree add -b x origin/main` -- never moves main: a bare publish refuses, and --set-upstream pushes under its own name and retracks it to origin/<own> (zheref/nen#234, #271)", async () => {
    const work = branchWith("tracks-trunk", { "trunk.txt": "not main\n" });
    mustGit(work, ["branch", "--set-upstream-to", "origin/main"]);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "tracks-trunk@{upstream}"])).toBe("origin/main");
    const mainBefore = mustGit(work, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0];
    const sha = mustGit(work, ["rev-parse", "HEAD"]);
    // Without -u: refused at exit 2, naming the trunk; nothing is pushed anywhere and the upstream is untouched.
    const plain = await wc(["publish", "--repo", work], false);
    expect(plain.code).toBe(2);
    expect(plain.err.join("\n")).toMatch(/'tracks-trunk' tracks 'origin\/main', whose branch 'main' is not 'tracks-trunk', the trunk/);
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]).toBe(mainBefore);
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/tracks-trunk"])).toBe("");
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "tracks-trunk@{upstream}"])).toBe("origin/main");
    // With -u: the push lands on refs/heads/tracks-trunk, main does not move, the upstream is retargeted.
    const retargeted = await wc(["publish", "--repo", work, "--set-upstream"]);
    expect(retargeted.code).toBe(0);
    expect(retargeted.doc).toMatchObject({ branch: "tracks-trunk", remote: "origin", destination: "tracks-trunk", upstreamBefore: "origin/main", ahead: 1, needsForce: false, pushed: true, retargetedUpstream: true });
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]).toBe(mainBefore);
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/tracks-trunk"]).split(/\s+/)[0]).toBe(sha);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "tracks-trunk@{upstream}"])).toBe("origin/tracks-trunk");
    // A rewritten branch that tracks the trunk while its OWN name is already on the remote is judged against origin/<own>,
    // not against main: needsForce, nothing pushed, nothing retracked (retargetedUpstream: false), main untouched.
    const rewritten = branchWith("tracks-trunk-rewrite", { "rw.txt": "one\n" });
    mustGit(rewritten, [...PINNED, "push", "--quiet", "origin", "refs/heads/tracks-trunk-rewrite:refs/heads/tracks-trunk-rewrite"]);
    mustGit(rewritten, ["branch", "--set-upstream-to", "origin/main"]);
    mustGit(rewritten, [...WHO, "commit", "--quiet", "--amend", "--no-edit", "-m", "feat: rewritten"]);
    const diverged = await wc(["publish", "--repo", rewritten, "--set-upstream"]);
    expect(diverged.code).toBe(1);
    expect(diverged.doc).toMatchObject({ destination: "tracks-trunk-rewrite", needsForce: true, pushed: false, retargetedUpstream: false });
    expect(mustGit(rewritten, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0]).toBe(mainBefore);
    expect(mustGit(rewritten, ["rev-parse", "--abbrev-ref", "tracks-trunk-rewrite@{upstream}"])).toBe("origin/main");
  });

  it("F1, the fork workflow: a branch cut from upstream/main in a clone whose origin is the fork is published to origin -- never created on upstream -- and --set-upstream --remote moves a same-name upstream (Nobunaga F1)", async () => {
    // canon.git is the canonical repository; this clone's `origin` is the fork, and `upstream` is canon.
    const canon = join(root, "canon.git");
    mustGit(root, [...PINNED, "clone", "--quiet", "--bare", origin, canon]);
    const work = join(root, "fork-workflow");
    mustGit(root, [...PINNED, "clone", "--quiet", origin, work]);
    pin(work);
    mustGit(work, ["remote", "add", "upstream", canon]);
    mustGit(work, [...PINNED, "fetch", "--quiet", "upstream"]);
    mustGit(work, ["switch", "--quiet", "-c", "feat", "--track", "upstream/main"]);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "feat@{upstream}"])).toBe("upstream/main");
    writeFileSync(join(work, "feat.txt"), "feat\n");
    mustGit(work, ["add", "-A"]);
    mustGit(work, [...WHO, "commit", "--quiet", "-m", "feat: in the fork"]);
    const canonMain = mustGit(work, ["ls-remote", "upstream", "refs/heads/main"]).split(/\s+/)[0];

    const refused = await wc(["publish", "--repo", work], false);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toMatch(/Pass --set-upstream to publish 'feat' to 'origin\/feat'/);

    const published = await wc(["publish", "--repo", work, "--set-upstream"]);
    expect(published.code).toBe(0);
    expect(published.doc).toMatchObject({ branch: "feat", remote: "origin", destination: "feat", upstreamBefore: "upstream/main", pushed: true, retargetedUpstream: true });
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/feat"]).split(/\s+/)[0]).toBe(mustGit(work, ["rev-parse", "HEAD"]));
    expect(mustGit(work, ["ls-remote", "upstream", "refs/heads/feat"])).toBe("");
    expect(mustGit(work, ["ls-remote", "upstream", "refs/heads/main"]).split(/\s+/)[0]).toBe(canonMain);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "feat@{upstream}"])).toBe("origin/feat");

    // A same-name upstream on the canonical remote: --remote origin alone is refused and names --set-upstream --remote,
    // which is not the `git branch --set-upstream-to origin/<b>` git itself refuses on a first publish.
    mustGit(work, ["switch", "--quiet", "-c", "same-name"]);
    mustGit(work, [...PINNED, "push", "--quiet", "-u", "upstream", "same-name"]);
    expect(git(work, ["branch", "--set-upstream-to", "origin/same-name"]).code).not.toBe(0);
    const contradicted = await wc(["publish", "--repo", work, "--remote", "origin"], false);
    expect(contradicted.code).toBe(2);
    expect(contradicted.err.join("\n")).toMatch(/pass --set-upstream --remote origin to publish it to 'origin\/same-name'/);
    const moved = await wc(["publish", "--repo", work, "--set-upstream", "--remote", "origin"]);
    expect(moved.code).toBe(0);
    expect(moved.doc).toMatchObject({ remote: "origin", destination: "same-name", upstreamBefore: "upstream/same-name", retargetedUpstream: true });
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "same-name@{upstream}"])).toBe("origin/same-name");
  });

  it("F2: a stacked branch whose base was DELETED on the remote still publishes under --set-upstream -- ahead: null, said so -- while a bare publish still refuses (Nobunaga F2)", async () => {
    const base = branchWith("gone-base", { "gone.txt": "base\n" });
    mustGit(base, [...PINNED, "push", "--quiet", "-u", "origin", "gone-base"]);
    const work = join(root, "orphaned-stack");
    mustGit(root, [...PINNED, "clone", "--quiet", origin, work]);
    pin(work);
    mustGit(work, ["switch", "--quiet", "-c", "orphaned", "--track", "origin/gone-base"]);
    writeFileSync(join(work, "orphaned.txt"), "stacked\n");
    mustGit(work, ["add", "-A"]);
    mustGit(work, [...WHO, "commit", "--quiet", "-m", "feat: stacked on a base that is about to go"]);
    // The base is merged and deleted on the remote; this clone still names it (no prune).
    mustGit(base, [...PINNED, "push", "--quiet", "origin", "--delete", "gone-base"]);
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "orphaned@{upstream}"])).toBe("origin/gone-base");
    // The real git's own words for it -- what the F2 route recognises.
    const probe = git(work, ["fetch", "--end-of-options", "origin", "refs/heads/gone-base:refs/remotes/origin/gone-base"]);
    expect(probe.code).not.toBe(0);
    expect(probe.stderr).toMatch(/couldn't find remote ref/);

    const bare = await wc(["publish", "--repo", work], false);
    expect(bare.code).toBe(2);
    const published = await wc(["publish", "--repo", work, "--set-upstream"]);
    expect(published.code).toBe(0);
    expect(published.doc).toMatchObject({ branch: "orphaned", remote: "origin", upstreamBefore: "origin/gone-base", ahead: null, pushed: true, retargetedUpstream: true });
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/orphaned"]).split(/\s+/)[0]).toBe(mustGit(work, ["rev-parse", "HEAD"]));
    expect(mustGit(work, ["ls-remote", "origin", "refs/heads/gone-base"])).toBe("");
    expect(mustGit(work, ["rev-parse", "--abbrev-ref", "orphaned@{upstream}"])).toBe("origin/orphaned");
  });

  it("the real git accepts `git fetch --end-of-options` (2.24+): a publish with an upstream fetches through it and pushes", async () => {
    // The whole guard rests on this: Copilot (zheref/nen#231) read the flag
    // as one fetch rejects. On this host's git the fetch below succeeds.
    const work = branchWith("eoo", { "eoo.txt": "1\n" });
    mustGit(work, [...PINNED, "push", "--quiet", "-u", "origin", "eoo"]);
    const probe = git(work, ["fetch", "--end-of-options", "origin", "refs/heads/eoo:refs/remotes/origin/eoo"]);
    expect(probe.code).toBe(0);
    expect(probe.stderr).not.toMatch(/unknown option/);
    writeFileSync(join(work, "eoo.txt"), "2\n");
    mustGit(work, ["add", "-A"]);
    mustGit(work, [...WHO, "commit", "--quiet", "-m", "feat: two"]);
    const result = await wc(["publish", "--repo", work]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ upstreamBefore: "origin/eoo", ahead: 1, pushed: true });
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
