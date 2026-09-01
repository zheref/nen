// src/seam/lines.ts -- a RAW line splitter, alongside ./exec.ts's outputLines().
//
// outputLines() TRIMS every line, which is right for the thing it exists for --
// turning a subprocess's stderr into a human-readable message. It is WRONG for
// output whose exact columns are the data: `git status --porcelain=v1`'s
// leading two-character status code plus a space (readWorkingCopyState in
// ../wc/classify.ts reads it with `line.slice(3)`, which a pre-trimmed line
// would misalign), an ordered `git log --format=%s` subject list, a `gh api
// -q '.[].name'` name list. Collapsing this into outputLines() would be
// exactly the "simplify it back into the bug" failure this repository's own
// header comments warn against -- so it stays a second, deliberately
// different-shaped helper rather than a leftover duplicate.
import { normalizeEol } from "./exec.js";

export function rawLines(text: string): string[] {
  return normalizeEol(text)
    .split("\n")
    .filter((line): boolean => line !== "");
}
