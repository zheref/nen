// src/wc/worktree.test.ts -- `nen wc worktree` over SCRIPTED seams and a fake
// filesystem (zheref/nen#299): the argument refusals that spend no git call,
// the scrubbed environment every call carries, the `--end-of-options` on every
// call that takes a ref or a path positionally, the dry run that writes
// nothing, the drop scoped to ONE registration, the refusals (dirty, locked,
// a name alias, a move over ignored files, an absent base), the exit-1 class,
// the staging in the git dir, retention, and the post-rename identity check.
// ./worktree.integration.test.ts proves the same table against the real git.

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stats } from "node:fs";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { wcCommand } from "./command.js";
import {
  copyPathRefusal,
  copyThroughStaging,
  foldName,
  manageWorktree,
  MANIFEST_CONTRACT,
  MANIFEST_FILE,
  nameRefusal,
  parseRegistrations,
  parseStatusZ,
  scrubbedGitEnv,
  WorktreeStepError,
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
  readonly copied: Array<{ readonly source: string; readonly destination: string; readonly stagingDir: string }>;
  readonly unlinked: string[];
  readonly written: Map<string, string>;
}

function fakeFs(entries: Readonly<Record<string, Kind>>, options: { hashes?: Readonly<Record<string, string>>; texts?: Readonly<Record<string, string>> } = {}): FakeFs {
  const tree = new Map<string, Kind>(Object.entries(entries));
  const made: string[] = [];
  const copied: Array<{ source: string; destination: string; stagingDir: string }> = [];
  const unlinked: string[] = [];
  const written = new Map<string, string>(Object.entries(options.texts ?? {}));
  return {
    made,
    copied,
    unlinked,
    written,
    lstat: (path: string): Stats | null => {
      const kind = tree.get(path);
      return kind === undefined ? null : stat(kind);
    },
    realpath: (path: string): string => path,
    mkdirp: (path: string): void => {
      made.push(path);
      tree.set(path, "dir");
    },
    copyFile: (source: string, destination: string, stagingDir: string): string => {
      copied.push({ source, destination, stagingDir });
      tree.set(destination, "file");
      return "c".repeat(64);
    },
    hashFile: (path: string): string | null => options.hashes?.[path] ?? null,
    unlink: (path: string): void => {
      unlinked.push(path);
      tree.delete(path);
    },
    readText: (path: string): string | null => written.get(path) ?? null,
    writeTextAtomic: (path: string, text: string): void => {
      written.set(path, text);
    },
  };
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A real, empty core directory: the CLI path uses the native filesystem, so core must exist. */
function makeCore(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-wc-worktree-unit-")));
  scratch.push(dir);
  const core = join(dir, "core");
  mkdirSync(core);
  return core;
}

const CORE = makeCore();
const PARENT = join(CORE, ".nen", "worktrees");
const PATH = join(PARENT, "kg");
const GITDIR = join(CORE, ".git", "worktrees", "kg");
const TIP = "a".repeat(40);
const OLD = "b".repeat(40);
const FETCH = "git fetch --quiet --end-of-options origin refs/heads/main:refs/remotes/origin/main";
const LS_REMOTE = "git ls-remote --exit-code --end-of-options origin refs/heads/main";

function corePorcelain(core: string, ...extra: string[]): string {
  return [`worktree ${core}`, `HEAD ${OLD}`, "branch refs/heads/main", "", ...extra].join("\n");
}

function base(core: string = CORE): ScriptedCall[] {
  return [
    { match: "git rev-parse --path-format=absolute --git-common-dir", result: { stdout: `${join(core, ".git")}\n` } },
    { match: "git rev-parse --is-bare-repository", result: { stdout: "false\n" } },
    { match: "git check-ref-format --branch main", result: { stdout: "main\n" } },
    { match: "git rev-parse --verify --quiet --end-of-options refs/remotes/origin/main^{commit}", result: { stdout: `${TIP}\n` } },
    { match: FETCH, result: {} },
    { match: "git check-ignore -q -- .nen/worktrees/kg", result: { code: 0 } },
  ];
}

/** The calls a registered, clean, detached worktree standing at `head` answers. */
function registeredAt(head: string): ScriptedCall[] {
  return [
    { match: "git worktree list --porcelain", result: { stdout: corePorcelain(CORE, `worktree ${PATH}`, `HEAD ${head}`, "detached", "") } },
    { match: "git rev-parse --path-format=absolute --show-toplevel", result: { stdout: `${PATH}\n` } },
    { match: "git status --porcelain=v1 -z --untracked-files=all", result: { stdout: "" } },
    { match: "git rev-parse --verify HEAD", result: { stdout: `${head}\n` } },
    { match: "git symbolic-ref -q HEAD", result: { code: 1 } },
    { match: "git rev-parse --path-format=absolute --git-dir", result: { stdout: `${GITDIR}\n` } },
  ];
}

const OPTIONS = { name: "kg", base: "main", copyFromCore: [] as string[], dryRun: false };

describe("scrubbedGitEnv", () => {
  it("drops every redirect, config, exec-path and pathspec variable and every GIT_CONFIG_KEY/VALUE_<n>, and keeps nothing else of the caller's", () => {
    const env = scrubbedGitEnv({ GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: "/x", GIT_CONFIG_KEY_ZZ: "kept", PATH: "/bin" });
    for (const key of [
      "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_CONFIG_COUNT",
      "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_EXEC_PATH",
      "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
      "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
    ]) {
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
  it.each(["kg", "kagutsuchi", "a.b_c-1", "console", "com10"])("admits the name %s", (name) => {
    expect(nameRefusal(name)).toBeNull();
  });
  it.each(["", "..", "../x", "a/b", ".hidden", "-x", "x..y", "x.lock", "a b", "a\\b", "x".repeat(101), "kg.", "CON", "nul.txt", "Com1", "lpt9.log", "PROGRA~1", "a:b"])(
    "refuses the name %j",
    (name) => {
      expect(nameRefusal(name)).not.toBeNull();
    },
  );
  it.each(["Kro/Config.xcconfig", ".env", "a/b c/d.txt", "café/app.env", "aux_files/x"])("admits the copy path %s", (path) => {
    expect(copyPathRefusal(path)).toBeNull();
  });
  it.each([
    "", "/etc/hosts", "C:/x", "../x", "a/../b", "a//b", "a/", "./a", "Kro/*.x", "a?b", "[a]", "a\\b", ":(glob)x", ".git/config", "sub/.GIT/x", "a\nb",
    "dir./x", "dir /x", "x.env ", "a:b/c", "PROGRA~1/x", "CON/x", "sub/aux.env", "LPT1",
  ])("refuses the copy path %j", (path) => {
    expect(copyPathRefusal(path)).not.toBeNull();
  });
  it("strips control characters from the echo (F7)", () => {
    expect(nameRefusal("a\u001b[2Kb")).not.toMatch(/\u001b/);
    expect(copyPathRefusal("a\u001b[2K*")).not.toMatch(/\u001b/);
  });
});

describe("the parsers and the fold", () => {
  it("reads every registration, prunable, locked and detached marked, a sibling kept distinct", () => {
    const rows = parseRegistrations(corePorcelain(CORE, `worktree ${PATH}2`, `HEAD ${TIP}`, "detached", "locked on a stick", "", `worktree ${PATH}`, `HEAD ${TIP}`, "detached", "prunable gitdir file points to non-existent location", ""));
    expect(rows.map((row) => row.path)).toEqual([CORE, `${PATH}2`, PATH]);
    expect(rows.map((row) => row.prunable)).toEqual([false, false, true]);
    expect(rows.map((row) => row.locked)).toEqual([false, true, false]);
    expect(rows.map((row) => row.detached)).toEqual([false, true, true]);
  });
  it("lists a -z status one entry per change, a rename with both names", () => {
    expect(parseStatusZ(" M README\0?? new file.txt\0R  b.txt\0a.txt\0")).toEqual([" M README", "?? new file.txt", "R  a.txt -> b.txt"]);
    expect(parseStatusZ("")).toEqual([]);
  });
  it("folds NFD to NFC everywhere, and case only on darwin and win32", () => {
    const nfd = "Cafe\u0301/App.env";
    expect(foldName(nfd, "linux")).toBe("Café/App.env");
    expect(foldName(nfd, "darwin")).toBe("café/app.env");
    expect(foldName(nfd, "win32")).toBe("café/app.env");
  });
  it("a step error's message is redacted and stripped (F7)", () => {
    const error = new WorktreeStepError("fetch https://u:secret@host/x failed \u001b[2Kgone");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toMatch(/\u001b/);
  });
});

describe("manageWorktree over scripted git", () => {
  it("--dry-run on an absent path fetches nothing, creates nothing, and says it would create", () => {
    const seams = new ScriptedSeams([...base(), { match: "git worktree list --porcelain", result: { stdout: corePorcelain(CORE) } }], {
      env: { GIT_DIR: "/elsewhere/.git", GIT_CONFIG_KEY_0: "core.hooksPath" },
    });
    const fs = fakeFs({});
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, dryRun: true }, fs);
    expect(outcome.kind).toBe("done");
    expect(outcome.report).toMatchObject({ state: "created", reached: "created", dryRun: true, fetched: false, tip: TIP, head: TIP, dropped: false, removed: [], kept: [] });
    expect(seams.calls.some((call) => call.args[0] === "fetch")).toBe(false);
    expect(seams.calls.some((call) => call.args[0] === "worktree" && call.args[1] === "add")).toBe(false);
    expect(fs.made).toEqual([]);
    if (outcome.kind === "done") expect(outcome.lines.join("\n")).toContain("(would create)");
    for (const call of seams.calls) {
      expect(call.env !== null && "GIT_DIR" in call.env && call.env["GIT_DIR"] === undefined, call.args.join(" ")).toBe(true);
      expect(call.env !== null && "GIT_CONFIG_KEY_0" in call.env, call.args.join(" ")).toBe(true);
    }
  });

  it("a real run creates the worktree and STAGES each copy in the worktree's git dir, never in the tree (F2), then records it (F3)", () => {
    const secret = "Kro/Config.xcconfig";
    const seams = new ScriptedSeams([
      ...base(),
      { match: "git ls-files -z --full-name", result: { stdout: "README\0" } },
      { match: `git check-ignore -q -- ${secret}`, result: { code: 0 } },
      { match: `git ls-tree -z --full-tree --end-of-options ${TIP}`, result: { stdout: `100644 blob ${OLD}\tREADME\0` } },
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain(CORE) } },
      { match: `git worktree add --quiet --detach --end-of-options ${PATH} ${TIP}`, result: {} },
      { match: "git rev-parse --path-format=absolute --git-dir", result: { stdout: `${GITDIR}\n` } },
    ]);
    const fs = fakeFs({ [join(CORE, "Kro")]: "dir", [join(CORE, "Kro", "Config.xcconfig")]: "file", [join(PATH, "Kro")]: "dir" });
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, copyFromCore: [secret] }, fs);
    expect(outcome.kind, JSON.stringify(outcome.report.refusal)).toBe("done");
    expect(fs.made).toContain(PARENT);
    expect(fs.copied).toEqual([{ source: join(CORE, "Kro", "Config.xcconfig"), destination: join(PATH, "Kro", "Config.xcconfig"), stagingDir: GITDIR }]);
    expect(fs.copied[0]?.stagingDir.startsWith(PATH)).toBe(false);
    expect(seams.calls.find((call) => call.args[0] === "fetch")?.args).toContain("--end-of-options");
    const record = JSON.parse(fs.written.get(join(GITDIR, MANIFEST_FILE)) ?? "{}") as unknown;
    expect(record).toEqual({ contract: MANIFEST_CONTRACT, copies: [{ path: secret, sha256: "c".repeat(64) }] });
  });

  it("retention: an unnamed copy whose bytes match is removed, an edited one kept, a vanished one forgotten; --dry-run removes nothing", () => {
    const same = "d".repeat(64);
    const manifest = JSON.stringify({
      contract: MANIFEST_CONTRACT,
      copies: [
        { path: "a.env", sha256: same },
        { path: "b.env", sha256: same },
        { path: "gone.env", sha256: same },
      ],
    });
    const entries = { [PARENT]: "dir", [PATH]: "dir", [join(PATH, "a.env")]: "file", [join(PATH, "b.env")]: "file" } as const;
    const hashes = { [join(PATH, "a.env")]: same, [join(PATH, "b.env")]: "e".repeat(64) };
    const script = (): ScriptedCall[] => [...base(), ...registeredAt(TIP)];

    const dryFs = fakeFs(entries, { hashes, texts: { [join(GITDIR, MANIFEST_FILE)]: manifest } });
    const dry = manageWorktree(new ScriptedSeams(script()), CORE, { ...OPTIONS, dryRun: true }, dryFs);
    expect(dry.report).toMatchObject({ state: "reused", removed: [{ path: "a.env", action: "would-remove" }], kept: [{ path: "b.env", reason: "edited since copy" }] });
    expect(dryFs.unlinked).toEqual([]);
    expect(dryFs.written.get(join(GITDIR, MANIFEST_FILE))).toBe(manifest);

    const realFs = fakeFs(entries, { hashes, texts: { [join(GITDIR, MANIFEST_FILE)]: manifest } });
    const real = manageWorktree(new ScriptedSeams(script()), CORE, OPTIONS, realFs);
    expect(real.report).toMatchObject({ removed: [{ path: "a.env", action: "removed" }], kept: [{ path: "b.env", reason: "edited since copy" }] });
    expect(realFs.unlinked).toEqual([join(PATH, "a.env")]);
    expect(JSON.parse(realFs.written.get(join(GITDIR, MANIFEST_FILE)) ?? "{}")).toEqual({ contract: MANIFEST_CONTRACT, copies: [{ path: "b.env", sha256: same }] });
    if (real.kind === "done") {
      expect(real.lines).toContain("removed:         a.env (no longer named; bytes as copied)");
      expect(real.lines).toContain("kept:            b.env (edited since copy)");
    }
  });

  it("a copy record nen cannot read is exit 1, never guessed around", () => {
    const fs = fakeFs({ [PARENT]: "dir", [PATH]: "dir" }, { texts: { [join(GITDIR, MANIFEST_FILE)]: "{ not json" } });
    expect(() => manageWorktree(new ScriptedSeams([...base(), ...registeredAt(TIP)]), CORE, OPTIONS, fs)).toThrow(WorktreeStepError);
  });

  it("a vanished registration: --dry-run keeps it; a real run removes ONLY that path and never prunes", () => {
    const porcelain = corePorcelain(CORE, `worktree ${PATH}`, `HEAD ${TIP}`, "detached", "prunable gitdir file points to non-existent location", "");
    const dry = new ScriptedSeams([...base(), { match: "git worktree list --porcelain", result: { stdout: porcelain } }]);
    const planned = manageWorktree(dry, CORE, { ...OPTIONS, dryRun: true }, fakeFs({ [PARENT]: "dir" }));
    expect(planned.report).toMatchObject({ state: "recreated", dropped: true, dryRun: true });
    expect(dry.calls.some((call) => call.args[1] === "remove")).toBe(false);

    const real = new ScriptedSeams([
      ...base(),
      { match: "git worktree list --porcelain", result: { stdout: porcelain } },
      { match: `git worktree remove --force --end-of-options ${PATH}`, result: {} },
      { match: `git worktree add --quiet --detach --end-of-options ${PATH} ${TIP}`, result: {} },
      { match: "git rev-parse --path-format=absolute --git-dir", result: { stdout: `${GITDIR}\n` } },
    ]);
    const done = manageWorktree(real, CORE, OPTIONS, fakeFs({ [PARENT]: "dir" }));
    expect(done.report).toMatchObject({ state: "recreated", dropped: true });
    expect(real.calls.some((call) => call.args.includes("prune"))).toBe(false);
  });

  it.each([true, false])("a LOCKED vanished registration is refused, dry run %s, before any remove (N3)", (dryRun) => {
    const porcelain = corePorcelain(CORE, `worktree ${PATH}`, `HEAD ${TIP}`, "detached", "locked", "");
    const seams = new ScriptedSeams([...base(), { match: "git worktree list --porcelain", result: { stdout: porcelain } }]);
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, dryRun }, fakeFs({ [PARENT]: "dir" }));
    expect(outcome.report.refusal?.kind).toBe("locked");
    expect(seams.calls.some((call) => call.args[1] === "remove")).toBe(false);
  });

  it("a --name differing from a registration only by case or NFC is refused, naming the existing spelling (N12)", () => {
    const porcelain = corePorcelain(CORE, `worktree ${join(PARENT, "KG")}`, `HEAD ${TIP}`, "detached", "");
    const seams = new ScriptedSeams([...base(), { match: "git worktree list --porcelain", result: { stdout: porcelain } }]);
    const outcome = manageWorktree(seams, CORE, OPTIONS, fakeFs({ [PARENT]: "dir" }));
    expect(outcome.report.refusal?.kind).toBe("name-alias");
    expect(outcome.report.refusal?.reason).toContain("use 'KG'");
  });

  it("a dirty worktree is refused with its paths, and nothing after the status is run", () => {
    const seams = new ScriptedSeams([
      ...base(),
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain(CORE, `worktree ${PATH}`, `HEAD ${OLD}`, "detached", "") } },
      { match: "git rev-parse --path-format=absolute --show-toplevel", result: { stdout: `${PATH}\n` } },
      { match: "git status --porcelain=v1 -z --untracked-files=all", result: { stdout: " M README\0?? x\0" } },
    ]);
    const outcome = manageWorktree(seams, CORE, OPTIONS, fakeFs({ [PARENT]: "dir", [PATH]: "dir" }));
    expect(outcome.kind).toBe("refused");
    expect(outcome.report.refusal).toMatchObject({ kind: "dirty", paths: [" M README", "?? x"] });
    expect(outcome.report).toMatchObject({ head: null, reached: null });
    expect(seams.calls.at(-1)?.args[0]).toBe("status");
  });

  it("a clean worktree elsewhere is moved with checkout --detach behind --end-of-options", () => {
    const seams = new ScriptedSeams([
      ...base(),
      ...registeredAt(OLD),
      { match: "git ls-files -z --others --ignored --exclude-standard --directory", result: { stdout: "build/\0" } },
      { match: `git diff --no-ext-diff --no-renames --name-only -z --end-of-options HEAD ${TIP}`, result: { stdout: "README\0" } },
      { match: `git checkout --quiet --detach --end-of-options ${TIP}`, result: {} },
    ]);
    const outcome = manageWorktree(seams, CORE, OPTIONS, fakeFs({ [PARENT]: "dir", [PATH]: "dir" }));
    expect(outcome.report).toMatchObject({ state: "moved", headBefore: OLD, head: TIP });
    expect(seams.calls.find((call) => call.args[0] === "checkout")?.cwd).toBe(PATH);
  });

  it.each([
    ["the same path", "build.env\0", "build.env\0"],
    ["a path under an ignored directory", "build/\0", "build/out.bin\0"],
    ["a path above an ignored file", "cache/x/y\0", "cache\0"],
  ])("a move that would overwrite an ignored, untracked file is refused -- %s (N9)", (_, ignored, changed) => {
    const seams = new ScriptedSeams([
      ...base(),
      ...registeredAt(OLD),
      { match: "git ls-files -z --others --ignored --exclude-standard --directory", result: { stdout: ignored } },
      { match: `git diff --no-ext-diff --no-renames --name-only -z --end-of-options HEAD ${TIP}`, result: { stdout: changed } },
    ]);
    const outcome = manageWorktree(seams, CORE, OPTIONS, fakeFs({ [PARENT]: "dir", [PATH]: "dir" }));
    expect(outcome.report.refusal?.kind).toBe("would-overwrite-ignored");
    expect(outcome.report.refusal?.paths).toEqual([changed.replace(/\0$/, "")]);
    expect(seams.calls.some((call) => call.args[0] === "checkout")).toBe(false);
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

  it("a copy SOURCE under a symlinked segment in core is refused as copy-source (F4)", () => {
    const seams = new ScriptedSeams([...base(), { match: "git ls-files -z --full-name", result: { stdout: "" } }]);
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, copyFromCore: ["Alias/Config.xcconfig"] }, fakeFs({ [join(CORE, "Alias")]: "link", [join(CORE, "Alias", "Config.xcconfig")]: "file" }));
    expect(outcome.report.refusal?.kind).toBe("copy-source");
    expect(outcome.report.refusal?.reason).toMatch(/beneath 'Alias', a symlink in core/);
  });

  it("a copy source tracked in core under its NFD spelling is refused (F1)", () => {
    const seams = new ScriptedSeams([...base(), { match: "git ls-files -z --full-name", result: { stdout: "cafe\u0301/app.env\0" } }]);
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, copyFromCore: ["café/app.env"] }, fakeFs({ [join(CORE, "café")]: "dir", [join(CORE, "café", "app.env")]: "file" }));
    expect(outcome.report.refusal?.kind).toBe("copy-source");
    expect(outcome.report.refusal?.reason).toMatch(/is tracked in core/);
  });

  it("a copy destination tracked at the tip is refused from the tree, without the stray '--' (N10), before anything is created", () => {
    const secret = "Kro/Config.xcconfig";
    const seams = new ScriptedSeams([
      ...base(),
      { match: "git ls-files -z --full-name", result: { stdout: "" } },
      { match: `git check-ignore -q -- ${secret}`, result: { code: 0 } },
      { match: `git ls-tree -z --full-tree --end-of-options ${TIP}`, result: { stdout: `100644 blob ${OLD}\tREADME\u0000120000 blob ${OLD}\tKro\0` } },
    ]);
    const fs = fakeFs({ [join(CORE, "Kro")]: "dir", [join(CORE, "Kro", "Config.xcconfig")]: "file" });
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, copyFromCore: [secret] }, fs);
    expect(outcome.report.refusal?.kind).toBe("copy-destination");
    expect(outcome.report.refusal?.reason).toMatch(/TRACKED as a symlink/);
    expect(fs.made).toEqual([]);
    expect(fs.copied).toEqual([]);
    expect(seams.calls.some((call) => call.args[0] === "worktree")).toBe(false);
  });

  it("a destination tracked in the worktree under its NFD spelling is refused from the whole ls-files listing (F1 backstop)", () => {
    const nfc = "café/app.env";
    // The second `git ls-files -z --full-name` (in the worktree) answers the NFD spelling.
    const script = [
      ...base(),
      { match: "git ls-files -z --full-name", result: { stdout: "" } },
      { match: "git ls-files -z --full-name", result: { stdout: "cafe\u0301/app.env\0" } },
      { match: `git check-ignore -q -- ${nfc}`, result: { code: 0 } },
      { match: `git ls-tree -z --full-tree --end-of-options ${TIP}`, result: { stdout: "" } },
      ...registeredAt(TIP),
    ];
    const outcome = manageWorktree(
      new ScriptedSeams(script, { platform: "linux" }),
      CORE,
      { ...OPTIONS, copyFromCore: [nfc] },
      fakeFs({ [join(CORE, "café")]: "dir", [join(CORE, "café", "app.env")]: "file", [PARENT]: "dir", [PATH]: "dir", [join(PATH, "café")]: "dir" }),
    );
    expect(outcome.report.refusal?.kind).toBe("copy-destination");
    expect(outcome.report.refusal?.reason).toMatch(/is tracked in the worktree/);
  });

  it("a copy refusal after a move keeps the state reached (N7)", () => {
    const secret = "Kro/Config.xcconfig";
    const seams = new ScriptedSeams([
      ...base(),
      { match: "git ls-files -z --full-name", result: { stdout: "" } },
      { match: `git check-ignore -q -- ${secret}`, result: { code: 0 } },
      { match: `git ls-tree -z --full-tree --end-of-options ${TIP}`, result: { stdout: "" } },
      ...registeredAt(OLD),
      { match: "git ls-files -z --others --ignored --exclude-standard --directory", result: { stdout: "" } },
      { match: `git checkout --quiet --detach --end-of-options ${TIP}`, result: {} },
    ]);
    const fs = fakeFs({ [join(CORE, "Kro")]: "dir", [join(CORE, "Kro", "Config.xcconfig")]: "file", [PARENT]: "dir", [PATH]: "dir", [join(PATH, "Kro")]: "link" });
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, copyFromCore: [secret] }, fs);
    expect(outcome.kind).toBe("refused");
    expect(outcome.report).toMatchObject({ state: "refused", reached: "moved", head: null });
    expect(outcome.report.refusal?.kind).toBe("copy-destination");
  });
});

