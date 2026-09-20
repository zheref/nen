// src/report/objects.ts -- `objects[]`: the pull requests and issues an effort
// is ABOUT, as facts, for the report that lists them.
//
// WHY IT IS IN `report data` AND NOT A VERB OF ITS OWN. A report's register --
// "these three issues, these two pull requests, and where each one stands" --
// is the same document as its commit list and its file list: one read, one
// instant, one thing a template fills. Splitting it out would mean a caller
// stitching two documents together and answering for himself whether they were
// read at the same moment, which is exactly what `nen report data` exists to
// stop being anybody's problem.
//
// `objects` IS `[]` UNLESS THE CALLER ASKED. The five flags that fill it
// (`--target`, `--prs`, `--issues`, `--backlog`, `--objects-from`) are the whole
// of the trigger: with none of them, this module is never called and the field
// is the empty list a template's `{{#each objects}}` renders as nothing. That
// keeps `report data`'s v0.11 shape -- local, four git reads, no network -- the
// DEFAULT rather than a thing you opt out of, because the verb is run inside
// build loops where a surprise `gh` call is a surprise token requirement.
//
// READINESS HAS THREE ANSWERS AND SAYS WHICH ONE IT GAVE. A repository whose CI
// publishes a check run called `readiness` has already decided the verdict on
// this exact head, and re-deriving it here would be a second opinion about a
// question somebody already answered -- so that check's own summary line is
// read and `source` is `check`. Without one, the in-process gate
// (../verbs/pr_ready.ts, the SAME code `nen pr ready` runs, never a re-spelling
// of CON-32) decides it and `source` is `computed`. With neither -- no token, an
// unevaluated gate -- readiness is `null` WITH THE REASON ON STDERR, on
// ./data.ts's own rule: an absence is `null` and never a failure, and a report
// that refused to describe an effort because GitHub was unreachable is a report
// you can only run online.
//
// AN OBJECT THE CALLER NAMED IS NEVER QUIETLY MISSING, AND THAT IS WHERE THIS
// MODULE PARTS COMPANY WITH ./data.ts's "every absence is null". That rule is
// about ARTIFACTS NOBODY PRODUCED -- a coverage report that was never written,
// a proof, a recorded stop -- where `null` is the true answer and a refusal
// would mean the verb only runs at the end. The register is the other case:
// `--prs 87`, `--issues 85` and `--backlog` are the caller saying WHICH objects
// the report is about, so a row that could not be read is not an absence, it is
// an unanswered question. A short `objects[]` at exit 0 says "that is the whole
// register" in a document whose whole job is to be the whole register, which is
// ./data.ts's own reason for refusing a failed `git log` rather than reporting
// a branch with no commits on it.
//
// SO THE LINE IS DRAWN AT THE OBJECT, NOT THE FIELD. A FIELD that will not read
// degrades and is named in the row's `notes[]` (see `prRow`); an OBJECT that
// cannot be read at all, or a backlog page that cannot be fetched, is a
// refusal at exit 1 naming it. Losing a field costs a column; losing an object
// costs the reader a thing they asked about and never learn was missing.
//
// THE OFFLINE PATH IS VALIDATED AT THE READ SEAM, BY INDEX. `--objects-from`
// takes rows already in this shape -- it is how a caller who assembled the
// register himself (or a test) feeds it in -- and an unvalidated row would put
// `undefined` into a published register under a key the contract promises. So
// every row is checked field by field and refused at exit 2 NAMING ITS INDEX,
// the same discipline ../pr/command.ts's `validateWakes` applies to the wake
// history for the same reason: a row nobody checked is a fact nobody checked.
//
// EVERY `gh api` ARGV THIS MODULE BUILDS NAMES ITS METHOD EXPLICITLY, on
// ../pr/fetch.ts's module rule (zheref/nen#19): gh flips to POST the moment any
// `-f`/`-F` is supplied, and a READ verb that writes is the worst defect class
// this CLI can have. `report data` is the read verb par excellence -- ./data.ts's
// header says it has no write path at all -- so the rule is inherited whole.
// The claim is about the builders HERE and in the modules this calls
// (../pr/threads.ts, ../backlog/fetch.ts), each of which states it for itself;
// ./objects.test.ts and ../pr/fetch.test.ts sweep them together, so the rule is
// checked rather than asserted (Nobunaga N11 -- the sentence used to claim more
// than this module could see).

import { VerbUsageError } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { referencedIssueNumbers, fetchPaginated } from "../backlog/fetch.js";
import type { Target } from "../github/target.js";
import { rollupEntryStatus, type RollupEntry } from "../github/types.js";
import { parseCheckRollup } from "../github/parse.js";
import { checksAllGreen, latestChecks } from "../gates/predicates.js";
import { viewArgv } from "../pr/fetch.js";
import { listThreads } from "../pr/threads.js";
import { GH, outputLines, type Seams } from "../seam/exec.js";
import { prReady } from "../verbs/pr_ready.js";

/**
 * An OBJECT the caller named that could not be read at all.
 *
 * A plain `Error`, so ../index.ts's "anything else is exit 1" answers it: this
 * is the verb failing, not the invocation being wrong -- the flags were right
 * and GitHub did not answer. A retry can fix it, which is exactly what exit 1
 * tells a caller and exit 2 would not.
 */
export class ObjectsError extends Error {
  constructor(message: string) {
    super(`objects: ${message}`);
    this.name = "ObjectsError";
  }
}

/** The check-run name a repository publishes its own readiness verdict under. */
export const READINESS_CHECK = "readiness";

export interface ObjectChecks {
  readonly total: number;
  readonly green: number;
  readonly red: number;
  readonly pending: number;
}

export interface ObjectThreads {
  readonly total: number;
  readonly unresolved: number;
}

