// src/pr/runner_stall.ts -- whether a check CON-32(a) is still waiting on can
// ever start: the runner-availability diagnosis `nen pr ready --explain` and
// `--json` carry (zheref/nen#224).
//
// THE GAP IT CLOSES. A required check sitting at `queued` is plain not-ready
// under CON-32(a), which is correct -- and indistinguishable from the case that
// matters: NO ONLINE RUNNER carries that check's runner labels, so it will never
// start and waiting is not a strategy. On 2026-09-19/20 NN-PR-#217 parked on
// four consecutive pushes behind `check (Windows, [self-hosted, Windows, X64])`
// while the only Windows runner was offline, and the reason came from a human
// opening the repository's runner page. This module reads the same two facts
// through the verb's own seam: the job's `runs-on` labels (Actions jobs API) and
// the runners that could carry them (`actions/runners`, the repository's, plus
// the organization's where the owner is one).
//
// DIAGNOSIS ONLY, NEVER A VERDICT. Nothing here is read by ../gates/ready.ts and
// nothing here can change a row, the verdict or the exit code: an infrastructure
// stall is still not-ready, with the same exit. Excluding a stalled check stays
// the caller's decision (`--exclude-check`), never this module's.
//
// FAIL CLOSED, IN THE DIAGNOSIS'S OWN DIRECTION. The claim with consequences is
// `infrastructureStall: true` -- it tells a loop to stop waiting and escalate --
// so it is made only when ALL of these hold:
//   * the job read back is THIS check's job at the judged head (Feitan F1);
//   * the runner list is COMPLETE: every page read, distinct runner ids equal
//     to a `total_count` that did not move between pages (N8);
//   * the job has been queued at least STALL_FLOOR_MINUTES (N4): an autoscaled
//     or ephemeral pool registers its runner only once a job is waiting, so a
//     young queue with no runner is the ordinary start of such a pool;
//   * the pull request does not change `.github/workflows/**` (Feitan F2): when
//     it does, the PR's own author chose these `runs-on` labels, and "no runner
//     carries them" is a fact about the PR, not about the infrastructure.
// Anything short of that is `infrastructureStall: false` (too young) or `null`
// (could not tell), with the reason in `detail`.
//
// WHAT IS NOT ENUMERATED, SAID RATHER THAN HIDDEN. Enterprise-level runners and
// GitHub-hosted larger runners appear in neither list; a "no runner" answer
// says so, and labels naming neither `self-hosted` nor a standard hosted image
// are `undetermined` when nothing listed carries them.
//
// ORGANIZATION RUNNERS ARE COUNTED, NEVER NAMED (Feitan F3). A repository's
// readiness output is read by anyone who can read the repository; the names of
// an organization's shared runners are not that audience's to learn. Repository
// runners are the repository's own and are named. ONE EXCEPTION, stated: a
// `started` detail names the job's own `runner_name`, which can be an
// organization runner -- the same name the job's log already shows to anyone
// who can read this repository's Actions runs, so it reaches no new audience.
//
// BOUND TO THE ROLLUP ENTRY (Feitan round-3 R1). A `detailsUrl` is the
// check's own claim; a third-party check can point it at any Actions job. The
// job is read only for an entry whose `appSlug` is `github-actions` and whose
// `databaseId` equals the job id in its URL -- an Actions check run's id IS
// its job's id -- so a stalled job is never attributed to another app's check.

import { digPath } from "../github/graphql.js";
import type { PrRef, PrStateSource } from "../github/pr_state.js";
import { rollupEntryLabel, type RollupEntry } from "../github/types.js";

/** What the diagnosis concluded for one waiting check. */
export type RunnerDetermination =
  /** At least one ONLINE runner carries every label: waiting for capacity, not stalled. */
  | "online"
  /** Runners carry every label and every one of them is offline. */
  | "offline-only"
  /** No listed runner carries every label. */
  | "no-runner"
  /** A standard GitHub-hosted image label no listed runner carries: always available. */
  | "github-hosted"
  /** A runner picked the job up (or it finished) after the rollup was read: no longer queued. */
  | "started"
  /** The job waits on an environment protection rule, not on a runner. */
  | "environment-wait"
  /** Could not tell; `detail` says why and `missingPermission` names a missing grant. */
  | "undetermined";

/** A REPOSITORY runner carrying every label. Organization runners are only counted. */
export interface MatchedRunner {
  readonly name: string;
  readonly status: string;
  readonly busy: boolean | null;
}

/** Organization runners carrying every label, by status -- never by name (Feitan F3). */
export interface OrganizationRunnerCounts {
  readonly online: number;
  readonly offline: number;
}

