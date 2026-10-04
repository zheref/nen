// src/direct/resolve.ts -- the pure resolution logic behind `nen direct resolve`.
//
// WHY IT IS PURE AND SEPARATE. Hatsu's ruling of 2026-10-04: an issue's
// classification decides which model does the work, on which surface, at which
// effort -- STABLE ALIASES, REPLACEABLE VERSIONS. The registry (./registry.ts)
// carries no version and nen stores none: a recommendation here is an ALIAS, spelled
// for a surface by the consumer's own `nen/workflow.json` `models` block, and the
// snapshot a result quotes is a dated record, never something this module
// resolves through. Only Hatsu's four surfaces are actionable (the registry's
// `surfaces`). EFFORT IS A RULE -- a score over the jobs and languages, banded --
// and the MISMATCH between the session that is running and the recommendation is
// REPORTED, never enforced: the skill asks once and never blocks, so nothing in
// this module refuses a session for differing, and nothing forbids a frontier
// alias from being recommended (the verdict is for the maintainer's own session).
// The live version lookup is the skill's prose; everything here is deterministic
// and takes its inputs as ARGUMENTS (no file, no clock, no process), so every
// rule is provable from a table.
//
// EVERY NAME IS DATA. No alias, surface, domain, job, language or provider is
// written into this module (src/taxonomy-purity.test.ts). What is written is the
// SHAPE of the derivation -- which is why the five domain rows are found by their
// ORDER and their domain NAMES are read from `taxonomy.domains.rule[i].domain`,
// and why the three effort adds are found by the registry's own `plusOne` keys.
// Three closed sets are written here, because they are nen's own vocabulary and
// not the taxonomy's: a repository's role and kind (../repo/classify.ts, which
// `nen repo classify` answers in) and an issue's kind. The five rules, in order:
//
//   1  the kind is the process kind, OR the role is canon       -> row 1's domain
//   2  the kind is the library kind                             -> row 2's domain
//   3  a carried job lists ONLY row 3's domain in its phases    -> row 3's domain
//      (the marker job: the one whose phases name that domain alone)
//   4  the issue kind is bug, OR every job carried lists ONLY
//      row 4's domain                                           -> row 4's domain
//   5  otherwise                                                -> row 5's domain
//
// The rows' `when` prose is reported, never parsed: the inputs decide.
//
// THE DOMAIN FALLBACK ORDER (when a job has no phase in the derived domain). The
// taxonomy states it as a SENTENCE (`domains.fallback`): the derived domain, then
// a list of domain names in the order the maintainer wants them tried. This module
// parses the names out of that sentence in order of first appearance (whole words
// only), puts the derived domain first, and appends any domain of `domains.keys`
// the sentence does not mention in `keys` order -- so the order the maintainer
// wrote wins, and a domain they forgot to name is still reachable. It is NOT the
// `keys` order alone: the two differ in the shipped file, and the sentence is the
// declaration that is about this question.
//
// A REVIEWER ALIAS IS NEVER THE AGGREGATE WINNER. An alias the registry marks
// `reviewer` (an automated PR reviewer, not an author) is replaced by the cell's
// `also` stand-in where one is given; with none, the pair is skipped from the
// tally and the skip is reported. A reviewer may still appear as a RUNNER-UP
// where the data says so (it is a second opinion, not the work).

import { VerbUsageError } from "../cli/command.js";
import type { RepoKind, RepoRole } from "../repo/classify.js";
import type { ClassifyTaxonomy, DomainPolicy } from "../classify/taxonomy.js";
import {
  MANY_JOBS,
  MANY_LANGS,
  SHARED_CELL,
  type DirectRegistry,
  type RoutedSide,
  type RoutingEntry,
} from "./registry.js";

/** The closed sets `nen repo classify` answers in (../repo/classify.ts), as the flags spell them. */
export const REPO_KINDS: readonly RepoKind[] = ["product", "process", "library", "unknown"];
export const REPO_ROLES: readonly RepoRole[] = ["canon", "consumer", "unregistered"];
export type IssueKind = "bug" | "enhancement" | "none";
export const ISSUE_KINDS: readonly IssueKind[] = ["bug", "enhancement", "none"];

