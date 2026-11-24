// src/quality/command.ts -- `nen quality tooling|perf-compare|method-check`.

import { readFileSync } from "node:fs";
import { resolveRepoRoot } from "../repo/root.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { parseToolingTable, resolveTooling } from "./tooling.js";
import { compareBudgets, parsePerfCeilings, type PerfCeilings } from "./ceilings.js";
import { plainLine } from "../cli/plain.js";
import { validateMethodBlock, type MethodBlock } from "./method.js";

const USAGE = `nen quality -- tooling lookup, perf-budget comparison, method-block validation.

usage:
  nen quality tooling --table <path.json> --scenario <name>
      Looks up e2e/adversarial/perf tooling for --scenario in the caller-
      supplied table (the target repository's own manifest -- never a table
      shipped in this binary). Exits 1 when the scenario has no entry.

  nen quality perf-compare --metric <name> --baseline <n> --measured <n> [--ceilings <path.json>]
      QA-13's own thresholds: >10% median regression is high, >25% is
      critical, regression-relative to --baseline. Lower is better for every
      one of the fixed seven metrics. Exits 1 when severity is high or
      critical. Optional --ceilings declares {source, ceilings: [{metric,
      ceiling, unit}]}; exact metric matches compare --measured in that unit.
      Reports absolute within/breached/no-ceiling independently; a breach
      exits 1. A zero baseline still emits the absolute verdict, with a null
      percentage/severity and its refusal reason, and exits 1.

  nen quality method-check --input <path.json>
      Validates a QA-15 method block: device/OS stated, Release config with no
      debugger, sample size >=5 with the first discarded, median and p90
      reported, thermal and network conditions stated. Exits 1 on any gap.

  --repo <path>    The checkout that --table, --input and --ceilings resolve against.
                   Defaults to the current directory, so a call made from
                   anywhere else needs it: since zheref/nen#100 every path
                   flag on this verb resolves against this root, never
                   against the process's own directory.`;

export const qualityCommand: Command = {
  name: "quality",
  subcommands: ["tooling", "perf-compare", "method-check"],
  summary: "Scenario tooling lookup, perf-budget comparison, method-block validation.",
  usage: USAGE,
  flags: {
    values: ["table", "scenario", "metric", "baseline", "measured", "input", "ceilings"],
    booleans: [],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("quality", context.args, ["tooling", "perf-compare", "method-check"]);
    if (subcommand !== "perf-compare" && context.args.values["ceilings"] !== undefined) {
      throw new VerbUsageError("--ceilings is only valid with perf-compare.");
    }
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
  // RESOLVED OUTSIDE THE TRY (Copilot, PR #197). A malformed `--repo` throws a
  // RepoRootError, which ../index.ts maps to the usage exit 2 it is -- but only
  // if it is allowed to propagate. Inside the read's own catch it became exit 1
  // under a "could not read" message about a file nobody had a path to yet.
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  let table;
  try {
    table = parseToolingTable(readFileSync(resolveAgainstRepo(root, tablePath), "utf8"));
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
  if (baselineRaw.trim() === "" || measuredRaw.trim() === "" || !Number.isFinite(baseline) || !Number.isFinite(measured)) {
    throw new VerbUsageError("--baseline and --measured must be numbers.");
  }
  const ceilingsPath = context.args.values["ceilings"];
  let declaration: PerfCeilings | null = null;
  if (ceilingsPath !== undefined) {
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    try {
      declaration = parsePerfCeilings(readFileSync(resolveAgainstRepo(root, ceilingsPath), "utf8"));
    } catch (error) {
      throw new VerbUsageError(`could not read --ceilings '${plainLine(ceilingsPath)}': ${plainLine(String(error))}`);
    }
  }
  const result = compareBudgets(metric, baseline, measured, declaration);
  const exit = result.severity === "ok" && result.absolute.status !== "breached" ? 0 : 1;
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return exit;
  }
  context.io.out(result.regressionPct === null
    ? `${plainLine(result.metric)}: percentage refused -- ${result.percentageReason}`
    : `${plainLine(result.metric)}: ${result.regressionPct.toFixed(1)}% vs baseline -- ${result.severity}`);
  const absolute = result.absolute;
  context.io.out(absolute.status === "no-ceiling"
    ? `absolute: no ceiling applies${absolute.source === null ? " (no declaration)" : ` in ${plainLine(absolute.source)}`}`
    : `absolute: ${absolute.status} -- ${measured} ${plainLine(absolute.unit ?? "")} vs ceiling ${absolute.ceiling}; source: ${plainLine(absolute.source ?? "")}`);
  return exit;
}

function methodCheck(context: CommandContext): number {
  const path = context.args.values["input"];
  if (path === undefined) throw new VerbUsageError("quality method-check takes --input <path.json>.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  let block: MethodBlock;
  try {
    block = JSON.parse(
      readFileSync(resolveAgainstRepo(root, path), "utf8").replace(/\r\n/g, "\n"),
    ) as MethodBlock;
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
