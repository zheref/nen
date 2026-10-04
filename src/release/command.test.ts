import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { defaultSeams, spawnRunner, type CommandResult, type Seams } from "../seam/exec.js";
import { changelogCommand } from "../changelog/command.js";
import { releaseCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

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
  const seams: Seams = {
    run,
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("this verb has no watched form");
    },
    platform: "linux",
  };
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
    async function runWithHold(holdResult: CommandResult, extraArgs: readonly string[] = []): Promise<{ code: number; out: string[] }> {
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
          ...extraArgs,
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

    // zheref/nen#23: the value is PARSED for truthiness, never merely
    // length-checked. The `value === ""` check this replaces read a variable
    // set to the literal string "false" as the same HELD verdict as "true" --
    // one regression test per value class, per the issue.
    describe("the value is parsed for truthiness (zheref/nen#23)", () => {
      it("'true', 'TRUE', '1' and 'yes' each read as an active hold", async () => {
        for (const value of ["true", "TRUE", "1", "yes"]) {
          const result = await runWithHold({ code: 0, stdout: `${value}\n`, stderr: "", spawnFailed: false });
          expect(result.code).toBe(1);
          // Anchored to the WHOLE row line (review finding): the fail-closed
          // rendering for an unrecognized value starts with this exact text
          // as its prefix, so a bare toContain() would still pass if
          // true/1/yes regressed into the fail-closed path. The recognized
          // vocabulary must produce the plain HELD row and nothing more.
          expect(result.out.join("\n")).toMatch(new RegExp(`^FAIL {2}RELEASE_HOLD -- HELD: RELEASE_HOLD = '${value}'$`, "m"));
        }
      });

      it("'false', 'FALSE', '0' and 'no' each read as NOT held and pass the table (was: HELD)", async () => {
        for (const value of ["false", "FALSE", "0", "no"]) {
          const result = await runWithHold({ code: 0, stdout: `${value}\n`, stderr: "", spawnFailed: false });
          expect(result.code).toBe(0);
          const joined = result.out.join("\n");
          // Passing, but distinguishable from a genuinely absent variable:
          // the row names the lingering value so the operator can tidy it.
          expect(joined).toMatch(/ok\s+RELEASE_HOLD -- not held/);
          expect(joined).toContain(`'${value}'`);
        }
      });

      it("a whitespace-only value still reads as the genuine 'not set'", async () => {
        const result = await runWithHold({ code: 0, stdout: "\n", stderr: "", spawnFailed: false });
        expect(result.code).toBe(0);
        expect(result.out.join("\n")).toMatch(/ok\s+RELEASE_HOLD -- not set/);
      });

      it("an arbitrary hold message fails CLOSED as held, printing the raw value and why", async () => {
        // The deliberate deviation from the shell hold_active() convention:
        // 'freeze until Monday' is not a recognized boolean, and the one row
        // whose job is to stop a release must not fail open on a spelling.
        const result = await runWithHold({ code: 0, stdout: "freeze until Monday\n", stderr: "", spawnFailed: false });
        expect(result.code).toBe(1);
        const joined = result.out.join("\n");
        expect(joined).toMatch(/FAIL {2}RELEASE_HOLD -- HELD/);
        expect(joined).toContain("'freeze until Monday'");
        expect(joined).toContain("fails closed");
      });
    });

    // Review finding on the zheref/nen#23 fix: the hold row's name and
    // details hard-coded RELEASE_HOLD, so a `--hold-var FREEZE` run blamed a
    // variable it never queried. The row must cite the variable the run
    // actually read -- and only that one.
    describe("--hold-var's name is the one the row prints (review finding)", () => {
      it("a held custom variable renders under ITS name, with RELEASE_HOLD nowhere in the table", async () => {
        const result = await runWithHold({ code: 0, stdout: "true\n", stderr: "", spawnFailed: false }, ["--hold-var", "FREEZE"]);
        expect(result.code).toBe(1);
        const joined = result.out.join("\n");
        expect(joined).toMatch(/^FAIL {2}FREEZE -- HELD: FREEZE = 'true'$/m);
        expect(joined).not.toContain("RELEASE_HOLD");
      });

      it("a clear custom variable names itself as the lingering one -- the occurrence this fix added", async () => {
        const result = await runWithHold({ code: 0, stdout: "no\n", stderr: "", spawnFailed: false }, ["--hold-var", "FREEZE"]);
        expect(result.code).toBe(0);
        const joined = result.out.join("\n");
        expect(joined).toMatch(/ok\s+FREEZE -- not held: FREEZE = 'no'/);
        expect(joined).not.toContain("RELEASE_HOLD");
      });
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

  // zheref/nen#10 item 5. `--fragment-dir` is now DEFAULTED from ONE shared
  // constant (../changelog/completeness.ts's DEFAULT_FRAGMENT_DIR) and read
  // through ONE shared seam (../cli/inputs.ts's optionalDirectoryFlag), so
  // this verb and `nen changelog completeness` cannot drift about where
  // fragments live. Covered on THIS side too, deliberately: the sibling
  // verb's tests alone left renaming the constant green here.
  describe("--fragment-dir: the SAME default and the SAME refusals as 'nen changelog completeness'", () => {
    async function runWithFragmentDir(
      prepare: (dir: string) => void,
      extraArgs: readonly string[] = [],
    ): Promise<{ code: number; out: string[]; err: string[] }> {
      const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "no refs here\n"); // the CHANGELOG references NOTHING
      const liveChoresFrom = join(dir, "live-chores.json");
      writeFileSync(liveChoresFrom, "[]");
      prepare(dir);
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
          ...extraArgs,
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

    it("counts an UNCOLLATED fragment's PR as present with the flag OMITTED", async () => {
      // The mirror of ../changelog/command.test.ts's own default test: #5 is
      // referenced NOWHERE in the CHANGELOG, and the only thing that can make
      // CON-33(c) reconcile is the changelog.d/ fragment found by default.
      const result = await runWithFragmentDir((dir): void => {
        mkdirSync(join(dir, "changelog.d"), { recursive: true });
        writeFileSync(join(dir, "changelog.d", "5-a-thing.md"), "- did a thing\n");
      });
      expect(result.out.join("\n")).toMatch(/ok\s+CON-33\(c\) reconciled -- every merged PR has a CHANGELOG entry or fragment/);
      // The fragment is also SEEN by the "changelog.d/ empty" row, which is
      // the second reader of the same default: it fails, by name.
      expect(result.out.join("\n")).toMatch(/FAIL {2}changelog\.d\/ empty at cut point -- 1 fragment\(s\) uncollated: 5-a-thing\.md/);
    });

    it("is the SAME answer as passing the default directory explicitly", async () => {
      const prepare = (dir: string): void => {
        mkdirSync(join(dir, "changelog.d"), { recursive: true });
        writeFileSync(join(dir, "changelog.d", "5-a-thing.md"), "- did a thing\n");
      };
      const omitted = await runWithFragmentDir(prepare);
      const explicit = await runWithFragmentDir(prepare, ["--fragment-dir", "changelog.d"]);
      expect(omitted.code).toBe(explicit.code);
      expect(omitted.out).toEqual(explicit.out);
    });

    it("treats a MISSING default directory as 'no fragments', never a crash", async () => {
      const result = await runWithFragmentDir((): void => {}); // no changelog.d/ anywhere
      expect(result.code).toBe(1); // #5 really is unreferenced -- reported, not crashed
      expect(result.out.join("\n")).toMatch(/FAIL {2}CON-33\(c\) reconciled -- missing: #5/);
      expect(result.out.join("\n")).toMatch(/ok\s+changelog\.d\/ empty at cut point -- empty/);
      expect(result.err.join("\n")).not.toMatch(/ENOENT/);
    });

    it("refuses an EXPLICITLY EMPTY --fragment-dir at exit 2 rather than reading the repository root", async () => {
      // `?? DEFAULT_FRAGMENT_DIR` does not catch `""`, so this used to resolve
      // to the repo root and count every top-level *.md as a fragment.
      const result = await runWithFragmentDir((dir): void => {
        writeFileSync(join(dir, "5-stray.md"), "not a fragment\n");
      }, ["--fragment-dir", ""]);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--fragment-dir was given an empty value/);
      expect(result.err.join("\n")).toMatch(/Omit the flag to use the default/);
    });

    it("refuses a --fragment-dir that is a FILE at exit 2, naming the path", async () => {
      // Was a raw ENOTDIR out of readdirSync at exit 1, several frames from
      // the flag that caused it.
      const result = await runWithFragmentDir((dir): void => {
        writeFileSync(join(dir, "notadir"), "x\n");
      }, ["--fragment-dir", "notadir"]);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--fragment-dir points at .*notadir', which is not a directory/);
      expect(result.err.join("\n")).not.toMatch(/ENOTDIR/);
    });

    it("refuses an UNREADABLE --fragment-dir at exit 2, naming the errno, rather than reporting 'no fragments' (PR #83 review)", async () => {
      // Mirrors ../changelog/command.test.ts's own case for the same shared
      // seam (../cli/inputs.ts's optionalDirectoryFlag): an EACCES from a
      // locked PARENT directory must not be folded into the same null return
      // as an absent directory -- a caller told "no fragments" in that case
      // would never learn the check did not run at all. chmod is skipped
      // where the bit is not enforced (root, or a filesystem that ignores it)
      // rather than asserted into a platform-dependent failure -- see
      // ../verbs/pr_ready.test.ts (zheref/nen#8) for the same guard on a
      // file-level EACCES.
      let blocked = true;
      let locked = "";
      const result = await runWithFragmentDir((dir): void => {
        locked = join(dir, "locked");
        const fragmentDir = join(locked, "changelog.d");
        mkdirSync(fragmentDir, { recursive: true });
        chmodSync(locked, 0o000);
        try {
          statSync(fragmentDir);
          blocked = false; // permission bit not enforced on this host -- skip below
        } catch {
          // still blocked, as expected
        }
      }, ["--fragment-dir", join("locked", "changelog.d")]);

      if (blocked) {
        expect(result.code).toBe(2);
        expect(result.err.join("\n")).toMatch(/--fragment-dir points at .*changelog\.d', which could not be checked/);
        expect(result.err.join("\n")).toMatch(/EACCES/);
      }

      if (locked !== "") chmodSync(locked, 0o700); // restore so the temp-dir cleanup can traverse it
    });
  });
});

// --- verbs/4-remainders: resolve-target and self-check, merged into this
// same "release" family alongside main's "preflight" (zheref/nen#3). ---

describe("nen release resolve-target -- CLI wiring", () => {
  it("exits 0 for an ancestor, 1 for a non-ancestor", async () => {
    const script: readonly ScriptedCall[] = [
      { match: "git fetch origin main", result: {} },
      { match: "git rev-parse origin/main", result: { stdout: "sha1\n" } },
      { match: "git merge-base --is-ancestor sha1 origin/main", result: { code: 0 } },
    ];
    const result = await capture(["release", "resolve-target", "--token", "main"], BANKAI_REPO, new ScriptedSeams(script).run);
    expect(result.code).toBe(0);
  });

  it("requires --token", async () => {
    const result = await capture(["release", "resolve-target"], BANKAI_REPO, new ScriptedSeams([]).run);
    expect(result.code).toBe(2);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- resolving a release target in whatever repository the
  // process is standing in answers the ancestor check against the wrong trunk.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["release", "resolve-target", "--token", "main"], null, new ScriptedSeams([]).run);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });
});

describe("nen release self-check -- CLI wiring", () => {
  it("reports shouldListItself and always exits 0 -- a report, not a guard", async () => {
    const script: readonly ScriptedCall[] = [
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 0 } },
      { match: "git merge-base --is-ancestor pr-sha v1.0.0", result: { code: 1 } },
    ];
    const result = await capture(
      ["release", "self-check", "--pr-merge-sha", "pr-sha", "--previous-tag", "v1.0.0", "--cut-point", "cut-point"],
      BANKAI_REPO,
      new ScriptedSeams(script).run,
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/should list ITSELF/);
  });

  it("requires all three flags", async () => {
    const result = await capture(["release", "self-check"], BANKAI_REPO, new ScriptedSeams([]).run);
    expect(result.code).toBe(2);
  });

  // zheref/nen#28: same unbracketed promise as resolve-target's usage line.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(
      ["release", "self-check", "--pr-merge-sha", "pr-sha", "--previous-tag", "v1.0.0", "--cut-point", "cut-point"],
      null,
      new ScriptedSeams([]).run,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });
});

