import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig, type TestProject } from "vitest/node";
import { fileURLToPath } from "node:url";
import config from "../../vitest.config.js";
import setup, { workerBudgetLine, workerBudgetSource } from "./worker-budget.js";

describe("the test-worker budget", () => {
  const configPath = fileURLToPath(new URL("../../vitest.config.ts", import.meta.url));
  beforeEach(() => vi.stubEnv("VITEST_MAX_WORKERS", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it.each([false, true])("resolves a finite default with coverage=%s through the pinned runner", async (coverage) => {
    // Resolve the real repository configuration without starting nested workers.
    const { vitestConfig } = await resolveConfig({ config: configPath, coverage: { enabled: coverage } });
    expect(vitestConfig.maxWorkers).toBe(2);
    expect(workerBudgetLine(vitestConfig.maxWorkers, workerBudgetSource(true, ["run"], false))).toContain("maxWorkers=2;");
  });

  it("records the environment override even above a caller limit and disabled file parallelism", async () => {
    vi.stubEnv("VITEST_MAX_WORKERS", "3");
    const { vitestConfig } = await resolveConfig({ config: configPath, maxWorkers: 1, fileParallelism: false });
    expect(vitestConfig.maxWorkers).toBe(3);
    expect(workerBudgetSource(Reflect.get(vitestConfig, "fileParallelism"), ["run", "--maxWorkers=1"], true)).toBe("VITEST_MAX_WORKERS");
  });

  it("names file parallelism, CLI and config/API sources without guessing from the effective count", () => {
    expect(workerBudgetSource(false, ["run", "--maxWorkers=8"], false)).toBe("fileParallelism=false");
    expect(workerBudgetSource(true, ["run", "--maxWorkers", "2"], false)).toBe("--maxWorkers");
    expect(workerBudgetSource(true, ["run", "--max-workers=1"], false)).toBe("--maxWorkers");
    expect(workerBudgetSource(true, ["run"], false)).toBe("Vitest configuration/API (repository default: vitest.config.ts)");
  });

  it("identifies the pinned runner's explicit file-parallelism cap", async () => {
    const { vitestConfig } = await resolveConfig({ config: configPath, maxWorkers: 2, fileParallelism: false });
    expect(vitestConfig.maxWorkers).toBe(1);
    expect(workerBudgetSource(Reflect.get(vitestConfig, "fileParallelism"), ["run", "--maxWorkers=2"], false)).toBe("fileParallelism=false");
  });

  it("records a caller override after Vitest applies configuration precedence", async () => {
    const { vitestConfig } = await resolveConfig({ config: configPath, maxWorkers: 1 });
    expect(vitestConfig.maxWorkers).toBe(1);
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      setup({ globalConfig: vitestConfig } as TestProject);
      expect(output).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("maxWorkers=1;"));
    } finally {
      output.mockRestore();
    }
  });

  it("gives focused and full coverage the same finite default", () => {
    expect(config.test?.maxWorkers).toBe(2);
    expect(config.test?.globalSetup).toContain("src/testing/worker-budget.ts");
  });

  it("records the resolved count and the override chain without environment values", () => {
    expect(workerBudgetLine(8, "--maxWorkers")).toBe("nen test workers: maxWorkers=8; source=--maxWorkers; scope=test workers only, not subprocesses or host capacity");
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("refuses an invalid resolved limit: %s", (limit) => {
    expect(() => workerBudgetLine(limit, "Vitest configuration/API")).toThrow("positive safe integer");
  });
});
