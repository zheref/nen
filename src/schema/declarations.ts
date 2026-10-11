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
