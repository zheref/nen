import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { runnersArgv, type RunnerRow } from "./inventory.js";
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

describe("verify -- the pool's own label (#340)", () => {
  const POOL_LABELS = ["self-hosted", "Windows", "X64", "pool-windows-x64"];

  it("catches a runner registered without its pool label, and names the relabel step", () => {
    const seams = new ScriptedSeams([
      {
        match: LIST,
        result: { stdout: runnersAnswer([{ name: "NZ-NNR1", labels: POOL_LABELS }, { name: "NZ-NNR2" }]) },
      },
    ]);
    const report = verifyRunners(seams, TARGET, ["NZ-NNR1", "NZ-NNR2"], POOL_LABELS, 0, () => undefined, { id: "windows-x64", target: "zheref/nen" });
    expect(report.ok).toBe(false);
    expect(report.runners.map((row) => [row.name, row.verdict, row.missingLabels])).toEqual([
      ["NZ-NNR1", "ok", []],
      ["NZ-NNR2", "labels", ["pool-windows-x64"]],
    ]);
    expect(report.runners[1]?.detail).toBe(
      "labels: missing pool-windows-x64 -- registered without its pool label: nen runner relabel --target zheref/nen --pool windows-x64 --runner NZ-NNR2 --run",
    );
  });

  const runner = (name: string, labels: string[]): RunnerRow => ({ name, id: 1, os: "", status: "online", busy: false, labels, convention: "runner-0" as const, machine: null, consumer: null, slot: null });
  const POOL = { id: "windows-x64", target: "zheref/nen" };

  it("does not offer relabel when what is missing is a default label", () => {
    const [row] = judge([runner("A", ["self-hosted", "pool-windows-x64"])], ["A"], POOL_LABELS, POOL);
    expect(row?.detail).toBe("labels: missing Windows, X64");
  });

  it("offers relabel only when it is exact: --pool given, the pool label the ONLY one missing, and no other pool label carried (N2)", () => {
    // Missing the pool label AND a default: relabel would not fix it.
    expect(judge([runner("A", ["self-hosted", "Windows"])], ["A"], POOL_LABELS, POOL)[0]?.detail).toBe("labels: missing X64, pool-windows-x64");
    // Already in another pool: relabel would refuse it.
    expect(judge([runner("A", ["self-hosted", "Windows", "X64", "pool-windows-x64-desktop"])], ["A"], POOL_LABELS, POOL)[0]?.detail).toBe("labels: missing pool-windows-x64");
    // No --pool: the id is never sliced out of a label.
    expect(judge([runner("A", ["self-hosted", "Windows", "X64"])], ["A"], POOL_LABELS)[0]?.detail).toBe("labels: missing pool-windows-x64");
  });

  it("prints a GitHub runner name plain, and keeps it raw in the report (F3)", () => {
    const evil = "NZ-NNR2\u001b[2K";
    const seams = new ScriptedSeams([{ match: LIST, result: { stdout: runnersAnswer([{ name: evil }]) } }]);
    const report = verifyRunners(seams, TARGET, [evil], POOL_LABELS, 0, () => undefined, POOL);
    expect(report.runners[0]?.name).toBe(evil);
    expect(report.runners[0]?.detail).toContain(`--runner ${evil} --run`);
    const text = renderVerify(report).join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("--runner NZ-NNR2[2K --run");
  });
});
