// src/ref/notation.ts -- the object notation `<CODE>-<IS|PR>-#<N>`, formatted and
// parsed.
//
// PORTED FROM bankai-core's `agents/_conventions.md` § Object references and the
// rule 4 restatement in `agents/ichigo/AGENT.md` § Prompt protocol. The problem
// it solves, in its own words: "A bare `#386` does not say which repo it lives in
// or whether it is an issue or a PR, and a reader who follows dozens of these
// across [repositories] cannot afford to guess."
//
// THE GLYPHS ARE NOTATION, NOT TAXONOMY, and the distinction is why they are
// written here as constants rather than read from a schema. A status circle is a
// VOCABULARY -- a repository decides what its statuses are and what each means,
// which is why ../color/status.ts reads every one of them from
// `schemas/colors.yml`. `IS` versus `PR` is not a vocabulary: it is the two
// halves of this notation's own grammar, in the same way the `-` separators are.
// A repository that wanted a third object kind would be changing the notation,
// not configuring it.
//
// THE KIND GLYPH IS DERIVED FROM THE REF, NEVER FROM A FIELD, and the original
// says why in one clause: "derived from the ref's own IS/PR so it cannot
// disagree with the text". The STATE mark is the opposite -- it comes from an
// explicit field, "since an object's lifecycle cannot be read off a ref" -- and
// the asymmetry is load-bearing rather than untidy.
//
// `open` RENDERS NO MARK, AND THAT IS NOT THE SAME AS AN UNKNOWN STATE. Both
// emit nothing; only one of them is a fact. So `parseState` returns a
// discriminated result and the renderer reports an unknown state rather than
// quietly treating it as open -- an object whose lifecycle could not be read
// must not look identical to one that is confirmed open.

/** `<CODE>-<IS|PR>-#<N>`: two or three UPPERCASE letters, the kind, the number. */
export const OBJECT_REF = /^([A-Z]{2,3})-(IS|PR)-#(\d+)$/;

export type ObjectKind = "IS" | "PR";

/** Leading glyph, by kind. Deliberately circle-free: the board's status circles are a different vocabulary and must stay unambiguous. */
export const KIND_GLYPH: Readonly<Record<ObjectKind, string>> = {
  IS: "\u{1F4C4}",
  PR: "\u{1F500}",
};

/** Trailing mark, by state. `open` is present and empty -- a fact, not an absence. */
export const STATE_MARK: Readonly<Record<string, string>> = {
  merged: "✓",
  completed: "✓",
  closed: "✗",
  draft: "✎",
  open: "",
};

export const KNOWN_STATES: readonly string[] = Object.keys(STATE_MARK);

export interface ObjectRef {
  readonly ref: string;
  readonly code: string;
  readonly kind: ObjectKind;
  readonly number: number;
  /** The kind glyph, derived from `kind`. */
  readonly glyph: string;
}

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefError";
  }
}

export function parseRef(token: string): ObjectRef {
  const match = OBJECT_REF.exec(token.trim());
  if (match === null) {
    throw new RefError(
      `'${token}' is not object notation. The form is <CODE>-<IS|PR>-#<N>: two or three UPPERCASE letters naming the repository, then IS for an issue or PR for a pull request, then the number behind a '#'. A bare number does not say which repository it lives in or whether it is an issue, and a reader following these across repositories cannot afford to guess.`,
    );
  }
  const [, code, kind, digits] = match;
  if (code === undefined || kind === undefined || digits === undefined) {
    throw new RefError(`'${token}' matched the notation but carried no parts.`);
  }
  const objectKind = kind as ObjectKind;
  return {
    ref: `${code}-${kind}-#${digits}`,
    code,
    kind: objectKind,
    number: Number.parseInt(digits, 10),
    glyph: KIND_GLYPH[objectKind],
  };
}

/** `true` when the token reads as object notation, without throwing. */
export function isRef(token: string): boolean {
  return OBJECT_REF.test(token.trim());
}

export interface FormatOptions {
  readonly code: string;
  readonly kind: ObjectKind;
  readonly number: number;
  /** `merged` | `completed` | `closed` | `draft` | `open`, or null when unrecorded. */
  readonly state?: string | null;
  /** When given, the ref is wrapped as a markdown link. */
  readonly url?: string | null;
  /** Emit the kind glyph and the state mark around the token. */
  readonly glyphs?: boolean;
}

export interface Formatted {
  /** The bare `<CODE>-<IS|PR>-#<N>`. */
  readonly ref: string;
  /** The rendered token: `[kind] <ref-or-link> [state]`. */
  readonly token: string;
  readonly glyph: string;
  /** The state mark, or "" for `open` and for an unrecorded state. */
  readonly mark: string;
  /** Set when a state was given that this notation does not know. */
  readonly unknownState: string | null;
}

const CODE = /^[A-Z]{2,3}$/;

export function formatRef(options: FormatOptions): Formatted {
  if (!CODE.test(options.code)) {
    throw new RefError(
      `'${options.code}' is not a product code. A code is two or three UPPERCASE letters and comes from the target repository's schemas/repos.json -- add it there before naming a new repository.`,
    );
  }
  if (!Number.isInteger(options.number) || options.number <= 0) {
    throw new RefError(`'${String(options.number)}' is not an issue or pull-request number.`);
  }
  const ref = `${options.code}-${options.kind}-#${options.number}`;
  const state = options.state ?? null;
  const known = state === null ? true : Object.prototype.hasOwnProperty.call(STATE_MARK, state);
  const mark = state !== null && known ? (STATE_MARK[state] ?? "") : "";
  const glyph = KIND_GLYPH[options.kind];

  // THE LINK WRAPS THE WHOLE TOKEN, never part of it: the convention is explicit
  // that in markdown bodies "wrap the whole token" and that a token is never
  // split across lines.
  const core = options.url === undefined || options.url === null || options.url === ""
    ? ref
    : `[${ref}](${options.url})`;
  const wantGlyphs = options.glyphs !== false;
  const token = wantGlyphs
    ? [glyph, core, mark].filter((part): boolean => part !== "").join(" ")
    : core;

  return {
    ref,
    token,
    glyph,
    mark,
    unknownState: state !== null && !known ? state : null,
  };
}
