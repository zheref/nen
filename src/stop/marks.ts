// src/stop/marks.ts -- one stop marker PER GATE (zheref/nen#513).
//
// THE GAP. `nen stop --mark` wrote one file, `.nen/last-stop.json`, so when
// several efforts of one unattended run reached their gates each write
// replaced the last, and a Stop hook could ring for the final gate only.
//
// THE SHAPE. Every mark ALSO writes `<git-common-dir>/.nen/marks/<effort>/<gate>.json`
// (../ledger/roots.json's `marks`), contract `nen.stop.mark/v0.3`: the v0.2 keys,
// every one present, plus `effort`. `<effort>` is the effort id percent-encoded by
// the one encoder (../ledger/effort.ts), or `_` for a stop named with no effort --
// `_` is outside the effort-id grammar, so it never collides with one. `<gate>` is
// the gate id, or `none` for a stop with no gate. Two marks for different gates, or
// for one gate of two efforts, are two files; a second mark of the SAME gate of the
// same effort replaces its own file only (that gate's latest stop).
//
// THE COMMON DIR, so a marker written in a worktree survives that worktree's
// removal (AC-4); outside git, `<--repo>/.nen/marks/`, the documented exception.
//
// BACKWARD COMPATIBLE. `.nen/last-stop.json` under --repo keeps being written
// byte-for-byte as before (v0.1, or v0.2 when the stop says more), and `stop show`
// keeps reading it, so a hook that reads only the single file sees nothing change
// (it still rings for the latest stop). `stop list` reads both, and lists the
// single file as `legacy` only when no per-gate marker is the same stop (same
// `at`, `gate` and `who`) -- a marker an older build wrote still reads.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative } from "node:path";
import { realContainment } from "../repo/contain.js";
import { encodeEffortId } from "../ledger/effort.js";
import { commonDirOrNull } from "../ledger/home.js";
import { writeLedgerAtomically } from "../ledger/lock.js";
import { MARKS_COMMON_SEGMENTS } from "../ledger/roots.js";
import type { Seams } from "../seam/exec.js";
import { MARKER_FILE, parseMarker } from "./marker.js";

/**
 * THE RUNG TWIN (Nobunaga on #516). A Stop hook that rings off the single file
 * and removes it (`rm -f .nen/last-stop.json`, as Hatsu's stop-bell does)
 * never consumes the per-gate twin. So every mark also records which per-gate
 * marker the single file currently twins, in `<marks>/.latest/<hash of the single file's path>.json` { path, at, single }, one per checkout.
 * When the single file is GONE and that marker still carries the same `at`, the
 * hook consumed it: `list` does not report it, and the next `--mark` removes
 * it. A single file that was REPLACED by a later mark consumed nothing, so the
 * earlier gates stay listed as unrung.
 */
export const LATEST_DIR = ".latest";

/** `nen.stop.list/v0.1` -- `nen stop list --json`'s document. */
export const STOP_LIST_CONTRACT = "nen.stop.list/v0.1";
/** The effort directory of a stop marked with no `--effort`. Outside the effort-id grammar. */
export const NO_EFFORT_DIR = "_";
/** The file of a stop marked with no `--gate`. */
export const NO_GATE_FILE = "none";

export interface MarksHome {
  /** Absolute `.nen/marks/` directory. */
  readonly dir: string;
  readonly durable: boolean;
}

/** Where the per-gate markers live for `root`: the git common dir, or `--repo` outside git. */
export function resolveMarksHome(root: string, seams: Pick<Seams, "run">): MarksHome {
  const common = commonDirOrNull(root, seams, "stop marker");
  return common === null ? { dir: join(root, ...MARKS_COMMON_SEGMENTS), durable: false } : { dir: join(common, ...MARKS_COMMON_SEGMENTS), durable: true };
}

/** `<marks>/<encoded effort | _>/<gate | none>.json`. */
export function gateMarkPath(home: MarksHome, effort: string | null, gate: string | null): string {
  return join(home.dir, effort === null ? NO_EFFORT_DIR : encodeEffortId(effort), `${gate ?? NO_GATE_FILE}.json`);
}

/** Write one per-gate marker atomically, creating its directory. */
export function writeGateMark(path: string, document: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeLedgerAtomically(path, document);
}

export interface ListedMark {
  /** `gate` for a per-gate marker, `legacy` for the single `.nen/last-stop.json` with no per-gate twin. */
  readonly source: "gate" | "legacy";
  readonly path: string;
  readonly contract: string;
  readonly gate: string | null;
  readonly effort: string | null;
  readonly who: string | null;
  readonly at: string;
  readonly title: string | null;
}

export interface MarkList {
  readonly marks: readonly ListedMark[];
  /** Files that exist and could not be read as a marker: never skipped, never "nothing found". */
  readonly unreadable: readonly { readonly path: string; readonly reason: string }[];
}

