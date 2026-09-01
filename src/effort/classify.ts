// src/effort/classify.ts -- senkei §3's five-class effort taxonomy, mechanical
// half only.
//
// FIVE CLASSES, ONE OF THEM ("idle") ABOUT THE EPIC AND FOUR ABOUT A CHILD.
// "delivering" (a delivery PR open at G2), "building" (released, in progress),
// "stalled" (released with nothing ever opened), "queued" (G1-approved, not
// yet released) and "idle" (an integration branch alive under a CLOSED epic)
// are read off the object's own state -- issue state, its stage label(s), PR
// existence and shape, branch liveness. THE STAGE-LABEL FAMILY IS CALLER DATA
// (../issue/chain.ts's role-map discipline again): this module knows nothing
// named 'bankai:stage/building'; it is handed whichever labels the caller
// already resolved to mean "released" or "in review".
//
// A SECOND, CROSS-CUTTING CHECK RUNS FIRST AND WINS: two stage labels on one
// object AT ONCE is a state-machine violation the skill names explicitly --
// "flag it, don't guess which one is authoritative". A caller that handed two
// stage-family labels gets that answer before any of the five classes are
// even considered, because guessing between them is exactly the judgment this
// module refuses to make.
//
// "STALLED" HAS A HALF THIS MODULE CANNOT SEE. The skill's own examples --
// a reviewer job that died mid-run leaving a stale CHANGES_REQUESTED, a
// builder that burned its turn cap and pushed nothing -- are live-signal
// judgments read off a PR's actual history, not a fact this pure function is
// handed. `reviewerVerdictMissing` is the one piece of that live evidence a
// caller MAY supply; without it, "stalled" is still reachable through the
// mechanical rule (released, no branch, no PR), which is the "mechanical
// half" issue #4's own scope line names.

export type EffortClass = "delivering" | "building" | "stalled" | "queued" | "idle" | "state-machine-violation" | "undecidable";

export interface EffortInput {
  readonly kind: "epic" | "child";
  readonly issueState: "open" | "closed";
  /** The stage-family labels this object carries, in the caller's own vocabulary. */
  readonly stageLabels: readonly string[];
  /** A G1 mode label (the human-picked routing decision) is present. */
  readonly modeLabelPresent: boolean;
  readonly hasPr: boolean;
  readonly prOpen: boolean;
  /** The PR is the final integration->trunk delivery, or a shikai-mode child's own PR. */
  readonly prIsDelivery: boolean;
  readonly integrationBranchAlive: boolean;
  /** A reviewer job posted no Verdict line at all -- one live signal for "stalled". */
  readonly reviewerVerdictMissing?: boolean;
}

export interface EffortClassification {
  readonly effortClass: EffortClass;
  readonly evidence: readonly string[];
}

export function classifyEffort(input: EffortInput): EffortClassification {
  if (input.stageLabels.length > 1) {
    return {
      effortClass: "state-machine-violation",
      evidence: [
        `carries ${input.stageLabels.length} stage-family labels at once (${input.stageLabels.join(", ")}) -- exactly one at all times is the invariant; this is flagged, not resolved by guessing which is authoritative`,
      ],
    };
  }

  if (input.kind === "epic" && input.integrationBranchAlive && input.issueState === "closed") {
    return {
      effortClass: "idle",
      evidence: ["the epic is closed but its integration branch is still alive -- flag for cleanup"],
    };
  }

  if (input.hasPr && input.prOpen && input.prIsDelivery) {
    return {
      effortClass: "delivering",
      evidence: ["an open PR is the delivery PR the caller flagged as prIsDelivery -- this is at G2"],
    };
  }

  const stage = input.stageLabels[0];
  if (stage !== undefined) {
    if (input.hasPr) {
      return { effortClass: "building", evidence: [`carries the released stage label '${stage}' and has a PR in progress`] };
    }
    if (!input.integrationBranchAlive) {
      const reasons = ["released, but no branch or PR was ever opened"];
      if (input.reviewerVerdictMissing === true) {
        reasons.push("a reviewer job posted no Verdict line at all -- a job that died mid-run, not a pending review");
      }
      return { effortClass: "stalled", evidence: [`carries '${stage}' -- ${reasons.join("; ")}`] };
    }
    return { effortClass: "building", evidence: [`carries the released stage label '${stage}'; a branch exists but no PR yet`] };
  }

  if (input.modeLabelPresent) {
    return { effortClass: "queued", evidence: ["G1-approved (a mode label was picked) but not yet released with a stage label"] };
  }

  return {
    effortClass: "undecidable",
    evidence: ["no stage label, no mode label, no PR, no live integration branch -- nothing here places it in the taxonomy"],
  };
}
