// Every write/deletion here is inside a fresh throwaway clone and bare remote.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import { wcCommand } from "./command.js";
import { parsePrunePlan, type PruneReport } from "./prune.js";
import { scrubbedGitEnv } from "./worktree.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const env = { ...process.env, ...scrubbedGitEnv(process.env) };
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
function world(): { root: string; repo: string; remote: string; tree: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-prune-")); roots.push(root);
  const repo = join(root, "repo"); const remote = join(root, "remote.git"); const tree = join(root, "topic-tree");
  git(root, "init", "--bare", remote);
  git(root, "init", "--initial-branch=main", repo);
  git(repo, "config", "user.email", "fixture@example.invalid"); git(repo, "config", "user.name", "fixture"); git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "core.hooksPath", "/dev/null");
  writeFileSync(join(repo, "seed.txt"), "seed\n"); git(repo, "add", "seed.txt"); git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", remote); git(repo, "push", "-u", "origin", "main");
  git(repo, "branch", "topic"); git(repo, "push", "origin", "topic");
  return { root, repo, remote, tree };
}
async function run(w: ReturnType<typeof world>, items: unknown, flags: string[] = [], seams: Seams = defaultSeams()): Promise<{ code: number; report: PruneReport | null; err: string }> {
  const file = join(w.root, "plan.json"); writeFileSync(file, JSON.stringify(items));
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (line) => void out.push(line), err: (line) => void err.push(line) };
  const code = await runFamily(wcCommand, ["wc", "prune", "--plan", file, "--json", ...flags], w.repo, false, io, seams);
  return { code, report: out.length === 0 ? null : JSON.parse(out.join("\n")) as PruneReport, err: err.join("\n") };
}
const base = "refs/remotes/origin/main";
const local = { kind: "local-branch", ref: "refs/heads/topic", base };
const remoteItem = { kind: "remote-branch", remote: "origin", ref: "refs/heads/topic", base };
const tracking = { kind: "remote-ref", remote: "origin", ref: "refs/remotes/origin/topic", base };

