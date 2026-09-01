// src/schema/errors.ts -- the ONE error type every taxonomy read fails with.
//
// A MISSING OR MALFORMED SCHEMA FILE IS A LOUD, ACTIONABLE ERROR. It is never a
// fallback to a built-in default, and this file existing at all is how that rule
// is kept: there is no other way for a loader to report a problem, so there is
// nowhere for a `?? BUILT_IN_LABELS` to hide.
//
// WHY NO FALLBACK, stated once here so no loader has to re-argue it. The
// Akatsuki migration's §3 discipline is "names are data": no binary may
// hard-code a persona, label, check name or colour. A fallback IS a hard-coded
// name -- it is the same literal, moved into the error path where no test looks
// and no reviewer reads it, and it activates precisely when the repository's own
// taxonomy could not be read. The failure mode is the worst available: `nen`
// reports labels the target repository does not have, confidently, and the
// operator discovers it when a label sync deletes work.
//
// So a loader either returns what the file says or throws SchemaError naming
// (1) the absolute PATH it looked at, (2) what it expected, and (3) what it
// found. All three, because a reader who is told "invalid schema" has been told
// nothing they can act on.

export class SchemaError extends Error {
  /** The absolute path of the file the loader was reading. */
  readonly path: string;
  /** A JSON-ish pointer into that file, e.g. `labels[3].description`. */
  readonly pointer: string | null;

  constructor(path: string, pointer: string | null, message: string) {
    super(pointer === null ? `${path}: ${message}` : `${path}: at ${pointer}, ${message}`);
    this.name = "SchemaError";
    this.path = path;
    this.pointer = pointer;
  }
}

export function describeValue(value: unknown): string {
  if (value === undefined) return "nothing (the field is absent)";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "object") return `an object with keys [${Object.keys(value).join(", ")}]`;
  return `${typeof value} (${JSON.stringify(value)})`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The three readers every loader shares. They take the path/pointer so that the
// SchemaError they throw is already actionable at the point of failure rather
// than being decorated by a catch further up, which is how a path gets lost.

export function requireRecord(
  path: string,
  pointer: string,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SchemaError(path, pointer, `expected an object, got ${describeValue(value)}`);
  }
  return value;
}

export function requireArray(path: string, pointer: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new SchemaError(path, pointer, `expected an array, got ${describeValue(value)}`);
  }
  return value;
}

export function requireString(path: string, pointer: string, value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new SchemaError(
      path,
      pointer,
      `expected a non-empty string, got ${describeValue(value)}`,
    );
  }
  return value;
}

export function optionalString(path: string, pointer: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new SchemaError(
      path,
      pointer,
      `expected a string or nothing, got ${describeValue(value)}`,
    );
  }
  return value;
}

export function requireBoolean(path: string, pointer: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new SchemaError(path, pointer, `expected a boolean, got ${describeValue(value)}`);
  }
  return value;
}
