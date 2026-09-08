// src/cli/shape.ts -- the two pieces every read-seam row validator restates:
// how to name a value's actual shape in a refusal, and how to name the row
// that refusal is about.
//
// PULLED OUT OF ../board/command.ts and ../backlog/command.ts, in that order
// of authorship: ../board/command.ts's validateBoardRows()/validateBoard()
// (#32/#68/#92) wrote both first, and ../backlog/command.ts's
// validateOrderRows() (#105) copied them verbatim rather than share, so the
// same two functions existed twice, byte-identical in everything that runs,
// with only their surrounding comments drifting apart. A third read-seam
// validator reaching for these -- and this codebase has already grown two --
// would otherwise copy a THIRD time rather than find one place to import
// from.
//
// NOTE ON src/schema/errors.ts's describeValue(): that is a DIFFERENT
// function with a different voice ("expected an object, got ...", built for
// SchemaError's `path`/`pointer` shape) serving the schema loaders under
// src/schema/. It is not consolidated here on purpose -- the two families'
// messages are pinned by their own tests and are not meant to read alike.

/**
 * The "got" half of a shape refusal. Bare `typeof` is not enough: `typeof
 * null` is "object", an array is "object" too, and a missing field would
 * print as the grammatically hostile "undefined" -- each sends the caller
 * hunting for a mistake they did not make.
 */
export function describeValue(value: unknown): string {
  if (value === undefined) return "nothing (the field is missing)";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `the string '${value}'`;
  // "an object", never "a object". A plain object DOES reach this fallback
  // (e.g. a field sent as `{ ... }` -- neither array, null, nor string), and
  // it is the one typeof in JSON's vocabulary that starts with a vowel; the
  // bare template below would hand back exactly the grammatically hostile
  // output this helper exists to avoid.
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/**
 * A refusal that cannot say WHICH row it refuses sends the caller back to
 * bisecting the file by hand. The row's own id is used whenever it is a
 * usable name; the index is the fallback, not the default.
 */
export function rowLabel(row: Readonly<Record<string, unknown>>, index: number): string {
  const id = row["id"];
  return typeof id === "string" && id !== "" ? `row '${id}'` : `row at index ${index}`;
}
