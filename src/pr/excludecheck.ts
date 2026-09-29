// src/pr/excludecheck.ts -- `nen pr ready --exclude-check`'s argv grammar: how
// the values a caller typed become the EXACT check names CON-32(a) drops
// (zheref/nen#243). The matching itself -- exact, on the rollup entry's own
// label -- is ../gates/predicates.ts's `excludeCheckNames` and is unchanged;
// this module only decides what the names ARE.
//
// THE DEFECT. The flag took one comma-joined value and split it on every
// comma, so a check whose own name contains a comma could never be named. A
// GitHub Actions MATRIX job is exactly that: Actions names it `<job> (<v1>,
// <v2>, ...)`, and this repository's own CI reports `check (Windows,
// ["self-hosted","Windows","X64"])`. On zheref/nen#242 the maintainer ruled
// that job out of scope, and `--exclude-check 'check (Windows,
// ["self-hosted","Windows","X64"])'` split into four fragments, excluded none
// of them, and left the verdict `not-ready` on a job nobody had to run.
//
// THE GRAMMAR, AND WHY IT IS THIS ONE.
//
//   1. THE FLAG REPEATS (the argv reader's `lists`, ../cli/args.ts). Each
//      occurrence is read on its own; `--exclude-check a --exclude-check b`
//      names two checks. It used to be a usage error ("given more than once").
//   2. WITHIN ONE OCCURRENCE, A COMMA SEPARATES NAMES ONLY OUTSIDE BRACKETS.
//      `(`, `[` and `{` open a group, the matching closer ends it, and a comma
//      inside a group is part of the name. So `a,b` is still two names --
//      every value that held no bracketed comma splits exactly as it always
//      did, which is the backward-compatibility half of #243 -- and a matrix
//      name, whose every comma Actions writes INSIDE its trailing `( ... )`,
//      is one name.
//
// WHY BRACKETS AND NOT A QUOTING OR ESCAPING LANGUAGE. A comma that belongs
// to a check name has to be told apart from one that separates two names,
// and there were three deterministic ways to do it. (a) One name per
// occurrence, never split: the simplest, but it silently turns every existing
// `--exclude-check a,b` into ONE name `a,b` that matches nothing -- a
// behaviour change a caller would only discover as a surprise `not-ready`.
// (b) A quoting or escaping syntax (`"a,b"`, `a\,b`): a second quoting
// language layered on the shell's own, where a quote the caller typed is
// either part of the name (and then it no longer matches) or stripped (and
// then a name that really holds a quote needs yet another escape). (c)
// Bracket depth, chosen: it needs no new syntax at all, because the names
// that carry commas in practice already carry the brackets that enclose
// them. What it cannot express is stated rather than papered over -- see 3.
//
//   3. WHAT STAYS UNNAMABLE, AND THE REFUSAL. A name with a comma OUTSIDE any
//      bracket (`lint, format`) still splits; no Actions matrix name is
//      shaped that way, and zheref/nen#249's declared exclusion in
//      nen/gates.json is where a pattern belongs. And an opener that is
//      NEVER CLOSED with a comma after it (`lint (,build`) is REFUSED, exit 2:
//      that value has two honest readings -- the old one (`lint (` and
//      `build`) and the bracket one (a single name) -- and nothing in it says
//      which the caller meant. Guessing would change which check is dropped,
//      and a check dropped by mistake is a false `ready`. The remedy is the
//      repeat: one name per occurrence. An unclosed opener with NO comma
//      after it (`lint (`) is not ambiguous -- both readings agree -- and is
//      kept as typed. A closer with no matching opener is an ordinary
//      character.
//
// Names are trimmed and empty ones dropped, exactly as before (an unset shell
// variable passed as `--exclude-check "$VAR"` excludes nothing, which is the
// conservative direction: more checks count, never fewer). Repeats are folded
// to the first occurrence, so a name typed twice is excluded, reported and
// warned about once.

export class ExcludeCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExcludeCheckError";
  }
}

const CLOSER_FOR: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS: ReadonlySet<string> = new Set(Object.values(CLOSER_FOR));

/**
 * One `--exclude-check` occurrence, split into check names on the commas
 * that sit OUTSIDE every bracket group. See this module's header for the
 * grammar and why; throws `ExcludeCheckError` on the one ambiguous shape (an
 * unclosed opener with a comma after it).
 */
export function splitCheckNames(raw: string): string[] {
  const pieces: string[] = [];
  // A TYPED STACK, not a depth counter: `(` is closed by `)` and nothing
  // else, so `check (a]` does not pretend its paren was closed. A closer that
  // does not match the innermost open group is an ordinary character.
  const open: { readonly closer: string; readonly index: number }[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    const char = raw.charAt(index);
    const closer = CLOSER_FOR[char];
    if (closer !== undefined) {
      open.push({ closer, index });
      continue;
    }
    if (CLOSERS.has(char)) {
      if (open.length > 0 && open[open.length - 1]?.closer === char) open.pop();
      continue;
    }
    if (char === "," && open.length === 0) {
      pieces.push(raw.slice(start, index));
      start = index + 1;
    }
  }
  // Every comma after the OUTERMOST still-open group was read inside it; if
  // there is one, the bracket reading and the plain comma reading disagree.
  const unclosed = open[0];
  if (unclosed !== undefined && raw.indexOf(",", unclosed.index) !== -1) {
    const opener = raw.charAt(unclosed.index);
    throw new ExcludeCheckError(
      `--exclude-check '${raw}' opens a '${opener}' at character ${unclosed.index + 1} that is never closed, with a comma after it -- so it has two readings (that comma separates two check names, or belongs to one) and nothing in the value says which. Give each check its own --exclude-check occurrence. A check whose own name holds an unclosed bracket AND a comma after it cannot be named by this flag.`,
    );
  }
  pieces.push(raw.slice(start));
  return pieces.map((name): string => name.trim()).filter((name): boolean => name !== "");
}

/**
 * Every `--exclude-check` occurrence, in argv order, as the list of check
 * names to drop: each occurrence split by `splitCheckNames`, repeats folded to
 * their first appearance. `[]` when the flag was never given.
 */
export function parseExcludeCheckNames(occurrences: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const occurrence of occurrences) {
    for (const name of splitCheckNames(occurrence)) {
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}
