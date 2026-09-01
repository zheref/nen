// src/split/diff.ts -- a minimal unified-diff parser, down to the HUNK, for
// ../split/verify.ts's completeness proof. It parses; it never applies,
// generates or judges a diff -- see verify.ts for the comparison this exists
// to serve.
//
// A HUNK IS THE ATOMIC UNIT, not a line and not a whole file. jujisho's rule is
// "if a hunk genuinely belongs to both axes, it goes on the LOWER one in the
// stack" -- i.e. a hunk is never split further and never duplicated across two
// branches. Comparing at hunk granularity is therefore the coarsest unit that
// can still catch the failure the skill names: "a leftover hunk is a silent
// bug... invisible in both PRs".
//
// IDENTITY IS THE HUNK'S EXACT TEXT, including its `@@ ... @@` header and every
// context/added/removed line beneath it, CRLF-normalized. Two hunks compare
// equal only when they are byte-for-byte the same change in the same file --
// deliberately strict, because a hunk that merely LOOKS similar (the same
// three-line context repeated elsewhere in the file) must never be silently
// treated as the one that moved.

export interface Hunk {
  /** The '@@ -a,b +c,d @@ ...' header line, verbatim. */
  readonly header: string;
  /** Every line of the hunk's body, including the header, joined -- the identity key. */
  readonly text: string;
}

export interface FileDiff {
  /** The 'b/' path jujisho's diffs always carry; the new path for a rename. */
  readonly path: string;
  /** Everything before the first hunk: `diff --git`, mode/index lines, `---`/`+++`. */
  readonly preamble: readonly string[];
  readonly hunks: readonly Hunk[];
}

const FILE_HEADER = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_HEADER = /^@@ .*@@/;

// CRLF normalized on the way in -- the same discipline every parser in this
// repository follows at the one point it reads a repo file (Windows CI checks
// out CRLF; a hunk's identity must not depend on which lane produced it).
export function parseDiff(text: string): readonly FileDiff[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const files: FileDiff[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const match = FILE_HEADER.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }
    const path = match[2] ?? match[1] ?? "";
    const preamble: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined || HUNK_HEADER.test(next) || FILE_HEADER.test(next)) break;
      preamble.push(next);
      index += 1;
    }

    const hunks: Hunk[] = [];
    while (index < lines.length) {
      const hunkLine = lines[index];
      if (hunkLine === undefined || !HUNK_HEADER.test(hunkLine)) break;
      const body: string[] = [hunkLine];
      index += 1;
      while (index < lines.length) {
        const bodyLine = lines[index];
        if (bodyLine === undefined || HUNK_HEADER.test(bodyLine) || FILE_HEADER.test(bodyLine)) break;
        body.push(bodyLine);
        index += 1;
      }
      hunks.push({ header: hunkLine, text: body.join("\n") });
    }

    files.push({ path, preamble, hunks });
  }

  return files;
}
