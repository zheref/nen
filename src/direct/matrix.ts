// src/direct/matrix.ts -- the pure enumeration behind `nen direct matrix`.
//
// WHY IT EXISTS (zheref/nen#426). A consumer that renders the whole routing table
// as a page a person reads -- Hatsu's docs/DIRECT-MATRIX.md -- needs every (job,
// domain, language) answer at once, and `nen direct resolve` answers one
// classification per call. Rendering offline therefore meant re-implementing the
// domain derivation, the fallback order, the aggregation and the effort banding
// beside the verb, and proving the copy with ~1,000 resolve calls. This module
// answers the whole table from the resolver ITSELF.
//
// IT OWNS NO RULE. Every answer below is a call into ./resolve.ts:
//   - which domains a job can be in: `deriveDomain` (step 1), asked over a bounded
//     set of WITNESS issues (below) -- never a second predicate walk;
//   - the route, the fallback, the phase, the cell, the stand-in: `collectPairs`
//     (step 2), through `resolveInDomain`;
//   - the winner, the runner-up, the tally: `aggregate` (step 3), through
//     `resolveInDomain`;
//   - each side's surface, spelled alias, restart line, interactive tools,
//     snapshot quote and live lookup: `resolveSide` (step 4), through
//     `resolveInDomain`;
//   - the effort: `scoreEffort` (step 5) and the surface dial, through
//     `resolveInDomain`.
// So a cell here is, field for field, what `resolve` prints for an issue that
// carries that one job and that one language (or none) in that domain.
//
// A WITNESS IS AN ISSUE THAT PUTS THE JOB IN THE DOMAIN. The domain is derived
// from the repository's kind and role, the issue's labels and ALL its jobs, so a
// job is in a domain only when some issue carrying it derives that domain. The
// search is bounded and deterministic, and every candidate is handed to
// `deriveDomain` verbatim:
//   jobs    the job alone, then with one other job, then with two others, each in
//           the taxonomy's job order;
//   kind    a kind no rule names (KIND_NONE, suffixed until it is unnamed), then every
//           value a `repoKind` predicate names, in rule order;
//   role    none, then every value a `repoRole` predicate names, in rule order;
//   labels  none, then one label per `issueLabels` pattern, in rule order (a
//           `*:name` pattern as `<LABEL_NAMESPACE>:name`).
// The first candidate (fewest jobs, then kind, role, labels, in those orders) that
// derives a domain is that domain's witness, and a domain no candidate derives is
// UNREACHABLE for the job: printed with no cells, never a guessed route. Every
// predicate shape is a positive test (anyOf of value lists and job tests), so one
// value per fact suffices to make a row hold, and the earlier rows are made false by
// the "no value" candidates; two companion jobs cover a key job and a job that
// breaks an `everyListsOnly` row. The bound is reported in the document (`search`)
// so a caller can see exactly what "unreachable" was measured against.
//
// A CELL A REVIEWER WINS WITH NO STAND-IN has no recommendation: `resolve` refuses
// an issue whose every pair is such a cell (exit 1), so the matrix reports the cell
// as `skipped`, with its pair and effort, and never as a winner.
//
// EVERY NAME IS DATA (src/taxonomy-purity.test.ts): no alias, surface, domain, job
// or language is written here; the two placeholders below are not vocabulary of
// either contract, and the kind one is re-suffixed should a rule ever name it.

import { VerbUsageError } from "../cli/command.js";
import type { ClassifyTaxonomy, DomainPredicate } from "../classify/taxonomy.js";
import { SHARED_CELL } from "./registry.js";
import {
  checkRegistryAgainstTaxonomy,
  collectPairs,
  deriveDomain,
  fallbackOrder,
  isReviewer,
  requireDomains,
  resolveInDomain,
  scoreEffort,
  type Aggregate,
  type DirectInputs,
  type DomainVerdict,
  type EffortVerdict,
  type Pair,
  type ResolveContext,
  type ResolvedSide,
  type SessionValues,
} from "./resolve.js";

/** The kind a witness carries when no rule may match on kind. */
export const KIND_NONE = "unlisted";

/** The namespace a `*:name` label pattern is materialised under for a witness. */
export const LABEL_NAMESPACE = "ns";

/** How many jobs besides the one enumerated a witness may carry. */
export const MAX_COMPANIONS = 2;

const NO_SESSION: SessionValues = { surface: null, model: null, effort: null };

/** An issue that derives a domain, passable to `nen direct resolve` as typed. */
export interface Witness {
  readonly kind: string;
  readonly role: string | null;
  readonly labels: readonly string[];
  /** The job enumerated first, then any companions the derivation needed. */
  readonly jobs: readonly string[];
  /** The `order` of the rule row that derived the domain, and that row's own sentence. */
  readonly rule: number;
  readonly because: string | null;
}

