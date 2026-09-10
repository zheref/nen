// src/schema/source.ts -- where a taxonomy file lives, and how it is read.
//
// ONE PLACE THE PATHS ARE WRITTEN. `nen/labels.json`, `nen/repos.json`,
// `nen/colors.yml`, `nen/gates.json` and `nen/contract.json` are the target
// REPOSITORY's files, resolved from the root ../repo/root.ts computed for THIS
// invocation -- never bundled into the binary, never looked for beside the
// executable, never derived from `import.meta.url`.
//
// `nen/` IS COMMITTED CONFIGURATION ONLY. Generated output lives under a
// dot-prefixed, gitignored `.nen/`; the one-character difference is deliberate,
// so that `git add nen/` after a run can never stage a log.
//
// THE DISTINCTION THAT MATTERS: these are relative paths INSIDE the target repo,
// not names of things nen knows. `nen/labels.json` is a location; the label
// NAMES inside it are the data. A future repo that keeps its taxonomy somewhere
// else changes one constant here (or, better, gets a `--schemas` flag) -- and
// that is a different kind of change from teaching the binary a label name.
//
// A `$`-PREFIXED KEY IS METADATA, NOT DATA -- CONVENTION FOR EVERY LOADER READING
// THESE FILES. Most structural comments in this schema family sit BESIDE the
// collection they annotate (`nen/labels.json`'s own `$comment` beside `labels`),
// which every loader here already skips just by naming the fields it reads. The
// one shape that bites is a `$`-prefixed key nested INSIDE an object a loader
// walks key-by-key as data (`product_codes` is exactly that: bankai-core's own
// `nen/repos.json` documents the object-reference notation from a `$comment` key
// living inside `product_codes`, not beside it -- zheref/nen#17). A loader that
// iterates such an object must skip every key starting with `$` before treating
// the rest as real entries; the next loader that key-walks a data map inherits
// this same obligation, not just `../repos.ts`'s two call sites
// (`product_codes`, and the per-caller pin fields on a consumer entry).

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SchemaError } from "./errors.js";

export const LABELS_FILE = "nen/labels.json";
export const REPOS_FILE = "nen/repos.json";
export const COLORS_FILE = "nen/colors.yml";
export const GATES_FILE = "nen/gates.json";
export const CONTRACT_FILE = "nen/contract.json";

/**
 * THE FALLBACK ANNOUNCED IN v0.3.0 AND REMOVED HERE, IN v0.5.0.
 *
 * Through v0.2.0 the four taxonomy files lived under `schemas/`. From v0.3.0
 * the canonical directory is `nen/` (zheref/nen#108), and through the v0.3 and
 * v0.4 lines `schemas/` was READ as a fallback when `nen/` did not answer, so a
 * repository that had not migrated kept working. That fallback is gone: a
 * `schemas/` copy is never opened by anything below. `nen/` is the only
 * directory nen ever reads a taxonomy file from, unconditionally.
 *
 * THIS MAP SURVIVES THE FALLBACK'S REMOVAL, AND IS NOW A DETECTION TABLE, NOT A
 * SEARCH ORDER. Two things still need to know where a file USED to live: the
 * refusal a caller gets for an absent `nen/<file>` names the `schemas/<file>`
 * it found instead, so the message can point at `nen scaffold init
 * --accept-detected` rather than a bare "add the file"; and that same verb's
 * COPY step (../scaffold/init.ts) reads this map to know which four files to
 * migrate. Neither reads the legacy bytes as this repository's taxonomy.
 *
 * EXACTLY FOUR ENTRIES, AND `nen/contract.json` IS NOT ONE OF THEM. A legacy
 * entry is a promise that some released nen once READ that path; the contract
 * file is new in this line and no release ever looked for it anywhere. Mapping
 * it to a `schemas/` name would not preserve compatibility -- it would INVENT a
 * claim over a filename in a directory nen no longer owns, so that a repository
 * carrying an unrelated file of that name (its own build's stack manifest, say)
 * would start being parsed as a nen contract and fail `schema check` at exit 1
 * having changed nothing. A file with no legacy location gets `legacy: null`
 * below, and every message it produces names one path.
 */
