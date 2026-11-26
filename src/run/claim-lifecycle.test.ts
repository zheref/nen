import { describe, expect, it } from "vitest";
import { planClaim, planPark, planStart, type RunManifest } from "./manifest.js";
import { normaliseManifest } from "./issue.js";
import { planImport, type ConsumerRun } from "./import.js";
import { effortsFromRun } from "../loop/fromrun.js";
import { ScriptedSeams } from "../seam/scripted.js";

const time = (n: number): string => `2026-10-22T00:00:0${n}.000Z`;
const ISSUE = "zheref/nen#564";
const empty = (): RunManifest => planStart(null, "r1", "zheref/nen", time(0), null).manifest;
const readSlots = (manifest: RunManifest): ReturnType<typeof effortsFromRun> => effortsFromRun(manifest, {
  readPr: (): never => { throw new Error("no PR read expected"); },
  readiness: async (): Promise<never> => { throw new Error("no readiness read expected"); },
  marker: (): never => { throw new Error("no marker read expected"); },
  repoCode: "NN",
});
const historical = (at: string): ConsumerRun => ({ contract: "hatsu.run/v0.1", id: "r1", repo: "zheref/nen", startedAt: time(0), idleAnswers: null, prs: [], parked: [{ issue: 564, row: "hold", at }] });

describe("claim and park lifecycle (NN#564)", () => {
  it("releases a reclaimed slot on the same row, and retry/import replay preserve that park", async () => {
    const claimed = planClaim(empty(), ISSUE, "A", time(1)).manifest;
    const parked = planPark(claimed, ISSUE, "hold", time(2)).manifest;
    const reclaimed = planClaim(parked, ISSUE, "A", time(3)).manifest;
    expect((await readSlots(reclaimed)).efforts).toHaveLength(1);
    const reparked = planPark(reclaimed, "ZHEREF/NEN#564", "hold", time(4));
    expect(reparked.outcome).toBe("parked");
    expect(reparked.manifest.parked).toHaveLength(1);
    expect((await readSlots(reparked.manifest)).efforts).toHaveLength(0);
    expect(planPark(reparked.manifest, ISSUE, "hold", time(5)).manifest).toBe(reparked.manifest);
    const normalized = normaliseManifest(".", reparked.manifest).manifest;
    const replay = planImport(new ScriptedSeams([]), normalized, historical(time(2)), "r1", time(6), ".");
    expect(replay.outcome).toBe("unchanged");
    expect((await readSlots(replay.manifest)).efforts).toHaveLength(0);
    expect(replay.manifest.parked[0]?.at).toBe(time(4));
  });

  it("keeps the latest duplicate park during normalization regardless of row order", async () => {
    const claimed = planClaim(empty(), ISSUE, "A", time(3)).manifest;
    for (const times of [[2, 4], [4, 2]]) {
      const manifest = { ...claimed, parked: times.map((n, i) => ({ issue: i ? ISSUE.toUpperCase() : ISSUE, row: "hold", at: time(n) })) };
      const normalized = normaliseManifest(".", manifest).manifest;
      expect(normalized.parked).toHaveLength(1);
      expect(normalized.parked[0]?.at).toBe(time(4));
      expect((await readSlots(normalized)).efforts).toHaveLength(0);
    }
  });

  it("historical replay cannot manufacture a new park after reclaim, but a later imported park releases it", async () => {
    const parked = planPark(planClaim(empty(), ISSUE, "A", time(1)).manifest, ISSUE, "hold", time(2)).manifest;
    const reclaimed = planClaim(parked, ISSUE, "A", time(3)).manifest;
    const stale = planImport(new ScriptedSeams([]), reclaimed, historical(time(2)), "r1", time(6), ".");
    expect(stale.outcome).toBe("unchanged");
    expect((await readSlots(stale.manifest)).efforts).toHaveLength(1);
    const fresh = planImport(new ScriptedSeams([]), stale.manifest, historical(time(4)), "r1", time(6), ".");
    expect((await readSlots(fresh.manifest)).efforts).toHaveLength(0);
    expect(fresh.manifest.parked[0]?.at).toBe(time(4));
  });

  it("allows distinct branch claims at one clock tick, but refuses a backwards clock and a park tie", async () => {
    const first = planClaim(empty(), ISSUE, "A", time(1)).manifest;
    const second = planClaim(first, ISSUE, "B", time(1)).manifest;
    expect(second.claims).toHaveLength(2);
    expect((await readSlots(second)).efforts).toHaveLength(1);
    expect(planClaim(second, ISSUE, "A", time(2)).outcome).toBe("unchanged");
    expect(() => planClaim(second, ISSUE, "C", time(0))).toThrow(/clock/);
    const parked = planPark(second, ISSUE, "hold", time(1)).manifest;
    expect(() => planClaim(parked, ISSUE, "C", time(1))).toThrow(/clock/);
  });
});