describe("nen release unit-check -- CLI wiring", () => {
  function workflowRepo(unitPaths: readonly unknown[] | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-unit-check-"));
    mkdirSync(join(dir, "nen"), { recursive: true });
    const body = unitPaths === undefined ? {} : { release: { unitPaths } };
    writeFileSync(join(dir, "nen", "workflow.json"), JSON.stringify(body));
    return dir;
  }

  it("exits 2 and names the key when release.unitPaths is not declared", async () => {
    const result = await capture(
      ["release", "unit-check", "--pr", "acme/widgets#9"],
      BANKAI_REPO,
      new ScriptedSeams([]).run,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/declares no 'release\.unitPaths'/);
  });

  it("exits 0 when every changed path is inside the declared unit", async () => {
    const root = workflowRepo(["src/unit/**"]);
    const script: readonly ScriptedCall[] = [
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/unit/a.ts" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 1 }) },
      },
    ];
    const result = await capture(["release", "unit-check", "--pr", "acme/widgets#9"], root, new ScriptedSeams(script).run);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/every changed path is inside the release unit/);
  });

  it("exits 1 and lists every path outside the declared unit", async () => {
    const root = workflowRepo(["src/unit/**"]);
    const script: readonly ScriptedCall[] = [
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/unit/a.ts" }, { filename: "src/other/b.ts" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 2 }) },
      },
    ];
    const result = await capture(["release", "unit-check", "--pr", "acme/widgets#9"], root, new ScriptedSeams(script).run);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/outside: "src\/other\/b\.ts"/);
  });

  it("resolves a bare --pr number against this checkout's own origin", async () => {
    const root = workflowRepo(["src/unit/**"]);
    const script: readonly ScriptedCall[] = [
      { match: "git remote get-url origin", result: { code: 0, stdout: "git@github.com:acme/widgets.git\n" } },
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/unit/a.ts" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 1 }) },
      },
    ];
    const result = await capture(["release", "unit-check", "--pr", "9"], root, new ScriptedSeams(script).run);
    expect(result.code).toBe(0);
  });

  // N3: scripted CLI tests for a content-scoped (object) unitPaths entry.
  describe("a content-scoped {path, keys} entry", () => {
    const MERGE_BASE = "mergebasesha";
    function contractContentsCall(json: unknown, ref: string): ScriptedCall {
      return {
        match: `gh api repos/acme/widgets/contents/nen/contract.json?ref=${ref}`,
        result: { code: 0, stdout: JSON.stringify({ content: Buffer.from(JSON.stringify(json)).toString("base64") }) },
      };
    }
    function prRefsCall(): ScriptedCall {
      return {
        match: "gh pr view 9 --repo acme/widgets --json baseRefOid,headRefOid",
        result: { code: 0, stdout: JSON.stringify({ baseRefOid: "BASE", headRefOid: "HEAD" }) },
      };
    }
    function compareCall(): ScriptedCall {
      return {
        match: "gh api repos/acme/widgets/compare/BASE...HEAD",
        result: { code: 0, stdout: JSON.stringify({ merge_base_commit: { sha: MERGE_BASE } }) },
      };
    }
    function filesScript(files: readonly { filename: string }[]): readonly ScriptedCall[] {
      return [
        { match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files", result: { code: 0, stdout: JSON.stringify(files) } },
        { match: "gh api repos/acme/widgets/pulls/9", result: { code: 0, stdout: JSON.stringify({ changed_files: files.length }) } },
      ];
    }

    it("exits 0 when the changed file only touches its declared key", async () => {
      const root = workflowRepo([{ path: "nen/contract.json", keys: ["version"] }]);
      const script: readonly ScriptedCall[] = [
        ...filesScript([{ filename: "nen/contract.json" }]),
        prRefsCall(),
        compareCall(),
        contractContentsCall({ version: "1.0.0" }, MERGE_BASE),
        contractContentsCall({ version: "1.0.1" }, "HEAD"),
      ];
      const result = await capture(["release", "unit-check", "--pr", "acme/widgets#9"], root, new ScriptedSeams(script).run);
      expect(result.code).toBe(0);
      expect(result.out.join("\n")).toMatch(/every changed path is inside the release unit/);
    });

    it("exits 1 with the 'outside (content-scoped)' line and keyScopedViolations in --json when an undeclared key changes", async () => {
      const root = workflowRepo([{ path: "nen/contract.json", keys: ["version"] }]);
      const script: readonly ScriptedCall[] = [
        ...filesScript([{ filename: "nen/contract.json" }]),
        prRefsCall(),
        compareCall(),
        contractContentsCall({ version: "1.0.0", description: "old" }, MERGE_BASE),
        contractContentsCall({ version: "1.0.1", description: "new" }, "HEAD"),
      ];
      const result = await capture(["release", "unit-check", "--pr", "acme/widgets#9"], root, new ScriptedSeams(script).run);
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/outside \(content-scoped\): "nen\/contract\.json" changed at "description"/);

      const jsonResult = await capture(
        ["release", "unit-check", "--pr", "acme/widgets#9", "--json"],
        root,
        new ScriptedSeams(script).run,
      );
      const report = JSON.parse(jsonResult.out.join("\n")) as { readonly keyScopedViolations: readonly { readonly path: string; readonly offendingKeys: readonly string[] }[] };
      expect(report.keyScopedViolations).toEqual([{ path: "nen/contract.json", ok: false, offendingKeys: ["description"] }]);
    });

    it("exits 1 and names the failure when 'gh pr view' (the base/head refs fetch) fails", async () => {
      const root = workflowRepo([{ path: "nen/contract.json", keys: ["version"] }]);
      const script: readonly ScriptedCall[] = [
        ...filesScript([{ filename: "nen/contract.json" }]),
        { match: "gh pr view 9 --repo acme/widgets --json baseRefOid,headRefOid", result: { code: 1, stdout: "", stderr: "not found" } },
      ];
      const result = await capture(["release", "unit-check", "--pr", "acme/widgets#9"], root, new ScriptedSeams(script).run);
      expect(result.code).not.toBe(0);
    });

    it("exits 1 naming the merge-base failure when the compare endpoint fails (N6)", async () => {
      const root = workflowRepo([{ path: "nen/contract.json", keys: ["version"] }]);
      const script: readonly ScriptedCall[] = [
        ...filesScript([{ filename: "nen/contract.json" }]),
        prRefsCall(),
        { match: "gh api repos/acme/widgets/compare/BASE...HEAD", result: { code: 1, stdout: "", stderr: "not found" } },
      ];
      const result = await capture(["release", "unit-check", "--pr", "acme/widgets#9"], root, new ScriptedSeams(script).run);
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).toMatch(/could not resolve the merge base/);
    });
  });

  it("refuses an omitted --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["release", "unit-check", "--pr", "acme/widgets#9"], null, new ScriptedSeams([]).run);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("refuses a bad --pr reference at exit 2", async () => {
    const root = workflowRepo(["src/unit/**"]);
    const result = await capture(["release", "unit-check", "--pr", "not-a-ref"], root, new ScriptedSeams([]).run);
    expect(result.code).toBe(2);
  });

  // zheref/nen#269: 'pr merge' shares this verb's ref grammar, so --pr gains
  // <CODE>#<n> too -- resolved through --repo's own nen/repos.json by 'pr
  // ready's own lookup. This verb only READS, so a code naming a repository
  // other than --repo's origin is allowed, exactly as an explicit
  // owner/name#n always was: no origin read is scripted below, and none runs.
  describe("--pr <CODE>#<n> (zheref/nen#269)", () => {
    function codedWorkflowRepo(): string {
      const root = workflowRepo(["src/unit/**"]);
      writeFileSync(
        join(root, "nen", "repos.json"),
        JSON.stringify({ consumers: [{ repo: "acme/widgets", consumes: [], code: "AW" }] }),
      );
      return root;
    }

    it("resolves the code through --repo's registry and checks that repository's pull request", async () => {
      const script: readonly ScriptedCall[] = [
        {
          match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
          result: { code: 0, stdout: JSON.stringify([{ filename: "src/unit/a.ts" }]) },
        },
        { match: "gh api repos/acme/widgets/pulls/9", result: { code: 0, stdout: JSON.stringify({ changed_files: 1 }) } },
      ];
      const result = await capture(
        ["release", "unit-check", "--pr", "AW#9", "--json"],
        codedWorkflowRepo(),
        new ScriptedSeams(script).run,
      );
      expect(result.code).toBe(0);
      const report = JSON.parse(result.out.join("\n")) as { target: string; pr: number; ok: boolean };
      expect(report).toMatchObject({ target: "acme/widgets", pr: 9, ok: true });
    });

    it("refuses an unknown code at exit 2, naming the known codes", async () => {
      const result = await capture(["release", "unit-check", "--pr", "ZZ#9"], codedWorkflowRepo(), new ScriptedSeams([]).run);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/'ZZ' is not a product code .*Known codes: AW/);
    });

    // Feitan (E3 review): this verb allows a code naming another repository,
    // so a lookup that silently picked one of two case-variant keys -- or
    // folded a KELVIN SIGN key onto 'K' -- read the WRONG repository's pull
    // request. Both are refused at exit 2 before any gh call.
    it("refuses (exit 2, no gh call) a code that matches two keys differing only by case, naming both repositories", async () => {
      const root = workflowRepo(["src/unit/**"]);
      writeFileSync(
        join(root, "nen", "repos.json"),
        JSON.stringify({
          consumers: [
            { repo: "acme/widgets", consumes: [], code: "AW" },
            { repo: "evil/widgets", consumes: [], code: "aw" },
          ],
        }),
      );
      const seams = new ScriptedSeams([]);
      const result = await capture(["release", "unit-check", "--pr", "Aw#9"], root, seams.run);
      expect(result.code).toBe(2);
      const err = result.err.join("\n");
      expect(err).toMatch(/'Aw' matches 2 differently-spelled product codes/);
      expect(err).toContain("'AW' -> 'acme/widgets'");
      expect(err).toContain("'aw' -> 'evil/widgets'");
      expect(seams.calls).toEqual([]);
    });

    it("refuses (exit 2, no gh call) 'K#9' when the only matching key is a KELVIN SIGN", async () => {
      const root = workflowRepo(["src/unit/**"]);
      writeFileSync(join(root, "nen", "repos.json"), JSON.stringify({ consumers: [{ repo: "evil/kelvin", consumes: [], code: "\u212A" }] }));
      const seams = new ScriptedSeams([]);
      const result = await capture(["release", "unit-check", "--pr", "K#9"], root, seams.run);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/'K' is not a product code/);
      expect(seams.calls).toEqual([]);
    });

    it("refuses a code at exit 2 when --repo carries no registry, naming the file", async () => {
      const root = workflowRepo(["src/unit/**"]);
      const result = await capture(["release", "unit-check", "--pr", "AW#9"], root, new ScriptedSeams([]).run);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/resolved through --repo's own registry, and it could not be read/);
    });

    it("--help names the CODE#n form, the shared lookup, and that the '#' is required", async () => {
      const result = await capture(["release", "--help"], null, new ScriptedSeams([]).run);
      const help = result.out.join("\n");
      expect(help).toMatch(/nen release unit-check --pr <n\|owner\/name#n\|CODE#n> --repo <path>/);
      expect(help).toMatch(/SAME lookup 'pr ready\s+<CODE>#<N>' uses/);
      expect(help).toMatch(/The '#' is required/);
    });
  });
});