const LEGACY_LOCATION: Readonly<Record<string, string>> = {
  [LABELS_FILE]: "schemas/labels.json",
  [REPOS_FILE]: "schemas/repos.json",
  [COLORS_FILE]: "schemas/colors.yml",
  [GATES_FILE]: "schemas/gates.json",
};

/**
 * The canonical paths that HAVE a legacy location, in byte order.
 *
 * DERIVED FROM THE MAP RATHER THAN TYPED OUT BESIDE IT, because a second hand-
 * written list is a list that falls behind. `nen scaffold init` migrates by
 * iterating this: a fifth entry added to `LEGACY_LOCATION` is a fifth file the
 * scaffold copies, with no edit anywhere else, and -- more to the point -- an
 * entry REMOVED here (which is what v0.5.0's deletion of the fallback is) stops
 * being migrated in the same commit rather than becoming a copy of a file
 * nothing reads any more.
 */
export const LEGACY_MIGRATABLE_FILES: readonly string[] = Object.keys(LEGACY_LOCATION).sort();

/**
 * Which directory answered a read. Always `"nen"` now that the `schemas/`
 * fallback is gone -- kept as a type, rather than a bare `string`, so
 * `RepositoryContract` and `LoadedWorkflow` (neither of which ever had a
 * legacy location) can keep publishing the field without importing a second
 * type for a value that is always the same.
 */
export type SchemaLocation = "nen" | "schemas";

export interface SchemaCandidate {
  /** Repo-relative, forward-slashed -- the spelling every message prints. */
  readonly relative: string;
  /** Absolute, platform-joined. */
  readonly path: string;
  readonly present: boolean;
}

export interface ResolvedSchemaFile {
  /** The canonical `nen/` path -- the only one anything below ever reads. */
  readonly relative: string;
  /** The absolute form of the same path. */
  readonly path: string;
  readonly location: SchemaLocation;
  /** The `nen/` candidate. Always present as a candidate, present-or-not on disk. */
  readonly canonical: SchemaCandidate;
  /** The `schemas/` candidate, or null for a file with no legacy location. */
  readonly legacy: SchemaCandidate | null;
}

export function schemaPath(repoRoot: string, relative: string): string {
  return join(repoRoot, ...relative.split("/"));
}

// "Is something there?", answered so that an ACCESS failure -- and a SYMLINK,
// dangling or not -- is never mistaken for an ABSENCE. Used for both the
// canonical candidate (feeds `readSchemaFile`'s refusal and every loader) and
// the legacy one (feeds the migration sentence and `nen scaffold init`'s copy
// step) -- neither may under-report "present" and turn a broken file into a
// falsely quiet "nothing here".
//
// `existsSync` returns false for any failure, so an EACCES on a parent
// directory or an ELOOP symlink cycle would misreport a file that is right
// there -- broken, but there -- as absent: for the canonical candidate that
// would tell an operator to CREATE a file that already exists and is merely
// unreadable, and for the legacy one it would silently drop a real migration
// candidate out of the message. `throwIfNoEntry: false` narrows that to the
// failures that genuinely mean "nothing is there"; anything this THROWS means
// the entry exists in some form this process could not stat, so it counts as
// present and the read below reports the real errno.
//
// `lstatSync`, NOT `statSync` -- THE PROBE MUST NOT FOLLOW THE SYMLINK. A
// `statSync` on a DANGLING symlink at `nen/labels.json` resolves the target,
// finds nothing, and reports plain ENOENT -- suppressed by `throwIfNoEntry`
// exactly like a missing file, so the entry would read as ABSENT and the
// refusal would call a broken canonical file "not found" instead of naming
// the real errno underneath it. `lstatSync` stats the symlink ITSELF, which is
// there regardless of what it points to, so both a dangling symlink and a
// SELF-REFERENTIAL one now succeed here and count as present; the read below
// is what follows the link and reports the real errno (ENOENT for the
// dangling case, ELOOP for the self-referential one that `source.test.ts`
// pins). EACCES still throws for either stat call, which is the property this
// module's "present" answer otherwise rests on.
//
// "NOTHING IS THERE" IS TWO ERRNOS, NOT ONE, and the second is worth naming
// because it is a deliberate widening rather than a leak: for `statSync`,
// `throwIfNoEntry: false` suppresses ENOTDIR as well as ENOENT, so a
// repository with a stray FILE named `nen` reads as an ABSENCE -- the same
// answer that repository would get with no `nen` entry at all, and the honest
// one, since nothing can ever live under a path component that is a file.
// VERIFIED WITH A PROBE: `lstatSync` does NOT get the same courtesy --
// `throwIfNoEntry: false` suppresses its ENOENT but still lets ENOTDIR through
// as a throw. Left alone that would flip the stray-`nen`-file case to
// "present" (any throw counts as present), so the catch below folds ENOTDIR
// back in by hand to keep the two stat calls answering identically here.
//
// THAT ONE IS UNIFORM ACROSS PLATFORMS, which is worth stating because the
// route differs: Windows reports `ERROR_PATH_NOT_FOUND` for a file used as a
// directory, which libuv maps to ENOENT, where POSIX reports ENOTDIR.
// `throwIfNoEntry` already suppresses ENOENT for both stat calls, so the
// Windows case never reaches the catch at all; the explicit ENOTDIR check
// below is the POSIX side of the same uniform answer.
function isPresent(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOTDIR";
  }
}

