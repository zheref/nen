// `nen pr ready`'s runner-availability diagnosis end to end (zheref/nen#224):
// the whole verb against a STUBBED transport, asserting what the issue's
// acceptance criteria turn on -- `--explain` says whether an online runner can
// start a waiting check, `--json` carries the same determination, a stalled and
// a merely slow check read differently, an unreadable runner list names the
// missing permission, and THE VERDICT AND EXIT ARE UNCHANGED in every case.

import { describe, expect, it } from "vitest";
import { prReady, type Io, type PrReadyDeps, type PrReadyInput, type ReadyReport } from "./pr_ready.js";
import type { PrStateSource } from "../github/pr_state.js";
import type {
  CheckRollupPage,
  PullRequestSnapshot,
  ReviewRequestsPage,
  ReviewThreadPage,
} from "../github/graphql.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { GATES_FILE, schemaPath } from "../schema/source.js";

const WINDOWS_CHECK = 'check (Windows, ["self-hosted","Windows","X64"])';
const WINDOWS = ["self-hosted", "Windows", "X64"];
const MACOS = ["self-hosted", "macOS", "ARM64"];
const JOB_URL = "https://github.com/zheref/example/actions/runs/38164140114/job/114543053976";

const NOW = "2026-10-11T12:00:00Z";

let nextRunnerId = 1;
function runner(name: string, status: "online" | "offline", labels: readonly string[]): unknown {
  return { id: nextRunnerId++, name, status, busy: false, labels: labels.map((label) => ({ name: label })) };
}

type RunnerReads = Pick<
  PrStateSource,
  "actionsJob" | "repoRunnersPage" | "orgRunnersPage" | "accountType" | "pullRequestFiles"
>;

