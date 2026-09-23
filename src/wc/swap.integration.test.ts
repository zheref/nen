// src/wc/swap.integration.test.ts -- `nen wc worktrees` and `nen wc swap`,
// against the REAL git, in a throwaway repository with a real (bare, local)
// `origin`, a core clone and one worktree (zheref/nen#241).
//
// THE FIRST DESCRIBE IS THE REFERENCE ENGINE'S SELF-TEST, PORTED ONE FOR ONE.
// The verb replaces a consumer's shell engine whose `--self-test` held 29
// hermetic fixtures; each `it` below is one of them, in the same order, over
// the same evolving fixture -- core dirty with a modified, an untracked and a
// deleted path plus an ignored file that must never move -- because the
// fixtures are a SEQUENCE (a re-swap only means something after a swap). The
// numbers in the titles are the engine's own order. The second describe adds
// what the port itself owes: the refusals the engine never exercised, the
// stranded-park guard, and the --json contracts.
//
// THE FIXTURE IS ./catchup.integration.test.ts's OWN SHAPE: repo-local
// identity and `core.autocrlf=false`, `protocol.file.allow=always` for the
// local clone, a floor of git 2.31 (`rev-parse --path-format=absolute`), and a
// loud SKIP where no usable git is on PATH.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { wcCommand } from "./command.js";
import { PARK_REF, STATE_FILE, SWAP_CONTRACT, WORKTREES_CONTRACT } from "./swap.js";

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
  return major > 2 || (major === 2 && minor >= 31);
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
  readonly out: string;
  readonly err: string;
  readonly doc: Record<string, unknown>;
}

async function wc(argv: readonly string[], repo: string, json = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(wcCommand, ["wc", ...argv], repo, json, io, defaultSeams());
  const doc = json && out.length > 0 ? (JSON.parse(out.join("\n")) as Record<string, unknown>) : {};
  return { code, out: out.join("\n"), err: err.join("\n"), doc };
}

const branchOf = (repo: string): string | null => {
  const ref = git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
  return ref.code === 0 ? ref.stdout.trim() : null;
};
const headOf = (repo: string): string => mustGit(repo, ["rev-parse", "HEAD"]);
const parkRef = (repo: string): boolean => git(repo, ["rev-parse", "-q", "--verify", PARK_REF]).code === 0;

let root = "";
let C = "";
let W = "";

function commitIn(repo: string, files: Readonly<Record<string, string>>, message: string): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  mustGit(repo, ["add", "-A"]);
  mustGit(repo, ["commit", "--quiet", "-m", message]);
}