export interface ObjectReadiness {
  /** `ready`, `not-ready`, or whatever verdict word the source gave. */
  readonly verdict: string;
  /** The line to quote. Empty only when the source gave none. */
  readonly reason: string;
  /** Which of the two authorities answered. */
  readonly source: "check" | "computed";
}

/**
 * ONE ROW. KEY ORDER IS THE CONTRACT, and a pull request carries five keys an
 * issue does not -- there is no `head` on an issue, and a `null` one would be a
 * field inviting a template to print "mergeable: null" about a thing that never
 * merges.
 */
export interface PrObject {
  readonly kind: "pr";
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly labels: readonly string[];
  readonly head: string;
  readonly mergeStateStatus: string;
  readonly checks: ObjectChecks;
  readonly threads: ObjectThreads;
  readonly reviewRequests: readonly string[];
  /** Issue numbers this pull request references. */
  readonly linked: readonly number[];
  readonly readiness: ObjectReadiness | null;
  /**
   * What could not be read cleanly about THIS row, named, in the order it was
   * found. Empty when everything read.
   *
   * IT IS A FIELD AND NOT ONLY A WARNING (Nobunaga N2). A degraded row that
   * said so only on stderr would be published into a report that looks
   * complete, read by somebody who never saw the terminal -- and the whole
   * reason the row survives a bad field is that a register must not lose an
   * object it was asked for. Surviving quietly is the other half of the same
   * mistake. Every line here is also written to stderr, so neither reader has
   * to know about the other.
   */
  readonly notes: readonly string[];
}

export interface IssueObject {
  readonly kind: "issue";
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly labels: readonly string[];
  /** Pull-request numbers that reference this issue. */
  readonly linked: readonly number[];
  /** ALWAYS `null`: CON-32 is a statement about a pull request, not an issue. */
  readonly readiness: null;
  /** See `PrObject.notes`. Empty when everything read. */
  readonly notes: readonly string[];
}

export type ReportObject = PrObject | IssueObject;

export interface ObjectsOptions {
  /** `--target owner/name`, or null when only `--objects-from` was given. */
  readonly target: Target | null;
  /** `--prs`, already split into numbers. */
  readonly prs: readonly number[];
  /** `--issues`, already split into numbers. */
  readonly issues: readonly number[];
  /** `--backlog`: every open issue and pull request. */
  readonly backlog: boolean;
  /** `--objects-from <file>`'s parsed document, or null. */
  readonly from: { readonly document: unknown; readonly display: string } | null;
  /** The checkout `prReady` resolves its repo registry and gates against. */
  readonly repoRoot: string;
}

// ── the offline path: validation by index ───────────────────────────────────

function refuse(display: string, index: number, what: string): never {
  throw new VerbUsageError(
    `'${display}': row ${index} ${what}. Every row is one of the two shapes 'nen report data' publishes under 'objects': a pull request ({ kind: "pr", number, title, url, state, labels[], head, mergeStateStatus, checks: { total, green, red, pending }, threads: { total, unresolved }, reviewRequests[], linked[], readiness }) or an issue ({ kind: "issue", number, title, url, state, labels[], linked[], readiness: null }). A row nobody checked is a fact nobody checked, so the whole file is refused rather than one register row published with a hole in it.`,
  );
}

function field(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function requireString(row: Record<string, unknown>, key: string, display: string, index: number): string {
  const value = field(row, key);
  if (typeof value !== "string") refuse(display, index, `has '${key}' of type ${describe(value)}, not a string`);
  return value;
}

function requireNumber(row: Record<string, unknown>, key: string, display: string, index: number): number {
  const value = field(row, key);
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    refuse(display, index, `has '${key}' of ${describe(value)}, not a positive whole number`);
  }
  return value;
}

function requireStrings(row: Record<string, unknown>, key: string, display: string, index: number): string[] {
  const value = field(row, key);
  if (!Array.isArray(value) || value.some((entry): boolean => typeof entry !== "string")) {
    refuse(display, index, `has '${key}' that is not a list of strings`);
  }
  return [...(value as string[])];
}

function requireNumbers(row: Record<string, unknown>, key: string, display: string, index: number): number[] {
  const value = field(row, key);
  if (!Array.isArray(value) || value.some((entry): boolean => typeof entry !== "number" || !Number.isInteger(entry))) {
    refuse(display, index, `has '${key}' that is not a list of whole numbers`);
  }
  return [...(value as number[])];
}

function requireCounts(
  row: Record<string, unknown>,
  key: string,
  keys: readonly string[],
  display: string,
  index: number,
): Record<string, number> {
  const value = field(row, key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse(display, index, `has '${key}' of ${describe(value)}, not an object of counts`);
  }
  const counts: Record<string, number> = {};
  for (const name of keys) {
    const count = (value as Record<string, unknown>)[name];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      refuse(display, index, `has '${key}.${name}' of ${describe(count)}, not a whole count`);
    }
    counts[name] = count;
  }
  return counts;
}

function readReadiness(row: Record<string, unknown>, display: string, index: number): ObjectReadiness | null {
  const value = field(row, "readiness");
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    refuse(display, index, `has 'readiness' of ${describe(value)}, which is neither null nor a verdict object`);
  }
  const record = value as Record<string, unknown>;
  const verdict = record["verdict"];
  const reason = record["reason"];
  const source = record["source"];
  if (typeof verdict !== "string" || typeof reason !== "string") {
    refuse(display, index, `has a 'readiness' without a string 'verdict' and 'reason'`);
  }
  if (source !== "check" && source !== "computed") {
    refuse(
      display,
      index,
      `has 'readiness.source' of ${describe(source)} -- it says WHICH authority answered and is 'check' (the head's own readiness check run) or 'computed' (nen's in-process CON-32 gate)`,
    );
  }
  return { verdict, reason, source };
}

