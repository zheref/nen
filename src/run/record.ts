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

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import specRun from "./schemas/spec-run.v0.1.json";

export const RUN_RECORD_CONTRACT = "nen.run.record/v0.1";

export type RecordVerdict = "valid" | "written" | "would-write" | "absent" | "invalid" | "could-not-read";

interface FieldRule {
  readonly kind: "string" | "string|null" | "string[]" | "object" | "object[]" | "integer";
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly keys?: readonly string[];
  readonly enumKey?: Readonly<Record<string, readonly string[]>>;
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
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "") return isAbsolute(xdg) ? { path: xdg, reason: null } : { path: null, reason: `XDG_STATE_HOME '${xdg}' is not absolute; the XDG spec says to ignore it, and nen will not guess a directory` };
  const home = env["HOME"];
  if (home === undefined || home === "" || !isAbsolute(home)) return { path: null, reason: "neither XDG_STATE_HOME nor an absolute HOME is set, so there is no state directory to keep the record in" };
  return { path: join(home, ".local", "state"), reason: null };
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
    const where = name;
    if (field === undefined) {
      problems.push(`${where} is missing`);
      continue;
    }
    const isString = typeof field === "string";
    switch (rule.kind) {
      case "string":
        if (!isString) problems.push(`${where} is not a string`);
        break;
      case "string|null":
        if (!isString && field !== null) problems.push(`${where} is neither a string nor null`);
        break;
      case "integer":
        if (!Number.isSafeInteger(field)) problems.push(`${where} is not a whole number`);
        break;
      case "string[]":
        if (!Array.isArray(field) || field.some((item): boolean => typeof item !== "string")) problems.push(`${where} is not a list of strings`);
        break;
      case "object":
      case "object[]": {
        const rows = rule.kind === "object" ? [field] : Array.isArray(field) ? field : null;
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
          for (const key of rule.keys ?? []) if (!Object.hasOwn(row, key)) problems.push(`${at}.${key} is missing`);
          for (const [key, allowed] of Object.entries(rule.enumKey ?? {})) {
            const entry = (row as Record<string, unknown>)[key];
            if (entry !== undefined && !allowed.includes(entry as string)) problems.push(`${at}.${key} is ${JSON.stringify(entry)}, not one of ${allowed.join(", ")}`);
          }
        });
        break;
      }
    }
    if (isString && rule.enum !== undefined && !rule.enum.includes(field)) problems.push(`${where} is ${JSON.stringify(field)}, not one of ${rule.enum.join(", ")}`);
    if (isString && rule.pattern !== undefined && !new RegExp(rule.pattern).test(field)) problems.push(`${where} ${JSON.stringify(field)} does not match ${rule.pattern}`);
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

export function readRecord(input: RecordInput): RecordReport {
  const make = (verdict: RecordVerdict, path: string | null, problems: readonly string[], record: unknown, reason: string | null): RecordReport => ({ contract: RUN_RECORD_CONTRACT, verdict, schema: input.schema.schema, id: input.id, path, problems, record, reason });
  const where = locate(input);
  if (where.path === null) return make("could-not-read", null, [], null, where.reason);
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
  mkdirSync(where.dir, { recursive: true, mode: 0o700 });
  if ((statSync(where.dir).mode & 0o077) !== 0) chmodSync(where.dir, 0o700);
  const temp = `${where.path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, where.path);
  return make("written", where.path, [], value, null);
}

export function renderRecord(report: RecordReport): string[] {
  const lines = [`${report.verdict}: ${report.schema} ${report.id}${report.path === null ? "" : ` -- ${report.path}`}`];
  if (report.reason !== null) lines.push(`  ${report.reason}`);
  for (const problem of report.problems) lines.push(`  ${problem}`);
  return lines;
}
