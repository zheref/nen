// src/runner/shellword.ts -- one argv element as a POSIX shell would need it
// to be pasted back, for the command lines the runner family PRINTS as hints
// (`would run:`, `then:`, the inventory and verify relabel lines).
//
// PRINTED, NEVER EXECUTED. The argv nen hands `gh` is not parsed by a shell
// and is never quoted; this is only for the line a human copies. A runner name
// or a pool id is data somebody chose, and `labels[]=x` is a glob a shell may
// expand, so anything outside a conservative word is single-quoted. Callers
// strip control characters (../cli/plain.ts) first: quoting makes a word
// paste safely, not print safely.

/** `word` as one shell word: bare when it is plainly safe, single-quoted otherwise. */
export function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}
