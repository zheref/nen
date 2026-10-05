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
// It SKIPS where `git` is missing or older than 2.31 -- the verb's own floor
// in range mode: `log --diff-merges` (2.31) is the newest flag it passes,
// above `rev-parse --end-of-options` (2.30) and the fixture's
// `--initial-branch` (2.28). Sizes go to `cat-file --batch-check` as bare
// object ids, with no `-z`, so nothing needs 2.38 (hanten round 2 N4).

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
  return major > 2 || (major === 2 && minor >= 31);
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
  readonly read: { mode: string; base?: string; head?: string; mergeBase?: string; headSha?: string; commits?: number };
  readonly clean: string[];
  readonly flagged: { path: string; reasons: string[] }[];
  readonly ignored: { path: string; reasons: string[] }[];
}

function doc(run: Run): Doc {
  return JSON.parse(run.out.join("\n")) as Doc;
}

/** The three buckets alone, for a row that compares them whole. */
function buckets(run: Run): Omit<Doc, "read"> {
  const { clean, flagged, ignored } = doc(run);
  return { clean, flagged, ignored };
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

    // hanten N1: a secret that exists only INSIDE the range.
    mustGit(repo, ["checkout", "--quiet", "-b", "ghost-env", init]);
    write(repo, ".env", "SECRET=1\n");
    commit(repo, "add a .env");
    rmSync(join(repo, ".env"));
    write(repo, "src/a.ts", "changed\n");
    commit(repo, "remove it again");

    mustGit(repo, ["checkout", "--quiet", "-b", "ghost-pem", init]);
    write(repo, "key.pem", "-----BEGIN PRIVATE KEY-----\n");
    commit(repo, "add a key");
    mustGit(repo, ["mv", "key.pem", "notes.txt"]);
    commit(repo, "rename it away");

    // hanten N2: an added gitlink, with a committed .gitmodules that says
    // `ignore = all`. Its commit is this repository's own root -- the object
    // need not be a real submodule checkout for git to record the gitlink.
    mustGit(repo, ["checkout", "--quiet", "-b", "gitlink", init]);
    write(repo, ".gitmodules", '[submodule "vendor/credentials"]\n\tpath = vendor/credentials\n\turl = ./vendor\n\tignore = all\n');
    mustGit(repo, ["add", ".gitmodules"]);
    mustGit(repo, ["update-index", "--add", "--cacheinfo", `160000,${init},vendor/credentials`]);
    mustGit(repo, [...WHO, "commit", "--quiet", "-m", "add a gitlink"]);

    // hanten round 2 N1: a large blob that exists only inside the range.
    mustGit(repo, ["checkout", "--quiet", "-b", "ghost-dump", init]);
    write(repo, "dump.sql", "d".repeat(3000));
    commit(repo, "add a dump");
    rmSync(join(repo, "dump.sql"));
    commit(repo, "drop it");

    mustGit(repo, ["checkout", "--quiet", "-b", "grow-shrink", init]);
    write(repo, "src/a.ts", "g".repeat(3000));
    commit(repo, "grow");
    write(repo, "src/a.ts", "small\n");
    commit(repo, "shrink");

    // hanten round 2 N3 (a): an EVIL merge adds a secret no parent had, and a
    // later merge drops it the same way.
    for (const side of ["side-one", "side-two"]) {
      mustGit(repo, ["checkout", "--quiet", "-b", side, init]);
      write(repo, `${side}.ts`);
      commit(repo, side);
    }
    mustGit(repo, ["checkout", "--quiet", "-b", "evil", init]);
    write(repo, "src/topic.ts");
    commit(repo, "topic work");
    mustGit(repo, [...WHO, "merge", "--quiet", "--no-ff", "--no-commit", "side-one"]);
    write(repo, "evil.pem", "-----BEGIN PRIVATE KEY-----\n");
    mustGit(repo, ["add", "evil.pem"]);
    mustGit(repo, [...WHO, "commit", "--quiet", "-m", "evil merge adds a key"]);
    mustGit(repo, [...WHO, "merge", "--quiet", "--no-ff", "--no-commit", "side-two"]);
    mustGit(repo, ["rm", "--quiet", "evil.pem"]);
    mustGit(repo, [...WHO, "commit", "--quiet", "-m", "evil merge drops it"]);

    // (b): a catch-up merge from the base. The base's own files -- a secret
    // among them -- are not this range's.
    mustGit(repo, ["checkout", "--quiet", "-b", "trunk", init]);
    write(repo, "trunk-only.pem", "-----BEGIN CERTIFICATE-----\n");
    write(repo, "src/trunk.ts");
    commit(repo, "the trunk moves on");
    mustGit(repo, ["checkout", "--quiet", "-b", "catch-up", init]);
    write(repo, "src/feature.ts");
    commit(repo, "feature");
    mustGit(repo, [...WHO, "merge", "--quiet", "--no-ff", "-m", "catch up with the trunk", "trunk"]);

    // (c): a secret added and removed only on a side branch that is merged in.
    mustGit(repo, ["checkout", "--quiet", "-b", "with-side", init]);
    write(repo, "src/main-line.ts");
    commit(repo, "main line");
    mustGit(repo, ["checkout", "--quiet", "-b", "leaky-side"]);
    write(repo, ".env.production", "SECRET=3\n");
    commit(repo, "side adds a secret");
    rmSync(join(repo, ".env.production"));
    write(repo, "src/side.ts");
    commit(repo, "side drops it");
    mustGit(repo, ["checkout", "--quiet", "with-side"]);
    mustGit(repo, [...WHO, "merge", "--quiet", "--no-ff", "-m", "merge the side", "leaky-side"]);

    mustGit(repo, ["checkout", "--quiet", "main"]);
  });

  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("flags a committed .env as secret-shape at exit 1, in a clean working tree", async () => {
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..env-branch"]);
    expect(run.code).toBe(1);
    expect(run.out[0]).toMatch(/^read: committed range main\.\.env-branch \([0-9a-f]{12}\.\.[0-9a-f]{12}, 1 commit\(s\)\), not the working copy$/);
    expect(run.out).toContain("  .env  [secret-shape]");
    expect(run.out).toContain("ignored: 0 file(s), not listed");
  });

  it("flags a committed *.pem as secret-shape at exit 1, in a clean working tree", async () => {
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..pem-branch"], true);
    expect(run.code).toBe(1);
    expect(buckets(run)).toEqual({ clean: [], flagged: [{ path: "certs/server.pem", reasons: ["secret-shape"] }], ignored: [] });
  });

  it("a clean range exits 0 with every changed path clean, in a clean working tree", async () => {
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..clean-branch"]);
    expect(run.code).toBe(0);
    expect(run.out.slice(1)).toEqual(["clean: 2 file(s)", "  src/a.ts", "  src/b.ts", "ignored: 0 file(s), not listed"]);
  });

  it("--json has one shape in both modes, and its 'read' names the reading", async () => {
    const run = await triage(repo, ["--range", "main..clean-branch"], true);
    expect(Object.keys(doc(run))).toEqual(["read", "clean", "flagged", "ignored"]);
    expect(doc(run).read).toEqual({
      mode: "range",
      base: "main",
      head: "clean-branch",
      mergeBase: init,
      headSha: mustGit(repo, ["rev-parse", "clean-branch"]).trim(),
      commits: 1,
    });
    const working = await triage(repo, [], true);
    expect(Object.keys(doc(working))).toEqual(["read", "clean", "flagged", "ignored"]);
    expect(doc(working).read).toEqual({ mode: "working-copy" });
  });

  it("an empty range exits 0, says it names no commits, and --json carries commits: 0", async () => {
    const text = await triage(repo, ["--range", "env-branch..main"]);
    expect(text.code).toBe(0);
    expect(text.out[0]).toMatch(/-- the range names no commits, not the working copy$/);
    const json = await triage(repo, ["--range", "env-branch..main"], true);
    expect(json.code).toBe(0);
    expect(doc(json).read.commits).toBe(0);
    expect(buckets(json)).toEqual({ clean: [], flagged: [], ignored: [] });
  });

  it("flags a .env added and then deleted inside the range: gone at head, still in history (hanten N1)", async () => {
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..ghost-env"], true);
    expect(run.code).toBe(1);
    expect(buckets(run)).toEqual({
      clean: ["src/a.ts"],
      flagged: [{ path: ".env", reasons: ["secret-shape", "in-history"] }],
      ignored: [],
    });
  });

  it("flags a key.pem added and then renamed to notes.txt inside the range (hanten N1)", async () => {
    expect(status(repo)).toBe("");
    const run = await triage(repo, ["--range", "main..ghost-pem"]);
    expect(run.code).toBe(1);
    expect(run.out).toContain("  key.pem  [secret-shape, in-history]");
    expect(run.out).toContain("  notes.txt");
  });

  it("flags a 3000-byte dump.sql added then deleted as [large, in-history] (hanten round 2 N1)", async () => {
    const run = await triage(repo, ["--range", "main..ghost-dump", "--large-bytes", "2000"], true);
    expect(run.code).toBe(1);
    expect(buckets(run)).toEqual({ clean: [], flagged: [{ path: "dump.sql", reasons: ["large", "in-history"] }], ignored: [] });
    // Under the default threshold the same range has nothing to say.
    const quiet = await triage(repo, ["--range", "main..ghost-dump"], true);
    expect(quiet.code).toBe(0);
  });

  it("flags a file grown then shrunk inside the range as [large, in-history] (hanten round 2 N1)", async () => {
    const run = await triage(repo, ["--range", "main..grow-shrink", "--large-bytes", "2000"], true);
    expect(run.code).toBe(1);
    expect(buckets(run)).toEqual({ clean: [], flagged: [{ path: "src/a.ts", reasons: ["large", "in-history"] }], ignored: [] });
  });

  it("flags a key an evil merge added and a later merge removed (hanten round 2 N3a)", async () => {
    const run = await triage(repo, ["--range", "main..evil"], true);
    expect(run.code).toBe(1);
    expect(doc(run).flagged).toEqual([{ path: "evil.pem", reasons: ["secret-shape", "in-history"] }]);
    expect(doc(run).clean.sort()).toEqual(["side-one.ts", "side-two.ts", "src/topic.ts"]);
  });

  it("does not list the base's files after a catch-up merge from the base (hanten round 2 N3b)", async () => {
    const run = await triage(repo, ["--range", "trunk..catch-up"], true);
    expect(run.code).toBe(0);
    expect(buckets(run)).toEqual({ clean: ["src/feature.ts"], flagged: [], ignored: [] });
  });

  it("flags a secret added and removed only on a merged side branch (hanten round 2 N3c)", async () => {
    const run = await triage(repo, ["--range", "main..with-side"], true);
    expect(run.code).toBe(1);
    expect(doc(run).flagged).toEqual([{ path: ".env.production", reasons: ["secret-shape", "in-history"] }]);
    expect(doc(run).clean.sort()).toEqual(["src/main-line.ts", "src/side.ts"]);
  });

  it("reads the pushed objects, not a replace ref's stand-in (hanten round 2 N6)", async () => {
    const envCommit = mustGit(repo, ["rev-parse", "env-branch"]).trim();
    const cleanCommit = mustGit(repo, ["rev-parse", "clean-branch"]).trim();
    mustGit(repo, ["replace", envCommit, cleanCommit]);
    try {
      // git itself now shows the stand-in's changes for env-branch ...
      expect(mustGit(repo, ["diff", "--name-only", "main", "env-branch"])).not.toContain(".env");
      // ... and the verb still reads the commit being pushed.
      const run = await triage(repo, ["--range", "main..env-branch"], true);
      expect(run.code).toBe(1);
      expect(doc(run).flagged).toEqual([{ path: ".env", reasons: ["secret-shape"] }]);
    } finally {
      mustGit(repo, ["replace", "-d", envCommit]);
    }
  });

  it("refuses a real shallow clone at exit 2, even where a merged side branch would read clean (Copilot on #379)", async () => {
    const shallow = join(root, "shallow");
    mustGit(root, ["clone", "--quiet", "--depth", "2", "--no-single-branch", `file://${repo}`, shallow]);
    expect(mustGit(shallow, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("true");
    const run = await triage(shallow, ["--range", "origin/main..origin/with-side"]);
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toMatch(/is a shallow clone -- fetch full history/);
    expect(run.out).toEqual([]);
  });

  it("sees an added gitlink when diff.ignoreSubmodules=all is configured (hanten N2)", async () => {
    mustGit(repo, ["config", "diff.ignoreSubmodules", "all"]);
    try {
      const run = await triage(repo, ["--range", "main..gitlink"], true);
      expect(run.code).toBe(1);
      expect(doc(run).flagged).toContainEqual({ path: "vendor/credentials", reasons: ["secret-shape"] });
    } finally {
      mustGit(repo, ["config", "--unset", "diff.ignoreSubmodules"]);
    }
  });

  it("sees an added gitlink when a committed .gitmodules says ignore = all (hanten N2)", async () => {
    mustGit(repo, ["checkout", "--quiet", "gitlink"]);
    try {
      expect(mustGit(repo, ["config", "-f", ".gitmodules", "submodule.vendor/credentials.ignore"]).trim()).toBe("all");
      const run = await triage(repo, ["--range", "main..gitlink"], true);
      expect(run.code).toBe(1);
      expect(doc(run).flagged).toContainEqual({ path: "vendor/credentials", reasons: ["secret-shape"] });
    } finally {
      mustGit(repo, ["checkout", "--quiet", "main"]);
    }
  });

  it("never reads the working copy: an untracked .env on disk is not in a clean range's report", async () => {
    write(repo, ".env", "SECRET=1\n");
    write(repo, "node_modules/leftpad/index.js");
    try {
      const run = await triage(repo, ["--range", "main..clean-branch"], true);
      expect(run.code).toBe(0);
      expect(buckets(run)).toEqual({ clean: ["src/a.ts", "src/b.ts"], flagged: [], ignored: [] });
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
    expect(buckets(run)).toEqual({ clean: ["src/a.ts", "src/b.ts"], flagged: [], ignored: [] });
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

  it.each(["-x..main", "main..--output=/tmp/x"])("refuses a side beginning with '-' (%s) at exit 2, before git sees it", async (value) => {
    const run = await triage(repo, ["--range", value]);
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toMatch(/begins with '-'/);
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
