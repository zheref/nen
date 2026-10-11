// src/schema/set.ts -- `nen schema set`: write ONE value into a declaration
// file, validated by that file's own loader before anything is written
// (zheref/nen#338).
//
// THE EDIT IS ../edit/json-pointer.ts's: an existing scalar replaced in place
// by a scalar, or a member added to an existing object in that object's own
// style, every other byte of the file -- its formatting, its key order, its
// other members, its `$`-prefixed notes -- left as it was, and the splice
// proved by a parse. A pointer through a `$`-prefixed segment, or through an
// empty one, is refused: a `$` key is metadata (./declarations.ts), and
// metadata is the author's, never this verb's.
//
// THE RESULT IS VALIDATED FIRST. The ORIGINAL text goes through the loader's
// own parse (`Declaration.validate`) so a failure that was already there is
// named as such; then the edited text does, before the disk is touched. A
// result the loader refuses is refused here, at exit 1, with the loader's own
// message and nothing written -- and an edit that REPAIRS a failing file is
// allowed, and says so. The two models are then compared
// (`canonicalModel`): an edit no loader reads -- a key nen keeps verbatim but
// acts on nowhere -- is reported as kept verbatim (`read: false`), never
// refused. After a write the file is read back through the loader itself.
//
// SOME POINTERS ARE A GATE CHANGE (Feitan F1). A validated one-liner can widen
// who approves a pull request or change what nen executes. The pointers that
// do are listed in `GATE_CHANGE_RULES`, and setting one needs `--gate-change`:
// without it the verb refuses at exit 2, naming the pointer and why; with it
// the report carries a `security-relevant:` line and `gateChange: true`.
//
// THE WRITE IS ../edit/atomic.ts's, shared with `canon pin --write`. The
// declaration must be a regular file -- never a symbolic link -- directly in
// `nen/`, which must not be a link either (Feitan F2); it is resolved to its
// real path, which must be inside the repository and directly inside the real
// `nen/`; read without following a final link, recording its identity; and
// replaced through a temporary file beside it, given the original's mode,
// after the identity and containment are checked again. A failure after the
// rename is reported as written (`read-back-mismatch`), never as nothing.

import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { containedOn, resolvedOrSelf, samePath } from "../canon/paths.js";
import type { ParsedArgs } from "../cli/args.js";
import { plainLine } from "../cli/plain.js";
import { checkedTarget, errnoOf, readChecked, TargetChangedError, writeFileAtomic, WrittenButUnverifiedError, type AtomicHooks } from "../edit/atomic.js";
import { formatPointer, JsonPointerSyntaxError, parsePointer, setJsonPointer, type PointerEdit } from "../edit/json-pointer.js";
import { JsonSpanError } from "../edit/json-span.js";
import { assertRepoRoot } from "../repo/root.js";
import { PROGRAM } from "../version.js";
import { canonicalModel, DECLARATIONS, declarationFor, isMetadataKey, METADATA_PREFIX } from "./declarations.js";
import { CONTRACT_FILE, GATES_FILE, parseSchemaJsonText, readSchemaFile, resolveSchemaFile } from "./source.js";
import { WORKFLOW_FILE } from "./workflow.js";

export const SCHEMA_SET_CONTRACT = "nen.schema.set/v0.1";

/** The flags `schema set` reads -- its own spec, not the pre-registry globals. */
export const SCHEMA_SET_FLAGS = {
  values: ["repo", "file", "pointer", "value"],
  booleans: ["json", "dry-run", "gate-change", "help"],
  aliases: { h: "help" },
} as const;

/** The JSON declarations `schema set` may edit, in row order. */
export const SETTABLE_FILES: readonly string[] = DECLARATIONS.filter((row): boolean => row.format === "json").map((row): string => row.file);

/**
 * One family of pointers that is a GATE CHANGE (Feitan F1). `prefix`: the
 * pointer starts with `path`, each step matching exactly, `*` any one step,
 * and `*<suffix>` any step ending in it. `segment`: any step of the pointer
 * is `path[0]`.
 */
export interface GateChangeRule {
  readonly file: string;
  readonly kind: "prefix" | "segment";
  readonly path: readonly string[];
  readonly reason: string;
}

const gates = (key: string, reason: string): GateChangeRule => ({ file: GATES_FILE, kind: "prefix", path: [key], reason });
const executes = (key: string, reason: string): GateChangeRule => ({ file: CONTRACT_FILE, kind: "segment", path: [key], reason });

