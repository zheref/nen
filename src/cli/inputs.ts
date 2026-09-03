// src/cli/inputs.ts -- the three ways a verb is handed a list of paths, a blob
// of text, or a JSON document, written once.
//
// WHY IT IS SHARED. Four verbs take "the set of files this change touches" --
// gate derivation, the changelog-fragment rule, the fan-out intersection, and
// the pull-request body check -- and the shell scripts they are ported from each
// took it differently (a file of newline-separated paths, a `git diff` invoked
// inline, a shell array). Three spellings of the same input is three places a
// trailing carriage return, an empty last line, or a `git` that was not run from
// the right directory each has to be handled again.
//
// LINE ENDINGS ARE NORMALIZED HERE. The repository is `* text=auto`, the
// maintainer's host is Windows/Git Bash, and a changed-file list read from a
// file there arrives with `\r\n`. A path carrying a trailing `\r` matches no
// pattern and belongs to no path set, so the gate silently derives the PERMISSIVE
// answer on exactly one platform. That failure mode has a name in this
// repository already -- src/taxonomy-purity.test.ts's own header records it --
// and it is why the seam normalizes and why this does too.

import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { VerbUsageError, type CommandContext } from "./command.js";
import { GIT, must, normalizeEol, outputLines } from "../seam/exec.js";

/**
 * The rationale half of the refusal below, for the verbs this module was written
 * for: the ones that read a CHANGED-FILE SET and answer a question about it.
 *
 * It is the default rather than the only text because the sentence is a claim
 * about the caller's verb, not about the filesystem. A verb that reads no set
 * and renders no verdict -- `nen issue comment --body-file`, whose file IS the
 * payload -- would be told that its empty fallback "would report a clean verdict
 * for a check it never ran", which describes nothing it does. The actionable
 * half (the RESOLVED path and the errno) is the same for everyone and is never
 * overridable; only the why is.
 */
const CHANGED_SET_RATIONALE =
  "A verb that fell back to an empty input here would report a clean verdict for a check it never ran.";

/**
 * Read a file with its line endings normalized.
 *
 * `-` IS NOT STDIN HERE, and never was: it resolves as a path literally named
 * `-` and refuses like any other missing file. This docblock used to end "`-`
 * reads stdin", which was a claim about behaviour this function has no code
 * for, and rewriting the docblock is not the place to delete a false sentence
 * in silence -- the family-visible consequence outlives the wording. It is why
 * changedFilesUsage() below tells callers of --files-from that `-` is not
 * accepted, and the reason it gives is the real one: a verb reading a set from
 * stdin cannot also report which set it read.
 *
 * `why` replaces the rationale clause of the refusal for a caller whose input is
 * not a changed-file set -- see CHANGED_SET_RATIONALE above.
 *
 * `raw`, WHEN TRUE, SKIPS THE NORMALIZATION -- ROUND THREE, MINOR 2. The
 * normalization exists for the CHANGED-FILE-SET readers this module was built
 * for (see the file header): a `\r` left on a path matches no pattern, so
 * stripping it is correct there. `nen issue comment --body-file` is not one of
 * those readers -- the file IS the payload, not a list to match patterns
 * against -- and it has its OWN reason to skip this: `--dry-run`'s whole
 * promise is "the bytes printed are the bytes that would be sent", and `gh` is
 * always handed the ORIGINAL path, never a copy this process rewrote. A CRLF
 * `--body-file` used to break that promise in one specific way -- the
 * transcript and `--json`'s `body` field showed `\n`-normalized bytes while
 * `gh` read the untouched `\r\n` file from disk, so what the caller approved
 * and what got posted were never quite the same bytes. Rather than make `gh`
 * read normalized bytes too (which would mean writing the caller's file back
 * out through this process, a second write this verb has no other reason to
 * perform), the read here is left exactly as it is on disk, so both sides
 * already agree without either one moving.
 */
export function readTextFile(
  path: string,
  cwd: string,
  why: string = CHANGED_SET_RATIONALE,
  raw: boolean = false,
): string {
  const full = isAbsolute(path) ? path : resolvePath(cwd, path);
  try {
    const text = readFileSync(full, "utf8");
    return raw ? text : normalizeEol(text);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new VerbUsageError(
      `could not read '${full}'${code === undefined ? "" : ` (${code})`}. ${why}`,
    );
  }
}

/** `a,b,c` -> `["a","b","c"]`, dropping empties. */
export function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item): string => item.trim())
    .filter((item): boolean => item !== "");
}

export interface ChangedFilesFlags {
  /** `--files a,b,c` */
  readonly files: string;
  /** `--files-from <path>`: one path per line. */
  readonly filesFrom: string;
  /** `--range <a>..<b>`: computed with `git diff --name-only`. */
  readonly range: string;
}

export const CHANGED_FILE_FLAGS: ChangedFilesFlags = {
  files: "files",
  filesFrom: "files-from",
  range: "range",
};

export function changedFilesUsage(): string {
  return `  --files <a,b,c>       The changed paths, comma-separated.
  --files-from <path>   A file with one changed path per line ('-' is not
                        accepted: a verb reading a set from stdin cannot also
                        be told which set it read).
  --range <a>..<b>      Compute the set with 'git diff --name-only <range>'.`;
}

/**
 * The changed-file set, from whichever of the three flags was given.
 *
 * EXACTLY ONE, and an absent set is an ERROR rather than an empty one. Every
 * verb that takes this set derives the PERMISSIVE answer from an empty one -- no
 * gate, no fragment owed, no consumer affected -- so a caller who forgot the flag
 * would be told the thing they were checking for is not there.
 */
export function changedFiles(context: CommandContext, gitCwd: string): readonly string[] {
  const inline = context.args.values[CHANGED_FILE_FLAGS.files];
  const from = context.args.values[CHANGED_FILE_FLAGS.filesFrom];
  const range = context.args.values[CHANGED_FILE_FLAGS.range];
  const given = [inline, from, range].filter((value): boolean => value !== undefined);

  if (given.length === 0) {
    throw new VerbUsageError(
      `the changed-file set is required: give --${CHANGED_FILE_FLAGS.files}, --${CHANGED_FILE_FLAGS.filesFrom} or --${CHANGED_FILE_FLAGS.range}. An empty set is the permissive answer for every verb that reads one, so it is never assumed.`,
    );
  }
  if (given.length > 1) {
    throw new VerbUsageError(
      `--${CHANGED_FILE_FLAGS.files}, --${CHANGED_FILE_FLAGS.filesFrom} and --${CHANGED_FILE_FLAGS.range} are three spellings of ONE input; give exactly one, so the answer names the set it was computed from.`,
    );
  }

  if (inline !== undefined) return splitList(inline);
  if (from !== undefined) {
    return outputLines(readTextFile(from, gitCwd));
  }
  const result = must(context.seams, GIT, ["diff", "--name-only", range ?? ""], { cwd: gitCwd });
  return outputLines(result.stdout);
}

/**
 * Parse a JSON document from a file, with a message that names the file.
 *
 * `why` is handed straight to readTextFile above, so a caller whose JSON is not
 * a changed-file set gets its own rationale on the unreadable-file refusal too.
 */
export function readJsonFile<T>(path: string, cwd: string, why?: string): T {
  const text = readTextFile(path, cwd, why);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new VerbUsageError(
      `'${path}' is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}