export interface MatrixCell {
  /** The column: a language key, or the shared cell's key for an issue with no language. */
  readonly lang: string;
  /** The cell key the registry was read at: the language's own, or the shared one. */
  readonly cell: string;
  /** Step 2's pair for this job and language: route, fallback, phase, cell, both sides with any stand-in. */
  readonly pair: Pair;
  /** True when the pair's winner is a reviewer with no stand-in: no recommendation, `resolve` would refuse it alone. */
  readonly skipped: boolean;
  readonly aggregate: Pick<Aggregate, "skipped" | "tally"> | null;
  /** Step 4's winner and runner-up exactly as `resolve` prints them; null when skipped (runner-up also when none distinct). */
  readonly winner: ResolvedSide | null;
  readonly runnerUp: ResolvedSide | null;
  /** Step 5's effort for this one job and language in this domain (the surface dial null when skipped). */
  readonly effort: EffortVerdict;
}

export interface MatrixDomain {
  readonly domain: string;
  /** False when no witness in the searched space derives this domain with this job. */
  readonly reachable: boolean;
  readonly witness: Witness | null;
  /** The domain the job is routed on, its fallback source and phase; null when unreachable. */
  readonly routedOn: string | null;
  readonly fallbackFrom: string | null;
  readonly phase: string | null;
  readonly phaseName: string | null;
  /** The fallback note `resolve` prints for this job in this domain, or null when routed on it directly. */
  readonly fallback: string | null;
  readonly cells: readonly MatrixCell[];
}

export interface MatrixJob {
  readonly job: string;
  readonly weight: number | null;
  readonly domains: readonly MatrixDomain[];
}

export interface MatrixSearch {
  readonly kinds: readonly string[];
  readonly roles: readonly (string | null)[];
  readonly labels: readonly (readonly string[])[];
  readonly maxCompanions: number;
}

export interface Matrix {
  readonly search: MatrixSearch;
  /** Each domain and the order a job with no phase in it is routed on (step 2's fallback order). */
  readonly domains: readonly { readonly domain: string; readonly fallbackOrder: readonly string[] }[];
  readonly languages: readonly string[];
  readonly jobs: readonly MatrixJob[];
  readonly counts: {
    readonly jobs: number;
    readonly domains: number;
    readonly reachable: number;
    readonly unreachable: number;
    readonly cells: number;
    readonly skipped: number;
  };
}

export interface MatrixFilter {
  /** Job keys to enumerate, or null for every job of the taxonomy. */
  readonly jobs: readonly string[] | null;
  /** Domain keys to enumerate, or null for every domain of the taxonomy. */
  readonly domains: readonly string[] | null;
}

function unique<T>(values: readonly T[]): T[] {
  return values.filter((value, index): boolean => values.indexOf(value) === index);
}

/** Every atom of a predicate, anyOf flattened. */
function atoms(predicate: DomainPredicate): DomainPredicate[] {
  return predicate.kind === "anyOf" ? predicate.members.flatMap(atoms) : [predicate];
}

/** The candidate facts, read from the rule rows (see the header). */
export function searchSpace(taxonomy: ClassifyTaxonomy): MatrixSearch {
  const rows = requireDomains(taxonomy).rule.flatMap((row): DomainPredicate[] => atoms(row.when));
  const named = unique(rows.flatMap((atom): readonly string[] => (atom.kind === "repoKind" ? atom.values : [])));
  let none = KIND_NONE;
  for (let suffix = 2; named.includes(none); suffix += 1) none = `${KIND_NONE}-${suffix}`;
  const roles = unique(rows.flatMap((atom): readonly string[] => (atom.kind === "repoRole" ? atom.values : [])));
  const patterns = unique(rows.flatMap((atom): readonly string[] => (atom.kind === "issueLabels" ? atom.any : [])));
  const labels = unique(patterns.map((pattern): string => (pattern.startsWith("*:") ? `${LABEL_NAMESPACE}:${pattern.slice(2)}` : pattern)));
  return {
    kinds: [none, ...named],
    roles: [null, ...roles],
    labels: [[], ...labels.map((label): string[] => [label])],
    maxCompanions: MAX_COMPANIONS,
  };
}

/** The job sets a witness may carry: the job, then with one companion, then with two, in taxonomy order. */
function jobSets(job: string, others: readonly string[], max: number): string[][] {
  const sets: string[][] = [[job]];
  if (max >= 1) for (const one of others) sets.push([job, one]);
  if (max >= 2) {
    for (let i = 0; i < others.length; i += 1) {
      for (let j = i + 1; j < others.length; j += 1) sets.push([job, others[i] as string, others[j] as string]);
    }
  }
  return sets;
}

