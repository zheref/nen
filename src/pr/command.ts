// src/pr/command.ts -- `nen pr ready`, `nen pr staleness`, `nen pr body-check`
// (main), and (verbs/4-remainders, zheref/nen#4) `nen pr fetch`,
// `nen pr next-blocker`, `nen pr cascade-main`, `nen pr retarget`,
// `nen pr request-reviews`, `nen pr edit-body`, and (zheref/nen#345)
// `nen pr mark-ready` -- one "pr" family.
//
// THREE SUBCOMMANDS, ONE FAMILY. `nen pr ready` (the CON-32 readiness verdict,
// zheref/nen#2) is the ELDER of the three: it landed on main first, as a direct
// case in ../index.ts's dispatcher, before this registry existed. Converging it
// here -- rather than leaving two separate "pr" entry points, one via the
// registry and one hard-coded in ../index.ts -- is what keeps `nen pr <tab>`
// meaning one thing. Its implementation stays in ../verbs/pr_ready.ts unchanged
// (network transport, gate evaluation, --json contract, review record and all);
// this file only adapts the registry's CommandContext into the shape
// prReady() already expects. The five FETCH/NEXT-BLOCKER/CASCADE-MAIN/
// RETARGET/REQUEST-REVIEWS subcommands arrived the same way a wave later
// (verbs/4-remainders): a second "pr" family, independently registered, is
// exactly the two-entry-points mistake the paragraph above already refused
// once, so they join this same family instead of a second one.
//
// `run()` RETURNS `number | Promise<number>` (../cli/command.ts) because
// `ready` reads GitHub over the network and every other subcommand does not --
// see ../verbs/pr_ready.ts for why there is no synchronous alternative.

import {
  emit,
  GLOBAL_FLAGS,
  requireRepoFlag,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
  requireTargetFlag,
  parseCallerToken,
} from "../cli/command.js";
import { readJsonFile, readTextFile, readVerbatimTextFile, resolveAgainstRepo } from "../cli/inputs.js";
import { mergeUnit, MergeUnitUsageError, EXIT_GH_REFUSED, EXIT_GH_NOT_RUNNABLE } from "./mergeunit.js";
import { deliveryExit, mergeDelivery } from "./mergedelivery.js";
import { commaList } from "../cli/comma.js";
import { assertRepoRoot, resolveRepoRoot } from "../repo/root.js";
import { loadGateIdentities, parseGateIdentities, parseGatesText, type GateIdentities } from "../schema/gates.js";
import { SchemaError } from "../schema/errors.js";
import {
  BASE_GATES_PATH,
  exclusionsAtBoth,
  type BaseGatesRead,
} from "../gates/base_exclusions.js";
import { identitiesAtBase } from "../gates/base_identities.js";
import { resolveDeclaredExclusions } from "../gates/predicates.js";
import { declarationWarnings } from "../gates/ready.js";
import { GH, must, redactRemoteCredentials, type Seams } from "../seam/exec.js";
import { parseTarget, type Target , TargetError} from "../github/target.js";
import { classifyGatesPath, PR_READY_FLAGS, prReady, resolveIdentities } from "../verbs/pr_ready.js";
import type { FlagSpec } from "../cli/args.js";
import { conjoin } from "../cli/prose.js";
import { checkBody, validateRequirements, BodyCheckError, type BodyRequirement, type BodyCheckOptions } from "./bodycheck.js";
import {
  checkDerivedBody,
  deriveRequirements,
  describeReader,
  discoverTemplate,
  gitReader,
  workingTreeReader,
  type DerivedRequirement,
  type TemplateReader,
} from "./template.js";
import { computeStaleness, type VerifiedWake } from "./staleness.js";
import { nextBlocker } from "./blocker.js";
import { cascadeMain } from "./cascade.js";
import { fetchPullRequest, type PrSnapshot } from "./fetch.js";
import { assertPinnedHead, ConvergeReadError, readConvergeInput } from "./converge.js";
import { convergeComposite } from "./convergecomposite.js";
import { converge, DEFAULT_COVERAGE_POLICY, extractCriteria, PR_CONVERGE_CONTRACT, readCoveragePolicy, type ClosingIssue, type ConvergeReport, type CoveragePolicy, type CriteriaReport } from "../issue/criteria.js";
import { DEFAULT_CRITERIA_PREFIX } from "../issue/shape.js";
import { parseCatalogue, type IssueSectionsCatalogue } from "../issue/shape.js";
import { retarget } from "./retarget.js";
import { requestReviews } from "./reviewers.js";
import {
  botLabel,
  botRounds,
  canonicalBotLogins,
  ceilingRefusal,
  readRequestEvents,
  readGatesAt,
  resolveCeiling,
  RoundCeilingError,
  type BotRound,
  type RequestEvent,
} from "./round_ceiling.js";
import {
  EXIT_BOT_REQUEST_UNRECORDED,
  botLoginKey,
  isReviewerNodeId,
  isBotLoginInput,
  isBotLoginAlias,
  resolveBotLogin,
  fetchPrAndKnownBots,
  isCollaborator,
  requestBotReviews,
  type KnownBot,
  type PrAndKnownBots,
  type UnrecordedBot,
} from "./bots.js";
import { certifyPullRequest, editBodyArgv, writePullRequestBody } from "./editbody.js";
import { blockingExit, blocksWrite, type CheckedText, type IgnoreList, type PrivateNameCheck } from "../issue/privacy.js";
import { guardPrivateNames, PRIVATE_NAME_FLAGS, readIgnoreFlag } from "../issue/privacyguard.js";
import { LEDGER_ACTION_FLAGS, ledgerVerb } from "./ledger-verb.js";
import { GITHUB_COMMENT_LIMIT, PR_LEDGER_CONTRACT } from "./ledger.js";
import { LOGIN as OPEN_LOGIN, ME as OPEN_ME, OPEN_CONTRACT, openPullRequest } from "./open.js";
import { sectionsCommand } from "./sections_command.js";
import { plainLine } from "../cli/plain.js";
import { exitCodeFor, markReady, SHA_PREFIX as MARK_READY_SHA_PREFIX, type MarkReadyReport } from "./markready.js";
import {
  EXIT_FOR,
  listThreads,
  renderThreads,
  reply as replyToThread,
  resolve as resolveThread,
  printableArgv,
  ThreadsError,
  THREADS_CONTRACT,
  type ThreadsReport,
} from "./threads.js";
import {
  readSettleFile,
  refuseUnknownThreads,
  renderSettle,
  SETTLE_CONTRACT,
  settleExit,
  settleThreads,
  stoppedLine,
  type SettleReport,
} from "./settle.js";

function requireTarget(context: CommandContext): Target {
  const raw = requireTargetFlag(context, "It is the GitHub side of the pair; --repo names a checkout on disk and is never used to address the API.");
  // A MALFORMED value is the same mistake as a missing one -- a typo in a flag
  // -- so `parseTarget`'s own refusal is re-raised as a usage error and exits 2
  // rather than 1 (zheref/nen#93; Copilot, PR #195).
  return parseCallerToken(
    (): Target => parseTarget(raw),
    (error: unknown): boolean => error instanceof TargetError,
  );
}

function requirePr(context: CommandContext): number {
  const raw = context.args.values["pr"];
  const number = Number(raw ?? "");
  if (raw === undefined || !Number.isInteger(number) || number <= 0) {
    throw new VerbUsageError("--pr <number> is required.");
  }
  return number;
}

