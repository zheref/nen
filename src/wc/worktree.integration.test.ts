// src/wc/worktree.integration.test.ts -- `nen wc worktree` against the REAL
// git, in a throwaway project: a bare `origin`, a core clone, a second clone
// that moves the trunk, and a gitignored file in core to copy (zheref/nen#299).
//
// THE SEQUENCE IS THE REFERENCE SCRIPT'S SELF-TEST, PORTED (zheref/hatsu
// `scripts/kagutsuchi_worktree.sh --self-test`): the plan, the creation, the
// reuse, the move, the dirty refusal, the copy proofs in core and at the tip
// -- a tracked PARENT symlink, a tracked LEAF symlink, a tracked regular file,
// an UNTRACKED symlink at the destination -- the sibling registration, the
// symlinked parent, the stray directory and the vanished registration. The
// fixtures are a sequence (a reuse only means something after a creation), so
// the `it`s run in order over one evolving fixture. Two things the script
// never proved are added: a tip refusal leaves the worktree where it was
// (proven against the tip's tree before anything moves), and an inherited
// GIT_DIR / GIT_INDEX_FILE does not redirect the verb.
//
// The fixture shape is ./swap.integration.test.ts's: repo-local identity,
// `core.autocrlf=false`, `protocol.file.allow=always`, git >= 2.31, and a loud
// SKIP where no usable git is on PATH.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { wcCommand } from "./command.js";
import { WORKTREE_CONTRACT } from "./worktree.js";

const PINNED = ["-c", "core.autocrlf=false", "-c", "protocol.file.allow=always"];

