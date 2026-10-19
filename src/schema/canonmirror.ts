// src/schema/canonmirror.ts -- the `nen schema check` row that asks whether a
// consumer's generated `.claude/rules/` mirror still agrees with the bindings
// in its `.claude/canon-values.yml` (zheref/nen#262).
//
// WHY A SCHEMA ROW AND NOT ANOTHER `canon mirror check`. That verb compares a
// committed mirror with a fresh rendering of the canon at its pin, so it needs
// a checkout of the handbooks repository -- CI has one, a local loop often has
// not. Observed on a consumer: a session rebound `SNAPSHOT_OS` 26.5 -> 27.0,
// `schema check` said every file was ok, and three mirror files still asserted
// 26.5 until CI's drift check failed the pull request. This row is the half of
// that comparison that needs only the two local files and the repository's own
// history, so it can run in every warm-up.
//
// WHAT IT CAN AND CANNOT KNOW. The mirror carries no token names: generation
// replaces `{{TOKEN}}` with its value, so a mirror line says `27.0`, never
// `SNAPSHOT_OS`. And the bindings file says only what a token is bound to NOW.
// "A binding that moved" is a fact about time, so the earlier values come from
// git: every committed revision of `.claude/canon-values.yml` (up to
// HISTORY_LIMIT), each parsed with the same reader `canon mirror generate`
// uses. A value a token held in any of them and does not hold now is a
// SUPERSEDED value of that token.
//
// A BLUNT SUBSTRING SWEEP FOR SUPERSEDED VALUES WOULD BE WRONG (the issue's
// first caveat): `26.5` may sit in an example for reasons unrelated to the
// token. So a superseded value FAILs only where the token is evidently what put
// it there, which is one of two shapes:
//
//   * STALE -- the token's bound value occurs NOWHERE in the mirror while a
//     superseded value of it does. A mirror generated after the rebind would
//     carry the new value wherever the canon writes the token, so its total
//     absence beside the old one says the mirror predates the rebind. Every
//     file carrying the old value is named.
//   * BESIDE -- the bound value DOES occur, and on some line a superseded value
//     occurs next to it (or next to the token's own name, where the canon
//     spells it out). This is the issue's second caveat, the hardcoded column:
//     a placeholder table whose token column was substituted and whose value
//     column was not reads `| 27.0 | 26.5 |`, which a mirror-vs-generator drift
//     check accepts, because the generator does produce it. It is named by
//     line, and the remedy says the canon itself carries the old value.
//
// Anything else -- a superseded value on a line of its own, in a mirror that
// does carry the bound value -- is the unrelated occurrence the caveat
// describes and is not a finding.
//
// THREE MORE GUARDS AGAINST A FALSE FAIL. A superseded value that is the
// CURRENT value of any token is skipped: it may be that token's substitution,
// and nothing here can say whose it is. A value is matched as a whole literal
// (MATCH below), so `26.5` is not found in `26.5.1`, `v26.5` or `126.5`. And
// only files carrying nen's own canon marker are read: a consumer's
// hand-written rule beside the mirror is its own and was never generated from
// these bindings.
//
// HONESTY ABOUT THE CHECK THAT DID NOT RUN. No `.claude/canon-values.yml` is
// an `ok` row reading `absent (optional)` -- a repository that never adopted a
// canon mirror. A history git cannot read (not a repository, git missing) is a
// `warn` row reading `NOT CHECKED`, never an `ok`: no superseded value is known,
// so no comparison was made, and an unperformed check is not a clean one.
//
// THE ONE ROW THAT SPAWNS. Every other `schema check` row is a file read. This
// one runs git, through the seam, and only when the bindings file is present
// and at least one generated mirror file exists -- a repository without a
// canon mirror still costs no subprocess.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCanonValues, readFileMarker } from "../canon/mirror.js";
import { GIT, type Runner } from "../seam/exec.js";
import { findSurface } from "../surface/rules.js";
import type { SchemaCheck } from "./taxonomy.js";

/** The bindings file, repository-relative. The consumer convention #262 names. */
export const CANON_VALUES_FILE = ".claude/canon-values.yml";

/** The surface whose mirror sits beside the bindings file. */
const MIRROR_SURFACE = "claude-code";

