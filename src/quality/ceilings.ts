// Absolute budgets are caller declarations, not guesses from metric/tool names.
import { comparePerf, type PerfSeverity } from "./perf.js";

export interface PerfCeilings {
  readonly source: string;
  readonly ceilings: readonly { readonly metric: string; readonly ceiling: number; readonly unit: string }[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
}

/** Reject the whole declaration before judging any metric, including unused rows. */
export function parsePerfCeilings(raw: string): PerfCeilings {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || !text(value["source"]) || !Array.isArray(value["ceilings"])) {
    throw new Error("expected a nonempty source and a ceilings array");
  }
  const seen = new Set<string>();
  const ceilings = value["ceilings"].map((entry: unknown, index: number) => {
    if (!object(entry) || !text(entry["metric"]) || !text(entry["unit"]) ||
      typeof entry["ceiling"] !== "number" || !Number.isFinite(entry["ceiling"]) || entry["ceiling"] < 0) {
      throw new Error(`ceilings[${index}] needs a nonempty metric/unit and a finite nonnegative ceiling`);
    }
    if (seen.has(entry["metric"])) throw new Error(`duplicate ceiling metric '${entry["metric"]}'`);
    seen.add(entry["metric"]);
    return { metric: entry["metric"], ceiling: entry["ceiling"], unit: entry["unit"] };
  });
  return { source: value["source"], ceilings };
}

export interface BudgetComparison {
  readonly metric: string;
  readonly baseline: number;
  readonly measured: number;
  readonly regressionPct: number | null;
  readonly severity: PerfSeverity | null;
  readonly percentageReason: string | null;
  readonly absolute: {
    readonly status: "within" | "breached" | "no-ceiling";
    readonly ceiling: number | null;
    readonly unit: string | null;
    readonly source: string | null;
  };
}

export function compareBudgets(metric: string, baseline: number, measured: number, declaration: PerfCeilings | null): BudgetComparison {
  const relative = baseline === 0 ? null : comparePerf(metric, baseline, measured);
  const overflow = relative !== null && !Number.isFinite(relative.regressionPct);
  const ceiling = declaration?.ceilings.find((row): boolean => row.metric === metric);
  return {
    metric, baseline, measured,
    regressionPct: overflow ? null : relative?.regressionPct ?? null,
    severity: relative?.severity ?? null,
    percentageReason: relative === null ? "zero baseline: a percentage regression is undefined"
      : overflow ? "percentage exceeds the finite numeric range" : null,
    absolute: {
      status: ceiling === undefined ? "no-ceiling" : measured > ceiling.ceiling ? "breached" : "within",
      ceiling: ceiling?.ceiling ?? null,
      unit: ceiling?.unit ?? null,
      source: declaration?.source ?? null,
    },
  };
}
