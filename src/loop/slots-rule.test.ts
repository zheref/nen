// src/loop/slots-rule.test.ts -- monitor.localSlotFrees (HR-5): when a LOCAL
// slot frees is the repository's declaration, read by `nen loop slots`.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { loopCommand } from "./command.js";
import { computeSlots, occupancy, parseEfforts, type Effort } from "./slots.js";

const local = (over: Partial<Effort>): Effort => ({ id: "a", plane: "local", prOpen: true, ready: false, prompted: false, ...over });

describe("occupancy under each local rule", () => {
  it("ready+prompted (the default) is the rule it always was", () => {
    expect(occupancy(local({ ready: true, prompted: true })).occupied).toBe(false);
    expect(occupancy(local({ ready: true, prompted: true }), "ready+prompted").occupied).toBe(false);
    expect(occupancy(local({ stacked: true })).occupied).toBe(true);
  });

  it("merged holds a ready-and-prompted PR until it merges", () => {
    expect(occupancy(local({ ready: true, prompted: true }), "merged").occupied).toBe(true);
    expect(occupancy(local({ ready: true, prompted: true }), "merged").why).toMatch(/only on merge/);
    expect(occupancy(local({ merged: true }), "merged").occupied).toBe(false);
  });

  it("stacked-open frees an open stacked PR, and leaves an unstacked one on ready+prompted", () => {
    expect(occupancy(local({ stacked: true }), "stacked-open").occupied).toBe(false);
    expect(occupancy(local({ stacked: true, prOpen: false }), "stacked-open").occupied).toBe(true);
    expect(occupancy(local({}), "stacked-open").occupied).toBe(true);
    expect(occupancy(local({ ready: true, prompted: true }), "stacked-open").occupied).toBe(false);
  });

  it("never touches the CI plane, which frees at PR-open under every rule", () => {
    const ci: Effort = { id: "c", plane: "ci", prOpen: true, ready: false, prompted: false };
    expect(occupancy(ci, "merged").occupied).toBe(false);
  });

  it("computeSlots applies the rule to the local plane", () => {
    const report = computeSlots([local({ ready: true, prompted: true })], { ci: 2, local: 1 }, "merged");
    expect(report.local.occupied).toBe(1);
    expect(report.local.binding).toBe(true);
  });

  it("frees a local effort with no PR once it is merged locally, under every rule, and holds an unmerged one (zheref/nen#521)", () => {
    for (const rule of ["ready+prompted", "stacked-open", "merged"] as const) {
      expect(occupancy(local({ prOpen: false, merged: true }), rule).occupied).toBe(false);
      expect(occupancy(local({ prOpen: false }), rule)).toEqual({ occupied: true, why: "authored locally, no PR yet" });
    }
    expect(occupancy(local({ prOpen: false, merged: true }), "ready+prompted").why).toMatch(/merged locally with no PR/);
  });

  it("parseEfforts reads merged and stacked, absent as false", () => {
    const parsed = parseEfforts(JSON.stringify([{ id: "a", plane: "local", merged: true }, { id: "b", plane: "local", stacked: true }, { id: "c", plane: "local" }]));
    expect(parsed.efforts.map((e) => [e.merged, e.stacked])).toEqual([[true, false], [false, true], [false, false]]);
  });
});

async function capture(argv: readonly string[], repoFlag: string, json = false): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("loop slots makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("no watched form");
    },
    platform: "linux",
  };
  const code = await runFamily(loopCommand, argv, repoFlag, json, io, seams);
  return { code, out, err };
}

function repo(workflow: unknown | undefined, efforts: unknown): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-slots-"));
  mkdirSync(join(root, "nen"));
  if (workflow !== undefined) writeFileSync(join(root, "nen", "workflow.json"), typeof workflow === "string" ? workflow : JSON.stringify(workflow));
  const path = join(root, "efforts.json");
  writeFileSync(path, JSON.stringify(efforts));
  return { root, path };
}

describe("nen loop slots reads monitor.localSlotFrees from --repo", () => {
  const efforts = [{ id: "a", plane: "local", prOpen: true, ready: true, prompted: true }];

  it("states the default and its source when undeclared", async () => {
    const { root, path } = repo(undefined, efforts);
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "1"], root);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("local slot frees: ready+prompted (default (neither idle.localSlotFrees nor monitor.localSlotFrees declared))");
  });

  it("holds a ready-and-prompted slot under a declared merged rule, and says where the rule came from", async () => {
    const { root, path } = repo({ monitor: { localSlotFrees: "merged" } }, efforts);
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "1"], root, true);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out.join("\n")) as { local: { occupied: number }; localSlotFrees: { rule: string; source: string } };
    expect(doc.local.occupied).toBe(1);
    expect(doc.localSlotFrees.rule).toBe("merged");
    expect(doc.localSlotFrees.source).toMatch(/monitor.localSlotFrees$/);
  });

  it("a workflow.json that will not load is exit 1, never the default", async () => {
    const { root, path } = repo({ monitor: { localSlotFrees: "whenever" } }, efforts);
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "1"], root);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read nen\/workflow.json for the local slot rule/);
  });
});

describe("nen loop slots under Hatsu's committed nen/workflow.json (idle.localSlotFrees: merged)", () => {
  it("holds a ready-and-prompted local PR until it merges: the idle profile's rule, not the default", async () => {
    const repo = join(process.cwd(), "src", "loop", "fixtures", "hatsu-workflow");
    const dir = mkdtempSync(join(tmpdir(), "nen-slots-hatsu-"));
    writeFileSync(join(dir, "efforts.json"), JSON.stringify([{ id: "a", plane: "local", prOpen: true, ready: true, prompted: true }]));
    const result = await capture(["loop", "slots", "--efforts", join(dir, "efforts.json"), "--local-cap", "1"], repo, true);
    expect(result.err).toEqual([]);
    const doc = JSON.parse(result.out.join("\n")) as { localSlotFrees: { rule: string; source: string }; local: { occupied: number }; done: string[] };
    expect(doc.localSlotFrees.rule).toBe("merged");
    expect(doc.localSlotFrees.source).toMatch(/idle\.localSlotFrees$/);
    expect(doc.local.occupied).toBe(1);
    expect(doc.done).toEqual([]);
  });
});


describe("the per-effort line names the key the rule came from", () => {
  it("idle.localSlotFrees is named when the rule was read there", () => {
    expect(occupancy(local({}), "merged", "idle.localSlotFrees").why).toContain("(idle.localSlotFrees: merged)");
    expect(computeSlots([local({})], { ci: 1, local: 1 }, "merged", "idle.localSlotFrees").local.holding[0]?.why).toContain("idle.localSlotFrees");
    expect(occupancy(local({}), "merged").why).toContain("(monitor.localSlotFrees: merged)");
  });
});
