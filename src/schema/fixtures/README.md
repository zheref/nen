# Test fixtures

Three fake repository roots. Two carry a migrated `nen/` directory; the third
deliberately still carries `schemas/`.

These are **test data, not shipped code**. They deliberately contain concrete
persona, label and check-name strings — that is the point of them: the loaders
and the readiness predicates are proved to follow whatever the target
repository's files say, and you cannot prove that without two files that say
different things.

- `bankai-repo/nen/` — the vocabulary of the live system nen serves today
  (`bankai:*` labels, the reviewer identities the CON-32 predicates were ported
  from). `src/gates/predicates.test.ts` runs the ported cases against it, so a
  behavioural divergence from the original shell/TypeScript gate shows up as a
  failing test.
- `alt-repo/nen/` — a *different* vocabulary (`akatsuki:*` labels, different
  reviewer names, different check names, different colours). Nothing in the
  shipped tree knows any of these strings. Every accessor and predicate that
  works against `bankai-repo/` must work identically against this one; where a
  test asserts the same behaviour against both, that pair IS the proof that the
  names are data.
- `legacy-repo/schemas/` — **not migrated**, and nothing under `nen/`. A copy of
  `bankai-repo`'s four taxonomy files at the pre-v0.3 location, so the
  `schemas/` fallback is exercised by a real repository root rather than by a
  temp directory a test builds. It is the ONLY thing in this tree keeping the
  old layout alive, which is what makes the v0.4.0 removal a deletion of one
  directory and one map in `src/schema/source.ts` — with a test that goes red if
  anything else still depends on it.

Nothing under this directory is linted (`eslint.config.js` ignores
`**/fixtures/**`) or type-checked, and the taxonomy-purity sweep in
`src/taxonomy-purity.test.ts` excludes it by name.
