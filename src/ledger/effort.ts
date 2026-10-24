// src/ledger/effort.ts -- the ONE effort-id grammar every per-effort ledger
// admits, and the one encoder that turns an id into a file name
// (zheref/nen#509, with #511 folded in).
//
// WHY ONE. The phase and usage ledgers each declared their own EFFORT_ID,
// equal by accident; the direct record refused only a traversal; the stop
// answer ledger refused only a traversal too. One effort's id was therefore
// valid in one ledger and refused by the next, and a resume that keyed every
// ledger by the same id could find half of its history. Every ledger imports
// the grammar from here now: phase, usage, session, the direct record, the
// stop-answer records, the run manifest's --effort and `nen shu --effort`.
//
// THE ALPHABET. Letters, digits, '.', '_', '-', '/', '#' and ':', starting
// with a letter or digit, no path segment that is '.' or '..', and no leading
// `<letter>:` (a Windows drive path). '#' and ':'
// are admitted because two ids every Hatsu record already keys on carry them:
// `<CODE>-IS-#<N>` (the direct record and the futon run record) and
// `inline-<ISO-8601 UTC>` (a textual effort). A space, a backslash, a NUL, a
// leading '.' or '/' and every other character are refused, at exit 2, with
// the one message `effortIdRefusal` composes -- the same text from every verb.
//
// THE ENCODER. `encodeURIComponent` is INJECTIVE on this alphabet: '/' ->
// '%2F', '#' -> '%23', ':' -> '%3A', every other admitted character kept. No
// two ids share a file and no id opens a subdirectory (a '/' -> '-'
// substitution was not injective: 'HA/85' and 'HA-85' once shared a ledger,
// Copilot review on zheref/nen#217).

import { VerbUsageError } from "../cli/command.js";

/** The one grammar. `git grep -n 'EFFORT_ID = /' src` prints this line alone (#509 AC-1). */
export const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9._/#:-]*$/;

/** Why `id` is not an effort id, or null when it is one. */
export function effortIdProblem(id: string): string | null {
  if (id === "") return "it is empty";
  if (!EFFORT_ID.test(id)) return "an effort id is letters, digits, '.', '_', '-', '/', '#' and ':', starting with a letter or digit";
  if (/^[A-Za-z]:/.test(id)) return "it reads as a Windows drive path";
  if (id.split("/").some((segment): boolean => segment === "." || segment === "..")) return "a '/' segment is '.' or '..'";
  return null;
}

/** True when `id` is an effort id under the one grammar. */
export function isEffortId(id: string): boolean {
  return effortIdProblem(id) === null;
}

/** The one refusal text, identical from every verb that takes an effort id (#509 AC-2). */
export function effortIdRefusal(id: string, problem: string): string {
  return `effort id '${id}' is refused: ${problem}. One grammar holds for every nen ledger (docs/USAGE.md § Effort ids).`;
}

/** The id, or a usage refusal (exit 2) in the one text. */
export function assertEffortId(id: string): string {
  const problem = effortIdProblem(id);
  if (problem !== null) throw new VerbUsageError(effortIdRefusal(id, problem));
  return id;
}

/** The ONE encoder of an effort id into a ledger file name. */
export function encodeEffortId(effort: string): string {
  return encodeURIComponent(effort);
}
