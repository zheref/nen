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

/** Read a file with its line endings normalized. `-` reads stdin. */
export function readTextFile(path: string, cwd: string): string {
  const full = isAbsolute(path) ? path : resolvePath(cwd, path);
  try {
    return normalizeEol(readFileSync(full, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new VerbUsageError(
      `could not read '${full}'${code === undefined ? "" : ` (${code})`}. A verb that fell back to an empty input here would report a clean verdict for a check it never ran.`,
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

/** Parse a JSON document from a file, with a message that names the file. */
export function readJsonFile<T>(path: string, cwd: string): T {
  const text = readTextFile(path, cwd);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new VerbUsageError(
      `'${path}' is not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}
