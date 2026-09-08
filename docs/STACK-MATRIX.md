<!-- GENERATED FILE -- DO NOT EDIT. Run `bun run matrix` and commit the result. -->

# Stack matrix

**This page is generated.** `bun run matrix` renders it from `profiles/*.json`, the bundled profiles pack, and a test in this repository's own suite re-renders it and compares byte for byte -- so it cannot quietly go stale, and a hand edit fails the build. Change the pack, not the page.

**What it is.** For each stack the pack knows, the reference command each verb has *in the product repositories the inventory read*, cited to a file and a line. It is a CATALOGUE, not an authority: the only thing nen ever executes is the target repository's own `nen/contract.json`, and this page exists so that whoever writes one has somewhere honest to start. For the question *"what does THIS checkout support"*, ask `nen shu detect --repo <path>`; this page answers *"what does the pack know"*.

**Empty cells are first-class.** A verb no repository in the inventory implements is `unsupported` with the reason it is, never a plausible command nobody has run.

## Placeholders

**A command in this page is a SHAPE, not a runnable line.** A row that reads `xcodebuild -project {project} -scheme {scheme}` is true of every repository of that stack and executable in none of them, because the project and the scheme are that repository's. Every `{...}` below is a hole *you* fill.

**Where the value comes from.** All but one are **declaration-supplied**: your `nen/contract.json` states them, and the pack never contributes one -- a version or a path from this catalogue reaching a spawned command is the exact thing this repository's own test suite fails the build over. The exception is marked `host-conditional`, which nen resolves itself from `process.platform`.

**An unsubstituted token is refused, not run.** nen's executor treats a `{...}` that survives into an argv as an error, so copying a row verbatim fails loudly rather than invoking something with a brace in it. The set is closed: the pack's loader refuses a profile that uses a token this table does not list.

| token | supplied by | meaning |
| --- | --- | --- |
| `{app}` | declaration-supplied | the workspace an end-to-end or Storybook command is filtered to, in a monorepo whose root script fans out. |
| `{archiveScript}` | declaration-supplied | the repository's own archive script, as a path relative to the repository root -- the script is that repository's, not this stack's. |
| `{browserPath}` | declaration-supplied | the installed browser binary an archive step probes for, as an absolute path -- the probe is for presence, and the location is the machine's. |
| `{destination}` | declaration-supplied | an `xcodebuild -destination` argument, in either of its two forms: `id=<udid>`, or a `platform=...,name=...,OS=...` selector. |
| `{gw}` | **host-conditional** | the repository's Gradle wrapper: `./gradlew` on darwin and linux, `gradlew.bat` on win32. THE ONE TOKEN NEN RESOLVES ITSELF, from `process.platform` -- a lane with no wrapper is a finding, never an install. |
| `{name}` | declaration-supplied | the test-case name in an `-only-testing:<target>/<name>` selector, for the local subset form. |
| `{packageManager}` | declaration-supplied | the declaration's own `packageManager` PIN, `<name>@<version>`, as corepack activates it. Distinct from `{pm}`, and the distinction is the point: this one carries a VERSION, and a version in an install argv may only ever come from the declaration. |
| `{package}` | declaration-supplied | one workspace package the command runs for. The row is templated because the command runs ONCE PER PACKAGE, and the package names are the repository's. |
| `{platform}` | declaration-supplied | the native lane an `expo run:<platform>` targets. Neither lane is the other's default, so the pack templates rather than picks. |
| `{pm}` | declaration-supplied | the repository's package-manager EXECUTABLE, from its own `packageManager` field. The command name only; the pinned version is `{packageManager}`. |
| `{project}` | declaration-supplied | the Xcode project the build addresses -- and, for a workspace-based repository, the flag changes with it. |
| `{resultBundle}` | declaration-supplied | the `.xcresult` bundle path a test run writes and the coverage step then reads. The same value in both steps, which is why the row is a two-step cell and not two rows. |
| `{scheme}` | declaration-supplied | the Xcode scheme to build, test or archive. |
| `{simUdid}` | declaration-supplied | the UDID of the simulator the run is pinned to. CI creates and boots one per runner; a name-based destination is the other observed form. |
| `{testTarget}` | declaration-supplied | the test target in an `-only-testing:<target>/<name>` selector, for the local subset form. |
| `{unitTestTask}` | declaration-supplied | the repository's own JVM unit-test Gradle task, module path included -- the module name is that repository's, not this stack's. |
| `{workload}` | declaration-supplied | the Visual Studio workload id a `vswhere -requires` probe asks for. It names what must be INSTALLED, and the probe never installs it. |

## Legend

| cell | meaning |
| --- | --- |
| ✓ `command` | the pack carries a reference command for this verb |
| ✓ delegates to ... | the verb's work is another verb's, named -- and the named rows are in this same table |
| D declared-only (...) | the verb is REAL for this stack and the observed repositories disagree about what it means, so the pack proposes NO default and the declaration must say |
| — ... | unsupported, with the short reason. The full reason and its citation are in the stack's own section |

The **host** column is the platform allowlist every verb of that stack shares (`any` when it is every platform nen publishes a binary for), and **template** is the scaffold template the stack has a name for. Both are stated in full in the stack's own section.

## Summary grid

| stack | host | template | `detect` | `build` | `test` | `ui-test` | `lint` | `archive` | `release` | `dev` | `run` | `deploy` | `coverage` | `tools` | `warmup` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `compose-desktop` | any | — | D declared-only (markers, no spawn) | — no command in the tree | — no command in the tree | — no command in the tree | — no command in the tree | — formats declared, never invoked | — no command in the tree | — no command in the tree | ✓ `{gw} run` | — no command in the tree | — nothing to instrument | D declared-only (verify-only, all of it) | D declared-only (git half only) |
| `dotnet-winui` | win32 | — | D declared-only (markers, no spawn) | — no command in the repo | — no command in the repo | — no command in the repo | — no command in the repo | — no command in the repo | — no command in the repo | — no command in the repo | — no command in the repo | — no command in the repo | — coverlet present, unused | D declared-only (SDK gated, IDE never) | D declared-only (git half only) |
| `expo` | any | `minimal` | D declared-only (markers, no spawn) | — run:* builds and launches | — no test runner at all | — no UI runner at all | ✓ `expo lint` | — no eas.json anywhere | — no release lane at all | ✓ `expo start` | ✓ `expo run:{platform}` | — no deploy target | — no tests to instrument | ✓ `corepack enable` then `corepack prepare {packageManager} --activate` | D declared-only (git half only) |
| `gatsby` | any | `full` | D declared-only (markers, no spawn) | ✓ `gatsby build` | — no test runner at all | — no UI runner at all | — no linter at all | ✓ `node {archiveScript}` | — no release lane at all | ✓ `gatsby develop` | ✓ `gatsby serve` | ✓ `node {archiveScript}` then `gh-pages -d public -b gh-pages --dotfiles` | — no tests to instrument | D declared-only (verify-only, all of it) | ✓ delegates to `build` |
| `gradle-android` | any | `minimal` | D declared-only (markers, no spawn) | ✓ `{gw} assembleDebug --stacktrace` | ✓ `{gw} verifyPaparazziDebug {unitTestTask} --stacktrace` | ✓ `{gw} verifyPaparazziDebug` | ✓ `{gw} :app:lintDebug --stacktrace` | — release type, no signing | — no release lane at all | — no installDebug, no run | — no local run lane | — no deploy target | — no coverage plugin | D declared-only (components only) | ✓ delegates to `build`, `test` |
| `nextjs` | any | `full` | D declared-only (markers, no spawn) | ✓ `{pm} turbo run build` | ✓ `{pm} turbo run test` | D declared-only (two meanings) | ✓ `{pm} exec biome check .` then `{pm} turbo run lint` | D declared-only (evidence, not an artifact) | — declared n/a in the repo | ✓ `{pm} turbo run dev` | ✓ `next start` | D declared-only (three shapes, no default) | ✓ `{pm} --filter {package} test:coverage` | ✓ `corepack enable` then `corepack prepare {packageManager} --activate` | ✓ delegates to `build`, `test` |
| `xcode-ios` | darwin | `minimal` | D declared-only (markers, no spawn) | ✓ `xcodebuild -project {project} -scheme {scheme} -destination {destination} -configuration Debug build` | ✓ `xcodebuild -project {project} -scheme {scheme} -destination id={simUdid} -enableCodeCoverage YES -skipMacroValidation test` | — targets exist, never run | D declared-only (two meanings, one repo) | — no xcodebuild archive | — no release lane at all | — a GUI gesture | — no simctl install/launch | — db migration, not an app | ✓ `xcodebuild -project {project} -scheme {scheme} -destination id={simUdid} -enableCodeCoverage YES -skipMacroValidation -resultBundlePath {resultBundle} test` then `xcrun xccov view --report --json {resultBundle}` | D declared-only (verify-only, all of it) | ✓ delegates to `build`, `test` |

