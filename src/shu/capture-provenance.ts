// src/shu/capture-provenance.ts -- the I/O half of `--from-capture`'s
// provenance (zheref/nen#250): the git reads that fingerprint a tree, the
// hashes of the declared reports, and the sidecar that records both.
//
// ./coverage/capture.ts holds the rule and says why it is provenance rather
// than modification times; this module gathers the facts that rule is applied
// to, and is the only place a sidecar is written or read.
//
// WHICH RUNS RECORD ONE -- decided by the DECLARATION, never by a guess about
// what a tool writes. A capture is "the lane's declared coverage reports", the
// recognised paths under `project.verbs.<lane>.coverage.artifacts`, so:
//
//   * `nen shu coverage` (the run form) always records one: those reports are
//     exactly what its command was declared to produce;
//   * `nen shu test` and `nen shu test-report` (the run form) record one only
//     when the SAME lane's `test` row declares EVERY one of those reports
//     among its own `artifacts` -- the repository saying, in its own file, that
//     its test command writes the coverage capture. A test row that declares
//     none of them, or only some, produces no capture nen can vouch for, and
//     records nothing.
//
// Never on `--dry-run` (nothing ran), and only for a run that exited 0 with
// every report on disk: a failed run's reports may be half-written. A sidecar
// is never deleted -- an old one stays truthful about the run that wrote it,
// and the report hashes and the fingerprint it carries are what keep it from
// vouching for anything else.

import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { GIT, ToolError, type CommandResult, type Seams } from "../seam/exec.js";
import {
  CAPTURE_CONTRACT,
  CAPTURE_DIRECTORY,
  excludedFromFingerprint,
  fingerprintOf,
  parseSidecar,
  sha256,
  sidecarPath,
  type ArtifactDigest,
  type CaptureSidecar,
  type UntrackedDigest,
} from "./coverage/capture.js";
import { recognisedByName } from "./coverage/parse.js";
import { openDeclaration } from "./declaration.js";
import { renderInvocation } from "./render.js";
import { insideRepo } from "./run.js";

/** Every git read here: paths raw (never C-quoted), whatever the user's config says. */
const RAW_PATHS = ["-c", "core.quotePath=false"] as const;

/** A NUL-separated path list (`-z`), split. A path's bytes are kept exactly. */
export function nulPaths(stdout: string): string[] {
  return stdout.split("\0").filter((entry): boolean => entry !== "");
}

/** A fingerprint of the tree as it is now, or why one could not be taken. */
export type Fingerprint =
  | { readonly ok: true; readonly head: string; readonly fingerprint: string }
  | {
      readonly ok: false;
      readonly why: string;
      /**
       * Set when git itself could not be STARTED -- an operational failure,
       * never a fact about the tree. `--from-capture` throws it (exit 1)
       * rather than reporting the capture refused (Copilot round 2 on
       * zheref/nen#369).
       */
      readonly error?: ToolError;
    };

/** A failed git read, as a `Fingerprint` failure: spawn failures carry the error. */
function failed(args: readonly string[], result: CommandResult, why: string): Extract<Fingerprint, { ok: false }> {
  return result.spawnFailed ? { ok: false, why, error: new ToolError(GIT, args, result) } : { ok: false, why };
}

/**
 * A `-z` path list from git's RAW stdout bytes, each record decoded by a FATAL
 * UTF-8 decoder (as ../stage/triage.ts reads `git status -z`). A record that
 * is not UTF-8 comes back as `{ undecodable }` -- the only thing that refuses;
 * a filename that really contains U+FFFD decodes cleanly and is kept.
 */
export function nulRecords(bytes: Uint8Array): (string | { readonly undecodable: string })[] {
  const fatal = new TextDecoder("utf-8", { fatal: true });
  const lenient = new TextDecoder("utf-8");
  const records: (string | { readonly undecodable: string })[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index++) {
    if (index < bytes.length && bytes[index] !== 0) continue;
    if (index > start) {
      const slice = bytes.subarray(start, index);
      try {
        records.push(fatal.decode(slice));
      } catch {
        records.push({ undecodable: lenient.decode(slice) });
      }
    }
    start = index + 1;
  }
  return records;
}

/** `git <args>` with stdout kept as raw bytes, for a `-z` path list. */
function gitBytes(seams: Seams, repoRoot: string, args: readonly string[]): CommandResult {
  return seams.run(GIT, args, { cwd: repoRoot, bytes: true });
}

function recordsOf(result: CommandResult): (string | { readonly undecodable: string })[] {
  return nulRecords(result.stdoutBytes ?? new TextEncoder().encode(result.stdout));
}

