import { describe, expect, it } from "vitest";
import { testBudget, type BudgetConfig } from "./test-budget.js";

const source = "/fixture/vitest.config.ts";
const configured: BudgetConfig = { minWorkers: 2, maxWorkers: 2 };
const baseline: BudgetConfig = { ...configured, pool: "forks", fileParallelism: true };

describe("effective Vitest worker evidence", () => {
  it("records the explicit shared default and the host-workload boundary", () => {
    const receipt = testBudget(baseline, configured, {}, {}, source);
    expect(receipt.min).toEqual({ value: 2, source: `${source}:test.minWorkers` });
    expect(receipt.max).toEqual({ value: 2, source: `${source}:test.maxWorkers` });
    expect(receipt.boundary).toContain("subprocesses remain part of the admitted host workload");
    expect(receipt.boundary).toContain("host admission still applies");
  });

  it("records a narrower explicit CLI override", () => {
    const cli = { minWorkers: 1, maxWorkers: 1 };
    const receipt = testBudget({ ...baseline, ...cli }, configured, cli, {}, source);
    expect(receipt.min).toEqual({ value: 1, source: "CLI --minWorkers" });
    expect(receipt.max).toEqual({ value: 1, source: "CLI --maxWorkers" });
  });

  it("reports higher-priority environment and pool settings instead of claiming top-level limits", () => {
    const cli = { minWorkers: 3, maxWorkers: 3, poolOptions: { forks: { minForks: 4, maxForks: 4 } } };
    const env = { VITEST_MIN_FORKS: "1", VITEST_MAX_FORKS: "1" };
    const receipt = testBudget({ ...baseline, ...cli, poolOptions: { forks: { minForks: 1, maxForks: 1 } } }, configured, cli, env, source);
    expect(receipt.min).toEqual({ value: 1, source: "environment VITEST_MIN_FORKS" });
    expect(receipt.max).toEqual({ value: 1, source: "environment VITEST_MAX_FORKS" });
    expect(receipt.overrides).toContainEqual({ value: 4, source: "CLI --poolOptions.forks.maxForks" });
  });

  it("uses the thread-specific resolver and ignores fork environment variables for a thread pool", () => {
    const receipt = testBudget({ ...baseline, pool: "threads", poolOptions: { threads: { minThreads: 1, maxThreads: 1 } } }, configured,
      { pool: "threads", poolOptions: { threads: { minThreads: 1, maxThreads: 1 } } }, { VITEST_MAX_FORKS: "7" }, source);
    expect(receipt.max).toEqual({ value: 1, source: "CLI --poolOptions.threads.maxThreads" });
  });

  it.each([0, -1, 1.5, Infinity, NaN, "2junk", "50%", "0", "1.5"])("refuses invalid or CPU-relative budget %s", (value) => {
    expect(() => testBudget({ ...baseline, maxWorkers: value }, configured, { maxWorkers: value }, {}, source)).toThrow(/positive finite integer/);
  });

  it("refuses malformed environment input even if the pinned runner truncates it", () => {
    expect(() => testBudget({ ...baseline, poolOptions: { forks: { maxForks: 2 } } }, configured, {}, { VITEST_MAX_FORKS: "2junk" }, source)).toThrow(/positive finite integer/);
  });

  it("refuses a reversed budget and unexplained effective settings", () => {
    expect(() => testBudget({ ...baseline, minWorkers: 3 }, configured, { minWorkers: 3 }, {}, source)).toThrow(/minimum exceeds maximum/);
    expect(() => testBudget({ ...baseline, maxWorkers: 7 }, configured, {}, {}, source)).toThrow(/resolved to 7/);
  });

  it("records actual serialized concurrency", () => {
    expect(testBudget({ ...baseline, fileParallelism: false, minWorkers: 1, maxWorkers: 1 }, configured, { fileParallelism: false }, {}, source).max.value).toBe(1);
    expect(testBudget({ ...baseline, poolOptions: { forks: { singleFork: true } } }, configured, { poolOptions: { forks: { singleFork: true } } }, {}, source).max.value).toBe(1);
  });

  it.each([{ pool: "vmForks" }, { poolMatchGlobs: [["**", "threads"]] }])("refuses an unverified pool topology %j", (extra) => {
    expect(() => testBudget({ ...baseline, ...extra }, configured, {}, {}, source)).toThrow(/unverified pool|mixed pools/);
  });
});
