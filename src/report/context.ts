// src/report/context.ts -- where the effort IS, derived: the worktree, the
// stage and its gate, the turn, and the local clock (zheref/nen#258).
//
// THESE WERE PROSE. Hatsu's report page shows every one of these values every
// turn (its docs/WORKFLOW.md § "Where the effort is" and § "Report time"), and
// until this module each was derived by a model from `git rev-parse`, this
// verb's own `phases[]`, `nen pr ready` and a plugin shell script for the
// clock. Every deterministic step is a nen verb; these are deterministic, so
// they are this verb's.
//
// EVERY FIELD IS `null` WITH ITS REASON ON STDERR WHEN IT CANNOT BE DERIVED,
// on ./data.ts's own rule -- and never a guess. A stage read from a PR nobody
// could match to this branch, a gate for a repository the registry does not
// list, a zone the host cannot name: each is `null`, and the line on stderr
// says which of those it was. What IS refused is a flag the caller typed that
// cannot mean anything (`--tz Mars/Olympus`): exit 2, by name, the family's
// rule for every malformed flag.
//
// IT READS AND NEVER WRITES, like the rest of `report data`: two or three
// `git rev-parse` reads, the zoneinfo file the zone names (four bytes of it),
// and `nen/repos.json` when the stage needs a gate.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { roleOf } from "../repo/classify.js";
import { isContained } from "../repo/contain.js";
import { rawLines } from "../seam/lines.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import type { ReportPhase } from "./data.js";
import type { ReportObject, PrObject } from "./objects.js";

export type PrLookup = "none" | "prs" | "backlog" | "issues-only" | "file";

/** The six stages of Hatsu's WORKFLOW.md table, in its order. */
export type EffortStage = "authoring" | "published" | "in review" | "ready" | "blocked" | "landed";

/**
 * KEY ORDER IS THE CONTRACT; ./context.test.ts pins it. These keys are
 * APPENDED after `objects` on the data path, and after the register keys under
 * `--register` (where the desk's own `gate` and `generatedAtLocal` keep their
 * places -- see ./command.ts).
 */
export interface ReportContext {
  /** The checkout's directory name in a linked worktree, `"core"` in the main one. */
  readonly worktree: string | null;
  readonly effortStage: EffortStage | null;
  readonly gate: string | null;
  readonly stageClass: "info" | "warn" | "red" | "ok" | null;
  /** The count of `report` phase entries this effort's ledger holds. */
  readonly turnNumber: number | null;
  /** `Tue 22 Sep 2026 · 14:05 America/Bogota (UTC-05:00)` */
  readonly generatedAtLocal: string | null;
  /** `2026-09-22` -- the date a dated report's file name carries. */
  readonly generatedDateLocal: string | null;
  readonly timeZone: string | null;
}

export interface ContextInput {
  /** `--repo`'s root. */
  readonly root: string;
  /** `owner/name`, or null (./data.ts already said why). */
  readonly repo: string | null;
  /** null on a detached HEAD. */
  readonly branch: string | null;
  readonly phases: readonly ReportPhase[];
  readonly objects: readonly ReportObject[];
  /**
   * How pull requests were looked for: not at all; `--prs <n>`; `--backlog`
   * (OPEN ones only); `--issues` alone (none); or an `--objects-from` file.
   */
  readonly prLookup: PrLookup;
  /** `--open-stop`: a G5 stop is open this turn. The only way to `blocked`. */
  readonly openStop: boolean;
}

// ── the stage table ─────────────────────────────────────────────────────────

/**
 * Hatsu's docs/WORKFLOW.md § "Where the effort is", as data. `gate` is a
 * template: `{G}` is the repository's own declaration gate (G2 for a consumer,
 * G4 for canon, from `nen/repos.json` -- ../repo/classify.ts's rule), and only
 * the two stages that carry one need the registry at all.
 */
const STAGES: Readonly<Record<EffortStage, { readonly gate: string; readonly stageClass: ReportContext["stageClass"] }>> = {
  authoring: { gate: "none — local", stageClass: "info" },
  published: { gate: "none — pushed", stageClass: "info" },
  "in review": { gate: "{G} — pending", stageClass: "warn" },
  ready: { gate: "{G} — yours", stageClass: "red" },
  blocked: { gate: "G5 — yours", stageClass: "red" },
  landed: { gate: "none — landed", stageClass: "ok" },
};

