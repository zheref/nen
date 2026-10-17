# runner fixtures

- `runners.json`, `downloads.json` -- recorded answers of
  `GET /repos/zheref/nen/actions/runners` and `.../actions/runners/downloads`
  (2026-09-30, read-only). Tests feed them through `ScriptedSeams`; no test
  opens a socket.
- `runner-preflight.template.yml` -- a byte-for-byte copy of Hatsu 0.111.2's
  `templates/runner-preflight.yml` (commit `815574e9d278bf8d72f5f60b33ed31ee242ebc40`) that `nen runner workflow` renders. Nen
  carries the renderer; the template ships in Hatsu.
- `*.golden*` -- byte-for-byte renderings, versioned `0.0.0-test` so a release
  does not move them. Regenerate with `NEN_UPDATE_GOLDEN=1 bunx vitest run src/runner`.
  The two bash renderings end `.txt`, not `.sh`: AK-11 (`src/pipeline.test.ts`)
  admits exactly one shell file in the repository, `bootstrap/nen.sh`, and a
  golden file is data, never a script anything runs.