/**
 * `notes[]`, ABSENT-TOLERANT on the way in and always present on the way out.
 *
 * A row written before this field existed -- or by a caller who has nothing to
 * degrade -- is a valid row, so an absent `notes` reads as the empty list
 * rather than a refusal by index. What is NOT tolerated is a `notes` that is
 * there and is not a list of strings: that is a row claiming to carry
 * degradations in a shape nobody can print.
 */
function readNotes(row: Record<string, unknown>, display: string, index: number): readonly string[] {
  const value = field(row, "notes");
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry): boolean => typeof entry !== "string")) {
    refuse(display, index, `has 'notes' that is not a list of strings`);
  }
  return [...(value as string[])];
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return `a list of ${value.length}`;
  // A STRING IS QUOTED AND SHOWN. "a string" tells a caller nothing about the
  // row they have to fix, and the values this refuses are short enumerations
  // ('epic' for a kind, 'guessed' for a source) where the wrong word IS the
  // finding.
  if (typeof value === "string") return `'${value}'`;
  return `a ${typeof value}`;
}

/**
 * `--objects-from <file>`, validated and RE-EMITTED IN THE CONTRACT'S KEY ORDER.
 *
 * Re-emitted rather than passed through, because the key order of this document
 * is part of what it promises: a caller's file that spells the same fields in
 * another order would publish a register whose rows differ from the ones the
 * live path produces, in a document whose whole purpose is that they do not.
 */
export function parseObjects(document: unknown, display: string): readonly ReportObject[] {
  if (!Array.isArray(document)) {
    throw new VerbUsageError(
      `'${display}' is not a JSON array of object rows. --objects-from takes the 'objects' array 'nen report data' publishes, which is how a caller who assembled the register himself feeds it back in.`,
    );
  }
  return document.map((entry, index): ReportObject => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      refuse(display, index, `is ${describe(entry)}, not an object`);
    }
    const row = entry as Record<string, unknown>;
    const kind = row["kind"];
    if (kind !== "pr" && kind !== "issue") {
      refuse(display, index, `has 'kind' of ${describe(kind)} -- it is 'pr' or 'issue'`);
    }
    const common = {
      number: requireNumber(row, "number", display, index),
      title: requireString(row, "title", display, index),
      url: requireString(row, "url", display, index),
      state: requireString(row, "state", display, index),
      labels: requireStrings(row, "labels", display, index),
    };
    if (kind === "issue") {
      const readiness = readReadiness(row, display, index);
      if (readiness !== null) {
        refuse(
          display,
          index,
          `is an issue carrying a 'readiness'. CON-32 is a statement about a pull request; an issue's readiness is always null`,
        );
      }
      return {
        kind: "issue",
        ...common,
        linked: requireNumbers(row, "linked", display, index),
        readiness: null,
        notes: readNotes(row, display, index),
      };
    }
    return {
      kind: "pr",
      ...common,
      head: requireString(row, "head", display, index),
      mergeStateStatus: requireString(row, "mergeStateStatus", display, index),
      checks: requireCounts(row, "checks", ["total", "green", "red", "pending"], display, index) as unknown as ObjectChecks,
      threads: requireCounts(row, "threads", ["total", "unresolved"], display, index) as unknown as ObjectThreads,
      reviewRequests: requireStrings(row, "reviewRequests", display, index),
      linked: requireNumbers(row, "linked", display, index),
      readiness: readReadiness(row, display, index),
      notes: readNotes(row, display, index),
    };
  });
}

// ── readiness: the check run, then the gate, then null ──────────────────────

interface RawCheckRun {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
  readonly started_at?: unknown;
  readonly output?: { readonly title?: unknown; readonly summary?: unknown; readonly text?: unknown };
}

/**
 * The verdict line a `readiness` check run published, parsed.
 *
 * THE WHOLE LINE MUST BE THE VERDICT, and nothing else is read (Feitan F1).
 * Hunting for `ready` anywhere in a summary finds it inside "not ready yet",
 * inside "readiness", and inside a check-run TITLE somebody wrote as "Ready to
 * merge" -- and any one of those short-circuits the gate into publishing
 * `ready` about a pull request nothing evaluated. So a line is a verdict only
 * when it IS one, end to end: `ready`, or `not-ready: <reason>`. A line with
 * anything after the bare `ready` is not a verdict, it is prose that starts
 * with the word.
 */
export function parseVerdictLine(text: string): { readonly verdict: string; readonly reason: string } | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const ready = /^ready\.?$/i.exec(trimmed);
    if (ready !== null) return { verdict: "ready", reason: trimmed };
    const notReady = /^not-ready\s*:\s*(\S.*)$/i.exec(trimmed);
    if (notReady !== null) return { verdict: "not-ready", reason: trimmed };
  }
  return null;
}

/**
 * `gh api --method GET repos/<slug>/commits/<sha>/check-runs?per_page=100&page=N`.
 *
 * PAGINATED, AND `latestOf` IS WHY (Copilot, #221). The first cut read the
 * endpoint's DEFAULT page and then asked `latestOf` for the newest `readiness`
 * attempt in it -- so on a commit with more check runs than one page, a newer
 * readiness run simply was not in the set, and an OLDER verdict was published
 * as though it were current. That is the same false-green shape ../pr/fetch.ts's
 * header records one layer along, reached through recency instead of through
 * truncation.
 */
export function checkRunsArgv(target: Target, sha: string, page = 1): readonly string[] {
  return [
    "api",
    "--method",
    "GET",
    `repos/${target.slug}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PAGE_SIZE}&page=${page}`,
  ];
}

