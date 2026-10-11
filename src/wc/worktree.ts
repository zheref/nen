// src/wc/worktree.ts -- `nen wc worktree`: ONE detached worktree at a FIXED
// path, `<core>/.nen/worktrees/<name>`, standing at `origin/<base>`'s fetched
// tip, plus the copy of the maintainer's own gitignored files from core into
// it (zheref/nen#299).
//
// WHY A VERB. Hatsu's kagutsuchi § 3b builds and sends from a clean worktree
// at the trunk's tip, and it carried that as a POSIX shell script of ten raw
// git calls (zheref/hatsu `scripts/kagutsuchi_worktree.sh`). This is that
// script's state table and its copy proofs, ported, so Hatsu can retire it.
//
// THE STATE TABLE. Every mutation refuses rather than guesses:
//   absent                                -> `git worktree add --detach`     created
//   present, clean, detached at the tip   -> nothing                          reused
//   present, clean, anywhere else         -> `git checkout --detach <tip>`   moved
//   present, DIRTY                        -> exit 2, every path listed; never reset,
//                                            cleaned, stashed or discarded
//   present, not this project's worktree  -> exit 2: a stray directory, a symlink, or a
//                                            directory beside a SIBLING registration
//                                            (`<name>2`) is somebody's, not ours
//   registered, directory gone            -> that ONE registration dropped
//                                            (`git worktree remove --force -- <path>`),
//                                            then created                  recreated
// A repository-wide `git worktree prune` is never run: it would drop OTHER
// sessions' vanished registrations, which are not this verb's to decide.
//
// CORE is the checkout whose `.git` is the common git directory, resolved from
// ANY checkout through `git rev-parse --git-common-dir` -- the same derivation
// ./swap.ts's `resolveCore` makes. The parents of the fixed path are proven
// first: a symlinked `.nen` or `.nen/worktrees` would carry the worktree, and
// every credential copied into it, wherever the link points, reported as if it
// stood under core.
//
// THE COPY. `--copy-from-core <path>` (repeatable) names a repo-relative path
// copied FROM CORE, never synthesised and never from any other checkout. A
// contract-declared list (`nen/contract.json -> project.fromCore[]`) is a
// follow-up: that file's schema is owned by another open change. Before a byte
// moves, each path is proven twice:
//   the SOURCE, in core: a literal repo-relative path inside the tree; not
//     tracked (a tracked file is already in every worktree); gitignored (an
//     unignored copy would dirty the worktree and the next run would refuse
//     it); a regular file, not a symlink, whose directory resolves inside core.
//   the DESTINATION, at the tip: the worktree stands at origin/<base>, so a
//     TRUNK commit decides what sits at the destination. Not tracked at the tip
//     (a regular file would be overwritten with a credential and shown by `git
//     diff`; a leaf symlink would carry it outside the tree); no ancestor
//     tracked at the tip as a symlink, a submodule or a file (a parent symlink
//     carries it outside the tree). Those are proven against the tip's TREE
//     (`git ls-tree`), so they hold before anything is created or moved, and
//     under --dry-run too. Then, in the worktree on disk: gitignored there; no
//     ancestor directory and no leaf a symlink (an UNTRACKED symlink at the
//     destination is refused as firmly as a tracked one); the leaf, when
//     present, a regular file; and the destination directory resolving inside
//     the worktree.
//   The bytes travel through a temp file in the destination directory and a
//   rename, which replaces the path and never follows a link. The source is
//   opened with O_NOFOLLOW where the platform has it and re-checked as a
//   regular file on the open descriptor.
//
// GIT'S ENVIRONMENT IS SCRUBBED on every call. A `GIT_DIR`, `GIT_WORK_TREE` or
// `GIT_INDEX_FILE` inherited from a hook (zheref/nen#294 hit exactly this)
// would point `git -C <path>` at another repository, index or config, and a
// verb that ADDS and MOVES worktrees would do it there.
//
// PATHS ARE COMPARED AS THE PLATFORM DOES (zheref/nen#294's Windows lesson):
// through `realpathSync.native`, by ../canon/paths.ts's `samePath` and
// `containedOn`, so an 8.3 short name and git's long forward-slash spelling
// are one directory.
//
// EXIT CODES: 0 the worktree stands at the tip with every named file copied
// (or, under --dry-run, the plan); 2 a refusal, its reason on stderr -- before
// the state step nothing was changed (a fetch aside); 1 a git step or a write
// that FAILED part-way, the message saying where.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { containedOn, samePath } from "../canon/paths.js";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";

