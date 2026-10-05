// src/classify/taxonomy.ts -- the classification taxonomy file, read as DATA.
//
// WHY THIS MODULE EXISTS. Hatsu's ruling of 2026-10-04: an issue is classified
// on two axes, `lang/<key>` and `job/<key>`, applied as GitHub labels; the
// declaration PR lands first and the GitHub sync follows; an axis with no
// confident answer stays empty (undecidable); low-confidence rows are listed,
// never applied. The JUDGEMENT is a skill's prose. The file the skill and the
// verbs share is this taxonomy -- a JSON document the maintainer's governance
// repository owns -- and every `nen classify` verb reads the vocabulary from it.
//
// KEYS, PREFIXES AND COLOURS ARE DATA, never code. This file knows the SHAPE
// of an axis (a prefix ending in `/`, a six-hex colour, a list of kebab keys
// each with a title and a description GitHub can hold) and nothing about any
// particular key: src/taxonomy-purity.test.ts holds the whole shipped tree to
// that, and fixtures and tests may name what they like. The ONE structural
// fact written here is that a classification has the two axes the ruling
// names -- `AXES` -- the way ../schema/labels.ts knows the word `labels`: a
// field of the contract, not a value of the vocabulary.
//
// THE DIRECTION FAMILY READS MORE OF THE SAME FILE (Hatsu ruling of 2026-10-04:
// stable aliases, replaceable versions -- `nen direct` picks a model for an
// issue's classification). Four OPTIONAL facts ride the keys and the root, and
// this module parses them so the second family never reads the file a second
// way: a lang key's `code` flag (true marks a programming language, false one
// that is not code; ABSENT READS TRUE, so a taxonomy written before the flag
// existed still means what it meant), a job key's `weight` (1..4) and `phases`
// (domain -> phase ids), and the root's `domains` block (the domain names, the
// ordered derivation rows and the fallback sentence). None is required here --
// `nen classify` needs none of them, and a taxonomy without them is still a
// valid classification vocabulary; `nen direct resolve` is the verb that
// refuses a file that lacks what it derives from.
//
// A BAD FILE IS A LOUD, POINTED REFUSAL (../schema/errors.ts): the path, the
// pointer into the file and what was found. No fallback and no built-in copy --
// a binary that guessed the vocabulary would label issues with names the
// maintainer never declared.

import { readFileSync } from "node:fs";
import { resolveAgainstRepo } from "../cli/inputs.js";
import {
  describeValue,
  requireArray,
  requireBoolean,
  requireRecord,
  requireString,
  SchemaError,
} from "../schema/errors.js";
import { MAX_DESCRIPTION_LENGTH, type Label } from "../schema/labels.js";

/** The two axes of the ruling, in the order every report prints them. */
export const AXES = ["lang", "job"] as const;
export type AxisName = (typeof AXES)[number];

const HEX_COLOR = /^[0-9a-fA-F]{6}$/;
const KEBAB_KEY = /^[a-z][a-z0-9-]*$/;
/** The contract line every revision of the file opens with, e.g. `<owner>.classify-taxonomy/v1`. */
const SCHEMA_LINE = /^[A-Za-z0-9._-]*classify-taxonomy\/v1$/;

/** The weight range a job key may carry; `nen direct` adds the highest one carried to its effort score. */
export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 4;

export interface AxisKey {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  /** A language key's `code` flag; true when absent. Meaningless (and always true) on a job key. */
  readonly code: boolean;
  /** A job key's weight, WEIGHT_MIN..WEIGHT_MAX, or null when the file states none. */
  readonly weight: number | null;
  /** A job key's phases per domain (domain -> phase ids, in file order), or null when the file states none. */
  readonly phases: Readonly<Record<string, readonly string[]>> | null;
}