/**
 * Where a taxonomy file lives in THIS repository: always the canonical `nen/`
 * path -- because that is the only path anything below ever reads, and it is
 * also the one a "not found" message should tell an operator to create.
 *
 * `legacy` IS A DETECTION, NOT A SECOND CANDIDATE TO READ. It answers "does a
 * pre-v0.3.0 `schemas/<file>` still sit on disk", present or not, so a caller
 * can name it in a message; it never changes `location`, `path` or `relative`
 * above, which are the canonical file's regardless of what `legacy` finds.
 * `nen schema check` reports a present legacy copy as a leftover to delete,
 * and `readSchemaFile` below names it in the refusal for an absent canonical
 * file -- both read the map, neither reads the bytes.
 */
export function resolveSchemaFile(repoRoot: string, relative: string): ResolvedSchemaFile {
  const canonicalPath = schemaPath(repoRoot, relative);
  const canonical: SchemaCandidate = {
    relative,
    path: canonicalPath,
    present: isPresent(canonicalPath),
  };
  const legacyRelative = LEGACY_LOCATION[relative];
  const legacy: SchemaCandidate | null =
    legacyRelative === undefined
      ? null
      : {
          relative: legacyRelative,
          path: schemaPath(repoRoot, legacyRelative),
          present: isPresent(schemaPath(repoRoot, legacyRelative)),
        };
  return { relative: canonical.relative, path: canonical.path, location: "nen", canonical, legacy };
}

/**
 * Whether a legacy copy is still sitting beside a migrated canonical one.
 *
 * `unknown` IS ITS OWN ANSWER AND NOT A SYNONYM FOR `different`. It means the
 * comparison could not be PERFORMED -- one of the two copies would not open --
 * which fails the report for the same fail-closed reason `different` does, but
 * is a different thing to tell an operator. Collapsing it into `different`
 * makes the report assert three things it does not know: that the bytes differ,
 * that nen read the canonical copy, and that the legacy one is the one to
 * delete. In the case that produces it most often -- the canonical copy is the
 * unreadable one -- all three are false, and the last is advice to delete the
 * only file that still works.
 */
export type ShadowState = "none" | "identical" | "different" | "unknown";

export interface ShadowVerdict {
  readonly state: ShadowState;
  /**
   * The errno that stopped the comparison, for `unknown` only -- `null` for
   * every other state. It is what turns "could not compare" into something an
   * operator can act on: EACCES is a permission, ENOTDIR a stray file where a
   * directory belongs, ELOOP a symlink pointing at itself.
   */
  readonly errno: string | null;
}

/**
 * A LEGACY COPY THAT SURVIVED THE MOVE IS A FINDING, NOT A DETAIL. Both files
 * present with DIFFERENT bytes means an operator is editing one file and nen is
 * reading the other; identical bytes mean the deletion is free and nobody has
 * done it yet. The two are reported differently by `nen schema check` and only
 * the first fails it.
 *
 * A read failure on either side answers `unknown`, carrying the errno. Both
 * `different` and `unknown` fail the report -- "we could not prove they agree"
 * is the fail-closed reading either way -- but only `different` may claim the
 * bytes differ, and only `different` may name a file to delete.
 *
 * THE COMPARISON IS BYTE-EXACT, deliberately: two files that differ only in
 * line endings are two files a git checkout can disagree about, and a
 * "semantically identical" answer would tell an operator the deletion is free
 * when the two copies may still round-trip differently through their tools.
 */
