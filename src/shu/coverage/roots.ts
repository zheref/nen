// src/shu/coverage/roots.ts -- which directory a coverage report's own row
// names are relative to, and the rewrite that makes them repo-relative. Pure:
// the one filesystem question it asks ("is this repo-relative path a file?")
// is a function it is HANDED, so this directory stays text-in-shape-out
// (../../profiles/inertness.test.ts's rule for it).
//
// WHY THIS EXISTS -- zheref/nen#236. A workspace monorepo runs its coverage
// tool once per member, and each member's tool writes its LCOV `SF:` lines
// relative to THAT MEMBER (`SF:src/domain/endeavor/Defer.ts` inside
// `packages/core/coverage/lcov.info`), while `git diff --name-only` names the
// same file relative to the REPOSITORY (`packages/core/src/domain/endeavor/
// Defer.ts`). Joined as-is, the two never meet: 0 of 58 touched files matched
// on the repository that reported it, at exit 0. The report is not wrong and
// neither is git; the join was missing the root each report was written from.
//
// HOW THE ROOT IS INFERRED, AND WHY THIS RULE. A report does not state its own
// root -- LCOV has no header for it, and Istanbul's summary keys are whatever
// the reporter was configured to write -- so nen proposes a small, ordered set
// of candidates and lets the TREE decide among them:
//
//   1. `artifact` -- the artifact's own directory with ONE trailing `coverage`
//      segment removed (`packages/core/coverage/lcov.info` -> `packages/core`).
//      `coverage/` is the directory every JS/TS coverage tool in the reference
//      pack writes into by default, under the package it ran in, so its parent
//      is the likeliest place the run was rooted. Proposed ONLY when that
//      segment is there: an artifact at `build/reports/lcov.info` says nothing
//      about where its run started, and guessing `build/reports` would be a
//      root nobody's tool uses.
//   2. `lane-cwd` -- the lane's declared `cwd`, which is where nen ran the
//      tool. The right answer for a single-package lane rooted in a
//      subdirectory, whatever its report is called.
//   3. `repo-root` -- the repository itself, which is where every row already
//      was before this module existed. Keeping it as a candidate is what makes
//      a single-package repository (lane cwd == artifact root == repo root)
//      reach EXACTLY the answer it always had.
//
// Each candidate is scored by how many of the report's relative row names name
// a file that EXISTS under it, and the highest score wins; a tie goes to the
// earlier candidate in the list above. Existence is the only evidence on disk
// that says "this is the directory these names were written from", and it is
// asked of the working tree the run just measured -- so a report whose files
// are all there picks the root that finds them, and a report whose files are
// NOT there (a fixture, a deleted tree) falls back to the order above rather
// than to a coin toss. The root is chosen ONCE PER ARTIFACT, never per row:
// one tool run has one root, and a per-row choice could join two rows of one
// report against two different directories and call both correct.
//
// WHAT IS NEVER REBASED. An ABSOLUTE row name is already anchored, and
// ../../coverage.ts's `relativiseName` makes it repo-relative (or leaves it,
// if it lies outside the tree) exactly as it always has. A relative name that
// would climb out of the repository once joined (`../../elsewhere.ts`) is left
// exactly as the report wrote it, for the same reason an outside-the-tree
// absolute name is: it is a fact about the run, not a path to invent. And a
// PACKAGE-grain report (jacoco; cobertura only when it names no file) is not
// rebased at all -- its rows are package names, not paths, and
// `touchedByPackage` already matches them anywhere inside a touched path.
//
// A REPORT THAT STATES ITS OWN ROOTS IS RESOLVED PER FILE, NOT ONCE
// (zheref/nen#296). Cobertura names each file relative to one of the
// directories its `<sources><source>` list states -- coverage.py writes one
// per measured package, so a report can have several -- and never says which.
// So `resolveFileName` below asks, for EACH name, every stated root first (the
// report's own statement is the best evidence there is): exactly one of them
// holding the file resolves it, and TWO holding two different files make it
// AMBIGUOUS -- the report cannot say which one its lines measured. Only when
// no stated root has it are the three candidates above tried, in order. One
// run still has one set of roots; what varies per name is which of the
// report's own stated roots it was written under, which is the report's fact
// rather than nen's guess. A name that is ambiguous, or exists nowhere, is
// UNRESOLVED -- ./files.ts keeps it out of matching altogether and says why,
// because a touched file credited through a guessed join is the silent miss
// #296 is.

