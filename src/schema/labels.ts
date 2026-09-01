// src/schema/labels.ts -- the label taxonomy, read from the TARGET repository.
//
// `schemas/labels.json` is the source of truth for every label name, colour and
// description in the repository nen is pointed at. This module validates it and
// exposes typed accessors; it knows the SHAPE of a label and nothing about any
// particular label's NAME. Grep this file for a `bankai:` or an `akatsuki:`
// literal and you will find none -- that is the invariant, and
// src/taxonomy-purity.test.ts asserts it across the whole shipped tree.
//
// THE <=100 CHARACTER RULE IS VALIDATED, NOT ASSUMED. GitHub rejects a longer
// description outright, so a repo whose file carries one has a taxonomy that
// cannot be provisioned -- and the failure would otherwise surface as a partial
// label sync (some labels created, one rejected, the rest never attempted),
// which is the state that is hardest to reason about afterwards. Reading it here
// makes the whole file's validity a single question answered before anything is
// written to GitHub.
//
// PREFIX GROUPING IS STRUCTURAL, NOT A VOCABULARY. `namespace()` splits a name
// at its first `:` and `family()` at the following `/`, so `<ns>:<family>/<leaf>`
// decomposes without this file knowing that any particular namespace or family
// exists. A caller asking for "the stage labels" supplies the string "stage";
// it does not find it hard-coded here.

import {
  describeValue,
  requireArray,
  requireRecord,
  requireString,
  SchemaError,
} from "./errors.js";
import { LABELS_FILE, readSchemaJson } from "./source.js";

/** GitHub's own hard limit. A longer description makes the label uncreatable. */
export const MAX_DESCRIPTION_LENGTH = 100;

export interface Label {
  readonly name: string;
  /** Six hex digits, no leading `#` -- the spelling GitHub's API takes. */
  readonly color: string;
  readonly description: string;
}

export interface LabelTaxonomy {
  readonly path: string;
  readonly labels: readonly Label[];
  /** By exact name. */
  get(name: string): Label | undefined;
  has(name: string): boolean;
  names(): readonly string[];
  /** Every label whose name begins `<namespace>:`. */
  inNamespace(namespace: string): readonly Label[];
  /** Every label whose name begins `<namespace>:<family>/`. */
  inFamily(namespace: string, family: string): readonly Label[];
}

const HEX_COLOR = /^[0-9a-fA-F]{6}$/;

export function parseLabelTaxonomy(path: string, value: unknown): LabelTaxonomy {
  const root = requireRecord(path, "$", value);
  const rawLabels = requireArray(path, "labels", root["labels"]);
  if (rawLabels.length === 0) {
    throw new SchemaError(
      path,
      "labels",
      "is empty. An empty taxonomy is indistinguishable from a truncated file, and every downstream verb would report 'no such label' for every label the repository actually uses.",
    );
  }

  const labels: Label[] = [];
  const seen = new Map<string, number>();

  rawLabels.forEach((entry, index): void => {
    const pointer = `labels[${index}]`;
    const record = requireRecord(path, pointer, entry);
    const name = requireString(path, `${pointer}.name`, record["name"]);
    const color = requireString(path, `${pointer}.color`, record["color"]);
    // The description is REQUIRED rather than optional. GitHub accepts a label
    // with none, but a taxonomy that is the source of truth for a whole system
    // and cannot say what a label means is not one -- and the length rule below
    // has nothing to check.
    const description = requireString(path, `${pointer}.description`, record["description"]);

    if (!HEX_COLOR.test(color)) {
      throw new SchemaError(
        path,
        `${pointer}.color`,
        `expected six hex digits with no leading '#' (GitHub's own spelling), got ${describeValue(color)}`,
      );
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new SchemaError(
        path,
        `${pointer}.description`,
        `is ${description.length} characters; GitHub rejects anything over ${MAX_DESCRIPTION_LENGTH}, so this label cannot be provisioned and a sync would fail partway through`,
      );
    }

    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new SchemaError(
        path,
        `${pointer}.name`,
        `duplicates labels[${previous}].name ('${name}'). Two entries for one label means the file has two answers for its colour and description, and whichever a reader takes is arbitrary.`,
      );
    }
    seen.set(name, index);
    labels.push({ name, color, description });
  });

  const byName = new Map(labels.map((label): [string, Label] => [label.name, label]));

  return {
    path,
    labels,
    get: (name): Label | undefined => byName.get(name),
    has: (name): boolean => byName.has(name),
    names: (): readonly string[] => labels.map((label): string => label.name),
    inNamespace: (namespace): readonly Label[] =>
      labels.filter((label): boolean => label.name.startsWith(`${namespace}:`)),
    inFamily: (namespace, family): readonly Label[] =>
      labels.filter((label): boolean => label.name.startsWith(`${namespace}:${family}/`)),
  };
}

export function loadLabelTaxonomy(repoRoot: string): LabelTaxonomy {
  const { path, value } = readSchemaJson(repoRoot, LABELS_FILE);
  return parseLabelTaxonomy(path, value);
}

// `<namespace>:<family>/<leaf>`, decomposed structurally. All three parts are
// `null` when the name does not carry them, because a caller must be able to
// tell "this label has no family" from "its family is the empty string".
export interface LabelName {
  readonly namespace: string | null;
  readonly family: string | null;
  readonly leaf: string | null;
}

export function decomposeLabelName(name: string): LabelName {
  const colon = name.indexOf(":");
  if (colon === -1) return { namespace: null, family: null, leaf: null };
  const namespace = name.slice(0, colon);
  const rest = name.slice(colon + 1);
  const slash = rest.indexOf("/");
  if (slash === -1) return { namespace, family: rest === "" ? null : rest, leaf: null };
  return {
    namespace,
    family: rest.slice(0, slash),
    leaf: rest.slice(slash + 1),
  };
}