beforeAll(() => {
  if (!HAVE_GIT) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), "nen-wc-swap-git-")));
  const origin = join(root, "origin.git");
  C = join(root, "core");
  W = join(root, "wt");
  mustGit(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  mustGit(root, [...PINNED, "clone", "--quiet", origin, C]);
  pin(C);
  mustGit(C, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  commitIn(C, { "a.txt": "one\n", "gone.txt": "keep\n", ".gitignore": "ignored/\n" }, "base");
  mustGit(C, [...PINNED, "push", "--quiet", "origin", "main"]);
  mustGit(C, ["worktree", "add", "--quiet", "-b", "feat", W]);
  commitIn(W, { "f.txt": "feat\n", "App.xcodeproj/project.pbxproj": "p\n" }, "feat work");
  // core dirty: modified, untracked, deleted, and an ignored file that must never move
  writeFileSync(join(C, "a.txt"), "one-edited\n");
  writeFileSync(join(C, "new.txt"), "new\n");
  rmSync(join(C, "gone.txt"));
  mkdirSync(join(C, "ignored"), { recursive: true });
  writeFileSync(join(C, "ignored", "local.cfg"), "secret\n");
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

if (!HAVE_GIT) {
  it.skip("SKIPPED: no git >= 2.31 on PATH -- the swap fixtures need a real git", () => undefined);
}

describe.skipIf(!HAVE_GIT)("nen wc swap -- the reference engine's 29 fixtures, ported in order", () => {
  it("01 return with no swap is refused (2)", async () => {
    expect((await wc(["swap", "--return"], C)).code).toBe(2);
  });

  it("02 an unknown target is refused (2)", async () => {
    expect((await wc(["swap", "nope"], C)).code).toBe(2);
  });

  it("03 the core itself is refused (2)", async () => {
    expect((await wc(["swap", C], C)).code).toBe(2);
  });

  it("04 a dirty worktree is refused (3), naming the path", async () => {
    writeFileSync(join(W, "wip.txt"), "x\n");
    const run = await wc(["swap", "feat"], C);
    expect(run.code).toBe(3);
    expect(run.err).toContain("wip.txt");
  });

  it("05   and core did not move", () => {
    expect(branchOf(C)).toBe("main");
    expect(existsSync(join(C, "new.txt"))).toBe(true);
    rmSync(join(W, "wip.txt"));
  });

  let swapOut = "";
  it("06 swap by branch, run from inside the worktree (0)", async () => {
    const run = await wc(["swap", "feat"], W);
    swapOut = run.out;
    expect(run.code).toBe(0);
  });

  it("07   core holds the worktree's commit, detached", () => {
    expect(headOf(C)).toBe(headOf(W));
    expect(branchOf(C)).toBeNull();
  });

  it("08   the worktree keeps its branch", () => {
    expect(branchOf(W)).toBe("feat");
  });

  it("09   core is clean and its ignored file untouched", () => {
    expect(mustGit(C, ["status", "--porcelain"])).toBe("");
    expect(readFileSync(join(C, "ignored", "local.cfg"), "utf8")).toBe("secret\n");
  });

  it("10   the parked work is pinned", () => {
    expect(parkRef(C)).toBe(true);
  });

  it("11   the project-file reload hint is printed", () => {
    expect(swapOut).toContain("project.pbxproj");
  });

  it("12 list marks core and the swapped-in worktree", async () => {
    const run = await wc(["worktrees"], C);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/^core /m);
    expect(run.out).toMatch(/^in {3}/m);
  });

  it("13 re-swap by path picks up the worktree's newer commit", async () => {
    writeFileSync(join(W, "f.txt"), "feat\nmore\n");
    mustGit(W, ["commit", "--quiet", "-am", "more feat"]);
    const run = await wc(["swap", W], C);
    expect(run.code).toBe(0);
    expect(headOf(C)).toBe(headOf(W));
  });

  it("14   and keeps the first home", async () => {
    const run = await wc(["swap", "--status"], C, true);
    expect(run.doc["home"]).toBe("main");
  });

  it("15 return refuses a core dirtied while viewing (3)", async () => {
    writeFileSync(join(C, "f.txt"), "feat\nmore\nscribble\n");
    expect((await wc(["swap", "--return"], C)).code).toBe(3);
  });

  it("16 a dirty view is promoted to --take in place (0)", async () => {
    const run = await wc(["swap", "feat", "--take"], C);
    expect(run.code).toBe(0);
    expect(branchOf(C)).toBe("feat");
    expect(readFileSync(join(C, "f.txt"), "utf8")).toContain("scribble");
    mustGit(C, ["checkout", "--quiet", "--", "f.txt"]);
  });

  it("17 return (0)", async () => {
    expect((await wc(["swap", "--return"], C)).code).toBe(0);
  });

  it("18   the promoted branch went back to the worktree", () => {
    expect(branchOf(W)).toBe("feat");
  });

  it("19   core is back on main", () => {
    expect(branchOf(C)).toBe("main");
  });

  it("20   modified, new and deleted paths restored, nothing staged", () => {
    expect(readFileSync(join(C, "a.txt"), "utf8")).toBe("one-edited\n");
    expect(existsSync(join(C, "new.txt"))).toBe(true);
    expect(existsSync(join(C, "gone.txt"))).toBe(false);
    expect(mustGit(C, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("21   the park ref and the state are gone", () => {
    expect(parkRef(C)).toBe(false);
    expect(existsSync(join(C, ".git", STATE_FILE))).toBe(false);
  });

  it("22 the shared stash stack was never touched", () => {
    expect(mustGit(C, ["stash", "list"])).toBe("");
  });

  it("23 swap --take (0)", async () => {
    expect((await wc(["swap", "feat", "--take"], C)).code).toBe(0);
  });

  it("24   core has the branch; the worktree is detached on the same commit", () => {
    expect(branchOf(C)).toBe("feat");
    expect(branchOf(W)).toBeNull();
    expect(headOf(W)).toBe(headOf(C));
  });

  it("25 return from --take (0)", async () => {
    writeFileSync(join(C, "fix.txt"), "from the ide\n");
    mustGit(C, ["add", "fix.txt"]);
    mustGit(C, ["commit", "--quiet", "-m", "fix from core"]);
    expect((await wc(["swap", "--return"], C)).code).toBe(0);
  });

  it("26   the worktree has its branch back, with core's commit on it", () => {
    expect(branchOf(W)).toBe("feat");
    expect(existsSync(join(W, "fix.txt"))).toBe(true);
  });

  it("27   core is home with its work restored", () => {
    expect(branchOf(C)).toBe("main");
    expect(readFileSync(join(C, "a.txt"), "utf8")).toBe("one-edited\n");
  });

  it("28 --take on a detached worktree is refused (2)", async () => {
    mustGit(W, ["checkout", "--quiet", "--detach"]);
    expect((await wc(["swap", W, "--take"], C)).code).toBe(2);
    mustGit(W, ["checkout", "--quiet", "feat"]);
  });

  it("29 an unknown verb is refused (2)", async () => {
    expect((await wc(["bogus"], C)).code).toBe(2);
  });
});

describe.skipIf(!HAVE_GIT)("nen wc swap -- what the port adds", () => {
  it("a branch name shared by two worktree directory names is refused (2) -- pass the path", async () => {
    const twin = join(root, "twin", "feat");
    mustGit(C, ["worktree", "add", "--quiet", "-b", "other", twin]);
    const run = await wc(["swap", "feat"], C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/more than one worktree/);
    mustGit(C, ["worktree", "remove", "--force", twin]);
  });

  it("status with no swap says so (0), and its --json is inactive", async () => {
    const text = await wc(["swap", "--status"], C);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^no swap active; core is on main$/);
    const json = await wc(["swap", "--status"], C, true);
    expect(json.doc["contract"]).toBe(SWAP_CONTRACT);
    expect(json.doc["active"]).toBe(false);
  });

  it("the swap document's key order is the contract", async () => {
    const run = await wc(["swap", "feat"], C, true);
    expect(run.code).toBe(0);
    expect(Object.keys(run.doc)).toEqual([
      "contract", "action", "core", "coreBranch", "head", "active", "target", "branch",
      "mode", "home", "homeSha", "parked", "reloadHints", "dirty",
    ]);
    expect(run.doc["action"]).toBe("swap");
    expect(run.doc["mode"]).toBe("view");
    expect(run.doc["home"]).toBe("main");
    expect(typeof run.doc["parked"]).toBe("string");
  });

  it("the swap record lives in the common git directory, never in the tree", () => {
    expect(existsSync(join(C, ".git", STATE_FILE))).toBe(true);
    expect(mustGit(C, ["status", "--porcelain", "--ignored"])).not.toContain(STATE_FILE);
  });

  it("worktrees --json carries the swap and one row per worktree, core first", async () => {
    const run = await wc(["worktrees"], W, true);
    expect(run.code).toBe(0);
    expect(run.doc["contract"]).toBe(WORKTREES_CONTRACT);
    const rows = run.doc["worktrees"] as Array<Record<string, unknown>>;
    expect(rows.map((row): unknown => row["mark"])).toEqual(["core", "in"]);
    expect(rows[1]?.["branch"]).toBe("feat");
    expect(rows[1]?.["ahead"]).toBe(3);
    expect(rows[1]?.["behind"]).toBe(0);
    expect(rows[0]?.["dirty"]).toBe(0);
    expect((run.doc["swap"] as Record<string, unknown>)["mode"]).toBe("view");
  });

  it("a dirty core on --return under --json is a document naming the checkout and every path (3)", async () => {
    writeFileSync(join(C, "stray.txt"), "x\n");
    const run = await wc(["swap", "--return"], C, true);
    expect(run.code).toBe(3);
    const dirty = run.doc["dirty"] as { checkout: string; paths: string[] };
    expect(dirty.paths.some((line): boolean => line.endsWith("stray.txt"))).toBe(true);
    rmSync(join(C, "stray.txt"));
    expect((await wc(["swap", "--return"], C)).code).toBe(0);
    expect(readFileSync(join(C, "a.txt"), "utf8")).toBe("one-edited\n");
  });

  it("a detached home is returned to by commit", async () => {
    const home = headOf(C);
    mustGit(C, ["checkout", "--quiet", "--detach"]);
    expect((await wc(["swap", "feat"], C)).code).toBe(0);
    const back = await wc(["swap", "--return"], C);
    expect(back.code).toBe(0);
    expect(branchOf(C)).toBeNull();
    expect(headOf(C)).toBe(home);
    mustGit(C, ["checkout", "--quiet", "main"]);
    expect(readFileSync(join(C, "a.txt"), "utf8")).toBe("one-edited\n");
  });

  it("a park ref stranded by an interrupted swap is refused (2), never overwritten", async () => {
    const stranded = mustGit(C, ["rev-parse", "HEAD"]);
    mustGit(C, ["update-ref", PARK_REF, stranded]);
    const run = await wc(["swap", "feat"], C);
    expect(run.code).toBe(2);
    expect(run.err).toContain(stranded);
    expect(branchOf(C)).toBe("main");
    expect(mustGit(C, ["rev-parse", PARK_REF])).toBe(stranded);
    mustGit(C, ["update-ref", "-d", PARK_REF]);
  });

  it("the stash stack is still untouched at the end", () => {
    expect(mustGit(C, ["stash", "list"])).toBe("");
  });
});
