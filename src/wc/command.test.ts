import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { wcCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
): Promise<{ code: number; out: string[]; err: string[]; seams: ScriptedSeams }> {
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
  const scripted = new ScriptedSeams(script);
  const seams: Seams = scripted;
  const code = await runFamily(wcCommand, argv, repoFlag, false, io, seams);
  return { code, out, err, seams: scripted };
}

describe("nen wc classify -- CLI wiring", () => {
  it("reports must-move for a dirty trunk", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/case: must-move/);
  });

  it("always exits 0 -- a report, not a guard", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(result.code).toBe(0);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- never silently read as "classify the process's cwd".
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["wc", "classify"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("prints the branch on its own line, on the ordinary path", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/x\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "0\n" } },
      { match: "git log main..HEAD --format=%s", result: { stdout: "" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("branch: feature/x");
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["wc", "bogus"])).code).toBe(2);
  });
});

// ── a detached HEAD (zheref/nen#163) ────────────────────────────────────────
//
// A worktree added with `--detach`, a bisect, a rebase step. Each is an
// ORDINARY working copy: the classification is decided by trunk-or-not and
// dirty-or-not, and both are answerable without a branch name. This used to
// refuse at exit 1 -- "the tree is not clean", which it was not saying -- and
// print that prose on stdout under --json.

describe("nen wc classify -- a detached HEAD", () => {
  const DETACHED: readonly ScriptedCall[] = [
    { match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } },
    { match: "git rev-parse --short HEAD", result: { stdout: "1a2b3c4\n" } },
    { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    { match: "git rev-list --count main..HEAD", result: { stdout: "2\n" } },
    { match: "git log main..HEAD --format=%s", result: { stdout: "second\nfirst\n" } },
  ];

  it("classifies it, at exit 0, saying where HEAD is standing", async () => {
    const result = await capture(["wc", "classify"], DETACHED);
    expect(result.code).toBe(0);
    expect(result.out).toContain("case: on-branch-dirty");
    expect(result.out).toContain("branch: (detached HEAD at 1a2b3c4)");
    expect(result.out.join("\n")).toContain("on a detached HEAD at 1a2b3c4");
  });

  it("--json is ONE document, with branch: null and the sha beside it", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const code = await runFamily(wcCommand, ["wc", "classify"], BANKAI_REPO, true, io, new ScriptedSeams(DETACHED));
    expect(code).toBe(0);
    // Parses at all, which is the half the issue was about: the refusal used to
    // print its prose on stdout under --json.
    const parsed = JSON.parse(out.join("\n")) as { state: Record<string, unknown>; result: Record<string, unknown> };
    expect(parsed.state["branch"]).toBeNull();
    expect(parsed.state["detachedAt"]).toBe("1a2b3c4");
    expect(parsed.state["isTrunk"]).toBe(false);
    expect(parsed.result["case"]).toBe("on-branch-dirty");
    expect(err).toEqual([]);
  });

  it("a CLEAN detached HEAD is on-branch-clean, at exit 0", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } },
      { match: "git rev-parse --short HEAD", result: { stdout: "1a2b3c4\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "0\n" } },
      { match: "git log main..HEAD --format=%s", result: { stdout: "" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("case: on-branch-clean");
    expect(result.out).toContain("branch: (detached HEAD at 1a2b3c4)");
  });

  it("still exits non-zero, with an EMPTY stdout, when HEAD resolves to no commit at all", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } },
      { match: "git rev-parse --short HEAD", result: { code: 128, stderr: "fatal: ambiguous argument 'HEAD'" } },
    ]);
    expect(result.code).not.toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/resolves to no commit/);
  });
});