/** The first witness per domain for one job, or nothing for a domain no candidate derives. */
export function findWitnesses(
  taxonomy: ClassifyTaxonomy,
  search: MatrixSearch,
  job: string,
  wanted: readonly string[],
): Map<string, Witness> {
  const found = new Map<string, Witness>();
  const others = taxonomy.axes.job.keys.map((entry): string => entry.key).filter((key): boolean => key !== job);
  for (const jobs of jobSets(job, others, search.maxCompanions)) {
    for (const kind of search.kinds) {
      for (const role of search.roles) {
        for (const labels of search.labels) {
          const inputs: DirectInputs = { langs: [], jobs, kind, role, labels };
          const derived = deriveDomain(taxonomy, inputs);
          if (wanted.includes(derived.domain) && !found.has(derived.domain)) {
            found.set(derived.domain, { kind, role, labels, jobs, rule: derived.rule, because: derived.because });
            if (found.size === wanted.length) return found;
          }
        }
      }
    }
  }
  return found;
}

function checkFilter(axis: string, given: readonly string[] | null, valid: readonly string[]): readonly string[] {
  if (given === null) return valid;
  const unknown = given.filter((key): boolean => !valid.includes(key));
  if (unknown.length > 0) {
    throw new VerbUsageError(`--${axis} names unknown ${axis} key${unknown.length === 1 ? "" : "s"} ${unknown.map((key): string => `'${key}'`).join(", ")}. Valid: ${valid.join(", ")}.`);
  }
  if (given.length === 0) throw new VerbUsageError(`--${axis} is empty. Name at least one ${axis} key, or omit it for every one.`);
  // The taxonomy's order, never the flag's: the document is a table, and its rows have one order.
  return valid.filter((key): boolean => given.includes(key));
}

function cellFor(context: ResolveContext, job: string, lang: string, witness: Witness, verdict: Omit<DomainVerdict, "fallbacks">): MatrixCell {
  const { registry, taxonomy } = context;
  const inputs: DirectInputs = {
    langs: lang === SHARED_CELL ? [] : [lang],
    jobs: [job],
    kind: witness.kind,
    role: witness.role,
    labels: witness.labels,
  };
  const pair = collectPairs(registry, taxonomy, inputs, verdict.domain).pairs[0] as Pair;
  if (isReviewer(registry, pair.winner.alias)) {
    const scored = scoreEffort(registry, taxonomy, inputs, verdict.domain);
    return { lang, cell: pair.cell, pair, skipped: true, aggregate: null, winner: null, runnerUp: null, effort: { ...scored, surfaceEffort: null } };
  }
  const resolution = resolveInDomain(context, inputs, NO_SESSION, verdict);
  return {
    lang,
    cell: pair.cell,
    pair: resolution.pairs[0] as Pair,
    skipped: false,
    aggregate: resolution.aggregate,
    winner: resolution.winner,
    runnerUp: resolution.runnerUp,
    effort: resolution.effort as EffortVerdict,
  };
}

/** Enumerate every (job, domain, language) answer the resolver gives (see the header). */
export function buildMatrix(context: ResolveContext, filter: MatrixFilter): Matrix {
  const { registry, taxonomy } = context;
  checkRegistryAgainstTaxonomy(registry, taxonomy);
  const policy = requireDomains(taxonomy);
  const jobKeys = taxonomy.axes.job.keys.map((entry): string => entry.key);
  const jobs = checkFilter("job", filter.jobs, jobKeys);
  const domains = checkFilter("domain", filter.domains, policy.keys);
  const languages = [SHARED_CELL, ...taxonomy.axes.lang.keys.map((entry): string => entry.key)];
  const search = searchSpace(taxonomy);

  let reachable = 0;
  let unreachable = 0;
  let cells = 0;
  let skipped = 0;
  const rows: MatrixJob[] = jobs.map((job): MatrixJob => {
    const witnesses = findWitnesses(taxonomy, search, job, domains);
    const entries = domains.map((domain): MatrixDomain => {
      const witness = witnesses.get(domain);
      if (witness === undefined) {
        unreachable += 1;
        return { domain, reachable: false, witness: null, routedOn: null, fallbackFrom: null, phase: null, phaseName: null, fallback: null, cells: [] };
      }
      reachable += 1;
      const verdict = { domain, rule: witness.rule, because: witness.because };
      const row = languages.map((lang): MatrixCell => cellFor(context, job, lang, witness, verdict));
      cells += row.length;
      skipped += row.filter((cell): boolean => cell.skipped).length;
      const first = (row[0] as MatrixCell).pair;
      const note = collectPairs(registry, taxonomy, { langs: [], jobs: [job], kind: witness.kind, role: witness.role, labels: witness.labels }, domain).fallbacks[0] ?? null;
      return {
        domain,
        reachable: true,
        witness,
        routedOn: first.domain,
        fallbackFrom: first.fallbackFrom,
        phase: first.phase,
        phaseName: first.phaseName,
        fallback: note,
        cells: row,
      };
    });
    const weight = taxonomy.axes.job.keys.find((entry): boolean => entry.key === job)?.weight ?? null;
    return { job, weight, domains: entries };
  });

  return {
    search,
    domains: domains.map((domain): { domain: string; fallbackOrder: string[] } => ({ domain, fallbackOrder: fallbackOrder(policy, domain) })),
    languages,
    jobs: rows,
    counts: { jobs: rows.length, domains: domains.length, reachable, unreachable, cells, skipped },
  };
}
