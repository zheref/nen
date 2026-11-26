// Developer harness policy only; this module is never imported by the CLI.
export const TEST_WORKERS = 2;

export interface BudgetConfig {
  pool?: string;
  minWorkers?: unknown;
  maxWorkers?: unknown;
  fileParallelism?: boolean;
  poolOptions?: {
    forks?: { minForks?: unknown; maxForks?: unknown; singleFork?: boolean };
    threads?: { minThreads?: unknown; maxThreads?: unknown; singleThread?: boolean };
  };
  poolMatchGlobs?: unknown[];
}

interface Setting {
  value: number;
  source: string;
}

interface Candidate {
  value: unknown;
  source: string;
}

export interface TestBudget {
  contract: "nen.test-budget/v1";
  config: string;
  pool: string;
  poolSource: string;
  min: Setting;
  max: Setting;
  overrides: Candidate[];
  boundary: string;
}

function integer(value: unknown, source: string): number {
  const parsed = typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`test budget: ${source} must be a positive finite integer (no CPU percentages)`);
  }
  return parsed;
}

/** Check the actual resolved pool against the pinned runner's precedence. */
export function testBudget(resolved: BudgetConfig, configured: BudgetConfig, cli: BudgetConfig,
  env: Readonly<Record<string, string | undefined>>, configPath: string): TestBudget {
  const pool = resolved.pool;
  // Nen declares one fork pool. Other built-in modes need their own proven
  // resolver (notably Vitest 2.1.8 vmForks reads maxForks for BOTH bounds).
  if (pool !== "forks" && pool !== "threads") throw new Error(`test budget: unverified pool ${pool}`);
  if (pool !== (cli.pool ?? configured.pool ?? "forks")) throw new Error("test budget: unexplained selected pool");
  if (resolved.poolMatchGlobs?.length) throw new Error("test budget: mixed pools require separate effective receipts");
  const poolConfig = resolved.poolOptions?.[pool] as Record<string, unknown> | undefined;
  const overrides: Candidate[] = [];
  const singleKey = pool === "forks" ? "singleFork" : "singleThread";
  const configuredPool = configured.poolOptions?.[pool] as Record<string, unknown> | undefined;
  const cliPool = cli.poolOptions?.[pool] as Record<string, unknown> | undefined;
  let serialization: string | undefined;
  if (resolved.fileParallelism === false) {
    if ((cli.fileParallelism ?? configured.fileParallelism) !== false) throw new Error("test budget: unexplained fileParallelism override");
    serialization = cli.fileParallelism !== undefined ? "CLI --fileParallelism=false" : `${configPath}:test.fileParallelism=false`;
  } else if (poolConfig?.[singleKey] === true) {
    if ((cliPool?.[singleKey] ?? configuredPool?.[singleKey]) !== true) throw new Error("test budget: unexplained single-pool override");
    serialization = cliPool?.[singleKey] !== undefined ? `CLI --poolOptions.${pool}.${singleKey}=true` : `${configPath}:test.poolOptions.${pool}.${singleKey}=true`;
  }
  if (serialization) overrides.push({ value: 1, source: serialization });
  function setting(bound: "min" | "max"): Setting {
    const workerKey = `${bound}Workers` as "minWorkers" | "maxWorkers";
    const poolKey = `${bound}${pool === "forks" ? "Forks" : "Threads"}`;
    const envKey = `VITEST_${bound.toUpperCase()}_${pool === "forks" ? "FORKS" : "THREADS"}`;
    const candidates: Candidate[] = [
      { value: configured[workerKey], source: `${configPath}:test.${workerKey}` },
      { value: cli[workerKey], source: `CLI --${workerKey}` },
      { value: configuredPool?.[poolKey], source: `${configPath}:test.poolOptions.${pool}.${poolKey}` },
      { value: cliPool?.[poolKey], source: `CLI --poolOptions.${pool}.${poolKey}` },
      { value: env[envKey] || undefined, source: `environment ${envKey}` },
    ].filter((candidate): boolean => candidate.value !== undefined);
    for (const candidate of candidates) integer(candidate.value, candidate.source);
    const chosen = candidates.at(-1);
    if (!chosen) throw new Error(`test budget: ${workerKey} has no explicit configuration source`);
    const actual = integer(poolConfig?.[poolKey] ?? resolved[workerKey], `resolved ${pool}.${poolKey}`);
    const expected = integer(chosen.value, chosen.source);
    // A serialized pool overrides the requested concurrency. Still record its
    // requests, and never claim they are the actual concurrency.
    overrides.push(...candidates.slice(1));
    if (serialization) return { value: 1, source: serialization };
    if (actual !== expected) throw new Error(`test budget: ${workerKey} resolved to ${actual}, source ${chosen.source} requested ${expected}`);
    return { value: actual, source: chosen.source };
  }
  const min = setting("min");
  const max = setting("max");
  if (min.value > max.value) throw new Error("test budget: effective minimum exceeds maximum");
  return {
    contract: "nen.test-budget/v1", config: configPath, pool,
    poolSource: cli.pool !== undefined ? "CLI --pool" : configured.pool !== undefined ? `${configPath}:test.pool` : "Vitest 2.1.8 exported default",
    min, max, overrides,
    boundary: "Vitest pool concurrency per invocation only; test subprocesses remain part of the admitted host workload. No descendant, RSS, CPU or concurrent-job cap; host admission still applies.",
  };
}