describe("the tip walk folds case where the filesystem does, and NFC everywhere", () => {
  const secret = "Kro/Config.xcconfig";
  function script(listing: string, child: string): ScriptedCall[] {
    return [
      ...base(),
      { match: "git ls-files -z --full-name", result: { stdout: "" } },
      { match: `git check-ignore -q -- ${secret}`, result: { code: 0 } },
      { match: `git ls-tree -z --full-tree --end-of-options ${TIP}`, result: { stdout: listing } },
      { match: `git ls-tree -z --full-tree --end-of-options ${OLD}`, result: { stdout: child } },
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain(CORE) } },
    ];
  }
  const fs = (): FakeFs => fakeFs({ [join(CORE, "Kro")]: "dir", [join(CORE, "Kro", "Config.xcconfig")]: "file" });

  it.each(["darwin", "win32"] as const)("on %s, a tip tracking 'kro/config.xcconfig' refuses 'Kro/Config.xcconfig', naming the tip's spelling", (platform) => {
    const seams = new ScriptedSeams(script(`040000 tree ${OLD}\tkro\0`, `100644 blob ${OLD}\tconfig.xcconfig\0`), { platform });
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, dryRun: true, copyFromCore: [secret] }, fs());
    expect(outcome.report.refusal?.kind).toBe("copy-destination");
    expect(outcome.report.refusal?.reason).toContain("as 'kro/config.xcconfig'");
  });

  it("on linux, where the names are two files, the walk does not match across case", () => {
    const seams = new ScriptedSeams(script(`040000 tree ${OLD}\tkro\0`, `100644 blob ${OLD}\tconfig.xcconfig\0`), { platform: "linux" });
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, dryRun: true, copyFromCore: [secret] }, fs());
    expect(outcome.kind).toBe("done");
  });

  it("on linux too, an NFD symlink parent at the tip refuses an NFC request (F1)", () => {
    const nfc = "café/app.env";
    const seams = new ScriptedSeams(
      [
        ...base(),
        { match: "git ls-files -z --full-name", result: { stdout: "" } },
        { match: `git check-ignore -q -- ${nfc}`, result: { code: 0 } },
        { match: `git ls-tree -z --full-tree --end-of-options ${TIP}`, result: { stdout: `120000 blob ${OLD}\tcafe\u0301\0` } },
      ],
      { platform: "linux" },
    );
    const outcome = manageWorktree(seams, CORE, { ...OPTIONS, copyFromCore: [nfc] }, fakeFs({ [join(CORE, "café")]: "dir", [join(CORE, "café", "app.env")]: "file" }));
    expect(outcome.report.refusal?.kind).toBe("copy-destination");
    expect(outcome.report.refusal?.reason).toMatch(/TRACKED as a symlink/);
  });
});