const PROCESS_KIND: RepoKind = "process";
const LIBRARY_KIND: RepoKind = "library";
const CANON_ROLE: RepoRole = "canon";
const BUG_KIND: IssueKind = "bug";

/** What a surface alias reads when the consumer's workflow does not spell it. */
export const UNSPELLED = "unspelled";

/** The number of rows `domains.rule` must carry for this derivation. */
const RULE_ROWS = 5;

/** A registry or taxonomy that cannot answer the question asked of it -- a failure (exit 1), never a typo. */
export class DirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectError";
  }
}

/** `record[key]` only when the record OWNS the key, so a user-typed token never reads a prototype member. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

// ── inputs ──────────────────────────────────────────────────────────────────

export interface DirectInputs {
  readonly langs: readonly string[];
  readonly jobs: readonly string[];
  readonly kind: RepoKind;
  readonly role: RepoRole | null;
  readonly issueKind: IssueKind;
}

export interface SessionValues {
  readonly surface: string | null;
  readonly tier: string | null;
  readonly effort: string | null;
}

export interface RawInputs {
  readonly langs: readonly string[];
  readonly jobs: readonly string[];
  readonly kind: string;
  readonly role: string | null;
  readonly issueKind: string | null;
}

function oneOf<T extends string>(flag: string, value: string, valid: readonly T[]): T {
  const found = valid.find((candidate): boolean => candidate === value);
  if (found === undefined) {
    throw new VerbUsageError(`--${flag} '${value}' is not one of: ${valid.join(", ")}.`);
  }
  return found;
}

function unique(values: readonly string[]): string[] {
  return values.filter((value, index): boolean => values.indexOf(value) === index);
}

/**
 * Validate what the caller typed. Every refusal is a usage error (exit 2) naming
 * the valid set, because "you typed it wrong" must stay distinguishable from "the
 * registry cannot answer".
 */
export function parseInputs(taxonomy: ClassifyTaxonomy, raw: RawInputs): DirectInputs {
  const langKeys = taxonomy.axes.lang.keys.map((entry): string => entry.key);
  const jobKeys = taxonomy.axes.job.keys.map((entry): string => entry.key);
  const langs = unique(raw.langs);
  const jobs = unique(raw.jobs);
  if (langs.length === 0) throw new VerbUsageError(`--lang needs at least one language key. Valid: ${langKeys.join(", ")}.`);
  if (jobs.length === 0) throw new VerbUsageError(`--job needs at least one job key. Valid: ${jobKeys.join(", ")}.`);
  const unknownLangs = langs.filter((lang): boolean => !langKeys.includes(lang));
  if (unknownLangs.length > 0) {
    throw new VerbUsageError(`--lang names unknown language key${unknownLangs.length === 1 ? "" : "s"} ${unknownLangs.map((key): string => `'${key}'`).join(", ")}. Valid: ${langKeys.join(", ")}.`);
  }
  const unknownJobs = jobs.filter((job): boolean => !jobKeys.includes(job));
  if (unknownJobs.length > 0) {
    throw new VerbUsageError(`--job names unknown job key${unknownJobs.length === 1 ? "" : "s"} ${unknownJobs.map((key): string => `'${key}'`).join(", ")}. Valid: ${jobKeys.join(", ")}.`);
  }
  return {
    langs,
    jobs,
    kind: oneOf("kind", raw.kind, REPO_KINDS),
    role: raw.role === null ? null : oneOf("role", raw.role, REPO_ROLES),
    issueKind: raw.issueKind === null ? "none" : oneOf("issue-kind", raw.issueKind, ISSUE_KINDS),
  };
}

/** Validate the session's own values against the registry; each refusal names the valid set. */
export function parseSession(
  registry: DirectRegistry,
  raw: { readonly surface: string | null; readonly tier: string | null; readonly effort: string | null },
): SessionValues {
  const surfaces = Object.keys(registry.surfaces);
  if (raw.surface !== null && !surfaces.includes(raw.surface)) {
    throw new VerbUsageError(`--surface '${raw.surface}' is not one of: ${surfaces.join(", ")}.`);
  }
  if (raw.effort !== null && !registry.effort.levels.includes(raw.effort)) {
    throw new VerbUsageError(`--effort '${raw.effort}' is not one of: ${registry.effort.levels.join(", ")}.`);
  }
  return { surface: raw.surface, tier: raw.tier, effort: raw.effort };
}