describe("nen release -- refuses an unknown subcommand", () => {
  it("exits 2", async () => {
    const result = await capture(["release", "bogus"], BANKAI_REPO, new ScriptedSeams([]).run);
    expect(result.code).toBe(2);
  });
});

// zheref/nen#229. `nen release preflight` and `nen changelog completeness`
// share ONE reconciliation (../changelog/reconcile.ts), release-PR allowance
// included, so for the same range they must reach the same verdict. Proven
// on a REAL merge graph: `git log`/`ls-tree`/`cat-file` run for real, and only
// the two calls that would reach GitHub or a remote (`gh variable get`, `git
// ls-remote`) are answered by the fixture. The allowance's own shapes are
// covered in ../changelog/reconcile.test.ts and its integration twin.
describe("nen release preflight -- the SAME CON-33(c) verdict as 'nen changelog completeness' (zheref/nen#229)", () => {
  const usable = ((): boolean => {
    const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
    const version = /(\d+)\.(\d+)/.exec(probe.stdout ?? "");
    return probe.status === 0 && version !== null && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 28));
  })();

  function mustGit(cwd: string, args: readonly string[]): void {
    const result = spawnSync("git", [...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  }

  const LINK = (n: number): string => `[#${n}](https://github.com/o/r/pull/${n})`;

  /** v1.0.0 tagged; #221 delivered; the release PR #222 introduces v1.1.0 citing `cites`, and ends the range. */
  function releaseRepo(cites: readonly number[], stray: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "nen-release-parity-"));
    mustGit(root, ["init", "-q", "-b", "main"]);
    for (const [key, value] of [["user.name", "nen test"], ["user.email", "nen@example.invalid"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"], ["core.autocrlf", "false"]] as const) {
      mustGit(root, ["config", key, value]);
    }
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## v1.0.0 — 2026-09-01\n");
    mustGit(root, ["add", "CHANGELOG.md"]);
    mustGit(root, ["commit", "-q", "-m", "chore(release): v1.0.0"]);
    mustGit(root, ["tag", "-a", "-m", "v1.0.0", "v1.0.0"]);
    for (const [branch, pr] of [...(stray ? [["stray", 220] as const] : []), ["feature", 221] as const]) {
      mustGit(root, ["checkout", "-q", "-b", branch, "main"]);
      writeFileSync(join(root, `${branch}.txt`), `${branch}\n`);
      mustGit(root, ["add", `${branch}.txt`]);
      mustGit(root, ["commit", "-q", "-m", `feat: ${branch}`]);
      mustGit(root, ["checkout", "-q", "main"]);
      mustGit(root, ["merge", "-q", "--no-ff", "-m", `Merge pull request #${pr} from o/${branch}`, branch]);
    }
    mustGit(root, ["checkout", "-q", "-b", "release", "main"]);
    writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## v1.1.0 — 2026-09-20\n\nRelease unit: ${cites.map(LINK).join(", ")}.\n\n## v1.0.0 — 2026-09-01\n`);
    mustGit(root, ["add", "CHANGELOG.md"]);
    mustGit(root, ["commit", "-q", "-m", "chore(release): v1.1.0"]);
    mustGit(root, ["checkout", "-q", "main"]);
    mustGit(root, ["merge", "-q", "--no-ff", "-m", "Merge pull request #222 from o/release", "release"]);
    writeFileSync(join(root, "live-chores.json"), "[]");
    return root;
  }

  /** Real git for history; the fixture answers only what would leave the machine. */
  const localOnly: Seams["run"] = (command, args, options): CommandResult => {
    if (command === "gh") return { code: 1, stdout: "", stderr: "variable RELEASE_HOLD was not found", spawnFailed: false };
    if (args[0] === "ls-remote") return { code: 0, stdout: "", stderr: "", spawnFailed: false };
    return spawnRunner(command, args, options);
  };

  async function both(root: string): Promise<{ preflight: { code: number; out: string[] }; completeness: { code: number; out: string[] } }> {
    const preflight = await capture(
      ["release", "preflight", "--repo-slug", "o/r", "--tag", "v1.1.0", "--range", "v1.0.0..main", "--changelog", "CHANGELOG.md", "--owner-repo", "o/r", "--critical-issues", "", "--live-chores-from", "live-chores.json"],
      root,
      localOnly,
    );
    const out: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (): void => {} };
    const seams: Seams = { ...defaultSeams(), run: localOnly };
    const code = await runFamily(changelogCommand, ["changelog", "completeness", "--range", "v1.0.0..main", "--changelog", "CHANGELOG.md", "--owner-repo", "o/r"], root, false, io, seams);
    return { preflight, completeness: { code, out } };
  }

  it.skipIf(!usable)("both pass when the only uncited PR is the terminal release PR, and both name it", async () => {
    const { preflight, completeness } = await both(releaseRepo([221], false));
    expect(completeness.code).toBe(0);
    expect(preflight.code).toBe(0);
    expect(preflight.out.join("\n")).toMatch(/ok {4}CON-33\(c\) reconciled -- every merged PR has a CHANGELOG entry or fragment, but one, excused by the release-PR allowance -- #222 reconciled by the CON-33\(c\) release-PR allowance/);
    expect(completeness.out[1]).toMatch(/#222 reconciled by the CON-33\(c\) release-PR allowance/);
  });

  it.skipIf(!usable)("both fail on an uncited non-terminal PR, and both name it", async () => {
    const { preflight, completeness } = await both(releaseRepo([221], true));
    expect(completeness.code).toBe(1);
    expect(completeness.out).toContain("  #220");
    expect(preflight.code).toBe(1);
    expect(preflight.out.join("\n")).toMatch(/FAIL {2}CON-33\(c\) reconciled -- missing: #220 -- #222 reconciled by the CON-33\(c\) release-PR allowance/);
  });

  // The review settlement's M2: the shared reconciliation refuses a --range
  // with a revision beginning with '-' before ANY git call. Preflight's own
  // `git log` used to take it as an option (--output=<file>), write the log to
  // a file, and pass the CON-33(c) row on an empty merge list.
  it("refuses --range=--output=<file>..HEAD at exit 2 -- no git and no gh runs, and no file is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    writeFileSync(join(dir, "CHANGELOG.md"), "no refs here\n");
    writeFileSync(join(dir, "live-chores.json"), "[]");
    const target = join(dir, "pwned");
    const toolCalls: string[] = [];
    const result = await capture(
      ["release", "preflight", "--repo-slug", "o/r", "--tag", "v1.1.0", `--range=--output=${target}..HEAD`, "--changelog", "CHANGELOG.md", "--owner-repo", "o/r", "--critical-issues", "", "--live-chores-from", "live-chores.json"],
      dir,
      (command, args): CommandResult => {
        toolCalls.push([command, ...args].join(" "));
        if (command === "gh") return { code: 1, stdout: "", stderr: "variable RELEASE_HOLD was not found", spawnFailed: false };
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/has a revision beginning with '-'/);
    expect(toolCalls).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });
});

// --- zheref/nen#309: every usage problem in ONE refusal, not one per run ---
describe("nen release preflight -- every missing or invalid flag in one refusal (zheref/nen#309)", () => {
  async function refuse(argv: readonly string[], repoFlag: string | null = null): Promise<{ code: number; err: string; toolCalls: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    const toolCalls: string[] = [];
    const result = await capture(["release", "preflight", ...argv], repoFlag ?? dir, (command, args): CommandResult => {
      toolCalls.push([command, ...args].join(" "));
      return { code: 0, stdout: "", stderr: "", spawnFailed: false };
    });
    return { code: result.code, err: result.err.join("\n"), toolCalls };
  }

  it("names ALL FIVE required flags when every one is missing, exits 2 once, and runs no tool", async () => {
    const { code, err, toolCalls } = await refuse([]);
    expect(code).toBe(2);
    expect(err).toMatch(/release preflight refused for 5 reasons -- nothing was run:/);
    for (const flag of ["repo-slug", "tag", "range", "changelog", "owner-repo"]) {
      expect(err).toContain(`  - --${flag} is required.`);
    }
    // One refusal, one pointer to the help -- not five.
    expect(err.match(/Run 'nen release --help'\./g)).toHaveLength(1);
    expect(toolCalls).toEqual([]);
  });

  it("names exactly the missing subset, in usage order", async () => {
    const { code, err } = await refuse(["--repo-slug", "o/r", "--range", "v1.0.0..v1.1.0", "--owner-repo", "o/r"]);
    expect(code).toBe(2);
    expect(err).toMatch(/refused for 2 reasons/);
    expect(err.indexOf("--tag is required.")).toBeLessThan(err.indexOf("--changelog is required."));
    expect(err).not.toContain("--repo-slug is required.");
    expect(err).not.toContain("--range is required.");
  });

  it("keeps a SINGLE missing flag's refusal byte for byte what it always was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    writeFileSync(join(dir, "CHANGELOG.md"), "x\n");
    const { code, err } = await refuse(
      ["--repo-slug", "o/r", "--range", "v1.0.0..v1.1.0", "--changelog", "CHANGELOG.md", "--owner-repo", "o/r"],
      dir,
    );
    expect(code).toBe(2);
    expect(err).toBe("nen release: --tag is required. The tag being proposed for this cut.\nRun 'nen release --help'.");
  });

  // THE ORDERING CHANGE, PINNED (hanten N4): the caller-named files are now
  // read BEFORE 'gh variable get', so an unreadable one is refused with no
  // tool run at all -- and, alone, with the message it always had.
  function validArgs(dir: string, overrides: Record<string, string>): string[] {
    writeFileSync(join(dir, "CHANGELOG.md"), "x\n");
    writeFileSync(join(dir, "live-chores.json"), "[]");
    const flags: Record<string, string> = {
      "repo-slug": "o/r",
      tag: "v1.1.0",
      range: "v1.0.0..v1.1.0",
      changelog: "CHANGELOG.md",
      "owner-repo": "o/r",
      "critical-issues": "",
      "live-chores-from": "live-chores.json",
      ...overrides,
    };
    return Object.entries(flags).flatMap(([flag, value]): string[] => [`--${flag}`, value]);
  }

  it("refuses ONLY an unreadable --changelog with its old message byte for byte, and runs no tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    const { code, err, toolCalls } = await refuse(validArgs(dir, { changelog: "missing-CHANGELOG.md" }), dir);
    expect(code).toBe(2);
    expect(err).toBe(
      `nen release: could not read '${join(dir, "missing-CHANGELOG.md")}' (ENOENT). A verb that fell back to an empty input here would report a clean verdict for a check it never ran.\nRun 'nen release --help'.`,
    );
    expect(toolCalls).toEqual([]);
  });

  it("refuses ONLY an unreadable --live-chores-from with its old message byte for byte, and runs no tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-"));
    const { code, err, toolCalls } = await refuse(validArgs(dir, { "live-chores-from": "missing-chores.json" }), dir);
    expect(code).toBe(2);
    expect(err).toBe(
      `nen release: could not read '${join(dir, "missing-chores.json")}' (ENOENT). A verb that fell back to an empty input here would report a clean verdict for a check it never ran.\nRun 'nen release --help'.`,
    );
    expect(toolCalls).toEqual([]);
  });

  it("reports an EMPTY --fragment-dir even when --repo did not resolve", async () => {
    const { code, err } = await refuse(["--tag", "v1.1.0", "--fragment-dir", ""], "");
    expect(code).toBe(2);
    expect(err).toMatch(/refused for 6 reasons/);
    expect(err).toMatch(/--repo was given an empty value/);
    expect(err).toMatch(/--fragment-dir was given an empty value/);
  });

  it("gathers an INVALID flag and an unreadable file beside the missing ones", async () => {
    const { code, err, toolCalls } = await refuse([
      "--range=--output=x..HEAD",
      "--critical-issues",
      "3,abc",
      "--changelog",
      "no-such-CHANGELOG.md",
      "--live-chores-from",
      "no-such-chores.json",
      "--fragment-dir",
      "",
    ]);
    expect(code).toBe(2);
    expect(err).toMatch(/refused for 8 reasons/);
    expect(err).toContain("--repo-slug is required.");
    expect(err).toContain("--tag is required.");
    expect(err).toContain("--owner-repo is required.");
    expect(err).toMatch(/--range '--output=x\.\.HEAD' has a revision beginning with '-'/);
    expect(err).toMatch(/--critical-issues takes a comma-separated list .* 'abc'/);
    expect(err).toMatch(/could not read '.*no-such-chores\.json'/);
    expect(err).toMatch(/--fragment-dir was given an empty value/);
    expect(err).toMatch(/could not read '.*no-such-CHANGELOG\.md'/);
    expect(toolCalls).toEqual([]);
  });

  it("counts an unresolvable --repo as one more reason rather than hiding the others", async () => {
    const { code, err } = await refuse(["--tag", "v1.1.0"], "");
    expect(code).toBe(2);
    expect(err).toMatch(/refused for 5 reasons/);
    expect(err).toMatch(/--repo was given an empty value/);
    expect(err).toContain("--repo-slug is required.");
  });

  it("--help marks which flags are required and which optional", async () => {
    const out: string[] = [];
    const io: Io = {
      out: (line): void => {
        out.push(line);
      },
      err: (): void => undefined,
    };
    expect(await run(["release", "preflight", "--help"], io)).toBe(0);
    const help = out.join("\n");
    const required = help.slice(help.indexOf("REQUIRED -- refused at exit 2"), help.indexOf("OPTIONAL TO PARSE"));
    for (const flag of ["--repo-slug", "--tag", "--range", "--changelog", "--owner-repo"]) expect(required).toContain(`${flag} <`);
    const optional = help.slice(help.indexOf("OPTIONAL TO PARSE"), help.indexOf("resolve-target:\n"));
    for (const flag of ["--critical-issues", "--live-chores-from", "--hold-var", "--fragment-dir", "--repo"]) expect(optional).toContain(`${flag} <`);
    expect(optional).toContain("OPTIONAL -- defaulted when omitted:");
    expect(optional).not.toMatch(/^ {2}--(?:repo-slug|tag|range|changelog|owner-repo) </m);
  });
});
