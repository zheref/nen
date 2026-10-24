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

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { MARKER_FILE, parseMarker } from "../stop/marker.js";
import { assertRepoRoot, type RepoRootOptions } from "../repo/root.js";
import { loadColorVocabulary, type ColorVocabulary } from "./colors.js";
import { describeContract, loadContract, precedenceRestatementFindings, withinOneEdit, type DeployTarget } from "./contract.js";
import { GatesDuplicateKeyError, GatesUnknownKeyError, loadGateIdentities, pointerSegment, visibleKey, type GateIdentities } from "./gates.js";
import { loadLabelTaxonomy, type LabelTaxonomy } from "./labels.js";
import { loadRepoRegistry, type RepoRegistry } from "./repos.js";
import { SchemaError } from "./errors.js";
import {
  describeReviewScopes,
  describeRelease,
  describeSections,
  describeProfile,
  describeRunners,
  describeWorkflow,
  describeAlwaysOverlaps,
  describeIdle,
  DEFAULT_TARGET_NONE,
  loadWorkflow,
  WORKFLOW_FILE,
  type Workflow,
} from "./workflow.js";
import { describeDecisions, loadDecisions } from "./decisions.js";
import { canonMirrorCheck } from "./canonmirror.js";
import type { Runner } from "../seam/exec.js";
import {
  COLORS_FILE,
  DECISIONS_FILE,
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
  /** The repo-relative declaration path, or optional generated ledger path. */
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
  /**
   * Every key a file carries that this build does not read, as
   * `<file>: <pointer>.<key>` (zheref/nen#310). Each is also a failed row; this
   * list is what makes `nen schema check` exit 2 rather than 1 -- the file asks
   * for a gate this binary cannot apply, which is a fact about the binary as
   * much as the file. Empty when every key is known.
   */
  readonly unknownKeys: readonly string[];
  /**
   * A key repeated within one object of `nen/gates.json`, as `<file>:
   * <pointer>.<key>` (Feitan F3). Also a failed row, and also exit 2. Empty
   * when none is repeated. Additive.
   */
  readonly duplicateKeys: readonly string[];
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
// The colour row. ITS ABSENCE IS `ok` FROM v0.11.0 (zheref/nen#216): a
// repository that declares no colour vocabulary has nothing for `nen color
// status` and the board renderers to resolve, and each of THOSE verbs refuses
// by name when asked -- which is the right place for that refusal. Making the
// aggregate red on every consumer that never adopted the file taught every
// warm-up to read "FAIL" as background noise, which is how a real FAIL goes
// unread. Present and malformed still fails by pointer.
function colorsCheck(root: string): SchemaCheck {
  const check = run(COLORS_FILE, root, false, (): string => {
    const colors = loadColorVocabulary(root);
    const total = colors.categories.reduce((sum, category): number => sum + category.values.length, 0);
    return `${colors.categories.length} categories, ${total} values`;
  });
  if (check.ok || !check.detail.includes(ABSENT_FILE_MARKER)) return check;
  return { ...check, ok: true, detail: "absent (optional)" };
}

// The decision-matrix row (zheref/nen#216). Absent is `ok` because the loader
// answers an empty matrix -- every stop is then decided by prose, as it was
// before the file existed. Present and malformed fails by pointer.
function decisionsCheck(root: string): SchemaCheck {
  return run(DECISIONS_FILE, root, false, (): string => describeDecisions(loadDecisions(root)));
}

// The `idle` row (HR-5). Like `deploy.defaultTarget`, it reads TWO files: the
// profile lives in `nen/workflow.json`, and the rows it resolves are
// `nen/decisions.json`'s. A row the local matrix declares with a class other
// than ask-once-per-run is a required FAIL by pointer -- an idle batch may only
// pre-answer a question a run would ask once. A row the local matrix does not
// declare at all is a WARN, never a pass and never a fail: a consumer's own
// file overrides the canon matrix it runs under, so the row may be the canon's,
// and this checkout cannot see that. An absent matrix is the same warn, said.
function idleCheck(root: string): SchemaCheck {
  const resolved = resolveSchemaFile(root, WORKFLOW_FILE);
  const row = (ok: boolean, required: boolean, detail: string): SchemaCheck => ({
    file: `${resolved.relative}#idle`,
    path: resolved.path,
    ok,
    detail,
    required,
    legacy: false,
    note: null,
  });
  let workflow: Workflow;
  let policyPath: string;
  try {
    const loaded = loadWorkflow(root);
    if (!loaded.present) return row(true, false, "none declared (no policy file)");
    workflow = loaded.workflow;
    policyPath = loaded.path;
  } catch {
    return row(true, false, `not read -- ${WORKFLOW_FILE} did not load; see that row`);
  }
  const idle = workflow.idle ?? null;
  if (idle === null) return row(true, false, "none declared");
  const summary = describeIdle(idle);
  // A KEY NEN DOES NOT READ IS SAID, never accepted silently: a consumer that
  // states a rule nen ignores believes it is in force (delivery round on
  // zheref/nen#498, reading 5).
  if (idle.unreadKeys.length > 0) {
    return row(false, false, `${summary} -- idle.${idle.unreadKeys.join(", idle.")} ${idle.unreadKeys.length === 1 ? "is a key" : "are keys"} nen does not read; nothing it says is enforced here`);
  }
  const ids = Object.keys(idle.decisions);
  if (ids.length === 0) return row(true, false, summary);
  let matrix;
  try {
    matrix = loadDecisions(root);
  } catch {
    return row(false, false, `${summary} -- not cross-checked: ${DECISIONS_FILE} did not load; see that row`);
  }
  if (!matrix.present) {
    return row(false, false, `${summary} -- not cross-checked: no ${DECISIONS_FILE} here, so whether each id is an ask-once-per-run row is unknown (the rows may be the canon matrix's)`);
  }
  for (const id of ids) {
    const declared = matrix.row(id);
    if (declared !== undefined && declared.class !== "ask-once-per-run") {
      return row(
        false,
        true,
        new SchemaError(
          policyPath,
          `idle.decisions.${id}`,
          `resolves '${id}', which ${DECISIONS_FILE} declares as a '${declared.class}' row. An idle batch may pre-answer only an ask-once-per-run row: an autonomous row asks nothing, and a human gate is never pre-answered`,
        ).message,
      );
    }
  }
  const unknown = ids.filter((id): boolean => matrix.row(id) === undefined);
  if (unknown.length > 0) {
    return row(false, false, `${summary} -- ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not declared in ${DECISIONS_FILE}; the row may be the canon matrix's, which this checkout cannot see`);
  }
  return row(true, false, summary);
}

function workflowCheck(root: string): SchemaCheck {
  return run(WORKFLOW_FILE, root, false, (): string => {
    const loaded = loadWorkflow(root);
    const severity = loaded.workflow.severity;
    if (severity !== null) {
      const labels = loadLabelTaxonomy(root);
      const missing = severity.order.filter((leaf) => !labels.has(severity.labels?.[leaf] ?? `${severity.family}/${leaf}`));
      if (missing.length > 0) throw new SchemaError(loaded.path, "severity.order", `not declared in ${labels.path}: ${missing.map((leaf) => severity.labels?.[leaf] ?? `${severity.family}/${leaf}`).join(", ")}`);
    }
    return loaded.present ? describeWorkflow(loaded.workflow) : "absent (defaults apply)";
  });
}

// The two POINTER rows (zheref/nen#220). Both live inside `nen/workflow.json`
// and both get a row of their own, because they answer a question the policy
// row does not: `reports.sections` is what `nen report render --variant` reads
// and `review.scopes` is what `nen review scopes` reads, and a warm-up that
// wants to know whether those verbs have anything to work with should not have
// to read a coverage ladder to find out. Their `file` therefore names the
// POINTER, not a second file -- `nen/workflow.json#reports.sections` -- so a
// machine reader of `--json` can tell them from the file rows by the `#`.
//
// NEVER REQUIRED AND NEVER A FAIL OF THEIR OWN. A malformed block already
// fails the POLICY row by pointer (the loader refuses the whole file), so
// these two can only ever report what a successfully-loaded policy declares.
// A repository that declares neither is a repository that has not adopted the
// two verbs, which is an `ok` row reading `none declared`.
function pointerCheck(root: string, pointer: string, describe: (workflow: Workflow) => string): SchemaCheck {
  const resolved = resolveSchemaFile(root, WORKFLOW_FILE);
  const file = `${resolved.relative}#${pointer}`;
  try {
    const loaded = loadWorkflow(root);
    return {
      file,
      path: resolved.path,
      ok: true,
      detail: loaded.present ? describe(loaded.workflow) : "none declared (no policy file)",
      required: false,
      legacy: false,
      note: null,
    };
  } catch (error) {
    // The policy row above already reported this by pointer; saying it twice in
    // two voices would make one defect read as two. This row says only that it
    // could not be read, and points at the row that says why.
    return {
      file,
      path: resolved.path,
      ok: true,
      detail: `not read -- ${WORKFLOW_FILE} did not load; see that row${error instanceof SchemaError ? "" : ""}`,
      required: false,
      legacy: false,
      note: null,
    };
  }
}

// The `deploy.defaultTarget` row (zheref/nen#300). UNLIKE THE POINTER ROWS
// ABOVE, THIS ONE CAN FAIL, and it is the only row that reads two files: the
// value lives in `nen/workflow.json` and what it must name lives in
// `nen/contract.json` → `project.targets`, so neither loader alone can say
// whether it is right. A malformed value (a number, an empty string, a
// near-miss key) is already refused by the POLICY row's loader, by pointer;
// this row adds the half no single loader can see. Two findings are a
// REQUIRED FAIL by pointer: a name that is no declared target (a caller's
// tooling would hand it to `nen shu deploy --target`, which refuses it at 2),
// and a declared target not marked `nonProduction: true` (a default is what a
// bare invocation sends to, so it must never be a production destination --
// and prose in `why` is not a mark). A marked target with no command line
// (`unsupported`) is a `warn`: the default is honest, and sending to it is
// exit 4 with the repository's own reason.
//
// THE ROW NEVER FAILS ON ANOTHER ROW'S ACCOUNT, and the two "could not
// check" cases are deliberately different. A POLICY that did not load gives
// `ok: true` reading `not read`: the policy row already FAILs by pointer and
// this row has no name to judge at all. A CONTRACT that did not load, under a
// policy that DOES name a target, gives `ok: false`, not required, reading
// `not checked`: there is a name, and a check that was not performed is not
// one that passed -- but the contract row already fails the report.
//
// EVERY NAME IN A MESSAGE IS THE FILE'S TEXT, shown through `visibleKey`
// (Feitan F2 on #300): a target key or a default carrying ESC, CR or a bidi
// override is printed escaped, never raw.
const DEFAULT_TARGET_POINTER = "deploy.defaultTarget";

/** The largest file `precedenceRestatedIn` may name: a prose page, never a dump (4 MiB). */
export const RESTATEMENT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The `precedence` restatement row (zheref/nen#474, Hatsu HR-1): every file
 * `precedenceRestatedIn` names, read and held to the array. A FAIL-capable
 * pointer row like `deploy.defaultTarget`'s, because it checks the contract
 * against second files: drift, a file restating nothing, and a file that
 * could not be read (absent, outside the root, not UTF-8) are each a required
 * FAIL naming the file -- an unread file is never a parity pass. THE ROW
 * APPEARS ONLY WHEN THE KEY IS DECLARED, so the report a repository without it
 * reads is unchanged row for row.
 */
function precedenceRestatementCheck(root: string): SchemaCheck | null {
  const resolved = resolveSchemaFile(root, CONTRACT_FILE);
  const row = (ok: boolean, required: boolean, detail: string): SchemaCheck => ({
    file: `${resolved.relative}#precedenceRestatedIn`,
    path: resolved.path,
    ok,
    detail,
    required,
    legacy: false,
    note: null,
  });
  let precedence: readonly string[] | null;
  let files: readonly string[] | null;
  try {
    const contract = loadContract(root);
    precedence = contract.precedence;
    files = contract.precedenceRestatedIn;
  } catch {
    // Absent or malformed: the contract row already says so, and no
    // restatement is declared that this row could hold to anything.
    return null;
  }
  if (precedence === null || files === null) return null;
  const findings: string[] = [];
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    realRoot = root;
  }
  for (const file of files) {
    let text: string;
    try {
      const real = realpathSync(join(root, file));
      // `relative`, never a '/' prefix test: on Windows the separator is '\\'
      // and a short (8.3) temp path only matches once both sides are real.
      const inside = relative(realRoot, real);
      if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        findings.push(`${file}: could not read -- it resolves outside the repository`);
        continue;
      }
      // A REGULAR FILE, AND A BOUNDED ONE (zheref/nen#515, Feitan 3): the path
      // is a pull request author's to choose, and this check may run in CI.
      const stat = statSync(real);
      if (!stat.isFile()) {
        findings.push(`${file}: could not read -- it is not a regular file`);
        continue;
      }
      if (stat.size > RESTATEMENT_MAX_BYTES) {
        findings.push(`${file}: could not read -- ${stat.size} bytes is over the ${RESTATEMENT_MAX_BYTES}-byte cap for a restating file`);
        continue;
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(real));
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "not UTF-8";
      findings.push(`${file}: could not read (${code})`);
      continue;
    }
    findings.push(...precedenceRestatementFindings(file, text, precedence));
  }
  if (findings.length === 0) return row(true, false, `${files.length} restatement file${files.length === 1 ? " agrees" : "s agree"} with precedence: ${files.join(", ")}`);
  return row(false, true, new SchemaError(resolved.path, "precedenceRestatedIn", findings.join("; ")).message);
}