// ── step 1: the domain ──────────────────────────────────────────────────────

export interface DomainVerdict {
  readonly domain: string;
  /** The `order` of the rule row that decided. */
  readonly rule: number;
  /** That row's own prose condition, as the taxonomy states it. */
  readonly when: string;
  /** Which input decided it, in words. */
  readonly because: string;
  /** One note per job that had no phase in the domain and was routed elsewhere. */
  readonly fallbacks: readonly string[];
}

/** The domains a job lists phases under, or null when the taxonomy states none for it. */
function jobDomains(taxonomy: ClassifyTaxonomy, job: string): readonly string[] | null {
  const phases = taxonomy.axes.job.keys.find((entry): boolean => entry.key === job)?.phases ?? null;
  return phases === null ? null : Object.keys(phases);
}

function listsOnly(taxonomy: ClassifyTaxonomy, job: string, domain: string): boolean {
  const domains = jobDomains(taxonomy, job);
  return domains !== null && domains.length === 1 && domains[0] === domain;
}

export function requireDomains(taxonomy: ClassifyTaxonomy): DomainPolicy {
  if (taxonomy.domains === null) {
    throw new DirectError(`${taxonomy.path}: has no 'domains' block. nen direct resolve derives the domain from it.`);
  }
  if (taxonomy.domains.rule.length !== RULE_ROWS) {
    throw new DirectError(
      `${taxonomy.path}: at domains.rule, found ${taxonomy.domains.rule.length} rows; the derivation implements exactly ${RULE_ROWS}, in order (process-or-canon, library, marker job, bug-or-maintenance-only, otherwise).`,
    );
  }
  return taxonomy.domains;
}

export function deriveDomain(taxonomy: ClassifyTaxonomy, inputs: DirectInputs): Omit<DomainVerdict, "fallbacks"> {
  const [processRow, libraryRow, markerRow, bugRow, otherwiseRow] = requireDomains(taxonomy).rule;
  if (processRow === undefined || libraryRow === undefined || markerRow === undefined || bugRow === undefined || otherwiseRow === undefined) {
    throw new DirectError(`${taxonomy.path}: at domains.rule, the five rows are not all present`);
  }
  const verdict = (row: typeof processRow, because: string): Omit<DomainVerdict, "fallbacks"> => ({
    domain: row.domain,
    rule: row.order,
    when: row.when,
    because,
  });

  if (inputs.kind === PROCESS_KIND || inputs.role === CANON_ROLE) {
    return verdict(processRow, inputs.role === CANON_ROLE ? `the role is ${CANON_ROLE}` : `the kind is ${PROCESS_KIND}`);
  }
  if (inputs.kind === LIBRARY_KIND) return verdict(libraryRow, `the kind is ${LIBRARY_KIND}`);
  const marker = inputs.jobs.find((job): boolean => listsOnly(taxonomy, job, markerRow.domain));
  if (marker !== undefined) return verdict(markerRow, `job ${marker} lists only the ${markerRow.domain} domain`);
  if (inputs.issueKind === BUG_KIND) return verdict(bugRow, `the issue kind is ${BUG_KIND}`);
  if (inputs.jobs.length > 0 && inputs.jobs.every((job): boolean => listsOnly(taxonomy, job, bugRow.domain))) {
    return verdict(bugRow, `every job carried lists only ${bugRow.domain} phases`);
  }
  return verdict(otherwiseRow, "nothing above applied");
}

/** The order domains are tried in when a job has none in the derived one (see the header). */
export function fallbackOrder(domains: DomainPolicy, derived: string): string[] {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentioned = domains.keys
    .map((key): { key: string; at: number } => ({
      key,
      at: domains.fallback.search(new RegExp(`(?<![A-Za-z0-9-])${escape(key)}(?![A-Za-z0-9-])`)),
    }))
    .filter((hit): boolean => hit.at >= 0)
    .sort((a, b): number => a.at - b.at)
    .map((hit): string => hit.key);
  return unique([derived, ...mentioned, ...domains.keys]);
}

