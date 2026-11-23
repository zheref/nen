import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./tempdir.js";
import { openTempSandbox, pidAlive, removeTree, SANDBOX_PREFIX, sweepStaleSandboxes, TEMP_VARIABLES } from "./temp-sandbox.js";

describe("the run's temp sandbox (zheref/nen#635)", () => {
  it("binds every temp variable to a directory under the base and puts them back on close", () => {
    const base = makeTempDir("nen-sbx-base-");
    const env: Record<string, string | undefined> = { TMPDIR: "/before/a", TMP: undefined, TEMP: "/before/c" };
    const sandbox = openTempSandbox(base, env);
    expect(basename(sandbox.dir).startsWith(`${SANDBOX_PREFIX}${process.pid}-`)).toBe(true);
    expect(sandbox.dir.startsWith(base)).toBe(true);
    for (const name of TEMP_VARIABLES) expect(env[name]).toBe(sandbox.dir);
    sandbox.close();
    expect(env).toEqual({ TMPDIR: "/before/a", TEMP: "/before/c" });
  });

  it("AC-1: removes the whole sandbox and counts what tests left in it", () => {
    const base = makeTempDir("nen-sbx-base-");
    const sandbox = openTempSandbox(base, {});
    mkdirSync(join(sandbox.dir, "nen-a"));
    writeFileSync(join(sandbox.dir, "nen-a", "file"), "x");
    mkdirSync(join(sandbox.dir, "nen-b"));
    expect(sandbox.close()).toEqual({ leftover: 2 });
    expect(existsSync(sandbox.dir)).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });

  it("AC-2: a run that failed after creating its temp dirs still removes them, read-only trees included", () => {
    const base = makeTempDir("nen-sbx-base-");
    const sandbox = openTempSandbox(base, {});
    const locked = join(sandbox.dir, "nen-locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    writeFileSync(join(locked, "inner", "file"), "x");
    chmodSync(join(locked, "inner"), 0o500);
    chmodSync(locked, 0o500);
    try {
      throw new Error("the test failed after creating its temp dir");
    } catch {
      // The teardown runs whatever the tests did.
    }
    sandbox.close();
    expect(existsSync(sandbox.dir)).toBe(false);
  });

  it("sweeps a dead run's sandbox and keeps a live one's and anything unrelated", () => {
    const base = makeTempDir("nen-sbx-base-");
    const dead = mkdtempSync(join(base, `${SANDBOX_PREFIX}999999-`));
    const live = mkdtempSync(join(base, `${SANDBOX_PREFIX}${process.pid}-`));
    const other = join(base, "nen-test-run-notapid");
    mkdirSync(other);
    expect(sweepStaleSandboxes(base, (pid) => pid === process.pid)).toBe(1);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("removeTree removes a read-only tree and a missing path alike", () => {
    const dir = makeTempDir("nen-sbx-rm-");
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "f"), "x");
    chmodSync(locked, 0o500);
    removeTree(locked);
    expect(existsSync(locked)).toBe(false);
    expect(() => removeTree(join(dir, "never-made"))).not.toThrow();
  });
});

describe("makeTempDir (zheref/nen#635)", () => {
  const made: string[] = [];

  it("creates the directory under the temp dir the run is bound to", () => {
    const dir = makeTempDir("nen-helper-");
    made.push(dir);
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(tmpdir())).toBe(true);
  });

  it("has removed the previous test's directory by the next test", () => {
    expect(made).toHaveLength(1);
    expect(existsSync(made[0] as string)).toBe(false);
  });
});
