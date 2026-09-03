// src/repo/scenario.ts -- `nen repo scenario`: the caller workflow's scenario
// read straight off the target repository's own registry entry.
//
// A LOOKUP, NOT A COMPUTATION. `schemas/repos.json`'s consumer entries already
// carry a `scenario` field (../schema/repos.ts's ConsumerEntry) -- the value
// bankai-quality/-handbooks resolution reads to pick a tooling and rule set.
// This module's only job is naming the failure honestly when the lookup comes
// back empty, and the registry records repositories in more places than
// `consumers[]` (./resolve.ts's rule 5, zheref/nen#27), so there are THREE
// distinct gaps, not two (zheref/nen#28):
//
//   1. the repo is not recorded ANYWHERE in the file -- fix the --target
//      spelling, or point --repo at the registry that records it;
//   2. the repo IS recorded (a `product_codes` value, `maintained_tools`,
//      `pending_onboarding`) but not as a consumer -- only a consumers[] entry
//      carries a `scenario`, so the fix is in the registry, not the flags;
//   3. the repo is a consumer whose entry simply carries no `scenario` field.
//
// Conflating them into one "not a consumer" -- which is what this module did
// before the split -- sent a caller fixing the wrong file: the identical
// refusal fired for the registry's own source repo (recorded as a product-code
// value, never a consumer of itself) and for a genuinely unknown slug.
//
// "RECORDED" IS ./resolve.ts's CLAIM, NOT A SECOND MATCHER. resolveToken() is
// the one authority on what the file records (exact, case-insensitive, never a
// prefix); re-deriving membership here would be a second copy of that rule
// that drifts. This module only asks it "known or not", then names WHERE the
// record was found for the message.

import type { RepoRegistry } from "../schema/repos.js";
import { nameHalf, RepoResolutionError, resolveToken } from "./resolve.js";

export type ScenarioResult =
  | { readonly ok: true; readonly scenario: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Where recordedWhere() found `repoSlug`, and whether that find NAMES it --
 * as opposed to merely matching its bare name half against a value that
 * names no owner at all (resolveToken()'s rule 3.5c). The distinction exists
 * because resolveScenario()'s gap-2 message says "'repoSlug' IS recorded in
 * FILE"; that claim is true for every case below except the 3.5c one, where
 * the file never recorded `repoSlug` -- only its name half, under a bare
 * `product_codes` value that states no owner. Saying "is recorded" there
 * overstates what a caller re-reading the file would actually find (#28).
 */
interface RecordedLocation {
  readonly clause: string;
  readonly exact: boolean;
}

// Where the registry records a repo that resolveToken() matched OUTSIDE
// `consumers[]` -- named in the refusal so the caller opens the right section.
// The comparisons mirror ./resolve.ts's (exact slug for the listings, exact
// value for a product code, or -- separately, and marked inexact -- a bare
// value's name half); the fallthrough exists so a future widening of
// resolveToken() degrades to a vaguer-but-true message here rather than to a
// lie about which section to edit.
function recordedWhere(registry: RepoRegistry, repoSlug: string): RecordedLocation {
  const wanted = repoSlug.toLowerCase();
  const short = nameHalf(repoSlug).toLowerCase();
  if (registry.maintainedTools.some((repo): boolean => repo.toLowerCase() === wanted)) {
    return { clause: "under 'maintained_tools'", exact: true };
  }
  if (registry.pendingOnboarding.some((repo): boolean => repo.toLowerCase() === wanted)) {
    return { clause: "under 'pending_onboarding'", exact: true };
  }
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (name.toLowerCase() === wanted) {
      return { clause: `as product code '${code}' ('${name}')`, exact: true };
    }
  }
  // 3.5c: a BARE product-code value (no owner recorded for it anywhere in the
  // file) matched by NAME HALF only. `repoSlug`'s owner half came from the
  // caller's own token, never from a lookup, so the registry does not record
  // `repoSlug` -- only the name resolveToken() matched it against.
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (!name.includes("/") && name.toLowerCase() === short) {
      return {
        clause: `bare product code '${code}' ('${name}'), which names no owner`,
        exact: false,
      };
    }
  }
  return { clause: "outside its consumers[] list", exact: true };
}

export function resolveScenario(registry: RepoRegistry, repoSlug: string): ScenarioResult {
  let resolved;
  try {
    resolved = resolveToken(registry, repoSlug);
  } catch (error) {
    if (!(error instanceof RepoResolutionError)) throw error;
    // Gap 1: nothing in the file knows this slug at all.
    return {
      ok: false,
      reason: `'${repoSlug}' is not recorded anywhere in ${registry.path} -- not as a consumer, a product-code value, a maintained tool, or a pending onboarding. Its scenario cannot be read from a registry that does not know it. Check the --target spelling, or point --repo at the checkout whose registry records it.`,
    };
  }
  const entry = resolved[0]?.entry ?? null;
  if (entry === null) {
    // Gap 2: the file plainly records the repo -- just not as a consumer, and
    // only a consumers[] entry carries a `scenario`. This is the case the old
    // "not a consumer" wording reported IDENTICALLY to gap 1, which told a
    // caller staring at the repo's own listing that the registry "does not
    // know it".
    const where = recordedWhere(registry, repoSlug);
    return {
      ok: false,
      // The 3.5c/bare-value case (where.exact === false) gets its OWN
      // sentence rather than reusing "'repoSlug' is recorded in FILE (...)":
      // the file never recorded repoSlug there, only the name half it
      // matched against -- saying "is recorded" would overstate the lookup
      // (#28's second finding).
      reason: where.exact
        ? `'${repoSlug}' is recorded in ${registry.path} (${where.clause}), but only a consumers[] entry carries a 'scenario' field. To give it one, record it under consumers[] with a 'scenario'.`
        : `'${repoSlug}' is not itself recorded in ${registry.path} -- only its name half matches ${where.clause}. To give it a scenario, record '${repoSlug}' under consumers[] there.`,
    };
  }
  if (entry.scenario === null) {
    // Gap 3: a consumer, onboarded, whose entry never states a scenario.
    return {
      ok: false,
      reason: `'${repoSlug}' is a consumer in ${registry.path}, but its entry carries no 'scenario' field. Add one to the entry to record which scenario governs it.`,
    };
  }
  return { ok: true, scenario: entry.scenario };
}
