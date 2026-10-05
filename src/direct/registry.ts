// src/direct/registry.ts -- the model-direction registry file, read as DATA.
//
// WHY THIS MODULE EXISTS. Hatsu's ruling of 2026-10-04: an issue's classification
// (its languages and jobs, ../classify/taxonomy.ts) decides which model should do
// the work, on which surface, at which effort. STABLE ALIASES, REPLACEABLE
// VERSIONS: the registry names an ALIAS (a role: the frontier author, the
// execution model, the visual orchestrator...) and pins no version -- the dated
// `snapshot` block is a quoted record of what each alias meant on one day, never
// a thing nen resolves through, and NEN STORES NO VERSION of its own. Which
// surfaces are actionable is also the ruling's: the four the registry's
// `surfaces` block carries. Effort is a RULE (a score over the jobs and
// languages, banded), not a table of answers. The mismatch between the session
// that is running and the recommendation asks ONCE in the skill and never
// blocks; the verb only REPORTS it (./command.ts, ./resolve.ts). The judgement
// is the skill's prose; this file and its neighbours are the deterministic half.
//
// THE FILE IS Hatsu's, and nen reads every word of it. No alias, surface,
// domain, job, language or provider name is written into this binary
// (src/taxonomy-purity.test.ts holds the whole shipped tree to that; fixtures
// and tests may name what they like). What IS written here is the file's SHAPE:
// its structural field names (`aliases`, `surfaces`, `routing`, `cells`,
// `winner`, `runnerUp`, `effort`, `levels`, `bands`, `precedence`...) and the
// one structural key of a routing entry, SHARED_CELL -- the cell every language
// falls back to -- which is a field of the contract the way ../schema/labels.ts
// knows the word `labels`, not a value of the vocabulary.
//
// A CELL'S SURFACE IS ITS ALIAS'S SURFACE (the registry's `surfaceRule`): the
// consumer's workflow maps an alias onto a tier and a tier onto the surface's own
// alias, so a cell that moved an alias to another surface would name a tier that
// surface lacks. The parser refuses it by pointer. A reviewer alias as a runner-up
// must name its `also` stand-in, so a runner-up always resolves to an actionable
// alias. Every `$`-prefixed key (`$comment`, `$collapsed`) is metadata and is
// skipped wherever the file is walked, the house rule of ../schema/source.ts.
//
// A BAD FILE IS A LOUD, POINTED REFUSAL (../schema/errors.ts): the path, the
// pointer into the file and what was found. The refusals the contract names:
// a routing cell whose alias or surface the registry does not declare, a
// surface without a string `modelsKey`, an effort block whose levels are not
// four or whose surface map does not cover them, bands that overlap or leave a
// score unplaced, a precedence that does not list every alias exactly once, and
// a snapshot date that is not a date. A binary that guessed any of these would
// recommend a model the maintainer never declared.

import { readFileSync } from "node:fs";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { WEIGHT_MAX } from "../classify/taxonomy.js";
import {
  describeValue,
  isRecord,
  requireArray,
  requireBoolean,
  requireRecord,
  requireString,
  SchemaError,
} from "../schema/errors.js";

/** The contract line every revision of the file opens with, e.g. `<owner>.direct-registry/v1`. */
const SCHEMA_LINE = /^[A-Za-z0-9._-]*direct-registry\/v1$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The one structural key of a routing entry's `cells`: the cell a language without its own cell reads. */
export const SHARED_CELL = "*";

/**
 * The `effort.rule.plusOne` keys that are COUNTS: each carries a `threshold`, and
 * the add applies when the count it names reaches it. Any other key is a DOMAIN
 * add: no threshold, and it applies when the derived domain IS that key -- the
 * name is the registry's own datum, never a literal here (./resolve.ts).
 */
export const MANY_JOBS = "manyJobs";
export const MANY_LANGS = "manyLangs";
export const COUNT_ADD_KEYS: readonly string[] = [MANY_JOBS, MANY_LANGS];

/** How many levels an effort ladder has -- the ruling's four. */
export const LEVEL_COUNT = 4;

export interface SnapshotAlias {
  readonly primary: string;
  /** The provider's model id on the snapshot day, or null where the surface takes none. */
  readonly modelId: string | null;
  readonly fallback: string;
}

