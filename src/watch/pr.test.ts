// Tests for `nen watch until --pr <ref> --until <predicate>` (zheref/nen#264):
// the settlement predicate (../gates/predicates.ts), the facts the gate now
// carries beside its verdict (../gates/ready.ts), the pure decision
// (./pr.ts), the async loop (./until.ts), and the verb end to end through
// ../index.ts's real `runFamily` -- with the GitHub transport STUBBED through
// the same `PrReadyDeps.openSource` seam ../verbs/pr_ready.test.ts drives, and
// a ScriptedSeams with no script, so a single spawned subprocess fails the test.

import { describe, expect, it } from "vitest";
import { checksSettled, pendingCheckLabels } from "../gates/predicates.js";
import { evaluateReady } from "../gates/ready.js";
import { parseCheckRollup } from "../github/parse.js";
import type { RollupEntry } from "../github/types.js";
import type { PrStateSource } from "../github/pr_state.js";
import type { CheckRollupPage, PullRequestSnapshot, ReviewRequestsPage, ReviewThreadPage } from "../github/graphql.js";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { loadGateIdentities } from "../schema/gates.js";
import { GATES_FILE, schemaPath } from "../schema/source.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { readReady, type LocalCheckout, type PrReadyDeps, type ReadyRead } from "../verbs/pr_ready.js";
import { createWatchCommand } from "./command.js";
import { observePr, parsePrPredicate } from "./pr.js";
import { watchUntilAsync, type WatchObservation } from "./until.js";

const HEAD = "cafebabe";

function rollup(raw: readonly Record<string, unknown>[]): RollupEntry[] {
  const parsed = parseCheckRollup(raw, "$.checks");
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

describe("checksSettled -- every latest check has a verdict, red included", () => {
  it("a red check is settled; CON-32(a) and settlement are different questions", () => {
    const entries = rollup([{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }]);
    expect(checksSettled(entries)).toBe(true);
    expect(pendingCheckLabels(entries)).toEqual([]);
  });

  it("a queued or in-progress run holds it open, and is named", () => {
    const entries = rollup([
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "test", status: "IN_PROGRESS", conclusion: null },
    ]);
    expect(checksSettled(entries)).toBe(false);
    expect(pendingCheckLabels(entries)).toEqual(["test"]);
  });

  it("a PENDING or EXPECTED status context holds it open; ERROR settles it", () => {
    expect(checksSettled(rollup([{ context: "ext", state: "PENDING" }]))).toBe(false);
    expect(checksSettled(rollup([{ context: "ext", state: "EXPECTED" }]))).toBe(false);
    expect(checksSettled(rollup([{ context: "ext", state: "ERROR" }]))).toBe(true);
  });

  it("an EMPTY rollup is never settled -- no reported check is no signal", () => {
    expect(checksSettled([])).toBe(false);
  });

  it("reads the LATEST run per name: a queued re-run supersedes an older SUCCESS", () => {
    const entries = rollup([
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" },
      { name: "build", status: "QUEUED", conclusion: null, startedAt: null },
    ]);
    expect(checksSettled(entries)).toBe(false);
  });
});