/** The most recent revisions of the bindings file read for superseded values. */
export const HISTORY_LIMIT = 100;

/** The closing remedy every FAIL carries (CON-13: the mirror is generated, never hand-edited). */
export const REGENERATE_REMEDY = "Regenerate the mirror (nen canon mirror generate); never hand-edit it (CON-13).";

/** Added when any finding is BESIDE: a value that survives a regenerate there is in the canon itself. */
export const HARDCODED_REMEDY =
  "A superseded value that survives a regenerate beside its token is hardcoded in the canon itself -- fix it there, then regenerate.";

/** The mirror's location, from the surface row rather than a second literal. */
export function mirrorDir(): string {
  const rule = findSurface(MIRROR_SURFACE)?.canonMirror;
  if (rule === undefined || rule === null || rule.kind !== "directory") {
    throw new Error(`surface '${MIRROR_SURFACE}' documents no directory canon mirror`);
  }
  return rule.dir;
}

// ---------------------------------------------------------------------------
// Matching a value as a whole literal
// ---------------------------------------------------------------------------

const WORD = /[A-Za-z0-9_]/;
const ALNUM = /[A-Za-z0-9]/;

/**
 * Whether `line` has a boundary just before `index`: the start, or a character
 * that is not a word character and is not a `.`/`-` glued to one. `v26.5`,
 * `126.5` and `1.26.5` therefore do not contain `26.5`; `(26.5)`, `` `26.5` ``
 * and `| 26.5 |` do.
 */
function leftBoundary(line: string, index: number): boolean {
  if (index === 0) return true;
  const before = line[index - 1] ?? "";
  if (WORD.test(before)) return false;
  if ((before === "." || before === "-") && ALNUM.test(line[index - 2] ?? "")) return false;
  return true;
}

/** The mirror image of leftBoundary: `26.5.1` and `26.5x` do not end in `26.5`; `26.5.` at a sentence end does. */
function rightBoundary(line: string, end: number): boolean {
  if (end === line.length) return true;
  const after = line[end] ?? "";
  if (WORD.test(after)) return false;
  if ((after === "." || after === "-") && ALNUM.test(line[end + 1] ?? "")) return false;
  return true;
}

/** Every start offset at which `value` occurs in `line` as a whole literal. */
export function literalOccurrences(line: string, value: string): readonly number[] {
  if (value === "") return [];
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = line.indexOf(value, from);
    if (index === -1) return found;
    if (leftBoundary(line, index) && rightBoundary(line, index + value.length)) found.push(index);
    from = index + 1;
  }
}

function hasTokenName(line: string, token: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(line);
}

// ---------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------

export interface MirrorFile {
  /** The file's name inside the mirror directory, e.g. `07-testing.md`. */
  readonly name: string;
  readonly text: string;
}

export interface MirrorFinding {
  readonly token: string;
  /** The value the token is bound to now. */
  readonly bound: string;
  /** The value it was bound to in an earlier revision, still in the mirror. */
  readonly superseded: string;
  /** See the module header. */
  readonly kind: "stale" | "beside";
  /** File names (stale) or `file:line` (beside), in mirror order. */
  readonly sites: readonly string[];
}

/** A mirror line nen wrote as its own marker: never a site of a binding. */
function isMarkerLine(line: string): boolean {
  return line.startsWith("<!-- GENERATED by nen canon mirror") || line.startsWith("<!-- BEGIN GENERATED by nen canon mirror") || line.startsWith("<!-- END GENERATED by nen canon mirror") || line.startsWith("<!-- canon: ");
}

function contentLines(text: string): readonly string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Every superseded value the mirror still carries where its token put it.
 *
 * `bound` is the current bindings; `history` maps a token to every value it
 * held in an earlier revision (the current one may be among them and is
 * skipped). Pure: the caller reads the files and the history.
 */