const USAGE = `nen pr ready --target <owner/name> --pr <n> [the same ready options below]
nen pr ready <ref> [--explain] [--gh-repo <owner/name>] [--reviewers <a,b,c>] [--reviewer-login <name>=<login>]... [--approvers <a,b>] [--round-policy strict|bounded] [--exclude-run <id>] [--exclude-check <name>]... [--gates <path>] [--token-env <VAR>] [--require-head <sha>] [--require-base-gates]
nen pr staleness --wakes-from <path> --last-activity <ISO> --now <ISO> [--ready] [--min-verified-wakes <n>] [--idle-minutes <n>]
nen pr body-check --body-from <path> [--requirements-from <path> | --base <ref>]
                  [--exact [--max <n>]] [--prose-budget <words>]
                  [--criteria <AC-1,AC-2> | --criteria-from <issue-body.md>] [--criteria-issue <[owner/name]#N>] [--catalogue <path>]
nen pr sections resolve --catalogue <path> --kind <kind> --family <family> [--with a,b] [--overrides <workflow.json>] [--json]
nen pr sections family --taxonomy <path> --catalogue <path> --jobs <a,b> [--json]
nen pr fetch --target <owner/name> --pr <n>
nen pr converge --target <owner/name> --pr <n> [--catalogue <catalogue.json>] [--require-head <sha>] [--json]
nen pr converge --target <owner/name> --pr <n> --composite --require-head <sha> --body-requirements <path> [--catalogue <catalogue.json>] [--json]
nen pr next-blocker --target <owner/name> --pr <n> --repo <path> [--reviewers a,b] [--policy bounded|strict] [--delivery-pr] [--gates <path>] [--requirements-from <path>]
nen pr cascade-main --repo <path> [--trunk main] [--no-push] [--dry-run]
nen pr retarget --target <owner/name> --pr <n> --base <branch> [--dry-run]
nen pr request-reviews --target <owner/name> --pr <n> [--add-reviewers a,b] [--add-bots login-or-id,...] [--dry-run]
nen pr edit-body --target <owner/name> --pr <n> --body-file <path> [--dry-run] [PRIVATE-NAME FLAGS]
nen pr mark-ready --target <owner/name> --pr <n> [--require-head <sha>] [--dry-run] [--json]
nen pr threads list|reply|resolve --target <owner/name> --pr <n> [--thread <id>] [--body-file <path>] [--dry-run] [--json] [PRIVATE-NAME FLAGS: reply]
nen pr threads settle --target <owner/name> --pr <n> --from <file.json> [--dry-run] [--json] [PRIVATE-NAME FLAGS]
nen pr open --target <owner/name> --base <ref> --title-file <path> --body-file <path> [--head <branch>] [--draft] [--assignee <login>[,<login>...]] [--repo <path>] [--dry-run] [--json] [PRIVATE-NAME FLAGS]

PRIVATE-NAME FLAGS (zheref/nen#363): [--skip-private-name-check]
  [--private-names-ignore-file <path> [--allow-all-ignored]]. 'edit-body',
  'threads reply', 'threads settle' and 'open' write caller text to GitHub,
  and run the private-name guard 'nen issue' runs (see 'nen issue --help',
  PRIVATE REPOSITORY NAMES) before the write -- on --dry-run too: the text
  is compared against the credential's live private repository list, a
  private repository named in text bound for a PUBLIC target exits 4 and
  writes nothing, a check that could not run exits 1 (a credential whose
  X-OAuth-Scopes lacks 'repo' included: its list may be partial), a private
  target is not checked and an internal one is. The guard's stderr lines begin 'nen pr <subcommand>:'
  and never print the name; --json adds 'privateNameCheck'. Fields checked:
  'open' title and body, before any other call; 'edit-body' body, after the
  certifying read; 'threads reply' body, before the walk; 'threads settle'
  every entry's body (entry[<n>], from 1), after the file's own refusals and
  before the walk. On 'threads', 4 is also 'no such thread' / 'the pull
  request is not visible': a guard refusal is told apart by its stderr lines
  and, under --json, by privateNameCheck.result "refused", which those
  refusals never print. 'open' and 'edit-body' hand gh the checked bytes on
  stdin ('--body-file -'), never the path.
nen pr merge <n|owner/name#n|CODE#n> --release-unit --requirements-from <path> --repo <path> [--run] [--json]
nen pr merge <n|owner/name#n|CODE#n> --delivery --requirements-from <path> --repo <path> [--require-head <sha>] [--run] [--json]
nen pr ledger post --target <owner/name> --pr <n> --effort <id> [--findings <path> --findings-schema <path>] [--proof <path>]... [--login <name>] [--dry-run] [--repo <path>] [--json] [PRIVATE-NAME FLAGS]
nen pr ledger read --target <owner/name> --pr <n> --effort <id> [--restore] [--login <name>] [--repo <path>] [--json]

Flags are PER SUBCOMMAND (zheref/nen#351). Every subcommand refuses, at exit
2 and before any gh call, each flag it does not read -- another
subcommand's flag exactly as a misspelt one, 'pr ready''s --token-env and
--gh-repo included -- and the refusal names the subcommands that do read
it. A threads action reads only its own action's flags, and tokens after a
bare '--' are refused too: no subcommand forwards arguments. The global
--repo, --json and --help are never refused.

ready:
  Report a pull request's CON-32 readiness: the gate's verdict and every
  conjunct row (ready / FAILED / unknown, with why). Every row is evaluated;
  the verdict is their conjunction and the first line quotes the FIRST failing
  row. Read-only -- it never labels, merges or comments.
  aiReviewers is read from nen/workflow.json at the pinned PR base and
  default-branch tip: required > optional > off; absent/unreadable is required.
  Optional/off waive only bots consistently declared kind: bot by both trusted
  gates files. Human/unknown rounds, stalls, approvals and other gates bind.
  JSON keeps raw owedRounds/quorum and adds meta.aiReviewers provenance,
  owedRounds[].waivedByAiPolicy and the separate aiPolicyQuorum judgment.
  THE VERDICT CONCERNS GITHUB'S CURRENT HEAD for the pull request at the moment
  it is read -- not your local commit. A push still in flight is judged as its
  parent. Every output states the judged head, and warns (naming both SHAs)
  when run inside a checkout of the PR's head branch whose tip differs.
  --require-head <sha> pins it. Exit 0 ready; 1 not-ready or unevaluated;
  2 usage or a refused gates file (unreadable, malformed, or carrying a key
  this build does not read, zheref/nen#310); 8 head-mismatch (--require-head
  did not match; no verdict).
  <ref>                       <CODE>#<N> via the target repo's product codes,
                              or a bare <N> with --gh-repo. The '#' may be
                              omitted (AB123 = AB#123); the shorthand reads the
                              LONGEST trailing digit run as the number, so a
                              code that itself ends in a digit needs the '#' --
                              <CODE>#<N> is the unambiguous form.
  --target <owner/name>       Alias for --gh-repo; may pair with a positional
                              ref. Must agree with --gh-repo and a coded ref.
  --pr <n>                   Alias for the positional number; may pair with
                              --gh-repo or a coded ref. Must agree with an
                              existing positional number. A missing object
                              or repository, malformed alias, or conflicting
                              declarations is exit 2 before any GitHub read.
  --gh-repo <owner/name>      The repository, when the ref is a bare number.
  --explain                   The conjunct table, in evaluation order, plus
                              what the gate does NOT decide. When nen/gates.json
                              states round_policy.minRounds or .maxRounds, also
                              each reviewer's requested and posted rounds
                              against both (--json: meta.roundCounts) --
                              counted, never a conjunct (zheref/nen#240). And
                              for each check still QUEUED at the judged head,
                              whether an ONLINE runner carries its runs-on
                              labels -- online, offline-only, no-runner,
                              github-hosted, started, environment-wait, or
                              undetermined with why and any missing permission
                              -- and its queue age; a stall is called only
                              after 10 minutes queued (--json:
                              meta.runnerAvailability). Diagnosis only: the
                              verdict and exit are unchanged (zheref/nen#224).
  --reviewers <a,b,c>         The configured reviewer set (mirrors the shell
                              gate's flag). Also the identity source of last
                              resort -- see --gates. On that path each name is
                              the WHOLE login, case-insensitive, with an
                              optional [bot] suffix -- never a substring or a
                              regex (zheref/nen#264): 'alice' is not
                              'Not-Alice-Fan'.
  --reviewer-login <name>=<login>
                              REPEATABLE. The exact login a --reviewers name
                              posts under, on that flags path only: whole,
                              case-insensitive, optional [bot]; repeat a name
                              for alternatives. Nothing is built in -- without
                              it the name must equal the login. A name
                              --reviewers does not list is exit 2; beside a
                              gates file it is ignored with a warning (declare
                              login_pattern there).
  --approvers <a,b>           The approval set, when identities come from flags.
  --round-policy <p>          strict | bounded. Default bounded.
  --exclude-run <id>          Drop one Actions run's own checks (CON-36 clause
                              3; pass it only from inside that run's own job).
  --exclude-check <name>      Drop checks BY EXACT NAME from CON-32(a) (zheref/nen#216): a repository whose only reporting
                              check is its own readiness run would otherwise
                              read a false ready off that prior check. An
                              EMPTY rollup after exclusion is 'not-ready: no
                              checks reported', never ready. REPEATABLE, one
                              name per occurrence (zheref/nen#243); one value
                              may also join names with commas, and a comma
                              inside ()/[]/{} is part of the name, so a
                              matrix job such as 'check (Windows,
                              ["self-hosted","Windows","X64"])' is one name.
                              An opener never closed with a comma after it is
                              refused (exit 2) -- repeat the flag instead. A
                              name with a comma outside every bracket cannot
                              be named. Combines with nen/gates.json's
                              declared checks.excluded (zheref/nen#249), which
                              is read AT THE PR's BASE commit (never the local
                              file) and needs contents:read: a standing ruling
                              belongs there, with its reason, ruling date and
                              until, not in a flag.
  --gates <path>              Read every gate input but checks.excluded from
                              this file -- the caller's word, used as given --
                              instead of nen/gates.json at the PR's base.
                              A RELATIVE path is resolved against the --repo
                              root, NOT the current directory; pass an
                              absolute path for a file outside the target
                              repository. A --gates naming the checkout's OWN
                              nen/gates.json (any spelling, a hard link) is
                              the head's file and is read at the base like
                              the default; any other file inside the checkout
                              may be head content, applied with a warning
                              (meta.identities.read: local-fallback). The
                              resolved path is what --explain and --json
                              report.
  THE GATES FILE IS THE BASE'S (zheref/nen#372). Without --gates, every input
  nen/gates.json supplies -- every reviewers[] key (name, kind, login_pattern,
  review/round/enrolment_check_pattern, bounded_policy_exempt,
  delivery_holistic_pass, approves_when_posted_at_head), default_approvers,
  approval_policy, base_reviewers, round_quorum, round_policy, delivery,
  dependabot_carve_out, checks.excluded -- is read at the PR's BASE commit
  (contents:read), not from the --repo checkout (in a worktree the PR's own
  head) unless the base cannot be READ: a PR cannot loosen its own gate.
    base could not be read (403, network)  the checkout's file, warned
                                           (read: local-fallback); 'pr merge'
                                           and 'watch until --until ready'
                                           refuse such a ready
    base declares no nen/gates.json        --reviewers' own identities if
                                           given (read: null), else NO
                                           verdict: unevaluated, exit 1
    base file this build refuses           NO verdict: unevaluated, exit 1
                                           (upgrade nen)
  The checkout carrying NO nen/gates.json (a head that deleted it) with
  --reviewers reads the base all the same: a base file applies, --reviewers
  narrowing it (read: base, warned); none at the base, the flags are the gate
  (read: null); a base that could not be read leaves the flags unverified
  (read: flags-unverified, refused like local-fallback); a refused base file
  is no verdict. checks.excluded is never taken from the checkout. With
  --gates naming a file outside the checkout, that file supplies the rest and
  base/default-tip intersection supplies checks.excluded (read: gates-flag).
  'watch until --pr' and 'pr merge' run this same read.
  checks.excluded requires the SAME complete declaration at BOTH the base
  and default-branch tip, pinned by OID from the same GitHub snapshot. A
  missing/unreadable/refused side authorises none; diagnostics name it.
  JSON's rounds-owed row adds owedRounds: { reviewer, reason,
  coveredByQuorum, kind?, state? }[].
  Event state is in-flight|no-run|completed-without-review|posted. Event
  lanes are never requested; their review job proves activity only. It includes excused quorum members; [] means
  computed with none owed, absent means uncomputed (including CON-30).
  kind is only the declared bot|human classification, never inferred.
  --require-base-gates        No verdict unless the gate inputs were the
                              base's: read base, gates-flag, or null (the
                              base read, declaring none). Any other route --
                              local-fallback, flags-unverified -- is
                              unevaluated, exit 1, naming it. A ready on the
                              checkout's file otherwise exits 0 like a
                              base-judged one; pass this wherever the exit
                              code is acted on (a script, a required check,
                              an agent). 'watch until --pr' takes it too.
  --token-env <VAR>           Environment variable holding the token. Default
                              GH_TOKEN; never picked up ambiently.
  --require-head <sha>        Judge ONLY this commit (7-40 hex digits, a prefix
                              of GitHub's head, any case). If GitHub's head is
                              anything else: exit 8, status head-mismatch, both
                              SHAs printed, and NO verdict. The verb never
                              waits or retries; polling is the caller's.

staleness:
  A pull request is STALE at >=2 verified no-commit wakes AND >=60 minutes
  idle (both defaults, overridable). Stale + Ready is the one case a merge is
  permitted without a human.
  --wakes-from <path>   A JSON array of { at, noCommit }.

sections:
  resolve reads caller-owned sections[], footer[], families{}, precedence[],
  variants{"<kind>.<family>": [ids]} and max. The JSON contract is
  'nen.pr.sections/v0.1'. --with admits sections whose 'when' names a run fact;
  --overrides reads workflow.json's pr.sections cell map. Only reader sections
  count against the catalogue max; footer blocks remain outside it.
  family counts distinct taxonomy job keys; ties use catalogue precedence.

body-check:
  --exact refuses undeclared, repeated, ambiguous or out-of-order level-2
  headings outside fences/comments, naming the line. --max requires --exact.
  --prose-budget warns per section over the budget, excluding tables, code
  (including Mermaid) and comments, without changing the verdict.
  Every requirement is checked; never stops at the first miss.
  --criteria <ids> | --criteria-from <file>  One verify row per acceptance
                              criterion (zheref/nen#479; CON-17(c), HR-11):
                              the closing issue's AC ids, comma-separated, or
                              read from a local copy of its body ('- AC-{n}:'
                              rows, as 'nen issue criteria' reads them), held
                              to the body's '| <criterion> | <word> |
                              <evidence> |' rows by the comparison 'pr
                              converge' runs. An id with no row, a word
                              outside satisfied, partial, missing,
                              contradicts, unrequested, a row with two words,
                              a row reading missing or contradicts (quoted),
                              or an issue body with no criterion is exit 1.
                              --criteria-issue <[owner/name]#N> names the
                              issue, so <CODE>#<N>/AC-{n} rows match;
                              --catalogue <path> gives the issue-sections
                              catalogue (prefix, sections, 'coverage').
                              Local files only, as ever; live reads are
                              'pr converge'. One issue per run: several
                              closing issues are 'pr converge''s job.
                              --json adds 'criteria'.
  --requirements-from <path>  A JSON array of { name, pattern } -- this
                              repository's own template convention, never a
                              literal shipped here.
  Without --requirements-from the set is DERIVED from the repository's own
  pull-request template (GitHub's locations: pull_request_template.md or
  .txt, any case, at the root, .github/ or docs/; else one .md/.txt file in
  a PULL_REQUEST_TEMPLATE/ directory there; a file with no extension is not
  read): each of its headings becomes a required heading at the same level,
  and each must have content under it -- a heading with none is EMPTY. The
  verdict line names the template and where it was read, and --json carries
  'source' { kind: shipped|derived, path, ref, commit }. Two default
  templates, or several directory templates and no default, is AMBIGUOUS;
  no template, an unreadable one, one outside the repository, or one with
  no headings is a refusal (exit 2) -- never a silent skip. Bootstrap:
  docs/USAGE.md, "Bootstrapping a body-check requirements file".
  --base <ref>                Read the template from git at <ref>, never the
                              working tree. A PR's head can edit its own
                              template, so a gate passes the base. A ref
                              that is not one commit (a range included), or
                              one starting with '-', exits 2; so does a
                              template that is a symlink at <ref>. The
                              verdict names the ref and its short oid, and
                              'source.commit' the full oid. Only with a
                              derived set.

fetch:
  One typed snapshot: head SHA, mergeability, the check rollup, reviews
  PER COMMIT, review threads with resolution state, pending review
  requests.

converge:
  Read-only. Compares the acceptance criteria of every issue the PR closes
  (GitHub's closingIssuesReferences; on a base that is not the default
  branch, where GitHub computes none, the body's Closes/Fixes/Resolves
  keywords) with the PR body's verify rows '| <criterion> | <word> |
  <evidence> |', where <criterion> is AC-{n}, <CODE>#<N>/AC-{n},
  <owner/name>#<N>/AC-{n}, #<N>/AC-{n} or none, and <word> is satisfied,
  partial, missing, contradicts or unrequested. Criteria are read as 'nen
  issue criteria' reads them; --catalogue <catalogue.json> (deprecated alias
  here: --requirements-from, which on body-check, next-blocker and merge
  names the body requirements) gives the
  issue-sections catalogue (its acceptance prefix and section) and an
  optional 'coverage' block (blocking words, the none word, evidence
  required or optional) -- with none, the defaults are AC rows anywhere in
  the body, missing and contradicts blocking, unrequested on none rows, and
  evidence required. Reports per criterion: covered-with-evidence,
  covered-without-evidence, missing-row, malformed-row, duplicate-rows,
  not-verifiable, and the row's word. Exits: 0 nothing blocks (a PR into
  the default branch closing no issue is 0); 1 any blocking row -- a
  missing-row, malformed-row (a word outside the five, or two words, in one
  row) or duplicate-rows criterion, a blocking word (its row quoted), a
  criterion row saying unrequested, a criterion without evidence, a closing
  issue stating no criterion (not-verifiable) or carrying an unrecognised AC
  row, a none row with a problem, an unmatched or malformed verify row -- or
  a read that did not finish (the PR, the default branch, a closing issue, a
  full page of 100 closing references), stdout empty; a non-default base
  whose body names no closing issue is reported, never blocked; 2 usage or a
  malformed catalogue. --require-head <sha> pins every read to one full
  commit (first read and a closing head re-read; else exit 1 -- 3 under
  --composite -- no verdict).
  --composite (zheref/nen#483 AC-1; needs --require-head and
  --body-requirements <path>, the '{ name, pattern }' file 'pr body-check'
  reads): ONE verdict at the pinned head from four conjuncts -- 'pr ready'
  (in-process, as 'pr merge' runs it), the body check, the closing-issue
  links (into the default branch, every body closing keyword is a GitHub
  closing link and every GitHub closing link is named in the body; on
  another base, read from the body) and the criteria coverage. Exit 0 all
  four hold; 1 any does not; 3 any read did not finish or was at another
  head (no verdict, stdout empty) -- could-not-look has its own exit here.
  'pr merge --delivery' gates on the same criteria and links conjuncts. --json: '{ contract, composite: true, target,
  pr, url, headSha, requiredHead, base, closingSource, ready, conjuncts: [{
  name, ok, lines }], blocking }'. Otherwise --json: '{
  contract: "nen.pr.converge/v0.1", target, pr, url, headSha, base,
  closingSource, verifiable, closingIssues: [{ issue, criteria, verifiable,
  unrecognised }], criteria: [{ issue, id, text, coverage, word, evidence,
  rows, raw }], unrequested: [{ line, word, evidence, problem }], unmatched: [{
  line, cell, reason }], malformed: [{ line, cell, reason }], counts,
  blocking }'.

next-blocker:
  The FIRST blocking condition, fixed order: conflict -> red required
  check -> owed reviewer round -> unresolved thread -> missing body
  requirement (CON-17): with --requirements-from, the first unsatisfied
  requirement of the same '{ name, pattern }' file 'pr body-check' reads;
  without it, a '## How to verify' heading. Exits 1 when something blocks,
  2 on usage or a refused gates file (as pr ready does, zheref/nen#310),
  0 when this check finds nothing -- the adversarial confirmation pass
  stays human. NOTE: the changelog.d/ fragment half of CON-33(a) is
  diff-shaped and not checked here; see ../pr/blocker.ts's header.
  --gates <path>              Read reviewer identities from this gates file
                              instead of nen/gates.json at the PR's base
                              -- the same flag 'ready' takes, through the same
                              resolver, so a checkout that ships no gates file
                              can still be evaluated. A RELATIVE path is
                              resolved against --repo, NOT the current
                              directory, exactly as it is for 'ready'.
  Reviewer identities and other inputs retain the PR's BASE route (#372).
  checks.excluded is the intersection of complete declarations at the pinned
  base and default-tip OIDs (#403), the same rule as 'ready'. A missing,
  unreadable or refused side authorises none; warnings name the source.
  Without --gates (or with one naming the checkout's own file), a base that
  could not be read falls back to the checkout's file, with a warning; a base
  that declares no file, or one this build refuses, is exit 2. --json adds
  identities { path, read } and declaredExclusionsSource naming both pinned
  files and their intersection.

cascade-main:
  Merges (never rebases) the trunk into the current branch and pushes on a
  clean merge. Reports a conflict rather than resolving it.
  --no-push                   Fetch and merge exactly as always, then stop --
                              never push. Still mutates the working tree and
                              index (the merge happens); --json gains
                              'noPush: true'. Exit codes are unchanged: 0 on a
                              clean merge, 1 on a conflict.
  --dry-run                   Print every git call (fetch, merge, push unless
                              --no-push) as 'would run:' and run none of them,
                              the fetch included; exit 0. Whether the merge
                              would conflict is only known by merging. --json
                              gains 'dryRun: true'.

retarget:
  gh pr edit --base, for a stacked PR after its predecessor merges.
  --dry-run  print 'would run: gh pr edit <n> --repo <o/n> --base <b>' and
             call nothing, not even a read; exit 0. --json: { ok, message,
             dryRun, command }.

request-reviews:
  Two routes, chosen per name -- 'gh pr edit --add-reviewer' (once per
  name) for a User or a Team, and GitHub's 'requestReviews' GraphQL
  mutation (botIds, one call for every bot named or resolved) for a Bot,
  because 'gh pr edit --add-reviewer' resolves through
  'requestReviewsByLogin', which never resolves a Bot reviewer at all
  (zheref/nen#160). Request on the MAINTAINER's user token -- a bot
  token silently no-ops on the user route (S6); this verb cannot
  enforce which credential ran it, only warn.
  --add-reviewers <a,b>  Logins, resolved one by one: an entry containing
                         a '/' (an 'org/team' slug) is a TEAM and goes
                         straight to 'gh pr edit --add-reviewer', no
                         lookup; a bare login already known as a Bot is
                         routed to botIds; a collaborator goes through the
                         user route. Other bot logins resolve with GET
                         /users/<login>[bot]; a missing login is refused.
                         API aliases and '[bot]' spellings use the bot route.
  --add-bots <login-or-id,...>
                         Bot logins (short or '[bot]' spelling) and known
                         GitHub API aliases are resolved through GitHub to
                         obtain the Bot node_id. Explicit
                         GraphQL node ids remain accepted unchanged.
  --dry-run              Resolution still runs (this verb is not
                         network-free even here) but nothing is
                         requested; prints which route -- bot, user or
                         team -- each name or id went to instead.
  THE ROUND CEILING (zheref/nen#240): before any bot is requested,
  round_policy.maxRounds is read from nen/gates.json at the PULL
  REQUEST'S BASE and at the DEFAULT BRANCH's tip, the LOWER applied,
  and each bot's review_requested timeline events are counted by node
  id (its canonical login only as a fallback). A request that
  would pass the ceiling refuses the WHOLE call at exit 2 -- naming the
  bot, its count, the request it would be and the ceiling's sources --
  and nothing is requested; --dry-run previews the same, and prints
  'request N of M' per bot inside it. Neither commit stating maxRounds
  (only a file-level 404 at a readable commit is "no file") is no
  ceiling. A commit, file or timeline that cannot be read, a file that
  does not validate, an id that is not a Bot, or a legacy id GitHub
  answers under another canonical id (named in the refusal) refuses the
  bot request at exit 1. Users and teams are not capped. A GUARDRAIL, not a lock:
  'gh pr edit', raw GraphQL and the web UI request reviews without this
  verb, and the count is not atomic with the request.
  --json adds 'ceiling' ({ maxRounds, source } or null) and 'rounds'
  ([{ id, login, requested, next, maxRounds, refused }]) when a bot is
  named.
  A bot is reported as requested only when the mutation's OWN response
  lists it, by node id, as pending review (zheref/nen#277). A successful
  response may omit a requested bot; it does not prove whether GitHub
  recorded it. Exit codes: 0 every name requested (or a --dry-run); 1 nothing
  named, or a route's gh call failed or answered something unreadable,
  or the round ceiling could not be checked; 2 usage (a missing --pr, an
  unresolved --add-reviewers or --add-bots login, or an invalid explicit
  Bot node id) or a bot past
  round_policy.maxRounds; 9 every
  call was ACCEPTED but at least one requested bot is absent from the
  response's pending-review page
  -- named in the message, and in --json's 'unrecordedBots' ([{ id, login
  }], login null for a bot this pull request has never seen). The response cannot determine allowance exhaustion versus an otherwise
  unrecorded request; its first:100 page may omit a pending bot. When a call also failed outright, 1 wins and
  'unrecordedBots' still names the bot. --json: '{ ok, routing, message,
  unrecordedBots }'.

edit-body:
  Replaces the pull request's body OUTRIGHT with the file's bytes -- no
  trimming, no template, the file becomes the body exactly, through
  'gh pr edit --body-file -', the bytes on stdin. --body-file is required; there is no inline
  --body. Refused (exit 2): a missing or unreadable --body-file, an empty
  or whitespace-only one, a non-numeric/non-positive --pr. The number is
  CERTIFIED as a pull request before any write -- unlike 'nen issue
  comment', which deliberately accepts either object class, this verb never
  writes the wrong object: a number that does not read as a pull request
  (the target repository's 'pulls/<n>' answers 404/410) is refused before
  anything changes, worded so it does not claim the number IS an issue --
  only that it is not a pull request -- and points at 'nen issue edit-body'
  next. --dry-run still performs that certifying read (this verb is not
  network-free) and the private-name guard (PRIVATE-NAME FLAGS above), then
  prints the target, the number, the byte count and the first and last line
  of the body instead of writing. --json: '{ contract: "nen.pr.edit-body/v0.1",
  target, number, bytes, written, dryRun, privateNameCheck }'. Exit 4: the
  guard refused, nothing written.

mark-ready:
  Move ONE existing draft pull request out of draft, through GitHub's
  'markPullRequestReadyForReview' mutation (zheref/nen#345). NOT 'pr ready':
  that verb is the read-only CON-32 verdict and decides nothing here; this
  one changes isDraft and decides nothing about readiness. It never merges,
  votes, labels, requests reviewers or touches permissions, and it runs on
  whatever credential gh already holds -- a refusal is reported, never
  routed around.
  ONE READ FIRST, BEFORE ANY WRITE: the number must resolve as a pull
  request in --target (exit 2 if it, or the repository, does not), be OPEN
  (exit 3 if CLOSED or MERGED), and carry the --require-head commit when one
  is given (exit 8, both SHAs printed). Already NOT a draft: exit 0,
  status already-ready, nothing sent. Otherwise the mutation is addressed by
  the node id that read produced, and GitHub is READ BACK: success (exit 0,
  marked-ready) only when the same pull request now reads isDraft false.
  A 200 carrying errors is refused (exit 1); a non-zero gh exit or a
  non-JSON answer is read back like any other, and a failed or still-draft
  read back is unconfirmed (exit 1) -- never reported as ready. Every flag
  this verb does not read (pr ready's --token-env, --gh-repo, ... included)
  is refused at exit 2 before any call.
  --require-head <sha>  7-40 hex digits, a prefix of GitHub's head, any case.
                        Refused before the write unless it matches; the
                        mutation itself is not pinned, so a head that moved
                        by the read back is marked-ready-head-moved: the
                        pull request left draft, the pin no longer holds,
                        exit 8. Without --require-head a moved head is only
                        reported (headMoved), at exit 0.
  --dry-run             The read and every refusal above still run; prints
                        the exact 'gh api graphql' mutation argv and sends
                        nothing.
  --json: '{ contract: "nen.pr.mark-ready/v0.1", status, ok, target, number,
  url, stateBefore, wasDraft, isDraft, requiredHead, headBefore, headAfter,
  headMoved, sent, dryRun, mutationArgv, message }'.

threads:
  The review-thread half of a pull request (zheref/nen#215): 'list' reads
  every thread, PAGINATED TO COMPLETION and fail-closed exactly as 'fetch'
  reads them, with each one's id, resolution state, path, line, first
  comment's author and first 200 characters, and url. 'reply --thread <id>
  --body-file <path>' posts one reply through GitHub's
  'addPullRequestReviewThreadReply' mutation; 'resolve --thread <id>' closes
  one through 'resolveReviewThread'.
  --thread <id>   The GraphQL node id 'list' prints -- never a position. The
                  third thread stops being the third one the moment anybody
                  comments, so there is no positional form.
  --body-file <path>  Required by 'reply'. The reply's bytes, read raw; a
                  body typed on a command line is a body nobody reviewed.
  --dry-run       Prints the exact 'gh api graphql' argv that WOULD run and
                  writes nothing. The thread is still looked up (so a
                  non-existent id is still exit 4 and an already-resolved
                  one still exit 3), because a dry run whose refusals differ
                  from the real run's proves nothing.
  Exit codes, as a published contract: 0 done; 1 the API refused; 2 usage;
  3 the thread is ALREADY RESOLVED, named, with nothing sent; 4 no such
  thread on this pull request, named; 5 the credential could not
  authenticate. --json: '{ contract: "nen.pr.threads/v0.1", target, pr,
  head, thread, replied, resolved, dryRun, threads[] }'.
  'settle --from <file.json>' settles a BATCH (zheref/nen#230): the thread
  list is walked ONCE, then one reply and one resolve mutation per entry, in
  file order -- 2N + P calls (P = pages of 100 threads) where the single
  verbs cost 4N. The file is a JSON array of { "thread": "<id>", "body":
  "<text>" } or { "thread": "<id>", "bodyFile": "<path>" }. A bodyFile is
  CONFINED to the batch file's own directory: relative, no '..' segment and
  no segment starting with '.' (.env, .git/config), its real path (after
  symlinks) inside that directory's real path, and a regular file with one
  hard link, opened without following a final symlink and checked on the
  descriptor it is read from -- an absolute path, a symlink that escapes, a
  dot-file, a hard link, a device or a FIFO is refused. Its real path is
  reported in bodyFrom and on each entry line. Every body, inline or read,
  is at most 65536 characters and is refused if it carries a credential's
  shape (a GitHub token or PAT, a URL's user:secret@).
  --from <file.json>  Required by 'settle'; relative to --repo. Read like a
                  bodyFile: a regular file, checked on its descriptor, at
                  most 4 MiB -- a FIFO, a device or a directory is refused.
  REFUSED AT EXIT 2, ALL PROBLEMS NAMED, NOTHING SENT: a file that is not a
  non-empty JSON array; an entry with an unknown key, no 'thread', a thread
  id carrying a control character, both or neither of 'body'/'bodyFile', a
  bodyFile refused as above or unreadable, or an empty or oversize body; a
  thread id named twice; and -- after the one walk -- an id this pull
  request does not carry. An ALREADY-RESOLVED thread (per the walk's
  snapshot) is reported against its entry as 'already-resolved', nothing
  sent to it, and the rest proceeds.
  A mutation refused partway STOPS the batch: the report names which
  threads were replied to and resolved, replied to only, and not attempted;
  nothing is retried. --dry-run walks, validates, prints both argvs and every
  reply body per entry, and sends nothing. Exit: 0 every entry settled (or
  planned); 3 every other entry settled and at least one was already
  resolved; 1 / 5 the batch stopped on an API refusal / an authentication
  failure; 4 the pull request itself is not visible; 2 as above. --json:
  '{ contract: "nen.pr.threads-settle/v0.1", target, pr, head, from, dryRun,
  ok, stoppedAt, entries[]: { thread, disposition, replied, resolved,
  bodyBytes, bodyFrom, replyArgv, resolveArgv, error } }', disposition one of
  resolved, replied, already-resolved, failed, not-attempted, planned.

open:
  Open exactly ONE pull request from a head that is already on the remote
  (zheref/nen#227). The head is --head, or the branch checked out under
  --repo (default: the current directory).
  --base <ref>         the pull request's base branch on GitHub.
  --title-file <path>  the title: the file's first non-empty line.
  --body-file <path>   the body, read once, checked by the private-name guard
                       (PRIVATE-NAME FLAGS above) and handed to 'gh pr create'
                       on stdin ('--body-file -'), never by path.
  --head <branch>      the head branch; default the checked-out branch.
  --draft              open it as a draft.
  --assignee <login>[,<login>...]  assign the pull request as it is opened
                       (zheref/nen#293). '@me' is resolved to the login of
                       the token running this verb ('GET /user') and that
                       login is printed -- '@me' is never passed through.
                       Every login is checked BEFORE the pull request is
                       opened: 'GET /users/<login>' (exit 2 naming an unknown
                       one) and 'GET /repos/<o>/<n>/assignees/<login>' (exit
                       2 naming one that cannot be assigned here). The
                       assignees are read back after the create; one missing
                       is exit 1 with the opened pull request still named.
  --dry-run            print the 'gh pr create' argv; still asks git and
                       GitHub every question below, creates nothing.
  REFUSED AT EXIT 2: a detached HEAD with no --head; a head with no upstream;
  a head whose local sha is not what 'git ls-remote <remote> refs/heads/<b>'
  answers, where <remote>/<b> is what '<head>@{upstream}' names (origin only
  when that is the upstream's remote; a head tracking fork/<b> is asked of
  fork) -- push first. ALREADY OPEN for that head ('gh pr list --head'):
  against the same --base, at the head commit pushed here, it is the pull
  request a previous call opened (a retry after a timeout), reported
  'opened: existing' with its number and url at EXIT 0, nothing created;
  another base or head commit (a same-named branch on a fork), or a fork's
  pull request even at the same commit (isCrossRepository), EXIT 1,
  nothing opened or retargeted.
  --json: '{ contract: "${OPEN_CONTRACT}", number, url, head, base, draft,
  dryRun, existing, assignees, me, assigned }' -- number and url null on a
  dry run; existing true when a pull request was already open for the head,
  where they name the pull request already there; assignees the validated logins asked for ([] without
  --assignee); me the login '@me' resolved to, else null; assigned the
  logins the read-back found, null when nothing was opened or read back --
  then privateNameCheck. EXIT 4, nothing asked and nothing opened: the
  private-name guard found a private repository named in the title or body;
  '{ contract, dryRun, opened: false, privateNameCheck }' under --json.

ledger:
  An effort's ledger slice as ONE pull request comment (zheref/nen#510),
  contract '${PR_LEDGER_CONTRACT}': { contract, effort, repo, pr, head, phases[],
  usage { entries, totals[] }, findings { schema { id, sha256 }, document } |
  null, proof[] { path, sha256, bytes } }, in a json fence behind the marker
  '<!-- nen:ledger effort=<encoded id> sha256=<digest of the fenced json> -->'.
  The phases and usage come from the effort's durable ledgers
  (<git-common-dir>/.nen/phases|usage/).
  post: validates --findings against --findings-schema (the caller's own JSON
    Schema; nen carries no consumer's contract; a keyword nen does not assert,
    a supported keyword with a malformed value, or a $ref outside subschema
    positions is refused, exit 2), hashes each --proof file (repo-relative;
    outside --repo is exit 2), writes the repository root as '.' in notes and
    step argv, refuses a credential's shape anywhere in the slice
    (secret-shape, exit 1, the field named), runs the private-name guard,
    then posts a new comment, or EDITS this login's one marked comment for
    the effort in place. The comment is as visible as the PR. Verdicts: posted | updated | unchanged (the same
    bytes are already there) | dry-run (prints the gh call and the body,
    writes nothing) | findings-invalid (exit 1, the first failing JSON pointer
    named, nothing posted) | too-large (exit 1: over GitHub's ${GITHUB_COMMENT_LIMIT}-
    character limit, both sizes named, never truncated) | refused (exit 4,
    the private-name guard). Two marked comments by this login is exit 1.
  read: the one marked comment the AUTHENTICATED login (or --login, for a
    token that cannot read 'user') wrote for the effort AND nobody else
    edited; marked comments by any other author or editor are counted
    (foreign: n) and never read. Verdicts: ok (exit 0: its head is the PR's head) | stale (exit 1:
    the PR moved on) | could-not-read (exit 1: none, two, edited -- the
    digest does not match -- or not this contract). --restore writes the
    slice's phases as the effort's phase ledger when there is none
    ('restored'), 'unchanged' when it agrees, and refuses (exit 1, nothing
    overwritten) one that disagrees, naming both. A stale slice IS restored
    and still exits 1.
  --json: { contract, verdict, ... } (post: posted, url, size, slice,
  privateNameCheck; read: login, foreign, url, slice, restored).

merge:
  THE BOUNDED MERGE THIS BINARY PERFORMS, in exactly two forms: a release
  unit (--release-unit) and a run's own delivery into a non-main base
  (--delivery, below). Never a general-purpose merge -- refused (exit 2)
  without one of the two, and with both. --release-unit evaluates, IN ORDER, every one of: 'pr ready'
  (../verbs/pr_ready.ts's own gate, called IN-PROCESS -- never a
  subprocess), 'head pin' (GitHub's head must still be the exact commit
  'pr ready' judged), 'pr body-check' (against the pull request's LIVE
  body -- read as part of the ONE 'gh pr view' fetch this verb makes of
  the pull request, never a second, independent read -- and
  --requirements-from), 'release unit-check' (against 'release.unitPaths'
  in nen/workflow.json AT THE PULL REQUEST'S BASE COMMIT, never this
  checkout's own local file -- refused outright when the pull request
  itself changes nen/workflow.json or nen/gates.json, or when a changed
  path inside the unit is a symlink or a submodule), and 'whose pr'
  (refused when the pull request is cross-repository, or its author is
  not the authenticated viewer). EVERY GATE runs regardless of an earlier
  failure, and every verdict line is printed VERBATIM, the same sentence
  the standalone verb would print.
  Without --run: prints the plan only (every verdict line, plus the exact
  'gh pr merge' argv that WOULD run) and exits 0 when every gate passed, 1
  otherwise. With --run: on a passing plan, executes 'gh pr merge <n>
  --merge --match-head-commit <judgedHead>' -- NEVER --admin, NEVER
  --auto; this verb's own flag set declares neither, so passing either is
  refused at the parser (exit 2) before this subcommand ever runs. A
  successful 'gh pr merge' exit is not itself trusted as "merged": the
  pull request's state is re-read, and 'merged' is reported only when
  GitHub's own state is MERGED -- otherwise this prints "queued (auto-merge
  or merge queue)", naming the state read back.
  <ref>                       <n> -- --repo's own origin; owner/name#<n>;
                              or <CODE>#<n> -- the code resolved through
                              --repo's nen/repos.json by the SAME lookup
                              'pr ready <CODE>#<N>' uses (zheref/nen#269),
                              case-insensitive over A-Z only; a code that
                              matches two keys differing only by case is
                              refused (exit 2), naming both, never picked.
                              Every form must name --repo's origin: a slug
                              or a code resolving to any other repository
                              is refused (exit 2), never merged. NARROWER
                              THAN 'pr ready', DELIBERATELY: the '#' is
                              required -- the no-'#' shorthand (AB123)
                              splits by a rule, not a delimiter, and a verb
                              that merges takes only the unambiguous form.
  --requirements-from <path>  The same '{ name, pattern }' JSON array
                              'pr body-check' takes, validated (exists,
                              non-empty, parseable) before ANY gh call.
  --run                       Execute the merge once every gate passes.
                              Omit it to see the plan only.
  Exit codes: 0 merged, or a passing plan printed without --run; 1 at
  least one gate did not pass; 2 usage (neither or both of --release-unit
  and --delivery, a flag merge does not read, --require-head, a bad ref,
  an unknown or unreadable product code, missing --requirements-from,
  --repo's origin naming a different repository than the ref or the code
  resolves to, or an unknown flag such as --admin/--auto -- unknown to
  'pr merge' itself: a flag another 'pr' subcommand reads is refused
  here too, as it is on every subcommand, zheref/nen#351);
  5 gh REFUSED the merge (branch protection, a required review, ...) --
  its stderr and the exact command are printed for a human; 6 gh could
  not be RUN at all (not on PATH, no permission) -- distinct from 5,
  which means gh ran and said no.
  --json: '{ contract: "nen.pr.merge-unit/v0.1", target, pr, ready,
  bodyOk, unitOk, pinOk, wholeOk, ok, ran, spawnFailed, judgedHead, state,
  mergeArgv, gates: [{ name, ok, lines }] }'.
  --require-head is refused (exit 2) with --release-unit.

merge --delivery (zheref/nen#286):
  A RUN'S OWN PULL REQUEST INTO A NON-MAIN, UNPROTECTED BASE, and nothing
  wider -- the maintainer's ruling of 2026-10-03 ("Narrow to non-main
  bases"), under the maintainer's merge-authority ruling of 2026-09-30: a
  merge into the trunk is the maintainer's. REFUSED BY RULING (exit 2,
  before any other gate, the transcript and --json document still emitted
  with refused: true, baseOk: false) when the base -- 'refs/heads/'
  stripped -- is a PROTECTED NAME: GitHub's default branch; branch.base in
  this checkout's nen/workflow.json ('main' when absent), in
  nen/workflow.json AT THE PULL REQUEST'S BASE COMMIT (so a head that edits
  branch.base cannot dodge it) or AT THE DEFAULT BRANCH; a branch GitHub
  reports protected, or one a ruleset targets; or the head of an open pull
  request into a protected name with auto-merge enabled. The refusal hands
  the maintainer 'nen pr ready <n> --require-head <head>' BEFORE 'gh pr
  merge' -- 'pr ready' was not evaluated. No flag widens it.
  Otherwise evaluates, IN ORDER, every one of: 'base' (fails, exit 1, when
  any read above fails or the pull request answers no base name or a
  baseRefOid that is not a SHA -- "unknown" is never a pass), 'pr ready'
  (IN-PROCESS, --require-head passed through), 'head pin', 'pr body-check',
  'criteria' and 'closing links' (the conjuncts 'pr converge --composite'
  reports, from the SAME one fetch, so at the pinned head: a criterion with
  no verify row, a row reading missing or contradicts -- quoted -- or a
  closing issue that could not be read refuses; --catalogue <path> gives the
  issue-sections catalogue, else AC rows anywhere in the issue body and the
  default coverage rules)
  and 'whose pr' (author is the viewer, never cross-repository, AND the
  head ref is in the run form of branch.template at the base commit:
  '{model}/{persona}/{descriptor}' is three non-empty segments). Plan,
  --run, the merged/queued re-read and NEVER --admin/--auto are
  --release-unit's. Under --run the base is re-read just before 'gh pr
  merge' (which pins the head, not the base) and a 'base (re-read)' gate
  is appended: a retarget onto a protected name is refused by ruling (2),
  a failed read or any other retarget is exit 1, nothing merged. AFTER the
  merge the base is read once more, WHATEVER the state (merged or queued):
  a protected name, any base but the one gated, no name, or a re-read that
  fails ("authority unconfirmed") is EXIT 7, never 0.
  --requirements-from <path>  Required, as for --release-unit.
  --require-head <sha>        Pin the commit (7-40 hex digits); 'pr ready'
                              gives no verdict on any other head.
  Every flag 'pr merge' does not read -- 'pr ready''s own (--gates,
  --reviewers, --approvers, --round-policy, --token-env, --exclude-run,
  --exclude-check, --gh-repo, --explain) and other subcommands' (--base,
  --target, ...) -- is refused (exit 2) before any gh call.
  nen/workflow.json must be committed at the base commit AND on the default
  branch for --delivery to work: an absent file reads as unknown (exit 1).
  A ruleset matching every branch (e.g. ~ALL) refuses every base until it
  excludes the integration branches. The auto-merge chain check covers ONE
  hop: each auto-merge target is judged like a base, its own chain is not;
  a chain list that fills gh's --limit 1000, or an entry naming no base, is
  unknown (exit 1). A remote 'branch' block is held to nen/workflow.json's
  own loader rules (a branch.template must carry {descriptor}).
  Exit codes: 0 merged, or a passing plan without --run; 1 a gate did not
  pass (an unknown base included); 2 usage, OR refused by ruling -- told
  apart by 'refused by ruling' on stdout and refused: true in --json, where
  a usage error writes only stderr; 5 gh refused the merge; 6 gh could not
  be run; 7 MERGED WITHOUT AUTHORITY -- tell the maintainer.
  --json: '{ contract: "nen.pr.merge-delivery/v0.1", target, pr, base,
  baseOk, refused, defaultBranch, configuredBase, baseCommitBase,
  defaultBranchBase, baseProtected, baseRulesets (distinct ruleset_id),
  ready, pinOk, bodyOk, criteriaOk, linksOk, wholeOk, ok, ran, spawnFailed, judgedHead,
  requiredHead, state, rereadBase, mergedBase, outsideAuthority, mergeArgv,
  gates: [{ name, ok, lines }] }'.`;