/** One entry of `meta.runnerAvailability` in `nen pr ready --json`. */
export interface WaitingCheckDiagnosis {
  /** The rollup label of the check CON-32(a) is waiting on. */
  readonly check: string;
  /** The Actions job id (a check run's id IS its job's id); `null` when none was named. */
  readonly jobId: number | null;
  /** The job's `runs-on` labels, as the jobs API answered them; `null` when unread. */
  readonly labels: readonly string[] | null;
  /**
   * The job's `created_at` -- when it entered the queue; `null` when unread, and
   * ALWAYS `null` on `started` and `environment-wait`, where the job is not
   * queued for a runner (round-3 R3).
   */
  readonly queuedSince: string | null;
  /** Whole minutes from `queuedSince` to the evaluation time; `null` whenever `queuedSince` is, or the time is unreadable. */
  readonly queuedMinutes: number | null;
  readonly determination: RunnerDetermination;
  /**
   * `true` only for `offline-only`/`no-runner` once the job has been queued at
   * least STALL_FLOOR_MINUTES and the PR does not change `.github/**`;
   * `false` when a runner can start it, it is younger than the floor, or it is
   * not waiting on a runner. On an `offline-only`/`no-runner` entry `null`
   * means ONLY that the queue age could not be read (N15); every
   * `undetermined` entry carries `null` as well, because nothing was decided.
   */
  readonly infrastructureStall: boolean | null;
  /** REPOSITORY runners carrying every label (only the online ones on `online`). */
  readonly runners: readonly MatchedRunner[];
  /** ORGANIZATION runners carrying every label, as counts; `null` when that pool was not read or does not exist. */
  readonly organizationRunners: OrganizationRunnerCounts | null;
  /**
   * Whether the PR changes anything under `.github/` -- workflows, composite
   * actions, the files that compute `runs-on` -- so its author may have set
   * these labels (Feitan F2, widened by N14). `true`: the PR changes
   * something under `.github/`. `false`: this PR changes NOTHING under
   * `.github/` -- a fact about the PR's files, not a claim about who set the
   * labels (Feitan round-3 R2). Read only when a stall would otherwise be
   * called; `null` when not read or unreadable.
   */
  readonly labelsFromPrHead: boolean | null;
  /** The FIRST refused grant -- `missingPermissions[0]` -- kept for compatibility; `null` when none. */
  readonly missingPermission: string | null;
  /** Every DISTINCT grant a refused read named (N11), in read order; empty when none. */
  readonly missingPermissions: readonly string[];
  /** The one human sentence `--explain` prints. */
  readonly detail: string;
}

/** 100 runners a page; ten pages is a pool no real repository reaches, and a backstop. */
export const MAX_RUNNER_PAGES = 10;
/** Jobs read per evaluation; a check past this is reported as not read, never guessed. */
export const MAX_DIAGNOSED_JOBS = 20;
/**
 * The youngest queue a stall is called on (N4, the coordinator's ruling on
 * zheref/nen#224 round 1). An autoscaled or ephemeral pool registers a runner
 * only after a job is queued, so below this an empty or offline pool is the
 * ordinary first minutes of such a pool, not an outage.
 */
export const STALL_FLOOR_MINUTES = 10;
/** GitHub's own cap on `pulls/{n}/files`: a list this long may be cut off. */
export const PULL_REQUEST_FILES_CAP = 3000;

/** The seam this module reads through: the optional half of ../github/pr_state.ts's source. */
export type RunnerSource = Pick<
  PrStateSource,
  "actionsJob" | "repoRunnersPage" | "orgRunnersPage" | "accountType" | "pullRequestFiles"
>;

/** What the caller knows that the diagnosis checks against. */
export interface DiagnosisContext {
  /** The pull request's number, for the changed-files read (Feitan F2). */
  readonly prNumber: number;
  /** The head the verdict was judged at; a job for another head is not this check's (Feitan F1). */
  readonly headSha: string;
  /** The evaluation time, ISO-8601, for the queue age (N4). */
  readonly now: string;
  /** Running inside GitHub Actions: the grant hint is omitted (Feitan F5). */
  readonly inActions: boolean;
}

// The documented grant each read needs, named when GitHub's own headers do not
// say. Classic token scopes in brackets, because both kinds of token reach this
// verb.
const PERMISSION_JOBS = "actions:read (classic token: repo)";
const PERMISSION_REPO_RUNNERS = "administration:read on the repository (classic token: repo, held by a repository admin)";
const PERMISSION_ORG_RUNNERS = "organization_self_hosted_runners:read (classic token: admin:org)";
const PERMISSION_FILES = "pull_requests:read (classic token: repo)";

