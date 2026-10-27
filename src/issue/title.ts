// src/issue/title.ts -- `--title-file <path>`, the file-fed title of `nen issue
// file` and `nen idea file` (zheref/nen#444).
//
// WHY A FILE. A title the maintainer typed is the maintainer's words, and a
// command line is shell source: a backtick or `$(...)` in it runs before nen
// ever sees the value. A file read here is bytes, never code, so a caller that
// writes the words to a file first has nothing left for a shell to expand.
//
// VERBATIM, ONE TRAILING NEWLINE STRIPPED. An editor, `printf '%s\n'` and a
// heredoc all end the file with one newline that is not part of the title, so
// exactly one `\n` (or `\r\n`) is dropped, with a leading byte-order mark
// (an encoding mark, not a character). Nothing else is trimmed: a leading
// space or a second trailing newline is the caller's byte, and a title with a
// line break left in it is refused rather than flattened, because GitHub would
// store a different title than the one in the file.

import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { readVerbatimTextFile, resolveAgainstRepo } from "../cli/inputs.js";

/**
 * The title read from `--title-file`, or `undefined` when the flag was not
 * given. Refuses (exit 2) `--title` and `--title-file` together, an unreadable
 * file, and a title that still holds a line break once its one trailing
 * newline is stripped.
 */
export function readTitleFile(
  context: CommandContext,
  root: string,
  why: string = "--title-file names the title this verb files, read verbatim so no shell ever expands it.",
): string | undefined {
  const path = context.args.values["title-file"];
  if (path === undefined) return undefined;
  if (context.args.values["title"] !== undefined) {
    throw new VerbUsageError("--title and --title-file are two spellings of ONE input; give exactly one, so the report names where the title came from.");
  }
  if (path === "") throw new VerbUsageError("--title-file needs a path.");
  const raw = readVerbatimTextFile(
    resolveAgainstRepo(root, path),
    process.cwd(),
    why,
    true,
  );
  // A leading BOM is the file's encoding mark, never a character of the title.
  const title = raw.replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
  if (/[\r\n]/.test(title)) {
    throw new VerbUsageError(
      `--title-file '${path}' holds more than one line; a title is one line, and nen will not join or cut the lines into one.`,
    );
  }
  return title;
}
