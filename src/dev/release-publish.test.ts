// src/dev/release-publish.test.ts -- the publisher behind `project.verbs.nen.release`.
// The script's own hermetic `--self-test` is the fixture set (a throwaway git
// repository, `gh` faked, nothing sent); this file runs it under vitest so CI
// carries it, and pins the pure helpers it rests on.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeNotes,
  parseArgs,
  previousTagOf,
  readIgnoreOption,
  readNamedListOption,
  releasePublishMain,
  remoteHost,
  selfTest,
  slugFromRemote,
  unreleasedHeading,
  type Options,
  type Run,
} from "./release-publish.js";

describe("release-publish --self-test", () => {
  it("is all green", () => {
    const result = selfTest();
    expect(result.lines.filter((line): boolean => line.includes("FAIL"))).toEqual([]);
    expect(result.failed).toBe(0);
    expect(result.ran).toBeGreaterThan(40);
  });
});

describe("release-publish helpers", () => {
  it("derives the slug from both remote shapes", () => {
    expect(slugFromRemote("https://github.com/zheref/nen.git\n")).toBe("zheref/nen");
    expect(slugFromRemote("git@github.com:zheref/nen.git")).toBe("zheref/nen");
    expect(slugFromRemote("https://github.com/zheref/nen")).toBe("zheref/nen");
  });

  it("refuses a remote that is not a repository instead of reading a slug out of its path", () => {
    expect(slugFromRemote("/tmp/bare/repo.git")).toBeUndefined();
    expect(slugFromRemote("../elsewhere/repo.git\n")).toBeUndefined();
    expect(slugFromRemote("file:///tmp/bare/repo.git")).toBeUndefined();
    expect(slugFromRemote("https://github.com/owner/name/extra")).toBeUndefined();
  });

  it("refuses a remote on any host but github.com -- every gh call targets github.com", () => {
    expect(slugFromRemote("git@git.example.com:owner/name.git")).toBeUndefined();
    expect(slugFromRemote("https://git.example.com/owner/name.git")).toBeUndefined();
    expect(slugFromRemote("ssh://git@git.example.com:2222/owner/name.git")).toBeUndefined();
    expect(slugFromRemote("ssh://git@github.com/zheref/nen.git")).toBe("zheref/nen");
    expect(slugFromRemote("https://GitHub.com/zheref/nen.git")).toBe("zheref/nen");
    expect(remoteHost("git@git.example.com:owner/name.git")).toBe("git.example.com");
    expect(remoteHost("https://user@git.example.com:8443/owner/name")).toBe("git.example.com");
    expect(remoteHost("/tmp/bare/repo.git")).toBeUndefined();
  });

  it("takes the tag immediately below the target", () => {
    expect(previousTagOf(["v3.0.0", "v2.0.0", "v1.0.0"], "v2.0.0")).toBe("v1.0.0");
    expect(previousTagOf(["v3.0.0", "v2.0.0"], "v2.0.0")).toBeUndefined();
  });

  it("composes the tag's section and nothing it did not write", () => {
    const log = "# Changelog\n\n## v2.0.0 — two\n\n- b\n\n## v1.0.0 — one\n\n- a\n";
    expect(composeNotes(log, "v2.0.0", "v1.0.0")).toEqual({ notes: "## v2.0.0 — two\n\n- b\n", sections: 1 });
    expect(composeNotes(log, "v9.0.0")).toBeUndefined();
    expect(unreleasedHeading("## v2.0.0 — unreleased\n", "v2.0.0")).toBe(true);
    expect(unreleasedHeading(log, "v2.0.0")).toBe(false);
  });

  it("refuses an unknown flag at exit 2", () => {
    expect(() => parseArgs(["--asset", "x"])).toThrow(/unexpected argument/);
    const err: string[] = [];
    expect(releasePublishMain(["--nope"], undefined, { out: (): void => undefined, err: (l): void => { err.push(l); } })).toBe(2);
    expect(err.join("\n")).toContain("release-publish: unexpected argument '--nope'");
  });

  it("refuses a value flag given twice rather than taking the last one", () => {
    expect(() => parseArgs(["--tag", "v1.0.0", "--tag", "v2.0.0"])).toThrow(/--tag is given more than once/);
    expect(() => parseArgs(["--slug", "a/b", "--slug", "c/d"])).toThrow(/--slug is given more than once/);
    expect(() => parseArgs(["--repo", ".", "--repo", ".."])).toThrow(/--repo is given more than once/);
    expect(parseArgs(["--json", "--json"]).json).toBe(true);
  });
});

