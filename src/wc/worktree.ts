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
//     ...unless the move would overwrite an IGNORED, untracked file the tip
//     tracks (git overwrites those silently) -> refused, every path listed
//   present, DIRTY                        -> exit 2, every path listed; never reset,
//                                            cleaned, stashed or discarded
//   present, not this project's worktree  -> exit 2: a stray directory, a symlink, or a
//                                            directory beside a SIBLING registration
//                                            (`<name>2`) is somebody's, not ours
//   registered, directory gone            -> that ONE registration dropped
//                                            (`git worktree remove --force` on its own
//                                            path), then created           recreated
//     ...unless it is LOCKED, which is somebody's statement that it is coming
//     back (a removable disk, a network share) -> refused
// A repository-wide `git worktree prune` is never run: it would drop OTHER
// sessions' vanished registrations, which are not this verb's to decide. A
// --name differing from a registration under .nen/worktrees only by case or
// Unicode normalisation is refused: on a folding filesystem the two are one
// directory, and on any other they are two names a reader cannot tell apart.
//
// CORE is the checkout whose `.git` is the common git directory, resolved from
// ANY checkout through `git rev-parse --git-common-dir` -- the same derivation
// ./swap.ts's `resolveCore` makes. The parents of the fixed path are proven
// first: a symlinked `.nen` or `.nen/worktrees` would carry the worktree, and
// every credential copied into it, wherever the link points.
//
// THE COPY. `--copy-from-core <path>` (repeatable) names a repo-relative path
// copied FROM CORE, never synthesised and never from any other checkout. A
// contract-declared list (`nen/contract.json -> project.fromCore[]`) is a
// follow-up: that file's schema is owned by another open change.
//   the SOURCE, in core: a literal path, every ancestor a real directory (a
//     symlinked segment is refused); a regular file, not a symlink; not
//     tracked under any spelling; gitignored.
//   the DESTINATION, at the tip, from its TREE and before anything moves: not
//     tracked, and no ancestor tracked as a symlink, a submodule or a file.
//   the DESTINATION, in the worktree on disk: no ancestor and no leaf a
//     symlink; nothing tracked there under any spelling (`git ls-files`, read
//     whole); gitignored; the directory resolving inside the worktree.
// NAMES ARE COMPARED FOLDED: NFC on every platform, and case-folded on darwin
// and win32. A trunk tracking the NFD spelling `café/app.env` is the same
// file on APFS as an untracked NFC `café/app.env`, and an exact-spelling proof
// would let the credential overwrite it (Feitan F1).
//
// THE BYTES are staged in the WORKTREE'S OWN GIT DIRECTORY
// (`core/.git/worktrees/<n>`, outside the tree, on core's filesystem) and
// renamed into place, so a crash never leaves a partial credential in the work
// tree. After the rename the destination's directory is resolved again and the
// file there must be the one written (device and inode): one that landed
// outside the tree is unlinked, and either way the run fails at exit 1.
//
// RETENTION. Each copy is recorded -- its path and an HMAC-SHA256 of its bytes
// under a random 32-byte per-worktree key (mode 0600, beside the record) -- in
// `<worktree git dir>/nen-wc-worktree-copies.json`, outside the tree. A later
// run that no longer names a recorded copy removes it ONLY when it is still
// untracked, still ignored, and its bytes still verify; and it unlinks only
// the file it hashed (device and inode re-checked). Anything else is listed as
// kept and never deleted. A still-named entry the run does not get to re-copy
// stays recorded. A copy whose core source was deleted cannot be named (the
// source proof refuses it), so it goes the same way as one no longer named.
//
// GIT'S ENVIRONMENT IS SCRUBBED on every call (zheref/nen#294): the variables
// that point `git -C <path>` at another repository, index, object store, exec
// path or pathspec mode, or inject config. GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM
// and GIT_CONFIG_NOSYSTEM are KEPT: they are the user's own choice of config
// files, not a hook's redirect.
//
// EXIT CODES: 0 the worktree stands at the tip with every named file copied
// (or, under --dry-run, the plan); 2 a refusal, its reason on stderr; 1 a git
// step or a write that FAILED part-way, the message saying where.

import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { containedOn, samePath } from "../canon/paths.js";
import { plainLine } from "../cli/plain.js";
import { GIT, outputLines, redactRemoteCredentials, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";

export const WORKTREE_CONTRACT = "nen.wc.worktree/v0.1";
export const MANIFEST_CONTRACT = "nen.wc.worktree.copies/v0.2";
/** The plain-sha256 record v0.1 wrote; its entries cannot be verified and are kept. */
export const MANIFEST_CONTRACT_V1 = "nen.wc.worktree.copies/v0.1";

/** Where every managed worktree lives, relative to core. */
export const WORKTREES_DIR = ".nen/worktrees";

/** The copy record, in the worktree's own git directory. */
export const MANIFEST_FILE = "nen-wc-worktree-copies.json";

/** The per-worktree HMAC key, beside the record. */
export const KEY_FILE = "nen-wc-worktree-copies.key";

/** The two names a crashed run can leave in the worktree git dir, and nothing else. */
export const LEFTOVER = /^(?:nen-wc-worktree-copy\.[0-9a-f]{16}|nen-wc-worktree-copies\.json\.[0-9a-f]{12}\.tmp)$/;

/** The remote whose branch is the tip. */
const REMOTE = "origin";

/** The git variables that would point a `git -C <path>` call somewhere else, or change how it reads a path. */
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
  "GIT_EXEC_PATH",
  "GIT_PREFIX",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
];

/**
 * The environment every git call here runs under: each variable above, and
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
  out["GIT_OPTIONAL_LOCKS"] = "0";
  return out;
}

/**
 * A name as the platform's filesystem compares it: NFC everywhere, and
 * case-folded on darwin and win32, whose default filesystems fold case.
 */
export function foldName(name: string, platform: NodeJS.Platform): string {
  const nfc = name.normalize("NFC");
  return platform === "darwin" || platform === "win32" ? nfc.toLowerCase() : nfc;
}

