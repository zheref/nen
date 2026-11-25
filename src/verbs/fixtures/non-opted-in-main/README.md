# Non-opted-in readiness goldens (zheref/nen#663)

Generated FROM `origin/main` at `0101cbb0` (before the version-collision
limb existed), by copying `src/verbs/fixtures/pr_ready.golden-scenarios.ts`
unchanged to the same path in a detached worktree of that commit and running its scenarios through
`prReady` with the stub harness of `src/verbs/pr_ready.test.ts`.
`src/verbs/pr_ready.golden.test.ts` runs the same scenarios on this tree and
asserts byte equality with every file here.

Per scenario: `<name>.json` (`--json` stdout), `<name>.txt` (plain stdout),
`<name>.explain.txt` (`--explain` stdout), `<name>.exit.json` (exit code,
stderr and every file read at a commit, in order, of each -- the stub offers
none of the version-collision reads, so any would have failed loudly).

Normalised identically on both sides, and nothing else: the two temp paths
(`<GATES>`, `<ROOT>`), the build's version (`<VERSION>`), and the
`version_collision (nen >= …)` entry in the list of keys a build reads, which
only scenario `v` prints (inside the unknown-key refusal).

Release v0.31.0: regenerated the seven `--explain` outputs through the same
scenario harness, verifying that only `decided by nen 0.30.0` became
`decided by nen 0.31.0`. That provenance line is not normalized by the
harness; every other byte remains the baseline above.
