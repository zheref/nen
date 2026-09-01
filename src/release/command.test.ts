import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { releaseCommand } from "./command.js";

function capture(argv: readonly string[], repoFlag: string | null, run: Seams["run"]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const args = parseArgs(argv, mergeFlags(releaseCommand.flags));
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  try {
    const code = releaseCommand.run({ args, repoFlag, json: args.booleans.has("json"), io, seams });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
}

describe("nen release preflight", () => {
  it("passes every check on a clean cut point", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "https://github.com/o/r/pull/5\n");

    const result = capture(
      ["release", "preflight", "--repo-slug", "o/r", "--tag", "v1.1.0", "--range", "v1.0.0..v1.1.0", "--changelog", changelog, "--owner-repo", "o/r"],
      dir,
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("variable get")) return { code: 1, stdout: "", stderr: "not found", spawnFailed: false };
        if (joined.includes("log ") && joined.includes("--merges")) {
          return { code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false };
        }
        if (joined.includes("ls-remote")) return { code: 0, stdout: "", stderr: "", spawnFailed: false };
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(0);
  });

  it("reports EVERY failing precondition at once", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "no refs\n");

    const result = capture(
      [
        "release",
        "preflight",
        "--repo-slug",
        "o/r",
        "--tag",
        "v1.1.0",
        "--range",
        "v1.0.0..v1.1.0",
        "--changelog",
        changelog,
        "--owner-repo",
        "o/r",
        "--critical-issues",
        "3",
      ],
      dir,
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("variable get")) return { code: 0, stdout: "true\n", stderr: "", spawnFailed: false };
        if (joined.includes("log ") && joined.includes("--merges")) {
          return { code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false };
        }
        if (joined.includes("ls-remote")) return { code: 0, stdout: "abc\trefs/tags/v1.1.0\n", stderr: "", spawnFailed: false };
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(1);
    const failing = result.out.filter((line): boolean => line.startsWith("FAIL"));
    expect(failing.length).toBeGreaterThanOrEqual(4); // hold, critical, changelog, tag
  });
});
