### Fixed

- `bun run test` no longer leaves `nen-*` directories in the temp dir. The suite runs inside one sandbox directory that is removed when the run ends, pass or fail, and a test file that makes a temp directory with a bare `mkdtemp` is now refused by `src/testing/temp-hygiene.test.ts` in favour of `makeTempDir()`.
