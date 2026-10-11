// src/shu/focused-guard.integration.test.ts -- the focused results path's
// guard against a REAL git and a REAL filesystem (zheref/nen#207, PR #393).
//
// WHY REAL. The guard before this one was proved with scripted git and missed
// four ways to delete data, each of them a fact only a real git or a real
// filesystem states: a case-sensitive pathspec on a case-insensitive disk, a
// tracked symlink ancestor ls-files stops at, untracked work and a nested
// worktree git does not list, and a submodule the superproject lists as one
// gitlink. Every case below reproduces one of the reviewer's runs and asserts
// the protected files still exist afterwards.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { shuCommand } from "./command.js";

const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];

function git(cwd: string, args: readonly string[]): string {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "protocol.file.allow=always", ...WHO, ...args], { cwd, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const HAVE_GIT = ((): boolean => {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
})();
const POSIX = process.platform !== "win32";

const made: string[] = [];
afterEach((): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A one-test JUnit document. */
const JUNIT = '<?xml version="1.0"?><testsuites tests="1"><testsuite name="s" tests="1"><testcase classname="s" name="t"/></testsuite></testsuites>';

/**
 * A committed repository whose `test` row declares a focused form that writes
 * one passing JUnit test to `results` -- the runner is this process's own
 * `node`, so no toolchain is involved.
 */
function repo(results: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nen-focused-guard-")));
  made.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(join(dir, "nen"));
  mkdirSync(join(dir, "src", "shu"), { recursive: true });
  writeFileSync(join(dir, "src", "shu", "keep.ts"), "export const kept = true;\n");
  const writer = [
    `const fs = require("fs"); const path = require("path");`,
    `const target = ${JSON.stringify(results)};`,
    `const file = target.endsWith(".xml") ? target : path.join(target, "r.xml");`,
    `fs.mkdirSync(path.dirname(file), { recursive: true });`,
    `fs.writeFileSync(file, ${JSON.stringify(JUNIT)});`,
  ].join("\n");
  const project = {
    lanes: { web: { stack: "s", cwd: "." } },
    defaultLane: "web",
    verbs: {
      web: {
        test: {
          exe: process.execPath,
          argv: ["-e", "0"],
          select: {
            exe: process.execPath,
            argv: ["-e", writer],
            each: ["{id}"],
            pattern: "[a-z]+",
            results: { path: results, format: "junit" },
          },
        },
      },
    },
  };
  writeFileSync(join(dir, "nen", "contract.json"), JSON.stringify({ $schema: "nen.contract/v0.1", project }));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function shu(dir: string, extra: readonly string[] = []): Promise<{ code: number; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(shuCommand, ["shu", "test", "--select", "a", "--heartbeat", "0", ...extra], dir, false, io, defaultSeams());
  return { code, err: err.join("\n") };
}

describe.skipIf(!HAVE_GIT)("the focused results guard, against a real git", () => {
  it("N1 -- 'SRC' is refused at load and src/ survives", async () => {
    const dir = repo("SRC");
    const result = await shu(dir);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/strictly inside '\.nen\/focused\/'/);
    expect(existsSync(join(dir, "src", "shu", "keep.ts"))).toBe(true);
  });

  it.skipIf(!POSIX)("N2 -- a tracked symlinked ancestor into src/ is refused at exit 2 and src/shu survives", async () => {
    const dir = repo(".nen/focused/out/shu");
    mkdirSync(join(dir, ".nen", "focused"), { recursive: true });
    symlinkSync(join("..", "..", "src"), join(dir, ".nen", "focused", "out"), "dir");
    git(dir, ["add", "-f", ".nen/focused/out"]);
    git(dir, ["commit", "-q", "-m", "link"]);
    const result = await shu(dir);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/symlink or junction/);
    expect(existsSync(join(dir, "src", "shu", "keep.ts"))).toBe(true);
  });

  it("N3 -- untracked work under the results path is MOVED aside, never deleted", async () => {
    const dir = repo(".nen/focused/work");
    mkdirSync(join(dir, ".nen", "focused", "work", "wip"), { recursive: true });
    writeFileSync(join(dir, ".nen", "focused", "work", "wip", "notes.txt"), "unsaved thoughts");
    const result = await shu(dir);
    expect(result.code, result.err).toBe(0);
    const runs = readdirSync(join(dir, ".nen", "focused", ".previous"));
    expect(runs).toHaveLength(1);
    expect(existsSync(join(dir, ".nen", "focused", ".previous", runs[0] as string, "work", "wip", "notes.txt"))).toBe(true);
  });

  it("N3 -- a nested worktree at the results path is refused at exit 2 and survives", async () => {
    const dir = repo(".nen/focused/wt");
    git(dir, ["worktree", "add", "-q", ".nen/focused/wt", "-b", "side"]);
    const result = await shu(dir);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/is a git entry/);
    expect(existsSync(join(dir, ".nen", "focused", "wt", "src", "shu", "keep.ts"))).toBe(true);
  });

  it("N4 -- a submodule at the results path is refused at exit 2 and its content survives", async () => {
    const lib = realpathSync(mkdtempSync(join(tmpdir(), "nen-focused-lib-")));
    made.push(lib);
    git(lib, ["init", "-q", "-b", "main"]);
    writeFileSync(join(lib, "lib.ts"), "export const lib = 1;\n");
    git(lib, ["add", "-A"]);
    git(lib, ["commit", "-q", "-m", "lib"]);
    const dir = repo(".nen/focused/sub");
    git(dir, ["submodule", "add", "-q", lib, ".nen/focused/sub"]);
    git(dir, ["commit", "-q", "-m", "submodule"]);
    const result = await shu(dir);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/is a git entry|git tracks/);
    expect(existsSync(join(dir, ".nen", "focused", "sub", "lib.ts"))).toBe(true);
  });

  it("N6 -- pathspec magic is refused at load, and is literal inside .nen/focused/", async () => {
    const magic = repo(":(exclude)x");
    expect((await shu(magic)).code).toBe(1);
    expect(existsSync(join(magic, "src", "shu", "keep.ts"))).toBe(true);
    if (!POSIX) return;
    // INSIDE THE ALLOWLIST THE SAME SPELLING IS A FILE NAME, read literally:
    // git lists nothing for it, and only that one path moves aside.
    const dir = repo(".nen/focused/:(exclude)x.xml");
    mkdirSync(join(dir, ".nen", "focused"), { recursive: true });
    writeFileSync(join(dir, ".nen", "focused", ":(exclude)x.xml"), JUNIT);
    writeFileSync(join(dir, ".nen", "focused", "neighbour.txt"), "kept");
    const result = await shu(dir);
    expect(result.code).toBe(0);
    expect(existsSync(join(dir, ".nen", "focused", "neighbour.txt"))).toBe(true);
    expect(existsSync(join(dir, "src", "shu", "keep.ts"))).toBe(true);
  });

  it.skipIf(!POSIX)("N5 -- --dry-run runs the proofs: the symlinked ancestor is exit 2 there too, nothing moved", async () => {
    const dir = repo(".nen/focused/out/shu");
    mkdirSync(join(dir, ".nen", "focused"), { recursive: true });
    symlinkSync(join("..", "..", "src"), join(dir, ".nen", "focused", "out"), "dir");
    const result = await shu(dir, ["--dry-run"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/symlink or junction/);
    expect(existsSync(join(dir, "src", "shu", "keep.ts"))).toBe(true);
    expect(existsSync(join(dir, ".nen", "focused", ".previous"))).toBe(false);
  });

  it("the happy path: results under .nen/focused/ are moved aside each run, and two runs are kept", async () => {
    const dir = repo(".nen/focused/r.xml");
    for (let run = 0; run < 4; run += 1) {
      const result = await shu(dir);
      expect(result.code, result.err).toBe(0);
    }
    expect(existsSync(join(dir, ".nen", "focused", "r.xml"))).toBe(true);
    const runs = readdirSync(join(dir, ".nen", "focused", ".previous"));
    expect(runs).toHaveLength(2);
    for (const run of runs) expect(existsSync(join(dir, ".nen", "focused", ".previous", run, "r.xml"))).toBe(true);
    expect(git(dir, ["status", "--porcelain", "--", "src", "nen"])).toBe("");
  });
});