/** A real file on disk holding `content`, for `--message-file` (a real fs read). */
function messageFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-wc-squash-msg-"));
  const path = join(dir, "message.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

const CLEAN = { match: "git status --porcelain=v1 -uall", result: { stdout: "" } };
const MERGE_BASE = { match: "git merge-base main HEAD", result: { stdout: "base0000\n" } };
const ANCESTOR_OK = { match: "git merge-base --is-ancestor main HEAD", result: { code: 0 } };
const NO_UPSTREAM = { match: "git rev-parse --abbrev-ref @{upstream}", result: { code: 1 } };
const TWO_COMMITS = {
  match: "git log base0000..HEAD --format=%H%x09%s",
  result: { stdout: "sha2\tsecond commit\nsha1\tfirst commit\n" },
};

describe("nen wc squash -- CLI wiring", () => {
  it("refuses an OMITTED --repo at exit 2, naming the flag", async () => {
    const result = await capture(["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("refuses an OMITTED --onto at exit 2", async () => {
    const result = await capture(["wc", "squash", "--message-file", messageFile("feat: x\n")]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--onto is required/);
  });

  it("refuses an OMITTED --message-file at exit 2", async () => {
    const result = await capture(["wc", "squash", "--onto", "main"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--message-file is required/);
  });

  it("refuses a --message-file that fails Conventional Commits shape, at exit 2, naming every reason", async () => {
    const result = await capture([
      "wc",
      "squash",
      "--onto",
      "main",
      "--message-file",
      messageFile(`bogus: ${"x".repeat(80)}\n`),
    ]);
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    expect(message).toMatch(/not one of/);
    expect(message).toMatch(/72-character/);
  });

  it("refuses a dirty working tree at exit 2, and never even reads --onto's ancestry", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [{ match: "git status --porcelain=v1 -uall", result: { stdout: " M dirty.ts\n" } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/dirty.ts/);
  });

  it("refuses --onto not an ancestor of HEAD, at exit 2", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [CLEAN, MERGE_BASE, { match: "git merge-base --is-ancestor main HEAD", result: { code: 1 } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/not an ancestor/);
  });

  it("refuses a folded commit already on the upstream, at exit 2, naming it as already published", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [
        CLEAN,
        MERGE_BASE,
        ANCESTOR_OK,
        TWO_COMMITS,
        { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
        { match: "git fetch origin work", result: { code: 0 } },
        { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 0 } },
      ],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/already published; squashing would rewrite pushed history/);
  });

  it("exits 0 with one line, not a refusal, when fewer than two commits would fold", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [CLEAN, MERGE_BASE, ANCESTOR_OK, { match: "git log base0000..HEAD --format=%H%x09%s", result: { stdout: "" } }],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/nothing to squash/);
  });

  it("--dry-run prints the folded commits and the message, and touches neither reset nor commit", async () => {
    const script = [CLEAN, MERGE_BASE, ANCESTOR_OK, TWO_COMMITS, NO_UPSTREAM];
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: add a thing\n\nCloses: #4\n"), "--dry-run"],
      script,
    );
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/would fold 2 commit\(s\)/);
    expect(out).toContain("sha1 first commit");
    expect(out).toContain("sha2 second commit");
    expect(out).toContain("feat: add a thing");
    expect(out).toContain("Closes: #4");
  });

  it("performs the real squash: reset --soft then commit -F, in that order, after every refusal has passed", async () => {
    const path = messageFile("feat: add a thing\n");
    const script = [
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      TWO_COMMITS,
      NO_UPSTREAM,
      { match: "git reset --soft base0000", result: { code: 0 } },
      { match: `git commit -F ${path}`, result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "newsha00\n" } },
    ];
    const result = await capture(["wc", "squash", "--onto", "main", "--message-file", path], script);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("squashed into newsha00");
  });

  it("--json prints the nen.wc.squash/v0.1 contract, folded oldest-first, newSha set", async () => {
    const path = messageFile("feat: add a thing\n");
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams: Seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      TWO_COMMITS,
      NO_UPSTREAM,
      { match: "git reset --soft base0000", result: { code: 0 } },
      { match: `git commit -F ${path}`, result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "newsha00\n" } },
    ]);
    const code = await runFamily(wcCommand, ["wc", "squash", "--onto", "main", "--message-file", path], BANKAI_REPO, true, io, seams);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(parsed["contract"]).toBe("nen.wc.squash/v0.1");
    expect(parsed["onto"]).toBe("main");
    expect(parsed["mergeBase"]).toBe("base0000");
    expect(parsed["folded"]).toEqual(["sha1", "sha2"]);
    expect(parsed["newSha"]).toBe("newsha00");
    expect(parsed["dryRun"]).toBe(false);
  });
});

// ── nen wc catch-up (zheref/nen#227) ────────────────────────────────────────

