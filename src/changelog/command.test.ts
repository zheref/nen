import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { changelogCommand } from "./command.js";

function capture(argv: readonly string[], repoFlag: string | null, run: Seams["run"] = (): CommandResult => ({ code: 0, stdout: "", stderr: "", spawnFailed: false })): {
  code: number;
  out: string[];
  err: string[];
} {
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
  const args = parseArgs(argv, mergeFlags(changelogCommand.flags));
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  try {
    const code = changelogCommand.run({ args, repoFlag, json: args.booleans.has("json"), io, seams });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
}

describe("nen changelog fragment-required", () => {
  it("is not-applicable when no spec path changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const head = join(dir, "CHANGELOG.md");
    writeFileSync(head, "### Unreleased\n_(nothing awaiting release.)_\n");
    const result = capture(
      ["changelog", "fragment-required", "--spec-paths", "schemas/*", "--fragment-dir", "changelog.d", "--files", "src/a.ts", "--head-changelog", head],
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("not-applicable");
  });

  it("is required when a spec path changed with no fragment and no opt-out", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const head = join(dir, "CHANGELOG.md");
    writeFileSync(head, "### Unreleased\n_(nothing awaiting release.)_\n");
    const result = capture(
      ["changelog", "fragment-required", "--spec-paths", "schemas/*", "--fragment-dir", "changelog.d", "--files", "schemas/repos.json", "--head-changelog", head],
      dir,
    );
    expect(result.code).toBe(1);
    expect(result.out[0]).toBe("required");
  });
});

describe("nen changelog collate", () => {
  it("renders without writing unless --write is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "### Unreleased\n_(nothing awaiting release.)_\n\n### v1.0.0 -- prior\n- **x**\n");
    const fragmentDir = join(dir, "changelog.d");
    mkdirSync(fragmentDir);
    writeFileSync(join(fragmentDir, "1-a.md"), "- **A** thing\n");
    const result = capture(["changelog", "collate", "--version", "v1.1.0", "--theme", "theme", "--changelog", changelog, "--fragment-dir", "changelog.d"], dir);
    expect(result.code).toBe(0);
    expect(readFileSync(changelog, "utf8")).not.toContain("v1.1.0");
    expect(result.out.join("\n")).toMatch(/would collate 1 fragment/);
  });

  it("writes the collated changelog and deletes fragments when --write is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "### Unreleased\n_(nothing awaiting release.)_\n\n### v1.0.0 -- prior\n- **x**\n");
    const fragmentDir = join(dir, "changelog.d");
    mkdirSync(fragmentDir);
    writeFileSync(join(fragmentDir, "1-a.md"), "- **A** thing\n");
    const result = capture(["changelog", "collate", "--version", "v1.1.0", "--theme", "theme", "--changelog", changelog, "--fragment-dir", "changelog.d", "--write"], dir);
    expect(result.code).toBe(0);
    expect(readFileSync(changelog, "utf8")).toContain("### v1.1.0 -- theme");
  });
});

describe("nen changelog completeness", () => {
  it("reports missing PRs from the merge log against the changelog", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "no refs here");
    const result = capture(
      ["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r"],
      dir,
      (): CommandResult => ({ code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false }),
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/#5/);
  });
});
