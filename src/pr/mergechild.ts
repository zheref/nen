// Explicit opt-in child route; delivery's live guards remain shared and intact.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withLedgerLock, writeLedgerAtomically } from "../ledger/lock.js";
import { containedOn } from "../canon/paths.js";
import { mergeDelivery, type MergeDeliveryOptions, type MergeDeliveryOutcome } from "./mergedelivery.js";
export const CHILD_MERGE_LEDGER_CONTRACT = "nen.pr.child-merge-ledger/v0.1";
export interface ChildMergeRecord { readonly repo: string; readonly pr: number; readonly base: string; readonly judgedSha: string; readonly verdict: string; readonly at: string }
function append(root: string, record: ChildMergeRecord): string {
  const path = join(root, ".nen", "child-merges.json");
  const guard = (): void => { if (!containedOn(root, path, process.platform)) throw new Error("child merge ledger leaves repository through a symbolic link"); };
  guard();
  return withLedgerLock(path, (): string => {
    guard();
    const current: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { contract: CHILD_MERGE_LEDGER_CONTRACT, records: [] };
    if (current === null || typeof current !== "object" || (current as { contract?: unknown }).contract !== CHILD_MERGE_LEDGER_CONTRACT || !Array.isArray((current as { records?: unknown }).records)) throw new Error("child merge ledger is not a valid durable record");
    const records = (current as { records: unknown[] }).records;
    writeLedgerAtomically(path, { contract: CHILD_MERGE_LEDGER_CONTRACT, records: [...records, record] });
    return path;
  });
}
export async function mergeChild(options: MergeDeliveryOptions): Promise<MergeDeliveryOutcome & { readonly ledgerError?: string }> {
  let prepared: Omit<ChildMergeRecord, "verdict" | "at"> | null = null;
  const result = await mergeDelivery({ ...options, child: true, beforeMerge: (fact) => {
    prepared = { repo: fact.target, pr: fact.pr, base: fact.base, judgedSha: fact.judgedSha };
    append(options.root, { ...prepared, verdict: "ready: prepared for head-matched merge", at: options.seams.now().toISOString() });
  } });
  if (prepared !== null && result.report.ran) {
    try {
      const path = append(options.root, { ...(prepared as Omit<ChildMergeRecord, "verdict" | "at">), verdict: result.report.ok && result.report.state === "MERGED" ? "merged" : `merge not confirmed: ${result.report.state ?? "unreadable"}`, at: options.seams.now().toISOString() });
      return { report: result.report, lines: [...result.lines, `child merge ledger: ${path}`] };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { report: { ...result.report, ok: false }, lines: [...result.lines, `CHILD MERGE LEDGER FAILED AFTER MERGE ATTEMPT: ${why}; inspect PR state before retrying`], ledgerError: why };
    }
  }
  return result;
}
