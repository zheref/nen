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

Binaries are published for three targets — `linux-x64`, `darwin-arm64`,
`windows-x64` — alongside a `SHA256SUMS` manifest, attached to the GitHub
release for each tag. The bootstrap script fetches the binary for your
platform, verifies it against that manifest, caches it, and refuses outright
on any integrity gap (unfetchable manifest, missing entry, digest mismatch)
rather than falling back to an unverified download:

```
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.1.0/bootstrap/nen.sh -o nen-bootstrap.sh
bash nen-bootstrap.sh --ref v0.1.0
```

It prints the path to a verified, executable binary on stdout and nothing
else, so it composes directly:

```
nen="$(bash nen-bootstrap.sh --ref v0.1.0)"
"$nen" --version
```

`bootstrap/nen.sh` is the one shell script this repository ships — everything
else, including the CLI itself, is TypeScript. See the script's own header
for the full fail-closed contract (which exit code means what, and which
ones are safe to retry).

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

`nen --help` lists every command family (34, as of this release); each
family's own `--help` (`nen pr --help`, `nen board --help`, ...) documents
its verbs and flags in full. The families group roughly as:

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
history isn't required to use Nen — everything above is the whole contract
— but if you're curious, the migration that produced it is tracked at
[zheref/akatsuki-ai#1](https://github.com/zheref/akatsuki-ai/issues/1).
