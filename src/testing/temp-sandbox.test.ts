import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import setup from "./global-setup.js";
import { cleanupTempDirs, makeTempDir } from "./tempdir.js";
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

  it("the teardown removes the sandbox whatever the tests left in it, read-only trees included", () => {
    const base = makeTempDir("nen-sbx-base-");
    const sandbox = openTempSandbox(base, {});
    const locked = join(sandbox.dir, "nen-locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    writeFileSync(join(locked, "inner", "file"), "x");
    chmodSync(join(locked, "inner"), 0o500);
    chmodSync(locked, 0o500);
    expect(sandbox.close()).toEqual({ leftover: 1 });
    expect(existsSync(sandbox.dir)).toBe(false);
  });

  it("sweeps a dead run's old sandbox and keeps a live one's, a fresh one's and anything unrelated", () => {
    const base = makeTempDir("nen-sbx-base-");
    const dead = mkdtempSync(join(base, `${SANDBOX_PREFIX}999999-`));
    const fresh = mkdtempSync(join(base, `${SANDBOX_PREFIX}999998-`));
    const live = mkdtempSync(join(base, `${SANDBOX_PREFIX}${process.pid}-`));
    const other = join(base, "nen-test-run-notapid");
    mkdirSync(other);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const dir of [dead, live, other]) utimesSync(dir, old, old);
    expect(sweepStaleSandboxes(base, (pid) => pid === process.pid)).toBe(1);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
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

describe("the globalSetup (zheref/nen#635)", () => {
  it("binds the temp variables for the run, reports what tests left and puts everything back", () => {
    const before = TEMP_VARIABLES.map((name) => process.env[name]);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const teardown = setup();
      const bound = process.env["TMPDIR"] as string;
      expect(bound).not.toBe(before[0]);
      expect(tmpdir().startsWith(bound.replace(/[\\/]$/, ""))).toBe(true);
      mkdirSync(join(bound, "nen-left-behind"));
      teardown();
      expect(existsSync(bound)).toBe(false);
      expect(TEMP_VARIABLES.map((name) => process.env[name])).toEqual(before);
      expect(write).toHaveBeenCalledWith(expect.stringMatching(/removed 1 entries the tests left behind/));
    } finally {
      write.mockRestore();
    }
  });
});

describe("makeTempDir (zheref/nen#635)", () => {
  // Made while the file is collected, long before any test runs: it must outlive the first test.
  const shared = makeTempDir("nen-helper-shared-");

  it("keeps a directory made at describe scope for the first test", () => {
    expect(existsSync(shared)).toBe(true);
  });

  it("keeps it for the second too", () => {
    expect(existsSync(shared)).toBe(true);
  });

  it("creates under the temp dir the run is bound to, and cleanupTempDirs (the afterAll hook) removes it", () => {
    const dir = makeTempDir("nen-helper-");
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(tmpdir())).toBe(true);
    cleanupTempDirs();
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(shared)).toBe(false);
  });
});