/** `--base main` passed git's own validator; every catch-up script starts here. */
const BASE_OK = { match: "git check-ref-format --branch main", result: { code: 0 } };
const FETCH_MAIN = "git fetch --end-of-options origin refs/heads/main:refs/remotes/origin/main";
/** git says neither a rebase nor a merge is in progress. */
const NOTHING_PENDING: readonly ScriptedCall[] = [
  BASE_OK,
  { match: "git rev-parse --verify --quiet REBASE_HEAD", result: { code: 1 } },
  { match: "git rev-parse --verify --quiet MERGE_HEAD", result: { code: 1 } },
];
const FETCHED = { match: FETCH_MAIN, result: { code: 0 } };
const HEAD_BEFORE = { match: "git rev-parse HEAD", result: { stdout: "before00\n" } };
const BEHIND = (n: number): ScriptedCall => ({ match: "git rev-list --count HEAD..origin/main", result: { stdout: `${n}\n` } });
const AHEAD = (n: number): ScriptedCall => ({ match: "git rev-list --count origin/main..HEAD", result: { stdout: `${n}\n` } });
const OWN_COMMITS = { match: "git log origin/main..HEAD --format=%H%x09%s", result: { stdout: "sha2\tsecond\nsha1\tfirst\n" } };

async function captureJson(argv: readonly string[], script: readonly ScriptedCall[]): Promise<{ code: number; doc: Record<string, unknown>; err: string[]; seams: ScriptedSeams }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(script);
  const code = await runFamily(wcCommand, argv, BANKAI_REPO, true, io, seams);
  return { code, doc: out.length === 0 ? {} : (JSON.parse(out.join("\n")) as Record<string, unknown>), err, seams };
}

const gitCalls = (seams: ScriptedSeams): readonly string[] => seams.calls.map((call): string => [call.command, ...call.args].join(" "));

