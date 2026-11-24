// src/phase/list.ts -- `nen phase list`: every effort that has a phase ledger,
// one row each (zheref/nen#583).
//
// WHY A VERB. A reader that shows other sessions' efforts (the Hatsu desk) had
// to list every `.json` file under `<git-common-dir>/.nen/phases/` itself and
// decode each file name back into an effort id: the encoding is nen's
// (../ledger/effort.ts), an older worktree-local copy that `show` still reads
// was missed, and the layout was re-implemented outside the tool that owns it.
//
// WHERE IT LOOKS. Exactly where `nen phase show` looks (../ledger/home.ts):
// the durable home (`<git-common-dir>/.nen/phases/`, or `<--repo>/.nen/phases/`
// outside git) and every checkout's older `.nen/phases/` that `git worktree
// list` names. An effort is listed ONCE. When it has a ledger in more than one
// of those places, `show` refuses it (exit 1) because nen will not choose which
// copy is the effort's record; this verb lists it once as `conflict`, names
// every copy, and reports no newest phase -- it does not choose either.
//
// THE NEWEST PHASE IS THE LAST ENTRY OF `phases[]`. That is the ledger's own
// ordering guarantee: `begin` is the only writer that adds an entry, and it
// appends (`[...phases, entry]`); `end`, `--resume` and a `shu` step append
// edit an entry in place and never reorder. A sort by `startedAt` would trust
// a clock the ledger never promised was monotonic.
//
// READ-ONLY, PROVABLY. `readdirSync`, `lstatSync` and `readFileSync` only --
// the read-mode half of the layout, never `locateEffortLedger(..., "write")`,
// no ledger lock (taking one creates `<ledger>.lock`), no directory created.
// A non-regular file is reported, never read through (SEC-7, as `show`).
//
// ONE BAD LEDGER IS ONE ROW (AC-3). Bad JSON, another contract, a newer one,
// an effort id the file name does not decode to, a file that cannot be read:
// each is a row marked `unreadable` with its file and a short reason, and the
// other rows still print at exit 0.

import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { plainLine } from "../cli/plain.js";
import { realContainment } from "../repo/contain.js";
import { encodeEffortId, isEffortId } from "../ledger/effort.js";
import type { EffortHome } from "../ledger/home.js";
import { PHASE_CONTRACT } from "./ledger.js";

export const PHASE_LIST_CONTRACT = "nen.phase.list/v0.1";

/** Which home a copy sits in: the common dir, --repo's own (outside git), or an older checkout-local one. */
export type PhaseLedgerLocation = "common-dir" | "repo" | "worktree";

export type PhaseListState = "ok" | "unreadable" | "conflict";

export interface PhaseListNewest {
  readonly phase: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
}

export interface PhaseListCopy {
  readonly path: string;
  readonly location: PhaseLedgerLocation;
  readonly modifiedAt: string | null;
}

export interface PhaseListRow {
  /** The decoded effort id; null only when the file name is not an encoded one. */
  readonly effort: string | null;
  /** The ledger's file name (`HA%2F85.json`), or the directory's name when a location could not be listed. */
  readonly file: string;
  /** The absolute path read. On a conflict, the first copy; `copies` names every one. */
  readonly path: string;
  /** Where it was read from; `multiple` on a conflict. */
  readonly location: PhaseLedgerLocation | "multiple";
  readonly state: PhaseListState;
  /** The file's modification time (ISO 8601); on a conflict, the newest copy's; null when it could not be stat'ed. */
  readonly modifiedAt: string | null;
  /** `phases.length`; null unless the ledger was read. */
  readonly phaseCount: number | null;
  /** The last entry of `phases[]`; null on an empty ledger, an unreadable one and a conflict. */
  readonly newest: PhaseListNewest | null;
  /** Why the row is unreadable or a conflict; null when it is ok. */
  readonly reason: string | null;
  /** Every copy of this effort's ledger: one when ok or unreadable, two or more on a conflict. */
  readonly copies: readonly PhaseListCopy[];
}

