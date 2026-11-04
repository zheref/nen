# Consumer configuration and scaffolding acceptance

This delivery combines NN#500 and NN#470, with independently useful NN#450
implementation. It does **not** claim NN#450 complete: its marker-omitting
examples need an explicit policy decision. No automation marker or unconditional
human trailer requirement is invented.

## NN#500

- AC1 / SC1: the public-command fixture reports exactly two selected lanes,
  one uncovered path and one undeclared lane in one read-only run.
- AC2: missing/empty mappings remain visible as `undeclared`, never executed.
- AC3: malformed glob declarations refuse at the lane's contract pointer.
- AC4: ordinary command behavior remains covered by the existing command suite;
  only `test --changed` enters the new selector. No selected-suite execution,
  gate derivation or consumer path population is added.
- Adversarial cases cover foreign selectors, redirected Git environment,
  incomplete NUL transport and literal newline filenames. Git reads prohibit
  external diff/text conversion and lazy fetching.

## NN#470

- AC1/2: all four profiles declare first-party native seats. Default planning
  writes no native tree and names the actual project/destination followed by
  init. Explicit `--run-native` is available for supported Android/WinUI
  generators; Xcode/Compose manual seats name their wizard on refusal.
- AC3: Compose and WinUI receive CI templates; the shared workflow explicitly
  uses Bash, including on the Windows runner.
- AC4: JSON exposes `path`, ordered `postSteps` and notes for every native pack;
  existing template plans report `template`.
- AC5: each native pack's dry-run fixture pins its step list. The opt-in host
  smoke test generates a real tree only when the required tool and host are
  prepared and `NEN_NATIVE_SMOKE=1` is explicit. It then scaffolds, checks schema
  and previews build. Current host receipts: Android **skipped: tool missing**;
  WinUI **skipped: tool missing**. Generated-tree checks were not performed here.
  No SDK/template installation is attempted or implied by these skips.

Generator options were checked against the first-party
[Google Android CLI create reference](https://developer.android.com/tools/agents/android-cli/commands/create)
and [Microsoft WinUI template documentation](https://github.com/microsoft/WindowsAppSDK/blob/main/dev/Templates/Dotnet/README.md).
Installed help must confirm required generator options before execution. WinUI
requires `--no-restore` support. Missing capability refuses instead of substituting
an unofficial generator or installing prerequisites.

## NN#450 — remaining policy hold

- AC1: the documentation pack proposes one lane with unsupported seats, no
  inferred project kind, an explicit optional lint argv, and lint-only PR CI.
  Current init still requires an explicit automation marker.
- AC2: hook-only reads existing workflow policy without creating a lane. It
  refuses absent policy, foreign hooks without force, and redirected hook/backup
  destinations. An explicit `--marker-env` remains required; the issue's exact
  marker-omitting invocation is **not fulfilled** pending the policy decision.
- AC3: index/Markdown-only detection proposes the documentation pack; confirmed
  init is separate, and recognised build markers suppress the proposal.
- AC4: synthetic declared taxonomy plus prose scaffolding reads every schema
  row `ok`; the real generated hook refuses a missing declared trailer and
  accepts it when supplied. Hook and backup symlink fixtures preserve outside
  sentinels. No live consumer provisioning occurred.

## Verification

The focused compatibility run passed 729 tests with the two explicit missing-tool
native smoke skips. It includes ordinary Shu command/detection, pack inertness,
scaffolding, selector and CLI catalogue checks. Typecheck and scoped lint are
recorded separately at the delivery head. Independent review found no remaining
actionable finding in the reviewed selector/hook/native safety delta.
