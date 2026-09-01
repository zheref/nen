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

import { GH, outputLines, type Seams } from "../seam/exec.js";
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
  seams: Seams,
  target: Target,
  subject: SearchSubject,
): readonly RecipeResult[] {
  return recipes(target.slug, subject).map((recipe): RecipeResult => {
    if (recipe.query.trim() === "") {
      return { recipe, skipped: true, issues: [], truncated: false, error: null };
    }
    const result = seams.run(GH, recipe.argv);
    if (result.code !== 0) {
      return {
        recipe,
        skipped: false,
        issues: [],
        truncated: false,
        // The failure is CARRIED, not swallowed. A pass that errored found
        // nothing, and "found nothing" and "could not look" must never read the
        // same in a report whose conclusion is "no duplicate exists".
        error: outputLines(result.stderr).join(" ") || `exit ${result.code}`,
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

// ============================================================================
// --- the absorbed dedupe -----------------------------------------------------
//
// PORTED FROM bankai-core `scripts/dedupe_handbook_questions.sh` (zheref/nen#4,
// Akatsuki migration P1). The script existed and was never invoked by anything
// in that repository; its logic is not lost -- it is exactly the exact-title
// half of this search, and is absorbed here rather than shipped as a separate
// verb. The comment blocks immediately below are the ORIGINAL's own, carried
// VERBATIM (BC-IS-#737): its module header, and each function's own comment
// ported onto its TypeScript equivalent (normalize_title -> normalizeTitle,
// find_canonical -> findCanonical). Only the case fold's IMPLEMENTATION
// deviates -- see asciiLower() below -- to match tr's own C-locale behaviour
// exactly rather than approximate it with JS's Unicode-aware toLowerCase().
// ============================================================================
// dedupe_handbook_questions.sh — CON-11's idempotent-filing guard for
// `bankai:handbook-question` issues (bankai-core#196).
//
// CON-11 already mandates search-before-file, but two agent runs finding the
// SAME handbook gap seconds apart both pass that search (neither sees the
// other's not-yet-created issue) and both file — a classic TOCTOU race. This is
// the deterministic, POST-HOC close of that race: whenever a new
// `bankai:handbook-question` issue is opened, compare its (normalized) title
// against every OTHER currently-open issue carrying that label. If an OLDER one
// already covers the same gap, close this new one as a duplicate and comment on
// the older (canonical) issue — collapsing concurrent filings to one open issue
// + a comment, exactly as CON-11 requires.
//
// This converges even without a lock: "canonical" is always the LOWEST issue
// number among current matches — a stable, order-independent computation over
// whatever the live open set is at run time. The reusable workflow additionally
// serializes every run repo-wide (a `concurrency:` group), which closes the
// last-mile race where two near-simultaneous opens each still see only
// themselves (search-before-file passing for both) — by the time the second
// run's dedupe pass executes, the first run has already landed.
//
// Pure logic (`normalize_title`, `find_canonical`) is unit-testable without a
// token; `main` is the thin `gh`-calling wrapper the reusable workflow invokes.
// ============================================================================
//
// DEVIATION FROM THE CARRIED TEXT ABOVE (declared here per this repository's
// own discipline: a deviation is reported where the reader sees it, not
// silently applied): the "reusable workflow" and its repo-wide `concurrency:`
// group are bankai-core's own CI wiring, which this port does not carry --
// nen's absorbed logic is the pure normalize_title/find_canonical half only
// (see "Pure logic..." above), never the `main` wrapper or its workflow. The
// last-mile race the concurrency group closes is therefore NOT closed by
// nen's port; the TOCTOU race the paragraph names as its whole reason for
// existing is narrowed, not fully closed, by this absorption.
// ============================================================================

// --- normalize_title TITLE -----------------------------------------------------
// Lowercases, collapses everything that isn't a-z/0-9 into single spaces, and
// trims — a deliberately simple, deterministic key. This is NOT semantic
// dedup (two differently-worded reports of the same underlying gap won't
// match) — it targets the race this guards against, where two runs of the SAME
// agent finding the SAME gap in the SAME session tend to title it identically
// or near-identically.
//
// IMPLEMENTATION DEVIATION FROM THE ORIGINAL, reported rather than silent: the
// shell's `tr '[:upper:]' '[:lower:]'` is ASCII-only in the C locale, touching
// ONLY A-Z; JavaScript's `String.toLowerCase()` is Unicode-aware. A title
// carrying U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE, e.g. "İstanbul")
// reaches the punctuation-stripping pass untouched under `tr` and is stripped
// as punctuation, while `.toLowerCase()` expands it to "i" plus a COMBINING
// DOT ABOVE (U+0307) -- a different codepoint sequence that would silently
// miss a duplicate the original always caught. asciiLower() below replicates
// `tr`'s exact C-locale mapping instead, found necessary and verified by the
// imported corpus slice (tests/fixtures/dualrun-slice/dedupe/
// non-ascii-uppercase-survives-the-lowercaser.json).
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter): string => letter.toLowerCase());
}

export function normalizeTitle(title: string): string {
  return asciiLower(title)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface Candidate {
  readonly number: number;
  readonly title: string;
}

// --- find_canonical NEW_NUMBER NEW_TITLE ---------------------------------------
// Reads TSV `number<TAB>title` on stdin (every currently-open
// bankai:handbook-question issue, INCLUDING the new one). Echoes the lowest
// issue number strictly less than NEW_NUMBER whose normalized title matches
// NEW_TITLE's — the canonical issue this NEW_NUMBER duplicates — or nothing if
// NEW_NUMBER is itself canonical (no older match).
//
// PORT NOTE: the shell reads its candidate set off stdin as TSV; this takes it
// as an already-parsed `Candidate[]` instead (../issue/search.ts's own
// `runSearch` supplies it from gh's typed --json output), so there is no TSV
// field-splitting step to port at all -- see tests/fixtures/dualrun-slice/
// MANIFEST.json for the fixtures that pin exactly that shell-specific parsing
// and are excluded here for having no nen equivalent to replay against.
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
