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
// The '-a,b +c,d' ranges inside a hunk header. A count git omits (the
// '@@ -3 +3 @@' single-line form) means 1, per the unified-diff format --
// these counts are what terminate a hunk's body exactly (see below), so they
// are read here rather than trusted to "whatever precedes the next header".
const HUNK_COUNTS = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

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
      // TERMINATE THE BODY EXACTLY WHERE THE HEADER'S OWN COUNTS SAY IT ENDS,
      // never at "whatever comes before the next header". The greedy
      // alternative swallowed the phantom '' that String.split leaves after a
      // text's trailing newline into whichever hunk happened to be LAST in
      // its own diff text -- so a hunk that is last in a one-file branch diff
      // but NOT last in the multi-file original compared `body + ""` against
      // `body` and reported a false ALTERED on a byte-identical split
      // (issue #21). The counts are the format's own statement of where the
      // hunk stops; anything after them belongs to the next section, not here.
      const counts = HUNK_COUNTS.exec(hunkLine);
      // A header HUNK_HEADER accepted but whose ranges are unreadable gets
      // the old boundary-based capture (Infinity never exhausts) rather than
      // an empty body -- degrading to greedy is strictly safer than dropping
      // lines from a hunk whose identity IS its full text.
      let oldRemaining = counts === null ? Infinity : Number(counts[1] ?? "1");
      let newRemaining = counts === null ? Infinity : Number(counts[2] ?? "1");
      const body: string[] = [hunkLine];
      index += 1;
      while (index < lines.length) {
        const bodyLine = lines[index];
        if (bodyLine === undefined || HUNK_HEADER.test(bodyLine) || FILE_HEADER.test(bodyLine)) break;
        if (bodyLine.startsWith("\\")) {
          // '\ No newline at end of file' annotates the line ABOVE it and
          // counts toward neither side -- but it IS part of the hunk's
          // identity (checked before the exhaustion break below, since it can
          // trail the final '+' line): a change that also strips the trailing
          // newline is not the same change without it.
          body.push(bodyLine);
          index += 1;
          continue;
        }
        if (oldRemaining <= 0 && newRemaining <= 0) break;
        const marker = bodyLine[0];
        if (marker === " ") {
          // A context line counts toward both sides. A BLANK context line is
          // ' ' (one space) in a unified diff, never '' -- so '' is
          // deliberately NOT accepted here even while the counts owe lines:
          // the only '' this parser ever meets is the split-artifact of a
          // trailing newline (or a blank separator between sections), and
          // admitting it into a count-underrun hunk's body would be #21's
          // phantom line readmitted through the malformed-input door.
          oldRemaining -= 1;
          newRemaining -= 1;
        } else if (marker === "-") {
          oldRemaining -= 1;
        } else if (marker === "+") {
          newRemaining -= 1;
        } else {
          // Not a hunk-body line at all ('' included -- see above), yet the
          // counts promised more: malformed input. Stop at the malformation
          // rather than swallow arbitrary text into the hunk's identity.
          break;
        }
        body.push(bodyLine);
        index += 1;
      }
      hunks.push({ header: hunkLine, text: body.join("\n") });
    }

    files.push({ path, preamble, hunks });
  }

  return files;
}
