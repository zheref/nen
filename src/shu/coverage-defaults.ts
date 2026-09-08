// src/shu/coverage-defaults.ts -- the CATALOGUE half of `nen shu coverage`: one
// advisory sentence per stack about where that stack's tooling conventionally
// writes a coverage report.
//
// WHY THIS IS ITS OWN MODULE, AND WHY IT IS NOT ./coverage.ts. That module
// imports ./run.ts, which imports the subprocess seam; this one imports the
// reference profiles pack. ../profiles/inertness.test.ts fails the build if
// those two ever meet in one import graph, and the rule is the point rather than
// the inconvenience: the pack is a catalogue nen quotes, never an authority nen
// acts on. Keeping the two halves apart is what makes "nen never opens a path
// the pack named" a property of the program instead of a promise in a header.
//
// WHAT CROSSES, AND IN WHICH DIRECTION. One STRING, out of here, into a refusal
// message. Nothing here reaches an argv, a spawn or a file open: the path this
// module returns is printed and never resolved, and `nen shu coverage` parses
// only a report the DECLARATION named under the verb's `artifacts`. That is the
// same narrowing ./tools.ts already has for its advisory `packMinimum` column,
// argued once in ../profiles/inertness.test.ts's allowlist and not again here.
//
// ../shu/command.ts IS THE JOIN, as it is for `tools`: it imports this module
// and the executing one, imports no seam itself, and hands the advisory across
// as a value. There is no parameter anywhere in ./coverage.ts through which a
// catalogue value could become a path that is opened.
//
// THE SENTENCE IS NOT WRITTEN HERE, and that split is load-bearing rather than
// tidy. `advisoryFor` formats a refusal out of values it is handed and reads
// nothing, so it lives in ./coverage/advisory.ts, where the module that CAN
// spawn may import it. If it lived in this file, ./coverage.ts would have to
// import this file to print a sentence -- and would thereby reach the pack,
// which is the offence ../profiles/inertness.test.ts exists to fail the build
// on. One module reads the catalogue; another writes the English.

import { loadProfilesPack, type ProfilesPack } from "../profiles/pack.js";
import type { CoverageAdvisory } from "./coverage/advisory.js";

export type { CoverageAdvisory };

/**
 * The advisory for every stack the pack carries, by stack id.
 *
 * A MAP RATHER THAN A LOOKUP BY STACK. The caller knows the lane's stack only
 * after the declaration is open, and passing a stack id INTO this module would
 * be the first parameter through which the catalogue could learn something
 * about the target repository. It returns everything it has; the seam side
 * picks the row it needs.
 */
export function coverageAdvisories(pack: ProfilesPack = loadProfilesPack()): Readonly<
  Record<string, CoverageAdvisory>
> {
  const out: Record<string, CoverageAdvisory> = {};
  for (const id of pack.ids) {
    const profile = pack.profiles[id];
    if (profile === undefined) continue;
    out[id] = {
      path: profile.reportDefault.path,
      why: profile.reportDefault.why,
      source: profile.reportDefault.source,
    };
  }
  return out;
}