export const WORKTREE_CONTRACT = "nen.wc.worktree/v0.1";

/** Where every managed worktree lives, relative to core. */
export const WORKTREES_DIR = ".nen/worktrees";

/** The remote whose branch is the tip. */
const REMOTE = "origin";

/** The git variables that would point a `git -C <path>` call at another repository, index, object store or config. */
const GIT_REDIRECTS: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_PREFIX",
];

/**
 * The environment every git call here runs under: each redirect above, and
 * every `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` the process carries,
 * passed as `undefined` -- which the runner drops from the child's
 * environment -- no terminal prompt for the fetch's credentials, and no
 * optional lock (a `git status` never rewrites the index it reads).
 */
export function scrubbedGitEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of GIT_REDIRECTS) out[name] = undefined;
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) out[name] = undefined;
  }
  out["GIT_TERMINAL_PROMPT"] = "0";
  // A status in a dry run must not refresh and rewrite the worktree's index.
  out["GIT_OPTIONAL_LOCKS"] = "0";
  return out;
}

/** Why the verb refused. `usage` is never emitted here -- that is a VerbUsageError before core resolves. */
export type RefusalKind =
  | "not-a-checkout"
  | "base"
  | "parent-symlink"
  | "symlink"
  | "stray"
  | "not-root"
  | "dirty"
  | "copy-source"
  | "copy-destination";

/** Refused: exit 2, the reason on stderr; `paths` lists the dirty entries. */
export class WorktreeRefusal extends Error {
  constructor(
    readonly kind: RefusalKind,
    message: string,
    readonly paths: readonly string[] = [],
  ) {
    super(message);
    this.name = "WorktreeRefusal";
  }
}

/** A git step or a write that failed part-way: exit 1. */
export class WorktreeStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeStepError";
  }
}

export type WorktreeState = "created" | "reused" | "moved" | "recreated" | "refused";

export interface CopyRow {
  readonly path: string;
  readonly action: "copied" | "would-copy";
}

/** What `wc worktree` reports. KEY ORDER IS THE CONTRACT; ./worktree.test.ts pins it. */
export interface WorktreeReport {
  readonly contract: string;
  readonly core: string | null;
  readonly name: string;
  /** `<core>/.nen/worktrees/<name>`. */
  readonly path: string | null;
  readonly base: string;
  /** origin/<base>'s commit -- fetched, or as last fetched under --dry-run. */
  readonly tip: string | null;
  /** False under --dry-run: the tip was read as last fetched. */
  readonly fetched: boolean;
  /** What happened, or under --dry-run what would; `refused` on exit 2. */
  readonly state: WorktreeState;
  readonly dryRun: boolean;
  /** The worktree's HEAD before this run; null when there was none. */
  readonly headBefore: string | null;
  /** The worktree's HEAD after this run (the tip); null on a refusal. */
  readonly head: string | null;
  /** True when the named registration outlived its directory and was (or would be) dropped. */
  readonly dropped: boolean;
  /** Whether core's own ignore rules cover the worktree's path; null when not asked. */
  readonly coreIgnored: boolean | null;
  readonly copies: readonly CopyRow[];
  /** Null unless refused. */
  readonly refusal: { readonly kind: RefusalKind; readonly reason: string; readonly paths: readonly string[] } | null;
}

export interface WorktreeOptions {
  readonly name: string;
  readonly base: string;
  readonly copyFromCore: readonly string[];
  readonly dryRun: boolean;
}

export type WorktreeOutcome =
  | { readonly kind: "done"; readonly report: WorktreeReport; readonly lines: readonly string[] }
  | { readonly kind: "refused"; readonly report: WorktreeReport; readonly message: string };

/** The filesystem calls the copy and the path proofs make -- injectable so a unit test drives every branch. */
export interface WorktreeFs {
  /** `lstat`, or null when nothing is there. */
  readonly lstat: (path: string) => Stats | null;
  readonly realpath: (path: string) => string;
  readonly mkdirp: (path: string) => void;
  /** Copy `source` to `destination` through a temp file in `dirname(destination)` and a rename. */
  readonly copyFile: (source: string, destination: string) => void;
}