describe("nen wc catch-up -- rebase or merge onto origin/<base>, never picking a side", () => {
  it("refuses an omitted --repo and --base, and an unknown --strategy, at exit 2", async () => {
    expect((await capture(["wc", "catch-up", "--base", "main"], [], null)).code).toBe(2);
    expect((await capture(["wc", "catch-up"], [])).code).toBe(2);
    const bad = await capture(["wc", "catch-up", "--base", "main", "--strategy", "yolo"], NOTHING_PENDING);
    expect(bad.code).toBe(2);
    expect(bad.err.join("\n")).toMatch(/--strategy 'yolo' is not one of rebase, merge, auto/);
  });

  it("refuses a --base git rejects, or one shaped like an option or a force, before ANY fetch -- under --dry-run too (Feitan S2)", async () => {
    const option = await capture(["wc", "catch-up", "--base=--upload-pack=/x", "--dry-run"], [
      { match: "git check-ref-format --branch --upload-pack=/x", result: { code: 129, stderr: "error: unknown option `upload-pack=/x'" } },
    ]);
    expect(option.code).toBe(2);
    expect(option.err.join("\n")).toMatch(/--base '--upload-pack=\/x' is not a branch name git will accept/);
    expect(gitCalls(option.seams)).toEqual(["git check-ref-format --branch --upload-pack=/x"]);
    const force = await capture(["wc", "catch-up", "--base", "+main"], [
      { match: "git check-ref-format --branch +main", result: { code: 0 } },
    ]);
    expect(force.code).toBe(2);
    expect(force.err.join("\n")).toMatch(/--base '\+main' looks like a refspec or a force option/);
    expect(gitCalls(force.seams)).toEqual(["git check-ref-format --branch +main"]);
  });

  it("refuses a dirty tree at exit 2, before the fetch", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main"], [
      ...NOTHING_PENDING,
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M dirty.ts\n" } },
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/dirty.ts/);
    expect(gitCalls(result.seams)).not.toContain(FETCH_MAIN);
  });

  it("auto picks REBASE when no commit is on the upstream, and runs it", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      ...NOTHING_PENDING,
      CLEAN,
      FETCHED,
      { match: "git rev-parse HEAD", result: { stdout: "before00\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "after000\n" } },
      BEHIND(3),
      AHEAD(2),
      OWN_COMMITS,
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 1 } },
      { match: "git merge-base --is-ancestor sha2 origin/work", result: { code: 1 } },
      { match: "git rebase origin/main", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(Object.keys(result.doc)).toEqual(["contract", "base", "strategy", "before", "after", "behindBefore", "aheadBefore", "noOp", "conflicted", "resumed", "aborted", "dryRun"]);
    expect(result.doc).toMatchObject({ contract: "nen.wc.catch-up/v0.1", base: "main", strategy: "rebase", before: "before00", after: "after000", behindBefore: 3, aheadBefore: 2, noOp: false, conflicted: [], resumed: false, aborted: false, dryRun: false });
    expect(gitCalls(result.seams)).toContain("git rebase origin/main");
  });

  it("auto picks MERGE when a commit is already on the upstream", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      ...NOTHING_PENDING,
      CLEAN,
      FETCHED,
      HEAD_BEFORE,
      BEHIND(1),
      AHEAD(2),
      OWN_COMMITS,
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 0 } },
      { match: "git merge --no-edit origin/main", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc["strategy"]).toBe("merge");
    expect(gitCalls(result.seams)).toContain("git merge --no-edit origin/main");
    expect(gitCalls(result.seams)).not.toContain("git rebase origin/main");
  });

  it("is a noOp at exit 0 when already up to date, running neither", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "rebase"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(0), AHEAD(4),
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ noOp: true, after: "before00", strategy: "rebase" });
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git rebase") || call.startsWith("git merge"))).toBe(false);
  });

  it("--dry-run prints the line and runs neither", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge", "--dry-run"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("would run: git merge --no-edit origin/main  (1 ahead, 2 behind)");
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git merge"))).toBe(false);
  });

  it("on a conflict: reports every path with both sides, prints the abort line, leaves the tree, exits 1", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "rebase"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git rebase origin/main", result: { code: 1, stderr: "CONFLICT (content): Merge conflict in a.ts" } },
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "a.ts\nb.ts\n" } },
      { match: "git diff --cached --check", result: { code: 0 } },
      { match: "git show :2:a.ts", result: { stdout: "ours a\n" } },
      { match: "git show :3:a.ts", result: { stdout: "theirs a\n" } },
      { match: "git show :2:b.ts", result: { code: 128 } },
      { match: "git show :3:b.ts", result: { stdout: "theirs b\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc["after"]).toBeNull();
    expect(result.doc["conflicted"]).toEqual([
      { path: "a.ts", ours: "ours a\n", theirs: "theirs a\n" },
      { path: "b.ts", ours: null, theirs: "theirs b\n" },
    ]);
    expect(gitCalls(result.seams)).not.toContain("git rebase --abort");
    const text = await capture(["wc", "catch-up", "--base", "main", "--strategy", "rebase"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git rebase origin/main", result: { code: 1 } },
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "a.ts\n" } },
      { match: "git diff --cached --check", result: { code: 0 } },
      { match: "git show :2:a.ts", result: { stdout: "ours a\n" } },
      { match: "git show :3:a.ts", result: { stdout: "theirs a\n" } },
    ]);
    expect(text.code).toBe(1);
    expect(text.out).toContain("to back out: git rebase --abort");
    expect(text.out.join("\n")).toContain("    ours  :\n      ours a\n    theirs:\n      theirs a");
  });

  it("a failure that leaves no conflict is exit 1 with the git error, not a decided outcome", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git merge --no-edit origin/main", result: { code: 128, stderr: "fatal: refusing to merge unrelated histories" } },
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "" } },
      { match: "git diff --cached --check", result: { code: 0 } },
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/unrelated histories/);
  });

  it("RESUMES an in-progress rebase once the resolutions are staged: rebase --continue under GIT_EDITOR=true, resumed: true", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      BASE_OK,
      { match: "git rev-parse --verify --quiet REBASE_HEAD", result: { code: 0, stdout: "abc\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "after000\n" } },
      BEHIND(0),
      AHEAD(2),
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "" } },
      { match: "git diff --cached --check", result: { code: 0 } },
      { match: "git rebase --continue", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ strategy: "rebase", before: "mid00000", after: "after000", resumed: true, aborted: false, conflicted: [] });
    const cont = result.seams.calls.find((call): boolean => call.args.join(" ") === "rebase --continue");
    expect(cont?.env).toEqual({ GIT_EDITOR: "true" });
    // Never a fetch, never a status refusal: the tree is dirty by definition mid-resolution.
    expect(gitCalls(result.seams)).not.toContain(FETCH_MAIN);
    expect(gitCalls(result.seams)).not.toContain("git status --porcelain=v1 -uall");
  });

  it("RESUMES an in-progress merge with git commit --no-edit", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      BASE_OK,
      { match: "git rev-parse --verify --quiet REBASE_HEAD", result: { code: 1 } },
      { match: "git rev-parse --verify --quiet MERGE_HEAD", result: { code: 0, stdout: "abc\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "after000\n" } },
      BEHIND(1),
      AHEAD(2),
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "" } },
      { match: "git diff --cached --check", result: { code: 0 } },
      { match: "git commit --no-edit", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ strategy: "merge", resumed: true, after: "after000" });
  });

  it("does NOT continue over unmerged paths or leftover conflict markers: conflicted[] again, exit 1, abort line", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      BASE_OK,
      { match: "git rev-parse --verify --quiet REBASE_HEAD", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      BEHIND(0),
      AHEAD(2),
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "" } },
      { match: "git diff --cached --check", result: { code: 2, stdout: "a.ts:12: leftover conflict marker\na.ts:20: leftover conflict marker\n" } },
      { match: "git show :2:a.ts", result: { stdout: "<<<<<<< ours\n" } },
      { match: "git show :3:a.ts", result: { stdout: "theirs\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc).toMatchObject({ resumed: false, after: null });
    expect((result.doc["conflicted"] as { path: string }[]).map((c): string => c.path)).toEqual(["a.ts"]);
    expect(gitCalls(result.seams)).not.toContain("git rebase --continue");
  });

  it("a continued rebase that conflicts on a LATER commit reports that conflict at exit 1", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      BASE_OK,
      { match: "git rev-parse --verify --quiet REBASE_HEAD", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      BEHIND(0),
      AHEAD(2),
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "" } },
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "c.ts\n" } },
      { match: "git diff --cached --check", result: { code: 0 } },
      { match: "git rebase --continue", result: { code: 1 } },
      { match: "git show :2:c.ts", result: { stdout: "o\n" } },
      { match: "git show :3:c.ts", result: { stdout: "t\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc["conflicted"]).toEqual([{ path: "c.ts", ours: "o\n", theirs: "t\n" }]);
    expect(result.doc["resumed"]).toBe(false);
  });

  it("refuses a --strategy that disagrees with what is in progress, at exit 2", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      BASE_OK,
      { match: "git rev-parse --verify --quiet REBASE_HEAD", result: { code: 0 } },
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/a rebase is in progress here and --strategy merge/);
  });

  it("--abort backs out the in-progress operation and reports aborted: true; refused when nothing is in progress", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--abort"], [
      BASE_OK,
      { match: "git rev-parse --verify --quiet REBASE_HEAD", result: { code: 1 } },
      { match: "git rev-parse --verify --quiet MERGE_HEAD", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "before00\n" } },
      { match: "git merge --abort", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ strategy: "merge", aborted: true, resumed: false, after: "before00" });
    const dry = await capture(["wc", "catch-up", "--base", "main", "--abort", "--dry-run"], [
      BASE_OK,
      { match: "git rev-parse --verify --quiet REBASE_HEAD", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
    ]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would run: git rebase --abort");
    expect(gitCalls(dry.seams)).not.toContain("git rebase --abort");
    const nothing = await capture(["wc", "catch-up", "--base", "main", "--abort"], NOTHING_PENDING);
    expect(nothing.code).toBe(2);
    expect(nothing.err.join("\n")).toMatch(/nothing to back out of/);
  });
});

