// ============================================================================
// SEEDED FROM bankai-core `cli/src/gates/predicates.ts` (zheref/nen#1, Akatsuki
// migration P1).
//
// The header below this block is the ORIGINAL's, carried VERBATIM, as is every
// per-predicate WHY in this file. That is the BC-IS-#737 discipline and it is
// not decoration: each comment names the production incident its branch exists
// for, and a predicate that arrives without its incident is one the next
// maintainer simplifies back into the bug.
//
// ONE THING CHANGED, AND IT CHANGED EVERYWHERE: the reviewer IDENTITIES this
// file used to hard-code are now DATA, supplied by the caller as a
// `GateIdentities` read from the target repository's `schemas/gates.json` (see
// ../schema/gates.ts). The Akatsuki migration's §3 makes that mandatory -- "no
// hard-coded personas, labels, check names, or colours" -- and §3 names this
// module by way of example: the `case "sasuke": return /^sasuke \/ audit$/i`
// arms, the `/(^|\/)roy-bankai(\[bot\])?$/` author pattern, the
// `labels.includes("bankai:epic")` test and the `["sasuke", "tenma",
// "copilot"]` default set were all names written into a binary.
//
// THE LOGIC IS UNCHANGED, and that is the property under test. Every branch,
// every ordering, every asymmetry and every conservative direction is exactly
// as it was; only the VALUES the branches compare against arrive from outside.
// The ported companion suite runs against a fixture that states this system's
// own identities, so any behavioural divergence from the original shows up as a
// failing assertion rather than as a difference nobody looked for -- and it runs
// the same structural cases a second time against a fixture with entirely
// different names, which is what makes "the names are data" a proved claim
// rather than an asserted one.
//
// WHERE A NAME BECAME A STRUCTURAL PROPERTY, the mapping is:
//   `case "copilot"` under the bounded policy -> `boundedPolicyExempt`
//   `name === "sasuke" || name === "tenma"`   -> `deliveryHolisticPass`
//   `name === "bisky" || name === "bugbot"`   -> a `roundCheckPattern` exists
//   the bisky/bugbot enrolment patterns       -> `enrolmentCheckPattern`
//   `reviewerLoginPattern`'s switch arms      -> `loginPattern`
//   `reviewerReviewCheckPattern`'s switch     -> `reviewCheckPattern`
//   `DEFAULT_APPROVERS`                       -> `defaultApprovers`
//   `defaultReviewers`' base set              -> `baseReviewers`
//   `ROY_AUTHOR` / `integration/` / the label -> `delivery.*`
// Each is named at its own call site too; this list is the index.
//
// Only file PATHS are otherwise rewritten. References to bankai-core's scripts,
// workflows and clause IDs are left alone: they are accurate about the system
// this code came from and about where its reasoning is recorded.
// ============================================================================
// src/gates/predicates.ts -- the CON-32 readiness predicates, ported from
// scripts/pr_ready_gate.sh's jq programs (BC-IS-#736, epic BC-IS-#733 Phase 1).
//
// PURE. Data in, verdict out: no gh, no network, no process spawning, no clock,
// no environment. Every predicate here is a function of its arguments alone, so
// that the thing which decides whether a PR is ready can be exercised
// exhaustively in vitest rather than against a live PR (BC-9).
//
// PHASE 1 IS ADDITIVE AND INERT (BC-IS-#736). Nothing in this file is wired into
// a workflow, a shim, or the CLI's argv. scripts/pr_ready_gate.sh remains the
// ONE place a CON-32 readiness claim is decided until a later phase retires it.
//
// THE COMMENTS ARE THE DELIVERABLE, not decoration (BC-IS-#737). Each predicate
// below exists because a specific failure happened, and the comment naming that
// failure is the only thing standing between a future maintainer and
// "simplifying" the predicate back into the bug. A migrated predicate arriving
// with no explanation of why it exists is a review finding. Every WHY here is
// carried across from the shell, with the issue number the shell cited.
//
// BC-6: this file authors NO policy. Every threshold, taxonomy value and reading
// below already exists in scripts/pr_ready_gate.sh; the reason names introduced
// for the structured results are labels for branches that are already there, not
// new categories. Message TEXT is deliberately absent -- the shell's reason
// strings belong to the gate's composition (`evaluate_ready`), which is a later
// phase's port, so these predicates return the FACTS and let the caller phrase
// them.

import {
  rollupEntryCheckName,
  rollupEntryDetailsUrl,
  rollupEntryLabel,
  rollupEntryStatus,
  type CheckConclusion,
  type CheckStatus,
  type Review,
  type ReviewRequest,
  type RollupEntry,
} from "../github/types.js";
// PORT ADDITION: the identities every reviewer-aware predicate below is now
// parameterised by. A TYPE-ONLY import -- these predicates stay pure and never
// read a file; the CALLER loads the target repository's `schemas/gates.json`
// and hands the result in.
import type { GateIdentities, ReviewerIdentity } from "../schema/gates.js";

// --- shared helpers ----------------------------------------------------------

// jq compares strings by codepoint; JavaScript's `<` compares by UTF-16 code
// unit. The two agree on every value these predicates order (ISO-8601
// timestamps, check names), and an explicit comparator keeps the ordering out of
// locale-sensitive `String.prototype.localeCompare`, which does NOT agree.
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// A case-insensitive regex built from a caller-supplied reviewer name, exactly
// as jq's `test($name; "i")` builds one.
//
// An INVALID pattern (a name carrying unbalanced regex metacharacters) yields a
// regex that matches NOTHING, which reproduces the shell's behaviour rather than
// diverging from it: there, `jq -e` errors, the `if` reads the non-zero exit as
// "no match", and the reviewer is therefore still owed a round. Conservative in
// the same direction -- a malformed reviewer name can never SATISFY a round, only
// fail to match one.
function safePattern(source: string): RegExp {
  try {
    return new RegExp(source, "i");
  } catch {
    return /(?!)/;
  }
}

// Literal-escape, for the one pattern assembled from an id rather than a name.
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `(.status // "COMPLETED")` -- a legacy StatusContext has no lifecycle status
// at all (a commit status IS its verdict, posted finished), so the shell's
// default treats it as COMPLETED. Preserved rather than "cleaned up": dropping
// the default would make every external CI status stop satisfying the round
// rules that read it.
function lifecycleStatus(entry: RollupEntry): CheckStatus {
  return entry.kind === "check_run" ? (entry.status ?? "COMPLETED") : "COMPLETED";
}