/**
 * sha256 over HEAD, `git diff HEAD --binary`, every untracked non-ignored
 * file's path and content, and every assume-unchanged or skip-worktree file's
 * raw object hash -- the declared reports and the sidecar directory left out
 * of all of them (./coverage/capture.ts says why).
 *
 * THE DIFF IS PINNED against the user's own configuration: no colour, no
 * external diff driver, no textconv filter, and submodules shown as diffs and
 * never ignored -- each of those would otherwise let the same tree print
 * different bytes, or let a changed tree print the same ones.
 *
 * NOTHING IS COLLAPSED TO A MARKER THAT COULD HIDE A DIFFERENCE. A path whose
 * bytes are not UTF-8 (told apart from a real U+FFFD by a fatal decoder over
 * git's raw output) and an untracked file nen cannot read both make the
 * fingerprint `ok: false`, naming the path -- the caller records nothing
 * rather than a fingerprint that would match a different tree.
 */
export function takeFingerprint(seams: Seams, repoRoot: string, artifacts: readonly string[]): Fingerprint {
  const headArgs = ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"];
  const head = seams.run(GIT, headArgs, { cwd: repoRoot });
  if (head.spawnFailed || head.code !== 0) {
    return failed(headArgs, head, "HEAD does not name a commit here (not a git work tree, or no commit yet)");
  }
  const exclude = [...artifacts, CAPTURE_DIRECTORY].map((path): string => `:(exclude,literal)${path}`);
  const diffArgs = [
    ...RAW_PATHS,
    "diff",
    "HEAD",
    "--binary",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--submodule=diff",
    "--ignore-submodules=none",
    "--",
    ".",
    ...exclude,
  ];
  const diff = seams.run(GIT, diffArgs, { cwd: repoRoot });
  if (diff.spawnFailed || diff.code !== 0) {
    return failed(diffArgs, diff, `'git diff HEAD --binary' exited ${diff.code}: ${diff.stderr.trim()}`);
  }
  const othersArgs = [...RAW_PATHS, "ls-files", "-z", "--others", "--exclude-standard"];
  const listed = gitBytes(seams, repoRoot, othersArgs);
  if (listed.spawnFailed || listed.code !== 0) {
    return failed(othersArgs, listed, `'git ls-files --others' exited ${listed.code}: ${listed.stderr.trim()}`);
  }
  const untracked: UntrackedDigest[] = [];
  for (const record of recordsOf(listed)) {
    if (typeof record !== "string") return notUtf8(record.undecodable);
    if (excludedFromFingerprint(record, artifacts)) continue;
    const digest = untrackedDigest(repoRoot, record);
    if (typeof digest !== "string") return { ok: false, why: digest.why };
    untracked.push({ path: record, sha256: digest });
  }
  const hidden = hiddenDigests(seams, repoRoot, artifacts);
  if (!Array.isArray(hidden)) return hidden as Extract<Fingerprint, { ok: false }>;
  const headSha = head.stdout.trim();
  return {
    ok: true,
    head: headSha,
    fingerprint: fingerprintOf({ head: headSha, diff: diff.stdout, untracked, hidden: hidden as UntrackedDigest[] }),
  };
}

function notUtf8(path: string): Extract<Fingerprint, { ok: false }> {
  return {
    ok: false,
    why: `the path '${path}' is not valid UTF-8 (git printed bytes a strict UTF-8 decoder rejects), so nen cannot name it exactly and cannot fingerprint it -- rename it, or ignore it`,
  };
}

/**
 * One untracked entry's content hash. A symlink is its TARGET string (git
 * stores a link that way, and following it could leave the tree); a directory
 * -- a NESTED repository, which git lists as `dir/` -- counts only as present
 * (a stated limit). Anything else nen cannot read is a refusal, never a
 * marker: a marker would make two different files fingerprint alike.
 */
function untrackedDigest(repoRoot: string, path: string): string | { readonly why: string } {
  const absolute = join(repoRoot, path);
  try {
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) return `link:${sha256(readlinkSync(absolute))}`;
    if (stats.isDirectory()) return "directory";
    return sha256(readFileSync(absolute));
  } catch (error) {
    return {
      why: `the untracked file '${path}' could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"}), so its content cannot be fingerprinted`,
    };
  }
}

/**
 * Tracked files git is told to look away from -- assume-unchanged (a
 * lower-case tag in `git ls-files -v`, `h` for an ordinary one) and
 * skip-worktree (`S`, `s` when both) -- with `git hash-object --no-filters`
 * of their working-tree bytes. `git diff` shows no edit to any of them, so
 * without this an edit there was invisible. Read-only: no `-w`, nothing is
 * written into the object store. A file the working tree does not hold (the
 * usual skip-worktree case) is `absent`.
 */
