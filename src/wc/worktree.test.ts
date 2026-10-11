// src/wc/worktree.test.ts -- `nen wc worktree` over SCRIPTED seams and a fake
// filesystem (zheref/nen#299): the argument refusals that spend no git call,
// the scrubbed environment every call carries, the `--end-of-options` on every
// call that takes a ref or a path positionally, the dry run that writes
// nothing, the drop that is scoped to ONE registration, and the dirty refusal.
// ./worktree.integration.test.ts proves the same table against the real git.

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stats } from "node:fs";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { wcCommand } from "./command.js";
import {
  copyPathRefusal,
  manageWorktree,
  nameRefusal,
  parseRegistrations,
  parseStatusZ,
  scrubbedGitEnv,
  type WorktreeFs,
} from "./worktree.js";

type Kind = "dir" | "file" | "link";

function stat(kind: Kind): Stats {
  return {
    isDirectory: (): boolean => kind === "dir",
    isFile: (): boolean => kind === "file",
    isSymbolicLink: (): boolean => kind === "link",
  } as unknown as Stats;
}

interface FakeFs extends WorktreeFs {
  readonly made: string[];
  readonly copied: Array<readonly [string, string]>;
}

function fakeFs(entries: Readonly<Record<string, Kind>>): FakeFs {
  const tree = new Map<string, Kind>(Object.entries(entries));
  const made: string[] = [];
  const copied: Array<readonly [string, string]> = [];
  return {
    made,
    copied,
    lstat: (path: string): Stats | null => {
      const kind = tree.get(path);
      return kind === undefined ? null : stat(kind);
    },
    realpath: (path: string): string => path,
    mkdirp: (path: string): void => {
      made.push(path);
      tree.set(path, "dir");
    },
    copyFile: (source: string, destination: string): void => {
      copied.push([source, destination]);
      tree.set(destination, "file");
    },
  };
}

const CORE = join(tmpdir(), "nen-wc-worktree-unit", "core");
const PARENT = join(CORE, ".nen", "worktrees");
const PATH = join(PARENT, "kg");
const TIP = "a".repeat(40);
const OLD = "b".repeat(40);

function corePorcelain(...extra: string[]): string {
  return [`worktree ${CORE}`, `HEAD ${OLD}`, "branch refs/heads/main", "", ...extra].join("\n");
}

function base(): ScriptedCall[] {
  return [
    { match: "git rev-parse --path-format=absolute --git-common-dir", result: { stdout: `${join(CORE, ".git")}\n` } },
    { match: "git rev-parse --is-bare-repository", result: { stdout: "false\n" } },
    { match: "git check-ref-format --branch main", result: { stdout: "main\n" } },
    { match: "git rev-parse --verify --quiet --end-of-options refs/remotes/origin/main^{commit}", result: { stdout: `${TIP}\n` } },
    { match: "git fetch --quiet --end-of-options origin refs/heads/main:refs/remotes/origin/main", result: {} },
    { match: "git check-ignore -q -- .nen/worktrees/kg", result: { code: 0 } },
  ];
}

const OPTIONS = { name: "kg", base: "main", copyFromCore: [] as string[], dryRun: false };

describe("scrubbedGitEnv", () => {
  it("drops every redirect and every GIT_CONFIG_KEY/VALUE_<n>, and keeps nothing else of the caller's", () => {
    const env = scrubbedGitEnv({ GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: "/x", GIT_CONFIG_KEY_ZZ: "kept", PATH: "/bin" });
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
      expect(key in env, key).toBe(true);
      expect(env[key], key).toBeUndefined();
    }
    expect("GIT_CONFIG_KEY_ZZ" in env).toBe(false);
    expect("PATH" in env).toBe(false);
    expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });
});

