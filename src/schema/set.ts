// src/schema/set.ts -- `nen schema set`: write ONE value into a declaration
// file, validated by that file's own loader before anything is written
// (zheref/nen#338).
//
// THE EDIT IS ../edit/json-pointer.ts's: an existing scalar replaced in place,
// or a member added to an existing object in that object's own style, every
// other byte of the file -- its formatting, its key order, its other members,
// its `$`-prefixed notes -- left as it was, and the splice proved by a parse.
// A pointer through a `$`-prefixed segment is refused: a `$` key is metadata
// (./declarations.ts), and metadata is the author's, never this verb's.
//
// THE RESULT IS VALIDATED FIRST. The edited text goes through the loader's own
// parse (`Declaration.validate`) before the disk is touched; a value the loader
// would refuse is refused here, at exit 1, with the loader's own message and
// nothing written. After a write the file is read back through the loader
// itself (`Declaration.load`), and the value at the pointer must be the one
// asked for.
//
// THE WRITE IS ../edit/atomic.ts's, shared with `canon pin --write`: the file
// is resolved to its real path, which must be inside the repository; read
// without following a final link, recording its identity; and replaced through
// a temporary file beside it, given the original's mode, after the identity
// and containment are checked again. A file that changed in between is
// refused, never overwritten.

import { realpathSync } from "node:fs";
import { containedOn, resolvedOrSelf } from "../canon/paths.js";
import type { ParsedArgs } from "../cli/args.js";
import { plainLine } from "../cli/plain.js";
import { checkedTarget, errnoOf, readChecked, TargetChangedError, writeFileAtomic } from "../edit/atomic.js";
import { formatPointer, JsonPointerSyntaxError, parsePointer, setJsonPointer, type PointerEdit } from "../edit/json-pointer.js";
import { JsonSpanError } from "../edit/json-span.js";
import { assertRepoRoot } from "../repo/root.js";
import { PROGRAM } from "../version.js";
import { DECLARATIONS, declarationFor, isMetadataKey, METADATA_PREFIX } from "./declarations.js";
import { parseSchemaJsonText, readSchemaFile, resolveSchemaFile } from "./source.js";

export const SCHEMA_SET_CONTRACT = "nen.schema.set/v0.1";

/** The flags `schema set` reads -- its own spec, not the pre-registry globals. */
export const SCHEMA_SET_FLAGS = {
  values: ["repo", "file", "pointer", "value"],
  booleans: ["json", "dry-run", "help"],
  aliases: { h: "help" },
} as const;

/** The JSON declarations `schema set` may edit, in row order. */
export const SETTABLE_FILES: readonly string[] = DECLARATIONS.filter((row): boolean => row.format === "json").map((row): string => row.file);

/** Thrown for an invocation `schema set` refuses before reading anything: exit 2. */
export class SchemaSetUsageError extends Error {}

export type SchemaSetFailureCode =
  | "no-file"
  | "outside-repo"
  | "file-changed"
  | "not-json"
  | "refused-edit"
  | "invalid"
  | "write-failed"
  | "read-back-mismatch";

export interface SchemaSetIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The one value a `--value` names: JSON, and a number only when it is written back as typed. */
export function parseSetValue(raw: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SchemaSetUsageError(
      `--value '${raw}' is not JSON (${error instanceof Error ? error.message : String(error)}). A string is quoted: --value '"main"'; a number, a boolean or null is bare: --value 85, --value true.`,
    );
  }
  checkNumbers(raw, value);
  return value;
}

