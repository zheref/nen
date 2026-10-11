// Tests for ./runner_stall.ts: the runner-availability diagnosis `nen pr ready`
// attaches for a check still waiting on a runner (zheref/nen#224). Every read
// goes through a SCRIPTED source -- the optional half of PrStateSource -- so no
// test here reaches GitHub. The verdict-is-unchanged half lives in
// ../verbs/pr_ready.runners.test.ts, where the whole verb runs.

import { describe, expect, it } from "vitest";
import {
  actionsJobRef,
  diagnoseWaitingChecks,
  githubHostedLabels,
  MAX_DIAGNOSED_JOBS,
  readRunnerList,
  renderRunnerAvailability,
  runnerCarries,
  type RunnerSource,
} from "./runner_stall.js";
import type { CheckRun, RollupEntry, StatusContext } from "../github/types.js";

const REPO = { owner: "zheref", repo: "nen" };
const WINDOWS = ["self-hosted", "Windows", "X64"];
const MACOS = ["self-hosted", "macOS", "ARM64"];

function queued(name: string, jobId: number | null, repo = "zheref/nen"): CheckRun {
  return {
    kind: "check_run",
    name,
    status: "QUEUED",
    conclusion: null,
    startedAt: null,
    completedAt: null,
    detailsUrl: jobId === null ? null : `https://github.com/${repo}/actions/runs/38164140114/job/${jobId}`,
  };
}

function runner(name: string, status: "online" | "offline", labels: readonly string[], busy = false): unknown {
  return { id: 1, name, status, busy, labels: labels.map((label) => ({ id: 1, name: label, type: "read-only" })) };
}

/** Live shape of zheref/nen on 2026-10-11 with the Windows pool offline. */
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
  };
  return { source, calls };
}

function job(labels: readonly string[], status = "queued", runnerName: string | null = null): unknown {
  return { id: 1, status, labels, runner_name: runnerName };
}

function forbidden(status: number, accepted?: string): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { headers: accepted === undefined ? {} : { "x-accepted-github-permissions": accepted } },
  });
}

describe("actionsJobRef / githubHostedLabels / runnerCarries", () => {
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

  it("knows the standard hosted image labels and nothing custom", () => {
    expect(githubHostedLabels(["ubuntu-latest"])).toBe(true);
    expect(githubHostedLabels(["windows-2025"])).toBe(true);
    expect(githubHostedLabels(["macos-15-xlarge"])).toBe(true);
    expect(githubHostedLabels(["ubuntu-24.04-arm"])).toBe(true);
    expect(githubHostedLabels(["self-hosted", "Windows", "X64"])).toBe(false);
    expect(githubHostedLabels(["ubuntu-latest", "gpu"])).toBe(false);
    expect(githubHostedLabels([])).toBe(false);
  });

  it("matches every label, case-insensitively, as GitHub routes", () => {
    expect(runnerCarries(["self-hosted", "windows", "x64", "extra"], WINDOWS)).toBe(true);
    expect(runnerCarries(MACOS, WINDOWS)).toBe(false);
  });
});