export function inspectShadow(resolved: ResolvedSchemaFile): ShadowVerdict {
  const { canonical, legacy } = resolved;
  if (legacy === null || !canonical.present || !legacy.present) {
    return { state: "none", errno: null };
  }
  try {
    return {
      state: readFileSync(canonical.path).equals(readFileSync(legacy.path))
        ? "identical"
        : "different",
      errno: null,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: "unknown", errno: code ?? String(error) };
  }
}

// Read a schema file, converting the two failure modes a caller cares about into
// a SchemaError that names the path.
//
// ENOENT GETS ITS OWN SENTENCE, because it is the failure an operator will
// actually hit. The message says which file is missing, and -- the ONE place
// this is decided, for every verb that reads a taxonomy file -- whether a
// legacy `schemas/<file>` is sitting there unread, naming the migration: run
// `nen scaffold init --accept-detected`, or copy it by hand. A repository
// carrying only the legacy copy is, from here down, INDISTINGUISHABLE from one
// carrying neither; the only difference the caller sees is this one sentence.
//
// IT OPENS WITH `no such file.` IN EVERY CASE, and that wording is load-bearing:
// ../schema/taxonomy.ts's ABSENT_FILE_MARKER branches on it to tell "the file is
// not there" (tolerable for an optional schema) from "the file is there and is
// wrong" (never tolerable). The legacy sentence is an ADDITION inside that same
// opening, never a second one.
export function readSchemaFile(
  repoRoot: string,
  relative: string,
): { path: string; text: string; location: SchemaLocation; legacy: boolean } {
  const resolved = resolveSchemaFile(repoRoot, relative);
  const { path, location } = resolved;
  try {
    // `legacy` here means "this read was served by the fallback" -- always
    // `false`, because there is no fallback left to serve it. The field stays
    // on the shape rather than being deleted so a caller destructuring it does
    // not have to change, and so it stays visibly, honestly `false` instead of
    // disappearing.
    return { path, text: readFileSync(path, "utf8"), location, legacy: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR JOINS ENOENT HERE, matching `isPresent`'s own rule above: a path
    // component that is a FILE (a stray `nen` where the directory belongs)
    // means nothing can live under it, which is the same "nothing is there"
    // finding as a plain missing entry -- not a new failure mode with its own
    // sentence. Without this, a repository with a stray `nen` file would read
    // this file's real open() failure as "could not be read (ENOTDIR)", a
    // sentence that sends an operator looking for a corrupt file that was
    // never created, instead of the actionable "add the file" this branch
    // gives every other absence.
    if (code === "ENOENT" || code === "ENOTDIR") {
      const migration =
        resolved.legacy !== null && resolved.legacy.present
          ? ` A legacy '${resolved.legacy.relative}' is present -- run 'nen scaffold init --accept-detected' (or copy it) to migrate; the schemas/ fallback was removed in v0.5.0.`
          : "";
      throw new SchemaError(
        resolved.canonical.path,
        null,
        `no such file. Nen reads this repository's taxonomy from '${resolved.canonical.relative}' in the TARGET repo and has no built-in copy to fall back on -- a binary that guessed the names would report a taxonomy this repository does not have.${migration} Point it at a checkout that carries the file with --repo <path>, or add the file.`,
      );
    }
    if (code === "EISDIR") {
      throw new SchemaError(path, null, "expected a file, found a directory");
    }
    throw new SchemaError(path, null, `could not be read (${code ?? String(error)})`);
  }
}

export function readSchemaJson(
  repoRoot: string,
  relative: string,
): { path: string; value: unknown; location: SchemaLocation; legacy: boolean } {
  const { path, text, location, legacy } = readSchemaFile(repoRoot, relative);
  try {
    return { path, value: JSON.parse(text) as unknown, location, legacy };
  } catch (error) {
    throw new SchemaError(
      path,
      null,
      `is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