export interface RegistryAlias {
  readonly provider: string;
  readonly family: string;
  /** The surface the alias runs on by default, or null (a reviewer bot has none). */
  readonly surface: string | null;
  /** The tier key of `models.<surface>` in the consumer's workflow, or null. */
  readonly tier: string | null;
  /** A reviewer alias is never an aggregate winner (./resolve.ts). */
  readonly reviewer: boolean;
  readonly selection: string;
}

export interface RegistrySurface {
  readonly label: string;
  /** The key of the consumer's `nen/workflow.json` `models` block this surface reads. */
  readonly modelsKey: string;
  readonly restart: string;
  readonly interactive: string;
  readonly effortControl: string;
  readonly lookup: string;
}

export interface LiveLookup {
  readonly cli: string | null;
  readonly docs: readonly string[];
}

export interface PlusOne {
  readonly when: string;
  readonly key: string;
  /** Present on a count add, absent on a domain add. */
  readonly threshold: number | null;
  /**
   * A domain add's target domain when the file names one beside the key; null
   * otherwise, and the verb then reads the taxonomy's first rule row's domain.
   */
  readonly domain: string | null;
}

export interface EffortRule {
  readonly base: string;
  readonly plusOne: readonly PlusOne[];
  /** level -> [lowest score, highest score], inclusive. */
  readonly bands: Readonly<Record<string, readonly [number, number]>>;
}

