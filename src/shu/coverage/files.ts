// src/shu/coverage/files.ts -- a report's per-SOURCE-FILE view, resolved
// against the tree and made into one row per touched-matchable file. Pure: the
// one filesystem question it asks ("is this repo-relative path a file, and how
// is it spelled on disk?") is a function it is HANDED, exactly as ./roots.ts's
// is.
//
// WHY THIS EXISTS -- zheref/nen#296. A Cobertura report's rows are packages,
// so `nen shu coverage --touched` matched each touched C# file to its PACKAGE
// and reported the package's number for all of them: four changed files in one
// package became one row whose figure was neither any file's coverage nor
// their average, and a per-file floor could not be read off it. The report
// already says which file every `<class>` came from; ./formats/cobertura.ts
// collects that into ./shape.ts's `SourceFiles`, and this module turns it into
// what `--touched` compares against git's own file list: repo-relative FILE
// rows, under the spelling the file has on disk.
//
// THREE STEPS, IN THIS ORDER, AND WHY THE ORDER MATTERS:
//
//   1. RESOLVE each name the report states to ONE file that exists
//      (./roots.ts's `resolveFileName`: the report's own `<source>` roots
//      first, then the artifact / lane-cwd / repo-root candidates every
//      file-grain report is resolved against). A name that is AMBIGUOUS --
//      present under two different stated roots -- or that exists nowhere is
//      UNRESOLVED: it is never matched, it is listed with its reason, and its
//      touched file stays `unmatched` -- never credited to whichever file or
//      package happened to be found first, which is precisely the answer #296
//      says was wrong.
//   2. MERGE names that resolved to the SAME file -- `Core/A.cs` under one
//      stated root and `A.cs` under another, or `core/a.cs` and `Core/A.cs` on
//      a case-insensitive filesystem -- by the same UNION the parser already
//      applied within one name (./shape.ts's `unionLine` says what it is and
//      why a sum would double-count).
//   3. MEASURE each file from its merged lines, once, at the end. Measuring
//      before merging would leave two rows for one file, or a sum of two
//      figures that each counted the shared lines.
//
// WHY THE PARSER'S VIEW IS KEYED BY FILE NAME ALONE, not by (package, name).
// Resolution depends only on the name, so two entries with one name resolve
// identically whichever package they sat in; and the one writer whose names
// genuinely collide -- coverage.py, one `<source>` per measured package --
// puts every top-level file in package `.`, so a package key would not tell
// its `utils.py`s apart either.
//
// MERGING BY NAME BEFORE RESOLVING IS SAFE ONLY WHEN EVERY STATED ROOT CAN BE
// CHECKED (corrected in review round 3; an earlier version of this paragraph
// claimed it always was). Two entries named `utils.py` are one file only if
// they sit under one root, and nen can only find out by looking in each root
// the report states. So ./roots.ts's `resolveFileName` looks in EVERY one --
// a root outside the repository that exists on this machine (coverage.py's
// site-packages) is looked in too, and a file there is a distinct answer --
// and refuses the name when two roots hold two files (ambiguous), when the
// only file is outside the repository, or when a root cannot be checked here
// at all while the name was merged from several entries in a report stating
// several roots (unverifiable: the union may already be two files' lines).
//
// WHAT IT HANDS BACK is one `TouchedGroup` at FILE grain and one
// `TouchedArtifact` account, the same two things ../coverage.ts assembles for
// every other file-grain report -- so `filterTouchedGroups`, the bands, the
// exit-6 rule and the `from:` line all apply to these rows unchanged.

import type { TouchedArtifact, UnresolvedName } from "./report.js";
import {
  anchorUnderAny,
  isAbsoluteName,
  resolveFileName,
  rootCandidates,
  type PathProbe,
  type RootBasis,
  type RootCandidate,
} from "./roots.js";
import {
  CoverageReportError,
  measureLines,
  unionLines,
  type CoverageTarget,
  type LineFact,
  type SourceFiles,
} from "./shape.js";
import type { TouchedGroup } from "./touched.js";

/** What resolving a per-file view needs to know about where the report came from. */
export interface FileJoinContext {
  /**
   * Every spelling of the repository root, absolute: as nen was given it, and
   * as the filesystem resolves it (a symlinked checkout, `/tmp` ->
   * `/private/tmp`). An absolute `<source>` is anchored under whichever one
   * it was written against.
   */
  readonly repoRoots: readonly string[];
  /** The artifact's path, repo-relative, as the declaration wrote it. */
  readonly artifactPath: string;
  /** The report's format id, for the account. */
  readonly format: string;
  /** The lane's `cwd`, repo-relative and `/`-separated (`""` at the root). */
  readonly laneCwd: string;
  /**
   * "Is this repo-relative path a FILE in the working tree -- and if so, how
   * is it spelled on disk?" Null when it is not a file. On a case-insensitive
   * filesystem the answer can differ from the question in letter case, and
   * the answer is the spelling git names the file by.
   */
  readonly locate: (repoRelative: string) => string | null;
  /** What an absolute path OUTSIDE the repository is on this machine (./roots.ts's `PathProbe`). */
  readonly probe: PathProbe;
}

