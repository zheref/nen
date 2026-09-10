# Nen

Nen is a local development CLI for deterministic GitHub-backlog machinery. It
answers the questions a maintainer or an automation asks about a repository's
pull requests and issues — is this PR ready to merge, what does the backlog
look like, does this label taxonomy match what's configured, is this release
safe to cut — the same way every time, from the same one binary.

- **Readiness verdicts.** `nen pr ready` evaluates a pull request against a
  fixed set of merge-readiness conditions (mergeable, checks green, review
  rounds settled, threads resolved) and reports the verdict plus the first
  condition that failed. It never merges, labels, or comments — it only
  reads and reports.
- **Backlog boards.** `nen backlog fetch`, `nen board build | render | diff`
  assemble and render a repository's open issues and pull requests into a
  gate board, without a page cap and without caching stale state.
- **Label taxonomy.** `nen labels sync | rename` creates, updates, and
  renames labels in a target repository from a taxonomy file, preserving
  every issue association.
- **Release mechanics.** `nen release preflight`, `nen changelog collate`,
  `nen tag cut` check the preconditions a release needs and cut a tag pinned
  to an explicit commit — they never publish a release themselves.

Nen detects, computes, formats, and verifies. It never decides anything that
requires judgment — a human or an LLM caller still reads the verdict and
decides what to do about it.

## Install

Each published GitHub release attaches binaries for three targets —
`linux-x64`, `darwin-arm64`, `windows-x64` — alongside a `SHA256SUMS`
manifest; cutting a tag does not by itself create a release, so the assets
exist once a release has actually been published for that tag, not the
moment the tag is cut. The bootstrap script fetches the binary for your
platform, verifies it against that manifest, caches it, and refuses outright
on any integrity gap (unfetchable manifest, missing entry, digest mismatch)
rather than falling back to an unverified download:

```
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.3.0/bootstrap/nen.sh -o nen-bootstrap.sh
bash nen-bootstrap.sh --ref v0.3.0
```

It prints the path to a verified, executable binary on stdout and nothing
else, so it composes directly:

```
nen="$(bash nen-bootstrap.sh --ref v0.3.0)"
"$nen" --version
```

`bootstrap/nen.sh` is the one shell script this repository ships — everything
else, including the CLI itself, is TypeScript. See the script's own header
for the full fail-closed contract (which exit code means what, and which
ones are safe to retry).