import { posix } from "node:path";
import type { CoverageTarget } from "./shape.js";

/**
 * Which candidate a root came from -- carried into `--json` so the join is
 * auditable. `source` is a root the REPORT stated (Cobertura's `<source>`),
 * which only a per-file view (./files.ts) has.
 */
export type RootBasis = "source" | "artifact" | "lane-cwd" | "repo-root";

export interface RootCandidate {
  /** Repo-relative, `/`-separated; `""` is the repository root itself. */
  readonly root: string;
  readonly basis: RootBasis;
}

export interface ResolvedRoot extends RootCandidate {
  /** How many of the report's relative row names name a file under `root`. */
  readonly onDisk: number;
  /** How many relative row names there were to test -- the denominator. */
  readonly relative: number;
}

function toSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/** A row name that is anchored already: POSIX-absolute, a drive letter, or a UNC path. */
export function isAbsoluteName(name: string): boolean {
  const slashed = toSlashes(name);
  return slashed.startsWith("/") || /^[A-Za-z]:\//.test(slashed);
}

/** `a/b/` -> `a/b`, `.` -> `` -- the one spelling of a repo-relative directory. */
function normaliseDir(value: string): string {
  const normal = posix.normalize(toSlashes(value));
  const trimmed = normal.endsWith("/") ? normal.slice(0, -1) : normal;
  return trimmed === "." ? "" : trimmed;
}

/**
 * The candidate roots for one artifact, in preference order, deduplicated.
 *
 * `artifactPath` and `laneCwd` are both REPO-RELATIVE. A duplicate keeps its
 * EARLIER basis, so a single-package repository reports `artifact` for the
 * root `coverage/lcov.info` implies -- which is also the lane cwd and the repo
 * root -- rather than a basis that depends on which spelling came last.
 */
export function rootCandidates(artifactPath: string, laneCwd: string): readonly RootCandidate[] {
  const candidates: RootCandidate[] = [];
  const directory = posix.dirname(toSlashes(artifactPath));
  const segments = normaliseDir(directory).split("/").filter((part): boolean => part !== "");
  if (segments[segments.length - 1] === "coverage") {
    candidates.push({ root: segments.slice(0, -1).join("/"), basis: "artifact" });
  }
  candidates.push({ root: normaliseDir(laneCwd), basis: "lane-cwd" });
  candidates.push({ root: "", basis: "repo-root" });
  const seen = new Set<string>();
  return candidates.filter((candidate): boolean => {
    if (seen.has(candidate.root)) return false;
    seen.add(candidate.root);
    return true;
  });
}

/**
 * `root` + `name`, repo-relative and `/`-separated -- or null when the join
 * would leave the repository (a `..` that climbs past the root).
 */
export function joinUnder(root: string, name: string): string | null {
  const joined = posix.normalize(root === "" ? toSlashes(name) : `${root}/${toSlashes(name)}`);
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return null;
  return joined;
}

/**
 * Pick one root for one report, by how many of its rows exist under each
 * candidate. Ties -- including the all-zero tie of a tree with none of the
 * files on it -- go to the EARLIER candidate.
 */