/** GitHub's own clamp on one page of check runs. A page size, never a cap. */
const CHECK_RUNS_PAGE_SIZE = 100;

/** A runaway backstop, matching ../pr/fetch.ts's own: 50 pages of 100. */
const MAX_CHECK_RUN_PAGES = 50;

/**
 * The ONE conclusion whose verdict line is read, as an allowlist.
 *
 * IT WAS A DENYLIST, AND A DENYLIST LEAKS (Copilot, #221). `NEVER_READY` held
 * the six terminal failures -- and an absent, null, empty or simply unfamiliar
 * `conclusion` stringified to `""`, which is in no denylist, so a malformed
 * completed run whose summary said `ready` was trusted as `source: "check"`.
 * That is the exact false-ready path the three checks around it exist to close,
 * reintroduced by the shape of the test rather than by its contents.
 *
 * `SUCCESS` ALONE, NOT `NEUTRAL`. A neutral conclusion is a job that declined
 * to decide -- which is a fine thing for a linter to report and not a thing a
 * READINESS job may say while its output claims a verdict. The narrow set is
 * the safe one to be wrong about: every other value falls through to nen's own
 * gate, which is a real answer, rather than to a verdict nobody computed.
 */
const READY_CONCLUSIONS: ReadonlySet<string> = new Set(["SUCCESS"]);

/**
 * The head's own `readiness` check run, or null when it carries none.
 *
 * FOUR THINGS MUST HOLD BEFORE THIS SHORT-CIRCUITS THE GATE, and each one is a
 * way the first cut of this function could be talked into publishing `ready`
 * about a pull request nothing evaluated (Feitan F1, Nobunaga N5):
 *
 *   1. THE LATEST RUN OF THAT NAME, not the first one the array happens to
 *      carry. GitHub returns every attempt; a re-run that went red sits beside
 *      the SUCCESS it replaced, and array order is not recency. The reduction
 *      is `started_at`, descending, which is what ../gates/predicates.ts's
 *      `latestChecks` does one layer up on the validated shape.
 *   2. `status === "completed"`. An in-flight run has not said anything yet,
 *      and a run still deciding must never be read as a decision -- the exact
 *      `//`-chain lesson ../github/types.ts's header records.
 *   3. THE CONCLUSION IS FOLDED IN. A run that FAILED, was CANCELLED or TIMED
 *      OUT cannot publish `ready` however its output is worded: the job that
 *      was supposed to decide did not finish deciding.
 *   4. THE VERDICT COMES FROM `output.summary` OR `output.text`, NEVER FROM
 *      `output.title`. A title is a display string an app writes for a human
 *      ("Ready to merge"), and reading it as a verdict is how "Ready to merge"
 *      becomes `ready` from an app nobody vetted.
 *
 * ANY OF THEM FAILING IS A WARNING AND A FALL-THROUGH TO THE GATE, never a
 * refusal and never a verdict: nen's own gate is a better answer than a
 * degraded one, and no answer at all is better than a wrong one.
 *
 * NEN STILL DOES NOT VERIFY WHO PUBLISHED THE RUN, and that is worth saying
 * out loud rather than leaving implied. A check run named `readiness` on the
 * head is trusted as the repository's own because only an app with write
 * access to that repository can create one; if that assumption is ever wrong
 * for a consumer, the repair is to stop publishing the check rather than to
 * add an app allow-list here, which would be nen inventing somebody's CI
 * vocabulary.
 */
export function readinessFromCheck(
  seams: Seams,
  target: Target,
  sha: string,
  warn: (line: string) => void,
): ObjectReadiness | null {
  const runs = readCheckRuns(seams, target, sha, warn);
  if (runs === null) return null;
  const named = runs.filter((entry): boolean => String(entry.name ?? "") === READINESS_CHECK);
  if (named.length === 0) return null;
  const run = latestOf(named);
  const where = `${target.slug}@${sha.slice(0, 8)} carries a '${READINESS_CHECK}' check run`;

  const status = String(run.status ?? "").toLowerCase();
  if (status !== "completed") {
    warn(
      `objects: ${where} whose status is '${status || "(none)"}', not 'completed' -- a run still deciding has not decided; falling through to nen's own gate.`,
    );
    return null;
  }
  const conclusion = String(run.conclusion ?? "").toUpperCase();
  if (!READY_CONCLUSIONS.has(conclusion)) {
    warn(
      `objects: ${where} whose conclusion is '${conclusion || "(none)"}', not SUCCESS -- only a run that succeeded may publish a readiness verdict, so its output is not read as one; falling through to nen's own gate.`,
    );
    return null;
  }
  // `output.title` IS DELIBERATELY NOT IN THIS JOIN. See clause 4 above.
  const text = [run.output?.summary, run.output?.text]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  const line = parseVerdictLine(text);
  if (line === null) {
    warn(
      `objects: ${where} whose output.summary/output.text names no verdict line (a whole line reading 'ready', or 'not-ready: <reason>'); falling through to nen's own gate.`,
    );
    return null;
  }
  return { verdict: line.verdict, reason: line.reason, source: "check" };
}

/**
 * Every check run on this commit, walked to completion, or null.
 *
 * FAILS CLOSED INTO `null`, WHICH HERE MEANS "FALL THROUGH TO THE GATE". A
 * partial set is exactly as untrustworthy as none for a question decided by
 * RECENCY -- the newest run is the one most likely to be on the page nobody
 * fetched -- so a page that cannot be read, cannot be parsed, or runs past the
 * backstop abandons the check-run route entirely rather than answering from
 * what it happened to get. That is a weaker failure than ../pr/threads.ts's
 * walk throwing, and deliberately so: there IS a second authority here (nen's
 * own gate), and falling through to a real verdict beats refusing the report.
 *
 * `total_count` IS NOT TRUSTED AS THE TERMINATOR. A short page is the end of
 * the walk; a full page means ask again. A count the server computed before
 * the caller's last page is one more thing that can be wrong in the direction
 * that truncates.
 */