/**
 * A row's condition, as STRUCTURED DATA the direct family evaluates (the maintainer's
 * review of 2026-10-04 replaced the prose conditions): a bare `"otherwise"`, or an object
 * with exactly one of `anyOf` (a list of predicates, any matches), `repoKind` /
 * `repoRole` (a list of values, the input is in it), `issueLabels.any` (patterns; a
 * `*:name` pattern matches any `<ns>:name`) or `jobs` (`anyKey`, or `nonEmpty` with
 * `everyListsOnly`). The parser normalises each shape into one member of this union and
 * refuses any other shape by pointer, so the evaluator never sees an unknown one.
 */
export type DomainPredicate =
  | { readonly kind: "otherwise" }
  | { readonly kind: "anyOf"; readonly members: readonly DomainPredicate[] }
  | { readonly kind: "repoKind"; readonly values: readonly string[] }
  | { readonly kind: "repoRole"; readonly values: readonly string[] }
  | { readonly kind: "issueLabels"; readonly any: readonly string[] }
  | { readonly kind: "jobsAnyKey"; readonly keys: readonly string[] }
  | { readonly kind: "jobsEveryListsOnly"; readonly domain: string };

/** One row of `domains.rule`: the derivation `nen direct` applies, in `order`, first match wins. */
export interface DomainRule {
  readonly order: number;
  readonly domain: string;
  readonly when: DomainPredicate;
  /** The row's own `$comment`: the sentence for a reader, reported and never evaluated. */
  readonly note: string | null;
}

export interface DomainPolicy {
  /** The domain names, in the file's order. */
  readonly keys: readonly string[];
  /** The derivation rows, ascending by `order`. */
  readonly rule: readonly DomainRule[];
  /** The sentence that orders the substitution when a job has no phase in the derived domain. */
  readonly fallback: string;
}

export interface Axis {
  readonly name: AxisName;
  /** Ends in `/`; a label of this axis is `prefix + key`. */
  readonly prefix: string;
  /** Six hex digits, no leading `#` -- GitHub's own spelling. */
  readonly color: string;
  readonly keys: readonly AxisKey[];
}

export interface ConfidencePolicy {
  readonly levels: readonly string[];
  /** Levels a sweep applies after its one confirmation. */
  readonly applied: readonly string[];
  /** Levels that are listed and skipped unless explicitly picked. */
  readonly listed: readonly string[];
}

/** One label the taxonomy defines: a plain label plus where it came from. */
export interface ClassifyLabel extends Label {
  readonly axis: AxisName;
  readonly key: string;
}

export interface ClassifyTaxonomy {
  readonly path: string;
  readonly axes: Readonly<Record<AxisName, Axis>>;
  readonly confidence: ConfidencePolicy;
  /** The `domains` block, or null when the file carries none. */
  readonly domains: DomainPolicy | null;
}

function requireStringList(path: string, pointer: string, value: unknown): string[] {
  return requireArray(path, pointer, value).map((entry, index): string =>
    requireString(path, `${pointer}[${index}]`, entry),
  );
}

function optionalBoolean(path: string, pointer: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return requireBoolean(path, pointer, value);
}

function parseWeight(path: string, pointer: string, value: unknown): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < WEIGHT_MIN || value > WEIGHT_MAX) {
    throw new SchemaError(
      path,
      pointer,
      `expected a whole number from ${WEIGHT_MIN} to ${WEIGHT_MAX}, got ${describeValue(value)}`,
    );
  }
  return value;
}

function parsePhases(path: string, pointer: string, value: unknown): Record<string, string[]> | null {
  if (value === undefined) return null;
  const record = requireRecord(path, pointer, value);
  // A `$`-prefixed key (`$comment`, ...) is metadata, never a domain: skipped before
  // its value is read, the loader policy of ../schema/source.ts.
  return Object.fromEntries(
    Object.entries(record)
      .filter(([domain]): boolean => !domain.startsWith("$"))
      .map(([domain, ids]): [string, string[]] => [domain, requireStringList(path, `${pointer}.${domain}`, ids)]),
  );
}