/** Why the verb refused. A bad argument is a VerbUsageError before any of these. */
export type RefusalKind =
  | "not-a-checkout"
  | "base"
  | "name-alias"
  | "parent-symlink"
  | "symlink"
  | "stray"
  | "locked"
  | "not-root"
  | "dirty"
  | "would-overwrite-ignored"
  | "copy-source"
  | "copy-destination";

/** Refused: exit 2, the reason on stderr; `paths` lists the entries the reason is about. */
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

/**
 * A git step or a write that failed part-way: exit 1. The message is made
 * safe to print HERE, because ../index.ts's runFamily prints it as it stands:
 * remote credentials redacted, control characters stripped (Feitan F7).
 */
export class WorktreeStepError extends Error {
  constructor(message: string) {
    super(plainLine(redactRemoteCredentials(message)));
    this.name = "WorktreeStepError";
  }
}

export type WorktreeState = "created" | "reused" | "moved" | "recreated" | "refused";
export type ReachedState = Exclude<WorktreeState, "refused">;

export interface CopyRow {
  readonly path: string;
  readonly action: "copied" | "would-copy";
}

export interface RemovedRow {
  readonly path: string;
  readonly action: "removed" | "would-remove";
}

export type KeptReason = "edited since copy" | "not a regular file" | "tracked at the tip" | "not ignored" | "unverifiable record";

export interface KeptRow {
  readonly path: string;
  readonly reason: KeptReason;
}

/** What `wc worktree` reports. KEY ORDER IS THE CONTRACT; the tests pin it. */
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
  /** The state the worktree REACHED before any refusal; null when it was refused before the state step. */
  readonly reached: ReachedState | null;
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
  /** Recorded copies no longer named, removed because their bytes were still as copied. */
  readonly removed: readonly RemovedRow[];
  /** Recorded copies no longer named and NOT removed. */
  readonly kept: readonly KeptRow[];
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

/** The filesystem calls the verb makes -- injectable so a unit test drives every branch. */
export interface WorktreeFs {
  /** `lstat`, or null when nothing is there. */
  readonly lstat: (path: string) => Stats | null;
  readonly realpath: (path: string) => string;
  readonly mkdirp: (path: string) => void;
  /**
   * Copy `source` to `destination`, staging the bytes in `stagingDir` and
   * renaming them into place; `inside` says whether a resolved directory is
   * inside the worktree. Returns the sha256 of the bytes written.
   */
  readonly copyFile: (source: string, destination: string, stagingDir: string, inside: (directory: string) => boolean, key: Buffer) => string;
  /**
   * The HMAC of a regular file's bytes, read from ONE descriptor opened
   * without following a final link, with that descriptor's device and inode;
   * null when it is not a regular file.
   */
  readonly digestFile: (path: string, key: Buffer) => FileDigest | null;
  /** Unlink `path` only when it is still the regular file `dev`/`ino` names; false (nothing unlinked) otherwise. */
  readonly unlinkIfSame: (path: string, dev: bigint, ino: bigint) => boolean;
  /** The per-worktree key: read, or created (32 random bytes, mode 0600) when `create`; null when absent and not created. */
  readonly loadKey: (path: string, create: boolean) => Buffer | null;
  /** Remove every regular file in `dir` whose name matches LEFTOVER; the names removed. */
  readonly removeLeftovers: (dir: string) => string[];
  /** A file's text, or null when it does not exist. */
  readonly readText: (path: string) => string | null;
  /** Write a file through a temp file beside it and a rename. */
  readonly writeTextAtomic: (path: string, text: string) => void;
}

export interface FileDigest {
  readonly digest: string;
  readonly dev: bigint;
  readonly ino: bigint;
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

  /** NUL-separated output as entries, the empty tail dropped. */
  entries(cwd: string, args: readonly string[], what: string): string[] {
    return this.must(cwd, args, what).split("\0").filter((entry): boolean => entry !== "");
  }
}

function firstLine(text: string): string {
  return rawLines(text)[0] ?? "";
}

// ── argument shapes, lexical and before any git call ────────────────────────

const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * A segment no platform this verb runs on can hold faithfully (Feitan F5):
 * Windows drops a trailing '.' or space, reads ':' as a stream separator,
 * '~<digit>' as a short-name alias, and CON/PRN/AUX/NUL/COM1-9/LPT1-9 (with
 * or without an extension) as devices. Refused on EVERY platform, so a name
 * means the same file wherever it is run.
 */
export function segmentProblem(segment: string): string | null {
  if (/[. ]$/.test(segment)) return `the segment '${segment}' ends in '.' or a space`;
  if (segment.includes(":")) return `the segment '${segment}' carries ':'`;
  if (/~\d/.test(segment)) return `the segment '${segment}' carries '~<digit>', a Windows short-name form`;
  if (RESERVED_DEVICE.test(segment)) return `the segment '${segment}' is a reserved device name`;
  return null;
}

/** A worktree name is ONE path segment. Returns the refusal (safe to print) or null. */
export function nameRefusal(name: string): string | null {
  const problem = NAME_SHAPE.test(name) && !name.includes("..") && !name.endsWith(".lock") ? segmentProblem(name) : "it is not one plain path segment";
  if (problem === null) return null;
  return plainLine(
    `--name '${name}' is refused: ${problem}. A name is letters, digits, '.', '_' and '-', starts with a letter or digit, has no '..', does not end in '.lock' or a '.', is not a reserved device name, and is at most 100 characters. It becomes the directory ${WORKTREES_DIR}/<name> under core, and nothing in it may move that directory elsewhere.`,
  );
}

/** A character a copy path may not carry: a glob or pathspec-magic character, a backslash, ':' or a control character. */
const COPY_PATH_FORBIDDEN = /[*?[\]\\:\u0000-\u001F\u007F]/;