function git(cwd: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env["GIT_DIR"];
  delete env["GIT_INDEX_FILE"];
  delete env["GIT_WORK_TREE"];
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8", env });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
/** Symlinks need a privilege on Windows that CI does not grant; the symlink fixtures are POSIX-only. */
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

let root = "";
let C = "";
let O = "";
let W = "";
let firstTip = "";
let newTip = "";
const SECRET = "Kro/Config.xcconfig";
const KG = ["--name", "kagutsuchi", "--base", "main"];
const COPY = ["--copy-from-core", SECRET];

const headOf = (repo: string): string => mustGit(repo, ["rev-parse", "HEAD"]);

function commitIn(repo: string, message: string): void {
  mustGit(repo, ["add", "-A"]);
  mustGit(repo, ["commit", "--quiet", "-m", message]);
}

beforeAll(() => {
  if (!HAVE_GIT) return;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-wc-worktree-git-")));
  const origin = join(root, "origin.git");
  C = join(root, "core");
  O = join(root, "other");
  W = join(C, ".nen", "worktrees", "kagutsuchi");
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
  firstTip = headOf(C);
  mustGit(root, [...PINNED, "clone", "--quiet", origin, O]);
  pin(O);
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!HAVE_GIT)("nen wc worktree -- the reference self-test, ported", () => {
  it("refuses a missing --name, a missing --base, a bad name, a bad copy path and a non-checkout, all at exit 2", async () => {
    expect((await wc(["--base", "main"], C)).code).toBe(2);
    expect((await wc(["--name", "kagutsuchi"], C)).code).toBe(2);
    const badName = await wc(["--name", "../x", "--base", "main"], C);
    expect(badName.code).toBe(2);
    expect(badName.err).toMatch(/one plain path segment/);
    const escape = await wc([...KG, "--copy-from-core", "../outside"], C);
    expect(escape.code).toBe(2);
    const glob = await wc([...KG, "--copy-from-core", "Kro/*.xcconfig"], C);
    expect(glob.code).toBe(2);
    expect(glob.err).toMatch(/one literal path/);
    const dup = await wc([...KG, ...COPY, ...COPY], C);
    expect(dup.code).toBe(2);
    const outside = await wc(KG, root);
    expect(outside.code).toBe(2);
    expect(outside.err).toMatch(/not inside a git checkout/);
    const option = await wc(["--name", "kagutsuchi", "--base", "+main"], C);
    expect(option.code).toBe(2);
    expect(existsSync(W)).toBe(false);
  });

  it("--dry-run on a fresh core prints the plan and creates nothing", async () => {
    const run = await wc([...KG, ...COPY, "--dry-run"], C);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("would create");
    expect(run.out).toContain("as last fetched");
    expect(run.out).toContain(`copied:          ${SECRET} (would copy from core)`);
    expect(existsSync(join(C, ".nen"))).toBe(false);
  });

  it("creates one worktree at origin/main's tip with the named file copied, and it stays clean", async () => {
    const run = await wc([...KG, ...COPY], C);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`worktree:        ${W} (created)`);
    expect(run.out).toContain(`copied:          ${SECRET} (from core, gitignored)`);
    expect(run.out).toContain("core-ignore:     .nen/worktrees/kagutsuchi is gitignored in core");
    expect(readFileSync(join(W, SECRET), "utf8")).toBe("SUPABASE_URL = x\n");
    expect(headOf(W)).toBe(firstTip);
    expect(git(W, ["symbolic-ref", "-q", "HEAD"]).code).not.toBe(0);
    expect(mustGit(W, ["status", "--porcelain"])).toBe("");
  });

  it("a second run at the same tip reuses it: still exactly one managed worktree beside core", async () => {
    const run = await wc([...KG, ...COPY], C);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("(reused)");
    const count = mustGit(C, ["worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).length;
    expect(count).toBe(2);
  });

  it("invoked FROM the worktree, core is resolved and the run is a no-op", async () => {
    const run = await wc(KG, W);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(`core:            ${C}`);
    expect(run.out).toContain("(reused)");
  });

  it("an inherited GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE does not redirect it", async () => {
    const saved = { dir: process.env["GIT_DIR"], index: process.env["GIT_INDEX_FILE"], tree: process.env["GIT_WORK_TREE"] };
    process.env["GIT_DIR"] = join(O, ".git");
    process.env["GIT_INDEX_FILE"] = join(root, "no-such-index");
    process.env["GIT_WORK_TREE"] = O;
    try {
      const run = await wc(KG, C, true);
      expect(run.code, run.err).toBe(0);
      expect(run.doc["core"]).toBe(C);
      expect(run.doc["state"]).toBe("reused");
    } finally {
      for (const [key, value] of [["GIT_DIR", saved.dir], ["GIT_INDEX_FILE", saved.index], ["GIT_WORK_TREE", saved.tree]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("when origin/main moves, a clean worktree is moved to the new tip", async () => {
    writeFileSync(join(O, "README"), "hello\nnewer\n");
    commitIn(O, "newer");
    mustGit(O, [...PINNED, "push", "--quiet", "origin", "main"]);
    newTip = headOf(O);
    const run = await wc([...KG, ...COPY], C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc["state"]).toBe("moved");
    expect(run.doc["headBefore"]).toBe(firstTip);
    expect(run.doc["head"]).toBe(newTip);
    expect(headOf(W)).toBe(newTip);
  });

  it("a worktree that sits ON A BRANCH at the tip is moved -- detached -- not reused", async () => {
    mustGit(W, ["checkout", "--quiet", "-b", "scratch"]);
    const run = await wc(KG, C, true);
    expect(run.code, run.err).toBe(0);
    expect(run.doc["state"]).toBe("moved");
    expect(git(W, ["symbolic-ref", "-q", "HEAD"]).code).not.toBe(0);
    mustGit(C, ["branch", "-D", "scratch"]);
  });

  it("a dirty worktree is refused with every path listed, and never discarded", async () => {
    writeFileSync(join(W, "README"), "hello\nnewer\nedit\n");
    writeFileSync(join(W, "untracked.txt"), "mine\n");
    const run = await wc(KG, C, true);
    expect(run.code).toBe(2);
    expect(run.err).toContain("README");
    expect(run.err).toContain("untracked.txt");
    expect(run.err).toMatch(/never reset, cleaned or discarded/);
    const refusal = run.doc["refusal"] as { kind: string; paths: string[] };
    expect(run.doc["state"]).toBe("refused");
    expect(refusal.kind).toBe("dirty");
    expect(refusal.paths).toEqual([" M README", "?? untracked.txt"]);
    expect(readFileSync(join(W, "README"), "utf8")).toBe("hello\nnewer\nedit\n");
    expect(existsSync(join(W, "untracked.txt"))).toBe(true);
    mustGit(W, ["checkout", "--quiet", "--", "README"]);
    rmSync(join(W, "untracked.txt"));
  });

  it("the copy SOURCE is proven in core: tracked, unignored, absent and symlinked sources are refused", async () => {
    const tracked = await wc([...KG, "--copy-from-core", "README"], C, true);
    expect(tracked.code).toBe(2);
    expect(tracked.err).toMatch(/is tracked in core/);
    expect((tracked.doc["refusal"] as { kind: string }).kind).toBe("copy-source");

    writeFileSync(join(C, "Kro", "Secret.env"), "x\n");
    const unignored = await wc([...KG, "--copy-from-core", "Kro/Secret.env"], C);
    expect(unignored.code).toBe(2);
    expect(unignored.err).toMatch(/not gitignored in core/);
    rmSync(join(C, "Kro", "Secret.env"));

    const absent = await wc([...KG, "--copy-from-core", "Kro/Other.xcconfig"], C);
    expect(absent.code).toBe(2);
    expect(absent.err).toMatch(/absent in core/);
  });

  it.skipIf(!LINKS)("a symlinked source, or a source under a symlinked directory in core, is refused", async () => {
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(join(root, "outside", "Config.xcconfig"), "victim\n");
    symlinkSync(join(root, "outside", "Config.xcconfig"), join(C, "Kro", "Other.xcconfig"));
    const leaf = await wc([...KG, "--copy-from-core", "Kro/Other.xcconfig"], C);
    expect(leaf.code).toBe(2);
    expect(leaf.err).toMatch(/is a symlink in core/);
    rmSync(join(C, "Kro", "Other.xcconfig"));

    symlinkSync(join(root, "outside"), join(C, "Linked"));
    writeFileSync(join(C, ".git", "info", "exclude"), "/Linked\n");
    const parent = await wc([...KG, "--copy-from-core", "Linked/Config.xcconfig"], C);
    expect(parent.code).toBe(2);
    expect(parent.err).toMatch(/does not stand inside core/);
    rmSync(join(C, "Linked"));
    writeFileSync(join(C, ".git", "info", "exclude"), "");
  });

  // THE DESTINATION AT THE TIP. Three trunk commits chained as fast-forwards,
  // so the verb's no-'+' fetch never sees a rewound origin until the fixture
  // rewinds BOTH refs at the end.
  it.skipIf(!LINKS)("a tip that tracks the destination's PARENT as a symlink is refused before the worktree moves", async () => {
    mustGit(O, [...PINNED, "pull", "--quiet", "--ff-only"]);
    rmSync(join(O, "Kro"), { recursive: true, force: true });
    symlinkSync(join(root, "outside"), join(O, "Kro"));
    commitIn(O, "parent-symlink");
    mustGit(O, [...PINNED, "push", "--quiet", "origin", "main"]);
    const run = await wc([...KG, ...COPY], C, true);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/TRACKED as a symlink/);
    expect((run.doc["refusal"] as { kind: string }).kind).toBe("copy-destination");
    expect(readFileSync(join(root, "outside", "Config.xcconfig"), "utf8")).toBe("victim\n");
    expect(headOf(W)).toBe(newTip);
  });

  it.skipIf(!LINKS)("a tip that tracks the destination LEAF as a symlink is refused", async () => {
    rmSync(join(O, "Kro"));
    mkdirSync(join(O, "Kro"));
    writeFileSync(join(O, "Kro", "keep.txt"), "kept\n");
    symlinkSync(join(root, "outside", "Config.xcconfig"), join(O, SECRET));
    mustGit(O, ["add", "-A"]);
    mustGit(O, ["add", "-f", SECRET]);
    mustGit(O, ["commit", "--quiet", "-m", "leaf-symlink"]);
    mustGit(O, [...PINNED, "push", "--quiet", "origin", "main"]);
    const run = await wc([...KG, ...COPY], C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is TRACKED \(as .Kro\/Config.xcconfig.\) as a symlink/);
    expect(readFileSync(join(root, "outside", "Config.xcconfig"), "utf8")).toBe("victim\n");
    expect(headOf(W)).toBe(newTip);
  });

  it.skipIf(!LINKS)("a tip that tracks the destination as a regular file is refused, never overwritten", async () => {
    rmSync(join(O, SECRET));
    writeFileSync(join(O, SECRET), "tracked placeholder\n");
    mustGit(O, ["add", "-f", SECRET]);
    mustGit(O, ["commit", "--quiet", "-m", "leaf-tracked"]);
    mustGit(O, [...PINNED, "push", "--quiet", "origin", "main"]);
    const dry = await wc([...KG, ...COPY, "--dry-run"], C);
    expect(dry.code).toBe(2);
    const run = await wc([...KG, ...COPY], C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is TRACKED \(as .Kro\/Config.xcconfig.\) -- the copy would overwrite a tracked file/);
    expect(mustGit(W, ["status", "--porcelain"])).toBe("");
    expect(headOf(W)).toBe(newTip);
    // Rewind the trunk on both sides, so the next fetch is a fast-forward again.
    mustGit(join(root, "origin.git"), ["update-ref", "refs/heads/main", newTip]);
    mustGit(C, ["update-ref", "refs/remotes/origin/main", newTip]);
    mustGit(O, ["reset", "--quiet", "--hard", newTip]);
  });

  it.skipIf(!LINKS)("an UNTRACKED symlink at the destination inside the worktree is refused", async () => {
    const back = await wc([...KG, ...COPY], C);
    expect(back.code, back.err).toBe(0);
    rmSync(join(W, SECRET));
    symlinkSync(join(root, "outside", "Config.xcconfig"), join(W, SECRET));
    const run = await wc([...KG, ...COPY], C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is a symlink in the worktree/);
    expect(readFileSync(join(root, "outside", "Config.xcconfig"), "utf8")).toBe("victim\n");
    rmSync(join(W, SECRET));
  });

  it("a stray directory beside a SIBLING registration ('kagutsuchi2') is refused, and core does not move", async () => {
    mustGit(C, ["worktree", "add", "--quiet", "--detach", join(C, ".nen", "worktrees", "kagutsuchi2"), newTip]);
    mustGit(C, ["worktree", "remove", "--force", W]);
    mkdirSync(W, { recursive: true });
    writeFileSync(join(W, "stray"), "");
    const before = { head: headOf(C), branch: mustGit(C, ["branch", "--show-current"]) };
    const run = await wc(KG, C, true);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is not a worktree of this project/);
    expect(run.err).toContain("kagutsuchi2");
    expect((run.doc["refusal"] as { kind: string }).kind).toBe("stray");
    expect(headOf(C)).toBe(before.head);
    expect(mustGit(C, ["branch", "--show-current"])).toBe(before.branch);
    expect(existsSync(join(W, "stray"))).toBe(true);
    rmSync(W, { recursive: true, force: true });
    mustGit(C, ["worktree", "remove", "--force", join(C, ".nen", "worktrees", "kagutsuchi2")]);
  });

  it.skipIf(!LINKS)("a symlinked .nen/worktrees under core is refused", async () => {
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    rmSync(join(C, ".nen", "worktrees"), { recursive: true, force: true });
    symlinkSync(join(root, "elsewhere"), join(C, ".nen", "worktrees"));
    const run = await wc(KG, C, true);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is a symlink/);
    expect((run.doc["refusal"] as { kind: string }).kind).toBe("parent-symlink");
    rmSync(join(C, ".nen", "worktrees"));
  });

  it.skipIf(!LINKS)("a symlink AT the fixed path is refused", async () => {
    mkdirSync(join(C, ".nen", "worktrees"), { recursive: true });
    symlinkSync(join(root, "elsewhere"), W);
    const run = await wc(KG, C, true);
    expect(run.code).toBe(2);
    expect((run.doc["refusal"] as { kind: string }).kind).toBe("symlink");
    rmSync(W);
  });

  it("a plain directory at the fixed path that is not a worktree is refused", async () => {
    mkdirSync(W, { recursive: true });
    writeFileSync(join(W, "stray"), "");
    const run = await wc(KG, C);
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/is not a worktree of this project/);
    rmSync(W, { recursive: true, force: true });
  });

  it("a registration whose directory vanished: --dry-run plans the drop and keeps it; the real run drops only it and recreates", async () => {
    const made = await wc([...KG, ...COPY], C);
    expect(made.code, made.err).toBe(0);
    expect(made.out).toContain("(created)");
    // A second, unrelated vanished registration -- which a repository-wide
    // prune WOULD drop, and this verb must not.
    const other = join(root, "other-wt");
    mustGit(C, ["worktree", "add", "--quiet", "--detach", other, newTip]);
    rmSync(other, { recursive: true, force: true });
    rmSync(W, { recursive: true, force: true });

    const dry = await wc([...KG, "--dry-run"], C, true);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.doc["state"]).toBe("recreated");
    expect(dry.doc["dropped"]).toBe(true);
    expect(mustGit(C, ["worktree", "list", "--porcelain"])).toContain(`worktree ${W}`);

    const run = await wc([...KG, ...COPY], C);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain("(recreated (its vanished registration dropped))");
    expect(readFileSync(join(W, SECRET), "utf8")).toBe("SUPABASE_URL = x\n");
    const list = mustGit(C, ["worktree", "list", "--porcelain"]);
    expect(list).toContain(`worktree ${other}`);
    expect(lstatSync(W).isDirectory()).toBe(true);
    mustGit(C, ["worktree", "remove", "--force", other]);
  });

  it("--json is the nen.wc.worktree/v0.1 contract, in its key order", async () => {
    const run = await wc([...KG, ...COPY], C, true);
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
      "dryRun",
      "headBefore",
      "head",
      "dropped",
      "coreIgnored",
      "copies",
      "refusal",
    ]);
    expect(run.doc).toMatchObject({
      contract: WORKTREE_CONTRACT,
      core: C,
      name: "kagutsuchi",
      path: W,
      base: "main",
      tip: newTip,
      fetched: true,
      state: "reused",
      dryRun: false,
      headBefore: newTip,
      head: newTip,
      dropped: false,
      coreIgnored: true,
      copies: [{ path: SECRET, action: "copied" }],
      refusal: null,
    });
  });
});