function gitRead(seams: Seams, root: string, args: readonly string[]): { ok: boolean; code: number | null; stdout: string; why: string } {
  const result = seams.run(GIT, [...args], { cwd: root });
  if (result.spawnFailed) return { ok: false, code: null, stdout: "", why: `git could not be started: ${result.stderr}` };
  return {
    ok: result.code === 0,
    code: result.code,
    stdout: result.stdout,
    why: outputLines(result.stderr).join(" ") || `exit ${result.code}`,
  };
}

/**
 * `worktree`: the checkout's directory name when `--git-dir` and
 * `--git-common-dir` differ (a linked worktree), else `"core"`.
 *
 * ONE READ, THREE ANSWERS, ALL ABSOLUTE: `--path-format=absolute` makes git
 * print both directories the same way, so the comparison is between two
 * spellings git chose rather than between `.git` and an absolute path. The
 * name is the TOP LEVEL's, not `--repo`'s -- a `--repo` pointing into a
 * subdirectory still names the worktree it is in -- and it is a name, never a
 * path (./data.ts's rule for `repo`: this document is pasted into PRs).
 */
export function readWorktree(seams: Seams, root: string, warn: (line: string) => void): string | null {
  const read = gitRead(seams, root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
  // RAW LINES, NOT outputLines (Copilot, NN-PR-#375): a path is data, and a
  // directory whose name ends in a space is still that directory.
  const lines = rawLines(read.stdout);
  const [gitDir, commonDir, top] = lines;
  if (!read.ok || gitDir === undefined || commonDir === undefined || top === undefined) {
    warn(`worktree: could not read this checkout's git directories ('git rev-parse --git-dir --git-common-dir' ${read.ok ? "printed too little" : `failed: ${read.why}`}); reported as null.`);
    return null;
  }
  return trimSlash(gitDir) === trimSlash(commonDir) ? "core" : basename(trimSlash(top));
}

function trimSlash(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/**
 * `refs/remotes/origin/<branch>`'s commit; null when the branch is not on
 * origin; or the reason the probe itself FAILED (Copilot, NN-PR-#375).
 *
 * ONLY EXIT 1 MEANS ABSENT. `rev-parse --verify --quiet` answers 1, silently,
 * for a ref that does not exist; git that cannot start, or a repository it
 * cannot read (exit 128), has said nothing about the ref -- and reading that
 * as "not on origin" would derive `authoring` from a failure.
 */
function originTip(seams: Seams, root: string, branch: string): { readonly sha: string | null } | { readonly why: string } {
  const read = gitRead(seams, root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  if (read.ok) return { sha: outputLines(read.stdout)[0] ?? null };
  if (read.code === 1) return { sha: null };
  return { why: `whether origin/${branch} exists could not be read ('git rev-parse --verify refs/remotes/origin/${branch}' failed: ${read.why})` };
}

/**
 * THE EFFORT'S PULL REQUEST is the PR row whose head is this branch's commit --
 * HEAD's, or `origin/<branch>`'s when HEAD has moved past what was pushed.
 *
 * MATCHED BY HEAD, NEVER BY "THE ONLY PR IN SCOPE": a `--backlog` register
 * with one open pull request in it is not a statement that that pull request
 * is this branch's. And a PR IN SCOPE THAT MATCHES NEITHER HEAD is not "no
 * pull request" either (Nobunaga N1): it may be this branch's PR seen through a
 * stale `origin/<branch>`, or one whose head moved on GitHub. Every answer
 * that is not exactly one match is a reason, and the stage is null.
 */
function effortPr(
  prs: readonly PrObject[],
  head: string | null,
  pushed: string | null,
  branch: string,
  lookup: PrLookup,
): { readonly pr: PrObject } | { readonly why: string } {
  const heads = [head, pushed].filter((sha): sha is string => sha !== null);
  const matches = prs.filter((pr): boolean => pr.head !== "" && heads.includes(pr.head));
  if (matches.length === 1) return { pr: matches[0] as PrObject };
  const numbers = (rows: readonly PrObject[]): string => rows.map((pr): string => `#${pr.number}`).join(", ");
  if (matches.length > 1) {
    return { why: `${matches.length} pull requests in scope (${numbers(matches)}) have this branch's head, so which one is this effort's is not one answer` };
  }
  const unread = prs.filter((pr): boolean => pr.head === "");
  if (unread.length > 0) {
    return { why: `pull request ${numbers(unread)} has a head that could not be read, so it cannot be ruled out as this branch's` };
  }
  const where = `HEAD ${head ?? "(unreadable)"}, origin/${branch} ${pushed ?? "(not on origin)"}`;
  return {
    why:
      lookup === "backlog"
        ? `no PR row matched this branch: none of the ${prs.length} open pull request(s) --backlog read (${numbers(prs)}) has its head at ${where} -- fetch, or the PR's head moved`
        : `pull request ${numbers(prs)} is in scope and its head matches neither ${where} -- fetch, or the PR's head moved`,
  };
}

/** The declaration gate for `repo`, from `--repo`'s registry, or null with the reason. */
function declarationGate(root: string, repo: string | null): { readonly gate: "G2" | "G4" } | { readonly why: string } {
  if (repo === null) return { why: "this checkout has no owner/name (see 'repo:' above), so its role is not known" };
  try {
    const { role } = roleOf(loadRepoRegistry(root), repo);
    if (role === "canon") return { gate: "G4" };
    if (role === "consumer") return { gate: "G2" };
    return { why: `'${repo}' is not in this checkout's nen/repos.json, so whether its gate is G2 or G4 is not derived -- register it rather than inferring` };
  } catch (error) {
    return { why: `no readable nen/repos.json to read '${repo}''s role from (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * `effortStage`, `gate`, `stageClass` -- the documented table, row by row.
 *
 * `blocked` IS THE CALLER'S WORD AND NOTHING ELSE'S. Whether a G5 stop is open
 * this turn is a fact about the conversation, not the repository; a
 * `.nen/last-stop.json` on disk records a stop that may long since have been
 * answered. So only `--open-stop` reaches it.
 */
export function deriveStage(
  seams: Seams,
  input: ContextInput,
  warn: (line: string) => void,
): Pick<ReportContext, "effortStage" | "gate" | "stageClass"> {
  const none = { effortStage: null, gate: null, stageClass: null };
  const fail = (why: string): Pick<ReportContext, "effortStage" | "gate" | "stageClass"> => {
    warn(`effortStage: ${why}; effortStage, gate and stageClass reported as null.`);
    return none;
  };
  if (input.openStop) return stageRow("blocked", null);
  if (input.branch === null) return fail("HEAD is detached, so there is no branch whose stage to read");
  const tip = originTip(seams, input.root, input.branch);
  if ("why" in tip) return fail(tip.why);
  const pushed = tip.sha;
  const prs = input.objects.filter((object): object is PrObject => object.kind === "pr");

  if (prs.length === 0) {
    // NO PULL REQUEST ROW. That proves "no PR" only for a branch that is not
    // on origin (a PR needs a pushed head); for one that is, no lookup this
    // verb makes is exhaustive -- `--backlog` reads OPEN pull requests, and a
    // merged one is not among them -- so the stage is not derived (N2).
    const reason =
      input.prLookup === "backlog"
        ? "no PR row matched this branch (--backlog reads OPEN pull requests only, and none is open)"
        : input.prLookup === "issues-only"
          ? "no PR row matched this branch (--issues reads no pull request)"
          : "no pull request was looked for — pass --target <owner/name> --prs <n>";
    if (pushed === null) {
      warn(`effortStage: 'authoring' is read from origin alone: ${reason}.`);
      return stageRow("authoring", null);
    }
    return fail(`origin/${input.branch} exists and ${reason}`);
  }

  const headRead = gitRead(seams, input.root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const head = headRead.ok ? (outputLines(headRead.stdout)[0] ?? null) : null;
  const found = effortPr(prs, head, pushed, input.branch, input.prLookup);
  if ("why" in found) return fail(found.why);
  const pr = found.pr;
  if (head !== null && pr.head !== head) {
    warn(`effortStage: pull request #${pr.number}'s head ${pr.head} is origin/${input.branch}, not HEAD ${head} -- the stage describes what was pushed, and this checkout has moved on.`);
  }
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return stageRow("landed", null);
  if (state !== "OPEN") {
    return fail(`pull request #${pr.number} is ${pr.state === "" ? "in an unreadable state" : `'${pr.state}'`}, which no stage in the table describes (closed without merging is not 'landed')`);
  }
  if (pr.readiness === null) {
    // NOT 'in review' (N5): an unread verdict has said nothing, and 'in
    // review' is the statement that it said "not ready".
    return fail(`pull request #${pr.number}'s readiness was not read (its notes say why), so whether it is 'ready' or 'in review' is not known`);
  }
  const stage: EffortStage = pr.readiness.verdict === "ready" ? "ready" : "in review";
  const gate = declarationGate(input.root, input.repo);
  if ("why" in gate) {
    warn(`gate: ${gate.why}; reported as null.`);
    return { effortStage: stage, gate: null, stageClass: STAGES[stage].stageClass };
  }
  return stageRow(stage, gate.gate);
}

function stageRow(stage: EffortStage, declaration: string | null): Pick<ReportContext, "effortStage" | "gate" | "stageClass"> {
  const row = STAGES[stage];
  return { effortStage: stage, gate: row.gate.replace("{G}", declaration ?? "{G}"), stageClass: row.stageClass };
}

// ── the turn ────────────────────────────────────────────────────────────────

/**
 * `turnNumber`: how many `report` phase entries THIS BRANCH'S ledger holds --
 * the ledger whose effort id is the branch's name, and no other (N3). A lone
 * ledger under another id is another effort's turns, however likely it looks;
 * no ledger, a detached HEAD, or no `report` entry is `null` ("Turn 0" is not
 * a turn).
 */
export function deriveTurn(phases: readonly ReportPhase[], branch: string | null, warn: (line: string) => void): number | null {
  if (branch === null) {
    warn("turnNumber: HEAD is detached, so there is no branch whose ledger to count; reported as null.");
    return null;
  }
  const mine = phases.filter((phase): boolean => phase.effort === branch);
  if (mine.length === 0) {
    warn(`turnNumber: no .nen/phases/ ledger has the effort id '${branch}' (this branch's name; 'nen phase begin --effort ${branch} --phase report' records one per turn); reported as null.`);
    return null;
  }
  const turns = mine.filter((phase): boolean => phase.phase === "report").length;
  if (turns === 0) {
    warn(`turnNumber: the '${branch}' ledger records no 'report' phase; reported as null.`);
    return null;
  }
  return turns;
}

// ── the local clock ─────────────────────────────────────────────────────────

/** The zoneinfo directories searched when `$TZDIR` does not name one -- libc's own order. */
export const ZONEINFO_DIRS: readonly string[] = ["/usr/share/zoneinfo", "/var/db/timezone/zoneinfo", "/usr/lib/zoneinfo"];

/** The zones that need no database: the C library answers them itself. */
const BUILTIN_ZONES = new Set(["UTC", "Etc/UTC"]);

/** A name that addresses a path rather than a zone, never looked up at all. */
function pathShaped(zone: string): boolean {
  return zone === "" || zone.startsWith("/") || zone.includes("\\") || zone.split("/").includes("..") || /^[A-Za-z]:/.test(zone);
}

/**
 * Whether `zone` is a COMPILED zone in this host's zoneinfo database: a
 * REGULAR file whose first four bytes are `TZif`.
 *
 * THE MAGIC, NOT THE FILE'S PRESENCE. The database directory also holds
 * tables and metadata (`zone.tab`, `tzdata.zi`, `+VERSION`, `leapseconds`,
 * `iso3166.tab`) that are files and are not zones; and a FIFO or a device
 * named like a zone is not a file to read four bytes from (N13), so `fstat`
 * must say regular file before anything is read.
 */
export function isCompiledZone(zone: string, dirs: readonly string[]): boolean {
  if (BUILTIN_ZONES.has(zone)) return true;
  if (pathShaped(zone)) return false;
  for (const dir of dirs) {
    let fd: number | null = null;
    try {
      // THE REAL PATH MUST STAY IN THE REAL DATABASE (Copilot, NN-PR-#375): a
      // symlink under $TZDIR pointing anywhere else is not a zone this
      // database holds, however its first four bytes read.
      // ../repo/contain.ts's rule, asked of a file that must already exist.
      const real = realpathSync(join(dir, ...zone.split("/")));
      if (!isContained(realpathSync(dir), real)) continue;
      fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      if (!fstatSync(fd).isFile()) continue;
      const magic = Buffer.alloc(4);
      if (readSync(fd, magic, 0, 4, 0) === 4 && magic.toString("latin1") === "TZif") return true;
    } catch {
      // Absent, unreadable: not this directory's zone.
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return false;
}

/**
 * WHICH AUTHORITY SAYS A NAME IS A ZONE (N7). A TZif file, wherever a zoneinfo
 * database exists -- `$TZDIR`, else libc's directories (none of which is a path
 * on Windows). Where none exists, the runtime's own ICU zone list,
 * `Intl.supportedValuesOf("timeZone")`, and the run SAYS so on stderr: the
 * check is weaker (ICU's table, not the host's), and a reader should know
 * which one answered.
 */
type ZoneAuthority = { readonly kind: "tzif"; readonly dirs: readonly string[] } | { readonly kind: "icu"; readonly why: string };

function zoneAuthority(seams: Seams): ZoneAuthority {
  const tzdir = seams.env["TZDIR"];
  const named = tzdir !== undefined && tzdir.trim() !== "";
  const candidates = named ? [tzdir] : seams.platform === "win32" ? [] : ZONEINFO_DIRS;
  const dirs = candidates.filter((dir): boolean => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length > 0) return { kind: "tzif", dirs };
  const why = named
    ? `$TZDIR '${tzdir}' is not a directory`
    : seams.platform === "win32"
      ? "this host (win32) has no zoneinfo database"
      : `none of ${ZONEINFO_DIRS.join(", ")} exists`;
  return { kind: "icu", why };
}

/** ICU's canonical spelling of `zone`, or null when the runtime does not know it. */
function canonicalZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * `zone` checked by the authority, as ICU's canonical name, or the reason it
 * is not a zone.
 *
 * A CASE MISMATCH IS REFUSED (N13): on a case-insensitive file system
 * `america/bogota` opens `America/Bogota`'s TZif file, and ICU canonicalises it
 * -- so it would pass both checks while naming a zone nobody wrote. The name
 * printed is ICU's `resolvedOptions().timeZone`, the one the clock was read in.
 */
export function validateZone(zone: string, authority: ZoneAuthority): { readonly zone: string } | { readonly why: string } {
  if (pathShaped(zone)) return { why: "it is a path, not a zone name" };
  const canonical = canonicalZone(zone);
  if (canonical === null) return { why: "the runtime's ICU does not know it" };
  if (canonical !== zone && canonical.toLowerCase() === zone.toLowerCase()) {
    return { why: `zone names are case-sensitive, and the zone is spelled '${canonical}'` };
  }
  if (authority.kind === "tzif") {
    return isCompiledZone(zone, authority.dirs)
      ? { zone: canonical }
      : { why: `there is no compiled zone of that name in ${authority.dirs.join(", ")} (a regular file starting 'TZif')` };
  }
  const known = new Set(Intl.supportedValuesOf("timeZone"));
  return BUILTIN_ZONES.has(zone) || known.has(zone) || known.has(canonical)
    ? { zone: canonical }
    : { why: "it is not in the runtime's ICU zone list" };
}

interface LocalParts {
  readonly weekday: string;
  readonly day: number;
  readonly month: string;
  readonly year: number;
  readonly monthNumber: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The instant's wall clock in `zone`, or null when the runtime does not know the zone. */
function partsIn(zone: string, instant: Date): LocalParts | null {
  let parts: Intl.DateTimeFormatPart[];
  let numeric: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short" }).formatToParts(instant);
    numeric = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    }).formatToParts(instant);
  } catch {
    return null;
  }
  const text = (from: Intl.DateTimeFormatPart[], type: string): string => from.find((part): boolean => part.type === type)?.value ?? "";
  const number = (type: string): number => Number(text(numeric, type));
  return {
    weekday: text(parts, "weekday"),
    month: text(parts, "month"),
    day: number("day"),
    year: number("year"),
    monthNumber: number("month"),
    hour: number("hour") % 24,
    minute: number("minute"),
    second: number("second"),
  };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/**
 * The three clock fields, for a zone already known to be in the database.
 *
 * THE OFFSET IS COMPUTED, NOT FORMATTED: the wall clock read back as if it
 * were UTC, minus the instant (to the second), is the zone's offset at that
 * instant -- which is the number `date +%z` prints, with no locale's idea of
 * how to spell "GMT" in between.
 */
export function localClock(zone: string, instant: Date): Pick<ReportContext, "generatedAtLocal" | "generatedDateLocal" | "timeZone"> | null {
  const local = partsIn(zone, instant);
  if (local === null) return null;
  const wall = Date.UTC(local.year, local.monthNumber - 1, local.day, local.hour, local.minute, local.second);
  const offsetMinutes = Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return {
    generatedAtLocal: `${local.weekday} ${local.day} ${local.month} ${local.year} · ${pad(local.hour)}:${pad(local.minute)} ${zone} (UTC${offset})`,
    generatedDateLocal: `${pad(local.year, 4)}-${pad(local.monthNumber)}-${pad(local.day)}`,
    timeZone: zone,
  };
}

/**
 * The zone, then the clock.
 *
 * `--tz` FIRST, AND A `--tz` THAT IS NOT A ZONE IS REFUSED (exit 2): the caller
 * typed it, and a report stamped in UTC because a zone name was misspelled is
 * the silent answer `date(1)` gives and this verb exists not to. Then `$TZ`,
 * then the zone the host names (the seam's `hostTimeZone`: the
 * `/etc/localtime` symlink's target, then `/etc/timezone`, then ICU's own
 * guess -- ../seam/zone.ts). A zone from either that fails the same check is
 * `null` with the reason, because nobody typed it wrong.
 */
export function deriveClock(
  seams: Seams,
  tz: string | null,
  instant: Date,
  warn: (line: string) => void,
): Pick<ReportContext, "generatedAtLocal" | "generatedDateLocal" | "timeZone"> {
  const none = { generatedAtLocal: null, generatedDateLocal: null, timeZone: null };
  const authority = zoneAuthority(seams);
  const said = (zone: string): void => {
    if (authority.kind === "icu") {
      warn(`timeZone: ${authority.why}, so '${zone}' was checked against the runtime's ICU zone list (Intl.supportedValuesOf), not a TZif file.`);
    }
  };
  if (tz !== null) {
    const checked = validateZone(tz, authority);
    const clock = "zone" in checked ? localClock(checked.zone, instant) : null;
    if (clock === null) {
      throw new VerbUsageError(
        `--tz '${tz}' is not a zone: ${"why" in checked ? checked.why : "the runtime could not read a clock in it"}. A zone is an IANA name, like 'America/Bogota'. Refused rather than stamped in UTC, which is what date(1) silently does with a name it does not know.`,
      );
    }
    said(tz);
    return clock;
  }
  const fromEnv = seams.env["TZ"]?.replace(/^:/, "").trim();
  const zone = fromEnv !== undefined && fromEnv !== "" ? fromEnv : (seams.hostTimeZone?.() ?? null);
  const source = fromEnv !== undefined && fromEnv !== "" ? "$TZ" : "the host";
  if (zone === null || zone === "") {
    warn("timeZone: this host does not name its zone; pass --tz <IANA zone>. generatedAtLocal, generatedDateLocal and timeZone reported as null.");
    return none;
  }
  const checked = validateZone(zone, authority);
  const clock = "zone" in checked ? localClock(checked.zone, instant) : null;
  if (clock === null) {
    warn(`timeZone: ${source} names '${zone}', which is not a zone (${"why" in checked ? checked.why : "the runtime could not read a clock in it"}); pass --tz <IANA zone>. generatedAtLocal, generatedDateLocal and timeZone reported as null.`);
    return none;
  }
  said(zone);
  return clock;
}

// ── the block ───────────────────────────────────────────────────────────────

/**
 * THE CLOCK IS PASSED IN, ALREADY DERIVED: ./command.ts reads it straight after
 * the git half and BEFORE any GitHub read, so a `--tz` that is refused is
 * refused before the verb has spent a network round on a register it will
 * not print.
 */
export function assembleContext(
  seams: Seams,
  input: ContextInput,
  clock: Pick<ReportContext, "generatedAtLocal" | "generatedDateLocal" | "timeZone">,
  warn: (line: string) => void,
): ReportContext {
  const worktree = readWorktree(seams, input.root, warn);
  const stage = deriveStage(seams, input, warn);
  return {
    worktree,
    ...stage,
    turnNumber: deriveTurn(input.phases, input.branch, warn),
    ...clock,
  };
}
