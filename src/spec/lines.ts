// src/spec/lines.ts -- the line grammar every `nen spec` verb reads.
//
// ONE GRAMMAR, FOUR READERS. `spec check` holds each requirement line to
// citation-or-marker, `spec cite-check` resolves the citations, `spec index`
// counts the open markers -- if each kept its own regex, a citation one of them
// accepted could be one another refused. The shapes are Hatsu's (the SDD plan's
// skill design, *Hallucination controls*, HR-12):
//
//   [src: <CODE>:<path>:<l1>-<l2> @ <sha> · declared|observed|inferred]
//   [NEEDS CLARIFICATION: <question>] · [NEEDS RULING] · [UNVERIFIED]
//
// and the two forms later phases write (Hatsu's docs/config/spec-repo.md §
// Citations and markers): `[ruled: CL-nnn]`, an answered clarification in
// place of the marker it settled -- a CLOSING annotation, neither open nor
// uncited -- and `[STALE @ <old sha>]`, written by recapture beside a citation
// whose range moved: a trailing COMPANION of the citation, counted as stale,
// never read as the line's own annotation (delivery round on zheref/nen#498,
// reading 8).
//
// FENCED BLOCKS ARE SOURCE DATA (SEC-15), so nothing inside one is a
// requirement, a citation, a marker or a placeholder: issue and PR text quoted
// into a spec lives there precisely so it is never read as the spec's own.

export type Tier = "declared" | "observed" | "inferred";
export type MarkerKind = "needs-clarification" | "needs-ruling" | "unverified";

export interface Citation {
  readonly code: string;
  readonly path: string;
  readonly l1: number;
  readonly l2: number;
  readonly sha: string;
  readonly tier: Tier;
  /** The bracket exactly as written. */
  readonly text: string;
}

export interface Marker {
  readonly kind: MarkerKind;
  readonly text: string;
}

/** What a line's trailing annotation group holds, peeled right to left. */
export interface Annotation {
  readonly citations: readonly Citation[];
  readonly markers: readonly Marker[];
  /** `[src: ...]` brackets that did not parse as a citation, verbatim. */
  readonly malformed: readonly string[];
  /** `[ruled: CL-nnn]` closing annotations: the clarification ids that settled the line. */
  readonly ruled: readonly string[];
  /** `[STALE @ <sha>]` companions, verbatim. */
  readonly stale: readonly string[];
}

export interface SourceLine {
  /** 1-based. */
  readonly number: number;
  readonly text: string;
  /** The nearest heading above the line, or null. */
  readonly heading: string | null;
  readonly headingLevel: number;
}

const CITATION = /^\[src: ([A-Z][A-Z0-9]{1,7}):([^\s\]]+?):(\d+)-(\d+) @ ([0-9a-f]{7,40}) · (declared|observed|inferred)\]$/;
const TRAILING = /\s*(\[src:[^\]]*\]|\[NEEDS CLARIFICATION:[^\]]*\]|\[NEEDS RULING\]|\[UNVERIFIED\]|\[ruled: CL-\d+\]|\[STALE @ [0-9a-f]{7,40}\])\s*$/;
const RULED = /^\[ruled: (CL-\d+)\]$/;
const STALE = /^\[STALE @ [0-9a-f]{7,40}\]$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** The 1-based line of a fence opener that never closes before the end of the text, or null. */
export function unclosedFence(text: string): number | null {
  let fence: string | null = null;
  let at: number | null = null;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, index): void => {
    const opener = FENCE.exec(line);
    if (fence !== null) {
      if (opener !== null && (opener[1] as string)[0] === fence[0] && (opener[1] as string).length >= fence.length && line.trim() === (opener[1] as string)) {
        fence = null;
        at = null;
      }
      return;
    }
    if (opener !== null) {
      fence = opener[1] as string;
      at = index + 1;
    }
  });
  return at;
}

/** Every line outside a fenced block, with the heading it sits under. */
export function proseLines(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  let fence: string | null = null;
  let heading: string | null = null;
  let headingLevel = 0;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, index): void => {
    const opener = FENCE.exec(line);
    if (fence !== null) {
      if (opener !== null && (opener[1] as string)[0] === fence[0] && (opener[1] as string).length >= fence.length && line.trim() === (opener[1] as string)) fence = null;
      return;
    }
    if (opener !== null) {
      fence = opener[1] as string;
      return;
    }
    const head = HEADING.exec(line);
    if (head !== null) {
      heading = head[2] as string;
      headingLevel = (head[1] as string).length;
    }
    out.push({ number: index + 1, text: line, heading, headingLevel });
  });
  return out;
}

