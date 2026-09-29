// src/changelog/completeness.ts -- CON-33(c)'s release-time vPrev..vNew
// completeness check, ported from bankai-core's
// `scripts/changelog_release_completeness_check.sh` (bankai-core#249, #397).
//
// CON-33(c): a release tag vNew MUST enumerate everything merged since vPrev,
// reconciled against the ACTUAL merge history -- no merged PR in the range may
// lack a fragment folded into the dated section (or, for a non-spec PR, the
// CON-33(a) opt-out, which this module cannot see from the CHANGELOG alone --
// a flagged PR still needs a human glance at its body before back-filling).
//
// A FRAGMENT STILL SITTING UNCOLLATED counts as a reference: #397's
// changelog-guard already required a fragment to exist before its PR could
// merge, so an uncollated fragment is evidence of compliance, not a gap. Its
// leading `<pr-or-issue-number>-` prefix counts exactly like an
// already-collated PR link would.
//
// SCOPED to THIS repository's own PR/issue links -- an unrelated foreign-repo
// link that happens to share a number must never count as this repository's
// reference (bankai-core#344 AC1). The link pattern is therefore a caller
// parameter (the repository's own `github.com/<owner>/<repo>` prefix), never
// a literal.
//
// ONE PR MAY BE RECONCILED WITHOUT A CITATION: THE TERMINAL PR WHOSE MERGE
// INTRODUCED THE DATED SECTION (zheref/nen#229) -- "the release-PR
// allowance". A release proposal is written before its own pull request has a
// number, so the dated section it introduces cannot cite it, and the cut point
// -- that PR's own merge -- always listed it as missing. Every release in this
// repository paid a second "reconcile" PR whose whole diff was adding its
// predecessor's number to one line. The allowance is decided by ./reconcile.ts
// from the merge history (see its header for the exact conditions, and for
// what they can NOT tell apart) and arrives here as data: this module only
// EXCUSES the one PR the decision names, and only when the decision says
// `applied`. Every other uncited PR is still missing exactly as before, and
// the decision -- applied or declined, with its reason -- is carried in the
// report rather than dropped, so an auditor can see the allowance was used and
// why.

/**
 * The fragment directory both CON-33(c) readers default to, defined ONCE here
 * because both of them import this module already (zheref/nen#10 item 5).
 *
 * `nen release preflight` and `nen changelog completeness` reconcile the same
 * merge range against the same evidence, and `--fragment-dir` used to default
 * in one and be optional-with-no-default in the other -- so omitting it from
 * `changelog completeness` reported an uncollated fragment's PR as missing
 * while the sibling verb (and the porting source's own CLI,
 * changelog_release_completeness_check.sh:117) counted it. Two verbs
 * disagreeing about the same repository's layout is the kind of drift a shared
 * constant makes impossible rather than merely unlikely.
 */
export const DEFAULT_FRAGMENT_DIR = "changelog.d";

/**
 * Why the release-PR allowance was, or was not, applied -- one value per
 * distinct fact, so a consumer branches on the fact rather than on prose.
 * ./reconcile.ts checks them in this order and stops at the first that
 * declines:
 *
 *   applied                  the terminal merge's PR introduced the dated section, and is reconciled without a citation.
 *   range-not-two-dot        `--range` is not `<vPrev>..<vNew>`, so it has no single end commit.
 *   terminal-unreadable      git could not read the range's end commit.
 *   terminal-not-pr-merge    the range ends at a commit that is not a two-parent `Merge pull request #N` merge.
 *   terminal-pr-cited        the terminal PR is already cited; there is nothing to excuse.
 *   no-dated-section         `--changelog` does not open with a DATED `## vX.Y.Z` / `### vX.Y.Z` heading --
 *                            none at all, or one whose trailing text is `unreleased`.
 *   changelog-outside-repo   `--changelog` does not resolve inside the repository, so its history cannot be read.
 *   section-not-at-terminal  the CHANGELOG at the terminal merge does not open with that dated section.
 *   section-on-first-parent  the section, dated, was already on the trunk before the terminal merge.
 *   section-carried          another merge on the terminal PR's branch -- a PR merge or a local one -- introduced it.
 *   history-unreadable       a git read the decision needs failed; the allowance fails closed.
 */
export type ReleasePrVerdict =
  | "applied"
  | "range-not-two-dot"
  | "terminal-unreadable"
  | "terminal-not-pr-merge"
  | "terminal-pr-cited"
  | "no-dated-section"
  | "changelog-outside-repo"
  | "section-not-at-terminal"
  | "section-on-first-parent"
  | "section-carried"
  | "history-unreadable";