// ── git through the seam ────────────────────────────────────────────────────

interface GitCall {
  readonly code: number;
  readonly stdout: string;
  readonly error: string;
  readonly spawnFailed: boolean;
}

class Git {
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly seams: Seams) {
    this.env = scrubbedGitEnv(seams.env);
  }

  run(cwd: string, args: readonly string[]): GitCall {
    const result = this.seams.run(GIT, [...args], { cwd, env: this.env });
    const error = result.spawnFailed
      ? `git could not be started (${result.stderr.trim()}); put it on PATH`
      : outputLines(result.stderr).join(" ") || `exit ${result.code}`;
    return { code: result.spawnFailed ? 127 : result.code, stdout: result.stdout, error, spawnFailed: result.spawnFailed };
  }

  must(cwd: string, args: readonly string[], what: string): string {
    const result = this.run(cwd, args);
    if (result.code !== 0) throw new WorktreeStepError(`${what} ('git ${args.join(" ")}' failed: ${result.error})`);
    return result.stdout;
  }

  /** A git call whose only answers are 0 and 1; anything else (a spawn failure, 128) is a step error. */
  yesNo(cwd: string, args: readonly string[], what: string): boolean {
    const result = this.run(cwd, args);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new WorktreeStepError(`${what} ('git ${args.join(" ")}' failed: ${result.error})`);
  }
}

function firstLine(text: string): string {
  return rawLines(text)[0] ?? "";
}

// ── argument shapes, lexical and before any git call ────────────────────────

const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A worktree name is ONE path segment: no separator, no `..`, no leading dot or dash. Returns the refusal or null. */
export function nameRefusal(name: string): string | null {
  if (!NAME_SHAPE.test(name) || name.includes("..") || name.endsWith(".lock")) {
    return `--name '${name}' is not one plain path segment (letters, digits, '.', '_' and '-'; starting with a letter or digit; no '..'; not ending in '.lock'; at most 100 characters). It becomes the directory ${WORKTREES_DIR}/<name> under core, and nothing in it may move that directory elsewhere.`;
  }
  return null;
}

/** A character a copy path may not carry: a glob or pathspec-magic character, a backslash, or a control character. */
const COPY_PATH_FORBIDDEN = /[*?[\]\\\u0000-\u001F\u007F]/;

/** A --copy-from-core path, refused lexically, or null. */
export function copyPathRefusal(path: string): string | null {
  const why = (text: string): string => `--copy-from-core '${path}' ${text}. Nothing was fetched, created or copied.`;
  if (path === "") return why("is empty");
  if (COPY_PATH_FORBIDDEN.test(path)) {
    return why("is not one literal path: it carries a glob or pathspec character ('*', '?', '[', ']'), a backslash or a control character, and git would read it as a pattern");
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith(":")) {
    return why("is not repo-relative: name it from the repository's root, with forward slashes");
  }
  const segments = path.split("/");
  if (segments.some((segment): boolean => segment === "" || segment === "." || segment === "..")) {
    return why("is not a plain repo-relative path inside the tree (an empty, '.' or '..' segment, or a trailing '/')");
  }
  if (segments.some((segment): boolean => segment.toLowerCase() === ".git")) {
    return why("names a path inside a '.git' directory, which is git's, never a file to copy");
  }
  return null;
}

// ── the worktree list ───────────────────────────────────────────────────────

interface Registration {
  /** As git printed it. */
  readonly path: string;
  readonly head: string | null;
  readonly detached: boolean;
  readonly prunable: boolean;
}

/** Every record of `git worktree list --porcelain`, the bare one included, nothing skipped. */
export function parseRegistrations(porcelain: string): Registration[] {
  const rows: Registration[] = [];
  let path: string | null = null;
  let head: string | null = null;
  let detached = false;
  let prunable = false;
  const flush = (): void => {
    if (path !== null) rows.push({ path, head, detached, prunable });
    path = null;
    head = null;
    detached = false;
    prunable = false;
  };
  for (const line of porcelain.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
    else if (line === "detached") detached = true;
    else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
  }
  flush();
  return rows;
}

/** `git status --porcelain=v1 -z -uall`, as one `XY path` (or `XY origin -> path`) entry per change. */
export function parseStatusZ(text: string): string[] {
  const fields = text.split("\0");
  const entries: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) {
      const origin = fields[index + 1] ?? "";
      index += 1;
      entries.push(`${code} ${origin} -> ${path}`);
    } else {
      entries.push(`${code} ${path}`);
    }
  }
  return entries;
}