export interface FileJoin {
  /** The file rows to match, or null when the view could not be measured (see `artifact.error`). */
  readonly group: TouchedGroup | null;
  readonly artifact: TouchedArtifact;
}

/**
 * One report's per-file view, resolved and measured.
 *
 * `artifact.rows` is how many distinct file names the report states;
 * `artifact.onDisk` how many of them resolved to one file here; the rest are
 * `artifact.unresolved`, each with its reason. `artifact.root` and `basis` are
 * the root MOST of its files resolved under (a tie goes to the one reached
 * first) -- a per-file view can resolve different names under different
 * stated roots, and the account names the dominant one rather than inventing a
 * single root the report never had. With nothing resolved they are the first
 * place nen looked.
 *
 * A LINE THAT STATES MORE CONDITIONS COVERED THAN IT HAS is the one refusal
 * here: it is returned as `artifact.error` with the path in it, and the run
 * becomes exit 1 exactly as an unreadable report does -- never a clamp, never
 * outvoted by a neighbouring figure, never the package row instead.
 */
export function joinSourceFiles(view: SourceFiles, context: FileJoinContext): FileJoin {
  const candidates = rootCandidates(context.artifactPath, context.laneCwd);
  const merged = new Map<string, Map<number, LineFact>>();
  const unresolved: UnresolvedName[] = [];
  const byRoot = new Map<string, { readonly root: string; readonly basis: RootBasis; count: number }>();
  let onDisk = 0;
  for (const file of view.files) {
    const resolution = resolveFileName(file.name, file.entries, {
      statedRoots: view.roots,
      repoRoots: context.repoRoots,
      candidates,
      locate: context.locate,
      probe: context.probe,
    });
    if (resolution.kind === "unresolved") {
      unresolved.push({ name: file.name, reason: resolution.reason });
      continue;
    }
    const resolved = resolution.candidate;
    onDisk += 1;
    const lines = merged.get(resolved.path) ?? new Map<number, LineFact>();
    unionLines(lines, file.lines);
    merged.set(resolved.path, lines);
    const key = `${resolved.basis}\u0000${resolved.root}`;
    const entry = byRoot.get(key) ?? { root: resolved.root, basis: resolved.basis, count: 0 };
    entry.count += 1;
    byRoot.set(key, entry);
  }

  let rows: CoverageTarget[];
  try {
    rows = [...merged.entries()]
      .map(([name, lines]): CoverageTarget => measureLines(name, lines))
      .sort((left, right): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch (error) {
    if (!(error instanceof CoverageReportError)) throw error;
    return {
      group: null,
      artifact: {
        path: context.artifactPath,
        format: context.format,
        root: null,
        basis: null,
        rows: 0,
        onDisk: null,
        error: `${context.artifactPath}: ${error.message}`,
        // Still a per-file view's entry, so it still carries the key -- the
        // names that could not be placed before the measurement refused.
        unresolved,
      },
    };
  }

  const dominant = dominantRoot(byRoot, view, context, candidates);
  return {
    group: { rows, grain: "file" },
    artifact: {
      path: context.artifactPath,
      format: context.format,
      root: dominant.root === "" ? "." : dominant.root,
      basis: dominant.basis,
      rows: view.files.length,
      onDisk,
      error: null,
      unresolved,
    },
  };
}

/**
 * The root most names resolved under, a tie going to the one reached first.
 *
 * WITH NOTHING RESOLVED the account still names where nen looked first -- the
 * first `<source>` inside the repository, else the first of the usual
 * candidates -- so the `from:` line reads "root X [basis], 0 on disk" rather
 * than a blank. Only an ABSOLUTE stated root names one directory on its own;
 * a relative one is relative to something the report does not say.
 */
function dominantRoot(
  byRoot: ReadonlyMap<string, { readonly root: string; readonly basis: RootBasis; readonly count: number }>,
  view: SourceFiles,
  context: FileJoinContext,
  candidates: readonly RootCandidate[],
): { readonly root: string; readonly basis: RootBasis } {
  let best: { readonly root: string; readonly basis: RootBasis; readonly count: number } | null = null;
  for (const entry of byRoot.values()) {
    if (best === null || entry.count > best.count) best = entry;
  }
  if (best !== null) return best;
  for (const stated of view.roots) {
    const anchored = isAbsoluteName(stated) ? anchorUnderAny(context.repoRoots, stated) : null;
    if (anchored !== null) return { root: anchored, basis: "source" };
  }
  /* c8 ignore next -- rootCandidates always returns at least the repo root */
  return candidates[0] ?? { root: "", basis: "repo-root" };
}