describe("wc prune -- explicit targets, real disposable repositories", () => {
  it("defaults to a dry run with no write commands, refs or directories changed", async () => {
    const w = world(); git(w.repo, "worktree", "add", w.tree, "topic");
    const before = git(w.repo, "show-ref"); const calls: string[][] = [];
    const real = defaultSeams(); const seams: Seams = { ...real, run: (command, args, options) => { if (command === "git") calls.push([...args]); return real.run(command, args, options); } };
    const result = await run(w, [{ kind: "worktree", path: w.tree, base }, local], [], seams);
    expect(result.code).toBe(0); expect(result.report?.dryRun).toBe(true);
    expect(result.report?.items.map((i) => i.status)).toEqual(["would-remove", "would-remove"]);
    expect(result.report?.freedBytes).toBe(0); expect(existsSync(w.tree)).toBe(true); expect(git(w.repo, "show-ref")).toBe(before);
    expect(calls.some((a) => ["push", "fetch", "update-ref", "branch"].includes(a[0] ?? "") || a[0] === "worktree" && a[1] !== "list")).toBe(false);
  });
  it("removes only listed worktree and local branch, and measures logical bytes truthfully", async () => {
    const w = world(); git(w.repo, "worktree", "add", w.tree, "topic"); git(w.repo, "branch", "keep");
    const expectedBytes = lstatSync(join(w.tree, ".git")).size + readFileSync(join(w.tree, "seed.txt")).length;
    const result = await run(w, [{ kind: "worktree", path: w.tree, base }, local], ["--run"]);
    expect(result.code).toBe(0); expect(result.report?.items.map((i) => i.status)).toEqual(["removed", "removed"]);
    expect(result.report?.freedBytes).toBe(expectedBytes); expect(result.report?.physicalFreedBytes).toBeNull();
    expect(existsSync(w.tree)).toBe(false); expect(git(w.repo, "branch", "--list", "topic")).toBe("");
    expect(git(w.repo, "branch", "--list", "keep")).toContain("keep"); expect(git(w.remote, "show-ref", "refs/heads/topic")).toContain("topic");
  });
  it("deletes only a named remote branch, preserving an unlisted remote branch and tracking ref", async () => {
    const w = world(); git(w.repo, "branch", "keep"); git(w.repo, "push", "origin", "keep");
    const beforeTracking = git(w.repo, "show-ref", "refs/remotes/origin/topic");
    const result = await run(w, [remoteItem], ["--run"]);
    expect(result.code).toBe(0); expect(result.report?.items[0]?.status).toBe("removed");
    expect(git(w.repo, "ls-remote", "--heads", "origin", "refs/heads/topic")).toBe("");
    expect(git(w.remote, "show-ref", "refs/heads/keep")).toContain("keep");
    expect(git(w.repo, "show-ref", "refs/remotes/origin/topic")).toBe(beforeTracking);
    expect(result.report?.freedBytes).toBe(0);
  });
  it("observes the actual push URL and retains an unmerged destination even when the fetch branch is merged", async () => {
    const w = world(); const pushRemote = join(w.root, "push.git"); git(w.root, "init", "--bare", pushRemote);
    git(w.repo, "switch", "topic"); writeFileSync(join(w.repo, "new.txt"), "unmerged"); git(w.repo, "add", "new.txt"); git(w.repo, "commit", "-m", "unmerged destination");
    const tip = git(w.repo, "rev-parse", "HEAD"); git(w.repo, "push", pushRemote, "topic"); git(w.repo, "switch", "main");
    git(w.repo, "remote", "set-url", "--push", "origin", pushRemote);
    const result = await run(w, [remoteItem], ["--run"]);
    expect(result.code).toBe(2); expect(result.report?.items[0]?.message).toMatch(/not merged/);
    expect(git(pushRemote, "rev-parse", "refs/heads/topic")).toBe(tip);
    expect(git(w.remote, "rev-parse", "refs/heads/topic")).toBe(git(w.repo, "rev-parse", "main"));
  });
  it("removes only an explicitly named stale tracking ref, never a live one or remote HEAD", async () => {
    const w = world(); const live = await run(w, [tracking], ["--run"]);
    expect(live.code).toBe(2); expect(live.report?.items[0]?.message).toMatch(/still exists/);
    git(w.remote, "update-ref", "-d", "refs/heads/topic");
    const result = await run(w, [tracking], ["--run"]); expect(result.code).toBe(0);
    expect(git(w.repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/topic")).toBe("");
    const head = await run(w, [{ ...tracking, ref: "refs/remotes/origin/HEAD" }], ["--run"]); expect(head.code).toBe(2);
  });
  it("refuses current/primary, checked-out, locked, dirty, ignored and unmerged worktrees", async () => {
    const w = world(); git(w.repo, "worktree", "add", w.tree, "topic");
    for (const items of [[{ kind: "worktree", path: w.repo, base }], [local]]) expect((await run(w, items, ["--run"])).code).toBe(2);
    git(w.repo, "worktree", "lock", w.tree); expect((await run(w, [{ kind: "worktree", path: w.tree, base }], ["--run"])).code).toBe(2); git(w.repo, "worktree", "unlock", w.tree);
    writeFileSync(join(w.tree, "untracked"), "retain"); expect((await run(w, [{ kind: "worktree", path: w.tree, base }], ["--run"])).code).toBe(2); rmSync(join(w.tree, "untracked"));
    writeFileSync(join(w.repo, ".git", "info", "exclude"), "ignored\n"); writeFileSync(join(w.tree, "ignored"), "retain");
    expect((await run(w, [{ kind: "worktree", path: w.tree, base }], ["--run"])).report?.items[0]?.message).toMatch(/dirt/); rmSync(join(w.tree, "ignored"));
    writeFileSync(join(w.tree, "seed.txt"), "new\n"); git(w.tree, "add", "seed.txt"); git(w.tree, "commit", "-m", "unpublished");
    const result = await run(w, [{ kind: "worktree", path: w.tree, base }], ["--run"]); expect(result.code).toBe(2); expect(result.report?.items[0]?.message).toMatch(/not merged/); expect(existsSync(w.tree)).toBe(true);
  });
  it("refuses unmerged local/remote refs, protected bases and symbolic refs without deleting peers", async () => {
    const w = world(); git(w.repo, "switch", "topic"); writeFileSync(join(w.repo, "new.txt"), "new"); git(w.repo, "add", "new.txt"); git(w.repo, "commit", "-m", "unmerged"); git(w.repo, "push", "origin", "topic"); git(w.repo, "switch", "main");
    const result = await run(w, [local, remoteItem, { ...local, ref: "refs/heads/main" }], ["--run"]);
    expect(result.code).toBe(2); expect(result.report?.items.every((i) => i.status === "refused")).toBe(true);
    git(w.repo, "symbolic-ref", "refs/remotes/origin/alias", "refs/remotes/origin/main");
    expect((await run(w, [{ ...tracking, ref: "refs/remotes/origin/alias" }], ["--run"])).code).toBe(2);
    expect(git(w.repo, "branch", "--list", "topic")).toContain("topic");
  });
  it("rejects malformed plans/refs and conflicting flags whole before any deletion", async () => {
    const w = world();
    for (const value of [{}, [{ kind: "anything", ref: "topic" }], [{ ...local, typo: true }], [local, { ...local, ref: "refs/heads/bad..ref" }], [{ ...remoteItem, remote: "--force" }], [{ kind: "remote-ref", ref: tracking.ref, base }]]) {
      const result = await run(w, value, ["--run"]); expect(result.code).toBe(2); expect(result.report).toBeNull(); expect(git(w.repo, "branch", "--list", "topic")).toContain("topic");
    }
    expect((await run(w, [local], ["--run", "--dry-run"])).code).toBe(2);
    expect((await run(w, [local], ["--base", "main"])).code).toBe(2);
  });
  it("reports absent refs without writes and rejects bases listed for removal", async () => {
    const w = world();
    const missing = await run(w, [{ ...local, ref: "refs/heads/absent" }, { ...tracking, ref: "refs/remotes/origin/absent" }, { ...remoteItem, ref: "refs/heads/absent" }], ["--run"]);
    expect(missing.code).toBe(0); expect(missing.report?.items.map((item) => item.status)).toEqual(["missing", "missing", "missing"]);
    expect(missing.report?.freedBytes).toBe(0);
    const conflict = await run(w, [{ ...local, base: "refs/heads/keep" }, { ...local, ref: "refs/heads/keep" }], ["--run"]);
    expect(conflict.code).toBe(2); expect(conflict.report?.items[0]?.message).toMatch(/itself listed/);
    expect(git(w.repo, "branch", "--list", "topic")).toContain("topic");
  });
  it("refuses multiple push destinations and preserves every remote branch", async () => {
    const w = world(); git(w.repo, "remote", "set-url", "--add", "--push", "origin", w.remote); git(w.repo, "remote", "set-url", "--add", "--push", "origin", join(w.root, "other.git"));
    const result = await run(w, [remoteItem], ["--run"]);
    expect(result.code).toBe(2); expect(result.report?.items[0]?.message).toMatch(/exactly one/);
    expect(git(w.remote, "show-ref", "refs/heads/topic")).toContain("topic");
  });
  it("a moved remote tip is protected by the exact observed lease", async () => {
    const w = world(); git(w.repo, "branch", "other"); git(w.repo, "switch", "other"); writeFileSync(join(w.repo, "new.txt"), "new"); git(w.repo, "add", "new.txt"); git(w.repo, "commit", "-m", "new tip"); const newer = git(w.repo, "rev-parse", "HEAD"); git(w.repo, "switch", "main");
    const real = defaultSeams(); const seams: Seams = { ...real, run: (command, args, options) => {
      if (command === "git" && args[0] === "push") git(w.remote, "update-ref", "refs/heads/topic", newer);
      return real.run(command, args, options);
    } };
    // Transfer the fixture object to the bare remote before simulating movement.
    git(w.repo, "push", "origin", "other");
    const result = await run(w, [remoteItem], ["--run"], seams); expect(result.code).toBe(1); expect(result.report?.items[0]?.status).toBe("failed"); expect(git(w.remote, "rev-parse", "refs/heads/topic")).toBe(newer);
  });
  it("retains a local tip moved after ancestry proof even when HEAD contains its replacement", async () => {
    const w = world(); git(w.repo, "switch", "-c", "other");
    writeFileSync(join(w.repo, "replacement"), "unmerged into plan base"); git(w.repo, "add", "replacement"); git(w.repo, "commit", "-m", "replacement");
    const replacement = git(w.repo, "rev-parse", "HEAD");
    expect(spawnSync("git", ["merge-base", "--is-ancestor", replacement, base], { cwd: w.repo, env }).status).toBe(1);
    const real = defaultSeams(); let moved = false;
    const seams: Seams = { ...real, run: (command, args, options) => {
      const result = real.run(command, args, options);
      if (!moved && command === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor") {
        moved = true; git(w.repo, "update-ref", local.ref, replacement);
      }
      return result;
    } };
    const result = await run(w, [local], ["--run"], seams);
    expect(moved).toBe(true); expect(result.code).toBe(1); expect(result.report?.items[0]?.status).toBe("failed");
    expect(git(w.repo, "rev-parse", local.ref)).toBe(replacement);
  });
  it("retains the upstream-or-HEAD non-force guard in addition to the explicit plan base", async () => {
    const w = world(); git(w.repo, "switch", "topic");
    writeFileSync(join(w.repo, "later"), "later"); git(w.repo, "add", "later"); git(w.repo, "commit", "-m", "later");
    const tip = git(w.repo, "rev-parse", "HEAD"); git(w.repo, "switch", "main"); git(w.repo, "update-ref", base, tip);
    expect((await run(w, [local], ["--run"])).report?.items[0]?.message).toMatch(/non-force deletion refused/);
    expect(git(w.repo, "rev-parse", local.ref)).toBe(tip);
    git(w.repo, "branch", "--set-upstream-to=origin/main", "topic");
    expect((await run(w, [local], ["--run"])).code).toBe(0);
  });
  it("reverses a nonidentity fetch refspec instead of deriving its source from the tracking name", async () => {
    const w = world(); const tip = git(w.repo, "rev-parse", "topic");
    git(w.remote, "update-ref", "refs/heads/source", tip);
    git(w.repo, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/source:refs/remotes/origin/topic");
    const live = await run(w, [tracking], ["--run"]);
    expect(live.code).toBe(2); expect(live.report?.items[0]?.message).toMatch(/still exists/);
    expect(git(w.repo, "rev-parse", tracking.ref)).toBe(tip);
    git(w.remote, "update-ref", "-d", "refs/heads/source");
    expect((await run(w, [tracking], ["--run"])).code).toBe(0);
    expect(git(w.remote, "rev-parse", "refs/heads/topic")).toBe(tip);
  });
  it("uses the explicitly named remote under a custom destination namespace with an unrelated same-name remote", async () => {
    const w = world(); const unrelated = join(w.root, "cache.git"); git(w.root, "init", "--bare", unrelated);
    git(w.repo, "remote", "add", "cache", unrelated);
    git(w.repo, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/cache/*");
    const ref = "refs/remotes/cache/topic"; const tip = git(w.repo, "rev-parse", "topic"); git(w.repo, "update-ref", ref, tip);
    const item = { ...tracking, ref };
    expect((await run(w, [item], ["--run"])).code).toBe(2);
    expect(git(w.repo, "rev-parse", ref)).toBe(tip);
    git(w.remote, "update-ref", "-d", "refs/heads/topic");
    expect((await run(w, [item], ["--run"])).code).toBe(0);
    expect(git(unrelated, "for-each-ref")).toBe("");
  });
  it.each(["ambiguous", "negative-exact", "negative-wildcard", "unmapped"])("retains a tracking ref with %s fetch authority", async (mode) => {
    const w = world(); const tip = git(w.repo, "rev-parse", tracking.ref);
    if (mode === "ambiguous") git(w.repo, "config", "--add", "remote.origin.fetch", "+refs/heads/source:refs/remotes/origin/topic");
    if (mode === "negative-exact") git(w.repo, "config", "--add", "remote.origin.fetch", "^refs/heads/topic");
    if (mode === "negative-wildcard") git(w.repo, "config", "--add", "remote.origin.fetch", "^refs/heads/top*");
    if (mode === "unmapped") git(w.repo, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/*:refs/remotes/cache/*");
    const result = await run(w, [tracking], ["--run"]);
    expect(result.code).toBe(2); expect(result.report?.items[0]?.status).toBe("refused");
    expect(result.report?.items[0]?.message).toMatch(/exactly one source|negative fetch refspec/);
    expect(git(w.repo, "rev-parse", tracking.ref)).toBe(tip);
  });
  it.each([false, true])("previews ordered remote removals by exact endpoint, split push/fetch=%s", async (split) => {
    const w = world(); const pushRemote = join(w.root, "push.git");
    if (split) { git(w.root, "init", "--bare", pushRemote); git(w.repo, "push", pushRemote, "topic"); git(w.repo, "remote", "set-url", "--push", "origin", pushRemote); }
    else git(w.repo, "remote", "add", "alias", w.remote);
    // A different remote NAME can still mean the very same endpoint.
    const trackingItem = split ? tracking : { ...tracking, remote: "alias", ref: "refs/remotes/alias/topic" };
    if (!split) git(w.repo, "update-ref", trackingItem.ref, git(w.repo, "rev-parse", "topic"));
    const preview = await run(w, [remoteItem, trackingItem]);
    const actual = await run(w, [remoteItem, trackingItem], ["--run"]);
    expect(preview.report?.items.map((i) => i.status)).toEqual(split ? ["would-remove", "refused"] : ["would-remove", "would-remove"]);
    expect(actual.report?.items.map((i) => i.status)).toEqual(preview.report?.items.map((i) => i.status === "would-remove" ? "removed" : i.status));
    expect(actual.code).toBe(split ? 2 : 0);
    if (split) expect(git(w.repo, "rev-parse", tracking.ref)).toBe(git(w.remote, "rev-parse", "refs/heads/topic"));
  });
  it("rejects duplicate destructive identities whole-plan, including aliases, in preview and execution", async () => {
    const w = world(); git(w.repo, "branch", "keep"); git(w.repo, "worktree", "add", w.tree, "topic"); git(w.repo, "remote", "add", "alias", w.remote);
    const worktree = { kind: "worktree", path: w.tree, base };
    const keep = { ...local, ref: "refs/heads/keep" };
    for (const duplicates of [[local, local], [tracking, { ...tracking, remote: "alias" }], [remoteItem, { ...remoteItem, remote: "alias" }], [worktree, { ...worktree, path: join(w.tree, ".") }]]) {
      for (const flags of [[], ["--run"]]) {
        const result = await run(w, [keep, ...duplicates], flags);
        expect(result.code).toBe(2); expect(result.report).toBeNull(); expect(result.err).toContain("duplicate destructive target");
        expect(git(w.repo, "branch", "--list", "keep")).toContain("keep");
        expect(existsSync(w.tree)).toBe(true); expect(git(w.remote, "rev-parse", "refs/heads/topic")).toBe(git(w.repo, "rev-parse", "topic"));
      }
    }
  });
  it("records failures per item and continues, never claiming bytes for an uncertain write", async () => {
    const w = world(); git(w.repo, "branch", "keep");
    const real = defaultSeams(); const seams: Seams = { ...real, run: (command, args, options) => command === "git" && args[0] === "update-ref" ? { code: 1, stdout: "", stderr: "refused", spawnFailed: false } : real.run(command, args, options) };
    const result = await run(w, [local, { ...local, ref: "refs/heads/keep" }], ["--run"], seams);
    expect(result.code).toBe(1); expect(result.report?.items.map((i) => i.status)).toEqual(["failed", "failed"]); expect(result.report?.freedBytes).toBeNull();
  });
  it.skipIf(process.platform === "win32")("reads host links without following or removing them, and refuses symlink worktree roots", async () => {
    const w = world(); git(w.repo, "worktree", "add", w.tree, "topic"); const link = join(w.root, "host-link"); symlinkSync(w.tree, link);
    const result = await run(w, [{ kind: "host-link", path: link }], ["--run"]); expect(result.code).toBe(0); expect(result.report?.items[0]?.linkTarget).toBe(w.tree); expect(existsSync(link)).toBe(true); expect(result.report?.freedBytes).toBe(0);
    expect((await run(w, [{ kind: "worktree", path: link, base }], ["--run"])).code).toBe(2); expect(existsSync(w.tree)).toBe(true);
  });
  it("plan validation does not silently accept nulls or empty fields", () => {
    for (const value of [[null], [{ kind: "worktree", path: "", base }], [{ kind: "host-link", path: "a\nb" }]]) expect(() => parsePrunePlan(value)).toThrow();
  });
});
