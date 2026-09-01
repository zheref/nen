// ============================================================================
// SEEDED FROM bankai-core `cli/src/github/types.ts` (zheref/nen#1, Akatsuki migration P1).
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
// src/github/types.ts -- the typed GitHub domain model every later phase of
// the shell-to-TypeScript migration is written against (BC-IS-#736, epic
// BC-IS-#733 Phase 1).
//
// WHY THIS FILE EXISTS. The machinery reads GitHub through jq expressions that
// COALESCE an absent field into a value: `.conclusion // .state // ""`,
// `.name // ""`, `(.status // "COMPLETED")`, `.checks // []`. Every one of those
// `//` is a place where a null quietly becomes a datum, and the readiness gate's
// worst historical failures are exactly that: a value that was never reported
// reading as though it had been. Modelling the rollup as a DISCRIMINATED UNION
// -- a CheckRun that carries `.conclusion` (null while in flight) or a legacy
// StatusContext that carries `.state`, never both -- makes "no verdict yet" a
// state the type system forces every caller to handle, instead of a `//` away
// from "SUCCESS".
//
// Nothing here decides anything. The verdicts live in ../gates/predicates.ts,
// the boundary validation in ./parse.ts, the I/O in ./client.ts. This module is
// shapes and field accessors only, so that the ONE authority on a CON-32
// readiness claim (scripts/pr_ready_gate.sh today, BC-11 TypeScript after
// BC-IS-#733) keeps having exactly one place where a shape is interpreted.

// --- check rollup ------------------------------------------------------------

// A CheckRun's terminal verdict. The set is GitHub's `CheckConclusionState`
// enum, spelled as the GraphQL API (and therefore `gh pr view --json
// statusCheckRollup`) returns it: UPPER_SNAKE. scripts/pr_ready_gate.sh compares
// against these literal spellings and nothing else, so the union is deliberately
// NOT case-normalized here -- accepting a lowercase REST spelling as green would
// widen the gate by exactly the reading the shell never gave it.
export type CheckConclusion =
  | "ACTION_REQUIRED"
  | "CANCELLED"
  | "FAILURE"
  | "NEUTRAL"
  | "SKIPPED"
  | "STALE"
  | "STARTUP_FAILURE"
  | "SUCCESS"
  | "TIMED_OUT";

// A CheckRun's lifecycle state. Only COMPLETED is load-bearing for the gate: a
// reviewer's check satisfies a round only when it has COMPLETED, because an
// in-flight one has not said anything yet (bankai-core#577).
export type CheckStatus =
  | "COMPLETED"
  | "IN_PROGRESS"
  | "PENDING"
  | "QUEUED"
  | "REQUESTED"
  | "WAITING";

// A legacy StatusContext's state -- the commit-status API an external CI system
// still reports through. It has no `conclusion` and no lifecycle `status`; its
// `state` IS its verdict, which is why every predicate that asks "what did this
// entry conclude" has to consult two different fields.
export type StatusContextState =
  | "ERROR"
  | "EXPECTED"
  | "FAILURE"
  | "PENDING"
  | "SUCCESS";

// A GitHub Actions check run in a PR's status-check rollup.
//
// `conclusion: null` is the whole point of the type: it is a run that has
// STARTED and not finished. The shell writes that state as `.conclusion //
// .state // ""` and every reader has to remember that "" is not a verdict; here
// it is `null` and the compiler remembers instead.
export interface CheckRun {
  readonly kind: "check_run";
  // `null` when the rollup entry carried no name at all. latestChecks() keeps
  // such entries in singleton groups rather than collapsing them into one
  // another (bankai-core#558/#564).
  readonly name: string | null;
  readonly status: CheckStatus | null;
  readonly conclusion: CheckConclusion | null;
  // ISO-8601. The ordering keys latestChecks() uses to find the LATEST run for a
  // check name; `null` sorts before every timestamp, matching jq's
  // `sort_by(.startedAt // "")`.
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  // `https://.../actions/runs/<RUN_ID>/job/<JOB_ID>` -- the only field that
  // names the Actions run an entry came from, and therefore the only thing
  // excludeCheckRun() can match on (CON-36 self-run carve-out,
  // bankai-core#708).
  readonly detailsUrl: string | null;
}

// A legacy commit status ("StatusContext") in the same rollup.
//
// It carries `targetUrl`, never `detailsUrl`, so it can never name an Actions
// run -- which is why excludeCheckRun() can never drop one, and that is correct:
// a commit status from an external CI system cannot be "this job"
// (bankai-core#708).
export interface StatusContext {
  readonly kind: "status_context";
  readonly context: string | null;
  readonly state: StatusContextState | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly targetUrl: string | null;
}