describe("the lexical refusals", () => {
  it.each(["kg", "kagutsuchi", "a.b_c-1"])("admits the name %s", (name) => {
    expect(nameRefusal(name)).toBeNull();
  });
  it.each(["", "..", "../x", "a/b", ".hidden", "-x", "x..y", "x.lock", "a b", "a\\b", "x".repeat(101)])("refuses the name %j", (name) => {
    expect(nameRefusal(name)).not.toBeNull();
  });
  it.each(["Kro/Config.xcconfig", ".env", "a/b c/d.txt"])("admits the copy path %s", (path) => {
    expect(copyPathRefusal(path)).toBeNull();
  });
  it.each(["", "/etc/hosts", "C:/x", "../x", "a/../b", "a//b", "a/", "./a", "Kro/*.x", "a?b", "[a]", "a\\b", ":(glob)x", ".git/config", "sub/.GIT/x", "a\nb"])(
    "refuses the copy path %j",
    (path) => {
      expect(copyPathRefusal(path)).not.toBeNull();
    },
  );
});

describe("the parsers", () => {
  it("reads every registration, prunable and detached marked, a sibling kept distinct", () => {
    const rows = parseRegistrations(corePorcelain(`worktree ${PATH}2`, `HEAD ${TIP}`, "detached", "", `worktree ${PATH}`, `HEAD ${TIP}`, "detached", "prunable gitdir file points to non-existent location", ""));
    expect(rows.map((row) => row.path)).toEqual([CORE, `${PATH}2`, PATH]);
    expect(rows.map((row) => row.prunable)).toEqual([false, false, true]);
    expect(rows.map((row) => row.detached)).toEqual([false, true, true]);
  });
  it("lists a -z status one entry per change, a rename with both names", () => {
    expect(parseStatusZ(" M README\0?? new file.txt\0R  b.txt\0a.txt\0")).toEqual([" M README", "?? new file.txt", "R  a.txt -> b.txt"]);
    expect(parseStatusZ("")).toEqual([]);
  });
});