export function findMirrorFindings(
  bound: Readonly<Record<string, string>>,
  history: ReadonlyMap<string, ReadonlySet<string>>,
  files: readonly MirrorFile[],
): readonly MirrorFinding[] {
  const current = new Set(Object.values(bound));
  const lines = files.map((file): { readonly name: string; readonly lines: readonly string[] } => ({
    name: file.name,
    lines: contentLines(file.text).map((line): string => (isMarkerLine(line) ? "" : line)),
  }));
  const findings: MirrorFinding[] = [];
  for (const token of Object.keys(bound).sort()) {
    const value = bound[token] ?? "";
    const earlier = [...(history.get(token) ?? new Set<string>())]
      .filter((old): boolean => old.trim() !== "" && old !== value && !current.has(old))
      .sort();
    if (earlier.length === 0) continue;
    // An empty bound value cannot be looked for, so its absence proves nothing:
    // only the BESIDE shape, keyed on the token's own name, is judged for it.
    const boundPresent =
      value === "" || lines.some((file): boolean => file.lines.some((line): boolean => literalOccurrences(line, value).length > 0));
    for (const old of earlier) {
      if (!boundPresent) {
        const carrying = lines.filter((file): boolean => file.lines.some((line): boolean => literalOccurrences(line, old).length > 0));
        if (carrying.length > 0) {
          findings.push({ token, bound: value, superseded: old, kind: "stale", sites: carrying.map((file): string => file.name) });
        }
        continue;
      }
      const sites: string[] = [];
      for (const file of lines) {
        file.lines.forEach((line, index): void => {
          const olds = literalOccurrences(line, old);
          if (olds.length === 0) return;
          const spans = literalOccurrences(line, value).map((start): readonly [number, number] => [start, start + value.length]);
          // An old-value occurrence INSIDE a bound-value one is the bound value, not a second literal.
          const apart = olds.some((start): boolean => spans.every(([from, to]): boolean => start + old.length <= from || start >= to));
          if (!apart) return;
          if (spans.length > 0 || hasTokenName(line, token)) sites.push(`${file.name}:${index + 1}`);
        });
      }
      if (sites.length > 0) findings.push({ token, bound: value, superseded: old, kind: "beside", sites });
    }
  }
  return findings;
}

/** One finding as a clause of the row's detail. */
export function describeFinding(finding: MirrorFinding): string {
  const count = finding.sites.length;
  return finding.kind === "stale"
    ? `${finding.token} is bound to '${finding.bound}' but ${count} file(s) still carry '${finding.superseded}': ${finding.sites.join(", ")}`
    : `${finding.token} is bound to '${finding.bound}' but ${count} line(s) still carry '${finding.superseded}' beside it: ${finding.sites.join(", ")}`;
}

// ---------------------------------------------------------------------------
// Reading: the bindings, the mirror, the history
// ---------------------------------------------------------------------------

type Read = { readonly kind: "text"; readonly text: string } | { readonly kind: "absent" } | { readonly kind: "error"; readonly reason: string };

/**
 * A regular file's text, refusing anything else before opening it: a FIFO
 * read can wait forever for a writer, and a symbolic link is not a file this
 * check owns. The descriptor is re-checked after the open, as the stop-marker
 * row does, for a swap between the two.
 */