describe("diagnoseWaitingChecks -- the determinations", () => {
  it("OFFLINE-ONLY: runners carry the labels and every one is offline -- an infrastructure stall", async () => {
    const { source } = scripted({
      jobs: { 7: job(WINDOWS) },
      repoPages: [{ total_count: 6, runners: MAC_ONLINE_WINDOWS_OFFLINE }],
    });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("check (Windows)", 7)]);
    expect(diagnosis).toMatchObject({
      check: "check (Windows)",
      jobId: 7,
      labels: WINDOWS,
      determination: "offline-only",
      infrastructureStall: true,
      missingPermission: null,
    });
    expect(diagnosis?.runners.map((each) => each.name)).toEqual(["NZ-NNR1", "NZ-NNR2", "NZ-NNR3"]);
    expect(diagnosis?.detail).toMatch(/^INFRASTRUCTURE STALL: every runner carrying these labels is offline \(NZ-NNR1 \(offline\)/);
  });

  it("ONLINE: an online runner carries every label -- slow, not stalled, and busy is named", async () => {
    const { source, calls } = scripted({
      jobs: { 8: job(MACOS) },
      repoPages: [{ total_count: 6, runners: MAC_ONLINE_WINDOWS_OFFLINE }],
    });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("check (macOS)", 8)]);
    expect(diagnosis).toMatchObject({ determination: "online", infrastructureStall: false });
    expect(diagnosis?.detail).toContain("RJ2-NNR2 (online, busy)");
    expect(diagnosis?.detail).toContain("not stalled on infrastructure");
    // An online repository match never asks for the organization's pool.
    expect(calls).toEqual(["job 8", "repo runners 1"]);
  });

  it("NO-RUNNER: nothing listed carries the labels -- an infrastructure stall, enterprise runners named as unlisted", async () => {
    const { source } = scripted({
      jobs: { 9: job(["self-hosted", "Linux", "GPU"]) },
      repoPages: [{ total_count: 6, runners: MAC_ONLINE_WINDOWS_OFFLINE }],
    });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("gpu", 9)]);
    expect(diagnosis).toMatchObject({ determination: "no-runner", infrastructureStall: true, runners: [] });
    expect(diagnosis?.detail).toContain("enterprise runners are not enumerated");
  });

  it("GITHUB-HOSTED: always available, so the runner list is never read", async () => {
    const { source, calls } = scripted({ jobs: { 10: job(["ubuntu-latest"]) } });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("lint", 10)]);
    expect(diagnosis).toMatchObject({ determination: "github-hosted", infrastructureStall: false });
    expect(calls).toEqual(["job 10"]);
  });

  it("STARTED: a job a runner picked up after the rollup was read is not queued any more", async () => {
    const { source, calls } = scripted({ jobs: { 11: job(WINDOWS, "in_progress", "NZ-NNR2") } });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("check (Windows)", 11)]);
    expect(diagnosis).toMatchObject({ determination: "started", infrastructureStall: false });
    expect(diagnosis?.detail).toContain("in_progress on runner NZ-NNR2");
    expect(calls).toEqual(["job 11"]);
  });

  it("custom labels with no self-hosted and no listed carrier are UNDETERMINED (a hosted larger runner may carry them)", async () => {
    const { source } = scripted({ jobs: { 12: job(["big-linux-box"]) }, repoPages: [{ total_count: 0, runners: [] }] });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("big", 12)]);
    expect(diagnosis).toMatchObject({ determination: "undetermined", infrastructureStall: null });
    expect(diagnosis?.detail).toContain("larger runner");
  });

  it("reads the runner list ONCE for every check that needs it", async () => {
    const { source, calls } = scripted({
      jobs: { 7: job(WINDOWS), 8: job(MACOS) },
      repoPages: [{ total_count: 6, runners: MAC_ONLINE_WINDOWS_OFFLINE }],
    });
    const out = await diagnoseWaitingChecks(source, REPO, [queued("w", 7), queued("m", 8)]);
    expect(out.map((each) => each.determination)).toEqual(["offline-only", "online"]);
    expect(calls.filter((call) => call.startsWith("repo runners"))).toEqual(["repo runners 1"]);
  });
});

describe("diagnoseWaitingChecks -- organization runners", () => {
  it("reads the organization's pool for an organization-owned repository, and a match there is online", async () => {
    const { source, calls } = scripted({
      jobs: { 7: job(WINDOWS) },
      repoPages: [{ total_count: 0, runners: [] }],
      accountType: "Organization",
      orgPages: [{ total_count: 1, runners: [runner("ORG-WIN", "online", WINDOWS)] }],
    });
    const [diagnosis] = await diagnoseWaitingChecks(source, { owner: "acme", repo: "app" }, [
      queued("w", 7, "acme/app"),
    ]);
    expect(diagnosis).toMatchObject({ determination: "online" });
    expect(diagnosis?.runners).toEqual([{ name: "ORG-WIN", status: "online", busy: false, scope: "organization" }]);
    expect(calls).toEqual(["job 7", "repo runners 1", "account acme", "org runners acme 1"]);
  });

  it("an organization owner on a transport that cannot read its pool is undetermined, said so", async () => {
    const { source } = scripted({ jobs: { 7: job(WINDOWS) }, repoPages: [{ total_count: 0, runners: [] }], accountType: "Organization" });
    const [diagnosis] = await diagnoseWaitingChecks({ ...source, orgRunnersPage: undefined }, { owner: "acme", repo: "app" }, [
      queued("w", 7, "acme/app"),
    ]);
    expect(diagnosis?.determination).toBe("undetermined");
    expect(diagnosis?.detail).toContain("this transport cannot read organization runners");
  });

  it("never reads an organization pool for a user-owned repository", async () => {
    const { source, calls } = scripted({ jobs: { 7: job(WINDOWS) }, repoPages: [{ total_count: 0, runners: [] }] });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
    expect(diagnosis?.determination).toBe("no-runner");
    expect(calls).not.toContain("org runners zheref 1");
  });

  it("an org pool the token may not read leaves an offline-only repository match UNDETERMINED, naming admin:org", async () => {
    const { source } = scripted({
      jobs: { 7: job(WINDOWS) },
      repoPages: [{ total_count: 1, runners: [runner("NZ-NNR1", "offline", WINDOWS)] }],
      accountType: "Organization",
      orgError: forbidden(403),
    });
    const [diagnosis] = await diagnoseWaitingChecks(source, { owner: "acme", repo: "app" }, [
      queued("w", 7, "acme/app"),
    ]);
    expect(diagnosis).toMatchObject({ determination: "undetermined", infrastructureStall: null });
    expect(diagnosis?.missingPermission).toContain("admin:org");
    expect(diagnosis?.runners.map((each) => each.name)).toEqual(["NZ-NNR1"]);
  });

  it("an account type that cannot be read is undetermined, never 'no organization pool'", async () => {
    const { source } = scripted({
      jobs: { 7: job(WINDOWS) },
      repoPages: [{ total_count: 0, runners: [] }],
      accountError: new Error("socket hang up"),
    });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
    expect(diagnosis?.determination).toBe("undetermined");
    expect(diagnosis?.detail).toContain("socket hang up");
  });
});

