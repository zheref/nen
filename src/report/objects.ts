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
// THE OFFLINE PATH IS VALIDATED AT THE READ SEAM, BY INDEX. `--objects-from`
// takes rows already in this shape -- it is how a caller who assembled the
// register himself (or a test) feeds it in -- and an unvalidated row would put
// `undefined` into a published register under a key the contract promises. So
// every row is checked field by field and refused at exit 2 NAMING ITS INDEX,
// the same discipline ../pr/command.ts's `validateWakes` applies to the wake
// history for the same reason: a row nobody checked is a fact nobody checked.
//
// EVERY `gh api` ARGV NAMES ITS METHOD EXPLICITLY, on ../pr/fetch.ts's module
// rule (zheref/nen#19): gh flips to POST the moment any `-f`/`-F` is supplied,
// and a READ verb that writes is the worst defect class this CLI can have.
// `report data` is the read verb par excellence -- ./data.ts's header says it
// has no write path at all -- so the rule is inherited whole, not weakened.

import { VerbUsageError } from "../cli/command.js";
import { referencedIssueNumbers, fetchPaginated } from "../backlog/fetch.js";
import type { Target } from "../github/target.js";
import { rollupEntryStatus, type RollupEntry } from "../github/types.js";
import { checksAllGreen, latestChecks } from "../gates/predicates.js";
import { fetchPullRequest } from "../pr/fetch.js";
import { GH, type Seams } from "../seam/exec.js";
import { prReady } from "../verbs/pr_ready.js";

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
    };
  });
}

// ── readiness: the check run, then the gate, then null ──────────────────────

/** `gh api --method GET repos/<slug>/commits/<sha>/check-runs`. */
export function checkRunsArgv(target: Target, sha: string): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/commits/${sha}/check-runs`];
}

interface RawCheckRun {
  readonly name?: unknown;
  readonly output?: { readonly title?: unknown; readonly summary?: unknown; readonly text?: unknown };
}

/**
 * The verdict line a `readiness` check run published, parsed.
 *
 * THE FIRST LINE THAT STARTS WITH A VERDICT WORD WINS, and nothing else is read.
 * A check run's summary is prose somebody wrote; hunting for `ready` anywhere in
 * it would find the word inside "not ready yet" and inside "readiness", which is
 * the exact substring accident a gate must not be decided by. So the match is
 * anchored: `ready` alone, or `not-ready: <reason>`.
 */
export function parseVerdictLine(text: string): { readonly verdict: string; readonly reason: string } | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^(not-ready|ready)\b\s*:?\s*(.*)$/i.exec(trimmed);
    if (match === null) continue;
    return { verdict: (match[1] as string).toLowerCase(), reason: trimmed };
  }
  return null;
}

/**
 * The head's own `readiness` check run, or null when it carries none.
 *
 * A FAILED READ IS NULL, NOT A REFUSAL: the caller falls through to the gate,
 * which is a better answer than no answer, and reports its own reason if that
 * fails too. Only a check run that EXISTS and carries a parseable verdict line
 * answers here -- one that exists and says nothing readable is not a verdict
 * this module is willing to invent a reading of.
 */
export function readinessFromCheck(
  seams: Seams,
  target: Target,
  sha: string,
  warn: (line: string) => void,
): ObjectReadiness | null {
  const result = seams.run(GH, [...checkRunsArgv(target, sha)]);
  if (result.spawnFailed || result.code !== 0) return null;
  let runs: readonly RawCheckRun[];
  try {
    const parsed = JSON.parse(result.stdout) as { check_runs?: unknown };
    runs = Array.isArray(parsed.check_runs) ? (parsed.check_runs as RawCheckRun[]) : [];
  } catch {
    return null;
  }
  const run = runs.find((entry): boolean => String(entry.name ?? "") === READINESS_CHECK);
  if (run === undefined) return null;
  const text = [run.output?.title, run.output?.summary, run.output?.text]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  const line = parseVerdictLine(text);
  if (line === null) {
    warn(
      `objects: ${target.slug}@${sha.slice(0, 8)} carries a '${READINESS_CHECK}' check run whose output names no verdict line ('ready' or 'not-ready: <reason>'); falling through to nen's own gate.`,
    );
    return null;
  }
  return { verdict: line.verdict, reason: line.reason, source: "check" };
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

interface RawGhIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly { readonly name: string }[];
  readonly state: string;
  readonly html_url: string;
  readonly body: string | null;
  readonly pull_request?: unknown;
}

