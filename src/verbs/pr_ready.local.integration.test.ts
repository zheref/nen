// Tests for ../verbs/pr_ready.ts's `readLocalCheckout` against a REAL git
// repository (zheref/nen#245). The verb's own suite stubs this seam so that no
// verdict depends on the branch the suite happens to run from; this file is the
// other half -- that the seam reads what a checkout actually has checked out,
// and answers `null` (never a throw, never a verdict) where there is nothing to
// read.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalCheckout } from "./pr_ready.js";

const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];

function mustGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${String(result.status)}: ${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

const HAVE_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!HAVE_GIT)("readLocalCheckout -- a real checkout (zheref/nen#245)", () => {
  it("reads the branch, its tip and every remote URL", () => {
    const repo = mkdtempSync(join(tmpdir(), "nen-pr-ready-local-"));
    mustGit(repo, ["init", "-q", "-b", "feature/x"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    mustGit(repo, ["add", "a.txt"]);
    mustGit(repo, [...WHO, "commit", "-q", "--no-verify", "-m", "init"]);
    mustGit(repo, ["remote", "add", "origin", "git@github.com:zheref/example.git"]);
    mustGit(repo, ["remote", "add", "upstream", "https://github.com/someone/else.git"]);
    const tip = mustGit(repo, ["rev-parse", "HEAD"]);

    const local = readLocalCheckout(repo);
    expect(local).toEqual({
      branch: "feature/x",
      sha: tip,
      remoteUrls: ["git@github.com:zheref/example.git", "https://github.com/someone/else.git"],
    });
  });

  it("a detached HEAD is not a checkout OF a branch: null", () => {
    const repo = mkdtempSync(join(tmpdir(), "nen-pr-ready-local-"));
    mustGit(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    mustGit(repo, ["add", "a.txt"]);
    mustGit(repo, [...WHO, "commit", "-q", "--no-verify", "-m", "init"]);
    mustGit(repo, ["checkout", "-q", "--detach"]);
    expect(readLocalCheckout(repo)).toBeNull();
  });

  it("a directory that is not a git checkout: null, never a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-ready-nogit-"));
    expect(readLocalCheckout(dir)).toBeNull();
  });
});