function readRegular(path: string): Read {
  try {
    if (!lstatSync(path).isFile()) return { kind: "error", reason: "not a regular file" };
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return { kind: "error", reason: "not a regular file" };
      return { kind: "text", text: readFileSync(fd, "utf8") };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "error", reason: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/** The generated files in the mirror directory: immediate `.md` children carrying nen's canon marker. */
function readMirror(root: string, dir: string): { readonly files: readonly MirrorFile[]; readonly error: string | null } {
  let names: readonly string[];
  try {
    names = readdirSync(join(root, ...dir.split("/"))).filter((name): boolean => name.endsWith(".md")).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { files: [], error: null };
    return { files: [], error: `${dir}/ could not be listed: ${code ?? String(error)}` };
  }
  const files: MirrorFile[] = [];
  for (const name of names) {
    const read = readRegular(join(root, ...dir.split("/"), name));
    // A symbolic link, a directory named *.md or an unreadable entry is not a
    // file nen generated: the generator writes regular files only.
    if (read.kind !== "text") continue;
    if (readFileMarker(read.text) === null) continue;
    files.push({ name, text: read.text });
  }
  return { files, error: null };
}

export type ValueHistory =
  | { readonly available: true; readonly revisions: number; readonly capped: boolean; readonly values: ReadonlyMap<string, ReadonlySet<string>> }
  | { readonly available: false; readonly reason: string };

function firstLine(text: string): string {
  return text.replace(/\r\n/g, "\n").trim().split("\n")[0] ?? "";
}

/**
 * Every value each token held in a committed revision of the bindings file,
 * newest HISTORY_LIMIT revisions first. `git cat-file blob` reads each one raw
 * -- no textconv, no external diff driver, nothing a repository's own config
 * can substitute for the bytes.
 */
export function readValueHistory(run: Runner | undefined, root: string): ValueHistory {
  if (run === undefined) return { available: false, reason: "no subprocess seam was given" };
  const log = run(GIT, ["log", `--max-count=${HISTORY_LIMIT}`, "--format=%H", "--no-show-signature", "--", CANON_VALUES_FILE], { cwd: root });
  if (log.spawnFailed) return { available: false, reason: "git could not be started" };
  if (log.code !== 0) return { available: false, reason: `git log exited ${log.code}: ${firstLine(log.stderr)}` };
  const shas = log.stdout.split("\n").map((line): string => line.trim()).filter((line): boolean => /^[0-9a-f]{40,64}$/.test(line));
  const values = new Map<string, Set<string>>();
  for (const sha of shas) {
    const blob = run(GIT, ["cat-file", "blob", `${sha}:./${CANON_VALUES_FILE}`], { cwd: root });
    if (blob.spawnFailed) return { available: false, reason: "git could not be started" };
    // A revision that deleted the file is listed by `git log` too; it holds no binding.
    if (blob.code !== 0) continue;
    for (const [token, value] of Object.entries(parseCanonValues(blob.stdout).values)) {
      const seen = values.get(token) ?? new Set<string>();
      seen.add(value);
      values.set(token, seen);
    }
  }
  return { available: true, revisions: shas.length, capped: shas.length >= HISTORY_LIMIT, values };
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** The row's `file`: the mirror directory, as the issue's sketch prints it. */
export function mirrorRowFile(): string {
  return `${mirrorDir()}/`;
}

export function canonMirrorCheck(root: string, run: Runner | undefined): SchemaCheck {
  const dir = mirrorDir();
  const file = `${dir}/`;
  const path = join(root, ...dir.split("/"));
  const row = (ok: boolean, required: boolean, detail: string): SchemaCheck => ({ file, path, ok, detail, required, legacy: false, note: null });

  const valuesRead = readRegular(join(root, ...CANON_VALUES_FILE.split("/")));
  if (valuesRead.kind === "absent") return row(true, false, `absent (optional): no ${CANON_VALUES_FILE}`);
  if (valuesRead.kind === "error") return row(false, true, `could not read ${CANON_VALUES_FILE}: ${valuesRead.reason}`);
  const bound = parseCanonValues(valuesRead.text).values;
  const tokens = Object.keys(bound).length;

  const mirror = readMirror(root, dir);
  if (mirror.error !== null) return row(false, true, mirror.error);
  if (mirror.files.length === 0) {
    return row(true, false, `no generated mirror under ${file} (no file carries nen's canon marker); nothing to compare against ${CANON_VALUES_FILE} (${tokens} tokens)`);
  }
  const counts = `${tokens} tokens, ${mirror.files.length} files`;

  const history = readValueHistory(run, root);
  if (!history.available) {
    return row(false, false, `NOT CHECKED -- ${CANON_VALUES_FILE} has no readable git history (${history.reason}), so no superseded value is known (${counts})`);
  }
  const findings = findMirrorFindings(bound, history.values, mirror.files);
  const revisions = `${history.revisions}${history.capped ? " (the most recent)" : ""} revision(s) read`;
  if (findings.length === 0) {
    return row(true, false, `mirror consistent with ${CANON_VALUES_FILE} (${counts}, ${revisions})`);
  }
  const remedy = findings.some((finding): boolean => finding.kind === "beside") ? `${REGENERATE_REMEDY} ${HARDCODED_REMEDY}` : REGENERATE_REMEDY;
  return row(false, true, `${findings.map(describeFinding).join("; ")}. ${remedy}`);
}
