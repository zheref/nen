// ============================================================================
// SEEDED FROM bankai-core `cli/src/github/parse.ts` (zheref/nen#1, Akatsuki migration P1).
//
// The header below this block is the ORIGINAL's, carried VERBATIM. It is not
// decoration: every WHY in it names a production incident, and a port that
// arrives without the explanation of why a branch exists is a port whose next
// maintainer "simplifies" it back into the bug (the BC-IS-#737 discipline).
// Only file PATHS have been rewritten, because this repository has no `cli/`
// subdirectory -- nen IS the CLI. References to bankai-core's own scripts,
// workflows and clause IDs are left alone: they are accurate statements about
// the system this code came from and where its reasoning is recorded.
// ============================================================================
// src/github/parse.ts -- the validating boundary between raw GitHub JSON and
// the typed domain model (BC-IS-#736, epic BC-IS-#733 Phase 1).
//
// THE SINGLE BIGGEST CORRECTNESS WIN OF THE MIGRATION, and the reason this file
// is separate from the predicates that consume it. In shell, a rollup entry
// reaches a verdict through `(.conclusion // .state // "")`: if GitHub renames a
// field, drops one, or answers `null` where it used to answer a value, jq does
// not fail -- it produces `""`, and `""` flows into a predicate that was written
// assuming a verdict was there. That is precisely how an absent answer reads as
// a present one. Here a shape that is not the shape we modelled produces a
// PARSE ERROR naming the field and the value, and a parse error is not a
// verdict: a caller must decide what to do with it, and the only safe decision
// for a readiness gate is not-ready. It can no longer be mistaken for green,
// because it is not a boolean.
//
// Errors are RETURNED, never thrown. Bad input from the network is expected
// input, not an exceptional condition -- a `catch` an author forgot to write is
// the same silent failure in a different costume.
//
// Two spellings are accepted for the PR-level fields, and only two, each named
// explicitly below: gh's `pr view --json` camelCase, and the flattened
// snake_case state blob `scripts/pr_ready_gate.sh`'s `fetch_pr_state` emits
// (which every replay fixture and every bats case is written in). Accepting
// both is NOT a `//` fallback chain of the kind this module exists to remove:
// each alternative is a named, documented shape, and the absence of ALL of them
// is an error rather than a default.

import type {
  CheckConclusion,
  CheckRun,
  CheckStatus,
  MergeableState,
  PullRequest,
  Review,
  ReviewRequest,
  ReviewState,
  ReviewThread,
  RollupEntry,
  StatusContext,
  StatusContextState,
} from "./types.js";

// --- result type -------------------------------------------------------------

export interface ParseError {
  // A JSON-ish pointer to the offending value, e.g. `$.checks[3].conclusion`.
  // The path is the whole value of an error message here: "expected one of ..."
  // without WHERE sends a reader back to a 400-entry rollup to find it.
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ParseError };

export function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function fail<T>(path: string, message: string): ParseResult<T> {
  return { ok: false, error: { path, message } };
}

// --- primitive readers -------------------------------------------------------

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

// An ABSENT field and an explicitly-null one are the same thing to us: GitHub
// omits what it has no value for in REST and sends `null` in GraphQL, and no
// predicate in the gate distinguishes them.
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): ParseResult<string | null> {
  const value = record[key];
  if (isAbsent(value)) return ok(null);
  if (typeof value !== "string") {
    return fail(`${path}.${key}`, `expected a string, got ${describe(value)}`);
  }
  return ok(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): ParseResult<string> {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    return fail(
      `${path}.${key}`,
      `expected a non-empty string, got ${describe(value)}`,
    );
  }
  return ok(value);
}

// A member of a closed union, or `null` when the field is absent.
//
// An UNRECOGNISED value is an error, not a silent "not green". GitHub adding a
// conclusion we have never seen is exactly the shape change this module exists
// to surface: the shell would have read it through `//` as not-green and said
// nothing, which is conservative but silent, and a gate that cannot explain
// itself is the failure class bankai-core#639/#698 are both about.
function optionalEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed: ReadonlySet<string>,
): ParseResult<T | null> {
  const value = record[key];
  if (isAbsent(value)) return ok(null);
  if (typeof value !== "string" || !allowed.has(value)) {
    return fail(
      `${path}.${key}`,
      `expected one of ${[...allowed].join("|")}, got ${describe(value)}`,
    );
  }
  return ok(value as T);
}

function requiredEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  path: string,
  allowed: ReadonlySet<string>,
): ParseResult<T> {
  const value = record[key];
  if (typeof value !== "string" || !allowed.has(value)) {
    return fail(
      `${path}.${key}`,
      `expected one of ${[...allowed].join("|")}, got ${describe(value)}`,
    );
  }
  return ok(value as T);
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing (the field is absent)";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `${typeof value} (${JSON.stringify(value)})`;
}

// The FIRST failure aborts the whole array.
//
// Deliberately not "parse what we can and drop the rest": a rollup that parsed
// mostly is not a rollup a readiness claim can be made on -- the dropped entry
// is exactly the one that might not have been green (bankai-core#671: an entry
// that never reported is not evidence that checks passed).
//
// --- FORWARD OBLIGATION for BC-IS-#737 (Phase 2 composition) -----------------
//
// RECORDED, NOT IMPLEMENTED -- this module authors no verdicts, and the mapping
// below is a readiness decision. It is written down because the verification
// pass found nothing recording it as binding (BC-PR-#802).
//
// EVERY ParseError MUST BECOME not-ready, WITH A LOUD REASON. The abort above
// means one unparseable entry in a 400-entry rollup takes the WHOLE array with
// it, and a ParseError is not a verdict -- it is neither ready nor not-ready
// until a caller decides. scripts/pr_ready_gate.sh's contract is that
// `--verdict` ALWAYS emits `ready` or `not-ready`, and an ABSENT verdict is the
// one outcome it must never produce: BC-PR-#745 is exactly that failure, a crash
// mid-evaluation leaving the caller with no answer to read, which every consumer
// then interprets however its own error handling happens to. So the composition
// phase must catch ParseError at the boundary and emit not-ready carrying
// `error.path` and `error.message` verbatim -- not-ready because "we could not
// read the evidence" is never evidence of readiness, and loud because a
// not-ready whose reason is a shape change wants a machinery fix, not a re-run,
// and the two are indistinguishable without the path (bankai-core#639/#698).
//
// AND THE SLICES MUST BE GATED IN ORDER, PR NODE FIRST. parseReviewRequests()
// maps an absent list to `[]` -- the shell's `.review_requests // []`, correct
// for a PR that genuinely has no pending request -- but a response GitHub
// blanked entirely also arrives as absent, and an empty request list means NO
// round is owed by pendingRounds()' limb (i). That is the permissive direction,
// and review requests are the only slice with the property: an absent rollup
// parses to the empty array that is never green (bankai-core#671), and an absent
// PR node fails outright. So the composition phase must establish that
// parsePullRequest() succeeded on the SAME snapshot before it trusts the request
// list, rather than parsing the three slices independently and believing
// whichever ones happened to parse.
function parseEach<T>(
  raw: unknown,
  path: string,
  parseItem: (item: unknown, itemPath: string) => ParseResult<T>,
): ParseResult<T[]> {
  if (!Array.isArray(raw)) {
    return fail(path, `expected an array, got ${describe(raw)}`);
  }
  const parsed: T[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const result = parseItem(raw[index], `${path}[${index}]`);
    if (!result.ok) return fail(result.error.path, result.error.message);
    parsed.push(result.value);
  }
  return ok(parsed);
}

// --- closed unions -----------------------------------------------------------

const CHECK_CONCLUSIONS: ReadonlySet<string> = new Set<CheckConclusion>([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
]);

const CHECK_STATUSES: ReadonlySet<string> = new Set<CheckStatus>([
  "COMPLETED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
]);

const STATUS_CONTEXT_STATES: ReadonlySet<string> = new Set<StatusContextState>([
  "ERROR",
  "EXPECTED",
  "FAILURE",
  "PENDING",
  "SUCCESS",
]);

