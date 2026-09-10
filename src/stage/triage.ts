// src/stage/triage.ts -- staging triage, tensho §3's table: detection only.
//
// "A FLAGGED FILE IS NEVER COMMITTED WITHOUT AN EXPLICIT YES" is the skill's
// own rule, and it names the human as the one who answers. This module's job
// ends at flagging: it detects a secret shape, an ignored file, a binary, a
// file outside the declared scope, a deletion nobody mentioned, a
// local-config filename and a file over the size threshold, and it hands back
// WHY each one was flagged. It never decides to stage or skip a
// file, and it never asks the question itself -- that stays with whoever is
// driving, exactly as issue #4's "what stays with the LLM" section says.
//
// EVERY FLAG IS REPORTED, NOT JUST THE FIRST. "Present all flags AT ONCE" is
// the skill's own instruction, so a file matching two reasons (an ignored
// binary, say) carries both rather than whichever check ran first.
//
// A GIT-IGNORED PATH IS A FACT, NOT A QUESTION (zheref/nen#169). It cannot be
// staged without `-f`, so there is nothing for a human to answer yes or no
// to -- unlike every other reason here, which flags something a plain `git
// add` COULD put in a commit. `triageStage` therefore returns it in its own
// `ignored` bucket rather than `flagged`: a repository with a large ignored
// tree (`node_modules/`, a generated `.cursor/` mirror) no longer buries the
// handful of rows that genuinely need a decision under thousands that don't.

export interface StatusEntry {
  readonly path: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly ignored: boolean;
}

// `git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall`.
//
// -z, NOT NEWLINE-SPLIT, AND core.quotePath=false FORCED. With the default
// (newline-terminated) porcelain format, git C-quotes any path containing a
// non-ASCII byte -- `secrëts/.env` comes back as `"secr\303\253ts/.env"`,
// quotes and octal escapes included -- which defeats every `$`-anchored
// shape check below on exactly the paths most worth catching (a name someone
// chose to make less greppable). `-z` disables that quoting unconditionally
// and NUL-terminates every record instead of newline-terminating it, so an
// embedded space or newline in a path cannot be confused with a field
// separator either; `core.quotePath=false` is forced too, defensively, in
// case a caller's global config has already turned quoting off in a way that
// changes the non-`-z` behavior this comment doesn't rely on.
//
// A rename or copy is not a single NUL-terminated record with an " -> " in
// it (that spelling is newline-mode only) -- in `-z` mode it is TWO
// consecutive NUL-terminated records, `XY NEW_PATH\0ORIG_PATH\0`. Only the
// NEW path is kept, since that is what would be staged; the ORIG_PATH record
// is consumed and never treated as an entry of its own.
export function parseStatusPorcelain(text: string): readonly StatusEntry[] {
  const entries: StatusEntry[] = [];
  const records = text.split("\0").filter((record): boolean => record !== "");
  for (let i = 0; i < records.length; i++) {
    const raw = records[i] ?? "";
    const indexStatus = raw[0] ?? " ";
    const worktreeStatus = raw[1] ?? " ";
    const path = raw.slice(3);
    entries.push({
      path,
      indexStatus,
      worktreeStatus,
      ignored: indexStatus === "!" && worktreeStatus === "!",
    });
    const isRenameOrCopy = indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C";
    if (isRenameOrCopy) {
      // The next record is ORIG_PATH -- skip it, it is not its own entry.
      i++;
    }
  }
  return entries;
}

export type FlagReason =
  | "secret-shape"
  | "ignored"
  | "binary"
  | "out-of-scope"
  | "unmentioned-deletion"
  | "local-config"
  | "large";

export interface FlaggedFile {
  readonly path: string;
  readonly reasons: readonly FlagReason[];
}

export interface TriageResult {
  readonly clean: readonly string[];
  readonly flagged: readonly FlaggedFile[];
  /**
   * Git-ignored paths, kept OUT of `flagged` (zheref/nen#169). An ignored
   * path is a FACT, not a question -- it cannot be staged without `-f`, so
   * there is nothing for a human to say yes or no to, and burying it among
   * paths that DO need a decision (an untracked-in-scope file, a
   * secret-shaped one) was the bug this bucket fixes. Every other reason
   * still computed for the entry travels with it here rather than being
   * dropped: a secret-shaped file inside an ignored tree still carries
   * `secret-shape` alongside `ignored`, recorded and never silently lost --
   * it is simply never counted toward `flagged`, because an ignored path can
   * never end up in a commit regardless of its name.
   */
  readonly ignored: readonly FlaggedFile[];
}

export interface TriageOptions {
  /** Path PREFIXES considered in-scope. Empty means "no scope declared" -- the out-of-scope check is skipped rather than flagging everything. */
  readonly scopePrefixes?: readonly string[];
  /** Free text (a commit message draft, a PR description) searched for a deleted path's basename. */
  readonly mentionedText?: string;
  /** Paths `git diff --numstat` reported as binary (both columns '-'). */
  readonly binaryPaths?: ReadonlySet<string>;
  /**
   * Working-tree size in bytes, per path. A path absent from the map is not
   * measured and is never flagged `large` -- a deletion has no file to stat,
   * and "could not be measured" must never render as "measured and small".
   */
  readonly sizes?: ReadonlyMap<string, number>;
  /** Bytes at or above which a file is `large`. Defaults to `DEFAULT_LARGE_BYTES`. */
  readonly largeBytes?: number;
}

