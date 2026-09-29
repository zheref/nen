// src/repo/scenario.ts -- `nen repo scenario`: the caller workflow's scenario
// read straight off the target repository's own registry.
//
// A LOOKUP, NOT A COMPUTATION. `nen/repos.json` records a `scenario` on the
// rows of three sections -- `consumers[]`, `maintained_tools[]` and
// `pending_onboarding[]` (../schema/repos.ts's ConsumerEntry and ListedEntry)
// -- the value bankai-quality/-handbooks resolution reads to pick a tooling
// and rule set. This module's only job is reading it off whichever row
// records the repository, and naming the failure honestly when there is none.
//
// WHY THREE SECTIONS, NOT ONE (zheref/nen#219). Only a consumers[] entry used
// to carry a scenario, and the refusal for a maintained tool told the caller
// to "record it under consumers[]" -- asking for a false fact, since a
// registry's own tool repository consumes nothing (`zheref/hatsu` does not
// consume `zheref/hatsu`). With no truthful way to record one, neither tool
// repository could resolve a pinned handbook, and every review there cited
// canon by path instead of by rule id. A scenario is a property of the
// REPOSITORY, not of the reason the registry records it, so every row that
// records a repository by slug may state one. A `product_codes` value stays
// outside that set: it is a name, not a row, and has nowhere to put a field.
//
// ONE REPOSITORY, ONE SCENARIO. A repository can be recorded in more than one
// section -- a maintained tool that is also a consumer is a real shape. Its
// rows may repeat the same value, and a value stated on any one of them is
// read; rows that state DIFFERENT values are refused, naming each, because
// reading either would be a guess about which one governs it -- the "resolve
// or fail, never guess" rule ./resolve.ts states for tokens, applied to the
// value a token leads to. A consumers[] entry's scenario is therefore read
// exactly as before whenever no other row contradicts it.
//
// THE FAILURES, TOLD APART. The registry records repositories in more places
// than it records scenarios, so "no scenario" has four distinct causes
// (zheref/nen#28, widened by #219), and conflating them sends a caller to fix
// the wrong file:
//
//   1. the repo is not recorded ANYWHERE in the file -- fix the --target
//      spelling, or point --repo at the registry that records it;
//   2. the repo IS recorded on a row that can carry a scenario, and no such
//      row states one -- the fix is THAT row, in the section it is already
//      in, never a move to another section;
//   3. the repo is recorded only where no scenario can live (a
//      `product_codes` value) -- the fix is to add a row for it, in the
//      section that is TRUE of it, which the refusal spells out rather than
//      naming one section and leaving the caller to misfile it;
//   4. its rows state scenarios that disagree.
//
// "RECORDED" IS ./resolve.ts's CLAIM, NOT A SECOND MATCHER. resolveToken() is
// the one authority on what the file records (exact, case-insensitive, never a
// prefix); re-deriving membership here would be a second copy of that rule
// that drifts. This module only asks it "known or not", then names WHERE the
// record was found for the message.

import type { ListedEntry, ListedSection, RepoRegistry } from "../schema/repos.js";
import { nameHalf, RepoResolutionError, resolveToken } from "./resolve.js";

export type ScenarioResult =
  | { readonly ok: true; readonly scenario: string }
  | { readonly ok: false; readonly reason: string };

// What each section is FOR, in the remedy's own words. A repository the file
// records only by a product code has no row yet, and the section a new row
// belongs in is a fact about that repository which only the caller knows.
// Naming one section -- which is what the pre-#219 remedy did, and it named
// consumers[] -- turns the refusal into an instruction to record whatever it
// named, true or not.
const SECTION_GUIDE =
  "under maintained_tools[] if it is one of this registry's own tool repositories, pending_onboarding[] if it has not adopted the machinery yet, or consumers[] if it consumes it";

/** One row that states a scenario, and how a refusal names that row. */
interface StatedScenario {
  readonly scenario: string;
  readonly row: string;
}

/**
 * Where recordedWhere() found `repoSlug`, and whether that find NAMES it --
 * as opposed to merely matching its bare name half against a value that
 * names no owner at all (resolveToken()'s rule 3.5c). The distinction exists
 * because resolveScenario()'s cause-3 message says "'repoSlug' IS recorded in
 * FILE"; that claim is true for every case below except the 3.5c one, where
 * the file never recorded `repoSlug` -- only its name half, under a bare
 * `product_codes` value that states no owner. Saying "is recorded" there
 * overstates what a caller re-reading the file would actually find (#28).
 */
interface RecordedLocation {
  readonly clause: string;
  readonly exact: boolean;
}

// The maintained_tools/pending_onboarding rows that record `repoSlug`, by
// exact slug and case-insensitively -- the comparison ./resolve.ts's rule
// 3.5b makes for an `owner/name` token, which is the only shape --target
// takes. Order is `listed`'s: maintained_tools rows, then pending_onboarding
// rows.
//
// `listed` is absent only on a registry assembled by hand, which predates the
// field (../schema/repos.ts). Its slug lists are still read as rows -- rows
// that state no scenario -- so a repository such a registry lists is refused
// as "recorded under maintained_tools, with no scenario" rather than falling
// through to a message that says it is recorded nowhere a scenario can live.
function listedRowsFor(registry: RepoRegistry, repoSlug: string): readonly ListedEntry[] {
  const wanted = repoSlug.toLowerCase();
  const rows = registry.listed ?? [
    ...registry.maintainedTools.map((repo): ListedEntry => ({ repo, section: "maintained_tools", scenario: null })),
    ...registry.pendingOnboarding.map((repo): ListedEntry => ({ repo, section: "pending_onboarding", scenario: null })),
  ];
  return rows.filter((row): boolean => row.repo.toLowerCase() === wanted);
}