const REVIEW_STATES: ReadonlySet<string> = new Set<ReviewState>([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);

const MERGEABLE_STATES: ReadonlySet<string> = new Set<MergeableState>([
  "CONFLICTING",
  "MERGEABLE",
  "UNKNOWN",
]);

// --- rollup entries ----------------------------------------------------------

// Which of the two rollup shapes is this?
//
// `__typename` when GraphQL supplied it (gh does, on statusCheckRollup nodes),
// and otherwise the structural tell: a CheckRun is the thing that has a
// `conclusion`/`status`/`detailsUrl`, a StatusContext the thing that has a
// `state`/`context`/`targetUrl`. An entry with NEITHER tell is not one of the
// two shapes we model, and saying so is the entire job of this module -- the
// alternative is to treat it as a CheckRun with a null conclusion, i.e. to
// invent an in-flight run that GitHub never reported.
function parseRollupEntry(raw: unknown, path: string): ParseResult<RollupEntry> {
  if (!isRecord(raw)) {
    return fail(path, `expected a check-rollup entry object, got ${describe(raw)}`);
  }
  const typename = raw["__typename"];
  const looksLikeCheckRun =
    typename === "CheckRun" ||
    (typename === undefined &&
      ("conclusion" in raw || "status" in raw || "detailsUrl" in raw));
  const looksLikeStatusContext =
    typename === "StatusContext" ||
    (typename === undefined &&
      ("state" in raw || "context" in raw || "targetUrl" in raw));

  if (looksLikeCheckRun) return parseCheckRun(raw, path);
  if (looksLikeStatusContext) return parseStatusContext(raw, path);
  return fail(
    path,
    "expected a CheckRun (conclusion/status/detailsUrl) or a StatusContext (state/context/targetUrl); this entry carries neither, so its verdict cannot be read",
  );
}

function parseCheckRun(
  record: Record<string, unknown>,
  path: string,
): ParseResult<CheckRun> {
  const name = optionalString(record, "name", path);
  if (!name.ok) return fail(name.error.path, name.error.message);
  const status = optionalEnum<CheckStatus>(record, "status", path, CHECK_STATUSES);
  if (!status.ok) return fail(status.error.path, status.error.message);
  const conclusion = optionalEnum<CheckConclusion>(
    record,
    "conclusion",
    path,
    CHECK_CONCLUSIONS,
  );
  if (!conclusion.ok) return fail(conclusion.error.path, conclusion.error.message);
  const startedAt = optionalString(record, "startedAt", path);
  if (!startedAt.ok) return fail(startedAt.error.path, startedAt.error.message);
  const completedAt = optionalString(record, "completedAt", path);
  if (!completedAt.ok) return fail(completedAt.error.path, completedAt.error.message);
  const detailsUrl = optionalString(record, "detailsUrl", path);
  if (!detailsUrl.ok) return fail(detailsUrl.error.path, detailsUrl.error.message);

  return ok({
    kind: "check_run",
    name: name.value,
    status: status.value,
    conclusion: conclusion.value,
    startedAt: startedAt.value,
    completedAt: completedAt.value,
    detailsUrl: detailsUrl.value,
  });
}

function parseStatusContext(
  record: Record<string, unknown>,
  path: string,
): ParseResult<StatusContext> {
  const context = optionalString(record, "context", path);
  if (!context.ok) return fail(context.error.path, context.error.message);
  const state = optionalEnum<StatusContextState>(
    record,
    "state",
    path,
    STATUS_CONTEXT_STATES,
  );
  if (!state.ok) return fail(state.error.path, state.error.message);
  const startedAt = optionalString(record, "startedAt", path);
  if (!startedAt.ok) return fail(startedAt.error.path, startedAt.error.message);
  const completedAt = optionalString(record, "completedAt", path);
  if (!completedAt.ok) return fail(completedAt.error.path, completedAt.error.message);
  const targetUrl = optionalString(record, "targetUrl", path);
  if (!targetUrl.ok) return fail(targetUrl.error.path, targetUrl.error.message);

  return ok({
    kind: "status_context",
    context: context.value,
    state: state.value,
    startedAt: startedAt.value,
    completedAt: completedAt.value,
    targetUrl: targetUrl.value,
  });
}

// `statusCheckRollup`, whole.
//
// `null`/absent parses to the EMPTY array on purpose. GitHub answers
// `statusCheckRollup: null` for a PR with no runs at all -- a real state, not a
// shape change (bankai-core#671, and the crash that made the gate emit no
// verdict at all when that null met `map(select(...))`, BC-PR-#745). The empty
// array is not a green rollup and never becomes one: checksAllGreen() opens with
// a non-empty test precisely so "nothing reported" stays "no signal".
export function parseCheckRollup(
  raw: unknown,
  path = "$.statusCheckRollup",
): ParseResult<RollupEntry[]> {
  if (isAbsent(raw)) return ok([]);
  return parseEach(raw, path, parseRollupEntry);
}

export function parseRollupEntries(
  raw: unknown,
  path = "$.checks",
): ParseResult<RollupEntry[]> {
  return parseCheckRollup(raw, path);
}

// --- reviews -----------------------------------------------------------------

// Two shapes, both real in this repo: the REST review object (`user.login`,
// `commit_id`, `submitted_at`), which the machinery reads because it is the only
// source of `commit_id`, and the flattened `{author,state,commit_id,
// submitted_at}` blob `fetch_pr_state` emits and every fixture is written in.
export function parseReview(raw: unknown, path = "$"): ParseResult<Review> {
  if (!isRecord(raw)) {
    return fail(path, `expected a review object, got ${describe(raw)}`);
  }
  let author: string;
  if ("author" in raw) {
    const flattened = requiredString(raw, "author", path);
    if (!flattened.ok) return fail(flattened.error.path, flattened.error.message);
    author = flattened.value;
  } else {
    const user = raw["user"];
    if (!isRecord(user)) {
      return fail(
        `${path}.user`,
        `expected the REST review's user object (or a flattened .author string), got ${describe(user)}`,
      );
    }
    const login = requiredString(user, "login", `${path}.user`);
    if (!login.ok) return fail(login.error.path, login.error.message);
    author = login.value;
  }

  const state = requiredEnum<ReviewState>(raw, "state", path, REVIEW_STATES);
  if (!state.ok) return fail(state.error.path, state.error.message);
  // Nullable, not required: a PENDING review has no commit and no submission
  // time. It also cannot satisfy CON-16's current-head rule, which compares
  // `commitId` to the head SHA -- and `null` compares equal to no SHA.
  const commitId = optionalString(raw, "commit_id", path);
  if (!commitId.ok) return fail(commitId.error.path, commitId.error.message);
  const submittedAt = optionalString(raw, "submitted_at", path);
  if (!submittedAt.ok) return fail(submittedAt.error.path, submittedAt.error.message);

  return ok({
    author,
    state: state.value,
    commitId: commitId.value,
    submittedAt: submittedAt.value,
  });
}

export function parseReviews(raw: unknown, path = "$.reviews"): ParseResult<Review[]> {
  if (isAbsent(raw)) return ok([]);
  return parseEach(raw, path, parseReview);
}

// --- review threads ----------------------------------------------------------

// `isResolved` is REQUIRED and never defaulted. CON-32(d)'s boundary is "zero
// unresolved", so a thread whose resolution we could not read must not be
// silently counted as resolved -- the shell takes the same stance from the other
// direction, falling back to a count of 1 (not-ready) whenever a page cannot be
// established.
export function parseReviewThread(
  raw: unknown,
  path = "$",
): ParseResult<ReviewThread> {
  if (!isRecord(raw)) {
    return fail(path, `expected a review-thread object, got ${describe(raw)}`);
  }
  const id = optionalString(raw, "id", path);
  if (!id.ok) return fail(id.error.path, id.error.message);
  const isResolved = raw["isResolved"];
  if (typeof isResolved !== "boolean") {
    return fail(
      `${path}.isResolved`,
      `expected a boolean, got ${describe(isResolved)}`,
    );
  }
  return ok({ id: id.value, isResolved });
}

export function parseReviewThreads(
  raw: unknown,
  path = "$.reviewThreads.nodes",
): ParseResult<ReviewThread[]> {
  if (isAbsent(raw)) return ok([]);
  return parseEach(raw, path, parseReviewThread);
}

// --- review requests ---------------------------------------------------------

// Three shapes, all real: gh's `{login}` for a user/bot, gh's `{name}` for a
// team, and the bare login STRING that `fetch_pr_state` flattens them to (and
// that every bats fixture and every gate consumer carries -- `"review_requests":
// ["Copilot"]`).
//
// A request naming NOBODY is an error rather than an empty login, because an
// empty login matches no reviewer pattern and would therefore silently drop the
// only pre-post footprint an un-posted Copilot round has (bankai-core#564).
export function parseReviewRequest(
  raw: unknown,
  path = "$",
): ParseResult<ReviewRequest> {
  if (typeof raw === "string") {
    if (raw === "") {
      return fail(path, "expected a reviewer login, got an empty string");
    }
    return ok({ login: raw, name: null });
  }
  if (!isRecord(raw)) {
    return fail(
      path,
      `expected a review-request object or a login string, got ${describe(raw)}`,
    );
  }
  const login = optionalString(raw, "login", path);
  if (!login.ok) return fail(login.error.path, login.error.message);
  const name = optionalString(raw, "name", path);
  if (!name.ok) return fail(name.error.path, name.error.message);
  if (login.value === null && name.value === null) {
    return fail(
      path,
      "expected a review request naming a login or a team name; this one names neither, so no reviewer could ever be matched to it",
    );
  }
  return ok({ login: login.value, name: name.value });
}

export function parseReviewRequests(
  raw: unknown,
  path = "$.review_requests",
): ParseResult<ReviewRequest[]> {
  if (isAbsent(raw)) return ok([]);
  return parseEach(raw, path, parseReviewRequest);
}

// --- pull request ------------------------------------------------------------

// Reads either spelling of each field (see the module header). `alias` order is
// gh's camelCase first, then the flattened snake_case state blob.
function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): ParseResult<string> {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return ok(value);
    if (!isAbsent(value) && typeof value !== "string") {
      return fail(`${path}.${key}`, `expected a string, got ${describe(value)}`);
    }
  }
  return fail(
    path,
    `expected a non-empty string at one of ${keys.map((key): string => `.${key}`).join(" / ")}`,
  );
}