describe("diagnoseWaitingChecks -- unreadable runners say so, and name the permission", () => {
  it("a 403 on the runners list names GitHub's own accepted-permissions header", async () => {
    const { source } = scripted({ jobs: { 7: job(WINDOWS) }, repoError: forbidden(403, "administration=read") });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
    expect(diagnosis).toMatchObject({
      determination: "undetermined",
      infrastructureStall: null,
      missingPermission: "administration=read",
    });
    expect(diagnosis?.detail).toContain("the token may not list zheref/nen's self-hosted runners (HTTP 403): it lacks administration=read");
  });

  it("a 403 with no header names the documented grant, classic scope included", async () => {
    const { source } = scripted({ jobs: { 7: job(WINDOWS) }, repoError: forbidden(403) });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
    expect(diagnosis?.missingPermission).toBe(
      "administration:read on the repository (classic token: repo, held by a repository admin)",
    );
  });

  it("a 404 is read as the hidden-endpoint refusal it is, never as an empty pool", async () => {
    const { source } = scripted({ jobs: { 7: job(WINDOWS) }, repoError: forbidden(404) });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
    expect(diagnosis?.determination).toBe("undetermined");
    expect(diagnosis?.detail).toContain("HTTP 404, which is how GitHub hides this endpoint");
  });

  it("a job the token may not read names actions:read", async () => {
    const { source, calls } = scripted({ jobError: forbidden(403) });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
    expect(diagnosis).toMatchObject({ determination: "undetermined", labels: null });
    expect(diagnosis?.missingPermission).toContain("actions:read");
    expect(calls).toEqual(["job 7"]);
  });

  it("a network failure is reported as itself, with no permission claimed", async () => {
    const { source } = scripted({ jobs: { 7: job(WINDOWS) }, repoError: new Error("ECONNRESET") });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
    expect(diagnosis).toMatchObject({ determination: "undetermined", missingPermission: null });
    expect(diagnosis?.detail).toContain("ECONNRESET");
  });

  it("a source without the reads says the transport cannot, never omits the check", async () => {
    const out = await diagnoseWaitingChecks({}, REPO, [queued("w", 7)]);
    expect(out).toHaveLength(1);
    expect(out[0]?.detail).toContain("this transport cannot read Actions jobs");
  });
});