describe("manageWorktree over scripted git", () => {
  it("--dry-run on an absent path fetches nothing, creates nothing, and says it would create", () => {
    const seams = new ScriptedSeams([...base(), { match: "git worktree list --porcelain", result: { stdout: corePorcelain() } }], {
      env: { GIT_DIR: "/elsewhere/.git", GIT_CONFIG_KEY_0: "core.hooksPath" },
    });
    const fs = fakeFs({});
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, dryRun: true, copyFromCore: [] }, fs);
    expect(outcome.kind).toBe("done");
    expect(outcome.report).toMatchObject({ state: "created", dryRun: true, fetched: false, tip: TIP, head: TIP, dropped: false });
    expect(seams.calls.some((call) => call.args[0] === "fetch")).toBe(false);
    expect(seams.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "add")).toBe(false);
    expect(fs.made).toEqual([]);
    if (outcome.kind === "done") expect(outcome.lines.join("\n")).toContain("(would create)");
    for (const call of seams.calls) {
      expect(call.env !== null && "GIT_DIR" in call.env && call.env["GIT_DIR"] === undefined, call.args.join(" ")).toBe(true);
      expect(call.env !== null && "GIT_CONFIG_KEY_0" in call.env, call.args.join(" ")).toBe(true);
    }
  });

  it("a real run on an absent path fetches, makes the parent, and adds --detach behind --end-of-options", () => {
    const seams = new ScriptedSeams([
      ...base(),
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain() } },
      { match: `git worktree add --quiet --detach --end-of-options ${PATH} ${TIP}`, result: {} },
    ]);
    const fs = fakeFs({});
    const outcome = manageWorktree(seams, CORE, OPTIONS, fs);
    expect(outcome.report).toMatchObject({ state: "created", fetched: true });
    expect(fs.made).toEqual([PARENT]);
    expect(seams.calls.find((call) => call.args[0] === "fetch")?.args).toContain("--end-of-options");
  });

  it("a vanished registration: --dry-run keeps it; a real run removes ONLY that path and never prunes", () => {
    const porcelain = corePorcelain(`worktree ${PATH}`, `HEAD ${TIP}`, "detached", "prunable gitdir file points to non-existent location", "");
    const dry = new ScriptedSeams([...base(), { match: "git worktree list --porcelain", result: { stdout: porcelain } }]);
    const planned = manageWorktree(dry, CORE, { ...OPTIONS, dryRun: true }, fakeFs({ [PARENT]: "dir" }));
    expect(planned.report).toMatchObject({ state: "recreated", dropped: true, dryRun: true });
    expect(dry.calls.some((call) => call.args[1] === "remove")).toBe(false);

    const real = new ScriptedSeams([
      ...base(),
      { match: "git worktree list --porcelain", result: { stdout: porcelain } },
      { match: `git worktree remove --force --end-of-options ${PATH}`, result: {} },
      { match: `git worktree add --quiet --detach --end-of-options ${PATH} ${TIP}`, result: {} },
    ]);
    const done = manageWorktree(real, CORE, OPTIONS, fakeFs({ [PARENT]: "dir" }));
    expect(done.report).toMatchObject({ state: "recreated", dropped: true });
    expect(real.calls.some((call) => call.args.includes("prune"))).toBe(false);
  });

  it("a dirty worktree is refused with its paths, and nothing after the status is run", () => {
    const seams = new ScriptedSeams([
      ...base(),
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain(`worktree ${PATH}`, `HEAD ${OLD}`, "detached", "") } },
      { match: "git rev-parse --path-format=absolute --show-toplevel", result: { stdout: `${PATH}\n` } },
      { match: "git status --porcelain=v1 -z --untracked-files=all", result: { stdout: " M README\0?? x\0" } },
    ]);
    const outcome = manageWorktree(seams, CORE, OPTIONS, fakeFs({ [PARENT]: "dir", [PATH]: "dir" }));
    expect(outcome.kind).toBe("refused");
    expect(outcome.report.refusal).toMatchObject({ kind: "dirty", paths: [" M README", "?? x"] });
    expect(outcome.report.head).toBeNull();
    expect(seams.calls.at(-1)?.args[0]).toBe("status");
  });

  it("a clean worktree elsewhere is moved with checkout --detach behind --end-of-options", () => {
    const seams = new ScriptedSeams([
      ...base(),
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain(`worktree ${PATH}`, `HEAD ${OLD}`, "detached", "") } },
      { match: "git rev-parse --path-format=absolute --show-toplevel", result: { stdout: `${PATH}\n` } },
      { match: "git status --porcelain=v1 -z --untracked-files=all", result: { stdout: "" } },
      { match: "git rev-parse --verify HEAD", result: { stdout: `${OLD}\n` } },
      { match: "git symbolic-ref -q HEAD", result: { code: 1 } },
      { match: `git checkout --quiet --detach --end-of-options ${TIP}`, result: {} },
    ]);
    const outcome = manageWorktree(seams, CORE, OPTIONS, fakeFs({ [PARENT]: "dir", [PATH]: "dir" }));
    expect(outcome.report).toMatchObject({ state: "moved", headBefore: OLD, head: TIP });
    expect(seams.calls.find((call) => call.args[0] === "checkout")?.cwd).toBe(PATH);
  });

  it("a symlinked .nen is refused before the registration is read", () => {
    const seams = new ScriptedSeams(base());
    const outcome = manageWorktree(seams, CORE, OPTIONS, fakeFs({ [join(CORE, ".nen")]: "link" }));
    expect(outcome.report.refusal?.kind).toBe("parent-symlink");
    expect(seams.calls.some((call) => call.args[0] === "worktree")).toBe(false);
  });

  it("an --base git rejects is refused before any fetch", () => {
    const seams = new ScriptedSeams([
      { match: "git rev-parse --path-format=absolute --git-common-dir", result: { stdout: `${join(CORE, ".git")}\n` } },
      { match: "git rev-parse --is-bare-repository", result: { stdout: "false\n" } },
      { match: "git check-ref-format --branch ma..in", result: { code: 1, stderr: "fatal: 'ma..in' is not a valid branch name" } },
    ]);
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, base: "ma..in" }, fakeFs({}));
    expect(outcome.report.refusal?.kind).toBe("base");
    expect(seams.calls.some((call) => call.args[0] === "fetch")).toBe(false);
  });

  it("a copy destination tracked at the tip is refused from the tree, before anything is created", () => {
    const secret = "Kro/Config.xcconfig";
    const seams = new ScriptedSeams([
      ...base(),
      { match: `git ls-files --error-unmatch -- ${secret}`, result: { code: 1 } },
      { match: `git check-ignore -q -- ${secret}`, result: { code: 0 } },
      { match: `git ls-tree -z --full-tree --end-of-options ${TIP}`, result: { stdout: `100644 blob ${OLD}\tREADME\u0000120000 blob ${OLD}\tKro\0` } },
    ]);
    const fs = fakeFs({ [join(CORE, "Kro", "Config.xcconfig")]: "file" });
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, copyFromCore: [secret] }, fs);
    expect(outcome.report.refusal?.kind).toBe("copy-destination");
    expect(outcome.report.refusal?.reason).toMatch(/TRACKED as a symlink/);
    expect(fs.made).toEqual([]);
    expect(fs.copied).toEqual([]);
    expect(seams.calls.some((call) => call.args[0] === "worktree")).toBe(false);
  });
});

