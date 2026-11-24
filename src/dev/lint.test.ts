import { describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempdir.js";
import { devLintArgv, runDevLint } from "./lint.js";

// NOTE: mirrors ./test.test.ts's own note -- this suite never calls
// `runDevLint` in a way that would spawn eslint for real; what is tested is
// the argv mapping and the refusal path.

describe("devLintArgv", () => {
  it("runs the package script, so there is exactly one definition of the linter", () => {
    expect(devLintArgv()).toEqual(["run", "lint"]);
  });

  it("passes arguments through behind `--`, untouched", () => {
    expect(devLintArgv(["--fix"])).toEqual(["run", "lint", "--", "--fix"]);
  });
});

describe("runDevLint", () => {
  it("refuses a directory with no package.json, and says why a binary cannot do this", () => {
    const empty = makeTempDir("nen-dev-lint-");
    const result = runDevLint({ repoFlag: empty });
    expect(result.code).toBe(2);
    expect(result.message).toMatch(/no package\.json/);
    expect(result.message).toMatch(/a compiled binary has no linter to run/);
  });
});