/** The release-PR allowance's decision, applied or declined, as evidence. */
export interface ReleasePrAllowance {
  /** True only for verdict `applied`. */
  readonly applied: boolean;
  readonly verdict: ReleasePrVerdict;
  /** The terminal merge's PR number, once the range is known to end at a PR merge. */
  readonly pr: number | null;
  /** The range's end commit, once git has resolved it. */
  readonly mergeSha: string | null;
  /** The terminal merge's first parent -- the trunk just before the PR merged. */
  readonly firstParentSha: string | null;
  /** The dated section `--changelog` opens with, e.g. `v0.12.0`. */
  readonly section: string | null;
  /**
   * For `section-carried`: the PR whose merge introduced the section, or null
   * when that merge was a local one (no PR); the merge's sha is in `detail`.
   */
  readonly carriedBy: number | null;
  /** One sentence saying why, in the words both verbs print. */
  readonly detail: string;
}

export interface CompletenessInput {
  /** Merged PR numbers in the range, from `git log --merges` subjects. */
  readonly mergedPrNumbers: readonly number[];
  /** PR/issue numbers referenced by a link in the CHANGELOG text. */
  readonly changelogRefs: readonly number[];
  /** PR/issue numbers named by a `changelog.d/<n>-*.md` fragment filename, collated or not. */
  readonly fragmentRefs: readonly number[];
  /**
   * The release-PR allowance's decision, when one was made. Omitted (or null)
   * means none was evaluated -- the reconciliation is exactly the citation
   * check it always was.
   */
  readonly releasePrAllowance?: ReleasePrAllowance | null;
}

export interface CompletenessReport {
  /** Merged PRs with no citation and no fragment, AFTER the allowance. */
  readonly missing: readonly number[];
  readonly ok: boolean;
  /**
   * The allowance's decision, or null when it was never needed (every merged
   * PR was already cited). Kept even when it excused nothing, so the reason it
   * declined is on the record next to the PR it declined.
   */
  readonly releasePrAllowance: ReleasePrAllowance | null;
}

export function checkCompleteness(input: CompletenessInput): CompletenessReport {
  const referenced = new Set([...input.changelogRefs, ...input.fragmentRefs]);
  const allowance = input.releasePrAllowance ?? null;
  // AT MOST ONE PR IS EXCUSED, and only by an `applied` decision naming it:
  // a declined decision, or an applied one without a PR number, excuses
  // nothing, so the check can never loosen by accident.
  const excused = allowance !== null && allowance.applied ? allowance.pr : null;
  const missing = [...new Set(input.mergedPrNumbers)]
    .filter((number): boolean => !referenced.has(number) && number !== excused)
    .sort((a, b): number => a - b);
  return { missing, ok: missing.length === 0, releasePrAllowance: allowance };
}

/**
 * One line naming the allowance, for the two verbs that print it -- or null
 * when there is nothing a reader of the missing list needs to know.
 *
 * WRITTEN ONCE so `nen changelog completeness` and `nen release preflight`
 * cannot describe the same decision two ways. A line appears when the
 * allowance EXCUSED a PR (so the auditor sees which one, and why it was
 * allowed to go uncited), and when it DECLINED the terminal PR that is still
 * missing (so the reader of "missing: #225" learns why the exception did not
 * cover it). A decline that never reached a PR -- a range that does not end
 * at a pull-request merge, or a terminal PR that is cited already -- has
 * nothing to add to the list, and says so only in `--json`.
 *
 * THE LINE NAMES THE RULE, NOT AN IDENTITY. The history proves that the
 * terminal PR's merge introduced the dated section, which is what a release
 * proposal does -- and also what a delivery PR that opens the section itself
 * does. So the line says the PR was reconciled BY the allowance, never that it
 * IS the release PR.
 */
export function describeReleasePrAllowance(allowance: ReleasePrAllowance | null): string | null {
  if (allowance === null || allowance.pr === null) return null;
  if (allowance.applied) return `#${allowance.pr} reconciled by the CON-33(c) release-PR allowance: ${allowance.detail}`;
  if (allowance.verdict === "terminal-pr-cited") return null;
  return `#${allowance.pr} not reconciled by the release-PR allowance: ${allowance.detail}`;
}

