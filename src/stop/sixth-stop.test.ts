import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuorumMember } from "../gates/predicates.js";
import { runFamily } from "../index.js";
import { effortsFromRun, markerForBranch, type FromRunReport } from "../loop/fromrun.js";
import { computeSlots, parseEfforts, type PlaneReport } from "../loop/slots.js";
import { RUN_CONTRACT, type RunManifest } from "../run/manifest.js";
import { defaultSeams } from "../seam/exec.js";
import { stopCommand } from "./command.js";
import { readSixthStop, recordSixthStop, sixthStopObservation, type SixthStopReadiness } from "./sixth-stop.js";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const REPO = "owner/repo";
const identity = { effort: "effort", pr: 7, head: HEAD, gate: "G4" };
const now = "2026-11-09T22:00:00.000Z";
const seams = defaultSeams();
const requested: QuorumMember = { reviewer: "requested", round: null, reading: "current-head", requested: false, roundCheck: null };
const event: QuorumMember = {
  reviewer: "event",
  round: null,
  reading: "current-head",
  requested: false,
  roundCheck: { pattern: "^Round$", name: "Round", state: "unsuccessful", conclusion: "NEUTRAL", from: "head", sha: HEAD },
};
const absent: QuorumMember = {
  ...event, roundCheck: { pattern: "^Round$", name: null, state: "absent", conclusion: null, from: null, sha: null },
};
const evidence = {
  requests: [{ reviewer: "requested", head: HEAD, exitCode: 9, result: { ok: false, repo: REPO, pr: 7, requestHead: HEAD, routing: [{ route: "bot", id: "BOT_1", name: "requested-bot" }], unrecordedBots: [{ id: "BOT_1", login: null }] } }],
  windows: [],
};
const manifest: RunManifest = {
  contract: RUN_CONTRACT,
  id: "r1",
  repo: REPO,
  startedAt: now,
  idleAnswers: null,
  parked: [],
  prs: [{ issue: "NN#1", pr: 7, base: "main", branch: "topic", kind: "delivery", head: HEAD, effort: "effort", recordedAt: now }],
};

function verdict(head = HEAD, members = [requested, event], failing: SixthStopReadiness["failing"] = ["rounds-owed"], owed = ["requested", "event"]): SixthStopReadiness {
  return {
    verdict: failing.length === 0 ? "ready" : "not-ready",
    judgedHead: head,
    failing,
    meta: { repo: REPO, pr: 7, requiredHead: head, evaluatedAt: now, identities: { read: "base" }, aiReviewers: { effective: "required" } },
    conjuncts: [{
      id: "rounds-owed",
      status: "failed",
      roundQuorum: { anyOf: members.map(({ reviewer }) => reviewer), minimum: 1, count: 0, met: false, members },
      owedRounds: owed.map((reviewer) => ({ reviewer })),
    }],
  };
}

function watch(start: number, head = HEAD, absentReviewers = ["event"]): unknown {
  return {
    until: "ready",
    outcome: "max-iterations",
    intervalMs: 300_000,
    iterations: [1, 2].map((iteration) => ({ iteration, errored: false, conditionTrue: false })),
    sixthStopObservations: [start, start + 300_000].map((at) => ({
      repo: REPO, pr: 7, head, absentReviewers, at: new Date(Date.parse(now) + at).toISOString(),
    })),
  };
}