/**
 * `--<flag> <ISO-8601>`, refused by name AND VALUE when it does not parse
 * (review finding). Left unrefused, an unparseable instant survived as
 * `Date.parse` NaN, through `Math.max(0, NaN)`, into "NaN/60 idle minute(s)"
 * on the human line and `"idleMinutes": null` in --json, at exit 0 -- a
 * machine consumer of --json cannot distinguish "computed zero-ish idle time"
 * from "could not parse the timestamp at all", and neither can a human
 * reading a bare `null`.
 */
function requireIsoInstant(context: CommandContext, flag: string, why: string): string {
  const value = requireValue(context.args, flag, why);
  if (Number.isNaN(Date.parse(value))) {
    throw new VerbUsageError(`--${flag} '${value}' is not a parseable ISO-8601 instant. ${why}`);
  }
  return value;
}

// EVERY WAKE ELEMENT IS VALIDATED, NOT TRUTHINESS-TESTED (review finding).
// `wake.noCommit` read straight off unvalidated JSON would let the STRING
// "false" -- truthy in JavaScript -- count toward the threshold that
// authorizes the one merge a non-human actor may make. Each element must be
// an object with a string `at` and a BOOLEAN `noCommit`, or this refuses by
// index rather than silently coercing.
function validateWakes(raw: unknown, path: string): VerifiedWake[] {
  if (!Array.isArray(raw)) {
    throw new VerbUsageError(`'${path}' must be a JSON array of { at, noCommit }.`);
  }
  return raw.map((item, index): VerifiedWake => {
    if (typeof item !== "object" || item === null) {
      throw new VerbUsageError(`'${path}': element ${index} is not an object.`);
    }
    const at = (item as Record<string, unknown>)["at"];
    const noCommit = (item as Record<string, unknown>)["noCommit"];
    if (typeof at !== "string") {
      throw new VerbUsageError(`'${path}': element ${index} has no string 'at'.`);
    }
    if (typeof noCommit !== "boolean") {
      throw new VerbUsageError(
        `'${path}': element ${index} has 'noCommit' of type ${typeof noCommit}, not a boolean -- a truthy non-boolean (e.g. the string "false") must never count toward the merge-permitting threshold.`,
      );
    }
    return { at, noCommit };
  });
}

function staleness(context: CommandContext): number {
  const wakesPath = requireValue(context.args, "wakes-from", "The verified-wake history to reason over.");
  const lastActivity = requireIsoInstant(context, "last-activity", "The pull request's last-activity instant.");
  const now = requireIsoInstant(context, "now", "Read once, never the live clock -- so a replay is reproducible.");
  const ready = context.args.booleans.has("ready");
  const minVerifiedWakes = context.args.values["min-verified-wakes"];
  const idleMinutes = context.args.values["idle-minutes"];
  if (minVerifiedWakes !== undefined && !/^\d+$/.test(minVerifiedWakes)) {
    throw new VerbUsageError(`--min-verified-wakes takes a whole number, got '${minVerifiedWakes}'.`);
  }
  if (idleMinutes !== undefined && !/^\d+$/.test(idleMinutes)) {
    throw new VerbUsageError(`--idle-minutes takes a whole number, got '${idleMinutes}'.`);
  }

  const cwd = resolveRepoRoot({ repoFlag: context.repoFlag });
  const wakes = validateWakes(readJsonFile<unknown>(wakesPath, cwd), wakesPath);

  const result = computeStaleness({
    wakes,
    lastActivityAt: lastActivity,
    now,
    ready,
    ...(minVerifiedWakes === undefined ? {} : { minVerifiedWakes: Number.parseInt(minVerifiedWakes, 10) }),
    ...(idleMinutes === undefined ? {} : { idleMinutes: Number.parseInt(idleMinutes, 10) }),
  });

  const lines = [
    result.stale ? "stale" : "not stale",
    result.mergePermitted ? "merge PERMITTED (stale + Ready)" : "merge not permitted",
    ...result.reasons,
  ];
  emit(context.io, context.json, result, lines);
  return 0;
}

// zheref/nen#239: where the requirement set came from, so a reader of the
// verdict can tell a shipped file from a set nen derived, without the
// transcript. `path` is the caller's own `--requirements-from` value when
// shipped, and the template's repo-relative path when derived; `ref` is the
// `--base` the template was read at, or null (the working tree, or shipped),
// and `commit` the full oid that ref resolved to.
export interface RequirementSource {
  readonly kind: "shipped" | "derived";
  readonly path: string;
  readonly ref: string | null;
  /** The full commit oid `ref` resolved to; null for the working tree and for shipped. */
  readonly commit: string | null;
}

const BODY_CHECK_BOOTSTRAP =
  "Pass --requirements-from <path> (a JSON array of { name, pattern }), or add a pull-request template; see docs/USAGE.md, \"Bootstrapping a body-check requirements file\".";

