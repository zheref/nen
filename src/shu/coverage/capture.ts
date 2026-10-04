// src/shu/coverage/capture.ts -- `nen shu coverage --touched --from-capture`:
// is a coverage capture already on disk CURRENT for this tree? (zheref/nen#250)
//
// THE QUESTION IS NEN'S, NOT THE CALLER'S. A flag that said "trust the file"
// would hand the one judgement this verb exists to make -- are these numbers
// about THIS tree? -- to whoever typed it, and a caller in a hurry answers yes.
// So `--from-capture` never reuses a capture nen has not judged current, and a
// capture it cannot judge current is REFUSED, by name, with the reason
// (../exit.ts's EXIT_COVERAGE_STALE_CAPTURE). Silently reusing it is the
// failure the issue names.
//
// WHAT "CURRENT" MEANS, AND WHY IT IS MODIFICATION TIMES. A coverage report
// records no commit: nothing in an LCOV tracefile, an Istanbul summary or an
// xccov document says which tree it measured. What nen CAN see is when the
// report was written and when every file that could make it wrong was last
// written -- and a capture is current exactly when it was written AFTER every
// one of them. The files that could make it wrong are:
//
//   * every file the touched set names (`git diff --name-only <base>...HEAD`),
//     because those are the rows the table reports; and
//   * every tracked file with an uncommitted change (`git diff --name-only
//     HEAD`), because an edit nobody committed yet still changes what the
//     tests measure, and it is not in the touched set.
//
// A file modified after the capture was written means the capture measured a
// different version of it. A checkout that moved a touched file rewrites that
// file, so its time moves too. A COMMIT DOES NOT, and that is why the HEAD the
// capture was taken at is not the test: the ordinary loop verifies the tree
// and THEN commits it, so a capture older than HEAD's commit is the normal
// case and refusing it would refuse every honest reuse.
//
// WHAT THIS CANNOT SEE, said rather than hidden: a capture copied in from
// another checkout, an untracked file (never compared -- a coverage run's own
// untracked output sits beside the report and is written after it), and a
// file changed and changed back to an older timestamp. Each is a capture
// someone went out of their way to make look current.
//
// TEXT IN, SHAPE OUT. The modification times are read by ../coverage.ts and
// handed in; this module never touches the filesystem, so the rule is tested
// without one.

/** One declared report, as nen found it on disk. `mtimeMs` null: not there. */
export interface CaptureStat {
  readonly path: string;
  readonly mtimeMs: number | null;
}

/** One file the capture must be newer than. Absent files are never listed. */
export interface WatchedFile {
  readonly path: string;
  readonly mtimeMs: number;
}

/** Why one declared report cannot be reused. */
export type CaptureProblem =
  | { readonly path: string; readonly reason: "missing" }
  | { readonly path: string; readonly reason: "stale"; readonly newer: readonly string[] };

/**
 * Every declared report that cannot be reused, in declaration order; empty
 * when all of them are current.
 *
 * ALL OF THEM OR NONE. A workspace's `--touched` table is assembled from every
 * declared report, and reusing the current ones while one is stale would
 * report a table half of which is about another tree -- with nothing in it to
 * say which half.
 *
 * EQUAL TIMES ARE CURRENT. A filesystem with coarse timestamps (one or two
 * seconds) gives an edit and the run that followed it the same time often
 * enough; the run read the file as it was, so the capture is about it.
 */
export function judgeCapture(
  captures: readonly CaptureStat[],
  watched: readonly WatchedFile[],
): readonly CaptureProblem[] {
  const problems: CaptureProblem[] = [];
  for (const capture of captures) {
    if (capture.mtimeMs === null) {
      problems.push({ path: capture.path, reason: "missing" });
      continue;
    }
    const written = capture.mtimeMs;
    const newer = watched
      .filter((file): boolean => file.mtimeMs > written)
      .map((file): string => file.path);
    if (newer.length > 0) problems.push({ path: capture.path, reason: "stale", newer });
  }
  return problems;
}

/** How many newer files the refusal names per report before it summarises. */
const NAMED = 3;

/**
 * The refusal sentence: every report that cannot be reused, and why, and the
 * one way out.
 */
export function captureRefusal(problems: readonly CaptureProblem[], checked: number): string {
  const each = problems
    .map((problem): string => {
      if (problem.reason === "missing") {
        return `'${problem.path}' is not on disk -- there is no capture to reuse`;
      }
      const named = problem.newer.slice(0, NAMED).map((path): string => `'${path}'`).join(", ");
      const more = problem.newer.length > NAMED ? ` and ${problem.newer.length - NAMED} more` : "";
      return `'${problem.path}' is STALE -- written before ${problem.newer.length} of the ${checked} file${checked === 1 ? "" : "s"} it must postdate changed: ${named}${more}`;
    })
    .join("; ");
  return `--from-capture refused: ${each}. A capture is reused only when it was written after every touched file and every uncommitted change in this tree, and nen will not report another tree's numbers as this one's. Run the same line without --from-capture (it runs the lane's coverage command and measures what that run writes), or re-run whatever produced the capture, then try again.`;
}
