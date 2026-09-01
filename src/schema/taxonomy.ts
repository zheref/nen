// src/schema/taxonomy.ts -- the facade every verb reads a repository's taxonomy
// through.
//
// ONE ENTRY POINT, so that "which repository is this about" is answered once per
// invocation and cannot drift between two verbs in the same run. The root comes
// from ../repo/root.ts (cwd at the call site, `--repo <path>` override); the
// three files are the target repository's own.
//
// LAZY BY FILE, AND THAT IS A CORRECTNESS PROPERTY, not a performance one. A
// verb that only needs labels must not fail because the repository's colours
// file is malformed -- otherwise every verb inherits every other verb's schema
// requirements, and a repository adopting nen has to satisfy all of them before
// any of them works. `check()` is the opposite lane: it deliberately loads
// everything and reports every file's verdict, which is what an operator wants
// when they are asking "is my taxonomy readable at all".
//
// EACH FILE IS LOADED AT MOST ONCE per Taxonomy, and a FAILURE IS CACHED TOO.
// Retrying a read that threw would make an error message depend on how many
// times a verb happened to ask, and a schema file does not become valid by being
// re-read.

import { assertRepoRoot, type RepoRootOptions } from "../repo/root.js";
import { loadColorVocabulary, type ColorVocabulary } from "./colors.js";
import { loadGateIdentities, type GateIdentities } from "./gates.js";
import { loadLabelTaxonomy, type LabelTaxonomy } from "./labels.js";
import { loadRepoRegistry, type RepoRegistry } from "./repos.js";
import { SchemaError } from "./errors.js";
import { COLORS_FILE, GATES_FILE, LABELS_FILE, REPOS_FILE, schemaPath } from "./source.js";

export interface Taxonomy {
  /** Absolute path of the target repository's working-tree root. */
  readonly root: string;
  labels(): LabelTaxonomy;
  repos(): RepoRegistry;
  colors(): ColorVocabulary;
  /**
   * Reviewer identities for the readiness predicates. Separate from the three
   * REQUIRED files because it is required only by the verbs that judge a pull
   * request -- see ./gates.ts.
   */
  gates(): GateIdentities;
}

function once<T>(load: () => T): () => T {
  let state: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  return (): T => {
    if (state === null) {
      try {
        state = { ok: true, value: load() };
      } catch (error) {
        state = { ok: false, error };
      }
    }
    if (state.ok) return state.value;
    throw state.error;
  };
}

export function openTaxonomy(options: RepoRootOptions = {}): Taxonomy {
  const root = assertRepoRoot(options);
  return {
    root,
    labels: once((): LabelTaxonomy => loadLabelTaxonomy(root)),
    repos: once((): RepoRegistry => loadRepoRegistry(root)),
    colors: once((): ColorVocabulary => loadColorVocabulary(root)),
    gates: once((): GateIdentities => loadGateIdentities(root)),
  };
}

export interface SchemaCheck {
  readonly file: string;
  readonly path: string;
  /** `true` when the file loaded and validated. */
  readonly ok: boolean;
  /** A one-line summary when ok, the SchemaError's message when not. */
  readonly detail: string;
  /**
   * Whether this check's failure fails the overall report. The three taxonomy
   * files are always required. gates.json is required only by the readiness
   * verbs, so its ABSENCE is reported without failing the report -- but a
   * gates.json that is present and INVALID is required, because a malformed
   * file is a defect in this repository's taxonomy rather than a feature it has
   * not adopted.
   */
  readonly required: boolean;
}

export interface CheckReport {
  readonly root: string;
  readonly checks: readonly SchemaCheck[];
  /** False when any REQUIRED file failed. */
  readonly ok: boolean;
}

function run(
  file: string,
  root: string,
  required: boolean,
  load: () => string,
): SchemaCheck {
  const path = schemaPath(root, file);
  try {
    return { file, path, ok: true, detail: load(), required };
  } catch (error) {
    return {
      file,
      path,
      ok: false,
      detail: error instanceof SchemaError ? error.message : String(error),
      // ABSENT AND CORRUPT ARE NOT THE SAME FINDING, and conflating them was a
      // real hole. `required` is what decides whether the overall report fails,
      // and gates.json is declared optional because only the readiness verbs
      // need it -- but "optional" was applied to EVERY way it could fail, so a
      // gates.json with a malformed regex, a missing login_pattern or an
      // approver naming an undeclared reviewer reported `warn` and let the
      // report pass. A file that IS there and is WRONG is a defect in this
      // repository's own taxonomy; only its ABSENCE is the tolerable state the
      // optional flag was written for.
      //
      // ENOENT is the one the loaders phrase as "no such file"; anything else
      // reaching here got past the read and failed validation.
      required: required || !isAbsentFileError(error),
    };
  }
}

// Whether a failure is "the file is not there" as opposed to "the file is
// there and does not say what it must". `source.ts` turns ENOENT into a
// SchemaError with a distinctive opening, which is the contract this reads --
// and `source.test.ts` pins that wording so this cannot drift into treating a
// corrupt file as an absent one.
export const ABSENT_FILE_MARKER = "no such file.";

function isAbsentFileError(error: unknown): boolean {
  return error instanceof SchemaError && error.message.includes(ABSENT_FILE_MARKER);
}

// Load every schema file and report each one's verdict, never stopping at the
// first failure. Reporting one problem at a time is how a repository adopting
// nen makes four round trips to learn four things it could have been told at
// once.
export function checkTaxonomy(options: RepoRootOptions = {}): CheckReport {
  const root = assertRepoRoot(options);
  const checks: SchemaCheck[] = [
    run(LABELS_FILE, root, true, (): string => {
      const labels = loadLabelTaxonomy(root);
      return `${labels.labels.length} labels`;
    }),
    run(REPOS_FILE, root, true, (): string => {
      const repos = loadRepoRegistry(root);
      return `${repos.consumers.length} consumers, ${Object.keys(repos.productCodes).length} product codes, latest ${repos.latest ?? "(unrecorded)"}`;
    }),
    run(COLORS_FILE, root, true, (): string => {
      const colors = loadColorVocabulary(root);
      const total = colors.categories.reduce(
        (sum, category): number => sum + category.values.length,
        0,
      );
      return `${colors.categories.length} categories, ${total} values`;
    }),
    run(GATES_FILE, root, false, (): string => {
      const gates = loadGateIdentities(root);
      return `${gates.reviewers.length} reviewer identities`;
    }),
  ];
  return {
    root,
    checks,
    ok: checks.every((check): boolean => check.ok || !check.required),
  };
}
