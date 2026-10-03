// src/commit/readback.integration.test.ts -- the read-back of zheref/nen#273,
// against the REAL git, in temporary repositories that carry a REAL
// `prepare-commit-msg` hook.
//
// WHY A REAL HOOK. The defect is that a hook runs INSIDE the verb's child
// `git commit` and edits a message nen never sees again. A scripted seam can
// only prove nen asks `git log -1 --format=%(trailers:only,unfold)`; it
// cannot prove that git really runs the hook on `commit -F`, that
// `git interpret-trailers` really lands the line in the trailer block git's
// own parser reads back, or that the commit really stays in place. The hook
// here is a model of the mechanism (Chrollo's own repro on 2026-09-28), not
// Cursor itself: it appends `Co-authored-by: Cursor <cursoragent@cursor.com>`
// through `git interpret-trailers --in-place`.
//
// THE FIXTURE IS ../wc/squash.integration.test.ts's SHAPE: a repo-local
// identity (the commit the VERB makes carries no `-c` flags), a pinned
// `core.hooksPath` so a host's global hooks directory neither hides this one
// nor adds its own, and a SKIP where git is missing or older than 2.28.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { wcCommand } from "../wc/command.js";
import type { Command } from "../cli/command.js";
import { commitCommand } from "./command.js";

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

/** The policy every repository below carries: the one attribution key it admits. */
const POLICY = { commits: { allowedAttributionTrailers: ["Hatsu-Agent"] } };

const CURSOR = "Co-authored-by: Cursor <cursoragent@cursor.com>";

let root = "";
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nen-commit-readback-"));
});

afterAll(() => {
  if (root === "") return;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS keeps it; the tmpdir is the OS's to reap */
  }
});

/**
 * A repository with one root commit, the policy committed, and -- when
 * `hookTrailer` is given -- a prepare-commit-msg hook appending that trailer
 * to every message. The hook directory is pinned under `.git/` so it is
 * never itself a path `git status` sees.
 */
function repository(hookTrailer: string | null): string {
  counter += 1;
  const repo = join(root, `repo-${counter}`);
  mkdirSync(repo);
  mustGit(repo, ["init", "--quiet", "--initial-branch=main"]);
  mustGit(repo, ["config", "core.autocrlf", "false"]);
  mustGit(repo, ["config", "user.name", "nen test"]);
  mustGit(repo, ["config", "user.email", "nen@example.invalid"]);
  mustGit(repo, ["config", "commit.gpgsign", "false"]);
  const hooks = join(repo, ".git", "nen-test-hooks");
  mkdirSync(hooks);
  mustGit(repo, ["config", "core.hooksPath", hooks]);
  mkdirSync(join(repo, "nen"));
  writeFileSync(join(repo, "nen", "workflow.json"), `${JSON.stringify(POLICY)}\n`);
  writeFileSync(join(repo, "README.md"), "root\n");
  mustGit(repo, ["add", "-A"]);
  mustGit(repo, ["commit", "--quiet", "-m", "chore: root"]);
  if (hookTrailer !== null) installHook(repo, hookTrailer);
  return repo;
}

/** The prepare-commit-msg hook: append `trailer` to every message, through git's own trailer writer. */
function installHook(repo: string, trailer: string): void {
  const hook = join(repo, ".git", "nen-test-hooks", "prepare-commit-msg");
  writeFileSync(hook, `#!/bin/sh\ngit interpret-trailers --in-place --trailer '${trailer}' "$1"\n`);
  chmodSync(hook, 0o755);
}

async function run(
  command: Command,
  argv: readonly string[],
  repo: string,
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(command, [...argv, "--repo", repo], null, true, io, defaultSeams());
  return { code, out, err };
}

/** Stage one new file and write `message.txt` outside the index (under .git, so the tree stays clean). */
function stage(repo: string, name: string, message: string): string {
  writeFileSync(join(repo, name), `${name}\n`);
  mustGit(repo, ["add", name]);
  const path = join(repo, ".git", `msg-${name}.txt`);
  writeFileSync(path, message);
  return path;
}

