// src/gates/base_identities.ts -- every OTHER input `nen/gates.json` supplies,
// as the PULL REQUEST'S BASE declares it (zheref/nen#372, Feitan on #264).
//
// WHY THE BASE, AGAIN. zheref/nen#249 moved `checks.excluded` to the base
// (./base_exclusions.ts) and left the rest of the file where it was: read from
// the checkout under `--repo`, which in a worktree IS the pull request's own
// head. So the head still decided who counts as a reviewer
// (`reviewers[].login_pattern`), what a round is (`round_check_pattern`,
// `review_check_pattern`, `enrolment_check_pattern`), whether a review at head
// approves (`approves_when_posted_at_head`), who must approve
// (`default_approvers`, `approval_policy`), who is owed (`base_reviewers`), how
// many rounds stand in for all of them (`round_quorum`), the round caps and the
// stall bound (`round_policy`), the delivery carve-out (`delivery`) and the
// Dependabot one (`dependabot_carve_out`). Each of those can widen a verdict as
// surely as an exclusion can -- a `login_pattern` loosened to `.*` lets anyone's
// review be the bot's round, and a `round_quorum` that drops its `minimum` from
// 2 to 1, or adds a member the head's author can satisfy, lets one round stand
// in for the rest -- so the whole file is read at the base now, through the
// same read #249 built.
//
// THE LOCAL FILE IS A FALLBACK, AND IT IS NEVER QUIET. When the base cannot be
// read, declares no `nen/gates.json`, or carries one this build refuses, the
// checkout's own file supplies the identities -- the verdict stays computable,
// and every repository whose token lacks `contents:read` keeps working -- but a
// warning says, on every output, that the verdict rests on rules the base has
// not merged. Unlike a lost exclusion (which can only make the verdict
// STRICTER, and so is a quiet note when nothing was declared), a fallback here
// can make it WIDER, so it is never demoted to a note.
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

/** Where a verdict's gate inputs were read from. */
export type GatesOrigin =
  /** `nen/gates.json` at the pull request's base commit. */
  | "base"
  /** The checkout's own file, because the base could not supply one (a warning says why). */
  | "local-fallback";

export interface BaseIdentities {
  /** The identities the gate applies. */
  readonly identities: GateIdentities;
  readonly origin: GatesOrigin;
  /**
   * The file they were parsed from: `<owner>/<repo>@<sha>:nen/gates.json` on
   * the base, the local file's own path on the fallback.
   */
  readonly path: string;
  /** Loud: empty when the base supplied them, one line naming why when it did not. */
  readonly warnings: readonly string[];
}

/**
 * Resolve the base read into the identities to apply. `where` names the file
 * at the base (`<owner>/<repo>@<sha>:nen/gates.json`); `local` is what the
 * checkout's own file declares, used only when the base cannot supply one.
 */
export function identitiesAtBase(read: BaseGatesRead, where: string, local: GateIdentities): BaseIdentities {
  const fallback = (why: string): BaseIdentities => ({
    identities: local,
    origin: "local-fallback",
    path: local.path,
    warnings: [
      `gate inputs read from the LOCAL ${local.path}, NOT the pull request's base (${where}): ${why}. ` +
        "In a worktree the local file is the pull request's own head, so the reviewers, rounds, quorum, approvals and carve-outs this verdict applied are ones the base has not merged.",
    ],
  });
  if (read.kind === "failed") return fallback(`the base could not be read (${read.message})`);
  if (read.kind === "absent") return fallback("the base declares no nen/gates.json");
  try {
    // The same refusals the local file meets -- duplicate keys, invalid JSON,
    // an unsupported version, a key this build does not read (zheref/nen#310)
    // -- each naming the BASE location rather than a path on this machine.
    return {
      identities: parseGateIdentities(where, parseGatesText(where, read.text)),
      origin: "base",
      path: where,
      warnings: [],
    };
  } catch (error) {
    if (error instanceof SchemaError) return fallback(`the base's file was refused (${error.message})`);
    throw error;
  }
}