function parseAxis(path: string, name: AxisName, value: unknown): Axis {
  const pointer = `axes.${name}`;
  const record = requireRecord(path, pointer, value);

  const prefix = requireString(path, `${pointer}.prefix`, record["prefix"]);
  if (!prefix.endsWith("/") || prefix === "/") {
    throw new SchemaError(
      path,
      `${pointer}.prefix`,
      `must be a non-empty namespace ending in '/', got ${describeValue(prefix)}. A label of this axis is prefix + key, and without the separator the key would run into the prefix.`,
    );
  }
  const color = requireString(path, `${pointer}.color`, record["color"]);
  if (!HEX_COLOR.test(color)) {
    throw new SchemaError(
      path,
      `${pointer}.color`,
      `expected six hex digits with no leading '#' (GitHub's own spelling), got ${describeValue(color)}`,
    );
  }

  const rawKeys = requireArray(path, `${pointer}.keys`, record["keys"]);
  if (rawKeys.length === 0) {
    throw new SchemaError(path, `${pointer}.keys`, "is empty. An axis with no keys can label nothing.");
  }
  const seen = new Map<string, number>();
  const keys = rawKeys.map((entry, index): AxisKey => {
    const keyPointer = `${pointer}.keys[${index}]`;
    const keyRecord = requireRecord(path, keyPointer, entry);
    const key = requireString(path, `${keyPointer}.key`, keyRecord["key"]);
    if (!KEBAB_KEY.test(key)) {
      throw new SchemaError(
        path,
        `${keyPointer}.key`,
        `expected a kebab-case key matching ${String(KEBAB_KEY)}, got ${describeValue(key)}`,
      );
    }
    const title = requireString(path, `${keyPointer}.title`, keyRecord["title"]);
    // The description becomes the GitHub label's own, so GitHub's limit is the
    // taxonomy's -- refused here, once, rather than as a half-synced repository.
    const description = requireString(path, `${keyPointer}.description`, keyRecord["description"]);
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new SchemaError(
        path,
        `${keyPointer}.description`,
        `is ${description.length} characters; it becomes the label's description and GitHub rejects anything over ${MAX_DESCRIPTION_LENGTH}`,
      );
    }
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new SchemaError(
        path,
        `${keyPointer}.key`,
        `duplicates ${pointer}.keys[${previous}].key (${describeValue(key)}). One key, two labels' worth of meaning, is how a classification becomes ambiguous.`,
      );
    }
    seen.set(key, index);
    return {
      key,
      title,
      description,
      code: optionalBoolean(path, `${keyPointer}.code`, keyRecord["code"], true),
      weight: parseWeight(path, `${keyPointer}.weight`, keyRecord["weight"]),
      phases: parsePhases(path, `${keyPointer}.phases`, keyRecord["phases"]),
    };
  });

  return { name, prefix, color, keys };
}

function parseConfidence(path: string, value: unknown): ConfidencePolicy {
  const pointer = "classification.confidence";
  const record = requireRecord(path, pointer, value);
  const levels = requireStringList(path, `${pointer}.levels`, record["levels"]);
  if (levels.length === 0) {
    throw new SchemaError(path, `${pointer}.levels`, "is empty. A plan row's confidence must be one of these.");
  }
  const applied = requireStringList(path, `${pointer}.applied`, record["applied"]);
  const listed = requireStringList(path, `${pointer}.listed`, record["listed"]);
  for (const [field, members] of [["applied", applied], ["listed", listed]] as const) {
    members.forEach((member, index): void => {
      if (!levels.includes(member)) {
        throw new SchemaError(
          path,
          `${pointer}.${field}[${index}]`,
          `names ${describeValue(member)}, which is not one of levels [${levels.join(", ")}]`,
        );
      }
    });
  }
  // Every level is decided one way or the other: a level in neither list would
  // be a row the apply verb has no rule for, and silence is not a rule.
  for (const level of levels) {
    const inApplied = applied.includes(level);
    const inListed = listed.includes(level);
    if (inApplied === inListed) {
      throw new SchemaError(
        path,
        `${pointer}.levels`,
        `level ${describeValue(level)} must be in exactly one of 'applied' and 'listed' (it is in ${inApplied ? "both" : "neither"})`,
      );
    }
  }
  return { levels, applied, listed };
}

