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
// A BAD FILE IS A LOUD, POINTED REFUSAL (../schema/errors.ts): the path, the
// pointer into the file and what was found. No fallback and no built-in copy --
// a binary that guessed the vocabulary would label issues with names the
// maintainer never declared.

import { readFileSync } from "node:fs";
import { resolveAgainstRepo } from "../cli/inputs.js";
import {
  describeValue,
  requireArray,
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

export interface AxisKey {
  readonly key: string;
  readonly title: string;
  readonly description: string;
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
}

function requireStringList(path: string, pointer: string, value: unknown): string[] {
  return requireArray(path, pointer, value).map((entry, index): string =>
    requireString(path, `${pointer}[${index}]`, entry),
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
    return { key, title, description };
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

  const axes = Object.fromEntries(parsed.map((axis): [AxisName, Axis] => [axis.name, axis])) as Record<
    AxisName,
    Axis
  >;
  return { path, axes, confidence };
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
