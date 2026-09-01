// src/changelog/collate.ts -- CON-33(b)'s release-time fragment collation,
// ported from bankai-core's `scripts/changelog_collate_fragments.sh`
// (bankai-core#397).
//
// CON-33(b): when a release tag is cut, the release PR collates every
// fragment file currently in the fragment directory directly into a new dated
// `### vX.Y.Z -- <theme>` section (placed newest-first, directly below
// `### Unreleased`), deletes each collated fragment file, and leaves
// `### Unreleased` empty. This module is the pure text transformation; the
// caller (../changelog/command.ts) does the file I/O the source's CLI half
// performed directly.
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

/** Sort fragments newest-first by their leading `<n>-` numeric prefix; no prefix sorts last. */
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

/** The rendered `### vX.Y.Z -- <theme>` section, fragments in the given order. */
export function renderDatedSection(version: string, theme: string, fragments: readonly Fragment[]): string {
  const bareVersion = version.startsWith("v") ? version.slice(1) : version;
  let out = `### v${bareVersion} -- ${theme}\n`;
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

/**
 * Rewrite a CHANGELOG's text: empty `### Unreleased`, insert the new dated
 * section immediately below it. Requires an ALREADY-EMPTY `### Unreleased`
 * (see the header) and at least one fragment.
 */
export function collateIntoChangelog(
  changelog: string,
  version: string,
  theme: string,
  fragments: readonly Fragment[],
): string {
  if (fragments.length === 0) {
    throw new CollateError("no fragment files were given -- nothing to collate.");
  }
  const lines = changelog.split("\n");
  const unreleasedIndex = lines.findIndex((line): boolean => /^### Unreleased/.test(line));
  if (unreleasedIndex === -1) {
    throw new CollateError("the changelog has no '### Unreleased' header to anchor the collation on.");
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