/** Refuse any non-`$` key of `record` that is not one the shape owns: a misspelt key would otherwise be silently ignored. */
function onlyKeys(path: string, pointer: string, record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const name of Object.keys(record)) {
    if (name.startsWith("$") || allowed.includes(name)) continue;
    throw new SchemaError(path, `${pointer}.${name}`, `is not a key of this predicate shape (expected only: ${allowed.join(", ")})`);
  }
}

function parsePredicate(
  path: string,
  pointer: string,
  value: unknown,
  domainKeys: readonly string[],
  jobKeys: readonly string[],
): DomainPredicate {
  if (value === "otherwise") return { kind: "otherwise" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaError(
      path,
      pointer,
      `expected "otherwise" or a predicate object (anyOf, repoKind, repoRole, issueLabels, jobs), got ${describeValue(value)}`,
    );
  }
  const record = value as Record<string, unknown>;
  const shapes = Object.keys(record).filter((name): boolean => !name.startsWith("$"));
  if (shapes.length !== 1) {
    throw new SchemaError(path, pointer, `expected exactly one predicate shape, found [${shapes.join(", ")}]`);
  }
  const shape = shapes[0] as string;
  const inner = record[shape];
  switch (shape) {
    case "anyOf": {
      const members = requireArray(path, `${pointer}.anyOf`, inner);
      if (members.length === 0) throw new SchemaError(path, `${pointer}.anyOf`, "is empty. An any-of with no member never matches.");
      return {
        kind: "anyOf",
        members: members.map((member, index): DomainPredicate => parsePredicate(path, `${pointer}.anyOf[${index}]`, member, domainKeys, jobKeys)),
      };
    }
    case "repoKind":
    case "repoRole": {
      const values = requireStringList(path, `${pointer}.${shape}`, inner);
      if (values.length === 0) throw new SchemaError(path, `${pointer}.${shape}`, "is empty. A list with no value never matches.");
      return { kind: shape, values };
    }
    case "issueLabels": {
      const labels = requireRecord(path, `${pointer}.issueLabels`, inner);
      onlyKeys(path, `${pointer}.issueLabels`, labels, ["any"]);
      const any = requireStringList(path, `${pointer}.issueLabels.any`, labels["any"]);
      if (any.length === 0) throw new SchemaError(path, `${pointer}.issueLabels.any`, "is empty. A list with no pattern never matches.");
      return { kind: "issueLabels", any };
    }
    case "jobs": {
      const jobs = requireRecord(path, `${pointer}.jobs`, inner);
      // Exactly one of two shapes: { anyKey } alone, or { nonEmpty, everyListsOnly } together.
      onlyKeys(path, `${pointer}.jobs`, jobs, jobs["anyKey"] !== undefined ? ["anyKey"] : ["nonEmpty", "everyListsOnly"]);
      if (jobs["anyKey"] !== undefined) {
        const keys = requireStringList(path, `${pointer}.jobs.anyKey`, jobs["anyKey"]);
        keys.forEach((key, index): void => {
          if (jobKeys.length > 0 && !jobKeys.includes(key)) {
            throw new SchemaError(path, `${pointer}.jobs.anyKey[${index}]`, `names ${describeValue(key)}, which is not one of axes.job.keys`);
          }
        });
        if (keys.length === 0) throw new SchemaError(path, `${pointer}.jobs.anyKey`, "is empty. A list with no key never matches.");
        return { kind: "jobsAnyKey", keys };
      }
      if (jobs["nonEmpty"] !== true) {
        throw new SchemaError(path, `${pointer}.jobs`, "expected 'anyKey', or 'nonEmpty': true with 'everyListsOnly'");
      }
      const domain = requireString(path, `${pointer}.jobs.everyListsOnly`, jobs["everyListsOnly"]);
      if (!domainKeys.includes(domain)) {
        throw new SchemaError(path, `${pointer}.jobs.everyListsOnly`, `names ${describeValue(domain)}, which is not one of domains.keys [${domainKeys.join(", ")}]`);
      }
      return { kind: "jobsEveryListsOnly", domain };
    }
    default:
      throw new SchemaError(
        path,
        `${pointer}.${shape}`,
        `is not a predicate shape this contract carries (expected one of: anyOf, repoKind, repoRole, issueLabels, jobs)`,
      );
  }
}

