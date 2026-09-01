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

export interface CompletenessInput {
  /** Merged PR numbers in the range, from `git log --merges` subjects. */
  readonly mergedPrNumbers: readonly number[];
  /** PR/issue numbers referenced by a link in the CHANGELOG text. */
  readonly changelogRefs: readonly number[];
  /** PR/issue numbers named by a `changelog.d/<n>-*.md` fragment filename, collated or not. */
  readonly fragmentRefs: readonly number[];
}

export interface CompletenessReport {
  readonly missing: readonly number[];
  readonly ok: boolean;
}

export function checkCompleteness(input: CompletenessInput): CompletenessReport {
  const referenced = new Set([...input.changelogRefs, ...input.fragmentRefs]);
  const missing = [...new Set(input.mergedPrNumbers)]
    .filter((number): boolean => !referenced.has(number))
    .sort((a, b): number => a - b);
  return { missing, ok: missing.length === 0 };
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
