// src/run/record.ts -- `nen run record read|write`: a caller's resumable run
// record, validated against a schema shipped as data and kept under the
// caller's own XDG state directory (zheref/nen#493 AC-11; Hatsu
// docs/config/spec-repo.md § The run record, ports.md's discipline).
//
// A SECOND RECORD BESIDE THE MANIFEST, AND WHY. `run start|append|…` keep a
// batch run's manifest under the git common dir; a spec run spans a family's
// repositories and outlives any one checkout, so its record lives where its
// owner says -- `${XDG_STATE_HOME:-$HOME/.local/state}/<schema directory>/
// <run-id>.json` -- and nen only validates and stores it. Pointers, never
// truth: the caller recomputes its step from live state on resume.
//
// THE ORDER OF THE CHECKS IS THE CONTRACT. The run id is matched WHOLE against
// the schema's pattern (no newline, no partial match) BEFORE any path is
// built from it; the record's `schema`, `caller` and `runId` are checked
// before its fields; a write is the whole document to a temp file at 0600 in
// a 0700 directory, then a rename, never a partial file.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import specRun from "./schemas/spec-run.v0.1.json";

export const RUN_RECORD_CONTRACT = "nen.run.record/v0.1";

export type RecordVerdict = "valid" | "written" | "would-write" | "absent" | "invalid" | "could-not-read";

interface FieldRule {
  readonly kind: "string" | "string|null" | "string[]" | "object" | "object[]" | "integer";
  readonly enum?: readonly string[];
  readonly pattern?: string;
  /** An object's (or each object[] item's) keys, each with its own rule, every one required. */
  readonly row?: Readonly<Record<string, FieldRule>>;
}

export interface RecordSchema {
  readonly schema: string;
  readonly caller: string;
  readonly directory: string;
  readonly runId: string;
  readonly fields: Readonly<Record<string, FieldRule>>;
}

const SCHEMAS: readonly RecordSchema[] = [specRun as unknown as RecordSchema];
export const RECORD_SCHEMAS: readonly string[] = SCHEMAS.map((schema): string => schema.schema);

export function recordSchema(id: string): RecordSchema | null {
  return SCHEMAS.find((schema): boolean => schema.schema === id) ?? null;
}

/** The run id matched whole: no newline, no partial match (Python's re.fullmatch, in JavaScript). */
export function runIdMatches(schema: RecordSchema, id: string): boolean {
  if (/[\r\n]/.test(id)) return false;
  const match = new RegExp(schema.runId).exec(id);
  return match !== null && match.index === 0 && match[0] === id;
}

/** `${XDG_STATE_HOME:-$HOME/.local/state}`, absolute, or null with the reason. */
export function stateHome(env: Readonly<Record<string, string | undefined>>): { path: string | null; reason: string | null } {
  // The XDG spec: a relative XDG_STATE_HOME is invalid and is ignored -- the default applies (Nobunaga F10).
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return { path: xdg, reason: null };
  const home = env["HOME"];
  if (home === undefined || home === "" || !isAbsolute(home)) return { path: null, reason: `${xdg !== undefined && xdg !== "" ? `XDG_STATE_HOME '${xdg}' is not absolute and so is ignored, and ` : ""}no absolute HOME is set, so there is no state directory to keep the record in` };
  return { path: join(home, ".local", "state"), reason: null };
}

