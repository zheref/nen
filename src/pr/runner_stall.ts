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
// "stalled" -- it tells a loop to stop waiting and escalate -- so it is made
// only from a COMPLETE runner list: an unreadable page, a short page, a
// pagination cap reached, a malformed runner entry or a 403 all make the answer
// `undetermined`, with the reason and (for a 403/404) the permission GitHub
// says is missing. An online match is the only claim a failed second list
// cannot falsify, so it is still reported when the OTHER list failed.
//
// WHAT IS NOT ENUMERATED, SAID RATHER THAN HIDDEN. Enterprise-level runners and
// GitHub-hosted larger runners appear in neither list; a "no runner" answer
// says so, and labels naming neither `self-hosted` nor a standard hosted image
// are `undetermined` when nothing listed carries them.

import { digPath } from "../github/graphql.js";
import type { PrRef, PrStateSource } from "../github/pr_state.js";
import { rollupEntryLabel, type RollupEntry } from "../github/types.js";

/** What the diagnosis concluded for one waiting check. */
export type RunnerDetermination =
  /** At least one ONLINE runner carries every label: waiting for capacity, not stalled. */
  | "online"
  /** Runners carry every label and every one of them is offline: an infrastructure stall. */
  | "offline-only"
  /** No listed runner carries every label: an infrastructure stall. */
  | "no-runner"
  /** A standard GitHub-hosted image label: always available, so slow rather than stalled. */
  | "github-hosted"
  /** A runner picked the job up after the rollup was read: no longer queued. */
  | "started"
  /** Could not tell; `detail` says why and `missingPermission` names a missing grant. */
  | "undetermined";

export interface MatchedRunner {
  readonly name: string;
  readonly status: string;
  readonly busy: boolean | null;
  readonly scope: "repository" | "organization";
}

/** One entry of `meta.runnerAvailability` in `nen pr ready --json`. */
export interface WaitingCheckDiagnosis {
  /** The rollup label of the check CON-32(a) is waiting on. */
  readonly check: string;
  /** The Actions job id (a check run's id IS its job's id); `null` when none was named. */
  readonly jobId: number | null;
  /** The job's `runs-on` labels, as the jobs API answered them; `null` when unread. */
  readonly labels: readonly string[] | null;
  readonly determination: RunnerDetermination;
  /** `true` for `offline-only`/`no-runner`, `false` for `online`/`github-hosted`/`started`, `null` when undetermined. */
  readonly infrastructureStall: boolean | null;
  /** Every listed runner carrying every label, online or not. */
  readonly runners: readonly MatchedRunner[];
  /** The permission GitHub (or the endpoint's documentation) says the token lacks; `null` otherwise. */
  readonly missingPermission: string | null;
  /** The one human sentence `--explain` prints. */
  readonly detail: string;
}

/** 100 runners a page; ten pages is a pool no real repository reaches, and a backstop. */
export const MAX_RUNNER_PAGES = 10;
/** Jobs read per evaluation; a check past this is reported as not read, never guessed. */
export const MAX_DIAGNOSED_JOBS = 20;

/** The seam this module reads through: the optional half of ../github/pr_state.ts's source. */
export type RunnerSource = Pick<PrStateSource, "actionsJob" | "repoRunnersPage" | "orgRunnersPage" | "accountType">;

// The documented grant each read needs, named when GitHub's own
// `X-Accepted-GitHub-Permissions` header does not say. Classic token scopes in
// brackets, because both kinds of token reach this verb.
const PERMISSION_JOBS = "actions:read (classic token: repo)";
const PERMISSION_REPO_RUNNERS = "administration:read on the repository (classic token: repo, held by a repository admin)";
const PERMISSION_ORG_RUNNERS = "organization_self_hosted_runners:read (classic token: admin:org)";

// `runs-on` labels GitHub serves from its own fleet: `ubuntu-latest`,
// `windows-2025`, `macos-15-xlarge`, `ubuntu-24.04-arm`. Matched whole and
// case-insensitively; anything else is looked up among self-hosted runners.
const HOSTED_LABEL = /^(?:ubuntu|windows|macos)-(?:latest|\d+(?:\.\d+)*)(?:-(?:arm|arm64|large|xlarge))?$/i;
const SELF_HOSTED = "self-hosted";

/** `https://github.com/<o>/<r>/actions/runs/<run>/job/<job>`, parsed, or `null`. */
export function actionsJobRef(detailsUrl: string | null): { owner: string; repo: string; jobId: number } | null {
  if (detailsUrl === null) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#].*)?$/.exec(detailsUrl);
  if (match === null) return null;
  const jobId = Number(match[3]);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) return null;
  return { owner: match[1] ?? "", repo: match[2] ?? "", jobId };
}

