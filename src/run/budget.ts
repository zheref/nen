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
// MINUTES ARE WALL-CLOCK FROM THE MANIFEST'S `startedAt` (delivery round on
// zheref/nen#498, reading 4): `idle.budget.minutes` is Hatsu's catalogue row
// workflow.idle.budget.minutes, "wall-clock minutes an idle run may claim new
// efforts for, counted from the run manifest's startedAt", and nen reads the
// key the way its owner defines it. The minutes the efforts' usage ledgers
// self-report are summed and printed as `effortMinutes` -- information, never
// compared against the key (parallel efforts multiply them, silent ones zero
// them).
//
// TOKENS FAIL CLOSED. Every distinct effort id the manifest's PRs name, plus
// any `--effort` the caller adds for an effort still without a PR, is read
// from `.nen/usage/<effort>.json` under --repo exactly as `nen usage show`
// reads it. Tokens are input + output + cache read + cache write. The token
// sum is UNREAD -- verdict `unevaluated`, a claim refused, exit 1 -- when any
// entry was recorded `--not-reported`, when a recorded delivery PR names no
// effort, or when a delivery PR's effort has no usage ledger: an absent spend
// is never a zero spend (NN#490 AC-2). An effort named only by --effort with
// no ledger yet is listed under `noLedger`; a ledger that will not read is
// `unevaluated` too.

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
  /** `minutes` wall-clock since the manifest's startedAt; `tokens` null when the token sum is unread. */
  readonly spent: { readonly minutes: number; readonly tokens: number | null };
  /** The efforts' self-reported minutes, summed: information, never compared against the ceiling. */
  readonly effortMinutes: number;
  readonly efforts: readonly { readonly effort: string; readonly minutes: number; readonly tokens: number; readonly entries: number; readonly notReported: number }[];
  readonly noLedger: readonly string[];
  readonly unread: readonly { readonly effort: string; readonly reason: string }[];
  /** Why the token sum is unread; empty when it was read. */
  readonly tokensUnread: readonly string[];
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
  now: Date,
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
  const tokensUnread: string[] = [];
  for (const row of rows) if (row.notReported > 0) tokensUnread.push(`${row.effort} has ${row.notReported} entr${row.notReported === 1 ? "y" : "ies"} recorded --not-reported`);
  for (const pr of manifest.prs) {
    if (pr.kind !== "delivery") continue;
    if (pr.effort === null) tokensUnread.push(`delivery PR #${pr.pr} names no effort, so its spend has no ledger to read`);
    else if (noLedger.includes(pr.effort)) tokensUnread.push(`delivery PR #${pr.pr}'s effort ${pr.effort} has no usage ledger`);
  }
  for (const row of unread) tokensUnread.push(`could not read ${row.effort}'s usage ledger`);
  const elapsed = Math.max(0, Math.floor((now.getTime() - Date.parse(manifest.startedAt)) / 60_000));
  const tokens = tokensUnread.length > 0 ? null : rows.reduce((sum, row): number => sum + row.tokens, 0);
  const spent = { minutes: elapsed, tokens };
  const reasons: string[] = [];
  if (spent.minutes >= ceiling.minutes) reasons.push(`minutes ${spent.minutes} since ${manifest.startedAt} >= ${ceiling.minutes} (${ceiling.source.minutes})`);
  if (spent.tokens !== null && spent.tokens >= ceiling.tokens) reasons.push(`tokens ${spent.tokens} >= ${ceiling.tokens} (${ceiling.source.tokens})`);
  for (const why of tokensUnread) reasons.push(`token sum unread: ${why}`);
  const verdict: BudgetVerdict = tokensUnread.length > 0 ? "unevaluated" : reasons.length > 0 ? "reached" : "within";
  return {
    run: manifest.id,
    claim,
    verdict,
    granted: claim ? verdict === "within" : null,
    ceiling,
    spent,
    effortMinutes: rows.reduce((sum, row): number => sum + row.minutes, 0),
    efforts: rows,
    noLedger,
    unread,
    tokensUnread,
    reasons,
  };
}

export function renderBudget(report: BudgetReport): string[] {
  const lines = [
    `run ${report.run}: ${report.spent.minutes} min since start of ${report.ceiling.minutes} (${report.ceiling.source.minutes}), ${report.spent.tokens === null ? "tokens unread" : `${report.spent.tokens} tokens`} of ${report.ceiling.tokens} (${report.ceiling.source.tokens})`,
    `  effortMinutes: ${report.effortMinutes} (the efforts' own minutes, summed; information, not the budget)`,
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