describe("evaluateReady's settlement -- read off the evaluation's own parse", () => {
  const identities = loadGateIdentities(BANKAI_REPO);
  const options = { roundPolicyDefault: "bounded" as const, stallMinutes: 30, now: "2026-01-01T00:00:00Z", excludeCheckNames: [] };

  it("a check the verdict excludes never holds the watch open", () => {
    const evaluation = evaluateReady(
      identities,
      {
        mergeable: "MERGEABLE",
        head_sha: HEAD,
        checks: [
          { name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "windows", status: "QUEUED", conclusion: null },
        ],
        reviews: [],
        review_requests: [],
        unresolved_threads: 0,
      },
      { ...options, excludeCheckNames: ["windows"] },
    );
    expect(evaluation.context.settlement.checksSettled).toBe(true);
  });

  it("names the authors of submitted reviews at head only -- never a stale round, never a PENDING draft", () => {
    const evaluation = evaluateReady(
      identities,
      {
        mergeable: "MERGEABLE",
        head_sha: HEAD,
        checks: [],
        reviews: [
          { author: "old", state: "APPROVED", commit_id: "0ldc0mm1t", submitted_at: "2025-01-01T00:00:00Z" },
          { author: "drafting", state: "PENDING", commit_id: HEAD, submitted_at: null },
          { author: "copilot", state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-01-01T00:00:00Z" },
          { author: "copilot", state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-01-01T00:01:00Z" },
        ],
        review_requests: [],
        unresolved_threads: 0,
      },
      options,
    );
    expect(evaluation.context.settlement.reviewersAtHead).toEqual(["copilot"]);
    expect(evaluation.context.settlement.checksSettled).toBe(false);
  });

  it("an unreadable rollup or reviews array is null -- never false", () => {
    const evaluation = evaluateReady(
      identities,
      { mergeable: "MERGEABLE", head_sha: HEAD, checks: "garbage", reviews: "garbage", review_requests: [], unresolved_threads: 0 },
      options,
    );
    expect(evaluation.context.settlement.checksSettled).toBeNull();
    expect(evaluation.context.settlement.reviewersAtHead).toBeNull();
  });
});

// ── the stubbed transport ───────────────────────────────────────────────────

interface Snapshot {
  /** A queued Windows job, or every check concluded. */
  readonly pending: boolean;
  /** Reviews at head: none, a comment only, or both approvers' APPROVE. */
  readonly reviews: "none" | "comment" | "approved";
}

const CHECK_NAMES = ["compile", "linux", "macos"];

function source(snapshot: Snapshot): PrStateSource {
  const pr: PullRequestSnapshot = {
    pullRequest: {
      number: 9,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: HEAD,
      headRefName: "feature/x",
      baseRefName: "main",
      baseRefOid: "basebase",
      author: { login: "someone" },
      labels: [],
      reviewRequests: [],
    },
    defaultBranch: "main",
    checkRollup: [
      ...CHECK_NAMES.map((name) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" })),
      snapshot.pending
        ? { name: "windows", status: "QUEUED", conclusion: null }
        : { name: "windows", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
    checkRollupPageInfo: { hasNextPage: false, endCursor: null },
    reviewRequests: [],
    reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
  };
  const at = "2026-01-01T00:00:00Z";
  const reviews =
    snapshot.reviews === "none"
      ? []
      : snapshot.reviews === "comment"
        ? [{ user: { login: "copilot" }, state: "COMMENTED", commit_id: HEAD, submitted_at: at }]
        : [
            { user: { login: "sasuke" }, state: "APPROVED", commit_id: HEAD, submitted_at: at },
            { user: { login: "tenma" }, state: "APPROVED", commit_id: HEAD, submitted_at: at },
          ];
  return {
    pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => pr,
    reviews: async (): Promise<unknown[]> => reviews,
    reviewThreadsPage: async (): Promise<ReviewThreadPage> => ({ nodes: [], hasNextPage: false, endCursor: null }),
    timeline: async (): Promise<unknown[]> => [],
    checkRollupPage: async (): Promise<CheckRollupPage> => {
      throw new Error("not paginated in this fixture");
    },
    reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
      throw new Error("not paginated in this fixture");
    },
    fileAtRef: async (): Promise<string | null> => null,
  };
}

/** One snapshot per read, in order -- `openSource` is called exactly once per `readReady`. `null` is "no token". */
function deps(snapshots: readonly (Snapshot | null)[]): PrReadyDeps & { reads: () => number } {
  const queue = [...snapshots];
  let reads = 0;
  return {
    now: (): string => "2026-01-01T00:00:00Z",
    executable: (): string => "/opt/nen/nen",
    openSource: (): ReturnType<PrReadyDeps["openSource"]> => {
      reads += 1;
      const next = queue.shift();
      if (next === undefined) throw new Error("the stub ran out of snapshots");
      return next === null ? { ok: false, message: "GH_TOKEN is not set" } : { ok: true, source: source(next) };
    },
    localCheckout: (): LocalCheckout | null => null,
    reads: (): number => reads,
  };
}

const GATES = schemaPath(BANKAI_REPO, GATES_FILE);
const BASE = ["watch", "until", "--pr", "9", "--gh-repo", "zheref/example", "--gates", GATES, "--interval-ms", "0"];

async function watch(
  argv: readonly string[],
  readyDeps: PrReadyDeps,
  json = false,
): Promise<{ code: number; out: string[]; err: string[]; sleeps: number[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const command = createWatchCommand({ prReady: readyDeps, sleep: (ms): void => void sleeps.push(ms) });
  const code = await runFamily(command, argv, null, json, io, new ScriptedSeams([]));
  return { code, out, err, sleeps };
}

const PENDING: Snapshot = { pending: true, reviews: "none" };
const SETTLED: Snapshot = { pending: false, reviews: "none" };
const SETTLED_COMMENTED: Snapshot = { pending: false, reviews: "comment" };
const READY: Snapshot = { pending: false, reviews: "approved" };

describe("nen watch until --pr -- the native compound predicate (zheref/nen#264)", () => {
  it("settled-and-reviewed waits for BOTH halves: pending, settled, then a review at head", async () => {
    const stub = deps([PENDING, SETTLED, SETTLED_COMMENTED]);
    const result = await watch([...BASE, "--until", "settled-and-reviewed"], stub);
    expect(result.code).toBe(0);
    expect(stub.reads()).toBe(3);
    expect(result.out[0]).toMatch(/^\[1\] settled-and-reviewed is not yet true -- head cafebab: 1 check\(s\) pending \(windows\); no review at head/);
    expect(result.out[1]).toMatch(/^\[2\] settled-and-reviewed is not yet true -- head cafebab: checks settled; no review at head/);
    expect(result.out[2]).toMatch(/^\[3\] settled-and-reviewed is true -- .*reviewed at head by copilot/);
    expect(result.out.at(-1)).toBe("condition became true after 3 observation(s)");
    // Paced between observations, never after the last.
    expect(result.sleeps).toEqual([0, 0]);
  });

  it("settled-and-reviewed also wakes on READY with no comment-only round", async () => {
    const result = await watch([...BASE, "--until", "settled-and-reviewed"], deps([PENDING, READY]));
    expect(result.code).toBe(0);
    expect(result.out[1]).toMatch(/verdict ready$/);
  });

  it("a review posted while CI still runs does NOT satisfy settled-and-reviewed", async () => {
    const result = await watch(
      [...BASE, "--until", "settled-and-reviewed", "--max-iterations", "1"],
      deps([{ pending: true, reviews: "comment" }]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/--max-iterations bound \(1\)/);
  });

  it("checks-settled wakes on a settled rollup even before any review", async () => {
    const result = await watch([...BASE, "--until", "checks-settled"], deps([PENDING, SETTLED]));
    expect(result.code).toBe(0);
  });

  it("review-posted wakes on a review at head whatever CI is doing", async () => {
    const result = await watch([...BASE, "--until", "review-posted"], deps([{ pending: true, reviews: "comment" }]));
    expect(result.code).toBe(0);
  });

  it("ready wakes exactly where 'pr ready' answers ready for the same flags and snapshot", async () => {
    const stub = deps([SETTLED_COMMENTED, READY]);
    const result = await watch([...BASE, "--until", "ready"], stub);
    expect(result.code).toBe(0);
    // The same read, asked directly of the same two snapshots, agrees row for row.
    const direct = deps([SETTLED_COMMENTED, READY]);
    const input = { positionals: ["pr", "ready", "9"], values: { "gh-repo": "zheref/example", gates: GATES }, booleans: new Set<string>(), repoFlag: null };
    const first = await readReady("9", input, direct);
    const second = await readReady("9", input, direct);
    expect(first.kind === "verdict" && first.report.verdict).toBe("not-ready");
    expect(second.kind === "verdict" && second.report.verdict).toBe("ready");
    expect(result.out[0]).toContain(first.kind === "verdict" ? first.report.gateLine : "?");
  });

  it("an unevaluated read is an OBSERVATION ERROR: three in a row stop the watch at exit 1, never 'not yet'", async () => {
    const result = await watch([...BASE, "--until", "settled-and-reviewed"], deps([null, null, null]));
    expect(result.code).toBe(1);
    expect(result.out[0]).toMatch(/^\[1\] observation failed: unevaluated: no usable token/);
    expect(result.err.join("\n")).toMatch(/3 consecutive observation errors/);
  });

  it("one unevaluated read between good ones resets the streak", async () => {
    const result = await watch([...BASE, "--until", "checks-settled"], deps([null, PENDING, null, SETTLED]));
    expect(result.code).toBe(0);
  });

  it("--require-head that GitHub's head does not match is an observation error, not a verdict", async () => {
    const result = await watch(
      [...BASE, "--until", "ready", "--require-head", "1234567", "--max-iterations", "1"],
      deps([READY]),
    );
    expect(result.code).toBe(1);
    expect(result.out[0]).toMatch(/observation failed: --require-head 1234567 does not match/);
  });

  it("--json carries the loop result plus until, pr and the last read's verdict and settlement", async () => {
    const result = await watch([...BASE, "--until", "settled-and-reviewed"], deps([PENDING, READY]), true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["outcome"]).toBe("condition-true");
    expect(doc["until"]).toBe("settled-and-reviewed");
    expect(doc["pr"]).toBe("9");
    expect(doc["last"]).toEqual({
      verdict: "ready",
      gateLine: "ready",
      judgedHead: HEAD,
      settlement: { checksSettled: true, pendingChecks: [], reviewersAtHead: ["sasuke", "tenma"] },
    });
    expect((doc["iterations"] as unknown[]).length).toBe(2);
  });
});

describe("nen watch until --pr -- usage refusals (exit 2, nothing read)", () => {
  it("--pr without --until", async () => {
    const stub = deps([]);
    const result = await watch(BASE, stub);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--pr needs --until/);
    expect(stub.reads()).toBe(0);
  });

  it("an --until outside the closed set", async () => {
    const result = await watch([...BASE, "--until", "approved"], deps([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--until must be one of checks-settled, review-posted, ready, settled-and-reviewed/);
  });

  it("--pr beside --command", async () => {
    const result = await watch([...BASE, "--until", "ready", "--command", "gh pr checks 9"], deps([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/two different observations/);
  });

  it("a --command-only flag beside --pr", async () => {
    const result = await watch([...BASE, "--until", "ready", "--true-pattern", "x"], deps([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--true-pattern is not read by the --pr form/);
  });

  it("a --pr-only flag beside --command", async () => {
    const result = await watch(["watch", "until", "--command", "git status --short", "--until", "ready"], deps([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--until is not read by the --command form/);
  });

  it("a usage refusal from the read itself stops on the FIRST poll, not after three", async () => {
    const stub = deps([READY, READY, READY]);
    const result = await watch([...BASE, "--until", "ready", "--round-policy", "lenient"], stub);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--round-policy must be strict or bounded/);
    expect(stub.reads()).toBe(0);
  });
});

describe("observePr / parsePrPredicate -- pure", () => {
  it("parsePrPredicate admits the closed set only", () => {
    expect(parsePrPredicate("settled-and-reviewed")).toBe("settled-and-reviewed");
    expect(() => parsePrPredicate(undefined)).toThrow(/--pr needs --until/);
  });

  it("ready does not need the settlement facts the verdict already turned on", () => {
    const read: ReadyRead = {
      kind: "verdict",
      report: { verdict: "not-ready", gateLine: "not-ready: x", judgedHead: HEAD } as never,
      settlement: { checksSettled: null, pendingChecks: [], reviewersAtHead: null },
    };
    expect(observePr(read, "ready")).toMatchObject({ errored: false, conditionTrue: false });
    expect(observePr(read, "checks-settled")).toMatchObject({ errored: true });
    expect(observePr(read, "review-posted")).toMatchObject({ errored: true });
  });
});

describe("watchUntilAsync -- the same loop, awaited", () => {
  const scripted = (observations: WatchObservation[]): (() => Promise<WatchObservation>) => {
    const queue = [...observations];
    return async (): Promise<WatchObservation> => {
      const next = queue.shift();
      if (next === undefined) throw new Error("ran out");
      return next;
    };
  };
  const no: WatchObservation = { errored: false, conditionTrue: false, message: "no" };
  const yes: WatchObservation = { errored: false, conditionTrue: true, message: "yes" };
  const broken: WatchObservation = { errored: true, conditionTrue: true, message: "broken" };

  it("stops on truth", async () => {
    const result = await watchUntilAsync({ observe: scripted([no, yes]), intervalMs: 0, sleep: (): void => {} });
    expect(result.outcome).toBe("condition-true");
    expect(result.iterations).toHaveLength(2);
  });

  it("an errored observation is never true, whatever the caller said", async () => {
    const result = await watchUntilAsync({ observe: scripted([broken, broken, broken]), intervalMs: 0, sleep: (): void => {} });
    expect(result.outcome).toBe("error-streak");
    expect(result.iterations.every((entry) => !entry.conditionTrue)).toBe(true);
  });

  it("stops at the bound", async () => {
    const result = await watchUntilAsync({ observe: scripted([no, no]), intervalMs: 0, maxIterations: 2, sleep: (): void => {} });
    expect(result.outcome).toBe("max-iterations");
  });

  it("the default sleep is a real, non-blocking wait", async () => {
    const result = await watchUntilAsync({ observe: scripted([no, yes]), intervalMs: 1 });
    expect(result.outcome).toBe("condition-true");
  });
});
