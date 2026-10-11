// `nen runner relabel` (#340), driven through scripted `gh` answers only: no
// runner, host or repository is touched, and an unscripted call throws.

import { describe, expect, it } from "vitest";
import { VerbUsageError } from "../cli/command.js";
import { parseRunners, type RunnersPolicy } from "../schema/workflow.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { RunnerFailure } from "./github.js";
import { runnersArgv } from "./inventory.js";
import { addLabelArgv, relabelPool, renderRelabel, runnerLabelsArgv } from "./relabel.js";
import { DESKTOP_POOL_BODY, POLICY, POLICY_BODY, runnersAnswer, TARGET } from "./testkit.js";

const at = (argv: readonly string[]): string => `gh ${argv.join(" ")}`;
const LIST = at(runnersArgv(TARGET, 1));
const DEFAULTS = ["self-hosted", "Windows", "X64"];
const LABELLED = [...DEFAULTS, "pool-windows-x64"];

function policyOf(...pools: Record<string, unknown>[]): RunnersPolicy {
  const parsed = parseRunners("<fixture>", { pools });
  if (parsed === null) throw new Error("no policy");
  return parsed;
}
const PLAIN_AND_DESKTOP = policyOf(POLICY_BODY.pools[0]!, DESKTOP_POOL_BODY);
const POLICY_ = POLICY as RunnersPolicy;
const windows = POLICY_.pools[0]!;

/** The runners list, ids 100.. in order, then whatever the test scripts after it. */
function seams(rows: Parameters<typeof runnersAnswer>[0], ...after: ScriptedCall[]): ScriptedSeams {
  return new ScriptedSeams([{ match: LIST, result: { stdout: runnersAnswer(rows) } }, ...after]);
}

const labelsAnswer = (labels: readonly string[]): string => JSON.stringify({ total_count: labels.length, labels: labels.map((name) => ({ id: 0, name, type: "custom" })) });