describe("the tip walk folds case where the filesystem does", () => {
  const secret = "Kro/Config.xcconfig";
  function script(): ScriptedCall[] {
    return [
      ...base(),
      { match: `git ls-files --error-unmatch -- ${secret}`, result: { code: 1 } },
      { match: `git check-ignore -q -- ${secret}`, result: { code: 0 } },
      { match: `git ls-tree -z --full-tree --end-of-options ${TIP}`, result: { stdout: `040000 tree ${OLD}\tkro\0` } },
      { match: `git ls-tree -z --full-tree --end-of-options ${TIP} -- kro/`, result: { stdout: `100644 blob ${OLD}\tkro/config.xcconfig\0` } },
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain() } },
    ];
  }
  const fs = (): FakeFs => fakeFs({ [join(CORE, "Kro", "Config.xcconfig")]: "file" });

  it.each(["darwin", "win32"] as const)("on %s, a tip tracking 'kro/config.xcconfig' refuses 'Kro/Config.xcconfig', naming the tip's spelling", (platform) => {
    const seams = new ScriptedSeams(script(), { platform });
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, dryRun: true, copyFromCore: [secret] }, fs());
    expect(outcome.report.refusal?.kind).toBe("copy-destination");
    expect(outcome.report.refusal?.reason).toContain("as 'kro/config.xcconfig'");
  });

  it("on linux, where the names are two files, the walk does not match across case", () => {
    const seams = new ScriptedSeams(script(), { platform: "linux" });
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, dryRun: true, copyFromCore: [secret] }, fs());
    expect(outcome.kind).toBe("done");
    expect(outcome.report.copies).toEqual([{ path: secret, action: "would-copy" }]);
  });
});

describe("nen wc worktree -- CLI wiring, no git spent on a bad argument", () => {
  async function capture(argv: readonly string[]): Promise<{ code: number; err: string; calls: number }> {
    const err: string[] = [];
    const io: Io = { out: (): void => undefined, err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams([]);
    const code = await runFamily(wcCommand, argv, tmpdir(), false, io, seams);
    return { code, err: err.join("\n"), calls: seams.calls.length };
  }

  it.each([
    [["wc", "worktree", "--base", "main"], /--name/],
    [["wc", "worktree", "--name", "kg"], /--base/],
    [["wc", "worktree", "--name", "../kg", "--base", "main"], /one plain path segment/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--copy-from-core", "a/*.x"], /one literal path/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--copy-from-core", "a", "--copy-from-core", "a"], /named twice/],
    [["wc", "worktree", "extra", "--name", "kg", "--base", "main"], /no positional argument/],
    [["wc", "worktrees", "--name", "kg"], /only 'wc worktree' takes it/],
    [["wc", "classify", "--copy-from-core", "a"], /only 'wc worktree' takes it/],
  ] as const)("refuses %j at exit 2 with no git call", async (argv, message) => {
    const result = await capture(argv);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(result.calls).toBe(0);
  });
});
