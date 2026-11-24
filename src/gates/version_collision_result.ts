// src/gates/version_collision_result.ts -- the version-collision limb's
// RESULT types (zheref/nen#663), here beside the pure gate that folds the limb
// into CON-32(a) (./ready.ts). The evaluator that produces them is
// ../pr/version_collision.ts; it imports these, and the gate never imports
// from src/pr -- the layering runs src/pr -> src/gates.

import type { VersionCollisionPolicy } from "../schema/gates.js";

export type VersionCollisionStatus = "not-applicable" | "clear" | "collision" | "unknown";

/** One conflict: a target tip that already carries the version, or a peer proposing it. */
export interface VersionCollisionEntry {
  /**
   * `base`: a target tip (the base's, or the default branch's on a stacked
   * base) already carries the proposed version (AC-1). `unbumped`: the head
   * keeps its merge base's version while the base tip has moved on to
   * another, already published one -- merged, the file keeps the tip's.
   * `peer`: another open same-repository pull request proposes it (AC-2).
   */
  readonly kind: "base" | "unbumped" | "peer";
  readonly version: string;
  /** The peer's number; `null` for a tip. */
  readonly pr: number | null;
  /** The tip's commit, or the peer's head. */
  readonly head: string | null;
  /** The tip's branch, or the peer's base branch. */
  readonly baseRef: string | null;
  /** The peer's draft flag; `null` for a tip. */
  readonly draft: boolean | null;
}

/** The evaluator's whole answer -- `meta.versionCollision` and the verb's document both carry it. */
export interface VersionCollisionResult {
  readonly status: VersionCollisionStatus;
  /** The one line to quote. */
  readonly line: string;
  readonly judgedHead: string | null;
  readonly base: { readonly ref: string; readonly sha: string | null };
  readonly default: { readonly ref: string; readonly sha: string | null };
  /** `<owner>/<repo>@<sha>:nen/gates.json` -- always the default-branch tip's. */
  readonly policySource: string | null;
  readonly policy: VersionCollisionPolicy | null;
  readonly proposedVersion: string | null;
  readonly collisions: readonly VersionCollisionEntry[];
  /**
   * Every piece of evidence that could not be read, by name. Non-empty on
   * `unknown`; it may also be non-empty on `collision` (a conflict proven by
   * the evidence that WAS read), and the line then says "also not read".
   */
  readonly missing: readonly string[];
  readonly inventory: {
    /** Inventory pages read (both passes). */
    readonly pages: number;
    /** Open pull requests inspected, the subject excluded. */
    readonly inspected: number;
    /** Requests this evaluation made. */
    readonly reads: number;
    readonly budget: number;
  };
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

/** The part of the result `nen pr ready` carries on its CON-32(a) row. */
export type VersionCollisionLimb = Pick<VersionCollisionResult, "status" | "line" | "proposedVersion" | "collisions" | "missing">;

