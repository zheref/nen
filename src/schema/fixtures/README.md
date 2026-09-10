# Test fixtures

Seven fake repository roots. Two carry a migrated `nen/` directory; the third
deliberately still carries `schemas/`; the last four carry only a contract — one
for the executor, one for the toolchain check, one for the coverage parse, one
for the test-report parse.

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
  four taxonomy files as `bankai-repo`, at the pre-v0.3 location. Through v0.4.0
  it proved the `schemas/` fallback; that fallback is removed in v0.5.0, and
  this fixture now proves the OPPOSITE fact instead -- every taxonomy-reading
  verb refuses this repository exactly as it would refuse one with no taxonomy
  at all, and the refusal names the migration (`nen scaffold init
  --accept-detected`). It stays a fixture, rather than a temp directory a test
  builds, so that refusal is proved against a real repository root. (The
  `LEGACY_LOCATION` map in `src/schema/source.ts` survives the same release,
  for the same reason: it is no longer a search order, but it is still how the
  refusal names the file it found and how `nen scaffold init` knows which four
  files to copy.)

- `shu-repo/nen/contract.json` — a **`project`-only** contract, and the one the
  `nen shu` executor is proved against. It is shaped after the Next.js product
  repository in [zheref/nen#91](https://github.com/zheref/nen/issues/91)'s
  design — a two-step lint, a multi-package coverage run, `unsupported`
  archive/release/deploy — using this fixture's own placeholder workspace names.
  Three lanes on different stacks, preconditions in all four states (satisfied
  path, satisfiable env, absent path, a kind nen cannot assert), one per-verb
  host restriction, one unsubstitutable placeholder, and one declared env value
  that must never appear in any output nen produces. The third lane, `pages`,
  is the one that CAN deploy, and it exists so that `--target` has somewhere to
  land: `web`'s `deploy` is an `unsupported` SEAT on purpose, and the pair is
  what proves the order the executor resolves a destination in — a seat answers
  exit 4 with its own reason whatever `--target` says, while a runnable row with
  no target is exit 2 naming what is declared. Its `targets` block carries all
  four shapes and is written **out of byte order**, so a listing nen prints
  sorted is provably sorted rather than provably echoed: a target that appends
  arguments and requires one variable, one that requires two (declared out of
  order, so the report's sort shows), a name-only one that appends nothing, and
  one that is `unsupported` because that destination has no command line at all.
  The variables its targets require are named and never valued anywhere in the
  file — the declared env VALUE on the deploy row is a separate, non-credential
  setting, so "a value never appears in any output" and "a credential is never
  in the declaration" are two facts a test can tell apart. It carries no taxonomy
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
  one's `coverage` row declares **no** `artifacts` and a stale **`report`** key
  from an earlier draft of the design, which are the two "nothing to parse"
  cases this verb must answer for (and the second must be *named* in the
  refusal, not silently ignored — that row's own `why` says so). This one
  carries five lanes, one per answer: `web` declares an artifact that **is** a
  report nen reads (and `coverage/coverage-summary.json` is committed beside it,
  so the parse runs end to end), `core` declares no artifact at all, `native`
  declares a real file in no format nen reads, `gone` declares a report that is
  not on disk, and `mixed` declares two artifacts of which only the **second**
  is a report (`coverage/lcov.info`, also committed). Its three stacks
  (`nextjs`, `xcode-ios`, `gatsby`) are chosen so the advisory the refusal
  quotes differs per lane — one stack has a conventional report location and the
  others say why they have none.

- `shu-test-report-repo/nen/contract.json` — the repository `nen shu
  test-report` is proved against, and the one fixture here that declares **no
  row for the verb it is about**: that verb runs `project.verbs.<lane>.test` and
  reads *that* row's `artifacts`, because a repository which has said how its
  tests run has said enough. Nine lanes, one per answer: `web` declares a report
  nen parses (committed beside it, so the parse runs end to end), `core`
  declares no artifact at all, `native` declares the **two-step** shape this
  family means by *declared* — a build step and a vendor extraction step the
  repository named, writing the JSON nen reads, because nen spawns no extraction
  of its own — `droid` declares a **directory** of one XML file per suite,
  `mixed` declares two decoys before the real report (an unrecognised extension
  and an extension-less **binary**, which is what makes the artifact choice two
  passes rather than one), `gone` declares a report that is not on disk, `stray`
  a directory holding XML that is not a test report, `noxml` a directory holding
  no XML at all, and `untested` declares a `build` and no `test` whatever.

The marker trees `nen shu detect` scans are a different kind of input and live
separately, at `src/shu/fixtures/` — see that directory's own README; the
coverage REPORT fixtures the five parsers are proved against live at
`src/shu/fixtures/coverage/`, and the test REPORT fixtures the three parsers are
proved against at `src/shu/fixtures/test-report/`. Both have a README too.

Nothing under this directory is linted (`eslint.config.js` ignores
`**/fixtures/**`) or type-checked, and the taxonomy-purity sweep in
`src/taxonomy-purity.test.ts` excludes it by name.