// The standard GitHub-hosted image labels, per family (N3): never a pattern
// loose enough to admit a lookalike a self-hosted pool could carry
// (`ubuntu-99`, `windows-latest-arm`, `macos-12-xlarge`).
//
// SOURCE, AS OF 2026-10-11: the "Available Images" table of the
// actions/runner-images README (github.com/actions/runner-images), plus its
// `ubuntu-slim` and `macos-<n>-intel` labels, the Ubuntu 26.04 and the
// Windows `-vs2026` images, and the `xcode-<n>` labels (Nobunaga round-3 R1).
// macOS 13 was RETIRED in November 2025 (N10): a job still pinned to
// `macos-13` never starts, so it must not read "always available". macOS 14 is
// DEPRECATED (actions/runner-images#13518): the next pass over this list drops
// it. Re-check this list against that README when an image is added or
// retired; a label missing here is looked up among self-hosted runners, which
// can only make the reading stricter.
const HOSTED_LABELS: readonly RegExp[] = [
  /^ubuntu-(?:latest|slim|(?:22|24|26)\.04(?:-arm)?)$/i,
  /^windows-(?:latest|2022|2025(?:-vs2026)?|11(?:-vs2026)?-arm)$/i,
  /^xcode-\d+(?:-xlarge)?$/i,
  /^macos-(?:latest(?:-(?:large|xlarge))?|(?:1[4-9]|[2-9]\d)(?:-(?:large|xlarge|intel))?)$/i,
];
const SELF_HOSTED = "self-hosted";
// N14: anything under `.github/` can change what computes `runs-on` -- a
// workflow, a composite action, a matrix file a workflow reads.
const GITHUB_DIR_PREFIX = ".github/";

// What a permissions header may look like before it is repeated (Feitan F4):
// `administration=read`, `repo, admin:org`, `organization_administration=admin;
// repo`. Anything else -- a value a proxy or a compromised hop wrote -- is not
// echoed; the documented grant is named (N12 widens it to `admin` and `;`).
const PERMISSION_HEADER = /^[a-z_:]+(=(read|write|admin))?([,;] ?[a-z_:]+(=(read|write|admin))?)*$/;
const PERMISSION_HEADER_MAX = 200;
// GitHub's own refusal message, appended to a reason (N9), bounded.
const MESSAGE_MAX = 200;

/** `https://github.com/<o>/<r>/actions/runs/<run>/job/<job>`, parsed, or `null`. */
export function actionsJobRef(detailsUrl: string | null): { owner: string; repo: string; jobId: number } | null {
  if (detailsUrl === null) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#].*)?$/.exec(detailsUrl);
  if (match === null) return null;
  const jobId = Number(match[3]);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return null;
  return { owner: match[1] ?? "", repo: match[2] ?? "", jobId };
}

/** Every label a standard GitHub-hosted image label (N3's allowlist). */
export function githubHostedLabels(labels: readonly string[]): boolean {
  return labels.length > 0 && labels.every((label): boolean => HOSTED_LABELS.some((pattern): boolean => pattern.test(label)));
}

/** Whether a runner carries every one of `labels`, as GitHub routes: case-insensitively. */
export function runnerCarries(runnerLabels: readonly string[], labels: readonly string[]): boolean {
  const carried = new Set(runnerLabels.map((label): string => label.toLowerCase()));
  return labels.every((label): boolean => carried.has(label.toLowerCase()));
}

/** A permissions header value, if it is shaped like one (Feitan F4); else `null`. */
export function acceptedHeader(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.length <= PERMISSION_HEADER_MAX && PERMISSION_HEADER.test(trimmed) ? trimmed : null;
}

interface Runner {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly busy: boolean | null;
  readonly labels: readonly string[];
}

interface Refusal {
  readonly reason: string;
  readonly missingPermission: string | null;
  /** A permission refusal, worded as F5's "diagnosis unavailable without <grant>". */
  readonly permission: boolean;
}

type RunnerList = { readonly ok: true; readonly runners: readonly Runner[] } | ({ readonly ok: false } & Refusal);

function httpStatus(error: unknown): number | null {
  const status = digPath(error, "status");
  return typeof status === "number" ? status : null;
}

