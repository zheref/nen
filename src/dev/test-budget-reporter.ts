import type { Reporter } from "vitest/reporters";
import { parseCLI, type Vitest } from "vitest/node";
import { testBudget, type BudgetConfig } from "./test-budget.js";

/** Kept beside every explicit reporter selection, including JSON/JUnit routes. */
export default class TestBudgetReporter implements Reporter {
  onInit(ctx: Vitest): void {
    const cli = parseCLI(["vitest", ...process.argv.slice(2)]).options;
    const configured = (ctx.server.config as typeof ctx.server.config & { test?: BudgetConfig }).test;
    const configPath = ctx.server.config.configFile;
    if (!configured || !configPath) throw new Error("test budget: loaded configuration source is missing");
    if (ctx.projects.length !== 1) throw new Error("test budget: workspace pools need separate effective receipts");
    const receipt = testBudget(ctx.config, configured, cli, process.env, configPath);
    // stderr preserves machine-readable stdout and is retained in CI logs.
    process.stderr.write(`nen-test-budget ${JSON.stringify(receipt)}\n`);
  }
}
