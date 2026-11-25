// vitest.config.ts -- the ONE test harness (D16: TypeScript + vitest only, no
// make, no bats, no pytest, no runtime python3, no jq/yq in an executed path).
//
// Tests live BESIDE their sources (`src/**/*.test.ts`), carried from
// bankai-core's cli/ layout: a predicate and the cases that pin its behaviour
// are read together or not at all.
//
// `dist/` is excluded because `bun build --compile` drops a sourcemap there and
// a stray match would make the harness's contents depend on whether somebody
// had built binaries locally -- a test run that differs between two clean
// checkouts is not a harness.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Shared by focused selection, full coverage and CI. This bounds test
    // workers only; subprocesses still belong to the admitted host workload.
    // Effective limits and host-admission boundary: docs/test-workers.md.
    maxWorkers: 2,
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Every temp directory a test makes lives in one sandbox that is removed when
    // the run ends, pass or fail (zheref/nen#635): see src/testing/temp-sandbox.ts.
    globalSetup: ["src/testing/worker-budget.ts", "src/testing/global-setup.ts"],
    // Deterministic ordering, so a failure reported by CI is reproducible by
    // name locally. Sequence, not parallelism, is what these tests need: they
    // are pure functions and a fixture directory, not a server.
    sequence: { shuffle: false },
    // The coverage report lists every source file, loaded by a test or not
    // (zheref/nen#598). vitest 4 dropped `coverage.all`: without `include` a
    // file no test imports is absent from the report instead of listed at 0%,
    // and a touched-file gate cannot measure a row that is not there. The
    // pattern also keeps imported JSON out of the report.
    coverage: { include: ["src/**/*.ts"] },
  },
});