// NO FILE GIVEN: derive from the repository's own pull-request template, or
// refuse at exit 2 naming what is missing. Every refusal here is a USAGE error
// -- the invocation lacks an input it needs -- and never a skip.
function derivedRequirements(reader: TemplateReader, root: string): { requirements: readonly DerivedRequirement[]; source: RequirementSource } {
  const where = describeReader(reader);
  const discovery = discoverTemplate(reader);
  if (discovery.kind === "none") {
    throw new VerbUsageError(
      `no --requirements-from was given and no pull-request template was found under '${root}' ${where} (searched ${discovery.searched.join(", ")}). ${BODY_CHECK_BOOTSTRAP}`,
    );
  }
  if (discovery.kind === "ambiguous") {
    throw new VerbUsageError(
      `no --requirements-from was given and the pull-request template ${where} is ambiguous: ${discovery.candidates.join(", ")}. Nen will not pick one. ${BODY_CHECK_BOOTSTRAP}`,
    );
  }
  const requirements = deriveRequirements(reader.read(discovery.path));
  if (requirements.length === 0) {
    throw new VerbUsageError(
      `no --requirements-from was given and the pull-request template '${discovery.path}' ${where} has no headings to derive requirements from. ${BODY_CHECK_BOOTSTRAP}`,
    );
  }
  return { requirements, source: { kind: "derived", path: discovery.path, ref: reader.ref, commit: reader.commit } };
}

/**
 * `pr body-check --criteria <ids> | --criteria-from <issue body>` (zheref/nen#479
 * AC-1..AC-3; Akatsuki CON-17(c), Hatsu HR-11 -- one rule, one verb): the closing
 * issue's acceptance criteria, passed by flag or read from a local copy of its
 * body, held to the body's verify rows by the same comparison `pr converge` and
 * `pr merge --delivery` run. Null when neither flag is given. Usage errors are
 * thrown before the body is read.
 */
function criteriaForBody(context: CommandContext, cwd: string): { issue: ClosingIssue; policy: CoveragePolicy } | null {
  const ids = context.args.values["criteria"];
  const from = context.args.values["criteria-from"];
  const issueFlag = context.args.values["criteria-issue"];
  if (ids === undefined && from === undefined) {
    if (issueFlag !== undefined) throw new VerbUsageError("--criteria-issue names the issue a --criteria or --criteria-from list belongs to; give one of them.");
    if (context.args.values["catalogue"] !== undefined) throw new VerbUsageError("--catalogue is read with --criteria or --criteria-from (the acceptance-row prefix, sections and coverage rules).");
    return null;
  }
  if (ids !== undefined && from !== undefined) throw new VerbUsageError("--criteria and --criteria-from both name the criteria; give one.");
  const { catalogue, policy } = readCriteriaCatalogue(context, "catalogue", cwd);
  let slug = "(local)";
  let number = 0;
  if (issueFlag !== undefined) {
    const match = /^(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+))?#([1-9][0-9]{0,8})$/.exec(issueFlag.trim());
    if (match === null) throw new VerbUsageError(`--criteria-issue '${issueFlag}' is not '#<N>' or '<owner/name>#<N>'.`);
    slug = match[1] ?? slug;
    number = Number(match[2]);
  }
  let report: CriteriaReport;
  let label: string;
  if (ids !== undefined) {
    const prefix = catalogue?.criteriaPrefix ?? DEFAULT_CRITERIA_PREFIX;
    const listed = commaList(ids);
    if (listed.length === 0) throw new VerbUsageError("--criteria names no criterion; give a comma-separated list such as AC-1,AC-2.");
    const pattern = new RegExp(`^${prefix}-([1-9][0-9]{0,8})$`);
    const criteria = listed.map((id, index) => {
      const match = pattern.exec(id);
      if (match === null) throw new VerbUsageError(`--criteria '${id}' is not a ${prefix}-<n> id.`);
      return { id, number: Number(match[1]), text: "", line: index + 1 };
    });
    const seen = new Map<string, number[]>();
    for (const entry of criteria) seen.set(entry.id, [...(seen.get(entry.id) ?? []), entry.line]);
    report = { verifiable: true, criteria, duplicates: [...seen.entries()].filter(([, at]) => at.length > 1).map(([id, at]) => ({ id, lines: at })), unrecognised: [] };
    label = number === 0 ? "--criteria" : `${slug}#${number}`;
  } else {
    const path = requireValue(context.args, "criteria-from", "A local copy of the closing issue's body, whose acceptance rows are read.");
    report = extractCriteria(readTextFile(path, cwd).replace(/\r\n?/g, "\n"), catalogue);
    label = number === 0 ? `--criteria-from ${path}` : `${slug}#${number}`;
  }
  return { issue: { target: slug, number, report, label }, policy };
}

/** The criteria half of a body-check: its lines, its `--json` field, and whether it blocks. */
function criteriaLines(report: ConvergeReport): string[] {
  return [
    `${report.criteria.length} criterion row(s), ${report.blocking.length} blocking (one verify row per acceptance criterion; CON-17(c), HR-11)`,
    ...report.criteria.map((entry): string => `${entry.coverage.toUpperCase()}  ${entry.id ?? "(no criterion)"}${entry.word === null ? "" : ` ${entry.word}`}${entry.rows.length === 0 ? "" : ` (line ${entry.rows.join(", ")})`}`),
    ...report.blocking.map((line): string => `BLOCKING ${line}`),
  ];
}

function bodyCheck(context: CommandContext): number {
  const integer = (flag: string): number | undefined => {
    const value = context.args.values[flag];
    if (value === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new VerbUsageError(`--${flag} requires a positive safe integer`);
    return Number(value);
  };
  const exact = context.args.booleans.has("exact");
  const max = integer("max");
  const proseBudget = integer("prose-budget");
  if (max !== undefined && !exact) throw new VerbUsageError("--max requires --exact");
  const options: BodyCheckOptions = { exact, ...(max === undefined ? {} : { max }), ...(proseBudget === undefined ? {} : { proseBudget }) };
  const extraLines = (report: ReturnType<typeof checkBody>): string[] => [
    ...(report.findings ?? []).map((row): string => `FINDING line ${row.line}: ${row.message}`),
    ...(report.warnings ?? []).map((row): string => `WARN ${row.section}: ${row.words} prose words (budget ${row.budget})`),
  ];
  const bodyPath = requireValue(context.args, "body-from", "The pull-request body to check.");
  // Given at all -> read exactly as before (an explicitly EMPTY value is still
  // requireValue's refusal, never a quiet fall-through to derivation).
  const requirementsPath =
    context.args.values["requirements-from"] === undefined
      ? undefined
      : requireValue(context.args, "requirements-from", "This repository's own template requirements.");
  const base = context.args.values["base"];
  if (base !== undefined && requirementsPath !== undefined) {
    throw new VerbUsageError(
      "--base names the ref the pull-request template is read at, and is only read when the set is derived; with --requirements-from there is no template to read.",
    );
  }

  const cwd = resolveRepoRoot({ repoFlag: context.repoFlag });
  const criteriaInput = criteriaForBody(context, cwd);
  const body = readTextFile(bodyPath, cwd);
  const criteria = criteriaInput === null ? null : converge([criteriaInput.issue], body.replace(/\r\n?/g, "\n"), criteriaInput.policy);
  const criteriaOk = criteria === null || criteria.blocking.length === 0;
  const criteriaField = criteria === null ? {} : { criteria };
  const criteriaText = criteria === null ? [] : criteriaLines(criteria);

  // A SHIPPED FILE: exactly the check it always was, plus the source field.
  if (requirementsPath !== undefined) {
    const checked = checkBody(body, readJsonFile<readonly BodyRequirement[]>(requirementsPath, cwd), options);
    const report = { ...checked, ok: checked.ok && criteriaOk };
    const source: RequirementSource = { kind: "shipped", path: requirementsPath, ref: null, commit: null };
    const satisfiedCount = report.results.filter((result): boolean => result.satisfied).length;
    // A VERDICT LINE ALWAYS PRINTS (review finding): zero output must never be a
    // passing result a caller's script can mistake for "nothing to report".
    const lines = [
      `${satisfiedCount}/${report.results.length} requirement(s) satisfied`,
      ...report.results.map((result): string => `${result.satisfied ? "ok" : "MISSING"}  ${result.name}`),
      ...extraLines(checked),
      ...criteriaText,
    ].map(plainLine);
    emit(context.io, context.json, { ...report, ...criteriaField, source }, lines);
    return report.ok ? 0 : 1;
  }

  // A DERIVED set says so ON the verdict line (zheref/nen#239), naming the
  // template and where it was read, so quoting the verdict quotes its
  // provenance. A heading present with nothing under it is EMPTY, not ok.
  //
  // EVERY HUMAN LINE THROUGH plainLine (Feitan F4's rule, Copilot on #385):
  // the template's path and headings are repository-controlled and the ref is
  // the caller's, so a newline in a filename or an ESC in a heading could
  // otherwise forge or erase a verdict line. The refusals below name the same
  // values, so they pass through it too. `--json` keeps the original bytes.
  let reader: TemplateReader;
  let derived: ReturnType<typeof derivedRequirements>;
  try {
    reader = base === undefined ? workingTreeReader(cwd) : gitReader(context.seams, cwd, base);
    derived = derivedRequirements(reader, cwd);
  } catch (error) {
    if (error instanceof VerbUsageError) throw new VerbUsageError(plainLine(error.message));
    throw error;
  }
  const { requirements, source } = derived;
  const derivedReport = checkDerivedBody(body, requirements, { strictFences: exact });
  const extra = exact || proseBudget !== undefined ? checkBody(body, requirements, options) : undefined;
  const report = { ...derivedReport, ...(extra?.findings === undefined ? {} : { findings: extra.findings }), ...(extra?.warnings === undefined ? {} : { warnings: extra.warnings }), ok: derivedReport.ok && (extra?.ok ?? true) && criteriaOk };
  const satisfiedCount = report.results.filter((result): boolean => result.satisfied).length;
  const label = { ok: "ok", missing: "MISSING", empty: "EMPTY" } as const;
  const lines = [
    `${satisfiedCount}/${report.results.length} requirement(s) satisfied (DERIVED from the pull-request template '${source.path}' ${describeReader(reader)}; no --requirements-from given)`,
    ...report.results.map((result): string => `${label[result.status]}  ${result.name}`),
    ...(extra === undefined ? [] : extraLines(extra)),
    ...criteriaText,
  ].map(plainLine);
  emit(context.io, context.json, { ...report, ...criteriaField, source }, lines);
  return report.ok ? 0 : 1;
}

// `ready`'s FLAGS AND POSITIONALS PASS THROUGH TO prReady() UNCHANGED --
// ../verbs/pr_ready.ts owns its own parsing of --gh-repo/--reviewers/etc and
// its own ref grammar; this adapts only the CALLING CONVENTION.
//
// `context.json` (already the OR of the head-stage and family-stage --json,
// per ../index.ts's runFamily) is folded into the boolean set passed down,
// because prReady() itself reads `input.booleans.has("json")` -- it predates
// the registry and was never written to take a pre-resolved `json: boolean`
// the way this file's `staleness`/`bodyCheck` are. Without this fold, `nen
// --json pr ready <ref>` (the flag typed BEFORE the family name) would
// silently print the human report instead of the machine one.
function ready(context: CommandContext): Promise<number> {
  const booleans = new Set(context.args.booleans);
  if (context.json) booleans.add("json");
  return prReady(
    {
      positionals: context.args.positionals,
      values: context.args.values,
      booleans,
      lists: context.args.lists,
      repoFlag: context.repoFlag,
    },
    context.io,
  );
}

// ── which flags each subcommand reads (zheref/nen#351) ──────────────────────

/**
 * WHAT EACH `pr` SUBCOMMAND ACTUALLY READS -- the ONE declaration the family's
 * parser spec and its foreign-flag refusal are both derived from, in the shape
 * ../issue/command.ts's ISSUE_SUBCOMMAND_FLAGS set for the issue family.
 *
 * WHY. A family shares one parser spec, so every flag any `pr` subcommand
 * declares parsed cleanly for ALL thirteen of them. `pr ready`'s whole set was
 * spread onto the family (`...PR_READY_FLAGS.values`), and only some foreign
 * flags were refused, one hand-written guard at a time -- so `pr edit-body`,
 * `pr request-reviews`, `pr threads` and `pr open` accepted `--token-env` and
 * `--gh-repo` and ignored them (zheref/nen#351; Feitan F1 and Nobunaga N1 on
 * #345, which closed it for `pr mark-ready` alone). The sharpest case is
 * `--token-env`: a caller naming a narrower credential still wrote with gh's
 * own, and nothing said so.
 *
 * So ownership is no longer written as a list of refusals. Each subcommand
 * declares the flags it reads, once, here; the parser gets their UNION (so a
 * flag cannot exist without an owner), and a flag parsed but absent from the
 * executing subcommand's own row is refused BY CONSTRUCTION, at exit 2 and
 * before any gh call, naming the subcommands that do read it. Adding a flag to
 * one row adds it to the parser and to every sibling's refusal in one edit.
 *
 * THE GLOBAL FLAGS ARE NOT LISTED and are never foreign: `--repo`, `--json`
 * and `--help` are ../cli/command.ts's, merged into every family by
 * mergeFlags. `threads` lists every flag ANY of its actions reads; the
 * per-action refusal (THREADS_ACTION_FLAGS below) narrows it further.
 */
export const PR_SUBCOMMAND_FLAGS: Readonly<Record<string, FlagSpec>> = {
  // `pr ready`'s flags pass through to ../verbs/pr_ready.ts's prReady(), which
  // reads PR_READY_FLAGS and the --target/--pr aliases (zheref/nen#383).
  ready: {
    values: ["target", "pr", ...PR_READY_FLAGS.values],
    booleans: [...PR_READY_FLAGS.booleans],
    lists: [...PR_READY_FLAGS.lists],
  },
  staleness: { values: ["wakes-from", "last-activity", "now", "min-verified-wakes", "idle-minutes"], booleans: ["ready"] },
  "body-check": { values: ["body-from", "requirements-from", "base", "max", "prose-budget", "criteria", "criteria-from", "criteria-issue", "catalogue"], booleans: ["exact"] },
  sections: { values: ["catalogue", "kind", "family", "with", "overrides", "taxonomy", "jobs"] },
  fetch: { values: ["target", "pr"] },
  converge: { values: ["target", "pr", "catalogue", "requirements-from", "require-head", "body-requirements"], booleans: ["composite"] },
  "next-blocker": { values: ["target", "pr", "reviewers", "gates", "policy", "requirements-from"], booleans: ["delivery-pr"] },
  "cascade-main": { values: ["trunk"], booleans: ["no-push", "dry-run"] },
  retarget: { values: ["target", "pr", "base"], booleans: ["dry-run"] },
  "request-reviews": { values: ["target", "pr", "add-reviewers", "add-bots"], booleans: ["dry-run"] },
  // The private-name guard's three flags ride every row whose subcommand
  // writes caller text (zheref/nen#363): edit-body, threads (reply, settle)
  // and open.
  "edit-body": { values: ["target", "pr", "body-file", ...PRIVATE_NAME_FLAGS.values], booleans: ["dry-run", ...PRIVATE_NAME_FLAGS.booleans] },
  "mark-ready": { values: ["target", "pr", "require-head"], booleans: ["dry-run"] },
  threads: { values: ["target", "pr", "thread", "body-file", "from", ...PRIVATE_NAME_FLAGS.values], booleans: ["dry-run", ...PRIVATE_NAME_FLAGS.booleans] },
  open: {
    values: ["target", "base", "title-file", "body-file", "head", "assignee", ...PRIVATE_NAME_FLAGS.values],
    booleans: ["draft", "dry-run", ...PRIVATE_NAME_FLAGS.booleans],
  },
  // --require-head is read by --delivery only; doMerge refuses it with
  // --release-unit, naming the form that reads it.
  merge: { values: ["requirements-from", "require-head", "catalogue"], booleans: ["release-unit", "delivery", "run"] },
  // zheref/nen#510; the post/read split of these flags is ./ledger-verb.ts's LEDGER_ACTION_FLAGS.
  ledger: {
    values: ["target", "pr", "effort", ...LEDGER_ACTION_FLAGS.post.values],
    booleans: [...LEDGER_ACTION_FLAGS.post.booleans, ...LEDGER_ACTION_FLAGS.read.booleans],
    lists: [...LEDGER_ACTION_FLAGS.post.lists],
  },
};

/** The subcommand names, read off the table so the two can never differ. */
export const PR_SUBCOMMANDS: readonly string[] = Object.keys(PR_SUBCOMMAND_FLAGS);

/**
 * Which flags each `threads` action reads beyond --target/--pr (zheref/nen#215,
 * Copilot on #221). Module-level so the family refusal can name the one action
 * that reads a flag (`--from` is 'pr threads settle''s) rather than the verb.
 */
export const THREADS_ACTION_FLAGS: Readonly<Record<string, { values: readonly string[]; booleans: readonly string[] }>> = {
  list: { values: [], booleans: [] },
  reply: { values: ["thread", "body-file", ...PRIVATE_NAME_FLAGS.values], booleans: ["dry-run", ...PRIVATE_NAME_FLAGS.booleans] },
  resolve: { values: ["thread"], booleans: ["dry-run"] },
  settle: { values: ["from", ...PRIVATE_NAME_FLAGS.values], booleans: ["dry-run", ...PRIVATE_NAME_FLAGS.booleans] },
};

const THREAD_ACTIONS: readonly string[] = Object.keys(THREADS_ACTION_FLAGS);

/** Whether one row declares this flag, in any of its three halves. */
function declaresFlag(spec: FlagSpec, flag: string): boolean {
  return (spec.values ?? []).includes(flag) || (spec.booleans ?? []).includes(flag) || (spec.lists ?? []).includes(flag);
}

/** The family's parser spec: the UNION of every row, sorted for a stable 'unknown option' listing. */
function unionPrFlags(specs: readonly FlagSpec[]): FlagSpec {
  const values = new Set<string>();
  const booleans = new Set<string>();
  const lists = new Set<string>();
  for (const spec of specs) {
    for (const flag of spec.values ?? []) values.add(flag);
    for (const flag of spec.booleans ?? []) booleans.add(flag);
    for (const flag of spec.lists ?? []) lists.add(flag);
  }
  return { values: [...values].sort(), booleans: [...booleans].sort(), lists: [...lists].sort() };
}

export const PR_FLAGS: FlagSpec = unionPrFlags(Object.values(PR_SUBCOMMAND_FLAGS));

const PR_GLOBAL_FLAG_NAMES: ReadonlySet<string> = new Set([
  ...(GLOBAL_FLAGS.values ?? []),
  ...(GLOBAL_FLAGS.booleans ?? []),
  ...(GLOBAL_FLAGS.lists ?? []),
]);

/**
 * A flag one FORM of a subcommand reads and the other refuses: `--require-head`
 * is 'pr merge --delivery''s, and doMerge refuses it with --release-unit, so
 * naming bare 'pr merge' would send a caller to a refusal (hanten round 1).
 */
const PR_FLAG_FORM: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  merge: { "require-head": "merge --delivery" },
};

/**
 * Who reads this flag, in the table's order, each as `'pr <subcommand>'` --
 * or `'pr threads <action>'` where exactly one threads action reads it, which
 * is the more useful answer for `--from` (settle) and `--body-file` (reply).
 * `withinThreads` (the refused invocation is itself a threads action) names
 * EVERY threads action that reads it, since 'pr threads' alone would name the
 * verb the caller is already running.
 */
export function prFlagOwners(flag: string, withinThreads = false): readonly string[] {
  return PR_SUBCOMMANDS.filter((name): boolean => declaresFlag(PR_SUBCOMMAND_FLAGS[name] ?? {}, flag)).flatMap((name): string[] => {
    if (name === "threads") {
      const actions = THREAD_ACTIONS.filter((action): boolean => {
        const row = THREADS_ACTION_FLAGS[action];
        return row !== undefined && (row.values.includes(flag) || row.booleans.includes(flag));
      });
      if (actions.length === 1 || (withinThreads && actions.length > 0)) return actions.map((action): string => `'pr threads ${action}'`);
    }
    return [`'pr ${PR_FLAG_FORM[name]?.[flag] ?? name}'`];
  });
}