/** Every label a standard GitHub-hosted image label, and none `self-hosted`. */
export function githubHostedLabels(labels: readonly string[]): boolean {
  return labels.length > 0 && labels.every((label): boolean => HOSTED_LABEL.test(label));
}

interface Runner {
  readonly name: string;
  readonly status: string;
  readonly busy: boolean | null;
  readonly labels: readonly string[];
}

type RunnerList =
  | { readonly ok: true; readonly runners: readonly Runner[] }
  | { readonly ok: false; readonly reason: string; readonly missingPermission: string | null };

/** Whether `runner` carries every one of `labels`, as GitHub routes: case-insensitively. */
export function runnerCarries(runnerLabels: readonly string[], labels: readonly string[]): boolean {
  const carried = new Set(runnerLabels.map((label): string => label.toLowerCase()));
  return labels.every((label): boolean => carried.has(label.toLowerCase()));
}

function httpStatus(error: unknown): number | null {
  const status = digPath(error, "status");
  return typeof status === "number" ? status : null;
}

function acceptedPermissions(error: unknown): string | null {
  const header = digPath(error, "response", "headers", "x-accepted-github-permissions");
  return typeof header === "string" && header.trim() !== "" ? header.trim() : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a failed read. A 403, and a 404 (how GitHub hides an admin endpoint
 * from a token without the grant), name the permission -- GitHub's own header
 * when it sent one, else the documented one. Anything else is reported as the
 * error it was, with no permission claimed.
 */
function refusal(error: unknown, what: string, documented: string): { reason: string; missingPermission: string | null } {
  const status = httpStatus(error);
  if (status === 403 || status === 404) {
    const permission = acceptedPermissions(error) ?? documented;
    return {
      reason: `the token may not ${what} (HTTP ${status}${status === 404 ? ", which is how GitHub hides this endpoint from a token without the grant" : ""}): it lacks ${permission}`,
      missingPermission: permission,
    };
  }
  if (status === 401) {
    return { reason: `GitHub rejected the token while trying to ${what} (HTTP 401)`, missingPermission: null };
  }
  return { reason: `could not ${what} (${errorText(error)})`, missingPermission: null };
}

function parseRunner(raw: unknown): Runner | null {
  const name = digPath(raw, "name");
  const status = digPath(raw, "status");
  const busy = digPath(raw, "busy");
  const labels = digPath(raw, "labels");
  if (typeof name !== "string" || typeof status !== "string" || !Array.isArray(labels)) return null;
  const names: string[] = [];
  for (const label of labels) {
    const labelName = digPath(label, "name");
    if (typeof labelName !== "string") return null;
    names.push(labelName);
  }
  return { name, status, busy: typeof busy === "boolean" ? busy : null, labels: names };
}

/**
 * Walk every page of a runner list, failing CLOSED: the list is complete only
 * when the runners read reach the first page's `total_count`. A short or empty
 * page, a cap reached, an unreadable count or a malformed runner is an
 * incomplete list, never a smaller pool.
 */
export async function readRunnerList(
  fetchPage: (page: number) => Promise<unknown>,
  what: string,
  documentedPermission: string,
  maxPages: number = MAX_RUNNER_PAGES,
): Promise<RunnerList> {
  const runners: Runner[] = [];
  let total: number | null = null;
  for (let page = 1; page <= maxPages; page += 1) {
    let data: unknown;
    try {
      data = await fetchPage(page);
    } catch (error) {
      const refused = refusal(error, what, documentedPermission);
      return { ok: false, reason: refused.reason, missingPermission: refused.missingPermission };
    }
    const count = digPath(data, "total_count");
    const entries = digPath(data, "runners");
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || !Array.isArray(entries)) {
      return { ok: false, reason: `could not ${what}: page ${page} carried no readable total_count and runners`, missingPermission: null };
    }
    total ??= count;
    for (const entry of entries) {
      const runner = parseRunner(entry);
      if (runner === null) {
        return { ok: false, reason: `could not ${what}: a runner on page ${page} carried no readable name, status and labels`, missingPermission: null };
      }
      runners.push(runner);
    }
    if (runners.length >= total) return { ok: true, runners };
    if (entries.length === 0) {
      return {
        ok: false,
        reason: `could not ${what}: page ${page} was empty after ${runners.length} of ${total} runners, so the list is incomplete`,
        missingPermission: null,
      };
    }
  }
  return {
    ok: false,
    reason: `could not ${what}: the list stopped at the ${maxPages}-page cap after ${runners.length} of ${total ?? "?"} runners, so it is incomplete`,
    missingPermission: null,
  };
}

function runnerNames(runners: readonly MatchedRunner[]): string {
  return runners
    .map((runner): string => `${runner.name} (${runner.status}${runner.busy === true ? ", busy" : ""}${runner.scope === "organization" ? ", organization" : ""})`)
    .join(", ");
}

