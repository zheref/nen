// src/stage/triage-range.integration.test.ts -- `nen stage triage --range`
// against the REAL git (zheref/nen#337).
//
// WHY A REAL GIT. The claim under test is about which paths git says a range
// of commits changed -- renames followed, the merge base honoured, a deletion
// absent from the head tree -- and that an unresolved ref is refused rather
// than quietly answered from the working copy. Only git can answer those.
//
// EVERY FIXTURE RUNS IN A CLEAN WORKING TREE unless the row is about the
// working tree, because the defect that filed #337 was a review of a clean,
// committed branch reading the secret-shape row as unread.
//
// It SKIPS where `git` is missing or older than 2.28 (the fixture's
// `--initial-branch` floor), as ./list.integration.test.ts does.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { stageCommand } from "./command.js";

const WHO = ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false"];

function mustGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if ((result.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout ?? "";
}

function usableGit(): boolean {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (probe.error !== undefined || probe.status !== 0) return false;
  const version = /(\d+)\.(\d+)/.exec(probe.stdout ?? "");
  if (version === null) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return major > 2 || (major === 2 && minor >= 28);
}

const HAVE_GIT = usableGit();

function write(root: string, path: string, content = "x\n"): void {
  const parts = path.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), content, "utf8");
}

function commit(repo: string, message: string): string {
  mustGit(repo, ["add", "-A"]);
  mustGit(repo, [...WHO, "commit", "--quiet", "--allow-empty", "-m", message]);
  return mustGit(repo, ["rev-parse", "HEAD"]).trim();
}

function status(repo: string): string {
  return mustGit(repo, ["status", "--porcelain=v1", "--ignored"]);
}

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

async function triage(repo: string, argv: readonly string[], json = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const code = await runFamily(stageCommand, ["stage", "triage", ...argv], repo, json, io, defaultSeams());
  return { code, out, err };
}

interface Doc {
  readonly clean: string[];
  readonly flagged: { path: string; reasons: string[] }[];
  readonly ignored: { path: string; reasons: string[] }[];
}

function doc(run: Run): Doc {
  return JSON.parse(run.out.join("\n")) as Doc;
}

