import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devTestArgv, runDevTest } from "./test.js";

// NOTE: this suite deliberately never CALLS `runDevTest` in a way that would
// spawn the harness -- doing so from inside the harness would recurse. What is
// tested is the argv mapping and the refusal path, which is where the behaviour
// actually is.

describe("devTestArgv", () => {
  it("runs the package script, so there is exactly one definition of the harness", () => {
    expect(devTestArgv()).toEqual(["run", "test"]);
  });

  it("passes arguments through behind `--`, untouched", () => {
    expect(devTestArgv(["-t", "names are data", "--reporter", "verbose"])).toEqual([
      "run",
      "test",
      "--",
      "-t",
      "names are data",
      "--reporter",
      "verbose",
    ]);
  });
});

describe("runDevTest", () => {
  it("refuses a directory with no package.json, and says why a binary cannot do this", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-dev-"));
    const result = runDevTest({ repoFlag: empty });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/no package\.json/);
    expect(result.message).toMatch(/a compiled binary has no harness to run/);
  });
});
