// src/shu/warmup-carry.integration.test.ts -- `nen shu warmup --carry` against
// the REAL git, in a temporary repository with a real (local) `origin`.
//
// WHY THIS EXISTS BESIDE THE SCRIPTED SUITE. ./warmup-carry.test.ts proves nen
// sends the argv it means to send -- a scripted seam accepts whatever argv this
// suite told it to accept, and a scripted 'ok' for `git stash pop <ref>` says
// nothing about whether the REAL git accepts a pop by ref rather than by the
// raw SHA `git rev-parse refs/stash` reads. It did not, on the first cut of
// this feature: `git stash pop <sha>` and `git stash drop <sha>` are both
// refused by real git -- only `stash apply` takes a raw object name -- so
// every real `--carry` run ended on the pop-failure path with the work
// stranded in the stash, and no scripted test caught it because every one of
// them handed the argv straight to a stub that says yes to anything it was
// told to. This file hands the argv to git itself.
//
// SAME FIXTURE SHAPE AS ./warmup.integration.test.ts -- see that file's header
// for the line-ending pin and the git-version floor; this file repeats the
// small amount of setup it needs rather than importing across two files whose
// `describe` blocks would otherwise share mutable fixture state.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { shuCommand } from "./command.js";

const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];
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

async function warmup(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(shuCommand, ["shu", ...argv], null, false, io, defaultSeams());
  return { code, out, err };
}

describe.skipIf(!HAVE_GIT)("nen shu warmup --carry, against the real git", () => {
  let root = "";
  let upstream = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nen-warmup-carry-git-"));
    upstream = join(root, "upstream");
    mkdirSync(upstream);
    mustGit(upstream, [...PINNED, "init", "--quiet", "--initial-branch=main"]);
    pinLineEndings(upstream);
    writeFileSync(join(upstream, "README.md"), "root\n");
    mustGit(upstream, ["add", "README.md"]);
    mustGit(upstream, [...WHO, "commit", "--quiet", "-m", "root"]);
  });

  afterAll(() => {
    if (root === "") return;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS keeps it; the tmpdir is the OS's to reap */
    }
  });

  /** A fresh clone of `upstream`, named `name`, with line endings pinned. */
  function freshClone(name: string): string {
    const work = join(root, name);
    mustGit(root, [...PINNED, "clone", "--quiet", upstream, work]);
    pinLineEndings(work);
    return work;
  }

  it("stashes a tracked modification and an untracked file, cuts the branch, and pops both back -- 'git stash list' ends empty", async () => {
    const work = freshClone("carry-happy");
    writeFileSync(join(work, "README.md"), "root\nedited locally\n");
    writeFileSync(join(work, "scratch.md"), "untracked, carried too\n");

    const result = await warmup(["warmup", "--repo", work, "--branch", "carried-idea", "--carry"]);
    expect(result.err.join("\n")).toMatch(/no declaration -- build\/test verification skipped/);
    expect(result.code).toBe(0);

    // The branch was cut, cleanly, from the fetched tip.
    expect(mustGit(work, ["branch", "--show-current"])).toBe("carried-idea");

    // Both paths are back -- present on disk AND uncommitted, exactly as they
    // were before the warm-up carried them across the fetch and the checkout.
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("root\nedited locally\n");
    expect(existsSync(join(work, "scratch.md"))).toBe(true);
    expect(readFileSync(join(work, "scratch.md"), "utf8")).toBe("untracked, carried too\n");
    const status = mustGit(work, ["status", "--porcelain=v1", "-uall"]);
    expect(status).toContain("README.md");
    expect(status).toContain("scratch.md");

    // And the stash this run pushed is gone -- popped, not merely applied and
    // left behind, and nothing else is sitting in the stack either.
    expect(mustGit(work, ["stash", "list"])).toBe("");

    // The report itself named a real ref, not the raw SHA -- 'git stash pop'
    // takes a stash ref (stash@{n}), never a commit object name.
    expect(result.out.join("\n")).toMatch(/ran: {11}git stash pop stash@\{0\}/);
  });

  it("exits 1, names the SHA and 'git stash apply <sha>', when the carried stash is gone by the time the pop runs", async () => {
    // A declared build that reaches into the SAME repository and drops the
    // very stash this run just pushed -- the real-world shape of "something
    // else touched the stash while warmup was building": a script, a habit, a
    // second terminal. `git stash drop stash@{0}` is real git, run for real,
    // between the push (step 3') and the pop (step 8); it is not a scripted
    // stand-in for that race, it IS that race.
    //
    // THE DECLARATION IS COMMITTED ON ITS OWN UPSTREAM, not pushed up from a
    // clone: this run's branch is cut from `origin/main`'s tip, so the
    // contract has to be on that tip BEFORE the clone, and a real git refuses
    // a push into a non-bare remote's checked-out branch anyway (exactly the
    // trap this repository's own warmup.ts fast-forwards around instead of
    // pushing through).
    const declaredUpstream = join(root, "declared-upstream");
    mkdirSync(declaredUpstream);
    mustGit(declaredUpstream, [...PINNED, "init", "--quiet", "--initial-branch=main"]);
    pinLineEndings(declaredUpstream);
    writeFileSync(join(declaredUpstream, "README.md"), "root\n");
    mkdirSync(join(declaredUpstream, "nen"), { recursive: true });
    writeFileSync(
      join(declaredUpstream, "nen", "contract.json"),
      JSON.stringify({
        $schema: "nen.contract/v0.1",
        project: {
          lanes: { app: { stack: "generic", cwd: "." } },
          defaultLane: "app",
          verbs: {
            app: { build: { exe: "git", argv: ["stash", "drop", "stash@{0}"] } },
          },
        },
      }),
    );
    mustGit(declaredUpstream, ["add", "README.md", "nen/contract.json"]);
    mustGit(declaredUpstream, [...WHO, "commit", "--quiet", "-m", "declare a build that drops the stash"]);

    const work = join(root, "carry-dropped");
    mustGit(root, [...PINNED, "clone", "--quiet", declaredUpstream, work]);
    pinLineEndings(work);

    writeFileSync(join(work, "README.md"), "root\nedited, about to be stranded\n");
    writeFileSync(join(work, "scratch.md"), "untracked, about to be stranded\n");

    const result = await warmup(["warmup", "--repo", work, "--branch", "doomed-idea", "--carry"]);
    expect(result.code).toBe(1);

    // The branch cut still happened -- the git half is done, and nothing after
    // the failed pop is undone.
    expect(mustGit(work, ["branch", "--show-current"])).toBe("doomed-idea");

    // The stash really is gone: the declared build dropped it for real.
    expect(mustGit(work, ["stash", "list"])).toBe("");

    // The report names the SHA this run recorded right after the push, and the
    // one recovery command that still works on a raw SHA: 'stash apply'.
    const said = result.err.join("\n");
    const shaMatch = /stashed as ([0-9a-f]{40})/.exec(said) ?? /apply ([0-9a-f]{40})/.exec(said);
    expect(shaMatch).not.toBeNull();
    const sha = shaMatch?.[1] ?? "";
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(said).toContain(`git stash apply ${sha}`);
    expect(said).toMatch(/no longer in 'git stash list'|NOT dropped|nothing was popped/i);
  });
});
