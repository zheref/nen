// src/gate/derive.ts -- the gate a pull request's DIFF derives, from the changed
// file set against two path sets.
//
// PORTED FROM backlog-state §4's decision tree and drive §2's flat restatement
// of the same rule. drive §2, verbatim:
//
//   diff touches CONSTITUTION.md, handbooks/, agents/, or schemas/   -> G4  (policy/spec)
//   diff touches the process surface
//       (.github/workflows/, claude/, scripts/, tests/, docs/)       -> G4  (this repo's product IS its process)
//   otherwise                                                        -> G2  (product code)
//
// THE PATH SETS ARE ARGUMENTS, NOT CONSTANTS, and that is the one deviation in
// this port worth reading before using the verb. The sets above are bankai-core's
// canon, not a universal truth -- drive §2 says so itself: "In bankai-core almost
// everything is G4; in [the consumer repos] almost everything is G2. Do not carry
// one repo's ratio into the other." A binary that shipped one repository's path
// sets would derive that repository's gates for every repository it was pointed
// at, which is the same defect §3 names for labels and personas wearing different
// clothes. So both sets are supplied per invocation and there is NO default: an
// absent set is an error naming the flag, never an empty set that quietly derives
// G2 for everything.
//
// THE DERIVATION IS ONLY REACHABLE FOR A READY PULL REQUEST. backlog-state §4 is
// a tree, and this is its right-hand branch: "is it CON-32-Ready? YES -> does the
// diff touch..." A pull request that is NOT ready has NO GATE -- it is in
// progress and owned by its author -- and reporting G2/G4 for one would put work
// nobody is waiting on into the maintainer's queue, which is precisely the
// failure backlog-state §4's "G5 is not the default bucket" section was written
// about. This module therefore reports the gate the DIFF derives and says, in
// the same breath, that readiness is a separate question decided elsewhere; the
// caller composes the two.
//
// BOTH SETS YIELD G4, so the order between them is informative rather than
// decisive -- but they are reported separately because the REASON differs, and
// drive §2 requires the correction to be stated in one line when a caller
// asserted a different gate.

/** The two sets, and the gate a miss on both derives. */
export interface PathSets {
  /** Policy/spec paths. A hit is G4 because only the human merges policy. */
  readonly policy: readonly string[];
  /** Process-surface paths. A hit is G4 because the process IS the product here. */
  readonly process: readonly string[];
}

export type DerivedGate = "G2" | "G4";

export interface PathHit {
  readonly path: string;
  readonly pattern: string;
  readonly set: "policy" | "process";
}

export interface Derivation {
  readonly gate: DerivedGate;
  readonly changed: readonly string[];
  readonly hits: readonly PathHit[];
  /** One sentence naming why this gate, in the form drive §2 asks for. */
  readonly basis: string;
  /** The gate the caller asserted, when they asserted one. */
  readonly asserted: string | null;
  /** True when `asserted` and `gate` disagree -- the correction drive §2 requires. */
  readonly corrected: boolean;
  /**
   * Always present, always the same sentence: this derivation is the diff's
   * half of backlog-state §4 and says nothing about readiness.
   */
  readonly readinessNote: string;
}

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

const READINESS_NOTE =
  "This is the diff's half of the derivation only. A pull request that is not ready has NO GATE -- it is in progress and owned by its author -- so compose this with a readiness verdict before putting a row in anyone's queue.";

// Match a changed path against one pattern.
//
// THREE SPELLINGS, because the sources use all three and refusing any of them
// would refuse a correct set:
//   `CONSTITUTION.md`   an exact path
//   `handbooks/`        a directory prefix -- everything beneath it, any depth
//   `handbooks/*`       the shell's own spelling, where `*` CROSSES `/`
//
// The third is not a filesystem glob and must not be read as one. The source
// script says so in its own words: "Bash `[[ == glob ]]` matches `*` across `/`
// (no filename-globbing path semantics), so `handbooks/*` covers any depth under
// handbooks/, not just one level." Reading it with filesystem semantics would
// silently stop covering nested files -- the direction that loses a gate.
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === "") return false;
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (pattern.includes("*")) {
    const source = pattern
      .split("*")
      .map((part): string => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[\\s\\S]*");
    return new RegExp(`^${source}$`).test(path);
  }
  return path === pattern;
}

function hitsFor(
  changed: readonly string[],
  patterns: readonly string[],
  set: "policy" | "process",
): PathHit[] {
  const hits: PathHit[] = [];
  for (const path of changed) {
    for (const pattern of patterns) {
      if (matchesPattern(path, pattern)) hits.push({ path, pattern, set });
    }
  }
  return hits;
}

export function derive(
  changed: readonly string[],
  sets: PathSets,
  asserted: string | null = null,
): Derivation {
  if (sets.policy.length === 0 && sets.process.length === 0) {
    throw new GateError(
      "no path sets were given, so every diff would derive G2 -- including a policy change. The two sets are this repository's canon and nen carries no copy of them; state them explicitly.",
    );
  }

  const policyHits = hitsFor(changed, sets.policy, "policy");
  const processHits = hitsFor(changed, sets.process, "process");
  const hits = [...policyHits, ...processHits];
  const gate: DerivedGate = hits.length > 0 ? "G4" : "G2";

  const basis =
    policyHits.length > 0
      ? `G4: the diff touches policy/spec (${unique(policyHits).join(", ")}), which only the human merges.`
      : processHits.length > 0
        ? `G4: the diff touches the process surface (${unique(processHits).join(", ")}); in a repository whose product is its process, that is a policy change.`
        : `G2: the diff touches neither path set across ${changed.length} changed file${changed.length === 1 ? "" : "s"}, so it is product code.`;

  return {
    gate,
    changed,
    hits,
    basis,
    asserted,
    corrected: asserted !== null && asserted !== gate,
    readinessNote: READINESS_NOTE,
  };
}

function unique(hits: readonly PathHit[]): string[] {
  return [...new Set(hits.map((hit): string => hit.pattern))];
}
