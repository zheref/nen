# Nen's test-worker budget

The repository's Vitest routes share `vitest.config.ts`'s explicit default of two
Vitest workers, including focused selection and full coverage. At startup the
runner prints its resolved `maxWorkers` and its source: `VITEST_MAX_WORKERS`,
`fileParallelism=false`, CLI `--maxWorkers`, or configuration/API options.
Vitest applies its environment override last. Its public resolved configuration
does not distinguish config-file values from programmatic API options; that
case is reported together, with the repository's default file named. CLI
provenance is used only for a recognized Vitest entry; a parsing failure is
reported as unread while retaining the runner's resolved count.
An explicit caller override, such as CI's Windows worker setting, is reflected
in the resolved count. Raw environment and argument values are not printed.

This limit covers Vitest workers only: tests can launch subprocesses. Workers
and their children remain part of one host workload; the limit does not grant
host capacity or replace the serialized host-admission fallback (#536).

A failed or interrupted coverage run is not verification. The coverage
consumer continues to refuse failed commands and missing reports; a saved
artifact must also have valid source-tree and configuration provenance before
measurement. Changing worker count does not waive these checks.