function undetermined(
  check: string,
  jobId: number | null,
  labels: readonly string[] | null,
  reason: string,
  missingPermission: string | null = null,
  runners: readonly MatchedRunner[] = [],
): WaitingCheckDiagnosis {
  return {
    check,
    jobId,
    labels,
    determination: "undetermined",
    infrastructureStall: null,
    runners,
    missingPermission,
    detail: `could not determine whether an online runner can start it: ${reason}`,
  };
}

const QUEUED_JOB_STATUSES: ReadonlySet<string> = new Set(["queued", "waiting", "pending", "requested"]);

/**
 * Diagnose every waiting check, in order. Reads each check's job, then -- once
 * per evaluation, only if a check needs it -- the repository's runners and, for
 * an organization-owned repository, the organization's.
 */
export async function diagnoseWaitingChecks(
  source: RunnerSource,
  repo: PrRef,
  waiting: readonly RollupEntry[],
): Promise<WaitingCheckDiagnosis[]> {
  let repoList: Promise<RunnerList> | undefined;
  const readRepoRunners = (): Promise<RunnerList> =>
    (repoList ??=
      source.repoRunnersPage === undefined
        ? Promise.resolve({ ok: false, reason: "this transport cannot list runners", missingPermission: null })
        : readRunnerList(
            (page): Promise<unknown> => (source.repoRunnersPage as NonNullable<RunnerSource["repoRunnersPage"]>)(repo, page),
            `list ${repo.owner}/${repo.repo}'s self-hosted runners`,
            PERMISSION_REPO_RUNNERS,
          ));
  // `null` when the owner is not an organization: there is no pool to read.
  let orgList: Promise<RunnerList | null> | undefined;
  const readOrgRunners = (): Promise<RunnerList | null> =>
    (orgList ??= (async (): Promise<RunnerList | null> => {
      if (source.accountType === undefined) {
        return { ok: false, reason: `this transport cannot tell whether ${repo.owner} is an organization with its own runner pool`, missingPermission: null };
      }
      let type: string;
      try {
        type = await source.accountType(repo.owner);
      } catch (error) {
        return {
          ok: false,
          reason: `could not tell whether ${repo.owner} is an organization with its own runner pool (${errorText(error)})`,
          missingPermission: null,
        };
      }
      if (type !== "Organization") return null;
      const orgPage = source.orgRunnersPage;
      if (orgPage === undefined) {
        return { ok: false, reason: "this transport cannot read organization runners", missingPermission: null };
      }
      return readRunnerList(
        (page): Promise<unknown> => orgPage(repo.owner, page),
        `list the ${repo.owner} organization's self-hosted runners`,
        PERMISSION_ORG_RUNNERS,
      );
    })());

  const out: WaitingCheckDiagnosis[] = [];
  for (const [index, entry] of waiting.entries()) {
    const check = rollupEntryLabel(entry) ?? "(unnamed)";
    if (index >= MAX_DIAGNOSED_JOBS) {
      out.push(undetermined(check, null, null, `not read: only the first ${MAX_DIAGNOSED_JOBS} waiting checks are diagnosed per evaluation`));
      continue;
    }
    if (entry.kind === "status_context") {
      out.push(undetermined(check, null, null, "it is a commit status from outside GitHub Actions, which names no runner labels to match"));
      continue;
    }
    const ref = actionsJobRef(entry.detailsUrl);
    if (ref === null) {
      out.push(undetermined(check, null, null, "its details URL names no GitHub Actions job (a check run from another app has no runner labels to read)"));
      continue;
    }
    if (ref.owner.toLowerCase() !== repo.owner.toLowerCase() || ref.repo.toLowerCase() !== repo.repo.toLowerCase()) {
      out.push(undetermined(check, ref.jobId, null, `its job runs in ${ref.owner}/${ref.repo}, not ${repo.owner}/${repo.repo}, whose runners this read does not list`));
      continue;
    }
    if (source.actionsJob === undefined) {
      out.push(undetermined(check, ref.jobId, null, "this transport cannot read Actions jobs"));
      continue;
    }
    let job: unknown;
    try {
      job = await source.actionsJob(repo, ref.jobId);
    } catch (error) {
      const refused = refusal(error, `read Actions job ${ref.jobId}`, PERMISSION_JOBS);
      out.push(undetermined(check, ref.jobId, null, refused.reason, refused.missingPermission));
      continue;
    }
    const rawLabels = digPath(job, "labels");
    const jobStatus = digPath(job, "status");
    if (!Array.isArray(rawLabels) || !rawLabels.every((label): boolean => typeof label === "string")) {
      out.push(undetermined(check, ref.jobId, null, `Actions job ${ref.jobId} answered no readable runner labels`));
      continue;
    }
    const labels = rawLabels as string[];
    if (typeof jobStatus === "string" && !QUEUED_JOB_STATUSES.has(jobStatus)) {
      const runnerName = digPath(job, "runner_name");
      out.push({
        check,
        jobId: ref.jobId,
        labels,
        determination: "started",
        infrastructureStall: false,
        runners: [],
        missingPermission: null,
        detail: `no longer queued: the job is ${jobStatus}${typeof runnerName === "string" && runnerName !== "" ? ` on runner ${runnerName}` : ""} (a runner picked it up after the rollup was read)`,
      });
      continue;
    }
    if (labels.length === 0) {
      out.push(undetermined(check, ref.jobId, labels, `Actions job ${ref.jobId} answered an empty label list`));
      continue;
    }
    if (githubHostedLabels(labels)) {
      out.push({
        check,
        jobId: ref.jobId,
        labels,
        determination: "github-hosted",
        infrastructureStall: false,
        runners: [],
        missingPermission: null,
        detail: "GitHub-hosted, which is always available: the check is slow or queued for capacity, not stalled on a runner",
      });
      continue;
    }
    out.push(await matchRunners(check, ref.jobId, labels, readRepoRunners, readOrgRunners));
  }
  return out;
}

