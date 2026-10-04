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

import { closeSync, openSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { roleOf } from "../repo/classify.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import type { ReportPhase } from "./data.js";
import type { ReportObject, PrObject } from "./objects.js";

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
  /** Whether any of the five `objects` flags was given -- whether a PR was LOOKED FOR. */
  readonly objectsAsked: boolean;
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

function gitRead(seams: Seams, root: string, args: readonly string[]): { ok: boolean; stdout: string; why: string } {
  const result = seams.run(GIT, [...args], { cwd: root });
  if (result.spawnFailed) return { ok: false, stdout: "", why: `git could not be started: ${result.stderr}` };
  return {
    ok: result.code === 0,
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
  const lines = outputLines(read.stdout);
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

/** `refs/remotes/origin/<branch>`'s commit, or null when the branch is not on origin. */
function originTip(seams: Seams, root: string, branch: string): string | null {
  const read = gitRead(seams, root, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  return read.ok ? (outputLines(read.stdout)[0] ?? null) : null;
}

/**
 * THE EFFORT'S PULL REQUEST is the PR row whose head is this branch's commit --
 * HEAD's, or `origin/<branch>`'s when HEAD has moved past what was pushed.
 *
 * MATCHED BY HEAD, NEVER BY "THE ONLY PR IN SCOPE": a `--backlog` register
 * with one open pull request in it is not a statement that that pull request
 * is this branch's. Two rows answering is ambiguous and a row whose head could
 * not be read cannot be ruled out, and both are `undefined` with the reason --
 * the caller's question had no single answer. `null` is "looked, none is".
 */
function effortPr(
  prs: readonly PrObject[],
  heads: readonly string[],
): { readonly pr: PrObject | null } | { readonly why: string } {
  const matches = prs.filter((pr): boolean => pr.head !== "" && heads.includes(pr.head));
  if (matches.length === 1) return { pr: matches[0] as PrObject };
  if (matches.length > 1) {
    return { why: `${matches.length} pull requests in scope (${matches.map((pr): string => `#${pr.number}`).join(", ")}) have this branch's head, so which one is this effort's is not one answer` };
  }
  const unread = prs.filter((pr): boolean => pr.head === "");
  if (unread.length > 0) {
    return { why: `pull request ${unread.map((pr): string => `#${pr.number}`).join(", ")} has a head that could not be read, so it cannot be ruled out as this branch's` };
  }
  return { pr: null };
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
  if (input.openStop) return stageRow("blocked", null);
  if (input.branch === null) {
    warn("effortStage: HEAD is detached, so there is no branch whose stage to read; reported as null.");
    return none;
  }
  const pushed = originTip(seams, input.root, input.branch);
  const prs = input.objects.filter((object): object is PrObject => object.kind === "pr");
  let pr: PrObject | null = null;
  if (prs.length > 0) {
    const head = gitRead(seams, input.root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const heads = [...(head.ok ? outputLines(head.stdout).slice(0, 1) : []), ...(pushed === null ? [] : [pushed])];
    const found = effortPr(prs, heads);
    if ("why" in found) {
      warn(`effortStage: ${found.why}; reported as null. Name this effort's own pull request with --prs <n>.`);
      return none;
    }
    pr = found.pr;
  }
  if (pr === null) {
    if (pushed === null) return stageRow("authoring", null);
    if (!input.objectsAsked) {
      warn(`effortStage: 'published' is read from origin alone -- no pull request was looked for (pass --target <owner/name> --prs <n> to read this effort's).`);
    }
    return stageRow("published", null);
  }
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return stageRow("landed", null);
  if (state !== "OPEN") {
    warn(`effortStage: pull request #${pr.number} is ${pr.state === "" ? "in an unreadable state" : `'${pr.state}'`}, which no stage in the table describes (closed without merging is not 'landed'); reported as null.`);
    return none;
  }
  const stage: EffortStage = pr.readiness?.verdict === "ready" ? "ready" : "in review";
  if (pr.readiness === null) {
    warn(`effortStage: pull request #${pr.number}'s readiness was not read (its notes say why), so it is 'in review' -- 'ready' is only ever the verdict's word.`);
  }
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
 * `turnNumber`: how many `report` phase entries this effort's ledger holds.
 *
 * WHICH EFFORT. A checkout normally carries one ledger, and that is the answer.
 * With several, the one whose id is this branch's name; with none of them so
 * named, `null` -- adding two efforts' turns together is a number nobody's turn
 * has. Zero `report` entries is `null` too: "Turn 0" is not a turn.
 */
export function deriveTurn(phases: readonly ReportPhase[], branch: string | null, warn: (line: string) => void): number | null {
  const counts = new Map<string, number>();
  for (const phase of phases) {
    if (phase.phase === "report") counts.set(phase.effort, (counts.get(phase.effort) ?? 0) + 1);
  }
  if (counts.size === 0) {
    warn("turnNumber: no 'report' phase is recorded in .nen/phases/ ('nen phase begin --phase report' records one per turn); reported as null.");
    return null;
  }
  if (counts.size === 1) return [...counts.values()][0] as number;
  const mine = branch === null ? undefined : counts.get(branch);
  if (mine !== undefined) return mine;
  warn(`turnNumber: ${counts.size} efforts record 'report' phases (${[...counts.keys()].sort().join(", ")}) and none is named after this branch, so which one's turn this is is not one answer; reported as null.`);
  return null;
}

// ── the local clock ─────────────────────────────────────────────────────────

/** The zoneinfo directories searched when `$TZDIR` does not name one -- libc's own order. */
export const ZONEINFO_DIRS: readonly string[] = ["/usr/share/zoneinfo", "/var/db/timezone/zoneinfo", "/usr/lib/zoneinfo"];

/** The zones that need no database: the C library answers them itself. */
const BUILTIN_ZONES = new Set(["UTC", "Etc/UTC"]);

/**
 * Whether `zone` is a COMPILED zone in this host's zoneinfo database: a file
 * whose first four bytes are `TZif`.
 *
 * THE MAGIC, NOT THE FILE'S PRESENCE. The database directory also holds
 * tables and metadata (`zone.tab`, `tzdata.zi`, `+VERSION`, `leapseconds`,
 * `iso3166.tab`) that are files and are not zones. A path-shaped name
 * (absolute, or carrying `..`) is never looked up at all.
 */
export function isCompiledZone(zone: string, dirs: readonly string[]): boolean {
  if (BUILTIN_ZONES.has(zone)) return true;
  if (zone === "" || zone.startsWith("/") || zone.includes("\\") || zone.split("/").includes("..") || /^[A-Za-z]:/.test(zone)) return false;
  for (const dir of dirs) {
    let fd: number | null = null;
    try {
      fd = openSync(join(dir, ...zone.split("/")), "r");
      const magic = Buffer.alloc(4);
      if (readSync(fd, magic, 0, 4, 0) === 4 && magic.toString("latin1") === "TZif") return true;
    } catch {
      // Absent, a directory, unreadable: not this directory's zone.
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return false;
}

function zoneinfoDirs(seams: Seams): readonly string[] {
  const tzdir = seams.env["TZDIR"];
  return tzdir !== undefined && tzdir.trim() !== "" ? [tzdir] : ZONEINFO_DIRS;
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
 * then the zone the host names (the seam's `hostTimeZone`, which on a real host
 * is the runtime's reading of `/etc/localtime`). A host zone that fails the
 * same check is `null` with the reason, because nobody typed it wrong.
 */
export function deriveClock(
  seams: Seams,
  tz: string | null,
  instant: Date,
  warn: (line: string) => void,
): Pick<ReportContext, "generatedAtLocal" | "generatedDateLocal" | "timeZone"> {
  const none = { generatedAtLocal: null, generatedDateLocal: null, timeZone: null };
  const dirs = zoneinfoDirs(seams);
  if (tz !== null) {
    const clock = isCompiledZone(tz, dirs) ? localClock(tz, instant) : null;
    if (clock === null) {
      throw new VerbUsageError(
        `--tz '${tz}' is not a zone in this host's zoneinfo database (${dirs.join(", ")}): a zone is an IANA name whose file there starts with 'TZif', like 'America/Bogota'. Refused rather than stamped in UTC, which is what date(1) silently does with a name it does not know.`,
      );
    }
    return clock;
  }
  const fromEnv = seams.env["TZ"]?.replace(/^:/, "").trim();
  const zone = fromEnv !== undefined && fromEnv !== "" ? fromEnv : (seams.hostTimeZone?.() ?? null);
  const source = fromEnv !== undefined && fromEnv !== "" ? "$TZ" : "the host";
  if (zone === null || zone === "") {
    warn("timeZone: this host does not name its zone; pass --tz <IANA zone>. generatedAtLocal, generatedDateLocal and timeZone reported as null.");
    return none;
  }
  const clock = isCompiledZone(zone, dirs) ? localClock(zone, instant) : null;
  if (clock === null) {
    warn(`timeZone: ${source} names '${zone}', which is not a zone in this host's zoneinfo database (${dirs.join(", ")}); pass --tz <IANA zone>. generatedAtLocal, generatedDateLocal and timeZone reported as null.`);
    return none;
  }
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