function parseDomains(path: string, value: unknown, jobKeys: readonly string[]): DomainPolicy | null {
  if (value === undefined) return null;
  const pointer = "domains";
  const record = requireRecord(path, pointer, value);
  // The rows are read first-match-wins; a file that says otherwise states a different contract.
  if (record["firstMatchWins"] !== undefined && record["firstMatchWins"] !== true) {
    throw new SchemaError(path, `${pointer}.firstMatchWins`, `expected true (the rows are evaluated in order, the first match winning), got ${describeValue(record["firstMatchWins"])}`);
  }
  const keys = requireStringList(path, `${pointer}.keys`, record["keys"]);
  if (keys.length === 0) {
    throw new SchemaError(path, `${pointer}.keys`, "is empty. A domain block with no domains routes nothing.");
  }
  keys.forEach((key, index): void => {
    if (keys.indexOf(key) !== index) {
      throw new SchemaError(path, `${pointer}.keys[${index}]`, `duplicates ${describeValue(key)}; a domain is named once`);
    }
  });
  const rows = requireArray(path, `${pointer}.rule`, record["rule"]).map((entry, index): DomainRule => {
    const rowPointer = `${pointer}.rule[${index}]`;
    const row = requireRecord(path, rowPointer, entry);
    const order = row["order"];
    if (typeof order !== "number" || !Number.isInteger(order) || order < 1) {
      throw new SchemaError(path, `${rowPointer}.order`, `expected a positive whole number, got ${describeValue(order)}`);
    }
    const domain = requireString(path, `${rowPointer}.domain`, row["domain"]);
    if (!keys.includes(domain)) {
      throw new SchemaError(
        path,
        `${rowPointer}.domain`,
        `names ${describeValue(domain)}, which is not one of ${pointer}.keys [${keys.join(", ")}]`,
      );
    }
    const note = row["$comment"];
    return {
      order,
      domain,
      when: parsePredicate(path, `${rowPointer}.when`, row["when"], keys, jobKeys),
      note: typeof note === "string" ? note : null,
    };
  });
  // An empty `rule` is tolerated here: `nen classify` never derives a domain, and
  // `nen direct resolve` refuses a block whose rows are not the ones it implements.
  const rule = [...rows].sort((a, b): number => a.order - b.order);
  rule.forEach((row, index): void => {
    if (index > 0 && (rule[index - 1] as DomainRule).order === row.order) {
      throw new SchemaError(path, `${pointer}.rule`, `has two rows with order ${row.order}; the order is the precedence and must be unique`);
    }
  });
  return { keys, rule, fallback: requireString(path, `${pointer}.fallback`, record["fallback"]) };
}