// ── the default filesystem ──────────────────────────────────────────────────

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * The bytes through a temp file and a rename. The source is opened without
 * following a final symlink where the platform can say so (O_NOFOLLOW; Windows
 * has none, and the lstat proof before this is then the guard), and the open
 * descriptor is checked to be a regular file -- so a source swapped for a link
 * or a directory between the proof and the read is refused, not followed. The
 * temp file is created exclusively (`wx`), carries the source's permission
 * bits and times, and is removed on every failure path.
 */
function copyThroughRename(source: string, destination: string): void {
  const noFollow = (fsConstants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0;
  const input = openSync(source, fsConstants.O_RDONLY | noFollow);
  let temp: string | null = null;
  try {
    const stat = fstatSync(input);
    if (!stat.isFile()) throw new WorktreeStepError(`'${source}' stopped being a regular file between the proof and the read; nothing was copied`);
    temp = join(dirname(destination), `.nen-copy-${basename(destination)}.${randomBytes(6).toString("hex")}`);
    const output = openSync(temp, "wx", stat.mode & 0o777);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const read = readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        let written = 0;
        while (written < read) written += writeSync(output, buffer, written, read - written);
      }
      futimesSync(output, stat.atime, stat.mtime);
    } finally {
      closeSync(output);
    }
    renameSync(temp, destination);
    temp = null;
  } finally {
    closeSync(input);
    if (temp !== null) {
      try {
        unlinkSync(temp);
      } catch {
        // already gone; the failure that brought us here is the one reported
      }
    }
  }
}

export const nativeWorktreeFs: WorktreeFs = {
  lstat: lstatOrNull,
  realpath: (path: string): string => realpathSync.native(path),
  mkdirp: (path: string): void => {
    mkdirSync(path, { recursive: true });
  },
  copyFile: copyThroughRename,
};

// ── the verb ────────────────────────────────────────────────────────────────

function emptyReport(options: WorktreeOptions): WorktreeReport {
  return {
    contract: WORKTREE_CONTRACT,
    core: null,
    name: options.name,
    path: null,
    base: options.base,
    tip: null,
    fetched: false,
    state: "refused",
    dryRun: options.dryRun,
    headBefore: null,
    head: null,
    dropped: false,
    coreIgnored: null,
    copies: [],
    refusal: null,
  };
}

/** Core, from any checkout of the project. */
function resolveCore(git: Git, fs: WorktreeFs, repo: string): string {
  const common = git.run(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.spawnFailed) throw new WorktreeStepError(common.error);
  if (common.code !== 0) throw new WorktreeRefusal("not-a-checkout", `'${repo}' is not inside a git checkout (${common.error}).`);
  const bare = git.run(repo, ["rev-parse", "--is-bare-repository"]);
  if (bare.code === 0 && firstLine(bare.stdout) === "true") {
    throw new WorktreeRefusal("not-a-checkout", "a bare repository has no core checkout to cut a worktree from.");
  }
  const commonDir = firstLine(common.stdout);
  if (basename(commonDir) !== ".git") {
    throw new WorktreeRefusal("not-a-checkout", `the common git directory '${commonDir}' is not a checkout's .git; there is no core checkout.`);
  }
  try {
    return fs.realpath(dirname(commonDir));
  } catch (error) {
    throw new WorktreeRefusal("not-a-checkout", `core '${dirname(commonDir)}' does not resolve (${(error as Error).message}).`);
  }
}

/** --base, held to git's own branch-name rule and to the refspec/force shapes git does not reject. */
function proveBase(git: Git, core: string, base: string): void {
  if (base.startsWith("-") || base.startsWith("+") || base.includes(":")) {
    throw new WorktreeRefusal("base", `--base '${base}' looks like an option, a refspec or a force (a leading '-' or '+', or a ':'), not a branch name.`);
  }
  const checked = git.run(core, ["check-ref-format", "--branch", base]);
  if (checked.spawnFailed) throw new WorktreeStepError(checked.error);
  if (checked.code !== 0) {
    throw new WorktreeRefusal("base", `--base '${base}' is not a branch name git will accept ('git check-ref-format --branch' answered ${checked.error}).`);
  }
  const normalized = firstLine(checked.stdout);
  if (normalized !== base || base.startsWith("refs/")) {
    throw new WorktreeRefusal("base", `--base '${base}' is not a short branch name (git reads it as '${normalized}'); name it as it appears under refs/heads/, e.g. 'main'.`);
  }
}

