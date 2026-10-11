// `nen runner relabel` (#340), driven through scripted `gh` answers only: no
// runner, host or repository is touched, and an unscripted call throws.

import { describe, expect, it } from "vitest";
import { VerbUsageError } from "../cli/command.js";
import { parseRunners, type RunnersPolicy } from "../schema/workflow.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { RunnerFailure } from "./github.js";
import { runnersArgv } from "./inventory.js";
import { addLabelArgv, relabelPool, renderRelabel, runnerLabelsArgv, shellWord } from "./relabel.js";
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
/** KroWindows' shape: the plain Windows pool, and no interactive pool declared. */
const PLAIN_ONLY = policyOf(POLICY_BODY.pools[0]!);
const POLICY_ = POLICY as RunnersPolicy;
const windows = POLICY_.pools[0]!;

/** The runners list, ids 100.. in order, then whatever the test scripts after it. */
function seams(rows: Parameters<typeof runnersAnswer>[0], ...after: ScriptedCall[]): ScriptedSeams {
  return new ScriptedSeams([{ match: LIST, result: { stdout: runnersAnswer(rows) } }, ...after]);
}

const labelsAnswer = (labels: readonly string[]): string => JSON.stringify({ total_count: labels.length, labels: labels.map((name) => ({ id: 0, name, type: "custom" })) });

function caught(run: () => unknown): RunnerFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof RunnerFailure) return error;
    throw error;
  }
  throw new Error("expected a RunnerFailure");
}

