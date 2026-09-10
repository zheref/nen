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
  REPOS_FILE,
  resolveSchemaFile,
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
  /** The repo-relative `nen/…` path -- the only one anything ever reads. */
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
  /**
   * `true` when a pre-v0.3.0 `schemas/<file>` copy still sits on disk. `false`
   * for a file with no legacy location (`nen/contract.json`, `nen/workflow.json`)
   * and for one that genuinely has neither copy. This is a DETECTION, never a
   * read: the fallback that once served this location is gone, so its presence
   * changes nothing about `ok` or `detail` above by itself.
   */
  readonly legacy: boolean;
  /**
   * The leftover-cleanup sentence, for the one case that has something new to
   * say: `nen/<file>` loaded (present, per `ok`/`detail` above) AND a
   * `schemas/<file>` copy is still sitting beside it. `null` otherwise --
   * including when `nen/<file>` is itself absent, because that case is a plain
   * FAIL/warn on `ok`/`required` and its `detail` (../schema/source.ts's own
   * refusal) already names the migration; this field is not a second place to
   * repeat it.
   */
  readonly note: string | null;
}

export interface CheckReport {
  readonly root: string;
  readonly checks: readonly SchemaCheck[];
  /** False when any REQUIRED file failed to load and validate. */
  readonly ok: boolean;
  /**
   * Every leftover-cleanup sentence the run produced, in row order, so a
   * machine reader sees the migration state without parsing prose. Empty for a
   * fully migrated repository, and for one carrying no legacy copy at all.
   */
  readonly deprecations: readonly string[];
}

// The ONE leftover-cleanup sentence, written once so a caller reading two
// different rows in the same run never sees two different phrasings of the
// same fact. It fires only for the case that is new information: `nen/<file>`
// answered the read AND a `schemas/<file>` copy is still there. Whether the
// two agree byte-for-byte no longer matters to THIS check -- `nen/` is the
// only file anything reads, so a stale duplicate is clutter to delete, not a
// correctness risk to fail the report over. (`nen scaffold init`'s own copy
// step still cares whether the bytes agree, and still asks
// ../schema/source.ts's `inspectShadow` directly for that -- a different
// question, asked to decide a different action.)
//
// `git rm -r`, NOT A BARE `git rm`, AND WITH A SECOND OPTION NAMED. Detecting
// `legacy` is a `lstat`, not a `readdir` or a `git status` -- ../schema/
// source.ts's `isPresent` answers "is something there", not "is it a
// committed file" (this repository's own `run()` tests build a leftover that
// is a DIRECTORY). `git rm` alone refuses a directory outright ("not removing
// … recursively without -r"); `-r` is a no-op on a plain file and the one
// spelling that removes either. It can still fail on a copy nobody ever
// staged -- `git rm` only knows tracked paths -- so the sentence names the
// filesystem `rm -r` too, for the leftover this repository's own history
// never saw.
function leftoverNote(canonical: string, legacy: string): string {
  return `a legacy '${legacy}' copy is still there, beside '${canonical}'. Delete it (git rm -r ${legacy}, or rm -r ${legacy} if it was never committed) -- the schemas/ fallback was removed in v0.5.0.`;
}

function run(
  relative: string,
  root: string,
  required: boolean,
  load: () => string,
): SchemaCheck {
  const resolved = resolveSchemaFile(root, relative);
  const { path, canonical, legacy: legacyCandidate } = resolved;
  const file = resolved.relative;
  const legacy = legacyCandidate?.present ?? false;
  try {
    const detail = load();
    // ONLY A SUCCESSFUL LOAD HAS A NOTE. "Delete the leftover" is advice to
    // discard the `schemas/` copy on the strength of `nen/<file>` being the
    // working one -- true only once `nen/<file>` has actually loaded and
    // validated. A `nen/<file>` that exists but is broken (a bad symlink, a
    // directory, malformed content) must not get this note: it would be
    // telling an operator to delete the only copy that has ever been checked,
    // on the word of one that has not.
    const note =
      legacy && legacyCandidate !== null
        ? leftoverNote(canonical.relative, legacyCandidate.relative)
        : null;
    return { file, path, ok: true, detail, required, legacy, note };
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
      // optional flag was written for. A repository carrying ONLY a legacy
      // `schemas/<file>` copy is ABSENT in this same sense -- readSchemaFile
      // refuses it exactly as it refuses no file at all, so `isAbsentFileError`
      // is still true and `required` does not tighten on its account.
      //
      // ENOENT is the one the loaders phrase as "no such file"; anything else
      // reaching here got past the read and failed validation.
      //
      // The field order matches the success branch above, so that `--json`
      // publishes one key order for every row rather than one per outcome.
      required: required || !isAbsentFileError(error),
      legacy,
      // No note on the failure branch, ever: a required-and-absent file's
      // migration sentence already lives in `detail` above (../schema/source.ts's
      // own refusal), and a present-but-broken file gets no "delete the
      // leftover" advice, for the reason given in the success branch.
      note: null,
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
    // A LEFTOVER `schemas/` COPY NO LONGER FAILS THE REPORT. It used to, back
    // when `nen/` merely WON a race a fallback could still lose on a broken
    // canonical file -- now `nen/` is the only file anything ever reads, so a
    // stale duplicate is housekeeping, not a correctness risk, and it is
    // reported as a `warn` row with a note instead.
    ok: checks.every((check): boolean => check.ok || !check.required),
    deprecations: checks
      .map((check): string | null => (check.note === null ? null : `${check.file}: ${check.note}`))
      .filter((note): note is string => note !== null),
  };
}
