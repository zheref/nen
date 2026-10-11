// src/schema/declarations.ts -- the declaration files nen reads under `nen/`,
// each with the loader that reads it (zheref/nen#338).
//
// ONE ROW PER FILE, AND THE ROW'S `validate` IS THE LOADER'S OWN PARSE. Every
// loader below is `read the file` + `parse the text`; `validate` is the second
// half, called on text that is not on disk yet, and `load` is the whole
// loader, called on the file that is. `nen schema set` validates the edited
// text with `validate` BEFORE it writes and reads the written file back with
// `load` after -- so a value the loader would refuse is never written, and the
// write is judged by the very function every other verb reads the file with.
// declarations.test.ts holds the two halves to the same verdict on every row.
//
// THE `$`-METADATA GUARANTEE, PUBLISHED. Every key whose name starts with `$`,
// at ANY level of ANY file in this table, is METADATA: an annotation for a
// human or another tool (`$comment`, `$schema`, an option note beside a value).
// Validation never fails because of one -- whatever its value, wherever it
// sits, whatever it is named after the `$` -- and no loader reads one as data:
// a `$` key inside a map a loader walks key by key (`product_codes`, a
// contract's `lanes`, a colour category's `values`) is never an entry of that
// map. Two uses are not data and are stated rather than hidden: where a
// loader keeps a block VERBATIM and reads none of it -- every `raw`,
// `nen/contract.json`'s `project.profiles`, a decision row's
// `surfaces.<name>` override -- the `$` keys inside travel with it; and a
// STRING `$schema` at the root of `nen/contract.json` or `nen/workflow.json`
// is echoed as the document's declared schema.
// declarations.test.ts proves this per file against
// ./fixtures/metadata-repo/, and fails if a loader changes its mind.
//
// `nen/colors.yml` IS IN THE TABLE AND IS NOT SETTABLE. It is YAML, its loader
// honours the same guarantee, and `nen schema set` refuses it by name: the
// surgical edit is a JSON text edit.

import { loadColorVocabulary, parseColorsText } from "./colors.js";
import { loadContract, parseContract } from "./contract.js";
import { loadDecisions, parseDecisions } from "./decisions.js";
import { loadGateIdentities, parseGateIdentities, parseGatesText } from "./gates.js";
import { loadLabelTaxonomy, parseLabelTaxonomy } from "./labels.js";
import { loadRepoRegistry, parseRepoRegistry } from "./repos.js";
import {
  COLORS_FILE,
  CONTRACT_FILE,
  DECISIONS_FILE,
  GATES_FILE,
  LABELS_FILE,
  parseSchemaJsonText,
  REPOS_FILE,
} from "./source.js";
import { loadWorkflow, parseWorkflow, WORKFLOW_FILE } from "./workflow.js";

/** The prefix that makes a key metadata. */
export const METADATA_PREFIX = "$";

/** Whether `key` is a metadata key: one every loader ignores as data. */
export function isMetadataKey(key: string): boolean {
  return key.startsWith(METADATA_PREFIX);
}

export interface Declaration {
  /** The repo-relative path, as every message prints it. */
  readonly file: string;
  readonly format: "json" | "yaml";
  /**
   * The loader's own parse of `text`, as if it were the file at `path`.
   * Throws the loader's `SchemaError` (or a subclass) on a document the
   * loader would refuse; returns the model it would build.
   */
  readonly validate: (path: string, text: string) => unknown;
  /** The loader itself, reading the file under `root`. */
  readonly load: (root: string) => unknown;
}

/** Every declaration file a loader reads, in `nen schema check`'s row order. */
export const DECLARATIONS: readonly Declaration[] = [
  {
    file: LABELS_FILE,
    format: "json",
    validate: (path, text) => parseLabelTaxonomy(path, parseSchemaJsonText(path, text)),
    load: (root) => loadLabelTaxonomy(root),
  },
  {
    file: REPOS_FILE,
    format: "json",
    validate: (path, text) => parseRepoRegistry(path, parseSchemaJsonText(path, text)),
    load: (root) => loadRepoRegistry(root),
  },
  {
    file: COLORS_FILE,
    format: "yaml",
    validate: (path, text) => parseColorsText(path, text),
    load: (root) => loadColorVocabulary(root),
  },
  {
    file: GATES_FILE,
    format: "json",
    validate: (path, text) => parseGateIdentities(path, parseGatesText(path, text)),
    load: (root) => loadGateIdentities(root),
  },
  {
    file: CONTRACT_FILE,
    format: "json",
    validate: (path, text) => parseContract(path, "nen", parseSchemaJsonText(path, text)),
    load: (root) => loadContract(root),
  },
  {
    file: WORKFLOW_FILE,
    format: "json",
    validate: (path, text) => parseWorkflow(path, parseSchemaJsonText(path, text)),
    load: (root) => loadWorkflow(root).workflow,
  },
  {
    file: DECISIONS_FILE,
    format: "json",
    validate: (path, text) => parseDecisions(path, parseSchemaJsonText(path, text)),
    load: (root) => loadDecisions(root),
  },
];

/** The row for `file`, or undefined for a path that is not a declaration. */
export function declarationFor(file: string): Declaration | undefined {
  return DECLARATIONS.find((row): boolean => row.file === file);
}

/** The JSON value with every `$`-prefixed key removed, at every level. */
export function stripMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMetadata);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!isMetadataKey(key)) out[key] = stripMetadata(item);
  }
  return out;
}

/** The roots whose string `$schema` a loader echoes as the model's `schema`. */
const ECHOES_SCHEMA: readonly string[] = [CONTRACT_FILE, WORKFLOW_FILE];

/** The unread blocks a loader keeps verbatim, as `<file>` + a path whose `*` matches any one step. */
const VERBATIM: readonly (readonly [string, readonly string[]])[] = [
  [CONTRACT_FILE, ["project", "profiles"]],
  [DECISIONS_FILE, ["rows", "*", "surfaces", "*"]],
];

function verbatimAt([file, pattern]: readonly [string, readonly string[]], actual: string, at: readonly string[]): boolean {
  return file === actual && pattern.length === at.length && pattern.every((step, index): boolean => step === "*" || step === at[index]);
}

/**
 * A loader's model as plain data, for comparing two models of one file:
 * functions dropped; RegExp, Map and Set spelled out; every `raw` (the file's
 * own preserved form) dropped, and the root's `path`; the documented
 * `$schema` echo dropped; and a verbatim block compared with its `$` keys
 * stripped. Two texts whose models agree here have the same TYPED model --
 * which is not the same as "no verb reads them differently": some commands
 * read keys from a loader's raw form, and `nen schema set` counts those
 * separately (`RAW_READ` in ./set.ts) before it reports the loader's typed
 * model as unchanged. declarations.test.ts holds the `$` guarantee with it.
 */
export function canonicalModel(value: unknown, file: string, at: readonly string[] = []): unknown {
  const down = (key: string, item: unknown): unknown => canonicalModel(item, file, [...at, key]);
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (value instanceof Map) return [...value.entries()].map(([key, item]): unknown => [key, down(String(key), item)]);
  if (value instanceof Set) return [...value].map((item): unknown => down("*", item));
  if (Array.isArray(value)) return value.map((item, index): unknown => down(String(index), item));
  if (typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (VERBATIM.some((pattern): boolean => verbatimAt(pattern, file, at))) return stripMetadata(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "raw") continue;
    if (at.length === 0 && key === "path") continue;
    if (at.length === 0 && key === "schema" && ECHOES_SCHEMA.includes(file)) continue;
    out[key] = down(key, item);
  }
  return out;
}