export function parsePullRequest(
  raw: unknown,
  path = "$",
): ParseResult<PullRequest> {
  if (!isRecord(raw)) {
    return fail(path, `expected a pull-request object, got ${describe(raw)}`);
  }
  const number = raw["number"];
  if (typeof number !== "number" || !Number.isInteger(number)) {
    return fail(`${path}.number`, `expected an integer, got ${describe(number)}`);
  }
  const headSha = firstString(raw, ["headRefOid", "head_sha"], path);
  if (!headSha.ok) return fail(headSha.error.path, headSha.error.message);
  const baseRef = firstString(raw, ["baseRefName", "base_ref"], path);
  if (!baseRef.ok) return fail(baseRef.error.path, baseRef.error.message);
  const headRef = firstString(raw, ["headRefName", "head_ref"], path);
  if (!headRef.ok) return fail(headRef.error.path, headRef.error.message);
  const mergeable = requiredEnum<MergeableState>(
    raw,
    "mergeable",
    path,
    MERGEABLE_STATES,
  );
  if (!mergeable.ok) return fail(mergeable.error.path, mergeable.error.message);

  // The author is NULLABLE, and that is load-bearing: `gh pr view` degrades to
  // an empty author on a partial response, and the CON-40 delivery carve-out
  // (bankai-core#720) requires a `roy-bankai` author to WIDEN the gate. Absent
  // evidence must leave the ordinary at-head rounds binding, so it parses to
  // `null` rather than failing -- a degraded fetch that cannot be judged as a
  // delivery PR is a correct outcome, whereas a parse error here would take an
  // ordinary PR's verdict away with it.
  let author: string | null = null;
  const rawAuthor = raw["author"];
  if (typeof rawAuthor === "string") {
    author = rawAuthor === "" ? null : rawAuthor;
  } else if (isRecord(rawAuthor)) {
    const login = optionalString(rawAuthor, "login", `${path}.author`);
    if (!login.ok) return fail(login.error.path, login.error.message);
    author = login.value === "" ? null : login.value;
  } else if (!isAbsent(rawAuthor)) {
    return fail(`${path}.author`, `expected a login string or object, got ${describe(rawAuthor)}`);
  }

  // `.labels // []` -- absent labels are no labels. Both gh's `[{name}]` and the
  // flattened `["bankai:epic"]` are accepted.
  let labels: string[] = [];
  const rawLabels = raw["labels"];
  if (!isAbsent(rawLabels)) {
    const parsed = parseEach<string>(rawLabels, `${path}.labels`, (item, itemPath): ParseResult<string> => {
      if (typeof item === "string") return ok(item);
      if (isRecord(item)) return requiredString(item, "name", itemPath);
      return fail(itemPath, `expected a label name or object, got ${describe(item)}`);
    });
    if (!parsed.ok) return fail(parsed.error.path, parsed.error.message);
    labels = parsed.value;
  }

  const rawDraft = raw["isDraft"] ?? raw["draft"];
  if (!isAbsent(rawDraft) && typeof rawDraft !== "boolean") {
    return fail(`${path}.isDraft`, `expected a boolean, got ${describe(rawDraft)}`);
  }

  return ok({
    number,
    headSha: headSha.value,
    baseRef: baseRef.value,
    headRef: headRef.value,
    author,
    labels,
    mergeable: mergeable.value,
    isDraft: rawDraft === true,
  });
}