/** Each copy source, proven in core. */
function proveSources(git: Git, fs: WorktreeFs, core: string, paths: readonly string[], platform: NodeJS.Platform): void {
  for (const path of paths) {
    const refusal = (text: string): WorktreeRefusal =>
      new WorktreeRefusal("copy-source", `--copy-from-core '${path}' ${text}; refused.`);
    const absolute = join(core, ...path.split("/"));
    // The directory first: a symlinked parent in core would make every check
    // below answer about somebody else's file.
    let sourceDir: string;
    try {
      sourceDir = fs.realpath(dirname(absolute));
    } catch {
      throw refusal("is absent in core -- its directory does not exist, and nothing is synthesised");
    }
    if (!containedOn(core, sourceDir, platform) || !samePath(sourceDir, dirname(absolute), platform)) {
      throw refusal(`does not stand inside core: its directory resolves to '${sourceDir}' through a symlink`);
    }
    const stat = fs.lstat(absolute);
    if (stat === null) throw refusal("is absent in core -- the maintainer's own checkout is where it comes from, and nothing is synthesised");
    if (stat.isSymbolicLink()) throw refusal("is a symlink in core -- only a regular file is copied, never what a link points at");
    if (!stat.isFile()) throw refusal("is not a regular file in core");
    if (git.yesNo(core, ["ls-files", "--error-unmatch", "--", path], `checking whether '${path}' is tracked in core`)) {
      throw refusal("is tracked in core -- a tracked file is already in every worktree");
    }
    if (!git.yesNo(core, ["check-ignore", "-q", "--", path], `checking whether '${path}' is gitignored in core`)) {
      throw refusal("is not gitignored in core -- a copy would dirty the worktree, and the next run would refuse it as dirty");
    }
  }
}

/** One level of the tip's tree: each child's name, as git spells it, and its mode. */
function tipChildren(git: Git, core: string, tip: string, directory: string): Array<{ readonly name: string; readonly mode: string }> {
  const args = directory === ""
    ? ["ls-tree", "-z", "--full-tree", "--end-of-options", tip]
    : ["ls-tree", "-z", "--full-tree", "--end-of-options", tip, "--", `${directory}/`];
  const out = git.must(core, args, `reading '${directory === "" ? "." : directory}' at the tip`);
  const children: Array<{ readonly name: string; readonly mode: string }> = [];
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const full = record.slice(tab + 1);
    children.push({ name: directory === "" ? full : full.slice(directory.length + 1), mode: record.slice(0, record.indexOf(" ")) });
  }
  return children;
}

/**
 * Each destination, proven against the tip's TREE -- before anything is
 * created or moved. The walk goes one level at a time and descends by the
 * name AS THE TIP SPELLS IT. On darwin and win32, whose default filesystems
 * fold case, a name is matched case-insensitively: a trunk that tracks
 * `kro/config.xcconfig` would otherwise slip past a proof about
 * `Kro/Config.xcconfig` and be overwritten on disk.
 */
function proveDestinationsAtTip(git: Git, core: string, tip: string, base: string, paths: readonly string[], platform: NodeJS.Platform): void {
  const fold = platform === "darwin" || platform === "win32" ? (name: string): string => name.toLowerCase() : (name: string): string => name;
  for (const path of paths) {
    const refusal = (text: string): WorktreeRefusal =>
      new WorktreeRefusal("copy-destination", `--copy-from-core '${path}' ${text} at ${REMOTE}/${base} (${tip}); refused, and nothing was created, moved or copied.`);
    const segments = path.split("/");
    let directory = "";
    for (let depth = 0; depth < segments.length; depth += 1) {
      const wanted = fold(segments[depth] ?? "");
      const entry = tipChildren(git, core, tip, directory).find((child): boolean => fold(child.name) === wanted);
      if (entry === undefined) break;
      const spelled = directory === "" ? entry.name : `${directory}/${entry.name}`;
      const leaf = depth === segments.length - 1;
      if (entry.mode === "040000" && !leaf) {
        directory = spelled;
        continue;
      }
      if (leaf) {
        if (entry.mode === "120000") throw refusal(`is TRACKED (as '${spelled}') as a symlink -- the copy would follow the trunk's link out of the tree`);
        if (entry.mode === "040000") throw refusal(`is TRACKED (as '${spelled}') as a directory`);
        throw refusal(`is TRACKED (as '${spelled}') -- the copy would overwrite a tracked file with core's, and \`git diff\` would show the credential`);
      }
      if (entry.mode === "120000") throw refusal(`lies beneath '${spelled}', which is TRACKED as a symlink -- the copy would land wherever the trunk's link points`);
      if (entry.mode === "160000") throw refusal(`lies beneath '${spelled}', which is TRACKED as a submodule`);
      throw refusal(`lies beneath '${spelled}', which is TRACKED as a file`);
    }
  }
}