const GH_RESOLVES = "runs on whatever credential gh resolves (GH_TOKEN/GITHUB_TOKEN if exported, else its stored login), never on the variable --token-env names.";

/**
 * What `--token-env` would have meant here, said truthfully per subcommand --
 * a refusal that asserts something false about the verb is one a caller stops
 * believing (../issue/command.ts's refuseForeignFlags, the same rule). Keyed
 * by EVERY subcommand but `ready` (the one that reads the flag) with no default
 * branch, so a new subcommand gets no credential claim until one is written
 * for it (command.test.ts asserts the coverage; hanten round 1).
 */
const TOKEN_ENV_ADVICE: Readonly<Record<string, string>> = {
  staleness: "staleness reads local files only and calls no GitHub API, so there is no credential to name.",
  sections: "sections reads local JSON files only and calls no GitHub API.",
  "body-check": "body-check reads local files and git only and calls no GitHub API, so there is no credential to name.",
  fetch: `fetch ${GH_RESOLVES}`,
  converge: `converge ${GH_RESOLVES}`,
  "next-blocker": `next-blocker ${GH_RESOLVES}`,
  "cascade-main": "cascade-main fetches and pushes on git's own credential and calls no GitHub API.",
  retarget: `retarget ${GH_RESOLVES}`,
  "request-reviews": `request-reviews ${GH_RESOLVES}`,
  "edit-body": `edit-body ${GH_RESOLVES}`,
  "mark-ready": `mark-ready ${GH_RESOLVES}`,
  threads: `threads ${GH_RESOLVES}`,
  open: `open ${GH_RESOLVES}`,
  ledger: `ledger ${GH_RESOLVES}`,
  merge: "merge judges readiness on GH_TOKEN and merges on whatever credential gh resolves (GH_TOKEN/GITHUB_TOKEN if exported, else its stored login); the variable --token-env names would have changed neither.",
};

/** Exported for the coverage test: every key of PR_SUBCOMMAND_FLAGS but `ready` has advice. */
export const PR_TOKEN_ENV_ADVICE_KEYS: readonly string[] = Object.keys(TOKEN_ENV_ADVICE);

/** What to type instead, where the owners alone are not the useful answer. */
function foreignFlagAdvice(subcommand: string, flag: string): string | undefined {
  if (flag === "token-env") return TOKEN_ENV_ADVICE[subcommand];
  if (flag === "gh-repo" && declaresFlag(PR_SUBCOMMAND_FLAGS[subcommand] ?? {}, "target")) {
    return `'pr ${subcommand}' names its repository with --target <owner/name>.`;
  }
  return undefined;
}

/**
 * Refuse every flag of this invocation the executing subcommand does not read
 * -- ALL of them named at once, sorted -- at exit 2, before any subcommand
 * runs and so before any gh call (zheref/nen#351). Each sentence says the
 * subcommand does not read the flag, then which subcommands DO.
 *
 * A `threads` action is judged against its OWN row (--target, --pr and
 * THREADS_ACTION_FLAGS[action]), here rather than inside threads(), so one
 * message names every foreign flag at both levels (hanten round 1). An action
 * that is missing or unknown is judged against the verb's row; threads() then
 * refuses the action itself.
 *
 * TOKENS AFTER A BARE `--` ARE REFUSED TOO (Feitan, SEC-7, hanten round 1).
 * ../cli/args.ts stops reading at `--` and hands the rest over as
 * `passthrough`, which no `pr` subcommand forwards anywhere -- so
 * `-- --token-env NARROW` was accepted and ignored on every subcommand, write
 * paths included. Only a flag-shaped token's NAME is ever echoed, never a value.
 */
function refuseFlagsSubcommandDoesNotRead(context: CommandContext, subcommand: string): void {
  const action = context.args.positionals[2];
  const actionRow = subcommand === "threads" && action !== undefined ? THREADS_ACTION_FLAGS[action] : undefined;
  const spec: FlagSpec | undefined =
    actionRow === undefined ? PR_SUBCOMMAND_FLAGS[subcommand] : { values: ["target", "pr", ...actionRow.values], booleans: [...actionRow.booleans] };
  const subject = actionRow === undefined ? subcommand : `threads ${action ?? ""}`;
  // Unreachable: requireSubcommand has already refused anything not keyed
  // here. Stated so a caller that skips that step fails closed, never reading
  // `undefined` as "reads everything".
  if (spec === undefined) throw new VerbUsageError(`'pr ${subcommand}' declares no flags of its own.`);
  const given = [
    ...Object.keys(context.args.values).filter((flag): boolean => context.args.values[flag] !== undefined),
    ...Object.keys(context.args.lists).filter((flag): boolean => (context.args.lists[flag] ?? []).length > 0),
    ...context.args.booleans,
  ];
  const foreign = [...new Set(given)].filter((flag): boolean => !PR_GLOBAL_FLAG_NAMES.has(flag) && !declaresFlag(spec, flag)).sort();
  const passthrough = context.args.passthrough;
  if (foreign.length === 0 && passthrough.length === 0) return;
  const sentences = foreign.map((flag): string => {
    const owners = prFlagOwners(flag, actionRow !== undefined);
    // Never empty while PR_FLAGS is the union of these rows: a flag no row
    // declares is an 'unknown option' at the parser and never reaches here.
    const read = owners.length === 0 ? `No 'pr' subcommand reads --${flag}.` : `--${flag} is only read by ${conjoin(owners)}`;
    const advice = foreignFlagAdvice(subcommand, flag);
    return `--${flag} is not read by 'pr ${subject}'. ${read}${owners.length === 0 ? "" : advice === undefined ? "." : `; ${advice}`}`;
  });
  if (passthrough.length > 0) {
    const named = [
      ...new Set(
        passthrough
          .filter((token): boolean => token.startsWith("--"))
          .map((token): string => token.slice(2).split("=")[0] ?? "")
          .filter((name): boolean => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)),
      ),
    ].map((name): string => `--${name}`);
    sentences.push(
      `'pr ${subject}' reads nothing after a bare '--': no 'pr' subcommand forwards arguments, so ${passthrough.length} token(s) there would have been accepted and ignored${named.length === 0 ? "" : `, among them ${conjoin(named)}`}. Drop the '--'.`,
    );
  }
  throw new VerbUsageError(sentences.join(" "));
}

export const prCommand: Command = {
  exits: [
    { verb: "pr open", code: 4, meaning: "a private repository named in text bound for a PUBLIC target; nothing written (the private-name guard)" },
    { verb: "pr edit-body", code: 4, meaning: "a private repository named in text bound for a PUBLIC target; nothing written (the private-name guard)" },
    { verb: "pr threads", code: 3, meaning: "the thread is already resolved (settle: every other entry settled)" },
    { verb: "pr threads", code: 4, meaning: "no thread with that id, the pull request is not visible, or (reply/settle) the private-name guard" },
    { verb: "pr threads", code: 5, meaning: "the credential could not authenticate" },
    { verb: "pr merge", code: 5, meaning: "gh pr merge refused" },
    { verb: "pr merge", code: 6, meaning: "gh could not be started" },
    { verb: "pr merge", code: 7, meaning: "--delivery: merged without authority; GitHub reports a base other than the one gated" },
    { verb: "pr ready", code: 8, meaning: "--require-head did not match GitHub's head; no verdict" },
    { verb: "pr converge", code: 3, meaning: "--composite: a read did not finish, or was at another head than --require-head; no verdict" },
    { verb: "pr mark-ready", code: 3, meaning: "the pull request is CLOSED or MERGED; nothing sent" },
    { verb: "pr mark-ready", code: 8, meaning: "--require-head did not match GitHub's head" },
    { verb: "pr request-reviews", code: 9, meaning: "a bot request GitHub accepted but did not list as pending" },
    { verb: "pr ledger", code: 4, meaning: "post: a private repository named in the slice bound for a PUBLIC target; nothing written (the private-name guard)" },
  ],
  name: "pr",
  subcommands: PR_SUBCOMMANDS,
  summary:
    "CON-32 readiness, staleness, body-check, fetch, next-blocker, cascade-main, retarget, request-reviews, edit-body, mark-ready, threads, open, merge, ledger.",
  usage: USAGE,
  flags: PR_FLAGS,
  run(context: CommandContext): number | Promise<number> {
    const subcommand = requireSubcommand("pr", context.args, PR_SUBCOMMANDS);
    // ONE GUARD FOR THE WHOLE FAMILY (zheref/nen#351), derived from
    // PR_SUBCOMMAND_FLAGS above. It replaces the one-flag-at-a-time refusals
    // this function used to carry (--release-unit, --no-push, --dry-run,
    // --body-file, --thread, --add-bots, ...) and mark-ready's and merge's own
    // tables, each of which covered the flags somebody had thought of.
    refuseFlagsSubcommandDoesNotRead(context, subcommand);
    switch (subcommand) {
      case "ready":
        return ready(context);
      case "staleness":
        return staleness(context);
      case "body-check":
        return bodyCheck(context);
      case "sections":
        return sectionsCommand(context);
      case "fetch":
        return fetch(context);
      case "converge":
        return convergeVerb(context);
      case "next-blocker":
        return blocker(context);
      case "cascade-main":
        return cascade(context);
      case "retarget":
        return doRetarget(context);
      case "request-reviews":
        return doRequestReviews(context);
      case "threads":
        return threads(context);
      case "open":
        return open(context);
      case "merge":
        return doMerge(context);
      case "mark-ready":
        return doMarkReady(context);
      case "ledger":
        return ledgerVerb(context, requireTarget(context), requirePr(context));
      default:
        return editBody(context);
    }
  },
};

function printSnapshot(context: CommandContext, snapshot: PrSnapshot): void {
  context.io.out(`#${snapshot.pr.number} ${snapshot.title}`);
  context.io.out(`  ${snapshot.pr.headRef} -> ${snapshot.pr.baseRef}  ${snapshot.pr.headSha}`);
  context.io.out(`  mergeable: ${snapshot.pr.mergeable}  mergeStateStatus: ${snapshot.mergeStateStatus}`);
  context.io.out(`  checks: ${snapshot.checks.length}  reviews: ${snapshot.reviews.length}  review requests: ${snapshot.reviewRequests.length}`);
  const unresolved = snapshot.reviewThreads.filter((thread): boolean => !thread.isResolved).length;
  // No truncation caveat here: ../pr/fetch.ts's fetchPullRequest() now walks
  // reviewThreads to completion or throws, so `snapshot.reviewThreads` is
  // never a partial page by the time this prints (zheref/nen#14's fact-check).
  context.io.out(`  review threads: ${snapshot.reviewThreads.length} (${unresolved} unresolved)`);
}

function fetch(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const snapshot = fetchPullRequest(context.seams, target, prNumber);
  if (context.json) {
    context.io.out(JSON.stringify(snapshot, null, 2));
    return 0;
  }
  printSnapshot(context, snapshot);
  return 0;
}

/**
 * `nen pr converge`: the closing issues' criteria against the PR body's
 * verify rows (../issue/criteria.ts). A read that did not finish is exit 1,
 * reported on stderr: "could not read" is never "nothing to cover", and it is
 * not a usage error either (the shared exit scheme's 2).
 */
/**
 * The issue-sections catalogue the criteria are read with, and its coverage
 * rules, from `--<flag>` (read before any network work); absent: no catalogue
 * (`AC-{n}` rows anywhere in the body) and the default coverage rules.
 */
function readCriteriaCatalogue(context: CommandContext, flag: string, root: string | null = null): { catalogue: IssueSectionsCatalogue | null; policy: CoveragePolicy } {
  const catalogueFrom = context.args.values[flag];
  if (catalogueFrom === undefined) return { catalogue: null, policy: DEFAULT_COVERAGE_POLICY };
  if (catalogueFrom === "") throw new VerbUsageError(`--${flag} names the issue-sections catalogue; it cannot be empty.`);
  const base = root ?? resolveRepoRoot({ repoFlag: context.repoFlag });
  const raw = readJsonFile<unknown>(resolveAgainstRepo(base, catalogueFrom), process.cwd(), `--${flag} is the catalogue the criteria and coverage rules are read from.`);
  try {
    return {
      catalogue: parseCatalogue(raw),
      policy: readCoveragePolicy(raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["coverage"] : undefined),
    };
  } catch (error) {
    throw new VerbUsageError(plainLine(`'${catalogueFrom}': ${error instanceof Error ? error.message : String(error)}`));
  }
}

function convergeVerb(context: CommandContext): number | Promise<number> {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  // `--catalogue` names the issue-sections catalogue here as on body-check and
  // merge (Nobunaga 2 on zheref/nen#526); `--requirements-from` is kept as a
  // DEPRECATED alias on this verb only, said on stderr, and both is refused.
  const catalogueFlag = context.args.values["catalogue"] !== undefined;
  const aliasFlag = context.args.values["requirements-from"] !== undefined;
  if (catalogueFlag && aliasFlag) throw new VerbUsageError("--catalogue and --requirements-from both name the issue-sections catalogue on 'pr converge'; give --catalogue (--requirements-from is its deprecated alias here).");
  if (aliasFlag) context.io.err("nen pr converge: --requirements-from is a deprecated alias of --catalogue on this verb (on body-check, next-blocker and merge it names the body requirements); pass --catalogue.");
  const { catalogue, policy } = readCriteriaCatalogue(context, aliasFlag ? "requirements-from" : "catalogue");
  const requireHead = context.args.values["require-head"];
  if (requireHead !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(requireHead)) {
    throw new VerbUsageError(`--require-head '${requireHead}' is not a full commit SHA (40 or 64 hex characters).`);
  }
  if (context.args.booleans.has("composite")) return convergeCompositeVerb(context, target, prNumber, catalogue, policy, requireHead);
  if (context.args.values["body-requirements"] !== undefined) {
    throw new VerbUsageError("--body-requirements is read by 'pr converge --composite' (the body-check conjunct); pass --composite to say so.");
  }
  let input;
  try {
    input = readConvergeInput(context.seams, target, prNumber, catalogue);
    if (requireHead !== undefined) assertPinnedHead(context.seams, target, prNumber, input, requireHead);
  } catch (error) {
    if (!(error instanceof ConvergeReadError)) throw error;
    context.io.err(plainLine(`nen pr converge: ${error.message}`));
    return 1;
  }
  const report = converge(input.issues, input.body, policy);
  const closingIssues = input.issues.map((issue) => ({
    issue: `${issue.target}#${issue.number}`,
    criteria: issue.report.criteria.length,
    verifiable: issue.report.verifiable,
    unrecognised: issue.report.unrecognised,
  }));
  const counts = report.counts;
  const noKeyword = input.closingSource === "none-on-non-default-base";
  // A NON-DEFAULT BASE WITH NO CLOSING ROW IS REPORTED, NOT BLOCKED (the
  // integrator's ruling, 2026-10-23): `closingSource` says
  // `none-on-non-default-base` and the head line says it cannot tell what the
  // pull request closes, but a sub-PR into an integration branch that closes
  // nothing has no criterion to miss, so the other conjuncts decide (#483 AC-5).
  const blocking = report.blocking;
  const head =
    input.issues.length === 0
      ? noKeyword
        ? `${target.slug}#${prNumber} into '${input.base}' (not the default branch): GitHub lists no closing issue and the body names none -- cannot tell what it closes`
        : `${target.slug}#${prNumber} closes no issue: no criterion to compare (not verifiable)`
      : `${report.criteria.length} criterion row(s) across ${input.issues.length} closing issue(s)${input.closingSource === "body-keywords" ? " (from the body's closing keywords: the base is not the default branch)" : ""}, ${blocking.length} blocking -- ` +
        `${counts["covered-with-evidence"]} covered with evidence, ${counts["covered-without-evidence"]} without, ${counts["missing-row"]} missing-row, ` +
        `${counts["malformed-row"]} malformed-row, ${counts["duplicate-rows"]} duplicate-rows, ${counts["not-verifiable"]} not-verifiable`;
  const lines = [
    head,
    ...report.criteria.map(
      (entry): string =>
        `${entry.coverage.toUpperCase()}  ${entry.issue}/${entry.id ?? "(no AC row)"}` +
        `${entry.word === null ? "" : ` ${entry.word}`}${entry.rows.length === 0 ? "" : ` (line ${entry.rows.join(", ")})`}`,
    ),
    ...input.issues.flatMap((issue): string[] => issue.report.unrecognised.map((row): string => `UNRECOGNISED ${issue.target}#${issue.number} line ${row.line}: ${row.text}`)),
    ...report.unrequested.map((row): string => `UNREQUESTED line ${row.line}: ${row.word ?? "?"}${row.problem === null ? "" : ` -- ${row.problem}`}`),
    ...report.unmatched.map((row): string => `UNMATCHED line ${row.line} '${row.cell}': ${row.reason}`),
    ...report.malformed.map((row): string => `MALFORMED line ${row.line}: ${row.reason}`),
  ].map(plainLine);
  emit(
    context.io,
    context.json,
    { contract: PR_CONVERGE_CONTRACT, target: target.slug, pr: prNumber, url: input.url, headSha: input.headSha, base: input.base, closingSource: input.closingSource, closingIssues, ...report, blocking },
    lines,
  );
  return blocking.length > 0 ? 1 : 0;
}

/** `pr converge --composite` could not read (or read at another head): no verdict. */
export const EXIT_COMPOSITE_UNREAD = 3;

/**
 * `pr converge --composite` (zheref/nen#483 AC-1): readiness, the body check,
 * the closing-issue links and the criteria coverage, all at the pinned head.
 * ./convergecomposite.ts holds the reads; this adapter reads flags and renders.
 */