describe.skipIf(!HAVE_GIT)("nen stage triage --range, against the real git (zheref/nen#337)", () => {
  let root = "";
  let repo = "";
  let init = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nen-stage-range-"));
    repo = join(root, "work");
    mkdirSync(repo, { recursive: true });
    mustGit(repo, ["init", "--quiet", "--initial-branch=main"]);
    mustGit(repo, ["config", "core.autocrlf", "false"]);
    write(repo, ".gitignore", "node_modules/\n");
    write(repo, "src/a.ts");
    write(repo, "src/old-name.ts", "renamed content that is long enough to be followed\n");
    write(repo, "src/doomed.ts");
    write(repo, "src/huge.ts");
    init = commit(repo, "init");
    // Every branch below is cut from `init` and committed; `main` stays there
    // until the merge-base row moves it.
    mustGit(repo, ["branch", "env-branch"]);
    mustGit(repo, ["branch", "pem-branch"]);
    mustGit(repo, ["branch", "clean-branch"]);
    mustGit(repo, ["branch", "mixed-branch"]);

    mustGit(repo, ["checkout", "--quiet", "env-branch"]);
    write(repo, ".env", "SECRET=1\n");
    commit(repo, "commit a .env");

    mustGit(repo, ["checkout", "--quiet", "pem-branch"]);
    write(repo, "certs/server.pem", "-----BEGIN CERTIFICATE-----\n");
    commit(repo, "commit a pem");

    mustGit(repo, ["checkout", "--quiet", "clean-branch"]);
    write(repo, "src/a.ts", "changed\n");
    write(repo, "src/b.ts");
    commit(repo, "ordinary change");

    mustGit(repo, ["checkout", "--quiet", "mixed-branch"]);
    rmSync(join(repo, "src", "doomed.ts"));
    // Shrunk at <head>: on disk it is re-grown below, uncommitted, to prove
    // sizes come from the tree and not the working copy.
    write(repo, "src/huge.ts", "y".repeat(64));
    mustGit(repo, ["mv", "src/old-name.ts", "src/new-name.ts"]);
    write(repo, "assets/blob.ts", "z".repeat(4096));
    commit(repo, "delete, rename, grow");

    mustGit(repo, ["checkout", "--quiet", "main"]);
  });

  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("flags a committed .env as secret-shape at exit 1, in a clean working tree", async () => {
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..env-branch"]);
    expect(run.code).toBe(1);
    expect(run.out[0]).toMatch(/^read: committed range main\.\.env-branch \([0-9a-f]{12}\.\.[0-9a-f]{12}\), not the working copy$/);
    expect(run.out).toContain("  .env  [secret-shape]");
    expect(run.out).toContain("ignored: 0 file(s), not listed");
  });

  it("flags a committed *.pem as secret-shape at exit 1, in a clean working tree", async () => {
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..pem-branch"], true);
    expect(run.code).toBe(1);
    expect(doc(run)).toEqual({ clean: [], flagged: [{ path: "certs/server.pem", reasons: ["secret-shape"] }], ignored: [] });
  });

  it("a clean range exits 0 with every changed path clean, in a clean working tree", async () => {
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..clean-branch"]);
    expect(run.code).toBe(0);
    expect(run.out.slice(1)).toEqual(["clean: 2 file(s)", "  src/a.ts", "  src/b.ts", "ignored: 0 file(s), not listed"]);
  });

  it("--json keeps the working-copy shape exactly: clean, flagged, ignored and nothing else", async () => {
    const run = await triage(repo, ["--range", "main..clean-branch"], true);
    expect(Object.keys(doc(run))).toEqual(["clean", "flagged", "ignored"]);
  });

  it("never reads the working copy: an untracked .env on disk is not in a clean range's report", async () => {
    write(repo, ".env", "SECRET=1\n");
    write(repo, "node_modules/leftpad/index.js");
    try {
      const run = await triage(repo, ["--range", "main..clean-branch"], true);
      expect(run.code).toBe(0);
      expect(doc(run)).toEqual({ clean: ["src/a.ts", "src/b.ts"], flagged: [], ignored: [] });
      // And without --range the same tree is the working-copy reading, unchanged.
      const working = await triage(repo, [], true);
      expect(working.code).toBe(1);
      expect(doc(working).flagged).toEqual([{ path: ".env", reasons: ["secret-shape"] }]);
      expect(doc(working).ignored.map((file): string => file.path)).toEqual(["node_modules/leftpad/index.js"]);
      expect(run.out.join("\n")).not.toMatch(/^read:/m);
      expect(working.out.join("\n")).not.toMatch(/^read:/);
    } finally {
      rmSync(join(repo, ".env"));
      rmSync(join(repo, "node_modules"), { recursive: true, force: true });
    }
  });

  it("follows a rename, flags an unmentioned deletion and never flags a deletion large", async () => {
    const run = await triage(repo, ["--range", "main..mixed-branch", "--large-bytes", "1"], true);
    expect(run.code).toBe(1);
    const flagged = doc(run).flagged;
    expect(flagged).toContainEqual({ path: "src/doomed.ts", reasons: ["unmentioned-deletion"] });
    expect(flagged).toContainEqual({ path: "src/new-name.ts", reasons: ["large"] });
    expect(flagged.map((file): string => file.path)).not.toContain("src/old-name.ts");
  });

  it("matches --mentions against a deleted path's basename exactly as the working-copy mode does", async () => {
    const run = await triage(repo, ["--range", "main..mixed-branch", "--mentions", "drop doomed.ts, it is unused"], true);
    expect(run.code).toBe(0);
    expect(doc(run).flagged).toEqual([]);
    expect(doc(run).clean).toContain("src/doomed.ts");
  });

  it("measures sizes at <head>'s tree, never on disk", async () => {
    mustGit(repo, ["checkout", "--quiet", "mixed-branch"]);
    write(repo, "src/huge.ts", "y".repeat(8192));
    try {
      const run = await triage(repo, ["--range", "main..mixed-branch", "--large-bytes", "1000"], true);
      const flagged = doc(run).flagged;
      expect(flagged).toContainEqual({ path: "assets/blob.ts", reasons: ["large"] });
      expect(flagged.map((file): string => file.path)).not.toContain("src/huge.ts");
      expect(doc(run).clean).toContain("src/huge.ts");
    } finally {
      mustGit(repo, ["checkout", "--quiet", "--", "src/huge.ts"]);
      mustGit(repo, ["checkout", "--quiet", "main"]);
    }
  });

  it("reads the range's own commits from the merge base: a .env the base gained later is not in it", async () => {
    mustGit(repo, ["checkout", "--quiet", "-b", "moved-main", init]);
    write(repo, "late/.env", "SECRET=2\n");
    commit(repo, "base moves on with its own secret");
    mustGit(repo, ["checkout", "--quiet", "main"]);
    const run = await triage(repo, ["--range", "moved-main..clean-branch"], true);
    expect(run.code).toBe(0);
    expect(doc(run)).toEqual({ clean: ["src/a.ts", "src/b.ts"], flagged: [], ignored: [] });
  });

  it("refuses an unresolved head ref at exit 2, naming it, and never falls back to the working copy", async () => {
    write(repo, ".env", "SECRET=1\n");
    try {
      const run = await triage(repo, ["--range", "main..no-such-branch"]);
      expect(run.code).toBe(2);
      expect(run.err.join("\n")).toMatch(/the head ref 'no-such-branch' does not resolve to a commit/);
      expect(run.out).toEqual([]);
    } finally {
      rmSync(join(repo, ".env"));
    }
  });

  it("refuses an unresolved base ref at exit 2, naming it", async () => {
    const run = await triage(repo, ["--range", "origin/gone..main"]);
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toMatch(/the base ref 'origin\/gone' does not resolve to a commit/);
  });

  it("refuses a ref that names a tree rather than a commit at exit 2", async () => {
    const tree = mustGit(repo, ["rev-parse", "main^{tree}"]).trim();
    const run = await triage(repo, ["--range", `main..${tree}`]);
    expect(run.code).toBe(2);
  });

  it("refuses two histories with no common ancestor at exit 2", async () => {
    mustGit(repo, ["checkout", "--quiet", "--orphan", "island"]);
    mustGit(repo, ["rm", "-r", "--quiet", "--cached", "."]);
    mustGit(repo, [...WHO, "commit", "--quiet", "--allow-empty", "-m", "unrelated root"]);
    mustGit(repo, ["checkout", "--quiet", "-f", "main"]);
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..island"]);
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toMatch(/share no common ancestor/);
  });

  it.each(["main", "main...env-branch", "..env-branch", "main..", "a..b..c"])(
    "refuses the malformed range '%s' at exit 2",
    async (value) => {
      const run = await triage(repo, ["--range", value]);
      expect(run.code).toBe(2);
      expect(run.err.join("\n")).toMatch(/--range takes <base>\.\.<head>/);
    },
  );

  it("refuses --range on stage list at exit 2", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const code = await runFamily(stageCommand, ["stage", "list", "--range", "main..env-branch"], repo, false, io, defaultSeams());
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--range belongs to 'stage triage'/);
  });

  it("refuses a directory that is not a repository at exit 1, naming it", async () => {
    const bare = join(root, "not-a-repo");
    mkdirSync(bare, { recursive: true });
    const run = await triage(bare, ["--range", "main..env-branch"]);
    expect(run.code).toBe(1);
    expect(run.err.join("\n")).toMatch(/is not a git repository/);
  });
});
