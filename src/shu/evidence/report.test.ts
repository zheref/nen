import { describe, expect, it } from "vitest";
import type { EvidenceBlock } from "../../schema/contract.js";
import type { ChangedFile } from "./diff.js";
import { buildEvidenceReport, EVIDENCE_CONTRACT, renderEvidence } from "./report.js";

function evidence(overrides: Partial<EvidenceBlock> = {}): EvidenceBlock {
  return {
    globs: ["**/__Snapshots__/**/*.png"],
    mechanism: "public-mirror",
    scene: "{suite}-{scene}",
    suiteSuffix: "SnapshotTests",
    raw: {},
    ...overrides,
  };
}

const KRO_PATH =
  "Kro/Tests/DateTimeFieldSnapshotTests/__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.1.png";

describe("buildEvidenceReport", () => {
  it("carries the published contract string, base and mechanism through untouched", () => {
    const report = buildEvidenceReport(evidence(), "main", []);
    expect(report.contract).toBe(EVIDENCE_CONTRACT);
    expect(report.contract).toBe("nen.shu.evidence/v0.1");
    expect(report.base).toBe("main");
    expect(report.mechanism).toBe("public-mirror");
  });

  it("filters the changed set to the declared globs -- a non-matching file never appears", () => {
    const changed: ChangedFile[] = [
      { path: KRO_PATH, status: "added" },
      { path: "src/main.swift", status: "modified" },
    ];
    const report = buildEvidenceReport(evidence(), "main", changed);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.path).toBe(KRO_PATH);
  });

  it("derives suite and scene per row, in the shape the contract publishes", () => {
    const report = buildEvidenceReport(evidence(), "main", [{ path: KRO_PATH, status: "added" }]);
    expect(report.rows).toEqual([
      { suite: "DateTimeField", scene: "disabled", path: KRO_PATH, status: "added" },
    ]);
  });

  it("groups suite -> unique scenes, in first-seen order", () => {
    const changed: ChangedFile[] = [
      {
        path: "__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.png",
        status: "added",
      },
      {
        path: "__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_enabled.png",
        status: "added",
      },
      {
        // A second density of the SAME scene (an @2x-style rerecord) collapses
        // to one entry in `scenes`, even though it is still its own row.
        path: "__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_enabled.1.png",
        status: "modified",
      },
      {
        path: "__Snapshots__/DurationFieldSnapshotTests/test_snapshot_zero.png",
        status: "added",
      },
    ];
    const report = buildEvidenceReport(
      evidence({ globs: ["**/__Snapshots__/**/*.png"] }),
      "main",
      changed,
    );
    expect(report.rows).toHaveLength(4);
    expect(report.suites).toEqual([
      { suite: "DateTimeField", scenes: ["disabled", "enabled"] },
      { suite: "DurationField", scenes: ["zero"] },
    ]);
  });

  it("reports an empty rows and suites set for no matching change -- never an error", () => {
    const report = buildEvidenceReport(evidence(), "main", [
      { path: "README.md", status: "modified" },
    ]);
    expect(report.rows).toEqual([]);
    expect(report.suites).toEqual([]);
  });

  it("reports the mechanism the declaration states, whichever of the three it is", () => {
    for (const mechanism of ["public-mirror", "files-changed", "embedded"] as const) {
      const report = buildEvidenceReport(evidence({ mechanism }), "main", []);
      expect(report.mechanism, mechanism).toBe(mechanism);
    }
  });
});

describe("renderEvidence", () => {
  it("names the base range and says so in one line when nothing matched", () => {
    const report = buildEvidenceReport(evidence(), "main", []);
    expect(renderEvidence(report)).toEqual([
      "evidence: no changed file under project.evidence.globs against main...HEAD",
    ]);
  });

  it("renders one table per suite", () => {
    const changed: ChangedFile[] = [
      {
        path: "__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.png",
        status: "added",
      },
      {
        path: "__Snapshots__/DurationFieldSnapshotTests/test_snapshot_zero.png",
        status: "modified",
      },
    ];
    const report = buildEvidenceReport(evidence(), "v1.0.0", changed);
    const lines = renderEvidence(report);
    expect(lines[0]).toContain("2 changed files across 2 suites");
    expect(lines.some((line): boolean => line === "suite: DateTimeField")).toBe(true);
    expect(lines.some((line): boolean => line === "suite: DurationField")).toBe(true);
    expect(lines.some((line): boolean => line.includes("added") && line.includes("disabled"))).toBe(
      true,
    );
    expect(
      lines.some((line): boolean => line.includes("modified") && line.includes("zero")),
    ).toBe(true);
  });
});