/** One value against its rule, every problem named by its path (Nobunaga F11: row values are typed, not only present). */
function validateValue(rule: FieldRule, value: unknown, where: string, problems: string[]): void {
  const isString = typeof value === "string";
  switch (rule.kind) {
    case "string":
      if (!isString) problems.push(`${where} is not a string`);
      break;
    case "string|null":
      if (!isString && value !== null) problems.push(`${where} is neither a string nor null`);
      break;
    case "integer":
      if (!Number.isSafeInteger(value) || (value as number) < 0) problems.push(`${where} is not a whole number`);
      break;
    case "string[]":
      if (!Array.isArray(value) || value.some((item): boolean => typeof item !== "string")) problems.push(`${where} is not a list of strings`);
      break;
    case "object":
    case "object[]": {
      const rows = rule.kind === "object" ? [value] : Array.isArray(value) ? value : null;
      if (rows === null) {
        problems.push(`${where} is not a list`);
        break;
      }
      rows.forEach((row, index): void => {
        const at = rule.kind === "object" ? where : `${where}[${index}]`;
        if (row === null || typeof row !== "object" || Array.isArray(row)) {
          problems.push(`${at} is not an object`);
          return;
        }
        // A row holds its declared keys and no others (Nobunaga delta a3): an extra key is a typo or a field no
        // schema version admits, refused rather than stored unread.
        for (const key of Object.keys(row)) if (rule.row !== undefined && !Object.hasOwn(rule.row, key)) problems.push(`${at}.${key} is not a key of this row (${Object.keys(rule.row).join(", ")})`);
        for (const [key, inner] of Object.entries(rule.row ?? {})) {
          const entry = (row as Record<string, unknown>)[key];
          if (entry === undefined) problems.push(`${at}.${key} is missing`);
          else validateValue(inner, entry, `${at}.${key}`, problems);
        }
      });
      break;
    }
  }
  if (isString && rule.enum !== undefined && !rule.enum.includes(value)) problems.push(`${where} is ${JSON.stringify(value)}, not one of ${rule.enum.join(", ")}`);
  if (isString && rule.pattern !== undefined && !new RegExp(rule.pattern).test(value)) problems.push(`${where} ${JSON.stringify(value)} does not match ${rule.pattern}`);
}

