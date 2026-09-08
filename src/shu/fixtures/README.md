# `src/shu/fixtures/` — marker trees for `nen shu detect`

Fake repository roots, each carrying exactly the files a marker scan looks for.
They are **test data, not shipped code**: nothing under a `fixtures/` directory
is linted, type-checked or swept by `src/taxonomy-purity.test.ts` or
`src/shu/purity.test.ts`, which is what lets them state concrete framework
filenames and dependency names.

| tree | what it proves |
|---|---|
| `nextjs-single/` | one lane at the root; the pack's rows survive the `package.json` cross-checks with `{pm}` substituted from `packageManager`; a `Makefile` is reported as a finding and never proposed |
| `nextjs-multi/` | two lanes in one tree (`web/`, `admin/`) → `defaultLane: null` and a note; lane names come from the directories |
| `nextjs-unverified/` | the marker matches but `package.json` states no `packageManager` and no dependencies → every templated row is withheld naming `{pm}`, the untemplated one is withheld naming its executable, and the lane is still proposed with `verbs: {}` |
| `nextjs-partial/` | the manager is stated and two of the reference rows name a task the manifest declares no script for → those rows alone are withheld, by name |
| `nextjs-workspaces/` | the three-workspace shape: a `pnpm-workspace.yaml` root that also carries a marker, `apps/web` (declares `test:coverage` → `coverage` is proposed, with `{package}` from its own `name`), `apps/admin` (no such script → withheld naming the task) and `packages/core` (no marker → a package the root's note names, not a lane). Three lanes, `defaultLane: null`, and the root's own `coverage` withheld because a workspace root is the LIST of packages rather than one of them |
| `markers/gatsby/`, `markers/expo/`, `markers/xcode/`, `markers/gradle-android/`, `markers/compose-desktop/`, `markers/winui/` | one marker each for the six stacks whose commands are not confirmable from a `package.json` → the lane is proposed with **no command row** and one reason per withheld row (the `unsupported` seats are still written, so the file loads) |
| `markers/dotnet-plain/` | a `.csproj` with **no** `<UseWinUI>` element → **no lane at all**: a .NET project is not a WinUI one, and proposing the narrower stack from the broader marker would be nen deciding what kind of application this is |
| `markers/ambiguous/` | two stacks' markers in ONE directory → both lanes proposed, neither chosen |
| `empty-tree/` | no marker anywhere → nothing is proposed, exit 1, with the reason and the scan's own bounds |

The bounds themselves — the depth limit, the skipped directories, a stack that
matched twice in one directory — are proved against **temporary** trees in
`detect.test.ts` rather than against a checked-in fixture, because each of them
is about a shape (`d1/d2/d3/d4/`, `node_modules/…`) that reads as noise in a
directory listing and as an assertion in a test.

The executor's own fixture is elsewhere — `src/schema/fixtures/shu-repo/`, a
repository root carrying a `nen/contract.json` rather than markers, because a
declaration and a marker scan are different inputs to different code.