export function resolveRoot(
  rows: readonly CoverageTarget[],
  candidates: readonly RootCandidate[],
  exists: (repoRelative: string) => boolean,
): ResolvedRoot {
  const relative = rows.filter((row): boolean => !isAbsoluteName(row.name));
  /* c8 ignore next -- rootCandidates always returns at least the repo root */
  const first = candidates[0] ?? { root: "", basis: "repo-root" as const };
  let best: ResolvedRoot = { ...first, onDisk: -1, relative: relative.length };
  for (const candidate of candidates) {
    let onDisk = 0;
    for (const row of relative) {
      const joined = joinUnder(candidate.root, row.name);
      if (joined !== null && exists(joined)) onDisk += 1;
    }
    if (onDisk > best.onDisk) best = { ...candidate, onDisk, relative: relative.length };
  }
  return best;
}

/**
 * Every RELATIVE row name rewritten to be repo-relative under `root`.
 *
 * Absolute names are returned untouched -- the caller's `relativiseName` owns
 * those -- and so is a relative name whose join would leave the repository.
 */
export function rebaseRows(rows: readonly CoverageTarget[], root: string): readonly CoverageTarget[] {
  return rows.map((row): CoverageTarget => rebaseOne(row, root));
}

function rebaseOne(row: CoverageTarget, root: string): CoverageTarget {
  if (isAbsoluteName(row.name)) return row;
  const joined = joinUnder(root, row.name);
  // AT THE REPOSITORY ROOT THE NAME IS KEPT BYTE-FOR-BYTE, not normalised: a
  // single-package repository's rows print exactly as they did before this
  // module existed (zheref/nen#236 acceptance 6), backslashes and all.
  if (joined === null || root === "") return row;
  return joined === row.name ? row : { ...row, name: joined };
}

/**
 * An ABSOLUTE path as a repo-relative one (`""` for the repository root
 * itself), or null when it does not lie inside `repoRoot`.
 *
 * BOTH SEPARATORS, ALWAYS. coverlet on Windows writes `C:\work\My Repo\` as a
 * `<source>`, and git hands nen the same directory as `C:/work/My Repo`.
 *
 * CASE-INSENSITIVE ON A WINDOWS-SHAPED ROOT (a drive letter or a UNC share),
 * AND EXACT EVERYWHERE ELSE. A Windows path names the same directory whatever
 * its letter case -- `C:\Work\repo` and `c:\work\repo` are one place, and one
 * tool writing it one way while git or the shell writes it the other is
 * ordinary there -- while a POSIX root is compared exactly, as
 * ../../coverage.ts's `relativiseName` does. The remainder after the root is
 * returned as the report spelled it; `locate` (./files.ts's context) is what
 * turns it into the spelling on disk.
 *
 * ONE SPELLING OF THE ROOT PER CALL. A repository reached through a symlink
 * (`/tmp` -> `/private/tmp`, a symlinked checkout) has two, and a tool that
 * ran inside it wrote whichever `getcwd` returned; `anchorUnderAny` below
 * tries each spelling the caller knows.
 *
 * A `..` that climbs back out of the repository is outside it, not a path to
 * trim: `/repo/../elsewhere` is null.
 */
export function anchorUnder(repoRoot: string, absolute: string): string | null {
  const root = toSlashes(repoRoot);
  const path = toSlashes(absolute);
  if (root === "") return null;
  const fold = win32Shaped(root)
    ? (value: string): string => value.toLowerCase()
    : (value: string): string => value;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (fold(path) === fold(root) || fold(path) === fold(prefix)) return "";
  // Compared on the ORIGINAL's leading slice, so a case fold that changes a
  // string's length can never shift where the remainder starts.
  if (path.length <= prefix.length || fold(path.slice(0, prefix.length)) !== fold(prefix)) return null;
  const relative = normaliseDir(path.slice(prefix.length));
  if (relative === ".." || relative.startsWith("../")) return null;
  return relative;
}

/** `anchorUnder` against every spelling of the repository root, first answer wins. */
export function anchorUnderAny(repoRoots: readonly string[], absolute: string): string | null {
  for (const root of repoRoots) {
    const anchored = anchorUnder(root, absolute);
    if (anchored !== null) return anchored;
  }
  return null;
}

