import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { RunnerFailure } from "./github.js";
import {
  assembleInventory,
  awaitingPools,
  declaredOf,
  downloadsArgv,
  fetchDownloads,
  fetchRunners,
  inPool,
  parseRunnerName,
  poolLabelsOf,
  renderInventory,
  runnersArgv,
} from "./inventory.js";
import { parseRunners } from "../schema/workflow.js";
import { DESKTOP_POOL_BODY, inventoryCalls, POLICY, POLICY_BODY, pool, runnersAnswer, TARGET } from "./testkit.js";

describe("parseRunnerName -- <machine>-<consumer>R<slot>, or runner 0", () => {
  it("parses the convention", () => {
    expect(parseRunnerName("NZ-NNR1")).toEqual({ convention: "named", machine: "NZ", consumer: "NN", slot: 1 });
    expect(parseRunnerName("RJ2-KPR12")).toEqual({ convention: "named", machine: "RJ2", consumer: "KP", slot: 12 });
    // A consumer code that itself ends in R still splits at the LAST R<digits>.
    expect(parseRunnerName("NZ-BRR3")).toEqual({ convention: "named", machine: "NZ", consumer: "BR", slot: 3 });
  });

  it("reads anything else as a grandfathered runner 0, never a slot", () => {
    for (const name of ["Runner0", "NZ-NNR0", "NZ_NNR1", "nosarashi", "NZ-NNR", "-NNR1"]) {
      expect(parseRunnerName(name)).toEqual({ convention: "runner-0", machine: null, consumer: null, slot: null });
    }
  });
});

describe("fetchRunners / fetchDownloads -- gh api GET, every page", () => {
  it("names --method GET on every read", () => {
    expect(runnersArgv(TARGET, 2)).toEqual(["api", "--method", "GET", "repos/zheref/nen/actions/runners?per_page=100&page=2"]);
    expect(downloadsArgv(TARGET)).toEqual(["api", "--method", "GET", "repos/zheref/nen/actions/runners/downloads"]);
  });

  it("reads the recorded answer into rows", () => {
    const rows = fetchRunners(new ScriptedSeams(inventoryCalls()), TARGET);
    expect(rows.map((row) => [row.name, row.status, row.busy, row.labels.join(","), row.slot])).toEqual([
      ["RJ2-NNR1", "online", false, "self-hosted,macOS,ARM64", 1],
      ["RJ2-NNR2", "online", false, "self-hosted,macOS,ARM64", 2],
      ["RJ2-NNR3", "online", false, "self-hosted,macOS,ARM64", 3],
    ]);
  });

  it("walks a second page when the first is full, and stops at total_count", () => {
    const page1 = JSON.stringify({ total_count: 101, runners: JSON.parse(runnersAnswer(Array.from({ length: 100 }, (_, i) => ({ name: `NZ-NNR${i + 1}` })))).runners });
    const page2 = runnersAnswer([{ name: "NZ-NNR101" }]).replace('"total_count":1', '"total_count":101');
    const seams = new ScriptedSeams([
      { match: `gh ${runnersArgv(TARGET, 1).join(" ")}`, result: { stdout: page1 } },
      { match: `gh ${runnersArgv(TARGET, 2).join(" ")}`, result: { stdout: page2 } },
    ]);
    expect(fetchRunners(seams, TARGET)).toHaveLength(101);
    expect(seams.calls).toHaveLength(2);
  });

  it("says 'needs admin' on a 403, and never echoes a token gh printed", () => {
    const seams = new ScriptedSeams([
      {
        match: `gh ${runnersArgv(TARGET, 1).join(" ")}`,
        result: { code: 1, stderr: "gh: Must have admin rights to Repository. (HTTP 403) token ghp_abcdefghijklmnopqrstuvwxyz0123" },
      },
    ]);
    let caught: unknown;
    try {
      fetchRunners(seams, TARGET);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunnerFailure);
    expect((caught as RunnerFailure).exitCode).toBe(1);
    expect((caught as RunnerFailure).message).toMatch(/needs admin on zheref\/nen/);
    expect((caught as RunnerFailure).message).not.toMatch(/ghp_/);
  });

  it("is exit 5 when gh cannot be started", () => {
    const seams = new ScriptedSeams([{ match: `gh ${runnersArgv(TARGET, 1).join(" ")}`, result: { spawnFailed: true, stderr: "ENOENT" } }]);
    expect(() => fetchRunners(seams, TARGET)).toThrow(expect.objectContaining({ exitCode: 5 }));
  });

  it("refuses an answer with no runners list, a row with no name, and a non-list downloads answer", () => {
    const argv = `gh ${runnersArgv(TARGET, 1).join(" ")}`;
    expect(() => fetchRunners(new ScriptedSeams([{ match: argv, result: { stdout: "{}" } }]), TARGET)).toThrow(/without a 'runners' list/);
    expect(() => fetchRunners(new ScriptedSeams([{ match: argv, result: { stdout: '{"runners":[{"id":1}]}' } }]), TARGET)).toThrow(/cannot read/);
    expect(() => fetchRunners(new ScriptedSeams([{ match: argv, result: { stdout: "not json" } }]), TARGET)).toThrow(/not JSON/);
    expect(() => fetchDownloads(new ScriptedSeams([{ match: `gh ${downloadsArgv(TARGET).join(" ")}`, result: { stdout: "{}" } }]), TARGET)).toThrow(/not a list/);
  });
});

