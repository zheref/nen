// ============================================================================
// ADOPTED FROM bankai-core `cli/src/ports/pr_ready_gate.ts` (zheref/nen#2,
// Akatsuki migration P1) -- `evaluateReady` at line 491, plus the jq-equivalent
// helpers and `minutesSince` it is built out of.
//
// The header below this block is the ORIGINAL's, carried WITH THE RECORDED
// EXCEPTIONS in divergences (5) and (6) below, as is every per-branch WHY in
// this file. That is the BC-IS-#737 discipline and it is REVIEW-BLOCKING rather
// than a courtesy: each comment names the production incident its branch exists
// for, and a predicate that arrives without its incident is one the next
// maintainer simplifies back into the bug. (An earlier revision of this file
// claimed the header was carried "VERBATIM" with no exceptions stated; that
// claim was false -- two paragraphs were dropped and two were spliced in
// unrecorded. zheref/nen#2's review record caught it; (5) and (6) are the
// correction, not a courtesy either.)
//
// ── WHAT THIS ADOPTION CHANGES, AND WHAT IT MUST NOT ────────────────────────
//
// THE LOGIC IS UNCHANGED. Every branch, every ordering, every asymmetry and
// every conservative direction is exactly as it was. The gate is NEVER PARTIALLY
// READY -- the whole conjunction -- and the reason returned is always the FIRST
// failing conjunct. The reason strings are transcribed BYTE FOR BYTE, em dashes
// and backticks included; the one exception is stated below and is the only one.
//
// (1) IDENTITIES ARE DATA (§3). The original decides against names written into
//     the source: `${2:-sasuke,tenma}`, `grep -Ex 'sasuke|tenma'`, an
//     `approvers="$approvers,bisky"` arm, `case "copilot"`, a
//     `"sasuke,tenma,copilot"` default reviewer set, `copilot round stalled`.
//     Every one of those is now read from the target repository's
//     `schemas/gates.json` through ../schema/gates.ts, exactly as
//     ./predicates.ts already reads the predicate half. WHERE A NAME BECAME A
//     STRUCTURAL PROPERTY, the mapping is:
//
//       `${2:-sasuke,tenma}` / the grep  -> `identities.defaultApprovers`
//       `approvers=",bisky"` arm         -> `approvesWhenPostedAtHead`
//       `"sasuke,tenma,copilot"` default -> `identities.baseReviewers`
//       `case "copilot"` (bounded)       -> `boundedPolicyExempt`
//       `copilot round stalled`          -> `<that reviewer's own name>`
//       the CON-40 pair                  -> `deliveryHolisticPass`
//       `roy-bankai`/`integration/`/label-> `identities.delivery.*`
//
//     The RENDERED OUTPUT is unaffected for a repository whose file states the
//     original's identities: `copilot round stalled` is produced by
//     interpolating the name of the reviewer the stall bound actually fired for,
//     which for that file IS `copilot`. That is the whole trick and it is worth
//     naming, because it is what lets "the strings are byte-identical" and "no
//     persona is written into the binary" both be true.
//
// (2) THE STATE BLOB'S TWO PERSONA-NAMED FIELDS ARE RENAMED, for the same
//     reason ./predicates.ts renamed the policy TYPE: a field name is a name
//     shipped in a binary's public API, which is the one place a value-level
//     sweep does not look (see ../taxonomy-purity.test.ts).
//
//       `copilot_policy`       -> `round_policy`
//       `copilot_requested_at` -> `stall_requested_at`
//
//     Nothing else about the blob moves. A consumer replaying the ORIGINAL's
//     recorded blobs has to map those two keys; that is a stated cost of §3 and
//     it is recorded here rather than discovered by the replay verb (nen#4).
//
// (3) ONE REASON STRING IS NOT BYTE-IDENTICAL, and it is the only one. The
//     empty-rollup message ends with a parenthetical citing the ISSUE in the
//     source system's repository, by that repository's NAME. §3 -- which the
//     ratified migration plan makes canon-superseding -- forbids the binary from
//     carrying the name of a system it serves, in a string as much as in a
//     value, and ../taxonomy-purity.test.ts fails the build on exactly that.
//     The citation is therefore carried in the COMMENT above the string, which
//     is where BC-IS-#737 wants it anyway, and dropped from the emitted text.
//     Recorded loudly -- in the ORIGINAL's own bankai-core cli/src/ports/
//     pr_ready_gate.ts, a "WHAT THIS PORT CANNOT REPRODUCE, STATED UP FRONT"
//     section makes exactly this kind of divergence explicit rather than
//     silent, and this numbered list plays the same role on this branch. That
//     section itself is NOT carried onto this file -- see divergence (6) for
//     where it went -- so it is not to be found here by name; this note
//     describes the ORIGINAL's practice, not a cross-reference to a section of
//     THIS file. Flagged as an open question for the maintainer rather than
//     settled here: the alternative is a re-worded string in the shell.
//
// (4) THE CONJUNCT TABLE IS NEW SURFACE, and it decides nothing. `evaluateReady`
//     already knew which conjunct failed -- it returns that conjunct's reason --
//     and every consumer downstream (`--explain`, `--json`, the ported pr-state
//     skill) was re-deriving the table by parsing the sentence. Recording it
//     structurally is BC-6-clean: the rows, their order, their clause IDs and
//     the short-circuit rule are the skill's own published table
//     (claude/skills/pr-state/SKILL.md § 3), not a new taxonomy. `line` and
//     `ready` remain exactly what they were, so a caller that wants only the
//     original's answer reads only those two fields.
//
// (5) THE ORIGINAL'S "PHASE 2 IS ADDITIVE" PARAGRAPH IS DROPPED, not carried.
//     It stated that scripts/pr_ready_gate.sh stays untouched and stays on
//     cli/src/guards/bc11-allowlist.txt -- both facts about bankai-core's OWN
//     repository layout (a second, shell implementation racing this ported one
//     under a guard list), neither of which exists once this logic is ported
//     into a standalone binary with no shell script beside it and no allowlist
//     to be added to. There is no nen-side "additive" claim to make in its
//     place: this file does not race an untouched original inside the SAME
//     repository, it replaces the original's role for THIS one.
//
// (6) THE ORIGINAL'S "WHAT THIS PORT CANNOT REPRODUCE, STATED UP FRONT" SECTION
//     IS DROPPED, and its three bullets did NOT travel forward uniformly:
//       * the `mktemp -d` pair (bankai-core#639/#695) and `native_path`
//         (bankai-core#748) ARE paraphrased forward, in ../github/pr_state.ts's
//         own header -- read there for why this port has no temp dir to fail to
//         create and no MSYS path to convert.
//       * the THIRD bullet -- `${REPO:?...}` emitting bash's OWN diagnostic,
//         and the reasoning for declining to record it into the corpus (a
//         Windows checkout's `C:` path makes the stderr classifier read a
//         diagnostic LABELLED `C` where a Linux runner's does not, so the same
//         bug would be green on one CI pool and red on the other for a reason
//         that has nothing to do with either implementation) -- has NO home on
//         this branch. This port's own ref-resolution errors
//         (../verbs/pr_ready.ts's `RefError`/`IdentityError`) are nen's own
//         messages, not a transcription of the shell's `${REPO:?...}` text, so
//         there is no analogous bash diagnostic here to decline recording.
//         Recorded here as an open gap, not silently dropped: if a future
//         phase ever DOES transcribe a shell diagnostic verbatim, the
//         Windows-path hazard this bullet names applies again and wants the
//         same treatment.
//     Two smaller, previously-unenumerated insertions into the carried body,
//     named here for completeness: the "ADOPTION NOTE on layer 3" paragraph
//     below (already labelled inline as an adoption note, but not previously
//     counted in this list) and the closing sentence of the SCOPE NOTE
//     ("Those are the CAVEATS `--explain` prints...") describing this file's
//     own `CAVEATS` export. Both are nen-side prose about nen-side additions,
//     not transcriptions of anything the original says.
// ============================================================================
// pr_ready_gate.ts -- the TypeScript port of scripts/pr_ready_gate.sh
// (BC-IS-#733 Phase 2, BC-IS-#737, rank 1).
//
// THIS IS THE FILE THE EPIC WAS WRITTEN ABOUT. CON-42/1 makes
// scripts/pr_ready_gate.sh the ONE place a CON-32 readiness claim is decided
// (bankai-core#568/#570), and BC-IS-#733's complaint is that the maintainer
// cannot audit a six-line `jq` expression. Every predicate below exists because
// a specific production failure happened, and the comment naming that failure is
// the only thing standing between a future maintainer and "simplifying" the
// predicate back into the bug. #737 makes carrying those comments across a
// REVIEW REQUIREMENT: a migrated predicate arriving with no explanation is a
// finding.
//
// ── WHAT THIS FILE IS RESPONSIBLE FOR ────────────────────────────────────────
//
// The shell splits into three layers and so does this port:
//
//   1. PREDICATES -- pure, data in / verdict out. They live in
//      ./predicates.ts (Phase 1, BC-IS-#736, plus the three this PR adds:
//      cancelledLatestReport, isDeliveryPr, defaultReviewers). Nothing is
//      re-implemented here; the typed core exists precisely for this file.
//   2. COMPOSITION -- `evaluateReady`, the conjunction, and the REASON STRINGS.
//      predicates.ts deliberately carries no message text ("the shell's reason
//      strings belong to the gate's composition, which is a later phase's
//      port"). That phase is this one, and the strings below are transcribed
//      BYTE FOR BYTE, em dashes and backticks included.
//   3. I/O -- `fetchPrState`, `unresolvedThreadCount`, `copilotRequestedAt` and
//      `main`'s notification path, expressed against an INJECTED `GhRunner`.
//      Nothing in this file spawns, reads a file, reads a clock or touches
//      `process.env`; the world is attached in ./host.ts, exactly as it is for
//      windows_preflight_checks.sh and classify_agent_termination.sh.
//
//   ADOPTION NOTE on layer 3: this file keeps layers 1 and 2 and NOT layer 3.
//   Nen reads GitHub through octokit (../github/client.ts), not through a `gh`
//   subprocess, so the transport half lives in ../github/pr_state.ts and its
//   bounds are stated there. What stays here is the part that DECIDES.
//
// ── THE TWO FORWARD OBLIGATIONS PHASE 1 RECORDED, AND HOW THEY ARE DISCHARGED ─
//
// (A) ../github/parse.ts: "EVERY ParseError MUST BECOME not-ready, WITH A LOUD
//     REASON ... not-ready because 'we could not read the evidence' is never
//     evidence of readiness, and loud because a not-ready whose reason is a
//     shape change wants a machinery fix, not a re-run."
//     DISCHARGED. `evaluateReady` maps every ParseError to
//     `not-ready: the PR state could not be read ...` carrying `error.path` and
//     `error.message` verbatim, and returns exit 1.
//
//     THIS IS A DELIBERATE, ONE-DIRECTIONAL DIVERGENCE FROM THE SHELL, and it
//     is stated rather than smuggled. Where the shell's `//` chain coerces a
//     foreign value into a datum and carries on, this port stops and says so.
//     The safety property that makes it acceptable: a ParseError can only ever
//     produce NOT-READY, never `ready`, so the port can never be MORE PERMISSIVE
//     than the thing it replaces through this path. The shell's own behaviour on
//     such input is worse than a different message -- for a non-array `.checks`
//     it aborts mid-pipeline under `set -euo pipefail` and emits NO VERDICT AT
//     ALL, which is the BC-PR-#745 failure class (`--verdict`'s contract is that
//     it ALWAYS prints ready or not-ready).
//
// (B) ../github/types.ts: "THE MODEL CANNOT EXPRESS is_delivery_pr ... #737
//     decides which of the two it wants: nullable `headRef` with the delivery
//     reading declining, or the current all-or-nothing parse plus a loud
//     not-ready. Both are defensible; only picking one silently is not."
//     DECIDED: NEITHER, and here is why the third answer is the right one.
//     `parsePullRequest` is not reachable from this gate at all -- it requires
//     `number`, and the state blob `fetch_pr_state` emits (the shape every bats
//     case, every replay fixture and every consumer of this gate carries) has
//     no `number` field and never has. More importantly, the delivery evidence
//     is FIVE INDEPENDENTLY-OPTIONAL FIELDS WHOSE ABSENCE IS ITSELF MEANINGFUL:
//     CON-40's carve-out WIDENS the gate, so a missing field must read as "not a
//     delivery PR" and leave the ordinary at-head rounds binding. Routing them
//     through a required-field parser would turn absent evidence into a parse
//     error and, via (A), into a not-ready whose reason is a shape complaint
//     rather than the truth ("this is an ordinary PR"). So the delivery evidence
//     gets its own narrow, tolerant reader (`deliveryEvidence` below) that
//     reproduces the shell's `// ""` exactly, and `PullRequest` is left alone.
//     Recorded here, and cross-referenced from types.ts, so the obligation is
//     visibly discharged rather than silently abandoned.
//
// ── THE GATE, IN ORDER (`evaluateReady`) ─────────────────────────────────────
//
//   mergeable        -- CON-42/1's added predicate (conflict-free);
//   CON-32(a)        -- every reported check green, on the LATEST run per check
//                       name, because the rollup RETAINS superseded same-name
//                       runs (bankai-core#558/#564);
//   CON-32(b) owed   -- no review request pending for a configured reviewer AND
//                       every configured reviewer has a round at head. This is
//                       the predicate #564 lacked: Copilot is NOT a check run,
//                       so before it posts its only footprint is a pending
//                       `reviewRequests` entry, and the old (a)/(b)/(d) gate read
//                       `ready` in the 69 seconds between Sasuke's APPROVE and
//                       Copilot's eight threads;
//   CON-32(b) approve-- every APPROVING reviewer's LATEST round is an APPROVE
//                       against the CURRENT head (CON-16's current-head rule);
//   CON-32(d)        -- zero unresolved review threads.
//
// SCOPE NOTE, carried across unchanged (never silent, CON-16/_conventions.md's
// "no silent caps"): this gate does NOT independently re-derive CON-32(c)
// ("addressed") or CON-32(e) (a channel-less finding dispositioned on the PR
// body) as their OWN signals -- it approximates both through the approve +
// zero-unresolved predicates. A conservative UNDER-approximation by design
// (biased to stay silent, never to notify early); the residual (e) gap is a
// known, documented limitation the human-side prose still owns. Those are the
// CAVEATS `--explain` prints, and they are published from this module (below)
// rather than retyped by every consumer.