function defaultTargetCheck(root: string): SchemaCheck {
  const resolved = resolveSchemaFile(root, WORKFLOW_FILE);
  const row = (ok: boolean, required: boolean, detail: string): SchemaCheck => ({
    file: `${resolved.relative}#${DEFAULT_TARGET_POINTER}`,
    path: resolved.path,
    ok,
    detail,
    required,
    legacy: false,
    note: null,
  });
  let name: string | null;
  let policyPath: string;
  try {
    const loaded = loadWorkflow(root);
    if (!loaded.present) return row(true, false, "none declared (no policy file)");
    name = loaded.workflow.deploy.defaultTarget;
    policyPath = loaded.path;
  } catch {
    return row(true, false, `not read -- ${WORKFLOW_FILE} did not load; see that row`);
  }
  if (name === null) return row(true, false, DEFAULT_TARGET_NONE);
  const shown = visibleKey(name);
  let targets: Readonly<Record<string, DeployTarget>>;
  try {
    targets = loadContract(root).project?.targets ?? {};
  } catch (error) {
    // ABSENT IS A FACT THIS ROW CAN JUDGE; MALFORMED IS NOT. An absent contract
    // declares no destination at all, so a stated name dangles -- that is
    // this row's finding. A contract present and broken fails its own row.
    if (error instanceof SchemaError && error.message.includes(ABSENT_FILE_MARKER)) {
      targets = {};
    } else {
      return row(
        false,
        false,
        `not checked -- names ${shown}, but ${CONTRACT_FILE} did not load, so whether it is a declared nonProduction key of project.targets is unknown; see that row`,
      );
    }
  }
  const fail = (message: string): SchemaCheck =>
    row(false, true, new SchemaError(policyPath, DEFAULT_TARGET_POINTER, message).message);
  const target = Object.prototype.hasOwnProperty.call(targets, name) ? targets[name] : undefined;
  if (target === undefined) {
    const declared = Object.keys(targets).sort();
    const meant = declared.find((candidate): boolean => withinOneEdit(name, candidate));
    const listed =
      declared.length === 0
        ? `${CONTRACT_FILE} declares no project.targets at all`
        : `${CONTRACT_FILE} declares project.targets: ${declared.map(visibleKey).join(", ")}`;
    return fail(
      `names ${shown}, which is not a key of project.targets -- ${listed}.${
        meant === undefined ? "" : ` It is one edit from ${visibleKey(meant)}.`
      } A caller's tooling would pass it to 'nen shu deploy --target', which refuses an undeclared destination at exit 2. Name a declared target, declare this one, or set it to null`,
    );
  }
  if (!target.nonProduction) {
    return fail(
      `names ${shown}, which ${CONTRACT_FILE} declares without "nonProduction": true -- a default deploy destination must be declared nonProduction. A default is what a bare invocation sends to, so it must never reach production users, and a 'why' that reads non-production is prose, not a mark. Add "nonProduction": true to project.targets.${pointerSegment(name)} if it is one, or name a target that is`,
    );
  }
  if (target.unsupported !== null) {
    return row(
      false,
      false,
      `${shown} is a declared nonProduction target with no command line (unsupported): 'nen shu deploy --target' answers it at exit 4 with the repository's own reason, so a default naming it can never send anything`,
    );
  }
  return row(true, false, `${shown} (a nonProduction key of ${CONTRACT_FILE} → project.targets)`);
}