/** A --copy-from-core path, refused lexically (safe to print), or null. */
export function copyPathRefusal(path: string): string | null {
  const why = (text: string): string => plainLine(`--copy-from-core '${path}' ${text}. Nothing was fetched, created or copied.`);
  if (path === "") return why("is empty");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return why("is not repo-relative: name it from the repository's root, with forward slashes");
  }
  if (COPY_PATH_FORBIDDEN.test(path)) {
    return why("is not one literal path: it carries a glob or pathspec character ('*', '?', '[', ']'), a backslash, a ':' or a control character, and git would read it as a pattern");
  }
  const segments = path.split("/");
  if (segments.some((segment): boolean => segment === "" || segment === "." || segment === "..")) {
    return why("is not a plain repo-relative path inside the tree (an empty, '.' or '..' segment, or a trailing '/')");
  }
  if (segments.some((segment): boolean => segment.toLowerCase() === ".git")) {
    return why("names a path inside a '.git' directory, which is git's, never a file to copy");
  }
  for (const segment of segments) {
    const problem = segmentProblem(segment);
    if (problem !== null) return why(`is refused: ${problem}`);
  }
  return null;
}

// ── parsers ─────────────────────────────────────────────────────────────────

export interface Registration {
  /** As git printed it. */
  readonly path: string;
  readonly head: string | null;
  readonly detached: boolean;
  readonly prunable: boolean;
  readonly locked: boolean;
}

/** Every record of `git worktree list --porcelain`, nothing skipped. */
export function parseRegistrations(porcelain: string): Registration[] {
  const rows: Registration[] = [];
  let path: string | null = null;
  let head: string | null = null;
  let detached = false;
  let prunable = false;
  let locked = false;
  const flush = (): void => {
    if (path !== null) rows.push({ path, head, detached, prunable, locked });
    path = null;
    head = null;
    detached = false;
    prunable = false;
    locked = false;
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
    else if (line === "locked" || line.startsWith("locked ")) locked = true;
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

/** A path and every one of its ancestors, folded: `a/b/c` -> `a`, `a/b`, `a/b/c`. */
function foldedPrefixes(path: string, platform: NodeJS.Platform): string[] {
  const segments = path.split("/");
  return segments.map((_, index): string => foldName(segments.slice(0, index + 1).join("/"), platform));
}

export interface RecordEntry {
  readonly path: string;
  /** HMAC-SHA256 of the bytes copied; null for an entry carried over from a v0.1 record, which cannot be verified. */
  readonly hmac: string | null;
}

interface Manifest {
  readonly copies: readonly RecordEntry[];
  /** True when the record on disk was v0.1: it is rewritten as v0.2. */
  readonly legacy: boolean;
}

/** The copy record, or a step error when it is not the contract's shape. A v0.1 record is read with every digest null. */
export function parseManifest(text: string, where: string): Manifest {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new WorktreeStepError(`the copy record '${where}' is not JSON (${(error as Error).message}); nen will not decide what to remove from a record it cannot read`);
  }
  const record = doc as { contract?: unknown; copies?: unknown };
  const legacy = typeof doc === "object" && doc !== null && record.contract === MANIFEST_CONTRACT_V1;
  if (typeof doc !== "object" || doc === null || (record.contract !== MANIFEST_CONTRACT && !legacy) || !Array.isArray(record.copies)) {
    throw new WorktreeStepError(`the copy record '${where}' is not a ${MANIFEST_CONTRACT} document`);
  }
  const copies: RecordEntry[] = [];
  for (const entry of record.copies as unknown[]) {
    const row = entry as { path?: unknown; hmac?: unknown; sha256?: unknown };
    const digest = legacy ? row.sha256 : row.hmac;
    const digestOk = typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest);
    const nullOk = !legacy && digest === null;
    if (typeof row.path !== "string" || copyPathRefusal(row.path) !== null || !(digestOk || nullOk)) {
      throw new WorktreeStepError(`the copy record '${where}' holds an entry that is not { path, ${legacy ? "sha256" : "hmac"} }`);
    }
    copies.push({ path: row.path, hmac: legacy ? null : (digest as string | null) });
  }
  return { copies, legacy };
}

function renderManifest(copies: readonly RecordEntry[]): string {
  return `${JSON.stringify({ contract: MANIFEST_CONTRACT, copies: copies.map((entry) => ({ path: entry.path, hmac: entry.hmac })) }, null, 2)}\n`;
}

// ── the default filesystem ──────────────────────────────────────────────────

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new WorktreeStepError(`could not lstat '${path}' (${(error as Error).message})`);
  }
}

/** Run a filesystem step, turning a raw error into a step error -- redacted and stripped (Feitan N4). */
function fsStep<T>(what: string, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof WorktreeStepError || error instanceof WorktreeRefusal) throw error;
    throw new WorktreeStepError(`${what} (${(error as Error).message})`);
  }
}

