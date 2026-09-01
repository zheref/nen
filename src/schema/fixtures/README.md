# Test fixtures

Two fake repository roots, each carrying a `schemas/` directory.

These are **test data, not shipped code**. They deliberately contain concrete
persona, label and check-name strings — that is the point of them: the loaders
and the readiness predicates are proved to follow whatever the target
repository's files say, and you cannot prove that without two files that say
different things.

- `bankai-repo/` — the vocabulary of the live system nen serves today
  (`bankai:*` labels, the reviewer identities the CON-32 predicates were ported
  from). `src/gates/predicates.test.ts` runs the ported cases against it, so a
  behavioural divergence from the original shell/TypeScript gate shows up as a
  failing test.
- `alt-repo/` — a *different* vocabulary (`akatsuki:*` labels, different
  reviewer names, different check names, different colours). Nothing in the
  shipped tree knows any of these strings. Every accessor and predicate that
  works against `bankai-repo/` must work identically against this one; where a
  test asserts the same behaviour against both, that pair IS the proof that the
  names are data.

Nothing under this directory is linted (`eslint.config.js` ignores
`**/fixtures/**`) or type-checked, and the taxonomy-purity sweep in
`src/taxonomy-purity.test.ts` excludes it by name.
