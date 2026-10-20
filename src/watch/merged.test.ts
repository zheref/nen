import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { normalizePullRequestResponse, PULL_REQUEST_QUERY } from "../github/graphql.js";
import { ScriptedSeams } from "../seam/scripted.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";
import { createWatchCommand } from "./command.js";
import { watchUntilAsync } from "./until.js";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const node = (state: string, extra = {}): Record<string, unknown> => ({ state, headRefOid: HEAD,
  baseRefName: "release/next", mergeCommit: state === "MERGED" ? { oid: MERGE } : null, ...extra });

async function watch(nodes: readonly (Record<string, unknown> | null | Error)[], flags: string[] = [], json = true,
  policy?: Record<string, number>): Promise<{ code: number; out: string[]; err: string[]; sleeps: number[]; reads: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "nen-merged-"));
  if (policy !== undefined) {
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen/workflow.json"), JSON.stringify({ $schema: "nen.workflow/v0.1", monitor: policy }));
  }
  const queue = [...nodes];
  const reads: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("readiness must not be read"); };
  const deps: PrReadyDeps = {
    now: () => "unused", executable: () => "unused", localCheckout: () => null,
    openSource: (env) => {
      reads.push(env);
      const next = queue.shift();
      if (next === undefined) throw new Error("no fixture");
      if (next instanceof Error) throw next;
      return { ok: true, source: { pullRequestSnapshot: async () => normalizePullRequestResponse({ repository: { pullRequest: next } }),
        reviews: unexpected, reviewThreadsPage: unexpected, timeline: unexpected,
        checkRollupPage: unexpected, reviewRequestsPage: unexpected, fileAtRef: unexpected } };
    },
  };
  const out: string[] = [], err: string[] = [], sleeps: number[] = [];
  const command = createWatchCommand({ prReady: deps, sleep: (ms) => { sleeps.push(ms); } });
  const code = await runFamily(command, ["watch", "until", "--pr", "42", "--gh-repo", "owner/name", "--repo", root,
    "--until", "merged", ...flags], null, json, { out: (s) => { out.push(s); }, err: (s) => { err.push(s); } }, new ScriptedSeams([]));
  return { code, out, err, sleeps, reads };
}

