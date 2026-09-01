// ============================================================================
// SEEDED FROM bankai-core `cli/src/github/client.ts` (zheref/nen#1, Akatsuki migration P1).
//
// The header below this block is the ORIGINAL's, carried VERBATIM. It is not
// decoration: every WHY in it names a production incident, and a port that
// arrives without the explanation of why a branch exists is a port whose next
// maintainer "simplifies" it back into the bug (the BC-IS-#737 discipline).
// Only file PATHS have been rewritten, because this repository has no `cli/`
// subdirectory -- nen IS the CLI. References to bankai-core's own scripts,
// workflows and clause IDs are left alone: they are accurate statements about
// the system this code came from and where its reasoning is recorded.
//
// CHANGED BEYOND PATHS: the octokit user-agent, which named the other binary.
// ============================================================================
// src/github/client.ts -- the thin octokit wrapper (BC-IS-#736, epic
// BC-IS-#733 Phase 1).
//
// SMALL AND SIDE-EFFECTING ON PURPOSE. Everything here does I/O and nothing here
// decides anything: the methods hand back the JSON GitHub answered with,
// gh-shaped by ./graphql.ts, for ./parse.ts to validate and
// ../gates/predicates.ts to judge. That split is what makes the readiness
// predicates testable without a network, which is the whole reason BC-9 can
// demand real coverage of them.
//
// NO BRANCHING LIVES HERE, and that is a deliberate change from this file's
// first draft (BC-PR-#802 verification, BC-9). The rollup extraction used to
// decide WHICH commit's rollup is read inside a method that could only be
// exercised against a live PR -- "a script/guard with real branching and no
// vitest test" is BC-9's auto-reject. That logic is pure and network-free, so it
// moved to ./graphql.ts where it is driven directly by graphql.test.ts; every
// method below is now a single await plus one extraction call.
//
// THE TOKEN IS PASSED EXPLICITLY. `gh` picks credentials up ambiently -- GH_TOKEN,
// GITHUB_TOKEN, the keyring, a hosts.yml -- and which identity a call ran as
// becomes a property of the environment rather than of the code. This client
// takes the token as an argument; tokenFromEnv() reads exactly the ONE variable
// the caller names and never falls back to another, so a job that forgot to mint
// a token fails loudly instead of quietly running as whatever identity happened
// to be lying around. The App token the machinery mints needs
// `pull-requests: read` AND `checks: read` AND `actions: read` for the
// statusCheckRollup query -- checks:read alone is not enough, because the rollup's
// own checkSuite.workflowRun sub-field needs actions:read too, and the missing
// grant is exactly what broke every sweeper tick before bankai-core#570/#636.
//
// NO VERDICTS LIVE HERE, including the conservative ones. The shell's
// `unresolved_thread_count` falls back to 1 (not-ready) whenever a page cannot
// be established -- "can't confirm zero, so not zero". That is a READINESS
// decision, so it belongs to the gate composition a later phase ports, not to
// the transport: this client exposes one review-thread PAGE and lets the caller
// own both the cursor walk and what an unreadable page means (bankai-core#568).

import { Octokit } from "octokit";
import {
  normalizePullRequestResponse,
  normalizeReviewThreadsResponse,
  PULL_REQUEST_QUERY,
  REVIEW_THREADS_QUERY,
  type GhPullRequestNode,
  type PullRequestSnapshot,
  type ReviewThreadPage,
} from "./graphql.js";
// PORT ADDITION: this binary's own name and version, for the user-agent below.
import { PROGRAM, VERSION } from "../version.js";

// The GraphQL wire shape is ./graphql.ts's alone (see its header), but these
// three are part of this module's published surface and are re-exported so a
// consumer needs one import, not two.
export { digPath } from "./graphql.js";
export type { GhPullRequestNode, PullRequestSnapshot, ReviewThreadPage };

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export type TokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly message: string };