// A VERSIONED SECTION HEADING, AT EITHER LEVEL THIS FAMILY WRITES. `nen
// changelog collate` renders `### vX.Y.Z — <theme>` (./collate.ts) while this
// repository's own CHANGELOG.md opens each release with `## vX.Y.Z — <date>`.
// ./fragment.ts's `firstDatedVersion` reads `###` only and is left alone --
// CON-33(a) is outside this change's scope -- so the allowance reads both
// levels here rather than declining every release of a `##` repository as
// "no dated section". Anything else (a `## [1.2.3]` Keep-a-Changelog heading,
// `### Unreleased`) is not a versioned section to this check, and the
// allowance then declines rather than guessing. The second group is whatever
// trails the version: the date, the theme, or `— unreleased`.
const VERSION_HEADING = /^#{2,3}[ \t]+(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=[ \t]|$)(.*)$/;

// A HEADING WHOSE TRAILING TEXT IS `unreleased` IS NOT DATED (zheref/nen#229,
// ruled in this effort's review settlement, on the issue's literal wording:
// the allowance covers the PR that introduced the DATED section). This
// repository shipped v0.13.1 through v0.14.2 with a delivery PR opening
// `## vX.Y.Z — unreleased` and the release PR adding the date. Read as dated,
// that excused the DELIVERY PR at its own merge and declined the release PR
// -- the reverse of the issue. Read as undated, the release PR that dates the
// heading is the one that introduced the dated section. The separator and any
// wrapping brackets or emphasis are stripped before comparing; anything else
// trailing the version (a date, a theme, nothing) is dated.
function isUndatedTrailer(trailer: string): boolean {
  const text = trailer
    .trim()
    .replace(/^[—–:-]+/, "")
    .trim()
    .replace(/^[([_*]+|[)\]_*]+$/g, "")
    .trim();
  return /^unreleased$/i.test(text);
}

/** One versioned section heading: its version, and whether it is dated (not `— unreleased`). */
export interface SectionHeading {
  readonly version: string;
  readonly dated: boolean;
}

/** Every versioned section heading, top to bottom, dated or not. */
export function sectionHeadings(changelog: string): SectionHeading[] {
  const headings: SectionHeading[] = [];
  for (const line of changelog.split("\n")) {
    const match = VERSION_HEADING.exec(line.replace(/\r$/, ""));
    if (match?.[1] !== undefined) headings.push({ version: match[1], dated: !isUndatedTrailer(match[2] ?? "") });
  }
  return headings;
}

/** Every DATED section heading's version, top to bottom -- what "the section is present" means. */
export function datedSections(changelog: string): string[] {
  return sectionHeadings(changelog)
    .filter((heading): boolean => heading.dated)
    .map((heading): string => heading.version);
}

/**
 * The dated section a CHANGELOG OPENS with -- the one a release at this point
 * cuts -- or null when its first versioned heading is undated (or it has
 * none). An opening `## vX.Y.Z — unreleased` is not skipped in favour of the
 * dated section below it: that older section is not the one being cut.
 */
export function openingDatedSection(changelog: string): string | null {
  const opening = sectionHeadings(changelog)[0];
  return opening !== undefined && opening.dated ? opening.version : null;
}

/** Parse "Merge pull request #N from ..." merge-commit subjects into PR numbers. */
export function extractMergedPrNumbers(subjects: readonly string[]): number[] {
  const numbers = new Set<number>();
  for (const subject of subjects) {
    const match = /^Merge pull request #(\d+)/.exec(subject);
    if (match?.[1] !== undefined) numbers.add(Number.parseInt(match[1], 10));
  }
  return [...numbers].sort((a, b): number => a - b);
}

/** Parse `github.com/<owner>/<repo>/(pull|issues)/<N>` links scoped to one repository slug. */
export function extractChangelogRefs(text: string, ownerRepo: string): number[] {
  const escaped = ownerRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`github\\.com/${escaped}/(?:pull|issues)/(\\d+)`, "g");
  const numbers = new Set<number>();
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) numbers.add(Number.parseInt(match[1], 10));
  }
  return [...numbers].sort((a, b): number => a - b);
}

/** Parse a fragment filename's leading `<n>-` prefix into a PR/issue number. */
export function extractFragmentRefs(fragmentNames: readonly string[]): number[] {
  const numbers = new Set<number>();
  for (const name of fragmentNames) {
    const match = /^(\d+)-/.exec(name);
    if (match?.[1] !== undefined) numbers.add(Number.parseInt(match[1], 10));
  }
  return [...numbers].sort((a, b): number => a - b);
}