function readCheckRuns(
  seams: Seams,
  target: Target,
  sha: string,
  warn: (line: string) => void,
): readonly RawCheckRun[] | null {
  const all: RawCheckRun[] = [];
  for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
    const result = seams.run(GH, [...checkRunsArgv(target, sha, page)]);
    if (result.spawnFailed || result.code !== 0) return null;
    let batch: readonly RawCheckRun[];
    try {
      const parsed = JSON.parse(result.stdout) as { check_runs?: unknown };
      if (!Array.isArray(parsed.check_runs)) return null;
      batch = parsed.check_runs as RawCheckRun[];
    } catch {
      return null;
    }
    all.push(...batch);
    if (batch.length < CHECK_RUNS_PAGE_SIZE) return all;
  }
  warn(
    `objects: ${target.slug}@${sha.slice(0, 8)} has more than ${MAX_CHECK_RUN_PAGES * CHECK_RUNS_PAGE_SIZE} check runs, which is past this walk's backstop -- the newest '${READINESS_CHECK}' run may not be in the set that was read, so no verdict is taken from it; falling through to nen's own gate.`,
  );
  return null;
}

/**
 * The latest run of one name, by `started_at`, descending.
 *
 * A MISSING TIMESTAMP SORTS FIRST, matching ../gates/predicates.ts's own
 * `sort_by(.startedAt // "")` -- so a run that does not say when it started
 * never wins recency over one that does.
 */
function latestOf(runs: readonly RawCheckRun[]): RawCheckRun {
  return [...runs].sort((a, b): number =>
    String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")),
  )[runs.length - 1] as RawCheckRun;
}

/**
 * The in-process CON-32 gate, run for one pull request, or null with the reason.
 *
 * IT IS `nen pr ready`, CALLED AS A FUNCTION -- not a second evaluation of the
 * same clauses. ../verbs/pr_ready.ts owns the verdict; this collects its
 * `--json` report through a capturing `Io` and reads two fields off it. An
 * `unevaluated` report (no token, an unreachable API) is `null` with the gate's
 * own remedy on stderr, because an unevaluated gate has not said "not ready" --
 * it has said nothing, and publishing the two as one word is the false-red twin
 * of the false-green ../pr/fetch.ts's header is about.
 */
export async function readinessFromGate(
  target: Target,
  prNumber: number,
  repoRoot: string,
  warn: (line: string) => void,
): Promise<ObjectReadiness | null> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await prReady(
    {
      positionals: ["pr", "ready", String(prNumber)],
      values: { "gh-repo": target.slug },
      booleans: new Set(["json"]),
      repoFlag: repoRoot,
    },
    { out: (line): void => void out.push(line), err: (line): void => void err.push(line) },
  );
  let report: { verdict?: unknown; gateLine?: unknown; remedy?: unknown };
  try {
    report = JSON.parse(out.join("\n")) as typeof report;
  } catch {
    warn(
      `objects: the readiness gate produced no report for ${target.slug}#${prNumber} (exit ${code})${err.length === 0 ? "" : `: ${err.join(" ")}`}; readiness reported as null.`,
    );
    return null;
  }
  if (report.verdict !== "ready" && report.verdict !== "not-ready") {
    warn(
      `objects: the readiness gate could not evaluate ${target.slug}#${prNumber} (${String(report.verdict)}). ${typeof report.remedy === "string" ? report.remedy : "Readiness reported as null."}`,
    );
    return null;
  }
  return {
    verdict: report.verdict,
    reason: typeof report.gateLine === "string" ? report.gateLine : "",
    source: "computed",
  };
}

// ── the live path ───────────────────────────────────────────────────────────