// Read the App/PAT token from the ONE environment variable the caller names.
//
// Returned, never thrown, and never defaulted: an absent token is an expected
// operational condition (a workflow that forgot the `with: token:`), and the
// caller must be able to report it as itself rather than as an authentication
// error 40 lines later.
export function tokenFromEnv(
  envVarName: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): TokenResult {
  const raw = env[envVarName];
  if (raw === undefined) {
    return {
      ok: false,
      message: `${envVarName} is not set -- this client never picks a token up ambiently the way gh does, so the caller must mint one and name the variable it lives in`,
    };
  }
  if (raw.trim() === "") {
    return {
      ok: false,
      message: `${envVarName} is set but empty -- an empty token authenticates as nobody, and an unauthenticated read of a private repo 404s in a way that reads like a deleted PR`,
    };
  }
  // PORT CORRECTION, carried from the recorded disposition on zheref/nen#7's
  // review thread (src/github/client.ts:103, Copilot; acknowledged by the
  // maintainer, deferred to the readiness-core PR that adopts this module).
  //
  // The seed VALIDATED with `raw.trim()` and RETURNED `raw`, so a token pasted
  // with a trailing newline -- the ordinary shape of a `gh auth token > file`
  // or a copied secret -- passed the emptiness check and then reached octokit's
  // `Authorization: token <value>\n` header intact. GitHub answers that with a
  // 401, or with a 404 on a private repository, and BOTH read like a deleted PR
  // or a missing grant rather than like whitespace. The failure is silent in the
  // direction that costs the most time: everything about the call looks right.
  //
  // Trimming here rather than at the call sites, and RETURNING the trimmed value
  // rather than trimming inside GitHubClient, because this function is already
  // the ONE place the raw environment is read -- a second trim at a consumer
  // would leave `result.token` and the value actually sent to GitHub as two
  // different strings, which is the same class of gap in a smaller costume.
  //
  // It cannot widen anything: a value that survives `raw.trim() !== ""` is
  // non-empty after trimming, and a token's own alphabet contains no whitespace.
  return { ok: true, token: raw.trim() };
}

