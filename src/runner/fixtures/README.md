# runner fixtures

- `runners.json`, `downloads.json` -- recorded answers of
  `GET /repos/zheref/nen/actions/runners` and `.../actions/runners/downloads`
  (2026-09-30, read-only). Tests feed them through `ScriptedSeams`; no test
  opens a socket.
- `runner-preflight.template.yml` -- the candidate of Hatsu's
  `templates/runner-preflight.yml` that `nen runner workflow` renders. Nen
  carries the renderer; the template ships in Hatsu.
- `*.golden*` -- byte-for-byte renderings, versioned `0.0.0-test` so a release
  does not move them. Regenerate with `NEN_UPDATE_GOLDEN=1 bunx vitest run src/runner`.
