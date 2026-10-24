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

/** Where the new section was anchored, and the heading it was written under. */
export interface CollateResult {
  readonly text: string;
  readonly heading: string;
  readonly anchor: "unreleased" | "dated-section";
}

export interface CollateOptions {
  /** The release date (`YYYY-MM-DD`), written only where the changelog's dated sections carry one. */
  readonly date?: string;
}

/**
 * The top dated release heading: `## vX.Y.Z — 2026-10-22` (nen's own shape) or
 * `### vX.Y.Z — <theme>` (the fragment-era shape), at any level. The level,
 * the `v`, the separator and whether the suffix is a date are read off it, so
 * the new section follows the changelog's own form (zheref/nen#504 AC-2).
 */
const DATED_HEADING = /^(#{1,6}) (v?)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)( [—–-]+ )(.*)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `line` is an ATX heading at `level` or above (fewer `#`s), the end of a section opened at `level`. */
function endsSection(line: string, level: number): boolean {
  const match = /^(#{1,6})\s/.exec(line);
  return match !== null && (match[1] as string).length <= level;
}

/**
 * Rewrite a CHANGELOG's text with the fragments as a new release section.
 *
 * TWO ANCHORS, IN ORDER (zheref/nen#504). An `### Unreleased` header, when the
 * changelog carries one, must be empty (see the header): it is kept with its
 * placeholder and the new `### vX.Y.Z — <theme>` section goes directly below
 * it, the section running to the next heading at its own level OR HIGHER, so a
 * `## v<prev>` heading under it is never swallowed. With no such header the new
 * section goes directly above the TOP dated release heading, at that heading's
 * level and in its form: a date suffix there means the new heading carries
 * `options.date` and the theme becomes the section's first paragraph; any other
 * suffix means the theme is the suffix. Every existing line is kept
 * byte-identical; only the new section and its blank separator are inserted.
 */
export function collateChangelog(
  changelog: string,
  version: string,
  theme: string,
  fragments: readonly Fragment[],
  options: CollateOptions = {},
): CollateResult {
  if (fragments.length === 0) {
    throw new CollateError("no fragment files were given -- nothing to collate.");
  }
  const lines = changelog.split("\n");
  // The file's own line ending, carried onto every inserted line: `split` on
  // LF leaves a CRLF file's `\r` on each existing line (zheref/nen#515 F11).
  const eol = changelog.includes("\r\n") ? "\r" : "";
  const unreleasedIndex = lines.findIndex((line): boolean => /^### Unreleased/.test(line));
  if (unreleasedIndex !== -1) {
    const existing = unreleasedEntryCount(changelog);
    if (existing > 0) {
      throw new CollateError(
        `the changelog still has ${existing} entr${existing === 1 ? "y" : "ies"} under '### Unreleased' -- refusing to overwrite existing content with the fragment placeholder. Migrate the entries by hand before collating fragments.`,
      );
    }
    let nextHeaderIndex = lines.length;
    for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
      if (endsSection(lines[index] ?? "", 3)) {
        nextHeaderIndex = index;
        break;
      }
    }
    const before = lines.slice(0, unreleasedIndex + 1);
    const after = lines.slice(nextHeaderIndex);
    // A DATED HEADING ABOVE OUR LEVEL ENDS THE BLOCK (zheref/nen#515 F1): the
    // changelog's releases are `## vX.Y.Z — <date>` with a `### Unreleased`
    // above them, so the new section takes THAT heading's form -- its level,
    // its date -- and a blank line, never an undated `###` wedged against it.
    const next = (after[0] ?? "").replace(/\r$/, "");
    const nextDated = DATED_HEADING.exec(next);
    if (nextDated !== null && (nextDated[1] as string).length < 3) {
      const section = renderInForm(nextDated, version, theme, fragments, options, eol);
      return {
        text: [...before, `_(nothing awaiting release.)_${eol}`, eol, ...section.lines, ...after].join("\n"),
        heading: section.heading,
        anchor: "unreleased",
      };
    }
    const section = renderDatedSection(version, theme, sortFragments(fragments));
    const heading = section.split("\n")[0] as string;
    const inserted = section.replace(/\n$/, "").split("\n").map((line): string => `${line}${eol}`);
    return {
      text: [...before, `_(nothing awaiting release.)_${eol}`, eol, ...inserted, ...after].join("\n"),
      heading,
      anchor: "unreleased",
    };
  }

  const topIndex = lines.findIndex((line): boolean => DATED_HEADING.test(line.replace(/\r$/, "")));
  if (topIndex === -1) {
    throw new CollateError(
      "the changelog has no '### Unreleased' header and no dated release heading ('## vX.Y.Z — <date or theme>') to anchor the collation on.",
    );
  }
  const match = DATED_HEADING.exec((lines[topIndex] as string).replace(/\r$/, "")) as RegExpExecArray;
  const section = renderInForm(match, version, theme, fragments, options, eol);
  return { text: [...lines.slice(0, topIndex), ...section.lines, ...lines.slice(topIndex)].join("\n"), heading: section.heading, anchor: "dated-section" };
}

/**
 * The new section in the form of `model`, a dated release heading: its level,
 * `v`, separator, and a date suffix (from `options.date`, the theme then the
 * first paragraph) or a theme suffix. Lines end with the file's own `eol`'s
 * `\r` where the file is CRLF (zheref/nen#515 F11); the caller joins on LF.
 */
function renderInForm(
  model: RegExpExecArray,
  version: string,
  theme: string,
  fragments: readonly Fragment[],
  options: CollateOptions,
  eol: string,
): { readonly heading: string; readonly lines: readonly string[] } {
  const [, hashes, vee, , separator, suffix] = model as unknown as [string, string, string, string, string, string];
  const bareVersion = version.startsWith("v") ? version.slice(1) : version;
  const dated = ISO_DATE.test(suffix.trim());
  if (dated && options.date === undefined) {
    throw new CollateError("the top release heading carries a date, and no release date was given to write on the new one.");
  }
  if (options.date !== undefined && !validIsoDate(options.date)) {
    throw new CollateError(`'${options.date}' is not a calendar date in YYYY-MM-DD form.`);
  }
  const heading = `${hashes} ${vee}${bareVersion}${separator}${dated ? (options.date as string) : theme}`;
  const body: string[] = [heading, ""];
  if (dated) body.push(theme, "");
  for (const fragment of sortFragments(fragments)) {
    body.push(...fragment.content.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n"));
  }
  body.push("");
  return { heading, lines: body.map((line): string => `${line}${eol}`) };
}

/** Whether `value` is a real `YYYY-MM-DD` calendar date. */
export function validIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** {@link collateChangelog}'s text alone, for callers that need no anchor. */
export function collateIntoChangelog(
  changelog: string,
  version: string,
  theme: string,
  fragments: readonly Fragment[],
  options: CollateOptions = {},
): string {
  return collateChangelog(changelog, version, theme, fragments, options).text;
}