/** A `[src: ...]` bracket read strictly, or null when it is not one. */
export function parseCitation(text: string): Citation | null {
  const match = CITATION.exec(text);
  if (match === null) return null;
  const path = match[2] as string;
  if (path.startsWith("/") || path.startsWith("-") || path.split("/").some((segment): boolean => segment === ".." || segment === "." || segment === "")) return null;
  return {
    code: match[1] as string,
    path,
    l1: Number(match[3]),
    l2: Number(match[4]),
    sha: match[5] as string,
    tier: match[6] as Tier,
    text,
  };
}

function markerOf(text: string): Marker | null {
  if (text === "[NEEDS RULING]") return { kind: "needs-ruling", text };
  if (text === "[UNVERIFIED]") return { kind: "unverified", text };
  if (text.startsWith("[NEEDS CLARIFICATION:") && text.slice("[NEEDS CLARIFICATION:".length, -1).trim() !== "") return { kind: "needs-clarification", text };
  return null;
}

/** The annotation brackets a line ENDS in, peeled from the right. */
export function trailingAnnotation(line: string): Annotation {
  const citations: Citation[] = [];
  const markers: Marker[] = [];
  const malformed: string[] = [];
  const ruled: string[] = [];
  const stale: string[] = [];
  let rest = line;
  for (;;) {
    const match = TRAILING.exec(rest);
    if (match === null) break;
    const token = match[1] as string;
    rest = rest.slice(0, match.index);
    const settled = RULED.exec(token);
    if (settled !== null) {
      ruled.unshift(settled[1] as string);
      continue;
    }
    if (STALE.test(token)) {
      stale.unshift(token);
      continue;
    }
    if (token.startsWith("[src:")) {
      const citation = parseCitation(token);
      if (citation === null) malformed.unshift(token);
      else citations.unshift(citation);
      continue;
    }
    const marker = markerOf(token);
    if (marker === null) malformed.unshift(token);
    else markers.unshift(marker);
  }
  return { citations, markers, malformed, ruled, stale };
}

const MARKER_ANYWHERE = /\[NEEDS CLARIFICATION:[^\]]*\]|\[NEEDS RULING\]|\[UNVERIFIED\]/g;

/** Every marker on a line, wherever it sits. */
export function markersIn(line: string): Marker[] {
  return [...line.matchAll(MARKER_ANYWHERE)].map((match): Marker | null => markerOf(match[0])).filter((marker): marker is Marker => marker !== null);
}

const CITATION_ANYWHERE = /\[src:[^\]]*\]/g;

/** Every `[src: ...]` bracket on a line, wherever it sits: parsed, or null when malformed. */
export function citationsIn(line: string): { readonly text: string; readonly citation: Citation | null }[] {
  return [...line.matchAll(CITATION_ANYWHERE)].map((match) => ({ text: match[0], citation: parseCitation(match[0]) }));
}

export type RequirementKind = "FR" | "SC" | "US";

export interface Requirement {
  readonly kind: RequirementKind;
  /** `FR-001`, `SC-002`, `US-1` -- a story heading's number spelled as US-<n>. */
  readonly id: string;
}

const DEFINITION = /^\s*(?:[-*+]\s+|\d+\.\s+)?(?:\*\*)?(FR|SC|US)-(\d+)(?:\*\*)?\s*[:.–—-]/;
/** `### User Story 1 - ...` (the pinned Spec Kit template) or `### US-1 — ...` (Hatsu's id grammar). */
const STORY_HEADING = /^#{1,6}\s+(?:User Story\s+(\d+)\b|US-(\d+)\b)/i;

/** The requirement a line DEFINES (not merely mentions), or null. */
export function requirementOf(line: string): Requirement | null {
  const story = STORY_HEADING.exec(line);
  if (story !== null) return { kind: "US", id: `US-${(story[1] ?? story[2]) as string}` };
  const definition = DEFINITION.exec(line);
  if (definition === null) return null;
  return { kind: definition[1] as RequirementKind, id: `${definition[1] as string}-${definition[2] as string}` };
}

/**
 * An in-folder id qualified for use outside the folder (Hatsu docs/config/spec-repo.md § The id grammar):
 * `FR-7` in folder `002` is `F002-FR-007`. The one padding rule every spec verb uses (SP-10), so a
 * live lookup keyed by the qualified id matches the id every other verb prints.
 */
export function qualifiedId(nnn: string, id: string): string {
  return `F${nnn}-${paddedId(id)}`;
}

/** An in-folder id in its padded form, `FR-7` -> `FR-007`: the one key two files' spellings are matched on. */
export function paddedId(id: string): string {
  const match = /^([A-Z]+)-(\d+)$/.exec(id);
  return match === null ? id : `${match[1] as string}-${(match[2] as string).padStart(3, "0")}`;
}