export interface PhaseListReport {
  readonly contract: typeof PHASE_LIST_CONTRACT;
  readonly repo: string;
  /** The durable home's display form: `<git-common-dir>/.nen/phases` or `.nen/phases`. */
  readonly home: string;
  /** Every directory looked in, durable home first. */
  readonly locations: readonly { readonly dir: string; readonly location: PhaseLedgerLocation }[];
  /** `--since` in minutes, or null. */
  readonly since: number | null;
  /** The instant the window is measured against (the seam's clock). */
  readonly now: string;
  readonly efforts: readonly PhaseListRow[];
}

/**
 * `--since <minutes>`: a whole number of minutes, at least 1. Anything else is a
 * usage refusal the caller raises (exit 2); null when the flag is absent.
 */
export function parseSinceMinutes(raw: string | undefined): number | null | { readonly refusal: string } {
  if (raw === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw.trim()))) {
    return { refusal: `--since takes a positive whole number of minutes; '${raw}' is not one.` };
  }
  return Number(raw.trim());
}

/**
 * The effort id a ledger file name encodes, or null when it encodes none. The
 * inverse of `encodeEffortId` ON ITS IMAGE ONLY: a name is accepted when it
 * decodes to an id under the one grammar AND that id encodes back to exactly
 * the same name, so `HA%2f85.json` (lower-case escape) or `HA%2D85.json` (an
 * escape the encoder never writes) is not silently read as `HA/85` / `HA-85`.
 */
export function decodeLedgerFileName(name: string): string | null {
  if (!name.endsWith(".json")) return null;
  const stem = name.slice(0, -".json".length);
  let effort: string;
  try {
    effort = decodeURIComponent(stem);
  } catch {
    return null;
  }
  if (!isEffortId(effort) || encodeEffortId(effort) !== stem) return null;
  return effort;
}

interface Copy {
  readonly effort: string | null;
  readonly file: string;
  readonly path: string;
  readonly location: PhaseLedgerLocation;
  readonly stats: Stats | null;
  /** Set when the copy cannot be read; the row is unreadable for this reason. */
  readonly problem: string | null;
}

const errno = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : String(error));

/** A path's real spelling when it resolves, else its resolved one; case-folded on Windows. */
function canonical(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * Whether `dir` (and the `.nen` above it) may be listed, as ../ledger/home.ts's
 * `legacyDirSafe` decides for `show`: absent is nothing to list (null), a real
 * directory is listed (true), anything else -- a symlink a checked-out head
 * could carry -- is a problem string, reported as a row and never followed.
 */
function directoryState(dir: string, checkParent: boolean): true | null | string {
  for (const path of checkParent ? [join(dir, ".."), dir] : [dir]) {
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      const code = errno(error);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      return `'${path}' could not be inspected (${code}); its ledgers were not listed`;
    }
    if (!stats.isDirectory()) {
      return `'${path}' is ${stats.isSymbolicLink() ? "a symbolic link" : "not a directory"}; a ledger directory is listed only when it is a real directory`;
    }
  }
  return true;
}

/** Every `.json` entry of one location, each lstat'ed; a location that cannot be listed is one problem copy. */
function copiesIn(dir: string, location: PhaseLedgerLocation, home: EffortHome): Copy[] {
  const isDurable = location !== "worktree";
  const state = directoryState(dir, !isDurable);
  if (state === null) return [];
  const asRow = (problem: string): Copy[] => [{ effort: null, file: dir.split(/[\\/]/).at(-1) ?? dir, path: dir, location, stats: null, problem }];
  if (state !== true) return asRow(state);
  if (isDurable) {
    // The durable home must really sit under its base (SEC-7, as `show`'s assertContained).
    const real = realContainment(home.base, dir);
    if (!real.contained) return asRow(`'${dir}' resolves to '${real.real}', outside ${home.durable ? "the git common directory" : "the repository (--repo)"}; its ledgers were not listed`);
  }
  let names: string[];
  try {
    names = readdirSync(dir).filter((name): boolean => name.endsWith(".json")).sort();
  } catch (error) {
    return asRow(`'${dir}' could not be listed (${errno(error)}); its ledgers were not listed`);
  }
  return names.map((file): Copy => {
    const path = join(dir, file);
    const effort = decodeLedgerFileName(file);
    let stats: Stats | null = null;
    let problem: string | null = null;
    try {
      stats = lstatSync(path);
      if (!stats.isFile()) problem = `${stats.isSymbolicLink() ? "a symbolic link" : "not a regular file"}; a ledger is only ever a plain file nen wrote, so it is not read`;
    } catch (error) {
      problem = `could not be inspected (${errno(error)})`;
    }
    if (problem === null && effort === null) problem = "the file name is not an encoded effort id";
    return { effort, file, path, location, stats, problem };
  });
}