// ── step 2: the cells ───────────────────────────────────────────────────────

export interface PairSide {
  readonly alias: string;
  readonly surface: string | null;
  readonly interactive: string | null;
  readonly note: string | null;
  /** The reviewer alias this side stood in for, when the cell named a stand-in. */
  readonly substituted: string | null;
}

export interface Pair {
  readonly job: string;
  readonly lang: string;
  readonly domain: string;
  readonly phase: string;
  readonly phaseName: string;
  /** The cell key read: the language's own, or the shared one. */
  readonly cell: string;
  readonly winner: PairSide;
  readonly runnerUp: PairSide;
}

function stand(registry: DirectRegistry, side: RoutedSide): PairSide {
  const row = own(registry.aliases, side.alias);
  if (row !== undefined && row.reviewer && side.also !== null) {
    const standIn = own(registry.aliases, side.also);
    return {
      alias: side.also,
      surface: side.surface ?? standIn?.surface ?? null,
      interactive: side.interactive,
      note: side.note,
      substituted: side.alias,
    };
  }
  return { alias: side.alias, surface: side.surface, interactive: side.interactive, note: side.note, substituted: null };
}

export function collectPairs(
  registry: DirectRegistry,
  taxonomy: ClassifyTaxonomy,
  inputs: DirectInputs,
  domain: string,
): { readonly pairs: readonly Pair[]; readonly fallbacks: readonly string[] } {
  const order = fallbackOrder(requireDomains(taxonomy), domain);
  const pairs: Pair[] = [];
  const fallbacks: string[] = [];
  for (const job of inputs.jobs) {
    const routing = own(registry.routing, job);
    if (routing === undefined) {
      throw new DirectError(`${registry.path}: at routing, there is no job '${job}'. The taxonomy names it; the registry has to route it.`);
    }
    let used = domain;
    let entry: RoutingEntry | undefined = own(routing, domain);
    if (entry === undefined) {
      const other = order.find((candidate): boolean => own(routing, candidate) !== undefined);
      entry = other === undefined ? undefined : own(routing, other);
      if (other === undefined || entry === undefined) {
        throw new DirectError(`${registry.path}: at routing.${job}, no domain this taxonomy names is routed.`);
      }
      used = other;
      fallbacks.push(`fallback: ${job} has no ${domain} phase; routed on ${other}`);
    }
    for (const lang of inputs.langs) {
      const specific = own(entry.cells, lang);
      const cell = specific ?? own(entry.cells, SHARED_CELL);
      if (cell === undefined) {
        throw new DirectError(`${registry.path}: at routing.${job}.${used}.cells, there is no shared cell.`);
      }
      pairs.push({
        job,
        lang,
        domain: used,
        phase: entry.phase,
        phaseName: entry.phaseName,
        cell: specific === undefined ? SHARED_CELL : lang,
        winner: stand(registry, cell.winner),
        runnerUp: stand(registry, cell.runnerUp),
      });
    }
  }
  return { pairs, fallbacks };
}

// ── step 3: the aggregate ───────────────────────────────────────────────────

export interface Skipped {
  readonly job: string;
  readonly lang: string;
  readonly alias: string;
}

export interface Aggregate {
  readonly winner: string;
  readonly runnerUp: string;
  /** The sides of the pairs that decided each alias, first pair first. */
  readonly winnerSides: readonly PairSide[];
  readonly runnerUpSides: readonly PairSide[];
  /** Pairs whose winner was a reviewer alias with no stand-in, left out of the tally. */
  readonly skipped: readonly Skipped[];
  readonly tally: Readonly<Record<string, number>>;
}

function isReviewer(registry: DirectRegistry, alias: string): boolean {
  return own(registry.aliases, alias)?.reviewer === true;
}