function hiddenDigests(
  seams: Seams,
  repoRoot: string,
  artifacts: readonly string[],
): UntrackedDigest[] | Extract<Fingerprint, { ok: false }> {
  const taggedArgs = [...RAW_PATHS, "ls-files", "-v", "-z"];
  const listed = gitBytes(seams, repoRoot, taggedArgs);
  if (listed.spawnFailed || listed.code !== 0) {
    return failed(taggedArgs, listed, `'git ls-files -v' exited ${listed.code}: ${listed.stderr.trim()}`);
  }
  const paths: string[] = [];
  for (const record of recordsOf(listed)) {
    const text = typeof record === "string" ? record : record.undecodable;
    const tag = text.slice(0, 1);
    const path = text.slice(2);
    const hidden = tag === "S" || (tag !== tag.toUpperCase() && tag === tag.toLowerCase());
    if (!hidden || excludedFromFingerprint(path, artifacts)) continue;
    if (typeof record !== "string") return notUtf8(path);
    paths.push(path);
  }
  if (paths.length === 0) return [];
  const present = paths.filter((path): boolean => {
    try {
      return lstatSync(join(repoRoot, path)).isFile();
    } catch {
      return false;
    }
  });
  const digests: UntrackedDigest[] = paths
    .filter((path): boolean => !present.includes(path))
    .map((path): UntrackedDigest => ({ path, sha256: "absent" }));
  if (present.length > 0) {
    const hashArgs = [...RAW_PATHS, "hash-object", "--no-filters", "--", ...present];
    const hashed = seams.run(GIT, hashArgs, { cwd: repoRoot });
    if (hashed.spawnFailed || hashed.code !== 0) {
      return failed(hashArgs, hashed, `'git hash-object --no-filters' exited ${hashed.code}: ${hashed.stderr.trim()}`);
    }
    const objects = hashed.stdout.split("\n").filter((line): boolean => line !== "");
    present.forEach((path, index): void => {
      digests.push({ path, sha256: objects[index] ?? "missing" });
    });
  }
  return digests;
}

/** Each declared report's content hash, in declaration order; null: not a file. */
export function digestArtifacts(repoRoot: string, lane: string, artifacts: readonly string[]): readonly ArtifactDigest[] {
  return artifacts.map((path): ArtifactDigest => {
    const absolute = insideRepo(repoRoot, path, `project.verbs.${lane}.coverage.artifacts`);
    return { path, sha256: fileStats(absolute) === null ? null : sha256(readFileSync(absolute)) };
  });
}