async function matchRunners(
  check: string,
  jobId: number,
  labels: readonly string[],
  readRepoRunners: () => Promise<RunnerList>,
  readOrgRunners: () => Promise<RunnerList | null>,
): Promise<WaitingCheckDiagnosis> {
  const matched: MatchedRunner[] = [];
  const failures: { reason: string; missingPermission: string | null }[] = [];
  const collect = (list: RunnerList, scope: MatchedRunner["scope"]): void => {
    if (!list.ok) {
      failures.push({ reason: list.reason, missingPermission: list.missingPermission });
      return;
    }
    for (const runner of list.runners) {
      if (runnerCarries(runner.labels, labels)) {
        matched.push({ name: runner.name, status: runner.status, busy: runner.busy, scope });
      }
    }
  };
  collect(await readRepoRunners(), "repository");
  const online = (): MatchedRunner[] => matched.filter((runner): boolean => runner.status === "online");
  if (online().length === 0) {
    const org = await readOrgRunners();
    if (org !== null) collect(org, "organization");
  }
  const onlineRunners = online();
  if (onlineRunners.length > 0) {
    return {
      check,
      jobId,
      labels,
      determination: "online",
      infrastructureStall: false,
      runners: matched,
      missingPermission: null,
      detail: `an ONLINE runner carries every label (${runnerNames(onlineRunners)}): queued for capacity or its turn, not stalled on infrastructure`,
    };
  }
  const failure = failures[0];
  if (failure !== undefined) {
    return undetermined(
      check,
      jobId,
      labels,
      failures.map((each): string => each.reason).join("; "),
      failure.missingPermission ?? failures.find((each): boolean => each.missingPermission !== null)?.missingPermission ?? null,
      matched,
    );
  }
  if (matched.length > 0) {
    return {
      check,
      jobId,
      labels,
      determination: "offline-only",
      infrastructureStall: true,
      runners: matched,
      missingPermission: null,
      detail: `INFRASTRUCTURE STALL: every runner carrying these labels is offline (${runnerNames(matched)}), so nothing can start it and waiting will not turn it green`,
    };
  }
  if (!labels.some((label): boolean => label.toLowerCase() === SELF_HOSTED)) {
    return undetermined(
      check,
      jobId,
      labels,
      "no listed runner carries these labels, and they name neither self-hosted nor a standard GitHub-hosted image; a GitHub-hosted larger runner or an enterprise runner, which this read cannot list, may carry them",
    );
  }
  return {
    check,
    jobId,
    labels,
    determination: "no-runner",
    infrastructureStall: true,
    runners: [],
    missingPermission: null,
    detail: "INFRASTRUCTURE STALL: no repository or organization runner carries every one of these labels, so nothing can start it and waiting will not turn it green (enterprise runners are not enumerated)",
  };
}

/** `--explain`'s block: a header and one line per waiting check. Empty when none was diagnosed. */
export function renderRunnerAvailability(diagnoses: readonly WaitingCheckDiagnosis[] | undefined): string[] {
  if (diagnoses === undefined || diagnoses.length === 0) return [];
  const lines = ["  waiting checks and their runners (zheref/nen#224; a diagnosis only, the verdict is unchanged):"];
  for (const diagnosis of diagnoses) {
    const labels = diagnosis.labels === null ? "" : ` [runs-on: ${diagnosis.labels.join(", ")}]`;
    lines.push(`  - ${diagnosis.check}${labels}: ${diagnosis.detail}`);
    if (diagnosis.missingPermission !== null) {
      lines.push(`      missing permission: ${diagnosis.missingPermission}`);
    }
  }
  return lines;
}
