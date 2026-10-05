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
// SHAPE of the derivation.
//
// THE DOMAIN IS A PREDICATE WALK. The taxonomy's `domains.rule` rows are STRUCTURED
// DATA (../classify/taxonomy.ts parses and validates each `when`; an unknown shape
// is refused there, by pointer, at exit 1). The rows are evaluated in `order` and
// the FIRST row whose predicate holds wins -- `evaluatePredicate` below, one case
// per shape: otherwise, anyOf, repoKind, repoRole, issueLabels (a `*:name` pattern
// matches any `<ns>:name`), jobs.anyKey, and jobs.nonEmpty + everyListsOnly. The
// facts are the flags' verbatim values: the repository's kind and role as
// `nen repo classify --json` prints them (nothing here knows their vocabulary),
// the issue's labels, and the job keys. The verb never re-derives kind or role.
//
// THE DOMAIN FALLBACK ORDER (when a job has no phase in the derived domain). The
// taxonomy states it as a SENTENCE (`domains.fallback`): a clause, a colon, then
// the derived domain and the names in the order the maintainer wants them tried.
// This module reads the domain names that appear AFTER THE COLON, in order of first
// appearance (whole words), puts the derived domain first, and appends any domain
// of `domains.keys` the sentence does not name, in `keys` order -- so the order the
// maintainer wrote wins and a domain they forgot is still reachable.
//
// A REVIEWER ALIAS IS NEVER THE AGGREGATE WINNER (registry `aggregation`): a pair
// it wins counts for its `also` stand-in; with none the pair is skipped and the
// skip is reported. A reviewer RUNNER-UP always carries an `also` (the registry
// parser refuses one without), so a runner-up always resolves to an actionable alias.
//
// EMPTY AXES ARE ANSWERS (registry `emptyAxis`): no job is `undirectable` (no cell,
// no effort, no mismatch asked; the caller continues on its own session), and no
// language reads the shared cell for every job. A cell's surface is its alias's
// surface (the registry parser enforces it), so a side's surface is read from the alias.
//
// THE MISMATCH IS COMPARED IN THE SESSION'S OWN TERMS: the surface by name, the
// model by ALIAS (against `models.<modelsKey>.<winner tier>` -- aliases, not
// tiers, because two tiers can spell one alias), and the effort in DIAL space: the
// level on both sides is mapped through `effort.surfaceMap` for the session's
// surface, so a collapsed top equals the dial below it. The literal `unread` on a
// flag marks that compare unread: reported, never a mismatch.

import { VerbUsageError } from "../cli/command.js";
import { SchemaError } from "../schema/errors.js";
import type { ClassifyTaxonomy, DomainPolicy, DomainPredicate } from "../classify/taxonomy.js";
import {
  MANY_JOBS,
  MANY_LANGS,
  SHARED_CELL,
  type DirectRegistry,
  type RoutedSide,
  type RoutingEntry,
} from "./registry.js";

/** What a surface alias reads when the consumer's workflow does not spell it. */
export const UNSPELLED = "unspelled";

/** The session value a harness that cannot read a fact passes: that compare is reported, never a mismatch. */
export const UNREAD = "unread";

/** A failure the registry or taxonomy causes (exit 1), never a typo. */
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

function unique(values: readonly string[]): string[] {
  return values.filter((value, index): boolean => values.indexOf(value) === index);
}

// ── inputs ──────────────────────────────────────────────────────────────────

export interface DirectInputs {
  readonly langs: readonly string[];
  readonly jobs: readonly string[];
  /** The repository's kind, verbatim from `nen repo classify --json`. */
  readonly kind: string;
  /** The repository's role, verbatim, or null when none was given. */
  readonly role: string | null;
  /** The issue's labels as GitHub reports them. */
  readonly labels: readonly string[];
}

export interface SessionValues {
  readonly surface: string | null;
  readonly model: string | null;
  readonly effort: string | null;
}

export interface RawInputs {
  readonly langs: readonly string[];
  readonly jobs: readonly string[];
  readonly kind: string;
  readonly role: string | null;
  readonly labels: readonly string[];
}

/**
 * Validate what the caller typed. Every refusal is a usage error (exit 2) naming
 * the valid set. An EMPTY axis is not a refusal -- it is an answer (see the header);
 * kind and role are passed through verbatim and only held to being non-empty.
 */
