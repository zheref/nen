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
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    // Deterministic ordering, so a failure reported by CI is reproducible by
    // name locally. Sequence, not parallelism, is what these tests need: they
    // are pure functions and a fixture directory, not a server.
    sequence: { shuffle: false },
  },
});
