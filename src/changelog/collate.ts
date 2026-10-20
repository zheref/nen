// src/changelog/collate.ts -- CON-33(b)'s release-time fragment collation,
// ported from bankai-core's `scripts/changelog_collate_fragments.sh`
// (bankai-core#397).
//
// CON-33(b): when a release tag is cut, the release PR collates every
// fragment file currently in the fragment directory directly into a new dated
// `### vX.Y.Z — <theme>` section (placed newest-first, directly below
// `### Unreleased`), deletes each collated fragment file, and leaves
// `### Unreleased` empty. This module is the pure text transformation; the
// caller (../changelog/command.ts) does the file I/O the source's CLI half
// performed directly.
// Without Unreleased, an existing ## or ### vX.Y.Z — YYYY-MM-DD heading
// supplies the shape; an explicit --date supplies the new calendar date.
//
// FRAGMENTS SORT NEWEST-FIRST BY THEIR LEADING NUMERIC PREFIX -- the
// `<pr-or-issue-number>-<slug>.md` convention -- matching the CHANGELOG's own
// newest-first convention for entries within a section. A filename with no
// numeric prefix sorts LAST (never dropped), the source's own fallback.
//
// COLLATION REFUSES AN ALREADY-NON-EMPTY `### Unreleased`. This collator only
// ever moves fragment content; a pre-existing bullet under Unreleased is
// content it did not put there and cannot see was migrated, and overwriting
// it with the empty placeholder would silently delete release history
// (bankai-core#403 finding 1). Fails closed, unchanged, rather than guessing.

import { unreleasedEntryCount } from "./fragment.js";

export interface Fragment {
  readonly name: string;
  readonly content: string;
}

/**
 * Sort fragments newest-first by their leading `<n>-` numeric prefix; no prefix
 * sorts last.
 *
 * IDEMPOTENT, and relied upon to be: `collateIntoChangelog` applies it to
 * whatever it is handed, so the section is newest-first even for a caller that
 * did not sort -- while `../changelog/command.ts` also applies it, to decide the
 * ONE order both the written section and the printed manifest are read off
 * (zheref/nen#34). Two applications, one order.
 */
export function sortFragments(fragments: readonly Fragment[]): Fragment[] {
  const withKey = fragments.map((fragment): { fragment: Fragment; key: number } => {
    const match = /^(\d+)-/.exec(fragment.name);
    return { fragment, key: match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10) };
  });
  withKey.sort((a, b): number => {
    if (a.key !== b.key) return b.key - a.key; // descending: newest (highest number) first
    return a.fragment.name < b.fragment.name ? -1 : a.fragment.name > b.fragment.name ? 1 : 0;
  });
  return withKey.map((item): Fragment => item.fragment);
}

/**
 * The rendered `### vX.Y.Z — <theme>` section, fragments in the given order.
 *
 * THE SEPARATOR IS AN EM DASH ("—"), matching the source's `printf '### v%s
 * — %s\n'` (changelog_collate_fragments.sh:59) and every existing dated
 * section in a real CHANGELOG.md -- an ASCII double-hyphen here was an
 * undisclosed behavioural delta from a strict porting source (review
 * finding): a section nen collates would visibly disagree with every section
 * above it. Cosmetic (nothing downstream matches on the separator -- see
 * ../changelog/completeness.ts and getsuga's own tag-precondition check,
 * which both match only the leading `### v<semver>`), but a port fidelity
 * deviation is a finding to report, never a silent "improvement".
 */
export function renderDatedSection(version: string, theme: string, fragments: readonly Fragment[]): string {
  const bareVersion = version.startsWith("v") ? version.slice(1) : version;
  let out = `### v${bareVersion} — ${theme}\n`;
  for (const fragment of fragments) {
    out += fragment.content.endsWith("\n") ? fragment.content : `${fragment.content}\n`;
  }
  return out;
}

export class CollateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollateError";
  }
}

const SUPPORTED_SHAPES = "supported shapes are '### Unreleased' with --theme, or '## vX.Y.Z — YYYY-MM-DD' / '### vX.Y.Z — YYYY-MM-DD' with --date";

function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

/** Resolve once from the newest release, never a later historical format. */
export function collationHeading(changelog: string, version: string, theme: string, date?: string): string {
  const bareVersion = version.replace(/^v/, "");
  if (changelog.split("\n").some((line): boolean => /^### Unreleased/.test(line))) {
    if (date !== undefined || theme.length === 0) {
      throw new CollateError(`'### Unreleased' requires --theme and does not accept --date; ${SUPPORTED_SHAPES}.`);
    }
    return `### v${bareVersion} — ${theme}`;
  }
  // Consider the first release-like heading, including unsupported levels and
  // separators. Skipping it to infer from an older section would silently pick
  // an obsolete shape. Unreleased at another level is also an unknown shape.
  const newest = changelog.split("\n").find((line): boolean => /^#+\s+(?:\[?v?\d|\[?Unreleased\b)/i.test(line));
  const shape = newest === undefined ? null : /^(#{2,3}) v\d+\.\d+\.\d+ — (\d{4}-\d{2}-\d{2})$/.exec(newest);
  if (shape === null || !validDate(shape[2] ?? "")) {
    throw new CollateError(`the changelog's newest section shape is not recognised; ${SUPPORTED_SHAPES}.`);
  }
  if (date === undefined || !validDate(date) || theme.length > 0) {
    throw new CollateError("a dated changelog requires --date YYYY-MM-DD (a valid calendar date), without --theme.");
  }
  return `${shape[1]} v${bareVersion} — ${date}`;
}

/**
 * Insert a release using the legacy empty-Unreleased route, or immediately
 * before the newest recognised ISO-dated release. Requires fragments; the
 * dated route also requires an explicit valid date, never a clock default.
 */
export function collateIntoChangelog(
  changelog: string,
  version: string,
  theme: string,
  fragments: readonly Fragment[],
  date?: string,
): string {
  if (fragments.length === 0) {
    throw new CollateError("no fragment files were given -- nothing to collate.");
  }
  const lines = changelog.split("\n");
  const heading = collationHeading(changelog, version, theme, date);
  const unreleasedIndex = lines.findIndex((line): boolean => /^### Unreleased/.test(line));
  if (unreleasedIndex === -1) {
    const newestIndex = lines.findIndex((line): boolean => /^#{2,3} v\d+\.\d+\.\d+ — /.test(line));
    const section = renderDatedSection(version, date ?? "", sortFragments(fragments)).replace(/^### [^\n]+/, heading);
    return [...lines.slice(0, newestIndex), section, ...lines.slice(newestIndex)].join("\n");
  }
  const existing = unreleasedEntryCount(changelog);
  if (existing > 0) {
    throw new CollateError(
      `the changelog still has ${existing} entr${existing === 1 ? "y" : "ies"} under '### Unreleased' -- refusing to overwrite existing content with the fragment placeholder. Migrate the entries by hand before collating fragments.`,
    );
  }

  let nextHeaderIndex = lines.length;
  for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("### ")) {
      nextHeaderIndex = index;
      break;
    }
  }

  const before = lines.slice(0, unreleasedIndex + 1);
  const after = lines.slice(nextHeaderIndex);
  const section = renderDatedSection(version, theme, sortFragments(fragments));

  return [...before, "_(nothing awaiting release.)_", "", section.replace(/\n$/, ""), ...after].join("\n");
}
