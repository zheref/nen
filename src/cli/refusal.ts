// src/cli/refusal.ts -- a refusal under `--json` is a JSON document, not a
// sentence (Hatsu SDD plan N5, finding B3).
//
// WHY. `issue file`, `idea file`, `canon resolve` and `commit format` used to
// print `nen: <reason>` lines even under `--json`: only the success path was
// machine-shaped. Those are the filing step of every intake and the commit
// step of every kokusen, so an unattended caller wrapping them met exit 1 and
// an unparseable line on the one path where it most needs to branch -- and
// reading the sentence is where a caller starts guessing ("probably a label
// race, retry"). Under `--json` these verbs now print one envelope on stdout,
// and print nothing on stderr; without `--json` the prose is unchanged.
//
// THE CODE IN THE ENVELOPE IS THE EXIT CODE, so a caller that parsed the
// document never needs a second source to know which kind of refusal it got
// (`nen exits <family> <verb>` says what a code above 2 means there).

import type { Io } from "../index.js";

export const REFUSAL_CONTRACT = "nen.refusal/v0.1";

export interface RefusalEnvelope {
  readonly contract: typeof REFUSAL_CONTRACT;
  readonly ok: false;
  /** `<family> <verb>`, as typed after `nen `. */
  readonly verb: string;
  /** The process exit code this refusal returns. */
  readonly code: number;
  /** Every reason, in the order the verb found them; never empty. */
  readonly refused: readonly string[];
}

export function refusalEnvelope(verb: string, code: number, reasons: readonly string[]): RefusalEnvelope {
  return { contract: REFUSAL_CONTRACT, ok: false, verb, code, refused: reasons.length === 0 ? ["refused"] : [...reasons] };
}

/**
 * Refuse with `code`: the envelope on stdout under `--json`, else one
 * `nen: <reason>` line per reason on stderr. Returns `code`, so a verb writes
 * `return refuse(...)`.
 */
export function refuse(io: Io, json: boolean, verb: string, code: number, reasons: readonly string[]): number {
  if (json) {
    io.out(JSON.stringify(refusalEnvelope(verb, code, reasons), null, 2));
    return code;
  }
  for (const reason of reasons) io.err(`nen: ${reason}`);
  return code;
}
