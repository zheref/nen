# `src/shu/fixtures/` — marker trees for `nen shu detect`

Fake repository roots, each carrying exactly the files a marker scan looks for.
They are **test data, not shipped code**: nothing under a `fixtures/` directory
is linted, type-checked or swept by `src/taxonomy-purity.test.ts` or
`src/shu/purity.test.ts`, which is what lets them state concrete framework
filenames and dependency names.

| tree | what it proves |
|---|---|
| `nextjs-single/` | one lane at the root; the pack's rows survive every `package.json` cross-check — `{pm}` from `packageManager`, `turbo` and `@biomejs/biome` as declared dependencies (the scoped one answers for the `biome` the argv names), and each `turbo run <task>` against the lane's own `turbo.json`; a `Makefile` is reported as a finding and never proposed |
| `nextjs-multi/` | two lanes in one tree (`web/`, `admin/`) → `defaultLane: null` and a note; lane names come from the directories |
| `nextjs-unverified/` | the marker matches but `package.json` states no `packageManager` and no dependencies → every templated row is withheld naming `{pm}`, the untemplated one is withheld naming its executable, and **the lane is still proposed**: no command row, and the four `unsupported` seats the pack's reasons go into, which is what makes the written file one the executor loads |
| `nextjs-partial/` | the manager, `turbo` and `biome` are all declared, and the lane's own `turbo.json` declares `build` and `dev` and neither `test` nor `lint` → those two rows alone are withheld, naming **turbo's** task list rather than `package.json`'s scripts, because `turbo run test` is what would have run |
| `nextjs-untooled/` | the manager IS declared and the tools it hands the work to are not → `build`/`test`/`dev` withheld naming `turbo` and `lint` naming `biome`. A manager the manifest names says nothing about the program the step actually needs, and `run` (`next start`) is proposed because `next` **is** a declared dependency |
| `nextjs-workspaces/` | the three-workspace shape: a `pnpm-workspace.yaml` root that also carries a marker, `apps/web` (declares `test:coverage` → `coverage` is proposed, with `{package}` from its own `name`), `apps/admin` (no such script → withheld naming the task) and `packages/core` (no marker → a package the root's note names, not a lane). Three lanes, `defaultLane: null`, and the root's own `coverage` withheld because a workspace root is the LIST of packages rather than one of them |
| `gatsby-site/` | the `gatsby` stack end to end: the config marker, `gatsby` as a declared dependency, and a `scripts` block that answers `{archiveScript}` for `archive` and for the first step of the two-step `deploy`. The script that answers is `resume:pdf`, and it answers because it **corroborates itself** — the repository named the script after the file it runs, so `pdf` is in the key and in the path. A `"start": "node server.js"` has the same word count and answers nothing. The five rows the pack has no command for arrive as `unsupported` seats carrying its reasons |
| `kro-shaped/` | **two separate Gradle builds in one tree**, the shape the inventory found: the root is `gradle-android` (its own wrapper, both spellings, `settings.gradle.kts` including one application module and one library module) and `program/` is `compose-desktop` (its **own** wrapper and settings file, a `compose.desktop` block, included by nothing above it). Two lanes, `defaultLane: null`, the two agreeing `hosts` maps merged into one block, `{gw}` written per host and `{unitTestTask}` answered `:PlaceholderCore:test` from the settings file, because that module applies a plugin nen can read and it is not the Android application one. The root's own build file *names* the Android plugin without applying it, and the Android marker is written `*/build.gradle{,.kts}` — a **module**, never the lane's own file — so the marker reported is the module's. The root's marker search stops at `program/`, because a directory shipping its own wrapper **or its own settings file** is its own build |
| `markers/gatsby/`, `markers/expo/`, `markers/xcode/`, `markers/winui/` | one marker each, each tree carrying nothing a command could be cross-checked against → the lane is proposed with **no command row** and one reason per withheld row (the `unsupported` seats are still written, so the file loads) |
| `markers/gradle-android/` | one marker — but this stack's tool is a file the repository **commits**, so the marker tree carries the evidence for the row as well: `build`/`lint`/`ui-test` are proposed with `{gw}` resolved from the host. It carries the lane's own `settings.gradle.kts`, because the profile names one as a marker and a directory without one is not this lane's build root; that file includes no module, so `test` alone is withheld. Plus the note about the `gradle` toolchain row, whose probe is `{gw} --version` — a probe naming a pack token is one nen proposes no precondition for |
| `markers/compose-desktop/` | the same, for the other Gradle stack — and it is also the smallest tree that shows a **nested carrier**: the `compose.desktop` block sits in `desktop/`, which the lane's own settings file includes as `:desktop`, so the proposed row is `{gw} :desktop:run` rather than `{gw} run`. The pack's marker for this stack carries no `*/` prefix, which is the pack saying the carrier is the lane's *own* build file; found one directory down instead, the build the pack describes is that module, and its bare task names are that module's |
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
