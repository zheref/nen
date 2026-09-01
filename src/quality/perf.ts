// src/quality/perf.ts -- performance-budget comparison, QA-13's own
// thresholds: >10% median regression is HIGH, >25% is CRITICAL, regression-
// relative to a recorded baseline.
//
// LOWER IS BETTER, for every one of the fixed seven metrics QA-11 names --
// cold launch, warm launch, frame hitches, memory high-water, artifact size,
// network payload/requests, longest main-thread block. A regression is
// therefore a MEASURED value higher than the BASELINE; an improvement (lower)
// is never flagged, which is why the severity floor is a positive percentage,
// not an absolute one.
//
// THE 10%/25% THRESHOLDS ARE A FIXED METHODOLOGY CONSTANT, not a repository's
// vocabulary -- the same footing as ../issue/search.ts's RECENTLY_CLOSED_DAYS
// or ../epic/waves.ts's BAR_WIDTH. Nothing about them names a persona, a
// label, a check or a colour, so they are written down here rather than
// threaded through as a flag nobody would ever want to change per repository.

export const HIGH_REGRESSION_PCT = 10;
export const CRITICAL_REGRESSION_PCT = 25;

export type PerfSeverity = "ok" | "high" | "critical";

export interface PerfComparison {
  readonly metric: string;
  readonly baseline: number;
  readonly measured: number;
  /** Positive is a regression (measured is worse -- higher); negative is an improvement. */
  readonly regressionPct: number;
  readonly severity: PerfSeverity;
}

export class PerfCompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerfCompareError";
  }
}

export function comparePerf(metric: string, baseline: number, measured: number): PerfComparison {
  if (baseline === 0) {
    throw new PerfCompareError(
      `'${metric}' has a zero baseline, so a percentage regression is not a defined number. Record a non-zero baseline, or compare the absolute values yourself.`,
    );
  }
  const regressionPct = ((measured - baseline) / Math.abs(baseline)) * 100;
  const severity: PerfSeverity =
    regressionPct > CRITICAL_REGRESSION_PCT ? "critical" : regressionPct > HIGH_REGRESSION_PCT ? "high" : "ok";
  return { metric, baseline, measured, regressionPct, severity };
}

export interface BaselineEntry {
  readonly metric: string;
  readonly value: number;
}

export function comparePerfBatch(
  baselines: readonly BaselineEntry[],
  measured: Readonly<Record<string, number>>,
): readonly PerfComparison[] {
  return baselines
    .filter((entry): boolean => Object.prototype.hasOwnProperty.call(measured, entry.metric))
    .map((entry): PerfComparison => comparePerf(entry.metric, entry.value, measured[entry.metric] as number));
}
