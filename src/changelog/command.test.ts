import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { changelogCommand } from "./command.js";

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
async function capture(argv: readonly string[], repoFlag: string | null, run: Seams["run"] = (): CommandResult => ({ code: 0, stdout: "", stderr: "", spawnFailed: false })): Promise<{
  code: number;
  out: string[];
  err: string[];
}> {
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
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  const code = await runFamily(changelogCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen changelog fragment-required", () => {
  it("is not-applicable when no spec path changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const head = join(dir, "CHANGELOG.md");
    writeFileSync(head, "### Unreleased\n_(nothing awaiting release.)_\n");
    const result = await capture(
      ["changelog", "fragment-required", "--spec-paths", "schemas/*", "--fragment-dir", "changelog.d", "--files", "src/a.ts", "--head-changelog", head],
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("not-applicable");
  });

  it("is required when a spec path changed with no fragment and no opt-out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const head = join(dir, "CHANGELOG.md");
    writeFileSync(head, "### Unreleased\n_(nothing awaiting release.)_\n");
    const result = await capture(
      ["changelog", "fragment-required", "--spec-paths", "schemas/*", "--fragment-dir", "changelog.d", "--files", "schemas/repos.json", "--head-changelog", head],
      dir,
    );
    expect(result.code).toBe(1);
    expect(result.out[0]).toBe("required");
  });
});

describe("nen changelog collate", () => {
  it("renders without writing unless --write is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "### Unreleased\n_(nothing awaiting release.)_\n\n### v1.0.0 — prior\n- **x**\n");
    const fragmentDir = join(dir, "changelog.d");
    mkdirSync(fragmentDir);
    writeFileSync(join(fragmentDir, "1-a.md"), "- **A** thing\n");
    const result = await capture(["changelog", "collate", "--version", "v1.1.0", "--theme", "theme", "--changelog", changelog, "--fragment-dir", "changelog.d"], dir);
    expect(result.code).toBe(0);
    expect(readFileSync(changelog, "utf8")).not.toContain("v1.1.0");
    expect(result.out.join("\n")).toMatch(/would collate 1 fragment/);
  });

  it("writes the collated changelog and deletes fragments when --write is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "### Unreleased\n_(nothing awaiting release.)_\n\n### v1.0.0 — prior\n- **x**\n");
    const fragmentDir = join(dir, "changelog.d");
    mkdirSync(fragmentDir);
    writeFileSync(join(fragmentDir, "1-a.md"), "- **A** thing\n");
    const result = await capture(["changelog", "collate", "--version", "v1.1.0", "--theme", "theme", "--changelog", changelog, "--fragment-dir", "changelog.d", "--write"], dir);
    expect(result.code).toBe(0);
    expect(readFileSync(changelog, "utf8")).toContain("### v1.1.0 — theme");
  });
});

describe("nen changelog completeness", () => {
  it("reports missing PRs from the merge log against the changelog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "no refs here");
    const result = await capture(
      ["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r"],
      dir,
      (): CommandResult => ({ code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false }),
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/#5/);
  });

  // zheref/nen#10 item 5. Omitting --fragment-dir used to contribute NO
  // fragment references, so an uncollated fragment's PR was reported as
  // missing an entry it demonstrably has -- while `nen release preflight`,
  // reconciling the same range against the same evidence, counted it.
  describe("--fragment-dir defaults to changelog.d, like 'nen release preflight'", () => {
    const mergedFive = (): CommandResult => ({ code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false });

    it("counts an UNCOLLATED fragment's PR as present with the flag omitted", async () => {
      const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "no refs here");
      mkdirSync(join(dir, "changelog.d"), { recursive: true });
      writeFileSync(join(dir, "changelog.d", "5-a-thing.md"), "- did a thing\n");

      const result = await capture(
        ["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r"],
        dir,
        mergedFive,
      );
      expect(result.code).toBe(0);
      expect(result.out.join("\n")).toMatch(/every PR merged in v1\.\.v2/);
    });

    it("is the SAME answer as passing the directory explicitly", async () => {
      const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "no refs here");
      mkdirSync(join(dir, "changelog.d"), { recursive: true });
      writeFileSync(join(dir, "changelog.d", "5-a-thing.md"), "- did a thing\n");

      const omitted = await capture(["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r"], dir, mergedFive);
      const explicit = await capture(["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r", "--fragment-dir", "changelog.d"], dir, mergedFive);
      expect(omitted.code).toBe(explicit.code);
      expect(omitted.out).toEqual(explicit.out);
    });

    it("treats a MISSING default directory as 'no fragments', never a crash or a refusal", async () => {
      // Matches `nen release preflight`'s own existsSync guard: a repository
      // that has collated every fragment legitimately has no changelog.d/ at
      // the cut point, and refusing there would fail a release for being tidy.
      const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "no refs here"); // no changelog.d/ anywhere

      const result = await capture(
        ["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r"],
        dir,
        mergedFive,
      );
      expect(result.code).toBe(1); // #5 really is unreferenced -- reported, not crashed
      expect(result.out.join("\n")).toMatch(/#5/);
      expect(result.err.join("\n")).not.toMatch(/ENOENT/);
    });

    it("still honours an EXPLICIT --fragment-dir elsewhere", async () => {
      const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "no refs here");
      mkdirSync(join(dir, "fragments"), { recursive: true });
      writeFileSync(join(dir, "fragments", "5-a-thing.md"), "- did a thing\n");

      const result = await capture(
        ["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r", "--fragment-dir", "fragments"],
        dir,
        mergedFive,
      );
      expect(result.code).toBe(0);
    });
  });
});
