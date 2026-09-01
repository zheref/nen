// src/color/status.ts -- first-match colour precedence, over the target
// repository's `schemas/colors.yml`.
//
// PORTED FROM backlog-state §6, whose rule is one sentence and whose reason is
// the sentence after it: "Precedence, when more than one could apply -- highest
// first. Apply the first that matches and stop. Two agents rendering the same
// board must produce identical colours; an unstated tie-break is how they
// diverge."
//
// THE ORDER IS THE FILE'S, NOT THIS MODULE'S. `schemas/colors.yml` states it as
// `categories.<name>.precedence`, a list of value names, and ../schema/colors.ts
// already validates that every name in it exists. So this module contains no
// order, no glyph and no colour -- it walks a list the repository wrote. That is
// the whole of §3 in one verb: the same code, pointed at a repository with a
// different vocabulary, answers with that repository's vocabulary.
//
// WHY A VERB AT ALL, when the loader already has `resolve()`. Two reasons the
// original names. The first is that the precedence is stated in prose in three
// skills and machine-readably in one file, and prose re-implemented per skill is
// how two boards disagree. The second is the REASONING behind the order, which a
// caller needs when a row surprises them: an explicit hold outranks everything
// because it is an instruction NOT to act while every other colour invites
// action; blocked outranks ready because a row that is both has a dependency the
// merge will not satisfy. This verb reports WHICH candidates lost, so that
// reasoning is visible in the answer rather than only in a document.
//
// A CATEGORY WITH NO PRECEDENCE AND MORE THAN ONE CANDIDATE HAS NO ANSWER, and
// this says so rather than picking. That is ../schema/colors.ts's behaviour and
// it is deliberate: an arbitrary pick from an unordered set is exactly the
// divergence the rule exists to prevent, and it would be invisible.

import type { ColorValue, ColorVocabulary } from "../schema/colors.js";

export interface StatusResolution {
  readonly category: string;
  /** The category's declared order, as the file states it. */
  readonly precedence: readonly string[];
  /** What the caller said was true of this row, in the order they said it. */
  readonly present: readonly string[];
  /** Names that are not values of this category. Reported, never ignored. */
  readonly unknown: readonly string[];
  /** The winner, or null when nothing matched or the tie is unbreakable. */
  readonly resolved: ColorValue | null;
  /** Candidates the precedence ranked below the winner. */
  readonly outranked: readonly string[];
  /** Why there is no winner, when there is none. */
  readonly reason: string | null;
}

export class ColorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ColorError";
  }
}

export function resolveStatus(
  colors: ColorVocabulary,
  categoryName: string,
  present: readonly string[],
): StatusResolution {
  const category = colors.category(categoryName);
  if (category === undefined) {
    throw new ColorError(
      `${colors.path} declares no '${categoryName}' category. Nen has no built-in colour table to fall back on -- a binary that guessed would report a vocabulary this repository does not have. Categories here: ${colors.categories.map((item): string => item.name).join(", ") || "(none)"}.`,
    );
  }

  const declared = new Set(category.values.map((value): string => value.name));
  const unknown = present.filter((name): boolean => !declared.has(name));
  const candidates = present.filter((name): boolean => declared.has(name));

  // FIRST MATCH IN THE FILE'S OWN ORDER, then stop.
  for (const name of category.precedence) {
    if (!candidates.includes(name)) continue;
    return {
      category: categoryName,
      precedence: category.precedence,
      present,
      unknown,
      resolved: category.get(name) ?? null,
      outranked: candidates.filter((item): boolean => item !== name),
      reason: null,
    };
  }

  // No precedence entry matched. Two very different situations, reported apart.
  const base = {
    category: categoryName,
    precedence: category.precedence,
    present,
    unknown,
    resolved: null,
    outranked: [] as readonly string[],
  };
  if (candidates.length === 0) {
    return {
      ...base,
      reason:
        unknown.length === 0
          ? `nothing was reported present, so no value of '${categoryName}' applies`
          : `none of the reported names is a value of '${categoryName}' (${unknown.join(", ")})`,
    };
  }
  if (category.precedence.length === 0) {
    // A single candidate needs no tie-break, so it wins even without an order.
    if (candidates.length === 1) {
      const only = candidates[0];
      return {
        ...base,
        resolved: only === undefined ? null : (category.get(only) ?? null),
        reason: null,
      };
    }
    return {
      ...base,
      reason: `'${categoryName}' declares no precedence, and ${candidates.length} of its values are present (${candidates.join(", ")}). An arbitrary pick is exactly the divergence a precedence exists to prevent, so there is no answer until the file states an order.`,
    };
  }
  return {
    ...base,
    reason: `'${categoryName}' declares a precedence (${category.precedence.join(" > ")}) that names none of the present values (${candidates.join(", ")}). A value outside the order has no rank, so no first match exists.`,
  };
}