async function convergeCompositeVerb(
  context: CommandContext,
  target: Target,
  prNumber: number,
  catalogue: IssueSectionsCatalogue | null,
  policy: CoveragePolicy,
  requireHead: string | undefined,
): Promise<number> {
  if (requireHead === undefined) throw new VerbUsageError("--composite reports one verdict at one head: --require-head <sha> is required.");
  const requirementsPath = requireValue(context.args, "body-requirements", "The '{ name, pattern }' body requirements 'pr body-check' reads -- the body conjunct of the composite verdict.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const raw = readJsonFile<unknown>(requirementsPath, root, "--body-requirements names the body requirements of the composite verdict; an unreadable one is refused, never read as none.");
  try {
    validateRequirements(raw);
  } catch (error) {
    if (error instanceof BodyCheckError) throw new VerbUsageError(`'${requirementsPath}': ${error.message}`);
    throw error;
  }
  let verdict;
  try {
    verdict = await convergeComposite({ seams: context.seams, target, prNumber, requireHead, requirements: raw, catalogue, policy, repoFlag: context.repoFlag });
  } catch (error) {
    if (!(error instanceof ConvergeReadError)) throw error;
    // COULD NOT LOOK IS ITS OWN EXIT under --composite (Nobunaga 4 on
    // zheref/nen#526; #483 AS-3): 3, never 1, which is "looked: not ready".
    context.io.err(plainLine(`nen pr converge: ${error.message}`));
    return EXIT_COMPOSITE_UNREAD;
  }
  const input = verdict.input;
  const lines = [
    `${target.slug}#${prNumber} at ${requireHead}: ${verdict.ready ? "READY" : "NOT READY"} -- ${verdict.conjuncts.map((conjunct): string => `${conjunct.name} ${conjunct.ok ? "ok" : "BLOCKED"}`).join(" · ")}`,
    ...verdict.conjuncts.flatMap((conjunct): readonly string[] => conjunct.lines),
  ].map(plainLine);
  emit(
    context.io,
    context.json,
    {
      contract: PR_CONVERGE_CONTRACT,
      composite: true,
      target: target.slug,
      pr: prNumber,
      url: input.url,
      headSha: input.headSha,
      requiredHead: requireHead,
      base: input.base,
      closingSource: input.closingSource,
      ready: verdict.ready,
      conjuncts: verdict.conjuncts,
      blocking: verdict.blocking,
    },
    lines,
  );
  return verdict.ready ? 0 : 1;
}

function blocker(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const reviewersRaw = context.args.values["reviewers"];
  const reviewers = reviewersRaw === undefined ? undefined : commaList(reviewersRaw);
  if (reviewersRaw !== undefined && reviewers?.length === 0) {
    // "" or "," or " , " all comma-split to an empty array. Treating that as
    // an override (no reviewers, nothing owed) rather than a usage error
    // would silently retire the owed-reviewer-round conjunct the moment a
    // caller's script passes an unset variable through --reviewers "$VAR".
    // Checked before the fetch below, so a bad flag is refused without a
    // network round trip.
    throw new VerbUsageError(
      "--reviewers named no reviewers. Omit the flag to use the repository's declared set; an empty list would silently retire the owed-round check.",
    );
  }
  // Usage lists --repo unbracketed: omitting it is refused by name at exit 2,
  // never silently read as "take the reviewer identities from whatever
  // gates file the cwd happens to hold" (zheref/nen#28). AFTER the
  // --reviewers guard above, which is checked first precisely so a bad flag
  // is refused without any filesystem or network work.
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(
      context,
      "It is the checkout whose nen/gates.json is read first; the reviewer identities come from nen/gates.json at the pull request's base, and from this file only when the base cannot be read.",
    ),
  });
  // --requirements-from (zheref/nen#479 AC-4): the SAME `{ name, pattern }`
  // file `pr body-check` reads, so the two verbs give one verdict for one body
  // -- a process body headed '## What the guards prove' included. Read and
  // validated before any network work; a relative path resolves against --repo.
  const requirementsFlag = context.args.values["requirements-from"];
  let bodyRequirements: readonly BodyRequirement[] | undefined;
  if (requirementsFlag !== undefined) {
    const requirementsPath = requireValue(context.args, "requirements-from", "The body requirements 'pr body-check' reads.");
    const raw = readJsonFile<unknown>(requirementsPath, root, "--requirements-from names the body requirements next-blocker's last step checks; an unreadable one is refused, never read as none.");
    try {
      validateRequirements(raw);
    } catch (error) {
      if (error instanceof BodyCheckError) throw new VerbUsageError(`'${requirementsPath}': ${error.message}`);
      throw error;
    }
    bodyRequirements = raw;
  }
  // `--gates <path>` goes through ../verbs/pr_ready.ts's resolveIdentities --
  // THE SAME resolver `pr ready` uses, never a re-spelled copy -- because
  // zheref/nen#20's defect was exactly the two siblings drifting apart:
  // `gates` already sat in this family's declared value flags (spread in from
  // PR_READY_FLAGS for `ready`'s sake), so `next-blocker --gates <path>`
  // PARSED cleanly and was then never read. Silently accepted, zero effect --
  // a caller pointing the flag at a real file to evaluate a checkout that
  // ships no nen/gates.json still got that checkout's own "no such file"
  // refusal, which reads as "the flag didn't help" rather than "the flag
  // doesn't exist". The empty reviewer/approver lists below are unreachable
  // padding, not a semantic choice: resolveIdentities consults its
  // flags-identity fallback only when the gates flag is undefined, and this
  // branch runs only when it is not. next-blocker's own --reviewers stays
  // what it always was -- an override handed to nextBlocker() below, never an
  // identity SOURCE.
  const gatesFlag = context.args.values["gates"];
  // A refused identity file -- unreadable, malformed, or carrying a key this
  // build does not read (zheref/nen#310) -- is a usage error, exit 2, as it is
  // in `pr ready`: nobody asked a question GitHub could answer, so no blocker
  // is reported. Re-raised whole, so the path and pointer survive.
  let local;
  try {
    local =
      gatesFlag === undefined
        ? loadGateIdentities(root)
        : resolveIdentities(root, gatesFlag, [], []).identities;
  } catch (error) {
    if (error instanceof SchemaError) throw new VerbUsageError(error.message);
    throw error;
  }
  const snapshot = fetchPullRequest(context.seams, target, prNumber);
  // `nen/gates.json` AT THE BASE, the same source `pr ready` reads -- never the
  // local file, which in a worktree is the pull request's own head. ONE read
  // for both halves: `checks.excluded` (zheref/nen#249, Feitan F1), where any
  // failure (no base commit, an unreadable or absent file, a malformed block)
  // applies none, the stricter answer; and every OTHER input -- reviewers,
  // rounds, quorum, approvals, carve-outs (zheref/nen#372) -- where a base
  // that could not be READ falls back to the local file with a warning, and a
  // base that declares NO file or one this build REFUSES is a refusal (exit
  // 2): this verb's --reviewers narrows a declared set and names no logins,
  // so it is no identity source to fall back to. An explicit `--gates` naming
  // a file outside the checkout is the caller's word for the second half,
  // exactly as in `pr ready`; one naming the checkout's own nen/gates.json is
  // read at the base like the default, and any other file inside the
  // checkout is head content, applied with a warning. The exclusions are the
  // intersection with the default tip on every path.
  const now = new Date().toISOString();
  // Keep the fetched PR's base for identities. The separate default-tip read
  // may authorise exclusions only while its head/base still match that snapshot.
  const refs = readGateRefs(context.seams, target, prNumber, snapshot);
  const baseSha = refs.baseSha;
  const where = `${target.slug}@${baseSha === "" ? "(unknown base)" : baseSha}:${BASE_GATES_PATH}`;
  const baseRead = readGatesAt(context.seams, target, baseSha);
  const gatesClass = gatesFlag === undefined ? null : classifyGatesPath(root, local.path);
  let applied: { identities: GateIdentities; path: string; read: "base" | "local-fallback" | "gates-flag"; warnings: readonly string[] };
  if (gatesClass === null || gatesClass === "own") {
    const atBase = identitiesAtBase(baseRead, where, local);
    if (atBase.kind !== "applied") {
      throw new VerbUsageError(
        `no gate to apply: ${atBase.reason}. ${
          atBase.kind === "absent"
            ? "Merge a nen/gates.json into the base first, or pass --gates <path> naming a file you vouch for outside this checkout."
            : "Upgrade nen to a build that reads the base's gates file, or fix the base's file."
        }`,
      );
    }
    applied = { identities: atBase.identities, path: atBase.path, read: atBase.origin, warnings: atBase.warnings };
  } else if (gatesClass === "inside") {
    applied = {
      identities: local,
      path: local.path,
      read: "local-fallback",
      warnings: [
        `--gates '${local.path}' names a file inside the --repo checkout (${root}), which in a worktree may be the pull request's own head: it is applied as given, but as possible head content rather than the caller's word.`,
      ],
    };
  } else {
    applied = { identities: local, path: local.path, read: "gates-flag", warnings: [] };
  }
  const identities = applied.identities;
  const defaultWhere = `${target.slug}@${refs.defaultSha === "" ? "(unknown default-branch tip)" : refs.defaultSha}:${BASE_GATES_PATH}`;
  const defaultRead: BaseGatesRead = refs.failure !== undefined
    ? { kind: "failed", message: refs.failure }
    : refs.defaultSha !== "" && refs.defaultSha === baseSha ? baseRead : readGatesAt(context.seams, target, refs.defaultSha);
  const base = exclusionsAtBoth({ read: baseRead, source: where }, { read: defaultRead, source: defaultWhere }, local.excludedChecks ?? []);
  const exclusionSource = `${where} and ${defaultWhere} checks.excluded (intersection)`;
  // Every declared entry as `pr ready` reports it (hanten round 2, N1): the
  // notice for each honoured one that removed a check, and a warning for each
  // that did not apply -- expired, not yet ruled, an unevaluable condition.
  const declaredLines = resolveDeclaredExclusions(base.exclusions, snapshot.checks, now).outcomes.flatMap(
    (outcome): string[] => declarationWarnings(outcome, exclusionSource, now),
  );
  const warnings = [...applied.warnings, ...base.warnings, ...declaredLines];
  const result = nextBlocker(identities, snapshot, {
    declaredExclusions: base.exclusions,
    now,
    reviewers,
    policy: context.args.values["policy"] === "strict" ? "strict" : context.args.values["policy"] === "bounded" ? "bounded" : undefined,
    deliveryPr: context.args.booleans.has("delivery-pr"),
    bodyRequirements,
  });
  if (context.json) {
    // `warnings` and `notes` are additive (hanten round 2, N1/N3); so is
    // `identities`, where the identities came from, mirroring `pr ready`'s
    // `meta.identities` (zheref/nen#372, Feitan 5).
    context.io.out(
      JSON.stringify({ ...result, warnings, notes: base.notes, declaredExclusionsSource: exclusionSource, identities: { path: applied.path, read: applied.read } }, null, 2),
    );
    return result.kind === "none" ? 0 : 1;
  }
  context.io.out(`#${prNumber}: ${result.kind}`);
  // Plain at the boundary (Copilot on zheref/nen#359): the detail and the
  // declaration lines carry check labels and declared text nen did not write.
  context.io.out(plainLine(`  ${result.detail}`));
  for (const warning of warnings) {
    context.io.out(plainLine(warning.startsWith("excluded by declaration: ") ? `  ${warning}` : `  warning: ${warning}`));
  }
  return result.kind === "none" ? 0 : 1;
}

/** Both trusted policy OIDs from one GitHub snapshot; no moving ref is used for file reads. */
export function gateRefsArgv(target: Target, prNumber: number): readonly string[] {
  return ["api", "--method", "POST", "graphql", "-f",
    "query=query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){defaultBranchRef{target{oid}} pullRequest(number:$pr){baseRefOid headRefOid}}}",
    "-f", `owner=${target.owner}`, "-f", `name=${target.repo}`, "-F", `pr=${prNumber}`];
}

function readGateRefs(seams: Seams, target: Target, prNumber: number, snapshot: PrSnapshot): { baseSha: string; defaultSha: string; failure?: string } {
  const baseSha = typeof snapshot.baseRefOid === "string" && /^[0-9a-f]{40}$/i.test(snapshot.baseRefOid) ? snapshot.baseRefOid : "";
  try {
    const result = must(seams, GH, [...gateRefsArgv(target, prNumber)]);
    const raw = JSON.parse(result.stdout) as { data?: { repository?: { pullRequest?: { baseRefOid?: unknown; headRefOid?: unknown }; defaultBranchRef?: { target?: { oid?: unknown } } } }; errors?: unknown };
    if (raw.errors !== undefined) return { baseSha, defaultSha: "", failure: "GitHub reported errors while reading the pinned gate-ref snapshot" };
    const base = raw.data?.repository?.pullRequest?.baseRefOid;
    const head = raw.data?.repository?.pullRequest?.headRefOid;
    const tip = raw.data?.repository?.defaultBranchRef?.target?.oid;
    const defaultSha = typeof tip === "string" && /^[0-9a-f]{40}$/i.test(tip) ? tip : "";
    const selectedBase = typeof base === "string" && /^[0-9a-f]{40}$/i.test(base) ? base : "";
    if (selectedBase !== baseSha || typeof head !== "string" || head === "" || head !== snapshot.pr.headSha) {
      return { baseSha, defaultSha, failure: "the policy snapshot changed or is unconfirmed against the fetched PR head/base; no later policy can exempt that snapshot's checks" };
    }
    return { baseSha, defaultSha };
  } catch (error) {
    return { baseSha, defaultSha: "", failure: `could not read pinned gate refs (${redactRemoteCredentials(error instanceof Error ? error.message : String(error))})` };
  }
}

/** Wake routing trusts only the pinned default tip; this read cannot authorise check exclusions. */
function readWakePolicyRef(seams: Seams, target: Target, prNumber: number): { kind: "read"; defaultSha: string } | { kind: "failed"; message: string } {
  try {
    const result = must(seams, GH, [...gateRefsArgv(target, prNumber)]);
    const raw = JSON.parse(result.stdout) as { data?: { repository?: { defaultBranchRef?: { target?: { oid?: unknown } } } }; errors?: unknown };
    if (raw.errors !== undefined) return { kind: "failed", message: "GitHub reported errors while reading the pinned wake-policy ref" };
    const tip = raw.data?.repository?.defaultBranchRef?.target?.oid;
    if (typeof tip !== "string" || !/^[0-9a-f]{40}$/i.test(tip)) return { kind: "failed", message: "no valid default-branch OID in the wake-policy snapshot" };
    return { kind: "read", defaultSha: tip };
  } catch (error) {
    return { kind: "failed", message: `could not read pinned wake-policy ref (${redactRemoteCredentials(error instanceof Error ? error.message : String(error))})` };
  }
}

function cascade(context: CommandContext): number {
  // Usage lists --repo unbracketed: omitting it is refused by name at exit 2
  // -- this verb MUTATES (merges and pushes) whatever repository it is pointed
  // at, so a silent cwd default is exactly the retargeting root.ts's header
  // warns about (zheref/nen#28).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the repository whose current branch the trunk is merged into."),
  });
  const result = cascadeMain(context.seams, root, context.args.values["trunk"] ?? "main", {
    noPush: context.args.booleans.has("no-push"),
    dryRun: context.args.booleans.has("dry-run"),
  });
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.error !== null || result.conflicted ? 1 : 0;
  }
  for (const line of result.log) context.io.out(line);
  // The placeholder deliberately claims nothing about WHY a side is empty --
  // it covers both "the merge base resolved and this range genuinely had no
  // commits" and "the merge base itself could not be resolved, so this range
  // was never computed at all" (../pr/cascade.ts's collectConflicts()). Only
  // --json's ours[]/theirs[] arrays exist to tell those two apart.
  const commitList = (commits: readonly string[]): string => (commits.length === 0 ? "(no commits found)" : commits.join(", "));
  for (const conflict of result.conflicts) {
    context.io.out(`  ${conflict.path}  (${conflict.kind})`);
    context.io.out(`    ours:   ${commitList(conflict.ours)}`);
    context.io.out(`    theirs: ${commitList(conflict.theirs)}`);
  }
  if (result.error !== null) {
    context.io.err(`nen: ${result.error}`);
    return 1;
  }
  if (result.conflicted) return 1;
  return 0;
}

function doRetarget(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  const base = context.args.values["base"];
  if (base === undefined || base.trim() === "") {
    throw new VerbUsageError("--base <branch> is required.");
  }
  const result = retarget(context.seams, target, prNumber, base, context.args.booleans.has("dry-run"));
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  context.io.out(result.message);
  return result.ok ? 0 : 1;
}

/** One `--add-reviewers`/`--add-bots` entry's resolved destination, for --dry-run and --json alike. */
interface ReviewerRoute {
  readonly name: string;
  readonly via: "add-reviewers" | "add-bots";
  readonly route: "bot" | "user" | "team";
  /** The bot's resolved node id -- only ever set on a "bot" route. */
  readonly id: string | null;
}

/**
 * `route.route`'s human word for `routeLine()` below -- a `switch` over the
 * three-member union rather than a chained ternary (Copilot review, PR #177):
 * a route this file adds a fourth member to in future gets a compiler error
 * on this function (TypeScript proves the switch exhaustive) instead of a
 * silent fall-through inside one more `? :`.
 */
function routeDetail(route: ReviewerRoute): string {
  switch (route.route) {
    case "bot": {
      // A resolved login adds information; an explicit id already names it.
      const showId = route.id !== null && route.name !== route.id;
      return `bot${showId ? ` (id ${route.id})` : ""}`;
    }
    case "team":
      return "team";
    case "user":
      return "user";
  }
}

function routeLine(route: ReviewerRoute): string {
  return `  ${route.name} -> ${routeDetail(route)} [${route.via}]`;
}

/**
 * Resolves every `--add-reviewers` login to a route, refusing (exit 2) any
 * BARE login that resolves to neither a known Bot nor a collaborator. See
 * ./bots.ts's header for why a Bot and a User need two different reads to
 * tell apart, and why a login that resolves to neither is refused here
 * rather than handed to `gh pr edit --add-reviewer` on the chance it works.
 *
 * A TEAM SLUG (`org/team`) NEVER REACHES EITHER LOOKUP. `gh pr edit
 * --add-reviewer` resolves a User login and a team slug through the exact
 * same `requestReviewsByLogin` mutation -- the bot detour this function also
 * runs (zheref/nen#160/#174) sits BESIDE that route, not in front of it, and
 * neither of the two reads that gate entry to it can even answer for a team:
 * a Bot node never carries a "/" (its `login` is a plain reviewer handle,
 * see ./bots.ts), and `collaborators(login:)` is a GitHub COLLABORATOR
 * filter that only ever resolves a user, never a team. Refusing a team slug
 * for failing a collaborator check that was never about teams regressed
 * `--add-reviewers org/team` the day #174 added that check in front of
 * every name uniformly; "/" is the one syntactic tell GitHub itself uses to
 * write a team slug, so it is used here to route a team STRAIGHT to the
 * user/team path, resolving nothing first.
 *
 * Returns `null` for `known` when nothing NEEDED the known-bots read --
 * `logins` is empty, or every entry is a team slug -- so `fetchPrAndKnownBots`
 * is skipped entirely rather than spent finding out a bot never named needs
 * no id.
 */
function resolveReviewerLogins(
  seams: Seams,
  target: Target,
  prNumber: number,
  logins: readonly string[],
): { readonly known: PrAndKnownBots | null; readonly routes: readonly ReviewerRoute[]; readonly resolvedBotIds: readonly string[]; readonly userLogins: readonly string[] } {
  if (logins.length === 0) return { known: null, routes: [], resolvedBotIds: [], userLogins: [] };

  let known: PrAndKnownBots | null = null;
  const routes: ReviewerRoute[] = [];
  const resolvedBotIds: string[] = [];
  const userLogins: string[] = [];
  const unresolved: string[] = [];

  for (const login of logins) {
    if (login.includes("/")) {
      userLogins.push(login);
      routes.push({ name: login, via: "add-reviewers", route: "team", id: null });
      continue;
    }
    known ??= fetchPrAndKnownBots(seams, target, prNumber);
    const bot = known.bots.find((candidate): boolean => botLoginKey(candidate.login) === botLoginKey(login));
    if (bot !== undefined) {
      resolvedBotIds.push(bot.id);
      routes.push({ name: login, via: "add-reviewers", route: "bot", id: bot.id });
      continue;
    }
    if (!isBotLoginAlias(login) && !/\[bot\]$/i.test(login) && isCollaborator(seams, target, login)) {
      userLogins.push(login);
      routes.push({ name: login, via: "add-reviewers", route: "user", id: null });
      continue;
    }
    const resolved = resolveBotLogin(seams, login);
    if (resolved !== null) {
      known = { ...known, bots: [...known.bots, resolved] };
      resolvedBotIds.push(resolved.id);
      routes.push({ name: login, via: "add-reviewers", route: "bot", id: resolved.id });
      continue;
    }
    unresolved.push(login);
  }

  if (unresolved.length > 0) {
    throw new VerbUsageError(
      `${unresolved.map((login): string => `'${login}'`).join(", ")} did not resolve to a Bot by login or PR history, or a collaborator of ${target.slug}. Check the spelling or use --add-bots with an explicit Bot node id.`,
    );
  }

  return { known, routes, resolvedBotIds, userLogins };
}