export function parseInputs(taxonomy: ClassifyTaxonomy, raw: RawInputs): DirectInputs {
  const langKeys = taxonomy.axes.lang.keys.map((entry): string => entry.key);
  const jobKeys = taxonomy.axes.job.keys.map((entry): string => entry.key);
  const langs = unique(raw.langs);
  const jobs = unique(raw.jobs);
  const unknownLangs = langs.filter((lang): boolean => !langKeys.includes(lang));
  if (unknownLangs.length > 0) {
    throw new VerbUsageError(`--lang names unknown language key${unknownLangs.length === 1 ? "" : "s"} ${unknownLangs.map((key): string => `'${key}'`).join(", ")}. Valid: ${langKeys.join(", ")}.`);
  }
  const unknownJobs = jobs.filter((job): boolean => !jobKeys.includes(job));
  if (unknownJobs.length > 0) {
    throw new VerbUsageError(`--job names unknown job key${unknownJobs.length === 1 ? "" : "s"} ${unknownJobs.map((key): string => `'${key}'`).join(", ")}. Valid: ${jobKeys.join(", ")}.`);
  }
  if (raw.kind.trim() === "") throw new VerbUsageError("--kind is empty. Pass the kind 'nen repo classify --json' printed.");
  if (raw.role !== null && raw.role.trim() === "") throw new VerbUsageError("--role is empty. Pass the role 'nen repo classify --json' printed, or omit it.");
  return { langs, jobs, kind: raw.kind, role: raw.role, labels: unique(raw.labels) };
}

/** Validate the session's own values against the registry; each refusal names the valid set. */
export function parseSession(
  registry: DirectRegistry,
  raw: { readonly surface: string | null; readonly model: string | null; readonly effort: string | null },
): SessionValues {
  const surfaces = Object.keys(registry.surfaces);
  if (raw.surface !== null && raw.surface !== UNREAD && !surfaces.includes(raw.surface)) {
    throw new VerbUsageError(`--surface '${raw.surface}' is not one of: ${[...surfaces, UNREAD].join(", ")}.`);
  }
  if (raw.effort !== null && raw.effort !== UNREAD && !registry.effort.levels.includes(raw.effort)) {
    throw new VerbUsageError(`--effort '${raw.effort}' is not one of: ${[...registry.effort.levels, UNREAD].join(", ")}.`);
  }
  if (raw.model !== null && raw.model.trim() === "") {
    throw new VerbUsageError(`--model is empty. Pass the model alias the session runs, or ${UNREAD}.`);
  }
  return { surface: raw.surface, model: raw.model, effort: raw.effort };
}

// ── step 1: the domain ──────────────────────────────────────────────────────

export interface DomainVerdict {
  readonly domain: string;
  /** The `order` of the rule row that matched. */
  readonly rule: number;
  /** That row's own sentence for a reader, or null. */
  readonly because: string | null;
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
  return domains !== null && domains.length > 0 && domains.every((name): boolean => name === domain);
}

/** The facts a predicate is evaluated over: the flags' values, verbatim. */
export interface DomainFacts {
  readonly kind: string;
  readonly role: string | null;
  readonly labels: readonly string[];
  readonly jobs: readonly string[];
}

/** A label pattern: exact, or `*:name` for `<ns>:name` under any namespace. */
function labelMatches(label: string, pattern: string): boolean {
  if (!pattern.startsWith("*:")) return label === pattern;
  const colon = label.indexOf(":");
  return colon > 0 && label.slice(colon + 1) === pattern.slice(2);
}

/** Evaluate one structured predicate. Exhaustive over the shapes the taxonomy parser admits. */
export function evaluatePredicate(taxonomy: ClassifyTaxonomy, predicate: DomainPredicate, facts: DomainFacts): boolean {
  switch (predicate.kind) {
    case "otherwise":
      return true;
    case "anyOf":
      return predicate.members.some((member): boolean => evaluatePredicate(taxonomy, member, facts));
    case "repoKind":
      return predicate.values.includes(facts.kind);
    case "repoRole":
      return facts.role !== null && predicate.values.includes(facts.role);
    case "issueLabels":
      return facts.labels.some((label): boolean => predicate.any.some((pattern): boolean => labelMatches(label, pattern)));
    case "jobsAnyKey":
      return facts.jobs.some((job): boolean => predicate.keys.includes(job));
    case "jobsEveryListsOnly":
      return facts.jobs.length > 0 && facts.jobs.every((job): boolean => listsOnly(taxonomy, job, predicate.domain));
  }
}