import {
  cancelledLatestReport,
  checksAllGreen,
  excludeCheckRun,
  isDeliveryPr,
  latestChecks,
  normalizeReviewers,
  pendingRounds,
  reviewsAllApprovedAtHead,
  reviewerReviewCheckPattern,
  unapprovedApprovers,
  type OwedRound,
  type RoundPolicy,
  type UnapprovedApprover,
} from "./predicates.js";
import {
  parseCheckRollup,
  parseReviewRequests,
  parseReviews,
  type ParseError,
} from "../github/parse.js";
import type { GateIdentities } from "../schema/gates.js";

// ── tiny jq equivalents ──────────────────────────────────────────────────────
//
// The shell reads every value through `jq`, and jq's coercions ARE the
// behaviour. Reproducing them in three named helpers keeps them auditable
// instead of retyped -- the same argument ../github/types.ts makes for its `//`
// accessors.

/**
 * `jq -r`: a string prints RAW, everything else prints as JSON.
 *
 * The `null` case is load-bearing and reachable: `jq -r '.mergeable'` on a state
 * blob with no `mergeable` field prints the four characters `null`, which is
 * what the shell then interpolates into
 * `not-ready: mergeable=null (expected MERGEABLE ...)`. Coercing absence to ""
 * here would silently change a real message.
 */