describe("relabelPool -- the pool's own label on runners registered before it (#340)", () => {
  it("shell-quotes every operand of the then: line (R2)", () => {
    const report = relabelPool(seams([{ name: "NZ-NNR1" }, { name: "NZ NNR2" }]), TARGET, POLICY_, windows, null, false);
    expect(renderRelabel(report, TARGET).at(-1)).toBe("then: nen runner relabel --target zheref/nen --pool windows-x64 --runner 'NZ-NNR1,NZ NNR2' --run");
    expect(shellWord("a,b")).toBe("a,b");
  });

  it("names the one write and its read-back; the would-run line is shell-quoted, the argv is not (N4)", () => {
    expect(addLabelArgv(TARGET, 100, "pool-windows-x64")).toEqual(["api", "--method", "POST", "repos/zheref/nen/actions/runners/100/labels", "-f", "labels[]=pool-windows-x64"]);
    expect(runnerLabelsArgv(TARGET, 100)).toEqual(["api", "--method", "GET", "repos/zheref/nen/actions/runners/100/labels"]);
    expect(shellWord("labels[]=pool-windows-x64")).toBe("'labels[]=pool-windows-x64'");
    expect(shellWord("repos/zheref/nen/actions/runners/100/labels")).toBe("repos/zheref/nen/actions/runners/100/labels");
    expect(shellWord("it's")).toBe("'it'\\''s'");
  });

  it("refuses --run without --runner at exit 2, before reading anything: no bulk admission (F1)", () => {
    const s = seams([{ name: "NZ-NNR1" }]);
    expect(() => relabelPool(s, TARGET, POLICY_, windows, null, true)).toThrow(VerbUsageError);
    expect(() => relabelPool(s, TARGET, POLICY_, windows, null, true)).toThrow(/--run needs --runner <name>\[,<name>...\] naming every runner to label: nen never admits runners into pool windows-x64 in bulk/);
    expect(s.calls).toHaveLength(0);
  });

  it("lists the eligible runners as candidates to name, without --runner, and writes nothing (F1)", () => {
    const s = seams([{ name: "NZ-NNR1" }, { name: "NZ-NNR2", labels: LABELLED }, { name: "NZ-NNR3" }, { name: "RJ2-NNR1", labels: ["self-hosted", "macOS", "ARM64"] }]);
    const report = relabelPool(s, TARGET, POLICY_, windows, null, false);
    expect(report).toEqual({
      target: "zheref/nen",
      pool: "windows-x64",
      label: "pool-windows-x64",
      selection: "candidates",
      run: false,
      runners: [
        { name: "NZ-NNR2", id: 101, verdict: "already" },
        { name: "NZ-NNR1", id: 100, verdict: "candidate" },
        { name: "NZ-NNR3", id: 102, verdict: "candidate" },
      ],
      changed: 0,
    });
    expect(s.calls).toHaveLength(1);
    const text = renderRelabel(report, TARGET);
    expect(text[0]).toBe("(dry run) 2 runner(s) on zheref/nen could take pool-windows-x64 (pool windows-x64); nothing is admitted in bulk -- name each one you mean:");
    expect(text.at(-1)).toBe("then: nen runner relabel --target zheref/nen --pool windows-x64 --runner NZ-NNR1,NZ-NNR3 --run");
  });

  it("is a dry run with --runner but no --run, printing each write shell-quoted (N4)", () => {
    const report = relabelPool(seams([{ name: "NZ-NNR1" }, { name: "NZ-NNR2" }]), TARGET, POLICY_, windows, ["NZ-NNR1", "NZ-NNR2"], false);
    expect(report.changed).toBe(2);
    expect(renderRelabel(report, TARGET)).toEqual([
      "(dry run) would add pool-windows-x64 to 2 runner(s) on zheref/nen (pool windows-x64); pass --run to write.",
      "| name    | verdict   |",
      "| ------- | --------- |",
      "| NZ-NNR1 | would-add |",
      "| NZ-NNR2 | would-add |",
      "would run: gh api --method POST repos/zheref/nen/actions/runners/100/labels -f 'labels[]=pool-windows-x64'",
      "would run: gh api --method POST repos/zheref/nen/actions/runners/101/labels -f 'labels[]=pool-windows-x64'",
    ]);
  });

  it("writes only the named runners with --run, reads every label back, and leaves one already carrying it alone", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }, { name: "NZ-NNR2", labels: LABELLED }, { name: "NZ-NNR3" }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: { stdout: labelsAnswer(LABELLED) } },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: labelsAnswer(LABELLED) } },
    );
    const report = relabelPool(s, TARGET, POLICY_, windows, ["NZ-NNR2", "NZ-NNR1"], true);
    expect(report.runners).toEqual([
      { name: "NZ-NNR2", id: 101, verdict: "already" },
      { name: "NZ-NNR1", id: 100, verdict: "added" },
    ]);
    expect(report.changed).toBe(1);
    expect(s.calls.map((call) => call.args.slice(0, 4).join(" "))).toEqual([
      "api --method GET repos/zheref/nen/actions/runners?per_page=100&page=1",
      "api --method POST repos/zheref/nen/actions/runners/100/labels",
      "api --method GET repos/zheref/nen/actions/runners/100/labels",
    ]);
    expect(renderRelabel(report, TARGET)[0]).toBe("1 runner(s) on zheref/nen now carry pool-windows-x64 (pool windows-x64); each read back.");
  });

  it("says nothing was written when every selected runner already carries the label (N7)", () => {
    const report = relabelPool(seams([{ name: "NZ-NNR1", labels: LABELLED }]), TARGET, POLICY_, windows, ["NZ-NNR1"], true);
    expect(report.changed).toBe(0);
    expect(renderRelabel(report, TARGET)[0]).toBe("every selected runner already carries pool-windows-x64; nothing written.");
  });

  it("is exit 1 when the read-back does not carry the label, naming what it read, plain (F3)", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: { stdout: "{}" } },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: labelsAnswer([...DEFAULTS, "x\u001b[2Ky"]) } },
    );
    const failure = caught(() => relabelPool(s, TARGET, POLICY_, windows, ["NZ-NNR1"], true));
    expect(failure.exitCode).toBe(1);
    expect(failure.message).toBe("added pool-windows-x64 to runner NZ-NNR1 on zheref/nen, and reading its labels back answered [self-hosted, Windows, X64, x[2Ky].");
  });

  it("says the POST was accepted when the read-back GET itself fails, at the read's exit code, naming runners already labelled (N3)", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }, { name: "NZ-NNR2" }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: {} },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: labelsAnswer(LABELLED) } },
      { match: at(addLabelArgv(TARGET, 101, "pool-windows-x64")), result: {} },
      { match: at(runnerLabelsArgv(TARGET, 101)), result: { code: 1, stderr: "gh: HTTP 502: Bad Gateway" } },
    );
    const failure = caught(() => relabelPool(s, TARGET, POLICY_, windows, ["NZ-NNR1", "NZ-NNR2"], true));
    expect(failure.exitCode).toBe(1);
    expect(failure.message).toMatch(/^the POST for NZ-NNR2 was accepted; its read-back failed: reading runner NZ-NNR2's labels failed on zheref\/nen: gh: HTTP 502: Bad Gateway\. Already labelled by this run: NZ-NNR1\.$/);
    const unstartable = seams([{ name: "NZ-NNR1" }], { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: {} }, { match: at(runnerLabelsArgv(TARGET, 100)), result: { spawnFailed: true } });
    expect(caught(() => relabelPool(unstartable, TARGET, POLICY_, windows, ["NZ-NNR1"], true)).exitCode).toBe(5);
  });

  it("names the 403 as needing admin, and which runners this run already labelled", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }, { name: "NZ-NNR2" }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: {} },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: labelsAnswer(LABELLED) } },
      { match: at(addLabelArgv(TARGET, 101, "pool-windows-x64")), result: { code: 1, stderr: "gh: Must have admin rights to Repository. (HTTP 403)" } },
    );
    const failure = caught(() => relabelPool(s, TARGET, POLICY_, windows, ["NZ-NNR1", "NZ-NNR2"], true));
    expect(failure.exitCode).toBe(1);
    expect(failure.message).toMatch(/adding pool-windows-x64 to runner NZ-NNR2 was refused \(403\): needs admin on zheref\/nen.*\(HTTP 403\)\. Already labelled by this run: NZ-NNR1\.$/);
  });

  it("refuses a read-back that is not a labels list", () => {
    const s = seams(
      [{ name: "NZ-NNR1" }],
      { match: at(addLabelArgv(TARGET, 100, "pool-windows-x64")), result: {} },
      { match: at(runnerLabelsArgv(TARGET, 100)), result: { stdout: "{}" } },
    );
    expect(() => relabelPool(s, TARGET, POLICY_, windows, ["NZ-NNR1"], true)).toThrow(/its read-back failed: .*answered without a 'labels' list/);
  });

  it("takes --runner names case-insensitively, once each", () => {
    const report = relabelPool(seams([{ name: "NZ-NNR1" }, { name: "NZ-NNR2" }]), TARGET, POLICY_, windows, ["nz-nnr2", "NZ-NNR2"], false);
    expect(report.selection).toBe("named");
    expect(report.runners).toEqual([{ name: "NZ-NNR2", id: 101, verdict: "would-add" }]);
  });

  it("refuses the whole call, writing nothing, when a named runner is missing, of another os, already in another pool, or carries a label the pool does not declare", () => {
    const s = seams([
      { name: "NZ-NNR1" },
      { name: "RJ2-NNR1", labels: ["self-hosted", "macOS", "ARM64"] },
      { name: "NZ-NNR3", labels: [...DEFAULTS, "pool-windows-x64-desktop"] },
      { name: "NZ-KWIR1", labels: [...DEFAULTS, "desktop"] },
      { name: "NZ-NNR5", labels: [...DEFAULTS, "gpu"] },
    ]);
    const message = caught(() => relabelPool(s, TARGET, PLAIN_AND_DESKTOP, PLAIN_AND_DESKTOP.pools[0]!, ["NZ-NNR1", "NZ-NNR9", "RJ2-NNR1", "NZ-NNR3", "NZ-KWIR1", "NZ-NNR5"], true)).message;
    expect(message).toMatch(/^no runner was relabelled for pool windows-x64: /);
    expect(message).toMatch(/NZ-NNR9 is not registered on zheref\/nen/);
    expect(message).toMatch(/RJ2-NNR1 lacks Windows, X64 of pool windows-x64's labels \[self-hosted, Windows, X64\], so it is not a runner of that pool/);
    expect(message).toMatch(/NZ-NNR3 already carries 'pool-windows-x64-desktop': a runner is in one pool/);
    expect(message).toMatch(/NZ-KWIR1 carries 'desktop', which is reserved for an interactive pool, and pool windows-x64 does not declare it: declare the interactive pool/);
    expect(message).toMatch(/NZ-NNR5 carries 'gpu', which pool windows-x64 does not declare/);
    expect(s.calls).toHaveLength(1);
  });

  // KroWindows' shape (Nobunaga N1, Feitan F2): with no interactive pool
  // declared, a desktop runner fits nothing -- not even by name.
  it("never admits a desktop runner into a plain-only pool, named or listed", () => {
    const rows = [{ name: "NZ-KWIR1" }, { name: "NZ-KWIR2", labels: [...DEFAULTS, "desktop"] }];
    const plain = PLAIN_ONLY.pools[0]!;
    expect(relabelPool(seams(rows), TARGET, PLAIN_ONLY, plain, null, false).runners).toEqual([{ name: "NZ-KWIR1", id: 100, verdict: "candidate" }]);
    const failure = caught(() => relabelPool(seams(rows), TARGET, PLAIN_ONLY, plain, ["NZ-KWIR2"], true));
    expect(failure.exitCode).toBe(1);
    expect(failure.message).toMatch(/NZ-KWIR2 carries 'desktop', which is reserved for an interactive pool, and pool windows-x64 does not declare it: declare the interactive pool/);
  });

  it("lists an unlabelled desktop runner as a candidate of the interactive pool only", () => {
    const rows = [{ name: "NZ-NNR1" }, { name: "NZ-KWIR1", labels: [...DEFAULTS, "desktop"] }];
    expect(relabelPool(seams(rows), TARGET, PLAIN_AND_DESKTOP, PLAIN_AND_DESKTOP.pools[1]!, null, false).runners).toEqual([{ name: "NZ-KWIR1", id: 101, verdict: "candidate" }]);
    expect(relabelPool(seams(rows), TARGET, PLAIN_AND_DESKTOP, PLAIN_AND_DESKTOP.pools[0]!, null, false).runners).toEqual([{ name: "NZ-NNR1", id: 100, verdict: "candidate" }]);
  });

  // Nobunaga R1: two pools declaring one label set. The safe default was
  // chosen -- refuse outright -- rather than an acknowledgement flag.
  describe("a runner that fits two pools sharing one label set (R1)", () => {
    const twin = policyOf(POLICY_BODY.pools[0]!, { ...POLICY_BODY.pools[0]!, id: "windows-two", preflightWorkflow: "two.yml" });
    const rows = [{ name: "NZ-NNR1" }, { name: "NZ-NNR2", labels: [...DEFAULTS, "pool-windows-two"] }];

    it("is listed as a candidate that also fits the other pool, and left off the then: line", () => {
      const report = relabelPool(seams(rows), TARGET, twin, twin.pools[0]!, null, false);
      expect(report.runners).toEqual([{ name: "NZ-NNR1", id: 100, verdict: "candidate", alsoFits: ["windows-two"] }]);
      const text = renderRelabel(report, TARGET);
      expect(text).toContain("| NZ-NNR1 | candidate (also fits windows-two) |");
      expect(text).toContain("1 runner(s) fit more than one pool and cannot be named: make those pools' declared labels differ first.");
      expect(text.some((line) => line.startsWith("then:"))).toBe(false);
    });

    it("is refused by name at exit 2, with --run or without, under either pool, writing nothing", () => {
      for (const [pool, run] of [[twin.pools[0]!, true], [twin.pools[1]!, true], [twin.pools[1]!, false]] as const) {
        const s = seams(rows);
        expect(() => relabelPool(s, TARGET, twin, pool, ["NZ-NNR1"], run)).toThrow(VerbUsageError);
        expect(() => relabelPool(seams(rows), TARGET, twin, pool, ["NZ-NNR1"], run)).toThrow(
          /NZ-NNR1 fits pool windows-(x64|two) and windows-(two|x64) -- those pools declare one label set, so a runner carrying it would belong to both\. Make their declared labels differ, then relabel\./,
        );
        expect(s.calls).toHaveLength(1);
      }
    });

    it("keeps an unambiguous candidate on the then: line beside an ambiguous one, and an already-labelled runner is not ambiguous", () => {
      const desktopTwin = policyOf(POLICY_BODY.pools[0]!, { ...POLICY_BODY.pools[0]!, id: "windows-two", preflightWorkflow: "two.yml" }, DESKTOP_POOL_BODY);
      const report = relabelPool(seams([{ name: "NZ-NNR1" }, { name: "NZ-KWIR1", labels: [...DEFAULTS, "desktop"] }]), TARGET, desktopTwin, desktopTwin.pools[2]!, null, false);
      expect(renderRelabel(report, TARGET).at(-1)).toBe("then: nen runner relabel --target zheref/nen --pool windows-x64-desktop --runner NZ-KWIR1 --run");
      expect(relabelPool(seams(rows), TARGET, twin, twin.pools[1]!, ["NZ-NNR2"], true).runners).toEqual([{ name: "NZ-NNR2", id: 101, verdict: "already" }]);
    });
  });

  it("prints GitHub's runner names plain on the human path, and keeps them raw in the report (F3)", () => {
    const evil = "NZ-NNR1\u001b[2K";
    const listed = relabelPool(seams([{ name: evil }]), TARGET, POLICY_, windows, null, false);
    expect(listed.runners[0]?.name).toBe(evil);
    const text = renderRelabel(listed, TARGET).join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("--runner 'NZ-NNR1[2K' --run");
    const named = relabelPool(seams([{ name: evil }]), TARGET, POLICY_, windows, [evil], false);
    expect(renderRelabel(named, TARGET).join("\n")).not.toContain("\u001b");
    const refused = caught(() => relabelPool(seams([{ name: evil, labels: [...DEFAULTS, "gp\u001b[1Au"] }]), TARGET, POLICY_, windows, [evil], true));
    expect(refused.message).not.toContain("\u001b");
    expect(refused.message).toContain("NZ-NNR1[2K carries 'gp[1Au'");
  });

  it("says there is nothing to do when no runner is a candidate", () => {
    const report = relabelPool(seams([{ name: "RJ2-NNR1", labels: ["self-hosted", "macOS", "ARM64"] }]), TARGET, POLICY_, windows, null, false);
    expect(report.runners).toEqual([]);
    expect(renderRelabel(report, TARGET)).toEqual([
      "no runner on zheref/nen is a candidate for pool-windows-x64: none fits pool windows-x64's declared labels exactly without a pool label. Nothing to do.",
    ]);
  });
});
