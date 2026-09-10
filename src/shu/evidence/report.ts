// src/shu/evidence/report.ts -- the document `nen shu evidence` emits: the
// changed-file set filtered to `project.evidence.globs`, each survivor's
// suite and scene derived, grouped suite -> scenes.
//
// PURE. No seam, no filesystem: ./diff.ts already turned git's answer into
// `ChangedFile[]`, and this module's whole job is the filter-derive-group step
// in between that and one document, which is what makes it independently
// testable against a hand-written changed-file list rather than a scripted git.

import type { EvidenceBlock, EvidenceMechanism } from "../../schema/contract.js";
import type { ChangedFile, EvidenceStatus } from "./diff.js";
import { matchesAnyGlob } from "./glob.js";
import { deriveSuiteAndScene } from "./scene.js";

export const EVIDENCE_CONTRACT = "nen.shu.evidence/v0.1";

/** KEY ORDER IS THE CONTRACT, and ./report.test.ts pins it. */
export interface EvidenceRow {
  readonly suite: string;
  readonly scene: string;
  readonly path: string;
  readonly status: EvidenceStatus;
}

export interface EvidenceSuite {
  readonly suite: string;
  /** Unique scenes under this suite, in first-seen (row) order. */
  readonly scenes: readonly string[];
}

export interface EvidenceReport {
  readonly contract: string;
  readonly base: string;
  readonly mechanism: EvidenceMechanism;
  readonly rows: readonly EvidenceRow[];
  readonly suites: readonly EvidenceSuite[];
}

/**
 * Filter the changed-file set to `evidence.globs`, derive `suite`/`scene` for
 * each survivor, and group suite -> scenes. An empty result -- no changed file
 * matched a glob -- is not a special case here or at the caller: it is the
 * same shape with empty arrays, and `nen shu command.ts` is what turns that
 * into exit 0 rather than an error (the brief's own "never an error" rule).
 */
export function buildEvidenceReport(
  evidence: EvidenceBlock,
  base: string,
  changed: readonly ChangedFile[],
): EvidenceReport {
  const rows: EvidenceRow[] = [];
  for (const file of changed) {
    if (!matchesAnyGlob(file.path, evidence.globs)) continue;
    const { suite, scene } = deriveSuiteAndScene(file.path, evidence.suiteSuffix);
    rows.push({ suite, scene, path: file.path, status: file.status });
  }

  // A Map preserves insertion order, which is what makes "first-seen order"
  // below a property of iterating it rather than something sorted in after.
  const bySuite = new Map<string, string[]>();
  for (const row of rows) {
    const scenes = bySuite.get(row.suite);
    if (scenes === undefined) {
      bySuite.set(row.suite, [row.scene]);
    } else if (!scenes.includes(row.scene)) {
      scenes.push(row.scene);
    }
  }
  const suites: EvidenceSuite[] = [...bySuite.entries()].map(
    ([suite, scenes]): EvidenceSuite => ({ suite, scenes }),
  );

  return { contract: EVIDENCE_CONTRACT, base, mechanism: evidence.mechanism, rows, suites };
}

function padColumn(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/**
 * The text rendering: one table per suite, exactly as the brief asks. An empty
 * report says so in one line, naming the base range that produced it -- never
 * a bare, ambiguous "no output at all".
 */
export function renderEvidence(report: EvidenceReport): readonly string[] {
  if (report.rows.length === 0) {
    return [
      `evidence: no changed file under project.evidence.globs against ${report.base}...HEAD`,
    ];
  }
  const lines: string[] = [
    `evidence: ${report.rows.length} changed file${report.rows.length === 1 ? "" : "s"} across ${report.suites.length} suite${report.suites.length === 1 ? "" : "s"} (${report.mechanism}), against ${report.base}...HEAD`,
  ];
  for (const suite of report.suites) {
    lines.push("");
    lines.push(`suite: ${suite.suite === "" ? "(none)" : suite.suite}`);
    for (const row of report.rows) {
      if (row.suite !== suite.suite) continue;
      lines.push(`  ${padColumn(row.status, 8)} ${padColumn(row.scene, 24)} ${row.path}`);
    }
  }
  return lines;
}