function jqRaw(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "null";
  return JSON.stringify(value);
}

/**
 * jq's `a // b`: `b` when `a` is absent, `null` or `false`.
 *
 * `false` is included because that is what jq does, not because any field here
 * is boolean -- transcribing the operator rather than the use sites is how a
 * future field added to the state blob gets the same reading the shell gives it.
 */
function jqAlternative<T>(value: unknown, fallback: T): unknown {
  if (value === undefined || value === null || value === false) return fallback;
  return value;
}

/**
 * jq's `tostring`: a string is itself, anything else is its JSON rendering.
 *
 * Kept because `is_delivery_pr`'s label test is `any(tostring == "...")`, which
 * stringifies each element first rather than dropping a non-string label.
 */
export function jqToString(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

// ── minutesSince ─────────────────────────────────────────────────────────────

/**
 * Whole minutes between two ISO-8601 timestamps, truncated toward zero.
 *
 * The shell's `minutes_since` is `$(( (b - a) / 60 ))` over two `date +%s`
 * values, and shell arithmetic truncates toward zero -- `Math.trunc`, never
 * `Math.floor`, so a NEGATIVE interval (a `NOW` earlier than the request, which
 * a caller pinning `NOW` in a test can produce) rounds the same way.
 *
 * An unparseable timestamp yields `undefined`, and the caller treats that as
 * "the stall bound did not fire". In the shell the same input makes `date` fail,
 * `$(...)` yield an empty string, and `[ "" -ge 30 ]` return non-zero with a
 * `[: : integer expression expected` line on stderr -- the falling-through half
 * is reproduced, the stray bash diagnostic is not. It is unreachable from any
 * real request timestamp, which is either a GitHub timestamp or empty.
 */
export function minutesSince(timestamp: string, now: string): number | undefined {
  const from = Date.parse(timestamp);
  const to = Date.parse(now);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  const minutes = Math.trunc((to - from) / 1000 / 60);
  // Normalize `-0` to `0`. It makes no difference to the MESSAGE (JavaScript
  // renders both as "0", as bash does) but it makes the value comparable with
  // `Object.is`, and a caller quietly holding a negative zero is a puzzle
  // nobody should have to solve twice.
  return minutes === 0 ? 0 : minutes;
}

// ── the conjunct table ───────────────────────────────────────────────────────
//
// The rows, their ORDER, their clause IDs and the short-circuit rule are the
// published pr-state table (claude/skills/pr-state/SKILL.md § 3), recorded
// structurally instead of re-derived from the reason sentence by every
// consumer. NO ROW IS NEW: each is a branch `evaluate_ready` already takes, in
// the order it already takes it.
//
// ROW 3 IS INSIDE ROW 4'S BRANCH in the shell -- the stall bound is only
// consulted once a round is owed -- and the table keeps it as its own row
// because that is how the skill publishes it and because the two failures want
// different actions: a stalled round wants a RE-REQUEST, an ordinary owed round
// wants the reviewer to run. When no round is owed at all, row 3 passes
// vacuously, which is exactly what the shell's control flow says.

export type ConjunctId =
  | "mergeable"
  | "checks-green"
  | "round-stalled"
  | "rounds-owed"
  | "approvals-at-head"
  | "unresolved-threads";

/**
 * `unevaluated` is the SHORT-CIRCUIT classification, and it is not a pass.
 *
 * The gate stops at the first failing conjunct, so every row after it is
 * genuinely UNKNOWN -- the skill's rule is that they must be reported as unknown
 * rather than as passing, because "the gate did not get that far" and "the gate
 * checked and was satisfied" are different facts and only one of them is
 * evidence.
 */
export type ConjunctStatus = "ready" | "failed" | "unevaluated";

export interface Conjunct {
  readonly id: ConjunctId;
  /** 1-based position in evaluation order -- the table's own numbering. */
  readonly order: number;
  /** The canon clause this row enforces, e.g. `CON-32(a)`. */
  readonly clause: string;
  /** The row's label, as the published table words it. */
  readonly title: string;
  readonly status: ConjunctStatus;
  /**
   * The gate's own reason, VERBATIM, on the row that failed; `null` otherwise.
   * Never paraphrased and never carried on a passing row -- a reason attached to
   * something that did not fail is the "plausible, wrong" output class
   * bankai-core#639/#698 were both about.
   */
  readonly reason: string | null;
}

interface ConjunctSpec {
  readonly id: ConjunctId;
  readonly clause: string;
  readonly title: string;
}

// Wording carried from the published table. It names no reviewer: the skill's
// row 3 reads "No Copilot round stalled", which is that one repository's
// reviewer, and the row is really "the reviewer whose round the stall bound
// applies to" -- the file's `bounded_policy_exempt` one.
const CONJUNCTS: readonly ConjunctSpec[] = [
  { id: "mergeable", clause: "CON-42/1", title: "Mergeable" },
  {
    id: "checks-green",
    clause: "CON-32(a)",
    title: "Every reported check green, on the latest run per check name",
  },
  {
    id: "round-stalled",
    clause: "CON-32(b)",
    title: "No configured reviewer's requested round has stalled",
  },
  {
    id: "rounds-owed",
    clause: "CON-32(b)",
    title: "No configured reviewer's round owed at the current head",
  },
  {
    id: "approvals-at-head",
    clause: "CON-32(b)/CON-16",
    title: "Every approving reviewer's latest round is an APPROVE at the current head",
  },
  { id: "unresolved-threads", clause: "CON-32(d)", title: "Zero unresolved review threads" },
];

export interface Caveat {
  readonly id: string;
  readonly clause: string;
  readonly text: string;
}

/**
 * WHAT THE GATE DOES NOT DECIDE -- the fixed set, published once.
 *
 * It is FIXED and it is STATIC (the migration plan's §2 pr-state row says so in
 * as many words), and it lives beside the gate rather than in the renderer
 * because all three consumers -- the human `--explain`, the `--json` contract,
 * and the ported skill that reads that JSON -- must state the same three things.
 * A caveat set that each consumer retypes is a caveat set that drifts, and the
 * drift lands on the side where a `ready` gets over-read.
 *
 * Sourced from claude/skills/pr-state/SKILL.md § 3, with the reviewer's NAME
 * removed from the third one: the suppressed-comments block that motivates it is
 * one reviewer's rendering, and the caveat is about findings that carry no
 * thread object at all.
 */
export const CAVEATS: readonly Caveat[] = [
  {
    id: "addressed-is-approximated",
    clause: "CON-32(c)",
    text:
      "\"Addressed\" is APPROXIMATED by the approve and zero-unresolved rows. The gate cannot read " +
      "whether a thread's substance was actually answered, only that the thread was resolved and " +
      "the round approved. Replying remains the author's obligation.",
  },
  {
    id: "which-checks-reported",
    clause: "CON-32(a)",
    text:
      "That a BUILD check exists specifically is NOT asserted -- only that at least one check " +
      "reported and that every reported check is green on its latest run. An EMPTY rollup FAILS, so " +
      "absence is a finding here and never a pass; what the gate cannot tell you is WHICH checks " +
      "reported. Confirm by eye that the one your repository requires is among them.",
  },
  {
    id: "channel-less-findings",
    clause: "CON-32(e)",
    text:
      "A reviewer finding with NO thread object -- a suppressed-comments block rendered in the " +
      "review BODY -- has nothing for the unresolved-threads row to count. Read the review bodies, " +
      "not only their threads.",
  },
];

// ── evaluateReady ────────────────────────────────────────────────────────────

/** The gate's answer: the exact line the shell prints, and whether it is ready. */
export interface ReadyVerdict {
  readonly line: string;
  readonly ready: boolean;
}

/**
 * The gate's answer PLUS the table it was already computing.
 *
 * `line` and `ready` are `ReadyVerdict`'s, unchanged and authoritative: a caller
 * that wants only the original's answer reads those two and ignores the rest.
 */
export interface ReadyEvaluation extends ReadyVerdict {
  readonly conjuncts: readonly Conjunct[];
  /** The id of the FIRST failing conjunct, or `null` on a ready verdict. */
  readonly firstFailing: ConjunctId | null;
  /** Facts the renderers report but the verdict does not turn on. */
  readonly context: EvaluationContext;
}

export interface EvaluationContext {
  /** The reviewer set actually applied, after normalization. */
  readonly reviewers: readonly string[];
  /** The approver set actually applied, in the shell's own list handling. */
  readonly approvers: readonly string[];
  readonly policy: RoundPolicy;
  readonly headSha: string;
  /** CON-40's carve-out, computed ONCE and threaded into both CON-32(b) limbs. */
  readonly deliveryPr: boolean;
}

export interface EvaluateOptions {
  /** `${COPILOT_POLICY:-bounded}` -- evaluate_ready's default for `.round_policy`. */
  readonly roundPolicyDefault: RoundPolicy;
  /** `${COPILOT_STALL_MINUTES:-30}`. */
  readonly stallMinutes: number;
  /** `${NOW:-$(date -u ...)}`, already resolved. */
  readonly now: string;
}

/** `pending_rounds`' four `pending+=(...)` sites, rendered as the shell does. */
function describeOwedRound(identities: GateIdentities, owed: OwedRound): string {
  switch (owed.reason) {
    case "review-requested-not-yet-posted":
      return `${owed.reviewer} (review requested, not yet posted)`;
    case "delivery-holistic-pass-never-posted":
      return (
        `${owed.reviewer} (delivery PR: CON-40's one holistic pass on 'opened' never posted ` +
        "— an abstain-green check at head cannot stand in for a review that never happened)"
      );
    case "delivery-no-definitive-success-review-check": {
      // `$(reviewer_review_check_pattern "$name" | tr -d '^$')` -- the anchors
      // are stripped for the message, so the reader sees the CHECK NAME rather
      // than the regex that matched it. The pattern is the FILE's, so the check
      // name in this message is the target repository's own.
      const pattern = reviewerReviewCheckPattern(identities, owed.reviewer);
      const check =
        pattern === null ? "" : pattern.source.replace(/[$^]/g, "").replace(/\\\//g, "/");
      return (
        `${owed.reviewer} (delivery PR: no definitive-SUCCESS ${check} check at head ` +
        "— CON-40's abstain must report a pass, never a skip)"
      );
    }
    case "no-round-at-head":
      return `${owed.reviewer} (no round at head)`;
  }
}

/** `unapproved_approvers`' two message forms, one per CON-32(b) reading. */
function describeUnapproved(entry: UnapprovedApprover): string {
  return entry.reading === "con40-holistic-pass"
    ? `${entry.reviewer} (no APPROVE on its CON-40 holistic pass on \`opened\`)`
    : `${entry.reviewer} (no APPROVE at the current head)`;
}

/**
 * `is_delivery_pr`'s inputs, read the tolerant way the shell reads them
 * (`.author // ""`, `.labels // []`), for the reason set out in obligation (B)
 * at the top of this file: ABSENCE IS MEANINGFUL HERE and must mean "not a
 * delivery PR", never "unreadable".
 */
export function deliveryEvidence(state: Record<string, unknown>): {
  readonly author: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly defaultBranch: string;
  readonly labels: readonly string[];
} {
  const text = (key: string): string => {
    const value = state[key];
    return typeof value === "string" ? value : "";
  };
  const rawLabels = state["labels"];
  return {
    author: text("author"),
    baseRef: text("base_ref"),
    headRef: text("head_ref"),
    defaultBranch: text("default_branch"),
    // jq's `any(tostring == "...")` stringifies each element first, so a
    // non-string label is compared by its rendering rather than dropped.
    labels: Array.isArray(rawLabels) ? rawLabels.map(jqToString) : [],
  };
}

/** The ONE mapping of a ParseError to a verdict -- obligation (A), discharged. */
function unreadable(error: ParseError): string {
  return (
    "not-ready: the PR state could not be read, so CON-32 cannot be judged " +
    `(${error.path}: ${error.message})`
  );
}

/**
 * Assemble the table for a verdict that failed at `failedAt`, or for `ready`.
 *
 * Rows BEFORE the failure are `ready` -- the gate reached them and was satisfied.
 * The failing row carries the reason VERBATIM. Rows AFTER it are `unevaluated`,
 * never `ready`: the gate short-circuits, so their state is unknown, and
 * reporting an unknown as a pass is the one reading a readiness gate must never
 * offer.
 */
function table(failedAt: ConjunctId | null, reason: string | null): readonly Conjunct[] {
  let seen = false;
  return CONJUNCTS.map((spec, index): Conjunct => {
    if (failedAt === null) {
      return { ...spec, order: index + 1, status: "ready", reason: null };
    }
    if (spec.id === failedAt) {
      seen = true;
      return { ...spec, order: index + 1, status: "failed", reason };
    }
    return { ...spec, order: index + 1, status: seen ? "unevaluated" : "ready", reason: null };
  });
}

/**
 * The whole gate. Reads the combined PR-state object, returns the exact line the
 * shell would print, whether it means ready, and the conjunct table.
 *
 * NEVER PARTIALLY READY -- the whole conjunction, same stance CON-32 itself
 * takes, and the reason returned is always the FIRST failing one so the reader
 * has one thing to fix rather than a list.
 */
export function evaluateReady(
  identities: GateIdentities,
  raw: unknown,
  options: EvaluateOptions,
): ReadyEvaluation {
  const state: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const mergeable = jqRaw(state["mergeable"]);
  const head = jqRaw(state["head_sha"]);
  const unresolved = jqRaw(state["unresolved_threads"]);
  // `.exclude_run_id // empty` -- absent, null and false all yield "".
  const excludeRunValue = state["exclude_run_id"];
  const excludeRun =
    excludeRunValue === undefined || excludeRunValue === null || excludeRunValue === false
      ? ""
      : jqRaw(excludeRunValue);
  // PORT CHANGE (§3): the shell's `// "sasuke,tenma,copilot"` default is the
  // FILE's `base_reviewers`. Reachable only for a hand-built blob -- the
  // transport always states the set -- but a default that named three personas
  // is exactly the literal §3 is about.
  const reviewers = normalizeReviewers(
    jqRaw(jqAlternative(state["reviewers"], identities.baseReviewers.join(","))),
  );
  const policyText = jqRaw(jqAlternative(state["round_policy"], options.roundPolicyDefault));
  // The shell does NOT re-validate the policy here -- `main` already did, and a
  // state blob carrying something else (a bats case, a hand-built caller) simply
  // fails every `= "bounded"` comparison and behaves as `strict`. Transcribed:
  // anything that is not exactly `bounded` is strict.
  const policy: RoundPolicy = policyText === "bounded" ? "bounded" : "strict";

  // Approvers: the file's `default_approvers` always, in the order the reviewer
  // set names them; a reviewer marked `approves_when_posted_at_head` ONLY once
  // it has POSTED a review at head (a silent completed review check is its
  // "nothing to say", and a reviewer that said nothing is not an approver).
  //
  // The shell builds this with `grep -Ex 'sasuke|tenma' ... || true`, and the
  // `|| true` is not decoration: under `pipefail` a grep that matches NOTHING
  // exits 1 and aborts the whole script under `set -e`, printing NO VERDICT at
  // all and breaking --verdict's contract. Reachable the moment the reviewer set
  // is caller-configurable -- `--reviewers copilot,bisky` names neither approver
  // (Cursor Bugbot + Sasuke, bankai-core#577). An EMPTY approver set makes the
  // approve predicate vacuous, which is correct: owed rounds are still enforced
  // by pendingRounds().
  const approverList = reviewers.filter((name): boolean =>
    identities.defaultApprovers.includes(name),
  );
  let approversCsv = approverList.join(",");

  // Parsing is LAZY and in the shell's own consumption order, so a malformed
  // slice cannot pre-empt an earlier predicate's verdict. The shell reaches
  // `.reviews` here through a tolerant `jq -e` whose failure simply reads as "no
  // conditional-approver round at head" -- reproduced exactly: a reviews array
  // this port cannot parse does not enrol the reviewer and does not yet abort.
  const parsedReviews = parseReviews(state["reviews"]);
  for (const name of reviewers) {
    const identity = identities.reviewer(name);
    if (identity?.approvesWhenPostedAtHead !== true) continue;
    if (approverList.includes(name)) continue;
    // PORT CORRECTION, the same one ./predicates.ts records for its approver
    // test: the shell matches the name RAW (`test($name; "i")`) and defends it
    // with "the approver set is only ever sasuke/tenma/bisky, each of which
    // matches its own login". That defence is a statement about ONE
    // repository's names and stops being true the moment the names are data, so
    // the enrolment reads the DECLARED login pattern -- which for a file whose
    // reviewer names equal their login patterns is the identical test.
    const postedAtHead =
      parsedReviews.ok &&
      parsedReviews.value.some(
        (review): boolean =>
          identity.loginPattern.test(review.author) && review.commitId === head,
      );
    if (postedAtHead) approversCsv = `${approversCsv},${name}`;
  }
  // `split(",") | map(select(length > 0))` -- the shell's own approver-list
  // handling, empties dropped and whitespace KEPT. Never trimmed here: trimming
  // would make the gate MORE PERMISSIVE than the shell (see shellApproverNames
  // in ./predicates.ts).
  const approvers = approversCsv.split(",").filter((name): boolean => name.length > 0);

  // CON-40 delivery-PR carve-out (bankai-core#720). Computed ONCE and threaded
  // into BOTH CON-32(b) limbs; every other predicate is untouched by it.
  const delivery = isDeliveryPr(identities, deliveryEvidence(state));

  const context: EvaluationContext = {
    reviewers,
    approvers,
    policy,
    headSha: head,
    deliveryPr: delivery,
  };
  const fail = (at: ConjunctId, line: string): ReadyEvaluation => ({
    ready: false,
    line,
    conjuncts: table(at, line),
    firstFailing: at,
    context,
  });

  if (mergeable !== "MERGEABLE") {
    return fail(
      "mergeable",
      `not-ready: mergeable=${mergeable} (expected MERGEABLE — CON-42/1's added predicate)`,
    );
  }

  // `.checks // []`: GitHub answers `statusCheckRollup: null` on a PR with no
  // runs -- the very state bankai-core#671 is about -- and that null reaching
  // `map(select(...))` aborted the whole script and emitted NO verdict, breaking
  // --verdict's always-print contract (Copilot, BC-PR-#745).
  const rawChecks = jqAlternative(state["checks"], []);
  const parsedChecks = parseCheckRollup(rawChecks, "$.checks");
  if (!parsedChecks.ok) return fail("checks-green", unreadable(parsedChecks.error));
  const checksExcluded = excludeCheckRun(parsedChecks.value, excludeRun);

  if (!checksAllGreen(checksExcluded)) {
    // AN EMPTY ROLLUP IS NOT A RED ROLLUP (bankai-core#671). `checksAllGreen`
    // opens with a non-empty test, so "no checks at all" and "a check failed"
    // both arrive here -- and used to leave through ONE string that named both.
    // They are different findings whose remedies do not overlap: a red check
    // wants a FIX, an empty rollup wants a RE-FIRE (or an `update-branch` on a
    // stale head) and never improves by waiting. BC-PR-#660 and BC-PR-#610 each
    // sat 11 hours on a `startup_failure` -- no job, no log, no annotation, no
    // check run -- reading exactly like a PR whose CI had merely not started.
    if (checksExcluded.length === 0) {
      // ...and "nothing ever reported" is not "the only thing that reported was
      // the run we were asked to ignore". The second is an artifact of the
      // CON-36 clause-3 self-check asking the gate from INSIDE its own job, and
      // telling that agent its CI is dead when it is the one running is worse
      // than useless -- it is the exact wrong remedy.
      if (excludeRun !== "" && parsedChecks.value.length > 0) {
        return fail(
          "checks-green",
          `not-ready: NO checks remain after excluding run ${excludeRun} (CON-32a) — the rollup ` +
            "held only the excluded run, so the gate has no evidence to judge. This is an ABSENT " +
            "verdict, not a red one; ask again once a check outside that run reports.",
        );
      }
      // ADOPTION DIVERGENCE (3) in the file header, and the ONLY reason string
      // that is not byte-identical. The shell's text ends the second sentence
      // with the citation `(bankai-core#671)` -- the incident that records why
      // an empty rollup and a red one are different findings, and the reference
      // a reader chasing this message wants. §3 forbids the binary from
      // carrying that repository's NAME in a shipped string, and the purity
      // sweep fails the build on it, so the citation lives here, in the comment
      // BC-IS-#737 wants it in, and the emitted sentence stops at the full stop.
      // Nothing else about the string moves, and the difference cannot change a
      // verdict: it is the same branch, on the same evidence, for the same
      // reason.
      return fail(
        "checks-green",
        "not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. " +
          "Either CI has not started yet, or its run concluded startup_failure and no check will " +
          "ever attach. Tell them apart with: gh run list --branch <head-branch> " +
          "--limit 5 --json conclusion,path,headSha",
      );
    }
    // Each callee gets exactly the shape its own contract documents (Copilot,
    // BC-PR-#742): checksAllGreen reduces INTERNALLY -- that is its contract,
    // relied on by its other callers -- while cancelledLatestReport REQUIRES
    // pre-reduced input. Reducing here, inside the failure branch, also keeps
    // the common green path one pass cheaper.
    const report = cancelledLatestReport(latestChecks(checksExcluded));
    const cancelledList = report.cancelled.join(", ");
    const failingList = report.failing.join(", ");
    if (cancelledList !== "") {
      return fail(
        "checks-green",
        "not-ready: required checks are not all green (CON-32a) — latest run CANCELLED, no " +
          `verdict (needs a re-run, not a fix): ${cancelledList}` +
          (failingList === "" ? "" : `; failing: ${failingList}`),
      );
    }
    return fail(
      "checks-green",
      "not-ready: required checks reported but are not all green (CON-32a)",
    );
  }

  // pending_rounds is handed `{review_requests, checks, reviews}` from the RAW
  // state -- the UN-excluded rollup. Transcribed deliberately: `--exclude-run`
  // is a CON-32(a) carve-out for the asking job's own check, and it was never
  // scoped to change which reviewers owe a round.
  if (!parsedReviews.ok) return fail("rounds-owed", unreadable(parsedReviews.error));
  const parsedRequests = parseReviewRequests(state["review_requests"]);
  if (!parsedRequests.ok) return fail("rounds-owed", unreadable(parsedRequests.error));
  const owed = pendingRounds(
    identities,
    {
      reviewRequests: parsedRequests.value,
      checks: parsedChecks.value,
      reviews: parsedReviews.value,
    },
    head,
    reviewers,
    policy,
    delivery,
  );
  if (owed.length > 0) {
    const requestedAt = state["stall_requested_at"];
    const requestedAtText = typeof requestedAt === "string" ? requestedAt : "";
    // PORT CHANGE (§3): `entry.reviewer === "copilot"` -> the reviewer the FILE
    // marks `bounded_policy_exempt`. That flag already names, structurally, the
    // reviewer nothing re-requests after a final push -- which is precisely the
    // reviewer a PENDING request can go stale on.
    const stalled = owed.find(
      (entry): boolean =>
        entry.reason === "review-requested-not-yet-posted" &&
        identities.reviewer(entry.reviewer)?.boundedPolicyExempt === true,
    );
    if (stalled !== undefined && requestedAtText !== "") {
      // Under BOTH policies a pending request older than the stall bound is
      // reported as STALLED -- loud, never silently ready. `bounded` is not
      // "ignore that reviewer": a pending request is the one footprint an
      // un-posted round has, and it is honoured either way.
      const age = minutesSince(requestedAtText, options.now);
      // `>=`, NOT `>`. The bound is "STALL_MINUTES old OR MORE", so a request
      // that is EXACTLY that old is already stalled. The distinction is one
      // character and was invisible to both the port's first test suite and
      // tests/pr_ready_gate.bats itself -- neither exercised the boundary, both
      // sampled 90 minutes against a 30-minute bound and 10 minutes against the
      // same -- so a deliberate `>=` -> `>` mutation replayed GREEN through the
      // whole corpus. Found by sabotage, closed by the two boundary cases in
      // ./ready.test.ts ("the stall bound fires AT the boundary").
      if (age !== undefined && age >= options.stallMinutes) {
        return fail(
          "round-stalled",
          `not-ready: ${stalled.reviewer} round stalled — requested ${age} min ago and never posted ` +
            "(CON-32b; re-request it, a user token is required)",
        );
      }
    }
    return fail(
      "rounds-owed",
      "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): " +
        owed.map((entry): string => describeOwedRound(identities, entry)).join(";"),
    );
  }

  // An EMPTY approver set makes this predicate vacuous BY DESIGN: the caller
  // configured a reviewer set with no approving reviewer in it, so there is no
  // approval to require. Owed rounds are still enforced above. The shell has to
  // guard the call explicitly because its `${2:-sasuke,tenma}` default
  // substitutes on an EMPTY argument as well as an absent one -- and would
  // therefore demand exactly the approvals the caller excluded; here "omitted"
  // and "empty" are different values and the guard is the empty array itself.
  if (
    approversCsv !== "" &&
    !reviewsAllApprovedAtHead(identities, parsedReviews.value, head, approvers, delivery)
  ) {
    // NAME the approver(s) actually failing, with the reading applied to each,
    // rather than asserting which one it must be. On a delivery PR the old
    // message blamed the CON-40 pair's holistic pass unconditionally, while a
    // conditional approver -- in `approvers` whenever it has posted at head,
    // and NOT carved out -- could be the real and only failure (Cursor Bugbot,
    // BC-PR-#773). The verdict was right and the reason pointed at the wrong
    // reviewer, which is the "plausible, wrong" class bankai-core#639 and #698
    // were both about.
    const unapproved = unapprovedApprovers(
      identities,
      parsedReviews.value,
      head,
      approvers,
      delivery,
    )
      .map(describeUnapproved)
      .join(";");
    if (unapproved !== "") {
      return fail(
        "approvals-at-head",
        `not-ready: not every approving reviewer's latest round is an APPROVE (CON-32b): ${unapproved}`,
      );
    }
    // Unreachable in practice -- the two predicates share their per-approver
    // test -- but a disagreement must degrade to the plain message, never to an
    // empty one that names nobody.
    return fail(
      "approvals-at-head",
      `not-ready: not every approving reviewer's latest round is an APPROVE (CON-32b: ${approversCsv})`,
    );
  }

  // `${unresolved:-1}` -- an empty value is 1, i.e. not-ready. "Cannot confirm
  // zero" is never "zero" at CON-32(d)'s boundary.
  if ((unresolved === "" ? "1" : unresolved) !== "0") {
    return fail(
      "unresolved-threads",
      `not-ready: ${unresolved} unresolved review thread(s) (CON-32d)`,
    );
  }

  return {
    ready: true,
    line: "ready",
    conjuncts: table(null, null),
    firstFailing: null,
    context,
  };
}