// Load every schema file and report each one's verdict, never stopping at the
// first failure. Reporting one problem at a time is how a repository adopting
// nen makes four round trips to learn four things it could have been told at
// once.
export interface CheckOptions extends RepoRootOptions {
  /** Opt in to the generated stop marker; ordinary schema checks never read it. */
  readonly ledger?: boolean;
  /**
   * The subprocess seam, for the one row that reads git: the canon mirror row
   * (zheref/nen#262), and only when `.claude/canon-values.yml` and a generated
   * mirror are both present. Absent, that row reads `NOT CHECKED` there.
   */
  readonly run?: Runner;
}

function stopMarkerCheck(root: string): SchemaCheck {
  const path = join(root, MARKER_FILE);
  const row = (ok: boolean, required: boolean, detail: string): SchemaCheck => ({
    file: MARKER_FILE, path, ok, detail, required, legacy: false, note: null,
  });
  let text: string;
  try {
    // Refuse special files before opening: a FIFO read can wait forever for a writer.
    if (!lstatSync(path).isFile()) return row(false, true, "could not read marker: not a regular file");
    // NONBLOCK also bounds a POSIX FIFO swapped in after lstat; NOFOLLOW refuses
    // a swapped final symlink where supported. Check the opened descriptor too.
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!fstatSync(fd).isFile()) return row(false, true, "could not read marker: not a regular file");
      text = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  } catch (error) {
    // Windows may report ENOENT for a child of a present FILE, where POSIX
    // reports ENOTDIR. Only an absent marker or absent parent is optional.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        // Establish entry absence without following a dangling parent symlink.
        lstatSync(dirname(path));
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code === "ENOENT") return row(true, false, "absent (optional; may have been consumed)");
        return row(false, true, `could not read marker parent: ${parentError instanceof Error ? parentError.message : String(parentError)}`);
      }
      try {
        // A present parent may be a directory symlink; its target must resolve.
        if (!statSync(dirname(path)).isDirectory()) return row(false, true, "could not read marker: parent is not a directory");
      } catch (parentError) {
        return row(false, true, `could not read marker parent: ${parentError instanceof Error ? parentError.message : String(parentError)}`);
      }
      return row(true, false, "absent (optional; may have been consumed)");
    }
    return row(false, true, `could not read marker: ${error instanceof Error ? error.message : String(error)}`);
  }
  let document: unknown;
  try { document = JSON.parse(text); }
  catch { return row(false, true, "not JSON"); }
  const verdict = parseMarker(document);
  return verdict.ok
    ? row(true, false, `valid ${String(verdict.marker["contract"])}`)
    : row(false, true, `invalid marker: ${verdict.reason}`);
}