// ── nen wc publish (zheref/nen#227) ─────────────────────────────────────────

const ON_WORK = { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/work\n" } };
const WORK_OK = { match: "git check-ref-format --branch feature/work", result: { code: 0 } };
const PUSH_WORK = "git push origin -- refs/heads/feature/work:refs/heads/feature/work";
const PUSH_WORK_U = "git push -u origin -- refs/heads/feature/work:refs/heads/feature/work";
const NO_TRACKING = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { code: 128 } };
const TRACKING = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "origin/feature/work\n" } };
const FETCH_WORK = { match: "git fetch --end-of-options origin refs/heads/feature/work:refs/remotes/origin/feature/work", result: { code: 0 } };

describe("nen wc publish -- push the current branch to origin, never a force, never the trunk", () => {
  it("pushes with -u on --set-upstream when there is no upstream yet, reporting the nen.wc.publish/v0.1 document", async () => {
    const result = await captureJson(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, NO_TRACKING, { match: PUSH_WORK_U, result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(Object.keys(result.doc)).toEqual(["contract", "branch", "remote", "upstreamBefore", "ahead", "needsForce", "pushed", "dryRun"]);
    expect(result.doc).toEqual({ contract: "nen.wc.publish/v0.1", branch: "feature/work", remote: "origin", upstreamBefore: null, ahead: null, needsForce: false, pushed: true, dryRun: false });
  });

  it("fetches the upstream, checks the fast-forward, counts ahead, and pushes without -u", async () => {
    const result = await captureJson(["wc", "publish"], [
      ON_WORK, WORK_OK, TRACKING, WORK_OK, FETCH_WORK,
      { match: "git merge-base --is-ancestor origin/feature/work HEAD", result: { code: 0 } },
      { match: "git rev-list --count origin/feature/work..HEAD", result: { stdout: "3\n" } },
      { match: PUSH_WORK, result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ upstreamBefore: "origin/feature/work", ahead: 3, needsForce: false, pushed: true });
  });

  it("--dry-run prints the push line and pushes nothing", async () => {
    const result = await capture(["wc", "publish", "--set-upstream", "--dry-run"], [ON_WORK, WORK_OK, NO_TRACKING]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([`would run: ${PUSH_WORK_U}  (no upstream yet)`]);
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
  });

  it("reports needsForce: true at exit 1, pushing nothing, when the local branch is not a fast-forward of its upstream", async () => {
    const result = await captureJson(["wc", "publish"], [
      ON_WORK, WORK_OK, TRACKING, WORK_OK, FETCH_WORK,
      { match: "git merge-base --is-ancestor origin/feature/work HEAD", result: { code: 1 } },
      { match: "git rev-list --count origin/feature/work..HEAD", result: { stdout: "1\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc).toMatchObject({ needsForce: true, pushed: false });
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
  });

  it("refuses at exit 2: a detached HEAD, the trunk (branch.base and main/master), a refspec, a force, an omitted --repo", async () => {
    const detached = await capture(["wc", "publish"], [{ match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } }]);
    expect(detached.code).toBe(2);
    expect(detached.err.join("\n")).toMatch(/HEAD is detached/);
    for (const trunk of ["main", "master"]) {
      const result = await capture(["wc", "publish"], [{ match: "git symbolic-ref --short HEAD", result: { stdout: `${trunk}\n` } }]);
      expect(result.code, trunk).toBe(2);
      expect(result.err.join("\n")).toMatch(/is the trunk/);
    }
    // A branch git holds under a name that IS a force once it sits in a push
    // argv (Feitan S1): `+main` passes check-ref-format, is the trunk once
    // normalized, and is refused as the trunk -- before any fetch or push.
    const plusMain = await capture(["wc", "publish"], [{ match: "git symbolic-ref --short HEAD", result: { stdout: "+main\n" } }]);
    expect(plusMain.code).toBe(2);
    expect(plusMain.err.join("\n")).toMatch(/'\+main' is the trunk/);
    expect(gitCalls(plusMain.seams).some((call): boolean => call.startsWith("git push") || call.startsWith("git fetch"))).toBe(false);
    // `+feature` is not the trunk, and is refused as a force shape after git accepted the name.
    const plusFeature = await capture(["wc", "publish"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "+feature\n" } },
      { match: "git check-ref-format --branch +feature", result: { code: 0 } },
    ]);
    expect(plusFeature.code).toBe(2);
    expect(plusFeature.err.join("\n")).toMatch(/'\+feature' looks like a refspec or a force option/);
    // A name git itself rejects is refused with git's answer.
    const rejected = await capture(["wc", "publish"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "bad..name\n" } },
      { match: "git check-ref-format --branch bad..name", result: { code: 1, stderr: "fatal: 'bad..name' is not a valid branch name" } },
    ]);
    expect(rejected.code).toBe(2);
    expect(rejected.err.join("\n")).toMatch(/not a branch name git will accept/);
    // An upstream whose branch half is force-shaped is refused before the fetch.
    const badUpstream = await capture(["wc", "publish"], [
      ON_WORK, WORK_OK,
      { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "origin/+feature/work\n" } },
      { match: "git check-ref-format --branch +feature/work", result: { code: 0 } },
    ]);
    expect(badUpstream.code).toBe(2);
    expect(badUpstream.err.join("\n")).toMatch(/the upstream's branch '\+feature\/work' looks like a refspec/);
    expect(gitCalls(badUpstream.seams).some((call): boolean => call.startsWith("git fetch"))).toBe(false);
    const refspec = await capture(["wc", "publish", "+feature/work:main"], []);
    expect(refspec.code).toBe(2);
    expect(refspec.err.join("\n")).toMatch(/looks like a refspec or a force option/);
    const colon = await capture(["wc", "publish", "a:b"], []);
    expect(colon.code).toBe(2);
    // --force is not a flag this family declares: the strict parser refuses it by name.
    const force = await capture(["wc", "publish", "--force"], []);
    expect(force.code).toBe(2);
    expect(force.err.join("\n")).toMatch(/unknown option '--force'/);
    expect((await capture(["wc", "publish"], [], null)).code).toBe(2);
  });
});