/** `major.minor` of a `nen.phase.ledger/v<major>[.<minor>]` contract, or null for any other contract. */
function ledgerVersion(contract: string): readonly [number, number] | null {
  const match = /^nen\.phase\.ledger\/v(\d+)(?:\.(\d+))?$/.exec(contract);
  return match === null ? null : [Number(match[1]), Number(match[2] ?? "0")];
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

/** The ledger's facts, or the short reason it cannot be read. */
function readCopy(copy: Copy): { readonly phaseCount: number; readonly newest: PhaseListNewest | null } | { readonly reason: string } {
  let text: string;
  try {
    text = readFileSync(copy.path, "utf8");
  } catch (error) {
    return { reason: `could not be read (${errno(error)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "not readable JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { reason: "not a JSON object" };
  const doc = parsed as { contract?: unknown; effort?: unknown; phases?: unknown };
  if (doc.contract !== PHASE_CONTRACT) {
    const ours = ledgerVersion(PHASE_CONTRACT) as readonly [number, number];
    const theirs = typeof doc.contract === "string" ? ledgerVersion(doc.contract) : null;
    if (theirs !== null && (theirs[0] > ours[0] || (theirs[0] === ours[0] && theirs[1] > ours[1]))) {
      return { reason: `written under the newer contract '${doc.contract as string}'; this build reads '${PHASE_CONTRACT}'` };
    }
    return { reason: `does not carry contract '${PHASE_CONTRACT}'` };
  }
  if (typeof doc.effort !== "string") return { reason: "carries no effort id" };
  if (doc.effort !== copy.effort) return { reason: `names effort '${doc.effort}', but its file name decodes to '${copy.effort ?? ""}'` };
  if (!Array.isArray(doc.phases)) return { reason: "'phases' is not an array" };
  const last: unknown = doc.phases.at(-1);
  if (last === undefined) return { phaseCount: 0, newest: null };
  const entry = last as Record<string, unknown> | null;
  if (
    typeof entry !== "object" ||
    entry === null ||
    typeof entry["phase"] !== "string" ||
    typeof entry["startedAt"] !== "string" ||
    !isNullableString(entry["endedAt"] ?? null) ||
    !(entry["exitCode"] === undefined || entry["exitCode"] === null || typeof entry["exitCode"] === "number")
  ) {
    return { reason: "its newest phase entry is not a phase entry" };
  }
  return {
    phaseCount: doc.phases.length,
    newest: {
      phase: entry["phase"],
      startedAt: entry["startedAt"],
      endedAt: (entry["endedAt"] as string | null | undefined) ?? null,
      exitCode: (entry["exitCode"] as number | null | undefined) ?? null,
    },
  };
}

const iso = (stats: Stats | null): string | null => (stats === null ? null : stats.mtime.toISOString());

function rowOf(copies: readonly Copy[]): PhaseListRow {
  const first = copies[0] as Copy;
  const listed: PhaseListCopy[] = copies.map((copy): PhaseListCopy => ({ path: copy.path, location: copy.location, modifiedAt: iso(copy.stats) }));
  // KEY ORDER IS THE DOCUMENTED ONE (docs/USAGE.md § nen phase list): built in that order, never spread.
  const row = (location: PhaseListRow["location"], state: PhaseListState, modifiedAt: string | null, phaseCount: number | null, newest: PhaseListNewest | null, reason: string | null): PhaseListRow => ({
    effort: first.effort,
    file: first.file,
    path: first.path,
    location,
    state,
    modifiedAt,
    phaseCount,
    newest,
    reason,
    copies: listed,
  });
  if (copies.length > 1) {
    const newestMtime = copies.map((copy): string | null => iso(copy.stats)).filter((value): value is string => value !== null).sort().at(-1) ?? null;
    return row("multiple", "conflict", newestMtime, null, null, `a phase ledger in ${copies.length} places (${copies.map((copy): string => copy.path).join(", ")}); nen will not choose which is the effort's record, and 'nen phase show' refuses it -- keep the common-dir copy and move the others aside`);
  }
  const modifiedAt = iso(first.stats);
  if (first.problem !== null) return row(first.location, "unreadable", modifiedAt, null, null, first.problem);
  const read = readCopy(first);
  if ("reason" in read) return row(first.location, "unreadable", modifiedAt, null, null, read.reason);
  return row(first.location, "ok", modifiedAt, read.phaseCount, read.newest, null);
}

/** Newest modification first; ties (and an unknown time, sorted last) by effort id, then by path. */
function compareRows(a: PhaseListRow, b: PhaseListRow): number {
  const am = a.modifiedAt ?? "";
  const bm = b.modifiedAt ?? "";
  if (am !== bm) return am > bm ? -1 : 1;
  const ae = a.effort ?? "";
  const be = b.effort ?? "";
  if (ae !== be) return ae < be ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Every effort with a phase ledger in `home`'s locations, one row each, newest
 * modification first. `since` (minutes) keeps a row only when `now - mtime` is
 * at most that window; a row whose time could not be read is kept, because it
 * cannot be proven outside the window. Reads only.
 */
export function listPhaseLedgers(root: string, home: EffortHome, now: Date, since: number | null): PhaseListReport {
  const locations: { dir: string; location: PhaseLedgerLocation }[] = [{ dir: home.dir, location: home.durable ? "common-dir" : "repo" }];
  for (const dir of home.legacyDirs) {
    if (!locations.some((known): boolean => canonical(known.dir) === canonical(dir))) locations.push({ dir, location: "worktree" });
  }
  const byKey = new Map<string, Copy[]>();
  for (const { dir, location } of locations) {
    for (const copy of copiesIn(dir, location, home)) {
      // An undecodable name or an unlistable directory has no effort to group by: keyed by its path, so it stays its own row.
      const key = copy.effort === null ? `path:${copy.path}` : `effort:${copy.effort}`;
      byKey.set(key, [...(byKey.get(key) ?? []), copy]);
    }
  }
  const windowMs = since === null ? null : since * 60_000;
  const efforts = [...byKey.values()]
    .map(rowOf)
    .filter((row): boolean => windowMs === null || row.modifiedAt === null || now.getTime() - Date.parse(row.modifiedAt) <= windowMs)
    .sort(compareRows);
  return { contract: PHASE_LIST_CONTRACT, repo: root, home: home.display, locations, since, now: now.toISOString(), efforts };
}

/** One aligned line per effort; an empty list says so. */
export function renderPhaseList(report: PhaseListReport): string[] {
  const window = report.since === null ? "" : ` modified in the last ${report.since} min`;
  if (report.efforts.length === 0) return [`no phase ledgers${window} under ${report.home} (${report.locations.length} location${report.locations.length === 1 ? "" : "s"} looked in)`];
  const label = (row: PhaseListRow): string => plainLine(row.effort ?? row.file);
  const width = Math.max(...report.efforts.map((row): number => label(row).length));
  const lines = [`${report.efforts.length} effort${report.efforts.length === 1 ? "" : "s"} with a phase ledger${window} under ${report.home}:`];
  for (const row of report.efforts) {
    const modified = row.modifiedAt ?? "unknown mtime".padEnd(24);
    let detail: string;
    if (row.state === "unreadable") detail = `UNREADABLE ${plainLine(row.file)}: ${plainLine(row.reason ?? "")}`;
    else if (row.state === "conflict") detail = `CONFLICT   in ${row.copies.length} places: ${row.copies.map((copy): string => plainLine(copy.path)).join(", ")} -- 'phase show' refuses it`;
    else if (row.newest === null) detail = "no phase entries";
    else {
      const n = row.newest;
      const state = n.endedAt === null ? "open" : `ended ${n.endedAt}${n.exitCode === null ? "" : ` exit ${n.exitCode}`}`;
      detail = `${plainLine(n.phase)}  started ${n.startedAt}  ${state}`;
    }
    const where = row.location === "worktree" ? `  (older worktree-local: ${plainLine(row.path)})` : "";
    lines.push(`  ${label(row).padEnd(width)}  ${modified}  ${detail}${where}`);
  }
  return lines;
}