/** Each destination, proven in the worktree on disk, then copied. */
function copyInto(
  git: Git,
  fs: WorktreeFs,
  core: string,
  worktree: string,
  base: string,
  tip: string,
  paths: readonly string[],
  platform: NodeJS.Platform,
): CopyRow[] {
  const rows: CopyRow[] = [];
  for (const path of paths) {
    const refusal = (text: string): WorktreeRefusal =>
      new WorktreeRefusal("copy-destination", `--copy-from-core '${path}' ${text}; refused. The worktree stands at ${REMOTE}/${base} (${tip}).`);
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = join(worktree, ...segments.slice(0, depth));
      const stat = fs.lstat(ancestor);
      if (stat === null) break;
      if (stat.isSymbolicLink()) throw refusal(`lies beneath '${segments.slice(0, depth).join("/")}', a symlink in the worktree`);
      if (!stat.isDirectory()) throw refusal(`lies beneath '${segments.slice(0, depth).join("/")}', which is not a directory in the worktree`);
    }
    const destination = join(worktree, ...segments);
    const leaf = fs.lstat(destination);
    if (leaf !== null && leaf.isSymbolicLink()) throw refusal("is a symlink in the worktree -- an untracked link at the destination is refused like a tracked one");
    if (leaf !== null && !leaf.isFile()) throw refusal("exists in the worktree and is not a regular file");
    // git is asked only once the path on disk is proven free of links: a path
    // beyond a symlink is a refusal above, never a git failure here.
    if (git.yesNo(worktree, ["ls-files", "--error-unmatch", "--", path], `checking whether '${path}' is tracked in the worktree`)) {
      throw refusal("is tracked in the worktree");
    }
    if (!git.yesNo(worktree, ["check-ignore", "-q", "--", path], `checking whether '${path}' is gitignored in the worktree`)) {
      throw refusal(`is not gitignored at ${REMOTE}/${base} -- a copy would dirty the worktree`);
    }
    const destinationDir = dirname(destination);
    try {
      fs.mkdirp(destinationDir);
    } catch (error) {
      throw new WorktreeStepError(`could not create '${destinationDir}' for '${path}' (${(error as Error).message})`);
    }
    let resolvedDir: string;
    try {
      resolvedDir = fs.realpath(destinationDir);
    } catch (error) {
      throw new WorktreeStepError(`'${destinationDir}' does not resolve after it was created (${(error as Error).message})`);
    }
    if (!containedOn(worktree, resolvedDir, platform)) throw refusal(`resolves outside the worktree (its directory is '${resolvedDir}')`);
    try {
      fs.copyFile(join(core, ...segments), destination);
    } catch (error) {
      if (error instanceof WorktreeStepError) throw error;
      throw new WorktreeStepError(`copying '${path}' from core failed (${(error as Error).message}); the destination was not replaced`);
    }
    rows.push({ path, action: "copied" });
  }
  return rows;
}

/**
 * Bring `<core>/.nen/worktrees/<name>` to origin/<base>'s tip and copy the
 * named files into it. A refusal comes back as an outcome; a git step that
 * failed part-way throws WorktreeStepError.
 */
