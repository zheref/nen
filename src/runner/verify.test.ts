import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { runnersArgv } from "./inventory.js";
import { judge, renderVerify, verifyRunners } from "./verify.js";
import { runnersAnswer, TARGET } from "./testkit.js";

const LIST = `gh ${runnersArgv(TARGET, 1).join(" ")}`;
const EXPECT = ["NZ-NNR1", "NZ-NNR2", "NZ-NNR3"];
const LABELS = ["self-hosted", "Windows", "X64"];

describe("verifyRunners -- every expected runner present, online, labelled; never a partial pass", () => {
  it("passes on the first read when all three are online", () => {
    const seams = new ScriptedSeams([{ match: LIST, result: { stdout: runnersAnswer(EXPECT.map((name) => ({ name }))) } }]);
    const slept: number[] = [];
    const report = verifyRunners(seams, TARGET, EXPECT, LABELS, 120, (ms) => slept.push(ms));
    expect(report.ok).toBe(true);
    expect(report.attempts).toBe(1);
    expect(slept).toEqual([]);
    expect(renderVerify(report)[0]).toBe("ok: 3/3 runner(s) online on zheref/nen (1 attempt(s), waited 0s)");
  });

  it("polls every 10s until they come up, within --wait", () => {
    const seams = new ScriptedSeams([
      { match: LIST, result: { stdout: runnersAnswer([{ name: "NZ-NNR1" }]) } },
      { match: LIST, result: { stdout: runnersAnswer([{ name: "NZ-NNR1" }, { name: "NZ-NNR2", status: "offline" }, { name: "NZ-NNR3" }]) } },
      { match: LIST, result: { stdout: runnersAnswer(EXPECT.map((name) => ({ name }))) } },
    ]);
    const slept: number[] = [];
    const report = verifyRunners(seams, TARGET, EXPECT, LABELS, 30, (ms) => slept.push(ms));
    expect(report.ok).toBe(true);
    expect(report.attempts).toBe(3);
    expect(slept).toEqual([10_000, 10_000]);
  });

  it("fails with a row per runner -- missing, offline, labels -- and asks once when --wait is 0", () => {
    const seams = new ScriptedSeams([
      {
        match: LIST,
        result: { stdout: runnersAnswer([{ name: "nz-nnr1" }, { name: "NZ-NNR2", status: "offline" }, { name: "NZ-NNR4", labels: ["self-hosted", "Windows"] }]) },
      },
    ]);
    const slept: number[] = [];
    const report = verifyRunners(seams, TARGET, [...EXPECT, "NZ-NNR4"], LABELS, 0, (ms) => slept.push(ms));
    expect(report.ok).toBe(false);
    expect(slept).toEqual([]);
    expect(report.runners.map((row) => [row.name, row.detail])).toEqual([
      ["NZ-NNR1", "ok"],
      ["NZ-NNR2", "offline"],
      ["NZ-NNR3", "missing"],
      ["NZ-NNR4", "labels: missing X64"],
    ]);
    expect(renderVerify(report).join("\n")).toMatch(/^NOT READY: 1\/4/);
  });

  it("does not demand labels nobody asked for", () => {
    const [runner] = [{ name: "A", id: 1, os: "", status: "online", busy: false, labels: [], convention: "runner-0" as const, machine: null, consumer: null, slot: null }];
    expect(judge([runner], ["A"], [])[0]?.verdict).toBe("ok");
    expect(judge([{ ...runner, status: "" }], ["A"], [])[0]?.detail).toBe("offline");
  });
});