function readMarker(path: string): { ok: true; marker: Record<string, unknown> } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, reason: `not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  return parseMarker(parsed);
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function listed(source: ListedMark["source"], path: string, m: Record<string, unknown>): ListedMark {
  return { source, path, contract: String(m["contract"]), gate: text(m["gate"]), effort: text(m["effort"]), who: text(m["who"]), at: String(m["at"]), title: text(m["title"]) };
}

/** True when the two markers record one stop: the single file is that stop's twin. */
export function sameStop(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a["at"] === b["at"] && a["gate"] === b["gate"] && a["who"] === b["who"];
}

/** Every per-gate marker under `home`, plus the single legacy marker under `root` when no per-gate marker is the same stop; oldest first. */
export function listMarks(home: MarksHome, root: string): MarkList {
  const marks: ListedMark[] = [];
  const unreadable: { path: string; reason: string }[] = [];
  const documents: Record<string, unknown>[] = [];
  const entries = (dir: string): string[] => {
    try {
      return readdirSync(dir).sort();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && !existsSync(dir)) return [];
      unreadable.push({ path: dir, reason: `could not read the directory (${code ?? String(error)})` });
      return [];
    }
  };
  const rung = new Set(rungTwins(home));
  for (const effortDir of entries(home.dir)) {
    if (effortDir.startsWith(".")) continue;
    const directory = join(home.dir, effortDir);
    if (!lstatSync(directory).isDirectory()) {
      unreadable.push({ path: directory, reason: "not a directory" });
      continue;
    }
    for (const name of entries(directory)) {
      if (!name.endsWith(".json")) continue;
      const path = join(directory, name);
      const verdict = readMarker(path);
      if (!verdict.ok) {
        unreadable.push({ path, reason: verdict.reason });
        continue;
      }
      if (rung.has(path)) continue;
      documents.push(verdict.marker);
      marks.push(listed("gate", path, verdict.marker));
    }
  }
  const legacy = join(root, ...MARKER_FILE.split("/"));
  if (existsSync(legacy)) {
    const verdict = readMarker(legacy);
    if (!verdict.ok) unreadable.push({ path: legacy, reason: verdict.reason });
    else if (!documents.some((document): boolean => sameStop(document, verdict.marker))) marks.push(listed("legacy", legacy, verdict.marker));
  }
  marks.sort((a, b): number => Date.parse(a.at) - Date.parse(b.at));
  return { marks, unreadable };
}

/** Remove `path` when it exists; true when it did. */
export function removeIfPresent(path: string): boolean {
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Every per-gate marker that is the same stop as `legacy` (normally one, or none). */
export function twinsOf(home: MarksHome, root: string, legacy: Record<string, unknown>): string[] {
  const list = listMarks(home, root);
  return list.marks
    .filter((mark): boolean => mark.source === "gate" && mark.at === legacy["at"] && mark.gate === text(legacy["gate"]) && mark.who === text(legacy["who"]))
    .map((mark): string => mark.path);
}

/** The single legacy marker under `root`, parsed, or null when absent or unreadable. */
export function readLegacy(root: string): Record<string, unknown> | null {
  const path = join(root, ...MARKER_FILE.split("/"));
  if (!existsSync(path)) return null;
  const verdict = readMarker(path);
  return verdict.ok ? verdict.marker : null;
}

/** One pointer file per checkout's single file, so worktrees marking in turn never overwrite each other's twin. */
export function latestPath(home: MarksHome, single: string): string {
  return join(home.dir, LATEST_DIR, `${createHash("sha256").update(single).digest("hex").slice(0, 32)}.json`);
}

/**
 * Every per-gate marker whose single file a hook consumed: a pointer under
 * `<marks>/.latest/` whose single file is gone while its `.nen` directory still
 * exists (a removed worktree, or a `.nen` a `git clean` removed, consumed
 * nothing), and whose marker still carries the pointer's `at`. A pointer path
 * that does not really sit under `<marks>` -- a `..` segment, a link out -- is
 * ignored, never deleted (Nobunaga on #516, SEC-7).
 */
export function rungTwins(home: MarksHome): readonly string[] {
  const dir = join(home.dir, LATEST_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name): boolean => name.endsWith(".json"));
  } catch {
    return [];
  }
  const rung: string[] = [];
  for (const name of names) {
    let pointer: { path?: unknown; at?: unknown; single?: unknown };
    try {
      pointer = JSON.parse(readFileSync(join(dir, name), "utf8")) as { path?: unknown; at?: unknown; single?: unknown };
    } catch {
      continue;
    }
    if (typeof pointer.path !== "string" || typeof pointer.at !== "string" || typeof pointer.single !== "string") continue;
    const rel = relative(home.dir, pointer.path);
    if (rel === "" || isAbsolute(rel) || rel.split(/[\\/]/).some((segment): boolean => segment === ".." || segment === "") || rel.startsWith(LATEST_DIR)) continue;
    if (!realContainment(home.dir, pointer.path).contained || !existsSync(pointer.path)) continue;
    if (!existsSync(dirname(pointer.single)) || existsSync(pointer.single)) continue;
    const verdict = readMarker(pointer.path);
    if (verdict.ok && verdict.marker["at"] === pointer.at) rung.push(pointer.path);
  }
  return rung;
}

/** Record which per-gate marker this checkout's single file now twins. */
export function writeLatest(home: MarksHome, path: string, at: string, single: string): void {
  writeLedgerAtomically(latestPath(home, single), { path, at, single });
}