const NO_FOLLOW = (fsConstants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0;

/** The rename the copy uses -- a parameter only so a test can play a swap at the destination. */
export interface CopyOps {
  readonly rename: (from: string, to: string) => void;
}

/**
 * The bytes from `source`, staged in `stagingDir` and renamed to
 * `destination`; returns their HMAC-SHA256 under `key`. The source is opened without following a final link where
 * the platform can say so (O_NOFOLLOW; on Windows the lstat proof before this
 * is the guard) and must be a regular file on the open descriptor. The staged
 * file is created exclusively, carries the source's permission bits and times,
 * and is removed on every failure path.
 *
 * AFTER THE RENAME (Feitan F8) the destination's directory is resolved again
 * and the file there must be the one written, by device and inode. When it is
 * ours but the directory now resolves outside the worktree, our file is
 * unlinked from where it landed; when it is not ours, the foreign file is left
 * alone (it is not ours to delete) and the staged file, if the rename left it,
 * is removed. Either way: exit 1.
 */
export function copyThroughStaging(
  source: string,
  destination: string,
  stagingDir: string,
  inside: (directory: string) => boolean,
  key: Buffer,
  ops: CopyOps = { rename: renameSync },
): string {
  const input = openSync(source, fsConstants.O_RDONLY | NO_FOLLOW);
  let staged: string | null = null;
  try {
    const stat = fstatSync(input);
    if (!stat.isFile()) throw new WorktreeStepError(`'${source}' stopped being a regular file between the proof and the read; nothing was copied`);
    staged = join(stagingDir, `nen-wc-worktree-copy.${randomBytes(8).toString("hex")}`);
    const output = openSync(staged, "wx", stat.mode & 0o777);
    const hash = createHmac("sha256", key);
    let written: { readonly dev: bigint; readonly ino: bigint };
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const read = readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        hash.update(buffer.subarray(0, read));
        let done = 0;
        while (done < read) done += writeSync(output, buffer, done, read - done);
      }
      futimesSync(output, stat.atime, stat.mtime);
      const own = fstatSync(output, { bigint: true });
      written = { dev: own.dev, ino: own.ino };
    } finally {
      closeSync(output);
    }
    ops.rename(staged, destination);
    const directory = dirname(destination);
    let resolved: string | null;
    try {
      resolved = realpathSync.native(directory);
    } catch {
      resolved = null;
    }
    let landed: { readonly dev: bigint; readonly ino: bigint } | null;
    try {
      const at = lstatSync(destination, { bigint: true });
      landed = { dev: at.dev, ino: at.ino };
    } catch {
      landed = null;
    }
    const ours = landed !== null && landed.dev === written.dev && landed.ino === written.ino;
    if (resolved === null || !inside(resolved) || !ours) {
      if (ours) unlinkSync(destination);
      throw new WorktreeStepError(
        ours
          ? `the copy to '${destination}' landed in '${resolved ?? directory}', outside the worktree, after the rename; it was unlinked from there`
          : `the file at '${destination}' after the rename is not the one written (another process replaced it); it was left alone`,
      );
    }
    staged = null;
    return hash.digest("hex");
  } finally {
    closeSync(input);
    if (staged !== null) {
      try {
        unlinkSync(staged);
      } catch {
        // renamed away or already gone; the failure that brought us here is the one reported
      }
    }
  }
}

function digestRegularFile(path: string, key: Buffer): FileDigest | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return null;
    const hash = createHmac("sha256", key);
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return { digest: hash.digest("hex"), dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

function lstatBig(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
}

function unlinkIfSame(path: string, dev: bigint, ino: bigint): boolean {
  const now = lstatBig(path);
  if (now === null || !now.isFile() || now.dev !== dev || now.ino !== ino) return false;
  fsStep(`could not remove '${path}'`, () => unlinkSync(path));
  return true;
}

const KEY_BYTES = 32;

function loadKey(path: string, create: boolean): Buffer | null {
  return fsStep(`could not read or create the copy key '${path}'`, (): Buffer | null => {
    const stat = lstatOrNull(path);
    if (stat === null) {
      if (!create) return null;
      const key = randomBytes(KEY_BYTES);
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, key);
      } finally {
        closeSync(fd);
      }
      return key;
    }
    if (!stat.isFile()) throw new WorktreeStepError(`the copy key '${path}' is not a regular file`);
    const fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    try {
      const key = Buffer.alloc(KEY_BYTES + 1);
      const read = readSync(fd, key, 0, key.length, 0);
      if (read !== KEY_BYTES) throw new WorktreeStepError(`the copy key '${path}' is not ${KEY_BYTES} bytes`);
      return key.subarray(0, KEY_BYTES);
    } finally {
      closeSync(fd);
    }
  });
}

function removeLeftovers(dir: string): string[] {
  return fsStep(`could not sweep '${dir}' for leftovers`, (): string[] => {
    const removed: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!LEFTOVER.test(name)) continue;
      const at = join(dir, name);
      const stat = lstatOrNull(at);
      if (stat === null || !stat.isFile()) continue;
      unlinkSync(at);
      removed.push(name);
    }
    return removed;
  });
}

function writeTextAtomic(path: string, text: string): void {
  const staged = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(staged, "wx", 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(staged, path);
  } catch (error) {
    try {
      unlinkSync(staged);
    } catch {
      // already gone
    }
    throw error;
  }
}

export const nativeWorktreeFs: WorktreeFs = {
  lstat: lstatOrNull,
  realpath: (path: string): string => realpathSync.native(path),
  mkdirp: (path: string): void => {
    fsStep(`could not create '${path}'`, () => mkdirSync(path, { recursive: true }));
  },
  copyFile: (source, destination, stagingDir, inside, key): string => copyThroughStaging(source, destination, stagingDir, inside, key),
  digestFile: digestRegularFile,
  unlinkIfSame,
  loadKey,
  removeLeftovers,
  readText: (path: string): string | null =>
    fsStep(`could not read '${path}'`, (): string | null => {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }),
  writeTextAtomic: (path: string, text: string): void => {
    fsStep(`could not write '${path}'`, () => writeTextAtomic(path, text));
  },
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
    reached: null,
    dryRun: options.dryRun,
    headBefore: null,
    head: null,
    dropped: false,
    coreIgnored: null,
    copies: [],
    removed: [],
    kept: [],
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

/** Every tracked path of the checkout at `cwd`, folded -- one read, so no spelling of a tracked name slips past. */
function trackedFolded(git: Git, cwd: string, platform: NodeJS.Platform, where: string): Set<string> {
  return new Set(git.entries(cwd, ["ls-files", "-z", "--full-name"], `listing the files tracked in ${where}`).map((entry): string => foldName(entry, platform)));
}

/** The first tracked spelling a path or one of its ancestors matches, folded, or null. */
function trackedHit(tracked: ReadonlySet<string>, path: string, platform: NodeJS.Platform): string | null {
  const prefixes = foldedPrefixes(path, platform);
  const segments = path.split("/");
  for (let index = 0; index < prefixes.length; index += 1) {
    if (tracked.has(prefixes[index] ?? "")) return segments.slice(0, index + 1).join("/");
  }
  return null;
}

/** Walk a path's ancestors under `root` with lstat: each must be a real directory or absent. Returns the failing segment and why, or null. */
function ancestorProblem(fs: WorktreeFs, root: string, path: string): { readonly at: string; readonly why: "symlink" | "not-a-directory" | "absent" } | null {
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const at = segments.slice(0, depth).join("/");
    const stat = fs.lstat(join(root, ...segments.slice(0, depth)));
    if (stat === null) return { at, why: "absent" };
    if (stat.isSymbolicLink()) return { at, why: "symlink" };
    if (!stat.isDirectory()) return { at, why: "not-a-directory" };
  }
  return null;
}