**Read it honestly, and over the right cells.** 10 of the 13 verbs name a command a repository RUNS; the other 3 describe what nen does *around* a build -- a marker match, a toolchain report, a delegation to two of these same rows -- and counting them in flatters the ratio in both directions at once. Over the **70** stack × verb cells the 10 command verbs make: **44 are unsupported**, 4 are declared-only, and 22 carry a command. That is what the ecosystem actually looks like today; a full grid would be a grid of aspirations.

The remaining 21 cells are those 3 rows: 6 carry something to run, 15 are declared-only and 0 are unsupported. They are worth reading and they are not builds.

---

## `compose-desktop` -- Compose Desktop

**Host:** any host to `run`; PACKAGING is per-format -- `packageDmg` needs macOS, `packageMsi` needs Windows, `packageDeb` needs Linux. That is a host constraint (exit 3), not a tool nen can supply.

**Scaffold template:** none -- no template is proposed: one observed lane and one observed command is not enough evidence for one.

### Verbs

| verb | command | why / source |
| --- | --- | --- |
| `detect` | declared-only | Detection is a marker match, not a spawned command: a `settings.gradle.kts` whose build applies `org.jetbrains.compose` with a `compose.desktop.application` block. *(source: markers)* |
| `build` | unsupported | This lane has no CI, no Makefile and no documentation naming a command. Only `run` exists. *(source: KroAndroid/program/ (inventory sweep))* |
| `test` | unsupported | This lane has no CI, no Makefile and no documentation naming a command. *(source: KroAndroid/program/ (inventory sweep))* |
| `ui-test` | unsupported | This lane has no CI, no Makefile and no documentation naming a command. *(source: KroAndroid/program/ (inventory sweep))* |
| `lint` | unsupported | This lane has no CI, no Makefile and no documentation naming a command. *(source: KroAndroid/program/ (inventory sweep))* |
| `archive` | unsupported | `targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)` is declared, so the tasks exist -- but NO COMMAND STRING FOR THEM APPEARS ANYWHERE IN THE REPOSITORY, and each format is host-locked. Proposing one would be nen inventing a release path. *(source: KroAndroid/program/build.gradle.kts:31)* |
| `release` | unsupported | This lane has no CI, no Makefile and no documentation naming a command. *(source: KroAndroid/program/ (inventory sweep))* |
| `dev` | unsupported | This lane has no CI, no Makefile and no documentation naming a command. The one invocation that exists is `run`. *(source: KroAndroid/program/ (inventory sweep))* |
| `run` | `{gw} run` | The ONLY invocation that exists for this lane, and it exists only as an IDE run configuration -- not in CI, not in a Makefile, not in prose. *(source: KroAndroid/program/.run/desktop.run.xml:11-15)* |
| `deploy` | unsupported | This lane has no CI, no Makefile and no documentation naming a command. *(source: KroAndroid/program/ (inventory sweep))* |
| `coverage` | unsupported | Same reason as `test`: no test command exists to instrument in the first place. *(source: KroAndroid/program/ (inventory sweep))* |
| `tools` | declared-only | All verify-only. A JDK (probe `java -version`) and the lane's OWN Gradle wrapper at 8.7 -- a DIFFERENT wrapper from the repository root's 9.5.1, which is itself the clearest argument for a per-lane toolchain block. Nothing to install: the wrapper is in the tree and the JDK is the host's. Packaging additionally needs the host that matches the format, which is a `hosts` constraint (exit 3), not a tool nen can supply. *(source: KroAndroid/program/gradle/wrapper/gradle-wrapper.properties)* |
| `warmup` | declared-only | The git steps still run -- classify, discard, fetch and branch are stack-independent -- but the build-verification step has nothing to delegate to, so `warmup` reports "no build command for this lane" rather than failing. *(source: this profile's own build row (unsupported))* |

### Host allowlist

| verb | platforms |
| --- | --- |
| `*` | `darwin`, `linux`, `win32` |

### Detection markers

| pattern | must contain | why |
| --- | --- | --- |
| `settings.gradle.kts` | `org.jetbrains.compose` | a Gradle build applying the Compose Multiplatform plugin. This lane is found by its OWN settings file, not the repository root's -- KroAndroid's `program/` is a wholly separate build inside an Android repository. |
| `build.gradle.kts` | `compose.desktop.application` | the refinement that makes it desktop rather than Android: the `compose.desktop.application` block. |

### Toolchain minimums (advisory)

What nen has been *tested* against, never what it installs: the pin an install would use is the target repository's own, and this column can never contribute one.

| tool | pack minimum | probe | version from | installer | why / source |
| --- | --- | --- | --- | --- | --- |
| `gradle` | `8.7` | `{gw} --version` | `first-semver-on-stdout` | `wrapper` | NOTHING TO INSTALL: this lane resolves its OWN wrapper, pinned at 8.7 -- a different wrapper from the repository root's 9.5.1, in the same tree. Two lanes, two Gradle versions, one repository: this row is why `toolchain` is a per-lane block and not a per-repository one. *(source: KroAndroid/program/gradle/wrapper/gradle-wrapper.properties)* |
| `jdk` | presence only | `java -version` | `first-semver-on-stderr` | `verify-only` | The host's JDK. This lane pins no version anywhere, so the pack states presence only. `java -version` writes to STDERR, which is why the reader is the stderr one. *(source: KroAndroid/program/ (no toolchain pin in the tree))* |

### Notes

- THIS LANE IS THE CLEAREST ARGUMENT IN THE INVENTORY FOR PER-LANE STACKS. It lives inside a repository whose every other verb is Android, with `rootProject.name = "kro-windows"`, its own wrapper, and inclusion by no workflow and no other build. A per-repository stack model gets it wrong by construction -- and so would a per-repository toolchain model, since the two lanes pin different Gradle versions in the same tree.

---

## `dotnet-winui` -- .NET / WinUI 3

**Host:** win32 only, and specifically Windows with Visual Studio 2022 (17.10+). The target framework needs the Windows 10 SDK 22621; `<UseWinUI>true</UseWinUI>` plus `<EnableMsixTooling>true</EnableMsixTooling>` need the Windows App SDK tooling; and the solution's deploy entries and MSIX launch profile are Visual Studio DEPLOYMENT GESTURES. Not cross-compilable from macOS or Linux.

**Scaffold template:** none -- no template is proposed: a skeleton for a stack with no invocable command is one nen could not then run anything against.

### Verbs

| verb | command | why / source |
| --- | --- | --- |
| `detect` | declared-only | Detection is a marker match, not a spawned command: `*.sln` or `*.csproj`, refined to THIS stack only by `<UseWinUI>true</UseWinUI>`. *(source: KroWindows/KroWindows.csproj:13)* |
| `build` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND. There is no Makefile, no `.cmd` / `.ps1` / `.sh`, no `global.json`, no `nuget.config`, no `Directory.Build.props`, and no `.github/` directory at all. Every action is a Visual Studio GUI gesture. *(source: KroWindows/Properties/launchSettings.json:3-8; KroWindows.csproj:133)* |
| `test` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND -- and specifically, no command anywhere invokes `dotnet test`, even though a test project exists. *(source: KroWindows (inventory sweep))* |
| `ui-test` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND. *(source: KroWindows (inventory sweep))* |
| `lint` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND. *(source: KroWindows (inventory sweep))* |
| `archive` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND. Packaging is a Visual Studio gesture: `HasPackageAndPublishMenu true`, with an MSIX launch profile. *(source: KroWindows/KroWindows.csproj:133; Properties/launchSettings.json:3-8)* |
| `release` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND, and signing is disabled outright (`<AppxPackageSigningEnabled>False</AppxPackageSigningEnabled>`). *(source: KroWindows/KroWindows.csproj:17)* |
| `dev` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND. Running is a Visual Studio launch profile. *(source: KroWindows/Properties/launchSettings.json:3-8)* |
| `run` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND. *(source: KroWindows/Properties/launchSettings.json:3-8)* |
| `deploy` | unsupported | NOTHING IN THE REPOSITORY INVOKES A COMMAND. The solution's `.Deploy.0` entries are Visual Studio deployment gestures, not a command line. *(source: KroWindows (solution deploy entries))* |
| `coverage` | unsupported | Unsupported -- but NOT a pure invention like an msbuild line would be. The test project already references `coverlet.collector` (`Version="6.0.2"`) as a real `PackageReference`, so the dependency `dotnet test --collect:"XPlat Code Coverage"` needs is already in the tree. Identically to every other verb in this stack, no command anywhere invokes `dotnet test` at all: real tooling, zero usage. *(source: KroWindows/KroCoreTests/KroCoreTests.csproj)* |
| `tools` | declared-only | The only stack whose one installable entry is GATED, and whose IDE can never be installed. .NET SDK -- installer `dotnet-install` (POSIX/Windows script) or `winget install Microsoft.DotNet.SDK.<n> --version <pin>`; the ONLY installer in the whole set that fetches and executes vendor code, which is why it is gated by residual question (d) and ships verify-only in the first release. The complication this row must carry: THERE IS NO `global.json`, so the build floats on whatever SDK is installed and the declaration has to state a pin nothing in the repository states. Visual Studio 2022 + Windows App SDK -- verify-only; probe `vswhere -latest -products * -requires <workload>` and report the workload id. nen never `winget install`s a 40 GB IDE. Windows 10 SDK 22621 -- verify-only; it arrives with the VS workload, so the row points at the workload rather than at a separate install. *(source: KroWindows/KroWindows.csproj:13, :133; no global.json in the tree)* |
| `warmup` | declared-only | The git steps run -- classify, discard, fetch and branch are stack-independent -- but build and test verification has nothing to delegate to, because every verb in this stack is unsupported. `warmup` reports that and stops there. *(source: this profile's own build and test rows (both unsupported))* |

### Host allowlist

| verb | platforms |
| --- | --- |
| `*` | `win32` |

### Detection markers

| pattern | must contain | why |
| --- | --- | --- |
| `*.csproj` | `<UseWinUI>true</UseWinUI>` | THE REFINEMENT IS THE MARKER. A `*.csproj` or `*.sln` alone identifies .NET, which is not this stack; `<UseWinUI>true</UseWinUI>` is what makes it WinUI 3. |
| `*.sln` |  | the solution, present but not sufficient: it must be refined by the WinUI property above. |

### Toolchain minimums (advisory)

What nen has been *tested* against, never what it installs: the pin an install would use is the target repository's own, and this column can never contribute one.

| tool | pack minimum | probe | version from | installer | why / source |
| --- | --- | --- | --- | --- | --- |
| `dotnet-sdk` | presence only | `dotnet --version` | `first-semver-on-stdout` | `dotnet-install` | THE ONLY INSTALLER IN THE SET THAT FETCHES AND EXECUTES VENDOR CODE, which is why it is gated by residual question (d) and ships VERIFY-ONLY in the first release. There is NO `global.json` in the repository, so no pin exists to carry and the pack states no minimum: the declaration must state one, and nen never installs "latest". *(source: KroWindows (no global.json; target framework net8.0-windows10.0.22621.0))* |
| `visual-studio` | `17.10` | `vswhere -latest -products * -requires {workload}` | `first-semver-on-stdout` | `verify-only` | Visual Studio 2022 17.10+ with the Windows App SDK tooling, which also brings the Windows 10 SDK 22621 -- so the row points at the WORKLOAD rather than at a separate SDK install. nen probes and reports the workload id a human installs; it never `winget install`s a 40 GB IDE. *(source: KroWindows/KroWindows.csproj:13 (UseWinUI), :133 (packaging menu))* |

### Notes

- PRECONDITIONS THIS STACK MUST ASSERT AND CANNOT FIX: a `ProjectReference` that ESCAPES THE REPOSITORY to a sibling clone of another project (KroCore/KroCore.csproj:10) -- no submodule, no NuGet package, no restore step fetches it, so the solution will not load unless that repository is cloned as a sibling directory, and nen never clones one; an `<AppInstallerUri>` hardcoding an absolute path on one machine (KroWindows.csproj:23); `<AppxPackageSigningEnabled>False</AppxPackageSigningEnabled>` (:17), unsigned packaging, and signing is exactly the thing nen never touches; and a `<PublishProfile>` naming profiles that DO NOT EXIST (:12).

---

## `expo` -- Expo

**Host:** SPLIT BY LANE, and the single `hosts` row cannot say it: `expo start` and `expo lint` run anywhere; `expo run:ios` needs macOS with Xcode and CocoaPods; `expo run:android` needs a JDK, the Android SDK and `node` on PATH for the Gradle configuration. The declaration narrows `run` to `darwin` for the iOS lane; the pack refuses to narrow it for a verb whose android half runs everywhere.

**Scaffold template:** `minimal` -- `app.json`, `package.json`, an `app/` route skeleton and nen/contract.json. NATIVE DIRECTORIES ARE NOT TEMPLATED; an `expo prebuild` is a printed post-step.

### Verbs

| verb | command | why / source |
| --- | --- | --- |
| `detect` | declared-only | Detection is a marker match, not a spawned command: `app.json` / `app.config.{js,ts}` carrying an `expo` key, or an `eas.json`; `ios/` AND `android/` present means the bare workflow. *(source: markers)* |
| `build` | unsupported | UNSUPPORTED AS A DISTINCT VERB: `expo run:ios` / `expo run:android` build AND launch, there is no build-only invocation in the repository, and `expo start --web` is a dev server rather than an `expo export`. Conflating the two would make `nen shu build` launch an app. *(source: food-diary/package.json:8-9, :11)* |
| `test` | unsupported | The repository has NO TEST RUNNER DEPENDENCY AT ALL: no jest, no `jest-expo`, no vitest. *(source: food-diary/package.json:14-49)* |
| `ui-test` | unsupported | No Maestro, no Detox, nothing. *(source: food-diary (inventory sweep))* |
| `lint` | `expo lint` | Flat ESLint 9 with `eslint-config-expo/flat`, ignoring `dist/*`. `expo` is invoked through the project's own dependency, never a global install. *(source: food-diary/package.json:12; eslint.config.js:5-9)* |
| `archive` | unsupported | NO `eas.json` AND NO EAS PROJECT ID in `app.json`. The pack must not propose `eas build`: nothing in the seven repositories has ever run it. *(source: food-diary (inventory sweep))* |
| `release` | unsupported | No `eas submit`, no fastlane. *(source: food-diary (inventory sweep))* |
| `dev` | `expo start` | The Metro dev server. `expo start --web` is the same verb with the web target, and is the declaration's argument to add. *(source: food-diary/package.json:6, :11)* |
| `run` | `expo run:{platform}` | The repository declares three forms: `expo run:ios`, `expo run:ios --device` and `expo run:android`. `{platform}` selects the lane and `--device` is the declaration's own extra argument; neither native lane is the other's default, so the pack templates rather than picks. THESE BUILD AND LAUNCH, which is why this profile has no `build` row. *(source: food-diary/package.json:9, :10, :8)* |
| `deploy` | unsupported | No deployment target of any kind. *(source: food-diary (inventory sweep))* |
| `coverage` | unsupported | Same reason as `test`: no jest, no `jest-expo`, no vitest, and no `coverage` hit anywhere in the repository. There is nothing to instrument. *(source: food-diary/package.json:14-49)* |
| `tools` | `corepack enable` then `corepack prepare {packageManager} --activate` | THE JS LANE ONLY, and it is the same one install nen performs anywhere: `{packageManager}` comes from the DECLARATION'S own `packageManager` pin, never from this pack. Everything else here is verify-only, and this row is the clearest case in the inventory for a per-lane toolchain. Node -- verify-only. Expo CLI -- installer `npx`, which installs NOTHING GLOBALLY: `expo` is invoked through the project's own dependency, and Expo itself warns against a global install; the row exists to say so rather than leave a reader guessing. iOS lane -- Xcode, simulator runtimes and CocoaPods, all verify-only, exactly as the xcode-ios profile. Android lane -- a JDK and Android SDK components as the gradle-android profile, PLUS `node` on PATH for a Gradle SYNC, which is a verify-only probe most readers would not expect. *(source: food-diary/package.json; start-ios.sh:5, :12; android/build.gradle:16-19)* |
| `warmup` | declared-only | The git steps run -- classify, discard, fetch and branch are stack-independent -- but the build-verification step reports `build` itself as unsupported for this lane: `expo run:*` builds AND launches, so there is nothing `warmup` can verify without also launching an app. *(source: this profile's own build row (unsupported))* |

### Host allowlist

| verb | platforms |
| --- | --- |
| `*` | `darwin`, `linux`, `win32` |

### Detection markers

| pattern | must contain | why |
| --- | --- | --- |
| `app.json` | `expo` | the manifest, identified by its `expo` key -- `app.json` alone is far too common a filename to be a marker. |
| `app.config.js` | `expo` | or `app.config.ts`: the dynamic manifest, same key. |
| `eas.json` |  | identifies an Expo project on its own. NOTE: no repository in the inventory has one, which is why `archive` is unsupported here. |
| `ios` |  | `ios/` AND `android/` both present means the BARE workflow -- prebuild output is committed, and the native lanes are real. |

### Toolchain minimums (advisory)

What nen has been *tested* against, never what it installs: the pin an install would use is the target repository's own, and this column can never contribute one.

| tool | pack minimum | probe | version from | installer | why / source |
| --- | --- | --- | --- | --- | --- |
| `expo-cli` | presence only | `expo --version` | `first-semver-on-stdout` | `npx` | NOTHING TO INSTALL GLOBALLY. `expo` is invoked through the project's own dependency, and Expo itself warns against a global install; this entry exists to state that rather than leave a reader to discover it. The observed project is Expo SDK 53 with expo-router 5 on React Native 0.79.5, and the CLI version travels with the project, so the pack states no host minimum. *(source: food-diary/package.json (Expo SDK 53 / expo-router 5 / RN 0.79.5))* |
| `node` | presence only | `node --version` | `first-semver-on-stdout` | `verify-only` | The repository pins no `engines` range, so the pack states presence only. Node is verify-only here for the same reason it is everywhere: a Node install is a system-wide decision with five common answers. The Android lane additionally needs it ON PATH for the Gradle sync. *(source: food-diary/package.json (no `engines`); android/build.gradle:16-19)* |

### Notes

- PRECONDITIONS ASSERTED, NEVER PERFORMED: `pod install` for the iOS lane; a JDK plus the Android SDK AND `node` on PATH for the Gradle lane; and a booted simulator. The repository's own helper hardcodes booting an `iPhone 16 Pro` (food-diary/start-ios.sh:5, :12) -- nen asserts a simulator exists and never boots one.
- The native lanes' toolchains are the xcode-ios and gradle-android profiles' rows, not copies of them. Duplicating those entries here would create two places to fix the same fact.

---

## `gatsby` -- Gatsby

**Host:** any host with Node >= 18 (CI pins 20). `archive` AND `deploy` additionally need a LOCALLY INSTALLED Chrome/Chromium/Edge -- the PDF builder deliberately avoids puppeteer and probes for an installed browser binary (zheref.io/scripts/build-resume-pdf.mjs:38-44), which is exactly why that step is not in CI. That is a tool constraint, not a platform one, so it is a toolchain row rather than a narrower `hosts` entry.

**Scaffold template:** `full` -- a static-site skeleton a template can carry end to end.

### Verbs

| verb | command | why / source |
| --- | --- | --- |
| `detect` | declared-only | Detection is a marker match, not a spawned command: `gatsby-config.{js,ts}`. *(source: markers)* |
| `build` | `gatsby build` | The repository's own build script. Its CI profile differs by one flag: `npx gatsby build --prefix-paths` when `PREFIX_PATHS=true`, else `npx gatsby build` -- a profile the declaration states, not a second row here. *(source: zheref.io/package.json:11 (ci profile: .github/workflows/deploy.yml:36-37))* |
| `test` | unsupported | No test script and no test-runner dependency. *(source: zheref.io/package.json)* |
| `ui-test` | unsupported | No UI or E2E runner of any kind. *(source: zheref.io (inventory sweep))* |
| `lint` | unsupported | NO LINTER OF ANY KIND EXISTS IN THIS REPOSITORY. *(source: zheref.io (inventory sweep))* |
| `archive` | `node {archiveScript}` | The one archive in the inventory that produces a real artifact: a PDF. Cited verbatim as `node scripts/build-resume-pdf.mjs` (`npm run resume:pdf`); `{archiveScript}` is templated because the script path is that repository's, not this stack's. It deliberately avoids puppeteer and PROBES for an installed browser binary, which is why this step is not in CI. *(source: zheref.io/package.json:15; scripts/build-resume-pdf.mjs:38-44)* |
| `release` | unsupported | No release lane of any kind. *(source: zheref.io (inventory sweep))* |
| `dev` | `gatsby develop` | Scripts `develop` and `start` are the same command; the repository's launch configuration adds a port (`npx gatsby develop -p 8000`), which is the declaration's argument to add. *(source: zheref.io/package.json:9, :10)* |
| `run` | `gatsby serve` | Serves the PRODUCTION build on port 9000, so it requires a prior `build` exactly as every other `run` row in this pack does. *(source: zheref.io/package.json:12)* |
| `deploy` | `node {archiveScript}` then `gh-pages -d public -b gh-pages --dotfiles` | Cited verbatim as `npm run resume:pdf && gh-pages -d public -b gh-pages --dotfiles`: the first half IS this profile's own `archive` row, which is why it is spelled the same way here. `public` is Gatsby's own output directory and the branch name is the host's convention, so both are carried literally. THE CI PROFILE HAS NO COMMAND AT ALL -- the site is uploaded by one action and published by another (`.github/workflows/deploy.yml:41-43`, `:53`), which is a deploy with no command line for nen to run. *(source: zheref.io/package.json:14 (ci profile: .github/workflows/deploy.yml:41-43, :53))* |
| `coverage` | unsupported | Same reason as `test`: no test script and no test-runner dependency, so there is nothing to instrument. *(source: zheref.io/package.json)* |
| `tools` | declared-only | All verify-only. Node -- verify-only, >= 18, CI pins 20. npm -- the repository uses npm rather than pnpm and ships NO `packageManager` field, so there is no corepack pin to activate: this is the one JS repository in the inventory where nen's single installable class does not apply. A local browser -- verify-only, and the most interesting row in the stack: `archive` and `deploy` need an installed Chrome/Chromium/Edge, which the PDF builder probes for BY PATH rather than downloading. nen probes the same way and reports; installing a browser is not something a build CLI does. *(source: zheref.io/package.json; scripts/build-resume-pdf.mjs:38-44)* |
| `warmup` | delegates to `build` | The git steps are stack-independent and run regardless; build-verification delegates to this profile's own `build` row. The OPTIONAL `--test` step is the one that reports unsupported here -- `test` has no command for this stack -- rather than `warmup` failing as a whole. *(source: this profile's own build row (test is unsupported))* |

### Host allowlist

| verb | platforms |
| --- | --- |
| `*` | `darwin`, `linux`, `win32` |

### Detection markers

| pattern | must contain | why |
| --- | --- | --- |
| `gatsby-config.js` |  | or `gatsby-config.ts`. The config file is the whole marker: Gatsby has no ambiguity to resolve. |
| `gatsby-config.ts` |  | the TypeScript spelling. |

### Toolchain minimums (advisory)

What nen has been *tested* against, never what it installs: the pin an install would use is the target repository's own, and this column can never contribute one.

| tool | pack minimum | probe | version from | installer | why / source |
| --- | --- | --- | --- | --- | --- |
| `browser` | presence only | `{browserPath}` | `path-exists` | `verify-only` | `archive` and `deploy` need a locally installed Chrome, Chromium or Edge. The repository's PDF builder deliberately avoids puppeteer and probes for the binary BY PATH; nen probes the same way, reports, and never installs a browser. No version is pinned, so the probe is a presence check. *(source: zheref.io/scripts/build-resume-pdf.mjs:38-44)* |
| `node` | `18.0.0` | `node --version` | `first-semver-on-stdout` | `verify-only` | The repository's floor is Node 18; its CI pins 20. Verify-only for the same reason as every other JS lane: a Node install is a system-wide decision nen does not make. *(source: zheref.io/package.json; .github/workflows/deploy.yml)* |
| `npm` | presence only | `npm --version` | `first-semver-on-stdout` | `verify-only` | THE ONE JS REPOSITORY WHERE COREPACK DOES NOT APPLY: it uses npm, not pnpm, and ships no `packageManager` field, so there is no pin to activate. npm arrives with Node, which is why the entry is verify-only rather than an install. *(source: zheref.io/package.json (no `packageManager` field))* |

### Notes

- THE SECOND `deploy` PROFILE IS THE POINT. Two of the seven repositories deploy through a mechanism that has NO COMMAND LINE AT ALL -- a Pages action here, a hosting provider's git integration in the nextjs profile. `unsupported` with a sentence, or a declared-only row, is the only honest rendering, and the schema has to be able to say it.

---

## `gradle-android` -- Gradle / Android

**Host:** any -- Gradle, the JDK and the Android SDK are all cross-platform, and the repository says so itself: "The Gradle toolchain is platform-agnostic" (KroAndroid/.github/workflows/build-test.yml:171-173). CI routes to a self-hosted Mac for BILLING, not because macOS is required.

**Scaffold template:** `minimal` -- wrapper, `settings.gradle.kts`, one module, nen/contract.json.

### Verbs

| verb | command | why / source |
| --- | --- | --- |
| `detect` | declared-only | Detection is a marker match, not a spawned command: `gradlew` plus `settings.gradle{,.kts}`, refined by a module applying `com.android.application`. The pack proposes no command because there is none to propose. *(source: markers)* |
| `build` | `{gw} assembleDebug --stacktrace` | The repository's own CI build step, verbatim. `{gw}` is the one host-conditional substitution in this pack: `./gradlew` on POSIX, `gradlew.bat` on Windows. *(source: KroAndroid/.github/workflows/build-test.yml:97)* |
| `test` | `{gw} verifyPaparazziDebug {unitTestTask} --stacktrace` | THE TASK MUST BE `verifyPaparazziDebug`, NEVER `testDebugUnitTest` (KN-IS-#182): under plain `testDebugUnitTest` a snapshot test renders and discards, so replacing a golden with a completely different image still reports PASSED. The cited command is `{gw} verifyPaparazziDebug :KroCore:test --stacktrace`; `{unitTestTask}` is the repository's own JVM unit-test task (KroAndroid: `:KroCore:test`), templated here because the module name is that repository's, not this stack's. *(source: KroAndroid/.github/workflows/build-test.yml:100 (the why: :51-58))* |
| `ui-test` | `{gw} verifyPaparazziDebug` | Screenshot verification is this stack's UI test, and it is the same task the `test` row runs. RECORDING baselines is a different, deliberately separate command the declaration states if it wants it: `{gw} recordPaparazziDebug`. INSTRUMENTED UI tests are unsupported here: `app/src/androidTest/` sources, a `testInstrumentationRunner` (app/build.gradle.kts:48) and Espresso / Compose-UI-test dependencies (:216-219) all exist, and no `connectedAndroidTest` invocation exists anywhere. *(source: KroAndroid/.claude/rules/14-ui-screenshots.md:112-113 (record: :109))* |
| `lint` | `{gw} :app:lintDebug --stacktrace` | The repository's own lint workflow step, verbatim. `:app` is the Android convention for the application module, not a product name, so it is carried literally. *(source: KroAndroid/.github/workflows/lint.yml:79)* |
| `archive` | unsupported | A `release` buildType is declared with NO signingConfig, and no `assembleRelease` / `bundleRelease` is invoked anywhere. An archive nen proposed would be an unsigned artifact nobody asked for. *(source: KroAndroid/app/build.gradle.kts:44-49)* |
| `release` | unsupported | No release lane of any kind in the inventory. *(source: the seven-repository inventory)* |
| `dev` | unsupported | No `installDebug`, no `run`. food-diary's Android lane is driven from the `expo` profile instead. *(source: KroAndroid (inventory sweep))* |
| `run` | unsupported | A release install to a device is a DEPLOY, not a local run, and no such invocation exists here either. *(source: KroAndroid (inventory sweep))* |
| `deploy` | unsupported | No Play publishing, no Firebase App Distribution, no `publish`. *(source: KroAndroid (inventory sweep))* |
| `coverage` | unsupported | No coverage plugin is declared, checked directly: neither JaCoCo nor Kover is applied anywhere. The root plugins block names the Android application plugin, Kotlin JVM / serialization / compose, KSP, Hilt and Paparazzi -- never `jacoco` or `kover`; the app module agrees; the version catalogue names neither. THE REPOSITORY'S OWN CHECKLIST DISAGREES WITH ITS OWN BUILD FILES: it documents `./gradlew jacocoTestReport`, a task that does not exist on a clean checkout. *(source: KroAndroid/build.gradle.kts:2-15, app/build.gradle.kts:4-13, gradle/libs.versions.toml (checklist: .claude/rules/12-session-completion-checklist.md:33-35))* |
| `tools` | declared-only | One installable class, three verify-only. Gradle -- installer `wrapper`, which installs NOTHING: `{gw}` resolves the repository's own wrapper, and a repo without one is a finding rather than an install. JDK -- verify-only, because KroAndroid needs TWO JDKs at once, Temurin 17 and 21, "21 last so it's the default JAVA_HOME (Gradle daemon), 17 present so toolchain(17) resolves"; an installer that got that ordering wrong would break the Gradle daemon in a way that looks like a compiler bug. Android SDK COMPONENTS -- installer `sdkmanager`, components only, into an SDK root that already exists; nen never installs the SDK root and never runs `sdkmanager --licenses`, which is an acceptance a human gives, and an absent `ANDROID_HOME` degrades the row to verify-only. `node` on PATH (food-diary's Android lane only) -- verify-only, needed by the Gradle SYNC, not just the JS bundle. *(source: wrapper: the repository; JDK/SDK: probes (KroAndroid/.github/actions/setup-kro/action.yml:12-23))* |
| `warmup` | delegates to `build`, `test` | The git steps are stack-independent and run regardless. The verification half delegates to this profile's own `build` and `test` rows, both of which carry a command. *(source: this profile's own build and test rows)* |

### Host allowlist

| verb | platforms |
| --- | --- |
| `*` | `darwin`, `linux`, `win32` |

### Detection markers

| pattern | must contain | why |
| --- | --- | --- |
| `gradlew` |  | the repository's own wrapper. `{gw}` resolves to it -- `./gradlew` on POSIX, `gradlew.bat` on Windows -- and a lane without one is a finding, not an install. |
| `settings.gradle.kts` |  | or `settings.gradle`. Present with the wrapper, this is a Gradle build; it is not yet an Android one. |
| `*/build.gradle.kts` | `com.android.application` | the refinement that makes it THIS stack rather than a plain JVM build: a module applying the Android application plugin. |

### Toolchain minimums (advisory)

What nen has been *tested* against, never what it installs: the pin an install would use is the target repository's own, and this column can never contribute one.

| tool | pack minimum | probe | version from | installer | why / source |
| --- | --- | --- | --- | --- | --- |
| `android-sdk` | presence only | `sdkmanager --version` | `first-semver-on-stdout` | `sdkmanager` | COMPONENTS ONLY, into an SDK root that already exists: `sdkmanager --install "platforms;android-<n>" "build-tools;<v>"`. nen never installs the SDK root and never runs `sdkmanager --licenses`. An absent `ANDROID_HOME` degrades this to verify-only with the message. GATED BY RESIDUAL QUESTION (d) -- it ships verify-only in the first release. No repository in the inventory pins a component version, so the pack states no minimum. *(source: KroAndroid (Android SDK required; no pinned component version in the tree))* |
| `gradle` | `9.5.1` | `{gw} --version` | `first-semver-on-stdout` | `wrapper` | NOTHING TO INSTALL: `{gw}` resolves the repository's own wrapper, and the minimum is what the root wrapper pins. nen never installs Gradle globally. *(source: KroAndroid root wrapper (contrast program/ at 8.7 -- see the compose-desktop profile))* |
| `jdk` | `17` | `java -version` | `first-semver-on-stderr` | `verify-only` | KroAndroid needs TWO JDKs at once, Temurin 17 and 21 -- "21 last so it's the default JAVA_HOME (Gradle daemon), 17 present so toolchain(17) resolves". The pack states the lower of the two as its minimum and reports both; an installer that got the ordering wrong would break the Gradle daemon in a way that looks like a compiler bug. `java -version` writes to STDERR, which is why the reader is the stderr one. *(source: KroAndroid/.github/actions/setup-kro/action.yml:12-23)* |
| `node` | presence only | `node --version` | `first-semver-on-stdout` | `verify-only` | food-diary's Android lane needs `node` ON PATH for the Gradle SYNC, not merely for the JS bundle -- a verify-only probe most readers would not expect. No version is pinned anywhere, so the pack states presence only. *(source: food-diary android/build.gradle:16-19, android/settings.gradle:4-14)* |

### Notes

- `{gw}` is the ONE host-conditional substitution in this pack: `./gradlew` on POSIX, `gradlew.bat` on Windows.
- PRECONDITIONS ASSERTED, NEVER PERFORMED: recursive submodules -- the root settings.gradle.kts:29-30 `includeBuild`s two sibling projects from a submodule, and without it nothing resolves; the two JDKs above; and a `local.properties` carrying the project's Supabase URL and anon key (app/build.gradle.kts:16-24).

---

## `nextjs` -- Next.js

**Host:** any. Node >= 20.19 (kro-pwa) / >= 22 (GymKai), with pnpm activated by corepack. `ui-test` via Playwright additionally downloads a browser (~300 MB), which is part of that verb's own two-step form and not a host install.

**Scaffold template:** `full` -- this is the stack a template can carry end to end, and the only one a CI runner can exercise on all three platforms.

### Verbs

| verb | command | why / source |
| --- | --- | --- |
| `detect` | declared-only | Detection is a marker match, not a spawned command: `next.config.{js,mjs,ts}`. Workspace members become lanes, which is a shape the declaration states rather than one the pack guesses. *(source: markers)* |
| `build` | `{pm} turbo run build` | Both repositories' own build target, which fans out to each workspace's `next build`. `{pm}` is the repository's package manager, from its own `packageManager` field. *(source: kro-pwa/Makefile:42 -> apps/web/package.json:7; GymKai/Makefile:36)* |
| `test` | `{pm} turbo run test` | Fans out to `vitest run --coverage` (kro-pwa's web app) or `vitest run` (its packages, and GymKai). *(source: kro-pwa/Makefile:63 and apps/web/package.json:9; GymKai/Makefile:49)* |
| `ui-test` | declared-only | TWO OBSERVED MEANINGS, and neither is the other's default. (a) Playwright, as TWO steps: `{pm} --filter {app} exec playwright install --with-deps chromium`, then `{pm} --filter {app} run test:e2e` (kro-pwa/Makefile:78-79, apps/web/package.json:11). (b) A Storybook static build as the visual-evidence carrier: `{pm} --filter {app} build-storybook` (GymKai/Makefile:59). The declaration says which this repository means. *(source: kro-pwa/Makefile:78-79; GymKai/Makefile:59)* |
| `lint` | `{pm} exec biome check .` then `{pm} turbo run lint` | TWO STEPS, IN ORDER, in both repositories: the formatter/linter pass over the whole tree first, then the per-workspace lint fan-out. Running only the second is a weaker check than either repository's own CI performs. *(source: kro-pwa/Makefile:46-47; GymKai/Makefile:39-40)* |
| `archive` | declared-only | kro-pwa has none. GymKai's nearest is `build-storybook` writing `packages/app/storybook-static`, uploaded as a 14-day CI artifact -- that is EVIDENCE, not a shippable app, and calling it this stack's archive would be the pack deciding what an archive is. *(source: GymKai/Makefile:59, .github/workflows/ci.yml:56-63)* |
| `release` | unsupported | One repository says so out loud, in its own Makefile: "publish: n/a -- Kro Web is a PWA, there is no package or store pipeline." *(source: kro-pwa/Makefile:100-101)* |
| `dev` | `{pm} turbo run dev` | Fans out to `next dev`. GymKai narrows the same command with a filter (`{pm} turbo run dev --filter @gymkai/web`), which is the declaration's argument to add, not the pack's. *(source: kro-pwa/Makefile:38; GymKai/Makefile:33)* |
| `run` | `next start` | The production server, and it REQUIRES A PRIOR `build`. nen states that in the refusal rather than silently building -- a verb that quietly does a different verb's work is how a caller loses track of what ran. *(source: kro-pwa/apps/web/package.json:8; GymKai/apps/web/package.json:9)* |
| `deploy` | declared-only | THREE OBSERVED SHAPES, NONE A DEFAULT. (a) An explicit failing stub: `@echo "deploy: no target is wired yet." ... @exit 1` (kro-pwa/Makefile:93-96). (b) NO COMMAND AT ALL -- the push to `main` IS the deploy, via the host's git integration (GymKai/Makefile:65, docs/Deployment.md:39-41). (c) Documented but unimplemented: `{pm} dlx vercel@latest deploy --prebuilt --prod --token=$VERCEL_TOKEN` (GymKai/docs/Deployment.md:65). *(source: kro-pwa/Makefile:93-96; GymKai/Makefile:65 and docs/Deployment.md:39-41, :65)* |
| `coverage` | `{pm} --filter {package} test:coverage` | ONE TEMPLATED COMMAND, RUN ONCE PER PACKAGE -- and reading it as a single invocation is the one way to get this row wrong. Both repositories run this exact shape N times, once for each workspace package that declares a `test:coverage` script, and a declaration reproduces that as N steps (or as its own root target that fans out); the pack states the SHAPE because the package list is the repository's, not this stack's. AN EXISTING COMMAND, NOT A PROPOSAL: each invocation resolves to `vitest run --coverage` with a real `coverage: { provider: 'v8', reporter: ['text','lcov'] }` block. Cited verbatim: `{pm} --filter @kro/core test:coverage` then `{pm} --filter @kro/app test:coverage` -- two runs, one shape. GAP WORTH CARRYING: neither repository's `test-coverage` target reaches `apps/web`, whose own `test` script already bakes coverage in. *(source: kro-pwa/Makefile:71-73 (packages/core/package.json:19, packages/app/package.json:22); GymKai/Makefile:51-53)* |
| `tools` | `corepack enable` then `corepack prepare {packageManager} --activate` | THE ONE INSTALL NEN PERFORMS, and the reason it is safe: corepack ships with Node, both repositories already run `corepack enable` as their own CI step (GymKai/.github/workflows/ci.yml:30; kro-pwa/Makefile:33-34), and kro-pwa/TOOLCHAIN.md:15-16 is explicit that it is the ONLY correct way here -- "Never install pnpm globally for this repo and never run `npm install` in it." `{packageManager}` COMES FROM THE DECLARATION'S OWN `packageManager` PIN, NEVER FROM THIS PACK: the pack may say what nen was tested against and may never contribute a version to an install argv. Node itself is verify-only; turbo, biome, vitest and playwright are project devDependencies installed by the project's own dependency install, which is a precondition nen asserts and never performs. *(source: kro-pwa/package.json (`packageManager`, `engines`), TOOLCHAIN.md:15-16; GymKai/.github/workflows/ci.yml:30)* |
| `warmup` | delegates to `build`, `test` | The git steps are stack-independent and run regardless. The verification half delegates to this profile's own `build` and `test` rows, both of which carry a command. *(source: this profile's own build and test rows)* |

### Host allowlist

| verb | platforms |
| --- | --- |
| `*` | `darwin`, `linux`, `win32` |

### Detection markers

| pattern | must contain | why |
| --- | --- | --- |
| `next.config.js` |  | or `next.config.mjs` / `next.config.ts`. In a monorepo the config sits in the app workspace, and workspace members become lanes. |
| `next.config.mjs` |  | the ESM spelling. |
| `next.config.ts` |  | the TypeScript spelling. |

### Toolchain minimums (advisory)

What nen has been *tested* against, never what it installs: the pin an install would use is the target repository's own, and this column can never contribute one.

| tool | pack minimum | probe | version from | installer | why / source |
| --- | --- | --- | --- | --- | --- |
| `node` | `20.19.0` | `node --version` | `first-semver-on-stdout` | `verify-only` | kro-pwa's `engines.node` is `>=20.19.0`; GymKai's CI runs 22. A Node install is a system-wide decision with five common answers (nvm, fnm, asdf, a distro package, the vendor installer), and picking one is exactly the line nen does not cross: it probes and prints the pin. *(source: kro-pwa/package.json (`engines.node`); GymKai CI setup step)* |
| `pnpm` | `9.15.9` | `pnpm --version` | `first-semver-on-stdout` | `corepack` | ADVISORY ONLY: this is the version nen has been TESTED against, and it never contributes to an install argv. IT IS THE ONE VERSION THE INVENTORY STATES: kro-pwa/package.json's `packageManager` field reads `pnpm@9.15.9`, and that is the whole evidence -- no repository in the inventory declares a `>= 9` range, an `engines.pnpm` floor, or any other pnpm version at all. An earlier draft wrote `9.0.0`, which was a floor nothing measured: rounding a measured version down to a plausible-looking major is exactly how an advisory column starts asserting things nobody checked. The pin that an `--install` would actually activate is the DECLARATION's `packageManager`, never this one. *(source: kro-pwa/package.json (`packageManager`))* |

### Notes

- PRECONDITIONS: `corepack enable` BEFORE the cached dependency install, as its own step; a frozen-lockfile install in CI (kro-pwa/.github/workflows/pr.yml); and an optional `cp .env.example apps/web/.env.local` (kro-pwa/TOOLCHAIN.md:23).
- TWO EXTRA VERBS THE INVENTORY EVIDENCES BUT THE THIRTEEN DO NOT COVER, carried here so they are not lost: `typecheck` -- `{pm} -r exec tsc --noEmit` (kro-pwa/Makefile:55; GymKai/Makefile:46); and `analyze` -- `{pm} turbo run analyze`, resolving to `ANALYZE=true next build` (kro-pwa/Makefile:59, apps/web/package.json:13). A declaration may carry any verb name it likes; the pack's thirteen are the ones the matrix compares across stacks.
- ON `make`: both repositories route every verb through a Makefile and both make it authoritative -- "If a command here disagrees with something you read elsewhere, this file wins" (kro-pwa/TOOLCHAIN.md:3-4), and CI runs the Makefile targets rather than the tools. The pack still proposes the LEAF commands, because a Makefile is a repository's own indirection and not this stack's.

---

## `xcode-ios` -- Xcode / iOS

**Host:** darwin only -- `xcodebuild`, `xcrun` and CocoaPods exist nowhere else. KroApple further requires Xcode 26.5 with the iOS 26.5 simulator runtime and an `iPhone 17 Pro` device type (KroApple/docs/ci.md:84-86).

**Scaffold template:** `minimal` -- a project skeleton plus nen/contract.json. nen never generates a `.pbxproj`.

### Verbs

| verb | command | why / source |
| --- | --- | --- |
| `detect` | declared-only | Detection is a marker match over the working tree, not a spawned command: `*.xcworkspace` is preferred, else `*.xcodeproj`; a `Podfile` adds a `pod install` precondition. The pack proposes no command because there is none to propose. *(source: markers)* |
| `build` | `xcodebuild -project {project} -scheme {scheme} -destination {destination} -configuration Debug build` | The repository's own build-execution rule. Its CI profile is the `test` row's form with `build` in place of `test` (`xcodebuild -project {project} -scheme {scheme} -destination id={simUdid} -enableCodeCoverage YES -skipMacroValidation build`) -- derived from the test row, not separately observed. *(source: KroApple/.claude/rules/13-build-execution.md:111-113)* |
| `test` | `xcodebuild -project {project} -scheme {scheme} -destination id={simUdid} -enableCodeCoverage YES -skipMacroValidation test` | CI runs this against a per-runner simulator created and booted BY UDID (`SCHEME: Kro`, tests.yml:58). The local snapshot-subset form is the same command with `-destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5'` and `-only-testing:{testTarget}/{name}` (KroApple/.claude/rules/07-testing.md:194-196). *(source: KroApple/.github/workflows/tests.yml:194-209)* |
| `ui-test` | unsupported | UI-test TARGETS exist and are never run. KroApple's shared scheme lists only `KroTests` in its test action; `KroUITests/` and `PreviewHostUITests/` appear in no shared scheme and no workflow. In food-diary it is worse: the scheme's TestAction references `fooddiaryTests`, but `project.pbxproj` contains exactly one native target and no test target -- so `xcodebuild test` on that scheme FAILS on a clean checkout. *(source: KroApple/Kro.xcscheme:38-47; food-diary ios/.../fooddiary.xcscheme:31-40 and project.pbxproj:137-160)* |
| `lint` | declared-only | Two incompatible meanings in one repository: `bash ci_scripts/lint_architecture.sh` (pure grep/find/bash, no Xcode) and `sh ci_scripts/verify_codex_guidance.sh`. SwiftLint appears nowhere in the seven repositories. No default is defensible, so the pack proposes none and the declaration says which this repository means. *(source: KroApple/.github/workflows/lint.yml:42-43; KroApple/Makefile:16-17)* |
| `archive` | unsupported | No repository invokes `xcodebuild archive`. KroApple's Archive actions are scheme CONFIGURATION pinned to `Release`, and heavy builds are delegated to Xcode Cloud, whose workflows live server-side and have no command line here. *(source: KroApple/Kro.xcscheme:92; KroApple/README.md:97)* |
| `release` | unsupported | No fastlane, no `altool`, no `xcrun notarytool` and no App Store Connect step in any of the seven repositories. *(source: the seven-repository inventory)* |
| `dev` | unsupported | Unsupported AS A SPAWNABLE COMMAND: the documented dev loop is a GUI gesture -- open the project, select the scheme, build and run with the IDE's own shortcut. *(source: KroApple/README.md:53-56)* |
| `run` | unsupported | Zero `xcrun simctl install` / `simctl launch` occurrences in KroApple. *(source: KroApple (inventory sweep))* |
| `deploy` | unsupported | Unsupported AT THE APP LEVEL. KroApple's only deploy lane is a Supabase DATABASE MIGRATION via a reusable workflow, which is not an app deploy and must not be filed as one. *(source: KroApple/.github/workflows/db-migrate.yml:23-26)* |
| `coverage` | `xcodebuild -project {project} -scheme {scheme} -destination id={simUdid} -enableCodeCoverage YES -skipMacroValidation -resultBundlePath {resultBundle} test` then `xcrun xccov view --report --json {resultBundle}` | DERIVED, NOT OBSERVED, and the row says so rather than reading as a found command. Step 1 is the `test` row's real `-enableCodeCoverage YES` invocation plus `-resultBundlePath`, so a report exists to read; step 2 extracts it. NO REPOSITORY RUNS THE EXTRACTION STEP: KroApple's own coverage policy (80% on touched files) is read by hand from Xcode's Report Navigator. *(source: flag: KroApple/.github/workflows/tests.yml:194-209; policy: KroApple/.claude/rules/12-session-completion-checklist.md:23-33 and 07-testing.md:45-46)* |
| `tools` | declared-only | Every entry is verify-only: NOTHING IN THIS STACK CAN BE INSTALLED BY NEN. Xcode -- probe `xcodebuild -version` and `xcode-select -p`; a 10+ GB, Apple-ID-gated download with a licence agreement is not something a CLI performs on a human's behalf, so the row prints two paths (the Mac App Store, or `xcodes install <version>` if the machine already has `xcodes`). Simulator runtimes -- probe `xcrun simctl list runtimes --json`; `xcodebuild -downloadPlatform iOS` is PRINTED, never run. Device type -- KroApple needs an `iPhone 17 Pro`; nen reports present/absent and never creates one. CocoaPods -- probe `pod --version`; its common install is `sudo gem install`, and nen never elevates. *(source: probes only; nothing installed)* |
| `warmup` | delegates to `build`, `test` | The git steps (classify, discard, fetch, branch) are stack-independent and run regardless. The verification half delegates to this profile's own `build` and `test` rows, both of which carry a command. *(source: this profile's own build and test rows)* |

### Host allowlist

| verb | platforms |
| --- | --- |
| `*` | `darwin` |

### Detection markers

| pattern | must contain | why |
| --- | --- | --- |
| `*.xcworkspace` |  | preferred when both are present: a workspace is what CocoaPods produces, and building the bare project instead is how a Pods-based build fails with missing headers. |
| `*.xcodeproj` |  | the project, when no workspace exists. |
| `Podfile` |  | adds a `pod install` PRECONDITION; on its own it does not identify the stack. |

### Toolchain minimums (advisory)

What nen has been *tested* against, never what it installs: the pin an install would use is the target repository's own, and this column can never contribute one.

| tool | pack minimum | probe | version from | installer | why / source |
| --- | --- | --- | --- | --- | --- |
| `cocoapods` | presence only | `pod --version` | `first-semver-on-stdout` | `verify-only` | food-diary's iOS lane is a CocoaPods workspace, and no repository in the inventory pins a version -- so the pack states presence, not a minimum. Its common install is `sudo gem install`, and nen never elevates. *(source: food-diary ios/ (Podfile); no pin in any repository)* |
| `xcode` | `26.5` | `xcodebuild -version` | `first-semver-on-stdout` | `verify-only` | KroApple pins Xcode 26.5 with the matching iOS 26.5 simulator runtime. nen cannot install it and does not pretend otherwise: the row prints the Mac App Store path, or `xcodes install <version>` where the machine already has `xcodes`. *(source: KroApple/docs/ci.md:84-86)* |

### Notes

- PRECONDITIONS THIS STACK ASSERTS AND NEVER PERFORMS (all from KroApple): a per-runner simulator created and booted by UDID (tests.yml:99-160, including the explicit prohibition on `xcrun simctl shutdown all` at :81-98); a gitignored `Kro/Config.xcconfig` written from secrets (:174-179); `defaults write com.apple.dt.Xcode IDESkipMacroFingerprintValidation -bool YES` (:186-188, and the whole of ci_scripts/ci_post_clone.sh:2); and, for food-diary, `pod install` plus an Expo prebuild.
- None of those preconditions becomes a `tools --install` action. They are assertions; `shu tools` installs host toolchains only.

---
