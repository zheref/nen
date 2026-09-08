# `profiles/` — the reference pack

**Data, not code, and deliberately outside `src/`.**

Each file here is one stack's *reference* answer to "what does this kind of
project usually run for this verb". `nen shu detect` reads them to write a
**proposal** a human then edits into their own repository's
`nen/contract.json`. Nothing else in nen may read them.

That restriction is the whole reason the directory exists rather than a table in
`src/`:

- **`src/shu/render.ts` and `src/shu/run.ts` — the execution path — take a
  declaration and nothing else.** There is no parameter to pass a profile
  through, which is what makes "the pack is a catalogue, not an authority" a
  property of the program instead of a sentence in a header. A repository's
  `nen/contract.json` is the only thing a spawned command ever comes from.
- **Every toolchain name in this tree lives here.** `src/shu/purity.test.ts`
  sweeps the executor for them and fails the build on a hit, so the day someone
  finds it convenient to write a package manager's name into a code path, the
  build says so.

A row here being *wrong for your repository* is expected and is not a bug: it is
a starting point you overwrite. A row here being *executed* would be the bug.

Per zheref/nen#91's design, PR3 fills in the remaining six stacks
(`xcode-ios`, `gradle-android`, `compose-desktop`, `expo`, `gatsby`,
`dotnet-winui`) and generates `docs/STACK-MATRIX.md` from them. Until then,
`nen shu detect` proposes those lanes with an empty `verbs` map and says so.