describe("release-publish reads the committed named list as every guarded verb does (zheref/nen#441)", () => {
  function repo(workflow: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-release-named-"));
    if (workflow !== null) {
      mkdirSync(join(dir, "nen"));
      writeFileSync(join(dir, "nen", "workflow.json"), workflow);
    }
    return dir;
  }
  function options(repo: string, allowAllIgnored = false): Options {
    return { repo, dryRun: false, json: false, selfTest: false, skipPrivateNameCheck: false, allowAllIgnored };
  }
  /** A `run` answering git by its argv, recording every call. */
  function fakeRun(answers: Readonly<Record<string, string | null>>): { run: Run; calls: string[] } {
    const calls: string[] = [];
    const run: Run = (exe, args): ReturnType<Run> => {
      const key = [exe, ...args].join(" ");
      calls.push(key);
      const found = Object.entries(answers).find(([suffix]): boolean => key.endsWith(suffix));
      if (found === undefined || found[1] === null) return { status: 128, stdout: "", stderr: "fatal: not found" };
      return { status: 0, stdout: found[1], stderr: "" };
    };
    return { run, calls };
  }
  const io = (): { io: { out: (line: string) => void; err: (line: string) => void }; err: string[] } => {
    const err: string[] = [];
    return { io: { out: (): void => undefined, err: (line): void => void err.push(line) }, err };
  };
  const DECLARED = '{"privateNames":{"namedFile":"scripts/named.txt"}}';
  const MAIN = {
    "symbolic-ref -q refs/remotes/origin/HEAD": "refs/remotes/origin/main\n",
    "show refs/remotes/origin/main:nen/workflow.json": DECLARED,
    "ls-tree refs/remotes/origin/main -- scripts/named.txt": "100644 blob 0123456789abcdef0123456789abcdef01234567\tscripts/named.txt\n",
  };

  it("reads nothing where the checkout declares no named list", () => {
    const { run, calls } = fakeRun({ ...MAIN, "show refs/remotes/origin/main:scripts/named.txt": "x/y\n" });
    const { io: sink, err } = io();
    expect(readNamedListOption(options(repo(null)), run, sink)).toBeNull();
    expect(calls).toEqual([]);
    expect(err).toEqual([]);
  });

  it("reads the policy, the path and the list at the remote's default branch, never from the checkout", () => {
    const { run, calls } = fakeRun({ ...MAIN, "show refs/remotes/origin/main:scripts/named.txt": "# ruled\nAcme/Thing\n" });
    const { io: sink, err } = io();
    const list = readNamedListOption(options(repo('{"branch":{"base":"feature"},"privateNames":{"namedFile":"scripts/mine.txt"}}')), run, sink);
    expect([...(list?.slugs ?? [])]).toEqual(["acme/thing"]);
    expect(calls.map((call): string => call.replace(/^git -C \S+ /, "git "))).toEqual([
      "git symbolic-ref -q refs/remotes/origin/HEAD",
      "git show refs/remotes/origin/main:nen/workflow.json",
      "git ls-tree refs/remotes/origin/main -- scripts/named.txt",
      "git show refs/remotes/origin/main:scripts/named.txt",
    ]);
    expect(err).toEqual([
      "release-publish: named list read from refs/remotes/origin/main:scripts/named.txt; the checkout declares 'scripts/mine.txt', which is head content and decides nothing.",
    ]);
  });

  it("a file not at the default branch names nothing and says so; a bare name is a usage defect (2)", () => {
    const missing = fakeRun({ ...MAIN, "ls-tree refs/remotes/origin/main -- scripts/named.txt": "" });
    const first = io();
    expect(readNamedListOption(options(repo(DECLARED)), missing.run, first.io)).toBeNull();
    expect(first.err).toEqual([
      "release-publish: named list not read -- named list 'scripts/named.txt' is not at refs/remotes/origin/main (it is read at the remote's default branch, never from the checkout); it names nothing in this run.",
    ]);
    const bare = fakeRun({ ...MAIN, "show refs/remotes/origin/main:scripts/named.txt": "vault\n" });
    let thrown: unknown;
    try {
      readNamedListOption(options(repo(DECLARED)), bare.run, io().io);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code: number }).code).toBe(2);
    expect((thrown as Error).message).toMatch(/line 1 is not an exact owner\/name/);
    expect((thrown as Error).message).not.toContain("vault");
  });

  it("--allow-all-ignored alone is accepted with a declared named list and refused with neither list", () => {
    expect(readIgnoreOption(options(repo(DECLARED), true))).toBeNull();
    let thrown: unknown;
    try {
      readIgnoreOption(options(repo(null), true));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code: number }).code).toBe(2);
    expect((thrown as Error).message).toMatch(/or a committed named list/);
  });
});