// One entry of `statusCheckRollup`. The rollup mixes both kinds, which is the
// reason the shell carries a `//` chain in every check predicate.
export type RollupEntry = CheckRun | StatusContext;

// --- reviews -----------------------------------------------------------------

export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

// A submitted review.
//
// `commitId` is why the machinery reads reviews over REST rather than through
// `gh pr view --json reviews`: CON-16's current-head rule needs to know WHICH
// commit a round was cast against, and the GraphQL-backed gh field does not
// expose it. A round on a superseded commit is stale, not an approval.
export interface Review {
  readonly author: string;
  readonly state: ReviewState;
  readonly commitId: string | null;
  // ISO-8601. The ordering key for "LATEST review per author"; `null` sorts
  // first, matching jq's `sort_by(.submitted_at)` on a missing field.
  readonly submittedAt: string | null;
}

// A review thread. CON-32(d) is "zero unresolved review threads", so
// `isResolved` is the only field the gate reads -- but a thread whose
// resolution could not be established must never be counted as resolved, which
// is why this is a plain boolean parsed from a REQUIRED field rather than one
// defaulted to `true`.
export interface ReviewThread {
  readonly id: string | null;
  readonly isResolved: boolean;
}

// A PENDING review request.
//
// It is the ONLY pre-post footprint a non-check reviewer has: Copilot is not a
// check run, so before it posts, a pending `reviewRequests` entry is the whole
// of the evidence that a round is owed. Missing that is how the gate read
// `ready` in the 69 seconds between an approval and Copilot's eight threads
// (bankai-core#564).
//
// `login` for a user/bot, `name` for a team -- gh returns one or the other,
// which is why the shell writes `(.login // .name // "")`.
export interface ReviewRequest {
  readonly login: string | null;
  readonly name: string | null;
}

// --- pull request ------------------------------------------------------------

// CON-42/1's added readiness predicate reads this: only MERGEABLE is
// conflict-free. UNKNOWN means GitHub has not finished computing the merge
// commit -- an absent answer, never a yes.
export type MergeableState = "CONFLICTING" | "MERGEABLE" | "UNKNOWN";

export interface PullRequest {
  readonly number: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
  // `null` when the API withheld it (a degraded fetch, an older payload).
  // Nullable rather than defaulted to a string, because every predicate that
  // reads the author uses it to WIDEN something -- the CON-40 delivery carve-out
  // requires a `roy-bankai` author -- and absent evidence must never widen a
  // gate (bankai-core#720).
  readonly author: string | null;
  readonly labels: readonly string[];
  readonly mergeable: MergeableState;
  readonly isDraft: boolean;
}

// --- rollup field accessors --------------------------------------------------
//
// These exist so that the shell's `//` chains appear ONCE each, named, instead
// of being retyped at every call site the way the jq idioms were. Each one is
// deliberately narrow, because the shell reads the same entry through THREE
// different field chains and the differences between them are load-bearing.

// `.name // .context` -- the display label used to GROUP entries by check name
// (latestChecks) and to name a check in a not-ready reason.
export function rollupEntryLabel(entry: RollupEntry): string | null {
  return entry.kind === "check_run" ? entry.name : entry.context;
}

// `.name` ALONE -- deliberately NOT falling back to `.context`.
//
// pending_rounds' check-satisfies-round rule matches `((.name // "") |
// test(...))`, so a legacy StatusContext can never satisfy a reviewer's round
// however it is named. That asymmetry with rollupEntryLabel() is preserved on
// purpose: a commit status from an external CI system is not bisky's or
// Bugbot's review job concluding silently.
export function rollupEntryCheckName(entry: RollupEntry): string | null {
  return entry.kind === "check_run" ? entry.name : null;
}

// `.conclusion // .state` -- the entry's effective verdict, or `null` when it
// has not produced one yet. `null` is never green and never a failure; it is a
// run still deciding (bankai-core#727).
export function rollupEntryStatus(
  entry: RollupEntry,
): CheckConclusion | StatusContextState | null {
  return entry.kind === "check_run" ? entry.conclusion : entry.state;
}

// `.detailsUrl // ""` -- always absent for a StatusContext, by construction.
export function rollupEntryDetailsUrl(entry: RollupEntry): string | null {
  return entry.kind === "check_run" ? entry.detailsUrl : null;
}

