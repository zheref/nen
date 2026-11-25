// Record the runner's resolved limit, after CLI/configuration precedence.
// No environment dump: worker count and its configuration chain are sufficient.
import { parseCLI, type TestProject } from "vitest/node";

export function workerBudgetSource(fileParallelism: unknown, argv: readonly string[], environmentOverride: boolean): string {
  // Vitest 4 applies its environment override last, including after the
  // fileParallelism=false cap. Read only its presence, never print its bytes.
  if (environmentOverride) return "VITEST_MAX_WORKERS";
  if (fileParallelism === false) return "fileParallelism=false";
  try {
    const { options } = parseCLI(["vitest", ...argv], { allowUnknownOptions: true });
    if (options.maxWorkers !== undefined) return "--maxWorkers";
  } catch {
    return "Vitest resolved configuration (CLI provenance unread)";
  }
  // The public resolved config does not distinguish a config file from API
  // options. Do not infer provenance merely because its value equals two.
  return "Vitest configuration/API (repository default: vitest.config.ts)";
}

export function workerBudgetLine(maxWorkers: number, source: string): string {
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1) {
    throw new Error("nen test workers: resolved maxWorkers must be a positive safe integer");
  }
  return `nen test workers: maxWorkers=${maxWorkers}; source=${source}; scope=test workers only, not subprocesses or host capacity`;
}

export default function setup(project: TestProject): void {
  // A programmatic caller's flags are not necessarily Vitest flags.
  const nativeCli = /(?:^|[/\\])vitest(?:\.m?js)?$/.test(process.argv[1] ?? "");
  // The pinned runner retains explicit fileParallelism input at runtime but
  // omits it from ResolvedConfig's type. Absence is unknown, never false.
  const source = workerBudgetSource(Reflect.get(project.globalConfig, "fileParallelism"), nativeCli ? process.argv.slice(2) : [], Boolean(process.env["VITEST_MAX_WORKERS"]));
  process.stderr.write(`${workerBudgetLine(project.globalConfig.maxWorkers, source)}\n`);
}