/** Aliases ordered by frequency, then by the registry's precedence (earlier wins), then first appearance. */
function rank(registry: DirectRegistry, seen: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const alias of seen) counts.set(alias, (counts.get(alias) ?? 0) + 1);
  const precedence = (alias: string): number => {
    const index = registry.precedence.indexOf(alias);
    return index < 0 ? registry.precedence.length : index;
  };
  return [...counts.keys()].sort(
    (a, b): number => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || precedence(a) - precedence(b) || seen.indexOf(a) - seen.indexOf(b),
  );
}

export function aggregate(registry: DirectRegistry, pairs: readonly Pair[]): Aggregate {
  const skipped: Skipped[] = [];
  const counted: Pair[] = [];
  for (const pair of pairs) {
    if (isReviewer(registry, pair.winner.alias)) {
      skipped.push({ job: pair.job, lang: pair.lang, alias: pair.winner.alias });
    } else {
      counted.push(pair);
    }
  }
  if (counted.length === 0) {
    throw new DirectError(
      `every (job, language) pair's winner is a reviewer alias with no stand-in (${unique(skipped.map((row): string => row.alias)).join(", ")}); a reviewer is never the recommendation, and the registry names no author for these cells.`,
    );
  }
  const ranked = rank(registry, counted.map((pair): string => pair.winner.alias));
  const winner = ranked[0] as string;
  const winning = counted.filter((pair): boolean => pair.winner.alias === winner);
  const tally = Object.fromEntries(
    ranked.map((alias): [string, number] => [alias, counted.filter((pair): boolean => pair.winner.alias === alias).length]),
  );

  const nextWinner = ranked[1];
  if (nextWinner !== undefined) {
    return {
      winner,
      runnerUp: nextWinner,
      winnerSides: winning.map((pair): PairSide => pair.winner),
      runnerUpSides: counted.filter((pair): boolean => pair.winner.alias === nextWinner).map((pair): PairSide => pair.winner),
      skipped,
      tally,
    };
  }
  // Every counted pair agreed on the winner: the second opinion is the winning
  // pairs' own most frequent runner-up, else the first pair's.
  const seconds = rank(registry, winning.map((pair): string => pair.runnerUp.alias).filter((alias): boolean => alias !== winner));
  const runnerUp = seconds[0] ?? (pairs[0] as Pair).runnerUp.alias;
  return {
    winner,
    runnerUp,
    winnerSides: winning.map((pair): PairSide => pair.winner),
    runnerUpSides: (seconds[0] === undefined ? [pairs[0] as Pair] : winning.filter((pair): boolean => pair.runnerUp.alias === runnerUp)).map(
      (pair): PairSide => pair.runnerUp,
    ),
    skipped,
    tally,
  };
}

// ── step 4: one side, resolved ──────────────────────────────────────────────

export interface SnapshotQuote {
  readonly asOf: string;
  readonly primary: string;
  readonly modelId: string | null;
  readonly fallback: string;
}

export interface ResolvedSide {
  readonly alias: string;
  readonly provider: string;
  readonly family: string;
  readonly reviewer: boolean;
  readonly surface: string | null;
  readonly tier: string | null;
  /** The consumer's spelling of the alias on the surface, or UNSPELLED; null when there is no surface. */
  readonly surfaceAlias: string | null;
  readonly restart: string | null;
  readonly effortControl: string | null;
  readonly interactive: readonly string[];
  readonly note: string | null;
  readonly snapshot: SnapshotQuote | null;
  readonly liveLookup: { readonly cli: string | null; readonly docs: readonly string[] } | null;
}

/** The surface most of the contributing sides name, first appearance breaking a tie; the alias default when none names one. */
function chooseSurface(defaultSurface: string | null, sides: readonly PairSide[]): string | null {
  const named = sides.map((side): string | null => side.surface).filter((surface): surface is string => surface !== null);
  if (named.length === 0) return defaultSurface;
  const counts = new Map<string, number>();
  for (const surface of named) counts.set(surface, (counts.get(surface) ?? 0) + 1);
  return [...counts.keys()].sort((a, b): number => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || named.indexOf(a) - named.indexOf(b))[0] ?? defaultSurface;
}

