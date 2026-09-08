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
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.2.0/bootstrap/nen.sh -o nen-bootstrap.sh
bash nen-bootstrap.sh --ref v0.2.0
```

It prints the path to a verified, executable binary on stdout and nothing
else, so it composes directly:

```
nen="$(bash nen-bootstrap.sh --ref v0.2.0)"
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
  ok    schemas/labels.json  13 labels
  ok    schemas/repos.json  3 consumers, 6 product codes, latest v0.11.2
  ok    schemas/colors.yml  3 categories, 13 values
  ok    schemas/gates.json  5 reviewer identities
```

(`repository:` prints the resolved absolute path, which is unique to wherever
you checked this out — elided above to `<absolute path to your checkout>` so
this block reads the same regardless of where that is; every other line is
pasted verbatim.)

Point `--repo` at any checkout instead of the fixture and Nen reads that
repository's own `schemas/labels.json`, `schemas/repos.json`,
`schemas/colors.yml`, and `schemas/gates.json` — see **Taxonomy as data**
below.

## Day to day

Install once, bring a repository's own `schemas/` taxonomy up to the point
where the taxonomy-reading verbs work against it, and run the handful of
verbs that come up most: a readiness check before merging, the board
pipeline, filing and commenting, polling a check, and cutting a tag. Every
command below is real — verified against [`docs/USAGE.md`](docs/USAGE.md)'s
own conventions, and, where it is read-only, run against this repository's
own bundled fixture, `src/schema/fixtures/bankai-repo`.

### Install

The two-step bootstrap under [Install](#install) above is the one-time
fetch. Day to day, pin it once — in a shell profile, or a CI job's setup
step — and reuse the resulting path instead of re-running `curl` on every
invocation:

```bash
nen="$(bash nen-bootstrap.sh --ref v0.2.0)"
"$nen" --version
```
```text
0.2.0
```

From inside a checkout that already has a binary, `nen bootstrap` is the
in-CLI form of the same fetch — for re-pinning to a newer tag, or for
pinning a second `nen` a script wants to call by an explicit path:

```bash
nen bootstrap --ref v0.2.0 --source zheref/nen --script ./nen-bootstrap.sh
```

Every exit code either form can return is a published contract; see
`bootstrap/nen.sh`'s own header for what each one means and which one is
safe to retry.

### Set up a repository

Bring a new (or newly-onboarded) repository up to the point where the
taxonomy-reading verbs work against it. `owner/name` below is a
placeholder — substitute the repository you are onboarding.

Create the directory skeleton, the trailer-enforcing commit-msg hook, and a
canon-values template:

```bash
nen scaffold init --repo /path/to/repo --directories src,tests,docs \
  --agent-trailer Agent-Name --run-trailer Run-Id --marker-env NEN_AUTOMATED \
  --canon-values-path .claude/canon-values.yml --scenario swiftui-tca-uzf-v2
```

Check that the four taxonomy files can be read at all — `--repo .` against
your own checkout; here, against this repository's bundled fixture so the
block runs as printed:

```
$ nen schema check --repo src/schema/fixtures/bankai-repo
repository: <absolute path to your checkout>/src/schema/fixtures/bankai-repo
  ok    schemas/labels.json  13 labels
  ok    schemas/repos.json  3 consumers, 6 product codes, latest v0.11.2
  ok    schemas/colors.yml  3 categories, 13 values
  ok    schemas/gates.json  5 reviewer identities
