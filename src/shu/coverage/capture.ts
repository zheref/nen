// src/shu/coverage/capture.ts -- `nen shu coverage --touched --from-capture`:
// is a coverage capture already on disk ABOUT THIS TREE? (zheref/nen#250)
//
// THE QUESTION IS NEN'S, NOT THE CALLER'S. A flag that said "trust the file"
// would hand the one judgement this verb exists to make -- are these numbers
// about THIS tree? -- to whoever typed it. So `--from-capture` never reuses a
// capture nen cannot PROVE current, and one it cannot is REFUSED, by name,
// with the reason (../exit.ts's EXIT_COVERAGE_STALE_CAPTURE).
//
// PROVENANCE, NOT CLOCKS. A coverage report records no commit and no tree, and
// a modification time says when bytes were written, not what they measured --
// an edit made while the suite was running, a merge that rewrote files nobody
// touched, a rename, a deletion and a skewed clock all slipped past an mtime
// rule (hanten round 1 on zheref/nen#250). So every nen run that can produce
// the lane's declared coverage reports records a SIDECAR beside them,
// `.nen/coverage-capture/<lane>.json`, carrying:
//
//   * a TREE FINGERPRINT taken at the START of the run -- sha256 over HEAD, the
//     bytes of `git diff HEAD --binary` (every staged and unstaged change to a
//     tracked file, deletions and renames included), and every untracked,
//     non-ignored file's path and content sha256;
//   * each declared report's path and content sha256, taken when the run
//     succeeded.
//
// `--from-capture` recomputes the fingerprint NOW and hashes the reports NOW,
// and reuses the capture only when every one of them is what the sidecar
// recorded. Nothing in the decision reads a clock.
//
// WHAT THE FINGERPRINT LEAVES OUT, ON PURPOSE: the declared reports themselves
// and the sidecar directory -- the run writes both, so a fingerprint that
// covered them could never match its own capture -- and ignored files, which
// is what ignoring means. Files git is told to look away from (assume-unchanged
// `h`, skip-worktree `S`) are folded in by their raw content hash, since
// `git diff` would not show their edits. What still escapes it is published,
// word for word, as CAPTURE_LIMITS below.
//
// TEXT IN, SHAPE OUT. The git reads, the file hashes and the sidecar's bytes
// are gathered by ../capture-provenance.ts and handed in; this module hashes
// and compares, and touches neither a filesystem nor a subprocess.

import { createHash } from "node:crypto";

/**
 * What the fingerprint does NOT catch -- the ONE sentence, printed identically
 * in `nen shu --help` and docs/USAGE.md (../coverage.test.ts holds the two to
 * this string), so the limits cannot drift apart between the two places a
 * reader looks.
 */
export const CAPTURE_LIMITS =
  "Not caught: a change to an IGNORED file; an edit made during the run and undone byte for byte before the reuse; the contents of a NESTED untracked repository (it counts only as present); a difference a clean filter or end-of-line normalisation hides from 'git diff'; an exec-bit change under core.fileMode=false; and two edits to a non-UTF-8 text file that differ only in bytes UTF-8 cannot decode.";

/** The sidecar's own contract name. */
export const CAPTURE_CONTRACT = "nen.shu.coverage-capture/v0.1";

/** Where the sidecars live, repo-relative, `/`-separated. */
export const CAPTURE_DIRECTORY = ".nen/coverage-capture";

/** The repo-relative sidecar path for one lane. */
export function sidecarPath(lane: string): string {
  return `${CAPTURE_DIRECTORY}/${encodeURIComponent(lane)}.json`;
}

/** One declared report and its content hash; null hash: not a file on disk. */
export interface ArtifactDigest {
  readonly path: string;
  readonly sha256: string | null;
}

/** One untracked, non-ignored file: its path and its content's hash. */
export interface UntrackedDigest {
  readonly path: string;
  readonly sha256: string;
}

/** The raw facts a fingerprint is computed from. */
export interface TreeFacts {
  readonly head: string;
  readonly diff: string;
  readonly untracked: readonly UntrackedDigest[];
  /**
   * Tracked files git is told to look away from -- assume-unchanged (`h`) and
   * skip-worktree (`S`) -- each with `git hash-object --no-filters` of its
   * working-tree bytes, or `absent`. Optional so a facts object without any
   * such file fingerprints exactly as before.
   */
  readonly hidden?: readonly UntrackedDigest[];
}

