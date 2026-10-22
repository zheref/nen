import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../seam/exec.js";
import { legacyDirs, resolveLoopHome } from "./home.js";

function answer(result: Partial<CommandResult>): { run: () => CommandResult } {
  return {
    run: (): CommandResult => ({ code: 0, stdout: "", stderr: "", spawnFailed: false, ...result }),
  };
}

describe("resolveLoopHome", () => {
  const root = mkdtempSync(join(tmpdir(), "nen-loop-home-"));

  it("homes the ledger under the git common directory", () => {
    const home = resolveLoopHome(root, answer({ stdout: "/repo/.git\n" }));
    expect(home).toEqual({ dir: join("/repo/.git", "nen", "loop"), durable: true, legacyDir: join(root, ".nen", "loop") });
  });

  it("resolves a relative common dir against --repo", () => {
    expect(resolveLoopHome(root, answer({ stdout: ".git\n" })).dir).toBe(join(root, ".git", "nen", "loop"));
  });

  it("falls back to the worktree-local home only outside a git repository", () => {
    const home = resolveLoopHome(
      root,
      answer({ code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" }),
    );
    expect(home).toEqual({ dir: join(root, ".nen", "loop"), durable: false, legacyDir: null });
  });

  it("asks git in the C locale with no inherited repository selection", () => {
    let seen: Readonly<Record<string, string | undefined>> | undefined;
    resolveLoopHome(root, {
      run: (_command, _args, options): CommandResult => {
        seen = options?.env;
        return { code: 0, stdout: "/repo/.git\n", stderr: "", spawnFailed: false };
      },
    });
    expect(seen).toMatchObject({ LC_ALL: "C" });
    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) {
      expect(seen !== undefined && key in seen && seen[key] === undefined, key).toBe(true);
    }
  });

  it("falls back for a --repo that does not exist yet, without running git", () => {
    const missing = join(root, "not-yet");
    const home = resolveLoopHome(missing, {
      run: (): never => {
        throw new Error("git must not run for a missing --repo");
      },
    });
    expect(home.durable).toBe(false);
  });

  it("refuses any other git failure rather than guessing a home", () => {
    expect(() =>
      resolveLoopHome(root, answer({ code: 128, stderr: "fatal: detected dubious ownership in repository\n" })),
    ).toThrow(/Refusing rather than falling back/);
  });

  it("refuses a git that cannot be run", () => {
    expect(() => resolveLoopHome(root, answer({ code: 1, spawnFailed: true }))).toThrow(/git could not be run/);
  });

  it("refuses an answer that is not one path", () => {
    expect(() => resolveLoopHome(root, answer({ stdout: "" }))).toThrow(/not one path/);
    expect(() => resolveLoopHome(root, answer({ stdout: "a\nb\n" }))).toThrow(/not one path/);
  });
});

describe("legacyDirs", () => {
  const root = mkdtempSync(join(tmpdir(), "nen-loop-legacy-"));
  const home = { dir: join("/repo/.git", "nen", "loop"), durable: true, legacyDir: join(root, ".nen", "loop") };

  it("lists --repo's old home first, then every other checkout's, once each", () => {
    const listing = `worktree ${root}\0HEAD abc\0branch refs/heads/main\0\0worktree /elsewhere\0HEAD def\0\0`;
    expect(legacyDirs(root, home, answer({ stdout: listing }))).toEqual([
      join(root, ".nen", "loop"),
      join("/elsewhere", ".nen", "loop"),
    ]);
  });

  it("has nothing to look for in the fallback", () => {
    expect(legacyDirs(root, { ...home, durable: false, legacyDir: null }, answer({ code: 1 }))).toEqual([]);
  });

  it("refuses a worktree list git cannot produce", () => {
    expect(() => legacyDirs(root, home, answer({ code: 128, stderr: "fatal" }))).toThrow(/git worktree list failed/);
  });
});