export function manageWorktree(
  seams: Seams,
  repo: string,
  options: WorktreeOptions,
  fs: WorktreeFs = nativeWorktreeFs,
): WorktreeOutcome {
  const git = new Git(seams);
  const platform = seams.platform;
  let report = emptyReport(options);
  try {
    const core = resolveCore(git, fs, repo);
    const path = join(core, ".nen", "worktrees", options.name);
    report = { ...report, core, path };
    proveBase(git, core, options.base);
    // THE COPY SOURCES, before anything moves, so a bad list costs nothing.
    proveSources(git, fs, core, options.copyFromCore, platform);

    // THE TIP. Fetched for real -- with no '+', so a rewound trunk fails
    // closed rather than silently moving the worktree backwards -- or read as
    // last fetched under --dry-run.
    if (!options.dryRun) {
      git.must(
        core,
        ["fetch", "--quiet", "--end-of-options", REMOTE, `refs/heads/${options.base}:refs/remotes/${REMOTE}/${options.base}`],
        `fetching ${REMOTE}/${options.base} -- the tip is unknown`,
      );
    }
    const tipCall = git.run(core, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/remotes/${REMOTE}/${options.base}^{commit}`]);
    if (tipCall.spawnFailed) throw new WorktreeStepError(tipCall.error);
    if (tipCall.code !== 0) {
      throw new WorktreeRefusal("base", `${REMOTE}/${options.base} does not resolve${options.dryRun ? " (as last fetched; --dry-run fetches nothing)" : ""}.`);
    }
    const tip = firstLine(tipCall.stdout);
    report = { ...report, tip, fetched: !options.dryRun };

    proveDestinationsAtTip(git, core, tip, options.base, options.copyFromCore, platform);

    // THE PATH'S PARENTS.
    for (const parent of [join(core, ".nen"), join(core, ".nen", "worktrees")]) {
      const stat = fs.lstat(parent);
      if (stat === null) continue;
      if (stat.isSymbolicLink()) throw new WorktreeRefusal("parent-symlink", `'${parent}' is a symlink -- the worktree, and every file copied into it, would land wherever it points.`);
      if (!stat.isDirectory()) throw new WorktreeRefusal("parent-symlink", `'${parent}' is not a directory.`);
      if (!samePath(fs.realpath(parent), parent, platform)) {
        throw new WorktreeRefusal("parent-symlink", `'${parent}' does not resolve to itself.`);
      }
    }

    // THE REGISTRATION -- an exact path match, never a prefix: a sibling
    // registration such as '<name>2' must never read as ours.
    const porcelain = git.must(core, ["worktree", "list", "--porcelain"], "listing the worktrees");
    const registrations = parseRegistrations(porcelain);
    const ours = registrations.find((row): boolean => samePath(row.path, path, platform)) ?? null;
    const present = fs.lstat(path);
    let dropped = false;
    let registered = ours !== null;

    if (ours !== null && present === null) {
      // Only OUR registration is dropped; never a repository-wide prune.
      if (!options.dryRun) git.must(core, ["worktree", "remove", "--force", "--end-of-options", ours.path], `dropping the vanished registration of '${path}'`);
      dropped = true;
      registered = false;
    }
    report = { ...report, dropped };

    if (present !== null && present.isSymbolicLink()) {
      throw new WorktreeRefusal("symlink", `'${path}' is a symlink -- refused; the worktree must stand at its own path under core.`);
    }
    if (present !== null && !registered) {
      const siblings = registrations
        .map((row): string => row.path)
        .filter((other): boolean => basename(other).startsWith(options.name) && !samePath(other, path, platform));
      const near = siblings.length > 0 ? ` (registered nearby, and not this path: ${siblings.join(", ")})` : "";
      throw new WorktreeRefusal("stray", `'${path}' exists and is not a worktree of this project${near} -- somebody's directory; refused, and nothing in it was touched.`);
    }

    let state: WorktreeState;
    let headBefore: string | null = null;
    if (registered && present !== null) {
      if (!present.isDirectory()) throw new WorktreeRefusal("stray", `'${path}' is registered but is not a directory.`);
      if (!samePath(fs.realpath(path), path, platform)) throw new WorktreeRefusal("not-root", `'${path}' does not resolve to itself.`);
      const top = git.must(path, ["rev-parse", "--path-format=absolute", "--show-toplevel"], `reading '${path}''s top level`);
      if (!samePath(firstLine(top), path, platform)) {
        throw new WorktreeRefusal("not-root", `'${path}' is not the worktree's own root (git answers '${firstLine(top)}').`);
      }
      const status = git.must(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], `reading '${path}''s status`);
      const dirty = parseStatusZ(status);
      if (dirty.length > 0) {
        throw new WorktreeRefusal("dirty", `the worktree at '${path}' is dirty -- refused, and never reset, cleaned or discarded. Commit, move or remove these yourself:`, dirty);
      }
      headBefore = firstLine(git.must(path, ["rev-parse", "--verify", "HEAD"], `reading '${path}''s HEAD`));
      const attached = git.run(path, ["symbolic-ref", "-q", "HEAD"]).code === 0;
      if (headBefore === tip && !attached) {
        state = "reused";
      } else {
        if (!options.dryRun) git.must(path, ["checkout", "--quiet", "--detach", "--end-of-options", tip], `moving '${path}' to ${tip}`);
        state = "moved";
      }
    } else {
      if (!options.dryRun) {
        fs.mkdirp(join(core, ".nen", "worktrees"));
        const parent = join(core, ".nen", "worktrees");
        const stat = fs.lstat(parent);
        if (stat === null || stat.isSymbolicLink() || !samePath(fs.realpath(parent), parent, platform)) {
          throw new WorktreeRefusal("parent-symlink", `'${parent}' does not resolve to itself after it was created.`);
        }
        git.must(core, ["worktree", "add", "--quiet", "--detach", "--end-of-options", path, tip], `adding the worktree at '${path}'`);
      }
      state = dropped ? "recreated" : "created";
    }

    const coreIgnored = git.yesNo(core, ["check-ignore", "-q", "--", `${WORKTREES_DIR}/${options.name}`], "checking whether core ignores the worktree");
    report = { ...report, state, headBefore, head: tip, coreIgnored };

    // THE COPY. Under --dry-run the tip proofs above already ran; the on-disk
    // ones need the worktree at the tip, which only a real run has.
    const copies = options.dryRun
      ? options.copyFromCore.map((copy): CopyRow => ({ path: copy, action: "would-copy" }))
      : copyInto(git, fs, core, path, options.base, tip, options.copyFromCore, platform);
    report = { ...report, copies };
    return { kind: "done", report, lines: renderLines(report) };
  } catch (error) {
    if (!(error instanceof WorktreeRefusal)) throw error;
    const refused: WorktreeReport = {
      ...report,
      state: "refused",
      head: null,
      refusal: { kind: error.kind, reason: error.message, paths: error.paths },
    };
    return { kind: "refused", report: refused, message: error.message };
  }
}