describe("readRunnerList -- pagination, and truncation failing closed", () => {
  const fetchFrom =
    (pages: readonly unknown[]) =>
    async (page: number): Promise<unknown> =>
      pages[page - 1] ?? { total_count: 0, runners: [] };

  it("walks every page until total_count is reached", async () => {
    const pages = [
      { total_count: 3, runners: [runner("a", "offline", WINDOWS), runner("b", "offline", WINDOWS)] },
      { total_count: 3, runners: [runner("c", "online", WINDOWS)] },
    ];
    const list = await readRunnerList(fetchFrom(pages), "list runners", "perm");
    expect(list.ok && list.runners.map((each) => each.name)).toEqual(["a", "b", "c"]);
  });

  it("the online match on page 2 is found -- page 1 alone would have said offline-only", async () => {
    const { source } = scripted({
      jobs: { 7: job(WINDOWS) },
      repoPages: [
        { total_count: 2, runners: [runner("NZ-NNR1", "offline", WINDOWS)] },
        { total_count: 2, runners: [runner("NZ-NNR2", "online", WINDOWS)] },
      ],
    });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
    expect(diagnosis?.determination).toBe("online");
  });

  it("an empty page short of total_count is an INCOMPLETE list, never a smaller pool", async () => {
    const list = await readRunnerList(
      fetchFrom([{ total_count: 5, runners: [runner("a", "offline", WINDOWS)] }, { total_count: 5, runners: [] }]),
      "list runners",
      "perm",
    );
    expect(list).toMatchObject({ ok: false });
    expect(!list.ok && list.reason).toContain("page 2 was empty after 1 of 5 runners");
  });

  it("the page cap reached short of total_count fails closed and says so", async () => {
    const list = await readRunnerList(
      async (): Promise<unknown> => ({ total_count: 1000, runners: [runner("x", "offline", WINDOWS)] }),
      "list runners",
      "perm",
      3,
    );
    expect(!list.ok && list.reason).toContain("stopped at the 3-page cap after 3 of 1000 runners");
  });

  it("an unreadable count, or a malformed runner, fails closed", async () => {
    expect(await readRunnerList(fetchFrom([{ runners: [] }]), "list runners", "perm")).toMatchObject({ ok: false });
    expect(
      await readRunnerList(fetchFrom([{ total_count: 1, runners: [{ name: "a", status: "online" }] }]), "list runners", "perm"),
    ).toMatchObject({ ok: false });
  });

  it("a truncated list makes the diagnosis UNDETERMINED -- no stall is claimed from a partial pool", async () => {
    const { source } = scripted({
      jobs: { 7: job(WINDOWS) },
      repoPages: [{ total_count: 2, runners: [runner("NZ-NNR1", "offline", WINDOWS)] }],
    });
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]);
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
    const { source, calls } = scripted({});
    const [diagnosis] = await diagnoseWaitingChecks(source, REPO, [status]);
    expect(diagnosis?.detail).toContain("commit status from outside GitHub Actions");
    expect(calls).toEqual([]);
  });

  it("a check run from another app, or from another repository, is undetermined and reads nothing", async () => {
    const { source, calls } = scripted({});
    const out = await diagnoseWaitingChecks(source, REPO, [queued("app", null), queued("fork", 7, "other/nen")]);
    expect(out.map((each) => each.determination)).toEqual(["undetermined", "undetermined"]);
    expect(out[1]?.detail).toContain("its job runs in other/nen");
    expect(calls).toEqual([]);
  });

  it(`reads at most ${MAX_DIAGNOSED_JOBS} jobs and reports the rest as not read`, async () => {
    const entries: RollupEntry[] = Array.from({ length: MAX_DIAGNOSED_JOBS + 2 }, (_, index) => queued(`c${index}`, index + 1));
    const jobs: Record<number, unknown> = {};
    for (let id = 1; id <= MAX_DIAGNOSED_JOBS + 2; id += 1) jobs[id] = job(["ubuntu-latest"]);
    const { source, calls } = scripted({ jobs });
    const out = await diagnoseWaitingChecks(source, REPO, entries);
    expect(out).toHaveLength(MAX_DIAGNOSED_JOBS + 2);
    expect(calls).toHaveLength(MAX_DIAGNOSED_JOBS);
    expect(out[MAX_DIAGNOSED_JOBS]?.detail).toContain(`only the first ${MAX_DIAGNOSED_JOBS} waiting checks`);
  });
});

describe("renderRunnerAvailability", () => {
  it("renders nothing when nothing was diagnosed, and a header plus one line per check otherwise", async () => {
    expect(renderRunnerAvailability(undefined)).toEqual([]);
    expect(renderRunnerAvailability([])).toEqual([]);
    const { source } = scripted({ jobs: { 7: job(WINDOWS) }, repoError: forbidden(403, "administration=read") });
    const lines = renderRunnerAvailability(await diagnoseWaitingChecks(source, REPO, [queued("w", 7)]));
    expect(lines[0]).toContain("a diagnosis only, the verdict is unchanged");
    expect(lines[1]).toMatch(/^ {2}- w \[runs-on: self-hosted, Windows, X64\]: could not determine/);
    expect(lines[2]).toBe("      missing permission: administration=read");
  });
});