describe("native PR lifecycle watch", () => {
  it("normalizes lifecycle fields without coercion and selects merge oid", () => {
    expect(PULL_REQUEST_QUERY).toContain("mergeCommit { oid }");
    for (const state of ["OPEN", "CLOSED", "MERGED"]) {
      const raw = node(state);
      expect(normalizePullRequestResponse({ repository: { pullRequest: raw } }).pullRequest).toMatchObject(raw);
    }
  });
  it("OPEN → MERGED returns full SHA and non-default base with no readiness reads", async () => {
    const got = await watch([node("OPEN"), node("MERGED")], ["--token-env", "CUSTOM_TOKEN", "--require-head", "AAAAAAA"]);
    expect(got.code).toBe(0);
    expect(got.reads).toEqual(["CUSTOM_TOKEN", "CUSTOM_TOKEN"]);
    expect(got.sleeps).toEqual([30000]);
    expect(JSON.parse(got.out[0] ?? "")).toMatchObject({ outcome: "condition-true", state: "MERGED", mergeSHA: MERGE, base: "release/next", headSHA: HEAD });
    expect(got.out[0]).not.toContain("readyAtWake");
  });
  it("human final line carries exact merge SHA/base and sanitizes GitHub fields", async () => {
    const got = await watch([node("MERGED", { baseRefName: "release/next\u001b\n" })], [], false);
    expect(got.code).toBe(0);
    expect(got.out.at(-1)).toBe(`PR owner/name#42 MERGED at ${MERGE} into release/next`);
    const machine = await watch([node("MERGED", { baseRefName: "release/next\n" })]);
    expect(JSON.parse(machine.out[0] ?? "").base).toBe("release/next\n");
  });
  it("OPEN → CLOSED is immediately terminal even on last allowed poll", async () => {
    const got = await watch([node("OPEN"), node("CLOSED")], ["--max-iterations", "2"]);
    expect(got.code).toBe(3);
    expect(got.sleeps).toEqual([30000]);
    expect(JSON.parse(got.out[0] ?? "")).toMatchObject({ outcome: "condition-false", state: "CLOSED", mergeSHA: null });
    const human = await watch([node("CLOSED")], [], false);
    expect(human.out.at(-1)).toContain("CLOSED without merge");
    expect(human.sleeps).toEqual([]);
  });
  it("OPEN at cap is distinct from merge and closure", async () => {
    const got = await watch([node("OPEN")], ["--max-iterations", "1"]);
    expect(got.code).toBe(1);
    expect(JSON.parse(got.out[0] ?? "")).toMatchObject({ outcome: "max-iterations", state: "OPEN", mergeSHA: null });
  });
  it.each([null, node("UNKNOWN"), node("MERGED", { mergeCommit: null }), node("MERGED", { mergeCommit: { oid: "bbbbbbb" } }),
    node("MERGED", { baseRefName: "" }), node("CLOSED", { mergeCommit: { oid: MERGE } }), node("OPEN", { headRefOid: null }), new Error("HTTP 403")])("unreadable/contradictory observation never succeeds: %j", async (bad) => {
    const got = await watch([bad, bad, bad]);
    expect(got.code).toBe(1);
    expect(got.reads).toHaveLength(3);
    expect(JSON.parse(got.out[0] ?? "")).toMatchObject({ outcome: "error-streak", state: null, mergeSHA: null });
  });
  it("head mismatch is an observation error; invalid head syntax is usage", async () => {
    expect((await watch([node("MERGED")], ["--require-head", "ccccccc", "--max-iterations", "1"])).code).toBe(1);
    const invalid = await watch([], ["--require-head", "short"]);
    expect(invalid.code).toBe(2);
    expect(invalid.reads).toEqual([]);
  });
  it.each([["--gates", "gates.json"], ["--reviewers", "someone"], ["--exclude-check", "build"], ["--require-base-gates"]])("refuses readiness-only flags %j before transport", async (...flags) => {
    const got = await watch([], flags);
    expect(got.code).toBe(2);
    expect(got.reads).toEqual([]);
  });
  it("valid OPEN resets the error streak", async () => {
    const got = await watch([new Error("offline"), new Error("offline"), node("OPEN"), new Error("offline"), node("MERGED")]);
    expect(got.code).toBe(0);
    expect(got.reads).toHaveLength(5);
  });
  it("monitor pace/cap and typed overrides apply, including declared zero", async () => {
    const cap = await watch([node("OPEN"), node("OPEN")], [], true, { maxCycles: 2, pollSeconds: 60 });
    expect(cap.code).toBe(1);
    expect(cap.sleeps).toEqual([60000]);
    const zero = await watch([], [], true, { maxCycles: 0, pollSeconds: 60 });
    expect(zero.code).toBe(1);
    expect(zero.reads).toEqual([]);
    const override = await watch([node("OPEN"), node("MERGED")], ["--max-iterations", "2", "--interval-ms", "30000"], true, { maxCycles: 0, pollSeconds: 60 });
    expect(override.code).toBe(0);
    expect(override.sleeps).toEqual([30000]);
    const floor = await watch([node("OPEN"), node("MERGED")], [], true, { maxCycles: 2, pollSeconds: 1 });
    expect(floor.sleeps).toEqual([30000]);
    const refused = await watch([], ["--interval-ms", "1000"]);
    expect(refused.code).toBe(2);
    expect(refused.reads).toEqual([]);
  });
  it("fallback bound is two hours and does not inherit undeclared monitor defaults", async () => {
    const got = await watch(Array.from({ length: 240 }, () => node("OPEN")));
    expect(got.code).toBe(1);
    expect(got.reads).toHaveLength(240);
    expect(got.sleeps).toHaveLength(239);
  });
});

describe("terminal false engine precedence", () => {
  it("errors cannot be terminal; truth wins; valid closure wins over cap", async () => {
    const sleep = vi.fn();
    const observation = { errored: true, conditionTrue: true, terminalFalse: true, message: "bad" };
    expect((await watchUntilAsync({ observe: async () => observation, intervalMs: 1, sleep })).outcome).toBe("error-streak");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect((await watchUntilAsync({ observe: async () => ({ ...observation, errored: false }), intervalMs: 1, maxIterations: 1, sleep })).outcome).toBe("condition-true");
    expect((await watchUntilAsync({ observe: async () => ({ ...observation, errored: false, conditionTrue: false }), intervalMs: 1, maxIterations: 1, sleep })).outcome).toBe("condition-false");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
