// src/cli/plain.ts -- one helper, for the one place text nen did not write
// reaches a terminal.
//
// WHY THIS EXISTS (Feitan F4). A pull request's title, a review thread's path
// and author, a check name, the first 200 characters of somebody's comment --
// every one of those is a string GitHub stores because somebody typed it, and
// several verbs print them straight to stdout. A terminal does not read a
// string; it EXECUTES one. `ESC[2K` erases the line the reader was about to
// read, `ESC[1A` moves the cursor back over what nen already printed, and a
// carriage return rewrites a line in place -- so a title somebody chose can
// hide the row beneath it, overwrite a verdict, or make a register print
// something no field in it says. It is not hypothetical: `ESC[2K` in a PR title
// was reproduced erasing a rendered row.
//
// IT STRIPS AT THE HUMAN RENDER SEAM ONLY, AND `--json` KEEPS THE BYTES. Those
// are two different consumers with two different needs. A human reading a
// terminal needs text that cannot move the cursor; a program reading `--json`
// needs the field GitHub actually holds, because it may be about to compare it,
// store it, or send it back -- and a CLI that silently altered the data in its
// machine-readable contract would be lying to the consumer least able to
// notice. `JSON.stringify` already escapes a control character into ``,
// which is inert in every JSON reader, so the machine half needs nothing.
//
// IT STRIPS RATHER THAN ESCAPES. A visible `[2K` in the middle of a title
// is noise in a column a human is scanning; the information a reader wants from
// a control character is that it was there, and nothing in these renderings is
// the place to say so. Replaced by nothing, so the surrounding text closes up.
//
// WHAT IT DELIBERATELY KEEPS: nothing. The ranges are C0 (U+0000-U+001F)
// including ESC, CR and LF, DEL (U+007F), and C1 (U+0080-U+009F), which carries
// a second, less-known escape introducer. A NEWLINE IS A CONTROL CHARACTER HERE
// TOO, and that is intended: these renderings are one row per line, and a
// two-line field is a row that has broken its own table. A caller who wants a
// newline kept is rendering a block, not a row, and should not come through
// here.

/** Every character a terminal reads as an instruction rather than as text. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * One line of text nen did not write, made safe to print.
 *
 * Every verb that prints a GitHub-controlled string in its HUMAN rendering
 * calls this; the `--json` document carries the original bytes.
 */
export function plainLine(text: string): string {
  return text.replace(CONTROL, "");
}

/**
 * Every control character EXCEPT the two a block of text is made of: a
 * newline (U+000A) and a tab (U+0009). CR goes too -- it rewrites a line in
 * place, which is the whole complaint.
 */
const CONTROL_IN_BLOCK = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * A BLOCK of text nen did not write -- a conflict hunk, a diff -- made safe
 * to print: `plainLine`'s sibling that keeps the newlines and tabs the block's
 * shape is made of and strips every other C0, C1 and DEL byte. The `--json`
 * document carries the original bytes, as with `plainLine`.
 */
export function plainBlock(text: string): string {
  return text.replace(CONTROL_IN_BLOCK, "");
}
