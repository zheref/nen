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

import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandContext } from "../cli/command.js";
import { GIT, type Seams } from "../seam/exec.js";
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
  | { readonly ok: false; readonly why: string };

/**
 * sha256 over HEAD, `git diff HEAD --binary`, and every untracked non-ignored
 * file's path and content -- the declared reports and the sidecar directory
 * left out of all three (./coverage/capture.ts says why).
 *
 * THE DIFF IS PINNED against the user's own configuration: no colour, no
 * external diff driver, no textconv filter -- each of those would make the
 * same tree print different bytes on two machines, or on one machine twice.
 */
export function takeFingerprint(seams: Seams, repoRoot: string, artifacts: readonly string[]): Fingerprint {
  const head = seams.run(GIT, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: repoRoot });
  if (head.spawnFailed || head.code !== 0) {
    return { ok: false, why: "HEAD does not name a commit here (not a git work tree, or no commit yet)" };
  }
  const exclude = [...artifacts, CAPTURE_DIRECTORY].map((path): string => `:(exclude,literal)${path}`);
  const diff = seams.run(
    GIT,
    [...RAW_PATHS, "diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--", ".", ...exclude],
    { cwd: repoRoot },
  );
  if (diff.spawnFailed || diff.code !== 0) {
    return { ok: false, why: `'git diff HEAD --binary' exited ${diff.code}: ${diff.stderr.trim()}` };
  }
  const listed = seams.run(GIT, [...RAW_PATHS, "ls-files", "-z", "--others", "--exclude-standard"], {
    cwd: repoRoot,
  });
  if (listed.spawnFailed || listed.code !== 0) {
    return { ok: false, why: `'git ls-files --others' exited ${listed.code}: ${listed.stderr.trim()}` };
  }
  const untracked: UntrackedDigest[] = nulPaths(listed.stdout)
    .filter((path): boolean => !excludedFromFingerprint(path, artifacts))
    .map((path): UntrackedDigest => ({ path, sha256: contentDigest(join(repoRoot, path)) }));
  const headSha = head.stdout.trim();
  return { ok: true, head: headSha, fingerprint: fingerprintOf({ head: headSha, diff: diff.stdout, untracked }) };
}

/**
 * One untracked entry's content hash. A symlink is its TARGET string (git
 * stores a link that way, and following it could leave the tree); a
 * directory (a nested repository, listed as `dir/`) and anything unreadable
 * get a marker, so they still count without nen guessing at their content.
 */
function contentDigest(absolute: string): string {
  try {
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) return `link:${sha256(readlinkSync(absolute))}`;
    if (stats.isDirectory()) return "directory";
    return sha256(readFileSync(absolute));
  } catch (error) {
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

/** Each declared report's content hash, in declaration order; null: not a file. */
export function digestArtifacts(repoRoot: string, lane: string, artifacts: readonly string[]): readonly ArtifactDigest[] {
  return artifacts.map((path): ArtifactDigest => {
    const absolute = insideRepo(repoRoot, path, `project.verbs.${lane}.coverage.artifacts`);
    try {
      const stats = lstatSync(absolute);
      return { path, sha256: stats.isFile() ? sha256(readFileSync(absolute)) : null };
    } catch {
      return { path, sha256: null };
    }
  });
}

/** The lane's sidecar: read, absent, or unreadable with a reason. */
export type SidecarRead =
  | { readonly state: "present"; readonly sidecar: CaptureSidecar }
  | { readonly state: "missing" }
  | { readonly state: "unreadable"; readonly why: string };

export function readCaptureSidecar(repoRoot: string, lane: string): SidecarRead {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, sidecarPath(lane)), "utf8");
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
  const absolute = join(repoRoot, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(sidecar, null, 2)}\n`);
  return code;
}
