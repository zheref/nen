import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { releaseCommand } from "./command.js";

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
async function capture(argv: readonly string[], repoFlag: string | null, run: Seams["run"]): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const code = await runFamily(releaseCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen release preflight", () => {
  it("passes every check on a clean cut point", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "https://github.com/o/r/pull/5\n");
    const liveChoresFrom = join(dir, "live-chores.json");
    writeFileSync(liveChoresFrom, "[]");

    const result = await capture(
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
        // Explicitly asserted, not omitted (review finding): omitting either
        // of these must fail the corresponding row rather than reading as
        // "none".
        "--critical-issues",
        "",
        "--live-chores-from",
        liveChoresFrom,
      ],
      dir,
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("variable get")) return { code: 1, stdout: "", stderr: "variable RELEASE_HOLD was not found", spawnFailed: false };
        if (joined.includes("log ") && joined.includes("--merges")) {
          return { code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false };
        }
        if (joined.includes("ls-remote")) return { code: 0, stdout: "", stderr: "", spawnFailed: false };
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(0);
  });

  it("reports EVERY failing precondition at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "no refs\n");

    const result = await capture(
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

  describe("RELEASE_HOLD fails CLOSED rather than reading 'not set' (review finding)", () => {
    async function runWithHold(holdResult: CommandResult): Promise<{ code: number; out: string[] }> {
      const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "https://github.com/o/r/pull/5\n");
      const liveChoresFrom = join(dir, "live-chores.json");
      writeFileSync(liveChoresFrom, "[]");
      return await capture(
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
          "",
          "--live-chores-from",
          liveChoresFrom,
        ],
        dir,
        (command, args): CommandResult => {
          const joined = args.join(" ");
          if (joined.includes("variable get")) return holdResult;
          if (joined.includes("log ") && joined.includes("--merges")) {
            return { code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false };
          }
          if (joined.includes("ls-remote")) return { code: 0, stdout: "", stderr: "", spawnFailed: false };
          return { code: 0, stdout: "", stderr: "", spawnFailed: false };
        },
      );
    }

    it("a gh that could not be started fails the table (was: 'not set')", async () => {
      const result = await runWithHold({ code: -1, stdout: "", stderr: "spawn gh ENOENT", spawnFailed: true });
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/FAIL {2}RELEASE_HOLD -- could not be read/);
    });

    it("an unauthenticated gh (non-zero, not a 'not found') fails the table (was: 'not set')", async () => {
      const result = await runWithHold({ code: 1, stdout: "", stderr: "gh: To use GitHub CLI, please run `gh auth login`", spawnFailed: false });
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/FAIL {2}RELEASE_HOLD -- could not be read/);
    });

    it("a genuine 'variable not found' still reads as 'not set' and passes", async () => {
      const result = await runWithHold({ code: 1, stdout: "", stderr: "variable RELEASE_HOLD not found", spawnFailed: false });
      expect(result.out.join("\n")).toMatch(/ok\s+RELEASE_HOLD -- not set/);
    });

    it("gh's real 'was not found' phrasing also reads as 'not set' and passes", async () => {
      const result = await runWithHold({ code: 1, stdout: "", stderr: "variable RELEASE_HOLD was not found", spawnFailed: false });
      expect(result.out.join("\n")).toMatch(/ok\s+RELEASE_HOLD -- not set/);
    });

    it("an unrelated 'HTTP 404: Not Found' fails the table rather than reading 'not set' (review finding)", async () => {
      const result = await runWithHold({
        code: 1,
        stdout: "",
        stderr: "failed to get variable RELEASE_HOLD: HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/variables/RELEASE_HOLD)",
        spawnFailed: false,
      });
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/FAIL {2}RELEASE_HOLD -- could not be read/);
    });

    it("a repo-not-found style message fails the table rather than reading 'not set' (review finding)", async () => {
      const result = await runWithHold({ code: 1, stdout: "", stderr: "GraphQL: Could not resolve to a Repository (repository)", spawnFailed: false });
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/FAIL {2}RELEASE_HOLD -- could not be read/);
    });

    it("an error whose message merely CONTAINS the substring 'not found' still fails the table", async () => {
      // The exact defect shape a substring sniff of "not found" anywhere in
      // stderr would misclassify: this literally contains "not found" but is
      // neither gh's `variable <name> not found` shape nor its `variable
      // <name> was not found` shape.
      const result = await runWithHold({
        code: 1,
        stdout: "",
        stderr: "endpoint not found: /repos/o/r/actions/variables/RELEASE_HOLD",
        spawnFailed: false,
      });
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/FAIL {2}RELEASE_HOLD -- could not be read/);
    });

    it("a set RELEASE_HOLD still fails the table", async () => {
      const result = await runWithHold({ code: 0, stdout: "waiting on legal\n", stderr: "", spawnFailed: false });
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/FAIL {2}RELEASE_HOLD -- HELD/);
    });
  });

  it("omitting --critical-issues and --live-chores-from fails the table rather than reading 'none' (review finding)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "https://github.com/o/r/pull/5\n");

    const result = await capture(
      ["release", "preflight", "--repo-slug", "o/r", "--tag", "v1.1.0", "--range", "v1.0.0..v1.1.0", "--changelog", changelog, "--owner-repo", "o/r"],
      dir,
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("variable get")) return { code: 1, stdout: "", stderr: "variable RELEASE_HOLD not found", spawnFailed: false };
        if (joined.includes("log ") && joined.includes("--merges")) {
          return { code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false };
        }
        if (joined.includes("ls-remote")) return { code: 0, stdout: "", stderr: "", spawnFailed: false };
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/FAIL {2}open critical issues -- not supplied/);
    expect(result.out.join("\n")).toMatch(/FAIL {2}CON-36 live chores -- not supplied/);
  });

  describe("--critical-issues refuses non-numeric entries as a usage error (review finding)", () => {
    async function runWithCriticalIssues(value: string): Promise<{ code: number; out: string[]; err: string[] }> {
      const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "https://github.com/o/r/pull/5\n");
      const liveChoresFrom = join(dir, "live-chores.json");
      writeFileSync(liveChoresFrom, "[]");
      return await capture(
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
          value,
          "--live-chores-from",
          liveChoresFrom,
        ],
        dir,
        (command, args): CommandResult => {
          const joined = args.join(" ");
          if (joined.includes("variable get")) return { code: 1, stdout: "", stderr: "variable RELEASE_HOLD was not found", spawnFailed: false };
          if (joined.includes("log ") && joined.includes("--merges")) {
            return { code: 0, stdout: "Merge pull request #5 from x/y\n", stderr: "", spawnFailed: false };
          }
          if (joined.includes("ls-remote")) return { code: 0, stdout: "", stderr: "", spawnFailed: false };
          return { code: 0, stdout: "", stderr: "", spawnFailed: false };
        },
      );
    }

    it("a non-numeric entry is refused as a usage error (exit 2), never becomes NaN in the report", async () => {
      const result = await runWithCriticalIssues("3,not-a-number,7");
      expect(result.code).toBe(2);
      expect(result.out.join("\n")).not.toMatch(/NaN/);
      expect(result.err.join("\n")).toMatch(/--critical-issues takes a comma-separated list of non-negative whole numbers/);
      expect(result.err.join("\n")).toMatch(/'not-a-number'/);
    });

    it("every non-numeric entry is named, not just the first", async () => {
      const result = await runWithCriticalIssues("abc,4,xyz");
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/'abc'/);
      expect(result.err.join("\n")).toMatch(/'xyz'/);
    });

    it("all-numeric entries still pass through cleanly", async () => {
      const result = await runWithCriticalIssues("3,7");
      expect(result.code).toBe(1); // fails the "open critical issues" row itself, not a usage error
      expect(result.out.join("\n")).toMatch(/FAIL {2}open critical issues -- 2 open: #3, #7/);
    });
  });
});