export function parseClassifyTaxonomy(path: string, value: unknown): ClassifyTaxonomy {
  const root = requireRecord(path, "$", value);
  const schema = requireString(path, "$schema", root["$schema"]);
  if (!SCHEMA_LINE.test(schema)) {
    throw new SchemaError(
      path,
      "$schema",
      `expected a classify-taxonomy v1 contract line, got ${describeValue(schema)}`,
    );
  }
  requireString(path, "contract", root["contract"]);

  const rawAxes = requireRecord(path, "axes", root["axes"]);
  for (const declared of Object.keys(rawAxes)) {
    // `$`-prefixed keys are metadata (`$comment`), never axes -- the loader
    // policy of ../schema/source.ts, so a note beside the axes is not a third one.
    if (declared.startsWith("$")) continue;
    if (!(AXES as readonly string[]).includes(declared)) {
      throw new SchemaError(
        path,
        `axes.${declared}`,
        `is not an axis this contract carries (expected exactly: ${AXES.join(", ")}). A third axis is a new contract version, not a quiet addition.`,
      );
    }
  }
  const parsed = AXES.map((name): Axis => {
    if (rawAxes[name] === undefined) {
      throw new SchemaError(
        path,
        `axes.${name}`,
        `is missing. A classification is made on every axis this contract carries (${AXES.join(", ")}).`,
      );
    }
    return parseAxis(path, name, rawAxes[name]);
  });

  // Two axes sharing a prefix (or one inside the other) would make a label's
  // axis ambiguous when it is read back off an issue.
  parsed.forEach((axis, index): void => {
    for (const other of parsed.slice(index + 1)) {
      if (axis.prefix.startsWith(other.prefix) || other.prefix.startsWith(axis.prefix)) {
        throw new SchemaError(
          path,
          `axes.${other.name}.prefix`,
          `${describeValue(other.prefix)} overlaps axes.${axis.name}.prefix ${describeValue(axis.prefix)}; a label's axis is read from its prefix and must be unambiguous`,
        );
      }
    }
  });

  const classification = requireRecord(path, "classification", root["classification"]);
  const confidence = parseConfidence(path, classification["confidence"]);

  const domains = parseDomains(path, root["domains"], parsed.flatMap((axis): string[] => (axis.name === "job" ? axis.keys.map((entry): string => entry.key) : [])));
  // A job's phases name domains; once the file declares the domain set, a phase
  // under a name outside it is a typo the derivation would silently never reach.
  if (domains !== null) {
    parsed.forEach((axis): void => {
      axis.keys.forEach((entry, index): void => {
        for (const domain of Object.keys(entry.phases ?? {})) {
          if (!domains.keys.includes(domain)) {
            throw new SchemaError(
              path,
              `axes.${axis.name}.keys[${index}].phases.${domain}`,
              `names ${describeValue(domain)}, which is not one of domains.keys [${domains.keys.join(", ")}]`,
            );
          }
        }
      });
    });
  }

  const axes = Object.fromEntries(parsed.map((axis): [AxisName, Axis] => [axis.name, axis])) as Record<
    AxisName,
    Axis
  >;
  return { path, axes, confidence, domains };
}

/**
 * Read and validate the file `--taxonomy` names. A relative path resolves
 * against `--repo`'s root like every path flag (zheref/nen#100).
 */
export function loadClassifyTaxonomy(repoRoot: string, flag: string): ClassifyTaxonomy {
  const path = resolveAgainstRepo(repoRoot, flag);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new SchemaError(path, null, `could not be read (${code ?? String(error)}). --taxonomy names the classification taxonomy file.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new SchemaError(path, null, `is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseClassifyTaxonomy(path, value);
}

/** Every label the taxonomy defines, axis by axis in `AXES` order, keys in file order. */
export function taxonomyLabels(taxonomy: ClassifyTaxonomy): ClassifyLabel[] {
  return AXES.flatMap((name): ClassifyLabel[] => {
    const axis = taxonomy.axes[name];
    return axis.keys.map(
      (entry): ClassifyLabel => ({
        name: axis.prefix + entry.key,
        color: axis.color,
        description: entry.description,
        axis: name,
        key: entry.key,
      }),
    );
  });
}

export interface AxisLabel {
  readonly axis: AxisName;
  /** What follows the prefix. May or may not be a key the taxonomy carries. */
  readonly key: string;
}

/** Which axis a label name belongs to by its prefix, or null when it carries none. */
export function axisOfLabel(taxonomy: ClassifyTaxonomy, name: string): AxisLabel | null {
  for (const axisName of AXES) {
    const axis = taxonomy.axes[axisName];
    if (name.startsWith(axis.prefix) && name.length > axis.prefix.length) {
      return { axis: axisName, key: name.slice(axis.prefix.length) };
    }
  }
  return null;
}
