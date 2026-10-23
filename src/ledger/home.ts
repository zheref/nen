// src/ledger/home.ts -- WHERE a per-effort ledger lives (zheref/nen#509), and
// how one an older build left inside a worktree is found rather than lost.
//
// THE GAP THIS CLOSES. `nen phase`, `nen usage`, `nen session` and `nen direct
// resolve --record` wrote `<--repo>/.nen/<family>/<effort>.json`. An effort runs
// in a linked worktree, cleanup removes the worktree, and the effort's history
// went with it: a resumed effort found no phases, no spend, no model pick. The
// loop ledger, the stop-answer records and the run manifest had already moved to
// `<git-common-dir>/.nen/` (./roots.json, nen's one common-dir root); these four
// ledgers move there too, so every worktree of a repository reads one record and
// no `git worktree remove` touches it.
//
// OUTSIDE GIT, `--repo`'S OWN `.nen/<family>/` IS THE ONLY HOME, the loop
// ledger's documented exception (#509 AC-5). A git that cannot be run, or that
// refuses for any reason other than "not a git repository", is a refusal at
// exit 2 -- falling back there would split one effort's record across two homes.
//
// AN OLDER LEDGER IS NEVER SHADOWED BY AN EMPTY NEW ONE (#509 AC-4). Every
// checkout `git worktree list` names is asked for `.nen/<family>/<id>.json`.
// A READ names the old path it read from and moves nothing; a WRITE moves the
// file into the common dir first (one rename, reported as `migratedFrom`).
// Two copies -- the durable one and an old one, or two old ones -- are refused
// at exit 1 naming every path: nen does not choose which record is the effort.
// A move the filesystem refuses (another device) is exit 1 with the `mv` line.
// The fallback is read through the 0.28 line and removed in 0.29.0.

import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { GIT, type Seams } from "../seam/exec.js";
import { encodeEffortId } from "./effort.js";
import { withLedgerLock } from "./lock.js";
import {
  DIRECT_COMMON_SEGMENTS,
  EFFORT_WORKTREE_LEGACY,
  PHASES_COMMON_SEGMENTS,
  SESSIONS_COMMON_SEGMENTS,
  USAGE_COMMON_SEGMENTS,
} from "./roots.js";

export type EffortFamily = "phases" | "usage" | "sessions" | "direct";

/** Each family's directory under the git common dir (./roots.json). */
export const EFFORT_COMMON_SEGMENTS: Readonly<Record<EffortFamily, readonly string[]>> = {
  phases: PHASES_COMMON_SEGMENTS,
  usage: USAGE_COMMON_SEGMENTS,
  sessions: SESSIONS_COMMON_SEGMENTS,
  direct: DIRECT_COMMON_SEGMENTS,
};

/** The release that drops the worktree-local read fallback (#509: one minor of fallback). */
export const WORKTREE_LEGACY_REMOVED_IN = "0.29.0";

export interface EffortHome {
  readonly family: EffortFamily;
  /** Absolute directory this family's ledgers live in. */
  readonly dir: string;
  /** True when `dir` is under the git common directory. */
  readonly durable: boolean;
  /** The directory every ledger path must really stay under: the common dir, or --repo outside git. */
  readonly base: string;
  /** The display form of `dir`: `<git-common-dir>/.nen/<family>` or `.nen/<family>`. */
  readonly display: string;
  /** Every worktree-local `.nen/<family>/` an older build could have written to. Empty outside git. */
  readonly legacyDirs: readonly string[];
}

export class LedgerHomeError extends Error {}

const GIT_ENV = { LC_ALL: "C", LANGUAGE: undefined, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined };
const NOT_A_REPOSITORY = /not a git repository/i;

/**
 * `root`'s git common directory, absolute, or null when `root` is not inside a
 * git repository. Any other failure is a refusal (exit 2), never null.
 */
export function commonDirOrNull(root: string, seams: Pick<Seams, "run">, what: string): string | null {
  // Asked IN `root` (cwd), not with `-C`, so a scripted test answers one argv for every root.
  const result = seams.run(GIT, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, env: GIT_ENV });
  if (result.spawnFailed) {
    throw new VerbUsageError(`git could not be run to find the common directory under '${root}', so the ${what}'s durable home is unknown. Refusing rather than writing a worktree-local record a cleanup would lose.`);
  }
  if (result.code !== 0) {
    if (NOT_A_REPOSITORY.test(result.stderr)) return null;
    const detail = result.stderr.trim().split(/\r?\n/)[0] ?? "";
    throw new VerbUsageError(`git rev-parse --git-common-dir failed under '${root}' (exit ${result.code}${detail === "" ? "" : `: ${detail}`}). Refusing rather than falling back to a worktree-local ${what}: one effort's record in two homes is a record that loses half its history.`);
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  const line = lines[0] ?? "";
  if (lines.length !== 1 || line === "") {
    throw new VerbUsageError(`git rev-parse --git-common-dir under '${root}' answered something that is not one path (${JSON.stringify(result.stdout)}). Refusing rather than guessing the ${what}'s home.`);
  }
  return isAbsolute(line) ? line : resolve(root, line);
}