describe("copyThroughStaging -- the bytes, and the post-rename identity check (F2, F8)", () => {
  function setup(): { readonly source: string; readonly staging: string; readonly tree: string } {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-wc-worktree-copy-")));
    scratch.push(dir);
    const staging = join(dir, "gitdir");
    const tree = join(dir, "tree");
    mkdirSync(staging);
    mkdirSync(tree);
    const source = join(dir, "source.env");
    writeFileSync(source, "SECRET=1\n");
    return { source, staging, tree };
  }
  const inTree = (tree: string) => (directory: string): boolean => directory === tree;

  it("copies through the staging dir, returns the sha256, and leaves nothing staged", () => {
    const { source, staging, tree } = setup();
    const hash = copyThroughStaging(source, join(tree, "x.env"), staging, inTree(tree));
    expect(hash).toBe(createHash("sha256").update("SECRET=1\n").digest("hex"));
    expect(readFileSync(join(tree, "x.env"), "utf8")).toBe("SECRET=1\n");
    expect(readdirSync(staging)).toEqual([]);
    expect(readdirSync(tree)).toEqual(["x.env"]);
  });

  it("a file at the destination that is not the one written is left alone, and the run fails (exit 1)", () => {
    const { source, staging, tree } = setup();
    const swap = {
      rename: (from: string, to: string): void => {
        renameSync(from, to);
        unlinkSync(to);
        writeFileSync(to, "theirs\n");
      },
    };
    expect(() => copyThroughStaging(source, join(tree, "x.env"), staging, inTree(tree), swap)).toThrow(WorktreeStepError);
    expect(readFileSync(join(tree, "x.env"), "utf8")).toBe("theirs\n");
    expect(readdirSync(staging)).toEqual([]);
  });

  it("a copy whose directory resolves outside the worktree after the rename is unlinked, and the run fails (exit 1)", () => {
    const { source, staging, tree } = setup();
    expect(() => copyThroughStaging(source, join(tree, "x.env"), staging, () => false)).toThrow(/outside the worktree/);
    expect(existsSync(join(tree, "x.env"))).toBe(false);
  });
});

