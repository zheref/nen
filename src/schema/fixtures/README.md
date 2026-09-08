# Test fixtures

Six fake repository roots. Two carry a migrated `nen/` directory; the third
deliberately still carries `schemas/`; the last three carry only a contract — one
for the executor, one for the toolchain check, one for the coverage parse.

These are **test data, not shipped code**. They deliberately contain concrete
persona, label and check-name strings — that is the point of them: the loaders
and the readiness predicates are proved to follow whatever the target
repository's files say, and you cannot prove that without two files that say
different things.

- `bankai-repo/nen/` — the vocabulary of the live system nen serves today
  (`bankai:*` labels, the reviewer identities the CON-32 predicates were ported
  from). `src/gates/predicates.test.ts` runs the ported cases against it, so a
  behavioural divergence from the original shell/TypeScript gate shows up as a
  failing test. It also carries a `nen/contract.json` with **both** blocks —
  `dependency` and `project` — using every field that schema declares.
- `alt-repo/nen/` — a *different* vocabulary (`akatsuki:*` labels, different
  reviewer names, different check names, different colours). Nothing in the
  shipped tree knows any of these strings. Every accessor and predicate that
  works against `bankai-repo/` must work identically against this one; where a
  test asserts the same behaviour against both, that pair IS the proof that the
  names are data. Its `nen/contract.json` carries **`dependency` only** — the
  shape a plugin repository has, and the proof the two blocks are independent.
- `legacy-repo/schemas/` — **not migrated**, and nothing under `nen/`. The same
  four taxonomy files as `bankai-repo`, at the pre-v0.3 location, so the
  `schemas/` fallback is exercised by a real repository root rather than by a
  temp directory a test builds. It is the ONLY thing in this tree keeping the
  old layout alive, which is what makes the v0.4.0 removal a deletion of one
  directory and one map in `src/schema/source.ts` — with a test that goes red if
  anything else still depends on it.

- `shu-repo/nen/contract.json` — a **`project`-only** contract, and the one the
  `nen shu` executor is proved against. It is shaped after the Next.js product
  repository in [zheref/nen#91](https://github.com/zheref/nen/issues/91)'s
  design — a two-step lint, a multi-package coverage run, `unsupported`
  archive/release/deploy — using this fixture's own placeholder workspace names.
  Two lanes on different stacks, preconditions in all four states (satisfied
  path, satisfiable env, absent path, a kind nen cannot assert), one per-verb
  host restriction, one unsubstitutable placeholder, and one declared env value
  that must never appear in any output nen produces. It carries no taxonomy
  files: a fixture that also had to be a valid taxonomy root would couple two
  suites that have nothing to do with each other. Its `deps/INSTALLED` is the
  file the satisfied `path` precondition asserts — named `deps/` rather than the
  obvious name because the obvious name is in this repository's `.gitignore`,
  and a fixture that cannot be committed proves nothing.

- `shu-tools-repo/nen/contract.json` — the repository `nen shu tools` is proved
  against, and the reason it is not folded into `shu-repo`: that one declares
  **no** `toolchain` and **no** `dependency`, which is what makes it the
  "nothing to check" case this verb must answer for. This one carries both — a
  `dependency` block for the `nen` row, and a `project.toolchain` covering all
  four `versionFrom` members and four installers between them (one nen runs,
  one declared and not enabled in this release, one with nothing to install,
  one verify-only). Its lane's stack is `nextjs`, so the advisory `packMinimum`
  column has a real profile to read; its `package.json` carries a
  `packageManager` pin that **agrees** with the declaration, so the
  cross-check has an agreeing case as well as the disagreeing one a test writes
  itself; and `sdk-root/` exists so the `path-exists` member has a path that is
  really there.

- `shu-coverage-repo/nen/contract.json` — the repository `nen shu coverage` is
  proved against, and the reason it is not folded into `shu-repo` either: that
  one's `coverage` row declares **no** `artifacts`, which is the "nothing to
  parse" case this verb must answer for. This one carries four lanes, one per
  answer: `web` declares an artifact that **is** a report nen reads (and
  `coverage/coverage-summary.json` is committed beside it, so the parse runs end
  to end), `core` declares no artifact at all, `native` declares a real file in
  no format nen reads, and `gone` declares a report that is not on disk. Its
  three stacks (`nextjs`, `xcode-ios`, `gatsby`) are chosen so the advisory the
  refusal quotes differs per lane — one stack has a conventional report location
  and the others say why they have none.

The marker trees `nen shu detect` scans are a different kind of input and live
separately, at `src/shu/fixtures/` — see that directory's own README; the
coverage REPORT fixtures the five parsers are proved against live at
`src/shu/fixtures/coverage/`, which has one too.

Nothing under this directory is linted (`eslint.config.js` ignores
`**/fixtures/**`) or type-checked, and the taxonomy-purity sweep in
`src/taxonomy-purity.test.ts` excludes it by name.