export interface EffortPolicy {
  /** The ladder, lowest first. */
  readonly levels: readonly string[];
  readonly rule: EffortRule;
  /** surface -> level -> what the surface's own control is told. */
  readonly surfaceMap: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface RoutedSide {
  readonly alias: string;
  readonly surface: string | null;
  readonly interactive: string | null;
  /** The actionable alias that stands in when `alias` is a reviewer. */
  readonly also: string | null;
  readonly note: string | null;
}

export interface RoutingCell {
  readonly winner: RoutedSide;
  readonly runnerUp: RoutedSide;
}

export interface RoutingEntry {
  readonly phase: string;
  readonly phaseName: string;
  readonly alsoPhases: readonly string[];
  /** language key (or SHARED_CELL) -> cell. SHARED_CELL is always present. */
  readonly cells: Readonly<Record<string, RoutingCell>>;
}

/**
 * The compares this binary implements, in order, and the ledger it writes: the
 * registry's `mismatch` block must STATE these, because the binary implements one
 * contract and a file that names another would be read by nothing.
 */
export const MISMATCH_COMPARES: readonly string[] = ["surface", "model", "effort"];
export const MISMATCH_LEDGER = ".nen/direct/<effort>.json";

export interface MismatchPolicy {
  readonly compares: readonly string[];
  readonly ledger: string;
}

export interface DirectRegistry {
  readonly path: string;
  readonly schema: string;
  readonly contract: string;
  readonly snapshot: {
    readonly asOf: string;
    readonly aliases: Readonly<Record<string, SnapshotAlias>>;
  };
  readonly aliases: Readonly<Record<string, RegistryAlias>>;
  readonly surfaces: Readonly<Record<string, RegistrySurface>>;
  /** language key -> the native interactive tool for it. */
  readonly nativeInteractive: Readonly<Record<string, string>>;
  readonly liveLookup: Readonly<Record<string, LiveLookup>>;
  readonly effort: EffortPolicy;
  /** Alias names, earliest wins a tie. */
  readonly precedence: readonly string[];
  readonly mismatch: MismatchPolicy;
  readonly phases: Readonly<Record<string, string>>;
  /** job -> domain -> entry. */
  readonly routing: Readonly<Record<string, Readonly<Record<string, RoutingEntry>>>>;
}

/** An entry of an object-valued block, skipping the `$`-prefixed metadata keys every contract file may carry. */
function entriesOf(record: Record<string, unknown>): [string, unknown][] {
  return Object.entries(record).filter(([name]): boolean => !name.startsWith("$"));
}

/** A string, or null for an explicit JSON null; anything else (including absence) is refused. */
function stringOrNull(path: string, pointer: string, value: unknown): string | null {
  if (value === null) return null;
  return requireString(path, pointer, value);
}

function requireStringList(path: string, pointer: string, value: unknown): string[] {
  return requireArray(path, pointer, value).map((entry, index): string =>
    requireString(path, `${pointer}[${index}]`, entry),
  );
}

function parseAsOf(path: string, value: unknown): string {
  const text = requireString(path, "snapshot.asOf", value);
  // A well-formed string can still name no day (month 13, February 30): JS dates
  // roll such a value over or refuse it, so the round trip is what proves it real.
  const parsed = ISO_DATE.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  const real = parsed !== null && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
  if (!real) {
    throw new SchemaError(path, "snapshot.asOf", `expected a calendar date written YYYY-MM-DD, got ${describeValue(text)}`);
  }
  return text;
}

function parseAliases(path: string, value: unknown, surfaceNames: readonly string[]): Record<string, RegistryAlias> {
  const record = requireRecord(path, "aliases", value);
  const aliases: Record<string, RegistryAlias> = {};
  for (const [name, entry] of entriesOf(record)) {
    const pointer = `aliases.${name}`;
    const row = requireRecord(path, pointer, entry);
    const surface = stringOrNull(path, `${pointer}.surface`, row["surface"]);
    if (surface !== null && !surfaceNames.includes(surface)) {
      throw new SchemaError(
        path,
        `${pointer}.surface`,
        `names surface ${describeValue(surface)}, which is not one of surfaces [${surfaceNames.join(", ")}]`,
      );
    }
    const tier = stringOrNull(path, `${pointer}.tier`, row["tier"]);
    const reviewer = row["reviewer"] === undefined ? false : requireBoolean(path, `${pointer}.reviewer`, row["reviewer"]);
    // Only a reviewer (an automated PR reviewer, not an author) may run nowhere: every
    // other alias is spelled for a surface by a tier of the consumer's workflow, so
    // one without both could never be recommended or spelled.
    if (!reviewer) {
      for (const [field, found] of [["surface", surface], ["tier", tier]] as const) {
        if (found === null) {
          throw new SchemaError(path, `${pointer}.${field}`, `is null. Only an alias marked 'reviewer: true' may have no ${field}; an author alias carries both surface and tier`);
        }
      }
    }
    aliases[name] = {
      provider: requireString(path, `${pointer}.provider`, row["provider"]),
      family: requireString(path, `${pointer}.family`, row["family"]),
      surface,
      tier,
      reviewer,
      selection: requireString(path, `${pointer}.selection`, row["selection"]),
    };
  }
  if (Object.keys(aliases).length === 0) {
    throw new SchemaError(path, "aliases", "is empty. A registry with no aliases can recommend nothing.");
  }
  return aliases;
}

function parseSnapshot(
  path: string,
  value: unknown,
  aliasNames: readonly string[],
): DirectRegistry["snapshot"] {
  const record = requireRecord(path, "snapshot", value);
  const asOf = parseAsOf(path, record["asOf"]);
  const rows = requireRecord(path, "snapshot.aliases", record["aliases"]);
  const aliases: Record<string, SnapshotAlias> = {};
  for (const [name, entry] of entriesOf(rows)) {
    const pointer = `snapshot.aliases.${name}`;
    if (!aliasNames.includes(name)) {
      throw new SchemaError(path, pointer, `quotes alias ${describeValue(name)}, which is not one of aliases [${aliasNames.join(", ")}]`);
    }
    const row = requireRecord(path, pointer, entry);
    aliases[name] = {
      primary: requireString(path, `${pointer}.primary`, row["primary"]),
      modelId: stringOrNull(path, `${pointer}.modelId`, row["modelId"]),
      fallback: requireString(path, `${pointer}.fallback`, row["fallback"]),
    };
  }
  return { asOf, aliases };
}

function parseSurfaces(path: string, value: unknown): Record<string, RegistrySurface> {
  const record = requireRecord(path, "surfaces", value);
  const surfaces: Record<string, RegistrySurface> = {};
  for (const [name, entry] of entriesOf(record)) {
    const pointer = `surfaces.${name}`;
    const row = requireRecord(path, pointer, entry);
    // `modelsKey` names the consumer's `models.<key>` block; a non-string there
    // would make every surface alias unspellable, so it is refused where read.
    surfaces[name] = {
      label: requireString(path, `${pointer}.label`, row["label"]),
      modelsKey: requireString(path, `${pointer}.modelsKey`, row["modelsKey"]),
      restart: requireString(path, `${pointer}.restart`, row["restart"]),
      interactive: requireString(path, `${pointer}.interactive`, row["interactive"]),
      effortControl: requireString(path, `${pointer}.effortControl`, row["effortControl"]),
      lookup: requireString(path, `${pointer}.lookup`, row["lookup"]),
    };
  }
  if (Object.keys(surfaces).length === 0) {
    throw new SchemaError(path, "surfaces", "is empty. A registry with no surface has nowhere to run a recommendation.");
  }
  return surfaces;
}

function parseLiveLookup(path: string, value: unknown): Record<string, LiveLookup> {
  const record = requireRecord(path, "liveLookup", value);
  const lookup: Record<string, LiveLookup> = {};
  for (const [provider, entry] of entriesOf(record)) {
    const pointer = `liveLookup.${provider}`;
    const row = requireRecord(path, pointer, entry);
    lookup[provider] = {
      cli: stringOrNull(path, `${pointer}.cli`, row["cli"]),
      docs: requireStringList(path, `${pointer}.docs`, row["docs"]),
    };
  }
  return lookup;
}

function parseEffort(path: string, value: unknown, surfaceNames: readonly string[]): EffortPolicy {
  const record = requireRecord(path, "effort", value);
  const levels = requireStringList(path, "effort.levels", record["levels"]);
  if (levels.length !== LEVEL_COUNT) {
    throw new SchemaError(path, "effort.levels", `must list exactly ${LEVEL_COUNT} levels, lowest first; found ${levels.length}`);
  }
  levels.forEach((level, index): void => {
    if (levels.indexOf(level) !== index) {
      throw new SchemaError(path, `effort.levels[${index}]`, `repeats ${describeValue(level)}; a level is named once`);
    }
  });

  const rule = requireRecord(path, "effort.rule", record["rule"]);
  const plusOne = requireArray(path, "effort.rule.plusOne", rule["plusOne"]).map((entry, index): PlusOne => {
    const pointer = `effort.rule.plusOne[${index}]`;
    const row = requireRecord(path, pointer, entry);
    const key = requireString(path, `${pointer}.key`, row["key"]);
    const counted = COUNT_ADD_KEYS.includes(key);
    const threshold = row["threshold"];
    if (counted) {
      if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1) {
        throw new SchemaError(path, `${pointer}.threshold`, `a count add (${COUNT_ADD_KEYS.join(", ")}) needs a positive whole threshold, got ${describeValue(threshold)}`);
      }
    } else if (threshold !== undefined) {
      throw new SchemaError(path, `${pointer}.threshold`, `only a count add (${COUNT_ADD_KEYS.join(", ")}) carries a threshold; ${describeValue(key)} adds on the derived domain`);
    }
    const domain = row["domain"] === undefined ? null : requireString(path, `${pointer}.domain`, row["domain"]);
    if (counted && domain !== null) {
      throw new SchemaError(path, `${pointer}.domain`, `only a domain add names a domain; ${describeValue(key)} is a count add`);
    }
    return { when: requireString(path, `${pointer}.when`, row["when"]), key, threshold: counted ? (threshold as number) : null, domain };
  });

