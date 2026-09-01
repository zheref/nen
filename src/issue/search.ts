// src/issue/search.ts -- the four duplicate searches, and the normalized-title
// dedupe that `scripts/dedupe_handbook_questions.sh` performed uninvoked.
//
// WHY FOUR AND NOT ONE. The filing skill's § 3 is explicit that one phrasing
// finds one issue: a duplicate is found by SUBJECT, a fold candidate by the
// FILES and RULE IDS it touches, and a lane neighbour by its LANE LABEL. The
// fourth pass is the same subject terms against RECENTLY CLOSED issues, because
// "a fix that was closed and regressed is a re-open with new evidence, not a new
// issue" -- and that is the pass a search over open issues alone can never make.
// Running one query and calling it a reconciliation is how a backlog grows
// faster than it is worked.
//
// WHY THE ARGV IS BUILT HERE AND ASSERTED IN TESTS. A search that quietly
// changed shape would keep returning results and stop finding duplicates, and
// nothing about the output would say so. The recipes are therefore data: pure
// functions from a subject to an argv, pinned verbatim by ./search.test.ts, so
// a change to a query is a change a reviewer sees.
//
// STATE IS PART OF THE RECIPE, NOT A FLAG THE CALLER REMEMBERS. Three passes
// are `--state open` and one is `--state closed` with a `closed:>=` window; a
// caller that had to supply that would eventually supply it wrong.
//
// NOTHING HERE DECIDES ANYTHING. It returns candidates and says which recipe
// found each. Whether two issues are the same problem, whether a near neighbour
// should absorb this one, and what severity the result carries are the
// judgments § 2 of the migration keeps with the LLM. This module detects; it
// does not group.

import { lines, type Runner } from "../exec/seam.js";
import type { Target } from "../github/target.js";

/** How many days back "recently closed" reaches. */
export const RECENTLY_CLOSED_DAYS = 90;

/** The page size every recipe asks for, and the number a truncation is judged against. */
export const SEARCH_LIMIT = 100;

export type RecipeId = "subject-open" | "subject-recently-closed" | "files-and-rule-ids" | "lane";

export interface SearchSubject {
  /** Free text -- the problem in the caller's own words. */
  readonly subject: string;
  /** Paths the problem touches. Each becomes an `in:body` term. */
  readonly files: readonly string[];
  /** Clause/rule identifiers, e.g. as a repository spells them. */
  readonly ruleIds: readonly string[];
  /** Lane / routing labels, read from the target repository's taxonomy. */
  readonly laneLabels: readonly string[];
  /** ISO date the recently-closed window starts at. */
  readonly closedSince: string;
}

export interface Recipe {
  readonly id: RecipeId;
  /** Why this pass exists, printed in the human report so a search is auditable. */
  readonly rationale: string;
  /** The search expression, exactly as it is handed to `gh`. */
  readonly query: string;
  readonly argv: readonly string[];
}

const FIELDS = "number,title,state,url,labels,updatedAt,closedAt";

// The window's start date, as `gh`'s `closed:>=` qualifier spells it.
//
// Computed from an injected clock, never `new Date()` inside the recipe: a
// query whose text depends on the wall clock cannot be pinned by a test, and an
// unpinned query is exactly the thing this module exists to make reviewable.
export function closedSince(now: Date, days: number = RECENTLY_CLOSED_DAYS): string {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
}

function listArgv(slug: string, state: "open" | "closed", query: string): readonly string[] {
  return [
    "issue",
    "list",
    "--repo",
    slug,
    "--state",
    state,
    "--search",
    query,
    "--limit",
    String(SEARCH_LIMIT),
    "--json",
    FIELDS,
  ];
}

// The four recipes, in the order the skill states them.
//
// A pass whose terms are EMPTY is still returned, marked by an empty query, and
// the runner skips it -- rather than being silently dropped. A reconciliation
// that ran three passes must say it ran three, because "what was searched" is
// half of what makes the result auditable.
export function recipes(slug: string, subject: SearchSubject): readonly Recipe[] {
  const terms = subject.subject.trim();
  const bodyTerms = [...subject.files, ...subject.ruleIds]
    .map((term): string => `"${term}"`)
    .join(" OR ");
  const laneTerms = subject.laneLabels
    .map((label): string => `label:"${label}"`)
    .join(" ");

  return [
    {
      id: "subject-open",
      rationale:
        "the same problem, already open -- amend it with the new evidence instead of filing a second one",
      query: terms,
      argv: listArgv(slug, "open", terms),
    },
    {
      id: "subject-recently-closed",
      rationale:
        "the same problem, closed within the window -- a fix that regressed is a re-open with new evidence, not a new issue",
      query: terms === "" ? "" : `${terms} closed:>=${subject.closedSince}`,
      argv: listArgv(slug, "closed", `${terms} closed:>=${subject.closedSince}`),
    },
    {
      id: "files-and-rule-ids",
      rationale:
        "a different problem in the same files or under the same rule -- the fold candidates one PR would sanely deliver together",
      query: bodyTerms,
      argv: listArgv(slug, "open", bodyTerms),
    },
    {
      id: "lane",
      rationale:
        "the same lane -- neighbours routed to the same authority, which is where a fold is defensible at all",
      query: laneTerms,
      argv: listArgv(slug, "open", laneTerms),
    },
  ];
}

