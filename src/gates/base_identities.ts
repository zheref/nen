// src/gates/base_identities.ts -- every OTHER input `nen/gates.json` supplies,
// as the PULL REQUEST'S BASE declares it (zheref/nen#372, Feitan on #264).
//
// WHY THE BASE, AGAIN. zheref/nen#249 moved `checks.excluded` to the base
// (./base_exclusions.ts) and left the rest of the file where it was: read from
// the checkout under `--repo`, which in a worktree IS the pull request's own
// head. So the head still decided who counts as a reviewer and what a round
// is -- every `reviewers[]` key: `name`, `login_pattern`,
// `review_check_pattern`, `round_check_pattern`, `enrolment_check_pattern`,
// `bounded_policy_exempt`, `delivery_holistic_pass`,
// `approves_when_posted_at_head` -- who must approve (`default_approvers`,
// `approval_policy`), who is owed (`base_reviewers`), how many rounds stand in
// for all of them (`round_quorum`), the round caps and the stall bound
// (`round_policy`), the delivery carve-out (`delivery`) and the Dependabot one
// (`dependabot_carve_out`). Each of those can widen a verdict as surely as an
// exclusion can -- a `login_pattern` loosened to `.*` lets anyone's review be
// the bot's round, and a `round_quorum` that drops its `minimum` from 2 to 1,
// or adds a member the head's author can satisfy, lets one round stand in for
// the rest -- so the whole file is read at the base now, through the same read
// #249 built.
//
// THREE OUTCOMES, AND ONLY ONE OF THEM FALLS BACK (SEC-6: a pull request must
// not relax its own gate; hanten round 1 on zheref/nen#372, Feitan 1 and 2).
//   * The base's file PARSES: it is applied (`base`).
//   * The base could not be READ -- a 403, the network, a transport that
//     cannot read files, no base commit: the checkout's own file is applied
//     (`local-fallback`), because the issue asks that a reader still get a
//     verdict, and a warning on every output says so. The autonomous callers
//     (`pr merge`, `watch until --pr --until ready`) refuse a verdict that
//     rests on it; a human reads the warning.
//   * The base DECLARES NO FILE (`absent`) or carries one this build REFUSES
//     (`refused`): nothing is applied here. Falling back would hand the gate
//     to whichever file the head carries -- a head that ADDS a gates file to a
//     base that has none would name its own reviewers, and a trunk that adopts
//     a key from a newer nen would have its rules replaced by the checkout's.
//     The caller decides what a missing gate means for it (`pr ready`: the
//     caller's `--reviewers`, or no verdict; `pr next-blocker`: a refusal).
//
// `checks.excluded` is not this file's: the identities resolved here carry
// whatever the chosen file declares, and the caller replaces that list with
// ./base_exclusions.ts's answer, which honours the base's and nothing else even
// on the fallback.
//
// Pure: the transports read the file (`pr ready`'s token client, `pr
// next-blocker`'s `gh`) and hand the outcome here.

import type { BaseGatesRead } from "./base_exclusions.js";
import { SchemaError } from "../schema/errors.js";
import { parseGateIdentities, parseGatesText, type GateIdentities } from "../schema/gates.js";

/** Where an APPLIED verdict's gate inputs were read from. */
export type GatesOrigin =
  /** `nen/gates.json` at the pull request's base commit. */
  | "base"
  /** The checkout's own file, because the base could not be READ (a warning says why). */
  | "local-fallback";

export type BaseIdentities =
  | {
      readonly kind: "applied";
      /** The identities the gate applies. */
      readonly identities: GateIdentities;
      readonly origin: GatesOrigin;
      /**
       * The file they were parsed from: `<owner>/<repo>@<sha>:nen/gates.json`
       * on the base, the local file's own path on the fallback.
       */
      readonly path: string;
      /** Loud: empty when the base supplied them, one line naming why when it did not. */
      readonly warnings: readonly string[];
    }
  | {
      /** The base declares no `nen/gates.json`: the checkout's file is NOT applied. */
      readonly kind: "absent";
      readonly reason: string;
    }
  | {
      /** The base's file is one this build refuses: the checkout's file is NOT applied. */
      readonly kind: "refused";
      readonly reason: string;
      /** The refusal itself, path and pointer included. */
      readonly message: string;
    };

/**
 * Resolve the base read into the identities to apply. `where` names the file
 * at the base (`<owner>/<repo>@<sha>:nen/gates.json`); `local` is what the
 * checkout's own file declares, used only when the base could not be READ.
 */
export function identitiesAtBase(read: BaseGatesRead, where: string, local: GateIdentities): BaseIdentities {
  if (read.kind === "failed") {
    return {
      kind: "applied",
      identities: local,
      origin: "local-fallback",
      path: local.path,
      warnings: [
        `gate inputs read from the LOCAL ${local.path}, NOT the pull request's base (${where}): the base could not be read (${read.message}). ` +
          "In a worktree the local file is the pull request's own head, so the reviewers, rounds, quorum, approvals and carve-outs this verdict applied may be ones the base has not merged; 'pr merge' and 'watch until --until ready' refuse a verdict that rests on them.",
      ],
    };
  }
  if (read.kind === "absent") {
    return {
      kind: "absent",
      reason: `the pull request's base (${where}) declares no nen/gates.json, so no merged ruling states a gate -- and the checkout's own file, in a worktree the pull request's head, is never applied in its place`,
    };
  }
  try {
    // The same refusals the local file meets -- duplicate keys, invalid JSON,
    // an unsupported version, a key this build does not read (zheref/nen#310)
    // -- each naming the BASE location rather than a path on this machine.
    return {
      kind: "applied",
      identities: parseGateIdentities(where, parseGatesText(where, read.text)),
      origin: "base",
      path: where,
      warnings: [],
    };
  } catch (error) {
    if (error instanceof SchemaError) {
      return {
        kind: "refused",
        message: error.message,
        reason: `this nen cannot read the gate the pull request's base declares (${error.message}), and the checkout's own file is never applied in its place`,
      };
    }
    throw error;
  }
}