export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string, options: { readonly baseUrl?: string } = {}) {
    this.octokit = new Octokit({
      auth: token,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      // PORT CHANGE: the original names the other binary. Composed from
      // ../version.ts rather than written as a literal, so a rate-limit
      // investigation can tell WHICH build of nen made a call and the string
      // cannot drift from the version `nen --version` reports.
      userAgent: `${PROGRAM}/${VERSION}`,
    });
  }

  // ONE round trip, all three slices: the PR node, the head commit's check
  // rollup, and the pending review requests.
  //
  // THIS is the method that makes "one round trip" true. The three accessors
  // below are conveniences and each pays for its own request -- an earlier
  // draft's comment claimed one trip served all three while pullRequest() and
  // checkRollup() separately issued the SAME full query, which is two
  // (BC-PR-#802 verification). A caller that needs more than one slice must use
  // this method; a caller that needs exactly one may use the accessor.
  async pullRequestSnapshot(
    repo: RepoRef,
    prNumber: number,
  ): Promise<PullRequestSnapshot> {
    const response: unknown = await this.octokit.graphql(PULL_REQUEST_QUERY, {
      owner: repo.owner,
      name: repo.repo,
      pr: prNumber,
    });
    return normalizePullRequestResponse(response);
  }

  // The PR node, gh-shaped, for parsePullRequest(). `undefined` when the
  // response carried no PR node at all -- which the parser reports as its own
  // error rather than this client guessing at (bankai-core#568).
  //
  // Costs its own round trip; use pullRequestSnapshot() when the rollup or the
  // review requests are wanted too.
  async pullRequest(
    repo: RepoRef,
    prNumber: number,
  ): Promise<GhPullRequestNode | undefined> {
    return (await this.pullRequestSnapshot(repo, prNumber)).pullRequest;
  }

  // `statusCheckRollup.contexts.nodes` of the head commit, raw. `undefined` when
  // the PR has no commits or no rollup at all -- which parseCheckRollup() turns
  // into the EMPTY array, a state that is never green (bankai-core#671).
  //
  // Costs its own round trip; see pullRequestSnapshot().
  async checkRollup(repo: RepoRef, prNumber: number): Promise<unknown> {
    return (await this.pullRequestSnapshot(repo, prNumber)).checkRollup;
  }

  // The PENDING review requests, gh-shaped, for parseReviewRequests().
  //
  // IT HAS TO EXIST (bankai-core#564). A ReviewRequest is the ONLY pre-post
  // footprint a non-check reviewer has: Copilot is not a check run, so until it
  // posts, a pending request is the whole of the evidence that a round is owed,
  // and it is what pendingRounds()' limb (i) turns on. The query has always
  // selected `reviewRequests`, but nothing extracted it -- so the list the gate
  // needs most could not be fetched at all, and the gate would have read `ready`
  // in exactly the window #564 was filed about.
  //
  // READ THE HAZARD BEFORE USING THIS ALONE. `undefined` here is ambiguous in a
  // way the other two slices are not: parseReviewRequests() maps it to `[]`
  // (`.review_requests // []`, the shell's own reading), and an empty request
  // list means NO round is owed via pendingRounds()' limb (i) -- so a response
  // that was blanked entirely reads as "nobody owes anything", which is the
  // permissive direction. The rollup does not have this problem, because its
  // empty array is never green (bankai-core#671). The ONE authority on whether
  // the response was readable at all is `snapshot.pullRequest`, so the
  // composition phase must gate on parsePullRequest() succeeding before it
  // trusts this list -- recorded as a binding obligation in ./parse.ts, since
  // deciding what a blank response MEANS is a verdict and no verdicts live here.
  //
  // Costs its own round trip; see pullRequestSnapshot().
  async reviewRequests(repo: RepoRef, prNumber: number): Promise<unknown> {
    return (await this.pullRequestSnapshot(repo, prNumber)).reviewRequests;
  }

  // REST, not GraphQL, and that is not a preference: reviews are read over REST
  // because `commit_id` is the field CON-16's current-head rule turns on, and
  // gh's GraphQL-backed `pr view --json reviews` does not expose it. Paginated
  // through octokit so a PR with more than 30 rounds is not silently truncated.
  async reviews(repo: RepoRef, prNumber: number): Promise<unknown[]> {
    return await this.octokit.paginate(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      { owner: repo.owner, repo: repo.repo, pull_number: prNumber, per_page: 100 },
    );
  }

  // The issue TIMELINE, paginated, raw.
  //
  // IT HAS TO EXIST, and REST is the only place it does. `reviewRequests`
  // carries no timestamp -- a pending request says WHO owes a round and never
  // WHEN it was asked for -- so the stall bound (`round stalled — requested N
  // min ago and never posted`) has nothing to compute from without the
  // `review_requested` timeline events. The shell reads the same endpoint for
  // the same reason.
  //
  // Raw and unfiltered, deliberately: WHICH events matter, how they are ordered
  // and what an unreadable one means for readiness are all readings, and no
  // verdicts live in this module. ../gates/ready.ts's caller does the selecting.
  async timeline(repo: RepoRef, prNumber: number): Promise<unknown[]> {
    return await this.octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/timeline", {
      owner: repo.owner,
      repo: repo.repo,
      issue_number: prNumber,
      per_page: 100,
    });
  }

  // ONE page of review threads, raw, with its cursor.
  //
  // The walk is the caller's, deliberately: CON-32(d)'s boundary is "zero
  // unresolved", a single first(100) query silently drops threads 101+, and what
  // an unreadable page MEANS for readiness is a verdict this module does not
  // make.
  async reviewThreadsPage(
    repo: RepoRef,
    prNumber: number,
    cursor: string | null = null,
  ): Promise<ReviewThreadPage> {
    const response: unknown = await this.octokit.graphql(REVIEW_THREADS_QUERY, {
      owner: repo.owner,
      name: repo.repo,
      pr: prNumber,
      cursor,
    });
    return normalizeReviewThreadsResponse(response);
  }
}

export function createClient(
  token: string,
  options: { readonly baseUrl?: string } = {},
): GitHubClient {
  return new GitHubClient(token, options);
}