/** Each copy source, proven in core. */
function proveSources(git: Git, fs: WorktreeFs, core: string, paths: readonly string[], platform: NodeJS.Platform): void {
  if (paths.length === 0) return;
  const tracked = trackedFolded(git, core, platform, "core");
  for (const path of paths) {
    const refusal = (text: string): WorktreeRefusal => new WorktreeRefusal("copy-source", `--copy-from-core '${path}' ${text}; refused.`);
    // Every ancestor first, by lstat (Feitan F4): a symlinked segment in core
    // would make every check below answer about somebody else's file.
    const ancestor = ancestorProblem(fs, core, path);
    if (ancestor?.why === "symlink") throw refusal(`lies beneath '${ancestor.at}', a symlink in core -- only a file under real directories is copied`);
    if (ancestor?.why === "not-a-directory") throw refusal(`lies beneath '${ancestor.at}', which is not a directory in core`);
    if (ancestor?.why === "absent") throw refusal("is absent in core -- its directory does not exist, and nothing is synthesised");
    const stat = fs.lstat(join(core, ...path.split("/")));
    if (stat === null) throw refusal("is absent in core -- the maintainer's own checkout is where it comes from, and nothing is synthesised");
    if (stat.isSymbolicLink()) throw refusal("is a symlink in core -- only a regular file is copied, never what a link points at");
    if (!stat.isFile()) throw refusal("is not a regular file in core");
    const hit = trackedHit(tracked, path, platform);
    if (hit !== null) throw refusal(`is tracked in core${hit === path ? "" : ` (as '${hit}')`} -- a tracked file is already in every worktree`);
    if (!git.yesNo(core, ["check-ignore", "-q", "--", path], `checking whether '${path}' is gitignored in core`)) {
      throw refusal("is not gitignored in core -- a copy would dirty the worktree, and the next run would refuse it as dirty");
    }
  }
}

/**
 * One level of a tree: each child's name, as git spells it, its mode and its
 * object id. The walk descends by OBJECT ID, never by a pathspec: on macOS git
 * precomposes both its output and its argv (core.precomposeunicode), so an
 * NFC pathspec would find nothing under an NFD directory the tree records.
 */
function treeChildren(git: Git, core: string, tree: string): Array<{ readonly name: string; readonly mode: string; readonly object: string }> {
  const children: Array<{ readonly name: string; readonly mode: string; readonly object: string }> = [];
  for (const record of git.entries(core, ["ls-tree", "-z", "--full-tree", "--end-of-options", tree], `reading ${tree} at the tip`)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", , object = ""] = record.slice(0, tab).split(" ");
    children.push({ name: record.slice(tab + 1), mode, object });
  }
  return children;
}

/**
 * Each destination, proven against the tip's TREE -- before anything is
 * created or moved. The walk goes one level at a time, matches each name
 * FOLDED (NFC, and case on darwin and win32), and descends by the object id of
 * the entry it matched, so a tracked NFD parent symlink is found under an NFC
 * request and the refusal names the tip's own spelling.
 */