describe("run-derived sixth-stop slot accounting", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nen-sixth-stop-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function stop(...options: string[]): Promise<number> {
    return runFamily(stopCommand, ["stop", "--effort", "effort", "--pr", "7", "--head", HEAD, "--gate", "G4", ...options], root, false,
      { out: () => {}, err: () => {} }, seams);
  }

  async function count(report = verdict(), live = HEAD): Promise<{ built: FromRunReport; slots: PlaneReport }> {
    const built = await effortsFromRun(manifest, {
      readPr: () => ({ ok: true, pr: { state: "open", base: "main", headRef: "topic", head: live, createdAt: null } }),
      readiness: async () => ({ ok: true, ready: report.verdict === "ready", report, reviewerMatches: (name, login): boolean => login === name + "-bot" }),
      marker: (branch, proof) => markerForBranch(seams, root, branch, proof),
      sixthStop: (proof, repairOnly) => readSixthStop(seams, root, proof, REPO, repairOnly),
      promptGate: "G4",
    });
    return { built, slots: computeSlots(built.efforts, { local: 7, ci: 2 }, "ready+prompted").local };
  }

  it("releases a verified handoff without changing the not-ready verdict", async () => {
    const file = join(root, "proof.json");
    writeFileSync(file, JSON.stringify(evidence));
    expect(await stop("--sixth-stop-from", file, "--target", REPO)).toBe(1);
    expect(await stop("--prompt-shown")).toBe(0);
    expect(await stop("--sixth-stop-from", file, "--target", REPO)).toBe(0);
    expect(await stop("--sixth-stop-from", file, "--target", REPO)).toBe(0);
    const { built, slots } = await count();
    expect(slots.occupied).toBe(0);
    expect(slots.free).toBe(7);
    expect(built.efforts[0]).toMatchObject({ ready: false, prompted: true, sixthStopHead: HEAD });
    expect(built.efforts[0]?.facts).toContain("not-ready, prompt receipt");
    expect(built.efforts[0]?.facts).toContain(`sixth-stop release at ${HEAD}`);
  });

  it("holds again when the head moves, another row fails, or repair starts", async () => {
    await stop("--prompt-shown");
    recordSixthStop(seams, root, identity, REPO, "handoff", evidence);
    const moved = await count(verdict(NEXT), NEXT);
    expect(moved.slots.occupied).toBe(1);
    expect(moved.built.efforts[0]?.facts).toContain("needs a prompt receipt at the judged head");
    const failing = await count(verdict(HEAD, [requested, event], ["checks-green", "rounds-owed"]));
    expect(failing.slots.occupied).toBe(1);
    expect(failing.built.efforts[0]?.facts).toContain("failing: checks-green, rounds-owed");
    expect(await stop("--repair-hold", "--target", REPO)).toBe(0);
    const repair = await count();
    expect(repair.slots.occupied).toBe(1);
    expect(repair.built.efforts[0]?.facts).toContain("repair hold recorded");
    expect((await count(verdict(HEAD, [], []))).slots.occupied).toBe(1);
    expect(readSixthStop(seams, root, identity, "owner/other", false)).toEqual({ status: "missing" });
  });

  it("names missing evidence, unreadable evidence and owed reviewers outside the quorum", async () => {
    await stop("--prompt-shown");
    const missing = await count();
    expect(missing.slots.occupied).toBe(1);
    expect(missing.built.efforts[0]?.facts).toContain("sixth-stop evidence missing");
    const path = recordSixthStop(seams, root, identity, REPO, "handoff", evidence);
    const outside = await count(verdict(HEAD, [requested, event], ["rounds-owed"], ["outside"]));
    expect(outside.slots.occupied).toBe(1);
    expect(outside.built.efforts[0]?.facts).toContain("owed-reviewer list confined to the quorum");
    writeFileSync(path, "broken JSON");
    const unread = await count();
    expect(unread.slots.occupied).toBe(1);
    expect(unread.built.unread).toEqual([expect.objectContaining({ pr: 7, reason: expect.stringContaining("SyntaxError") })]);
    expect(unread.built.efforts[0]?.facts).toContain("sixth-stop evidence unread");
  });

  it("requires two complete, sequential windows for an absent event check", async () => {
    await stop("--prompt-shown");
    for (const windows of [[watch(0)], [watch(0), watch(0)], [watch(0), watch(300_000, NEXT)]]) {
      expect(() => recordSixthStop(seams, root, identity, REPO, "handoff", { ...evidence, windows })).toThrow();
    }
    const short = { ...(watch(0) as Record<string, unknown>), intervalMs: 30_000 };
    const future = Date.parse("2099-01-01T00:00:00Z") - Date.parse(now);
    for (const windows of [[short, watch(300_000)], [watch(future), watch(future + 300_000)]]) {
      expect(() => recordSixthStop(seams, root, identity, REPO, "handoff", { ...evidence, windows })).toThrow();
    }
    recordSixthStop(seams, root, identity, REPO, "handoff", { ...evidence, windows: [watch(0), watch(300_000)] });
    expect((await count(verdict(HEAD, [requested, absent]))).slots.occupied).toBe(0);
    const pending = { ...absent, requested: true };
    expect((await count(verdict(HEAD, [requested, pending]))).slots.occupied).toBe(1);
    expect(sixthStopObservation(verdict(HEAD, [requested, absent]))).toMatchObject({ head: HEAD, absentReviewers: ["event"] });
    expect(sixthStopObservation(verdict(HEAD, [requested, absent], ["checks-green", "rounds-owed"]))).toBeNull();
  });

  it("keeps slots held when checks are unevaluated or the request names another reviewer", async () => {
    await stop("--prompt-shown");
    const request = evidence.requests[0]!;
    expect(() => recordSixthStop(seams, root, identity, REPO, "handoff", {
      requests: [{ ...request, result: { ...request.result, pr: 9 } }], windows: [],
    })).toThrow(/exact delivery/);
    const path = recordSixthStop(seams, root, identity, REPO, "handoff", evidence);
    const current = verdict();
    const unread = await count({ ...current, conjuncts: [...current.conjuncts, { id: "checks-green", status: "unevaluated" }] });
    expect(unread.slots.occupied).toBe(1);
    expect(unread.built.unread).toEqual([{ pr: 7, reason: "readiness row unread: checks-green" }]);
    rmSync(path);
    recordSixthStop(seams, root, identity, REPO, "handoff", {
      requests: [{ ...request, result: { ...request.result, routing: [{ route: "bot", id: "BOT_1", name: "another-bot" }] } }], windows: [],
    });
    expect((await count()).slots.occupied).toBe(1);
  });

  it("does not let a caller-written efforts document supply a release or repair hold", () => {
    const { efforts } = parseEfforts(JSON.stringify([{ id: "test", plane: "local", prOpen: true, prompted: true, sixthStopHead: HEAD, repairHold: true }]));
    expect(efforts[0]).not.toHaveProperty("sixthStopHead");
    expect(efforts[0]).not.toHaveProperty("repairHold");
    expect(computeSlots(efforts, { local: 7, ci: 2 }, "ready+prompted").local.occupied).toBe(1);
  });
});
