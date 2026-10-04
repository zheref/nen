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
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
const HAVE_BUN = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
/** This repository's own entry point, spawned as a process for the byte-level row. */
const ENTRY = join(process.cwd(), "src", "index.ts");

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

// hanten round 1 on #237: each row a claim about git only git can answer.
describe.skipIf(!HAVE_GIT)("nen stage list, against the real git -- hanten round 1 (zheref/nen#237)", () => {
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nen-stage-list-r1-"));
  });

  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("N1: a worktree rename (git add -N, then a move) piped into git add stages the WHOLE rename", async () => {
    const repo = freshRepo(root, "rename");
    write(repo, "src/old.ts", "a body long enough for git to call the move a rename\n");
    mustGit(repo, ["add", "src/old.ts"]);
    mustGit(repo, [...WHO, "commit", "--quiet", "-m", "old"]);
    renameSync(join(repo, "src", "old.ts"), join(repo, "src", "new.ts"));
    mustGit(repo, ["add", "-N", "src/new.ts"]);
    expect(mustGit(repo, ["status", "--porcelain=v1", "-z"])).toBe(" R src/new.ts\0src/old.ts\0");

    const unmentioned = await stageList(repo, []);
    expect(unmentioned.code).toBe(1);
    expect(unmentioned.err.join("\n")).toMatch(/^excluded: src\/old\.ts {2}\[unmentioned-deletion\]$/m);

    const result = await stageList(repo, ["--nul", "--mentions", "moves old.ts"]);
    expect(result.code).toBe(0);
    expect(result.written).toBe("src/new.ts\0src/old.ts\0");
    mustGit(repo, ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], result.written);
    expect(mustGit(repo, ["diff", "--cached", "--name-status", "-M", "-z"])).toMatch(/^R100\0src\/old\.ts\0src\/new\.ts\0$/);
  });

  it("N2: a --repo naming a subdirectory is refused at exit 2, naming the top", async () => {
    const repo = freshRepo(root, "subdir");
    write(repo, "src/new.ts");
    const result = await stageList(join(repo, "src"), []);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/not its top/);
    expect((await stageList(repo, [])).code).toBe(0);
  });

  it("N3: a real merge conflict is named 'unmerged', the list withheld at exit 1", async () => {
    const repo = freshRepo(root, "conflict");
    mustGit(repo, ["switch", "--quiet", "-c", "side"]);
    write(repo, "src/a.ts", "side\n");
    mustGit(repo, [...WHO, "commit", "--quiet", "-am", "side"]);
    mustGit(repo, ["switch", "--quiet", "main"]);
    write(repo, "src/a.ts", "main\n");
    mustGit(repo, [...WHO, "commit", "--quiet", "-am", "main"]);
    expect(git(repo, [...WHO, "merge", "--no-edit", "side"]).code).not.toBe(0);
    write(repo, "src/other.ts");

    const result = await stageList(repo, []);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toContain("unmerged: src/a.ts");
    const json = await stageList(repo, [], true);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ verdict: "flagged", unmerged: ["src/a.ts"], add: ["src/other.ts"] });
  });

  it("N4: an embedded repository, empty or populated, is never on the list", async () => {
    const repo = freshRepo(root, "embedded");
    mustGit(repo, ["init", "--quiet", "--initial-branch=main", join(repo, "empty-sub")]);
    const populated = join(repo, "full-sub");
    mustGit(repo, ["init", "--quiet", "--initial-branch=main", populated]);
    write(populated, "inner.ts");
    mustGit(populated, ["add", "inner.ts"]);
    mustGit(populated, [...WHO, "commit", "--quiet", "-m", "inner"]);
    write(repo, "src/new.ts");

    const json = await stageList(repo, [], true);
    expect(json.code).toBe(1);
    const doc = JSON.parse(json.out.join("\n")) as { add: string[]; embeddedRepos: string[] };
    expect([...doc.embeddedRepos].sort()).toEqual(["empty-sub/", "full-sub/"]);
    expect(doc.add).toEqual(["src/new.ts"]);
    const text = await stageList(repo, []);
    expect(text.out).toEqual([]);
    expect(text.err.join("\n")).toMatch(/^embedded repository: empty-sub\/ /m);
    expect(text.err.join("\n")).toMatch(/^embedded repository: full-sub\/ /m);
  });

  // N5: the in-process harness proves `write` gets the bytes; only a real
  // process proves nothing APPENDS one -- the trailing newline that git reads
  // as one more pathspec, matching nothing, and then stages nothing.
  it.skipIf(!HAVE_BUN)("N5: the spawned entry point's --nul stdout ends in NUL, with no newline after it", () => {
    const repo = freshRepo(root, "process");
    write(repo, "src/new.ts");
    write(repo, "with space.ts");
    const result = spawnSync("bun", [ENTRY, "stage", "list", "--repo", repo, "--nul"], { cwd: repo });
    expect(result.status).toBe(0);
    const stdout = result.stdout;
    expect(stdout.length).toBeGreaterThan(0);
    expect(stdout[stdout.length - 1]).toBe(0);
    expect(stdout.includes(0x0a)).toBe(false);
    expect(stdout.toString("utf8")).toBe("src/new.ts\0with space.ts\0");
  });
});