/** A drive-letter or UNC root: `C:/...`, `//server/share/...`. */
function win32Shaped(slashed: string): boolean {
  return /^[A-Za-z]:\//.test(slashed) || slashed.startsWith("//");
}

/** One place a report's file name could be: the repo-relative path, and where that guess came from. */
export interface NameCandidate {
  /** Repo-relative, `/`-separated -- the path that is checked on disk. */
  readonly path: string;
  /** The repo-relative directory the name was joined under (`""` for the repository root). */
  readonly root: string;
  readonly basis: RootBasis;
}

/**
 * Where one file name could be, grouped the way resolution needs them:
 * `stated[i]` is every candidate the report's `i`-th `<source>` offers, in
 * preference order, and `usual` is the artifact / lane-cwd / repo-root list.
 * A path already offered earlier is not offered again (the earlier basis is
 * kept), so no two groups share a path.
 *
 *   - An ABSOLUTE stated root counts only if it lies inside the repository
 *     under one of `repoRoots` -- a CI runner's `/home/runner/work/...` names
 *     no directory here, and joining under it would invent one. A RELATIVE
 *     stated root is tried under each usual candidate in turn, because the
 *     report does not say what it is relative to.
 *   - An ABSOLUTE name has exactly one candidate -- itself, anchored -- and no
 *     stated roots; a join that would climb out of the repository is not a
 *     candidate at all.
 */
export interface NameCandidates {
  readonly stated: readonly (readonly NameCandidate[])[];
  readonly usual: readonly NameCandidate[];
}

export function nameCandidates(
  name: string,
  statedRoots: readonly string[],
  repoRoots: readonly string[],
  candidates: readonly RootCandidate[],
): NameCandidates {
  if (isAbsoluteName(name)) {
    const anchored = anchorUnderAny(repoRoots, name);
    return {
      stated: [],
      usual: anchored === null || anchored === "" ? [] : [{ path: anchored, root: "", basis: "repo-root" }],
    };
  }
  const seen = new Set<string>();
  const offer = (into: NameCandidate[], root: string, basis: RootBasis): void => {
    const path = joinUnder(root, name);
    if (path === null || path === "." || seen.has(path)) return;
    seen.add(path);
    into.push({ path, root, basis });
  };
  const stated = statedRoots.map((statedRoot): readonly NameCandidate[] => {
    const group: NameCandidate[] = [];
    if (isAbsoluteName(statedRoot)) {
      const root = anchorUnderAny(repoRoots, statedRoot);
      if (root !== null) offer(group, root, "source");
      return group;
    }
    for (const candidate of candidates) {
      const root = joinUnder(candidate.root, statedRoot);
      if (root !== null) offer(group, normaliseDir(root), "source");
    }
    return group;
  });
  const usual: NameCandidate[] = [];
  for (const candidate of candidates) offer(usual, candidate.root, candidate.basis);
  return { stated, usual };
}

/** How one file name resolved: to one file, or not -- with the reason. */
export type NameResolution =
  | { readonly kind: "resolved"; readonly candidate: NameCandidate }
  | { readonly kind: "unresolved"; readonly reason: string };

/** `https://...`, `file://...` -- a source-link URL, never a path in any tree. */
const URL_NAME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * What the machine says about one ABSOLUTE path OUTSIDE the repository --
 * whether it is a file or a directory, and its real path -- or null when it is
 * neither, is not there, or is not an absolute path on THIS platform. Handed
 * in, like `locate`, so this module stays text-in-shape-out.
 */
export type PathProbe = (absolute: string) => { readonly kind: "file" | "directory"; readonly real: string } | null;

/** Everything `resolveFileName` needs besides the name itself. */
export interface NameContext {
  /** The report's own `<source>` roots, as written. */
  readonly statedRoots: readonly string[];
  /** Every spelling of the repository root (./files.ts's `FileJoinContext`). */
  readonly repoRoots: readonly string[];
  /** The artifact / lane-cwd / repo-root candidates. */
  readonly candidates: readonly RootCandidate[];
  /** A repo-relative path's on-disk spelling, or null when it is not a file. */
  readonly locate: (repoRelative: string) => string | null;
  /** What an absolute path outside the repository is on this machine. */
  readonly probe: PathProbe;
}