  // The bands partition the score line: each level has one, ascending in level
  // order, each beginning exactly where the one below ended. A gap leaves a score
  // no level owns; an overlap gives it two -- either way the verb would be guessing.
  const rawBands = requireRecord(path, "effort.rule.bands", rule["bands"]);
  for (const declared of Object.keys(rawBands).filter((name): boolean => !name.startsWith("$"))) {
    if (!levels.includes(declared)) {
      throw new SchemaError(path, `effort.rule.bands.${declared}`, `is not one of effort.levels [${levels.join(", ")}]`);
    }
  }
  const bands: Record<string, readonly [number, number]> = {};
  let previousEnd: number | null = null;
  for (const level of levels) {
    const pointer = `effort.rule.bands.${level}`;
    const pair = requireArray(path, pointer, rawBands[level]);
    const [low, high] = pair;
    if (
      pair.length !== 2 ||
      typeof low !== "number" || !Number.isInteger(low) || low < 0 ||
      typeof high !== "number" || !Number.isInteger(high) || high < low
    ) {
      throw new SchemaError(path, pointer, `expected [lowest, highest], two whole numbers with 0 <= lowest <= highest, got ${JSON.stringify(pair)}`);
    }
    if (previousEnd === null ? low !== 0 : low !== previousEnd + 1) {
      throw new SchemaError(
        path,
        pointer,
        `begins at ${low}; the bands must partition the scores, so '${level}' has to begin at ${previousEnd === null ? 0 : previousEnd + 1}`,
      );
    }
    bands[level] = [low, high];
    previousEnd = high;
  }
  // The bands must reach every score the rule can produce. The registry is validated
  // ALONE here, so the highest job weight is taken as WEIGHT_MAX (4), the ceiling the
  // taxonomy parser holds every job weight to; a taxonomy cannot exceed it, so the
  // bound is never looser than the real file's. Every `plusOne` row can add at once.
  const reachable = WEIGHT_MAX + plusOne.length;
  const topLevel = levels[levels.length - 1] as string;
  const topEnd = (bands[topLevel] as readonly [number, number])[1];
  if (topEnd < reachable) {
    throw new SchemaError(
      path,
      `effort.rule.bands.${topLevel}`,
      `ends at ${topEnd}, but the highest reachable score is ${reachable} (the highest job weight ${WEIGHT_MAX} plus ${plusOne.length} add${plusOne.length === 1 ? "" : "s"}); a score above the top band would belong to no level`,
    );
  }