describe("assembleInventory -- runners grouped by the declared pools", () => {
  const seams = (): ScriptedSeams => new ScriptedSeams(inventoryCalls());

  it("lists the recorded macOS runners, registered before #340, as awaiting macos-arm64's label -- in no pool, and not unpooled", () => {
    const s = seams();
    const report = assembleInventory(TARGET, fetchRunners(s, TARGET), fetchDownloads(s, TARGET), POLICY, null);
    expect(report.pools).toEqual([
      { id: "windows-x64", labels: ["self-hosted", "Windows", "X64", "pool-windows-x64"], runners: [], online: 0, free: 0, unlabelled: [] },
      { id: "macos-arm64", labels: ["self-hosted", "macOS", "ARM64", "pool-macos-arm64"], runners: [], online: 0, free: 0, unlabelled: ["RJ2-NNR1", "RJ2-NNR2", "RJ2-NNR3"] },
      { id: "linux-x64", labels: ["self-hosted", "Linux", "X64", "pool-linux-x64"], runners: [], online: 0, free: 0, unlabelled: [] },
    ]);
    expect(report.unpooled).toEqual([]);
    expect(report.downloads.find((row) => row.os === "win" && row.architecture === "x64")?.filename).toBe("actions-runner-win-x64-2.337.0.zip");
    expect(renderInventory(report).join("\n")).toMatch(
      /pool macos-arm64 \[self-hosted, macOS, ARM64, pool-macos-arm64\]: 0 runner\(s\), 0 online, 0 free; without pool-macos-arm64: RJ2-NNR1, RJ2-NNR2, RJ2-NNR3 \(nen runner relabel --pool macos-arm64\)/,
    );
  });

  it("groups relabelled runners into their pool, and no longer lists them as awaiting (#340)", () => {
    const answer = runnersAnswer(["RJ2-NNR1", "RJ2-NNR2"].map((name) => ({ name, labels: ["self-hosted", "macOS", "ARM64", "pool-macos-arm64"] })));
    const s = new ScriptedSeams(inventoryCalls(answer));
    const report = assembleInventory(TARGET, fetchRunners(s, TARGET), fetchDownloads(s, TARGET), POLICY, "macos-arm64");
    expect(report.pools).toEqual([
      { id: "macos-arm64", labels: ["self-hosted", "macOS", "ARM64", "pool-macos-arm64"], runners: ["RJ2-NNR1", "RJ2-NNR2"], online: 2, free: 2, unlabelled: [] },
    ]);
  });

  it("counts busy and offline apart, allows extra labels, and lists a runner no pool claims", () => {
    const rows = JSON.parse(
      runnersAnswer([
        { name: "NZ-NNR1", labels: ["self-hosted", "Windows", "X64", "pool-windows-x64"] },
        { name: "NZ-NNR2", busy: true, labels: ["self-hosted", "Windows", "X64", "pool-windows-x64"] },
        { name: "NZ-NNR3", status: "offline", labels: ["self-hosted", "Windows", "X64", "pool-windows-x64"] },
        { name: "NZ-NNR4", labels: ["self-hosted", "windows", "x64", "gpu", "POOL-windows-x64"] },
        { name: "Runner0", labels: ["self-hosted", "Windows", "ARM64"] },
      ]),
    );
    const s = new ScriptedSeams(inventoryCalls(JSON.stringify(rows)));
    const report = assembleInventory(TARGET, fetchRunners(s, TARGET), fetchDownloads(s, TARGET), POLICY, "windows-x64");
    expect(report.pools).toEqual([
      { id: "windows-x64", labels: ["self-hosted", "Windows", "X64", "pool-windows-x64"], runners: ["NZ-NNR1", "NZ-NNR2", "NZ-NNR3", "NZ-NNR4"], online: 3, free: 2, unlabelled: [] },
    ]);
    expect(report.unpooled).toEqual(["Runner0"]);
    expect(report.runners.find((row) => row.name === "Runner0")?.convention).toBe("runner-0");
    expect(renderInventory(report).join("\n")).toMatch(/\(runner 0\)/);
  });

  it("counts a desktop runner only in its interactive pool once both carry their own label (#333, #340)", () => {
    const policy = parseRunners("<fixture>", { pools: [POLICY_BODY.pools[0], DESKTOP_POOL_BODY] });
    const answer = runnersAnswer([
      { name: "NZ-NNR1", labels: ["self-hosted", "Windows", "X64", "pool-windows-x64"] },
      { name: "NZ-KWIR2", labels: ["self-hosted", "Windows", "X64", "desktop", "pool-windows-x64-desktop"] },
    ]);
    const s = new ScriptedSeams(inventoryCalls(answer));
    const report = assembleInventory(TARGET, fetchRunners(s, TARGET), fetchDownloads(s, TARGET), policy, null);
    expect(report.pools?.map((row) => [row.id, row.runners])).toEqual([
      ["windows-x64", ["NZ-NNR1"]],
      ["windows-x64-desktop", ["NZ-KWIR2"]],
    ]);
    expect(report.unpooled).toEqual([]);
  });

  it("lists an unlabelled desktop runner as awaiting only the interactive pool, never the plain one (#340)", () => {
    const policy = parseRunners("<fixture>", { pools: [POLICY_BODY.pools[0], DESKTOP_POOL_BODY] });
    const answer = runnersAnswer([{ name: "NZ-NNR1" }, { name: "NZ-KWIR2", labels: ["self-hosted", "Windows", "X64", "desktop"] }]);
    const s = new ScriptedSeams(inventoryCalls(answer));
    const report = assembleInventory(TARGET, fetchRunners(s, TARGET), fetchDownloads(s, TARGET), policy, null);
    expect(report.pools?.map((row) => [row.id, row.runners, row.unlabelled])).toEqual([
      ["windows-x64", [], ["NZ-NNR1"]],
      ["windows-x64-desktop", [], ["NZ-KWIR2"]],
    ]);
    expect(report.unpooled).toEqual([]);
  });

  it("awaits nothing for a runner that already carries any pool label, and both pools when two declare one set (#340)", () => {
    const policy = parseRunners("<fixture>", { pools: [POLICY_BODY.pools[0], { ...POLICY_BODY.pools[0], id: "windows-two", preflightWorkflow: "two.yml" }] });
    const pools = policy?.pools ?? [];
    expect(awaitingPools({ labels: ["self-hosted", "Windows", "X64", "pool-elsewhere"] }, pools)).toEqual([]);
    expect(awaitingPools({ labels: ["self-hosted", "Windows", "X64"] }, pools).map((p) => p.id)).toEqual(["windows-x64", "windows-two"]);
    expect(awaitingPools({ labels: ["self-hosted", "Linux", "X64"] }, pools)).toEqual([]);
    expect(declaredOf(pools[1]!)).toEqual(["self-hosted", "Windows", "X64"]);
    expect(poolLabelsOf({ labels: ["self-hosted", "Pool-A", "pool-b"] })).toEqual(["Pool-A", "pool-b"]);
  });

  it("carries no pools at all without a policy", () => {
    const s = seams();
    const report = assembleInventory(TARGET, fetchRunners(s, TARGET), [], null, null);
    expect(report.pools).toBeNull();
    expect(report.unpooled).toBeNull();
    expect(renderInventory(report).some((line) => line.startsWith("pool "))).toBe(false);
  });

  it("matches a pool by a superset of its labels, case-insensitively", () => {
    const [row] = fetchRunners(new ScriptedSeams(inventoryCalls(runnersAnswer([{ name: "X", labels: ["SELF-HOSTED", "macos", "arm64", "extra", "Pool-MacOS-ARM64"] }]))), TARGET);
    expect(inPool(row!, pool("macos-arm64"))).toBe(true);
    expect(inPool(row!, pool("windows-x64"))).toBe(false);
    // The defaults alone are not membership any more (#340).
    expect(inPool({ labels: ["self-hosted", "macOS", "ARM64"] }, pool("macos-arm64"))).toBe(false);
  });

  it("renders an empty repository as one line and no table", () => {
    const report = assembleInventory(TARGET, [], [], null, null);
    expect(renderInventory(report)).toEqual(["zheref/nen: 0 self-hosted runner(s)"]);
  });
});