describe("relabelPool -- the pool's own label on runners registered before it (#340)", () => {
  it("names the one write and its read-back", () => {
    expect(addLabelArgv(TARGET, 100, "pool-windows-x64")).toEqual(["api", "--method", "POST", "repos/zheref/nen/actions/runners/100/labels", "-f", "labels[]=pool-windows-x64"]);
    expect(runnerLabelsArgv(TARGET, 100)).toEqual(["api", "--method", "GET", "repos/zheref/nen/actions/runners/100/labels"]);
  });

  it("is a dry run by default: reads the list, writes nothing, and prints each write it would make", () => {
    const s = seams([{ name: "NZ-NNR1" }, { name: "NZ-NNR2" }, { name: "RJ2-NNR1", labels: ["self-hosted", "macOS", "ARM64"] }]);
    const report = relabelPool(s, TARGET, POLICY_, windows, null, false);
    expect(report).toEqual({
      target: "zheref/nen",
      pool: "windows-x64",
      label: "pool-windows-x64",
      selection: "awaiting",
      run: false,
      runners: [
        { name: "NZ-NNR1", id: 100, verdict: "would-add" },
        { name: "NZ-NNR2", id: 101, verdict: "would-add" },
      ],
      changed: 2,
    });
    expect(s.calls).toHaveLength(1);
    expect(renderRelabel(report, TARGET)).toEqual([
      "(dry run) would add pool-windows-x64 to 2 runner(s) on zheref/nen (pool windows-x64); pass --run to write.",
      "| name    | verdict   |",
      "| ------- | --------- |",
      "| NZ-NNR1 | would-add |",
      "| NZ-NNR2 | would-add |",
      "would run: gh api --method POST repos/zheref/nen/actions/runners/100/labels -f labels[]=pool-windows-x64",
      "would run: gh api --method POST repos/zheref/nen/actions/runners/101/labels -f labels[]=pool-windows-x64",
    ]);
  });

  it("writes with --run, reads every label back, and leaves a runner that already carries it alone", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }, { name: "NZ-NNR2", labels: LABELLED }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: { stdout: labelsAnswer(LABELLED) } },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: labelsAnswer(LABELLED) } },
    );
    const report = relabelPool(s, TARGET, POLICY_, windows, null, true);
    expect(report.runners).toEqual([
      { name: "NZ-NNR2", id: 101, verdict: "already" },
      { name: "NZ-NNR1", id: 100, verdict: "added" },
    ]);
    expect(report.changed).toBe(1);
    expect(s.calls.map((call) => call.args.slice(0, 3).join(" "))).toEqual(["api --method GET", "api --method POST", "api --method GET"]);
    expect(renderRelabel(report, TARGET)[0]).toBe("1 runner(s) on zheref/nen now carry pool-windows-x64 (pool windows-x64); each read back.");
  });

  it("is exit 1 when the read-back does not carry the label, naming what it read", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: { stdout: "{}" } },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: labelsAnswer(DEFAULTS) } },
    );
    expect(() => relabelPool(s, TARGET, POLICY_, windows, ["NZ-NNR1"], true)).toThrow(
      /added pool-windows-x64 to runner NZ-NNR1 on zheref\/nen, and reading its labels back answered \[self-hosted, Windows, X64\]/,
    );
  });

  it("names the 403 as needing admin, and which runners this run already labelled", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }, { name: "NZ-NNR2" }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: {} },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: labelsAnswer(LABELLED) } },
      { match: at(addLabelArgv(TARGET, 101, "pool-windows-x64")), result: { code: 1, stderr: "gh: Must have admin rights to Repository. (HTTP 403)" } },
    );
    let caught: unknown;
    try {
      relabelPool(s, TARGET, POLICY_, windows, null, true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunnerFailure);
    expect((caught as RunnerFailure).exitCode).toBe(1);
    expect((caught as RunnerFailure).message).toMatch(/adding pool-windows-x64 to runner NZ-NNR2 was refused \(403\): needs admin on zheref\/nen.*Already labelled by this run: NZ-NNR1\./);
  });

  it("refuses a read-back that is not a labels list", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: {} },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: "{}" } },
    );
    expect(() => relabelPool(s, TARGET, POLICY_, windows, null, true)).toThrow(/answered without a 'labels' list/);
  });

  it("takes --runner names case-insensitively, once each, and checks every one before any write", () => {
    const s = seams([{ name: "NZ-NNR1" }, { name: "NZ-NNR2" }]);
    const report = relabelPool(s, TARGET, POLICY_, windows, ["nz-nnr2", "NZ-NNR2"], false);
    expect(report.selection).toBe("named");
    expect(report.runners).toEqual([{ name: "NZ-NNR2", id: 101, verdict: "would-add" }]);
  });

  it("refuses the whole call, writing nothing, when a named runner is missing, of another os, already in another pool, or claimed by a more specific pool", () => {
    const s = seams([
      { name: "NZ-NNR1" },
      { name: "RJ2-NNR1", labels: ["self-hosted", "macOS", "ARM64"] },
      { name: "NZ-NNR3", labels: [...DEFAULTS, "pool-windows-x64-desktop"] },
      { name: "NZ-KWIR1", labels: [...DEFAULTS, "desktop"] },
    ]);
    let caught: unknown;
    try {
      relabelPool(s, TARGET, PLAIN_AND_DESKTOP, PLAIN_AND_DESKTOP.pools[0]!, ["NZ-NNR1", "NZ-NNR9", "RJ2-NNR1", "NZ-NNR3", "NZ-KWIR1"], true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunnerFailure);
    const message = (caught as RunnerFailure).message;
    expect(message).toMatch(/^no runner was relabelled for pool windows-x64: /);
    expect(message).toMatch(/NZ-NNR9 is not registered on zheref\/nen/);
    expect(message).toMatch(/RJ2-NNR1 lacks Windows, X64 of pool windows-x64's labels \[self-hosted, Windows, X64\], so it is not a runner of that pool/);
    expect(message).toMatch(/NZ-NNR3 already carries 'pool-windows-x64-desktop': a runner is in one pool/);
    expect(message).toMatch(/NZ-KWIR1 carries pool windows-x64-desktop's labels, a more specific set than pool windows-x64's/);
    expect(s.calls).toHaveLength(1);
  });

  it("puts an unlabelled desktop runner into the interactive pool only", () => {
    const s = seams([{ name: "NZ-NNR1" }, { name: "NZ-KWIR1", labels: [...DEFAULTS, "desktop"] }]);
    const desktop = PLAIN_AND_DESKTOP.pools[1]!;
    expect(relabelPool(s, TARGET, PLAIN_AND_DESKTOP, desktop, null, false).runners).toEqual([{ name: "NZ-KWIR1", id: 101, verdict: "would-add" }]);
    expect(relabelPool(seams([{ name: "NZ-NNR1" }, { name: "NZ-KWIR1", labels: [...DEFAULTS, "desktop"] }]), TARGET, PLAIN_AND_DESKTOP, PLAIN_AND_DESKTOP.pools[0]!, null, false).runners).toEqual([
      { name: "NZ-NNR1", id: 100, verdict: "would-add" },
    ]);
  });

  it("asks for --runner, exit 2, when two pools declare one label set", () => {
    const twin = policyOf(POLICY_BODY.pools[0]!, { ...POLICY_BODY.pools[0]!, id: "windows-two", preflightWorkflow: "two.yml" });
    expect(() => relabelPool(seams([{ name: "NZ-NNR1" }]), TARGET, twin, twin.pools[0]!, null, false)).toThrow(VerbUsageError);
    expect(() => relabelPool(seams([{ name: "NZ-NNR1" }]), TARGET, twin, twin.pools[0]!, null, false)).toThrow(
      /NZ-NNR1 could join pool windows-x64 or windows-two: they declare one label set, so which pool a runner is in is yours to say\. Name the runners with --runner/,
    );
    expect(relabelPool(seams([{ name: "NZ-NNR1" }]), TARGET, twin, twin.pools[1]!, ["NZ-NNR1"], false).runners).toEqual([{ name: "NZ-NNR1", id: 100, verdict: "would-add" }]);
  });

  it("says there is nothing to do when no runner awaits the label", () => {
    const report = relabelPool(seams([{ name: "RJ2-NNR1", labels: ["self-hosted", "macOS", "ARM64"] }]), TARGET, POLICY_, windows, null, true);
    expect(report.runners).toEqual([]);
    expect(renderRelabel(report, TARGET)).toEqual([
      "no runner on zheref/nen awaits pool-windows-x64: none carries pool windows-x64's declared labels without a pool label. Nothing to do.",
    ]);
  });
});
