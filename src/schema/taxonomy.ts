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
import {
  COLORS_FILE,
  GATES_FILE,
  LABELS_FILE,
  LEGACY_FALLBACK_REMOVED_IN,
  REPOS_FILE,
  resolveSchemaFile,
  shadowState,
  type SchemaLocation,
} from "./source.js";

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
  /** The repo-relative path that was READ -- `nen/…`, or `schemas/…` when the fallback answered. */
  readonly file: string;
  readonly path: string;
  /** Which of the two directories answered; `nen` when the file is absent from both. */
  readonly location: SchemaLocation;
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
  /**
   * `true` when a DIFFERENT copy of this file is still sitting at the legacy
   * `schemas/` path. Nen read the `nen/` one; the legacy one is a stale
   * taxonomy somebody may still be editing, so the row FAILS even though the
   * load succeeded -- a silent win for `nen/` is exactly how the wrong file
   * stays on disk for a year.
   */
  readonly shadowed: boolean;
  /**
   * The migration sentence for this row -- a legacy read, a shadowed leftover,
   * or an identical copy that is free to delete. `null` when there is nothing
   * to say.
   */
  readonly note: string | null;
}

export interface CheckReport {
  readonly root: string;
  readonly checks: readonly SchemaCheck[];
  /** False when any REQUIRED file failed, or any file is shadowed by a different legacy copy. */
  readonly ok: boolean;
  /**
   * Every migration sentence the run produced, in row order, so a machine
   * reader sees the migration state without parsing prose. Empty for a fully
   * migrated repository.
   */
  readonly deprecations: readonly string[];
}

// The two sentences a consumer mid-migration needs, written once so the four
// files cannot disagree about what they promise.
function migrationNote(
  canonical: string,
  legacy: string,
  kind: "read" | "shadow-different" | "shadow-identical",
): string {
  if (kind === "read") {
    return `legacy location. Move it to '${canonical}'; the schemas/ fallback is removed in ${LEGACY_FALLBACK_REMOVED_IN}.`;
  }
  if (kind === "shadow-identical") {
    return `an identical copy is still at '${legacy}'. Deleting it is free today; the schemas/ fallback is removed in ${LEGACY_FALLBACK_REMOVED_IN}.`;
  }
  return `SHADOWED LEFTOVER: '${legacy}' is also present and its bytes DIFFER from '${canonical}'. Nen read '${canonical}'; whoever is editing the other file is editing nothing. Delete it, or reconcile it into '${canonical}' -- the schemas/ fallback is removed in ${LEGACY_FALLBACK_REMOVED_IN}.`;
}

function run(
  relative: string,
  root: string,
  required: boolean,
  load: () => string,
): SchemaCheck {
  const resolved = resolveSchemaFile(root, relative);
  const { path, location } = resolved;
  const file = resolved.relative;
  const shadow = shadowState(resolved);
  const legacyRelative = resolved.legacy?.relative ?? null;
  const shadowed = shadow === "different";
  const note =
    legacyRelative === null
      ? null
      : shadow === "different"
        ? migrationNote(resolved.canonical.relative, legacyRelative, "shadow-different")
        : shadow === "identical"
          ? migrationNote(resolved.canonical.relative, legacyRelative, "shadow-identical")
          : location === "schemas"
            ? migrationNote(resolved.canonical.relative, legacyRelative, "read")
            : null;
  try {
    return { file, path, location, ok: true, detail: load(), required, shadowed, note };
  } catch (error) {
    return {
      file,
      path,
      location,
      ok: false,
      detail: error instanceof SchemaError ? error.message : String(error),
      shadowed,
      note,
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
    // A SHADOWED LEFTOVER FAILS THE REPORT even though its file loaded. The
    // alternative is a repository where `nen/` quietly wins, the stale
    // `schemas/` copy is the one a human keeps editing, and nothing on screen
    // ever says so -- which is the single failure the fallback was most likely
    // to introduce, so it is the one this verb refuses to pass.
    ok: checks.every((check): boolean => (check.ok || !check.required) && !check.shadowed),
    deprecations: checks
      .map((check): string | null => (check.note === null ? null : `${check.file}: ${check.note}`))
      .filter((note): note is string => note !== null),
  };
}