/** The sidecar, as written and as read back. */
export interface CaptureSidecar {
  readonly contract: string;
  readonly lane: string;
  /** The verb whose run produced the capture: `coverage`, `test` or `test-report`. */
  readonly verb: string;
  readonly head: string;
  /** ISO time the run started. RECORDED FOR A READER, never compared. */
  readonly startedAt: string;
  readonly fingerprint: string;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The tree fingerprint. Each field is length-prefixed so that no choice of
 * bytes in one can impersonate a boundary into the next.
 */
export function fingerprintOf(facts: TreeFacts): string {
  const hash = createHash("sha256");
  const field = (label: string, value: string): void => {
    hash.update(`${label}:${Buffer.byteLength(value, "utf8")}:`);
    hash.update(value);
  };
  field("head", facts.head);
  field("diff", facts.diff);
  const sorted = [...facts.untracked].sort((a, b): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  field("untracked", String(sorted.length));
  for (const entry of sorted) {
    field("path", entry.path);
    field("sha256", entry.sha256);
  }
  const hidden = [...(facts.hidden ?? [])].sort((a, b): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (hidden.length > 0) {
    field("hidden", String(hidden.length));
    for (const entry of hidden) {
      field("path", entry.path);
      field("object", entry.sha256);
    }
  }
  return hash.digest("hex");
}

/** Whether a path is one the fingerprint leaves out (the reports, the sidecars). */
export function excludedFromFingerprint(path: string, artifacts: readonly string[]): boolean {
  return artifacts.includes(path) || path === CAPTURE_DIRECTORY || path.startsWith(`${CAPTURE_DIRECTORY}/`);
}

/**
 * A sidecar's bytes, read back -- or a sentence saying why they are not one.
 * Every field is checked: a sidecar is evidence, and evidence nen cannot read
 * is not evidence.
 */
export function parseSidecar(text: string): CaptureSidecar | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "it is not JSON";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "it is not an object";
  const value = raw as Record<string, unknown>;
  if (value["contract"] !== CAPTURE_CONTRACT) return `its contract is not '${CAPTURE_CONTRACT}'`;
  for (const key of ["lane", "verb", "head", "startedAt", "fingerprint"]) {
    if (typeof value[key] !== "string") return `its '${key}' is not a string`;
  }
  const artifacts = value["artifacts"];
  const wellFormed = (entry: unknown): boolean => {
    if (typeof entry !== "object" || entry === null) return false;
    const fields = entry as Record<string, unknown>;
    return typeof fields["path"] === "string" && typeof fields["sha256"] === "string";
  };
  if (!Array.isArray(artifacts) || !artifacts.every(wellFormed)) {
    return "its 'artifacts' is not a list of { path, sha256 }";
  }
  return value as unknown as CaptureSidecar;
}

/** Why a capture cannot be reused. Every applicable reason is collected. */
export type CaptureProblem =
  | { readonly reason: "no-sidecar"; readonly sidecar: string }
  | { readonly reason: "unreadable-sidecar"; readonly sidecar: string; readonly why: string }
  | { readonly reason: "lane"; readonly recorded: string; readonly lane: string }
  | { readonly reason: "artifacts"; readonly recorded: readonly string[]; readonly declared: readonly string[] }
  | { readonly reason: "tree"; readonly recordedHead: string; readonly head: string }
  | { readonly reason: "artifact-missing"; readonly path: string }
  | { readonly reason: "artifact-changed"; readonly path: string };

/** What nen sees NOW, to judge a sidecar against. */
export interface CaptureNow {
  readonly lane: string;
  readonly artifacts: readonly ArtifactDigest[];
  readonly fingerprint: string;
  readonly head: string;
}

/**
 * Every reason the capture cannot be reused, empty when it can.
 *
 * ALL OF THE REPORTS OR NONE. A workspace's touched table is assembled from
 * every declared report, and reusing the sound ones while one changed would
 * report a table part of which is about another run -- with nothing in it to
 * say which part.
 */
export function judgeCapture(sidecar: CaptureSidecar, now: CaptureNow): readonly CaptureProblem[] {
  const problems: CaptureProblem[] = [];
  if (sidecar.lane !== now.lane) problems.push({ reason: "lane", recorded: sidecar.lane, lane: now.lane });
  const recorded = sidecar.artifacts.map((entry): string => entry.path);
  const declared = now.artifacts.map((entry): string => entry.path);
  if (recorded.length !== declared.length || recorded.some((path, index): boolean => path !== declared[index])) {
    problems.push({ reason: "artifacts", recorded, declared });
  }
  if (sidecar.fingerprint !== now.fingerprint) {
    problems.push({ reason: "tree", recordedHead: sidecar.head, head: now.head });
  }
  for (const artifact of now.artifacts) {
    if (artifact.sha256 === null) {
      problems.push({ reason: "artifact-missing", path: artifact.path });
      continue;
    }
    const was = sidecar.artifacts.find((entry): boolean => entry.path === artifact.path);
    if (was !== undefined && was.sha256 !== artifact.sha256) {
      problems.push({ reason: "artifact-changed", path: artifact.path });
    }
  }
  return problems;
}

function describe(problem: CaptureProblem): string {
  switch (problem.reason) {
    case "no-sidecar":
      return `there is no provenance sidecar at '${problem.sidecar}': this capture was not recorded by a nen run that produced it ('nen shu coverage', or 'nen shu test'/'test-report' on a lane whose test row declares the coverage reports), and a capture produced outside nen is refused by design`;
    case "unreadable-sidecar":
      return `the provenance sidecar '${problem.sidecar}' cannot be read: ${problem.why}`;
    case "lane":
      return `the sidecar records lane '${problem.recorded}', not '${problem.lane}'`;
    case "artifacts":
      return `the sidecar records the reports [${problem.recorded.join(", ")}] and the lane now declares [${problem.declared.join(", ")}]`;
    case "tree":
      return problem.recordedHead === problem.head
        ? `the working tree is not the one the capture's run started on: HEAD is the same (${problem.head.slice(0, 12)}), and a tracked file's content, a rename, a deletion or an untracked file differs`
        : `the working tree is not the one the capture's run started on: HEAD was ${problem.recordedHead.slice(0, 12)} and is now ${problem.head.slice(0, 12)}`;
    case "artifact-missing":
      return `the report '${problem.path}' is not on disk`;
    case "artifact-changed":
      return `the report '${problem.path}' is not the file the run recorded (its sha256 differs)`;
  }
}

/** The refusal sentence: every reason, and the one way out. */
export function captureRefusal(problems: readonly CaptureProblem[]): string {
  return `--from-capture refused: ${problems.map(describe).join("; ")}. nen reuses a capture only when its provenance proves it measured this exact tree, and it will not report another tree's numbers as this one's. Run the same line without --from-capture (it runs the lane's coverage command, measures what that run writes, and records a fresh sidecar), then try again.`;
}
