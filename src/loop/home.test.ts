import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../seam/exec.js";
import { resolveLoopHome } from "./home.js";

function answer(result: Partial<CommandResult>): { run: () => CommandResult } {
  return {
    run: (): CommandResult => ({ code: 0, stdout: "", stderr: "", spawnFailed: false, ...result }),
  };
}

describe("resolveLoopHome", () => {
  const root = mkdtempSync(join(tmpdir(), "nen-loop-home-"));

  it("homes the ledger under the git common directory", () => {
    const home = resolveLoopHome(root, answer({ stdout: "/repo/.git\n" }));
    expect(home).toEqual({ dir: "/repo/.git/nen/loop", durable: true, legacyDir: join(root, ".nen", "loop") });
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
