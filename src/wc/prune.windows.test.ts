// Git's config path API is not Node's native Windows device-path API.
// Exact CI Git source: git-for-windows/git v2.53.0.windows.2 compat/mingw.c
// mingw_access()/mingw_fopen() specially support /dev/null, not \\.\nul.
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeams, type CommandResult, type RunOptions } from "../seam/exec.js";
import { scrubbedGitEnv } from "./worktree.js";
import { prune } from "./prune.js";

vi.mock("node:os", async () => ({ ...await vi.importActual<typeof import("node:os")>("node:os"), devNull: "\\\\.\\nul" }));
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const env = { ...process.env, ...scrubbedGitEnv(process.env) };
const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`disposable git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
};
const root = (): string => { const path = mkdtempSync(join(tmpdir(), "nen-prune-windows-")); roots.push(path); return path; };

describe("isolated prune Git initialization portability", () => {
  it("uses Git-compatible empty config paths even when Node exposes a native Windows device path", () => {
    const path = root(); const repo = join(path, "repo"); const remote = join(path, "remote.git");
    git(path, "init", "--initial-branch=main", repo); git(path, "init", "--bare", remote);
    git(repo, "config", "user.name", "fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgsign", "false"); git(repo, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(repo, "seed"), "fixture"); git(repo, "add", "seed"); git(repo, "commit", "-m", "seed");
    git(repo, "branch", "topic"); git(repo, "remote", "add", "origin", remote); git(repo, "push", "origin", "topic");
    const real = defaultSeams(); let incompatibleConfig = false;
    const report = prune({ ...real, platform: "win32", run: (command, args, options) => {
      if (command === "git" && args[0] === "init" && [options?.env?.["GIT_CONFIG_GLOBAL"], options?.env?.["GIT_CONFIG_SYSTEM"]].includes("\\\\.\\nul")) {
        incompatibleConfig = true;
        // Reproduce the documented Git-for-Windows config-access boundary.
        return { code: 128, stdout: "", stderr: "disposable device config: Invalid argument", spawnFailed: false };
      }
      return real.run(command, args, options);
    } }, repo, [{ kind: "remote-branch", remote: "origin", ref: "refs/heads/topic", base: "refs/heads/main" }], false, "main");
    expect(incompatibleConfig).toBe(false);
    expect(report.items[0]?.status).toBe("removed"); expect(git(remote, "for-each-ref", "refs/heads/topic")).toBe("");
  });

  it("records native disposable initialization compatibility without logging config or authentication stderr", () => {
    const path = root(); const observations = ["\\\\.\\nul", "/dev/null"].map((config, index) => {
      const result = spawnSync("git", ["init", "--bare", "--template=", join(path, `bare-${index}`)], {
        cwd: path, env: { ...env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" }, encoding: "utf8",
      });
      return { kind: index === 0 ? "node-windows-device" : "git-portable-null", code: result.status, classification: result.status === 0 ? "success" : /invalid argument/i.test(result.stderr ?? "") ? "invalid-argument" : "other-failure" };
    });
    console.info("disposable Git init compatibility", JSON.stringify({ platform: process.platform, observations }));
    expect(observations[1]).toMatchObject({ code: 0, classification: "success" });
  });
  it.each(["space", "period", "rewritten-space"])("refuses unbindable Windows endpoint components before a native path layer could select an unlisted peer: %s", (variant) => {
    const path = root(); const repo = join(path, "repo"); const peer = join(path, "peer.git");
    git(path, "init", "--initial-branch=main", repo); git(path, "init", "--bare", peer);
    git(repo, "config", "user.name", "fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgsign", "false"); git(repo, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(repo, "seed"), "fixture"); git(repo, "add", "seed"); git(repo, "commit", "-m", "seed");
    git(repo, "branch", "topic"); git(repo, "remote", "add", "origin", peer); git(repo, "push", "origin", "topic");
    const ambiguous = peer + (variant === "period" ? "." : " ");
    git(repo, "remote", "set-url", "--push", "origin", variant === "rewritten-space" ? "fixture-alias" : ambiguous);
    if (variant === "rewritten-space") git(repo, "config", `url.${ambiguous}.insteadOf`, "fixture-alias");
    const real = defaultSeams(); const remoteCalls: string[][] = [];
    const seams = { ...real, platform: "win32" as const, run: (command: string, args: readonly string[], options?: RunOptions): CommandResult => {
      if (command === "git" && (args[0] === "push" || args[0] === "ls-remote" && args.includes("--heads"))) {
        remoteCalls.push([...args]);
        // Model the unsafe native normalization boundary with real paired Git
        // repositories: no call may reach it, even if it would select the peer.
        return real.run(command, args.map((arg) => arg === ambiguous ? peer : arg), options);
      }
      return real.run(command, args, options);
    } };
    const plan = [{ kind: "remote-branch" as const, remote: "origin", ref: "refs/heads/topic", base: "refs/heads/main" }];
    const reports = [prune(seams, repo, plan, true, "main"), prune(seams, repo, plan, false, "main")];
    for (const report of reports) { expect(report.items[0]?.status).toBe("refused"); expect(report.items[0]?.message).toMatch(/path normalization/); }
    expect(remoteCalls).toEqual([]); expect(git(peer, "for-each-ref", "--format=%(refname)", "refs/heads/topic")).toBe("refs/heads/topic");
  });

  it.each(["C:peer.git", "C:peer.git ", "C:peer.git."].flatMap((endpoint) => [false, true].map((rewrite) => ({ endpoint, rewrite }))))("refuses drive-relative authority before remote access: $endpoint rewritten=$rewrite", ({ endpoint, rewrite }) => {
    const path = root(); const repo = join(path, "repo");
    git(path, "init", "--initial-branch=main", repo);
    git(repo, "config", "user.name", "fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "commit.gpgsign", "false"); git(repo, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(repo, "seed"), "fixture"); git(repo, "add", "seed"); git(repo, "commit", "-m", "seed");
    git(repo, "remote", "add", "origin", rewrite ? "fixture-alias" : endpoint);
    if (rewrite) git(repo, "config", `url.${endpoint}.insteadOf`, "fixture-alias");
    const real = defaultSeams(); const remoteCalls: string[][] = [];
    const oid = git(repo, "rev-parse", "HEAD");
    const seams = { ...real, platform: "win32" as const, run: (command: string, args: readonly string[], options?: RunOptions): CommandResult => {
      if (command === "git" && args[0] === "ls-remote" && args.includes("--heads")) {
        remoteCalls.push([...args]);
        // No native access: expose the classification gap without a network
        // or a destructive endpoint. Both modes must refuse before this seam.
        const stdout = `${oid}\trefs/heads/topic\n`;
        return { code: 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", spawnFailed: false };
      }
      if (command === "git" && args[0] === "push") {
        remoteCalls.push([...args]); return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      }
      return real.run(command, args, options);
    } };
    const plan = [{ kind: "remote-branch" as const, remote: "origin", ref: "refs/heads/topic", base: "refs/heads/main" }];
    const reports = [prune(seams, repo, plan, true, "main"), prune(seams, repo, plan, false, "main")];
    for (const report of reports) { expect(report.items[0]?.status).toBe("refused"); expect(report.items[0]?.message).toMatch(/drive-relative/); }
    expect(remoteCalls).toEqual([]);
  });

});