/** Every checkout of the repository, `root` first; a list git cannot produce is a refusal. */
function checkouts(root: string, seams: Pick<Seams, "run">): string[] {
  const result = seams.run(GIT, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain", "-z"], { cwd: root, env: GIT_ENV });
  if (result.spawnFailed || result.code !== 0) {
    throw new VerbUsageError(`git worktree list failed under '${root}' (exit ${result.code}). Refusing rather than assuming no other checkout holds an older build's ledger: missing one would start the effort's history again.`);
  }
  const roots = [root];
  for (const entry of result.stdout.split("\0")) {
    if (!entry.startsWith("worktree ")) continue;
    const checkout = entry.slice("worktree ".length);
    if (!roots.some((known): boolean => canonical(known) === canonical(checkout))) roots.push(checkout);
  }
  return roots;
}

/** The home of `family`'s ledgers for the resolved `--repo` `root`. */
export function resolveEffortHome(root: string, family: EffortFamily, seams: Pick<Seams, "run">, options: { readonly legacy?: boolean } = {}): EffortHome {
  const local = join(root, ...EFFORT_WORKTREE_LEGACY[family]);
  const common = commonDirOrNull(root, seams, `${family} ledger`);
  if (common === null) {
    return { family, dir: local, durable: false, base: root, display: EFFORT_WORKTREE_LEGACY[family].join("/"), legacyDirs: [] };
  }
  return {
    family,
    dir: join(common, ...EFFORT_COMMON_SEGMENTS[family]),
    durable: true,
    base: common,
    display: `<git-common-dir>/${EFFORT_COMMON_SEGMENTS[family].join("/")}`,
    // A reader that lists the directory itself (`nen report data`) asks for no legacy scan.
    legacyDirs: options.legacy === false ? [] : checkouts(root, seams).map((checkout): string => join(checkout, ...EFFORT_WORKTREE_LEGACY[family])),
  };
}

/** A home with no git behind it: `<root>/.nen/<family>/`. For a caller that has no seams and must not spawn. */
export function localEffortHome(root: string, family: EffortFamily): EffortHome {
  return { family, dir: join(root, ...EFFORT_WORKTREE_LEGACY[family]), durable: false, base: root, display: EFFORT_WORKTREE_LEGACY[family].join("/"), legacyDirs: [] };
}

export interface LocatedLedger {
  /** The path to read or write. On a read that found only an old copy, the old path. */
  readonly path: string;
  /** The durable path this effort's ledger belongs at. */
  readonly home: string;
  /** Set on a read served from a worktree-local copy an older build left. */
  readonly legacy: string | null;
  /** Set on a write that first moved a worktree-local copy into the common dir. */
  readonly migratedFrom: string | null;
}

/** The ledger file name for `effort` in `home`. */
export function effortLedgerPath(home: EffortHome, effort: string): string {
  return join(home.dir, `${encodeEffortId(effort)}.json`);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new LedgerHomeError(`'${path}' could not be inspected (${code ?? String(error)}). Could not read is never nothing found.`);
  }
}

/**
 * Where `effort`'s ledger is, for a read or a write -- the header's rules.
 * `mode: "read"` never moves a byte; `mode: "write"` moves an old copy first.
 */
export function locateEffortLedger(home: EffortHome, effort: string, mode: "read" | "write"): LocatedLedger {
  const path = effortLedgerPath(home, effort);
  const name = `${encodeEffortId(effort)}.json`;
  const old: string[] = [];
  for (const dir of home.legacyDirs) {
    const candidate = join(dir, name);
    if (exists(candidate) && !old.some((known): boolean => canonical(known) === canonical(candidate))) old.push(candidate);
  }
  if (old.length === 0) return { path, home: path, legacy: null, migratedFrom: null };
  const durable = exists(path);
  if (durable || old.length > 1) {
    throw new LedgerHomeError(
      `effort '${effort}' has a ${home.family} ledger in more than one place (${[...(durable ? [path] : []), ...old].join(", ")}); nen will not choose which is the effort's record. Keep one -- the durable one is ${path} -- and move the others aside.`,
    );
  }
  const from = old[0] as string;
  if (mode === "read") return { path: from, home: path, legacy: from, migratedFrom: null };
  return withLedgerLock(path, (): LocatedLedger => {
    if (existsSync(path)) throw new LedgerHomeError(`effort '${effort}''s ledger appeared at ${path} while ${from} was being moved there; nen will not choose which is the record.`);
    mkdirSync(dirname(path), { recursive: true });
    try {
      renameSync(from, path);
    } catch (error) {
      throw new LedgerHomeError(
        `effort '${effort}' has an older ${home.family} ledger at ${from} that could not be moved to ${path} (${(error as NodeJS.ErrnoException).code ?? String(error)}). Move it once by hand -- mv '${from}' '${path}' -- and run again; nothing was written.`,
      );
    }
    return { path, home: path, legacy: null, migratedFrom: from };
  });
}

/** The line a verb prints when the ledger it touched came from an older home. */
export function legacyLine(located: LocatedLedger): string | null {
  if (located.migratedFrom !== null) return `moved the older worktree-local ledger ${located.migratedFrom} -> ${located.path} (the fallback is removed in ${WORKTREE_LEGACY_REMOVED_IN}).`;
  if (located.legacy !== null) return `read the older worktree-local ledger ${located.legacy}; the next write moves it to ${located.home} (the fallback is removed in ${WORKTREE_LEGACY_REMOVED_IN}).`;
  return null;
}

/** A path's real spelling when it exists, else its resolved one; case-folded on Windows. */
function canonical(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}