function doRequestReviews(context: CommandContext): number {
  const target = requireTarget(context);
  const prNumber = requirePr(context);
  let reviewerLogins = commaList(context.args.values["add-reviewers"]);
  let explicitBots = commaList(context.args.values["add-bots"]);
  const dryRun = context.args.booleans.has("dry-run");

  if (reviewerLogins.length === 0 && explicitBots.length === 0) {
    const message =
      "no reviewers named -- --add-reviewers takes a comma-separated list of logins, or --add-bots a comma-separated list of bot logins or node ids";
    emit(context.io, context.json, { ok: false, message }, [message]);
    return 1;
  }

  // Invalid explicit identities are invocation faults, before any lookup for
  // this batch's otherwise valid bot, user or team entries.
  for (const name of explicitBots) {
    if (!isReviewerNodeId(name) && !isBotLoginInput(name)) {
      throw new VerbUsageError(`'${name}' is not a valid Bot node id or bot login for --add-bots.`);
    }
  }

  // Wake policy is trusted default-branch content, pinned by one snapshot.
  // Partition before routing, ceilings, mutations or pending-request verification.
  const refs = readWakePolicyRef(context.seams, target, prNumber);
  if (refs.kind === "failed") {
    throw new VerbUsageError(`could not read reviewer wake policy: ${refs.message}. Nothing was requested.`);
  }
  const policy = readGatesAt(context.seams, target, refs.defaultSha);
  if (policy.kind === "failed") throw new VerbUsageError(`could not read reviewer wake policy: ${policy.message}. Nothing was requested.`);
  const identities = policy.kind === "read"
    ? parseGateIdentities(`${target.slug}@${refs.defaultSha}:${BASE_GATES_PATH}`, parseGatesText(BASE_GATES_PATH, policy.text))
    : null;
  const eventIdentities = identities?.reviewers.filter((identity): boolean => identity.wake === "event") ?? [];
  const skipped: Array<{ name: string; reviewer: string; reason: string }> = [];
  const canonicalIds = eventIdentities.length === 0 ? new Map<string, string>()
    : canonicalBotLogins(context.seams, explicitBots.filter(isReviewerNodeId));
  const requestable = (name: string): boolean => {
    const login = canonicalIds.get(name) ?? name;
    const identity = eventIdentities.find((candidate): boolean => candidate.loginPattern.test(login) || candidate.loginPattern.test(`${botLoginKey(login)}[bot]`));
    if (identity === undefined) return true;
    skipped.push({ name, reviewer: identity.name, reason: "event-driven, not requested" });
    return false;
  };
  reviewerLogins = reviewerLogins.filter(requestable);
  explicitBots = explicitBots.filter(requestable);
  const skippedLines = skipped.map((entry): string => `${entry.name}: ${entry.reason}`);
  if (reviewerLogins.length === 0 && explicitBots.length === 0) {
    emit(context.io, context.json, { ok: true, ...(dryRun ? { dryRun: true } : {}), skipped, routing: [], message: skippedLines.join("\n"), unrecordedBots: [] }, skippedLines);
    return 0;
  }

  // RESOLUTION RUNS EVEN UNDER --dry-run -- the same "not network-free"
  // shape edit-body's own --dry-run already has (it still certifies the
  // number over GitHub): the whole point of resolving before requesting is
  // that a caller learns where each name WOULD go, or that one resolves to
  // neither, without this verb ever attempting a write `gh` would refuse.
  const { known, routes: reviewerRoutes, resolvedBotIds, userLogins } = resolveReviewerLogins(
    context.seams,
    target,
    prNumber,
    reviewerLogins,
  );
  const explicitBotIds: string[] = [];
  const resolvedBots: KnownBot[] = [];
  const botRoutes: ReviewerRoute[] = explicitBots.map((name): ReviewerRoute => {
    const nodeId = isReviewerNodeId(name);
    const bot = nodeId ? null : resolveBotLogin(context.seams, name);
    if (bot === null && !nodeId) throw new VerbUsageError(`'${name}' did not resolve to a Bot login; check the spelling or pass an explicit Bot node id with --add-bots.`);
    const id = bot?.id ?? name;
    if (bot !== null) resolvedBots.push(bot);
    explicitBotIds.push(id);
    return { name, via: "add-bots", route: "bot", id };
  });
  const routes = [...reviewerRoutes, ...botRoutes];
  // Deduped by id: an id named twice (once via --add-bots, once resolved
  // from a --add-reviewers login the mutation already knows by that same
  // id) is one entry in botIds, not two -- `union:true` does not need the
  // duplicate and a repeated id tells a reader nothing a single one does not.
  const botIds = [...new Set([...resolvedBotIds, ...explicitBotIds])];

  // THE ROUND CEILING (zheref/nen#240), checked BEFORE anything is requested
  // and under --dry-run too, which previews exactly what the real call would
  // do. Bots only -- see ./round_ceiling.ts's header. `known` is read here
  // when only --add-bots was given, because the base commit and the default
  // branch the ceiling is read at come with it.
  let knownBots: PrAndKnownBots | null = known;
  let ceiling: { readonly maxRounds: number; readonly source: string; readonly rounds: readonly BotRound[] } | null = null;
  // A ceiling that could not be checked refuses at exit 1; `dryRun` rides in
  // the --json of that refusal too (N11).
  const unchecked = (message: string): number => {
    emit(
      context.io,
      context.json,
      { ok: false, ...(dryRun ? { dryRun: true } : {}), skipped, routing: routes, message, ceiling: null, rounds: [], unrecordedBots: [] },
      [...skippedLines, message],
    );
    return 1;
  };
  if (botIds.length > 0) {
    knownBots ??= fetchPrAndKnownBots(context.seams, target, prNumber);
    knownBots = { ...knownBots, bots: [...knownBots.bots, ...resolvedBots] };
    const read =
      knownBots.defaultBranch === null
        ? ({ kind: "failed", message: "GitHub answered no default branch for the repository" } as const)
        : resolveCeiling(context.seams, target, [
            { label: "pull request's base", sha: knownBots.baseRefOid },
            { label: `default branch (${knownBots.defaultBranch.name})`, sha: knownBots.defaultBranch.oid },
          ]);
    if (read.kind === "failed") {
      return unchecked(
        `${read.message}. Nothing was requested: a round_policy.maxRounds ceiling that cannot be checked is never read as no ceiling (zheref/nen#240).`,
      );
    }
    if (read.kind === "declared") {
      let events: RequestEvent[];
      let canonical: ReadonlyMap<string, string>;
      // Each bot's CANONICAL login (N5): from the route or this pull
      // request's known bots where it came from GraphQL already, else one
      // `nodes(ids:)` read for the --add-bots ids nothing else named.
      const knownLogin = (id: string): string | null =>
        knownBots?.bots.find((bot): boolean => bot.id === id)?.login ??
        reviewerRoutes.find((route): boolean => route.route === "bot" && route.id === id)?.name ??
        null;
      try {
        canonical = canonicalBotLogins(context.seams, botIds.filter((id): boolean => knownLogin(id) === null));
        events = readRequestEvents(context.seams, target, prNumber);
      } catch (error) {
        if (!(error instanceof RoundCeilingError)) throw error;
        return unchecked(
          `${error.message}, so the requests already made of each bot cannot be counted against the round_policy.maxRounds ceiling of ${read.maxRounds} declared in ${read.source}. Nothing was requested (zheref/nen#240).`,
        );
      }
      const loginOf = (id: string): string | null => knownLogin(id) ?? canonical.get(id) ?? null;
      const rounds = botRounds(events, botIds.map((id): { id: string; login: string | null } => ({ id, login: loginOf(id) })), read.maxRounds);
      ceiling = { maxRounds: read.maxRounds, source: read.source, rounds };
      const refused = rounds.filter((round): boolean => round.refused);
      if (refused.length > 0) {
        const message = ceilingRefusal(`${target.slug}#${prNumber}`, refused, read.source);
        emit(
          context.io,
          context.json,
          { ok: false, ...(dryRun ? { dryRun: true } : {}), skipped, routing: routes, message, ceiling: { maxRounds: read.maxRounds, source: read.source }, rounds, unrecordedBots: [] },
          [...skippedLines, message],
        );
        return EXIT_ROUND_CEILING;
      }
    }
  }
  const ceilingJson =
    botIds.length === 0
      ? {}
      : {
          ceiling: ceiling === null ? null : { maxRounds: ceiling.maxRounds, source: ceiling.source },
          rounds: ceiling?.rounds ?? [],
        };
  const ceilingLines = (ceiling?.rounds ?? []).map(
    (round): string => `  ${botLabel(round)}: request ${round.next} of ${round.maxRounds} (round_policy.maxRounds, ${ceiling?.source ?? ""})`,
  );

  if (dryRun) {
    const lines = [...skippedLines, `would request review on ${target.slug}#${prNumber}:`, ...routes.map(routeLine), ...ceilingLines];
    emit(context.io, context.json, { ok: true, dryRun: true, skipped, routing: routes, message: lines.join("\n"), ...ceilingJson }, lines);
    return 0;
  }

  const results: Array<{ readonly ok: boolean; readonly message: string; readonly unrecordedBots?: readonly UnrecordedBot[] }> = [];
  if (userLogins.length > 0) {
    results.push(requestReviews(context.seams, target, prNumber, userLogins));
  }
  if (botIds.length > 0) {
    // `known` is already populated whenever any --add-reviewers login
    // resolved to a bot; a caller who named bots ONLY via --add-bots never
    // triggered that read, so the pull request's own node id -- the
    // mutation's pullRequestId -- is fetched here instead. The same read's
    // bot list rides along so an unrecorded bot (zheref/nen#277) is named by
    // its login where this pull request already knows it, not only by id.
    const bots = knownBots ?? fetchPrAndKnownBots(context.seams, target, prNumber);
    results.push(requestBotReviews(context.seams, target, prNumber, bots.pullRequestId, botIds, bots.bots));
  }

  const ok = results.every((result): boolean => result.ok);
  const unrecordedBots = results.flatMap((result): readonly UnrecordedBot[] => result.unrecordedBots ?? []);
  // A FAILED CALL OUTRANKS AN UNRECORDED BOT (zheref/nen#277). When one route's
  // `gh` call failed outright (exit 1's meaning) and, in the same invocation,
  // the bot route was accepted but absent from the response, the code says the louder
  // fact -- something needs fixing before anything is retried -- and
  // `unrecordedBots` in --json still carries the bot half. EXIT 9 therefore
  // means exactly one thing: every call this verb made was accepted, and at
  // least one requested bot is absent from the response's pending-review page.
  const failedOutright = results.some((result): boolean => !result.ok && (result.unrecordedBots ?? []).length === 0);
  const code = ok ? 0 : failedOutright ? 1 : EXIT_BOT_REQUEST_UNRECORDED;
  const lines = [...skippedLines, ...results.map((result): string => result.message), ...ceilingLines];
  // JOINED WITH A NEWLINE, matching the human rendering line for line
  // (Copilot review, PR #174) -- both routes running in the same call
  // prints two lines to the terminal, and `--json`'s `message` field
  // silently collapsing them with a space would be a fact the human
  // rendering states plainly and the JSON rendering blurs.
  emit(context.io, context.json, { ok, skipped, routing: routes, message: lines.join("\n"), unrecordedBots, ...ceilingJson }, lines);
  return code;
}

/**
 * Exit 2 for a request past `round_policy.maxRounds` (zheref/nen#240): the
 * invocation asked for something the repository's declared policy refuses.
 * The same code a usage error carries, as the issue asks; the message names
 * the reviewer, the count and the ceiling, which a usage error never does.
 */
export const EXIT_ROUND_CEILING = 2;



/**
 * The first and last line of a body, for --dry-run's summary.
 *
 * PREVIEW ONLY -- the trailing newline stripped here and the separator split
 * on are never fed back into `body` or `bytes`, which stay exactly what was
 * read off disk. Splitting on a bare "\n" left a CRLF file's last displayed
 * line carrying a trailing "\r" (Copilot review): a caller reading `last
 * line: done\r` could not tell whether that was really in the file or an
 * artifact of this rendering. `/\r?\n/` treats CRLF as one line break for
 * the preview without touching how the actual write reads the file.
 */
function bodyBookends(body: string): { readonly first: string; readonly last: string } {
  const withoutTrailingNewline = body.replace(/\r?\n$/, "");
  const lines = withoutTrailingNewline.split(/\r?\n/);
  return { first: lines[0] ?? "", last: lines[lines.length - 1] ?? "" };
}

// `--pr` IS READ WITH THE HOUSE `/^\d+$/` GUARD HERE, deliberately NOT
// through this file's own `requirePr()` above (`Number(raw ?? "")`, which
// accepts `1e3` as 1000 and `0x0c` as 12). ../issue/command.ts's `comment()`
// draws the same line for the same reason and records it at length: a
// MUTATING verb that reads a number takes the strict form, because a looser
// read would silently overwrite the wrong object's body. `requirePr()`
// predates that discipline and is left as it is for its own four callers
// (fetch/next-blocker/retarget/request-reviews) -- not this change's fix to
// make.
/**
 * `--pr <n>`, read STRICTLY: digits only, positive, nothing JavaScript would
 * be willing to coerce.
 *
 * WHY THE FAMILY HAS TWO READERS OF ONE FLAG. `requirePr` above goes through
 * `Number(raw)`, which happily reads `1e3` as 1000 and `0x0c` as 12 -- a
 * caller's typo or a variable that picked up the wrong shell expansion
 * addresses a DIFFERENT pull request, silently and successfully. That is
 * survivable for a read (`fetch`, `next-blocker`) and is not survivable for a
 * verb that WRITES, which is why `edit-body` grew this reader; `threads reply`
 * and `threads resolve` write too -- a reply posted on the wrong pull request
 * is a public comment under the caller's identity -- so they share it
 * (Copilot, #221 round 2). `threads list` takes it as well rather than
 * splitting the family's one flag three ways: the number a listing printed is
 * the number a reply is about to be sent to, and they must be the same number.
 *
 * `verb` NAMES THE CALLER so the refusal says which verb refused, rather than
 * every verb in the family claiming to be `edit-body`.
 */
function requirePrStrict(context: CommandContext, verb: string): number {
  const raw = context.args.values["pr"];
  if (raw === undefined) {
    throw new VerbUsageError(`${verb} takes --pr <n>.`);
  }
  // BOUNDED, AND SAFE (Copilot, #221 round 3). `/^\d+$/` admits a digit string
  // of any length, and `Number.parseInt` turns a long enough one into
  // `Infinity` -- which is `> 0`, so it passed. `Infinity` then went into an
  // argv as the literal "Infinity" and addressed nothing. The length cap is
  // the cheap half (no repository has a ten-digit pull request) and
  // `Number.isSafeInteger` is the half that means it: above 2^53 a number is
  // no longer the number that was typed, and an identity that is not the one
  // you typed is the whole class of defect this reader exists to close.
  const parsed = Number.parseInt(raw, 10);
  if (!/^\d{1,9}$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new VerbUsageError(
      `${verb} takes --pr <n>: a positive whole number of at most 9 digits, digits only -- got '${raw}'. A looser read would accept '1e3' as 1000, '0x0c' as 12, and a long enough digit string as Infinity, and address the wrong pull request or none at all.`,
    );
  }
  return parsed;
}

function editBody(context: CommandContext): number {
  const target = requireTarget(context);
  const pr = requirePrStrict(context, "edit-body");
  // Read before any `gh` call; an unreadable one is exit 2 (zheref/nen#363).
  const ignore = readIgnoreFlag(context);

  const bodyFile = context.args.values["body-file"];
  if (bodyFile === undefined) {
    throw new VerbUsageError(
      "edit-body takes --body-file <path>: a body typed on the command line is a body nobody reviewed, and this verb REPLACES the pull request's body outright.",
    );
  }

  // READ RAW AND CHECKED BEFORE ANYTHING IS SENT -- ../issue/command.ts's
  // comment() makes the same two decisions for the same reasons: a
  // --dry-run byte count that is not the byte count that would be sent is
  // not a dry run. Since zheref/nen#363 `gh` is handed these BYTES on stdin,
  // never the path: the private-name guard checks them, and a path gh
  // re-reads after the check could publish something it never saw.
  const body = readTextFile(
    bodyFile,
    process.cwd(),
    "--body-file names the bytes this verb writes as the pull request's new body, so an unreadable one is refused rather than replacing it with nothing.",
    true,
  );
  if (body.trim() === "") {
    throw new VerbUsageError(
      `--body-file '${bodyFile}' is empty (or holds only whitespace). Replacing a pull request's body with nothing is never what a caller meant, and it is never assumed.`,
    );
  }

  // CERTIFIED BEFORE ANY WRITE -- see ./editbody.ts's header for why a
  // number that does not read as a pull request is refused (exit 2) rather
  // than accepted the way 'issue comment' accepts either object class.
  certifyPullRequest(context.seams, target, pr);

  const bytes = Buffer.byteLength(body, "utf8");
  const argv = editBodyArgv(target, pr);
  const dryRun = context.args.booleans.has("dry-run");

  // THE PRIVATE-NAME GUARD (zheref/nen#363), after the certifying read (a
  // number that is not a pull request is refused for THAT first) and before
  // the write -- on a dry run too, so its verdict is the real run's.
  const privateNameCheck = guardPrivateNames(context, target, [{ field: "body", text: body }], ignore, "nen pr edit-body");
  if (blocksWrite(privateNameCheck)) {
    if (context.json) {
      context.io.out(
        JSON.stringify(
          { contract: "nen.pr.edit-body/v0.1", target: target.slug, number: pr, bytes, written: false, dryRun, privateNameCheck },
          null,
          2,
        ),
      );
    }
    return blockingExit(privateNameCheck);
  }

  if (dryRun) {
    if (context.json) {
      context.io.out(
        JSON.stringify(
          { contract: "nen.pr.edit-body/v0.1", target: target.slug, number: pr, bytes, written: false, dryRun: true, privateNameCheck },
          null,
          2,
        ),
      );
      return 0;
    }
    const { first, last } = bodyBookends(body);
    context.io.out(`would run: gh ${argv.join(" ")}`);
    context.io.out(`target: ${target.slug}`);
    context.io.out(`number: ${pr}`);
    context.io.out(`bytes: ${bytes}`);
    context.io.out(`first line: ${first}`);
    context.io.out(`last line: ${last}`);
    return 0;
  }

  writePullRequestBody(context.seams, target, pr, body);
  if (context.json) {
    context.io.out(
      JSON.stringify(
        { contract: "nen.pr.edit-body/v0.1", target: target.slug, number: pr, bytes, written: true, dryRun: false, privateNameCheck },
        null,
        2,
      ),
    );
    return 0;
  }
  context.io.out(`replaced ${target.slug}#${pr}'s body (${bytes} byte(s))`);
  return 0;
}

