### Fixed

- `bun run test` no longer leaves `nen-*` directories in the temp dir. The suite runs inside one sandbox directory that is removed when the run ends, pass or fail. `makeTempDir()` is the helper a test uses to make a temp directory, and `src/testing/temp-hygiene.test.ts` refuses a new test, test kit or fixture that calls `mkdtemp` directly, or an existing one that calls it more often than its recorded baseline.