export function resolveSide(
  registry: DirectRegistry,
  models: Readonly<Record<string, Readonly<Record<string, string>>>>,
  alias: string,
  sides: readonly PairSide[],
  langs: readonly string[],
): ResolvedSide {
  const row = own(registry.aliases, alias);
  if (row === undefined) throw new DirectError(`${registry.path}: at aliases, there is no alias '${alias}'.`);
  // The cell's surface wins over the alias's default when it names one.
  const surface = chooseSurface(row.surface, sides);
  const surfaceRow = surface === null ? undefined : own(registry.surfaces, surface);
  const spelled =
    surfaceRow === undefined || row.tier === null ? undefined : own(own(models, surfaceRow.modelsKey) ?? {}, row.tier);
  const surfaceAlias = surfaceRow === undefined ? null : (spelled ?? UNSPELLED);
  const notes = unique(sides.map((side): string | null => side.note).filter((note): note is string => note !== null));
  const interactive = unique(
    [
      surfaceRow?.interactive ?? null,
      ...langs.map((lang): string | null => own(registry.nativeInteractive, lang) ?? null),
      ...sides.map((side): string | null => side.interactive),
    ].filter((entry): entry is string => entry !== null),
  );
  const quote = own(registry.snapshot.aliases, alias);
  return {
    alias,
    provider: row.provider,
    family: row.family,
    reviewer: row.reviewer,
    surface,
    tier: row.tier,
    surfaceAlias,
    // `<alias>` is the registry's placeholder; an unspelled alias leaves it as typed.
    restart: surfaceRow === undefined ? null : surfaceRow.restart.split("<alias>").join(spelled ?? "<alias>"),
    effortControl: surfaceRow?.effortControl ?? null,
    interactive,
    note: notes.length === 0 ? null : notes.join("; "),
    snapshot: quote === undefined ? null : { asOf: registry.snapshot.asOf, ...quote },
    liveLookup: own(registry.liveLookup, row.provider) ?? null,
  };
}

// ── step 5: the effort ──────────────────────────────────────────────────────

export interface EffortVerdict {
  readonly score: number;
  /** The highest weight among the jobs carried. */
  readonly weight: number;
  readonly level: string;
  /** The terms of the sum, e.g. `weight 4`, then each add that applied by its registry key. */
  readonly derivation: readonly string[];
  /** What the winner's surface's own control is told for this level, or null with no surface. */
  readonly surfaceEffort: string | null;
}

export function scoreEffort(
  registry: DirectRegistry,
  taxonomy: ClassifyTaxonomy,
  inputs: DirectInputs,
  domain: string,
  winnerSurface: string | null,
): EffortVerdict {
  const jobEntries = inputs.jobs.map((job): { job: string; weight: number | null } => ({
    job,
    weight: taxonomy.axes.job.keys.find((entry): boolean => entry.key === job)?.weight ?? null,
  }));
  const unweighted = jobEntries.filter((entry): boolean => entry.weight === null);
  if (unweighted.length > 0) {
    throw new DirectError(`${taxonomy.path}: at axes.job.keys, job ${unweighted.map((entry): string => `'${entry.job}'`).join(", ")} has no weight; the effort score is built from it.`);
  }
  const weight = Math.max(...jobEntries.map((entry): number => entry.weight as number));
  // A language is a CODE language unless its taxonomy entry says `code: false`: the flag is read, never the key's name.
  const codeLangs = inputs.langs.filter((lang): boolean => taxonomy.axes.lang.keys.find((entry): boolean => entry.key === lang)?.code !== false).length;
  const domainKeys = requireDomains(taxonomy).keys;

  const applied: string[] = [];
  for (const add of registry.effort.rule.plusOne) {
    let holds: boolean;
    if (add.key === MANY_JOBS) {
      holds = inputs.jobs.length >= (add.threshold as number);
    } else if (add.key === MANY_LANGS) {
      holds = codeLangs >= (add.threshold as number);
    } else {
      // A domain add: the key IS a domain's name, and it adds when that domain was derived.
      if (!domainKeys.includes(add.key)) {
        throw new DirectError(`${registry.path}: at effort.rule.plusOne, the add '${add.key}' is neither a count rule nor one of the taxonomy's domains [${domainKeys.join(", ")}].`);
      }
      holds = domain === add.key;
    }
    if (holds) applied.push(add.key);
  }
  const score = weight + applied.length;
  const level = registry.effort.levels.find((candidate): boolean => {
    const band = own(registry.effort.rule.bands, candidate);
    return band !== undefined && score >= band[0] && score <= band[1];
  });
  if (level === undefined) {
    throw new DirectError(`${registry.path}: at effort.rule.bands, no band holds the score ${score}.`);
  }
  const row = winnerSurface === null ? undefined : own(registry.effort.surfaceMap, winnerSurface);
  return {
    score,
    weight,
    level,
    derivation: [`weight ${weight}`, ...applied],
    surfaceEffort: row === undefined ? null : (own(row, level) ?? null),
  };
}

