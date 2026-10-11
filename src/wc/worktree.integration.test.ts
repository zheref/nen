// src/wc/worktree.integration.test.ts -- `nen wc worktree` against the REAL
// git, in throwaway projects: a bare `origin`, a core clone, a second clone
// that moves the trunk, and a gitignored file in core to copy (zheref/nen#299).
//
// THE CASES ARE THE REFERENCE SCRIPT'S SELF-TEST, PORTED (zheref/hatsu
// `scripts/kagutsuchi_worktree.sh --self-test`): the plan, the creation, the
// reuse, the move, the dirty refusal, the copy proofs in core and at the tip
// -- a tracked PARENT symlink, a tracked LEAF symlink, a tracked regular file,
// an UNTRACKED symlink at the destination -- the sibling registration, the
// symlinked parent, the stray directory and the vanished registration; plus
// what the review rounds added.
//
// EVERY TEST BUILDS ITS OWN WORLD (`world()`), removed after it. The script's
// self-test was one evolving fixture; ported that way, one failure on Windows
// (a lock never released, a trunk never rewound) cascaded into a dozen
// unrelated ones (zheref/nen#397). A world costs a few git calls, and a test
// that needs a worktree or a moved trunk says so itself.
//
// PATHS GIT REPORTS are compared with ../canon/paths.ts's `samePath`, never as
// strings: `git worktree list --porcelain` prints `C:/...` on Windows, where
// node's `join` spells `C:\...`. Fixtures Windows cannot express -- a real
// symlink on disk needs a privilege CI does not grant -- are skipped there;
// a symlink that lives only in a TREE (built with plumbing) runs everywhere.
//
// The fixture shape is ./swap.integration.test.ts's: repo-local identity,
// `core.autocrlf=false`, `protocol.file.allow=always`, git >= 2.31, and a loud
// SKIP where no usable git is on PATH.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { samePath } from "../canon/paths.js";
import { defaultSeams } from "../seam/exec.js";
import { wcCommand } from "./command.js";
import { KEY_FILE, MANIFEST_CONTRACT, MANIFEST_CONTRACT_V1, MANIFEST_FILE, WORKTREE_CONTRACT } from "./worktree.js";

const PINNED = ["-c", "core.autocrlf=false", "-c", "protocol.file.allow=always"];

function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env["GIT_DIR"];
  delete env["GIT_INDEX_FILE"];
  delete env["GIT_WORK_TREE"];
  return env;
}

function git(cwd: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", env: gitEnv() });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitIn(cwd: string, args: readonly string[], input: string): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", env: gitEnv(), input });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.status}: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