const VERB: Readonly<Record<Exclude<WorktreeState, "refused">, string>> = {
  created: "created",
  reused: "reused",
  moved: "moved",
  recreated: "recreated (its vanished registration dropped)",
};

const WOULD: Readonly<Record<Exclude<WorktreeState, "refused">, string>> = {
  created: "would create",
  reused: "reused",
  moved: "would move",
  recreated: "would drop its vanished registration and recreate",
};

/** The human rendering. Every line is built from the report, so it can never say what --json does not. */
export function renderLines(report: WorktreeReport): string[] {
  const lines: string[] = [];
  lines.push(`core:            ${report.core ?? "(unresolved)"}`);
  if (report.coreIgnored === true) lines.push(`core-ignore:     ${WORKTREES_DIR}/${report.name} is gitignored in core`);
  else if (report.coreIgnored === false) {
    lines.push(`core-ignore:     WARNING ${WORKTREES_DIR}/${report.name} is NOT gitignored in core -- core will show it as untracked; add .nen/ to the repository's .gitignore in its own change`);
  }
  lines.push(`${REMOTE}/${report.base}:   ${report.tip ?? "(unresolved)"}${report.fetched ? "" : " (as last fetched; --dry-run fetches nothing)"}`);
  if (report.state !== "refused") {
    const words = report.dryRun ? WOULD[report.state] : VERB[report.state];
    lines.push(`worktree:        ${report.path ?? ""} (${words})`);
    if (report.headBefore !== null && report.headBefore !== report.head) lines.push(`head before:     ${report.headBefore}`);
    lines.push(`head:            ${report.head ?? ""}`);
  }
  if (report.copies.length === 0) lines.push("copied:          none named (--copy-from-core)");
  for (const copy of report.copies) {
    lines.push(`copied:          ${copy.path} (${copy.action === "copied" ? "from core, gitignored" : "would copy from core"})`);
  }
  return lines;
}