/** One stated root's answer for one name. */
type StatedAnswer =
  | { readonly kind: "inside"; readonly candidate: NameCandidate }
  | { readonly kind: "outside"; readonly path: string; readonly real: string }
  | { readonly kind: "none" }
  | { readonly kind: "unchecked"; readonly root: string };

/**
 * Resolve one file name to ONE file in the tree, or say why it cannot be.
 *
 * `entries` is how many report entries were merged under this name before
 * resolution (./shape.ts's `SourceFile.entries`).
 *
 * THE RULE, IN ORDER:
 *
 *   1. A URL (a source-link report) is no path at all: unresolved. An
 *      absolute NAME outside the repository is unresolved too.
 *   2. Every STATED root answers for itself -- a file INSIDE the repository
 *      (under its on-disk spelling), a file OUTSIDE it, no file, or "cannot
 *      be checked on this machine":
 *        - a root inside the repository (relative, or absolute under one of
 *          `repoRoots`) is looked in with `locate`;
 *        - an absolute root OUTSIDE the repository that exists here as a
 *          directory is looked in with `probe` -- coverage.py states a
 *          package installed into site-packages exactly like one in the
 *          checkout -- and a file found there whose REAL path is inside the
 *          repository (a symlinked root) is an inside answer after all;
 *        - an absolute root that is not a directory here (a CI runner's path
 *          read on a laptop, another drive) CANNOT BE CHECKED.
 *      TWO OR MORE DISTINCT FILES answering is AMBIGUOUS, and ambiguous is
 *      UNRESOLVED, naming them -- never the first. Two answers that are one
 *      file on disk are one answer.
 *   3. UNVERIFIABLE: when some stated root cannot be checked, the report
 *      states two or more roots, and this name was MERGED from two or more
 *      entries, nen cannot tell whether those entries measured one file or
 *      several -- the unchecked root may hold another file of the same name,
 *      and the lines are already unioned. Unresolved. (A name from ONE entry
 *      measured one file, and a report stating ONE root puts every entry under
 *      it, so both of those still resolve below.)
 *   4. One inside answer resolves the name. One OUTSIDE answer means the lines
 *      measured a file this repository does not hold: unresolved, naming it
 *      -- never credited to a same-named file inside.
 *   5. Only when no stated root answered: the usual candidates, first that
 *      exists -- the preference order every file-grain report is resolved in
 *      (./roots.ts's header).
 *   6. Nothing: unresolved, naming where nen looked.
 *
 * Reasons never carry the REPOSITORY's absolute path. A path outside it is
 * quoted as the report stated it -- the same rule ../coverage.ts's
 * `relativiseName` keeps for a row outside the tree: it is a fact about the
 * run, and the report already carries it.
 */
