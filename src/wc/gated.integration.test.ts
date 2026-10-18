// All publications/removals in these tests use fresh disposable file remotes.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import { wcCommand } from "./command.js";
import { scrubbedGitEnv } from "./worktree.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...scrubbedGitEnv(process.env) } });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
function world(options: { message?: string; foreignIdentity?: boolean; redCheck?: boolean } = {}): { root: string; repo: string; remote: string; proved: string; published: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-gated-")); roots.push(root);
  const repo = join(root, "repo"); const remote = join(root, "remote.git"); git(root, "init", "--bare", remote); git(root, "init", "--initial-branch=main", repo);
  git(repo, "config", "user.name", "fixture"); git(repo, "config", "user.email", "fixture@example.invalid"); git(repo, "config", "commit.gpgsign", "false"); git(repo, "config", "core.hooksPath", "/dev/null");
  mkdirSync(join(repo, "nen")); writeFileSync(join(repo, ".gitignore"), ".nen/\n");
  writeFileSync(join(repo, "nen", "workflow.json"), JSON.stringify({ iteration: { checks: ["build", "lint"], lane: "unit" } }));
  const row = (code: number): unknown => ({ exe: process.execPath, argv: ["-e", `process.exit(${code})`] });
  writeFileSync(join(repo, "nen", "contract.json"), JSON.stringify({ project: { defaultLane: "unit", lanes: { unit: { stack: "bun-cli", cwd: "." } }, verbs: { unit: { build: row(options.redCheck ? 1 : 0), lint: row(0) } } } }));
  git(repo, "add", "nen", ".gitignore"); git(repo, "commit", "-m", "base"); git(repo, "remote", "add", "origin", remote); git(repo, "push", "-u", "origin", "main");
  git(repo, "switch", "-c", "feature"); git(repo, "push", "-u", "origin", "feature"); const published = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "own.txt"), "own\n"); git(repo, "add", "own.txt");
  const identity = options.foreignIdentity ? ["-c", "user.email=foreign@example.invalid"] : [];
  git(repo, ...identity, "commit", "-m", options.message ?? "feat: own\n\nHatsu-Agent: builder");
  return { root, repo, remote, proved: git(repo, "rev-parse", "HEAD"), published };
}
async function run(w: ReturnType<typeof world>, extra: string[] = [], seams: Seams = defaultSeams()): Promise<{ code: number; report: { gates: { gate: number; ok: boolean }[]; pushed: boolean }; err: string[] }> {
  const out: string[] = []; const err: string[] = [];
  const code = await runFamily(wcCommand, ["wc", "publish", "--gated", "--base", "main", "--proved", w.proved, "--persona", "builder", "--json", ...extra], w.repo, false, { out: (line) => void out.push(line), err: (line) => void err.push(line) }, seams);
  return { code, report: out.length === 0 ? { gates: [], pushed: false } : JSON.parse(out.join("\n")), err };
}
describe("gated published update", () => {
  it("previews with checks but no push, then publishes only the exact proved head", async () => {
    const w = world(); const preview = await run(w, ["--dry-run"]);
    expect(preview.code, preview.err.join("\n")).toBe(0); expect(preview.report.pushed).toBe(false); expect(git(w.remote, "rev-parse", "refs/heads/feature")).toBe(w.published);
    const result = await run(w); expect(result.code, result.err.join("\n")).toBe(0); expect(result.report.pushed).toBe(true); expect(git(w.remote, "rev-parse", "refs/heads/feature")).toBe(w.proved);
    expect(result.report.gates.map((gate) => gate.gate)).toEqual([1, 2, 3, 4, 4, 5, 6]);
  });
  it.each([{ message: "no trailer" }, { message: "feat: other\n\nHatsu-Agent: other" }, { foreignIdentity: true }])("refuses foreign outgoing provenance without touching the remote: %j", async (options) => {
    const w = world(options); const result = await run(w); expect(result.code).toBe(1); expect(result.report.gates.at(-1)?.gate).toBe(5); expect(git(w.remote, "rev-parse", "refs/heads/feature")).toBe(w.published);
  });
  it("stops at a red iteration check", async () => {
    const w = world({ redCheck: true }); const result = await run(w); expect(result.code).toBe(1); expect(result.report.gates.at(-1)?.gate).toBe(4); expect(git(w.remote, "rev-parse", "refs/heads/feature")).toBe(w.published);
  });
  it("refuses a different proved SHA and a branch tracking its base", async () => {
    const w = world(); const original = w.proved; w.proved = w.published;
    expect((await run(w)).report.gates.at(-1)?.gate).toBe(2); w.proved = original;
    git(w.repo, "branch", "--set-upstream-to=origin/main", "feature"); expect((await run(w)).report.gates.at(-1)?.gate).toBe(3);
    expect(git(w.remote, "rev-parse", "refs/heads/feature")).toBe(w.published);
  });
  it("returns a changed catch-up tree without publishing it", async () => {
    const w = world(); git(w.repo, "switch", "main"); writeFileSync(join(w.repo, "base.txt"), "new base"); git(w.repo, "add", "base.txt"); git(w.repo, "commit", "-m", "base advance"); git(w.repo, "push"); git(w.repo, "switch", "feature");
    const result = await run(w); expect(result.code).toBe(1); expect(result.report.gates.at(-1)?.gate).toBe(1); expect(git(w.repo, "rev-parse", "HEAD")).not.toBe(w.proved); expect(git(w.remote, "rev-parse", "refs/heads/feature")).toBe(w.published);
  });
  it("accepts only an exact clean base merge without its own trailer", async () => {
    const w = world(); git(w.repo, "switch", "main"); writeFileSync(join(w.repo, "base.txt"), "base"); git(w.repo, "add", "base.txt"); git(w.repo, "commit", "-m", "base advance"); git(w.repo, "push"); git(w.repo, "switch", "feature"); git(w.repo, "merge", "--no-edit", "origin/main"); w.proved = git(w.repo, "rev-parse", "HEAD");
    const result = await run(w); expect(result.code, result.err.join("\n")).toBe(0);
  });
  it("does not exempt a merge with extra tree edits from the outgoing trailer requirement", async () => {
    const w = world(); git(w.repo, "switch", "main"); writeFileSync(join(w.repo, "base.txt"), "base"); git(w.repo, "add", "base.txt"); git(w.repo, "commit", "-m", "base advance"); git(w.repo, "push"); git(w.repo, "switch", "feature"); git(w.repo, "merge", "--no-edit", "origin/main");
    writeFileSync(join(w.repo, "own.txt"), "extra merge edit"); git(w.repo, "add", "own.txt"); git(w.repo, "commit", "--amend", "--no-edit"); w.proved = git(w.repo, "rev-parse", "HEAD");
    const result = await run(w); expect(result.code).toBe(1); expect(result.report.gates.at(-1)?.gate).toBe(5); expect(git(w.remote, "rev-parse", "refs/heads/feature")).toBe(w.published);
  });
  it("re-reads HEAD after provenance and never publishes a moved tree", async () => {
    const w = world(); const real = defaultSeams(); let moved = false;
    const seams: Seams = { ...real, run: (command, args, options) => {
      const result = real.run(command, args, options);
      if (!moved && command === "git" && args[0] === "rev-list" && args[1] === "HEAD" && args[2]?.startsWith("^")) { moved = true; git(w.repo, "commit", "--allow-empty", "-m", "feat: moved\n\nHatsu-Agent: builder"); }
      return result;
    } };
    const result = await run(w, [], seams); expect(result.code).toBe(1); expect(result.report.gates.at(-1)?.gate).toBe(6); expect(git(w.remote, "rev-parse", "refs/heads/feature")).toBe(w.published);
  });
  it("refuses malformed proof and first-publish options as wiring", async () => {
    const w = world(); w.proved = "not-a-sha"; expect((await run(w)).code).toBe(2);
    w.proved = git(w.repo, "rev-parse", "HEAD"); expect((await run(w, ["--set-upstream"])).code).toBe(2);
    expect((await run(w, ["--copy-from-core", "owned.txt"])).code).toBe(2);
  });
});