/** A report's identity on disk: its bytes' hash, size, mtime and inode -- or absent. */
interface ReportState {
  readonly sha256: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

function reportState(repoRoot: string, lane: string, artifact: string): ReportState | null {
  const absolute = insideRepo(repoRoot, artifact, `project.verbs.${lane}.coverage.artifacts`);
  const stats = fileStats(absolute);
  if (stats === null) return null;
  return { sha256: sha256(readFileSync(absolute)), size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
}

/**
 * UNCHANGED means present before and after with all four the same. Absent
 * before and present after was written; present after with any one differing
 * was written. (Absent after is the missing-report branch, handled first.)
 */
function sameState(before: ReportState | null, after: ReportState | null): boolean {
  if (before === null || after === null) return false;
  return (
    before.sha256 === after.sha256 &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ino === after.ino
  );
}

/**
 * THE ONE STAT RULE for a declared report (round 2, N6): `lstat`, and only a
 * regular FILE counts. A symlink at a report's path is not a report nen
 * hashes -- it could point anywhere -- and every reader here agrees on that.
 */
export function fileStats(absolute: string): Stats | null {
  try {
    const stats = lstatSync(absolute);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

/** The sidecar's absolute path, or why it resolves outside the repository. */
function containedSidecar(repoRoot: string, lane: string): string | { readonly why: string } {
  try {
    return insideRepo(repoRoot, sidecarPath(lane), "the capture sidecar");
  } catch (error) {
    if (error instanceof VerbUsageError) return { why: error.message };
    throw error;
  }
}

/** The lane's sidecar: read, absent, or unreadable with a reason. */
export type SidecarRead =
  | { readonly state: "present"; readonly sidecar: CaptureSidecar }
  | { readonly state: "missing" }
  | { readonly state: "unreadable"; readonly why: string };

export function readCaptureSidecar(repoRoot: string, lane: string): SidecarRead {
  // THE SIDECAR'S PATH IS FIXED, AND STILL CONTAINED (Copilot round 2 on
  // zheref/nen#369): a `.nen` or `coverage-capture` directory that is a
  // symlink out of the tree would otherwise have nen read -- and trust -- a
  // file outside it. The same real-path rule every declared path meets
  // (./run.ts's insideRepo); an escaping sidecar is UNREADABLE, never read.
  const absolute = containedSidecar(repoRoot, lane);
  if (typeof absolute !== "string") return { state: "unreadable", why: absolute.why };
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "unreadable", why: (error as NodeJS.ErrnoException).code ?? "unknown error" };
  }
  const parsed = parseSidecar(text);
  return typeof parsed === "string" ? { state: "unreadable", why: parsed } : { state: "present", sidecar: parsed };
}

/**
 * The lane and its recognised coverage reports, IF a run of `verb` on that
 * lane produces them (this file's header), or null.
 *
 * NULL ON EVERY REFUSAL, deliberately: the run that follows resolves the same
 * declaration and refuses in its own words, in its own order. This read must
 * never become a second, earlier refusal of the same thing.
 */
export function producedCapture(
  repoRoot: string,
  platform: string,
  lane: string | null,
  verb: "coverage" | "test",
): { readonly lane: string; readonly artifacts: readonly string[] } | null {
  try {
    const { project } = openDeclaration(repoRoot);
    const coverage = renderInvocation(project, { lane, verb: "coverage", platform });
    const artifacts = coverage.artifacts.filter((path): boolean => recognisedByName(path));
    if (artifacts.length === 0) return null;
    if (verb === "test") {
      const test = renderInvocation(project, { lane, verb: "test", platform });
      if (!artifacts.every((path): boolean => test.artifacts.includes(path))) return null;
    }
    return { lane: coverage.lane, artifacts };
  } catch {
    return null;
  }
}

/**
 * Run `run` and, when it is a run that produces the lane's coverage capture,
 * record that capture's provenance: the fingerprint BEFORE it starts, the
 * reports' hashes once it has exited 0.
 *
 * A FINGERPRINT THAT COULD NOT BE TAKEN records nothing and says so on stderr
 * -- the run itself is not refused for it: the run is what was asked for, and
 * `--from-capture` will refuse the capture later, by name, for having no
 * sidecar. Nothing is written into the document either, so a run's `--json`
 * output is the same with or without this.
 */
export async function recordCapture(
  context: CommandContext,
  repoRoot: string,
  request: { readonly lane: string | null; readonly verb: "coverage" | "test"; readonly recordAs: string; readonly dryRun: boolean },
  run: () => Promise<number>,
): Promise<number> {
  if (request.dryRun) return run();
  const produced = producedCapture(repoRoot, context.seams.platform, request.lane, request.verb);
  if (produced === null) return run();
  const startedAt = context.seams.now().toISOString();
  const before = takeFingerprint(context.seams, repoRoot, produced.artifacts);
  // EACH REPORT'S STATE BEFORE THE RUN (round 2, N1). A run that exits 0
  // WITHOUT rewriting a report -- a tool that writes only when the file is
  // absent, a cache hit, a step that skipped -- would otherwise bind an old
  // tree's report to this tree's fingerprint. Absent is a state too.
  const prior = produced.artifacts.map((artifact): ReportState | null => reportState(repoRoot, produced.lane, artifact));
  const code = await run();
  if (code !== 0) return code;
  const path = sidecarPath(produced.lane);
  if (!before.ok) {
    context.io.err(
      `nen recorded no coverage-capture provenance for lane '${produced.lane}': ${before.why}. 'nen shu coverage --from-capture' will refuse this capture for having no sidecar at '${path}'.`,
    );
    return code;
  }
  const digests = digestArtifacts(repoRoot, produced.lane, produced.artifacts);
  const missing = digests.filter((entry): boolean => entry.sha256 === null);
  if (missing.length > 0) {
    context.io.err(
      `nen recorded no coverage-capture provenance for lane '${produced.lane}': the run exited 0 and did not leave ${missing.map((entry): string => `'${entry.path}'`).join(", ")} on disk.`,
    );
    return code;
  }
  const unwritten = produced.artifacts.filter((artifact, index): boolean =>
    sameState(prior[index] ?? null, reportState(repoRoot, produced.lane, artifact)),
  );
  if (unwritten.length > 0) {
    context.io.err(
      `nen recorded no coverage-capture provenance for lane '${produced.lane}': the run did not write ${unwritten.map((artifact): string => `'${artifact}'`).join(", ")}; no provenance recorded -- that report may be an earlier tree's, and an existing sidecar is left to fail on its own fingerprint.`,
    );
    return code;
  }
  const sidecar: CaptureSidecar = {
    contract: CAPTURE_CONTRACT,
    lane: produced.lane,
    verb: request.recordAs,
    head: before.head,
    startedAt,
    fingerprint: before.fingerprint,
    artifacts: digests.map((entry): { path: string; sha256: string } => ({
      path: entry.path,
      sha256: entry.sha256 as string,
    })),
  };
  const absolute = containedSidecar(repoRoot, produced.lane);
  if (typeof absolute !== "string") {
    context.io.err(`nen recorded no coverage-capture provenance for lane '${produced.lane}': ${absolute.why}`);
    return code;
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(sidecar, null, 2)}\n`);
  return code;
}
