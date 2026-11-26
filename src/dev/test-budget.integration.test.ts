import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestBudget } from "./test-budget.js";

const root = process.cwd();
const contract = JSON.parse(readFileSync(join(root, "nen/contract.json"), "utf8")) as {
  project: { verbs: { nen: { test: { argv: string[]; select: { argv: string[] } } } } };
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Real pinned runner, tiny isolated source tree; never a nested Nen suite. */
function fixture(argv: string[], envChanges: Record<string, string | undefined> = {}): {
  status: number | null; stderr: string; receipts: TestBudget[]; dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "nen-budget-"));
  dirs.push(dir);
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/value.ts"), "export const value = 42;\n");
  writeFileSync(join(dir, "src/budget.test.ts"), `
import { expect, it } from ${JSON.stringify(join(root, "node_modules/vitest/dist/index.js"))};
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { value } from './value';
it('runs one trivial test and accounts for its child boundary', () => {
  expect(value).toBe(42);
  const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({pid:process.pid,parent:process.ppid}))'], {encoding:'utf8'});
  expect(child.status).toBe(0);
  const observed = JSON.parse(child.stdout);
  expect(observed.parent).toBe(process.pid);
  writeFileSync(${JSON.stringify(join(dir, "child.json"))}, JSON.stringify({worker:process.pid, child:observed}));
});
`);
  const config = join(dir, "vitest.config.ts");
  writeFileSync(config, `import base from ${JSON.stringify(join(root, "vitest.config.ts"))};
export default {...base, test:{...base.test, coverage:{include:['src/value.ts'], reportsDirectory:${JSON.stringify(join(dir, "coverage"))}}}};\n`);
  const env = { ...process.env };
  // The fixture owns its inputs; host legacy overrides must not silently
  // change the evidence these assertions are meant to prove.
  for (const key of ["VITEST_MIN_FORKS", "VITEST_MAX_FORKS", "VITEST_MIN_THREADS", "VITEST_MAX_THREADS"]) delete env[key];
  Object.assign(env, envChanges);
  // Preserve route flags while redirecting its JUnit artifact into the fixture.
  const isolatedArgv = argv.filter((arg) => !arg.startsWith("--outputFile.junit="));
  const result = spawnSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), ...isolatedArgv,
    "--root", dir, "--config", config, "--outputFile.junit", join(dir, "result.junit.xml")], { cwd: root, env, encoding: "utf8" });
  const receipts = result.stderr.split("\n").filter((line) => line.startsWith("nen-test-budget "))
    .map((line): TestBudget => JSON.parse(line.slice("nen-test-budget ".length)) as TestBudget);
  return { status: result.status, stderr: result.stderr, receipts, dir };
}

describe("bounded defaults through real declared Vitest routes", () => {
  it.each(["focused", "coverage"] as const)("proves the effective default through the %s argv with its reporter overrides", (route) => {
    const test = contract.project.verbs.nen.test;
    const args = (route === "focused" ? test.select.argv : test.argv).slice(1);
    const result = fixture([...args, "src/budget.test.ts"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]?.min.value).toBe(2);
    expect(result.receipts[0]?.max.value).toBe(2);
    expect(result.receipts[0]?.max.source).toMatch(/vitest.config.ts:test.maxWorkers$/);
    expect(readFileSync(join(result.dir, "result.junit.xml"), "utf8")).toContain('failures="0"');
    expect(existsSync(join(result.dir, "coverage/lcov.info"))).toBe(route === "coverage");
    const child = JSON.parse(readFileSync(join(result.dir, "child.json"), "utf8")) as { worker: number; child: { parent: number; pid: number } };
    expect(child.child.parent).toBe(child.worker);
    expect(child.child.pid).not.toBe(child.worker);
  });

  it.each([
    { args: ["--minWorkers=1", "--maxWorkers=1"], env: {}, source: "CLI --maxWorkers" },
    { args: ["--minWorkers=2", "--maxWorkers=2", "--poolOptions.forks.minForks=1", "--poolOptions.forks.maxForks=1"], env: {}, source: "CLI --poolOptions.forks.maxForks" },
    { args: ["--minWorkers=2", "--maxWorkers=2", "--poolOptions.forks.minForks=2", "--poolOptions.forks.maxForks=2"], env: { VITEST_MIN_FORKS: "1", VITEST_MAX_FORKS: "1" }, source: "environment VITEST_MAX_FORKS" },
  ])("proves precedence of $source in the pinned runner", ({ args, env, source }) => {
    const result = fixture(["run", "src/budget.test.ts", ...args], env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.receipts[0]?.max).toEqual({ value: 1, source });
  });

  it("refuses malformed environment settings before any fixture test or coverage is accepted", () => {
    const result = fixture(["run", "--coverage"], { VITEST_MAX_FORKS: "2junk" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("positive finite integer");
    expect(result.receipts).toEqual([]);
    expect(existsSync(join(result.dir, "child.json"))).toBe(false);
    expect(existsSync(join(result.dir, "coverage/lcov.info"))).toBe(false);
  });
});