describe.skipIf(!HAVE_GIT)("nen commit write -- the written commit's trailers, read back (zheref/nen#273)", () => {
  it("a clean repository: exit 0, injected [], trailers as written", async () => {
    const repo = repository(null);
    const message = stage(repo, "a.txt", "feat: add a\n");
    const result = await run(commitCommand, ["commit", "write", "--message-file", message, "--trailer", "Hatsu-Agent: kurapika"], repo);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["injected"]).toEqual([]);
    expect(doc["trailers"]).toEqual([{ key: "Hatsu-Agent", value: "kurapika" }]);
    expect(doc["sha"]).toBe(mustGit(repo, ["rev-parse", "HEAD"]));
  });

  it("a prepare-commit-msg hook appending Co-authored-by: exit 3, the key named, the commit LEFT IN PLACE", async () => {
    const repo = repository(CURSOR);
    const before = mustGit(repo, ["rev-parse", "HEAD"]);
    const message = stage(repo, "b.txt", "feat: add b\n");
    const result = await run(commitCommand, ["commit", "write", "--message-file", message, "--trailer", "Hatsu-Agent: kurapika"], repo);
    expect(result.code).toBe(3);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["injected"]).toEqual(["Co-authored-by"]);
    expect(doc["trailers"]).toEqual([
      { key: "Hatsu-Agent", value: "kurapika" },
      { key: "Co-authored-by", value: "Cursor <cursoragent@cursor.com>" },
    ]);
    // Never amended: HEAD is the commit the verb reported, one ahead of the root, still carrying the key.
    const head = mustGit(repo, ["rev-parse", "HEAD"]);
    expect(doc["sha"]).toBe(head);
    expect(mustGit(repo, ["rev-parse", "HEAD~1"])).toBe(before);
    expect(mustGit(repo, ["log", "-1", "--format=%(trailers:only,unfold)"])).toContain(CURSOR);
    expect(result.err.join("\n")).toMatch(/refuses: 'Co-authored-by'/);
    expect(result.err.join("\n")).toMatch(/nen never amends it/);
  });

  it("a hook appending a key the policy ADMITS is not injected: exit 0, a note names it", async () => {
    const repo = repository("Hatsu-Agent: kurapika");
    const message = stage(repo, "c.txt", "feat: add c\n");
    const result = await run(commitCommand, ["commit", "write", "--message-file", message], repo);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["injected"]).toEqual([]);
    expect(doc["trailers"]).toEqual([{ key: "Hatsu-Agent", value: "kurapika" }]);
    expect(result.err.join("\n")).toMatch(/nen: note: .*also carries 'Hatsu-Agent'/);
  });
});

describe.skipIf(!HAVE_GIT)("nen wc squash -- the folded commit's trailers, read back (zheref/nen#273)", () => {
  /** Two clean commits on a branch; the hook, when given, is installed only AFTER them, so it fires on the squash's own commit alone. */
  function branchWithTwo(hookTrailer: string | null): string {
    const repo = repository(null);
    mustGit(repo, ["switch", "--quiet", "-c", "work"]);
    for (const name of ["one", "two"]) {
      writeFileSync(join(repo, `${name}.txt`), `${name}\n`);
      mustGit(repo, ["add", `${name}.txt`]);
      mustGit(repo, ["commit", "--quiet", "-m", `feat: add ${name}`]);
    }
    if (hookTrailer !== null) installHook(repo, hookTrailer);
    return repo;
  }

  it("a clean fold: exit 0, injected []", async () => {
    const repo = branchWithTwo(null);
    const message = join(repo, ".git", "squash-msg.txt");
    writeFileSync(message, "feat: add one and two\n\nHatsu-Agent: kurapika\n");
    const result = await run(wcCommand, ["wc", "squash", "--onto", "main", "--message-file", message], repo);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["injected"]).toEqual([]);
  });

  it("a hook appending Co-authored-by to the fold: exit 3, the key named, the squash left in place", async () => {
    const repo = branchWithTwo(CURSOR);
    const message = join(repo, ".git", "squash-msg.txt");
    writeFileSync(message, "feat: add one and two\n\nHatsu-Agent: kurapika\n");
    const result = await run(wcCommand, ["wc", "squash", "--onto", "main", "--message-file", message], repo);
    expect(result.code).toBe(3);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["injected"]).toEqual(["Co-authored-by"]);
    expect(doc["newSha"]).toBe(mustGit(repo, ["rev-parse", "HEAD"]));
    expect(mustGit(repo, ["rev-parse", "HEAD~1"])).toBe(mustGit(repo, ["rev-parse", "main"]));
    expect(result.err.join("\n")).toMatch(/git reset --soft ORIG_HEAD/);
  });
});
