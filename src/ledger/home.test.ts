// The per-effort ledgers' durable home (zheref/nen#509 AC-3, AC-4, AC-5): the
// git common dir, so a worktree removal keeps the history; an older
// worktree-local ledger is read in place and moved on the next write, never
// shadowed by an empty one. Real git, real temp repositories.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../index.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined } }).trim();
}

function repoWithWorktree(): { core: string; tree: string; common: string } {
  const core = realpathSync(mkdtempSync(join(tmpdir(), "nen-home-")));
  git(core, "init", "-q", "-b", "main");
  git(core, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root");
  const tree = join(core, "wt");
  git(core, "worktree", "add", "-q", "-b", "effort", tree);
  return { core, tree, common: join(core, ".git") };
}

async function nen(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const code = await run(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("per-effort ledgers live in the git common dir (zheref/nen#509)", () => {
  it("AC-3: phase, usage and direct --record written in a worktree survive its removal", async () => {
    const { core, tree, common } = repoWithWorktree();
    expect((await nen(["phase", "begin", "--effort", "e1", "--phase", "rasengan", "--repo", tree])).code).toBe(0);
    expect((await nen(["usage", "record", "--effort", "e1", "--surface", "codex", "--input", "5", "--repo", tree])).code).toBe(0);
    expect(existsSync(join(common, ".nen", "phases", "e1.json"))).toBe(true);
    expect(existsSync(join(common, ".nen", "usage", "e1.json"))).toBe(true);
    expect(existsSync(join(tree, ".nen"))).toBe(false);
    git(core, "worktree", "remove", "--force", tree);
    const show = await nen(["phase", "show", "--effort", "e1", "--repo", core, "--json"]);
    expect(show.code).toBe(0);
    expect((JSON.parse(show.out) as { phases: { phase: string }[] }).phases.map((p): string => p.phase)).toEqual(["rasengan"]);
    const usage = await nen(["usage", "show", "--effort", "e1", "--repo", core, "--json"]);
    expect((JSON.parse(usage.out) as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("AC-3: the direct record lands in the common dir too", async () => {
    const { tree, common } = repoWithWorktree();
    const record = join(common, ".nen", "direct", "NN-IS-%2312.json");
    mkdirSync(join(common, ".nen", "direct"), { recursive: true });
    writeFileSync(record, JSON.stringify({ contract: "nen.direct.resolve/v0.1", effortId: "NN-IS-#12" }));
    const answered = await nen(["direct", "answer", "--record", "NN-IS-#12", "--answer", "stop", "--repo", tree]);
    expect(answered.code).toBe(0);
    expect((JSON.parse(readFileSync(record, "utf8")) as { decision: { answer: string } }).decision.answer).toBe("stop");
  });

  it("AC-4: an older worktree-local ledger is read in place with its path named, then moved on the next write", async () => {
    const { tree, common } = repoWithWorktree();
    const old = join(tree, ".nen", "phases", "e2.json");
    mkdirSync(join(tree, ".nen", "phases"), { recursive: true });
    writeFileSync(old, JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "e2", phases: [{ phase: "breath", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000, exitCode: 0, surface: null, model: null, note: null, steps: [], dial: null }] }));
    const show = await nen(["phase", "show", "--effort", "e2", "--repo", tree]);
    expect(show.code).toBe(0);
    expect(show.err).toContain(`read the older worktree-local ledger ${old}`);
    expect(show.out).toContain("breath");
    expect(existsSync(old)).toBe(true);
    const begin = await nen(["phase", "begin", "--effort", "e2", "--phase", "kokusen", "--repo", tree]);
    expect(begin.code).toBe(0);
    expect(begin.err).toContain(`moved the older worktree-local ledger ${old}`);
    expect(existsSync(old)).toBe(false);
    const moved = JSON.parse(readFileSync(join(common, ".nen", "phases", "e2.json"), "utf8")) as { phases: { phase: string }[] };
    expect(moved.phases.map((p): string => p.phase)).toEqual(["breath", "kokusen"]);
  });

  it("AC-4: a ledger in both homes is refused at exit 1 naming both, never merged or shadowed", async () => {
    const { tree, common } = repoWithWorktree();
    const doc = JSON.stringify({ contract: "nen.usage.ledger/v0.1", effort: "e3", entries: [] });
    mkdirSync(join(tree, ".nen", "usage"), { recursive: true });
    mkdirSync(join(common, ".nen", "usage"), { recursive: true });
    writeFileSync(join(tree, ".nen", "usage", "e3.json"), doc);
    writeFileSync(join(common, ".nen", "usage", "e3.json"), doc);
    const result = await nen(["usage", "show", "--effort", "e3", "--repo", tree]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("in more than one place");
    expect(result.err).toContain(join(tree, ".nen", "usage", "e3.json"));
  });

  it("AC-5: outside git the ledger stays under --repo", async () => {
    const plain = mkdtempSync(join(tmpdir(), "nen-home-plain-"));
    expect((await nen(["phase", "begin", "--effort", "e4", "--phase", "breath", "--repo", plain])).code).toBe(0);
    expect(existsSync(join(plain, ".nen", "phases", "e4.json"))).toBe(true);
  });

  it("AC-6: report data reads the common-dir ledgers, and --effort scopes them", async () => {
    const { tree } = repoWithWorktree();
    await nen(["phase", "begin", "--effort", "mine", "--phase", "breath", "--repo", tree]);
    await nen(["phase", "begin", "--effort", "theirs", "--phase", "rasengan", "--repo", tree]);
    const all = await nen(["report", "data", "--repo", tree, "--base", "main", "--json"]);
    expect(all.code).toBe(0);
    expect((JSON.parse(all.out) as { phases: { effort: string }[] }).phases.map((p): string => p.effort).sort()).toEqual(["mine", "theirs"]);
    const scoped = await nen(["report", "data", "--repo", tree, "--base", "main", "--effort", "mine", "--json"]);
    expect((JSON.parse(scoped.out) as { phases: { effort: string }[] }).phases.map((p): string => p.effort)).toEqual(["mine"]);
  });

  it("SEC-7: a symlink at an older ledger's name is refused, never read through and never moved", async () => {
    const { tree, common } = repoWithWorktree();
    const outside = join(mkdtempSync(join(tmpdir(), "nen-home-outside-")), "secret.json");
    writeFileSync(outside, JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "e5", phases: [] }));
    mkdirSync(join(tree, ".nen", "phases"), { recursive: true });
    symlinkSync(outside, join(tree, ".nen", "phases", "e5.json"));
    const show = await nen(["phase", "show", "--effort", "e5", "--repo", tree]);
    expect(show.code).toBe(1);
    expect(show.err).toContain("is a symbolic link");
    expect((await nen(["phase", "begin", "--effort", "e5", "--phase", "breath", "--repo", tree])).code).toBe(1);
    expect(existsSync(join(common, ".nen", "phases", "e5.json"))).toBe(false);
    expect(lstatSync(join(tree, ".nen", "phases", "e5.json")).isSymbolicLink()).toBe(true);
  });

  it("SEC-7: a durable family directory that links out of the common dir is refused", async () => {
    const { tree, common } = repoWithWorktree();
    const elsewhere = mkdtempSync(join(tmpdir(), "nen-home-elsewhere-"));
    mkdirSync(join(common, ".nen"), { recursive: true });
    symlinkSync(elsewhere, join(common, ".nen", "usage"));
    const result = await nen(["usage", "record", "--effort", "e6", "--surface", "codex", "--input", "1", "--repo", tree]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("outside the git common directory");
    expect(existsSync(join(elsewhere, "e6.json"))).toBe(false);
  });

  it("a refused begin moves nothing: flags are checked before an older ledger is located", async () => {
    const { tree } = repoWithWorktree();
    const old = join(tree, ".nen", "phases", "e7.json");
    mkdirSync(join(tree, ".nen", "phases"), { recursive: true });
    writeFileSync(old, JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "e7", phases: [] }));
    expect((await nen(["phase", "begin", "--effort", "e7", "--repo", tree])).code).toBe(2);
    expect(existsSync(old)).toBe(true);
  });

  it("report data skips, with a warning, an effort whose ledger sits in both homes", async () => {
    const { tree, common } = repoWithWorktree();
    const doc = JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "dup", phases: [{ phase: "breath", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null }] });
    mkdirSync(join(tree, ".nen", "phases"), { recursive: true });
    mkdirSync(join(common, ".nen", "phases"), { recursive: true });
    writeFileSync(join(tree, ".nen", "phases", "dup.json"), doc);
    writeFileSync(join(common, ".nen", "phases", "dup.json"), doc);
    const result = await nen(["report", "data", "--repo", tree, "--base", "main", "--json"]);
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out) as { phases: unknown[] }).phases).toEqual([]);
    expect(result.err).toContain("one effort's ledger in two homes");
  });

  it("a refused begin or end because of the ledger's state moves nothing (Bugbot on #516)", async () => {
    const { tree } = repoWithWorktree();
    const old = join(tree, ".nen", "phases", "e8.json");
    mkdirSync(join(tree, ".nen", "phases"), { recursive: true });
    writeFileSync(old, JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "e8", phases: [{ phase: "breath", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, durationMs: null, exitCode: null, surface: null, model: null, note: null, steps: [], dial: null }] }));
    expect((await nen(["phase", "begin", "--effort", "e8", "--phase", "breath", "--repo", tree])).code).toBe(2);
    expect((await nen(["phase", "end", "--effort", "e8", "--phase", "kokusen", "--repo", tree])).code).toBe(2);
    expect(existsSync(old)).toBe(true);
    expect((await nen(["phase", "end", "--effort", "e8", "--repo", tree])).code).toBe(0);
    expect(existsSync(old)).toBe(false);
  });

  it("SEC-7: a symlinked older ledger directory is refused, never scanned (Bugbot on #516)", async () => {
    const { tree, common } = repoWithWorktree();
    const other = mkdtempSync(join(tmpdir(), "nen-home-otherdir-"));
    writeFileSync(join(other, "e9.json"), JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "e9", phases: [] }));
    mkdirSync(join(tree, ".nen"), { recursive: true });
    symlinkSync(other, join(tree, ".nen", "phases"));
    const result = await nen(["phase", "show", "--effort", "e9", "--repo", tree]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("is a symbolic link");
    expect(existsSync(join(common, ".nen", "phases", "e9.json"))).toBe(false);
  });
});
