import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { changelogCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

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

  // zheref/nen#34, reproduced at its own fixture size. The section was rendered
  // from `sortFragments` -- newest-first by the leading `<n>-` prefix -- and the
  // manifest was printed from `readdirSync` order, so the two disagreed by
  // construction at ANY fragment count. Nothing was ever dropped; the record a
  // caller cross-checks the section against simply described a different order
  // from the one written, which is worse than no record.
  it("prints the manifest in the order the fragments were WRITTEN, newest-first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "### Unreleased\n_(nothing awaiting release.)_\n");
    const fragmentDir = join(dir, "changelog.d");
    mkdirSync(fragmentDir);
    // Created in ASCENDING order, which is also the order readdir reports them.
    for (const [name, body] of [
      ["10-a.md", "- FRAG-10.\n"],
      ["20-b.md", "- FRAG-20.\n"],
      ["30-c.md", "- FRAG-30.\n"],
    ]) {
      writeFileSync(join(fragmentDir, name as string), body as string);
    }
    const result = await capture(
      ["changelog", "collate", "--version", "v0.2.0", "--theme", "order probe", "--changelog", changelog, "--fragment-dir", "changelog.d", "--write"],
      dir,
    );
    expect(result.code).toBe(0);
    // The manifest, and the written section, in ONE order.
    expect(result.out.slice(1)).toEqual(["  30-c.md", "  20-b.md", "  10-a.md"]);
    const written = readFileSync(changelog, "utf8");
    expect(written.indexOf("FRAG-30")).toBeLessThan(written.indexOf("FRAG-20"));
    expect(written.indexOf("FRAG-20")).toBeLessThan(written.indexOf("FRAG-10"));
  });

  it("carries the same order into --json's fragments[]", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, "### Unreleased\n_(nothing awaiting release.)_\n");
    const fragmentDir = join(dir, "changelog.d");
    mkdirSync(fragmentDir);
    writeFileSync(join(fragmentDir, "10-a.md"), "- FRAG-10.\n");
    writeFileSync(join(fragmentDir, "30-c.md"), "- FRAG-30.\n");
    const result = await capture(
      ["changelog", "collate", "--version", "v0.2.0", "--theme", "t", "--changelog", changelog, "--fragment-dir", "changelog.d", "--json"],
      dir,
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out.join("\n")) as { fragments: string[] }).fragments).toEqual([
      "30-c.md",
      "10-a.md",
    ]);
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

    it("refuses an EXPLICITLY EMPTY --fragment-dir at exit 2 rather than reading the repository root", async () => {
      // `?? DEFAULT_FRAGMENT_DIR` does not catch `""`, so `--fragment-dir ''`
      // used to resolve to the repo root and count every top-level *.md as a
      // fragment -- the loosest possible reading of "no fragment directory".
      const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "no refs here");
      writeFileSync(join(dir, "5-stray.md"), "not a fragment\n");

      const result = await capture(
        ["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r", "--fragment-dir", ""],
        dir,
        mergedFive,
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--fragment-dir was given an empty value/);
      expect(result.err.join("\n")).toMatch(/Omit the flag to use the default/);
    });

    it("refuses a --fragment-dir that is a FILE at exit 2, naming the path", async () => {
      // Was a raw ENOTDIR out of readdirSync at exit 1, several frames from
      // the flag that caused it.
      const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "no refs here");
      writeFileSync(join(dir, "notadir"), "x\n");

      const result = await capture(
        ["changelog", "completeness", "--range", "v1..v2", "--changelog", changelog, "--owner-repo", "o/r", "--fragment-dir", "notadir"],
        dir,
        mergedFive,
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--fragment-dir points at .*notadir', which is not a directory/);
      expect(result.err.join("\n")).not.toMatch(/ENOTDIR/);
    });

    it("refuses an UNREADABLE --fragment-dir at exit 2, naming the errno, rather than reporting 'no fragments' (PR #83 review)", async () => {
      // A stat failure that is NOT "not there" -- EACCES here, from a locked
      // PARENT directory -- must not be folded into the same null-return as an
      // absent directory: a caller told "no fragments" in that case would never
      // learn the check did not run at all. chmod is skipped where the bit is
      // not enforced (root, or a filesystem that ignores it) rather than
      // asserted into a platform-dependent failure -- see ../verbs/pr_ready.test.ts
      // (zheref/nen#8) for the same guard on a file-level EACCES.
      const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
      const changelog = join(dir, "CHANGELOG.md");
      writeFileSync(changelog, "no refs here");
      const locked = join(dir, "locked");
      const fragmentDir = join(locked, "changelog.d");
      mkdirSync(fragmentDir, { recursive: true });
      chmodSync(locked, 0o000);

      let blocked = true;
      try {
        statSync(fragmentDir);
        blocked = false; // permission bit not enforced on this host -- skip below
      } catch {
        // still blocked, as expected
      }

      if (blocked) {
        const result = await capture(
          [
            "changelog",
            "completeness",
            "--range",
            "v1..v2",
            "--changelog",
            changelog,
            "--owner-repo",
            "o/r",
            "--fragment-dir",
            join("locked", "changelog.d"),
          ],
          dir,
          mergedFive,
        );
        expect(result.code).toBe(2);
        expect(result.err.join("\n")).toMatch(/--fragment-dir points at .*changelog\.d', which could not be checked/);
        expect(result.err.join("\n")).toMatch(/EACCES/);
      }

      chmodSync(locked, 0o700); // restore so the temp-dir cleanup can traverse it
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

// zheref/nen#101. `--changelog` was read with a bare `readFileSync`, so a
// mistyped path escaped as `nen changelog: ENOENT: no such file or directory,
// open '<path>'` at exit 1 -- a raw errno under the code that means "the thing
// you asked for did not work", for what is a typo. The sibling verb one
// function down (`completeness`) already used the shared reader.
describe("nen changelog collate -- an unreadable --changelog is a usage refusal", () => {
  it("refuses at exit 2, naming the resolved path and what the file was for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-cl-"));
    const result = await capture(
      ["changelog", "collate", "--version", "v1.1.0", "--theme", "t", "--changelog", "nope.md", "--fragment-dir", "changelog.d"],
      dir,
    );
    expect(result.code).toBe(2);
    const said = result.err.join("\n");
    expect(said).toMatch(/could not read/);
    expect(said).toMatch(/ENOENT/);
    expect(said).toMatch(/names the file this verb REWRITES/);
  });
});
