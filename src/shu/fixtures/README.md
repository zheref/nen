# `src/shu/fixtures/` — marker trees for `nen shu detect`

Fake repository roots, each carrying exactly the files a marker scan looks for.
They are **test data, not shipped code**: nothing under a `fixtures/` directory
is linted, type-checked or swept by `src/taxonomy-purity.test.ts`, which is what
lets them state concrete framework filenames and dependency names.

| tree | what it proves |
|---|---|
| `nextjs-single/` | one lane at the root; the pack's five reference verbs survive the package.json cross-check; a `Makefile` is reported as a finding and never proposed |
| `nextjs-multi/` | two lanes in one tree (`web/`, `admin/`) → `defaultLane: null` and a note; lane names come from the directories |
| `nextjs-unverified/` | the marker matches but package.json names a different package manager → the lane is proposed with `verbs: {}` and the reason |
| `nextjs-partial/` | the marker matches and the manager agrees, but two of the dependencies the reference argv names are absent → those verbs alone are withheld, by name |
| `markers/gatsby/`, `markers/expo/`, `markers/xcode/`, `markers/gradle-android/`, `markers/compose-desktop/`, `markers/winui/` | one marker each for the six stacks the pack has no verbs for yet → the lane is proposed with `verbs: {}` and the note naming PR3 |
| `markers/ambiguous/` | two stacks' markers in ONE directory → both lanes proposed, neither chosen |
| `empty-tree/` | no marker anywhere → nothing is proposed, exit 1, with the reason |

The executor's own fixture is elsewhere — `src/schema/fixtures/shu-repo/`, a
repository root carrying a `nen/contract.json` rather than markers, because a
declaration and a marker scan are different inputs to different code.