// ── mark-ready (zheref/nen#345) ─────────────────────────────────────────────
//
// The flags it reads are its PR_SUBCOMMAND_FLAGS row; every other family flag
// -- --token-env above all (Feitan F1, Nobunaga N1) -- is refused by the
// family guard before this runs (zheref/nen#351 generalised #345's table).
//
// The verb's logic lives in ./markready.ts behind the seam; this adapts flags
// and renders. `--pr` takes the STRICT reader, because this verb WRITES: a
// coerced `1e3` would move pull request 1000 out of draft.
function doMarkReady(context: CommandContext): number {
  const target = requireTarget(context);
  const pr = requirePrStrict(context, "mark-ready");
  const rawHead = context.args.values["require-head"];
  if (rawHead !== undefined && !MARK_READY_SHA_PREFIX.test(rawHead)) {
    throw new VerbUsageError(`mark-ready: --require-head takes a commit SHA of 7 to 40 hex digits (got '${rawHead}').`);
  }
  const report: MarkReadyReport = markReady(context.seams, {
    target,
    number: pr,
    requiredHead: rawHead ?? null,
    dryRun: context.args.booleans.has("dry-run"),
  });
  // EVERY HUMAN LINE THROUGH plainLine (Feitan F3): the url, the node id (in
  // the argv and the different-object message) and gh's own stderr are
  // GitHub-controlled strings. --json carries the original bytes.
  const lines = [report.status, report.message];
  if (report.mutationArgv !== null && report.dryRun) lines.push(`would run: ${printableArgv(report.mutationArgv.slice(1))}`);
  lines.push(`  ${report.url}`);
  lines.push(`  head: ${report.headBefore}${report.headAfter !== null && report.headMoved ? ` -> ${report.headAfter}` : ""}`);
  if (report.requiredHead !== null) lines.push(`  --require-head ${report.requiredHead}`);
  emit(context.io, context.json, report, lines.map(plainLine));
  return exitCodeFor(report.status);
}

// ── threads (zheref/nen#215) ────────────────────────────────────────────────
//
// THE ACTION IS A SECOND POSITIONAL, not a third flag. `nen pr threads list`
// reads as one verb with a mode, which is what it is; a `--resolve` boolean
// beside a `--reply` boolean would be two flags that can both be given, and a
// flag that is accepted and ignored is what PR_SUBCOMMAND_FLAGS and
// refuseFlagsSubcommandDoesNotRead exist to refuse, because that mistake is
// expensive here.
//
// EVERY PATH LISTS FIRST, INCLUDING `--dry-run`. The listing is what turns a
// bad `--thread` into exit 4 naming it and an already-resolved one into exit 3
// naming it, instead of a GraphQL error a caller has to read. See
// ./threads.ts's header for why those two are separate codes at all.

function threads(context: CommandContext): number {
  const action = context.args.positionals[2];
  if (action === undefined || !THREAD_ACTIONS.includes(action)) {
    throw new VerbUsageError(
      `'pr threads' needs an action: ${THREAD_ACTIONS.join(", ")}. Try 'nen pr threads list --target <owner/name> --pr <n>'.`,
    );
  }
  // EACH ACTION READS ONLY ITS OWN FLAGS (Copilot, #221): `list` used to
  // ignore `--thread` and `resolve` `--body-file`. refuseFlagsSubcommandDoesNotRead
  // judges a threads action against THREADS_ACTION_FLAGS[action] before this
  // runs, so every flag the action does not read was already refused there,
  // naming the actions that do read it (hanten round 1).

  const target = requireTarget(context);
  const prNumber = requirePrStrict(context, `threads ${action}`);
  const dryRun = context.args.booleans.has("dry-run");
  if (action === "settle") return settle(context, target, prNumber, dryRun);
  const threadId = context.args.values["thread"];
  if (action !== "list" && (threadId === undefined || threadId.trim() === "")) {
    throw new VerbUsageError(
      `'pr threads ${action}' takes --thread <id>: the GraphQL node id 'pr threads list' prints. There is no positional form, because the third thread stops being the third one the moment anybody comments.`,
    );
  }

  let body = "";
  let ignore: IgnoreList | null = null;
  if (action === "reply") {
    ignore = readIgnoreFlag(context);
    const bodyFile = context.args.values["body-file"];
    if (bodyFile === undefined || bodyFile.trim() === "") {
      throw new VerbUsageError(
        "'pr threads reply' takes --body-file <path>: a reply typed on the command line is a reply nobody reviewed, and this one is posted under your identity.",
      );
    }
    // READ RAW AND CHECKED BEFORE ANYTHING IS SENT, exactly as `edit-body`
    // reads its own body: a --dry-run that did not read the file would not
    // have proved the one thing a caller wanted proved.
    //
    // RESOLVED AGAINST `--repo`, NOT THE PROCESS CWD (Feitan F7). ../cli/
    // inputs.ts's rule is that a relative path flag resolves against the
    // target repository's root, and every other path flag in this CLI follows
    // it -- so `--repo ../other --body-file reply.md` must mean that
    // repository's `reply.md`, not one that happens to sit beside the shell.
    // Reading the wrong file here posts the wrong text under the caller's
    // identity, which is not a mistake a dry run helps with if the dry run
    // read the same wrong file.
    body = readTextFile(
      bodyFile,
      resolveRepoRoot({ repoFlag: context.repoFlag }),
      "--body-file names the bytes this verb posts as the reply, so an unreadable one is refused rather than posting nothing.",
      true,
    );
    if (body.trim() === "") {
      throw new VerbUsageError(
        `--body-file '${bodyFile}' is empty (or holds only whitespace). An empty reply is never what a caller meant, and it is never assumed.`,
      );
    }
  }

  // THE PRIVATE-NAME GUARD (zheref/nen#363), before the thread walk and the
  // reply -- on a dry run too. A reply is posted under the caller's identity on
  // the pull request's public timeline. Its exit 4 is the guard's 4, which this
  // verb also answers for an unknown thread: a refusal by the guard is told
  // apart by its stderr lines and, under --json, by `privateNameCheck`.
  let privateNameCheck: PrivateNameCheck | null = null;
  if (action === "reply") {
    privateNameCheck = guardPrivateNames(context, target, [{ field: "body", text: body }], ignore, "nen pr threads reply");
    if (blocksWrite(privateNameCheck)) {
      if (context.json) {
        context.io.out(
          JSON.stringify(
            { contract: THREADS_CONTRACT, target: target.slug, pr: prNumber, thread: threadId as string, replied: false, dryRun, privateNameCheck },
            null,
            2,
          ),
        );
      }
      return blockingExit(privateNameCheck);
    }
  }

  try {
    const listing = listThreads(context.seams, target, prNumber);
    let replied = false;
    let resolved = false;
    let argv: readonly string[] | null = null;
    if (action === "reply") {
      const result = replyToThread(context.seams, target, prNumber, listing, threadId as string, body, dryRun);
      replied = result.replied;
      argv = result.argv;
    } else if (action === "resolve") {
      const result = resolveThread(context.seams, target, prNumber, listing, threadId as string, dryRun);
      resolved = result.resolved;
      argv = result.argv;
    }
    const report: ThreadsReport = {
      contract: THREADS_CONTRACT,
      target: target.slug,
      pr: prNumber,
      head: listing.head,
      thread: action === "list" ? null : (threadId as string),
      replied,
      resolved,
      dryRun,
      threads: action === "list" ? listing.threads : [],
      argv,
    };
    const lines =
      action === "list"
        ? renderThreads(report)
        : [
            ...(argv === null ? [] : [`${dryRun ? "would run" : "ran"}: ${printableArgv(argv)}`]),
            `${target.slug}#${prNumber} thread ${threadId as string}: ${
              dryRun
                ? "nothing written (dry run)"
                : action === "reply"
                  ? "replied"
                  : "resolved"
            }`,
          ];
    emit(context.io, context.json, privateNameCheck === null ? report : { ...report, privateNameCheck }, lines);
    return 0;
  } catch (error) {
    if (error instanceof ThreadsError) {
      context.io.err(`nen pr threads ${action}: ${error.message}`);
      return EXIT_FOR[error.kind];
    }
    throw error;
  }
}

/**
 * `nen pr threads settle` (zheref/nen#230). See ./settle.ts's header: the
 * file is validated in full, then the ONE walk, then the unknown-id refusal,
 * then the mutations -- so every exit-2 refusal fires before anything is sent.
 */
function settle(context: CommandContext, target: Target, prNumber: number, dryRun: boolean): number {
  const fromFlag = context.args.values["from"];
  if (fromFlag === undefined || fromFlag.trim() === "") {
    throw new VerbUsageError(
      "'pr threads settle' takes --from <file.json>: a JSON array of { \"thread\": \"<id>\", \"body\": \"<text>\" } or { \"thread\": \"<id>\", \"bodyFile\": \"<path>\" }.",
    );
  }
  // RESOLVED AGAINST `--repo`, like every other path flag (Feitan F7).
  const fromPath = resolveAgainstRepo(resolveRepoRoot({ repoFlag: context.repoFlag }), fromFlag);
  const ignore = readIgnoreFlag(context);
  const { entries, baseDir } = readSettleFile(fromPath);
  // THE PRIVATE-NAME GUARD (zheref/nen#363): every reply body in the file,
  // after the file's own refusals and before the walk -- so a hit sends
  // nothing to any thread. One field per entry, numbered from 1 in file order;
  // the thread id is not text the guard reports.
  const privateNameCheck = guardPrivateNames(
    context,
    target,
    entries.map((entry, index): CheckedText => ({ field: `entry[${index + 1}]`, text: entry.body })),
    ignore,
    "nen pr threads settle",
  );
  if (blocksWrite(privateNameCheck)) {
    if (context.json) {
      context.io.out(
        JSON.stringify({ contract: SETTLE_CONTRACT, target: target.slug, pr: prNumber, from: fromPath, dryRun, ok: false, privateNameCheck }, null, 2),
      );
    }
    return blockingExit(privateNameCheck);
  }
  let listing;
  try {
    listing = listThreads(context.seams, target, prNumber);
  } catch (error) {
    if (error instanceof ThreadsError) {
      context.io.err(`nen pr threads settle: ${error.message}`);
      return EXIT_FOR[error.kind];
    }
    throw error;
  }
  refuseUnknownThreads(listing, entries, target.slug, prNumber);
  const result = settleThreads(context.seams, target, prNumber, listing, entries, dryRun);
  const report: SettleReport = {
    contract: SETTLE_CONTRACT,
    target: target.slug,
    pr: prNumber,
    head: listing.head,
    from: fromPath,
    dryRun,
    ok: result.failure === null && result.outcomes.every((outcome): boolean => outcome.disposition === (dryRun ? "planned" : "resolved")),
    stoppedAt: result.stoppedAt,
    entries: result.outcomes,
  };
  emit(context.io, context.json, { ...report, privateNameCheck }, renderSettle(report, baseDir));
  if (result.failure !== null) context.io.err(`nen pr threads settle: ${stoppedLine(report)}`);
  return settleExit(result, EXIT_FOR);
}

/**
 * `nen pr open`. `--repo` is OPTIONAL here, unlike the verbs that mutate a
 * tree: the write goes to GitHub, and the checkout is only asked which branch
 * is out and whether the remote holds it -- reads whose wrong answer is a
 * refusal, never a wrong pull request.
 */
function open(context: CommandContext): number {
  const target = requireTarget(context);
  const base = requireValue(context.args, "base", "It is the pull request's base branch on GitHub.");
  const titlePath = requireValue(context.args, "title-file", "It is the file whose first non-empty line is the title.");
  const bodyPath = requireValue(context.args, "body-file", "It is the pull request body, read once, checked and handed to gh on stdin.");
  const ignore = readIgnoreFlag(context);
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  // VERBATIM: a title whose bytes are not UTF-8 is refused (exit 2), never
  // opened with replacement characters (delivery round on zheref/nen#498).
  const title = readVerbatimTextFile(titlePath, root, "It is the pull request's title -- 'pr open' reads no other source for it.")
    .split("\n")
    .map((line): string => line.trim())
    .find((line): boolean => line !== "");
  if (title === undefined) throw new VerbUsageError(`--title-file '${titlePath}' has no non-empty line, so there is no title to open with.`);
  // READ ONCE, RAW, AND THOSE BYTES ARE WHAT gh GETS, on stdin (zheref/nen#363):
  // the private-name guard checks them, and a path gh re-read after the check
  // could publish what the check never saw. An unreadable file still fails
  // before any question below is asked.
  const bodyFile = resolveAgainstRepo(root, bodyPath);
  const body = readTextFile(bodyPath, root, "It is the pull request body -- 'pr open' reads it once, checks it and hands those bytes to gh.", true);
  const assignees = readAssignees(context.args.values["assignee"]);
  // THE PRIVATE-NAME GUARD, before any other GitHub call and every write -- on
  // a dry run too, so its verdict is the real run's.
  const privateNameCheck = guardPrivateNames(
    context,
    target,
    [
      { field: "title", text: title },
      { field: "body", text: body },
    ],
    ignore,
    "nen pr open",
  );
  if (blocksWrite(privateNameCheck)) {
    if (context.json) {
      context.io.out(JSON.stringify({ contract: OPEN_CONTRACT, dryRun: context.args.booleans.has("dry-run"), opened: false, privateNameCheck }, null, 2));
    }
    return blockingExit(privateNameCheck);
  }
  const outcome = openPullRequest(context.seams, root, target, {
    base,
    head: context.args.values["head"] ?? null,
    title,
    bodyFile,
    body,
    draft: context.args.booleans.has("draft"),
    dryRun: context.args.booleans.has("dry-run"),
    assignees,
  });
  if (outcome.kind === "refused") throw new VerbUsageError(outcome.reason);
  // Every line carries a branch name, a login or gh's own words.
  emit(context.io, context.json, { ...outcome.report, privateNameCheck }, outcome.lines.map(plainLine));
  if (outcome.failure !== undefined) {
    context.io.err(`nen pr open: ${plainLine(outcome.failure)}`);
    return 1;
  }
  return 0;
}

/**
 * `--assignee a,b,@me`, syntax-checked before any call (exit 2). An empty
 * value, an empty item, a duplicate, or anything that is not a GitHub login's
 * shape or `@me` is refused by name; whether each login EXISTS and can be
 * assigned is ./open.ts's question, asked of GitHub before the create.
 */
function readAssignees(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const items = raw.split(",").map((item): string => item.trim());
  if (items.some((item): boolean => item === "")) {
    throw new VerbUsageError(`--assignee '${raw}' has an empty login. It takes <login>[,<login>...], or @me for the token running this verb.`);
  }
  const bad = items.filter((item): boolean => item !== OPEN_ME && !OPEN_LOGIN.test(item));
  if (bad.length > 0) {
    throw new VerbUsageError(
      `--assignee: ${bad.map((item): string => `'${item}'`).join(", ")} ${bad.length === 1 ? "is" : "are"} not a GitHub login (letters, digits and single interior hyphens, at most 39 characters) or @me.`,
    );
  }
  const seen = new Set<string>();
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) throw new VerbUsageError(`--assignee names '${item}' twice.`);
    seen.add(key);
  }
  return items;
}

/**
 * `nen pr merge <ref> --release-unit`. See ./mergeunit.ts's header for the
 * whole composition; this adapter only reads the CLI's own flags and renders.
 */
async function doMerge(context: CommandContext): Promise<number> {
  // Every flag 'pr merge' does not read was refused by the family guard
  // (round 2, N7; zheref/nen#351) before this ran.
  const releaseUnit = context.args.booleans.has("release-unit");
  const delivery = context.args.booleans.has("delivery");
  if (releaseUnit && delivery) {
    throw new VerbUsageError("--release-unit and --delivery are mutually exclusive -- a pull request is merged as one or the other, never both.");
  }
  if (!releaseUnit && !delivery) {
    throw new VerbUsageError(
      "nen pr merge only merges a release unit (--release-unit) or a run's own delivery pull request into a non-main base (--delivery) -- pass one to say so explicitly. There is no general-purpose merge here.",
    );
  }
  const typedRef = context.args.positionals[2];
  const form = releaseUnit ? "--release-unit" : "--delivery";
  if (typedRef === undefined) {
    throw new VerbUsageError(
      `'pr merge' requires a pull-request reference. Try 'pr merge <n> ${form} ...', 'pr merge owner/name#<n> ${form} ...' or 'pr merge <CODE>#<n> ${form} ...'.`,
    );
  }
  if (delivery) return doMergeDelivery(context, typedRef);
  if (context.args.values["require-head"] !== undefined) {
    throw new VerbUsageError("--require-head is read by 'pr merge --delivery', not by --release-unit, which pins the head 'pr ready' judges.");
  }
  if (context.args.values["catalogue"] !== undefined) {
    throw new VerbUsageError("--catalogue is read by 'pr merge --delivery' (the criteria gate), not by --release-unit.");
  }
  const requirementsPath = requireRequirementsPath(context);
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the checkout whose nen/workflow.json declares release.unitPaths."),
  });
  const requirements = readRequirements(requirementsPath, root);

  let outcome;
  try {
    outcome = await mergeUnit({
      typedRef,
      repoFlag: context.repoFlag,
      requirements,
      run: context.args.booleans.has("run"),
      seams: context.seams,
      root,
    });
  } catch (error) {
    if (error instanceof MergeUnitUsageError) throw new VerbUsageError(error.message);
    throw error;
  }

  emit(context.io, context.json, outcome.report, outcome.lines);
  return mergeExit(outcome.report);
}

/**
 * The exit-code mapping both merge forms share. gh itself refusing the merge
 * (branch protection, a required review, ...) is distinct from an ordinary
 * gate failure (exit 1) and from gh never having been RUNNABLE at all
 * (F8(b)), so a caller's script can tell "the checks did not pass" from "the
 * checks passed and gh said no" from "gh could not even be started" without
 * parsing the message.
 */
export function mergeExit(report: { readonly ok: boolean; readonly ran: boolean; readonly spawnFailed: boolean; readonly mergeArgv: readonly string[] | null }): number {
  if (report.ok) return 0;
  if (report.ran === false && report.mergeArgv !== null) return report.spawnFailed ? EXIT_GH_NOT_RUNNABLE : EXIT_GH_REFUSED;
  return 1;
}

/**
 * `nen pr merge <ref> --delivery` (zheref/nen#286, narrowed by the
 * maintainer's ruling of 2026-10-03 to non-main bases). See
 * ./mergedelivery.ts's header; this adapter only reads flags and renders.
 */
async function doMergeDelivery(context: CommandContext, typedRef: string): Promise<number> {
  const requirementsPath = requireRequirementsPath(context);
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the checkout whose origin names the repository and whose nen/workflow.json declares branch.base."),
  });
  const requirements = readRequirements(requirementsPath, root);
  const { catalogue, policy } = readCriteriaCatalogue(context, "catalogue", root);
  let outcome;
  try {
    outcome = await mergeDelivery({
      typedRef,
      repoFlag: context.repoFlag,
      requirements,
      catalogue,
      policy,
      requireHead: context.args.values["require-head"] ?? null,
      run: context.args.booleans.has("run"),
      seams: context.seams,
      root,
    });
  } catch (error) {
    if (error instanceof MergeUnitUsageError) throw new VerbUsageError(error.message);
    throw error;
  }
  emit(context.io, context.json, outcome.report, outcome.lines.map(plainLine));
  return deliveryExit(outcome.report, mergeExit);
}

/** `--requirements-from`, required by BOTH merge forms (zheref/nen#286 AC1 for --delivery). */
function requireRequirementsPath(context: CommandContext): string {
  return requireValue(
    context.args,
    "requirements-from",
    "The same '{ name, pattern }' JSON array 'pr body-check' takes, checked against the pull request's LIVE body.",
  );
}

/** Reads and validates `--requirements-from` before ANY gh call -- one reader for both merge forms. */
function readRequirements(requirementsPath: string, root: string): readonly BodyRequirement[] {
  const rawRequirements = readJsonFile<unknown>(requirementsPath, root);
  try {
    validateRequirements(rawRequirements);
  } catch (error) {
    if (error instanceof BodyCheckError) throw new VerbUsageError(`'${requirementsPath}': ${error.message}`);
    throw error;
  }
  return rawRequirements;
}