  const rawMap = requireRecord(path, "effort.surfaceMap", record["surfaceMap"]);
  const surfaceMap: Record<string, Record<string, string>> = {};
  for (const [surface, entry] of entriesOf(rawMap)) {
    const pointer = `effort.surfaceMap.${surface}`;
    if (!surfaceNames.includes(surface)) {
      throw new SchemaError(path, pointer, `maps surface ${describeValue(surface)}, which is not one of surfaces [${surfaceNames.join(", ")}]`);
    }
    const row = requireRecord(path, pointer, entry);
    surfaceMap[surface] = Object.fromEntries(
      levels.map((level): [string, string] => [level, requireString(path, `${pointer}.${level}`, row[level])]),
    );
  }
  for (const surface of surfaceNames) {
    if (surfaceMap[surface] === undefined) {
      throw new SchemaError(path, `effort.surfaceMap.${surface}`, "is missing. Every surface has to say what each level means to its own control.");
    }
  }
  return { levels, rule: { base: requireString(path, "effort.rule.base", rule["base"]), plusOne, bands }, surfaceMap };
}

function parsePrecedence(path: string, value: unknown, aliasNames: readonly string[]): string[] {
  const aggregation = requireRecord(path, "aggregation", value);
  const precedence = requireStringList(path, "aggregation.precedence", aggregation["precedence"]);
  precedence.forEach((name, index): void => {
    if (!aliasNames.includes(name)) {
      throw new SchemaError(path, `aggregation.precedence[${index}]`, `names ${describeValue(name)}, which is not one of aliases [${aliasNames.join(", ")}]`);
    }
    if (precedence.indexOf(name) !== index) {
      throw new SchemaError(path, `aggregation.precedence[${index}]`, `repeats ${describeValue(name)}; an alias is ranked once`);
    }
  });
  const missing = aliasNames.filter((name): boolean => !precedence.includes(name));
  if (missing.length > 0) {
    throw new SchemaError(path, "aggregation.precedence", `does not rank alias${missing.length === 1 ? "" : "es"} ${missing.join(", ")}; a tie between an unranked alias and any other would be decided by nothing`);
  }
  return precedence;
}

function parseMismatch(path: string, value: unknown): MismatchPolicy {
  const record = requireRecord(path, "mismatch", value);
  const compares = requireStringList(path, "mismatch.compares", record["compares"]);
  if (compares.length !== MISMATCH_COMPARES.length || compares.some((name, index): boolean => name !== MISMATCH_COMPARES[index])) {
    throw new SchemaError(path, "mismatch.compares", `must be exactly [${MISMATCH_COMPARES.join(", ")}], the set this binary compares; got ${JSON.stringify(compares)}`);
  }
  const ledger = requireString(path, "mismatch.ledger", record["ledger"]);
  if (ledger !== MISMATCH_LEDGER) {
    throw new SchemaError(path, "mismatch.ledger", `must be ${describeValue(MISMATCH_LEDGER)}, the one ledger this binary writes; got ${describeValue(ledger)}`);
  }
  return { compares, ledger };
}