// THERE IS NO rollupEntryStartedAt/rollupEntryCompletedAt, deliberately. Both
// existed here and were referenced nowhere (BC-PR-#802 verification): the
// timestamps are declared identically on BOTH members of the union, so
// `entry.startedAt` reads straight through the discriminant and latestChecks()
// does exactly that. An accessor exists in this section only where the two
// members disagree -- that disagreement IS the shell's `//` chain, made explicit
// -- so a pass-through accessor would suggest a divergence that is not there.

// --- FORWARD OBLIGATION for BC-IS-#737 (Phase 2 composition) — DISCHARGED ----
//
// ANSWERED, in bankai-core cli/src/ports/pr_ready_gate.ts (BC-IS-#737 rank 1). The obligation
// below asked #737 to pick between two ways of feeding `is_delivery_pr` through
// PullRequest, and said "only picking one silently is not" defensible. The answer
// is a THIRD option, and the reasoning lives in that port's header:
// `parsePullRequest` is not reachable from this gate at all — it requires
// `number`, and the flattened state blob `fetch_pr_state` emits (the shape every
// bats case, every replay fixture and every consumer of the gate carries) has no
// `number` field. More decisively, the delivery evidence is five INDEPENDENTLY
// OPTIONAL fields whose ABSENCE IS MEANINGFUL: CON-40's carve-out WIDENS the
// gate, so a missing field must read as "not a delivery PR" and leave the
// ordinary at-head rounds binding. Routing them through a required-field parser
// would turn absent evidence into a parse error and, via ./parse.ts's own
// obligation, into a not-ready whose reason is a shape complaint rather than the
// truth. So the delivery evidence gets its own narrow, tolerant reader
// (`deliveryEvidence`) and the predicate its own input type
// (`DeliveryEvidence`, in ../gates/predicates.ts); PullRequest is deliberately
// LEFT ALONE.
//
// CORRECTION (zheref/nen#2's review record): the sentence this replaced read
// "`defaultBranchRef` stays uncarried on the wire", which was true when
// written and is FALSE now. That was this obligation's item 1 (below),
// answered separately and later than the is_delivery_pr question this note is
// about -- see the "DISCHARGED" annotation on item 1 for where the field
// actually travels. PullRequest itself is still untouched; the field was never
// going to be a field OF it (item 1 says so), only a sibling carried
// elsewhere.
//
// The original text is kept below verbatim, because a discharged obligation that
// erases the question it answered leaves the next reader unable to check the
// answer.
//
// RECORDED, NOT IMPLEMENTED. Phase 1 is additive and inert; extending the model
// speculatively would author shape no ported predicate has asked for yet (BC-6).
// This is written down because the verification pass found nothing that recorded
// it as binding, and a gap nobody wrote down is a gap Phase 2 rediscovers in
// production.
//
// THE MODEL CANNOT EXPRESS `is_delivery_pr`. scripts/pr_ready_gate.sh decides
// the CON-40 delivery carve-out (bankai-core#720) from the PR's refs, and
// PullRequest cannot supply the inputs:
//
//   1. NO DEFAULT BRANCH. ./graphql.ts's PULL_REQUEST_QUERY already selects
//      `defaultBranchRef { name }` -- it is fetched on every round trip -- but
//      it is a sibling of the `pullRequest` node, not a field of it, and
//      PullRequest has no `defaultBranch`. The normalizer therefore drops it on
//      the floor today. #737 must carry it through and add the field; nothing
//      else needs to change on the wire.
//      DISCHARGED (../github/graphql.ts, zheref/nen#2). `defaultBranch` is
//      carried on `PullRequestSnapshot` -- the sibling this paragraph asked
//      for, never a field of `PullRequest` (that stays exactly as described
//      two paragraphs up) -- populated by `normalizePullRequestResponse` from
//      `repository.defaultBranchRef.name`, `undefined` rather than `""` when
//      absent. ../gates/ready.ts's `deliveryEvidence()` reads it off the
//      flattened state blob as `state.default_branch`.
//   2. `headRef` IS REQUIRED HERE, OPTIONAL THERE. parsePullRequest() demands a
//      non-empty `headRefName`/`head_ref`, whereas the shell documents
//      `head_ref` as INDIVIDUALLY OPTIONAL and degrades one predicate rather
//      than losing the whole verdict. A degraded fetch that blanks only the head
//      ref currently costs the PR its entire parse -- which the composition
//      phase must then map to not-ready (see the ParseError obligation in
//      ./parse.ts). #737 decides which of the two it wants: nullable `headRef`
//      with the delivery reading declining, or the current all-or-nothing parse
//      plus a loud not-ready. Both are defensible; only picking one silently is
//      not.
