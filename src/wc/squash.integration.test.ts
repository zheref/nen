// src/wc/squash.integration.test.ts -- `nen wc squash`, against the REAL git,
// in a temporary repository with a real (local) `origin`.
//
// WHY THIS EXISTS BESIDE ./squash.test.ts. That suite proves nen sends the
// argv it means to send, which is the half a scripted seam can prove. It
// cannot prove those argv MEAN what this verb's author thought: that
// `git reset --soft <merge-base>` really moves the branch ref and the index
// without touching the working tree, that the diff every folded commit
// carried really survives into the one commit that replaces them, that
// `git merge-base --is-ancestor` really answers "not an ancestor" for a
// SIBLING branch rather than a descendant one, and that a commit already
// pushed to this branch's own `@{upstream}` really is found and refused
// rather than silently folded. Every one of those is a claim about git, and
// only git can answer it.
//
// THE FIXTURE IS ../shu/warmup.integration.test.ts's OWN SHAPE: one local
// `upstream`, pinned `core.autocrlf=false` (so a CRLF-writing host does not
// report a clean checkout as dirty) and `protocol.file.allow=always` (so a
// `file://` remote is never refused by a host's own policy), a floor of git
// 2.28 for `init --initial-branch` so the trunk's name does not depend on
// the host's `init.defaultBranch`. It SKIPS rather than fails where `git` is
// not on PATH or is older than that floor -- a machine without a usable git
// is not a machine this rule was broken on -- and the skip is loud in the
// reporter rather than silent.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { wcCommand } from "./command.js";

/** The identity every commit below is made with. Nobody's, and never read back. */
const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];

/** See this file's header: decides how a clone is WRITTEN, and permits the `file://` remote. */
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

/** Is there a `git` here, new enough for this fixture to build itself? See ../shu/warmup.integration.test.ts's own twin. */
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

function pinLineEndings(repo: string): void {
  mustGit(repo, ["config", "core.autocrlf", "false"]);
}

/**
 * A REPO-LOCAL git identity, distinct from `WHO`'s per-invocation `-c` flags.
 *
 * `nen wc squash`'s real mechanism runs `git commit -F <file>` through
 * `defaultSeams()` -- production code, correctly carrying no identity flags
 * of its own, because relying on the caller's ambient git config is exactly
 * right for a real user's machine. A CI runner is not that machine: it may
 * have NO global `user.name`/`user.email` at all, and `WHO`'s `-c` flags
 * only cover the SETUP commits this file makes directly -- they are invisible
 * to the commit the VERB UNDER TEST makes. A repo-LOCAL config, by contrast,
 * applies to every git invocation in this directory regardless of who
 * started it, which is what lets the real mechanism succeed on a runner with
 * no ambient identity.
 */
function pinIdentity(repo: string): void {
  mustGit(repo, ["config", "user.name", "nen test"]);
  mustGit(repo, ["config", "user.email", "nen@example.invalid"]);
  mustGit(repo, ["config", "commit.gpgsign", "false"]);
}

async function squash(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(wcCommand, ["wc", ...argv], null, false, io, defaultSeams());
  return { code, out, err };
}

let root = "";
let upstream = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nen-wc-squash-git-"));
  upstream = join(root, "upstream");
  mkdirSync(upstream);
  mustGit(upstream, [...PINNED, "init", "--quiet", "--initial-branch=main"]);
  pinLineEndings(upstream);
  pinIdentity(upstream);
  writeFileSync(join(upstream, "README.md"), "root\n");
  mustGit(upstream, ["add", "README.md"]);
  mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "root"]);
});

afterAll(() => {
  if (root === "") return;
  try {
    // A `.git` object store is read-only on win32 and a temp directory the OS
    // will not release is not a finding about this verb -- see ../shu/
    // warmup.integration.test.ts's own afterAll for the same trade.
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS keeps it; the tmpdir is the OS's to reap */
  }
});

/** A fresh clone of `upstream`, on a NEW branch cut from `main`, one commit per entry of `messages`. */
function freshBranch(name: string, messages: readonly string[]): string {
  const work = join(root, name);
  mustGit(root, [...PINNED, "clone", "--quiet", upstream, work]);
  pinLineEndings(work);
  pinIdentity(work);
  mustGit(work, ["switch", "-c", name]);
  messages.forEach((message, index): void => {
    writeFileSync(join(work, `${name}-${index}.txt`), `${message}\n`);
    mustGit(work, ["add", `${name}-${index}.txt`]);
    mustGit(work, [...WHO, "commit", "--quiet", "-m", message]);
  });
  return work;
}

/**
 * A message file OUTSIDE the working tree it will squash -- inside would be
 * an untracked path `git status` sees, making the message file itself the
 * dirty-tree refusal on every single test that writes one.
 */
function messageFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-wc-squash-msg-"));
  const path = join(dir, "message.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

describe.skipIf(!HAVE_GIT)("nen wc squash, against the real git", () => {
  it("folds three real commits into one, and the total diff survives unchanged", async () => {
    const work = freshBranch("fold-three", ["feat: first", "feat: second", "feat: third"]);
    expect(mustGit(work, ["rev-list", "--count", "main..HEAD"])).toBe("3");

    const msg = messageFile("feat: fold three into one\n\nCloses: #1\n");
    const result = await squash(["squash", "--repo", work, "--onto", "main", "--message-file", msg]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/squashed into/);

    expect(mustGit(work, ["rev-list", "--count", "main..HEAD"])).toBe("1");
    expect(mustGit(work, ["log", "-1", "--format=%s"])).toBe("feat: fold three into one");
    expect(mustGit(work, ["log", "-1", "--format=%b"])).toContain("Closes: #1");
    // Every file every folded commit added is still there: the DIFF is
    // unchanged, only the commit BOUNDARIES moved.
    expect(mustGit(work, ["show", "HEAD:fold-three-0.txt"])).toBe("feat: first");
    expect(mustGit(work, ["show", "HEAD:fold-three-1.txt"])).toBe("feat: second");
    expect(mustGit(work, ["show", "HEAD:fold-three-2.txt"])).toBe("feat: third");
    expect(mustGit(work, ["status", "--porcelain=v1", "-uall"])).toBe("");
  });

  it("--dry-run touches NOTHING: the commits and the tree are exactly as they were", async () => {
    const work = freshBranch("dry-run-case", ["feat: a", "feat: b"]);
    const beforeHead = mustGit(work, ["rev-parse", "HEAD"]);
    const msg = messageFile("feat: would fold\n");

    const result = await squash(["squash", "--repo", work, "--onto", "main", "--message-file", msg, "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/would fold 2 commit\(s\)/);
    expect(result.out.join("\n")).toContain("feat: would fold");

    expect(mustGit(work, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(mustGit(work, ["rev-list", "--count", "main..HEAD"])).toBe("2");
  });

  it("refuses a dirty working tree at exit 2, and leaves every commit untouched", async () => {
    const work = freshBranch("dirty-case", ["feat: a", "feat: b"]);
    writeFileSync(join(work, "scratch.txt"), "uncommitted\n");
    const beforeHead = mustGit(work, ["rev-parse", "HEAD"]);
    const msg = messageFile("feat: would fold\n");

    const result = await squash(["squash", "--repo", work, "--onto", "main", "--message-file", msg]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("scratch.txt");
    expect(mustGit(work, ["rev-parse", "HEAD"])).toBe(beforeHead);
  });

  it("refuses --onto that is not an ancestor of HEAD -- a real SIBLING branch, not a descendant", async () => {
    // A branch cut from the same root as 'main', carrying a commit
    // 'diverge-case' never merges in -- so 'sibling' is not an ancestor of
    // its HEAD, even though the two share history.
    mustGit(upstream, ["switch", "-c", "sibling"]);
    writeFileSync(join(upstream, "sibling-only.txt"), "sibling\n");
    mustGit(upstream, ["add", "sibling-only.txt"]);
    mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "feat: sibling-only"]);
    mustGit(upstream, ["switch", "main"]); // restore HEAD before any later clone

    const work = freshBranch("diverge-case", ["feat: a", "feat: b"]);
    mustGit(work, [...PINNED, "fetch", "--quiet", "origin", "sibling:sibling"]);
    const msg = messageFile("feat: would fold\n");

    const result = await squash(["squash", "--repo", work, "--onto", "sibling", "--message-file", msg]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/not an ancestor/);
    expect(mustGit(work, ["rev-list", "--count", "main..HEAD"])).toBe("2");
  });

  it("refuses a commit already on the branch's own upstream: already published", async () => {
    const work = freshBranch("published-case", ["feat: a", "feat: b"]);
    mustGit(work, [...PINNED, "push", "--quiet", "-u", "origin", "published-case"]);

    const msg = messageFile("feat: would fold\n");
    const result = await squash(["squash", "--repo", work, "--onto", "main", "--message-file", msg]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/already published; squashing would rewrite pushed history/);
    // Nothing moved: still two commits, HEAD unchanged.
    expect(mustGit(work, ["rev-list", "--count", "main..HEAD"])).toBe("2");
  });

  it("exits 0 with nothing moved when fewer than two commits would fold", async () => {
    const work = freshBranch("single-commit-case", ["feat: only one"]);
    const beforeHead = mustGit(work, ["rev-parse", "HEAD"]);
    const msg = messageFile("feat: would fold\n");

    const result = await squash(["squash", "--repo", work, "--onto", "main", "--message-file", msg]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/nothing to squash/);
    expect(mustGit(work, ["rev-parse", "HEAD"])).toBe(beforeHead);
  });
});