/** Every way `value` fails the schema, by field; empty when it is a record of this schema for `id`. */
export function validateRecord(schema: RecordSchema, id: string, value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["the record is not a JSON object"];
  const record = value as Record<string, unknown>;
  if (record["schema"] !== schema.schema) return [`schema is ${JSON.stringify(record["schema"] ?? null)}, not ${schema.schema}; a record of another schema is refused`];
  if (record["caller"] !== schema.caller) return [`caller is ${JSON.stringify(record["caller"] ?? null)}, not ${schema.caller}; resume it with its own caller`];
  if (record["runId"] !== id) return [`runId is ${JSON.stringify(record["runId"] ?? null)}, not the file's ${id}`];
  const problems: string[] = [];
  for (const [name, rule] of Object.entries(schema.fields)) {
    const field = record[name];
    if (field === undefined) problems.push(`${name} is missing`);
    else validateValue(rule, field, name, problems);
  }
  return problems;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface RecordReport {
  readonly contract: string;
  readonly verdict: RecordVerdict;
  readonly schema: string;
  readonly id: string;
  readonly path: string | null;
  readonly problems: readonly string[];
  readonly record: unknown;
  readonly reason: string | null;
}

export interface RecordInput {
  readonly schema: RecordSchema;
  readonly id: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function locate(input: RecordInput): { path: string | null; dir: string | null; reason: string | null } {
  const home = stateHome(input.env);
  if (home.path === null) return { path: null, dir: null, reason: home.reason };
  const dir = join(home.path, input.schema.directory);
  return { dir, path: join(dir, `${input.id}.json`), reason: null };
}

/**
 * The first component of the record directory below the state home (the
 * schema's `directory`, e.g. `hatsu` then `hatsu/specs`) that is a link or not
 * a directory, by lstat; null when none is (absent components are fine). Every
 * component, not only the last: mkdir and chmod follow a linked ancestor
 * (Cursor Bugbot on NN-PR-#549).
 */
function irregularRecordDir(input: RecordInput, dir: string): string | null {
  const depth = input.schema.directory.split("/").filter((part): boolean => part !== "").length;
  const components: string[] = [];
  let at = dir;
  for (let i = 0; i < depth; i += 1) {
    components.unshift(at);
    at = dirname(at);
  }
  for (const component of components) {
    let entry;
    try {
      entry = lstatSync(component);
    } catch {
      return null;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return component;
  }
  return null;
}

export function readRecord(input: RecordInput): RecordReport {
  const make = (verdict: RecordVerdict, path: string | null, problems: readonly string[], record: unknown, reason: string | null): RecordReport => ({ contract: RUN_RECORD_CONTRACT, verdict, schema: input.schema.schema, id: input.id, path, problems, record, reason });
  const where = locate(input);
  if (where.path === null) return make("could-not-read", null, [], null, where.reason);
  // As the write refuses it (Feitan F2), a record directory that is a link or not a directory is never read through (zheref/nen#522 N8).
  const irregular = where.dir === null ? null : irregularRecordDir(input, where.dir);
  if (irregular !== null) return make("could-not-read", where.path, [], null, `${irregular} is not a real directory (a link or a file); nen reads no record through one`);
  if (!existsSync(where.path)) return make("absent", where.path, [], null, `no record for ${input.id}; a run never started is not a run with nothing recorded`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(where.path, "utf8"));
  } catch (error) {
    return make("could-not-read", where.path, [], null, `could not read ${where.path} as JSON: ${(error as Error).message}`);
  }
  const problems = validateRecord(input.schema, input.id, value);
  return make(problems.length === 0 ? "valid" : "invalid", where.path, problems, problems.length === 0 ? value : null, null);
}

export function writeRecord(input: RecordInput, value: unknown, dryRun: boolean): RecordReport {
  const make = (verdict: RecordVerdict, path: string | null, problems: readonly string[], record: unknown, reason: string | null): RecordReport => ({ contract: RUN_RECORD_CONTRACT, verdict, schema: input.schema.schema, id: input.id, path, problems, record, reason });
  const where = locate(input);
  if (where.path === null || where.dir === null) return make("could-not-read", null, [], null, where.reason);
  const problems = validateRecord(input.schema, input.id, value);
  if (problems.length > 0) return make("invalid", where.path, problems, null, "nothing was written");
  if (dryRun) return make("would-write", where.path, [], value, null);
  // Feitan F2 (SEC-2): the directory is a real directory this user owns, never a link followed; the
  // temp file is created exclusively at 0600, and any failure removes it and is reported, never thrown.
  const temp = `${where.path}.${process.pid}.tmp`;
  const irregular = irregularRecordDir(input, where.dir);
  if (irregular !== null) return make("could-not-read", where.path, [], null, `${irregular} is not a real directory (a link or a file); nen writes no record through one`);
  try {
    mkdirSync(where.dir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(where.dir);
    if (dir.isSymbolicLink() || !dir.isDirectory()) return make("could-not-read", where.path, [], null, `${where.dir} is not a real directory (a link or a file); nen writes no record through one`);
    if (typeof process.getuid === "function" && dir.uid !== process.getuid()) return make("could-not-read", where.path, [], null, `${where.dir} is owned by uid ${dir.uid}, not this user; nen writes no record into it`);
    if ((dir.mode & 0o077) !== 0) chmodSync(where.dir, 0o700);
    rmSync(temp, { force: true });
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, where.path);
  } catch (error) {
    rmSync(temp, { force: true });
    return make("could-not-read", where.path, [], null, `the record could not be written: ${(error as Error).message}`);
  }
  return make("written", where.path, [], value, null);
}

/** A record operation whose input could not be read. */
export function unreadableRecord(input: RecordInput, reason: string): RecordReport {
  return { contract: RUN_RECORD_CONTRACT, verdict: "could-not-read", schema: input.schema.schema, id: input.id, path: null, problems: [], record: null, reason };
}

export function renderRecord(report: RecordReport): string[] {
  const lines = [`${report.verdict}: ${report.schema} ${report.id}${report.path === null ? "" : ` -- ${report.path}`}`];
  if (report.reason !== null) lines.push(`  ${report.reason}`);
  for (const problem of report.problems) lines.push(`  ${problem}`);
  return lines;
}
