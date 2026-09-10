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
import { describeContract, loadContract } from "./contract.js";
import { loadGateIdentities, type GateIdentities } from "./gates.js";
import { loadLabelTaxonomy, type LabelTaxonomy } from "./labels.js";
import { loadRepoRegistry, type RepoRegistry } from "./repos.js";
import { SchemaError } from "./errors.js";
import { describeWorkflow, loadWorkflow, WORKFLOW_FILE } from "./workflow.js";
import {
  COLORS_FILE,
  CONTRACT_FILE,
  GATES_FILE,
  LABELS_FILE,
  inspectShadow,
  LEGACY_FALLBACK_REMOVED_IN,
  REPOS_FILE,
  resolveSchemaFile,
  type SchemaLocation,
  type ShadowState,
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
   * What the two copies of this file had to say to each other: `none` when only
   * one location carries it, `identical` / `different` when both were read, and
   * `unknown` when one of them would not open at all. Published because
   * `different` and `unknown` are the same VERDICT and different FACTS, and a
   * machine reader that has only the boolean below cannot tell "the bytes
   * disagree" from "nen could not look".
   */
  readonly shadow: ShadowState;
  /**
   * `true` when a legacy copy at the `schemas/` path is unaccounted for --
   * either its bytes DIFFER from the `nen/` one, or nen could not read one of
   * the two to compare them. The row FAILS in both cases even though the load
   * may have succeeded: a silent win for `nen/` is exactly how the wrong file
   * stays on disk for a year, and an unverifiable pair is not evidence that the
   * right one won.
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
  /**
   * False when any REQUIRED file failed, or any file's legacy copy is
   * unaccounted for -- different bytes, or a comparison nen could not make.
   */
  readonly ok: boolean;
  /**
   * Every migration sentence the run produced, in row order, so a machine
   * reader sees the migration state without parsing prose. Empty for a fully
   * migrated repository.
   */
  readonly deprecations: readonly string[];
}