Pinning `--ref` to a tag keeps that tag's behaviour until you choose to move;
see [CHANGELOG.md](CHANGELOG.md) for what changed release to release,
including every deliberate behaviour change (under each version's "Behaviour
changes") a caller needs to account for before repinning to a newer tag.

## Try it

Two commands that need nothing but a clone — no target repository, no
network, no credentials.

The stable, scriptable side of every verb — human-readable by default, the
same data as `--json` for a caller that parses it:

```
$ nen commit format --type feat --subject "add readiness verb"
feat: add readiness verb

$ nen commit format --type feat --subject "add readiness verb" --json
{
  "message": "feat: add readiness verb"
}
```

And the taxonomy-as-data check, pointed at this repository's own bundled
test fixture so it runs without any setup:

```
$ nen schema check --repo src/schema/fixtures/bankai-repo
repository: <absolute path to your checkout>/src/schema/fixtures/bankai-repo
  ok    nen/labels.json  13 labels
  ok    nen/repos.json  3 consumers, 6 product codes, latest v0.11.2
  ok    nen/colors.yml  3 categories, 13 values
  ok    nen/gates.json  5 reviewer identities
  ok    nen/contract.json  dependency (nen >= 0.3, pinned v0.3.0), project (2 lanes: web, android; 10 verbs; 3 toolchain entries)
```

(`repository:` prints the resolved absolute path, which is unique to wherever
you checked this out — elided above to `<absolute path to your checkout>` so
this block reads the same regardless of where that is; every other line is
pasted verbatim.)

Point `--repo` at any checkout instead of the fixture and Nen reads that
repository's own `nen/labels.json`, `nen/repos.json`, `nen/colors.yml`, and
`nen/gates.json` — see **Taxonomy as data** below.

## Day to day

Install once, bring a repository's `nen/` taxonomy up to where the
taxonomy-reading verbs work, then the four verbs that come up most. Every
command runs as printed; the read-only ones ran against the bundled fixture
`src/schema/fixtures/bankai-repo`. `owner/name` and `/path/to/repo` are
placeholders.

### Install

[Install](#install) above is the one-time fetch. Day to day, pin it once — in a
shell profile, or a CI job's setup step — and reuse the path; `nen bootstrap`
is the in-CLI form of the same fetch, for re-pinning from an existing checkout:

```bash
nen="$(bash nen-bootstrap.sh --ref v0.3.0)" && "$nen" --version
nen bootstrap --ref v0.3.0 --source zheref/nen --script ./nen-bootstrap.sh
```

Once a release is published for `v0.3.0`, the first prints `0.3.0`. Until then
both refuse at exit 6 — the tag exists but no release does, so there is no
`SHA256SUMS` to verify a binary against, and assets exist only once a release
is published, as [Install](#install) says. `--ref v0.1.0` resolves today.

### Set up a repository

The directory skeleton, the commit-msg trailer hook, a canon-values template,
`nen/contract.json`, the stack's CI workflow, and `.nen/` in `.gitignore` — one
verb, on a repository that already exists. `--accept-detected` accepts the stack
proposal [`nen shu detect`](docs/USAGE.md#nen-shu-detect) prints, seats and open
questions and all; **Nen never guesses a stack**, so pass `--stack <id>` instead
to state one, and with neither flag the verb refuses and names both. Add
`--dry-run` to see every write first — it spawns nothing at all:

```bash
nen scaffold init --repo /path/to/repo --accept-detected --directories src,tests,docs \
  --agent-trailer Agent-Name --run-trailer Run-Id --marker-env NEN_AUTOMATED \
  --canon-values-path .claude/canon-values.yml --scenario swiftui-tca-uzf-v2
```

It ends by running `nen shu tools` in **check** mode and printing what this
machine is missing, without installing anything. Run it yourself for the host
verdict — exit 5 with the install command per tool when something is missing or
is the wrong version, and `--install` (corepack only, in this release) to fix
what nen is allowed to fix:

```bash
nen shu tools --repo /path/to/repo
```

Then check the four taxonomy files read at all — one `ok`/`fail` row each,
shown in full under [Try it](#try-it) above. Any file still under the legacy
`schemas/` directory was **copied** into `nen/` by the scaffold, never moved, and
the `git rm` line for the leftovers was printed:

```bash
nen schema check --repo /path/to/repo
```

For a project that does not exist yet, `nen scaffold new` writes a fresh tree
for one stack — the manifest that identifies it, `nen/contract.json` as `shu
detect` proposes it, the hook, the CI workflow, `.gitignore` — into an empty
directory it refuses to merge into. Every post-step (`git init`, a dependency
install, a native prebuild) is **printed and never run**:

```bash
nen scaffold new --stack nextjs --name my-site --dir ./my-site --dry-run
```

Both verbs write `.github/workflows/nen-shu.yml`, pinned at a nen release —
`--nen-ref vX.Y.Z` states one, and left off it is the greater of this binary's
version and the oldest release carrying the `nen shu` verbs the workflow runs
(`templates/index.json` declares it, with the reason). When those differ the
report says so: Nen cannot check offline that a release exists for a ref, and
until one is published the workflow's bootstrap refuses at **exit 6** for the
reason [Install](#install) gives — the tag exists, the release does not.

Then start a piece of work in one line — refuse (or `--discard`) uncommitted
changes, fetch, fast-forward the trunk, cut the branch **you** name from its
fresh tip, and prove the declared build still passes; `--dry-run` prints every
git and toolchain command and runs none of them:

```bash
nen shu warmup --repo /path/to/repo --branch my-idea --dry-run
```

Preview the label set, then drop `--dry-run` to push it. `--dry-run` makes no
`gh` call at all; without it one bad label never aborts the run — every other
good label lands, and the failures are named at the end (exit 1):

```
$ nen labels sync --target owner/name --repo src/schema/fixtures/bankai-repo --dry-run
would sync: bankai:stage/idea (#ededed) -- Raw idea awaiting research
...
would sync: bankai:epic (#5319e7) -- An epic, delivered on an integration branch
```

Resolve which handbooks it loads. `--target` must name a registered consumer;
`zheref/KroApple` is the fixture's own:

```
$ nen canon resolve --repo src/schema/fixtures/bankai-repo --target zheref/KroApple --always-load handbooks/uzf-core.md,handbooks/security-baseline.md --stack-dir handbooks/stacks
scenario: swiftui-tca-uzf-v2
always load: handbooks/uzf-core.md, handbooks/security-baseline.md
stack handbook: handbooks/stacks/swiftui-tca-uzf-v2/architecture.md
```

### Use it every day

**Is this pull request ready to merge, before you look any further?**

```bash
nen pr ready 42 --gh-repo owner/name --repo . --explain
```

The ref is either `<CODE>#<N>` against the target repository's own product
codes (`KP#42`, or `KP42` — the `#` is optional) or, as here, a bare number
with `--gh-repo owner/name`. `--json` carries the same verdict behind a stable
contract line, `"contract": "nen.pr.ready/v0.1",`. A non-zero exit never means
cleared: with no readable token the verdict is `unevaluated` at exit 1.

**What does the backlog look like as a board, right now?**

```bash
nen backlog fetch --repo-slug owner/name --limit 200 --json > rows.json
```

`fetch`'s rows are `{issueNumber, title, labels, prNumbers, createdAt}` inside
an object — deliberately not the input of the verbs below. `backlog order`
takes a JSON **array** of `{id, severity, blocksOther, affectsConsumers,
createdAt, number}`; `board build` an array of BoardRow. Severity out of
labels, the blocking edges, a row's gate/status/needs are judgement calls, so
that reshape is the caller's — a skill or a script — not this CLI's. (Piping
`fetch` straight into `order` today crashes rather than refusing,
[#105](https://github.com/zheref/nen/issues/105).) Hand-written illustration:

```json
[
  {"id": "42", "title": "Pin the read-only table", "refs": ["KP-IS-#42", "KP-PR-#57"], "gate": "G2", "status": "🟢 ready", "needs": "review"},
  {"id": "43", "title": "Escape pipes in titles", "refs": ["KP-IS-#43"], "gate": null, "status": "🟡 blocked", "needs": "waiting on #42"}
]
```

`build` validates every row at the JSON boundary; `render` prints the table:

```
$ nen board build --repo-slug owner/name --rows-from board-rows.json --json > board.json
$ nen board render --board-from board.json
owner/name -- generated 2026-09-08T00:34:25.497Z

| Effort                  | Refs                 | Status (gate) | Needs          |
| ----------------------- | -------------------- | ------------- | -------------- |
| Pin the read-only table | KP-IS-#42, KP-PR-#57 | 🟢 ready (G2) | review         |
| Escape pipes in titles  | KP-IS-#43            | 🟡 blocked    | waiting on #42 |
```

**File the issue you just found.** `--dry-run` prints the exact `gh` call and
makes no network call at all; the labels are checked against `--repo`'s own
taxonomy first, where GitHub would silently create an unknown one instead:

```
$ nen issue file --target owner/name --repo src/schema/fixtures/bankai-repo \
  --title "watch until refuses a quoted --jq argument on a read-only gh api call" \
  --body-file ./body.md --label bankai:stage/idea,bankai:severity/medium \
  --assignee you --dry-run
would run: gh issue create --repo owner/name --title watch until refuses a quoted --jq argument on a read-only gh api call --body-file ./body.md --assignee you --label bankai:stage/idea --label bankai:severity/medium
```

**Wait for a check to go green without babysitting the terminal.**

```bash
nen watch until --command "gh pr checks 42 --json bucket" --true-pattern "pass" --interval-ms 5000
```

The command is classified against izanami's read-only table before the first
run and spawned with no shell, so a mutating one is refused outright. A quoted
or metacharacter-bearing argument refuses too (exit 2) — it reads as one word
to the classifier's scan and something else to a real shell:

```
$ nen watch until --command "gh api repos/owner/name/pulls --jq '.[].number'" --max-iterations 1
nen: 'gh api repos/owner/name/pulls --jq '.[].number'' classifies as unknown ...
```

[`docs/USAGE.md`](docs/USAGE.md) has every verb's arguments, exit codes and
`--json` shape — `pr next-blocker`, `release preflight`, `tag cut` and the rest
— plus six end-to-end workflows and a [day-to-day actions
table](docs/USAGE.md#day-to-day-actions--todays-verbs): the stack-aware
developer verbs (`build`, `test`, `lint`, `dev`, `run`, `deploy`) ship in this
release under the `nen shu` family, alongside `scaffold init` and `scaffold
new`, which write the `nen/contract.json` those verbs read — proposed in
[#91](https://github.com/zheref/nen/issues/91).

## The one-surface contract

Every verb that reports something rather than just doing it supports
`--json`. The human output and the JSON are the same underlying result in
two renderings, never two separate code paths that can drift apart. A
machine caller — a CI job, an editor plugin, a script — gets a stable,
versioned shape to parse (`nen pr ready`'s JSON carries a `contract` field,
`"nen.pr.ready/v0.1"`, precisely so a consumer can tell a future breaking
change from a compatible one). A human at a terminal gets a plain-text
verdict and, on request (`--explain`), the full table of conditions in the
order they're evaluated, including which ones the gate does *not* decide.

## Taxonomy as data

Nen hard-codes no label names, no repository names, no reviewer names, no
colors. Every verb that needs a repository's own vocabulary reads it from
that repository's `nen/` directory at the path given by `--repo`
(defaulting to the current directory):

| File | What it holds |
|---|---|
| `nen/labels.json` | The label set — names, colors, descriptions |
| `nen/repos.json` | The repository registry — product codes, consumers |
| `nen/colors.yml` | The status-color precedence for board rendering |
| `nen/gates.json` | Reviewer identities for `nen pr ready`'s readiness check |
| `nen/contract.json` | Optional. What this repository needs *from* Nen (`dependency`), and the stack declaration Nen reads *about* it (`project`). Parsed, validated and reported; nothing acts on it yet |

`nen/` is committed configuration only. Generated output goes to a
dot-prefixed, gitignored `.nen/` — the one-character difference is deliberate,
so staging `nen/` after a run can never pick up a build log.

**Migrating from `schemas/`.** Through the v0.3 line Nen still reads the four
taxonomy files from a repository's legacy `schemas/` directory when `nen/` does
not carry them, so a repository that has not moved yet keeps working unchanged.
`nen schema check` names every file it read from the legacy location, and fails
on a *shadowed leftover* — a file present in both places with different bytes,
where `nen/` wins and the copy somebody may still be editing is the one Nen
ignores. Moving the four files into `nen/` is the whole migration — with one
thing to check alongside it: **a path a caller pinned by hand does not move on
its own.** The fallback only answers for paths Nen resolves itself, so CI that
passes `nen pr ready --gates schemas/gates.json`, or `nen gate derive
--policy-paths "schemas/,…"`, is naming a literal path and must be updated in
the same change. `--gates` deliberately refuses rather than falling back: a flag
that quietly read a different file than the one it was handed would be worse
than an error. `nen/contract.json` has no legacy location at all — it is new in
this line, so nothing under `schemas/` is ever read as one. The fallback is
removed in **v0.4.0**.

A repository that carries none of these files can still use Nen's
repository-agnostic verbs (`nen commit format`, `nen ref format`, ...); a
verb that needs one and doesn't find it refuses explicitly, naming the exact
file and path it looked for, rather than guessing or falling back to a
built-in default that would belong to some other project.

## Platform parity

Nen behaves identically on macOS and on Windows under Git Bash: one binary,
plus `git` and `gh` on `PATH`. There is no `make`, no `bats`/`pytest`, no
runtime Python, and no `jq`/`yq` anywhere Nen's own tooling runs — CI
exercises all three platforms on every change for exactly this reason.

## The verb surface

`nen --help` lists every command family (36); each
family's own `--help` (`nen pr --help`, `nen board --help`, ...) documents
its verbs and flags in full. [`docs/USAGE.md`](docs/USAGE.md) documents all
86 verbs outside the binary — each one's purpose, arguments, exit codes and
`--json` shape — plus the conventions they share and the developer workflows
they compose into. The families group roughly as:

- **Readiness & pull requests** — `pr` (ready, staleness, body-check, fetch,
  next-blocker, cascade-main, retarget, request-reviews), `gate`, `split`,
  `wc`, `stage`
- **Backlog & boards** — `backlog`, `board`, `epic`, `effort`, `loop`,
  `warmup` (a *registry* stale-pin sweep — not `shu warmup`, below, which warms
  a working copy), `watch`
- **Labels, issues & taxonomy** — `label`, `labels`, `schema check`, `color`,
  `repo`, `ref`
- **Release mechanics** — `release`, `changelog`, `tag`, `fanout`, `run`
- **Issue & idea filing** — `issue`, `idea`
- **Repository scaffolding & canon** — `scaffold`, `canon`, `quality`, `commit`
- **Stack-aware developer verbs** — `shu` (`detect`, `build`, `test`,
  `ui-test`, `lint`, `archive`, `release`, `dev`, `run`, `deploy`, `coverage`,
  `tools`, `warmup`), which run what a *target project* declares in its own
  `nen/contract.json` — never anything Nen decided
- **This repository's own dev loop** — `dev` (`test`, `lint`, `replay`)
- **Skill-grammar parsing** — `parse`
- **Supply** — `bootstrap`, `wake`, `stop`
- **Reports** — `report` (`data`, `render`): the facts an effort's report is
  made of, and the fill that turns them into one

Every command accepts `--repo <path>` (the target repository's working-tree
root — never an owner/name slug) and `--json` where the verb has a
machine-readable form.

`nen shu` runs those verbs today, against any repository that declares them.
All thirteen execute — `nen shu build --dry-run` prints the exact argv, cwd and
environment *names* it would spawn and spawns nothing; `nen shu detect` proposes
a `nen/contract.json` project block from the markers on disk and never writes
one without `--write`; `nen shu tools` checks the **host** toolchain the
declaration pins, exits 5 naming the install command per tool, and installs only
through `corepack` with `--install` — every other declared installer is
verify-only in this release. `nen shu warmup` is the one verb in the family that
mutates git state: it warms a **working copy** (clean → fetch → fast-forward the
trunk → cut your branch → verify the declared build), refusing at exit 2 rather
than guessing at every step. Every check that needs no mutation is made *before*
`--discard` destroys anything, so a mistyped `--branch` costs nothing; and what
`--discard` ran is not what it achieved, so the tree is read again afterwards and
whatever survived — a nested repository, a dirty submodule — is named rather than
reported as clean. It is *not* the top-level `nen warmup`, which sweeps a
**registry** for stale pins and reads only.

What each verb can run **per stack** is written down in
[`docs/STACK-MATRIX.md`](docs/STACK-MATRIX.md) — seven stacks × thirteen
verbs, each cell either a reference command cited to the repository it came
from, a `declared-only` (real for the stack, and the observed repositories
disagree about what it means), or an `unsupported` with the reason. It is
generated from the bundled profiles pack (`profiles/*.json`) by `bun run
matrix` and drift-checked by the suite. The pack is a **catalogue, not an
authority**: `nen shu detect` reads it to write a proposal a human edits, and
an import-graph test fails the build if anything that can spawn a process ever
reaches it — the executor included.

## Working on Nen

Requires [bun](https://bun.sh) 1.4.0 or newer, and nothing else. Identical
on macOS and Windows/Git Bash.

```
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run test   # or: bun src/index.ts dev test
```

Tests live beside their sources (`src/**/*.test.ts`). `bun run build:linux-x64`
(and the `darwin-arm64` / `windows-x64` siblings) cross-compile the release
binaries from any one host; `bun run build:<target> && sha256sum dist/*` (or,
on a stock macOS dev setup, which has no `sha256sum` by default: `shasum -a
256 dist/*` — the same fallback `bootstrap/nen.sh` itself uses) is the local
equivalent of the release pipeline's `SHA256SUMS`.

## License

MIT — see [LICENSE](LICENSE).

## Origin

Nen is one of several tools built from a larger internal system. That
history isn't required to use Nen: everything above is the whole contract.
The migration that produced it is tracked in a private issue, so there's
no public link to follow here.