function mustGit(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.code}: ${result.stderr}`);
  return result.stdout.trim();
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
/** A real symlink on disk needs a privilege on Windows that CI does not grant; those fixtures are POSIX-only. */
const LINKS = process.platform !== "win32";

function pin(repo: string): void {
  mustGit(repo, ["config", "core.autocrlf", "false"]);
  mustGit(repo, ["config", "user.name", "nen test"]);
  mustGit(repo, ["config", "user.email", "nen@example.invalid"]);
  mustGit(repo, ["config", "commit.gpgsign", "false"]);
  mustGit(repo, ["config", "core.hooksPath", "/dev/null"]);
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly doc: Record<string, unknown>;
}

async function wc(argv: readonly string[], repo: string, json = false): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(wcCommand, ["wc", "worktree", ...argv], repo, json, io, defaultSeams());
  const doc = json && out.length > 0 ? (JSON.parse(out.join("\n")) as Record<string, unknown>) : {};
  return { code, out: out.join("\n"), err: err.join("\n"), doc };
}

const SECRET = "Kro/Config.xcconfig";
const KG = ["--name", "kagutsuchi", "--base", "main"];
const COPY = ["--copy-from-core", SECRET];

const headOf = (repo: string): string => mustGit(repo, ["rev-parse", "HEAD"]);
const refusalKind = (run: Run): string | undefined => (run.doc["refusal"] as { kind?: string } | null)?.kind;

/** Every worktree path `git worktree list --porcelain` prints, as git spells it. */
function registrations(core: string): string[] {
  return mustGit(core, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** Whether `path` is registered -- compared as the platform does, never as a string (`C:/` vs `C:\`). */
function isRegistered(core: string, path: string): boolean {
  return registrations(core).some((registered) => samePath(registered, path, process.platform));
}

/** Every path under `dir`, relative, directories descended. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name === ".git") continue;
    out.push(rel);
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
  }
  return out;
}

function commitIn(repo: string, message: string): void {
  mustGit(repo, ["add", "-A"]);
  mustGit(repo, ["commit", "--quiet", "-m", message]);
}

interface World {
  readonly root: string;
  readonly origin: string;
  /** Core: the checkout whose .git is the common git dir. */
  readonly C: string;
  /** A second clone that moves the trunk. */
  readonly O: string;
  /** The managed worktree's path. */
  readonly W: string;
  /** origin/main's first commit. */
  readonly firstTip: string;
  /** A directory outside every checkout, holding a victim file. */
  readonly outside: string;
  readonly gitDir: string;
}

const worlds: string[] = [];
afterEach(() => {
  for (const root of worlds.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh project: origin with one commit, core with the secret, a second clone, an outside victim. */
function world(): World {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-wc-worktree-git-")));
  worlds.push(root);
  const origin = join(root, "origin.git");
  const C = join(root, "core");
  const O = join(root, "other");
  const outside = join(root, "outside");
  mustGit(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  mustGit(root, [...PINNED, "clone", "--quiet", origin, C]);
  pin(C);
  mustGit(C, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  mkdirSync(join(C, "Kro"), { recursive: true });
  writeFileSync(join(C, ".gitignore"), "/Kro/Config.xcconfig\n/Kro/Other.xcconfig\n.nen/\n");
  writeFileSync(join(C, "README"), "hello\n");
  writeFileSync(join(C, "Kro", "keep.txt"), "kept\n");
  commitIn(C, "base");
  mustGit(C, [...PINNED, "push", "--quiet", "origin", "main"]);
  mustGit(C, [...PINNED, "fetch", "--quiet", "origin"]);
  writeFileSync(join(C, SECRET), "SUPABASE_URL = x\n");
  mustGit(root, [...PINNED, "clone", "--quiet", origin, O]);
  pin(O);
  mkdirSync(outside);
  writeFileSync(join(outside, "Config.xcconfig"), "victim\n");
  const W = join(C, ".nen", "worktrees", "kagutsuchi");
  return { root, origin, C, O, W, firstTip: headOf(C), outside, gitDir: join(C, ".git", "worktrees", "kagutsuchi") };
}

/** A world whose managed worktree already stands at the first tip, the secret copied. */
async function worldWithWorktree(): Promise<World> {
  const w = world();
  const made = await wc([...KG, ...COPY], w.C);
  if (made.code !== 0) throw new Error(`fixture: the worktree could not be created: ${made.err}`);
  return w;
}

/** Move the trunk one ordinary commit ahead; returns the new tip. */
function advance(w: World): string {
  writeFileSync(join(w.O, "README"), "hello\nnewer\n");
  commitIn(w.O, "newer");
  mustGit(w.O, [...PINNED, "push", "--quiet", "origin", "main"]);
  return headOf(w.O);
}

/** Push a commit built with PLUMBING on the first tip: its entries, minus `drop`, plus `extra`, spelled exactly. */
function pushPlumbed(w: World, extra: string, message: string, drop?: string): string {
  const entries = mustGit(w.O, ["ls-tree", w.firstTip]).split("\n").filter((line) => drop === undefined || !line.endsWith(`\t${drop}`));
  const tree = gitIn(w.O, ["mktree"], `${[...entries, extra].join("\n")}\n`);
  const commit = mustGit(w.O, ["commit-tree", tree, "-p", w.firstTip, "-m", message]);
  mustGit(w.O, [...PINNED, "push", "--quiet", "origin", `${commit}:refs/heads/main`]);
  return commit;
}

describe.skipIf(!HAVE_GIT)("nen wc worktree -- against the real git, one world per test", () => {
  it("refuses a missing --name, a missing --base, a bad name, a bad copy path and a non-checkout, all at exit 2", async () => {
    const w = world();
    expect((await wc(["--base", "main"], w.C)).code).toBe(2);
    expect((await wc(["--name", "kagutsuchi"], w.C)).code).toBe(2);
    const badName = await wc(["--name", "../x", "--base", "main"], w.C);
    expect(badName.code).toBe(2);
    expect(badName.err).toMatch(/one plain path segment/);
    expect((await wc([...KG, "--copy-from-core", "../outside"], w.C)).code).toBe(2);
    const glob = await wc([...KG, "--copy-from-core", "Kro/*.xcconfig"], w.C);
    expect(glob.code).toBe(2);
    expect(glob.err).toMatch(/one literal path/);
    expect((await wc([...KG, ...COPY, ...COPY], w.C)).code).toBe(2);
    const outside = await wc(KG, w.outside);
    expect(outside.code).toBe(2);
    expect(outside.err).toMatch(/not inside a git checkout/);
    expect((await wc(["--name", "kagutsuchi", "--base", "+main"], w.C)).code).toBe(2);
    expect(existsSync(w.W)).toBe(false);
  });

  it("--dry-run on a fresh core prints the plan and creates nothing", async () => {
    const w = world();
    const run = await wc([...KG, ...COPY, "--dry-run"], w.C);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("would create");
    expect(run.out).toContain("as last fetched");
    expect(run.out).toContain(`copied:          ${SECRET} (would copy from core)`);
    expect(existsSync(join(w.C, ".nen"))).toBe(false);
  });

  it("creates one worktree at origin/main's tip with the named file copied, staged outside the tree and recorded (F2, F3)", async () => {
    const w = world();
    const run = await wc([...KG, ...COPY], w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc).toMatchObject({ state: "created", copies: [{ path: SECRET, action: "copied" }], coreIgnored: true });
    expect(samePath(run.doc["path"] as string, w.W, process.platform)).toBe(true);
    expect(readFileSync(join(w.W, SECRET), "utf8")).toBe("SUPABASE_URL = x\n");
    expect(headOf(w.W)).toBe(w.firstTip);
    expect(git(w.W, ["symbolic-ref", "-q", "HEAD"]).code).not.toBe(0);
    expect(mustGit(w.W, ["status", "--porcelain"])).toBe("");
    expect(walk(w.W).filter((path) => path.includes("nen-wc-worktree-copy"))).toEqual([]);
    expect(mustGit(w.W, ["status", "--porcelain", "--ignored"])).toBe(`!! ${SECRET}`);
    const record = JSON.parse(readFileSync(join(w.gitDir, MANIFEST_FILE), "utf8")) as { contract: string; copies: Array<{ path: string }> };
    expect(record.contract).toBe(MANIFEST_CONTRACT);
    expect(record.copies.map((copy) => copy.path)).toEqual([SECRET]);
  });

  it("an --base origin does not have is a refusal at exit 2, not a git failure (N1)", async () => {
    const w = world();
    const run = await wc(["--name", "kagutsuchi", "--base", "no-such-branch"], w.C, true);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/origin has no branch 'no-such-branch'/);
    expect(refusalKind(run)).toBe("base");
  });

  it("a second run at the same tip reuses it: still exactly one managed worktree beside core", async () => {
    const w = await worldWithWorktree();
    const run = await wc([...KG, ...COPY], w.C);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("(reused)");
    expect(registrations(w.C)).toHaveLength(2);
    expect(isRegistered(w.C, w.W)).toBe(true);
  });

  it("invoked FROM the worktree, core is resolved and the run is a no-op", async () => {
    const w = await worldWithWorktree();
    const run = await wc(KG, w.W, true);
    expect(run.code, run.err).toBe(0);
    expect(samePath(run.doc["core"] as string, w.C, process.platform)).toBe(true);
    expect(run.doc["state"]).toBe("reused");
  });

  it("an inherited GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE does not redirect it", async () => {
    const w = await worldWithWorktree();
    const saved = { dir: process.env["GIT_DIR"], index: process.env["GIT_INDEX_FILE"], tree: process.env["GIT_WORK_TREE"] };
    process.env["GIT_DIR"] = join(w.O, ".git");
    process.env["GIT_INDEX_FILE"] = join(w.root, "no-such-index");
    process.env["GIT_WORK_TREE"] = w.O;
    try {
      const run = await wc(KG, w.C, true);
      expect(run.code, run.err).toBe(0);
      expect(samePath(run.doc["core"] as string, w.C, process.platform)).toBe(true);
      expect(run.doc["state"]).toBe("reused");
    } finally {
      for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_INDEX_FILE", saved.index], ["GIT_WORK_TREE", saved.tree]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("when origin/main moves, a clean worktree is moved to the new tip", async () => {
    const w = await worldWithWorktree();
    const newTip = advance(w);
    const run = await wc([...KG, ...COPY], w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc).toMatchObject({ state: "moved", headBefore: w.firstTip, head: newTip });
    expect(headOf(w.W)).toBe(newTip);
  });

  it("a worktree that sits ON A BRANCH at the tip is moved -- detached -- not reused", async () => {
    const w = await worldWithWorktree();
    mustGit(w.W, ["checkout", "--quiet", "-b", "scratch"]);
    const run = await wc(KG, w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc["state"]).toBe("moved");
    expect(git(w.W, ["symbolic-ref", "-q", "HEAD"]).code).not.toBe(0);
  });

  it("a dirty worktree is refused with every path listed, and never discarded", async () => {
    const w = await worldWithWorktree();
    writeFileSync(join(w.W, "README"), "hello\nedit\n");
    writeFileSync(join(w.W, "untracked.txt"), "mine\n");
    const run = await wc(KG, w.C, true);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/never reset, cleaned or discarded/);
    expect(run.doc["state"]).toBe("refused");
    expect(run.doc["refusal"]).toMatchObject({ kind: "dirty", paths: [" M README", "?? untracked.txt"] });
    expect(readFileSync(join(w.W, "README"), "utf8")).toBe("hello\nedit\n");
    expect(existsSync(join(w.W, "untracked.txt"))).toBe(true);
  });

  it("the copy SOURCE is proven in core: tracked, unignored and absent sources are refused", async () => {
    const w = world();
    const tracked = await wc([...KG, "--copy-from-core", "README"], w.C, true);
    expect(tracked.code).toBe(2);
    expect(tracked.err).toMatch(/is tracked in core/);
    expect(refusalKind(tracked)).toBe("copy-source");
    writeFileSync(join(w.C, "Kro", "Secret.env"), "x\n");
    const unignored = await wc([...KG, "--copy-from-core", "Kro/Secret.env"], w.C);
    expect(unignored.code).toBe(2);
    expect(unignored.err).toMatch(/not gitignored in core/);
    const absent = await wc([...KG, "--copy-from-core", "Kro/Other.xcconfig"], w.C);
    expect(absent.code).toBe(2);
    expect(absent.err).toMatch(/absent in core/);
  });

  it.skipIf(!LINKS)("a symlinked source, or a source under a symlinked directory in core, is refused", async () => {
    const w = world();
    symlinkSync(join(w.outside, "Config.xcconfig"), join(w.C, "Kro", "Other.xcconfig"));
    const leaf = await wc([...KG, "--copy-from-core", "Kro/Other.xcconfig"], w.C);
    expect(leaf.code).toBe(2);
    expect(leaf.err).toMatch(/is a symlink in core/);
    symlinkSync(w.outside, join(w.C, "Linked"));
    writeFileSync(join(w.C, ".git", "info", "exclude"), "/Linked\n");
    const parent = await wc([...KG, "--copy-from-core", "Linked/Config.xcconfig"], w.C);
    expect(parent.code).toBe(2);
    expect(parent.err).toMatch(/a symlink in core/);
  });

  it.skipIf(!LINKS)("a source reached through an IN-CORE symlinked segment ('ln -s Kro Alias') is refused as copy-source (F4)", async () => {
    const w = world();
    symlinkSync("Kro", join(w.C, "Alias"));
    writeFileSync(join(w.C, ".git", "info", "exclude"), "/Alias\n/Alias/\n");
    const run = await wc([...KG, "--copy-from-core", "Alias/Config.xcconfig"], w.C, true);
    expect(run.code).toBe(2);
    expect(refusalKind(run)).toBe("copy-source");
    expect(run.err).toMatch(/beneath 'Alias', a symlink in core/);
  });

  // THE DESTINATION AT THE TIP. The worktree must not move on any of these.
  it.skipIf(!LINKS)("a tip that tracks the destination's PARENT as a symlink is refused before the worktree moves", async () => {
    const w = await worldWithWorktree();
    rmSync(join(w.O, "Kro"), { recursive: true, force: true });
    symlinkSync(w.outside, join(w.O, "Kro"));
    commitIn(w.O, "parent-symlink");
    mustGit(w.O, [...PINNED, "push", "--quiet", "origin", "main"]);
    const run = await wc([...KG, ...COPY], w.C, true);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/TRACKED as a symlink/);
    expect(refusalKind(run)).toBe("copy-destination");
    expect(readFileSync(join(w.outside, "Config.xcconfig"), "utf8")).toBe("victim\n");
    expect(headOf(w.W)).toBe(w.firstTip);
  });

  it.skipIf(!LINKS)("a tip that tracks the destination LEAF as a symlink is refused", async () => {
    const w = await worldWithWorktree();
    symlinkSync(join(w.outside, "Config.xcconfig"), join(w.O, SECRET));
    mustGit(w.O, ["add", "-f", SECRET]);
    mustGit(w.O, ["commit", "--quiet", "-m", "leaf-symlink"]);
    mustGit(w.O, [...PINNED, "push", "--quiet", "origin", "main"]);
    const run = await wc([...KG, ...COPY], w.C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is TRACKED \(as .Kro\/Config.xcconfig.\) as a symlink/);
    expect(readFileSync(join(w.outside, "Config.xcconfig"), "utf8")).toBe("victim\n");
    expect(headOf(w.W)).toBe(w.firstTip);
  });

  it("a tip that tracks the destination as a regular file is refused, never overwritten", async () => {
    const w = await worldWithWorktree();
    writeFileSync(join(w.O, SECRET), "tracked placeholder\n");
    mustGit(w.O, ["add", "-f", SECRET]);
    mustGit(w.O, ["commit", "--quiet", "-m", "leaf-tracked"]);
    mustGit(w.O, [...PINNED, "push", "--quiet", "origin", "main"]);
    // A dry run reads the tip AS LAST FETCHED: before any fetch it still sees
    // the first tip, so the real run (which fetches) goes first.
    expect((await wc([...KG, ...COPY, "--dry-run"], w.C)).code).toBe(0);
    const run = await wc([...KG, ...COPY], w.C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is TRACKED \(as .Kro\/Config.xcconfig.\) -- the copy would overwrite a tracked file/);
    expect((await wc([...KG, ...COPY, "--dry-run"], w.C)).code).toBe(2);
    expect(mustGit(w.W, ["status", "--porcelain"])).toBe("");
    expect(headOf(w.W)).toBe(w.firstTip);
  });

  it.skipIf(!LINKS)("an UNTRACKED symlink at the destination inside the worktree is refused", async () => {
    const w = await worldWithWorktree();
    rmSync(join(w.W, SECRET));
    symlinkSync(join(w.outside, "Config.xcconfig"), join(w.W, SECRET));
    const run = await wc([...KG, ...COPY], w.C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is a symlink in the worktree/);
    expect(readFileSync(join(w.outside, "Config.xcconfig"), "utf8")).toBe("victim\n");
  });

  // F1: the trunk tracks the NFD spelling of a path core holds in NFC. The
  // commits are built with plumbing, so the NFD bytes are exactly what the tree
  // records whatever core.precomposeunicode says, and the symlink lives only in
  // the tree -- so both run on every platform.
  it("a tip tracking the NFD spelling of an NFC copy path is refused before anything moves, and nothing is overwritten (F1)", async () => {
    const w = await worldWithWorktree();
    const nfc = "caf\u00e9/app.env";
    mkdirSync(join(w.C, "caf\u00e9"), { recursive: true });
    writeFileSync(join(w.C, "caf\u00e9", "app.env"), "CREDENTIAL=1\n");
    writeFileSync(join(w.C, ".git", "info", "exclude"), `${nfc}\n`);
    const blob = gitIn(w.O, ["hash-object", "-w", "--stdin"], "tracked placeholder\n");
    const sub = gitIn(w.O, ["mktree"], `100644 blob ${blob}\tapp.env\n`);
    pushPlumbed(w, `040000 tree ${sub}\tcafe\u0301`, "nfd-tracked");
    const run = await wc([...KG, "--copy-from-core", nfc], w.C, true);
    expect(run.code, run.err).toBe(2);
    expect(run.doc).toMatchObject({ state: "refused", reached: null });
    expect(refusalKind(run)).toBe("copy-destination");
    expect(run.err).toMatch(/is TRACKED \(as 'cafe\u0301\/app.env'\)/);
    expect(headOf(w.W)).toBe(w.firstTip);
    expect(mustGit(w.W, ["status", "--porcelain"])).toBe("");
  });

  it("a tip tracking an NFD PARENT as a symlink is refused before anything is created (F1)", async () => {
    const w = await worldWithWorktree();
    const nfc = "caf\u00e9/app.env";
    mkdirSync(join(w.C, "caf\u00e9"), { recursive: true });
    writeFileSync(join(w.C, "caf\u00e9", "app.env"), "CREDENTIAL=1\n");
    writeFileSync(join(w.C, ".git", "info", "exclude"), `${nfc}\n`);
    const link = gitIn(w.O, ["hash-object", "-w", "--stdin"], w.outside);
    pushPlumbed(w, `120000 blob ${link}\tcafe\u0301`, "nfd-symlink-parent");
    const run = await wc([...KG, "--copy-from-core", nfc], w.C, true);
    expect(run.code, run.err).toBe(2);
    expect(run.err).toMatch(/lies beneath 'cafe\u0301', which is TRACKED as a symlink/);
    expect(headOf(w.W)).toBe(w.firstTip);
    expect(readFileSync(join(w.outside, "Config.xcconfig"), "utf8")).toBe("victim\n");
    expect(existsSync(join(w.outside, "app.env"))).toBe(false);
  });

  it("a move that would overwrite an IGNORED, untracked file the tip now tracks is refused, the file kept (N9)", async () => {
    const w = await worldWithWorktree();
    writeFileSync(join(w.W, "Kro", "Other.xcconfig"), "mine\n");
    const blob = gitIn(w.O, ["hash-object", "-w", "--stdin"], "theirs\n");
    const kro = mustGit(w.O, ["ls-tree", `${w.firstTip}:Kro`]);
    const sub = gitIn(w.O, ["mktree"], `${kro}\n100644 blob ${blob}\tOther.xcconfig\n`);
    pushPlumbed(w, `040000 tree ${sub}\tKro`, "track-other", "Kro");
    const run = await wc(KG, w.C, true);
    expect(run.code, run.err).toBe(2);
    expect(run.doc["refusal"]).toMatchObject({ kind: "would-overwrite-ignored", paths: ["Kro/Other.xcconfig"] });
    expect(readFileSync(join(w.W, "Kro", "Other.xcconfig"), "utf8")).toBe("mine\n");
    expect(headOf(w.W)).toBe(w.firstTip);
  });

  it("an ignored 'build/cache' does not refuse a move to a tip that adds 'build/out' (R3)", async () => {
    const w = await worldWithWorktree();
    writeFileSync(join(w.C, ".git", "info", "exclude"), "build/\n");
    mkdirSync(join(w.W, "build"), { recursive: true });
    writeFileSync(join(w.W, "build", "cache"), "cached\n");
    const blob = gitIn(w.O, ["hash-object", "-w", "--stdin"], "built\n");
    const sub = gitIn(w.O, ["mktree"], `100644 blob ${blob}\tout\n`);
    const tip = pushPlumbed(w, `040000 tree ${sub}\tbuild`, "build-out");
    const run = await wc(KG, w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc["state"]).toBe("moved");
    expect(headOf(w.W)).toBe(tip);
    expect(readFileSync(join(w.W, "build", "cache"), "utf8")).toBe("cached\n");
  });

  it("a stray directory beside a SIBLING registration ('kagutsuchi2') is refused, and core does not move", async () => {
    const w = world();
    mustGit(w.C, ["worktree", "add", "--quiet", "--detach", join(w.C, ".nen", "worktrees", "kagutsuchi2"), w.firstTip]);
    mkdirSync(w.W, { recursive: true });
    writeFileSync(join(w.W, "stray"), "");
    const before = { head: headOf(w.C), branch: mustGit(w.C, ["branch", "--show-current"]) };
    const run = await wc(KG, w.C, true);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is not a worktree of this project/);
    expect(run.err).toContain("kagutsuchi2");
    expect(refusalKind(run)).toBe("stray");
    expect(headOf(w.C)).toBe(before.head);
    expect(mustGit(w.C, ["branch", "--show-current"])).toBe(before.branch);
    expect(existsSync(join(w.W, "stray"))).toBe(true);
  });

  it.skipIf(!LINKS)("a symlinked .nen/worktrees under core is refused", async () => {
    const w = world();
    mkdirSync(join(w.C, ".nen"), { recursive: true });
    symlinkSync(w.outside, join(w.C, ".nen", "worktrees"));
    const run = await wc(KG, w.C, true);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is a symlink/);
    expect(refusalKind(run)).toBe("parent-symlink");
  });

  it.skipIf(!LINKS)("a symlink AT the fixed path is refused", async () => {
    const w = world();
    mkdirSync(join(w.C, ".nen", "worktrees"), { recursive: true });
    symlinkSync(w.outside, w.W);
    const run = await wc(KG, w.C, true);
    expect(run.code).toBe(2);
    expect(refusalKind(run)).toBe("symlink");
  });

  it("a plain directory at the fixed path that is not a worktree is refused", async () => {
    const w = world();
    mkdirSync(w.W, { recursive: true });
    writeFileSync(join(w.W, "stray"), "");
    const run = await wc(KG, w.C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is not a worktree of this project/);
  });

  it("a registration whose directory vanished: --dry-run plans the drop and keeps it; the real run drops only it and recreates", async () => {
    const w = await worldWithWorktree();
    // A second, unrelated vanished registration -- which a repository-wide
    // prune WOULD drop, and this verb must not.
    const other = join(w.root, "other-wt");
    mustGit(w.C, ["worktree", "add", "--quiet", "--detach", other, w.firstTip]);
    rmSync(other, { recursive: true, force: true });
    rmSync(w.W, { recursive: true, force: true });

    const dry = await wc([...KG, "--dry-run"], w.C, true);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.doc).toMatchObject({ state: "recreated", dropped: true });
    expect(isRegistered(w.C, w.W)).toBe(true);

    const run = await wc([...KG, ...COPY], w.C);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("(recreated (its vanished registration dropped))");
    expect(readFileSync(join(w.W, SECRET), "utf8")).toBe("SUPABASE_URL = x\n");
    expect(isRegistered(w.C, other)).toBe(true);
    expect(lstatSync(w.W).isDirectory()).toBe(true);
  });

  it("a LOCKED registration whose directory is gone is refused, dry and real, and kept (N3)", async () => {
    const w = await worldWithWorktree();
    mustGit(w.C, ["worktree", "lock", w.W]);
    rmSync(w.W, { recursive: true, force: true });
    for (const flags of [["--dry-run"], []]) {
      const run = await wc([...KG, ...flags], w.C, true);
      expect(run.code, run.err).toBe(2);
      expect(refusalKind(run)).toBe("locked");
    }
    expect(isRegistered(w.C, w.W)).toBe(true);
    mustGit(w.C, ["worktree", "unlock", w.W]);
    const back = await wc([...KG, ...COPY], w.C);
    expect(back.code, back.err).toBe(0);
    expect(back.out).toContain("recreated");
  });

  it("--json is the nen.wc.worktree/v0.1 contract, in its key order", async () => {
    const w = await worldWithWorktree();
    const run = await wc([...KG, ...COPY], w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(Object.keys(run.doc)).toEqual([
      "contract",
      "core",
      "name",
      "path",
      "base",
      "tip",
      "fetched",
      "state",
      "reached",
      "dryRun",
      "headBefore",
      "head",
      "dropped",
      "coreIgnored",
      "copies",
      "removed",
      "kept",
      "refusal",
    ]);
    expect(run.doc).toMatchObject({
      contract: WORKTREE_CONTRACT,
      name: "kagutsuchi",
      base: "main",
      tip: w.firstTip,
      fetched: true,
      state: "reused",
      reached: "reused",
      dryRun: false,
      headBefore: w.firstTip,
      head: w.firstTip,
      dropped: false,
      coreIgnored: true,
      copies: [{ path: SECRET, action: "copied" }],
      removed: [],
      kept: [],
      refusal: null,
    });
    expect(samePath(run.doc["core"] as string, w.C, process.platform)).toBe(true);
    expect(samePath(run.doc["path"] as string, w.W, process.platform)).toBe(true);
  });

  // RETENTION (F3, then round 2's R1, R2, N2, N3).
  const readRecord = (w: World): { contract: string; copies: Array<{ path: string; hmac: string | null }> } =>
    JSON.parse(readFileSync(join(w.gitDir, MANIFEST_FILE), "utf8")) as { contract: string; copies: Array<{ path: string; hmac: string | null }> };

  it("a copy no longer named is removed when its bytes are as copied; --dry-run only says so", async () => {
    const w = await worldWithWorktree();
    const dry = await wc([...KG, "--dry-run"], w.C, true);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.doc["removed"]).toEqual([{ path: SECRET, action: "would-remove" }]);
    expect(existsSync(join(w.W, SECRET))).toBe(true);
    const run = await wc(KG, w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc["removed"]).toEqual([{ path: SECRET, action: "removed" }]);
    expect(existsSync(join(w.W, SECRET))).toBe(false);
  });

  it("an EDITED copy no longer named is kept, listed, and never deleted", async () => {
    const w = await worldWithWorktree();
    writeFileSync(join(w.W, SECRET), "SUPABASE_URL = edited by hand\n");
    const run = await wc(KG, w.C);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`kept:            ${SECRET} (edited since copy)`);
    expect(readFileSync(join(w.W, SECRET), "utf8")).toBe("SUPABASE_URL = edited by hand\n");
    rmSync(join(w.W, SECRET));
    expect((await wc(KG, w.C, true)).doc["kept"]).toEqual([]);
  });

  it("a copy whose core source was deleted is no longer nameable, and goes the same way", async () => {
    const w = world();
    writeFileSync(join(w.C, "Kro", "Other.xcconfig"), "OTHER=1\n");
    expect((await wc([...KG, "--copy-from-core", "Kro/Other.xcconfig"], w.C)).code).toBe(0);
    rmSync(join(w.C, "Kro", "Other.xcconfig"));
    const named = await wc([...KG, "--copy-from-core", "Kro/Other.xcconfig"], w.C);
    expect(named.code).toBe(2);
    expect(named.err).toMatch(/absent in core/);
    const run = await wc(KG, w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc["removed"]).toEqual([{ path: "Kro/Other.xcconfig", action: "removed" }]);
    expect(existsSync(join(w.W, "Kro", "Other.xcconfig"))).toBe(false);
  });

  it("a record entry naming a TRACKED file whose bytes verify is kept, never deleted (R1)", async () => {
    const w = await worldWithWorktree();
    const key = readFileSync(join(w.gitDir, KEY_FILE));
    const hmac = createHmac("sha256", key).update(readFileSync(join(w.W, "README"))).digest("hex");
    writeFileSync(join(w.gitDir, MANIFEST_FILE), JSON.stringify({ contract: MANIFEST_CONTRACT, copies: [{ path: "README", hmac }] }));
    const run = await wc(KG, w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc["removed"]).toEqual([]);
    expect(run.doc["kept"]).toEqual([{ path: "README", reason: "tracked at the tip" }]);
    expect(existsSync(join(w.W, "README"))).toBe(true);
    expect(mustGit(w.W, ["status", "--porcelain"])).toBe("");
  });

  it("a refusal on one named path keeps the record of another still-named copy; a later run still reports it (R2)", async () => {
    const w = await worldWithWorktree();
    writeFileSync(join(w.C, "Kro", "Other.xcconfig"), "OTHER=1\n");
    mkdirSync(join(w.W, "Kro", "Other.xcconfig"));
    const run = await wc([...KG, "--copy-from-core", "Kro/Other.xcconfig", ...COPY], w.C, true);
    expect(run.code).toBe(2);
    expect(refusalKind(run)).toBe("copy-destination");
    expect(readRecord(w).copies.map((copy) => copy.path)).toEqual([SECRET]);
    rmSync(join(w.W, "Kro", "Other.xcconfig"), { recursive: true });
    const later = await wc(KG, w.C, true);
    expect(later.doc["removed"]).toEqual([{ path: SECRET, action: "removed" }]);
  });

  it("a v0.1 record's entries are kept as unverifiable, and the record is rewritten as v0.2 (N3)", async () => {
    const w = await worldWithWorktree();
    const sha256 = createHash("sha256").update(readFileSync(join(w.W, SECRET))).digest("hex");
    writeFileSync(join(w.gitDir, MANIFEST_FILE), JSON.stringify({ contract: MANIFEST_CONTRACT_V1, copies: [{ path: SECRET, sha256 }] }));
    const run = await wc(KG, w.C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc["kept"]).toEqual([{ path: SECRET, reason: "unverifiable record" }]);
    expect(existsSync(join(w.W, SECRET))).toBe(true);
    expect(readRecord(w)).toEqual({ contract: MANIFEST_CONTRACT, copies: [{ path: SECRET, hmac: null }] });
    rmSync(join(w.W, SECRET));
    expect((await wc(KG, w.C, true)).doc["kept"]).toEqual([]);
  });

  it("a crashed run's leftovers in the worktree git dir are swept on the next real run, and only those (N2)", async () => {
    const w = await worldWithWorktree();
    writeFileSync(join(w.gitDir, "nen-wc-worktree-copy.0123456789abcdef"), "partial credential");
    writeFileSync(join(w.gitDir, "nen-wc-worktree-copies.json.0123456789ab.tmp"), "{");
    writeFileSync(join(w.gitDir, "nen-wc-worktree-copy.keep"), "not ours");
    expect((await wc([...KG, "--dry-run"], w.C)).code).toBe(0);
    expect(existsSync(join(w.gitDir, "nen-wc-worktree-copy.0123456789abcdef"))).toBe(true);
    expect((await wc(KG, w.C)).code).toBe(0);
    expect(existsSync(join(w.gitDir, "nen-wc-worktree-copy.0123456789abcdef"))).toBe(false);
    expect(existsSync(join(w.gitDir, "nen-wc-worktree-copies.json.0123456789ab.tmp"))).toBe(false);
    expect(existsSync(join(w.gitDir, "nen-wc-worktree-copy.keep"))).toBe(true);
  });

  it("a checkout with no origin remote is refused as base, dry and real (R5)", async () => {
    const w = world();
    const lone = join(w.root, "lone");
    mustGit(w.root, ["init", "--quiet", "--initial-branch=main", lone]);
    pin(lone);
    writeFileSync(join(lone, "README"), "x\n");
    commitIn(lone, "lone");
    for (const flags of [["--dry-run"], []]) {
      const run = await wc([...KG, ...flags], lone, true);
      expect(run.code).toBe(2);
      expect(refusalKind(run)).toBe("base");
      expect(run.err).toMatch(/no origin remote/);
    }
    expect(existsSync(join(lone, ".nen"))).toBe(false);
  });
});