// The sentences a consumer mid-migration needs, written once so the four files
// cannot disagree about what they promise.
//
// THE FOURTH ONE EXISTS BECAUSE THE THIRD MUST NOT COVER IT. "Its bytes DIFFER",
// "Nen read '<canonical>'" and "delete the other one" are three claims that all
// happen to be false in the state where the comparison could not be made at
// all: when it is the CANONICAL copy that will not open, nen did not read it,
// nobody knows whether the bytes differ, and the file being nominated for
// deletion is the only one still working.
function migrationNote(
  canonical: string,
  legacy: string,
  kind: "read" | "shadow-different" | "shadow-identical" | "shadow-unknown",
  errno: string | null = null,
): string {
  if (kind === "read") {
    return `legacy location. Move it to '${canonical}'; the schemas/ fallback is removed in ${LEGACY_FALLBACK_REMOVED_IN}.`;
  }
  if (kind === "shadow-identical") {
    return `an identical copy is still at '${legacy}'. Deleting it is free today; the schemas/ fallback is removed in ${LEGACY_FALLBACK_REMOVED_IN}.`;
  }
  if (kind === "shadow-unknown") {
    return `UNVERIFIED LEFTOVER: '${legacy}' is also present, and nen could not read one of the two copies to compare them (${errno ?? "no errno reported"}). It does not know whether they agree, and it is not telling you to delete either one until they can be compared -- if it is '${canonical}' that will not open, that is the file to fix. Fail-closed, so this row fails the report; the schemas/ fallback is removed in ${LEGACY_FALLBACK_REMOVED_IN}.`;
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
  const { state: shadow, errno } = inspectShadow(resolved);
  const legacyRelative = resolved.legacy?.relative ?? null;
  // BOTH UNACCOUNTED-FOR STATES FAIL. `unknown` is not proof of a problem, but
  // it is the absence of proof that there is none, and this is the one check
  // whose entire job is to notice that two files disagree.
  const shadowed = shadow === "different" || shadow === "unknown";
  const note =
    legacyRelative === null
      ? null
      : shadow === "different"
        ? migrationNote(resolved.canonical.relative, legacyRelative, "shadow-different")
        : shadow === "unknown"
          ? migrationNote(resolved.canonical.relative, legacyRelative, "shadow-unknown", errno)
          : shadow === "identical"
            ? migrationNote(resolved.canonical.relative, legacyRelative, "shadow-identical")
            : location === "schemas"
              ? migrationNote(resolved.canonical.relative, legacyRelative, "read")
              : null;
  try {
    return { file, path, location, ok: true, detail: load(), required, shadow, shadowed, note };
  } catch (error) {
    return {
      file,
      path,
      location,
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
      //
      // The field order matches the success branch above, so that `--json`
      // publishes one key order for every row rather than one per outcome.
      required: required || !isAbsentFileError(error),
      shadow,
      shadowed,
      note,
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

// The contract row, which is the one row whose ABSENCE is `ok`. `run` reports
// every failure it is handed, so the absent case is turned into a summary here
// rather than being suppressed inside `run` -- a present-but-invalid contract
// still travels the ordinary failure path, marker and all.
function contractCheck(root: string): SchemaCheck {
  const check = run(CONTRACT_FILE, root, false, (): string =>
    describeContract(loadContract(root)),
  );
  if (check.ok || !check.detail.includes(ABSENT_FILE_MARKER)) return check;
  return { ...check, ok: true, detail: "absent (optional)" };
}

// The policy row. ITS ABSENCE IS `ok` FOR A DIFFERENT REASON FROM THE CONTRACT
// ROW'S, and the detail says which: an absent contract means there is nothing
// here to read, while an absent policy means every parameter takes the default
// ../schema/workflow.ts states. So the sentence is "defaults apply" rather than
// "optional" -- a caller reading this row is being told the loop still has a
// coverage ladder, a branch template and a trunk, not that it has none.
//
// THE ABSENT CASE IS DECIDED BY THE LOADER, NOT BY A MARKER. `loadWorkflow`
// already distinguishes "not there" (defaults) from "there and unreadable"
// (throws), so this row asks it rather than re-deriving the same fact from an
// error message -- and a present-but-malformed policy still travels `run`'s
// ordinary failure path and FAILS the row by pointer.
function workflowCheck(root: string): SchemaCheck {
  return run(WORKFLOW_FILE, root, false, (): string => {
    const loaded = loadWorkflow(root);
    return loaded.present ? describeWorkflow(loaded.workflow) : "absent (defaults apply)";
  });
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
    // `nen/contract.json` IS OPTIONAL AND ITS ABSENCE IS AN `ok` ROW, not a
    // warning -- unlike gates.json, whose absence is a warning because the
    // readiness verbs are the reason most repositories adopt nen at all. A
    // repository that declares no dependency pin and no stack is not
    // mid-adoption; it is a repository this file has nothing to say about. What
    // is NOT tolerated is a contract that is present and wrong, which fails
    // exactly like a present-and-wrong gates.json.
    contractCheck(root),
    // `nen/workflow.json` LAST, and optional in the third of the three senses
    // this report distinguishes: gates.json's absence WARNS, contract.json's
    // absence is nothing to read, and this file's absence is a full policy made
    // of defaults. Present and malformed fails, like both of them.
    workflowCheck(root),
  ];
  return {
    root,
    checks,
    // AN UNACCOUNTED-FOR LEFTOVER FAILS THE REPORT even though its file loaded.
    // The alternative is a repository where `nen/` quietly wins, the stale
    // `schemas/` copy is the one a human keeps editing, and nothing on screen
    // ever says so -- which is the single failure the fallback was most likely
    // to introduce, so it is the one this verb refuses to pass. A pair nen
    // could not compare fails the same way and for the same reason, while
    // saying a different thing on screen.
    ok: checks.every((check): boolean => (check.ok || !check.required) && !check.shadowed),
    deprecations: checks
      .map((check): string | null => (check.note === null ? null : `${check.file}: ${check.note}`))
      .filter((note): note is string => note !== null),
  };
}