function githubMessage(error: unknown): string | null {
  const message = digPath(error, "response", "data", "message");
  if (typeof message !== "string" || message.trim() === "") return null;
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_MAX ? `${flat.slice(0, MESSAGE_MAX)}…` : flat;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a failed read. A 403 -- and, on the two RUNNER endpoints only, a 404,
 * which is how GitHub hides an admin endpoint from a token without the grant --
 * is a permission refusal naming the grant: GitHub's own
 * `X-Accepted-GitHub-Permissions` or `X-Accepted-OAuth-Scopes` when well-formed
 * (F4, N9), else the documented one. GitHub's message is appended (N9).
 */
function refusal(
  error: unknown,
  what: string,
  documented: string,
  hiddenBy404: boolean,
  inActions: boolean,
): Refusal {
  const status = httpStatus(error);
  const message = githubMessage(error);
  const said = message === null ? "" : `: ${message}`;
  if (status === 403 || (status === 404 && hiddenBy404)) {
    const permission =
      acceptedHeader(digPath(error, "response", "headers", "x-accepted-github-permissions")) ??
      acceptedHeader(digPath(error, "response", "headers", "x-accepted-oauth-scopes")) ??
      documented;
    // F5: inside GitHub Actions the token's grants are the workflow's
    // `permissions:` block, and the gate does not need this one -- no hint.
    return {
      reason: inActions
        ? `runner diagnosis unavailable (HTTP ${status} trying to ${what}${said}); the gate does not need it`
        : `runner diagnosis unavailable without ${permission} (HTTP ${status} trying to ${what}${said}); the gate does not need it`,
      missingPermission: inActions ? null : permission,
      permission: true,
    };
  }
  if (status === 401) {
    return { reason: `GitHub rejected the token while trying to ${what} (HTTP 401${said})`, missingPermission: null, permission: false };
  }
  // One account of the failure, never two: GitHub's own message when it sent
  // one (octokit's error text usually repeats it), the error's text otherwise.
  return { reason: `could not ${what} (${message ?? errorText(error)})`, missingPermission: null, permission: false };
}

function parseRunner(raw: unknown): Runner | null {
  const id = digPath(raw, "id");
  const name = digPath(raw, "name");
  const status = digPath(raw, "status");
  const busy = digPath(raw, "busy");
  const labels = digPath(raw, "labels");
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (typeof name !== "string" || typeof status !== "string" || !Array.isArray(labels)) return null;
  const names: string[] = [];
  for (const label of labels) {
    const labelName = digPath(label, "name");
    if (typeof labelName !== "string") return null;
    names.push(labelName);
  }
  return { id, name, status, busy: typeof busy === "boolean" ? busy : null, labels: names };
}

/**
 * Walk every page of a runner list, failing CLOSED (N8): the list is complete
 * only when the DISTINCT runner ids read equal the first page's `total_count`,
 * and that count did not move on a later page. A short or empty page, a cap
 * reached, an unreadable count, a moved count, more distinct runners than the
 * count, or a malformed runner is an incomplete list, never a smaller pool.
 */
export async function readRunnerList(
  fetchPage: (page: number) => Promise<unknown>,
  what: string,
  documentedPermission: string,
  inActions = false,
  maxPages: number = MAX_RUNNER_PAGES,
): Promise<RunnerList> {
  const runners = new Map<number, Runner>();
  let total: number | null = null;
  // Page 1's ids, in order, from the FIRST read (Nobunaga round-3 R2).
  let firstPageIds: number[] = [];
  const incomplete = (why: string): RunnerList => ({ ok: false, reason: `could not ${what}: ${why}`, missingPermission: null, permission: false });
  for (let page = 1; page <= maxPages; page += 1) {
    let data: unknown;
    try {
      data = await fetchPage(page);
    } catch (error) {
      return { ok: false, ...refusal(error, what, documentedPermission, true, inActions) };
    }
    const count = digPath(data, "total_count");
    const entries = digPath(data, "runners");
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(entries)) {
      return incomplete(`page ${page} carried no readable total_count and runners`);
    }
    if (total === null) total = count;
    else if (count !== total) {
      return incomplete(`total_count moved from ${total} to ${count} on page ${page}, so the list is incomplete`);
    }
    for (const entry of entries) {
      const runner = parseRunner(entry);
      if (runner === null) return incomplete(`a runner on page ${page} carried no readable id, name, status and labels`);
      if (page === 1) firstPageIds.push(runner.id);
      runners.set(runner.id, runner);
    }
    if (runners.size === total) {
      // N13: the walk is not atomic -- a runner registered or removed while it
      // ran shifts every later page. Re-read page 1: the same total_count and
      // EXACTLY the same ids in the same order (round-3 R2: a remove-one,
      // add-one churn keeps both the count and the first id), or the list is
      // not one consistent snapshot.
      let again: unknown;
      try {
        again = await fetchPage(1);
      } catch (error) {
        return { ok: false, ...refusal(error, what, documentedPermission, true, inActions) };
      }
      const againCount = digPath(again, "total_count");
      const againEntries = digPath(again, "runners");
      const againIds = Array.isArray(againEntries) ? againEntries.map((entry): unknown => digPath(entry, "id")) : null;
      const samePage =
        againIds !== null &&
        againIds.length === firstPageIds.length &&
        againIds.every((id, index): boolean => id === firstPageIds[index]);
      if (againCount !== total || !samePage) {
        return incomplete("page 1 read again did not answer the same total_count and the same runners, so the pool changed during the walk and the list is incomplete");
      }
      return { ok: true, runners: [...runners.values()] };
    }
    if (runners.size > total) {
      return incomplete(`${runners.size} distinct runners were read against a total_count of ${total}, so the list is inconsistent`);
    }
    if (entries.length === 0) {
      return incomplete(`page ${page} was empty after ${runners.size} of ${total} runners, so the list is incomplete`);
    }
  }
  return incomplete(`the list stopped at the ${maxPages}-page cap after ${runners.size} of ${total ?? "?"} runners, so it is incomplete`);
}

