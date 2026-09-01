// src/schema/colors.ts -- the colour vocabulary, read from the TARGET
// repository's `schemas/colors.yml`.
//
// THE ONE RULE THAT MAKES REUSE SAFE, carried across from the file this reads
// because a reader of the loader needs it as much as a reader of the data: a
// colour is only meaningful INSIDE its category. The same glyph is deliberately
// reused across categories -- one circle is both a severity and a status -- so
// every accessor here is scoped BY CATEGORY and there is deliberately no
// `colors.get(emoji)`. An API that could answer "what does this glyph mean"
// without being told which matrix it came from would be an API that invites the
// defect the file's own header names: a bare coloured circle in a column that
// does not say which vocabulary it belongs to.
//
// `precedence` IS CARRIED AND VALIDATED. A category that declares one is
// declaring a first-match-wins order, and an unstated tie-break is how two
// renderers disagree about the same row. Every name in a precedence list must
// exist in that category's `values`; a precedence entry naming a value that is
// not there is a rule that silently never fires.
//
// NOTHING IS DEFAULTED. No category is required to exist and none is assumed to:
// `category()` returns `undefined` for one the file does not carry, and the
// caller decides what that means. The alternative -- a built-in "status" table
// used when the file has none -- would be the fallback ./errors.ts refuses.

import { describeValue, isRecord, requireRecord, SchemaError } from "./errors.js";
import { COLORS_FILE, readSchemaFile } from "./source.js";
import { parseYaml, YamlError, type YamlValue } from "./yaml.js";

export interface ColorValue {
  readonly name: string;
  /** The glyph to render. `null` when the file records the value as unassigned. */
  readonly emoji: string | null;
  /** `#rrggbb`. `null` when the value has no authoritative colour. */
  readonly hex: string | null;
  readonly label: string | null;
  readonly means: string | null;
  /** Free-form; the file's own vocabulary, never interpreted here. */
  readonly extra: Readonly<Record<string, YamlValue>>;
}

export interface ColorCategory {
  readonly name: string;
  readonly scope: string | null;
  /** First-match-wins order, when the category declares one. */
  readonly precedence: readonly string[];
  readonly values: readonly ColorValue[];
  get(valueName: string): ColorValue | undefined;
}

export interface ColorVocabulary {
  readonly path: string;
  readonly version: number | null;
  readonly categories: readonly ColorCategory[];
  category(name: string): ColorCategory | undefined;
  /** The value a category's precedence selects first from `present`. */
  resolve(categoryName: string, present: readonly string[]): ColorValue | undefined;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

const KNOWN_VALUE_FIELDS = new Set(["emoji", "hex", "label", "means"]);

function readOptionalText(path: string, pointer: string, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  // A number or a boolean where a label belongs is a shape mistake, not a
  // stringifiable convenience: coercing it would put `true` in a rendered table.
  throw new SchemaError(path, pointer, `expected a string or null, got ${describeValue(raw)}`);
}

export function parseColorVocabulary(path: string, parsed: YamlValue): ColorVocabulary {
  const root = requireRecord(path, "$", parsed);

  const rawVersion = root["version"];
  let version: number | null = null;
  if (rawVersion !== undefined && rawVersion !== null) {
    if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
      throw new SchemaError(path, "version", `expected an integer, got ${describeValue(rawVersion)}`);
    }
    version = rawVersion;
  }

  const rawCategories = requireRecord(path, "categories", root["categories"]);
  const categories: ColorCategory[] = [];

  for (const [categoryName, rawCategory] of Object.entries(rawCategories)) {
    const categoryPointer = `categories.${categoryName}`;
    const category = requireRecord(path, categoryPointer, rawCategory);
    const scope = readOptionalText(path, `${categoryPointer}.scope`, category["scope"]);

    const rawPrecedence = category["precedence"];
    let precedence: string[] = [];
    if (rawPrecedence !== undefined && rawPrecedence !== null) {
      if (!Array.isArray(rawPrecedence)) {
        throw new SchemaError(
          path,
          `${categoryPointer}.precedence`,
          `expected a list of value names, got ${describeValue(rawPrecedence)}`,
        );
      }
      precedence = rawPrecedence.map((item, index): string => {
        if (typeof item !== "string" || item === "") {
          throw new SchemaError(
            path,
            `${categoryPointer}.precedence[${index}]`,
            `expected a value name, got ${describeValue(item)}`,
          );
        }
        return item;
      });
    }

    const rawValues = requireRecord(path, `${categoryPointer}.values`, category["values"]);
    const values: ColorValue[] = [];
    for (const [valueName, rawValue] of Object.entries(rawValues)) {
      const valuePointer = `${categoryPointer}.values.${valueName}`;
      if (!isRecord(rawValue)) {
        throw new SchemaError(
          path,
          valuePointer,
          `expected an object describing the value, got ${describeValue(rawValue)}`,
        );
      }
      const hex = readOptionalText(path, `${valuePointer}.hex`, rawValue["hex"]);
      if (hex !== null && !HEX.test(hex)) {
        throw new SchemaError(
          path,
          `${valuePointer}.hex`,
          `expected '#rrggbb', got ${describeValue(hex)}`,
        );
      }
      const extra: Record<string, YamlValue> = {};
      for (const [key, item] of Object.entries(rawValue)) {
        if (!KNOWN_VALUE_FIELDS.has(key)) extra[key] = item as YamlValue;
      }
      values.push({
        name: valueName,
        emoji: readOptionalText(path, `${valuePointer}.emoji`, rawValue["emoji"]),
        hex,
        label: readOptionalText(path, `${valuePointer}.label`, rawValue["label"]),
        means: readOptionalText(path, `${valuePointer}.means`, rawValue["means"]),
        extra,
      });
    }

    const byName = new Map(values.map((value): [string, ColorValue] => [value.name, value]));
    for (const name of precedence) {
      if (!byName.has(name)) {
        throw new SchemaError(
          path,
          `${categoryPointer}.precedence`,
          `names '${name}', which is not one of this category's values (${[...byName.keys()].join(", ")}). A precedence entry for a value that does not exist is a tie-break rule that can never fire.`,
        );
      }
    }

    categories.push({
      name: categoryName,
      scope,
      precedence,
      values,
      get: (valueName): ColorValue | undefined => byName.get(valueName),
    });
  }

  const byCategory = new Map(
    categories.map((category): [string, ColorCategory] => [category.name, category]),
  );

  return {
    path,
    version,
    categories,
    category: (name): ColorCategory | undefined => byCategory.get(name),
    resolve: (categoryName, present): ColorValue | undefined => {
      const category = byCategory.get(categoryName);
      if (category === undefined) return undefined;
      const candidates = new Set(present);
      // FIRST MATCH IN THE FILE'S OWN ORDER. When the category declares no
      // precedence there is no defensible tie-break, so nothing is returned
      // for an ambiguous set rather than an arbitrary pick.
      for (const name of category.precedence) {
        if (candidates.has(name)) return category.get(name);
      }
      if (category.precedence.length === 0 && present.length === 1) {
        const only = present[0];
        return only === undefined ? undefined : category.get(only);
      }
      return undefined;
    },
  };
}

export function loadColorVocabulary(repoRoot: string): ColorVocabulary {
  const { path, text } = readSchemaFile(repoRoot, COLORS_FILE);
  let parsed: YamlValue;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlError) {
      throw new SchemaError(path, null, `is not readable YAML -- ${error.message}`);
    }
    throw error;
  }
  return parseColorVocabulary(path, parsed);
}