export function requireDomains(taxonomy: ClassifyTaxonomy): DomainPolicy {
  if (taxonomy.domains === null) {
    throw new DirectError(`${taxonomy.path}: has no 'domains' block. nen direct resolve derives the domain from it.`);
  }
  if (taxonomy.domains.rule.length === 0) {
    throw new DirectError(`${taxonomy.path}: at domains.rule, there are no rows. nen direct resolve derives the domain from them.`);
  }
  return taxonomy.domains;
}

/** The first rule row whose predicate holds, in `order`. */
export function deriveDomain(taxonomy: ClassifyTaxonomy, inputs: DirectInputs): Omit<DomainVerdict, "fallbacks"> {
  const facts: DomainFacts = { kind: inputs.kind, role: inputs.role, labels: inputs.labels, jobs: inputs.jobs };
  for (const row of requireDomains(taxonomy).rule) {
    if (evaluatePredicate(taxonomy, row.when, facts)) return { domain: row.domain, rule: row.order, because: row.note };
  }
  throw new DirectError(`${taxonomy.path}: at domains.rule, no row matched. The last row is expected to be "otherwise".`);
}

/** The order domains are tried in when a job has none in the derived one (see the header). */
export function fallbackOrder(domains: DomainPolicy, derived: string): string[] {
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const colon = domains.fallback.indexOf(":");
  const listed = colon >= 0 ? domains.fallback.slice(colon + 1) : domains.fallback;
  const mentioned = domains.keys
    .map((key): { key: string; at: number } => ({
      key,
      at: listed.search(new RegExp(`(?<![A-Za-z0-9-])${escape(key)}(?![A-Za-z0-9-])`)),
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
  /** The language, or the shared cell's key when no language was given. */
  readonly lang: string;
  readonly domain: string;
  /** The derived domain, when the job was routed on another one; else null. */
  readonly fallbackFrom: string | null;
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
      surface: standIn?.surface ?? null,
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
  // No language reads the shared cell for every job (the registry's emptyAxis).
  const langs = inputs.langs.length === 0 ? [SHARED_CELL] : inputs.langs;
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
    for (const lang of langs) {
      const specific = own(entry.cells, lang);
      const cell = specific ?? own(entry.cells, SHARED_CELL);
      if (cell === undefined) {
        throw new DirectError(`${registry.path}: at routing.${job}.${used}.cells, there is no shared cell.`);
      }
      pairs.push({
        job,
        lang,
        domain: used,
        fallbackFrom: used === domain ? null : domain,
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
  /** The next distinct alias, or null when every candidate is the winner itself. */
  readonly runnerUp: string | null;
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
  // The winner won every counted pair: the second opinion is the WINNING pairs' own
  // most frequent runner-up (a reviewer already resolved to its stand-in), ties by
  // precedence. A skipped pair is never read, and the winner is never its own
  // runner-up: when every candidate equals the winner there is none distinct, and
  // the runner-up is null.
  const seconds = rank(registry, winning.map((pair): string => pair.runnerUp.alias).filter((alias): boolean => alias !== winner));
  const runnerUp = seconds[0] ?? null;
  return {
    winner,
    runnerUp,
    winnerSides: winning.map((pair): PairSide => pair.winner),
    runnerUpSides: winning.filter((pair): boolean => pair.runnerUp.alias === runnerUp).map((pair): PairSide => pair.runnerUp),
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
  /** The reviewer product this alias stood in for (its cell's `also`), so the skill can name it; else null. */
  readonly substituted: string | null;
  readonly snapshot: SnapshotQuote | null;
  readonly liveLookup: { readonly cli: string | null; readonly docs: readonly string[] } | null;
}

/** What a surface's own control is told for a level: `effort.surfaceMap[surface][level]`, or null. */
export function dial(registry: DirectRegistry, surface: string | null, level: string): string | null {
  const row = surface === null ? undefined : own(registry.effort.surfaceMap, surface);
  return row === undefined ? null : (own(row, level) ?? null);
}

export function resolveSide(
  registry: DirectRegistry,
  models: Readonly<Record<string, Readonly<Record<string, string>>>>,
  alias: string,
  sides: readonly PairSide[],
  langs: readonly string[],
  level: string,
): ResolvedSide {
  const row = own(registry.aliases, alias);
  if (row === undefined) throw new DirectError(`${registry.path}: at aliases, there is no alias '${alias}'.`);
  // A cell's surface is its alias's surface (the registry parser enforces it), so the alias says where it runs.
  const surface = row.surface;
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
  // `<alias>` and `<level>` are the registry's placeholders, filled ONLY from the
  // consumer's workflow and the effort map -- never from the snapshot or a fetched
  // page. An unspelled alias leaves its placeholder as typed.
  const restart =
    surfaceRow === undefined
      ? null
      : surfaceRow.restart
          .split("<alias>")
          .join(spelled ?? "<alias>")
          .split("<level>")
          .join(dial(registry, surface, level) ?? "<level>");
  return {
    alias,
    provider: row.provider,
    family: row.family,
    reviewer: row.reviewer,
    surface,
    tier: row.tier,
    surfaceAlias,
    restart,
    effortControl: surfaceRow?.effortControl ?? null,
    interactive,
    note: notes.length === 0 ? null : notes.join("; "),
    substituted: sides.map((side): string | null => side.substituted).find((name): boolean => name !== null) ?? null,
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
): Omit<EffortVerdict, "surfaceEffort"> {
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
  const domains = requireDomains(taxonomy);

  const applied: string[] = [];
  for (const add of registry.effort.rule.plusOne) {
    let holds: boolean;
    if (add.key === MANY_JOBS) {
      holds = inputs.jobs.length >= (add.threshold as number);
    } else if (add.key === MANY_LANGS) {
      holds = codeLangs >= (add.threshold as number);
    } else {
      // A domain add: the domain the file names beside the key, else the first
      // rule row's domain (the one a canon or process repository derives).
      const target = add.domain ?? (domains.rule[0] as DomainPolicy["rule"][number]).domain;
      if (!domains.keys.includes(target)) {
        throw new DirectError(`${registry.path}: at effort.rule.plusOne, the add '${add.key}' targets '${target}', which is not one of the taxonomy's domains [${domains.keys.join(", ")}].`);
      }
      holds = domain === target;
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
  return { score, weight, level, derivation: [`weight ${weight}`, ...applied] };
}

/** `weight 4 + manyJobs + <domain add> = 6 -> max`, the one-line derivation the human output prints. */
export function renderEffort(effort: Pick<EffortVerdict, "derivation" | "score" | "level">): string {
  return `${effort.derivation.join(" + ")} = ${effort.score} -> ${effort.level}`;
}

// ── step 6: the mismatch ────────────────────────────────────────────────────

export type Verdict = "match" | "mismatch" | "unread";

export interface Compare {
  readonly field: "surface" | "model" | "effort";
  readonly session: string;
  /** What the recommendation says in the session's own terms (the effort as the session surface's dial). */
  readonly recommended: string | null;
  readonly verdict: Verdict;
}

export interface Mismatch {
  /** True when no compare is a mismatch; an unread compare never makes one. */
  readonly match: boolean;
  /** One entry per value the session gave, in the order surface, model, effort. */
  readonly compares: readonly Compare[];
}

/**
 * Compare what the running session says about itself with the recommendation.
 * It is an ANSWER, never a refusal: a difference is reported and the caller
 * (the skill) asks once and carries on. EFFORT is compared in dial space: both
 * the session's level and the recommended one go through the session surface's
 * `effort.surfaceMap` row (the winner's surface when the session gave none or
 * `unread`), so a collapsed top equals the dial below it.
 */
export function compareSession(
  registry: DirectRegistry,
  session: SessionValues,
  winner: ResolvedSide,
  level: string,
): Mismatch | null {
  const compares: Compare[] = [];
  const decide = (field: Compare["field"], given: string, recommended: string | null, same: boolean): void => {
    compares.push({ field, session: given, recommended, verdict: given === UNREAD ? "unread" : same ? "match" : "mismatch" });
  };
  if (session.surface !== null) decide("surface", session.surface, winner.surface, session.surface === winner.surface);
  if (session.model !== null) {
    // An alias the consumer's workflow does not spell is no fact to compare against:
    // the verdict is unread with nothing recommended, never a mismatch on a non-fact.
    if (winner.surfaceAlias === UNSPELLED || winner.surfaceAlias === null) {
      compares.push({ field: "model", session: session.model, recommended: null, verdict: "unread" });
    } else {
      decide("model", session.model, winner.surfaceAlias, session.model === winner.surfaceAlias);
    }
  }
  if (session.effort !== null) {
    const readSurface = session.surface !== null && session.surface !== UNREAD ? session.surface : winner.surface;
    const recommended = dial(registry, readSurface, level);
    const given = session.effort === UNREAD ? null : dial(registry, readSurface, session.effort);
    decide("effort", session.effort, recommended, given !== null && given === recommended);
  }
  if (compares.length === 0) return null;
  return { match: compares.every((compare): boolean => compare.verdict !== "mismatch"), compares };
}

// ── the whole resolution ────────────────────────────────────────────────────

export interface Resolution {
  readonly inputs: DirectInputs;
  readonly session: SessionValues;
  /** Set when there is nothing to direct (no job); every other field is then null or empty. */
  readonly undirectable: string | null;
  readonly domain: DomainVerdict | null;
  readonly pairs: readonly Pair[];
  readonly aggregate: Pick<Aggregate, "skipped" | "tally"> | null;
  readonly winner: ResolvedSide | null;
  /** Null when undirectable, or when no alias distinct from the winner exists. */
  readonly runnerUp: ResolvedSide | null;
  readonly effort: EffortVerdict | null;
  readonly mismatch: Mismatch | null;
}

export interface ResolveContext {
  readonly registry: DirectRegistry;
  readonly taxonomy: ClassifyTaxonomy;
  /** `models.<surface>.<tier>` from the consumer's workflow; empty when it declares none. */
  readonly models: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The reason an empty job axis answers with. */
export const UNDIRECTABLE_JOB = "job axis empty";

/**
 * Once both files are loaded: a routing cell key must be the shared cell or one of
 * the taxonomy's language keys, and a routing domain one of its `domains.keys`. A
 * cell under a misspelt language would never be read, and a misspelt domain would
 * make every job it routes fall through to the fallback, both silently; refused by
 * pointer instead (exit 1: the files disagree, the caller typed nothing wrong).
 */
export function checkRegistryAgainstTaxonomy(registry: DirectRegistry, taxonomy: ClassifyTaxonomy): void {
  const domainKeys = requireDomains(taxonomy).keys;
  const langKeys = taxonomy.axes.lang.keys.map((entry): string => entry.key);
  for (const [job, domains] of Object.entries(registry.routing)) {
    for (const [domain, entry] of Object.entries(domains)) {
      if (!domainKeys.includes(domain)) {
        throw new SchemaError(registry.path, `routing.${job}.${domain}`, `names domain ${JSON.stringify(domain)}, which is not one of the taxonomy's domains.keys [${domainKeys.join(", ")}]`);
      }
      for (const cell of Object.keys(entry.cells)) {
        if (cell !== SHARED_CELL && !langKeys.includes(cell)) {
          throw new SchemaError(registry.path, `routing.${job}.${domain}.cells.${cell}`, `is neither the shared '${SHARED_CELL}' cell nor one of the taxonomy's language keys [${langKeys.join(", ")}]`);
        }
      }
    }
  }
}

export function resolveDirection(context: ResolveContext, inputs: DirectInputs, session: SessionValues): Resolution {
  const { registry, taxonomy, models } = context;
  checkRegistryAgainstTaxonomy(registry, taxonomy);
  if (inputs.jobs.length === 0) {
    return { inputs, session, undirectable: UNDIRECTABLE_JOB, domain: null, pairs: [], aggregate: null, winner: null, runnerUp: null, effort: null, mismatch: null };
  }
  const derived = deriveDomain(taxonomy, inputs);
  const { pairs, fallbacks } = collectPairs(registry, taxonomy, inputs, derived.domain);
  const decided = aggregate(registry, pairs);
  const scored = scoreEffort(registry, taxonomy, inputs, derived.domain);
  const winner = resolveSide(registry, models, decided.winner, decided.winnerSides, inputs.langs, scored.level);
  const runnerUp =
    decided.runnerUp === null ? null : resolveSide(registry, models, decided.runnerUp, decided.runnerUpSides, inputs.langs, scored.level);
  return {
    inputs,
    session,
    undirectable: null,
    domain: { ...derived, fallbacks },
    pairs,
    aggregate: { skipped: decided.skipped, tally: decided.tally },
    winner,
    runnerUp,
    effort: { ...scored, surfaceEffort: dial(registry, winner.surface, scored.level) },
    mismatch: compareSession(registry, session, winner, scored.level),
  };
}