function runnerNames(runners: readonly MatchedRunner[]): string {
  return runners.map((runner): string => `${runner.name} (${runner.status}${runner.busy === true ? ", busy" : ""})`).join(", ");
}

function organizationText(counts: OrganizationRunnerCounts): string {
  const total = counts.online + counts.offline;
  const noun = total === 1 ? "organization runner carries" : "organization runners carry";
  if (counts.online === 0) return `${total} ${noun} these labels, all offline`;
  if (counts.offline === 0) return `${total} ${noun} these labels, all online`;
  return `${total} ${noun} these labels, ${counts.online} online`;
}

/** Clock skew between this machine and GitHub tolerated as "just queued" (N15). */
const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Whole minutes from `since` to `now`, or `null` when either is unreadable or
 * `since` is more than two minutes in the future. A `since` up to two minutes
 * ahead is this machine's clock trailing GitHub's, read as 0 (N15).
 */
export function minutesBetween(since: string | null, now: string): number | null {
  if (since === null) return null;
  const start = Date.parse(since);
  const end = Date.parse(now);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (end < start) return start - end <= CLOCK_SKEW_MS ? 0 : null;
  return Math.floor((end - start) / 60_000);
}

function ageText(minutes: number | null): string {
  if (minutes === null) return "for an unreadable time";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

interface JobFacts {
  readonly check: string;
  readonly jobId: number | null;
  readonly labels: readonly string[] | null;
  readonly queuedSince: string | null;
  readonly queuedMinutes: number | null;
}

/** N11: every distinct refused grant, and the first of them under the compatible key. */
function permissionsOf(
  first: string | null,
  all: readonly string[] | undefined,
): { missingPermission: string | null; missingPermissions: readonly string[] } {
  const list = all ?? (first === null ? [] : [first]);
  return { missingPermission: list[0] ?? first, missingPermissions: list };
}

function diagnosis(
  facts: JobFacts,
  determination: RunnerDetermination,
  infrastructureStall: boolean | null,
  detail: string,
  extra: Partial<Pick<WaitingCheckDiagnosis, "runners" | "organizationRunners" | "labelsFromPrHead" | "missingPermission" | "missingPermissions">> = {},
): WaitingCheckDiagnosis {
  return {
    ...facts,
    determination,
    infrastructureStall,
    runners: extra.runners ?? [],
    organizationRunners: extra.organizationRunners ?? null,
    labelsFromPrHead: extra.labelsFromPrHead ?? null,
    ...permissionsOf(extra.missingPermission ?? null, extra.missingPermissions),
    detail,
  };
}

function undetermined(
  facts: JobFacts,
  reason: string,
  extra: Partial<Pick<WaitingCheckDiagnosis, "runners" | "organizationRunners" | "labelsFromPrHead" | "missingPermission" | "missingPermissions">> = {},
  permission = false,
): WaitingCheckDiagnosis {
  return diagnosis(
    facts,
    "undetermined",
    null,
    permission ? reason : `could not determine whether an online runner can start it: ${reason}`,
    extra,
  );
}

const QUEUED_JOB_STATUSES: ReadonlySet<string> = new Set(["queued", "pending", "requested"]);

type FilesRead = { readonly ok: true; readonly workflows: boolean } | ({ readonly ok: false } & Refusal);

/**
 * Diagnose every waiting check, in order. Reads each check's job, then -- once
 * per evaluation, only if a check needs it -- the repository's runners, the
 * organization's for an organization-owned repository, and the PR's changed
 * files.
 */
export async function diagnoseWaitingChecks(
  source: RunnerSource,
  repo: PrRef,
  waiting: readonly RollupEntry[],
  context: DiagnosisContext,
): Promise<WaitingCheckDiagnosis[]> {
  const { inActions } = context;
  let repoList: Promise<RunnerList> | undefined;
  // Methods are CALLED on `source`, never detached (N2): a real GitHubClient
  // reads `this.octokit`, and a detached method loses `this`.
  const readRepoRunners = (): Promise<RunnerList> =>
    (repoList ??=
      source.repoRunnersPage === undefined
        ? Promise.resolve({ ok: false, reason: "this transport cannot list runners", missingPermission: null, permission: false })
        : readRunnerList(
            (page): Promise<unknown> =>
              source.repoRunnersPage === undefined ? Promise.reject(new Error("no runner read")) : source.repoRunnersPage(repo, page),
            `list ${repo.owner}/${repo.repo}'s self-hosted runners`,
            PERMISSION_REPO_RUNNERS,
            inActions,
          ));
  // `null` when the owner is not an organization: there is no pool to read.
  let orgList: Promise<RunnerList | null> | undefined;
  const readOrgRunners = (): Promise<RunnerList | null> =>
    (orgList ??= (async (): Promise<RunnerList | null> => {
      if (source.accountType === undefined) {
        return {
          ok: false,
          reason: `this transport cannot tell whether ${repo.owner} is an organization with its own runner pool`,
          missingPermission: null,
          permission: false,
        };
      }
      let type: string;
      try {
        type = await source.accountType(repo.owner);
      } catch (error) {
        return {
          ok: false,
          reason: `could not tell whether ${repo.owner} is an organization with its own runner pool (${errorText(error)})`,
          missingPermission: null,
          permission: false,
        };
      }
      if (type !== "Organization") return null;
      if (source.orgRunnersPage === undefined) {
        return { ok: false, reason: "this transport cannot read organization runners", missingPermission: null, permission: false };
      }
      return readRunnerList(
        (page): Promise<unknown> =>
          source.orgRunnersPage === undefined ? Promise.reject(new Error("no org runner read")) : source.orgRunnersPage(repo.owner, page),
        `list the ${repo.owner} organization's self-hosted runners`,
        PERMISSION_ORG_RUNNERS,
        inActions,
      );
    })());
  let filesRead: Promise<FilesRead> | undefined;
  const readWorkflowChange = (): Promise<FilesRead> =>
    (filesRead ??= (async (): Promise<FilesRead> => {
      if (source.pullRequestFiles === undefined) {
        return { ok: false, reason: "this transport cannot read the pull request's changed files", missingPermission: null, permission: false };
      }
      let files: unknown[];
      try {
        files = await source.pullRequestFiles(repo, context.prNumber);
      } catch (error) {
        return { ok: false, ...refusal(error, "read the pull request's changed files", PERMISSION_FILES, false, inActions) };
      }
      if (files.length >= PULL_REQUEST_FILES_CAP) {
        return {
          ok: false,
          reason: `the pull request's changed files reached GitHub's ${PULL_REQUEST_FILES_CAP}-file cap, so a workflow change cannot be ruled out`,
          missingPermission: null,
          permission: false,
        };
      }
      let workflows = false;
      for (const file of files) {
        const name = digPath(file, "filename");
        const previous = digPath(file, "previous_filename");
        if (typeof name !== "string") {
          return { ok: false, reason: "a changed file carried no readable filename", missingPermission: null, permission: false };
        }
        if (name.startsWith(GITHUB_DIR_PREFIX) || (typeof previous === "string" && previous.startsWith(GITHUB_DIR_PREFIX))) {
          workflows = true;
        }
      }
      return { ok: true, workflows };
    })());

  const out: WaitingCheckDiagnosis[] = [];
  for (const [index, entry] of waiting.entries()) {
    const check = rollupEntryLabel(entry) ?? "(unnamed)";
    const bare: JobFacts = { check, jobId: null, labels: null, queuedSince: null, queuedMinutes: null };
    if (index >= MAX_DIAGNOSED_JOBS) {
      out.push(undetermined(bare, `not read: only the first ${MAX_DIAGNOSED_JOBS} waiting checks are diagnosed per evaluation`));
      continue;
    }
    if (entry.kind === "status_context") {
      out.push(undetermined(bare, "it is a commit status from outside GitHub Actions, which names no runner labels to match"));
      continue;
    }
    const ref = actionsJobRef(entry.detailsUrl);
    if (ref === null) {
      out.push(undetermined(bare, "its details URL names no GitHub Actions job (a check run from another app has no runner labels to read)"));
      continue;
    }
    const withId: JobFacts = { ...bare, jobId: ref.jobId };
    if (ref.owner.toLowerCase() !== repo.owner.toLowerCase() || ref.repo.toLowerCase() !== repo.repo.toLowerCase()) {
      out.push(undetermined(withId, `its job runs in ${ref.owner}/${ref.repo}, not ${repo.owner}/${repo.repo}, whose runners this read does not list`));
      continue;
    }
    // Round-3 R1: the job must be THIS entry's -- an Actions check run whose id
    // is the job id. Checked before any read, so a third-party check never
    // costs a call and never borrows a stalled job.
    if (entry.appSlug === undefined || entry.appSlug === null || entry.databaseId === undefined || entry.databaseId === null) {
      out.push(undetermined(withId, "the check run's id or app could not be read, so its details URL cannot be bound to an Actions job"));
      continue;
    }
    if (entry.appSlug !== "github-actions" || entry.databaseId !== ref.jobId) {
      out.push(undetermined(withId, "its details URL names a job that is not this check's"));
      continue;
    }
    if (source.actionsJob === undefined) {
      out.push(undetermined(withId, "this transport cannot read Actions jobs"));
      continue;
    }
    let job: unknown;
    try {
      job = await source.actionsJob(repo, ref.jobId);
    } catch (error) {
      // N5/F1: a 404 on the JOBS endpoint is a job that is gone or not
      // visible -- never the hidden-admin-endpoint reading the runner lists get.
      if (httpStatus(error) === 404) {
        out.push(undetermined(withId, `Actions job ${ref.jobId} not found (deleted or not visible)`));
        continue;
      }
      const refused = refusal(error, `read Actions job ${ref.jobId}`, PERMISSION_JOBS, false, inActions);
      out.push(undetermined(withId, refused.reason, { missingPermission: refused.missingPermission }, refused.permission));
      continue;
    }
    // F1: the job read back must be THIS check's job at the judged head.
    const jobHead = digPath(job, "head_sha");
    const checkRunUrl = digPath(job, "check_run_url");
    if (
      typeof jobHead !== "string" ||
      context.headSha === "" ||
      jobHead.toLowerCase() !== context.headSha.toLowerCase() ||
      typeof checkRunUrl !== "string" ||
      !checkRunUrl.endsWith(`/check-runs/${ref.jobId}`)
    ) {
      out.push(undetermined(withId, "its details URL names a job that is not this check's"));
      continue;
    }
    const createdAt = digPath(job, "created_at");
    const queuedSince = typeof createdAt === "string" && createdAt !== "" ? createdAt : null;
    const queuedMinutes = minutesBetween(queuedSince, context.now);
    const rawLabels = digPath(job, "labels");
    const jobStatus = digPath(job, "status");
    const labels =
      Array.isArray(rawLabels) && rawLabels.every((label): boolean => typeof label === "string") ? (rawLabels as string[]) : null;
    const facts: JobFacts = { ...withId, labels, queuedSince, queuedMinutes };
    // Round-3 R3: on `environment-wait` and `started` the job is not queued for
    // a runner, so there is no queue age: `queuedSince`/`queuedMinutes` are null.
    const unqueued: JobFacts = { ...facts, queuedSince: null, queuedMinutes: null };
    if (jobStatus === "waiting") {
      // N7: a deployment environment's protection rule holds it, not a runner.
      out.push(diagnosis(unqueued, "environment-wait", false, "waiting on an environment protection rule, not on a runner"));
      continue;
    }
    if (typeof jobStatus === "string" && !QUEUED_JOB_STATUSES.has(jobStatus)) {
      const runnerName = digPath(job, "runner_name");
      const hasRunner = typeof runnerName === "string" && runnerName !== "";
      const conclusion = digPath(job, "conclusion");
      out.push(
        diagnosis(
          unqueued,
          "started",
          false,
          jobStatus === "completed" && !hasRunner
            ? // N6: finished without ever reaching a runner (cancelled while queued, say).
              `no longer queued: the job is completed (${typeof conclusion === "string" ? conclusion : "no conclusion"}) without a runner`
            : `no longer queued: the job is ${jobStatus}${hasRunner ? ` on runner ${runnerName}` : ""} (a runner picked it up after the rollup was read)`,
        ),
      );
      continue;
    }
    if (labels === null) {
      out.push(undetermined(facts, `Actions job ${ref.jobId} answered no readable runner labels`));
      continue;
    }
    if (labels.length === 0) {
      out.push(undetermined(facts, `Actions job ${ref.jobId} answered an empty label list`));
      continue;
    }
    if (githubHostedLabels(labels)) {
      // N3: a listed runner carrying hosted-looking labels is consulted FIRST;
      // the hosted reading is for labels no listed runner carries.
      const listed = await readRepoRunners();
      const carried = listed.ok && listed.runners.some((runner): boolean => runnerCarries(runner.labels, labels));
      if (!carried) {
        out.push(
          diagnosis(
            facts,
            "github-hosted",
            false,
            "GitHub-hosted, which is always available: the check is slow or queued for capacity, not stalled on a runner",
          ),
        );
        continue;
      }
    }
    out.push(await matchRunners(facts, labels, readRepoRunners, readOrgRunners, readWorkflowChange));
  }
  return out;
}

async function matchRunners(
  facts: JobFacts,
  labels: readonly string[],
  readRepoRunners: () => Promise<RunnerList>,
  readOrgRunners: () => Promise<RunnerList | null>,
  readWorkflowChange: () => Promise<FilesRead>,
): Promise<WaitingCheckDiagnosis> {
  const repoMatched: MatchedRunner[] = [];
  let org: OrganizationRunnerCounts | null = null;
  const failures: Refusal[] = [];
  const repoList = await readRepoRunners();
  if (repoList.ok) {
    for (const runner of repoList.runners) {
      if (runnerCarries(runner.labels, labels)) repoMatched.push({ name: runner.name, status: runner.status, busy: runner.busy });
    }
  } else {
    failures.push(repoList);
  }
  const repoOnline = repoMatched.filter((runner): boolean => runner.status === "online");
  if (repoOnline.length === 0) {
    const orgList = await readOrgRunners();
    if (orgList !== null) {
      if (orgList.ok) {
        const carrying = orgList.runners.filter((runner): boolean => runnerCarries(runner.labels, labels));
        const online = carrying.filter((runner): boolean => runner.status === "online").length;
        org = { online, offline: carrying.length - online };
      } else {
        failures.push(orgList);
      }
    }
  }
  if (repoOnline.length > 0 || (org !== null && org.online > 0)) {
    const named = repoOnline.length > 0 ? runnerNames(repoOnline) : "";
    const counted = org !== null && org.online > 0 ? `${org.online} online organization runner${org.online === 1 ? "" : "s"}` : "";
    return diagnosis(
      facts,
      "online",
      false,
      `an ONLINE runner carries every label (${[named, counted].filter((part): boolean => part !== "").join("; ")}): queued for capacity or its turn, not stalled on infrastructure`,
      { runners: repoOnline, organizationRunners: org },
    );
  }
  const extra = { runners: repoMatched, organizationRunners: org };
  const failure = failures[0];
  if (failure !== undefined) {
    const grants = [
      ...new Set(failures.flatMap((each): string[] => (each.missingPermission === null ? [] : [each.missingPermission]))),
    ];
    return undetermined(
      facts,
      failures.map((each): string => each.reason).join("; "),
      { ...extra, missingPermissions: grants },
      failures.every((each): boolean => each.permission),
    );
  }
  const orgCount = org === null ? 0 : org.online + org.offline;
  let determination: RunnerDetermination;
  let finding: string;
  if (repoMatched.length > 0 || orgCount > 0) {
    determination = "offline-only";
    const parts = [
      ...(repoMatched.length > 0 ? [runnerNames(repoMatched)] : []),
      ...(org !== null && orgCount > 0 ? [organizationText(org)] : []),
    ];
    finding = `every runner carrying these labels is offline (${parts.join("; ")})`;
  } else if (!labels.some((label): boolean => label.toLowerCase() === SELF_HOSTED)) {
    return undetermined(
      facts,
      "no listed runner carries these labels, and they name neither self-hosted nor a standard GitHub-hosted image; a GitHub-hosted larger runner or an enterprise runner, which this read cannot list, may carry them",
      extra,
    );
  } else {
    determination = "no-runner";
    finding =
      "no repository or organization runner carries every one of these labels (enterprise runners are not enumerated, and an autoscaled or ephemeral pool registers runners only on demand)";
  }
  // N4: the floor. A stall is a claim about time as much as about runners.
  if (facts.queuedMinutes === null) {
    return diagnosis(facts, determination, null, `${finding}; the queue age could not be read, so no stall is called`, extra);
  }
  if (facts.queuedMinutes < STALL_FLOOR_MINUTES) {
    return diagnosis(
      facts,
      determination,
      false,
      `${finding}; queued ${ageText(facts.queuedMinutes)}; too young to call a stall (an autoscaled or ephemeral pool may still register a runner)`,
      extra,
    );
  }
  // F2: a PR that edits its own workflows chose these labels itself.
  const files = await readWorkflowChange();
  if (!files.ok) {
    return undetermined(facts, `${finding}, but ${files.reason}, so whether this PR set its own runs-on labels is unknown`, {
      ...extra,
      missingPermission: files.missingPermission,
    });
  }
  if (files.workflows) {
    return undetermined(
      facts,
      `${finding}, but this pull request changes .github/, so its own author may have set these runs-on labels; no infrastructure stall is called`,
      { ...extra, labelsFromPrHead: true },
    );
  }
  return diagnosis(
    facts,
    determination,
    true,
    `INFRASTRUCTURE STALL: ${finding}; queued ${ageText(facts.queuedMinutes)}, so nothing can start it and waiting will not turn it green, unless this PR changes what computes runs-on`,
    { ...extra, labelsFromPrHead: false },
  );
}

/** `--explain`'s block: a header and one line per waiting check. Empty when none was diagnosed. */
export function renderRunnerAvailability(diagnoses: readonly WaitingCheckDiagnosis[] | undefined): string[] {
  if (diagnoses === undefined || diagnoses.length === 0) return [];
  const lines = ["  waiting checks and their runners (zheref/nen#224; a diagnosis only, the verdict is unchanged):"];
  for (const each of diagnoses) {
    const labels = each.labels === null ? "" : ` [runs-on: ${each.labels.join(", ")}]`;
    lines.push(`  - ${each.check}${labels}: ${each.detail}`);
    if (each.missingPermissions.length > 1) {
      lines.push(`      missing permissions: ${each.missingPermissions.join("; ")}`);
    } else if (each.missingPermission !== null) {
      lines.push(`      missing permission: ${each.missingPermission}`);
    }
  }
  return lines;
}