export function resolveFileName(name: string, entries: number, context: NameContext): NameResolution {
  if (URL_NAME.test(name)) {
    return {
      kind: "unresolved",
      reason:
        "is a URL, not a path -- a report that writes source-link URLs names no file in any working tree",
    };
  }
  if (isAbsoluteName(name) && anchorUnderAny(context.repoRoots, name) === null) {
    return { kind: "unresolved", reason: "is an absolute path outside this repository" };
  }
  const offered = nameCandidates(name, context.statedRoots, context.repoRoots, context.candidates);
  const stated = isAbsoluteName(name)
    ? []
    : context.statedRoots.map((root, index): StatedAnswer => statedAnswer(name, root, offered.stated[index] ?? [], context));

  const answers: (Extract<StatedAnswer, { kind: "inside" }> | Extract<StatedAnswer, { kind: "outside" }>)[] = [];
  for (const answer of stated) {
    if (answer.kind !== "inside" && answer.kind !== "outside") continue;
    const key = answer.kind === "inside" ? `inside:${answer.candidate.path}` : `outside:${answer.real}`;
    if (answers.some((seen): boolean => (seen.kind === "inside" ? `inside:${seen.candidate.path}` : `outside:${seen.real}`) === key)) {
      continue;
    }
    answers.push(answer);
  }
  if (answers.length >= 2) {
    const paths = answers.map((answer): string => `'${answer.kind === "inside" ? answer.candidate.path : answer.path}'`);
    return {
      kind: "unresolved",
      reason: `is ambiguous: it exists as ${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1] ?? ""}, under different roots the report states, and nothing in the report says which of them these lines measured`,
    };
  }
  const unchecked = stated.find((answer): boolean => answer.kind === "unchecked");
  if (unchecked !== undefined && unchecked.kind === "unchecked" && entries >= 2 && context.statedRoots.length >= 2) {
    return {
      kind: "unresolved",
      reason: `cannot be verified: the report names it in ${entries} entries and states ${context.statedRoots.length} roots, and '${unchecked.root}' is not a directory on this machine, so nen cannot tell whether those entries measured one file or several`,
    };
  }
  const [only] = answers;
  if (only !== undefined) {
    return only.kind === "inside"
      ? { kind: "resolved", candidate: only.candidate }
      : {
          kind: "unresolved",
          reason: `exists only outside this repository, at '${only.path}' -- the file these lines measured is not one this repository holds`,
        };
  }
  for (const candidate of offered.usual) {
    const onDisk = context.locate(candidate.path);
    if (onDisk !== null) return { kind: "resolved", candidate: { ...candidate, path: onDisk } };
  }
  const tried = [...offered.stated.flat(), ...offered.usual].map((candidate): string => `'${candidate.path}'`);
  return {
    kind: "unresolved",
    reason:
      tried.length === 0
        ? "names no path inside this repository"
        : `names no file in this tree (looked for ${tried.slice(0, 3).join(", ")}${tried.length > 3 ? ` and ${tried.length - 3} more` : ""})`,
  };
}

/** One stated root's answer for `name`: see `resolveFileName`'s step 2. */
function statedAnswer(
  name: string,
  root: string,
  inside: readonly NameCandidate[],
  context: NameContext,
): StatedAnswer {
  // Inside the repository (relative, or absolute under one of its
  // spellings): the candidates `nameCandidates` already offered for it.
  if (!isAbsoluteName(root) || anchorUnderAny(context.repoRoots, root) !== null) {
    return firstLocated(inside, context) ?? { kind: "none" };
  }
  const directory = context.probe(root);
  if (directory?.kind !== "directory") return { kind: "unchecked", root };
  // An outside spelling whose REAL path is inside (a symlinked root).
  const realRoot = anchorUnderAny(context.repoRoots, directory.real);
  if (realRoot !== null) {
    const path = joinUnder(realRoot, name);
    return path === null ? { kind: "none" } : (firstLocated([{ path, root: realRoot, basis: "source" }], context) ?? { kind: "none" });
  }
  const outsidePath = posix.normalize(`${toSlashes(root).replace(/\/+$/, "")}/${toSlashes(name)}`);
  const file = context.probe(outsidePath);
  if (file?.kind !== "file") return { kind: "none" };
  const realInside = anchorUnderAny(context.repoRoots, file.real);
  if (realInside !== null) {
    return firstLocated([{ path: realInside, root: normaliseDir(posix.dirname(realInside)), basis: "source" }], context) ?? { kind: "none" };
  }
  return { kind: "outside", path: outsidePath, real: toSlashes(file.real) };
}

/** The first candidate `locate` finds, under its on-disk spelling, as an inside answer. */
function firstLocated(
  candidates: readonly NameCandidate[],
  context: NameContext,
): Extract<StatedAnswer, { kind: "inside" }> | null {
  for (const candidate of candidates) {
    const onDisk = context.locate(candidate.path);
    if (onDisk !== null) return { kind: "inside", candidate: { ...candidate, path: onDisk } };
  }
  return null;
}
