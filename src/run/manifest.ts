// src/run/manifest.ts -- the run manifest (`nen.run/v0.1`): one batch run's
// identity, its launch-time idle answers, and every pull request it opened,
// whatever the base (Hatsu ruling HR-5; SDD plan findings D5, D4).
//
// WHY A FILE AND NOT A MEMORY. A futon or kazaana run's identity, its authored
// PR set and its `then` gate used to live in the conversation that ran it. The
// stacked-delivery ownership record exists only for non-main PRs, so a
// re-invoked run could not compute "every PR this run authored" -- the set its
// `then` gate and its final register both depend on. The manifest is that set,
// written as each PR opens, and read back live by `nen run verify`.
//
// WHERE IT LIVES. `<git-common-dir>/.nen/runs/<run-id>.json`: the git COMMON
// dir, so every worktree of one project reads and writes the same manifest,
// and a cleanup that removes an effort worktree cannot take the run's record
// with it (the loss SDD finding autonomy-loop#1 names for `.nen/loop/`). It is
// never under the work tree, so no `git add` can stage it. `.nen/` is nen's one
// root for its own records there (../ledger/roots.json), beside `.nen/loop/`
// and `.nen/stops/`; `hatsu/` stays the consumer's. A manifest an earlier build
// of this change wrote at `<git-common-dir>/hatsu/runs/` is moved once.
//
// FIELD MEANINGS MATCH HATSU'S RUN RECORD (hatsu.futon.run/v0.2) where both
// carry one: `head` is the head COMMIT and `branch` the head BRANCH name (Hatsu
// keeps the branch under `head`; nen names both), `issue` is the
// `<CODE>#<N>` string (the number is what follows `#`) and null for an
// integration or release PR, `repo` is the `owner/name` every PR lives in, and
// `parked[]` `{ issue, row, at }` is HR-5's park state. Which file Hatsu's
// `then` gate reads is Hatsu's to say. `nen run import` (./import.ts, NN#486
// AC-5) reads Hatsu's v0.2 manifest into this one, so one manifest owns the
// run and Hatsu's recorder can retire.
//
// NEN RECORDS AND READS; IT NEVER DECIDES. Nothing here chooses which PR a run
// may open, whether a gate passes, or what an idle answer means: start writes
// the launch answers it was handed, append records the PR it was told about,
// and the readers report.

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { withLedgerLock } from "../ledger/lock.js";
import { RUNS_COMMON_SEGMENTS, RUNS_LEGACY_SEGMENTS } from "../ledger/roots.js";
import { loopIdSegment } from "../loop/ledger.js";
import { IDLE_RESOLUTIONS, type IdleResolution } from "../schema/workflow.js";

export const RUN_CONTRACT = "nen.run/v0.1";
/** Below the git common dir, forward-slashed; the segments are ../ledger/roots.json's data. */
export const RUN_MANIFEST_DIR: string = RUNS_COMMON_SEGMENTS.join("/");

export const RUN_KINDS = ["delivery", "integration", "release"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** KEY ORDER IS THE CONTRACT; ./manifest.test.ts pins it. */
export interface RunPr {
  /** The issue the PR delivers, as `<CODE>#<N>` or `<owner/name>#<N>`; null for an integration or release PR. */
  readonly issue: string | null;
  readonly pr: number;
  /** The base the PR was opened (or last recorded) against, read live. */
  readonly base: string;
  /** The PR's head branch, read live. */
  readonly branch: string;
  readonly kind: RunKind;
  /** The head commit last recorded for the PR, read live. */
  readonly head: string;
  /** The effort id its usage ledger is keyed by, or null when none was named. */
  readonly effort: string | null;
  readonly recordedAt: string;
}

/** One effort parked on an unanswered ask-once row (HR-5). KEY ORDER IS THE CONTRACT. */
export interface RunParked {
  readonly issue: string;
  readonly row: string;
  readonly at: string;
}

/** KEY ORDER IS THE CONTRACT; ./manifest.test.ts pins it. */
export interface RunManifest {
  readonly contract: typeof RUN_CONTRACT;
  readonly id: string;
  /** The `owner/name` every recorded PR lives in; `run verify --target` must name it. */
  readonly repo: string;
  readonly startedAt: string;
  /** The launch-time answers per ask-once row id (HR-5), or null when the run was started without them. */
  readonly idleAnswers: Readonly<Record<string, IdleResolution>> | null;
  readonly prs: readonly RunPr[];
  readonly parked: readonly RunParked[];
}

export class RunManifestError extends Error {}

/** The run id, or null when it is not one path segment (the loop ledger's own alphabet). */
export function runIdSegment(id: string): string | null {
  return loopIdSegment(id);
}

/** `<CODE>#<N>` or `<owner/name>#<N>`; anything else is not an issue reference. */
export const ISSUE_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)?#[1-9][0-9]*$/;
/** A commit id: 7 to 40 hex digits. */
export const HEAD_SHA = /^[0-9a-f]{7,40}$/i;
/** A branch name as `git check-ref-format --branch` would mostly take it; refused rather than repaired. */
export const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]+(?<![./])$/;