```

Push the label set — preview first, then for real:

```
$ nen labels sync --target owner/name --repo src/schema/fixtures/bankai-repo --dry-run
would sync: bankai:stage/idea (#ededed) -- Raw idea awaiting research
would sync: bankai:stage/researched (#1d76db) -- Epic drafted, awaiting G1 approval
would sync: bankai:stage/building (#fbca04) -- Released to a builder
...
would sync: bankai:epic (#5319e7) -- An epic, delivered on an integration branch
```
```bash
nen labels sync --target owner/name --repo /path/to/repo
```

`--dry-run` makes no `gh` call at all — safe against any target. Drop it and
the sync runs for real: one bad label never aborts the run, every other good
label still lands, and the failures are named at the end (exit 1).

Resolve which handbooks the repository loads (`--target` must name a
repository the registry actually records as a consumer — `zheref/KroApple`
is the bundled fixture's own; point it at your real, registered repository
instead):

```
$ nen canon resolve --repo src/schema/fixtures/bankai-repo --target zheref/KroApple \
  --always-load handbooks/uzf-core.md,handbooks/security-baseline.md --stack-dir handbooks/stacks
scenario: swiftui-tca-uzf-v2
always load: handbooks/uzf-core.md, handbooks/security-baseline.md
stack handbook: handbooks/stacks/swiftui-tca-uzf-v2/architecture.md
```

### Use it every day

Six verbs, one block each, with the reason you would reach for it.

**Is this pull request ready to merge, before you look any further?**

```bash
nen pr ready owner/name#42 --explain
```

`--explain` prints the full conjunct table, in evaluation order, plus what
the gate does *not* decide. `--json` carries the same result behind a
stable, versioned `contract` field (`"nen.pr.ready/v0.1"`), so a caller can
tell a future breaking change from a compatible one — a non-zero exit never
means "cleared": `unevaluated` (GitHub could not be read) exits 1 exactly
like `not-ready`.

**What is the one thing standing in the way of merging it?**

```bash
nen pr next-blocker --target owner/name --pr 42 --repo .
```

Reports the first blocking condition only, in a fixed order — conflict, red
required check, owed reviewer round, unresolved thread, missing body
requirement — so you fix one thing and re-run rather than reading a whole
table every time. `--repo` is required by name here; it is where
`schemas/gates.json` (or an explicit `--gates <path>`) is read from.

**What does the backlog look like as a board, right now?**

```bash
nen backlog fetch --repo-slug owner/name --limit 200 --json > rows.json
nen backlog order --rows-from rows.json --severity-order critical,high,medium,low

nen board build --repo-slug owner/name --rows-from board-rows.json --json > board.json
nen board render --board-from board.json
```

Four verbs, composed by file: `fetch` is fresh over `gh api` every time
(never cached, and paginated past GitHub's 100-row clamp), `order` applies
severity/blocks/consumer/age priority to a pre-fetched row set, `build`
assembles the padded-markdown table's rows and validates their shape at the
JSON boundary, `render` prints it.

**File the issue you just found, and comment on the one it duplicates.**

```
$ nen issue file --target owner/name --repo src/schema/fixtures/bankai-repo \
  --title "watch until refuses a quoted --jq argument on a read-only gh api call" \
  --body-file ./body.md --label bankai:stage/idea,bankai:severity/medium \
  --assignee you --dry-run
would run: gh issue create --repo owner/name --title watch until refuses a quoted --jq argument on a read-only gh api call --body-file ./body.md --assignee you --label bankai:stage/idea --label bankai:severity/medium
```
```bash
nen issue comment --target owner/name --issue 90 \
  --body "Filed as #<n> -- see its body for the repro." --dry-run
```

Both print the exact `gh` call and write nothing under `--dry-run` — no
network call at all. `issue file`'s labels are checked against `--repo`'s
own taxonomy first; GitHub itself would silently create an unknown label
rather than refuse.

**Wait for a check to go green without babysitting the terminal.**

```bash
nen watch until --command "gh pr checks 42 --json bucket" --true-pattern "pass" --interval-ms 5000
```

The command is classified against izanami's read-only table before the
first run, and spawned directly with no shell — a mutating command is
refused outright, not run once and reported on. izanami is also stricter
than it looks: a quoted or metacharacter-bearing argument refuses too,
because it reads as one word to the classifier's scan and something else to
a real shell:

```
$ nen watch until --command "gh api repos/owner/name/pulls --jq '.[].number'" --max-iterations 1
nen: 'gh api repos/owner/name/pulls --jq '.[].number'' classifies as unknown ...
```

exit 2 — drop the quotes, or use a command the table can classify.

**Cut the tag once a release's preconditions all pass.**

```bash
nen release preflight --repo-slug owner/name --tag v0.3.0 --range v0.2.0..HEAD \
  --changelog CHANGELOG.md --owner-repo owner/name --critical-issues '' \
  --live-chores-from live-chores.json

nen tag cut --repo . --name v0.3.0 --at <sha> --push
```

`preflight` reports all six precondition rows, never just the first
failure. `tag cut` pins the tag at an explicit commit — `--at` is required
and never defaults to `HEAD` — and never auto-pushes without `--push`.
Either way, cutting a tag is not publishing a release: the binaries a
consumer's bootstrap needs exist only once a release has actually been
published for that tag.

---

[`docs/USAGE.md`](docs/USAGE.md) documents every verb's arguments, exit
codes and `--json` shape, plus six full end-to-end workflows these six
verbs are drawn from. Its own [day-to-day actions
table](docs/USAGE.md#day-to-day-actions--todays-verbs) is the honest
counterpart to this section: stack-aware developer verbs — `build`, `test`,
`lint`, `dev`, `run`, `deploy`, and the rest a maintainer reaches for daily
on a real project — do not exist in this release. They are being designed,
tracked in [zheref/nen#91](https://github.com/zheref/nen/issues/91); until
they land, those actions stay with each project's own toolchain.

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
that repository's `schemas/` directory at the path given by `--repo`
(defaulting to the current directory):

| File | What it holds |
|---|---|
| `schemas/labels.json` | The label set — names, colors, descriptions |
| `schemas/repos.json` | The repository registry — product codes, consumers |
| `schemas/colors.yml` | The status-color precedence for board rendering |
| `schemas/gates.json` | Reviewer identities for `nen pr ready`'s readiness check |

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

`nen --help` lists every command family (34 as of v0.2.0); each
family's own `--help` (`nen pr --help`, `nen board --help`, ...) documents
its verbs and flags in full. [`docs/USAGE.md`](docs/USAGE.md) documents all
70 verbs outside the binary — each one's purpose, arguments, exit codes and
`--json` shape — plus the conventions they share and the developer workflows
they compose into. The families group roughly as:

- **Readiness & pull requests** — `pr` (ready, staleness, body-check, fetch,
  next-blocker, cascade-main, retarget, request-reviews), `gate`, `split`,
  `wc`, `stage`
- **Backlog & boards** — `backlog`, `board`, `epic`, `effort`, `loop`,
  `warmup`, `watch`
- **Labels, issues & taxonomy** — `label`, `labels`, `schema check`, `color`,
  `repo`, `ref`
- **Release mechanics** — `release`, `changelog`, `tag`, `fanout`, `run`
- **Issue & idea filing** — `issue`, `idea`
- **Repository scaffolding & canon** — `scaffold`, `canon`, `quality`, `commit`
- **This repository's own dev loop** — `dev` (`test`, `lint`, `replay`)
- **Skill-grammar parsing** — `parse`
- **Supply** — `bootstrap`, `wake`, `stop`

Every command accepts `--repo <path>` (the target repository's working-tree
root — never an owner/name slug) and `--json` where the verb has a
machine-readable form.

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