/**
 * One mebibyte, and why a default exists here when `loop slots --local-cap`
 * refuses to have one.
 *
 * That flag is a concurrency GUARD, where a forgotten default silently WIDENS
 * what is allowed; this is a DETECTION threshold on a verb that decides
 * nothing, where the default errs toward flagging and a human answers anyway.
 * The two fail in opposite directions, so they get opposite treatments.
 *
 * A mebibyte is chosen so that no ordinary source file trips it and a
 * multi-megabyte accident -- a pasted dump, a captured log, a vendored blob
 * committed as text -- does. Callers with a stricter policy state their own.
 */
export const DEFAULT_LARGE_BYTES = 1024 * 1024;

// Filename shapes that carry a secret in this repository's own experience
// (tensho §3's table, verbatim): `.env`, `*.pem`, `*.key`, `credentials*`. This
// is a FILENAME check only -- it does not read file content, which is
// deliberate: content scanning is a different, heavier tool, and this check's
// whole value is that it is cheap enough to run on every file every time.
const SECRET_SHAPE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|credentials.*)$/i;

const BINARY_EXTENSION = /\.(png|jpe?g|gif|webp|ico|pdf|zip|tar|gz|7z|exe|dll|so|dylib|bin|woff2?|ttf|otf)$/i;

// A LOCAL-CONFIG FILENAME: the `.local` infix a dozen tools agree means "this
// machine's copy, not the project's" -- `settings.local.json`, `.env.local`,
// `config.local.yml`, a bare `foo.local`.
//
// zheref/nen#57: two consuming skills independently kept this as a by-eye check
// on top of this verb's five detectors, which is the shape of a gap rather than
// a preference. A local-config file is not a secret and often is not ignored;
// it is simply somebody's own settings, and committing it hands every other
// contributor a machine they are not sitting at.
//
// A FILENAME CHECK ONLY, exactly like the secret shape above and for the same
// reason: it is cheap enough to run on every file every time, which is the whole
// value of running it at all. It is deliberately NOT a directory rule --
// `.claude/`, `.vscode/` and their neighbours hold committed project
// configuration as often as personal settings, and flagging every file in them
// would bury the rows that need a decision under the ones that do not, which is
// the defect zheref/nen#169's `ignored` bucket exists to undo.
const LOCAL_CONFIG_SHAPE = /(^|\/)[^/]*\.local(\.[^/]*)?$/i;

export function triageStage(entries: readonly StatusEntry[], options: TriageOptions = {}): TriageResult {
  const scopePrefixes = options.scopePrefixes ?? [];
  const mentioned = (options.mentionedText ?? "").toLowerCase();
  const binaryPaths = options.binaryPaths ?? new Set<string>();
  const sizes = options.sizes ?? new Map<string, number>();
  const largeBytes = options.largeBytes ?? DEFAULT_LARGE_BYTES;

  const clean: string[] = [];
  const flagged: FlaggedFile[] = [];
  const ignored: FlaggedFile[] = [];

  for (const entry of entries) {
    const reasons: FlagReason[] = [];
    const isDeletion = entry.indexStatus === "D" || entry.worktreeStatus === "D";

    if (entry.ignored) reasons.push("ignored");
    if (SECRET_SHAPE.test(entry.path)) reasons.push("secret-shape");
    if (binaryPaths.has(entry.path) || BINARY_EXTENSION.test(entry.path)) reasons.push("binary");
    if (scopePrefixes.length > 0 && !scopePrefixes.some((prefix): boolean => entry.path.startsWith(prefix))) {
      reasons.push("out-of-scope");
    }
    if (isDeletion) {
      const basename = entry.path.split("/").at(-1) ?? entry.path;
      if (!mentioned.includes(basename.toLowerCase())) reasons.push("unmentioned-deletion");
    }
    if (LOCAL_CONFIG_SHAPE.test(entry.path)) reasons.push("local-config");
    // MEASURED OR NOT FLAGGED. An unmeasured path -- a deletion, a file the
    // caller chose not to stat -- carries no size claim at all, because "could
    // not be measured" rendering as "measured and small" is the one reading
    // this must never produce.
    const size = sizes.get(entry.path);
    if (size !== undefined && size >= largeBytes) reasons.push("large");

    // An ignored path is routed here FIRST, ahead of the empty-reasons check
    // below -- `entry.ignored` always pushed "ignored" above, so this branch
    // can never see an empty `reasons` array. It never falls through to
    // `flagged`, whatever else it also matched (zheref/nen#169).
    if (entry.ignored) ignored.push({ path: entry.path, reasons });
    else if (reasons.length === 0) clean.push(entry.path);
    else flagged.push({ path: entry.path, reasons });
  }

  return { clean, flagged, ignored };
}