function checkNumbers(raw: string, value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SchemaSetUsageError(`--value '${raw}' is a number JSON cannot write back (${String(value)}).`);
    const typed = raw.trim();
    if (/^-?[0-9]+$/.test(typed) && !Number.isSafeInteger(value)) {
      throw new SchemaSetUsageError(`--value '${raw}' is an integer past 2^53; it would be written as ${JSON.stringify(value)}, not as typed.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) checkNumbers(JSON.stringify(item), item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) checkNumbers(JSON.stringify(item), item);
  }
}

/** The pointer's segments, refused when they cannot name a value this verb may set. */
export function parseSetPointer(pointer: string): string[] {
  let segments: string[];
  try {
    segments = parsePointer(pointer);
  } catch (error) {
    if (error instanceof JsonPointerSyntaxError) throw new SchemaSetUsageError(`--pointer ${error.message}.`);
    throw error;
  }
  if (segments.length === 0) {
    throw new SchemaSetUsageError("--pointer '' names the whole document; name the one member to set, e.g. /coverage/minimum.");
  }
  const metadata = segments.find(isMetadataKey);
  if (metadata !== undefined) {
    throw new SchemaSetUsageError(
      `--pointer '${pointer}' goes through '${metadata}': a '${METADATA_PREFIX}'-prefixed key is metadata, which no loader reads and this verb never edits. Edit the note by hand.`,
    );
  }
  if (segments.includes("__proto__")) {
    throw new SchemaSetUsageError(`--pointer '${pointer}' names '__proto__', which no declaration carries.`);
  }
  return segments;
}

function show(value: unknown): string {
  return value === undefined ? "(absent)" : JSON.stringify(value);
}

/**
 * Run `nen schema set`. `args` is parsed against `SCHEMA_SET_FLAGS`; its
 * positionals are `schema set`. Returns the exit code: 0 set (or already
 * that value, or a dry run), 1 a refusal about the file or the value, 2 usage.
 */
export function runSchemaSet(args: ParsedArgs, repoFlag: string | null, json: boolean, io: SchemaSetIo, platform: NodeJS.Platform): number {
  const fail = (message: string): number => {
    io.err(plainLine(`${PROGRAM} schema set: ${message}`));
    io.err(`Run '${PROGRAM} schema --help'.`);
    return 2;
  };
  const extra = args.positionals.slice(2);
  if (extra.length > 0) return fail(`unexpected argument '${extra[0] ?? ""}': every input is a flag.`);
  const file = args.values["file"];
  const pointer = args.values["pointer"];
  const rawValue = args.values["value"];
  const missing = [file === undefined ? "--file" : null, pointer === undefined ? "--pointer" : null, rawValue === undefined ? "--value" : null].filter(
    (flag): flag is string => flag !== null,
  );
  if (file === undefined || pointer === undefined || rawValue === undefined) return fail(`requires ${missing.join(", ")}.`);
  const row = declarationFor(file);
  if (row === undefined) return fail(`--file '${file}' is not a declaration nen reads. It is one of: ${SETTABLE_FILES.join(", ")} -- spelled repo-relative, as here.`);
  if (row.format !== "json") return fail(`--file '${file}' is YAML; schema set edits a JSON declaration (${SETTABLE_FILES.join(", ")}).`);
  const dryRun = args.booleans.has("dry-run");
  let segments: string[];
  let value: unknown;
  try {
    segments = parseSetPointer(pointer);
    value = parseSetValue(rawValue);
  } catch (error) {
    if (error instanceof SchemaSetUsageError) return fail(error.message);
    throw error;
  }
  const canonicalPointer = formatPointer(segments);
  const root = assertRepoRoot({ repoFlag });

  const refuse = (code: SchemaSetFailureCode, message: string): number => {
    if (json) {
      io.out(JSON.stringify({ contract: SCHEMA_SET_CONTRACT, ok: false, file, pointer: canonicalPointer, written: false, failure: { code, message } }, null, 2));
    }
    io.err(plainLine(`${PROGRAM} schema set: ${message}`));
    return 1;
  };

  const resolved = resolveSchemaFile(root, file);
  if (!resolved.canonical.present) {
    return refuse("no-file", `${resolved.path}: no such file. schema set edits a declaration that exists and never creates one ('nen scaffold init' writes them); nothing was written.`);
  }
  // THE FILE WRITTEN IS THE REPOSITORY'S OWN: a declaration that is -- or has
  // become -- a link out of --repo is refused, never written through.
  const realRoot = resolvedOrSelf(root, undefined, platform);
  let realFile: string;
  try {
    realFile = realpathSync.native(resolved.path);
  } catch (error) {
    return refuse("file-changed", `${resolved.path} does not resolve (${errnoOf(error)}); nothing was written.`);
  }
  if (!containedOn(realRoot, realFile, platform)) {
    return refuse("outside-repo", `${resolved.path} resolves to ${realFile}, which is outside ${realRoot}. schema set edits only a declaration inside the repository; nothing was written.`);
  }
  const checked = readChecked(realFile);
  if (typeof checked === "string") return refuse("file-changed", `${realFile} ${checked}; nothing was written.`);
  const { text, stat } = checked;
  try {
    parseSchemaJsonText(resolved.path, text);
  } catch (error) {
    return refuse("not-json", `${error instanceof Error ? error.message : String(error)} Fix it by hand; nothing was written.`);
  }

  let edit: PointerEdit;
  try {
    edit = setJsonPointer(text, segments, value);
  } catch (error) {
    if (!(error instanceof JsonSpanError)) throw error;
    return refuse("refused-edit", `${resolved.path}: ${error.message}. Nothing was written.`);
  }

  // VALIDATED BY THE LOADER BEFORE THE DISK IS TOUCHED.
  try {
    row.validate(resolved.path, edit.text);
  } catch (error) {
    return refuse(
      "invalid",
      `${error instanceof Error ? error.message : String(error)} -- that is ${file} with ${canonicalPointer} set to ${show(edit.after)}, as its loader reads it; nothing was written.`,
    );
  }

  let written = false;
  if (edit.changed && !dryRun) {
    try {
      writeFileAtomic(checkedTarget(realFile, realRoot, platform, stat), edit.text);
    } catch (error) {
      const why = error instanceof TargetChangedError ? error.message : errnoOf(error);
      return refuse("write-failed", `${canonicalPointer} was not set; ${realFile} could not be replaced: ${why}.`);
    }
    written = true;
    // READ BACK THROUGH THE LOADER: the file loads, and the pointer reads the value asked for.
    let readBack: unknown;
    try {
      row.load(root);
      readBack = segments.reduce<unknown>(
        (node, segment): unknown => (Array.isArray(node) ? node[Number(segment)] : (node as Record<string, unknown>)[segment]),
        JSON.parse(readSchemaFile(root, file).text) as unknown,
      );
    } catch (error) {
      return refuse("read-back-mismatch", `${realFile} was written, but it no longer loads: ${error instanceof Error ? error.message : String(error)}. Inspect the file before committing it.`);
    }
    /* c8 ignore next 3 -- the splice was proved by a parse before the write */
    if (JSON.stringify(readBack) !== JSON.stringify(edit.after)) {
      return refuse("read-back-mismatch", `${realFile} was written, but ${canonicalPointer} now reads ${show(readBack)}, not ${show(edit.after)}. Inspect the file before committing it.`);
    }
  }

  if (json) {
    io.out(
      JSON.stringify(
        {
          contract: SCHEMA_SET_CONTRACT,
          ok: true,
          file,
          pointer: canonicalPointer,
          op: edit.op,
          // `before` is null for an `add` -- `op` says the member was absent.
          before: edit.before ?? null,
          after: edit.after,
          changed: edit.changed,
          dryRun,
          written,
          target: realFile,
          line: edit.line,
          failure: null,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const lines = [
    `file: ${file} (${realFile})`,
    `pointer: ${canonicalPointer} (line ${edit.line})`,
    `change: ${show(edit.before)} -> ${show(edit.after)}${edit.op === "add" ? " (added)" : edit.changed ? "" : " (unchanged)"}`,
    `validated: ${file}'s loader accepts the result`,
    !edit.changed
      ? `written: nothing (${canonicalPointer} is already ${show(edit.after)})`
      : dryRun
        ? `written: nothing (--dry-run); would write ${realFile}`
        : `written: ${realFile}, read back: ${canonicalPointer} is ${show(edit.after)}`,
  ];
  for (const line of lines) io.out(plainLine(line));
  return 0;
}