/** `weight 4 + manyJobs + aigov = 6 -> max`, the one-line derivation the human output prints. */
export function renderEffort(effort: EffortVerdict): string {
  return `${effort.derivation.join(" + ")} = ${effort.score} -> ${effort.level}`;
}

// ── step 6: the mismatch ────────────────────────────────────────────────────

export interface Difference {
  readonly field: "surface" | "tier" | "effort";
  readonly session: string;
  readonly recommended: string | null;
}

export interface Mismatch {
  /** The fields the session gave, in the order they are compared. */
  readonly compared: readonly string[];
  readonly match: boolean;
  readonly differences: readonly Difference[];
}

/**
 * Compare what the running session says about itself with the recommendation.
 * It is an ANSWER, never a refusal: a difference is reported and the caller
 * (the skill) asks once and carries on.
 */
export function compareSession(session: SessionValues, winner: ResolvedSide, level: string): Mismatch | null {
  const given: [Difference["field"], string | null, string | null][] = [
    ["surface", session.surface, winner.surface],
    ["tier", session.tier, winner.surfaceAlias],
    ["effort", session.effort, level],
  ];
  const asked = given.filter((row): row is [Difference["field"], string, string | null] => row[1] !== null);
  if (asked.length === 0) return null;
  const differences = asked
    .filter(([, mine, recommended]): boolean => mine !== recommended)
    .map(([field, mine, recommended]): Difference => ({ field, session: mine, recommended }));
  return { compared: asked.map(([field]): string => field), match: differences.length === 0, differences };
}

// ── the whole resolution ────────────────────────────────────────────────────

export interface Resolution {
  readonly inputs: DirectInputs;
  readonly session: SessionValues;
  readonly domain: DomainVerdict;
  readonly pairs: readonly Pair[];
  readonly aggregate: Pick<Aggregate, "skipped" | "tally">;
  readonly winner: ResolvedSide;
  readonly runnerUp: ResolvedSide;
  readonly effort: EffortVerdict;
  readonly mismatch: Mismatch | null;
}

export interface ResolveContext {
  readonly registry: DirectRegistry;
  readonly taxonomy: ClassifyTaxonomy;
  /** `models.<surface>.<tier>` from the consumer's workflow; empty when it declares none. */
  readonly models: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export function resolveDirection(context: ResolveContext, inputs: DirectInputs, session: SessionValues): Resolution {
  const { registry, taxonomy, models } = context;
  const derived = deriveDomain(taxonomy, inputs);
  const { pairs, fallbacks } = collectPairs(registry, taxonomy, inputs, derived.domain);
  const decided = aggregate(registry, pairs);
  const winner = resolveSide(registry, models, decided.winner, decided.winnerSides, inputs.langs);
  const runnerUp = resolveSide(registry, models, decided.runnerUp, decided.runnerUpSides, inputs.langs);
  const effort = scoreEffort(registry, taxonomy, inputs, derived.domain, winner.surface);
  return {
    inputs,
    session,
    domain: { ...derived, fallbacks },
    pairs,
    aggregate: { skipped: decided.skipped, tally: decided.tally },
    winner,
    runnerUp,
    effort,
    mismatch: compareSession(session, winner, effort.level),
  };
}
