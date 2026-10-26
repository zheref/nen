// src/wc/ahead.integration.test.ts -- `nen wc ahead` (zheref/nen#551) against
// real throwaway repositories: the four verdicts, their exit codes, and that
// nothing is fetched or written.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import { wcCommand } from "./command.js";
import { parseNumstat, type AheadReport } from "./ahead.js";
import { scrubbedGitEnv } from "./worktree.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = { ...process.env, ...scrubbedGitEnv(process.env) };
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
function commit(repo: string, file: string, text: string, message: string): string {
  writeFileSync(join(repo, file), text); git(repo, "add", file); git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}
function world(): { root: string; repo: string; reviewed: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-ahead-")); roots.push(root);
  const repo = join(root, "repo");
  git(root, "init", "--initial-branch=main", repo);
  git(repo, "config", "user.email", "fixture@example.invalid"); git(repo, "config", "user.name", "fixture"); git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "core.hooksPath", "/dev/null");
  commit(repo, "seed.txt", "seed\n", "seed");
  git(repo, "switch", "-c", "topic");
  const reviewed = commit(repo, "a.txt", "one\n", "reviewed");
  return { root, repo, reviewed };
}
async function run(repo: string, flags: readonly string[], json = true, seams: Seams = defaultSeams()): Promise<{ code: number; out: string[]; err: string; report: AheadReport | null }> {
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (line) => void out.push(line), err: (line) => void err.push(line) };
  const code = await runFamily(wcCommand, ["wc", "ahead", "--repo", repo, ...(json ? ["--json"] : []), ...flags], repo, json, io, seams);
  return { code, out, err: err.join("\n"), report: json && out.length > 0 ? JSON.parse(out.join("\n")) as AheadReport : null };
}