function parseSide(
  path: string,
  pointer: string,
  value: unknown,
  aliases: Readonly<Record<string, RegistryAlias>>,
  surfaceNames: readonly string[],
  isRunnerUp: boolean,
): RoutedSide {
  const aliasNames = Object.keys(aliases);
  const row = requireRecord(path, pointer, value);
  const alias = requireString(path, `${pointer}.alias`, row["alias"]);
  if (!aliasNames.includes(alias)) {
    throw new SchemaError(path, `${pointer}.alias`, `names alias ${describeValue(alias)}, which is not one of aliases [${aliasNames.join(", ")}]`);
  }
  const surface = stringOrNull(path, `${pointer}.surface`, row["surface"]);
  if (surface !== null && !surfaceNames.includes(surface)) {
    throw new SchemaError(path, `${pointer}.surface`, `names surface ${describeValue(surface)}, which is not one of surfaces [${surfaceNames.join(", ")}]`);
  }
  // A cell's surface is ALWAYS its alias's surface (the registry's surfaceRule): the
  // workflow maps an alias onto a tier and a tier onto the surface's own alias, so a
  // cell that moved an alias to another surface would name a tier that surface lacks.
  const aliasSurface = (aliases[alias] as RegistryAlias).surface;
  if (surface !== aliasSurface) {
    throw new SchemaError(
      path,
      `${pointer}.surface`,
      `is ${describeValue(surface)} but alias ${describeValue(alias)} runs on ${describeValue(aliasSurface)}; a cell's surface must equal its alias's surface`,
    );
  }
  const interactive = row["interactive"] === undefined ? null : stringOrNull(path, `${pointer}.interactive`, row["interactive"]);
  let also: string | null = null;
  if (row["also"] !== undefined) {
    also = requireString(path, `${pointer}.also`, row["also"]);
    if (!aliasNames.includes(also)) {
      throw new SchemaError(path, `${pointer}.also`, `names alias ${describeValue(also)}, which is not one of aliases [${aliasNames.join(", ")}]`);
    }
    if ((aliases[also] as RegistryAlias).reviewer) {
      throw new SchemaError(path, `${pointer}.also`, `names reviewer alias ${describeValue(also)}; a stand-in has to be an actionable alias`);
    }
  }
  // A runner-up always resolves to an actionable alias, so a reviewer there names its stand-in.
  if (isRunnerUp && (aliases[alias] as RegistryAlias).reviewer && also === null) {
    throw new SchemaError(path, `${pointer}.also`, `is missing. A reviewer alias as a runner-up has to name the actionable alias it resolves to`);
  }
  const note = row["note"] === undefined ? null : requireString(path, `${pointer}.note`, row["note"]);
  return { alias, surface, interactive, also, note };
}