export function checkTaxonomy(options: CheckOptions = {}): CheckReport {
  const root = assertRepoRoot(options);
  const unknownKeys: string[] = [];
  const duplicateKeys: string[] = [];
  // A key as the list shows it: plain when printable ASCII, else escaped
  // (Feitan F2) -- the file's text never reaches a terminal raw.
  const shown = (pointer: string, key: string): string =>
    `${GATES_FILE}: ${pointer === "$" ? "" : `${pointer}.`}${pointerSegment(key)}`;
  const checks: SchemaCheck[] = [
    run(LABELS_FILE, root, true, (): string => {
      const labels = loadLabelTaxonomy(root);
      return `${labels.labels.length} labels`;
    }),
    run(REPOS_FILE, root, true, (): string => {
      const repos = loadRepoRegistry(root);
      // The canon pin (CON-13) is surfaced here because a pin nobody can see
      // is a pin nobody knows has moved -- it was prose in a `$comment` until
      // the loader modelled it.
      const pins = Object.entries(repos.toolPins).map(([repo, tag]): string => `${repo}@${tag}`);
      const families = repos.families ?? [];
      return `${repos.consumers.length} consumers, ${Object.keys(repos.productCodes).length} product codes, latest ${repos.latest ?? "(unrecorded)"}${pins.length === 0 ? "" : `, pinned tools: ${pins.join(", ")}`}${families.length === 0 ? "" : `, families: ${families.map((family): string => `${family.name} (${family.members.length} member${family.members.length === 1 ? "" : "s"})`).join(", ")}`}`;
    }),
    colorsCheck(root),
    run(GATES_FILE, root, false, (): string => {
      let gates: GateIdentities;
      try {
        gates = loadGateIdentities(root);
      } catch (error) {
        // Recorded for the exit code (zheref/nen#310), then failed as any other
        // present-and-wrong gates.json: the row and its `detail` are unchanged.
        if (error instanceof GatesUnknownKeyError) {
          for (const { pointer, key } of error.unread) unknownKeys.push(shown(pointer, key));
        }
        if (error instanceof GatesDuplicateKeyError) duplicateKeys.push(shown(error.pointer ?? "$", error.key));
        throw error;
      }
      // `checks.excluded` (zheref/nen#249) is counted only when declared, so a
      // file without it reads exactly as it did before the key existed.
      const excluded = gates.excludedChecks?.length ?? 0;
      return `${gates.reviewers.length} reviewer identities${
        excluded === 0 ? "" : `, ${excluded} declared check exclusion${excluded === 1 ? "" : "s"}`
      }`;
    }),
    // `nen/contract.json` IS OPTIONAL AND ITS ABSENCE IS AN `ok` ROW, not a
    // warning -- unlike gates.json, whose absence is a warning because the
    // readiness verbs are the reason most repositories adopt nen at all. A
    // repository that declares no dependency pin and no stack is not
    // mid-adoption; it is a repository this file has nothing to say about. What
    // is NOT tolerated is a contract that is present and wrong, which fails
    // exactly like a present-and-wrong gates.json.
    contractCheck(root),
    // ...and the prose restatements of its `precedence` (zheref/nen#474).
    ...[precedenceRestatementCheck(root)].filter((check): check is SchemaCheck => check !== null),
    // `nen/workflow.json` LAST, and optional in the third of the three senses
    // this report distinguishes: gates.json's absence WARNS, contract.json's
    // absence is nothing to read, and this file's absence is a full policy made
    // of defaults. Present and malformed fails, like both of them.
    workflowCheck(root),
    // ...and the two POINTER rows immediately under it, in the order the two
    // verbs that read them arrived (zheref/nen#220).
    pointerCheck(root, "reports.sections", describeSections),
    pointerCheck(root, "review.scopes", describeReviewScopes),
    // ...and the `profile` row (zheref/nen#227): which run profile a bare turn
    // runs under, and which it may be asked for. Defaults apply when absent,
    // so this row reads the default rather than `none declared`.
    pointerCheck(root, "profile", describeProfile),
    // ...and the `runners` row: the self-hosted pools `nen runner` acts on.
    // No default, so an absent block reads `none declared`.
    pointerCheck(root, "runners", describeRunners),
    // ...and the `deploy.defaultTarget` row (zheref/nen#300): the one pointer
    // row that can FAIL, because it is checked against a second file.
    defaultTargetCheck(root),
    // The release unit's path/content bounds (zheref/nen#348).
    pointerCheck(root, "release", describeRelease),
    // The idle profile (HR-5), cross-checked against nen/decisions.json.
    idleCheck(root),
    // The paths `nen wc overlap` counts as touched by every effort (NN#488 AC-2).
    pointerCheck(root, "alwaysOverlaps", describeAlwaysOverlaps),
    // `nen/decisions.json` LAST OF THE nen/ FILES: newest file, optional, and read by the
    // stop verb and by every skill that would otherwise ask.
    decisionsCheck(root),
    // The consumer's generated `.claude/rules/` mirror against the bindings in
    // `.claude/canon-values.yml` (zheref/nen#262). Absent is `ok`; a value the
    // mirror kept after its binding moved is a required FAIL.
    canonMirrorCheck(root, options.run),
    ...(options.ledger === true ? [stopMarkerCheck(root)] : []),
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
    unknownKeys,
    duplicateKeys,
  };
}
