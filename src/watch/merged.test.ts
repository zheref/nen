// src/watch/merged.test.ts -- `nen watch until --pr <ref> --until merged`
// (zheref/nen#454): merged, closed-unmerged and still-open, told apart.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhPullRequestNode, PullRequestSnapshot } from "../github/graphql.js";
import type { PrStateSource } from "../github/pr_state.js";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import type { LocalCheckout, PrReadyDeps, ResolvedRef } from "../verbs/pr_ready.js";
import { createWatchCommand } from "./command.js";
import { lifecycleOf, observeLifecycle } from "./merged.js";

const REF: ResolvedRef = { owner: "zheref", repo: "example", number: 9, typed: "9" };
const MERGE_SHA = "0123456789abcdef0123456789abcdef01234567";

function node(state: unknown, mergeCommitOid: unknown = null): GhPullRequestNode {
  return {
    number: 9,
    mergeable: "UNKNOWN",
    isDraft: false,
    headRefOid: "cafebabe00",
    headRefName: "feature",
    baseRefName: "integration/x",
    author: { login: "zheref" },
    labels: [],
    reviewRequests: [],
    state,
    mergeCommitOid,
  };
}

/** One snapshot per poll; `null` is an unusable token, an Error is a failed read. */
function deps(queue: (GhPullRequestNode | undefined | null | Error)[]): PrReadyDeps & { reads: () => number } {
  let reads = 0;
  return {
    now: (): string => "2026-01-01T00:00:00Z",
    executable: (): string => "/opt/nen/nen",
    openSource: (): ReturnType<PrReadyDeps["openSource"]> => {
      reads += 1;
      const next = queue.shift();
      if (next === null) return { ok: false, message: "GH_TOKEN is not set" };
      const source = {
        pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => {
          if (next instanceof Error) throw next;
          return { pullRequest: next, defaultBranch: "main", checkRollup: undefined } as unknown as PullRequestSnapshot;
        },
      } as unknown as PrStateSource;
      return { ok: true, source };
    },
    localCheckout: (): LocalCheckout | null => null,
    reads: (): number => reads,
  };
}

const OUTSIDE_ROOT = mkdtempSync(join(tmpdir(), "nen-454-watch-"));
const BASE = ["watch", "until", "--pr", "9", "--gh-repo", "zheref/example", "--until", "merged", "--interval-ms", "30000", "--max-iterations", "5"];

async function watch(argv: readonly string[], readyDeps: PrReadyDeps, json = false): Promise<{ code: number; out: string[]; err: string[]; sleeps: number[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const command = createWatchCommand({ prReady: readyDeps, sleep: (ms): void => void sleeps.push(ms) });
  const code = await runFamily(command, argv, OUTSIDE_ROOT, json, io, new ScriptedSeams([]));
  return { code, out, err, sleeps };
}

describe("lifecycleOf / observeLifecycle -- three readings, never two", () => {
  it("MERGED is true and carries the merge commit and the base", () => {
    const read = lifecycleOf(REF, node("MERGED", MERGE_SHA));
    expect(read).toMatchObject({ kind: "state", lifecycle: { state: "MERGED", mergeCommit: MERGE_SHA, base: "integration/x" } });
    const seen = observeLifecycle(read);
    expect(seen.conditionTrue).toBe(true);
    expect(seen.message).toContain(MERGE_SHA);
  });

  it("CLOSED without a merge is terminal and false -- never the merge reading", () => {
    const seen = observeLifecycle(lifecycleOf(REF, node("CLOSED")));
    expect(seen).toMatchObject({ errored: false, conditionTrue: false, terminal: true });
  });

  it("OPEN is not yet, and not terminal", () => {
    const seen = observeLifecycle(lifecycleOf(REF, node("OPEN")));
    expect(seen).toMatchObject({ errored: false, conditionTrue: false });
    expect(seen.terminal).toBeUndefined();
  });

  it("an unreadable state, a missing node, or MERGED with no merge commit is an observation error", () => {
    expect(observeLifecycle(lifecycleOf(REF, node(undefined))).errored).toBe(true);
    expect(observeLifecycle(lifecycleOf(REF, node("SOMETHING"))).errored).toBe(true);
    expect(observeLifecycle(lifecycleOf(REF, undefined)).errored).toBe(true);
    expect(observeLifecycle(lifecycleOf(REF, node("MERGED", null))).errored).toBe(true);
  });
});

describe("nen watch until --pr <ref> --until merged", () => {
  it("polls an open PR until it merges, exits 0, and names the merge commit and base", async () => {
    const stub = deps([node("OPEN"), node("OPEN"), node("MERGED", MERGE_SHA)]);
    const result = await watch(BASE, stub);
    expect(result.code).toBe(0);
    expect(stub.reads()).toBe(3);
    expect(result.sleeps).toEqual([30000, 30000]);
    expect(result.out.at(-1)).toBe(`merged: zheref/example#9 into integration/x at ${MERGE_SHA}`);
  });

  it("stops on the FIRST closed-unmerged read at exit 1, outcome terminal, state CLOSED in --json", async () => {
    const stub = deps([node("OPEN"), node("CLOSED")]);
    const result = await watch(BASE, stub, true);
    expect(result.code).toBe(1);
    expect(stub.reads()).toBe(2);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc).toMatchObject({ outcome: "terminal", until: "merged", state: "CLOSED", mergeCommit: null, base: "integration/x" });
  });

  it("--json on a merge carries state MERGED, the merge commit and the base", async () => {
    const result = await watch(BASE, deps([node("MERGED", MERGE_SHA)]), true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ outcome: "condition-true", state: "MERGED", mergeCommit: MERGE_SHA, base: "integration/x" });
  });

  it("a still-open PR at the bound exits 1 with outcome max-iterations, never terminal", async () => {
    const stub = deps([node("OPEN"), node("OPEN")]);
    const result = await watch([...BASE.slice(0, -1), "2"], stub, true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ outcome: "max-iterations", state: "OPEN" });
  });

  it("three unreadable reads stop at the error streak -- could not read is never still open", async () => {
    const stub = deps([null, new Error("HTTP 502"), node(undefined)]);
    const result = await watch(BASE, stub, true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ outcome: "error-streak", state: null });
  });

  it("refuses a pr-ready flag it does not read, at exit 2, before any read", async () => {
    const stub = deps([]);
    const result = await watch([...BASE, "--reviewers", "copilot"], stub);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--reviewers is not read by the --until merged form/);
    expect(stub.reads()).toBe(0);
  });

  it("refuses a bare number with no --gh-repo at exit 2", async () => {
    const result = await watch(["watch", "until", "--pr", "9", "--until", "merged", "--interval-ms", "30000"], deps([]));
    expect(result.code).toBe(2);
  });
});
