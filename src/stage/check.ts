// src/stage/check.ts -- `nen stage check --exclusive`: an issue carries at
// most one label of the STAGE family (SDD plan finding D9, autonomy-loop#7).
//
// WHY. The stage-label invariant -- one stage at a time -- was written down and
// explicitly unenforced, so an unattended run that applied `stage/building`
// without removing `stage/ready` left an issue in two stages, and every reader
// after it picked one. This reads the issue's live labels and the family the
// repository declares, and refuses (exit 1) when two coexist. Which stage is
// right is not nen's to say; it names both.
//
// THE FAMILY IS DATA. A stage label is any label `nen/labels.json` declares
// whose `<namespace>:<family>/<leaf>` family is `stage` (../schema/labels.ts's
// structural decomposition), in whatever namespace the repository spells it.
// A taxonomy that declares no stage label cannot be checked, and says so: it
// is never read as "exclusive".

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { decomposeLabelName, type LabelTaxonomy } from "../schema/labels.js";

export const STAGE_FAMILY = "stage";

export type StageVerdict = "exclusive" | "conflict" | "undeclared" | "unread";

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface StageCheckReport {
  readonly target: string;
  readonly issue: number;
  readonly verdict: StageVerdict;
  /** The stage labels nen/labels.json declares. */
  readonly family: readonly string[];
  /** The declared stage labels the issue carries now; empty when unread. */
  readonly present: readonly string[];
  /** Live labels shaped `<ns>:stage/<leaf>` that nen/labels.json does not declare. */
  readonly undeclaredPresent: readonly string[];
  readonly reason: string | null;
}

export function stageFamily(taxonomy: LabelTaxonomy): readonly string[] {
  return taxonomy.names().filter((name): boolean => decomposeLabelName(name).family === STAGE_FAMILY && decomposeLabelName(name).leaf !== null);
}

export function issueLabelsArgv(target: Target, issue: number): readonly string[] {
  return ["issue", "view", String(issue), "--repo", target.slug, "--json", "number,labels"];
}

export type LabelsRead = { readonly ok: true; readonly labels: readonly string[] } | { readonly ok: false; readonly reason: string };

export function readIssueLabels(seams: Seams, target: Target, issue: number): LabelsRead {
  const result = seams.run(GH, [...issueLabelsArgv(target, issue)]);
  if (result.spawnFailed) return { ok: false, reason: "gh could not be started" };
  if (result.code !== 0) return { ok: false, reason: outputLines(result.stderr).join(" ") || `gh exit ${result.code}` };
  let raw: { number?: unknown; labels?: unknown };
  try {
    raw = JSON.parse(result.stdout) as typeof raw;
  } catch {
    return { ok: false, reason: "gh answered with text that is not JSON" };
  }
  if (raw.number !== issue) return { ok: false, reason: `gh answered for ${JSON.stringify(raw.number)}, not #${issue}` };
  if (!Array.isArray(raw.labels)) return { ok: false, reason: "gh's answer carries no labels list" };
  const names: string[] = [];
  for (const label of raw.labels) {
    const name = (label as { name?: unknown } | null)?.name;
    if (typeof name !== "string") return { ok: false, reason: "a label in gh's answer has no name" };
    names.push(name);
  }
  return { ok: true, labels: names };
}

export function checkExclusive(target: Target, issue: number, family: readonly string[], read: LabelsRead): StageCheckReport {
  const make = (verdict: StageVerdict, present: readonly string[], undeclaredPresent: readonly string[], reason: string | null): StageCheckReport => ({
    target: target.slug,
    issue,
    verdict,
    family: [...family],
    present,
    undeclaredPresent,
    reason,
  });
  if (!read.ok) return make("unread", [], [], read.reason);
  const undeclaredPresent = read.labels.filter((name): boolean => decomposeLabelName(name).family === STAGE_FAMILY && !family.includes(name));
  if (family.length === 0) {
    return make("undeclared", [], undeclaredPresent, "nen/labels.json declares no '<namespace>:stage/<leaf>' label, so there is no family to hold the issue to");
  }
  const present = read.labels.filter((name): boolean => family.includes(name));
  // An undeclared `<ns>:stage/<leaf>` label on the issue is still a stage
  // someone applied; counted, so a typo'd or retired stage cannot hide a
  // second stage from the check.
  const all = [...present, ...undeclaredPresent];
  if (all.length > 1) {
    return make("conflict", present, undeclaredPresent, `${all.length} stage labels coexist (${all.join(", ")}); an issue is in one stage at a time, and which one is not nen's to pick`);
  }
  return make("exclusive", present, undeclaredPresent, null);
}

export function renderStageCheck(report: StageCheckReport): string[] {
  const lines = [`${report.target}#${report.issue}: ${report.verdict}${report.reason === null ? "" : ` -- ${report.reason}`}`];
  if (report.verdict === "exclusive") lines.push(`stage: ${report.present[0] ?? report.undeclaredPresent[0] ?? "(none)"}`);
  if (report.undeclaredPresent.length > 0) lines.push(`undeclared stage-shaped label(s): ${report.undeclaredPresent.join(", ")}`);
  return lines;
}
