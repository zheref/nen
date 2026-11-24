import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { parseLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";
import { createArgv, editArgv, listLabelsArgv, syncLabels } from "./sync.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };
const at = (argv: readonly string[]): string => `gh ${argv.join(" ")}`;
const read = (pages: unknown = [[]]): ScriptedCall => ({ match: at(listLabelsArgv(TARGET)), result: { stdout: JSON.stringify(pages) } });
function taxonomy(): LabelTaxonomy {
  return parseLabelTaxonomy("/x/nen/labels.json", { labels: [
    { name: "a", color: "abcdef", description: "label a" },
    { name: "b", color: "222222", description: "label b" },
  ] });
}

describe("syncLabels -- remote diff with progress and isolated failures", () => {
  it("creates only missing labels, leaving foreign labels untouched", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([read([[{ ...t.labels[0], color: "ABCDEF" }, { name: "foreign", color: "000000", description: null }]]),
      { match: at(createArgv(TARGET, t.labels[1]!)), result: {} }]);
    expect(syncLabels(seams, TARGET, t, false).entries.map((e) => e.status)).toEqual(["unchanged", "created"]);
    expect(seams.calls).toHaveLength(2);
  });
  it("updates differing color or description directly without a failed create", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([read([[{ ...t.labels[0], description: "old" }], [{ ...t.labels[1], color: "000000" }]]),
      ...t.labels.map((label) => ({ match: at(editArgv(TARGET, label)), result: {} }))]);
    expect(syncLabels(seams, TARGET, t, false).entries.map((e) => e.status)).toEqual(["updated", "updated"]);
  });
  it("continues after a failed create and emits progress before the next write", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([read(),
      { match: at(createArgv(TARGET, t.labels[0]!)), result: { code: 1, stderr: "bad" } },
      { match: at(createArgv(TARGET, t.labels[1]!)), result: {} }]);
    const progress: unknown[] = [];
    const report = syncLabels(seams, TARGET, t, false, (entry, done, total) => progress.push([entry.status, done, total, seams.calls.length]));
    expect(report.failed).toEqual(["a"]);
    expect(progress).toEqual([["failed", 1, 2, 2], ["created", 2, 2, 3]]);
  });
  it("continues after an update fails without retrying it as a create", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([read([[{ ...t.labels[0], description: "old" }]]),
      { match: at(editArgv(TARGET, t.labels[0]!)), result: { code: 1, stderr: "denied" } },
      { match: at(createArgv(TARGET, t.labels[1]!)), result: {} }]);
    const report = syncLabels(seams, TARGET, t, false);
    expect(report.failed).toEqual(["a"]);
    expect(report.entries.map((entry) => entry.status)).toEqual(["failed", "created"]);
    expect(seams.calls).toHaveLength(3);
  });
  it("dry-run reads remote state but never mutates", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([read([[t.labels[0]]])]);
    const report = syncLabels(seams, TARGET, t, true);
    expect(report.entries.map((e) => e.status)).toEqual(["unchanged", "would-sync"]);
    expect(report.entries[1]?.message).toMatch(/would create/);
    expect(seams.calls).toHaveLength(1);
  });
  it("dry-run diffs an update against the remote, naming only the fields that differ (zheref/nen#591)", () => {
    const t = taxonomy();
    const seams = new ScriptedSeams([read([[{ ...t.labels[0], color: "000000" }, { ...t.labels[1], description: null }]])]);
    const messages = syncLabels(seams, TARGET, t, true).entries.map((entry) => entry.message);
    expect(messages[0]).toBe("would update: a (#abcdef) -- label a  (was: color #000000)");
    expect(messages[1]).toBe('would update: b (#222222) -- label b  (was: description "")');
    expect(seams.calls).toHaveLength(1);
  });
  it("a no-op over 124 labels performs one paginated read and zero writes", () => {
    const labels = Array.from({ length: 124 }, (_, n) => ({ name: `label-${n}`, color: "abcdef", description: "declared label" }));
    const t = parseLabelTaxonomy("/x/labels.json", { labels });
    const seams = new ScriptedSeams([read([labels.slice(0, 100), labels.slice(100)])]);
    const progress: number[] = [];
    expect(syncLabels(seams, TARGET, t, false, (_, done) => progress.push(done)).entries.every((e) => e.status === "unchanged")).toBe(true);
    expect(progress).toHaveLength(124);
    expect(progress.at(-1)).toBe(124);
    expect(seams.calls).toHaveLength(1);
  });
  it("refuses malformed or failed reads before any mutation", () => {
    for (const value of [{}, [{}], [[{ name: "a", color: "abc" }]], [[null]], [[{ name: "a", color: "abcdef", description: null }, { name: "A", color: "abcdef", description: "" }]]]) {
      const seams = new ScriptedSeams([read(value)]);
      expect(() => syncLabels(seams, TARGET, taxonomy(), false)).toThrow(/remote labels/);
      expect(seams.calls).toHaveLength(1);
    }
    const seams = new ScriptedSeams([{ match: at(listLabelsArgv(TARGET)), result: { code: 1, stderr: "HTTP 403" } }]);
    expect(() => syncLabels(seams, TARGET, taxonomy(), false)).toThrow();
    expect(seams.calls).toHaveLength(1);
  });
});