/** The pointers `schema set` writes only under `--gate-change` -- the ONE table, documented in docs/USAGE.md. */
export const GATE_CHANGE_RULES: readonly GateChangeRule[] = [
  { file: GATES_FILE, kind: "prefix", path: ["reviewers", "*", "*_pattern"], reason: "a reviewer's login or check pattern decides whose review counts toward readiness" },
  gates("round_quorum", "the round quorum decides which reviewers' rounds readiness owes"),
  gates("round_policy", "the round policy decides how many review rounds readiness owes"),
  gates("approval_policy", "the approval policy decides what approval readiness needs"),
  gates("default_approvers", "the default approvers decide whose approval readiness needs"),
  gates("base_reviewers", "the base reviewers decide which reviews readiness owes"),
  gates("delivery", "the delivery block decides which pull requests take the delivery path"),
  gates("checks", "the checks block decides which failing checks readiness excuses"),
  executes("exe", "an exe is a program nen runs"),
  executes("argv", "an argv is a command line nen runs"),
  executes("env", "env is the environment nen runs a command in"),
  executes("onStall", "onStall decides what nen does to a stalled command"),
  executes("preconditions", "preconditions decide when nen runs a command"),
  executes("targets", "targets decide where nen deploys"),
  { file: WORKFLOW_FILE, kind: "prefix", path: ["branch", "base"], reason: "branch.base is the trunk every branch is cut from and every merge lands on" },
];

function stepMatches(pattern: string, step: string): boolean {
  if (pattern === "*") return true;
  if (pattern.startsWith("*")) return step.endsWith(pattern.slice(1));
  return pattern === step;
}

/** The rule that makes `segments` in `file` a gate change, or null. */
export function gateChangeRule(file: string, segments: readonly string[]): GateChangeRule | null {
  for (const rule of GATE_CHANGE_RULES) {
    if (rule.file !== file) continue;
    const hit =
      rule.kind === "segment"
        ? segments.includes(rule.path[0] ?? "")
        : rule.path.length <= segments.length && rule.path.every((pattern, index): boolean => stepMatches(pattern, segments[index] ?? ""));
    if (hit) return rule;
  }
  return null;
}

/** Thrown for an invocation `schema set` refuses before writing anything: exit 2. */
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