/** A PR whose only blocker is one check QUEUED behind a runner, plus whatever runner reads a case scripts. */
function source(reads: RunnerReads, calls: string[] = [], checkName = WINDOWS_CHECK, appSlug = "github-actions"): PrStateSource {
  const snapshot: PullRequestSnapshot = {
    pullRequest: {
      number: 9,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: "cafebabe",
      headRefName: "feature/x",
      baseRefName: "main",
      baseRefOid: "basebase",
      author: { login: "someone" },
      labels: [],
      reviewRequests: [],
    },
    defaultBranch: "main",
    checkRollup: [
      { name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS" },
      // N1: GitHub stamps a real `startedAt` on a check run still QUEUED with
      // no runner -- the shape NN-PR-#217's job 105994605680 had.
      {
        name: checkName,
        status: "QUEUED",
        conclusion: null,
        startedAt: "2026-10-11T11:00:01Z",
        detailsUrl: JOB_URL,
        // Round-3 R1: what GraphQL answers for an Actions check run.
        databaseId: 114543053976,
        checkSuite: { app: { slug: appSlug } },
      },
    ],
    checkRollupPageInfo: { hasNextPage: false, endCursor: null },
    reviewRequests: [],
    reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
  };
  const record =
    <A extends unknown[], R>(
      name: string,
      fn: ((...args: A) => Promise<R>) | undefined,
    ): ((...args: A) => Promise<R>) | undefined =>
    fn === undefined
      ? undefined
      : async (...args: A): Promise<R> => {
          calls.push(name);
          return fn(...args);
        };
  const actionsJob = record("actionsJob", reads.actionsJob);
  const repoRunnersPage = record("repoRunnersPage", reads.repoRunnersPage);
  const orgRunnersPage = record("orgRunnersPage", reads.orgRunnersPage);
  const accountType = record("accountType", reads.accountType);
  const pullRequestFiles = record("pullRequestFiles", reads.pullRequestFiles);
  return {
    pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot,
    reviews: async (): Promise<unknown[]> => [
      { user: { login: "sasuke" }, state: "APPROVED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
      { user: { login: "tenma" }, state: "APPROVED", commit_id: "cafebabe", submitted_at: "2025-01-01T00:00:00Z" },
    ],
    reviewThreadsPage: async (): Promise<ReviewThreadPage> => ({ nodes: [], hasNextPage: false, endCursor: null }),
    timeline: async (): Promise<unknown[]> => [],
    checkRollupPage: async (): Promise<CheckRollupPage> => {
      throw new Error("not paged");
    },
    reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
      throw new Error("not paged");
    },
    fileAtRef: async (): Promise<string | null> => null,
    ...(actionsJob === undefined ? {} : { actionsJob }),
    ...(repoRunnersPage === undefined ? {} : { repoRunnersPage }),
    ...(orgRunnersPage === undefined ? {} : { orgRunnersPage }),
    ...(accountType === undefined ? {} : { accountType }),
    ...(pullRequestFiles === undefined ? {} : { pullRequestFiles }),
  };
}

function deps(src: PrStateSource, env: Record<string, string> = {}): PrReadyDeps {
  return {
    now: (): string => NOW,
    // Never the suite's own environment: under CI GITHUB_ACTIONS is "true".
    env: (): Record<string, string> => env,
    executable: (): string => "/opt/nen/nen-linux-x64",
    openSource: (): { ok: true; source: PrStateSource } => ({ ok: true, source: src }),
    localCheckout: (): null => null,
  };
}

function input(booleans: readonly string[]): PrReadyInput {
  return {
    positionals: ["pr", "ready", "9"],
    values: { "gh-repo": "zheref/example", gates: schemaPath(BANKAI_REPO, GATES_FILE) },
    booleans: new Set(booleans),
    repoFlag: null,
  };
}

async function run(
  src: PrStateSource,
  booleans: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await prReady(input(booleans), io, deps(src, env));
  return { code, out, err };
}

async function json(src: PrStateSource): Promise<{ code: number; report: ReadyReport }> {
  const { code, out } = await run(src, ["json"]);
  return { code, report: JSON.parse(out.join("\n")) as ReadyReport };
}

const queuedJob = (labels: readonly string[]) => async (): Promise<unknown> => ({
  id: 114543053976,
  status: "queued",
  labels,
  head_sha: "cafebabe",
  check_run_url: "https://api.github.com/repos/zheref/example/check-runs/114543053976",
  created_at: "2026-10-11T11:00:00Z",
});
const noWorkflowChange = async (): Promise<unknown[]> => [{ filename: "src/index.ts" }];
const pool = (runners: readonly unknown[]) => async (): Promise<unknown> => ({ total_count: runners.length, runners });
const user = async (): Promise<string> => "User";
const http = (status: number, accepted?: string): Error =>
  Object.assign(new Error(`HTTP ${status}`), {
    status,
    response: { headers: accepted === undefined ? {} : { "x-accepted-github-permissions": accepted } },
  });

const SCENARIOS: Readonly<Record<string, { reads: RunnerReads; determination: string; stall: boolean | null }>> = {
  "online match": {
    reads: { actionsJob: queuedJob(WINDOWS), repoRunnersPage: pool([runner("NZ-NNR1", "online", WINDOWS)]), accountType: user },
    determination: "online",
    stall: false,
  },
  "offline-only match": {
    reads: {
      actionsJob: queuedJob(WINDOWS),
      repoRunnersPage: pool([runner("NZ-NNR1", "offline", WINDOWS), runner("RJ2-NNR1", "online", MACOS)]),
      accountType: user,
      pullRequestFiles: noWorkflowChange,
    },
    determination: "offline-only",
    stall: true,
  },
  "no runner carrying the labels": {
    reads: {
      actionsJob: queuedJob(WINDOWS),
      repoRunnersPage: pool([runner("RJ2-NNR1", "online", MACOS)]),
      accountType: user,
      pullRequestFiles: noWorkflowChange,
    },
    determination: "no-runner",
    stall: true,
  },
  "GitHub-hosted": {
    reads: { actionsJob: queuedJob(["windows-latest"]) },
    determination: "github-hosted",
    stall: false,
  },
  "unreadable runners (403)": {
    reads: {
      actionsJob: queuedJob(WINDOWS),
      repoRunnersPage: async (): Promise<unknown> => {
        throw http(403, "administration=read");
      },
    },
    determination: "undetermined",
    stall: null,
  },
  "truncated runner list": {
    reads: {
      actionsJob: queuedJob(WINDOWS),
      repoRunnersPage: async (): Promise<unknown> => ({ total_count: 400, runners: [runner("NZ-NNR1", "offline", WINDOWS)] }),
      accountType: user,
    },
    determination: "undetermined",
    stall: null,
  },
};

/** Everything in a report but the diagnosis and the fields that carry it. */
function verdictOf(report: ReadyReport): unknown {
  const meta: Record<string, unknown> = { ...report.meta };
  delete meta["runnerAvailability"];
  return { ...report, meta };
}

describe("pr ready -- runner availability for a queued required check (zheref/nen#224)", () => {
  // The baseline: the same PR read through a transport with NO runner reads.
  // Its diagnosis is `undetermined` (the transport cannot), and everything
  // else is the verdict the gate decided before this issue existed.
  const baseline = async (): Promise<{ code: number; report: ReadyReport }> => json(source({}));

  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`${name}: --json carries '${scenario.determination}', and the verdict and exit are unchanged`, async () => {
      const before = await baseline();
      const after = await json(source(scenario.reads));
      expect(after.code).toBe(1);
      expect(after.code).toBe(before.code);
      expect(after.report.verdict).toBe("not-ready");
      expect(after.report.firstFailing).toBe("checks-green");
      expect(verdictOf(after.report)).toEqual(verdictOf(before.report));
      expect(after.report.meta.runnerAvailability).toHaveLength(1);
      expect(after.report.meta.runnerAvailability?.[0]).toMatchObject({
        check: WINDOWS_CHECK,
        jobId: 114543053976,
        determination: scenario.determination,
        infrastructureStall: scenario.stall,
      });
      // ...and the default output, which reads no runner, is identical too.
      const plainBefore = await run(source({}), []);
      const plainAfter = await run(source(scenario.reads), []);
      expect(plainAfter).toEqual(plainBefore);
    });
  }

  it("the default output makes NO runner read at all", async () => {
    const calls: string[] = [];
    await run(source(SCENARIOS["offline-only match"]?.reads ?? {}, calls), []);
    expect(calls).toEqual([]);
  });

  it("--explain says a stalled check and a merely slow one in different words (criterion 5)", async () => {
    const stalled = (await run(source(SCENARIOS["offline-only match"]?.reads ?? {}), ["explain"])).out.join("\n");
    const slow = (await run(source(SCENARIOS["online match"]?.reads ?? {}), ["explain"])).out.join("\n");
    expect(stalled).toContain("waiting checks and their runners (zheref/nen#224; a diagnosis only, the verdict is unchanged):");
    expect(stalled).toContain(
      `  - ${WINDOWS_CHECK} [runs-on: self-hosted, Windows, X64]: INFRASTRUCTURE STALL: every runner carrying these labels is offline (NZ-NNR1 (offline))`,
    );
    expect(slow).toContain(`  - ${WINDOWS_CHECK} [runs-on: self-hosted, Windows, X64]: an ONLINE runner carries every label (NZ-NNR1 (online))`);
    expect(slow).not.toContain("INFRASTRUCTURE STALL");
    // The verdict line above both is the same line.
    expect(stalled.split("\n")[0]).toBe(slow.split("\n")[0]);
  });

  it("a token that may not list runners: --explain says so and names the missing permission", async () => {
    const { code, out } = await run(source(SCENARIOS["unreadable runners (403)"]?.reads ?? {}), ["explain"]);
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain(
      "runner diagnosis unavailable without administration=read (HTTP 403 trying to list zheref/example's self-hosted runners); the gate does not need it",
    );
    expect(text).toContain("      missing permission: administration=read");
    const { report } = await json(source(SCENARIOS["unreadable runners (403)"]?.reads ?? {}));
    expect(report.meta.runnerAvailability?.[0]?.missingPermission).toBe("administration=read");
  });

  it("F5: under GITHUB_ACTIONS=true the grant hint is omitted, and the exit is the same", async () => {
    const { code, out } = await run(source(SCENARIOS["unreadable runners (403)"]?.reads ?? {}), ["explain"], {
      GITHUB_ACTIONS: "true",
    });
    expect(code).toBe(1);
    const text = out.join("\n");
    expect(text).toContain("runner diagnosis unavailable (HTTP 403 trying to list zheref/example's self-hosted runners); the gate does not need it");
    expect(text).not.toContain("missing permission:");
    expect(text).not.toContain("administration=read");
  });

  it("N4: the JSON carries the queue age the stall floor is judged on", async () => {
    const { report } = await json(source(SCENARIOS["offline-only match"]?.reads ?? {}));
    expect(report.meta.runnerAvailability?.[0]).toMatchObject({
      queuedSince: "2026-10-11T11:00:00Z",
      queuedMinutes: 60,
      labelsFromPrHead: false,
    });
  });

  it("every --explain line passes through plainLine: a hostile check name cannot rewrite the terminal", async () => {
    const hostile = "evil\u001b[2J\rcheck\nname";
    const { out } = await run(source(SCENARIOS["offline-only match"]?.reads ?? {}, [], hostile), ["explain"]);
    const line = out.find((each) => each.includes("INFRASTRUCTURE STALL"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\u001b\r\n]/);
  });

  it("round-3 R1: a third-party check whose details URL names a stalled Actions job is not called stalled", async () => {
    const calls: string[] = [];
    const { code, report } = await json(source(SCENARIOS["offline-only match"]?.reads ?? {}, calls, "Some App", "some-app"));
    expect(code).toBe(1);
    expect(report.meta.runnerAvailability?.[0]).toMatchObject({
      check: "Some App",
      determination: "undetermined",
      infrastructureStall: null,
    });
    expect(report.meta.runnerAvailability?.[0]?.detail).toContain("names a job that is not this check's");
    expect(calls).toEqual([]);
  });

  it("a ready pull request carries no diagnosis and reads no runner", async () => {
    const calls: string[] = [];
    const reads = SCENARIOS["offline-only match"]?.reads ?? {};
    const green = source(reads, calls);
    const snapshot = await green.pullRequestSnapshot({ owner: "zheref", repo: "example" }, 9);
    const ready: PrStateSource = {
      ...green,
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => ({
        ...snapshot,
        checkRollup: [{ name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    };
    const { code, report } = await json(ready);
    expect(code).toBe(0);
    expect(report.meta.runnerAvailability).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
