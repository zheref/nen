// src/run/budget.ts -- `nen run budget`: what a run's efforts have spent,
// against the ceiling the caller (or nen/workflow.json's `idle.budget`, HR-5)
// states, and -- under `--claim` -- the refusal to start one more effort once
// the ceiling is reached.
//
// THE LOOP CAP'S SHAPE (../loop/command.ts's `iterate`). Reaching the budget is
// exit 1: an ANSWER, not a failure -- the run asked whether it may claim more
// work and the answer is no. Nothing is written: the spend is the usage
// ledgers' (`nen usage record`), and the claim is a question asked of them.
//
// WHAT IS SUMMED. Every distinct effort id the manifest's PRs name, plus any
// `--effort` the caller adds for an effort still without a PR, read from
// `.nen/usage/<effort>.json` under --repo exactly as `nen usage show` reads it.
// Tokens are input + output + cache read + cache write -- every number the
// ledger holds, the reading that reaches the ceiling soonest. An effort with no
// ledger has recorded nothing and is listed under `noLedger`; a ledger that
// will not read is `unevaluated`, exit 1, never a zero.

import { usageLedgerPath, readUsageLedger, type UsageLedger } from "../usage/ledger.js";
import { totalsOf } from "../usage/command.js";
import { existsSync } from "node:fs";
import type { RunManifest } from "./manifest.js";

export type BudgetVerdict = "within" | "reached" | "unevaluated";

export interface BudgetCeiling {
  readonly minutes: number;
  readonly tokens: number;
  /** Where each ceiling came from: the flag, or the workflow's idle.budget. */
  readonly source: { readonly minutes: string; readonly tokens: string };
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface BudgetReport {
  readonly run: string;
  readonly claim: boolean;
  readonly verdict: BudgetVerdict;
  /** null unless --claim; true only when the verdict is `within`. */
  readonly granted: boolean | null;
  readonly ceiling: BudgetCeiling;
  readonly spent: { readonly minutes: number; readonly tokens: number };
  readonly efforts: readonly { readonly effort: string; readonly minutes: number; readonly tokens: number; readonly entries: number; readonly notReported: number }[];
  readonly noLedger: readonly string[];
  readonly unread: readonly { readonly effort: string; readonly reason: string }[];
  readonly reasons: readonly string[];
}

export function runEfforts(manifest: RunManifest, extra: readonly string[]): readonly string[] {
  const seen: string[] = [];
  for (const effort of [...manifest.prs.map((row): string | null => row.effort), ...extra]) {
    if (effort !== null && !seen.includes(effort)) seen.push(effort);
  }
  return seen;
}

export function computeBudget(
  manifest: RunManifest,
  root: string,
  efforts: readonly string[],
  ceiling: BudgetCeiling,
  claim: boolean,
  read: (path: string, effort: string) => UsageLedger = readUsageLedger,
): BudgetReport {
  const rows: BudgetReport["efforts"][number][] = [];
  const noLedger: string[] = [];
  const unread: { effort: string; reason: string }[] = [];
  for (const effort of efforts) {
    const path = usageLedgerPath(root, effort);
    if (!existsSync(path)) {
      noLedger.push(effort);
      continue;
    }
    let ledger: UsageLedger;
    try {
      ledger = read(path, effort);
    } catch (error) {
      unread.push({ effort, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const totals = totalsOf(ledger);
    rows.push({
      effort,
      minutes: totals.reduce((sum, t): number => sum + t.minutes, 0),
      tokens: totals.reduce((sum, t): number => sum + t.input + t.output + t.cacheRead + t.cacheWrite, 0),
      entries: totals.reduce((sum, t): number => sum + t.entries, 0),
      notReported: totals.reduce((sum, t): number => sum + t.notReported, 0),
    });
  }
  const spent = {
    minutes: rows.reduce((sum, row): number => sum + row.minutes, 0),
    tokens: rows.reduce((sum, row): number => sum + row.tokens, 0),
  };
  const reasons: string[] = [];
  if (spent.minutes >= ceiling.minutes) reasons.push(`minutes ${spent.minutes} >= ${ceiling.minutes} (${ceiling.source.minutes})`);
  if (spent.tokens >= ceiling.tokens) reasons.push(`tokens ${spent.tokens} >= ${ceiling.tokens} (${ceiling.source.tokens})`);
  for (const row of unread) reasons.push(`could not read ${row.effort}'s usage ledger`);
  const verdict: BudgetVerdict = unread.length > 0 ? "unevaluated" : reasons.length > 0 ? "reached" : "within";
  return {
    run: manifest.id,
    claim,
    verdict,
    granted: claim ? verdict === "within" : null,
    ceiling,
    spent,
    efforts: rows,
    noLedger,
    unread,
    reasons,
  };
}

export function renderBudget(report: BudgetReport): string[] {
  const lines = [
    `run ${report.run}: spent ${report.spent.minutes} min of ${report.ceiling.minutes} (${report.ceiling.source.minutes}), ${report.spent.tokens} tokens of ${report.ceiling.tokens} (${report.ceiling.source.tokens})`,
  ];
  for (const row of report.efforts) {
    lines.push(`  ${row.effort}: ${row.minutes} min, ${row.tokens} tokens (${row.entries} entr${row.entries === 1 ? "y" : "ies"}${row.notReported === 0 ? "" : `, ${row.notReported} not reported`})`);
  }
  for (const effort of report.noLedger) lines.push(`  ${effort}: no usage ledger -- nothing recorded`);
  for (const row of report.unread) lines.push(`  ${row.effort}: unread -- ${row.reason}`);
  const head = report.claim
    ? report.granted === true
      ? "claim: granted"
      : `claim: refused (${report.verdict})`
    : `budget: ${report.verdict}`;
  lines.push(report.reasons.length === 0 ? head : `${head} -- ${report.reasons.join("; ")}`);
  return lines;
}