// `(.conclusion // "")` -- deliberately NOT `.conclusion // .state`.
//
// The bisky/bugbot round rule reads `.conclusion` ALONE, so a StatusContext's
// `state` can never make it look SKIPPED. That asymmetry with
// rollupEntryStatus() is in the shell and is preserved here on purpose; see
// pendingRounds().
function checkRunConclusion(entry: RollupEntry): CheckConclusion | null {
  return entry.kind === "check_run" ? entry.conclusion : null;
}

// --- latestChecks ------------------------------------------------------------
// Reduce a check rollup to ONE entry per check name.
//
// WHY IT EXISTS (bankai-core#558/#564): the rollup RETAINS superseded same-name
// runs. A concurrency-cancelled `kisuke / probe / probe` CANCELLED sits next to a
// later SUCCESS at the very same head, and any predicate reading the raw rollup
// reports not-ready forever.
//
// Selection within a name group, in order:
//   1. DISCARD CANCELLED entries **if any non-cancelled entry exists**. A
//      cancellation is how a concurrency group retires a SUPERSEDED attempt; it
//      is the ABSENCE of a verdict, not a failing one. If EVERY entry for a name
//      is cancelled the group is kept as-is, so a genuinely never-completed
//      check still reads not-green (conservative).
//   2. Of what remains, take the LATEST by startedAt, then completedAt. An
//      in-flight rerun therefore correctly supersedes an earlier SUCCESS -- work
//      is happening now and the gate must wait for it.
//
// Step 1 is not hypothetical and "latest by startedAt" alone is NOT enough:
// bankai-core#577's own head carried, for `kisuke / probe / probe`, a SUCCESS
// started 23:03:05Z followed by a CANCELLED started 23:03:19Z (five overlapping
// runs inside 90 seconds, cancelling each other). Ordering by time alone picks
// the cancelled one and reports not-ready forever -- the exact failure this
// function exists to prevent, re-introduced through the back door.
//
// Entries with NO name are never collapsed into one another: each takes its own
// singleton group keyed by its position, matching jq's
// `("anon-" + (.key|tostring))`. Groups are emitted in sorted key order, as
// jq's `group_by` does, so the reduction is deterministic for any caller that
// names checks in a message.
export function latestChecks(entries: readonly RollupEntry[]): RollupEntry[] {
  interface Positioned {
    readonly entry: RollupEntry;
    readonly index: number;
  }

  const groups = new Map<string, Positioned[]>();
  entries.forEach((entry, index): void => {
    const key = rollupEntryLabel(entry) ?? `anon-${index}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [{ entry, index }]);
    else group.push({ entry, index });
  });

  // The ordering key jq's `sort_by(.startedAt // "", .completedAt // "", .key)`
  // builds: an absent timestamp sorts as "", i.e. before every real one.
  const later = (a: Positioned, b: Positioned): Positioned => {
    const byStart = compareStrings(
      a.entry.startedAt ?? "",
      b.entry.startedAt ?? "",
    );
    if (byStart !== 0) return byStart > 0 ? a : b;
    const byEnd = compareStrings(
      a.entry.completedAt ?? "",
      b.entry.completedAt ?? "",
    );
    if (byEnd !== 0) return byEnd > 0 ? a : b;
    return a.index > b.index ? a : b;
  };

  const reduced: RollupEntry[] = [];
  for (const key of [...groups.keys()].sort(compareStrings)) {
    const group = groups.get(key);
    if (group === undefined || group.length === 0) continue;
    const live = group.filter(
      (member): boolean => rollupEntryStatus(member.entry) !== "CANCELLED",
    );
    const candidates = live.length > 0 ? live : group;
    const first = candidates[0];
    if (first === undefined) continue;
    reduced.push(candidates.reduce(later, first).entry);
  }
  return reduced;
}

// --- checksAllGreen ----------------------------------------------------------
// CON-32(a). True iff the rollup is NON-EMPTY and every entry's effective status
// on the LATEST run per name is SUCCESS / NEUTRAL / SKIPPED.
//
// AN EMPTY ARRAY IS NEVER GREEN (bankai-core#671). "No reported check" is not
// evidence that checks passed -- it is no signal at all, and it is a DIFFERENT
// finding from a red check: a red check wants a fix, an empty rollup wants a
// re-fire (BC-PR-#660 and BC-PR-#610 each sat 11 hours on a `startup_failure`
// that produced no job, no log and no check run). An in-flight run is not green
// either: its effective status is `null`, which is a run still deciding, not a
// pass (bankai-core#727).
//
// The reduction is applied INSIDE, as in the shell -- that is this predicate's
// contract and its callers rely on it.
const GREEN_STATUSES: ReadonlySet<string> = new Set([
  "SUCCESS",
  "NEUTRAL",
  "SKIPPED",
]);

export function checksAllGreen(entries: readonly RollupEntry[]): boolean {
  const latest = latestChecks(entries);
  if (latest.length === 0) return false;
  return latest.every((entry): boolean => {
    const status = rollupEntryStatus(entry);
    return status !== null && GREEN_STATUSES.has(status);
  });
}

// --- excludeCheckRun ---------------------------------------------------------
// The CON-36 self-run carve-out (bankai-core#708): drop every rollup entry whose
// `detailsUrl` names the given Actions run.
//
// WHY IT EXISTS. The CON-36 clause-3 READY-CHECK self-merge asks the authoring
// agent to consult the readiness gate FROM INSIDE its own job -- so its own
// check-rollup entry (e.g. `kisuke / build`) is necessarily still IN_PROGRESS
// while it asks, and checksAllGreen() can never clear. The mode is unsatisfiable
// by construction without this (observed live on BC-PR-#524, three-for-three on
// #519/#523/#534 per BC-IS-#542).
//
// It is OPT-IN and NARROW by construction. A CheckRun's detailsUrl is
// `https://.../actions/runs/<RUN_ID>/job/<JOB_ID>`, so matching
// `/actions/runs/<RUN_ID>(/|$)` identifies every entry that run produced,
// however many jobs or attempts it posted -- and NOTHING else. Never a
// name-prefix or job-name guess, so a job merely being NAMED `naruto`/`kisuke`/
// `yamamoto` does not exempt it. A legacy StatusContext carries `targetUrl`,
// never `detailsUrl`, so it is never excluded, which is correct: a commit status
// from an external CI system cannot be "this job". An absent run id is the
// identity function, so every caller that never passes one (Roy's merge gates,
// the ITERATE loops, Ichigo, the backlog-loop) is unaffected.
//
// THE SECURITY PREMISE, carried across from the shell because it explains the
// shape of the whole feature: the caller passes its own `github.run_id`, and an
// authoring agent is documented to ingest untrusted PR/issue/review-comment text
// as instructions -- so a value it merely emits from a tool call is NOT
// trustworthy on its own. A successful prompt injection substituting a
// DIFFERENT, still-legitimately-blocking check's run id would otherwise drop
// that check from CON-32(a) and report a false `ready`. The defence is to
// cross-check the value against the job's own `$GITHUB_RUN_ID` -- which belongs
// to the CALLER (the shell does it in `main`), not to this pure predicate, and
// must not be forgotten when this is finally wired: a predicate that cannot see
// the environment cannot perform that check for you.
//
// The run id is literal-escaped before it becomes a pattern. The shell
// interpolates it raw and relies on `main`'s numeric validation upstream; here
// the validation is likewise the caller's, so escaping guarantees a non-numeric
// id can only ever match LESS, never more. It cannot widen the exclusion.
export function excludeCheckRun(
  entries: readonly RollupEntry[],
  runId: string | null | undefined,
): RollupEntry[] {
  if (runId === null || runId === undefined || runId === "") return [...entries];
  const pattern = new RegExp(`/actions/runs/${escapeRegExp(runId)}(/|$)`);
  return entries.filter((entry): boolean => {
    const detailsUrl = rollupEntryDetailsUrl(entry);
    return detailsUrl === null || !pattern.test(detailsUrl);
  });
}

// --- normalizeReviewers ------------------------------------------------------
// Trim every name in a reviewer list, drop the empties, preserve order.
//
// WHY IT EXISTS (Copilot review, bankai-core#577): a caller writing the natural
// `--reviewers "sasuke, tenma, copilot"` otherwise yields `" tenma"` -- and
// " tenma" matches no login and no check, so that reviewer is silently treated
// as never having posted a round and the PR is pinned not-ready with no path
// out. The failure is silent in the worst way: the reviewer NAME still appears
// in the owed list, so the reader chases a review that was posted.
//
// THIS IS THE DESIGNATED PLACE TRIMMING HAPPENS, and the only one. The shell
// trims HERE (`normalize_reviewers`) and inside `pending_rounds`, which calls
// it; it does NOT trim in `reviews_all_approved_at_head` or
// `unapproved_approvers`, which split the CSV with `split(",") | map(select(
// length > 0))` -- empties dropped, whitespace kept. Those two therefore use
// shellApproverNames() below, not this function. Concentrating the trim in one
// named place is #577's own fix; spreading it further changes what the gate
// accepts.
// WHAT IT TRIMS, AND WHY NOT `.trim()` (bankai-core#826).
//
// The shell trims with `sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'`, and
// POSIX `[[:space:]]` in the C locale is EXACTLY six ASCII characters:
// space, \t, \n, \v, \f, \r. JavaScript's `.trim()` strips the whole Unicode
// White_Space set -- U+00A0, U+2007, U+202F, the U+2000..U+200A run, and more.
//
// That difference ran in the PERMISSIVE direction, which is the one that
// matters. Given a reviewer name carrying a trailing non-breaking space:
//
//   shell -- keeps "sasuke\u00A0", which matches no login and no case arm, so
//            the CON-40 delivery branch is never entered and the name falls
//            through to `pending+=(... no round at head)` -> NOT-READY.
//   .trim() -- yields "sasuke", matches `sasuke-bankai[bot]`, enters the
//            delivery branch -> READY.
//
// A port that reads READY where its source reads NOT-READY is the one class of
// divergence that cannot be allowed to ship, and CON-42/1 keeps the shell as
// the single readiness authority until it is retired.
//
// FIDELITY, NOT IMPROVEMENT (BC-6). Trimming a non-breaking space is arguably
// better behaviour. Adopting it HERE would be this file authoring policy: the
// shell is the specification, and a port that silently improves is as much a
// divergence as one that regresses. If the better behaviour is wanted it is a
// deliberate change to BOTH implementations, reviewed as a behaviour change.
//
// Note the shape of the miss: the comment on `shellApproverNames` below already
// names this exact failure class -- "the ONE divergence in this port that makes
// the gate MORE PERMISSIVE than the shell" -- twelve lines from here. The author
// was hunting it, got the approver list right, and missed this function. Reading
// is not a reliable way to answer "did the port change behaviour?"; that is what
// bankai-core#735's dual-run harness is for.
const POSIX_SPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

export function normalizeReviewerNames(names: readonly string[]): string[] {
  return names
    .map((name): string => name.replace(POSIX_SPACE, ""))
    .filter((name): boolean => name.length > 0);
}

export function normalizeReviewers(csv: string | null | undefined): string[] {
  if (csv === null || csv === undefined) return [];
  return normalizeReviewerNames(csv.split(","));
}

// `split(",") | map(select(length > 0))` -- the approver-list handling of
// scripts/pr_ready_gate.sh's `reviews_all_approved_at_head` and
// `unapproved_approvers`, verbatim: DROP the empties, do NOT trim.
//
// The trim belongs to normalizeReviewers() (#577) and stops there. Doing it here
// too would be the ONE divergence in this port that makes the gate MORE
// PERMISSIVE than the shell (BC-PR-#802 verification): with approvers
// "sasuke, tenma" both approving at head, a trimming version reads APPROVED
// while the shell reads NOT_APPROVED, because the shell asks whether any author
// matches the literal pattern " tenma" and none does. Unreachable today --
// `evaluate_ready` pre-normalizes before it calls either predicate -- but these
// are exported APIs now, and a widened gate reachable only by a future caller is
// still a widened gate. Faithfulness beats convenience in the permissive
// direction; a caller that wants trimming calls normalizeReviewers() first,
// exactly as evaluate_ready does.
function shellApproverNames(approvers: readonly string[]): string[] {
  return approvers.filter((name): boolean => name.length > 0);
}

// --- reviewerLoginPattern ----------------------------------------------------
// The login regex (case-insensitive) a configured reviewer NAME posts under.
//
// The two exceptions are not stylistic: Copilot posts as
// `copilot-pull-request-reviewer[bot]` and Cursor's Bugbot posts under a login
// carrying `cursor` OR `bugbot` depending on the installation, so a reviewer
// configured as `bugbot` must match either. Every other name matches itself,
// unanchored, which is what lets `sasuke` match `sasuke-bankai[bot]`.
//
// PORT CHANGE (§3): the switch arms were the two exceptions written into the
// binary; each is now that reviewer's `login_pattern` in the target repository's
// `schemas/gates.json`. THE FALL-THROUGH IS KEPT, and it is not a fallback of
// the kind ../schema/errors.ts refuses: it applies to a name the file does NOT
// declare, and it reproduces the original's `default:` arm exactly -- an
// undeclared reviewer matches itself, case-insensitively, and an unparseable one
// matches nothing. Reproducing it matters because a caller may pass
// `--reviewers` a name the registry has never heard of, and the original's
// answer to that is "treat it as its own login", not "crash".
export function reviewerLoginPattern(identities: GateIdentities, name: string): RegExp {
  return identities.reviewer(name)?.loginPattern ?? safePattern(name);
}

// --- reviewerReviewCheckPattern ----------------------------------------------
// The check-rollup name regex for the REVIEW job of a configured reviewer -- the
// check CON-40's abstain-green disposition reports through (bankai-core#720).
//
// A rollup entry is `<caller job id> / <called job id>`: the caller job is
// `sasuke` / `tenma` in bankai.yml and in every consumer, and the called job id
// is the reviewer workflow's own review job -- `audit` in sasuke-review.yml,
// `review` in tenma-review.yml and bisky-review.yml.
//
// It must be the REVIEW job specifically, NEVER a name prefix: `sasuke / probe /
// probe` is the runner probe and is green on every PR whether or not the review
// ever ran, so `^sasuke / ` would let a delivery PR clear its CON-40 round on a
// check that says nothing about review. An unknown name yields `null`, and every
// caller treats that as "no check can satisfy this reviewer".
//
// PORT CHANGE (§3): the three arms are now each reviewer's
// `review_check_pattern`. The `default: null` becomes "the file declares none",
// which reaches every caller as the same `null` and therefore the same reading
// -- no check can satisfy this reviewer's round. That direction is the
// conservative one and is preserved deliberately: a repository that forgets to
// declare a reviewer's review check gets a gate that stays SHUT, never one that
// clears on a check nobody identified.
export function reviewerReviewCheckPattern(
  identities: GateIdentities,
  name: string,
): RegExp | null {
  return identities.reviewer(name)?.reviewCheckPattern ?? null;
}

// --- reviewsAllApprovedAtHead ------------------------------------------------
// CON-32(b), approve limb. True iff EVERY named approver's LATEST review (by
// submitted_at) is an APPROVE against the CURRENT head.
//
// CON-16's current-head rule is the whole point: a round on a superseded commit
// is STALE, not an approval. A single approver is insufficient -- only ALL named
// approvers approved-at-head passes. Non-approving reviewers (Copilot's
// COMMENTED rounds, Bugbot) are not iterated here; pendingRounds() is where
// their round is owed, and an empty review array can therefore never satisfy
// this predicate.
//
// DELIVERY-PR CARVE-OUT (bankai-core#720) drops the at-head requirement for
// SASUKE and TENMA only. On a CON-40 delivery PR their one holistic pass is cast
// on `opened` and deliberately never re-cast, so an APPROVE at head is
// unreachable BY DESIGN after the first `synchronize` -- without the carve-out an
// epic delivery PR reads not-ready forever, a gate the machine can never pass,
// which inverts it onto the human (KP-PR-#460). What is NOT dropped: their
// LATEST round must still BE an APPROVE. A holistic pass that ended
// CHANGES_REQUESTED, followed by a fix commit the reviewer then abstained on,
// stays not-ready -- an abstain carries no verdict about the fix. BISKY keeps the
// at-head requirement in full: it is not a CON-40 reviewer, does not abstain,
// and joins the approver set only once it has posted AT head anyway.
//
// The approver name is matched RAW here (`test($name; "i")`), not through
// reviewerLoginPattern(). That asymmetry is the shell's and is preserved: the
// approver set is only ever sasuke/tenma/bisky, each of which matches its own
// login, so the two idioms coincide in practice -- and "fixing" the asymmetry
// would silently change which logins can approve.
//
// The approver names are likewise NOT TRIMMED here, for the same reason and in
// the same direction: the shell's `split(",") | map(select(length > 0))` drops
// empties and keeps whitespace, so `" tenma"` is asked for literally and matches
// nobody. Trimming would turn a shell NOT_APPROVED into an APPROVED -- the one
// way this port could read MORE permissively than the thing it replaces
// (BC-PR-#802 verification). normalizeReviewers() is where trimming lives
// (#577); see shellApproverNames().

// The shell's `${2:-sasuke,tenma}`: CON-32(b)'s approval set, with `bisky`
// joining it where configured. Carried across verbatim, not chosen here.
//
// PORT CHANGE (§3): the two names were a constant in the binary and are now
// `default_approvers` in the target repository's `schemas/gates.json`. The
// accessor takes the identities rather than exporting an array, because an
// exported array would have to be SOMETHING when no repository has been read --
// and whatever it was would be a hard-coded approver set with a different name.
export function defaultApprovers(identities: GateIdentities): readonly string[] {
  return identities.defaultApprovers;
}

// `group_by(.author) | map(sort_by(.submitted_at) | last)` -- the LATEST review
// per author. An absent submitted_at sorts first, as jq's null does, so a review
// with no timestamp can never displace a timestamped one.
function latestReviewPerAuthor(reviews: readonly Review[]): Review[] {
  const byAuthor = new Map<string, Review[]>();
  for (const review of reviews) {
    const group = byAuthor.get(review.author);
    if (group === undefined) byAuthor.set(review.author, [review]);
    else group.push(review);
  }
  const latest: Review[] = [];
  for (const author of [...byAuthor.keys()].sort(compareStrings)) {
    const group = byAuthor.get(author);
    if (group === undefined || group.length === 0) continue;
    const first = group[0];
    if (first === undefined) continue;
    latest.push(
      group.reduce((a, b): Review => {
        // `>= 0` so the LAST of equal timestamps wins, matching `sort | last`
        // over jq's stable sort.
        return compareStrings(b.submittedAt ?? "", a.submittedAt ?? "") >= 0 ? b : a;
      }, first),
    );
  }
  return latest;
}

// Which reading of CON-32(b) was applied to a given approver. Both readings
// already exist in the shell; naming them is how a caller can report WHICH one a
// reviewer failed under without this module authoring the sentence.
export type ApprovalReading = "current-head" | "con40-holistic-pass";

export interface UnapprovedApprover {
  readonly reviewer: string;
  readonly reading: ApprovalReading;
}

function approvalReading(
  identities: GateIdentities,
  name: string,
  deliveryPr: boolean,
): ApprovalReading {
  // CON-40 names exactly two reviewers. The comparison is on the exact
  // configured name, never a pattern: a reviewer configured as something that
  // merely MATCHES `sasuke` must not inherit the carve-out.
  //
  // PORT CHANGE (§3): "exactly two reviewers" becomes "the reviewers the file
  // marks `delivery_holistic_pass`". The EXACT-NAME lookup is preserved
  // literally -- `identities.reviewer(name)` is a Map get, never a pattern
  // match -- because that was the original's stated defence and it is the one
  // that keeps a look-alike name out of a gate-widening carve-out.
  return deliveryPr && identities.reviewer(name)?.deliveryHolisticPass === true
    ? "con40-holistic-pass"
    : "current-head";
}

function approverApproved(
  latest: readonly Review[],
  name: string,
  headSha: string,
  reading: ApprovalReading,
): boolean {
  const pattern = safePattern(name);
  return latest.some(
    (review): boolean =>
      pattern.test(review.author) &&
      review.state === "APPROVED" &&
      (reading === "con40-holistic-pass" || review.commitId === headSha),
  );
}

export function reviewsAllApprovedAtHead(
  identities: GateIdentities,
  reviews: readonly Review[],
  headSha: string,
  // PORT CHANGE (§3): the default is the FILE's approver set, referenced off
  // the earlier parameter. The distinction the original's own comment turns on
  // -- "omitted" and "empty" are different values in TypeScript -- is preserved
  // exactly: an explicitly empty array still makes this vacuously true.
  approvers: readonly string[] = identities.defaultApprovers,
  deliveryPr = false,
): boolean {
  // An EMPTY approver list makes this predicate VACUOUSLY true, exactly as jq's
  // `all` over an empty list is: a caller that configured a reviewer set with no
  // approving reviewer in it has no approval to require, and owed rounds are
  // still enforced by pendingRounds() (Cursor Bugbot + Sasuke,
  // bankai-core#577).
  //
  // THIS IS THE ONE PLACE THE PORT DELIBERATELY DIFFERS FROM THE SHELL, and it
  // differs by removing a footgun rather than by changing a verdict. In shell,
  // `reviews_all_approved_at_head "$head" ""` does NOT mean "no approvers": the
  // parameter default `${2:-sasuke,tenma}` substitutes on an EMPTY argument as
  // well as an absent one, so an empty set silently demands the approvals the
  // caller deliberately excluded. `evaluate_ready` therefore has to guard the
  // call with `[ -n "$approvers" ]` and skip the predicate entirely -- which is
  // behaviourally identical to the vacuous `true` returned here. In TypeScript
  // "omitted" and "empty" are different values, so the default applies only when
  // the argument is genuinely absent and no caller-side guard is needed.
  const latest = latestReviewPerAuthor(reviews);
  // NOT normalizeReviewerNames(): the shell does not trim here, and trimming
  // would widen the gate. See shellApproverNames().
  return shellApproverNames(approvers).every((name): boolean =>
    approverApproved(latest, name, headSha, approvalReading(identities, name, deliveryPr)),
  );
}

// --- unapprovedApprovers -----------------------------------------------------
// The SAME per-approver test as reviewsAllApprovedAtHead, reported as the subset
// that FAILS it, each with the reading applied to it. It decides nothing; the
// verdict stays reviewsAllApprovedAtHead's.
//
// WHY IT EXISTS (Cursor Bugbot, BC-PR-#773): on a delivery PR the failure
// message asserted that sasuke/tenma's holistic pass was the problem -- but
// `bisky` can also be in the approver set (it joins once it has posted at head)
// and can be the one failing while sasuke and tenma are perfectly fine. The
// verdict was right and the reason pointed at the wrong reviewer, which is the
// class of "plausible, wrong" output bankai-core#639 and #698 were both about: a
// reader sent to re-run the wrong thing.
export function unapprovedApprovers(
  identities: GateIdentities,
  reviews: readonly Review[],
  headSha: string,
  approvers: readonly string[] = identities.defaultApprovers,
  deliveryPr = false,
): UnapprovedApprover[] {
  const latest = latestReviewPerAuthor(reviews);
  const unapproved: UnapprovedApprover[] = [];
  // The SAME list handling as reviewsAllApprovedAtHead, necessarily: this
  // function must name exactly the approvers that predicate failed, so the two
  // cannot disagree about which names are in the set.
  for (const name of shellApproverNames(approvers)) {
    const reading = approvalReading(identities, name, deliveryPr);
    if (!approverApproved(latest, name, headSha, reading)) {
      unapproved.push({ reviewer: name, reading });
    }
  }
  return unapproved;
}

// --- pendingRounds -----------------------------------------------------------
// CON-32(b), owed limb: which configured reviewers still OWE a round at the
// current head. An empty result means no round is owed.
//
// WHY IT EXISTS (bankai-core#564): Copilot is NOT a check run, so before it
// posts, its only footprint is a PENDING `reviewRequests` entry. The old
// (a)/(b)/(d) gate read `ready` in the 69 seconds between Sasuke's APPROVE and
// Copilot's eight threads. This is the predicate that was missing.
//
// A reviewer's round is owed when:
//   (i)  a review request naming it is PENDING -- `reviewRequests` drains when
//        the reviewer posts, so a pending entry is the only pre-post footprint a
//        non-check reviewer has; or
//   (ii) it has no round at HEAD: for sasuke/tenma/copilot a review with
//        `commit_id == HEAD` in ANY state; for BISKY and BUGBOT a review at head
//        OR a COMPLETED, non-SKIPPED check at head (`bisky / review`,
//        `Cursor Bugbot` -- the rollup is at head by construction). Both post a
//        review only when they have findings and otherwise conclude their check
//        silently, so for them the CHECK IS THE ROUND.
//
// Sasuke and Tenma are NEVER satisfied by their check alone on the ordinary
// path: their verdict review is the evidence, the check is only a proxy
// (agents/_conventions.md "proxy vs evidence"), and KroApple#329 shows a green
// `sasuke / audit` at head with no review posted at all.
//
// COPILOT POLICY. Under `bounded`, limb (ii) is SKIPPED for copilot -- only a
// pending request owes a round, so a head Copilot was never asked to review is
// not waited on. Under `strict`, copilot is a configured reviewer like any
// other. The replay behind that distinction: across 8 merged PRs sampled from
// bankai-core and KroApple, Copilot posted a round on ALL 8 and had it at the
// final head on NONE -- nothing re-requests Copilot after the final push, so
// `strict` holds every one of them not-ready indefinitely, and a gate nobody can
// satisfy is a gate everybody routes around (bankai-core#570 item 8). WHICH
// DEFAULT CANON WANTS IS THE MAINTAINER'S CON-7 CALL, so this predicate takes
// the policy as a REQUIRED argument and defaults nothing: the shell carries two
// different defaults at two different layers (`strict` inside pending_rounds,
// `bounded` in evaluate_ready), and a pure predicate picking one of them would
// be authoring the policy (BC-6).
//
// Requests for logins OUTSIDE the configured set (the human maintainer) are
// ignored: the human is the gate, never a round the gate waits on.
//
// DELIVERY_PR applies CON-40's carve-out to sasuke and tenma ONLY, and only
// after (ii) has already failed -- a round AT head still satisfies them by the
// ordinary path. Their round is then satisfied by the pair CON-40 actually
// specifies: the one holistic pass POSTED on this PR (a review at ANY commit)
// PLUS a definitive SUCCESS on their own review check at head. Missing either is
// still owed, and the two misses carry DIFFERENT reasons because they have
// different remedies -- "the one pass never posted" wants the review re-run,
// "no green abstain check at head" wants the check re-fired -- the same
// distinction bankai-core#698/#671 drew for CON-32(a). SUCCESS specifically,
// never NEUTRAL/SKIPPED: CON-40 requires the abstain to "report a definitive
// pass (never a skip, so branch protection is never left waiting)", and a
// skipped reviewer check is the workflow declining to run at all, which is not
// an abstain.

export type CopilotPolicy = "bounded" | "strict";

export interface RoundInputs {
  readonly reviewRequests: readonly ReviewRequest[];
  readonly checks: readonly RollupEntry[];
  readonly reviews: readonly Review[];
}

// The four reasons are the four branches that already exist in
// scripts/pr_ready_gate.sh's `pending_rounds`. Naming them is not a new taxonomy
// (BC-6); it is the shell's own `pending+=(...)` sites, typed.
export type OwedRoundReason =
  | "review-requested-not-yet-posted"
  | "no-round-at-head"
  | "delivery-holistic-pass-never-posted"
  | "delivery-no-definitive-success-review-check";

export interface OwedRound {
  readonly reviewer: string;
  readonly reason: OwedRoundReason;
}

// `tostring | test($p; "i")` over the request list. gh hands back `{login}` for
// a user or bot and `{name}` for a team, and the gate's own state blob flattens
// both to a bare login string -- all three reach this predicate as a
// ReviewRequest, so the match reads whichever of the two the request carries.
function requestMatches(request: ReviewRequest, pattern: RegExp): boolean {
  return pattern.test(request.login ?? request.name ?? "");
}

function hasDefinitiveSuccessCheck(
  checks: readonly RollupEntry[],
  pattern: RegExp,
): boolean {
  return checks.some((entry): boolean => {
    const name = rollupEntryCheckName(entry);
    return (
      name !== null &&
      pattern.test(name) &&
      lifecycleStatus(entry) === "COMPLETED" &&
      rollupEntryStatus(entry) === "SUCCESS"
    );
  });
}

function hasCompletedNonSkippedCheck(
  checks: readonly RollupEntry[],
  pattern: RegExp,
): boolean {
  return checks.some((entry): boolean => {
    const name = rollupEntryCheckName(entry);
    return (
      name !== null &&
      pattern.test(name) &&
      lifecycleStatus(entry) === "COMPLETED" &&
      checkRunConclusion(entry) !== "SKIPPED"
    );
  });
}

export function pendingRounds(
  identities: GateIdentities,
  inputs: RoundInputs,
  headSha: string,
  reviewers: readonly string[],
  policy: CopilotPolicy,
  deliveryPr = false,
): OwedRound[] {
  const names = normalizeReviewerNames(reviewers);
  // Reduce the rollup to the LATEST run per name BEFORE asking whether a
  // check-satisfied reviewer (bisky, bugbot) has a round. Reading the RAW rollup
  // here let a SUPERSEDED non-SKIPPED run clear a reviewer whose LATEST run at
  // head says otherwise (SKIPPED, cancelled, still in flight) -- the very
  // staleness latestChecks() exists to remove, applied to checksAllGreen() but
  // NOT here, and that omission was itself the bug (Cursor Bugbot + Sasuke,
  // bankai-core#577).
  const checks = latestChecks(inputs.checks);
  const owed: OwedRound[] = [];

  for (const name of names) {
    // PORT CHANGE (§3): one lookup, at the top of the loop, replaces four
    // separate name comparisons further down. `undefined` means the caller
    // named a reviewer the repository does not declare -- which is exactly the
    // original's `default:` world: it matches its own login, has no review
    // check, is not bounded-exempt, has no delivery carve-out and no check that
    // can stand in for its round. Every one of those is the conservative
    // reading, so an unknown reviewer OWES a round rather than being excused.
    const identity: ReviewerIdentity | undefined = identities.reviewer(name);
    const loginPattern = identity?.loginPattern ?? safePattern(name);

    if (
      inputs.reviewRequests.some((request): boolean =>
        requestMatches(request, loginPattern),
      )
    ) {
      owed.push({ reviewer: name, reason: "review-requested-not-yet-posted" });
      continue;
    }

    // PORT CHANGE (§3): `name === "copilot"` -> the file's
    // `bounded_policy_exempt` flag. The reviewer this named is the one nothing
    // re-requests after a final push, which is a STRUCTURAL property of how a
    // reviewer participates, not a fact about its name.
    if (identity?.boundedPolicyExempt === true && policy === "bounded") continue;

    if (
      inputs.reviews.some(
        (review): boolean =>
          loginPattern.test(review.author) && review.commitId === headSha,
      )
    ) {
      continue;
    }

    // PORT CHANGE (§3): the two names -> `delivery_holistic_pass`.
    if (deliveryPr && identity?.deliveryHolisticPass === true) {
      // CON-40's abstain-green round (bankai-core#720). Only reached once the
      // reviewer has NO review at head -- which on a delivery PR is the DESIGNED
      // state from the first `synchronize` onwards.
      const checkPattern = identity.reviewCheckPattern;
      if (
        checkPattern === null ||
        !hasDefinitiveSuccessCheck(checks, checkPattern)
      ) {
        owed.push({
          reviewer: name,
          reason: "delivery-no-definitive-success-review-check",
        });
        continue;
      }
      // An abstain-green check cannot stand in for a review that never happened
      // -- KP-PR-#460 exactly: Tenma's `opened` pass was concurrency-cancelled by
      // the synchronize that followed it, so Tenma abstained green having never
      // reviewed at all.
      if (
        inputs.reviews.some((review): boolean => loginPattern.test(review.author))
      ) {
        continue;
      }
      owed.push({
        reviewer: name,
        reason: "delivery-holistic-pass-never-posted",
      });
      continue;
    }

    // PORT CHANGE (§3): `name === "bisky" || name === "bugbot"` -> "the file
    // declares a `round_check_pattern` for this reviewer", i.e. a reviewer whose
    // CHECK IS THE ROUND because it posts a review only when it has findings.
    // The two patterns move with it, and their asymmetry moves intact: one is
    // anchored so a sibling probe job cannot clear a review round, the other an
    // unanchored substring because that check's name varies with the
    // installation. Both are stated by the file, per pattern, including
    // case-sensitivity -- see ../schema/gates.ts.
    if (identity?.roundCheckPattern != null) {
      if (hasCompletedNonSkippedCheck(checks, identity.roundCheckPattern)) continue;
    }

    owed.push({ reviewer: name, reason: "no-round-at-head" });
  }

  return owed;
}

// --- cancelledLatestReport ---------------------------------------------------
// Splits the NOT-GREEN entries of an ALREADY-REDUCED rollup into two named
// buckets, so a CON-32(a) failure can say WHICH KIND of not-green each check is.
//
// WHY IT EXISTS (bankai-core#698): a check whose LATEST run is CANCELLED carries
// no verdict at all -- a concurrency group with no live attempt left to
// supersede it, almost always infrastructural (a superseded run, a reclaimed
// runner) -- and it reads IDENTICALLY to a genuine FAILURE unless separated out.
// Six PRs sat indefinitely not-ready with no way to tell "this needs a re-run"
// from "this needs a fix". CON-32(a) is UNCHANGED by this: not-green is still
// not-ready. Only the reason string is more legible. Whether a cancelled-latest
// check should keep blocking, and whether something should re-run it
// automatically, is an open G4 question (bankai-core#698) that this predicate
// does not decide.
//
// `failing` is an ALLOWLIST of genuinely-terminal non-green values, never
// "everything left over" (bankai-core#727 review). A still-running or queued
// check has NO conclusion yet -- `null`, which is neither a failure nor a
// cancellation -- so it must NOT land in `failing`, or an in-flight check is
// misreported as broken and the reader is sent to fix something that has not
// finished deciding. Such an entry is simply omitted from BOTH buckets:
// checksAllGreen() already keeps the overall verdict not-ready for it, and this
// report only names checks that need an ACTION (a re-run or a fix). "Wait for
// it" needs neither.
//
// INPUT CONTRACT: the caller passes a rollup ALREADY reduced by latestChecks().
// The shell's own comment is explicit about it, and it is not cosmetic -- run
// this over a RAW rollup and a superseded CANCELLED attempt is named next to
// the SUCCESS that replaced it.
const TERMINAL_NOT_GREEN: ReadonlySet<string> = new Set([
  // CheckRun conclusions...
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
  // ...and the legacy StatusContext states. `PENDING`/`EXPECTED` are absent on
  // purpose: they are a status not yet decided, exactly like a null conclusion.
  "ERROR",
]);

export interface NotGreenReport {
  /** Check names whose LATEST run is CANCELLED -- needs a re-run, not a fix. */
  readonly cancelled: readonly string[];
  /** Check names that reached a terminal non-green verdict -- needs a fix. */
  readonly failing: readonly string[];
}

export function cancelledLatestReport(
  entries: readonly RollupEntry[],
): NotGreenReport {
  const cancelled: string[] = [];
  const failing: string[] = [];
  for (const entry of entries) {
    // `.name // .context // "unnamed check"` -- an entry that named itself
    // nothing is still worth naming in the reason, because "one check is red"
    // with no name at all sends the reader to the rollup to guess.
    const label = rollupEntryLabel(entry) ?? "unnamed check";
    const status = rollupEntryStatus(entry);
    if (status === "CANCELLED") cancelled.push(label);
    if (status !== null && TERMINAL_NOT_GREEN.has(status)) failing.push(label);
  }
  return { cancelled, failing };
}

// --- isDeliveryPr ------------------------------------------------------------
// CON-40's delivery-PR predicate (bankai-core#720): is this a PRODUCT-EPIC
// delivery PR, and therefore one whose reviewers abstain green by design?
//
// It uses the SAME structural predicate sasuke-review.yml/tenma-review.yml's
// gate step already implements:
//
//   author is roy-bankai  AND  base is the DEFAULT branch
//   AND ( head starts with `integration/`  OR  the `bankai:epic` label is on )
//
// WHY THE CARVE-OUT EXISTS AT ALL. CON-40 gives a delivery PR exactly ONE
// holistic review pass, on `opened`, and has the reviewers abstain green on
// every later `synchronize` -- "the check MUST report a definitive pass ... and
// cast no new review". CON-31 regenerates the delivery body on every child
// merge, so a new head is routine. Without the carve-out an epic delivery PR
// reads `not-ready: ... sasuke (no round at head);tenma (no round at head)`
// FOREVER after its first synchronize: a G2/G4 gate the machine can never pass,
// which inverts the gate onto the human (KP-PR-#460, reproduced live).
//
// AUTHOR AND A DEFAULT-BRANCH BASE ARE ALWAYS REQUIRED; only the head-ref naming
// convention is relaxed by the label. That asymmetry is BC-PR-#372's SECURITY
// FIX and is reproduced deliberately: the label is self-declared (CON-34,
// applied by Roy), so accepting it on its own would let any actor attach
// `bankai:epic` to an ordinary PR and permanently exempt its reviewers from a
// round at head.
//
// The author match tolerates BOTH login formats (issue #106, the same
// `(^|/)roy-bankai(\[bot\])?$` idiom roy-build.yml's remediate guard uses):
// `gh pr view --json author` returns `app/roy-bankai`, the webhook event context
// returns `roy-bankai[bot]`. It is ANCHORED, never a substring, so
// `roy-bankai-evil` and `evilroy-bankai2` are refused.
//
// WHAT IS REQUIRED TO BE PRESENT, exactly (Copilot, BC-PR-#773). Three fields
// are required NON-EMPTY -- author, baseRef, defaultBranch -- because each is an
// independent conjunct and an empty one cannot be evidence of anything.
// `headRef` and `labels` are NOT individually required: they form the fourth
// conjunct's DISJUNCTION, so an empty head ref is fine given the label, and
// empty labels are fine given an `integration/*` head. What that disjunction
// cannot do is pass on nothing.
//
// The property that matters holds either way: a state blob from an older caller,
// or a replay fixture captured before these fields existed, carries none of them
// and is therefore NOT a delivery PR -- so the ordinary at-head rounds keep
// binding. ABSENT EVIDENCE NEVER WIDENS A GATE.
// PORT CHANGE (§3): `const ROY_AUTHOR = /(^|\/)roy-bankai(\[bot\])?$/i`, the
// `integration/` head-ref prefix and the `bankai:epic` label were three names
// written into the binary. All three now come from the target repository's
// `delivery` block. The prefix and the label become LISTS because a repository
// may legitimately have more than one delivery convention; a single-entry list
// behaves exactly as the single literal did, and ../schema/gates.ts refuses a
// delivery block that declares neither -- a carve-out nothing can trigger is
// worse than no carve-out, because it looks configured.
//
// The ANCHORING of the author pattern is the file's responsibility now, and
// that is worth saying out loud: BC-PR-#372's security fix is that the author
// match is anchored so `roy-bankai-evil` is refused. A repository that writes
// an unanchored author pattern re-opens that hole. The predicate cannot decide
// this for the file without re-hard-coding the name it is being handed.

export interface DeliveryEvidence {
  /** `""` when the fetch could not establish it. Never widens the gate. */
  readonly author: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly defaultBranch: string;
  readonly labels: readonly string[];
}

export function isDeliveryPr(
  identities: GateIdentities,
  evidence: DeliveryEvidence,
): boolean {
  if (
    evidence.author === "" ||
    evidence.baseRef === "" ||
    evidence.defaultBranch === ""
  ) {
    return false;
  }
  if (!identities.delivery.authorPattern.test(evidence.author)) return false;
  if (evidence.baseRef !== evidence.defaultBranch) return false;
  return (
    identities.delivery.headRefPrefixes.some((prefix): boolean =>
      evidence.headRef.startsWith(prefix),
    ) || identities.delivery.labels.some((label): boolean => evidence.labels.includes(label))
  );
}

// --- defaultReviewers --------------------------------------------------------
// The configured reviewer set when `--reviewers` is not given: sasuke, tenma and
// copilot ALWAYS; plus bisky when a non-SKIPPED `bisky / review` check is present
// at head, plus bugbot when a non-SKIPPED check naming Bugbot is.
//
// PRESENCE AT HEAD IS THE EVIDENCE that a reviewer is configured for THIS PR --
// roy-build.yml's Bugbot rule, generalized. The registry (schemas/repos.json
// `consumes`) is deliberately NOT consulted: a consumer that consumes
// bisky-review.yml still gates Bisky per PR.
//
// THE `!= SKIPPED` FILTER IS NOT OPTIONAL, and it is the whole reason this
// function has a test (Sasuke, bankai-core#577). Enrolling bugbot on a SKIPPED
// check created a gate that could NEVER be satisfied: pendingRounds() accepts
// only a COMPLETED, non-SKIPPED check as bugbot's round, so a SKIPPED Bugbot
// check enrolled a reviewer and then never cleared it -- no review ever posts,
// the check never un-skips, and the PR is not-ready forever with no path out.
// That is the exact failure class this gate exists to eliminate, and it sat on
// the DEFAULT production path: copilot-sweeper.yml calls the gate with no
// --reviewers, so this branch always runs.
//
// The reduction to the LATEST run per name comes first, for the same reason
// pendingRounds() does it: a SUPERSEDED run must not decide who gates this PR.
//
// THE TWO PATTERNS ARE DELIBERATELY ASYMMETRIC and transcribed as the shell
// writes them: bisky's is `test("^bisky / review$")` -- ANCHORED and CASE
// SENSITIVE, because `bisky / probe / probe` is green on every PR and must not
// enrol the reviewer -- while bugbot's is `test("bugbot"; "i")`, an unanchored
// case-insensitive substring, because the Bugbot check's name varies with the
// installation (`Cursor Bugbot` today). "Fixing" either into the other's shape
// changes which reviewers a PR is gated by.
// PORT CHANGE (§3): `["sasuke", "tenma", "copilot"]` is now the file's
// `base_reviewers`, and the two enrolment patterns are each reviewer's
// `enrolment_check_pattern`. The asymmetry the original insists on -- one
// ANCHORED and CASE-SENSITIVE, the other an unanchored case-insensitive
// substring -- survives because ../schema/gates.ts makes `ignoreCase` a
// per-pattern field the file must state rather than something inferred from the
// pattern's shape. Enrolment order is the file's `reviewers` order, which is the
// analogue of the two `if`s the original ran in sequence.
export function defaultReviewers(
  identities: GateIdentities,
  checks: readonly RollupEntry[],
): string[] {
  const latest = latestChecks(checks);
  const enrolled = (pattern: RegExp): boolean =>
    latest.some((entry): boolean => {
      // `.name // ""` -- a legacy StatusContext has no `.name`, so it can never
      // enrol a reviewer however its `.context` is spelled. Same asymmetry
      // pendingRounds() relies on: an external CI system's commit status is not
      // bisky's or Bugbot's review job.
      const name = rollupEntryCheckName(entry) ?? "";
      // `.conclusion // ""` alone, NOT `.conclusion // .state` -- see
      // checkRunConclusion()'s note. A StatusContext's `state` must not be able
      // to make an entry look SKIPPED (or not-SKIPPED) here.
      return pattern.test(name) && checkRunConclusion(entry) !== "SKIPPED";
    });

  const set = [...identities.baseReviewers];
  for (const reviewer of identities.reviewers) {
    if (reviewer.enrolmentCheckPattern === null) continue;
    // A reviewer that is BOTH in the base set and enrollable would otherwise be
    // named twice, and a duplicate in this list means pendingRounds() reports
    // the same owed round twice. The original could not reach this state
    // because its two lists were disjoint literals; a file can write it, so it
    // is handled rather than assumed away.
    if (set.includes(reviewer.name)) continue;
    if (enrolled(reviewer.enrolmentCheckPattern)) set.push(reviewer.name);
  }
  return set;
}