// The sections those rows came from, deduped, in the file's own order.
function sectionsOf(rows: readonly ListedEntry[]): readonly ListedSection[] {
  return [...new Set(rows.map((row): ListedSection => row.section))];
}

function quoted(sections: readonly ListedSection[]): string {
  return sections.map((section): string => `'${section}'`).join(" and ");
}

// Where the registry records a repo that no scenario-carrying row records --
// which, for an `owner/name` --target, leaves only a `product_codes` value.
// The comparisons mirror ./resolve.ts's (exact value for a product code, or --
// separately, and marked inexact -- a bare value's name half); the
// fallthrough exists so a future widening of resolveToken() degrades to a
// vaguer-but-true message here rather than to a lie about which section to
// edit.
function recordedWhere(registry: RepoRegistry, repoSlug: string): RecordedLocation {
  const wanted = repoSlug.toLowerCase();
  const short = nameHalf(repoSlug).toLowerCase();
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
  return { clause: "outside every section whose rows carry a 'scenario'", exact: true };
}

export function resolveScenario(registry: RepoRegistry, repoSlug: string): ScenarioResult {
  let resolved;
  try {
    resolved = resolveToken(registry, repoSlug);
  } catch (error) {
    if (!(error instanceof RepoResolutionError)) throw error;
    // Cause 1: nothing in the file knows this slug at all.
    return {
      ok: false,
      reason: `'${repoSlug}' is not recorded anywhere in ${registry.path} -- not as a consumer, a product-code value, a maintained tool, or a pending onboarding. Its scenario cannot be read from a registry that does not know it. Check the --target spelling, or point --repo at the checkout whose registry records it.`,
    };
  }
  const consumer = resolved[0]?.entry ?? null;
  const rows = listedRowsFor(registry, repoSlug);

  // Every scenario a row recording this repository states, in file order:
  // the consumers[] entry first, then its maintained_tools/pending_onboarding
  // rows.
  const stated: StatedScenario[] = [];
  if (consumer !== null && consumer.scenario !== null) {
    stated.push({ scenario: consumer.scenario, row: "its consumers[] entry" });
  }
  for (const row of rows) {
    if (row.scenario !== null) stated.push({ scenario: row.scenario, row: `its ${row.section}[] row` });
  }

  // Cause 4: two rows, two answers. Compared exactly -- a scenario is a
  // directory name under canon resolve's --stack-dir, where case is part of
  // the name.
  if (new Set(stated.map((item): string => item.scenario)).size > 1) {
    const listing = stated.map((item): string => `'${item.scenario}' (${item.row})`).join(", ");
    return {
      ok: false,
      reason: `'${repoSlug}' is recorded in ${registry.path} with more than one scenario -- ${listing}. A repository has one scenario, and reading any one of these would be a guess about which governs it. Make its rows agree, or state it on one row only.`,
    };
  }
  const found = stated[0];
  if (found !== undefined) return { ok: true, scenario: found.scenario };

  if (consumer !== null) {
    // Cause 2, as a consumer: onboarded, and its entry never states a
    // scenario. The sentence is the pre-#219 one, unchanged, when consumers[]
    // is the only section recording it; a repository that is ALSO listed
    // gets that named too, so the caller knows a scenario on either row is
    // read.
    const base = `'${repoSlug}' is a consumer in ${registry.path}, but its entry carries no 'scenario' field. Add one to the entry to record which scenario governs it.`;
    return {
      ok: false,
      reason:
        rows.length === 0
          ? base
          : `${base} It is also recorded under ${quoted(sectionsOf(rows))}, where it carries none either; a 'scenario' on any one of its rows is read.`,
    };
  }

  const home = rows[0];
  if (home !== undefined) {
    // Cause 2, as a listed repository -- the #219 case. The file records it
    // exactly where it belongs, on a row that can carry the field, so the
    // remedy is that row. It used to say "record it under consumers[]",
    // which told the caller to write down a consumption that is not true.
    return {
      ok: false,
      reason: `'${repoSlug}' is recorded in ${registry.path} (under ${quoted(sectionsOf(rows))}), but ${rows.length === 1 ? "its row there carries no" : "none of its rows there carries a"} 'scenario' field. Add one to its ${home.section}[] row to record which scenario governs it -- that row carries the field exactly as a consumers[] entry does, so the repository needs recording nowhere else.`,
    };
  }

  // Cause 3: the file records the repo only where no scenario can live.
  const where = recordedWhere(registry, repoSlug);
  return {
    ok: false,
    // The 3.5c/bare-value case (where.exact === false) gets its OWN
    // sentence rather than reusing "'repoSlug' is recorded in FILE (...)":
    // the file never recorded repoSlug there, only the name half it
    // matched against -- saying "is recorded" would overstate the lookup
    // (#28's second finding).
    reason: where.exact
      ? `'${repoSlug}' is recorded in ${registry.path} (${where.clause}), but on no row that can carry a 'scenario' field -- only consumers[], maintained_tools[] and pending_onboarding[] rows do, and a product_codes value is a name rather than a row. To give it one, add a row for it ${SECTION_GUIDE}, with a 'scenario'.`
      : `'${repoSlug}' is not itself recorded in ${registry.path} -- only its name half matches ${where.clause}. To give it a scenario, add a row for '${repoSlug}' there ${SECTION_GUIDE}, with a 'scenario'.`,
  };
}
