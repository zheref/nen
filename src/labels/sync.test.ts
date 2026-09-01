import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { parseLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";
import { createArgv, editArgv, syncLabels } from "./sync.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

function taxonomy(): LabelTaxonomy {
  return parseLabelTaxonomy("/x/schemas/labels.json", {
    labels: [
      { name: "a", color: "111111", description: "label a" },
      { name: "b", color: "222222", description: "label b" },
    ],
  });
}

describe("syncLabels -- create-or-update, one bad label isolated", () => {
  it("reports 'created' when the create call succeeds", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([
      { match: `gh ${createArgv(TARGET, t.labels[0] as never).join(" ")}`, result: {} },
      { match: `gh ${createArgv(TARGET, t.labels[1] as never).join(" ")}`, result: {} },
    ]);
    const report = syncLabels(seams, TARGET, t, false);
    expect(report.entries.every((e): boolean => e.status === "created")).toBe(true);
    expect(report.failed).toEqual([]);
  });

  it("falls back to edit when create fails (already exists)", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([
      { match: `gh ${createArgv(TARGET, t.labels[0] as never).join(" ")}`, result: { code: 1, stderr: "already exists" } },
      { match: `gh ${editArgv(TARGET, t.labels[0] as never).join(" ")}`, result: {} },
      { match: `gh ${createArgv(TARGET, t.labels[1] as never).join(" ")}`, result: {} },
    ]);
    const report = syncLabels(seams, TARGET, t, false);
    expect(report.entries[0]?.status).toBe("updated");
  });

  it("isolates a failing label -- every other good label still lands", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([
      { match: `gh ${createArgv(TARGET, t.labels[0] as never).join(" ")}`, result: { code: 1, stderr: "bad" } },
      { match: `gh ${editArgv(TARGET, t.labels[0] as never).join(" ")}`, result: { code: 1, stderr: "still bad" } },
      { match: `gh ${createArgv(TARGET, t.labels[1] as never).join(" ")}`, result: {} },
    ]);
    const report = syncLabels(seams, TARGET, t, false);
    expect(report.failed).toEqual(["a"]);
    expect(report.entries[1]?.status).toBe("created");
  });

  it("dry-run never calls gh", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([]);
    const report = syncLabels(seams, TARGET, t, true);
    expect(report.entries.every((e): boolean => e.status === "would-sync")).toBe(true);
    expect(seams.calls).toEqual([]);
  });
});