describe("nen wc worktree -- CLI wiring and exit codes", () => {
  async function capture(argv: readonly string[], script: readonly ScriptedCall[] = [], repo: string = tmpdir()): Promise<{ code: number; err: string; calls: number }> {
    const err: string[] = [];
    const io: Io = { out: (): void => undefined, err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams(script);
    const code = await runFamily(wcCommand, argv, repo, false, io, seams);
    return { code, err: err.join("\n"), calls: seams.calls.length };
  }

  it.each([
    [["wc", "worktree", "--base", "main"], /--name/],
    [["wc", "worktree", "--name", "kg"], /--base/],
    [["wc", "worktree", "--name", "../kg", "--base", "main"], /one plain path segment/],
    [["wc", "worktree", "--name", "CON", "--base", "main"], /reserved device name/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--copy-from-core", "a/*.x"], /one literal path/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--copy-from-core", "a", "--copy-from-core", "a"], /named twice/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--copy-from-core", "café", "--copy-from-core", "cafe\u0301"], /named twice/],
    [["wc", "worktree", "extra", "--name", "kg", "--base", "main"], /no positional argument/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--onto", "main"], /--onto is not read by 'wc worktree'/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--message-file", "m"], /--message-file is not read/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--strategy", "merge"], /--strategy is not read/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--abort"], /--abort is not read/],
    [["wc", "worktree", "--name", "kg", "--base", "main", "--set-upstream"], /--set-upstream is not read/],
    [["wc", "worktrees", "--name", "kg"], /only 'wc worktree' takes it/],
    [["wc", "classify", "--copy-from-core", "a"], /only 'wc worktree' takes it/],
  ] as const)("refuses %j at exit 2 with no git call", async (argv, message) => {
    const result = await capture(argv);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(result.calls).toBe(0);
  });

  const ARGV = ["wc", "worktree", "--name", "kg", "--base", "main"];

  it("a fetch that fails and a branch ls-remote calls ABSENT is a refusal, exit 2 (N1)", async () => {
    const core = makeCore();
    const result = await capture(ARGV, [
      ...base(core).filter((call) => call.match !== FETCH),
      { match: FETCH, result: { code: 128, stderr: "fatal: couldn't find remote ref refs/heads/main" } },
      { match: LS_REMOTE, result: { code: 2 } },
    ], core);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/origin has no branch 'main'/);
  });

  it("a fetch that fails on the network is exit 1, credentials redacted, with no --json document (N1, N4, N11)", async () => {
    const core = makeCore();
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams = new ScriptedSeams([
      ...base(core).filter((call) => call.match !== FETCH),
      { match: FETCH, result: { code: 128, stderr: "fatal: unable to access 'https://u:secret@host/x/': Could not resolve host: host" } },
      { match: LS_REMOTE, result: { code: 128, stderr: "fatal: Could not resolve host: host" } },
    ]);
    const code = await runFamily(wcCommand, ARGV, core, true, io, seams);
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).not.toContain("secret");
  });

  it("a worktree add that fails after the parent was made is exit 1 (N4)", async () => {
    const core = makeCore();
    const path = join(core, ".nen", "worktrees", "kg");
    const result = await capture(ARGV, [
      ...base(core),
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain(core) } },
      { match: `git worktree add --quiet --detach --end-of-options ${path} ${TIP}`, result: { code: 128, stderr: "fatal: could not create directory" } },
    ], core);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/adding the worktree/);
    expect(existsSync(join(core, ".nen", "worktrees"))).toBe(true);
  });

  it("a registered path git cannot read as a work tree is a not-root refusal, exit 2 (N8)", async () => {
    const core = makeCore();
    const path = join(core, ".nen", "worktrees", "kg");
    mkdirSync(path, { recursive: true });
    const result = await capture(ARGV, [
      ...base(core),
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain(core, `worktree ${path}`, `HEAD ${TIP}`, "detached", "") } },
      { match: "git rev-parse --path-format=absolute --show-toplevel", result: { code: 128, stderr: "fatal: not a git repository" } },
    ], core);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/cannot read it as a work tree/);
  });

  it("a locked vanished registration is exit 2 (N3)", async () => {
    const core = makeCore();
    const path = join(core, ".nen", "worktrees", "kg");
    const result = await capture(ARGV, [
      ...base(core),
      { match: "git worktree list --porcelain", result: { stdout: corePorcelain(core, `worktree ${path}`, `HEAD ${TIP}`, "detached", "locked", "") } },
    ], core);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/LOCKED/);
  });
});