function proveDestinationsAtTip(git: Git, core: string, tip: string, base: string, paths: readonly string[], platform: NodeJS.Platform): void {
  for (const path of paths) {
    const refusal = (text: string): WorktreeRefusal =>
      new WorktreeRefusal("copy-destination", `--copy-from-core '${path}' ${text} at ${REMOTE}/${base} (${tip}); refused, and nothing was created, moved or copied.`);
    const segments = path.split("/");
    // EVERY folded match, not the first (Nobunaga R6): on a folding platform a
    // tip may hold 'Kro' AND 'kro', and either one can be the hazard.
    let frontier: Array<{ readonly tree: string; readonly directory: string }> = [{ tree: tip, directory: "" }];
    for (let depth = 0; depth < segments.length; depth += 1) {
      const wanted = foldName(segments[depth] ?? "", platform);
      const leaf = depth === segments.length - 1;
      const matches = frontier.flatMap((at) =>
        treeChildren(git, core, at.tree)
          .filter((child): boolean => foldName(child.name, platform) === wanted)
          .map((child) => ({ ...child, spelled: at.directory === "" ? child.name : `${at.directory}/${child.name}` })),
      );
      if (matches.length === 0) break;
      const entry = matches.find((match): boolean => leaf || match.mode !== "040000");
      if (entry === undefined) {
        frontier = matches.map((match) => ({ tree: match.object, directory: match.spelled }));
        continue;
      }
      const spelled = entry.spelled;
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

/**
 * The paths a move to `tip` would write over that are IGNORED and untracked in
 * the worktree now -- git overwrites those silently (Nobunaga N9). A changed
 * path matches an ignored entry when either is the other or its ancestor.
 */
function wouldOverwriteIgnored(git: Git, fs: WorktreeFs, worktree: string, tip: string, platform: NodeJS.Platform): string[] {
  const ignored = git
    .entries(worktree, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], `listing '${worktree}''s ignored files`)
    .map((entry): string => entry.replace(/\/$/, ""));
  if (ignored.length === 0) return [];
  const exact = new Set(ignored.map((entry): string => foldName(entry, platform)));
  const ancestors = new Set(ignored.flatMap((entry): string[] => foldedPrefixes(entry, platform).slice(0, -1)));
  const changed = git.entries(worktree, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--end-of-options", "HEAD", tip], `diffing '${worktree}' against ${tip}`);
  return changed.filter((path): boolean => {
    const prefixes = foldedPrefixes(path, platform);
    const matched = prefixes.some((prefix): boolean => exact.has(prefix)) || ancestors.has(prefixes[prefixes.length - 1] ?? "");
    return matched && inTheWay(fs, worktree, path);
  });
}

/**
 * Whether something on disk is in the way of a path the move writes (Nobunaga
 * R3): the path itself exists, or one of its ancestors exists as something
 * other than a directory. An ignored 'build/cache' does not stand in the way of
 * a tip that adds 'build/out'.
 */
function inTheWay(fs: WorktreeFs, worktree: string, path: string): boolean {
  const segments = path.split("/");
  if (fs.lstat(join(worktree, ...segments)) !== null) return true;
  for (let depth = 1; depth < segments.length; depth += 1) {
    const stat = fs.lstat(join(worktree, ...segments.slice(0, depth)));
    if (stat === null) return false;
    if (!stat.isDirectory()) return true;
  }
  return false;
}

/** The fetch, and on failure the one question that tells "no such branch" (exit 2) from "could not reach it" (exit 1). */
function fetchTip(git: Git, core: string, base: string): void {
  const args = ["fetch", "--quiet", "--end-of-options", REMOTE, `refs/heads/${base}:refs/remotes/${REMOTE}/${base}`];
  const fetch = git.run(core, args);
  if (fetch.code === 0) return;
  if (fetch.spawnFailed) throw new WorktreeStepError(fetch.error);
  const probe = git.run(core, ["ls-remote", "--exit-code", "--end-of-options", REMOTE, `refs/heads/${base}`]);
  if (probe.code === 2) {
    throw new WorktreeRefusal("base", `${REMOTE} has no branch '${base}' ('git ls-remote --exit-code' found no refs/heads/${base}); nothing was created.`);
  }
  throw new WorktreeStepError(`fetching ${REMOTE}/${base} failed, so the tip is unknown ('git ${args.join(" ")}' failed: ${fetch.error})`);
}

interface Retention {
  readonly removed: RemovedRow[];
  readonly kept: KeptRow[];
  /** The UNNAMED record entries that survive this step (the kept ones). */
  readonly survivors: RecordEntry[];
}

/**
 * Recorded copies no longer named: removed ONLY when the file is untracked,
 * still ignored, a regular file whose bytes verify under the key -- and only
 * the file that was hashed (device and inode re-checked at the unlink). Every
 * other one is kept, with its reason, and never deleted (Feitan N1).
 */
function retain(
  git: Git,
  fs: WorktreeFs,
  worktree: string,
  manifest: Manifest,
  named: readonly string[],
  key: Buffer | null,
  dryRun: boolean,
  platform: NodeJS.Platform,
): Retention {
  const still = new Set(named.map((path): string => foldName(path, platform)));
  const removed: RemovedRow[] = [];
  const kept: KeptRow[] = [];
  const survivors: RecordEntry[] = [];
  const unnamed = manifest.copies.filter((entry): boolean => !still.has(foldName(entry.path, platform)));
  if (unnamed.length === 0) return { removed, kept, survivors };
  const tracked = trackedFolded(git, worktree, platform, "the worktree");
  for (const entry of unnamed) {
    const keep = (reason: KeptReason): void => {
      kept.push({ path: entry.path, reason });
      survivors.push(entry);
    };
    const ancestor = ancestorProblem(fs, worktree, entry.path);
    if (ancestor?.why === "absent") continue;
    if (ancestor !== null) {
      keep("not a regular file");
      continue;
    }
    const destination = join(worktree, ...entry.path.split("/"));
    const stat = fs.lstat(destination);
    if (stat === null) continue;
    if (entry.hmac === null || key === null) {
      keep("unverifiable record");
      continue;
    }
    if (trackedHit(tracked, entry.path, platform) !== null) {
      keep("tracked at the tip");
      continue;
    }
    if (!stat.isFile()) {
      keep("not a regular file");
      continue;
    }
    if (!git.yesNo(worktree, ["check-ignore", "-q", "--", entry.path], `checking whether '${entry.path}' is still gitignored in the worktree`)) {
      keep("not ignored");
      continue;
    }
    const digest = fs.digestFile(destination, key);
    if (digest === null) {
      keep("not a regular file");
      continue;
    }
    if (digest.digest !== entry.hmac) {
      keep("edited since copy");
      continue;
    }
    if (dryRun) {
      removed.push({ path: entry.path, action: "would-remove" });
    } else if (fs.unlinkIfSame(destination, digest.dev, digest.ino)) {
      removed.push({ path: entry.path, action: "removed" });
    } else {
      keep("edited since copy");
    }
  }
  return { removed, kept, survivors };
}

/** Each destination, proven in the worktree on disk, then copied through the git dir. */
function copyInto(
  git: Git,
  fs: WorktreeFs,
  core: string,
  worktree: string,
  gitDir: string,
  base: string,
  tip: string,
  paths: readonly string[],
  platform: NodeJS.Platform,
  key: Buffer,
  record: (path: string, hmac: string) => void,
): CopyRow[] {
  const rows: CopyRow[] = [];
  if (paths.length === 0) return rows;
  // Every tracked path, read WHOLE and folded (Feitan F1): an exact-spelling
  // `ls-files --error-unmatch` misses the NFD twin of an NFC request.
  const tracked = trackedFolded(git, worktree, platform, "the worktree");
  for (const path of paths) {
    const refusal = (text: string): WorktreeRefusal =>
      new WorktreeRefusal("copy-destination", `--copy-from-core '${path}' ${text}; refused. The worktree stands at ${REMOTE}/${base} (${tip}).`);
    const ancestor = ancestorProblem(fs, worktree, path);
    if (ancestor?.why === "symlink") throw refusal(`lies beneath '${ancestor.at}', a symlink in the worktree`);
    if (ancestor?.why === "not-a-directory") throw refusal(`lies beneath '${ancestor.at}', which is not a directory in the worktree`);
    const destination = join(worktree, ...path.split("/"));
    const leaf = fs.lstat(destination);
    if (leaf !== null && leaf.isSymbolicLink()) throw refusal("is a symlink in the worktree -- an untracked link at the destination is refused like a tracked one");
    if (leaf !== null && !leaf.isFile()) throw refusal("exists in the worktree and is not a regular file");
    const hit = trackedHit(tracked, path, platform);
    if (hit !== null) throw refusal(`is tracked in the worktree${hit === path ? "" : ` (as '${hit}')`}`);
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
    const inside = (directory: string): boolean => containedOn(worktree, directory, platform);
    if (!inside(resolvedDir)) throw refusal(`resolves outside the worktree (its directory is '${resolvedDir}')`);
    let hmac: string;
    try {
      hmac = fs.copyFile(join(core, ...path.split("/")), destination, gitDir, inside, key);
    } catch (error) {
      if (error instanceof WorktreeStepError) throw error;
      throw new WorktreeStepError(`copying '${path}' from core failed (${(error as Error).message}); the destination was not replaced`);
    }
    record(path, hmac);
    rows.push({ path, action: "copied" });
  }
  return rows;
}

/** The worktree's own git directory, proven to sit inside core's common one. */
function worktreeGitDir(git: Git, fs: WorktreeFs, core: string, worktree: string, platform: NodeJS.Platform): string {
  const gitDir = firstLine(git.must(worktree, ["rev-parse", "--path-format=absolute", "--git-dir"], `reading '${worktree}''s git directory`));
  let resolved: string;
  try {
    resolved = fs.realpath(gitDir);
  } catch (error) {
    throw new WorktreeStepError(`'${worktree}''s git directory '${gitDir}' does not resolve (${(error as Error).message})`);
  }
  if (!containedOn(join(core, ".git", "worktrees"), resolved, platform)) {
    throw new WorktreeStepError(`'${worktree}''s git directory '${resolved}' is not under core's .git/worktrees; nothing is staged or recorded there`);
  }
  return resolved;
}

/**
 * Bring `<core>/.nen/worktrees/<name>` to origin/<base>'s tip, retire the
 * recorded copies no longer named, and copy the named files into it. A
 * refusal comes back as an outcome; a git step that failed part-way throws
 * WorktreeStepError.
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
    const parent = join(core, ".nen", "worktrees");
    const path = join(parent, options.name);
    report = { ...report, core, path };
    proveBase(git, core, options.base);
    // THE COPY SOURCES, before anything moves, so a bad list costs nothing.
    proveSources(git, fs, core, options.copyFromCore, platform);

    // THE TIP. Fetched for real -- with no '+', so a rewound trunk fails
    // closed rather than silently moving the worktree backwards -- or read as
    // last fetched under --dry-run.
    // THE REMOTE, before anything is fetched or read (Nobunaga R5).
    const remote = git.run(core, ["remote", "get-url", REMOTE]);
    if (remote.spawnFailed) throw new WorktreeStepError(remote.error);
    if (remote.code !== 0) {
      throw new WorktreeRefusal("base", `no origin remote -- the tip is origin/<base>, and this checkout has no '${REMOTE}' ('git remote get-url ${REMOTE}' answered ${remote.error}).`);
    }
    if (!options.dryRun) fetchTip(git, core, options.base);
    const tipCall = git.run(core, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/remotes/${REMOTE}/${options.base}^{commit}`]);
    if (tipCall.spawnFailed) throw new WorktreeStepError(tipCall.error);
    if (tipCall.code !== 0) {
      throw new WorktreeRefusal("base", `${REMOTE}/${options.base} does not resolve${options.dryRun ? " (as last fetched; --dry-run fetches nothing)" : ""}.`);
    }
    const tip = firstLine(tipCall.stdout);
    report = { ...report, tip, fetched: !options.dryRun };

    proveDestinationsAtTip(git, core, tip, options.base, options.copyFromCore, platform);

    // THE PATH'S PARENTS, by lstat: a symlinked .nen or .nen/worktrees is refused.
    for (const dir of [join(core, ".nen"), parent]) {
      const stat = fs.lstat(dir);
      if (stat === null) continue;
      if (stat.isSymbolicLink()) throw new WorktreeRefusal("parent-symlink", `'${dir}' is a symlink -- the worktree, and every file copied into it, would land wherever it points.`);
      if (!stat.isDirectory()) throw new WorktreeRefusal("parent-symlink", `'${dir}' is not a directory.`);
    }

    // THE REGISTRATION -- an exact path match, never a prefix: a sibling
    // registration such as '<name>2' must never read as ours.
    const porcelain = git.must(core, ["worktree", "list", "--porcelain"], "listing the worktrees");
    const registrations = parseRegistrations(porcelain);
    // A NAME THAT IS ANOTHER REGISTRATION'S UNDER CASE OR NFC (Nobunaga N12).
    const aliasFold = (name: string): string => name.normalize("NFC").toLowerCase();
    const alias = registrations.find(
      (row): boolean => samePath(dirname(row.path), parent, platform) && basename(row.path) !== options.name && aliasFold(basename(row.path)) === aliasFold(options.name),
    );
    if (alias !== undefined) {
      throw new WorktreeRefusal("name-alias", `--name '${options.name}' differs from the registered worktree '${alias.path}' only by case or Unicode normalisation; use '${basename(alias.path)}', or remove that registration yourself.`, [alias.path]);
    }
    const ours = registrations.find((row): boolean => samePath(row.path, path, platform)) ?? null;
    const present = fs.lstat(path);
    let dropped = false;
    let registered = ours !== null;

    if (ours !== null && present === null) {
      if (ours.locked) {
        throw new WorktreeRefusal("locked", `'${path}' is registered and LOCKED, and its directory is gone -- a lock says it is coming back (a removable disk, a network share). Refused; 'git worktree unlock' it yourself if it is not.`, [ours.path]);
      }
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

    let state: ReachedState;
    let headBefore: string | null = null;
    if (registered && present !== null) {
      if (!present.isDirectory()) throw new WorktreeRefusal("stray", `'${path}' is registered but is not a directory.`);
      const top = git.run(path, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
      if (top.spawnFailed) throw new WorktreeStepError(top.error);
      if (top.code !== 0) throw new WorktreeRefusal("not-root", `'${path}' is registered but git cannot read it as a work tree (${top.error}).`);
      if (!samePath(firstLine(top.stdout), path, platform)) {
        throw new WorktreeRefusal("not-root", `'${path}' is not the worktree's own root (git answers '${firstLine(top.stdout)}').`);
      }
      const dirty = parseStatusZ(git.must(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], `reading '${path}''s status`));
      if (dirty.length > 0) {
        throw new WorktreeRefusal("dirty", `the worktree at '${path}' is dirty -- refused, and never reset, cleaned or discarded. Commit, move or remove these yourself:`, dirty);
      }
      headBefore = firstLine(git.must(path, ["rev-parse", "--verify", "HEAD"], `reading '${path}''s HEAD`));
      const attached = git.run(path, ["symbolic-ref", "-q", "HEAD"]).code === 0;
      if (headBefore === tip && !attached) {
        state = "reused";
      } else {
        const overwritten = headBefore === tip ? [] : wouldOverwriteIgnored(git, fs, path, tip, platform);
        if (overwritten.length > 0) {
          throw new WorktreeRefusal("would-overwrite-ignored", `moving '${path}' to ${tip} would overwrite ignored, untracked files that the tip tracks -- git would do it silently. Refused; move or remove these yourself:`, overwritten);
        }
        if (!options.dryRun) git.must(path, ["checkout", "--quiet", "--detach", "--end-of-options", tip], `moving '${path}' to ${tip}`);
        state = "moved";
      }
    } else {
      if (!options.dryRun) {
        fs.mkdirp(parent);
        const stat = fs.lstat(parent);
        if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new WorktreeRefusal("parent-symlink", `'${parent}' is not a real directory after it was created.`);
        }
        git.must(core, ["worktree", "add", "--quiet", "--detach", "--end-of-options", path, tip], `adding the worktree at '${path}'`);
      }
      state = dropped ? "recreated" : "created";
    }

    const coreIgnored = git.yesNo(core, ["check-ignore", "-q", "--", `${WORKTREES_DIR}/${options.name}`], "checking whether core ignores the worktree");
    report = { ...report, state, reached: state, headBefore, head: tip, coreIgnored };

    // RETENTION AND THE COPY need the worktree on disk; a dry run that would
    // create it has neither a record nor a tree to read.
    const exists = !(options.dryRun && (state === "created" || state === "recreated"));
    if (!exists) {
      report = { ...report, copies: options.copyFromCore.map((copy): CopyRow => ({ path: copy, action: "would-copy" })) };
      return { kind: "done", report, lines: renderLines(report) };
    }
    const gitDir = worktreeGitDir(git, fs, core, path, platform);
    // A crashed run's staged bytes or half-written record, swept (Feitan N2).
    if (!options.dryRun) fs.removeLeftovers(gitDir);
    const manifestPath = join(gitDir, MANIFEST_FILE);
    const manifestText = fs.readText(manifestPath);
    const manifest: Manifest = manifestText === null ? { copies: [], legacy: false } : parseManifest(manifestText, manifestPath);
    const needKey = manifest.copies.length > 0 || options.copyFromCore.length > 0;
    const key = needKey ? fs.loadKey(join(gitDir, KEY_FILE), !options.dryRun) : null;
    const retention = retain(git, fs, path, manifest, options.copyFromCore, key, options.dryRun, platform);
    report = { ...report, removed: retention.removed, kept: retention.kept };
    if (options.dryRun) {
      report = { ...report, copies: options.copyFromCore.map((copy): CopyRow => ({ path: copy, action: "would-copy" })) };
      return { kind: "done", report, lines: renderLines(report) };
    }

    // THE RECORD AFTER THIS RUN (Nobunaga R2): the kept unnamed entries, and
    // every STILL-NAMED entry carried as it was until this run re-copies it --
    // a refusal part-way must never drop the record of a file still on disk.
    // Rewritten whatever happens below.
    const still = new Set(options.copyFromCore.map((copy): string => foldName(copy, platform)));
    const recorded = new Map<string, RecordEntry>();
    for (const entry of manifest.copies) {
      const folded = foldName(entry.path, platform);
      if (still.has(folded) || retention.survivors.includes(entry)) recorded.set(folded, entry);
    }
    let copies: CopyRow[] = [];
    try {
      if (options.copyFromCore.length > 0 && key === null) throw new WorktreeStepError("the copy key could not be created");
      copies = copyInto(git, fs, core, path, gitDir, options.base, tip, options.copyFromCore, platform, key ?? Buffer.alloc(0), (copyPath, hmac): void => {
        recorded.set(foldName(copyPath, platform), { path: copyPath, hmac });
      });
    } finally {
      if (manifestText !== null || recorded.size > 0) {
        fs.writeTextAtomic(manifestPath, renderManifest([...recorded.values()]));
      }
    }
    report = { ...report, copies };
    return { kind: "done", report, lines: renderLines(report) };
  } catch (error) {
    if (error instanceof WorktreeStepError) throw error;
    if (!(error instanceof WorktreeRefusal)) {
      // A raw error from anywhere below is a failed step, made safe to print (Feitan N4).
      throw new WorktreeStepError(error instanceof Error ? error.message : String(error));
    }
    const refused: WorktreeReport = {
      ...report,
      state: "refused",
      head: null,
      refusal: { kind: error.kind, reason: error.message, paths: error.paths },
    };
    return { kind: "refused", report: refused, message: error.message };
  }
}

const VERB: Readonly<Record<ReachedState, string>> = {
  created: "created",
  reused: "reused",
  moved: "moved",
  recreated: "recreated (its vanished registration dropped)",
};

const WOULD: Readonly<Record<ReachedState, string>> = {
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
  if (report.reached !== null) {
    const words = report.dryRun ? WOULD[report.reached] : VERB[report.reached];
    lines.push(`worktree:        ${report.path ?? ""} (${words})`);
    if (report.headBefore !== null && report.headBefore !== report.head) lines.push(`head before:     ${report.headBefore}`);
    lines.push(`head:            ${report.head ?? ""}`);
  }
  for (const row of report.removed) {
    lines.push(`removed:         ${row.path} (${row.action === "removed" ? "no longer named; bytes as copied" : "would remove: no longer named; bytes as copied"})`);
  }
  for (const row of report.kept) lines.push(`kept:            ${row.path} (${row.reason})`);
  if (report.copies.length === 0) lines.push("copied:          none named (--copy-from-core)");
  for (const copy of report.copies) {
    lines.push(`copied:          ${copy.path} (${copy.action === "copied" ? "from core, gitignored" : "would copy from core"})`);
  }
  return lines;
}