function parseRouting(
  path: string,
  value: unknown,
  phaseNames: Readonly<Record<string, string>>,
  aliases: Readonly<Record<string, RegistryAlias>>,
  surfaceNames: readonly string[],
): Record<string, Record<string, RoutingEntry>> {
  const record = requireRecord(path, "routing", value);
  const routing: Record<string, Record<string, RoutingEntry>> = {};
  for (const [job, domains] of entriesOf(record)) {
    const jobRecord = requireRecord(path, `routing.${job}`, domains);
    const byDomain: Record<string, RoutingEntry> = {};
    for (const [domain, entry] of entriesOf(jobRecord)) {
      const pointer = `routing.${job}.${domain}`;
      const row = requireRecord(path, pointer, entry);
      const phase = requireString(path, `${pointer}.phase`, row["phase"]);
      const alsoPhases = row["alsoPhases"] === undefined ? [] : requireStringList(path, `${pointer}.alsoPhases`, row["alsoPhases"]);
      for (const [where, id] of [[`${pointer}.phase`, phase], ...alsoPhases.map((id, index): [string, string] => [`${pointer}.alsoPhases[${index}]`, id])] as [string, string][]) {
        if (!Object.prototype.hasOwnProperty.call(phaseNames, id)) throw new SchemaError(path, where, `names phase ${describeValue(id)}, which is not declared in phases`);
      }
      const rawCells = requireRecord(path, `${pointer}.cells`, row["cells"]);
      if (rawCells[SHARED_CELL] === undefined) {
        throw new SchemaError(path, `${pointer}.cells.${SHARED_CELL}`, "is missing. Every routing entry carries the shared cell a language without its own reads.");
      }
      const cells: Record<string, RoutingCell> = {};
      for (const [lang, cell] of entriesOf(rawCells)) {
        const cellPointer = `${pointer}.cells.${lang}`;
        const cellRecord = requireRecord(path, cellPointer, cell);
        cells[lang] = {
          winner: parseSide(path, `${cellPointer}.winner`, cellRecord["winner"], aliases, surfaceNames, false),
          runnerUp: parseSide(path, `${cellPointer}.runnerUp`, cellRecord["runnerUp"], aliases, surfaceNames, true),
        };
      }
      // `phaseName` is a copy of `phases[phase].name`; a copy that disagrees with its
      // source is two statements of one fact, so it is refused (never silently derived).
      const phaseName = requireString(path, `${pointer}.phaseName`, row["phaseName"]);
      if (phaseName !== phaseNames[phase]) {
        throw new SchemaError(path, `${pointer}.phaseName`, `is ${describeValue(phaseName)} but phases.${phase}.name is ${describeValue(phaseNames[phase])}; the routing entry must carry its phase's name`);
      }
      byDomain[domain] = { phase, phaseName, alsoPhases, cells };
    }
    if (Object.keys(byDomain).length === 0) {
      throw new SchemaError(path, `routing.${job}`, "lists no domain. A routed job has at least one phase to route on.");
    }
    routing[job] = byDomain;
  }
  if (Object.keys(routing).length === 0) {
    throw new SchemaError(path, "routing", "is empty. A registry with no routing recommends nothing.");
  }
  return routing;
}

export function parseDirectRegistry(path: string, value: unknown): DirectRegistry {
  const root = requireRecord(path, "$", value);
  const schema = requireString(path, "$schema", root["$schema"]);
  if (!SCHEMA_LINE.test(schema)) {
    throw new SchemaError(path, "$schema", `expected a direct-registry v1 contract line, got ${describeValue(schema)}`);
  }
  const contract = requireString(path, "contract", root["contract"]);

  const surfaces = parseSurfaces(path, root["surfaces"]);
  const surfaceNames = Object.keys(surfaces);
  const aliases = parseAliases(path, root["aliases"], surfaceNames);
  const aliasNames = Object.keys(aliases);
  const snapshot = parseSnapshot(path, root["snapshot"], aliasNames);

  const nativeRecord = requireRecord(path, "nativeInteractive", root["nativeInteractive"]);
  const nativeInteractive = Object.fromEntries(
    entriesOf(nativeRecord).map(([lang, text]): [string, string] => [lang, requireString(path, `nativeInteractive.${lang}`, text)]),
  );

  const phasesRecord = requireRecord(path, "phases", root["phases"]);
  const phases = Object.fromEntries(
    entriesOf(phasesRecord).map(([id, entry]): [string, string] => [
      id,
      requireString(path, `phases.${id}.name`, isRecord(entry) ? entry["name"] : entry),
    ]),
  );

  return {
    path,
    schema,
    contract,
    snapshot,
    aliases,
    surfaces,
    nativeInteractive,
    liveLookup: parseLiveLookup(path, root["liveLookup"]),
    effort: parseEffort(path, root["effort"], surfaceNames),
    precedence: parsePrecedence(path, root["aggregation"], aliasNames),
    mismatch: parseMismatch(path, root["mismatch"]),
    phases,
    routing: parseRouting(path, root["routing"], phases, aliases, surfaceNames),
  };
}

/**
 * Read and validate the file `--registry` names. A relative path resolves
 * against `--repo`'s root like every path flag (zheref/nen#100).
 */
export function loadDirectRegistry(repoRoot: string, flag: string): DirectRegistry {
  const path = resolveAgainstRepo(repoRoot, flag);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new SchemaError(path, null, `could not be read (${code ?? String(error)}). --registry names the model-direction registry file.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SchemaError(path, null, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseDirectRegistry(path, value);
}

/** How many routing cells the registry carries, across every job and domain. */
export function countRoutingCells(registry: DirectRegistry): number {
  return Object.values(registry.routing).reduce(
    (jobs, domains): number =>
      jobs + Object.values(domains).reduce((sum, entry): number => sum + Object.keys(entry.cells).length, 0),
    0,
  );
}
