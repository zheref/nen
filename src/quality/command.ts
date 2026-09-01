// src/quality/command.ts -- `nen quality tooling|perf-compare|method-check`.

import { readFileSync } from "node:fs";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { parseToolingTable, resolveTooling } from "./tooling.js";
import { comparePerf, PerfCompareError } from "./perf.js";
import { validateMethodBlock, type MethodBlock } from "./method.js";

const USAGE = `nen quality -- tooling lookup, perf-budget comparison, method-block validation.

usage:
  nen quality tooling --table <path.json> --scenario <name>
      Looks up e2e/adversarial/perf tooling for --scenario in the caller-
      supplied table (the target repository's own manifest -- never a table
      shipped in this binary). Exits 1 when the scenario has no entry.

  nen quality perf-compare --metric <name> --baseline <n> --measured <n>
      QA-13's own thresholds: >10% median regression is high, >25% is
      critical, regression-relative to --baseline. Lower is better for every
      one of the fixed seven metrics. Exits 1 when severity is high or
      critical.

  nen quality method-check --input <path.json>
      Validates a QA-15 method block: device/OS stated, Release config with no
      debugger, sample size >=5 with the first discarded, median and p90
      reported, thermal and network conditions stated. Exits 1 on any gap.`;

export const qualityCommand: Command = {
  name: "quality",
  summary: "Scenario tooling lookup, perf-budget comparison, method-block validation.",
  usage: USAGE,
  flags: {
    values: ["table", "scenario", "metric", "baseline", "measured", "input"],
    booleans: [],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("quality", context.args, ["tooling", "perf-compare", "method-check"]);
    if (subcommand === "tooling") return tooling(context);
    if (subcommand === "perf-compare") return perfCompare(context);
    return methodCheck(context);
  },
};

function tooling(context: CommandContext): number {
  const tablePath = context.args.values["table"];
  const scenario = context.args.values["scenario"];
  if (tablePath === undefined || scenario === undefined) {
    throw new VerbUsageError("quality tooling takes --table <path.json> and --scenario <name>.");
  }
  let table;
  try {
    table = parseToolingTable(readFileSync(tablePath, "utf8"));
  } catch (error) {
    context.io.err(`nen: could not read --table '${tablePath}': ${String(error)}`);
    return 1;
  }
  const result = resolveTooling(table, scenario);
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    context.io.err(`nen: ${result.reason}`);
    return 1;
  }
  context.io.out(`scenario: ${result.scenario}`);
  context.io.out(`  e2e: ${result.tooling?.e2e ?? "(none)"}`);
  context.io.out(`  adversarial: ${result.tooling?.adversarial ?? "(none)"}`);
  context.io.out(`  not used: ${result.tooling?.notUsed.join(", ") || "(none)"}`);
  context.io.out(`  perf harness: ${result.tooling?.perfHarness ?? "(none)"}`);
  context.io.out(`  perf diagnosis: ${result.tooling?.perfDiagnosis ?? "(none)"}`);
  return 0;
}

function perfCompare(context: CommandContext): number {
  const metric = context.args.values["metric"];
  const baselineRaw = context.args.values["baseline"];
  const measuredRaw = context.args.values["measured"];
  if (metric === undefined || baselineRaw === undefined || measuredRaw === undefined) {
    throw new VerbUsageError("quality perf-compare takes --metric <name> --baseline <n> --measured <n>.");
  }
  const baseline = Number(baselineRaw);
  const measured = Number(measuredRaw);
  if (!Number.isFinite(baseline) || !Number.isFinite(measured)) {
    throw new VerbUsageError("--baseline and --measured must be numbers.");
  }
  let result;
  try {
    result = comparePerf(metric, baseline, measured);
  } catch (error) {
    if (error instanceof PerfCompareError) {
      context.io.err(`nen: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.severity === "ok" ? 0 : 1;
  }
  context.io.out(`${result.metric}: ${result.regressionPct.toFixed(1)}% vs baseline -- ${result.severity}`);
  return result.severity === "ok" ? 0 : 1;
}

function methodCheck(context: CommandContext): number {
  const path = context.args.values["input"];
  if (path === undefined) throw new VerbUsageError("quality method-check takes --input <path.json>.");
  let block: MethodBlock;
  try {
    block = JSON.parse(readFileSync(path, "utf8").replace(/\r\n/g, "\n")) as MethodBlock;
  } catch (error) {
    context.io.err(`nen: could not read --input '${path}': ${String(error)}`);
    return 1;
  }
  const refusals = validateMethodBlock(block);
  if (context.json) {
    context.io.out(JSON.stringify({ ok: refusals.length === 0, refusals }, null, 2));
    return refusals.length === 0 ? 0 : 1;
  }
  if (refusals.length === 0) {
    context.io.out("OK -- method block is complete.");
    return 0;
  }
  for (const refusal of refusals) context.io.out(`gap: ${refusal}`);
  return 1;
}