export interface FoundIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
}

export interface RecipeResult {
  readonly recipe: Recipe;
  /** `true` when the pass was skipped because its terms were empty. */
  readonly skipped: boolean;
  readonly issues: readonly FoundIssue[];
  /**
   * Set when the page came back FULL. A search that hit its limit may have
   * missed a duplicate on the next page, and `dedupe_handbook_questions.sh`
   * printed exactly this warning for exactly this reason -- a silent cap is a
   * reconciliation that claims more than it checked.
   */
  readonly truncated: boolean;
  readonly error: string | null;
}

export function parseIssueList(json: string): FoundIssue[] {
  const parsed: unknown = JSON.parse(json === "" ? "[]" : json);
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array of issues");
  return parsed.map((entry): FoundIssue => {
    const record = entry as Record<string, unknown>;
    const rawLabels = record["labels"];
    const labels = Array.isArray(rawLabels)
      ? rawLabels
          .map((label): string => String((label as Record<string, unknown>)["name"] ?? ""))
          .filter((name): boolean => name !== "")
      : [];
    return {
      number: Number(record["number"] ?? 0),
      title: String(record["title"] ?? ""),
      state: String(record["state"] ?? ""),
      url: String(record["url"] ?? ""),
      labels,
      updatedAt: record["updatedAt"] === undefined ? null : String(record["updatedAt"]),
      closedAt:
        record["closedAt"] === undefined || record["closedAt"] === null
          ? null
          : String(record["closedAt"]),
    };
  });
}

export function runSearch(
  runner: Runner,
  target: Target,
  subject: SearchSubject,
): readonly RecipeResult[] {
  return recipes(target.slug, subject).map((recipe): RecipeResult => {
    if (recipe.query.trim() === "") {
      return { recipe, skipped: true, issues: [], truncated: false, error: null };
    }
    const result = runner.run({ bin: "gh", args: recipe.argv });
    if (result.code !== 0) {
      return {
        recipe,
        skipped: false,
        issues: [],
        truncated: false,
        // The failure is CARRIED, not swallowed. A pass that errored found
        // nothing, and "found nothing" and "could not look" must never read the
        // same in a report whose conclusion is "no duplicate exists".
        error: (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`,
      };
    }
    let issues: FoundIssue[];
    try {
      issues = parseIssueList(result.stdout.trim());
    } catch (error) {
      return {
        recipe,
        skipped: false,
        issues: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      recipe,
      skipped: false,
      issues,
      truncated: issues.length >= SEARCH_LIMIT,
      error: null,
    };
  });
}

// --- the absorbed dedupe -----------------------------------------------------
//
// `scripts/dedupe_handbook_questions.sh` existed and was never invoked. Its
// logic is not lost: it is the exact-title half of this search. The
// normalization and the canonical-pick rule are carried verbatim, including the
// two properties that make it converge without a lock -- the canonical issue is
// the LOWEST number among current matches, and only numbers STRICTLY LESS than
// the new one can be canonical.

// Lowercase, collapse every non-alphanumeric run to a single space, trim.
//
// Deliberately NOT semantic. Two differently-worded reports of one gap will not
// match, and that is the documented bound: this targets the race where two runs
// of the same agent find the same gap seconds apart and title it identically.
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface Candidate {
  readonly number: number;
  readonly title: string;
}

// The canonical issue a new filing duplicates, or `null` when the new one is
// itself canonical.
//
// ORDER-INDEPENDENT BY CONSTRUCTION: it is a minimum over whatever the live
// open set is, so two concurrent runs computing it from different snapshots
// still agree on the answer. A blank normalized title matches nothing at all --
// a title of pure punctuation must never collapse every filing into one.
export function findCanonical(
  newNumber: number,
  newTitle: string,
  open: readonly Candidate[],
): number | null {
  const key = normalizeTitle(newTitle);
  if (key === "") return null;
  let best: number | null = null;
  for (const candidate of open) {
    if (candidate.number >= newNumber) continue;
    if (normalizeTitle(candidate.title) !== key) continue;
    if (best === null || candidate.number < best) best = candidate.number;
  }
  return best;
}
