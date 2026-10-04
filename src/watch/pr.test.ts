// Tests for `nen watch until --pr <ref> --until <predicate>` (zheref/nen#264):
// the settlement predicate (../gates/predicates.ts), the facts the gate now
// carries beside its verdict (../gates/ready.ts), the pure decision
// (./pr.ts), the async loop (./until.ts), and the verb end to end through
// ../index.ts's real `runFamily` -- with the GitHub transport STUBBED through
// the same `PrReadyDeps.openSource` seam ../verbs/pr_ready.test.ts drives, and
// a ScriptedSeams with no script, so a single spawned subprocess fails the test.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { prReady, readReady, type LocalCheckout, type PrReadyDeps, type ReadyRead, type ReadyReport } from "../verbs/pr_ready.js";
import { createWatchCommand } from "./command.js";
import { observePr, parsePrPredicate } from "./pr.js";
import { asyncSleep, MAX_TIMER_MS, watchUntilAsync, type WatchObservation } from "./until.js";

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

  const at = "2026-01-01T00:00:00Z";
  const state = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    mergeable: "MERGEABLE",
    head_sha: HEAD,
    checks: [],
    reviews: [],
    review_requests: [],
    unresolved_threads: 0,
    ...overrides,
  });

  it("counts a CONFIGURED reviewer's round at head and ignores a stray human's comment-only review", () => {
    const evaluation = evaluateReady(
      identities,
      state({
        reviews: [
          { author: "a-passing-human", state: "COMMENTED", commit_id: HEAD, submitted_at: at },
          { author: "copilot", state: "COMMENTED", commit_id: HEAD, submitted_at: at },
        ],
      }),
      options,
    );
    expect(evaluation.context.settlement.roundsAtHead).toEqual([{ reviewer: "copilot", via: "review" }]);
    expect(evaluation.context.settlement.checksSettled).toBe(false);
  });

  it("a stray human's review ALONE is no round at all", () => {
    const evaluation = evaluateReady(
      identities,
      state({ reviews: [{ author: "a-passing-human", state: "COMMENTED", commit_id: HEAD, submitted_at: at }] }),
      options,
    );
    expect(evaluation.context.settlement.roundsAtHead).toEqual([]);
  });

  it("current head only: a configured reviewer's round on an earlier commit does not count, even under bounded", () => {
    const evaluation = evaluateReady(
      identities,
      state({ reviews: [{ author: "sasuke", state: "APPROVED", commit_id: "0ldc0mm1t", submitted_at: at }] }),
      options,
    );
    expect(evaluation.context.settlement.roundsAtHead).toEqual([]);
  });

  it("a reviewer whose CHECK is its round counts by a definitive SUCCESS run at head, with no review", () => {
    const evaluation = evaluateReady(
      identities,
      state({
        reviewers: "sasuke,tenma,copilot,bugbot",
        checks: [{ name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
      options,
    );
    expect(evaluation.context.settlement.roundsAtHead).toEqual([{ reviewer: "bugbot", via: "round-check" }]);
  });

  it("a pending review request for the reviewer means its round is not posted yet", () => {
    const evaluation = evaluateReady(
      identities,
      state({
        reviews: [{ author: "copilot", state: "COMMENTED", commit_id: HEAD, submitted_at: at }],
        review_requests: ["copilot"],
      }),
      options,
    );
    expect(evaluation.context.settlement.roundsAtHead).toEqual([]);
  });

  it("an unreadable rollup or reviews array is null -- never false", () => {
    const evaluation = evaluateReady(
      identities,
      { mergeable: "MERGEABLE", head_sha: HEAD, checks: "garbage", reviews: "garbage", review_requests: [], unresolved_threads: 0 },
      options,
    );
    expect(evaluation.context.settlement.checksSettled).toBeNull();
    expect(evaluation.context.settlement.roundsAtHead).toBeNull();
  });
});

// ── the stubbed transport ───────────────────────────────────────────────────

interface Snapshot {
  /** A queued Windows job, or every check concluded. */
  readonly pending: boolean;
  /** Reviews at head: none, a comment only, or both approvers' APPROVE. */
  readonly reviews: "none" | "stray" | "comment" | "approved";
  /** The queued job's name -- GitHub's string, so a test can put control characters in it. */
  readonly pendingName?: string;
  /** An extra check whose latest run was CANCELLED -- the gate line NAMES it. */
  readonly cancelledName?: string;
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
        ? { name: snapshot.pendingName ?? "windows", status: "QUEUED", conclusion: null }
        : { name: "windows", status: "COMPLETED", conclusion: "SUCCESS" },
      ...(snapshot.cancelledName === undefined
        ? []
        : [{ name: snapshot.cancelledName, status: "COMPLETED", conclusion: "CANCELLED" }]),
    ],
    checkRollupPageInfo: { hasNextPage: false, endCursor: null },
    reviewRequests: [],
    reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
  };
  const at = "2026-01-01T00:00:00Z";
  const reviews =
    snapshot.reviews === "none"
      ? []
      : snapshot.reviews === "stray"
        ? [{ user: { login: "a-passing-human" }, state: "COMMENTED", commit_id: HEAD, submitted_at: at }]
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
const BASE = ["watch", "until", "--pr", "9", "--gh-repo", "zheref/example", "--gates", GATES, "--interval-ms", "30000"];

async function watch(
  argv: readonly string[],
  readyDeps: PrReadyDeps,
  json = false,
  repo: string | null = null,
): Promise<{ code: number; out: string[]; err: string[]; sleeps: number[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const command = createWatchCommand({ prReady: readyDeps, sleep: (ms): void => void sleeps.push(ms) });
  const code = await runFamily(command, argv, repo, json, io, new ScriptedSeams([]));
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
    expect(result.out[0]).toMatch(/^\[1\] settled-and-reviewed is not yet true -- head cafebab: 1 check\(s\) pending \(windows\); no configured reviewer's round at head/);
    expect(result.out[1]).toMatch(/^\[2\] settled-and-reviewed is not yet true -- head cafebab: checks settled; no configured reviewer's round at head/);
    expect(result.out[2]).toMatch(/^\[3\] settled-and-reviewed is true -- .*round at head by copilot \(review\)/);
    expect(result.out.at(-1)).toBe("condition became true after 3 observation(s)");
    // Paced between observations, never after the last.
    expect(result.sleeps).toEqual([30000, 30000]);
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

  it("a stray human's comment-only review does NOT wake review-posted; the configured reviewer's round does", async () => {
    const stub = deps([{ pending: true, reviews: "stray" }, SETTLED_COMMENTED]);
    const result = await watch([...BASE, "--until", "review-posted"], stub);
    expect(result.code).toBe(0);
    expect(stub.reads()).toBe(2);
    expect(result.out[0]).toMatch(/review-posted is not yet true -- .*no configured reviewer's round at head/);
    expect(result.out[1]).toMatch(/review-posted is true -- .*round at head by copilot \(review\)/);
  });

  it("a stray human's review does not satisfy settled-and-reviewed either", async () => {
    const result = await watch(
      [...BASE, "--until", "settled-and-reviewed", "--max-iterations", "1"],
      deps([{ pending: false, reviews: "stray" }]),
    );
    expect(result.code).toBe(1);
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
    expect(doc["readyAtWake"]).toBe(true);
    expect(doc["last"]).toEqual({
      verdict: "ready",
      gateLine: "ready",
      judgedHead: HEAD,
      warnings: [],
      notes: [],
      declaredExclusions: [],
      settlement: {
        checksSettled: true,
        pendingChecks: [],
        roundsAtHead: [
          { reviewer: "sasuke", via: "review" },
          { reviewer: "tenma", via: "review" },
        ],
      },
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

  const verdictRead = (verdict: "ready" | "not-ready", checksSettled: boolean | null, roundsAtHead: [] | null): ReadyRead => ({
    kind: "verdict",
    report: { verdict, gateLine: verdict === "ready" ? "ready" : "not-ready: x", judgedHead: HEAD } as never,
    settlement: { checksSettled, pendingChecks: [], roundsAtHead },
  });

  it("ready on a NOT-ready read with an unreadable fact is an ERROR, like settled-and-reviewed (N2)", () => {
    expect(observePr(verdictRead("not-ready", null, []), "ready")).toMatchObject({ errored: true });
    expect(observePr(verdictRead("not-ready", true, null), "ready")).toMatchObject({ errored: true });
    expect(observePr(verdictRead("not-ready", null, null), "checks-settled")).toMatchObject({ errored: true });
    expect(observePr(verdictRead("not-ready", null, null), "review-posted")).toMatchObject({ errored: true });
  });

  it("ready on a not-ready read whose facts are readable is an ordinary 'not yet'", () => {
    expect(observePr(verdictRead("not-ready", true, []), "ready")).toMatchObject({ errored: false, conditionTrue: false });
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

// ── hanten round 1 on zheref/nen#264 ────────────────────────────────────────

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const EVIL = "evil\u001b[2K\u001b]0;pwned\u0007\nname";

describe("F2 -- GitHub's strings are plain at every human seam, raw in --json", () => {
  it("the watch's poll lines carry no control character from a check name; --json keeps the bytes", async () => {
    const human = await watch([...BASE, "--until", "checks-settled", "--max-iterations", "1"], deps([{ pending: true, reviews: "none", pendingName: EVIL }]));
    expect(human.out.length).toBeGreaterThan(0);
    for (const line of [...human.out, ...human.err]) expect(line).not.toMatch(CONTROL);
    expect(human.out[0]).toContain("evil[2K]0;pwnedname");

    const machine = await watch([...BASE, "--until", "checks-settled", "--max-iterations", "1"], deps([{ pending: true, reviews: "none", pendingName: EVIL }]), true);
    const doc = JSON.parse(machine.out.join("\n")) as { last: { settlement: { pendingChecks: string[] } } };
    expect(doc.last.settlement.pendingChecks).toEqual([EVIL]);
  });

  it("pr ready's human rendering is plain too (the gate line names the check); its --json is raw", async () => {
    const lines: string[] = [];
    const io = { out: (line: string): void => void lines.push(line), err: (line: string): void => void lines.push(line) };
    const stub = deps([{ pending: false, reviews: "approved", cancelledName: EVIL }, { pending: false, reviews: "approved", cancelledName: EVIL }]);
    const input = { positionals: ["pr", "ready", "9"], values: { "gh-repo": "zheref/example", gates: GATES }, booleans: new Set<string>(), repoFlag: null };
    expect(await prReady(input, io, stub)).toBe(1);
    expect(lines.join("\n")).toContain("evil[2K]0;pwnedname");
    for (const line of lines) expect(line).not.toMatch(CONTROL);

    const json: string[] = [];
    await prReady({ ...input, booleans: new Set(["json"]) }, { out: (line): void => void json.push(line), err: (): void => {} }, stub);
    const report = JSON.parse(json.join("\n")) as ReadyReport;
    expect(report.gateLine).toContain(EVIL);
  });
});

describe("F3 -- the read's warnings, notes and declared exclusions are not dropped", () => {
  it("an unmatched --exclude-check is printed to stderr on the first poll, not again while unchanged, and carried in --json", async () => {
    const argv = [...BASE, "--until", "checks-settled", "--exclude-check", "no-such-check"];
    const human = await watch(argv, deps([PENDING, PENDING, SETTLED]));
    expect(human.code).toBe(0);
    const warned = human.err.filter((line) => line.includes("--exclude-check 'no-such-check' matched no check in the rollup"));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/^nen watch until: warning: /);

    const machine = await watch(argv, deps([SETTLED]), true);
    const doc = JSON.parse(machine.out.join("\n")) as { last: { warnings: string[]; notes: string[]; declaredExclusions: unknown[] } };
    expect(doc.last.warnings).toContain("--exclude-check 'no-such-check' matched no check in the rollup");
    expect(doc.last.notes).toEqual([]);
    expect(doc.last.declaredExclusions).toEqual([]);
  });

  it("the context is printed again when it CHANGES", async () => {
    // 'late-job' matches nothing on the first read (warned), then names the
    // queued job on the second (the warning is gone: the context changed).
    const changing = await watch(
      [...BASE, "--until", "settled-and-reviewed", "--exclude-check", "late-job", "--max-iterations", "2"],
      deps([PENDING, { pending: true, reviews: "none", pendingName: "late-job" }]),
    );
    const warnings = changing.err.filter((line) => line.includes("'late-job' matched no check"));
    expect(warnings).toHaveLength(1);
    // And back: a third read where it matches nothing again warns again.
    const back = await watch(
      [...BASE, "--until", "settled-and-reviewed", "--exclude-check", "late-job", "--max-iterations", "3"],
      deps([PENDING, { pending: true, reviews: "none", pendingName: "late-job" }, PENDING]),
    );
    expect(back.err.filter((line) => line.includes("'late-job' matched no check"))).toHaveLength(2);
  });
});

describe("F4/N6/N1 -- pacing for --pr", () => {
  it("refuses an --interval-ms under the 30000 ms floor, naming it, before any read", async () => {
    const stub = deps([]);
    const result = await watch(["watch", "until", "--pr", "9", "--gh-repo", "zheref/example", "--gates", GATES, "--until", "ready", "--interval-ms", "1000"], stub);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/under the --pr floor of 30000 ms/);
    expect(stub.reads()).toBe(0);
  });

  it("with no flag and no monitor policy, the watch is bounded at 2 hours' worth of polls", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-watch-pr-nopolicy-"));
    // One hour per poll -> a 2-hour bound is TWO polls; a third read would throw.
    const result = await watch(
      ["watch", "until", "--pr", "9", "--gh-repo", "zheref/example", "--gates", GATES, "--until", "checks-settled", "--interval-ms", "3600000"],
      deps([PENDING, PENDING]),
      false,
      root,
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/--max-iterations bound \(2\)/);
    expect(result.sleeps).toEqual([3600000]);
  });

  describe("asyncSleep sleeps in slices a timer can hold", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("an interval past 2^31-1 ms does not fire after 1 ms", async () => {
      vi.useFakeTimers();
      let done = false;
      const sleeping = asyncSleep(MAX_TIMER_MS + 1000).then((): void => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      await sleeping;
      expect(done).toBe(true);
    });
  });
});

describe("N5 -- the --pr form reads the monitor policy, and its edges", () => {
  const policyRoot = (monitor: Record<string, number>): string => {
    const root = mkdtempSync(join(tmpdir(), "nen-watch-pr-monitor-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ monitor }));
    return root;
  };
  const PR_ARGV = ["watch", "until", "--pr", "9", "--gh-repo", "zheref/example", "--gates", GATES, "--until", "checks-settled"];

  it("monitor.maxCycles is the default bound and monitor.pollSeconds the pace", async () => {
    const stub = deps([PENDING, PENDING]);
    const result = await watch(PR_ARGV, stub, false, policyRoot({ maxCycles: 2, pollSeconds: 300 }));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/--max-iterations bound \(2\)/);
    expect(result.sleeps).toEqual([300000]);
    expect(stub.reads()).toBe(2);
  });

  it("a monitor.pollSeconds under the floor is raised to it, and says so", async () => {
    const result = await watch(PR_ARGV, deps([PENDING, SETTLED]), false, policyRoot({ maxCycles: 5, pollSeconds: 5 }));
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toMatch(/monitor.pollSeconds \(5000 ms\) is under the --pr floor; polling every 30000 ms instead/);
    expect(result.sleeps).toEqual([30000]);
  });

  it("a declared monitor.maxCycles of 0 never runs: exit 1, nothing read", async () => {
    const stub = deps([]);
    const result = await watch(PR_ARGV, stub, false, policyRoot({ maxCycles: 0, pollSeconds: 300 }));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/maxCycles 0 -- the watch never runs/);
    expect(stub.reads()).toBe(0);
  });

  it("an empty --pr refuses at exit 2", async () => {
    const result = await watch(["watch", "until", "--pr", "", "--until", "ready"], deps([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--pr needs a pull-request reference/);
  });

  it("an all-CANCELLED group is settled: a cancellation is a verdict, and CON-32(a) reads it red", () => {
    const entries = rollup([
      { name: "build", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-01-01T00:00:00Z" },
      { name: "build", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-01-01T00:01:00Z" },
    ]);
    expect(checksSettled(entries)).toBe(true);
  });
});

describe("--reviewer-login and the anchored name-as-login fallback (zheref/nen#264)", () => {
  const BOT = "copilot-pull-request-reviewer[bot]";

  it("watch until --pr passes --reviewer-login through: the exact bot login counts, a look-alike does not", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-watch-pr-logins-"));
    const argv = [
      "watch", "until", "--pr", "9", "--gh-repo", "zheref/example", "--until", "review-posted",
      "--reviewers", "copilot", "--reviewer-login", `copilot=${BOT}`, "--interval-ms", "30000", "--max-iterations", "1",
    ];
    // One read whose only review is `login`'s, at head.
    const reviewed = (login: string): PrReadyDeps => ({
      ...deps([]),
      openSource: (): ReturnType<PrReadyDeps["openSource"]> => ({
        ok: true,
        source: {
          ...source({ pending: false, reviews: "none" }),
          reviews: async (): Promise<unknown[]> => [{ user: { login }, state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-01-01T00:00:00Z" }],
        },
      }),
    });
    expect((await watch(argv, reviewed(BOT), false, root)).code).toBe(0);
    expect((await watch(argv, reviewed("copilot-evil"), false, root)).code).toBe(1);
    expect((await watch(argv, reviewed("Not-copilot"), false, root)).code).toBe(1);
  });

  it("beside a gates file --reviewer-login is ignored with a warning, never silently", async () => {
    const stub = deps([READY]);
    const input = {
      positionals: ["pr", "ready", "9"],
      values: { "gh-repo": "zheref/example", gates: GATES },
      booleans: new Set<string>(),
      lists: { "reviewer-login": [`copilot=${BOT}`] },
      repoFlag: null,
    };
    const read = await readReady("9", input, stub);
    expect(read.kind === "verdict" && read.report.meta.warnings.some((w) => w.startsWith("--reviewer-login is read only when"))).toBe(true);
  });

  it("a reviewer name a gates file does not declare is its WHOLE login: a stranger's round never counts", () => {
    const identities = loadGateIdentities(BANKAI_REPO);
    const at = "2026-01-01T00:00:00Z";
    const evaluation = evaluateReady(
      identities,
      {
        mergeable: "MERGEABLE",
        head_sha: HEAD,
        reviewers: "ghost",
        checks: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
        reviews: [{ author: "ghost-fan", state: "APPROVED", commit_id: HEAD, submitted_at: at }],
        review_requests: [],
        unresolved_threads: 0,
      },
      { roundPolicyDefault: "bounded", stallMinutes: 30, now: at, excludeCheckNames: [] },
    );
    expect(evaluation.conjuncts.find((row) => row.id === "rounds-owed")?.status).toBe("failed");
    expect(evaluation.context.settlement.roundsAtHead).toEqual([]);

    const own = evaluateReady(
      identities,
      {
        mergeable: "MERGEABLE",
        head_sha: HEAD,
        reviewers: "ghost",
        checks: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
        reviews: [{ author: "Ghost[bot]", state: "COMMENTED", commit_id: HEAD, submitted_at: at }],
        review_requests: [],
        unresolved_threads: 0,
      },
      { roundPolicyDefault: "bounded", stallMinutes: 30, now: at, excludeCheckNames: [] },
    );
    expect(own.context.settlement.roundsAtHead).toEqual([{ reviewer: "ghost", via: "review" }]);
  });
});
