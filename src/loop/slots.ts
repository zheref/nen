// src/loop/slots.ts -- the two concurrency budgets, counted separately.
//
// THE WHOLE POINT IS THAT THEY ARE TWO. The band-scoped loop this ports keeps a
// CI budget and a LOCAL budget, and the sentence that matters is: "they are
// separate budgets and never traded against each other". Two CI efforts in
// flight does not forbid a local worktree, and seven local worktrees do not
// forbid the CI slots.
//
// WHEN A SLOT FREES IS DIFFERENT PER PLANE, AND THAT IS THE LOAD-BEARING PART.
//
//   * A CI slot frees the moment the PR OPENS, because a different actor -- the
//     builder's own iterate loop -- is contracted to drive it to readiness.
//   * A LOCAL slot frees only when that PR is READY *and* the human has been
//     prompted, because nothing else is behind it. No loop, no sweeper, no
//     webhook. Freeing a local slot at PR-open leaves the PR at not-ready
//     forever with no actor, and the run reports success having stranded it.
//
// A future reader who "optimises" the local rule to match the CI one has
// re-created exactly that stranding, and the symptom does not surface until
// somebody goes looking for a gate that never arrived. It is written here, in
// the code that computes it, for that reason.
//
// PROMPTED IS A FACT THE CALLER SUPPLIES, not one this module infers. Whether
// the human was actually told is knowable only where the telling happened, and
// a counter that assumed it would free every local slot the moment a gate
// script printed something.

export type Plane = "ci" | "local";

export interface Effort {
  readonly id: string;
  readonly plane: Plane;
  /** A PR exists and is open. */
  readonly prOpen: boolean;
  /** The readiness gate said ready. Only meaningful on the local plane. */
  readonly ready: boolean;
  /** The human has been prompted for this PR. Only meaningful on the local plane. */
  readonly prompted: boolean;
}

export interface Caps {
  readonly ci: number;
  readonly local: number;
}

// THE LOCAL PLANE HAS NO DEFAULT CAP, ON PURPOSE. There used to be one -- 7 --
// and it was a footgun (issue #52): every real caller's own stated policy was
// 2, so forgetting one flag silently granted more than three times the intended
// concurrency. A safety cap that WIDENS when omitted fails in the dangerous
// direction; a guard must be chosen by the caller, not inherited from a default
// nobody's policy actually states. So `computeSlots` requires caps outright,
// and the CLI refuses when `--local-cap` is omitted.
//
// THE CI PLANE KEEPS ITS DEFAULT, and the asymmetry is deliberate. 2 is not a
// guess this module made -- it is the ported band-scoped loop's own CI budget,
// the exact value every known caller runs under (none has ever overridden it).
// Forgetting `--ci-cap` therefore lands on the strictest known policy: the
// omission errs TIGHT, the safe direction, which is precisely what the local
// default failed to do. And the exposure differs in kind -- a CI slot frees at
// PR-open (see the header), so its budget bounds only the short pre-PR window,
// where a local slot is held all the way to ready-and-prompted.
export const DEFAULT_CI_CAP = 2;

export interface PlaneReport {
  readonly plane: Plane;
  readonly cap: number;
  readonly occupied: number;
  readonly free: number;
  /** Efforts still holding a slot, with why each one is still holding it. */
  readonly holding: readonly { readonly id: string; readonly why: string }[];
  readonly binding: boolean;
}

export interface SlotsReport {
  readonly ci: PlaneReport;
  readonly local: PlaneReport;
  /** Efforts that have finished by this plane's own rule. */
  readonly done: readonly string[];
}

// Whether an effort still occupies a slot, and the reason -- returned together,
// because a count with no reason is a number a reader has to re-derive to trust.
export function occupancy(effort: Effort): { occupied: boolean; why: string } {
  if (effort.plane === "ci") {
    if (effort.prOpen) {
      return {
        occupied: false,
        why: "PR open -- the builder's own iterate loop drives it from here, so the slot frees",
      };
    }
    return { occupied: true, why: "released, but no PR yet" };
  }
  if (!effort.prOpen) return { occupied: true, why: "authored locally, no PR yet" };
  if (!effort.ready) {
    return {
      occupied: true,
      why: "PR open but not ready -- nothing else is behind a locally-authored PR, so this run still owns it",
    };
  }
  if (!effort.prompted) {
    return {
      occupied: true,
      why: "ready, but the human has not been prompted -- readiness nobody was told about is not a handover",
    };
  }
  return { occupied: false, why: "ready and prompted -- handed over" };
}

// `caps` is required -- no default parameter. A library caller who omitted it
// would inherit exactly the silent local budget the DEFAULT_CI_CAP note above
// removes; the requirement holds at every layer, not just the CLI's.
export function computeSlots(
  efforts: readonly Effort[],
  caps: Caps,
): SlotsReport {
  const done: string[] = [];
  const build = (plane: Plane, cap: number): PlaneReport => {
    const holding: { id: string; why: string }[] = [];
    for (const effort of efforts) {
      if (effort.plane !== plane) continue;
      const state = occupancy(effort);
      if (state.occupied) holding.push({ id: effort.id, why: state.why });
      else done.push(effort.id);
    }
    const occupied = holding.length;
    return {
      plane,
      cap,
      occupied,
      free: Math.max(0, cap - occupied),
      holding,
      binding: occupied >= cap,
    };
  };
  const ci = build("ci", caps.ci);
  const local = build("local", caps.local);
  return { ci, local, done };
}

export interface ParsedEfforts {
  readonly efforts: readonly Effort[];
  readonly errors: readonly string[];
}

// The efforts file: a JSON array of objects. Validated rather than cast --
// an effort missing its `plane` would otherwise default into a budget nobody
// chose, and the two budgets exist precisely so that never happens.
export function parseEfforts(json: string): ParsedEfforts {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    return { efforts: [], errors: ["expected a JSON array of efforts"] };
  }
  const efforts: Effort[] = [];
  const errors: string[] = [];
  parsed.forEach((entry, index): void => {
    const record = entry as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"] : `#${index}`;
    const plane = record["plane"];
    if (plane !== "ci" && plane !== "local") {
      errors.push(
        `efforts[${index}] ('${id}') has plane ${JSON.stringify(plane)}; it must be "ci" or "local". The two budgets are never traded against each other, so an effort with no plane belongs to neither.`,
      );
      return;
    }
    efforts.push({
      id,
      plane,
      prOpen: record["prOpen"] === true,
      ready: record["ready"] === true,
      prompted: record["prompted"] === true,
    });
  });
  return { efforts, errors };
}
