// Every write/deletion here is inside a fresh throwaway clone and bare remote.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  it("honestly refuses unsupported local removals in the default dry run without writes", async () => {
    const w = world(); git(w.repo, "worktree", "add", w.tree, "topic");
    const before = git(w.repo, "show-ref"); const calls: string[][] = [];
    const real = defaultSeams(); const seams: Seams = { ...real, run: (command, args, options) => { if (command === "git") calls.push([...args]); return real.run(command, args, options); } };
    const result = await run(w, [{ kind: "worktree", path: w.tree, base }, local], [], seams);
    expect(result.code).toBe(2); expect(result.report?.dryRun).toBe(true);
    expect(result.report?.items.map((i) => i.status)).toEqual(["refused", "refused"]);
    expect(result.report?.freedBytes).toBe(0); expect(existsSync(w.tree)).toBe(true); expect(git(w.repo, "show-ref")).toBe(before);
    expect(calls.some((a) => ["push", "fetch", "update-ref", "branch"].includes(a[0] ?? "") || a[0] === "worktree" && a[1] !== "list")).toBe(false);
  });
  it("retains clean worktrees, branches and configuration with zero bytes reclaimed", async () => {
    const w = world(); git(w.repo, "worktree", "add", w.tree, "topic"); git(w.repo, "branch", "keep");
    const before = git(w.repo, "show-ref"); const config = readFileSync(join(w.repo, ".git", "config"), "utf8");
    const result = await run(w, [{ kind: "worktree", path: w.tree, base }, local], ["--run"]);
    expect(result.code).toBe(2); expect(result.report?.items.map((i) => i.status)).toEqual(["refused", "refused"]);
    expect(result.report?.freedBytes).toBe(0); expect(result.report?.physicalFreedBytes).toBeNull();
    expect(result.report?.items.every((i) => i.measuredBytes === null)).toBe(true);
    expect(existsSync(w.tree)).toBe(true); expect(git(w.repo, "show-ref")).toBe(before);
    expect(readFileSync(join(w.repo, ".git", "config"), "utf8")).toBe(config);
  });
  it("continues supported remote cleanup after refusing unsupported local rows, with preview parity", async () => {
    const w = world(); git(w.repo, "worktree", "add", w.tree, "topic");
    const plan = [{ kind: "worktree", path: w.tree, base }, local, remoteItem];
    const preview = await run(w, plan);
    expect(preview.code).toBe(2); expect(preview.report?.items.map((i) => i.status)).toEqual(["refused", "refused", "would-remove"]);
    const actual = await run(w, plan, ["--run"]);
    expect(actual.code).toBe(2); expect(actual.report?.items.map((i) => i.status)).toEqual(["refused", "refused", "removed"]);
    expect(existsSync(w.tree)).toBe(true); expect(git(w.tree, "rev-parse", "HEAD")).toBe(git(w.repo, "rev-parse", local.ref));
    expect(git(w.repo, "ls-remote", "--heads", "origin", remoteItem.ref)).toBe("");
    expect(actual.report?.freedBytes).toBe(0);
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
  it("retains existing stale tracking refs as well as live refs and remote HEAD", async () => {
    const w = world(); const live = await run(w, [tracking], ["--run"]);
    expect(live.code).toBe(2); expect(live.report?.items[0]?.message).toMatch(/still exists/);
    git(w.remote, "update-ref", "-d", "refs/heads/topic");
    const result = await run(w, [tracking], ["--run"]); expect(result.code).toBe(2);
    expect(result.report?.items[0]?.message).toMatch(/fetch-authority serialization/);
    expect(git(w.repo, "show-ref", "refs/remotes/origin/topic")).toContain("topic");
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
    expect(moved).toBe(true); expect(result.code).toBe(2); expect(result.report?.items[0]?.status).toBe("refused");
    expect(git(w.repo, "rev-parse", local.ref)).toBe(replacement);
  });
  it("preserves a two-remote branch's exact routing and prevents unforced recreation after refusal", async () => {
    const w = world(); const upstream = join(w.root, "upstream.git"); git(w.root, "init", "--bare", upstream);
    git(w.repo, "remote", "add", "upstream", upstream); git(w.repo, "push", "upstream", "topic");
    git(w.repo, "branch", "--set-upstream-to=upstream/topic", "topic");
    git(w.repo, "config", "branch.topic.description", "retained authority");
    const config = readFileSync(join(w.repo, ".git", "config"), "utf8"); const tip = git(w.repo, "rev-parse", local.ref);
    for (const flags of [[], ["--run"]]) {
      const result = await run(w, [local], flags);
      expect(result.code).toBe(2); expect(result.report?.items[0]?.message).toMatch(/configuration retained/);
      expect(git(w.repo, "rev-parse", local.ref)).toBe(tip);
      expect(readFileSync(join(w.repo, ".git", "config"), "utf8")).toBe(config);
    }
    expect(spawnSync("git", ["branch", "topic", "main"], { cwd: w.repo, env }).status).not.toBe(0);
    // No deleted/recreated identity inherits leftover settings: the original
    // branch and its legitimate routing remain together, byte-for-byte.
    git(w.repo, "switch", "topic"); const out: string[] = [];
    const code = await runFamily(wcCommand, ["wc", "publish", "--dry-run", "--json"], w.repo, false, { out: (s) => void out.push(s), err: () => {} }, defaultSeams());
    expect(code).toBe(0); expect(JSON.parse(out.join("\n"))).toMatchObject({ remote: "upstream", destination: "topic", pushed: false });
  });
  it.each(["add", "no-checkout", "switch"])("retains a branch activated after the final registration read by %s", async (variant) => {
    const w = world(); if (variant === "switch") git(w.repo, "worktree", "add", "--detach", w.tree, "main");
    const real = defaultSeams(); let reads = 0; let activated = false; const writes: string[][] = [];
    const seams: Seams = { ...real, run: (command, args, options) => {
      const result = real.run(command, args, options);
      if (command === "git" && args[0] === "update-ref") writes.push([...args]);
      if (command === "git" && args[0] === "worktree" && args[1] === "list" && ++reads === 2) {
        if (variant === "switch") git(w.tree, "switch", "topic");
        else git(w.repo, "worktree", "add", ...(variant === "no-checkout" ? ["--no-checkout"] : []), w.tree, "topic");
        activated = true;
      }
      return result;
    } };
    const result = await run(w, [local], ["--run"], seams);
    expect(activated).toBe(true); expect(result.code).toBe(2); expect(result.report?.items[0]?.status).toBe("refused");
    expect(writes).toEqual([]); expect(git(w.tree, "rev-parse", "HEAD")).toBe(git(w.repo, "rev-parse", local.ref));
  });
  it("preserves 4096 late ignored bytes after the clean observation, without destructive Git calls", async () => {
    const w = world(); git(w.repo, "worktree", "add", w.tree, "topic");
    writeFileSync(join(w.repo, ".git", "info", "exclude"), "late-ignored\n");
    const real = defaultSeams(); const destructive: string[][] = []; let wrote = false;
    const seams: Seams = { ...real, run: (command, args, options) => {
      const result = real.run(command, args, options);
      if (command === "git" && args[0] === "status" && options?.cwd !== undefined && realpathSync.native(options.cwd) === realpathSync.native(w.tree)) {
        expect(result.stdout).toBe(""); writeFileSync(join(w.tree, "late-ignored"), Buffer.alloc(4096, 65)); wrote = true;
      }
      if (command === "git" && (args[0] === "update-ref" || args[0] === "worktree" && args[1] === "remove")) destructive.push([...args]);
      return result;
    } };
    const result = await run(w, [{ kind: "worktree", path: w.tree, base }], ["--run"], seams);
    expect(wrote).toBe(true); expect(result.code).toBe(2); expect(result.report?.items[0]).toMatchObject({ status: "refused", measuredBytes: null, freedBytes: 0 });
    expect(result.report?.items[0]?.message).toMatch(/writer-quiescence/); expect(destructive).toEqual([]);
    expect(readFileSync(join(w.tree, "late-ignored"))).toEqual(Buffer.alloc(4096, 65));
    expect(git(w.tree, "rev-parse", "HEAD")).toBe(git(w.repo, "rev-parse", "topic"));
  });
  it("reverses a nonidentity fetch refspec instead of deriving its source from the tracking name", async () => {
    const w = world(); const tip = git(w.repo, "rev-parse", "topic");
    git(w.remote, "update-ref", "refs/heads/source", tip);
    git(w.repo, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/source:refs/remotes/origin/topic");
    const live = await run(w, [tracking], ["--run"]);
    expect(live.code).toBe(2); expect(live.report?.items[0]?.message).toMatch(/still exists/);
    expect(git(w.repo, "rev-parse", tracking.ref)).toBe(tip);
    git(w.remote, "update-ref", "-d", "refs/heads/source");
    expect((await run(w, [tracking], ["--run"])).report?.items[0]?.message).toMatch(/fetch-authority serialization/);
    expect(git(w.repo, "rev-parse", tracking.ref)).toBe(tip);
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
    expect((await run(w, [item], ["--run"])).report?.items[0]?.message).toMatch(/fetch-authority serialization/);
    expect(git(w.repo, "rev-parse", ref)).toBe(tip);
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
    expect(preview.report?.items.map((i) => i.status)).toEqual(["would-remove", "refused"]);
    expect(actual.report?.items.map((i) => i.status)).toEqual(preview.report?.items.map((i) => i.status === "would-remove" ? "removed" : i.status));
    expect(actual.code).toBe(2);
    expect(git(w.repo, "show-ref", trackingItem.ref)).toContain(trackingItem.ref);
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
  it("records supported remote failures per item and continues without claiming uncertain bytes", async () => {
    const w = world(); git(w.repo, "branch", "keep"); git(w.repo, "push", "origin", "keep");
    const real = defaultSeams(); const seams: Seams = { ...real, run: (command, args, options) => command === "git" && args[0] === "push" ? { code: 1, stdout: "", stderr: "refused", spawnFailed: false } : real.run(command, args, options) };
    const result = await run(w, [remoteItem, { ...remoteItem, ref: "refs/heads/keep" }], ["--run"], seams);
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
  it("literalizes a relative push path that collides with a configured remote name", async () => {
    const w = world(); const intended = join(w.repo, "target"); const other = join(w.root, "other.git");
    for (const endpoint of [intended, other]) { git(w.root, "init", "--bare", endpoint); git(w.repo, "push", endpoint, "topic"); }
    git(w.repo, "remote", "add", "target", other); git(w.repo, "fetch", "target");
    git(w.repo, "remote", "set-url", "--push", "origin", "target");
    const before = git(w.repo, "show-ref", "refs/remotes/target/topic");
    expect((await run(w, [remoteItem])).report?.items[0]?.status).toBe("would-remove");
    const result = await run(w, [remoteItem], ["--run"]);
    expect(result.code).toBe(0);
    expect(git(other, "show-ref", "refs/heads/topic")).toContain("topic");
    expect(git(w.repo, "show-ref", "refs/remotes/target/topic")).toBe(before);
    expect(git(intended, "for-each-ref", "refs/heads/topic")).toBe("");
  });
  it("resolves a chained rewrite once and never redirects the leased push a second time", async () => {
    const w = world(); const intended = join(w.root, "intended.git"); const other = join(w.root, "other.git");
    for (const endpoint of [intended, other]) { git(w.root, "init", "--bare", endpoint); git(w.repo, "push", endpoint, "topic"); }
    const alias = "prune-test-alias";
    git(w.repo, "remote", "set-url", "--push", "origin", alias);
    git(w.repo, "config", `url.${intended}.insteadOf`, alias);
    git(w.repo, "config", `url.${other}.pushInsteadOf`, intended);
    const result = await run(w, [remoteItem], ["--run"]);
    expect(result.code).toBe(0);
    expect(git(other, "show-ref", "refs/heads/topic")).toContain("topic");
    expect(git(intended, "for-each-ref", "refs/heads/topic")).toBe("");
  });
  it("retains the proved endpoint when a URL rewrite is added immediately before push", async () => {
    const w = world(); const other = join(w.root, "other.git");
    git(w.root, "init", "--bare", other); git(w.repo, "push", other, "topic");
    const real = defaultSeams(); let changed = false;
    const seams: Seams = { ...real, run: (command, args, options) => {
      if (command === "git" && args[0] === "push") {
        git(w.repo, "config", `url.${other}.insteadOf`, w.remote); changed = true;
      }
      return real.run(command, args, options);
    } };
    const result = await run(w, [remoteItem], ["--run"], seams);
    expect(changed).toBe(true); expect(result.code).toBe(0);
    expect(git(other, "show-ref", "refs/heads/topic")).toContain("topic");
    expect(git(w.remote, "for-each-ref", "refs/heads/topic")).toBe("");
  });
  it.each([false, true])("refuses tracking deletion even after an absence proof whose fetch authority changes, run=%s", async (execute) => {
    const w = world(); git(w.repo, "push", w.remote, "topic:live"); git(w.remote, "update-ref", "-d", "refs/heads/topic");
    const tip = git(w.repo, "rev-parse", tracking.ref); const real = defaultSeams(); let changed = false; const writes: string[][] = [];
    const seams: Seams = { ...real, run: (command, args, options) => {
      const result = real.run(command, args, options);
      if (command === "git" && args[0] === "ls-remote" && args.includes("--heads")) {
        git(w.repo, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/live:refs/remotes/origin/topic"); changed = true;
      }
      if (command === "git" && args[0] === "update-ref") writes.push([...args]);
      return result;
    } };
    const result = await run(w, [tracking], execute ? ["--run"] : [], seams);
    expect(changed).toBe(true); expect(result.code).toBe(2);
    expect(result.report?.items[0]?.status).toBe("refused"); expect(result.report?.items[0]?.message).toMatch(/fetch-authority serialization/);
    expect(writes).toEqual([]); expect(git(w.repo, "rev-parse", tracking.ref)).toBe(tip);
  });

  it("freezes inherited include/rewrite/auth configuration in memory without copying secrets into scratch files", async () => {
    const w = world(); const intended = join(w.root, "intended.git"); const other = join(w.root, "other.git");
    for (const endpoint of [intended, other]) { git(w.root, "init", "--bare", endpoint); git(w.repo, "push", endpoint, "topic"); }
    const global = join(w.root, "fixture-global"); const included = join(w.root, "fixture-include");
    // Let Git serialize native path escaping (Windows backslashes are not
    // valid unescaped config text). These are disposable explicit files only.
    git(w.root, "config", "--file", global, "include.path", included);
    git(w.root, "config", "--file", included, `url.${intended}.insteadOf`, "fixture-alias");
    git(w.root, "config", "--file", included, "http.extraHeader", "X-Fixture: private-test-value");
    git(w.repo, "remote", "set-url", "--push", "origin", "fixture-alias");
    const real = defaultSeams(); let observed = false; let pushed = false;
    const captured: { entries: (string | undefined)[][]; config: string }[] = [];
    const seams: Seams = { ...real, env: { ...real.env, GIT_CONFIG_GLOBAL: global }, run: (command, args, options) => {
      if (command === "git" && args[0] === "ls-remote" && args.includes("--heads")) {
        observed = true;
        writeFileSync(included, "");
        git(w.root, "config", "--file", included, `url.${other}.insteadOf`, intended);
      }
      if (command === "git" && (args[0] === "push" || args[0] === "ls-remote" && args.includes("--heads"))) {
        const entries = Number(options?.env?.["GIT_CONFIG_COUNT"] ?? 0);
        const values = Array.from({ length: entries }, (_, n) => [options?.env?.[`GIT_CONFIG_KEY_${n}`], options?.env?.[`GIT_CONFIG_VALUE_${n}`]]);
        expect(args.join(" ")).not.toContain("private-test-value");
        captured.push({ entries: values, config: readFileSync(join(options!.cwd!, "config"), "utf8") });
        if (args[0] === "push") pushed = true;
      }
      return real.run(command, args, options);
    } };
    const result = await run(w, [remoteItem], ["--run"], seams);
    expect(result.report?.items[0]?.message).toBe("only the named merged ref; no object GC");
    expect(observed && pushed).toBe(true); expect(result.code).toBe(0);
    for (const call of captured) {
      expect(call.entries).toContainEqual(["http.extraheader", "X-Fixture: private-test-value"]);
      expect(call.entries.some(([key]) => /^(url|remote|include)\./i.test(key ?? ""))).toBe(false);
      expect(call.config).not.toContain("private-test-value");
    }
    expect(git(other, "show-ref", "refs/heads/topic")).toContain("topic");
    expect(git(intended, "for-each-ref", "refs/heads/topic")).toBe("");
  });

  it.each(["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"])("does not let inherited %s redirect source or transport authority", async (name) => {
    const w = world(); const other = join(w.root, "other.git");
    git(w.root, "init", "--bare", other); git(w.repo, "push", other, "topic");
    const real = defaultSeams(); const seams: Seams = { ...real, env: { ...real.env,
      [name]: name === "GIT_CONFIG_PARAMETERS" ? `'url.${other}.insteadOf'='${w.remote}'` : name === "GIT_CONFIG_COUNT" ? "1" : other,
      GIT_CONFIG_KEY_0: `url.${other}.insteadOf`, GIT_CONFIG_VALUE_0: w.remote,
    } };
    const result = await run(w, [remoteItem], ["--run"], seams);
    expect(result.code).toBe(0);
    expect(git(other, "show-ref", "refs/heads/topic")).toContain("topic");
    expect(git(w.remote, "for-each-ref", "refs/heads/topic")).toBe("");
  });

  it.each(["https://fixture-private-value@host.invalid/repo", "ssh://fixture:fixture-private-value@host.invalid/repo"])("refuses embedded URL credentials without exposing them to subprocess argv: %s", async (url) => {
    const w = world(); git(w.repo, "remote", "set-url", "--push", "origin", url);
    const real = defaultSeams(); const argsSeen: string[][] = [];
    const seams: Seams = { ...real, run: (command, args, options) => {
      if (command === "git") argsSeen.push([...args]);
      return real.run(command, args, options);
    } };
    const result = await run(w, [remoteItem], ["--run"], seams);
    expect(result.code).toBe(2); expect(result.report?.items[0]?.message).toMatch(/embedded URL credentials/);
    expect(argsSeen.flat().join(" ")).not.toContain("fixture-private-value");
    expect(argsSeen.some((args) => args[0] === "push")).toBe(false);
  });

  it.each(["trailing-space", "leading-space", "rewritten-space"])("preserves exact endpoint bytes for %s rather than deleting a whitespace-trimmed peer", async (variant) => {
    const w = world(); const intended = variant === "leading-space" ? join(w.repo, " leading.git") : join(w.root, "trailing ");
    const other = variant === "leading-space" ? join(w.repo, "leading.git") : join(w.root, "trailing");
    const windowsUnsupported = process.platform === "win32" && variant !== "leading-space";
    if (windowsUnsupported) {
      const capability = spawnSync("git", ["init", "--bare", intended], { cwd: w.root, env, encoding: "utf8" });
      expect(capability.status).not.toBe(0); expect(capability.stderr).toMatch(/invalid argument/i); expect(existsSync(intended)).toBe(false);
    }
    for (const endpoint of windowsUnsupported ? [other] : [intended, other]) { git(w.root, "init", "--bare", endpoint); git(w.repo, "push", endpoint, "topic"); }
    const raw = variant === "leading-space" ? " leading.git" : variant === "rewritten-space" ? "fixture-alias" : intended;
    git(w.repo, "remote", "set-url", "--push", "origin", raw);
    if (variant === "rewritten-space") git(w.repo, "config", `url.${intended}.insteadOf`, raw);
    const remoteCalls: string[][] = []; const real = defaultSeams();
    const seams: Seams = { ...real, run: (command, args, options) => {
      if (command === "git" && (args[0] === "push" || args[0] === "ls-remote" && args.includes("--heads"))) remoteCalls.push([...args]);
      return real.run(command, args, options);
    } };
    const preview = await run(w, [remoteItem], [], seams);
    const result = await run(w, [remoteItem], ["--run"], seams);
    if (windowsUnsupported) {
      expect(preview.code).toBe(2); expect(result.code).toBe(2);
      expect(preview.report?.items[0]?.message).toMatch(/path normalization/); expect(remoteCalls).toEqual([]);
    } else {
      expect(preview.code).toBe(0); expect(preview.report?.items[0]?.status).toBe("would-remove"); expect(result.code).toBe(0);
      expect(git(intended, "for-each-ref", "refs/heads/topic")).toBe("");
    }
    expect(git(other, "show-ref", "refs/heads/topic")).toContain("topic");
  });
  it.each(["raw-LF", "raw-CR", "rewrite-encoded-LF", "encoded-LF"])("refuses record-ambiguous endpoint bytes before remote observation: %s", async (variant) => {
    const w = world(); const bad = w.remote + (variant === "raw-CR" ? "\r" : "\n");
    const raw = variant === "rewrite-encoded-LF" ? "fixture-alias" : variant === "encoded-LF" ? `${pathToFileURL(w.remote).href}%0A` : bad;
    git(w.repo, "remote", "set-url", "--push", "origin", raw);
    if (variant === "rewrite-encoded-LF") git(w.repo, "config", `url.${pathToFileURL(w.remote).href}%0A.insteadOf`, raw);
    const real = defaultSeams(); const remoteCalls: string[][] = [];
    const seams: Seams = { ...real, run: (command, args, options) => {
      if (command === "git" && (args[0] === "push" || args[0] === "ls-remote" && args.includes("--heads"))) remoteCalls.push([...args]);
      return real.run(command, args, options);
    } };
    for (const flags of [[], ["--run"]]) {
      const result = await run(w, [remoteItem], flags, seams);
      expect(result.code).toBe(2); expect(result.report?.items[0]?.message).toMatch(/endpoint.*record|record.*endpoint/);
      expect(remoteCalls).toEqual([]); expect(git(w.remote, "show-ref", "refs/heads/topic")).toContain("topic");
    }
  });

  it("removes only a Windows Git output terminator while retaining a portable leading-space pathname", async () => {
    const w = world(); const intended = join(w.repo, " leading.git"); const other = join(w.repo, "leading.git");
    for (const endpoint of [intended, other]) { git(w.root, "init", "--bare", endpoint); git(w.repo, "push", endpoint, "topic"); }
    git(w.repo, "remote", "set-url", "--push", "origin", " leading.git");
    const real = defaultSeams(); const seams: Seams = { ...real, platform: "win32", run: (command, args, options) => {
      const result = real.run(command, args, options);
      if (command !== "git" || !args.includes("--get-url")) return result;
      expect(result.stdout.endsWith("\n")).toBe(true);
      const payload = result.stdout.endsWith("\r\n") ? result.stdout.slice(0, -2) : result.stdout.slice(0, -1);
      const text = payload + "\r\n";
      return { ...result, stdout: text, stdoutBytes: new TextEncoder().encode(text) };
    } };
    const result = await run(w, [remoteItem], ["--run"], seams); expect(result.code).toBe(0);
    expect(git(other, "show-ref", "refs/heads/topic")).toContain("topic");
    expect(git(intended, "for-each-ref", "refs/heads/topic")).toBe("");
  });

  it.each([false, true])("preserves a leading BOM in a relative endpoint pathname, rewritten=%s", async (rewrite) => {
    const w = world(); const name = "\uFEFFbom.git";
    const intended = join(w.repo, name); const other = join(w.repo, "bom.git");
    for (const endpoint of [intended, other]) { git(w.root, "init", "--bare", endpoint); git(w.repo, "push", endpoint, "topic"); }
    const raw = rewrite ? "fixture-alias" : name;
    git(w.repo, "remote", "set-url", "--push", "origin", raw);
    if (rewrite) git(w.repo, "config", `url.${name}.insteadOf`, raw);
    const preview = await run(w, [remoteItem]); expect(preview.code).toBe(0); expect(preview.report?.items[0]?.status).toBe("would-remove");
    const result = await run(w, [remoteItem], ["--run"]); expect(result.code).toBe(0);
    expect(git(other, "show-ref", "refs/heads/topic")).toContain("topic");
    expect(git(intended, "for-each-ref", "refs/heads/topic")).toBe("");
  });

});