/** `gh api --method GET repos/<slug>/issues/<n>`. */
export function issueArgv(target: Target, number: number): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/issues/${number}`];
}

function issueRow(raw: RawGhIssue, linked: readonly number[]): IssueObject {
  return {
    kind: "issue",
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    state: String(raw.state ?? "").toUpperCase(),
    labels: (raw.labels ?? []).map((label): string => label.name),
    linked: [...linked].sort((a, b): number => a - b),
    readiness: null,
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

  const issues = new Map<number, RawGhIssue>();
  const prNumbers = new Set<number>(options.prs);

  if (options.backlog) {
    const open = fetchPaginated<RawGhIssue>(seams, `repos/${target.slug}/issues?state=open`, null);
    for (const raw of open.items) {
      if (raw.pull_request === undefined) issues.set(raw.number, raw);
      else prNumbers.add(raw.number);
    }
    if (open.truncated) {
      warn(`objects: the open-object fetch for ${target.slug} hit its pagination ceiling; the register may be incomplete.`);
    }
  }
  for (const number of options.issues) {
    if (issues.has(number)) continue;
    const result = seams.run(GH, [...issueArgv(target, number)]);
    if (result.spawnFailed || result.code !== 0) {
      warn(`objects: could not read ${target.slug}#${number} as an issue; it is left out of the register.`);
      continue;
    }
    try {
      issues.set(number, JSON.parse(result.stdout) as RawGhIssue);
    } catch {
      warn(`objects: ${target.slug}#${number} did not answer with JSON; it is left out of the register.`);
    }
  }

  const prs: PrObject[] = [];
  const linkedByIssue = new Map<number, number[]>();
  for (const number of [...prNumbers].sort((a, b): number => a - b)) {
    const row = await prRow(seams, target, number, options.repoRoot, warn);
    if (row === null) continue;
    prs.push(row);
    for (const issueNumber of row.linked) {
      if (!issues.has(issueNumber)) continue;
      linkedByIssue.set(issueNumber, [...(linkedByIssue.get(issueNumber) ?? []), number]);
    }
  }

  const issueRows = [...issues.keys()]
    .sort((a, b): number => a - b)
    .map((number): IssueObject => issueRow(issues.get(number) as RawGhIssue, linkedByIssue.get(number) ?? []));
  return [...issueRows, ...prs];
}

async function prRow(
  seams: Seams,
  target: Target,
  number: number,
  repoRoot: string,
  warn: (line: string) => void,
): Promise<PrObject | null> {
  let snapshot: Awaited<ReturnType<typeof fetchPullRequest>>;
  try {
    snapshot = fetchPullRequest(seams, target, number);
  } catch (error) {
    warn(
      `objects: could not read ${target.slug}#${number} (${error instanceof Error ? error.message : String(error)}); it is left out of the register.`,
    );
    return null;
  }
  const head = snapshot.pr.headSha;
  const readiness =
    readinessFromCheck(seams, target, head, warn) ??
    (await readinessFromGate(target, number, repoRoot, warn));
  return {
    kind: "pr",
    number: snapshot.pr.number,
    title: snapshot.title,
    url: snapshot.url,
    state: snapshot.state,
    labels: snapshot.pr.labels,
    head,
    mergeStateStatus: snapshot.mergeStateStatus,
    checks: countChecks(snapshot.checks),
    threads: {
      total: snapshot.reviewThreads.length,
      unresolved: snapshot.reviewThreads.filter((thread): boolean => !thread.isResolved).length,
    },
    reviewRequests: snapshot.reviewRequests.map((request): string => request.login ?? request.name ?? ""),
    linked: [...referencedIssueNumbers(`${snapshot.title}\n${snapshot.body}`)].sort((a, b): number => a - b),
    readiness,
  };
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
      object.readiness === null ? "" : `  [${object.readiness.verdict} (${object.readiness.source})]`;
    lines.push(`  ${mark} #${object.number}  ${object.state}  ${object.title}${verdict}`);
    if (object.kind === "pr") {
      lines.push(
        `      ${object.head.slice(0, 8)}  ${object.mergeStateStatus}  checks ${object.checks.green}/${object.checks.total} green, ${object.checks.red} red, ${object.checks.pending} pending  threads ${object.threads.unresolved}/${object.threads.total} unresolved`,
      );
    }
    if (object.linked.length > 0) {
      lines.push(`      linked: ${object.linked.map((number): string => `#${number}`).join(", ")}`);
    }
  }
  return lines;
}