/** An `owner/name` repository slug. */
export const REPO_SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
/** An ask-once row id, as nen/decisions.json spells one. */
export const ROW_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The project's git common dir, absolute, or a refusal. Read through the seam
 * so a test scripts it; a checkout git cannot answer for is not a place to
 * keep a run. git is asked in the C locale with an inherited GIT_DIR,
 * GIT_COMMON_DIR and GIT_WORK_TREE dropped, as ../loop/home.ts asks it, so a
 * hook's or a wrapper's environment cannot point the manifest at another
 * repository's common dir (Phinks, delivery round on zheref/nen#498).
 */
export function gitCommonDir(seams: Seams, root: string): string {
  const result = seams.run(GIT, ["-C", root, "rev-parse", "--git-common-dir"], {
    env: { LC_ALL: "C", LANGUAGE: undefined, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  const lines = outputLines(result.stdout);
  if (result.spawnFailed || result.code !== 0 || lines.length !== 1 || lines[0] === "") {
    throw new RunManifestError(
      `could not read the git common dir of '${root}' (git rev-parse --git-common-dir: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}). A run manifest lives there; nen does not fall back to the work tree, where a cleanup or a 'git add' could reach it.`,
    );
  }
  const line = lines[0] as string;
  return isAbsolute(line) ? line : resolve(root, line);
}

export function runManifestPath(commonDir: string, id: string): string {
  return join(commonDir, ...RUNS_COMMON_SEGMENTS, `${id}.json`);
}

/** The mode a manifest file is written with, and its directory's (zheref/nen#522 AC-1). */
export const MANIFEST_FILE_MODE = 0o600;
export const MANIFEST_DIR_MODE = 0o700;

/**
 * How the manifest's modes are set: the host's platform and its chmod. A seam
 * so a test proves the said-not-claimed path (AC-3) by injecting a chmod that
 * fails, never by running as another user, and the win32 path on any host.
 */
export interface ModeOps {
  readonly platform: NodeJS.Platform;
  readonly chmod: (path: string, mode: number) => void;
}

export const HOST_MODE_OPS: ModeOps = { platform: process.platform, chmod: chmodSync };

/**
 * What a write did to the manifest's modes -- READ BACK, never asserted from
 * intent (zheref/nen#522). `set`: the file reads 0600 and its directory 0700
 * after the write. `would-set`: a dry form, nothing written; `repaired` lists
 * the wider modes the real write would narrow. `not-set`: the host has no
 * POSIX modes, a chmod failed, or the read-back is not 0600/0700 -- `reason`
 * says which, and the verb prints it rather than claiming the mode (AC-3).
 * KEY ORDER IS THE CONTRACT.
 */
export interface ManifestModes {
  readonly verdict: "set" | "would-set" | "not-set";
  /** The file's mode as read back (`0600`), the planned one under a dry form, or null when unknown. */
  readonly file: string | null;
  /** The directory's mode, the same way. */
  readonly directory: string | null;
  /** Each wider mode narrowed (or, dry, to be narrowed): `file 0644 -> 0600`. */
  readonly repaired: readonly string[];
  readonly reason: string | null;
}

const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(4, "0");
/** What is AT the path, never what a link points to (lstat); null when nothing is there. */
function entryAt(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const present = (path: string): boolean => entryAt(path) !== null;
const modeOf = (path: string): number | null => {
  const entry = entryAt(path);
  return entry === null ? null : entry.mode & 0o777;
};

/**
 * Refuse a manifest path that holds anything but a regular file (Nobunaga N1,
 * N2 on #522). A link is never read through, moved, chmod-ed or written over:
 * chmod follows a link, so narrowing one would change a file OUTSIDE the runs
 * directory and then claim `set` for it. Absent is fine -- that is a new run.
 */
export function refuseIrregularManifest(path: string): void {
  const entry = entryAt(path);
  if (entry === null || entry.isFile()) return;
  throw new RunManifestError(
    `'${path}' is ${entry.isSymbolicLink() ? "a symbolic link" : "not a regular file"}; nen reads, moves and writes a run manifest only as a regular file, never through a link or over one. Move it aside.`,
  );
}

/**
 * How many path components a runs directory sits below the git common dir:
 * `.nen/runs` and the legacy `hatsu/runs` are both two. Every one of them is
 * checked, not only the last (Cursor Bugbot on NN-PR-#549): a `.nen` that is a
 * link would otherwise be followed by mkdir and chmod, narrowing and writing
 * into a directory outside the common dir while the verb reported `set`.
 */
const RUNS_DIR_DEPTH = Math.max(RUNS_COMMON_SEGMENTS.length, ...RUNS_LEGACY_SEGMENTS.map((segments): number => segments.length));

/** The first of `dir` and its ancestors up to `depth` components that is a link or not a directory (lstat), else null. */
export function irregularDirComponent(dir: string, depth: number): { readonly path: string; readonly link: boolean } | null {
  const components: string[] = [];
  let at = dir;
  for (let i = 0; i < depth; i += 1) {
    components.unshift(at);
    at = dirname(at);
  }
  for (const component of components) {
    const entry = entryAt(component);
    if (entry === null) return null;
    if (entry.isSymbolicLink() || !entry.isDirectory()) return { path: component, link: entry.isSymbolicLink() };
  }
  return null;
}

/**
 * Refuse a runs directory, or any of its components below the git common dir,
 * that is a link or not a directory: its mode would be some other directory's,
 * and a write would land outside the common dir.
 */
function refuseIrregularDir(dir: string): void {
  const bad = irregularDirComponent(dir, RUNS_DIR_DEPTH);
  if (bad === null) return;
  throw new RunManifestError(
    `'${bad.path}' is ${bad.link ? "a symbolic link" : "not a directory"}; nen keeps run manifests only in a real directory under the git common dir, which it can hold at 0700, never through a link. Move it aside.`,
  );
}
const noPosixModes = (platform: NodeJS.Platform): string | null =>
  platform === "win32" ? "this host (win32) has no POSIX file modes; the manifest takes its directory's access control list" : null;

/**
 * One `mode` for a call that may have written twice: the legacy move, then
 * the plan's own write (Nobunaga N9 on #522). Either alone is itself; both
 * keep the move's narrowing, which the second write can no longer see, and a
 * `not-set` from either wins with both reasons -- a mode is never claimed for
 * a call where one of its writes could not set it.
 */
export function combineModes(moved: ManifestModes | null, written: ManifestModes | null): ManifestModes | null {
  if (moved === null) return written;
  if (written === null) return moved;
  const repaired = [...new Set([...moved.repaired, ...written.repaired])];
  const reasons = [moved.reason, written.reason].filter((reason): reason is string => reason !== null && reason !== "");
  const failed = moved.verdict === "not-set" || written.verdict === "not-set";
  if (failed) return { verdict: "not-set", file: written.file, directory: written.directory, repaired, reason: [...new Set(reasons)].join("; ") || null };
  return { ...written, repaired };
}

/** The one line a verb prints for `modes`, or none when nothing was written. */
export function renderModes(modes: ManifestModes | null): string[] {
  if (modes === null) return [];
  const repaired = modes.repaired.length === 0 ? "" : ` (${modes.verdict === "would-set" ? "would narrow" : "narrowed"}: ${modes.repaired.join(", ")})`;
  if (modes.verdict === "not-set") return [`mode: not set (${modes.reason ?? "unknown"})`];
  if (modes.verdict === "would-set") return [`mode: would set file ${modes.file}, directory ${modes.directory}${repaired} -- dry run, nothing written`];
  return [`mode: file ${modes.file}, directory ${modes.directory}${repaired}`];
}

/**
 * Create the runs directory at 0700 when it is absent -- creation only, so the
 * ledger lock (which creates its parent at the umask's mode) never makes it
 * first. A directory that already exists is narrowed at write time, where it
 * is reported.
 */
export function createManifestDir(dir: string, ops: ModeOps = HOST_MODE_OPS): void {
  refuseIrregularDir(dir);
  if (present(dir)) return;
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir, { mode: MANIFEST_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return;
  }
  // mkdir's mode is masked by the umask; a umask that removes the owner's own
  // bits would leave a directory nen cannot use, so it is set outright.
  if (noPosixModes(ops.platform) === null) {
    try {
      ops.chmod(dir, MANIFEST_DIR_MODE);
    } catch {
      // Reported by the write that follows, which reads the mode back.
    }
  }
}

/**
 * The repairs a write would make: every wider mode on the directory and the
 * file. `filePath` is where the file is now -- the legacy path, under a dry
 * form that has not moved it -- so the dry line and the move's line agree.
 */
function plannedRepairs(path: string, filePath: string = path): string[] {
  const repairs: string[] = [];
  const dirMode = modeOf(dirname(path));
  if (dirMode !== null && dirMode !== MANIFEST_DIR_MODE) repairs.push(`directory ${octal(dirMode)} -> ${octal(MANIFEST_DIR_MODE)}`);
  const fileMode = modeOf(filePath);
  if (fileMode !== null && fileMode !== MANIFEST_FILE_MODE) repairs.push(`file ${octal(fileMode)} -> ${octal(MANIFEST_FILE_MODE)}`);
  return repairs;
}

/** What a dry form says about the modes the real write would set. */
export function plannedModes(path: string, ops: ModeOps = HOST_MODE_OPS, filePath: string = path): ManifestModes {
  const none = noPosixModes(ops.platform);
  if (none !== null) return { verdict: "not-set", file: null, directory: null, repaired: [], reason: `${none} -- dry run, nothing written` };
  return { verdict: "would-set", file: octal(MANIFEST_FILE_MODE), directory: octal(MANIFEST_DIR_MODE), repaired: plannedRepairs(path, filePath), reason: null };
}

/**
 * Narrow the manifest at `path` and its directory to 0600 and 0700 and read
 * both back. The file is never left unwritten for a mode that could not be
 * set: the run's record matters more than its mode, so the write stands and
 * the verb SAYS the mode was not set (AC-3).
 */
function settleModes(path: string, before: readonly string[], ops: ModeOps, failures: readonly string[]): ManifestModes {
  const none = noPosixModes(ops.platform);
  if (none !== null) return { verdict: "not-set", file: null, directory: null, repaired: [], reason: none };
  const dir = dirname(path);
  const problems = [...failures];
  const dirMode = modeOf(dir);
  const fileMode = modeOf(path);
  if (dirMode !== MANIFEST_DIR_MODE) problems.push(`directory ${dir} reads ${dirMode === null ? "absent" : octal(dirMode)}, not ${octal(MANIFEST_DIR_MODE)}`);
  if (fileMode !== MANIFEST_FILE_MODE) problems.push(`file reads ${fileMode === null ? "absent" : octal(fileMode)}, not ${octal(MANIFEST_FILE_MODE)}`);
  if (problems.length > 0) {
    return { verdict: "not-set", file: fileMode === null ? null : octal(fileMode), directory: dirMode === null ? null : octal(dirMode), repaired: [], reason: problems.join("; ") };
  }
  return { verdict: "set", file: octal(MANIFEST_FILE_MODE), directory: octal(MANIFEST_DIR_MODE), repaired: before, reason: null };
}

/** Narrow the directory before a write, collecting a chmod failure rather than throwing it. */
function narrowDir(dir: string, ops: ModeOps, failures: string[]): void {
  refuseIrregularDir(dir);
  const mode = modeOf(dir);
  if (mode === null || mode === MANIFEST_DIR_MODE) return;
  try {
    ops.chmod(dir, MANIFEST_DIR_MODE);
  } catch (error) {
    failures.push(`chmod ${octal(MANIFEST_DIR_MODE)} ${dir} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Write the manifest whole: the directory narrowed to 0700, the document to a
 * temp file created exclusively at 0600 and chmod-ed to it (the umask can only
 * remove bits), then a rename -- so the file at `path` is replaced with a 0600
 * one in one step and a reader never sees a torn manifest. A manifest an
 * earlier build left at 0644 is narrowed by the rename itself, and said so.
 */
export function writeRunManifest(path: string, manifest: RunManifest, ops: ModeOps = HOST_MODE_OPS): ManifestModes {
  const dir = dirname(path);
  refuseIrregularManifest(path);
  createManifestDir(dir, ops);
  const posix = noPosixModes(ops.platform) === null;
  const before = posix ? plannedRepairs(path) : [];
  const failures: string[] = [];
  if (posix) narrowDir(dir, ops, failures);
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  // Removed in `finally` only once THIS call created it: a 'wx' that failed on
  // EEXIST found another holder's file at that name, which is not ours (N7).
  let created = false;
  try {
    writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: MANIFEST_FILE_MODE, flag: "wx" });
    created = true;
    if (posix) {
      try {
        ops.chmod(temp, MANIFEST_FILE_MODE);
      } catch (error) {
        failures.push(`chmod ${octal(MANIFEST_FILE_MODE)} on the manifest failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    renameSync(temp, path);
    created = false;
  } finally {
    if (created) rmSync(temp, { force: true });
  }
  return settleModes(path, before, ops, failures);
}

export interface LocatedManifest {
  /** Where the manifest lives (or will, once moved): `<common>/.nen/runs/<id>.json`. */
  readonly path: string;
  /** Where to READ it from: `path`, or the legacy path when a dry form left it there. */
  readonly readPath: string;
  /** The legacy path it was (or, dry, would be) moved from; null when there was nothing to move. */
  readonly migratedFrom: string | null;
  /** True only when the file was actually moved. */
  readonly moved: boolean;
  /** The modes the move set (or would set); null when nothing was moved. */
  readonly modes: ManifestModes | null;
}

/**
 * The manifest path for `id`, after moving a manifest an earlier build left at
 * a legacy spelling (`<common>/hatsu/runs/<id>.json`) to it once. A manifest at
 * both paths is refused: nen does not choose which record is the run.
 *
 * THE MOVE IS A WRITE, so it has a dry form (zheref/nen#522 AC-2): with
 * `dryRun` the legacy file is left where it is, `readPath` names it so the
 * verb still reads the run, and `moved` is false -- the caller prints the move
 * it would make. A real move lands the file at 0600 under a 0700 directory,
 * read back into `modes`.
 */
export function locateRunManifest(commonDir: string, id: string, options: { readonly dryRun?: boolean; readonly ops?: ModeOps } = {}): LocatedManifest {
  const ops = options.ops ?? HOST_MODE_OPS;
  const path = runManifestPath(commonDir, id);
  // lstat, not exists: a dangling link at a legacy path is still something there, and refused (N1).
  const legacy = RUNS_LEGACY_SEGMENTS.map((segments): string => join(commonDir, ...segments, `${id}.json`)).filter((candidate): boolean => present(candidate));
  refuseIrregularManifest(path);
  // A runs directory that is a link is refused for a reader too (N8): nen never reads through one.
  refuseIrregularDir(dirname(path));
  if (legacy.length === 0) return { path, readPath: path, migratedFrom: null, moved: false, modes: null };
  if (present(path) || legacy.length > 1) {
    throw new RunManifestError(`run '${id}' has a manifest in more than one place (${[...(present(path) ? [path] : []), ...legacy].join(", ")}); nen will not choose which is the run. Keep one and move the others aside.`);
  }
  const from = legacy[0] as string;
  refuseIrregularManifest(from);
  if (options.dryRun === true) {
    return { path, readPath: from, migratedFrom: from, moved: false, modes: plannedModes(path, ops, from) };
  }
  createManifestDir(dirname(path), ops);
  return withLedgerLock(path, () => {
    refuseIrregularManifest(from);
    if (present(path)) throw new RunManifestError(`run '${id}' appeared at ${path} while ${from} was being moved there; nen will not choose which is the run.`);
    const posix = noPosixModes(ops.platform) === null;
    const before: string[] = [];
    const failures: string[] = [];
    if (posix) {
      const dirMode = modeOf(dirname(path));
      if (dirMode !== null && dirMode !== MANIFEST_DIR_MODE) before.push(`directory ${octal(dirMode)} -> ${octal(MANIFEST_DIR_MODE)}`);
      narrowDir(dirname(path), ops, failures);
    }
    renameSync(from, path);
    if (posix) {
      const fileMode = modeOf(path);
      if (fileMode !== null && fileMode !== MANIFEST_FILE_MODE) {
        before.push(`file ${octal(fileMode)} -> ${octal(MANIFEST_FILE_MODE)}`);
        try {
          ops.chmod(path, MANIFEST_FILE_MODE);
        } catch (error) {
          failures.push(`chmod ${octal(MANIFEST_FILE_MODE)} on the moved manifest failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { path, readPath: path, migratedFrom: from, moved: true, modes: settleModes(path, before, ops, failures) };
  });
}

/**
 * Parse `--idle-answers`: a JSON object from ask-once row id to one of the
 * HR-5 resolutions. Shape only -- whether each id names an ask-once row is
 * `nen schema check`'s `nen/workflow.json#idle` row's to say, against the
 * repository's own nen/decisions.json.
 */
export function parseIdleAnswers(text: string): Readonly<Record<string, IdleResolution>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RunManifestError(`--idle-answers is not JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RunManifestError("--idle-answers must be a JSON object from ask-once row id to default | hold | refuse.");
  }
  const answers: Record<string, IdleResolution> = {};
  for (const [row, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z0-9-]+$/.test(row)) {
      throw new RunManifestError(`--idle-answers row id '${row}' is not [a-z0-9-]+, the spelling nen/decisions.json uses.`);
    }
    if (typeof value !== "string" || !(IDLE_RESOLUTIONS as readonly string[]).includes(value)) {
      throw new RunManifestError(`--idle-answers '${row}' is ${JSON.stringify(value)}; it must be one of ${IDLE_RESOLUTIONS.join(", ")} (HR-5).`);
    }
    answers[row] = value as IdleResolution;
  }
  return answers;
}

function fail(path: string, why: string): never {
  throw new RunManifestError(`'${path}' is not a ${RUN_CONTRACT} manifest: ${why}. A manifest nen cannot read is never rewritten over and never read as an empty run; move it aside.`);
}

/** Validate a stored manifest field by field; a document this build did not write is refused, never coerced. */
export function parseRunManifest(path: string, value: unknown): RunManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "not a JSON object");
  const record = value as Record<string, unknown>;
  if (record["contract"] !== RUN_CONTRACT) fail(path, `contract is ${JSON.stringify(record["contract"])}`);
  const id = record["id"];
  if (typeof id !== "string" || runIdSegment(id) === null) fail(path, "id is not a run id");
  const startedAt = record["startedAt"];
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) fail(path, "startedAt is not an ISO-8601 instant");
  let idleAnswers: Readonly<Record<string, IdleResolution>> | null = null;
  if (record["idleAnswers"] !== null) {
    try {
      idleAnswers = parseIdleAnswers(JSON.stringify(record["idleAnswers"] ?? "missing"));
    } catch (error) {
      fail(path, `idleAnswers: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const repo = record["repo"];
  if (typeof repo !== "string" || !REPO_SLUG.test(repo)) fail(path, "repo is not an owner/name slug");
  const prs = record["prs"];
  if (!Array.isArray(prs)) fail(path, "prs is not an array");
  const parsed: RunPr[] = prs.map((entry, index): RunPr => {
    if (typeof entry !== "object" || entry === null) fail(path, `prs[${index}] is not an object`);
    const pr = entry as Record<string, unknown>;
    const str = (key: string, pattern: RegExp): string => {
      const v = pr[key];
      if (typeof v !== "string" || !pattern.test(v)) fail(path, `prs[${index}].${key} is ${JSON.stringify(v)}`);
      return v;
    };
    const number = pr["pr"];
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) fail(path, `prs[${index}].pr is not a pull request number`);
    const kind = pr["kind"];
    if (typeof kind !== "string" || !(RUN_KINDS as readonly string[]).includes(kind)) fail(path, `prs[${index}].kind is ${JSON.stringify(kind)}`);
    const issue = pr["issue"];
    if (issue === null ? kind === "delivery" : typeof issue !== "string" || !ISSUE_REF.test(issue)) fail(path, `prs[${index}].issue is ${JSON.stringify(issue)}`);
    const effort = pr["effort"];
    if (effort !== null && typeof effort !== "string") fail(path, `prs[${index}].effort is neither a string nor null`);
    const recordedAt = pr["recordedAt"];
    if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt))) fail(path, `prs[${index}].recordedAt is not an ISO-8601 instant`);
    return {
      issue: issue as string | null,
      pr: number,
      base: str("base", BRANCH_NAME),
      branch: str("branch", BRANCH_NAME),
      kind: kind as RunKind,
      head: str("head", HEAD_SHA),
      effort: effort as string | null,
      recordedAt,
    };
  });
  const rawParked = record["parked"];
  if (!Array.isArray(rawParked)) fail(path, "parked is not an array");
  const parked: RunParked[] = rawParked.map((entry, index): RunParked => {
    if (typeof entry !== "object" || entry === null) fail(path, `parked[${index}] is not an object`);
    const row = entry as Record<string, unknown>;
    if (typeof row["issue"] !== "string" || !ISSUE_REF.test(row["issue"])) fail(path, `parked[${index}].issue is ${JSON.stringify(row["issue"])}`);
    if (typeof row["row"] !== "string" || !ROW_ID.test(row["row"])) fail(path, `parked[${index}].row is ${JSON.stringify(row["row"])}`);
    if (typeof row["at"] !== "string" || Number.isNaN(Date.parse(row["at"]))) fail(path, `parked[${index}].at is not an ISO-8601 instant`);
    return { issue: row["issue"], row: row["row"], at: row["at"] };
  });
  return { contract: RUN_CONTRACT, id: id as string, repo, startedAt: startedAt as string, idleAnswers, prs: parsed, parked };
}

/** The manifest on disk, or null when there is none. Unreadable is a refusal, never null. */
export function readRunManifest(path: string): RunManifest | null {
  refuseIrregularDir(dirname(path));
  if (!present(path)) return null;
  refuseIrregularManifest(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(path, `not readable JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseRunManifest(path, value);
}

/** No answers and an empty answer map say the same thing; key order never matters. */
const answerKey = (a: RunManifest["idleAnswers"]): string => JSON.stringify(Object.entries(a ?? {}).sort());
const sameAnswers = (a: RunManifest["idleAnswers"], b: RunManifest["idleAnswers"]): boolean => answerKey(a) === answerKey(b);

export type StartOutcome =
  | { readonly outcome: "started" | "existing"; readonly manifest: RunManifest }
  | { readonly outcome: "conflict"; readonly manifest: RunManifest; readonly reason: string };

/**
 * What `run start` does to what is on disk -- pure, so the branches are data.
 *
 * A RE-START WITH THE SAME ANSWERS IS THE RESUME, and is `existing` at exit 0:
 * a re-invoked batch must be able to call start again without knowing whether
 * its first session got that far. A re-start with DIFFERENT answers is a
 * conflict: HR-5 records the batch resolution at launch, and an answer a later
 * session could rewrite would not be a launch answer.
 */
export function planStart(existing: RunManifest | null, id: string, repo: string, now: string, idleAnswers: RunManifest["idleAnswers"]): StartOutcome {
  if (existing === null) {
    return { outcome: "started", manifest: { contract: RUN_CONTRACT, id, repo, startedAt: now, idleAnswers, prs: [], parked: [] } };
  }
  if (existing.repo.toLowerCase() !== repo.toLowerCase()) {
    return { outcome: "conflict", manifest: existing, reason: `run '${id}' was started for ${existing.repo}, not ${repo}; one run lives in one repository.` };
  }
  if (sameAnswers(existing.idleAnswers, idleAnswers)) return { outcome: "existing", manifest: existing };
  return {
    outcome: "conflict",
    manifest: existing,
    reason: `run '${id}' was started at ${existing.startedAt} with other idle answers (${JSON.stringify(existing.idleAnswers)}); launch answers are fixed at start (HR-5) -- start a new run id to answer differently.`,
  };
}

export interface AppendInput {
  readonly issue: string | null;
  readonly pr: number;
  readonly base: string;
  readonly branch: string;
  readonly kind: RunKind;
  readonly head: string;
  readonly effort: string | null;
  readonly now: string;
}

export type AppendOutcome =
  | { readonly outcome: "appended" | "unchanged"; readonly manifest: RunManifest; readonly entry: RunPr }
  | { readonly outcome: "updated"; readonly manifest: RunManifest; readonly entry: RunPr; readonly previous: RunPr }
  | { readonly outcome: "conflict"; readonly manifest: RunManifest; readonly previous: RunPr; readonly reason: string };

/**
 * What `run append` does to a manifest -- pure.
 *
 * ONE ROW PER PULL REQUEST. Recording the same PR again is how a retry after a
 * partial failure stays safe: the same facts are `unchanged`; a moved head or
 * a retargeted base (catch-up, a stack collapsing onto its integration branch)
 * is `updated`, the previous row kept in the report. A different ISSUE or
 * KIND for a PR already recorded is a conflict -- one of the two callers is
 * wrong about which PR it opened, and nen cannot tell which. A changed effort
 * id is a conflict for the same reason, unless the row had none.
 */
export function planAppend(manifest: RunManifest, input: AppendInput): AppendOutcome {
  const previous = manifest.prs.find((entry): boolean => entry.pr === input.pr);
  if (previous === undefined) {
    const entry: RunPr = { issue: input.issue, pr: input.pr, base: input.base, branch: input.branch, kind: input.kind, head: input.head, effort: input.effort, recordedAt: input.now };
    return { outcome: "appended", manifest: { ...manifest, prs: [...manifest.prs, entry] }, entry };
  }
  const clashes: string[] = [];
  if (previous.issue !== input.issue) clashes.push(`issue ${previous.issue ?? "none"} -> ${input.issue ?? "none"}`);
  if (previous.kind !== input.kind) clashes.push(`kind ${previous.kind} -> ${input.kind}`);
  if (previous.effort !== null && input.effort !== null && previous.effort !== input.effort) clashes.push(`effort ${previous.effort} -> ${input.effort}`);
  if (clashes.length > 0) {
    return {
      outcome: "conflict",
      manifest,
      previous,
      reason: `PR #${input.pr} is already recorded in run '${manifest.id}' with other facts (${clashes.join("; ")}). A PR delivers one issue as one kind; nen will not pick which record is right.`,
    };
  }
  const effort = input.effort ?? previous.effort;
  if (previous.head.toLowerCase() === input.head.toLowerCase() && previous.base === input.base && previous.branch === input.branch && previous.effort === effort) {
    return { outcome: "unchanged", manifest, entry: previous };
  }
  const entry: RunPr = { ...previous, base: input.base, branch: input.branch, head: input.head, effort, recordedAt: input.now };
  return {
    outcome: "updated",
    manifest: { ...manifest, prs: manifest.prs.map((row): RunPr => (row.pr === input.pr ? entry : row)) },
    entry,
    previous,
  };
}

export type ParkOutcome =
  | { readonly outcome: "parked" | "unchanged"; readonly manifest: RunManifest; readonly entry: RunParked };

/**
 * What `run park` does to a manifest -- pure. An effort parked on a row is
 * recorded once; parking it on the same row again is `unchanged` (the retry).
 */
export function planPark(manifest: RunManifest, issue: string, row: string, now: string): ParkOutcome {
  const previous = manifest.parked.find((entry): boolean => entry.issue === issue && entry.row === row);
  if (previous !== undefined) return { outcome: "unchanged", manifest, entry: previous };
  const entry: RunParked = { issue, row, at: now };
  return { outcome: "parked", manifest: { ...manifest, parked: [...manifest.parked, entry] }, entry };
}

/**
 * Read-plan-write under the shared ledger lock, so two appends at once never
 * drop a row. `modes` is what the write set, read back (zheref/nen#522); under
 * a dry form (`write` false) it is what the write WOULD set when the plan
 * would write, and null whenever nothing is (or would be) written.
 * `readPath` is where a dry form reads a manifest still at a legacy path.
 */
export function withManifest<T extends { readonly manifest: RunManifest; readonly outcome: string }>(
  path: string,
  plan: (existing: RunManifest | null) => T,
  write: boolean,
  options: { readonly readPath?: string; readonly ops?: ModeOps } = {},
): T & { readonly modes: ManifestModes | null } {
  const ops = options.ops ?? HOST_MODE_OPS;
  const writes = (outcome: T): boolean => outcome.outcome !== "conflict" && outcome.outcome !== "existing" && outcome.outcome !== "unchanged";
  if (!write) {
    const outcome = plan(readRunManifest(options.readPath ?? path));
    return { ...outcome, modes: writes(outcome) ? plannedModes(path, ops, options.readPath ?? path) : null };
  }
  createManifestDir(dirname(path), ops);
  return withLedgerLock(path, () => {
    const outcome = plan(readRunManifest(path));
    return { ...outcome, modes: writes(outcome) ? writeRunManifest(path, outcome.manifest, ops) : null };
  });
}
