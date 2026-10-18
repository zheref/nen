import { describe, expect, it } from "vitest";
import { parseMarker, STOP_MARK_CONTRACT, STOP_MARK_CONTRACT_V2 } from "./marker.js";

const v1 = { contract: STOP_MARK_CONTRACT, who: "k", gate: "G5", notified: false, at: "2026-01-01T00:00:00Z" };
const v2 = {
  ...v1, contract: STOP_MARK_CONTRACT_V2, title: null, body: null, reportUrl: null,
  options: [{ key: "A", label: "continue", command: "nen version", recommended: true }],
  proposedIssue: { title: "process gap", body: "evidence", labels: ["enhancement"] },
};

describe("the shared stop marker validator", () => {
  it.each([v1, v2, { ...v2, options: null, proposedIssue: null }])("accepts the existing contract without changing its document", (document) => {
    expect(parseMarker(document)).toEqual({ ok: true, marker: document });
  });

  it.each([v1, v2])("requires precisely the version's top-level keys", (document) => {
    for (const key of Object.keys(document)) {
      const incomplete: Record<string, unknown> = { ...document };
      delete incomplete[key];
      expect(parseMarker(incomplete).ok).toBe(false);
    }
    expect(parseMarker({ ...document, extra: null })).toEqual({ ok: false, reason: expect.stringContaining("unexpected key") });
  });

  it.each([
    null, [], "marker", { ...v1, contract: "hatsu.stop-marker/v0.1" },
    { ...v1, who: 7 }, { ...v1, gate: "G9" }, { ...v1, notified: "false" }, { ...v1, at: "not a date" },
    { ...v2, title: 7 }, { ...v2, body: false }, { ...v2, reportUrl: [] },
    { ...v2, options: [] },
    { ...v2, options: [{ key: "A", label: "read the report", command: "open report", recommended: true }] },
    { ...v2, options: [{ key: "A", label: "continue", command: "", recommended: true }] },
    { ...v2, options: [null] },
    { ...v2, options: [{ key: "", label: "continue", command: "x", recommended: true }] },
    { ...v2, options: [{ key: "A", label: "", command: "x", recommended: true }] },
    { ...v2, options: [{ key: "A", label: "continue", command: "x", consequence: false, recommended: true }] },
    { ...v2, options: [{ key: "A", label: "continue", command: "x", recommended: "yes" }] },
    { ...v2, options: [{ key: "A", label: "continue", command: "x" }] },
    { ...v2, options: [
      { key: "A", label: "continue", command: "x", recommended: true },
      { key: "A", label: "inspect", command: "y" },
    ] },
    { ...v2, proposedIssue: [] },
    { ...v2, proposedIssue: { title: "", body: "evidence" } },
    { ...v2, proposedIssue: { title: "missing body" } },
    { ...v2, proposedIssue: { title: "gap", body: "evidence", labels: [7] } },
  ])("refuses malformed or foreign marker data %#", (document) => {
    expect(parseMarker(document).ok).toBe(false);
  });
});
