// src/spec/diff.ts -- `nen spec diff`: two inventories of one member, compared
// by stable row id (zheref/nen#493 AC-5).
//
// THE SHA IS NOT A CHANGE. Every row of a later inventory carries a later
// commit, so comparing `sha` would report every row changed on every
// recapture and hide the rows that did. A row is `changed` when its kind,
// path, line range, excerpt hash, tier or rule id differs; the two commits are
// reported once, at the top. Identical inputs -- or inputs differing only in
// their commit -- produce an empty diff.

import { readFileSync } from "node:fs";
import { SPEC_INVENTORY_CONTRACT, type InventoryRow } from "./inventory.js";

export const SPEC_DIFF_CONTRACT = "nen.spec.diff/v0.1";

export type DiffVerdict = "identical" | "differs" | "could-not-read";
const COMPARED = ["kind", "path", "lines", "excerptSha256", "tier", "ruleId"] as const;

export interface LoadedInventory {
  readonly file: string;
  readonly origin: string | null;
  readonly scenario: string | null;
  readonly sha: string | null;
  readonly rows: readonly InventoryRow[];
}

export class InventoryReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryReadError";
  }
}

/** An inventory file `spec inventory` wrote, held to its row shape; anything else is InventoryReadError. */
export function loadInventory(file: string): LoadedInventory {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new InventoryReadError(`could not read ${file} as JSON: ${(error as Error).message}`);
  }
  const doc = raw as Record<string, unknown> | null;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new InventoryReadError(`${file} is not a JSON object`);
  if (doc["contract"] !== SPEC_INVENTORY_CONTRACT) throw new InventoryReadError(`${file} is not a ${SPEC_INVENTORY_CONTRACT} document (contract ${JSON.stringify(doc["contract"] ?? null)})`);
  if (doc["verdict"] === "could-not-read") throw new InventoryReadError(`${file} records an inventory that could not be read (${String(doc["reason"] ?? "no reason")}); it holds no rows to compare`);
  if (!Array.isArray(doc["rows"])) throw new InventoryReadError(`${file} carries no rows[] list`);
  const ids = new Set<string>();
  const rows = (doc["rows"] as unknown[]).map((entry, index): InventoryRow => {
    const row = entry as Record<string, unknown> | null;
    const lines = row?.["lines"];
    const ok =
      row !== null &&
      typeof row["id"] === "string" &&
      typeof row["kind"] === "string" &&
      typeof row["path"] === "string" &&
      Array.isArray(lines) &&
      lines.length === 2 &&
      lines.every((value): boolean => Number.isSafeInteger(value)) &&
      typeof row["sha"] === "string" &&
      typeof row["excerptSha256"] === "string" &&
      (row["tier"] === "declared" || row["tier"] === "observed") &&
      (row["ruleId"] === null || typeof row["ruleId"] === "string");
    if (!ok) throw new InventoryReadError(`${file} rows[${index}] is not {id, kind, path, lines: [l1, l2], sha, excerptSha256, tier, ruleId}`);
    if (ids.has(row["id"] as string)) throw new InventoryReadError(`${file} carries row id '${String(row["id"])}' twice; a stable id names one row`);
    ids.add(row["id"] as string);
    return row as unknown as InventoryRow;
  });
  const text = (key: string): string | null => (typeof doc[key] === "string" ? (doc[key] as string) : null);
  return { file, origin: text("origin"), scenario: text("scenario"), sha: text("sha"), rows };
}

export interface ChangedRow {
  readonly id: string;
  readonly fields: Readonly<Record<string, { readonly from: unknown; readonly to: unknown }>>;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface SpecDiffReport {
  readonly contract: string;
  readonly verdict: DiffVerdict;
  readonly from: { readonly file: string; readonly sha: string | null };
  readonly to: { readonly file: string; readonly sha: string | null };
  readonly origin: string | null;
  readonly added: readonly InventoryRow[];
  readonly removed: readonly InventoryRow[];
  readonly changed: readonly ChangedRow[];
  readonly counts: { readonly added: number; readonly removed: number; readonly changed: number; readonly unchanged: number };
  readonly reason: string | null;
}

export function diffInventories(from: LoadedInventory, to: LoadedInventory): SpecDiffReport {
  const before = new Map(from.rows.map((row): [string, InventoryRow] => [row.id, row]));
  const after = new Map(to.rows.map((row): [string, InventoryRow] => [row.id, row]));
  const added = to.rows.filter((row): boolean => !before.has(row.id)).sort((a, b): number => a.id.localeCompare(b.id));
  const removed = from.rows.filter((row): boolean => !after.has(row.id)).sort((a, b): number => a.id.localeCompare(b.id));
  const changed: ChangedRow[] = [];
  let unchanged = 0;
  for (const row of [...after.values()].sort((a, b): number => a.id.localeCompare(b.id))) {
    const old = before.get(row.id);
    if (old === undefined) continue;
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of COMPARED) if (JSON.stringify(old[key]) !== JSON.stringify(row[key])) fields[key] = { from: old[key], to: row[key] };
    if (Object.keys(fields).length === 0) unchanged += 1;
    else changed.push({ id: row.id, fields });
  }
  const differs = added.length + removed.length + changed.length > 0;
  return {
    contract: SPEC_DIFF_CONTRACT,
    verdict: differs ? "differs" : "identical",
    from: { file: from.file, sha: from.sha },
    to: { file: to.file, sha: to.sha },
    origin: to.origin ?? from.origin,
    added,
    removed,
    changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length, unchanged },
    reason: null,
  };
}

export function unreadableDiff(from: string, to: string, reason: string): SpecDiffReport {
  return { contract: SPEC_DIFF_CONTRACT, verdict: "could-not-read", from: { file: from, sha: null }, to: { file: to, sha: null }, origin: null, added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0, unchanged: 0 }, reason };
}

export function renderDiff(report: SpecDiffReport): string[] {
  if (report.verdict === "could-not-read") return [`could-not-read: ${report.reason ?? ""}`];
  const lines = [
    `${report.verdict}: ${report.origin ?? "(no origin)"} ${report.from.sha?.slice(0, 12) ?? "?"} -> ${report.to.sha?.slice(0, 12) ?? "?"} -- ${report.counts.added} added, ${report.counts.removed} removed, ${report.counts.changed} changed, ${report.counts.unchanged} unchanged`,
  ];
  for (const row of report.added) lines.push(`  + ${row.id}`);
  for (const row of report.removed) lines.push(`  - ${row.id}`);
  for (const row of report.changed) lines.push(`  ~ ${row.id} (${Object.keys(row.fields).join(", ")})`);
  return lines;
}