/** `gh api --method GET repos/<slug>/issues/<n>`. */
export function issueArgv(target: Target, number: number): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/issues/${number}`];
}

/**
 * ONE ISSUE'S ROW, on the SAME field-by-field contract `prRow` follows
 * (Copilot, #221).
 *
 * IT USED TO BE A CAST AND A HOPE. `raw.labels.map(...)` THREW on a `labels`
 * that was not a list -- taking the whole verb down over a display field -- and
 * a non-string label name was published into the register as whatever it was,
 * under a key the contract says is a list of strings. Neither is an acceptable
 * way for an issue to arrive, and both were invisible to the reader.
 *
 * IT DEGRADES RATHER THAN REFUSING, AND THAT IS THE SAME RULE, NOT AN
 * EXCEPTION TO IT. This module's rule is that an OBJECT that could not be READ
 * AT ALL is a refusal (the `gh` call failing, above, still is) and a FIELD that
 * will not read degrades and is named. An issue that answered with a malformed
 * `labels` is an object that WAS read -- the caller's question was answered --
 * so it keeps its row and says what was wrong with it, exactly as a pull
 * request does.
 */
function issueRow(raw: Record<string, unknown>, number: number, linked: readonly number[]): IssueObject {
  const notes: string[] = [];
  const note = (line: string): void => void notes.push(line);
  return {
    kind: "issue",
    number: degradedNumber(raw, "number", number, note),
    title: degradedString(raw, "title", note),
    url: degradedString(raw, "html_url", note),
    state: degradedString(raw, "state", note).toUpperCase(),
    labels: readLabels(raw["labels"], note),
    linked: [...linked].sort((a, b): number => a - b),
    readiness: null,
    notes,
  };
}

/**
 * Every object the flags named, in one pass: issues first, then pull requests,
 * each in ascending number order.
 *
 * THE ORDER IS STATED RATHER THAN INHERITED from whatever GitHub returned,
 * because this list goes into a register a human reads twice -- once now and
 * once after the next push -- and a register whose rows move between two reads
 * of an unchanged repository is a register you cannot diff.
 */
export async function assembleObjects(
  seams: Seams,
  options: ObjectsOptions,
  warn: (line: string) => void,
): Promise<readonly ReportObject[]> {
  if (options.from !== null) return parseObjects(options.from.document, options.from.display);
  const target = options.target;
  if (target === null) return [];

  const issues = new Map<number, Record<string, unknown>>();
  const prNumbers = new Set<number>(options.prs);

  if (options.backlog) {
    const open = fetchPaginated<Record<string, unknown>>(seams, `repos/${target.slug}/issues?state=open`, null);
    for (const raw of open.items) {
      // A ROW WITH NO USABLE NUMBER IS NOT AN OBJECT, and it is the one field
      // there is no degrading around: it is the identity everything else in
      // the register is keyed by. Named on stderr and left out.
      const number = typeof raw["number"] === "number" ? raw["number"] : null;
      if (number === null) {
        warn(`objects: a row in ${target.slug}'s open-object page carried no numeric 'number' and could not be identified; it is not in the register.`);
        continue;
      }
      if (raw["pull_request"] === undefined) issues.set(number, raw);
      else prNumbers.add(number);
    }
    if (open.truncated) {
      throw new ObjectsError(
        `the open-object fetch for ${target.slug} hit its pagination ceiling before the last page. Refusing to publish a register that is short by an unknown number of rows under a flag whose whole meaning is 'every open issue and pull request'.`,
      );
    }
  }
  for (const number of options.issues) {
    if (issues.has(number)) continue;
    const result = seams.run(GH, [...issueArgv(target, number)]);
    if (result.spawnFailed || result.code !== 0) {
      throw new ObjectsError(
        `could not read ${target.slug}#${number}, which --issues named (${result.spawnFailed ? "gh could not be started" : `gh exited ${result.code}`}: ${outputLines(result.stderr).join(" ") || "no output"}). Refusing to publish a register that silently leaves out an object you asked for.`,
      );
    }
    try {
      issues.set(number, JSON.parse(result.stdout) as Record<string, unknown>);
    } catch (error) {
      throw new ObjectsError(
        `could not read ${target.slug}#${number}, which --issues named (gh did not answer JSON: ${String(error)}). Refusing to publish a register that silently leaves out an object you asked for.`,
      );
    }
  }

  const prs: PrObject[] = [];
  const linkedByIssue = new Map<number, number[]>();
  for (const number of [...prNumbers].sort((a, b): number => a - b)) {
    const row = await prRow(seams, target, number, options.repoRoot, warn);
    prs.push(row);
    for (const issueNumber of row.linked) {
      if (!issues.has(issueNumber)) continue;
      linkedByIssue.set(issueNumber, [...(linkedByIssue.get(issueNumber) ?? []), number]);
    }
  }

  const issueRows = [...issues.keys()]
    .sort((a, b): number => a - b)
    .map((number): IssueObject =>
      issueRow(issues.get(number) as Record<string, unknown>, number, linkedByIssue.get(number) ?? []),
    );
  // THE ROW'S NOTES REACH STDERR TOO. `prRow` warns as it degrades because it
  // holds the warn callback; `issueRow` is pure, so its notes are relayed here
  // -- the operator watching the run and the reader of the published register
  // must see the same degradations either way.
  for (const row of issueRows) {
    for (const entry of row.notes) warn(`objects: ${target.slug}#${row.number}: ${entry}`);
  }
  return [...issueRows, ...prs];
}

/**
 * ONE PULL REQUEST'S ROW, READ FIELD BY FIELD AND DEGRADED FIELD BY FIELD.
 *
 * THIS DOES NOT GO THROUGH ../pr/fetch.ts, AND THAT IS THE WHOLE POINT
 * (Nobunaga N2). `fetchPullRequest` is the GATE's read: it routes every field
 * through ../github/parse.ts and throws the moment one will not validate,
 * because a readiness verdict computed from a rollup nobody could read is the
 * worst thing this CLI can produce. That rule is right THERE and wrong HERE. A
 * register is a DISPLAY, and routing it through a fail-closed parser meant one
 * in-flight check run whose `conclusion` came back as `""` -- an ordinary,
 * momentary GitHub state -- deleted the entire pull request the caller had
 * named by number, at exit 0, with an empty `objects: []` and a warning nobody
 * reads in a report. The register LOST AN OBJECT IT WAS ASKED FOR, which is a
 * worse failure than any field being wrong.
 *
 * So every field is read on its own and degrades on its own: a rollup that will
 * not validate is counted from what parsed, `mergeStateStatus` is carried
 * verbatim as the string GitHub sent, an unreadable thread walk is `0/0`, and
 * each degradation is NAMED -- in the row's own `notes[]` and on stderr. The
 * one thing that can still lose the row is `gh pr view` itself failing, because
 * then there is no object to describe at all.
 *
 * READINESS IS STILL ALLOWED TO BE NULL, and it is the one field that keeps the
 * fail-closed reading: it is a VERDICT rather than a fact, and a verdict
 * computed from a degraded read would be exactly the false green the gate's own
 * parser exists to prevent. A row whose head SHA could not be read carries
 * `readiness: null` with the reason in `notes[]`.
 */
