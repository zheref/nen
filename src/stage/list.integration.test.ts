// src/stage/list.integration.test.ts -- `nen stage list` against the REAL git
// (zheref/nen#237).
//
// WHY A REAL GIT. The scripted suite proves the verb turns a porcelain record
// into a list. It cannot prove the list MEANS what the verb claims: that `git
// add --pathspec-from-file=-` fed this stdout verbatim stages exactly the
// intended set -- untracked files included, a path with a space or a newline
// read back whole, a staged deletion not breaking the whole add, an ignored
// file and a flagged one left out. Each of those is a claim about git, and only
// git can answer it. The defect that filed #237 was two untracked files dropped
// between a listing and a `git add`; this file stages from the verb's own
// output and reads the index back.
//
// It SKIPS where `git` is missing or older than 2.28 (the fixture's
// `--initial-branch` floor; `--pathspec-from-file` needs only 2.26), exactly as
// ../shu/warmup.integration.test.ts does, and for the same reason. A path
// carrying a newline or a double quote cannot exist on Windows, so those two
// rows are POSIX-only; every other row runs everywhere.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { stageCommand } from "./command.js";

const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];
const POSIX = process.platform !== "win32";

function git(cwd: string, args: readonly string[], input?: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    ...(input === undefined ? {} : { input }),
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function mustGit(cwd: string, args: readonly string[], input?: string): string {
  const result = git(cwd, args, input);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  return result.stdout;
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

function write(root: string, path: string, content = "x\n"): void {
  const parts = path.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), content, "utf8");
}

async function stageList(
  repo: string,
  argv: readonly string[],
  json = false,
): Promise<{ code: number; out: string[]; err: string[]; written: string }> {
  const out: string[] = [];
  const err: string[] = [];
  let written = "";
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
    write: (chunk): void => {
      written += chunk;
    },
  };
  const code = await runFamily(stageCommand, ["stage", "list", ...argv], repo, json, io, defaultSeams());
  return { code, out, err, written };
}

/** The index's changed paths against HEAD, as a sorted set -- renames off, since every fixture file shares one content. */
function stagedPaths(repo: string): string[] {
  return mustGit(repo, ["-c", "core.quotePath=false", "diff", "--cached", "--no-renames", "--name-only", "-z"])
    .split("\0")
    .filter((path): boolean => path !== "")
    .sort();
}

/** A fresh repository with one commit: tracked files to modify and delete, and a .gitignore. */
function freshRepo(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  mustGit(repo, ["init", "--quiet", "--initial-branch=main"]);
  mustGit(repo, ["config", "core.autocrlf", "false"]);
  write(repo, ".gitignore", "node_modules/\n");
  write(repo, "src/a.ts");
  write(repo, "src/gone.ts");
  write(repo, "src/staged-gone.ts");
  mustGit(repo, ["add", "."]);
  mustGit(repo, [...WHO, "commit", "--quiet", "-m", "init"]);
  return repo;
}

describe.skipIf(!HAVE_GIT)("nen stage list, against the real git (zheref/nen#237)", () => {
  let root = "";
  let repo = "";
  // Every path a checkpoint must stage. The two `oauthReturnQuery` files are
  // the very pair zheref/kro-pwa#95's hand-written filter dropped.
  const expected: string[] = [
    "src/a.ts",
    "src/gone.ts",
    "packages/core/src/utils/oauthReturnQuery.ts",
    "packages/core/src/utils/__tests__/oauthReturnQuery.test.ts",
    "with space.ts",
    "st*r[1].ts",
    ...(POSIX ? ["new\nline.ts", '"quoted.ts'] : []),
  ];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nen-stage-list-"));
    repo = freshRepo(root, "work");
    write(repo, "src/a.ts", "changed\n");
    rmSync(join(repo, "src", "gone.ts"));
    mustGit(repo, ["rm", "--quiet", "src/staged-gone.ts"]);
    for (const path of expected) if (path !== "src/a.ts" && path !== "src/gone.ts") write(repo, path);
    write(repo, "node_modules/leftpad/index.js");
    write(repo, ".env", "SECRET=1\n");
  });

  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("on a tree with a flagged secret: exit 1, nothing on stdout, the exclusion named, --json whole", async () => {
    const text = await stageList(repo, ["--mentions", "drops gone.ts and staged-gone.ts"]);
    expect(text.code).toBe(1);
    expect(text.out).toEqual([]);
    expect(text.written).toBe("");
    expect(text.err.join("\n")).toMatch(/^excluded: \.env {2}\[secret-shape\]$/m);

    const json = await stageList(repo, ["--mentions", "drops gone.ts and staged-gone.ts"], true);
    expect(json.code).toBe(1);
    const doc = JSON.parse(json.out.join("\n")) as {
      verdict: string;
      add: string[];
      excluded: { path: string; reasons: string[] }[];
      alreadyStaged: string[];
      ignored: { path: string; reasons: string[] }[];
    };
    expect(doc.verdict).toBe("flagged");
    expect([...doc.add].sort()).toEqual([...expected].sort());
    // git status's own order, which docs/USAGE.md's example shows: tracked
    // changes first, then untracked paths, each byte-sorted.
    expect(doc.add.slice(0, 2)).toEqual(["src/a.ts", "src/gone.ts"]);
    const untracked = doc.add.slice(2);
    expect(untracked).toEqual([...untracked].sort());
    expect(doc.excluded).toEqual([{ path: ".env", reasons: ["secret-shape"] }]);
    expect(doc.alreadyStaged).toEqual(["src/staged-gone.ts"]);
    expect(doc.ignored).toEqual([{ path: "node_modules/leftpad/index.js", reasons: ["ignored"] }]);
  });

  it("--nul fed verbatim to git add stages exactly the intended set", async () => {
    rmSync(join(repo, ".env"));
    const result = await stageList(repo, ["--nul", "--mentions", "drops gone.ts and staged-gone.ts"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([]);
    mustGit(repo, ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], result.written);
    expect(stagedPaths(repo)).toEqual([...expected, "src/staged-gone.ts"].sort());
    expect(stagedPaths(repo)).not.toContain("node_modules/leftpad/index.js");
  });

  it("the newline form fed verbatim to git add stages the same set", async () => {
    // Back to the same tree, unstaged, with the staged deletion kept staged.
    mustGit(repo, ["reset", "--quiet"]);
    mustGit(repo, ["rm", "--quiet", "--cached", "src/staged-gone.ts"]);
    const result = await stageList(repo, ["--mentions", "drops gone.ts and staged-gone.ts"]);
    expect(result.code).toBe(0);
    mustGit(repo, ["--literal-pathspecs", "add", "--pathspec-from-file=-"], result.out.map((line): string => `${line}\n`).join(""));
    expect(stagedPaths(repo)).toEqual([...expected, "src/staged-gone.ts"].sort());
  });

  it("an empty tree -- nothing but an ignored file -- exits 3 with an empty list", async () => {
    const empty = freshRepo(root, "empty");
    write(empty, "node_modules/leftpad/index.js");
    const text = await stageList(empty, []);
    expect(text.code).toBe(3);
    expect(text.out).toEqual([]);
    expect(text.err.join("\n")).toMatch(/nothing to add/);
    const json = await stageList(empty, [], true);
    expect(json.code).toBe(3);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ verdict: "empty", add: [], excluded: [] });
  });

  it("a directory that is not a repository is a failure (exit 1), never an empty list", async () => {
    const bare = join(root, "not-a-repo");
    mkdirSync(bare, { recursive: true });
    const result = await stageList(bare, []);
    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(3);
    expect(result.out).toEqual([]);
  });
});