describe("wc ahead -- commits beyond a named reviewed head, real repositories", () => {
  it("AC-1: counts the commits beyond an ancestor head, with its full id and the diff stat, exit 0", async () => {
    const w = world();
    commit(w.repo, "a.txt", "one\ntwo\n", "second");
    const tip = commit(w.repo, "b.txt", "x\ny\nz\n", "third");
    const short = w.reviewed.slice(0, 8);
    const result = await run(w.repo, ["--of", short]);
    expect(result.code).toBe(0);
    expect(result.report).toEqual({ verdict: "ahead", of: short, reviewedHead: w.reviewed, head: "HEAD", headSha: tip, ahead: 2, files: 2, insertions: 4, deletions: 0, reason: null });
    const text = await run(w.repo, ["--of", short], false);
    expect(text.code).toBe(0);
    expect(text.out).toEqual([`verdict: ahead 2`, `reviewed head: ${w.reviewed} (--of ${short})`, `head: ${tip} (--head HEAD)`, "diff: 2 file(s), +4 -0"]);
  });

  it("reads --head instead of HEAD, and counts a merge's commits like any other", async () => {
    const w = world();
    git(w.repo, "switch", "main"); commit(w.repo, "m.txt", "m\n", "trunk moves");
    git(w.repo, "switch", "topic"); git(w.repo, "merge", "--no-ff", "--no-edit", "main");
    const merged = git(w.repo, "rev-parse", "HEAD");
    git(w.repo, "switch", "main");
    const result = await run(w.repo, ["--of", w.reviewed, "--head", "topic"]);
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ verdict: "ahead", head: "topic", headSha: merged, ahead: 2, files: 1, insertions: 1, deletions: 0 });
  });

  it("is even, never ahead 0 at exit 0, when the head is the reviewed head: exit 3", async () => {
    const w = world();
    const result = await run(w.repo, ["--of", w.reviewed]);
    expect(result.code).toBe(3);
    expect(result.report).toMatchObject({ verdict: "even", reviewedHead: w.reviewed, headSha: w.reviewed, ahead: 0, files: 0, insertions: 0, deletions: 0, reason: null });
    const text = await run(w.repo, ["--of", "topic"], false);
    expect(text.code).toBe(3);
    expect(text.out[0]).toBe("verdict: even (no commit beyond the reviewed head; nothing new to review)");
  });

  it("AC-2: is diverged, never a count, after a force-push or a rebase, and behind the reviewed head: exit 1", async () => {
    const w = world();
    git(w.repo, "reset", "--hard", "HEAD~1"); commit(w.repo, "a.txt", "rewritten\n", "rewritten");
    const rewritten = await run(w.repo, ["--of", w.reviewed]);
    expect(rewritten.code).toBe(1);
    expect(rewritten.report).toMatchObject({ verdict: "diverged", reviewedHead: w.reviewed, ahead: null, files: null, insertions: null, deletions: null });
    expect(rewritten.report?.reason).toContain("not an ancestor");
    const w2 = world(); commit(w2.repo, "b.txt", "b\n", "later"); const later = git(w2.repo, "rev-parse", "HEAD");
    git(w2.repo, "reset", "--hard", w2.reviewed);
    const behind = await run(w2.repo, ["--of", later], false);
    expect(behind.code).toBe(1);
    expect(behind.out[0]).toMatch(/^verdict: diverged \(.* is not an ancestor of /);
    expect(behind.out.some((line) => line.startsWith("diff:"))).toBe(false);
  });

  it("AC-3: a head the clone does not hold is unreadable -- distinct from zero, verdict printed, exit 2, nothing fetched", async () => {
    const w = world();
    const calls: string[][] = []; const real = defaultSeams();
    const seams: Seams = { ...real, run: (command, args, options) => { if (command === "git") calls.push([...args]); return real.run(command, args, options); } };
    const absent = "0123456789abcdef0123456789abcdef01234567";
    const result = await run(w.repo, ["--of", absent], true, seams);
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({ verdict: "unreadable", of: absent, reviewedHead: null, ahead: null, files: null });
    expect(result.report?.reason).toContain("does not hold --of");
    expect(calls.some((args) => ["fetch", "pull", "ls-remote"].includes(args[2] ?? ""))).toBe(false);
    const text = await run(w.repo, ["--of", "no-such-branch"], false);
    expect(text.code).toBe(2);
    expect(text.out[0]).toMatch(/^verdict: unreadable \(the clone does not hold --of 'no-such-branch'.*; never read as nothing new\)$/);
    const head = await run(w.repo, ["--of", w.reviewed, "--head", "gone"]);
    expect(head).toMatchObject({ code: 2, report: { verdict: "unreadable", reviewedHead: w.reviewed, headSha: null } });
  });

  it("AC-4: the exit code and the verdict word distinguish ahead, even, diverged and unreadable", async () => {
    const w = world();
    const ahead = (await run(w.repo, ["--of", "main"]));
    const even = (await run(w.repo, ["--of", w.reviewed]));
    const unreadable = (await run(w.repo, ["--of", "nope"]));
    git(w.repo, "switch", "--orphan", "island"); commit(w.repo, "i.txt", "i\n", "island");
    const diverged = (await run(w.repo, ["--of", w.reviewed]));
    const seen = [ahead, even, diverged, unreadable].map((r) => [r.report?.verdict, r.code]);
    expect(seen).toEqual([["ahead", 0], ["even", 3], ["diverged", 1], ["unreadable", 2]]);
  });

  it("refuses at exit 2, with no verdict, a missing --of, a dash-led ref, a non-repository, another verb's flag and a stray positional", async () => {
    const w = world();
    const missing = await run(w.repo, []);
    expect(missing.code).toBe(2); expect(missing.out).toEqual([]); expect(missing.err).toContain("--of <reviewed-head> is required");
    const dashed = await run(w.repo, ["--of=--all"]);
    expect(dashed.code).toBe(2); expect(dashed.err).toContain("starts with '-'");
    const dashedHead = await run(w.repo, ["--of", "main", "--head=-x"]);
    expect(dashedHead.code).toBe(2); expect(dashedHead.err).toContain("starts with '-'");
    const notRepo = mkdtempSync(join(tmpdir(), "nen-ahead-norepo-")); roots.push(notRepo);
    const plain = await run(notRepo, ["--of", "main"]);
    expect(plain.code).toBe(2); expect(plain.out).toEqual([]); expect(plain.err).toContain("is not a git checkout");
    for (const flag of [["--base", "main"], ["--efforts", "a,b"], ["--dry-run"]]) {
      const foreign = await run(w.repo, ["--of", "main", ...flag]);
      expect(foreign.code, flag.join(" ")).toBe(2); expect(foreign.out).toEqual([]);
    }
    const out: string[] = []; const err: string[] = [];
    const io: Io = { out: (line) => void out.push(line), err: (line) => void err.push(line) };
    expect(await runFamily(wcCommand, ["wc", "ahead", "extra", "--repo", w.repo, "--of", "main"], w.repo, false, io, defaultSeams())).toBe(2);
    expect(await runFamily(wcCommand, ["wc", "classify", "--repo", w.repo, "--of", "main"], w.repo, false, io, defaultSeams())).toBe(2);
    expect(err.join("\n")).toContain("only 'wc ahead' takes it");
  });
});

describe("parseNumstat", () => {
  it("sums text files, counts a binary file with no lines, and refuses a line it cannot read", () => {
    expect(parseNumstat("3\t1\ta.txt\0-\t-\timg.png\0")).toEqual({ files: 2, insertions: 3, deletions: 1 });
    expect(parseNumstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
    expect(parseNumstat("garbage\0")).toBeNull();
  });
});