async function prRow(
  seams: Seams,
  target: Target,
  number: number,
  repoRoot: string,
  warn: (line: string) => void,
): Promise<PrObject> {
  const notes: string[] = [];
  const note = (line: string): void => {
    notes.push(line);
    warn(`objects: ${target.slug}#${number}: ${line}`);
  };

  const result = seams.run(GH, [...viewArgv(target, number)]);
  if (result.spawnFailed || result.code !== 0) {
    throw new ObjectsError(
      `could not read ${target.slug}#${number}, which this invocation named ('gh pr view' ${result.spawnFailed ? "could not be started" : `exited ${result.code}`}: ${outputLines(result.stderr).join(" ") || "no output"}). Refusing to publish a register that silently leaves out an object you asked for -- a short list reads as the whole list.`,
    );
  }
  let view: Record<string, unknown>;
  try {
    view = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (error) {
    throw new ObjectsError(
      `could not read ${target.slug}#${number}, which this invocation named ('gh pr view' did not answer JSON: ${String(error)}). Refusing to publish a register that silently leaves out an object you asked for.`,
    );
  }

  // EVERY COERCION IS ANNOUNCED (Copilot, #221). A fallback that silently
  // replaced a malformed field with "" left a row that looks complete and is
  // not -- which is the exact failure `notes[]` was added to close, escaping
  // through the fields the first cut coerced inline.
  const head = degradedString(view, "headRefOid", note);
  if (head === "") note("the head SHA could not be read, so readiness could not be established");
  const checks = countRollup(view["statusCheckRollup"], note);
  const threads = readThreadCounts(seams, target, number, note);
  const title = degradedString(view, "title", note);
  const body = degradedString(view, "body", note);

  const readiness =
    head === ""
      ? null
      : (readinessFromCheck(seams, target, head, warn) ??
        (await readinessFromGate(target, number, repoRoot, warn)));

  return {
    kind: "pr",
    number: degradedNumber(view, "number", number, note),
    title,
    url: degradedString(view, "url", note),
    state: degradedString(view, "state", note),
    labels: readLabels(view["labels"], note),
    head,
    // VERBATIM, whatever it says. GitHub's own composite is CLEAN/DIRTY/
    // BLOCKED/BEHIND/UNSTABLE/UNKNOWN today and may gain a word tomorrow; a row
    // that refused an unfamiliar one would be a register that breaks on a
    // GitHub release, and this field is printed, never branched on.
    mergeStateStatus:
      typeof view["mergeStateStatus"] === "string"
        ? view["mergeStateStatus"]
        : (note(`'mergeStateStatus' was not a string (${describe(view["mergeStateStatus"])}); reported as UNKNOWN`), "UNKNOWN"),
    checks,
    threads,
    reviewRequests: readReviewRequests(view["reviewRequests"], note),
    linked: [...referencedIssueNumbers(`${title}\n${body}`)].sort((a, b): number => a - b),
    readiness,
    notes,
  };
}

/** A string field, or the empty string WITH the degradation named. */
function degradedString(view: Record<string, unknown>, key: string, note: (line: string) => void): string {
  const value = view[key];
  if (typeof value === "string") return value;
  // An ABSENT field is not a degradation on every payload -- `body` is
  // legitimately null on a pull request with none -- so `null`/`undefined`
  // pass quietly and only a value of the WRONG TYPE is announced.
  if (value === undefined || value === null) return "";
  note(`'${key}' was not a string (${describe(value)}); reported as empty`);
  return "";
}

/** A number field, or the caller's own number WITH the degradation named. */
function degradedNumber(
  view: Record<string, unknown>,
  key: string,
  fallback: number,
  note: (line: string) => void,
): number {
  const value = view[key];
  if (typeof value === "number") return value;
  note(`'${key}' was not a number (${describe(value)}); reported as ${fallback}, the number this invocation named`);
  return fallback;
}

/** `labels` as names, naming what it had to drop. */
function readLabels(value: unknown, note: (line: string) => void): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    note(`'labels' was not a list (${describe(value)}); reported as none`);
    return [];
  }
  const names = value
    .map((entry): string =>
      typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string"
        ? ((entry as { name: string }).name)
        : "",
    )
    .filter((name): boolean => name !== "");
  if (names.length !== value.length) {
    note(`${value.length - names.length} of ${value.length} 'labels' entr(y/ies) carried no string name and were left out`);
  }
  return names;
}

/** `reviewRequests` as logins or team names -- `(.login // .name)`, leniently. */
function readReviewRequests(value: unknown, note: (line: string) => void): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    note(`'reviewRequests' was not a list (${describe(value)}); reported as none`);
    return [];
  }
  const names = value
    .map((entry): string => {
      if (typeof entry !== "object" || entry === null) return "";
      const record = entry as { login?: unknown; name?: unknown };
      if (typeof record.login === "string") return record.login;
      return typeof record.name === "string" ? record.name : "";
    })
    .filter((name): boolean => name !== "");
  if (names.length !== value.length) {
    note(`${value.length - names.length} of ${value.length} 'reviewRequests' entr(y/ies) named neither a login nor a team and were left out`);
  }
  return names;
}

/**
 * The rollup counted, STRICTLY when it validates and LENIENTLY when it does not.
 *
 * THE STRICT PATH IS TRIED FIRST AND IS UNCHANGED, so a rollup GitHub sent
 * cleanly is counted through the gate's own `latestChecks` reduction and this
 * register agrees with `nen pr ready` about how many checks are red -- which is
 * the property `countChecks`'s docblock is about, and it is worth keeping for
 * the case that is not broken.
 *
 * THE LENIENT PATH IS A FALLBACK, NOT A REPLACEMENT. It runs only when the
 * strict parse refused, counts every entry it can make sense of, and puts
 * anything it cannot into `pending` -- never into `green`. That direction is
 * not arbitrary: an entry nobody could read has not reported success, and the
 * one bucket it must never land in is the one a reader treats as "done".
 */