/**
 * The one value a `--value` names, as JSON. A number is written back in
 * JSON's own normalised spelling (`1.0` is written `1`, `1e2` is `100`); one
 * JSON cannot write back at all, or an integer that would not survive the
 * round trip, is refused.
 */
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
      throw new SchemaSetUsageError(`--value '${raw}' is an integer past 2^53; it would be written as ${JSON.stringify(value)}, a different number.`);
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
  if (segments.includes("")) {
    throw new SchemaSetUsageError(`--pointer '${pointer}' has an empty segment (a '//' or a trailing '/'), which names a member called "" -- never a declaration's key.`);
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run `nen schema set`. `args` is parsed against `SCHEMA_SET_FLAGS`; its
 * positionals are `schema set`. Returns the exit code: 0 set (or already
 * that value, or a dry run), 1 a refusal about the file or the value, 2 usage.
 * `hooks` is a test seam into the atomic write.
 */
export function runSchemaSet(args: ParsedArgs, repoFlag: string | null, json: boolean, io: SchemaSetIo, platform: NodeJS.Platform, hooks: AtomicHooks = {}): number {
  const fail = (text: string): number => {
    io.err(plainLine(`${PROGRAM} schema set: ${text}`));
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
  const gate = gateChangeRule(file, segments);
  if (gate !== null && !args.booleans.has("gate-change")) {
    return fail(`${file} ${canonicalPointer} is a gate change: ${gate.reason}. Setting it needs --gate-change, so the change is made on purpose and read as one.`);
  }
  const root = assertRepoRoot({ repoFlag });

  const refuse = (code: SchemaSetFailureCode, text: string, written = false): number => {
    if (json) {
      io.out(JSON.stringify({ contract: SCHEMA_SET_CONTRACT, ok: false, file, pointer: canonicalPointer, written, failure: { code, message: text } }, null, 2));
    }
    io.err(plainLine(`${PROGRAM} schema set: ${text}`));
    return 1;
  };

  const resolved = resolveSchemaFile(root, file);
  if (!resolved.canonical.present) {
    return refuse("no-file", `${resolved.path}: no such file. schema set edits a declaration that exists and never creates one ('nen scaffold init' writes them); nothing was written.`);
  }
  // A DECLARATION IS A REGULAR FILE DIRECTLY IN A REAL `nen/` (Feitan F2): a
  // link -- at the file or at `nen/` -- is refused, wherever it points.
  const nenDir = join(root, "nen");
  if (lstatSync(nenDir).isSymbolicLink()) return fail(`${nenDir} is a symbolic link; schema set writes only into a real nen/ directory. Nothing was written.`);
  if (lstatSync(resolved.path).isSymbolicLink()) return fail(`${resolved.path} is a symbolic link; schema set writes only a regular file, never through a link. Nothing was written.`);
  const realRoot = resolvedOrSelf(root, undefined, platform);
  let realFile: string;
  let realNen: string;
  try {
    realFile = realpathSync.native(resolved.path);
    realNen = realpathSync.native(nenDir);
  } catch (error) {
    return refuse("file-changed", `${resolved.path} does not resolve (${errnoOf(error)}); nothing was written.`);
  }
  if (!containedOn(realRoot, realFile, platform) || !samePath(dirname(realFile), realNen, platform)) {
    return refuse("outside-repo", `${resolved.path} resolves to ${realFile}, which is not directly in ${realNen} inside ${realRoot}. schema set edits only a declaration in the repository's own nen/; nothing was written.`);
  }
  const checked = readChecked(realFile);
  if (typeof checked === "string") return refuse("file-changed", `${realFile} ${checked}; nothing was written.`);
  const { text, stat } = checked;
  try {
    parseSchemaJsonText(resolved.path, text);
  } catch (error) {
    return refuse("not-json", `${messageOf(error)} Fix it by hand; nothing was written.`);
  }

  // THE ORIGINAL, THROUGH THE LOADER: a failure that is already there is named as one.
  let beforeModel: unknown = null;
  let alreadyFailing: string | null = null;
  try {
    beforeModel = row.validate(resolved.path, text);
  } catch (error) {
    alreadyFailing = messageOf(error);
  }

  let edit: PointerEdit;
  try {
    edit = setJsonPointer(text, segments, value);
  } catch (error) {
    if (!(error instanceof JsonSpanError)) throw error;
    return refuse("refused-edit", `${resolved.path}: ${error.message}. Nothing was written.`);
  }

  // VALIDATED BY THE LOADER BEFORE THE DISK IS TOUCHED.
  let afterModel: unknown;
  try {
    afterModel = row.validate(resolved.path, edit.text);
  } catch (error) {
    if (alreadyFailing !== null) {
      return refuse("invalid", `the file already fails its loader: ${alreadyFailing} -- and with ${canonicalPointer} set to ${show(edit.after)} it still does: ${messageOf(error)}; nothing was written.`);
    }
    return refuse("invalid", `${messageOf(error)} -- that is ${file} with ${canonicalPointer} set to ${show(edit.after)}, as its loader reads it; nothing was written.`);
  }
  // READ: whether the loader's model changes. A key kept verbatim is reported, never refused.
  const read = alreadyFailing !== null || JSON.stringify(canonicalModel(beforeModel, file)) !== JSON.stringify(canonicalModel(afterModel, file));

  let written = false;
  if (edit.changed && !dryRun) {
    try {
      writeFileAtomic(checkedTarget(realFile, realRoot, platform, stat), edit.text, hooks);
    } catch (error) {
      if (error instanceof WrittenButUnverifiedError) {
        return refuse("read-back-mismatch", `${canonicalPointer} WAS written, but ${error.message}. Inspect ${realFile} before committing it.`, true);
      }
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
      return refuse("read-back-mismatch", `${realFile} was written, but it does not read back: ${messageOf(error)}. Inspect the file before committing it.`, true);
    }
    /* c8 ignore next 3 -- the splice was proved by a parse before the write */
    if (JSON.stringify(readBack) !== JSON.stringify(edit.after)) {
      return refuse("read-back-mismatch", `${realFile} was written, but ${canonicalPointer} now reads ${show(readBack)}, not ${show(edit.after)}. Inspect the file before committing it.`, true);
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
          read,
          gateChange: gate !== null,
          repaired: alreadyFailing !== null,
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
    ...(gate === null ? [] : [`security-relevant: ${canonicalPointer} is a gate change -- ${gate.reason}`]),
    ...(alreadyFailing === null ? [] : [`repaired: the file failed its loader before this edit: ${alreadyFailing}`]),
    read ? `validated: ${file}'s loader accepts the result` : `kept verbatim -- no loader reads ${canonicalPointer}`,
    !edit.changed
      ? `written: nothing (${canonicalPointer} is already ${show(edit.after)})`
      : dryRun
        ? `written: nothing (--dry-run); would write ${realFile}`
        : `written: ${realFile}, read back: ${canonicalPointer} is ${show(edit.after)}`,
  ];
  for (const line of lines) io.out(plainLine(line));
  return 0;
}
