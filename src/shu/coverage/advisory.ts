// src/shu/coverage/advisory.ts -- the sentence a coverage refusal quotes about
// where a stack's tooling conventionally writes its report. Pure: no seam, no
// pack, no filesystem.
//
// WHY THE SENTENCE LIVES HERE AND THE DATA DOES NOT. ../coverage-defaults.ts
// reads the reference pack; this module only knows the SHAPE of what it read
// and how to write it into a refusal. Splitting them is what lets
// ../coverage.ts -- which reaches the subprocess seam through ../run.ts -- print
// the sentence without acquiring an import path to the catalogue: it takes the
// map as a VALUE from ../command.ts, the join, and formats it with this.
//
// ../../profiles/inertness.test.ts is what makes that a property of the program
// rather than a paragraph in a header: everything under `src/shu/coverage/`
// reaches neither the pack nor the seam, at any depth, and a module that can
// spawn may not reach the pack, at any depth either.

/** What the pack records about one stack's report location. Advisory. */
export interface CoverageAdvisory {
  /** The conventional location, or null when the stack has none. */
  readonly path: string | null;
  /** The pack's own reason. Quoted verbatim; never nen's words about a stack. */
  readonly why: string;
  /** Where the pack read it. Quoted so a reader can check the claim. */
  readonly source: string;
}

/**
 * The sentence a refusal prints for one stack, or the honest absence.
 *
 * IT ALWAYS SAYS THE VALUE IS ADVISORY AND UNREAD. A refusal that merely named
 * a path would read as "nen looked there", and the whole point of this pair of
 * modules is that nen did not: the catalogue has no filesystem access, and the
 * caller resolves nothing either of them returns.
 */
export function advisoryFor(
  advisories: Readonly<Record<string, CoverageAdvisory>>,
  stack: string,
): string {
  const advisory = advisories[stack];
  if (advisory === undefined) {
    return `The reference pack carries no profile for stack '${stack}', so nen has nothing to suggest about where its coverage report is written.`;
  }
  const head =
    advisory.path === null
      ? `The reference pack records no conventional report location for '${stack}'`
      : `The reference pack records '${advisory.path}' as the conventional location for '${stack}'`;
  return `${head} -- ADVISORY, and nen did not look there: it parses the report a declaration NAMES. The pack's reason: ${advisory.why} (${advisory.source})`;
}