function countRollup(value: unknown, note: (line: string) => void): ObjectChecks {
  const parsed = parseCheckRollup(value);
  if (parsed.ok) return countChecks(parsed.value);
  note(
    `the check rollup did not validate (${parsed.error.path} -- ${parsed.error.message}), so its counts are read leniently and anything unreadable is counted pending, never green`,
  );
  if (!Array.isArray(value)) return { total: 0, green: 0, red: 0, pending: 0 };
  let green = 0;
  let red = 0;
  let pending = 0;
  for (const entry of value) {
    const record = (entry ?? {}) as { conclusion?: unknown; state?: unknown };
    const status = typeof record.conclusion === "string" && record.conclusion !== ""
      ? record.conclusion
      : typeof record.state === "string" && record.state !== ""
        ? record.state
        : null;
    if (status === null) pending += 1;
    else if (LENIENT_GREEN.has(status)) green += 1;
    else if (LENIENT_PENDING.has(status)) pending += 1;
    else red += 1;
  }
  return { total: value.length, green, red, pending };
}

/**
 * The green and the not-yet sets, for the LENIENT count only.
 *
 * They restate ../gates/predicates.ts's own two sets, and the restatement is
 * deliberate rather than an oversight: those constants are typed against the
 * validated union, and the whole reason this path exists is that the value did
 * NOT validate. The gate's sets stay the authority for every verdict; these two
 * decide only which column a display number lands in.
 */
const LENIENT_GREEN: ReadonlySet<string> = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const LENIENT_PENDING: ReadonlySet<string> = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/**
 * The thread counts, through `nen pr threads`' own tolerant walk.
 *
 * ../pr/threads.ts RATHER THAN ../pr/fetch.ts, for this module's own reason: its
 * walk reads `isResolved === true` and never `?? true`, so an unreadable
 * resolution counts as UNRESOLVED, which is the safe direction for a number a
 * human acts on -- and it does not refuse the whole snapshot over a field a
 * register only prints. A walk that fails entirely is `0/0` with the reason
 * named, because a missing count must not read as "no threads".
 */
function readThreadCounts(
  seams: Seams,
  target: Target,
  number: number,
  note: (line: string) => void,
): ObjectThreads {
  try {
    const listing = listThreads(seams, target, number);
    return {
      total: listing.threads.length,
      unresolved: listing.threads.filter((thread): boolean => !thread.isResolved).length,
    };
  } catch (error) {
    note(
      `the review threads could not be read (${error instanceof Error ? error.message : String(error)}), so the thread counts are 0/0 and mean 'not read' rather than 'none'`,
    );
    return { total: 0, unresolved: 0 };
  }
}

/**
 * The rollup, counted three ways plus a total, over the LATEST run per name.
 *
 * `latestChecks` FIRST, on ../gates/predicates.ts's own input contract: a raw
 * rollup carries every attempt, so a superseded FAILURE beside the SUCCESS that
 * replaced it would be counted red forever. The gate reduces before it counts
 * and so does this, through the same reduction, because a register that
 * disagreed with `nen pr ready` about how many checks are red is a register
 * nobody can act on.
 *
 * A CONCLUSION NOBODY REPORTED IS `pending`, NEVER `green`. That is the whole
 * `//`-chain lesson ../github/types.ts's header records: an entry still in
 * flight has said nothing, and folding "nothing" into the success bucket is how
 * a register prints "4/4 green" about a run that has not finished. The green
 * set is the gate's own `GREEN_STATUSES`, read through `checksAllGreen`'s
 * sibling rather than restated here.
 */
export function countChecks(entries: readonly RollupEntry[]): ObjectChecks {
  const latest = latestChecks(entries);
  let green = 0;
  let red = 0;
  let pending = 0;
  for (const entry of latest) {
    const status = rollupEntryStatus(entry);
    if (status === null) pending += 1;
    else if (checksAllGreen([entry])) green += 1;
    else if (status === "PENDING" || status === "EXPECTED") pending += 1;
    else red += 1;
  }
  return { total: latest.length, green, red, pending };
}

/** The human lines `report data` prints under its `objects:` heading. */
export function renderObjects(objects: readonly ReportObject[]): readonly string[] {
  const lines = [`objects: ${objects.length === 0 ? "none (no --target/--prs/--issues/--backlog/--objects-from)" : `${objects.length} row(s)`}`];
  for (const object of objects) {
    const mark = object.kind === "pr" ? "PR" : "IS";
    const verdict =
      object.readiness === null
        ? ""
        : `  [${plainLine(object.readiness.verdict)} (${object.readiness.source})]`;
    // EVERY GITHUB-CONTROLLED STRING GOES THROUGH `plainLine` ON THE HUMAN
    // SIDE (Feitan F4): a title is a string somebody typed, and a terminal
    // executes `ESC[2K` rather than printing it. `--json` above carries the
    // bytes unchanged, for the consumer that needs the real field.
    lines.push(`  ${mark} #${object.number}  ${plainLine(object.state)}  ${plainLine(object.title)}${verdict}`);
    if (object.kind === "pr") {
      lines.push(
        `      ${plainLine(object.head).slice(0, 8)}  ${plainLine(object.mergeStateStatus)}  checks ${object.checks.green}/${object.checks.total} green, ${object.checks.red} red, ${object.checks.pending} pending  threads ${object.threads.unresolved}/${object.threads.total} unresolved`,
      );
    }
    if (object.linked.length > 0) {
      lines.push(`      linked: ${object.linked.map((number): string => `#${number}`).join(", ")}`);
    }
    // A DEGRADED ROW SAYS SO WHERE IT IS READ. The stderr warning is for the
    // operator watching the run; this line is for whoever reads the rendering
    // afterwards, who never saw it.
    for (const entry of object.notes) lines.push(`      note: ${plainLine(entry)}`);
  }
  return lines;
}
