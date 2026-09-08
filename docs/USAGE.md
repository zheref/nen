# Using nen

Nen is a local development CLI for deterministic GitHub-backlog machinery. It
**detects, computes, formats and verifies** — and it never decides: a
`not-ready` verdict is never turned into a merge, a derived gate is never
turned into a label, a flagged secret is never un-staged for you, and a failed
release precondition is never turned into "skip it anyway". A human or an LLM
caller reads the result and decides what to do about it. Run it as `nen` once
the bootstrap has fetched and verified a pinned binary (see [Getting the
binary](#getting-the-binary)), or as `bun src/index.ts` from a checkout of this
repository — the two are the same program, and every example below is written
with the `nen` spelling. This document covers the **v0.3.0 line** (unreleased:
`shu`, `scaffold new` and `issue comment` are not in v0.2.0): 35 command
families, 84 verbs, every flag checked against the binary this repository
builds.

## Conventions

These hold across the whole surface. Each verb's own section restates only
where it departs from them.

### `--repo <path>` is a path

`--repo` names a working-tree **root on disk** — never an `owner/name` slug.
It is a global flag, accepted everywhere, and it defaults to the current
directory, resolved at the call site and never from wherever the executable
itself lives (so a bootstrap-cached binary under `~/.cache/nen` still reads the
checkout you are standing in).

Fifteen verbs require it by name instead of defaulting, because each one either
mutates or reports on whatever it is pointed at, and a silent cwd default turned
a forgotten flag into a confident wrong answer (zheref/nen#28):
[`pr next-blocker`](#nen-pr-next-blocker),
[`pr cascade-main`](#nen-pr-cascade-main),
[`wc classify`](#nen-wc-classify),
[`stage triage`](#nen-stage-triage),
[`release resolve-target`](#nen-release-resolve-target),
[`release self-check`](#nen-release-self-check),
[`tag cut`](#nen-tag-cut),
[`labels sync`](#nen-labels-sync),
[`repo scenario`](#nen-repo-scenario),
[`issue file`](#nen-issue-file),
[`issue consolidate-close`](#nen-issue-consolidate-close),
[`idea file`](#nen-idea-file),
[`scaffold init`](#nen-scaffold-init),
[`canon resolve`](#nen-canon-resolve) and
[`parse futon`](#nen-parse-futon).
Thirty verbs accept it and never read it at all — they work entirely from the
paths and slugs they are handed. Every verb of [`commit`](#family-commit),
[`effort`](#family-effort), [`epic`](#family-epic), [`loop`](#family-loop),
[`quality`](#family-quality), [`run`](#family-run), [`split`](#family-split),
[`wake`](#family-wake) and [`watch`](#family-watch) is one; so are
[`backlog fetch`](#nen-backlog-fetch),
[`canon mirror generate`](#nen-canon-mirror-generate) and
[`canon mirror check`](#nen-canon-mirror-check), [`labels rename`](#nen-labels-rename),
[`pr fetch`](#nen-pr-fetch), [`pr retarget`](#nen-pr-retarget),
[`pr request-reviews`](#nen-pr-request-reviews),
[`ref parse`](#nen-ref-parse), [`repo inventory`](#nen-repo-inventory),
[`parse <skill>`](#nen-parse-skill), [`parse izanagi`](#nen-parse-izanagi),
[`parse izanami`](#nen-parse-izanami), and six of the eight
[`issue`](#family-issue) verbs — every one except
[`issue file`](#nen-issue-file) and
[`issue consolidate-close`](#nen-issue-consolidate-close). Their argument
tables say so.

#### Relative paths resolve against two different bases

There is no single rule here, and the difference is worth knowing before it
costs you a run. **Most** path flags resolve a relative value against
`--repo`'s root (an absolute value is always used as-is): `--rows-from`,
`--board-from`, `--gates`, `--changelog`, `--fragment-dir`, `--wakes-from`,
`--body-from`, `--requirements-from`, `--ledger`, `--questions-from`,
`--answers-from`, and every taxonomy file a verb opens for itself.

**A closed set of own-path flags does not** — they are handed to
`readFileSync`/`writeFileSync` unresolved, so a relative value resolves
against the **process's current directory** and `--repo` is ignored:

| Verb | Flags resolved against the process cwd |
|---|---|
| [`epic next-wave`](#nen-epic-next-wave) | `--body-file`, `--out` |
| [`idea file`](#nen-idea-file) | `--body-file` |
| [`issue comment`](#nen-issue-comment) | `--body-file` |
| [`issue file`](#nen-issue-file) | `--body-file` — never read by nen at all; the path is handed to `gh` verbatim, so `gh`'s own cwd resolves it |
| [`effort classify`](#nen-effort-classify) | `--input` |
| [`loop slots`](#nen-loop-slots) | `--efforts` |
| [`split verify`](#nen-split-verify) | `--original`, `--branches` |
| [`quality tooling`](#nen-quality-tooling) | `--table` |
| [`quality method-check`](#nen-quality-method-check) | `--input` |
| [`canon mirror generate`](#nen-canon-mirror-generate) / [`canon mirror check`](#nen-canon-mirror-check) | `--rules-dir`, `--canon-values`, `--out-dir`, `--mirror-dir`, `--markdown-out` |

Every one of these verbs is also in the accept-but-never-read list above, so
there is nothing inconsistent about a single invocation — but there IS an
inconsistency across the surface, and it is tracked as
[zheref/nen#100](https://github.com/zheref/nen/issues/100). Until it closes,
the portable habit is to pass an absolute path to any of the flags in this
table, or to run the verb from the directory those paths are relative to.

### `--target <owner/name>` names the GitHub repository

A verb that calls `gh` needs the repository on GitHub, which is a different
thing from the checkout on disk, so it gets a different flag. `--target
<owner/name>` is the usual spelling — [`pr fetch`](#nen-pr-fetch),
[`pr next-blocker`](#nen-pr-next-blocker), [`pr retarget`](#nen-pr-retarget),
[`pr request-reviews`](#nen-pr-request-reviews),
[`run rerun-failed`](#nen-run-rerun-failed), the whole
[`issue`](#family-issue) family, [`idea file`](#nen-idea-file),
[`labels sync`](#nen-labels-sync), [`labels rename`](#nen-labels-rename),
[`repo inventory`](#nen-repo-inventory) and
[`repo scenario`](#nen-repo-scenario) all take it. Four OTHER spellings cover
ten more mentions across nine verbs (`release preflight` takes two of them),
for reasons local to each: [`pr ready`](#nen-pr-ready) takes
`--gh-repo` (only needed when the `<ref>` is a bare number);
[`backlog fetch`](#nen-backlog-fetch), [`board build`](#nen-board-build),
[`label apply`](#nen-label-apply), [`release preflight`](#nen-release-preflight)
and the [`wake`](#family-wake) family take `--repo-slug`;
[`release preflight`](#nen-release-preflight) and
[`changelog completeness`](#nen-changelog-completeness) take `--owner-repo`,
which scopes changelog link matching to one repository rather than naming an
API target; and [`bootstrap`](#nen-bootstrap) takes `--source` for the
repository whose release assets it fetches. `--repo` and any of these are never
interchangeable: `--repo ../bankai-core` handed to a fetcher would produce a
bewildering 404, which is exactly why the two meanings carry two names.

### The one-surface `--json` contract

Every verb that reports something rather than only doing it accepts `--json`.
The human text and the JSON are the same underlying result object in two
renderings — never two code paths that can drift apart — so a CI job, an editor
plugin or a skill parses a stable shape while a person at a terminal reads a
verdict. [`pr ready`](#nen-pr-ready)'s JSON carries a `contract` field,
`"nen.pr.ready/v0.1"`, precisely so a consumer can tell a future breaking
change from a compatible one.

Three verbs have no `--json` because they have no result of their own to
render: [`dev test`](#nen-dev-test) and [`dev lint`](#nen-dev-lint) inherit
their subprocess's stdio, and [`bootstrap`](#nen-bootstrap) prints only the
verified binary path. And a handful of verbs — [`issue file`](#nen-issue-file),
[`idea file`](#nen-idea-file), [`canon resolve`](#nen-canon-resolve),
[`commit format`](#nen-commit-format) — print refusals as plain `nen: <reason>`
lines even under `--json`: only the success path is machine-shaped, because a
caller that mis-invoked a verb needs the sentence more than it needs a schema.

### Exit codes

`0` success, `1` the verb's own refusal or failure, `2` a usage error. The rule
`src/index.ts` states, and the reason the last two are not one code:

> A usage error is deliberately distinct from a failure: "you typed it wrong"
> and "the thing you asked for did not work" want different reactions from a
> caller.

A non-zero exit is never a pass. [`pr ready`](#nen-pr-ready) exits 1 on
`unevaluated` — "GitHub could not be read" — exactly as it does on `not-ready`,
because absence of a verdict is not a verdict. Several verbs that only report
always exit 0 ([`pr staleness`](#nen-pr-staleness),
[`fanout compute`](#nen-fanout-compute), [`board diff`](#nen-board-diff)); the
guard-shaped ones exit 1 to stop a shell loop
([`issue open-pr-check`](#nen-issue-open-pr-check),
[`loop slots`](#nen-loop-slots), [`stage triage`](#nen-stage-triage)). Each
verb's own **Output and exit codes** paragraph is authoritative.
[`bootstrap`](#nen-bootstrap) is the one exception to the three-code scheme: it
relays the bootstrap script's own published codes unchanged (see [Getting the
binary](#getting-the-binary)).

The [`shu`](#family-shu) family **extends** the scheme with three codes rather
than reinterpreting any of the first three, because each names a fact the
existing codes conflate — and the conflation would make an automated caller do
the wrong thing:

| Code | Meaning | Why not an existing code |
|---|---|---|
| `3` | **unsupported host** — the verb is real, this machine cannot run it | not `1`, because a retry wrapper would retry forever on a machine that can never satisfy it; not `2`, because the invocation was correct |
| `4` | **unsupported verb for this lane** — the declaration says so, in its own words | not `2`: the invocation was correct and the answer is a fact about the repository. It is the *majority* case across the stacks the family covers |
| `5` | **the declared program could not be started** — not installed, not on `PATH` | not `1`: "the tool is not installed" and "the tool ran and said no" want different reactions, and `src/seam/exec.ts` keeps them apart precisely so a caller need not guess |

`shu` is the only *family* that returns `3`, `4` or `5`; the one other place in
this CLI where a code above `2` appears is [`bootstrap`](#nen-bootstrap), which
is not on the three-code scheme at all — it relays the bootstrap script's own
published `3`–`7` unchanged, and those numbers mean the script's things, not
these. A caller branching on `3`/`4`/`5` must know which of the two it invoked.

One inconsistency is worth knowing before it surprises you: a missing
`--target` exits `1` rather than `2` on sixteen verbs — every verb routed
through one of the four families' local `requireTarget()` helpers. See the
note under [`labels sync`](#nen-labels-sync), and
[zheref/nen#93](https://github.com/zheref/nen/issues/93).

### `--dry-run` discipline

Every mutating verb can be asked to show what it would do and do nothing. What
it shows depends on what it does: most of them print the exact `gh` (or `git`)
call they would make; [`label apply`](#nen-label-apply) writes its ledger line
either way and marks it `outcome: "dry-run"`; and the [`shu`](#family-shu)
verbs print the argv the **target repository's own declaration** states, which
is the only kind of command they ever run. The flag's name follows what the
verb does by default:

| Verb | Safe by default? | Flag | Notes |
|---|---|---|---|
| [`issue file`](#nen-issue-file) | no | `--dry-run` | fully offline — no network call at all |
| [`issue comment`](#nen-issue-comment) | no | `--dry-run` | fully offline; also prints the exact bytes of the body |
| [`issue attach-sub`](#nen-issue-attach-sub) | no | `--dry-run` | **still reads GitHub** to certify every number is an issue, not a PR |
| [`issue consolidate-close`](#nen-issue-consolidate-close) | no | `--dry-run` | **still reads GitHub** for the object-class check and the open-PR guard |
| [`labels sync`](#nen-labels-sync) | no | `--dry-run` | fully offline |
| [`labels rename`](#nen-labels-rename) | no | `--dry-run` | **still calls `gh label list`** to decide idempotence |
| [`label apply`](#nen-label-apply) | yes | `--run` | the ledger line is written either way, with `outcome: "dry-run"` |
| [`wake verify`](#nen-wake-verify) | yes | `--run` | despite the name, `--run` reruns workflows and posts comments |
| [`wake fire`](#nen-wake-fire) | yes | `--run` | every line is prefixed `(dry run)` without it |
| [`changelog collate`](#nen-changelog-collate) | yes | `--write` | without it, nothing is rewritten and no fragment is deleted |
| [`tag cut`](#nen-tag-cut) | yes | `--push` | the tag is created locally; a tag is never auto-pushed |
| [`canon mirror generate`](#nen-canon-mirror-generate) | no | — | use [`canon mirror check`](#nen-canon-mirror-check), which writes nothing |
| [`scaffold init`](#nen-scaffold-init) | no | `--dry-run` | prints every write, every migration and every refusal, and performs none. It spawns **nothing**, probes included — the closing [`shu tools`](#nen-shu-tools) check is reported as `would check` rather than run, which is why the dry form classifies **read-only** in izanami's table while the bare form classifies **mutating**. `--dry-run --install-tools` is refused at exit 2: one says nothing happens, the other changes the HOST |
| [`scaffold new`](#nen-scaffold-new) | no | `--dry-run` | prints the tree it would write. Even the bare form spawns nothing at all: **every post-step is printed and none is run**, the toolchain check included |
| [`pr retarget`](#nen-pr-retarget), [`pr request-reviews`](#nen-pr-request-reviews), [`pr cascade-main`](#nen-pr-cascade-main), [`run rerun-failed`](#nen-run-rerun-failed) | no | — | one narrow `gh`/`git` call each, with no preview form |
| [`shu detect`](#nen-shu-detect) | yes | `--write` | fully offline; refuses to overwrite an existing declaration even with `--write`, and there is no `--force` |
| [`shu build`](#nen-shu-build), [`shu test`](#nen-shu-test), [`shu ui-test`](#nen-shu-ui-test), [`shu lint`](#nen-shu-lint), [`shu archive`](#nen-shu-archive), [`shu release`](#nen-shu-release), [`shu dev`](#nen-shu-dev), [`shu run`](#nen-shu-run), [`shu deploy`](#nen-shu-deploy), [`shu coverage`](#nen-shu-coverage) | no | `--dry-run` | prints every step's exact argv, cwd and env NAMES and spawns **nothing**. All ten are `dry-run-gated` in izanami's automation-policy table: the bare form classifies **mutating** — the argv comes from a file in the *target* repository, and certifying it read-only sight unseen would certify whatever it happens to contain — and the `--dry-run` form classifies **read-only**, because nen renders and spawns nothing whatever that file says. `deploy` additionally requires `--target <name>`, with no default ever -- resolved after the lane, the verb and the host, so a lane that declares no deploy answers its own refusal first. On `dev` and `run`, `--json` is **refused** without `--dry-run`. `coverage` additionally **parses** the report its run produced — and its `--dry-run` parses nothing either, so the report sitting on disk from a previous run is never read |
| [`shu tools`](#nen-shu-tools) | yes — nen writes nothing, but see the note | `--install` | the **only verb in this CLI whose blast radius is the developer's machine**, and the only row with three izanami answers rather than two. The bare check form spawns the version probes the *target repository* declares, so it classifies **`unknown`** — refused, and honestly labelled "not provably a read" rather than mislabelled "writes"; `--install` classifies **mutating**; and `--dry-run` classifies **read-only**, because that form spawns nothing at all, probes included. `--install --dry-run` is refused anyway: the write flag is decisive, because a read-only claim that hinges on one adjacent token still being present is exactly what the write-flag rule exists for |
| [`shu warmup`](#nen-shu-warmup) | no | `--dry-run` | **the only verb in the `shu` family that mutates git state.** `--dry-run` prints every git command *and* every delegated toolchain command, in order, and runs **none** of them — not even the fetch. Unlike the ten rows above, that form still classifies **mutating** in izanami's table, dry run included: nobody watches a warm-up, so the fail-closed answer costs nothing. `--discard` is its *other* dangerous flag, and it is the destructive one: without it a dirty tree is refused at exit 2 with every path listed, and with it the tree is reset and cleaned (`git reset --hard`, then `git clean -fd`) and then **read again**, refusing at 2 if anything survived — but **never** `git clean -x` and never a second `-f`, because an ignored file is the developer's own cache and a nested repository is not this verb's to delete |

"Still reads GitHub" matters in CI: a dry run of those three needs a token even
though it writes nothing.

### Taxonomy as data

Nen hard-codes no label names, no repository names, no reviewer names and no
colours. Every verb that needs a repository's own vocabulary reads it from that
repository's `nen/` directory, at the path `--repo` names:

| File | What it holds | What reads it |
|---|---|---|
| `nen/labels.json` | the label set — names, colours, descriptions | [`labels sync`](#nen-labels-sync), [`label apply`](#nen-label-apply), [`issue file`](#nen-issue-file), [`issue consolidate-close`](#nen-issue-consolidate-close), [`idea file`](#nen-idea-file), [`schema check`](#nen-schema-check) |
| `nen/repos.json` | the registry — consumers, product codes, per-consumer pins, recorded scenarios | [`repo resolve`](#nen-repo-resolve), [`repo scenario`](#nen-repo-scenario), [`ref format`](#nen-ref-format), [`fanout compute`](#nen-fanout-compute), [`fanout record`](#nen-fanout-record), [`warmup`](#nen-warmup), [`canon resolve`](#nen-canon-resolve), [`parse futon`](#nen-parse-futon), [`pr ready`](#nen-pr-ready) (ref resolution), [`schema check`](#nen-schema-check) |
| `nen/colors.yml` | the status-colour precedence for board rendering | [`color status`](#nen-color-status), [`schema check`](#nen-schema-check) |
| `nen/gates.json` | reviewer identities for the readiness check | [`pr ready`](#nen-pr-ready), [`pr next-blocker`](#nen-pr-next-blocker), [`schema check`](#nen-schema-check) |
| `nen/contract.json` | optional — `dependency` (what this repository needs *from* nen: the version floor, the pinned ref, the bootstrap) and `project` (its stack declaration: lanes, per-lane verbs, toolchain pins) | [`shu detect`](#nen-shu-detect) (proposes the `project` block), [`shu build`/`test`/`lint`/…](#family-shu) (every argv they run comes from it), [`shu tools`](#nen-shu-tools) (the `toolchain` pins), [`scaffold init`](#nen-scaffold-init) and [`scaffold new`](#nen-scaffold-new) (write it into absence; `init` also reads `dependency.pinnedRef` for the CI file's ref), [`schema check`](#nen-schema-check) |

`nen/` holds committed configuration only. Generated output goes to a
dot-prefixed, gitignored `.nen/`; the two have opposite lifetimes, and the
one-character difference is what keeps a build log out of a review.

**The legacy `schemas/` location.** Before v0.3 the four taxonomy files lived in
a `schemas/` directory. Nen still reads them from there when `nen/` does not
carry them, so an un-migrated repository keeps working for the whole v0.3 line;
that fallback is **removed in v0.4.0**. It is read-only — nothing in nen writes
to `schemas/` — and [`schema check`](#nen-schema-check) is where the migration
state is reported: a file read from the legacy location gets a `warn` row naming
the canonical path, and a file present in BOTH with different bytes is a
*shadowed leftover* that fails the check, because `nen/` wins the read and the
copy somebody may still be editing is the one nen ignores. That comparison is
**byte-exact**: two copies differing only in line endings (a CRLF/LF drift a
checkout can produce on its own) count as different, because "identical" is
what licenses deleting one of them. A "no such file" refusal names both
locations.

The fallback covers the four taxonomy files and nothing else. `nen/contract.json`
is new in this line and has **no** legacy location — no released nen ever read
one — so a repository's own unrelated file under `schemas/` is never claimed as
a nen contract.

**An explicitly pinned path does not move on its own.** The fallback answers only
for paths nen resolves itself. A caller that hard-codes a location — `pr ready
--gates schemas/gates.json`, or `gate derive --policy-paths "schemas/,…"` — is
naming a path, and nen takes it literally: `--gates` deliberately does not fall
back, since a flag that quietly read a different file than the one it was handed
would be worse than a refusal. Move those pins along with the files, in the same
change; `schema check` will not warn about them, because it never sees them.

A repository carrying none of these can still use the repository-agnostic verbs
([`commit format`](#nen-commit-format), [`ref parse`](#nen-ref-parse),
[`split verify`](#nen-split-verify), [`quality perf-compare`](#nen-quality-perf-compare),
the [`parse`](#family-parse) family, …). A verb that needs one and does not find
it **refuses explicitly, naming the exact file and path it looked for**, rather
than guessing or falling back to a built-in default that would belong to some
other project. `pr ready` and `pr next-blocker` accept `--gates <path>` to point
at a gates file outside the target repository;
[`schema check`](#nen-schema-check) reports every file's verdict at once and
is the fastest way to find out which one is missing.

### Platform parity

Nen behaves identically on macOS, Linux and Windows under Git Bash: one binary,
plus `git` and `gh` on `PATH`. There is no `make`, no `bats`/`pytest`, no
runtime Python, and no `jq`/`yq` anywhere nen's own tooling runs. Nen only ever
shells out to `git` and `gh` — which is why [`stop`](#nen-stop) renders a banner
but never fires an OS notification, and why [`watch until`](#nen-watch-until)
spawns its command directly with no shell (a shell builtin fails at spawn, and
a pipeline is not a command it can classify).

### Getting the binary

Each published GitHub release attaches binaries for `linux-x64`,
`darwin-arm64` and `windows-x64` alongside a `SHA256SUMS` manifest. Cutting a
tag does not by itself publish a release, so the assets exist once a release
has actually been published for that tag — not the moment
[`tag cut`](#nen-tag-cut) runs. Fetch the bootstrap script, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.2.0/bootstrap/nen.sh -o nen-bootstrap.sh
bash nen-bootstrap.sh --ref v0.2.0
```

It verifies the downloaded binary against that manifest, caches it under
`${XDG_CACHE_HOME:-$HOME/.cache}/nen`, and prints the path to a verified,
executable binary on stdout and nothing else — so it composes directly:

```bash
nen="$(bash nen-bootstrap.sh --ref v0.2.0)"
"$nen" --version
```

There is no `latest`: `--ref` is required with no fallback, because a bootstrap
that picked the newest release would convert a source-pinned supply chain into
an unpinned one. Every integrity failure fails closed — an unfetchable or
malformed manifest, an artifact missing from it, a digest mismatch, or a host
with no hashing tool — and mismatching bytes are deleted rather than kept. The
script never prints a path to a binary it did not verify, because its caller's
next act is to execute that path.

The exit codes are a published contract, from `bootstrap/nen.sh`'s own header,
so a caller can tell an operational failure from a security one without parsing
stderr:

| Code | Meaning | Retry? |
|---|---|---|
| `0` | verified; the path is on stdout | — |
| `2` | usage error — nothing was attempted | fix the invocation |
| `3` | unsupported host — no binary is published for this OS/arch | no |
| `4` | the binary asset could not be downloaded | **yes — the only retryable one** |
| `5` | checksum mismatch, or no hashing tool to verify with (`sha256sum`/`shasum`/`openssl`) | **never** — this is a security failure |
| `6` | `SHA256SUMS` unfetchable, missing, malformed, or silent about the artifact | **never** |
| `7` | the `nen bootstrap` wrapper could not run the script at all (no `bash`, script not found) | fix the environment |

Code `7` comes from the TypeScript wrapper rather than the script, and is
distinct from anything the script itself returns. Once a binary is on disk,
[`nen bootstrap`](#nen-bootstrap) is the in-CLI form of the same fetch, for a
job that already has one `nen` and wants a pinned second one.

## Verb index

All 84 verbs, grouped as the README groups them. **Reads** is what a
verb actually opens — a taxonomy file under `--repo`, a caller-supplied
file, `git`, or GitHub through `gh`; it is the fastest way to tell which
verbs need a token and which run offline. Every verb accepts the global
`--repo <path>` and, where the **`--json`** column says yes, `--json`.

| Family | Verb | Purpose | Reads | `--json` |
|---|---|---|---|---|
| [`pr`](#family-pr) | [`nen pr ready`](#nen-pr-ready) | CON-32 readiness verdict for one pull request | nen/gates.json + nen/repos.json (or --gates/--reviewers/--gh-repo), github (gh api graphql/rest) | yes |
| [`pr`](#family-pr) | [`nen pr staleness`](#nen-pr-staleness) | stale + Ready merge-permission arithmetic over a verified-wake history | caller-supplied --wakes-from JSON file, no schema/git/gh | yes |
| [`pr`](#family-pr) | [`nen pr body-check`](#nen-pr-body-check) | checks a PR body against caller-supplied requirement patterns | caller-supplied --body-from/--requirements-from files | yes |
| [`pr`](#family-pr) | [`nen pr fetch`](#nen-pr-fetch) | one typed snapshot of a PR: head sha, mergeability, check rollup, per-commit reviews, review threads, pending review requests | github (gh) | yes |
| [`pr`](#family-pr) | [`nen pr next-blocker`](#nen-pr-next-blocker) | the first blocking condition, in fixed order (conflict, red check, owed round, unresolved thread, missing body requirement) | nen/gates.json (or --gates), github (gh) | yes |
| [`pr`](#family-pr) | [`nen pr cascade-main`](#nen-pr-cascade-main) | merges (never rebases) the trunk into the current branch and pushes on a clean merge | git (fetch/merge/push, reaches origin) | yes |
| [`pr`](#family-pr) | [`nen pr retarget`](#nen-pr-retarget) | gh pr edit --base, for a stacked PR after its predecessor merges | github (gh) | yes |
| [`pr`](#family-pr) | [`nen pr request-reviews`](#nen-pr-request-reviews) | gh pr edit --add-reviewer, once per name | github (gh) | yes |
| [`gate`](#family-gate) | [`nen gate derive`](#nen-gate-derive) | derive G2 vs G4 from a changed-file set against two caller-supplied path sets | git diff (for --range), no schema file -- path sets are flags | yes |
| [`split`](#family-split) | [`nen split verify`](#nen-split-verify) | prove the union of per-axis branch diffs equals one original diff | caller-supplied --original/--branches diff files, no git/gh | yes |
| [`wc`](#family-wc) | [`nen wc classify`](#nen-wc-classify) | classify the working copy as must-move / on-branch-dirty / on-branch-clean | git (branch, status, ahead-count) | yes |
| [`stage`](#family-stage) | [`nen stage triage`](#nen-stage-triage) | flag secret-shaped, ignored, binary, out-of-scope and unmentioned-deletion files before staging | git status --porcelain | yes |
| [`backlog`](#family-backlog) | [`nen backlog fetch`](#nen-backlog-fetch) | fetches open issues + open PRs fresh over 'gh api' (never cached) and assembles one row per effort | gh (issues, pulls, paginated) | yes |
| [`backlog`](#family-backlog) | [`nen backlog order`](#nen-backlog-order) | applies backlog-loop's severity/blocks/consumer/age priority order to a pre-fetched row set | local file (--rows-from) | yes |
| [`board`](#family-board) | [`nen board build`](#nen-board-build) | assembles a Board from already-computed rows (gate from 'gate derive', colour from 'color status') | local file (--rows-from) | yes |
| [`board`](#family-board) | [`nen board render`](#nen-board-render) | renders a Board snapshot as the padded-markdown table bankai-core's own script established | local file (--board-from) | yes |
| [`board`](#family-board) | [`nen board diff`](#nen-board-diff) | field-level diff of two Board snapshots, by row id | local files (--before, --after) | yes |
| [`epic`](#family-epic) | [`nen epic next-wave`](#nen-epic-next-wave) | flips a completed child, redraws the progress bar, computes the next releasable wave | local file (--body-file), optional write (--out) | yes |
| [`effort`](#family-effort) | [`nen effort classify`](#nen-effort-classify) | classifies one epic/child against senkei's five-class (plus undecidable) taxonomy from caller-supplied facts | local file (--input) | yes |
| [`loop`](#family-loop) | [`nen loop slots`](#nen-loop-slots) | counts how many CI and local concurrency slots are free, from a caller-supplied efforts file and explicit caps | local file (--efforts) | yes |
| [`warmup`](#family-warmup) | [`nen warmup`](#nen-warmup) | warms a REGISTRY: detects stale/unpinned consumer versions, plus an optional handbook-question sweep. Reads only. Not [`nen shu warmup`](#nen-shu-warmup), which warms a working copy | nen/repos.json, optional local files | yes |
| [`watch`](#family-watch) | [`nen watch until`](#nen-watch-until) | polls one read-only observation command until its condition holds, paced and bounded | whatever --command names (typically git or gh) | yes |
| [`label`](#family-label) | [`nen label apply`](#nen-label-apply) | applies one label to one object and appends a durable, after-the-fact ledger line | nen/labels.json; gh only with --run | yes |
| [`labels`](#family-labels) | [`nen labels sync`](#nen-labels-sync) | creates or updates every taxonomy label on a target repository | nen/labels.json; gh unless --dry-run | yes |
| [`labels`](#family-labels) | [`nen labels rename`](#nen-labels-rename) | renames labels in place, preserving every issue association, idempotently | gh label list (always), gh label edit unless --dry-run | yes |
| [`schema`](#family-schema) | [`nen schema check`](#nen-schema-check) | loads and validates the files a repository is expected to carry under nen/, reporting each one's verdict and where it was read from | nen/labels.json, repos.json, colors.yml, gates.json, contract.json (optional) | yes |
| [`color`](#family-color) | [`nen color status`](#nen-color-status) | resolves one row's colour token by the repository's own nen/colors.yml precedence | nen/colors.yml | yes |
| [`repo`](#family-repo) | [`nen repo resolve`](#nen-repo-resolve) | resolves a repository token (code, slug, short name, or 'all') against the registry, or the cwd's own origin | nen/repos.json; git (no-token form) | yes |
| [`repo`](#family-repo) | [`nen repo inventory`](#nen-repo-inventory) | senkei's live enumeration: epics + children, integration branches, open PRs | gh (issue list, api sub_issues/branches/compare, pr list) | yes |
| [`repo`](#family-repo) | [`nen repo scenario`](#nen-repo-scenario) | reads back the scenario recorded for one --target in the registry | nen/repos.json | yes |
| [`ref`](#family-ref) | [`nen ref format`](#nen-ref-format) | formats the &lt;CODE&gt;-&lt;IS\|PR&gt;-#&lt;N&gt; notation, checking the code against the registry first | nen/repos.json | yes |
| [`ref`](#family-ref) | [`nen ref parse`](#nen-ref-parse) | parses a token in object notation | none | yes |
| [`release`](#family-release) | [`nen release preflight`](#nen-release-preflight) | every getsuga §2 release-cut precondition, checked and reported whole | github (gh variable get, git ls-remote), CHANGELOG.md, changelog.d/, git log --merges | yes |
| [`release`](#family-release) | [`nen release resolve-target`](#nen-release-resolve-target) | resolve a release token (main/last-commit/checkout/hash/branch) to a SHA and test trunk ancestry | git (fetch/rev-parse/merge-base, reaches origin) | yes |
| [`release`](#family-release) | [`nen release self-check`](#nen-release-self-check) | whether a release PR should list itself in its own range | git (merge-base ancestry, local only) | yes |
| [`changelog`](#family-changelog) | [`nen changelog fragment-required`](#nen-changelog-fragment-required) | whether a change owes a changelog.d/ fragment (CON-33(a)) | git diff/caller files, CHANGELOG.md at base+head, optional nen/repos.json-shaped --base-repos/--head-repos | yes |
| [`changelog`](#family-changelog) | [`nen changelog collate`](#nen-changelog-collate) | collate every changelog.d/ fragment into a new dated CHANGELOG.md section (CON-33(b)) | changelog.d/, CHANGELOG.md | yes |
| [`changelog`](#family-changelog) | [`nen changelog completeness`](#nen-changelog-completeness) | every PR merged in a range has a CHANGELOG entry or an (un)collated fragment (CON-33(c)) | git log --merges, CHANGELOG.md, changelog.d/ | yes |
| [`tag`](#family-tag) | [`nen tag cut`](#nen-tag-cut) | cut an annotated git tag pinned at an explicit SHA, never auto-pushed | git (tag/ls-remote/merge-base; --push also reaches origin) | yes |
| [`fanout`](#family-fanout) | [`nen fanout compute`](#nen-fanout-compute) | which registered consumers (nen/repos.json) are affected by workflows changed in a release range | nen/repos.json, git diff, .github/workflows/ | yes |
| [`fanout`](#family-fanout) | [`nen fanout record`](#nen-fanout-record) | the same computation, appended to an audit ledger file | nen/repos.json, git diff, .github/workflows/, ledger file | yes |
| [`run`](#family-run) | [`nen run rerun-failed`](#nen-run-rerun-failed) | re-run a workflow run's failed jobs (gh run rerun --failed) | github (gh) | yes |
| [`issue`](#family-issue) | [`nen issue search`](#nen-issue-search) | duplicate-search the backlog before filing: four gh passes (open subject, recently-closed subject, files+rule-ids, lane) reported with what each was for | gh (issue list x4) | yes |
| [`issue`](#family-issue) | [`nen issue open-pr-check`](#nen-issue-open-pr-check) | which candidate issues carry an OPEN pull request that closing would orphan | gh (pr list) | yes |
| [`issue`](#family-issue) | [`nen issue file`](#nen-issue-file) | file an issue with labels and assignee IN the create call, refusing any label the target taxonomy does not carry or that a forbidden family names | nen/labels.json; gh (issue create) | yes |
| [`issue`](#family-issue) | [`nen issue comment`](#nen-issue-comment) | post one caller-supplied comment on one issue (or, deliberately, one PR) number | gh (issue comment / api) | yes |
| [`issue`](#family-issue) | [`nen issue attach-sub`](#nen-issue-attach-sub) | attach children as GitHub sub-issues under a parent, certifying every number as an ISSUE (never a PR) before the first write | gh (api reads, sub_issues POST) | yes |
| [`issue`](#family-issue) | [`nen issue consolidate-close`](#nen-issue-consolidate-close) | the file-&gt;attach-&gt;close choreography: union labels, reduce one severity family to its strongest label, guard every child for an open PR, close each with a comment | nen/labels.json; gh (api reads, sub_issues POST, issue close/comment) | yes |
| [`issue`](#family-issue) | [`nen issue chain-position`](#nen-issue-chain-position) | classify where an OPEN issue sits on its delivery chain, from its labels alone | gh (api read) | yes |
| [`issue`](#family-issue) | [`nen issue terminus`](#nen-issue-terminus) | classify which object ends an issue's delivery run (its own PR, each child's PR, or one integration-branch delivery PR) | gh (api read) | yes |
| [`idea`](#family-idea) | [`nen idea file`](#nen-idea-file) | file an idea issue (reusing issue file's own choreography), then read it back over the API and diff title/body/labels against what was submitted | nen/labels.json; gh (issue create + api read) | yes |
| [`scaffold`](#family-scaffold) | [`nen scaffold init`](#nen-scaffold-init) | stand an EXISTING repository up: the directory skeleton, the trailer-enforcing commit-msg hook, a canon-values.yml template, nen/contract.json's project block, the schemas/-&gt;nen/ copy migration, the stack's CI workflow, .gitignore upkeep, and a closing `shu tools` CHECK that installs nothing | nen/contract.json + the legacy schemas/ copies; the bundled profiles pack and templates/; writes to disk under --repo; spawns the version probes the target declares (never on --dry-run) | yes |
| [`scaffold`](#family-scaffold) | [`nen scaffold new`](#nen-scaffold-new) | write a FRESH tree for one stack into an empty --dir: the template's files with {{name}} substituted, the CI workflow, .gitignore, the hook, and nen/contract.json as `shu detect` proposes it off the marker just written -- every post-step PRINTED, none run | the bundled profiles pack and templates/; writes to disk under --dir; spawns nothing at all | yes |
| [`canon`](#family-canon) | [`nen canon resolve`](#nen-canon-resolve) | resolve a target repo's always-load handbook set plus its ONE stack handbook, from the scenario nen/repos.json records for it | nen/repos.json | yes |
| [`canon`](#family-canon) | [`nen canon mirror generate`](#nen-canon-mirror-generate) | substitute every {{TOKEN}} in each canonical rule file into a mirror directory, writing only changed files and deleting orphans | caller-named --rules-dir + --canon-values file; writes --out-dir; no git/gh | yes |
| [`canon`](#family-canon) | [`nen canon mirror check`](#nen-canon-mirror-check) | regenerate the mirror in memory and diff it against the committed --mirror-dir: missing / extra / stale / hand-edited | caller-named --rules-dir + --canon-values + --mirror-dir; no git/gh | yes |
| [`quality`](#family-quality) | [`nen quality tooling`](#nen-quality-tooling) | look up the e2e/adversarial/perf tooling recorded for a scenario in a caller-supplied table | caller's own --table JSON (never a table shipped in nen) | yes |
| [`quality`](#family-quality) | [`nen quality perf-compare`](#nen-quality-perf-compare) | classify a measured-vs-baseline regression at QA-13's fixed 10%/25% thresholds | none (pure arithmetic over the two numbers given) | yes |
| [`quality`](#family-quality) | [`nen quality method-check`](#nen-quality-method-check) | validate a QA-15 method block: device/OS stated, Release with no debugger, n&gt;=5 with the first discarded, median+p90, thermal+network stated | caller's own --input JSON method block | yes |
| [`commit`](#family-commit) | [`nen commit format`](#nen-commit-format) | format and validate ONE Conventional Commits message's shape (type, subject, scope, breaking, trailers) -- never its content | none | yes |
| [`shu`](#family-shu) | [`nen shu detect`](#nen-shu-detect) | read the markers on disk and PROPOSE a nen/contract.json project block; never writes without --write and never overwrites one | the target repo's own files (framework configs, package.json, project files); writes nen/contract.json only with --write | yes |
| [`shu`](#family-shu) | [`nen shu build`](#nen-shu-build) | compile or assemble a lane, from the invocation its declaration states | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu test`](#nen-shu-test) | run a lane's test suite, from the invocation its declaration states | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu ui-test`](#nen-shu-ui-test) | run a lane's UI/E2E suite, from the invocation its declaration states | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu lint`](#nen-shu-lint) | run a lane's linter and format check, from the invocation its declaration states | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu archive`](#nen-shu-archive) | produce a lane's distributable artifact, where its declaration states one | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu release`](#nen-shu-release) | publish a lane's artifact, where its declaration states a publication step | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu dev`](#nen-shu-dev) | start a lane's DEBUG build; long-running, on this terminal | nen/contract.json (project block); inherits stdio unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu run`](#nen-shu-run) | start a lane's PRODUCTION build locally; long-running, on this terminal | nen/contract.json (project block); inherits stdio unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu deploy`](#nen-shu-deploy) | send a build to a declared, NAMED target -- --target is required and has no default, and a lane whose deploy is a seat refuses with its own reason whatever --target says | nen/contract.json (project block + project.targets: the destination's args, the env NAMES it requires, or the sentence saying it has no command line); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu coverage`](#nen-shu-coverage) | run a lane's coverage command and PARSE the report it produced into one shape -- totals, per-target rows, and `--threshold`'s `met`, which never moves the exit code | nen/contract.json (project block); spawns the declared argv unless --dry-run, then READS the report the verb's `artifacts` name | yes |
| [`shu`](#family-shu) | [`nen shu tools`](#nen-shu-tools) | check the host toolchain a declaration pins (exit 5 when anything is missing or wrong), and with --install install what corepack can | nen/contract.json (project.toolchain + dependency); spawns each declared version probe unless --dry-run; spawns an installer only with --install | yes |
| [`shu`](#family-shu) | [`nen shu warmup`](#nen-shu-warmup) | warm a WORKING COPY: clean, fetch, fast-forward the trunk, cut the named branch, verify the declared build -- the one `shu` verb that mutates git state. Not [`nen warmup`](#nen-warmup), which sweeps a registry and reads only | git in --repo (unless --dry-run); nen/contract.json (project block) for the build/test half | yes |
| [`dev`](#family-dev) | [`nen dev test`](#nen-dev-test) | run this checkout's own vitest suite via `bun run test` | package.json + vitest.config.ts under --repo | no *(stdio)* |
| [`dev`](#family-dev) | [`nen dev lint`](#nen-dev-lint) | run this checkout's own eslint via `bun run lint` | package.json + eslint config under --repo | no *(stdio)* |
| [`dev`](#family-dev) | [`nen dev replay`](#nen-dev-replay) | replay the imported dedupe corpus slice against nen's own normalizeTitle/findCanonical and report any disagreement | tests/fixtures/dualrun-slice/dedupe/*.json (or --slice-dir) | yes |
| [`parse`](#family-parse) | [`nen parse <skill>`](#nen-parse-skill) | parse an arbitrary skill's invocation against a caller-supplied --grammar template, echo the parse, or refuse with a corrected line | none | yes |
| [`parse`](#family-parse) | [`nen parse futon`](#nen-parse-futon) | parse futon's own grammar and resolve its repo token against the target repo's nen/repos.json, refusing a 'then &lt;terminal&gt;' clause on a repo that is not the caller's own | nen/repos.json | yes |
| [`parse`](#family-parse) | [`nen parse izanagi`](#nen-parse-izanagi) | parse izanagi's MUTATING-loop grammar, refusing when 'up to &lt;N&gt;' is absent | none | yes |
| [`parse`](#family-parse) | [`nen parse izanami`](#nen-parse-izanami) | parse izanami's READ-ONLY-loop grammar and classify every command in it against izanami's own allow/refuse table | none | yes |
| [`bootstrap`](#family-bootstrap) | [`nen bootstrap`](#nen-bootstrap) | fetch, checksum-verify and cache a pinned nen binary by running bootstrap/nen.sh, relaying its verified path and exit code unchanged | bootstrap/nen.sh under --repo; network (GitHub release assets + SHA256SUMS) | no *(stdio)* |
| [`wake`](#family-wake) | [`nen wake verify`](#nen-wake-verify) | scan open PRs whose author matches --author-pattern for a swallowed (action_required/startup_failure, never-executed) workflow run, auto-redriving what is safe and flagging the rest for a human | gh (pulls, actions/runs, issue comments; --run also writes reruns + comments) | yes |
| [`wake`](#family-wake) | [`nen wake fire`](#nen-wake-fire) | edge-trigger one object by removing then re-applying a label, then post an optional settle comment | gh (issue edit x2, api comment; --run required to write) | yes |
| [`stop`](#family-stop) | [`nen stop`](#nen-stop) | render the gate-stop banner plus a padded-markdown efforts table read from a file/stdin, or (--template) a blank table to fill in | a local efforts.md file or stdin; no git/gh | yes |

## Readiness & pull requests

The CON-32 readiness verdict and the pull-request mechanics built around it,
plus the three checks a working copy answers before a pull request exists and
the proof that a split branch set left nothing behind. Nothing in this group
merges, labels or comments on anything.

<a id="family-pr"></a>

**`nen pr`**

CON-32 readiness and the pull-request mechanics built around it: a
deterministic Ready/not-ready verdict (`ready`), staleness/merge-permission
arithmetic (`staleness`), a PR-body template check (`body-check`), a typed
state snapshot (`fetch`), the first blocking condition in a fixed order
(`next-blocker`), a trunk cascade-merge (`cascade-main`), and two narrow `gh
pr edit` mutations (`retarget`, `request-reviews`). `ready` and `next-blocker`
read reviewer identities from `nen/gates.json` (or an explicit `--gates`
file, or a reduced `--reviewers` set with no default); `ready`'s ref
resolution also reads `nen/repos.json`'s `product_codes`. This family
never merges, labels, or comments on a pull request.

### `nen pr ready`

Reports one pull request's CON-32 readiness: the deterministic gate's
verdict, quoted, plus the first failing conjunct — nothing else. It is
read-only: it never labels, merges or comments, and it holds no readiness
*authority* today (the shell gate still does; see the verb's own header for
the shadow-window position). A `<CODE>#<N>` ref is resolved through the
target repository's `nen/repos.json` `product_codes`; a bare number needs
`--gh-repo`. Reviewer identities come from exactly one of `--gates <path>`,
the target repo's `nen/gates.json`, or `--reviewers a,b,c` — there is no
built-in default set, and with none of the three the verb refuses rather than
guessing.

**Usage**

```text
nen pr ready <ref> [--explain] [--gh-repo <owner/name>] [--reviewers <a,b,c>] [--approvers <a,b>] [--round-policy strict|bounded] [--exclude-run <id>] [--gates <path>] [--token-env <VAR>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `<ref>` | yes | `<CODE>#<N>` (the `#` optional) or a bare `<N>` with `--gh-repo` | the shorthand splits at the LONGEST trailing digit run; a code ending in a digit needs the `#` |
| `--gh-repo <owner/name>` | no | the repository, when `<ref>` is a bare number | wins over a code if both are given |
| `--explain` | no | print the full conjunct table plus what the gate does not decide | suppressed by `--json` (the JSON already carries the table) |
| `--reviewers <a,b,c>` | no | the configured reviewer set | also the identity source of last resort — see `--gates` |
| `--approvers <a,b>` | no | the approval set, on the `--reviewers` identity path only | omitted defaults to the reviewer set (conservative: everyone must approve), never to "nobody" |
| `--round-policy <p>` | no | `strict` \| `bounded` | default `bounded` |
| `--exclude-run <id>` | no | drop one Actions run's own checks (CON-36 clause 3) | numeric run id; pass only from inside that run's own job |
| `--gates <path>` | no | read reviewer identities from this file instead of `nen/gates.json` | a RELATIVE path resolves against `--repo`, never cwd |
| `--token-env <VAR>` | no | env var holding the GitHub token | default `GH_TOKEN`; never read ambiently |
| `--repo <path>` | no | the checkout whose `nen/` is read | default cwd |
| `--json` | no | machine contract `nen.pr.ready/v0.1` | — |

**Output and exit codes** — human line is `<repo>#<pr>: <gateLine>` (or the
full conjunct table with `--explain`); `--json` top-level keys: `contract`,
`verdict` (`ready`\|`not-ready`\|`unevaluated`), `gateLine`, `firstFailing`,
`conjuncts[]`, `caveats[]`, `remedy`, `meta`. Exit 0 only on `verdict: ready`;
exit 1 on `not-ready` **or** `unevaluated` (a non-zero exit never means
"cleared" — SKILL.md §4's "absence is never a pass"); exit 2 on a malformed
ref, an unresolvable code, or no reviewer-identity source at all (a usage
problem, never a verdict).

**Example**

```bash
nen pr ready 5 --gh-repo zheref/nen --reviewers alice --token-env NEN_TEST_DEFINITELY_UNSET_TOKEN --json
```
```text
{
  "contract": "nen.pr.ready/v0.1",
  "verdict": "unevaluated",
  "gateLine": "unevaluated: no usable token, so GitHub could not be read",
  ...
}
```
exit 1 (no usable token, so GitHub could not be read — never read as ready)
(from a real run — the first four keys of an eleven-key document, elided at `...`. This verb normally reaches GitHub, but an unset `--token-env` short-circuits before the network, so the invocation as printed is fully offline-runnable and the `unevaluated` verdict is produced without a token. The same shape is asserted by `src/pr/command.test.ts`'s "`--json` is the SAME invocation whether given before or after 'pr'" case.)

### `nen pr staleness`

Answers whether a pull request is STALE (>=2 verified no-commit wakes AND
>=60 idle minutes, both overridable) and, if it is also independently known
to be Ready, whether the one merge a non-human actor may make is permitted.
Pure arithmetic over a caller-supplied wake history — it fetches nothing
itself.

**Usage**

```text
nen pr staleness --wakes-from <path> --last-activity <ISO> --now <ISO> [--ready] [--min-verified-wakes <n>] [--idle-minutes <n>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--wakes-from <path>` | yes | a JSON array of `{ at, noCommit }` | each `noCommit` must be a real boolean — a truthy string like `"false"` is refused, not coerced |
| `--last-activity <ISO>` | yes | the PR's last-activity instant | refused by name AND value if unparseable |
| `--now <ISO>` | yes | the instant this check reasons about | never the live clock, so a replay is reproducible |
| `--ready` | no | the PR is independently known to be CON-32 Ready | default false |
| `--min-verified-wakes <n>` | no | override the wake threshold | default 2 |
| `--idle-minutes <n>` | no | override the idle threshold | default 60 |
| `--repo <path>` | no | resolves `--wakes-from` against this root | default cwd |
| `--json` | no | machine-readable report | — |

**Output and exit codes** — human lines: `stale`/`not stale`, `merge
PERMITTED (stale + Ready)`/`merge not permitted`, then the two threshold
reasons; `--json` top-level keys: `verifiedNoCommitWakes`, `idleMinutes`,
`stale`, `mergePermitted`, `reasons[]`. Always exits 0 (a report, not a
guard); exit 2 on a missing/malformed flag, a non-boolean `noCommit`, or an
unparseable `--now`/`--last-activity`.

**Example**

```bash
nen pr staleness --wakes-from wakes.json --last-activity 2026-09-07T18:00:00Z --now 2026-09-07T20:05:00Z --ready
```
```text
stale
merge PERMITTED (stale + Ready)
2/2 verified no-commit wake(s) (met)
125/60 idle minute(s) (met)
```
(from a real run, `wakes.json` = `[{"at":"2026-09-07T18:00:00Z","noCommit":true},{"at":"2026-09-07T19:00:00Z","noCommit":true}]`)

### `nen pr body-check`

Checks a pull-request body against this repository's own template
requirements — every requirement is checked, never stopping at the first
miss. The requirement patterns are never built in.

**Usage**

```text
nen pr body-check --body-from <path> --requirements-from <path>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--body-from <path>` | yes | the pull-request body to check | plain text |
| `--requirements-from <path>` | yes | a JSON array of `{ name, pattern }` | an empty array is refused, exit 1 — a vacuous pass having checked nothing is never reported as success |
| `--repo <path>` | no | resolves `--body-from`/`--requirements-from` against this root | default cwd |
| `--json` | no | machine-readable report | — |

**Output and exit codes** — human lines: `<n>/<total> requirement(s)
satisfied`, then `ok`/`MISSING` per requirement; `--json` top-level keys:
`results[]` (`name`, `pattern`, `satisfied`), `ok`. Exit 0 when every
requirement is satisfied, exit 1 when at least one is missing **or** the
requirement list is empty, exit 2 on a missing flag.

**Example**

```bash
nen pr body-check --body-from body.md --requirements-from req.json
```
```text
3/3 requirement(s) satisfied
ok  summary
ok  how-to-verify
ok  test-plan
```
(from a real run; `req.json` = `[{"name":"summary","pattern":"## Summary"},{"name":"how-to-verify","pattern":"## How to verify"},{"name":"test-plan","pattern":"## Test plan"}]` against a body carrying all three headings)

### `nen pr fetch`

Fetches one typed snapshot of a pull request: head SHA, mergeability, the
check rollup, reviews **per commit**, review threads with resolution state,
and pending review requests. Read-only.

**Usage**

```text
nen pr fetch --target <owner/name> --pr <n>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | the GitHub repository | the GitHub-side counterpart of `--repo`; omitting it is a usage message but exits **1**, not 2 (a plain `Error`, not a `VerbUsageError`) |
| `--pr <n>` | yes | the pull-request number | a missing/non-numeric value exits 2 |
| `--json` | no | machine-readable snapshot | — |

This verb reads no `--repo` — the snapshot comes entirely from `--target`/`--pr` over `gh`, never from a local checkout.

**Output and exit codes** — human lines: `#<n> <title>`, head/base/sha,
mergeable/mergeStateStatus, check/review/thread counts; `--json` top-level
keys: `pr` (`number`, `headSha`, `baseRef`, `headRef`, `author`, `labels`,
`mergeable`, `isDraft`), `title`, `url`, `body`, `state`, `mergeStateStatus`,
`checks[]`, `reviews[]`, `reviewRequests[]`, `reviewThreads[]`. Exit 0 on a
successful fetch, exit 1 on a GitHub/network failure, exit 1 on a missing
`--target`, exit 2 on a missing/invalid `--pr`.

**Example**

```bash
nen pr fetch --target o/n --pr 9
```
```text
#9 a PR
  feature/x -> main  abc123
  mergeable: MERGEABLE  mergeStateStatus: CLEAN
  checks: 1  reviews: 2  review requests: 0
  review threads: 0 (0 unresolved)
```
(from `src/pr/command.test.ts`'s scripted `next-blocker` fixture, which drives the same `fetchPullRequest` this verb calls and prints the same three `gh` calls' worth of data — this verb reaches GitHub, so it was not run live here; `o/n` and `#9` are the test's own placeholder target/number, since `printSnapshot` never prints the target itself)

### `nen pr next-blocker`

Reports the FIRST blocking condition, in a fixed order: conflict -> red
required check -> owed reviewer round -> unresolved thread -> missing body
requirement (`## How to verify`, CON-17). It does not re-derive the CON-32
predicates; it composes the ported, tested gate engine over one fetched
snapshot. The changelog.d/ fragment half of CON-33(a) is diff-shaped and not
checked here.

**Usage**

```text
nen pr next-blocker --target <owner/name> --pr <n> --repo <path> [--reviewers a,b] [--policy bounded|strict] [--delivery-pr] [--gates <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | the GitHub repository | missing exits 1 (see `pr fetch`'s note) |
| `--pr <n>` | yes | the pull-request number | missing/invalid exits 2 |
| `--repo <path>` | **yes** | the checkout whose `nen/gates.json` supplies identities | usage lists it unbracketed; an omitted `--repo` is refused by name at exit 2, never silently read from cwd (#28) |
| `--reviewers <a,b>` | no | override reviewer set | an explicitly empty value (`""`, `","`) is refused at exit 2, never read as "nothing owed" |
| `--policy <p>` | no | `bounded` \| `strict` | any other value is silently ignored (treated as unset) rather than refused |
| `--delivery-pr` | no | this PR is a delivery PR | affects the CON-40 carve-out |
| `--gates <path>` | no | same resolver `pr ready` uses | a RELATIVE path resolves against `--repo`, not cwd |
| `--json` | no | machine-readable blocker report | — |

**Output and exit codes** — human lines: `#<pr>: <kind>`, then the detail
line; `--json` top-level keys: `kind`
(`conflict`\|`red-check`\|`owed-round`\|`unresolved-thread`\|`missing-body-requirement`\|`none`),
`detail`. Exit 0 when `kind` is `none`, exit 1 for any other kind or a
GitHub/schema-read failure, exit 2 on a bad flag.

**Example**

```bash
nen pr next-blocker --target o/n --pr 9 --repo . --gates src/schema/fixtures/alt-repo/nen/gates.json
```
```text
#9: none
```
(from `src/pr/command.test.ts`'s "`--gates` redirects the taxonomy read" case: a green-check, all-approved-at-head snapshot evaluated under `alt-repo`'s reviewer identities — this verb reaches GitHub, so it was not run live here; the same snapshot evaluated under `bankai-repo`'s own identities instead reports `#9: owed-round` with `sasuke` named, proving the `--gates` file is what decided)

### `nen pr cascade-main`

Merges (never rebases) the trunk into the current branch and pushes on a
clean merge. A conflict is reported, never resolved — this verb does not run
`git merge --abort`, does not pick a side, and does not push when conflict
markers remain.

**Usage**

```text
nen pr cascade-main --repo <path> [--trunk main]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the repository whose current branch the trunk is merged into | unbracketed in usage; omitted is refused at exit 2 — this verb mutates whatever it is pointed at (#28) |
| `--trunk <branch>` | no | the trunk branch | default `main` |
| `--json` | no | machine-readable cascade result | — |

**Output and exit codes** — human lines are the `log[]` entries (`fetched
origin/<trunk>`, `merged origin/<trunk> cleanly` or the conflict note,
`pushed`); `--json` top-level keys: `conflicted`, `pushed`, `log[]`, `error`.
Exit 0 on a clean merge + push, exit 1 on a conflict, a fetch failure, or a
push failure, exit 2 on a missing `--repo`.

**Example**

```bash
nen pr cascade-main --repo .
```
```text
fetched origin/main
merge left conflicts -- resolve them, then commit and push yourself; this cascade never picks a side
```
exit 1 (conflict)
(from `src/pr/command.test.ts`: `git fetch origin main` scripted to succeed, `git merge --no-edit origin/main` scripted to return exit 1 with `CONFLICT` on stderr — this verb reaches GitHub via `git fetch`/`git push`, so it was not run live here)

### `nen pr retarget`

`gh pr edit --base`, for a stacked PR after its predecessor merges. One
command; the judgment of which PR moves and to what base stays the caller's.

**Usage**

```text
nen pr retarget --target <owner/name> --pr <n> --base <branch>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | the GitHub repository | missing exits 1 |
| `--pr <n>` | yes | the pull-request number | missing/invalid exits 2 |
| `--base <branch>` | yes | the new base branch | empty/missing exits 2 |
| `--json` | no | machine-readable result | — |

This verb reads no `--repo` — `gh pr edit` addresses the PR entirely via `--target`/`--pr`.

**Output and exit codes** — human line: `<target>#<pr> now targets
'<base>'`, or the `gh` failure message; `--json` top-level keys: `ok`,
`message`. Exit 0 on success, exit 1 when `gh` fails, exit 2 on a missing
`--base`.

**Example**

```bash
nen pr retarget --target zheref/nen --pr 12 --base release/1.0
```
```text
zheref/nen#12 now targets 'release/1.0'
```
(from `src/pr/command.test.ts`, which scripts `gh pr edit 12 --repo zheref/nen --base release/1.0` — this verb reaches GitHub, so it was not run live here)

### `nen pr request-reviews`

`gh pr edit --add-reviewer`, once per name. Intended to run on the
MAINTAINER's user token — a bot token silently no-ops on this call (S6); this
verb cannot enforce which credential ran it, only warn in its usage text.

**Usage**

```text
nen pr request-reviews --target <owner/name> --pr <n> --add-reviewers a,b
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | the GitHub repository | missing exits 1 |
| `--pr <n>` | yes | the pull-request number | missing/invalid exits 2 |
| `--add-reviewers <a,b>` | yes | comma-separated reviewer logins | an empty/unset value is refused at runtime (`ok: false`, exit 1), not at parse time |
| `--json` | no | machine-readable result | — |

This verb reads no `--repo` — `gh pr edit` addresses the PR entirely via `--target`/`--pr`.

> **Note:** the refusal names the wrong flag. An empty or unset
> `--add-reviewers` prints `no reviewers named -- --reviewers takes a
> comma-separated list`, but this verb's own flag is `--add-reviewers`;
> `--reviewers` belongs to `pr ready` and `pr next-blocker`. The message
> comes from `src/pr/reviewers.ts`, written against a `--reviewers`-named
> flag and never updated. The behaviour is correct — nothing is requested
> and the verb exits 1 — only the flag it names is wrong. Tracked as
> [zheref/nen#95](https://github.com/zheref/nen/issues/95).

**Output and exit codes** — human line: `requested <a>, <b> on
<target>#<pr>`, or the refusal/failure message; `--json` top-level keys:
`ok`, `message`. Exit 0 on success, exit 1 when no reviewers were named or
`gh` fails, exit 2 on a missing `--pr`.

**Example**

```bash
nen pr request-reviews --target zheref/nen --pr 9 --add-reviewers copilot,sasuke
```
```text
requested copilot, sasuke on zheref/nen#9
```
(from `src/pr/command.test.ts`, which scripts `gh pr edit 9 --repo zheref/nen --add-reviewer copilot --add-reviewer sasuke` — this verb reaches GitHub, so it was not run live here)

<a id="family-gate"></a>

**`nen gate`**

Derives which human gate (G2 or G4) a pull request's DIFF sits at, by
checking a changed-file set against two repository-supplied path sets. It
carries no built-in path sets — a binary shipping one repository's sets would
derive that repository's gates everywhere it ran — and it decides only the
diff's half: readiness is a separate question the caller composes in.

### `nen gate derive`

Answers "G2 or G4?" for a changed-file set: a hit in `--policy-paths` or
`--process-paths` derives G4 (only the human merges policy, or — in a
repository whose product is its process — a process change IS a policy
change); a miss on both derives G2. When `--asserted` disagrees with the
derivation, the disagreement is reported and the derived gate stands.

**Usage**

```text
nen gate derive --policy-paths <a,b> --process-paths <c,d> (--files ... | --files-from ... | --range ...) [--asserted <G2|G4>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--policy-paths <a,b>` | yes | policy/spec path patterns | `''` is a legal, explicit assertion of "none"; omitting the flag entirely is refused, exit 2 |
| `--process-paths <c,d>` | yes | process-surface path patterns | same rule as `--policy-paths` |
| `--files <a,b,c>` | one of these three | comma-separated changed paths | — |
| `--files-from <path>` | one of these three | one path per line | `-` is not accepted as stdin |
| `--range <a>..<b>` | one of these three | computed via `git diff --name-only <range>` | needs `--repo`/cwd to be a git checkout |
| `--asserted <G2\|G4>` | no | the gate the caller believes this is | any other value is refused, exit 2 |
| `--repo <path>` | no | resolves `--range`/`--files-from` against this root | default cwd |
| `--json` | no | machine-readable derivation | — |

A pattern is an exact path, a directory prefix ending `/`, or a glob whose
`*` crosses `/` (so `handbooks/*` covers any depth beneath it).

**Output and exit codes** — human lines: the gate, the one-line basis, an
optional correction line, then the fixed readiness note; `--json` top-level
keys: `gate`, `changed[]`, `hits[]`, `basis`, `asserted`, `corrected`,
`readinessNote`. Exit 0 on any derivation (including a disagreement with
`--asserted`, which is reported, not refused); exit 1 when both path sets are
explicitly empty (`--policy-paths '' --process-paths ''`); exit 2 on a
missing/malformed flag.

**Example**

```bash
nen gate derive --repo src/schema/fixtures/bankai-repo --policy-paths "schemas/,CONSTITUTION.md" --process-paths ".github/workflows/,scripts/" --files "schemas/gates.json" --asserted G2
```
```text
G4
G4: the diff touches policy/spec (schemas/), which only the human merges.
correction: the invocation asserted G2; the diff derives G4, and the derived gate stands.
This is the diff's half of the derivation only. A pull request that is not ready has NO GATE -- it is in progress and owned by its author -- so compose this with a readiness verdict before putting a row in anyone's queue.
```
(from a real run against the bundled `bankai-repo` fixture)

<a id="family-split"></a>

**`nen split`**

Proves jujisho's completeness invariant: the union of a set of per-axis
branch diffs equals one original diff, hunk for hunk. It writes nothing and
never chooses which axis a hunk belongs to beyond reporting where it already
landed.

### `nen split verify`

Every hunk in `--original` must land in exactly one of `--branches`, with the
SAME body (identity is the hunk's exact text, not just its header). A hunk in
none of them is a leftover hunk (invisible in every PR); one in more than one
is reported too; one whose header matches but whose body differs is reported
ALTERED. An `--original` naming no hunks at all is refused outright.

**Usage**

```text
nen split verify --original <path> --branches <path,path,...>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--original <path>` | yes | a unified diff of the original working copy | e.g. `git diff main > original.diff` before any branch was cut |
| `--branches <path,path,...>` | yes | one unified diff per axis branch, comma-separated | e.g. `git diff main...<axis-branch>` per axis |
| `--json` | no | machine-readable proof result | — |

This verb reads no `--repo` and touches no git state itself — it only
compares diff text already written to disk.

**Output and exit codes** — human lines: a file-count summary, then `OK` or
one line per `MISSING`/`DUPLICATED`/`ALTERED`/`EXTRA` hunk; `--json`
top-level keys: `ok`, `filesInOriginal`, `filesInBranches`, `missing[]`,
`duplicated[]`, `altered[]`, `extra[]`, `error`. Exit 0 when every hunk lands
in exactly one branch, unaltered, with nothing extra; exit 1 on any missing,
duplicated, altered or extra hunk, on an unreadable `--original`/branch file,
and on an `--original` naming zero hunks — that last one is a refusal, not a
usage error, because the flag was spelled correctly and the file was read: it
just did not prove anything (`src/split/command.ts`; under `--json` the exit is
`result.ok ? 0 : 1`, so the zero-hunk refusal is exit 1 there too, with the
sentence in the `error` key). Exit 2 only on a missing `--original`/`--branches`
or a `--branches` that names no paths at all.

**Example**

```bash
nen split verify --original original.diff --branches axis-pr.diff,axis-gate.diff
```
```text
files: 2 in original, 2 across branches
OK -- every hunk in the original lands in exactly one branch, unaltered, and nothing extra was found.
```
(from a real run against two constructed diffs, `original.diff` touching `src/pr/command.ts` and `src/gate/derive.ts`, split cleanly across `axis-pr.diff` and `axis-gate.diff`)

<a id="family-wc"></a>

**`nen wc`**

Reports tensho's own four-case table for where the current working copy
sits — on the trunk, on a dirty branch, or on a clean branch — so tensho
knows whether to move it before opening a PR. It never commits, branches, or
stashes anything; it only reads git state.

### `nen wc classify`

Reports one of `must-move` (on the trunk, dirty), `on-branch-dirty` (on a
branch with uncommitted work — whether it is the same effort as the
branch's existing commits is a judgement this verb hands you evidence for,
never decides), or `on-branch-clean` (nothing to commit). A git command that
FAILS (a detached HEAD, a `--base` that does not resolve) is never folded
into one of the three cases as an empty/zero reading; it is reported as an
error and exits non-zero.

**Usage**

```text
nen wc classify --repo <path> [--base main]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the working tree being classified | unbracketed in usage; omitted is refused at exit 2 (#28) |
| `--base <branch>` | no | the PR's target base | default `main`; where the checkout would be cut from and what a dirty trunk must move off of |
| `--json` | no | machine-readable classification | — |

**Output and exit codes** — human lines: `case: <case>`, then indented
evidence lines; `--json` top-level keys: `state` (`branch`, `isTrunk`,
`dirty`, `aheadOfBase`, `existingCommitSubjects[]`, `uncommittedPaths[]`),
`result` (`case`, `evidence[]`). Exit 0 for any of the three cases (a report,
not a guard); exit 1 when the underlying git command fails (detached HEAD, an
unresolvable `--base`); exit 2 on a missing `--repo`.

**Example**

```bash
nen wc classify --repo .
```
```text
case: on-branch-clean
  on 'docs-usage-part1-scratch' with nothing uncommitted -- open or report the existing PR
```
(from a real run, on a throwaway local branch created and deleted for this check; a detached HEAD in the same checkout instead prints `nen wc: could not determine the current branch ... this usually means a detached HEAD` at exit 1, and an unresolvable `--base` prints `could not count commits ahead of base` at exit 1)

<a id="family-stage"></a>

**`nen stage`**

Flags what should never be staged blind, tensho §3's own table: secret
shapes, git-ignored files, binaries, out-of-scope paths and unmentioned
deletions. It detects, never decides — the yes to stage a flagged file is
always the human's.

### `nen stage triage`

Reads `git status --porcelain=v1 -z --ignored -uall` and reasons over every
entry: a secret-looking name (`.env`, `*.pem`, `*.key`, `credentials*`), a
git-ignored file, a binary, a path outside `--scope`, or a deleted path whose
basename `--mentions` never names.

**Usage**

```text
nen stage triage --repo <path> [--scope src/,docs/] [--mentions "<free text>"]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the working tree whose unstaged files are triaged | unbracketed in usage; omitted is refused at exit 2 (#28) |
| `--scope <a,b>` | no | in-scope path prefixes | omit to skip the out-of-scope check entirely |
| `--mentions <text>` | no | free text (a commit message draft, a PR description) searched for a deleted path's basename | an unmentioned deletion is flagged, never silently staged |
| `--json` | no | machine-readable triage | — |

**Output and exit codes** — human lines: `clean: <n> file(s)` then each
clean path, and (if any) `flagged: <n> file(s) -- never staged without an
explicit yes` then each flagged path with its reason tags; `--json`
top-level keys: `clean[]`, `flagged[]` (each `{ path, reasons[] }`). Exit 0
when nothing is flagged, exit 1 when anything is flagged or the underlying
`git status` fails, exit 2 on a missing `--repo`.

**Example**

```bash
nen stage triage --repo . --scope "src/,docs/"
```
```text
clean: 1 file(s)
  src/a.ts
flagged: 1 file(s) -- never staged without an explicit yes
  .env  [secret-shape, out-of-scope]
```
(from a real run against a throwaway scratch git repository with a committed, in-scope `src/a.ts` carrying an uncommitted edit alongside an untracked `.env`)

## Backlog & boards

What the open backlog looks like right now, in what order it should be worked,
and how it renders as a gate board — plus the epic, effort and concurrency
arithmetic around it, the registry pin sweep, and the read-only watch loop.
Severity, "blocks" and "affects consumers" are always read off labels or
caller-supplied facts, never inferred here.

<a id="family-backlog"></a>

**`nen backlog`**

Fetches the live backlog (open issues and open pull requests) from GitHub and assembles one row per
effort, or applies the backlog-loop's own priority order to a pre-fetched row set. `backlog` never
judges severity, "blocks", or "affects consumers" itself — those are read off labels/caller-supplied
facts, never inferred from content.

### `nen backlog fetch`

Answers "what does the open backlog of `owner/name` look like right now": it fetches open issues and
open pull requests fresh over `gh api` — never from a cache — and assembles one row per effort, meaning
an issue plus the PRs that reference it (via a closing keyword or a bare `#N` in the PR's title/body),
or a lone PR that references no open issue as its own row. It paginates past GitHub's 100-row
per-page clamp rather than stopping at the first page, so `--limit` is a real total cap across as many
pages as it takes, not the accidental 100-row ceiling an earlier version of this verb had.

**Usage**

```text
nen backlog fetch --repo-slug <owner/name> [--limit <n>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo-slug <owner/name>` | yes | The owner/name to fetch fresh from over `gh api`. | |
| `--limit <n>` | no | Caps the TOTAL rows fetched per resource (issues, PRs), across as many pages as it takes to reach it. | Omit for no cap. Must be a positive whole number, or refused (exit 2). A capped fetch is always reported TRUNCATED, never presented as complete. |

**Output and exit codes** — human rendering is `"<n> row(s) -- X issue(s), Y PR(s)"`, an optional
`TRUNCATED at --limit <n>: ...` or `TRUNCATED at a defensive 200-page ceiling: ...` line, then one line
per row (`#<issue> [#<pr>, ...]  <title>`, or `PR #<n>  <title>` for an orphan PR). `--json` top-level
keys: `repo`, `truncated`, `rows`, `issueCount`, `prCount`. Exit 0 whether or not the fetch was
truncated (truncation is reported, not failed); exit 2 for a missing `--repo-slug` or a malformed
`--limit`. This verb has no exit-1 path of its own.

**Example**

```bash
nen backlog fetch --repo-slug zheref/bankai-core --limit 200 --json
```
```text
{
  "repo": "zheref/bankai-core",
  "truncated": false,
  "rows": [
    { "issueNumber": 1, "title": "an issue", "labels": ["a"], "prNumbers": [5], "createdAt": "2026-01-01T00:00:00Z" }
  ],
  "issueCount": 1,
  "prCount": 1
}
```
(shape confirmed from `src/backlog/command.test.ts` — this verb reaches GitHub live and was not run
against a real repository; see the tool's setup notes.)

### `nen backlog order`

Answers "in what order should this repository's backlog be worked": it applies backlog-loop §2's rule
— severity first (in the repository's own stated order), then within a severity: blocks another issue,
then affects consumer behaviour/DX, then oldest first, then issue number as the final tie-break — to a
row set the caller already has in hand. "Blocks" and "affects consumers" are judgement calls the caller
makes by reading the issue; this verb is the arithmetic of the ordering, never the judgement.

**Usage**

```text
nen backlog order --rows-from <path> --severity-order <a,b,c,d> [--blocks <id|n,...>] [--affects-consumers <id|n,...>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--rows-from <path>` | yes | A JSON array of rows: `{ id, severity, createdAt, number }`, e.g. `backlog fetch --json` reshaped. | Resolved relative to `--repo` (defaults to cwd) unless absolute. |
| `--severity-order <a,b,c,..>` | yes | This repository's own severity vocabulary, in priority order. | A row whose severity is not in this list ranks LAST. |
| `--blocks <id\|n,...>` | no | Rows that block another issue, each named by its row id (`XY-IS-#938`) or bare issue number (`938`). | A token naming no row is refused (exit 2), never silently ignored. |
| `--affects-consumers <id\|n,...>` | no | Rows that affect consumer behaviour/DX. | Same token forms and refusal as `--blocks`. |
| `--repo <path>` | no | Resolves `--rows-from`'s path when it is relative. | Defaults to cwd. |

**Output and exit codes** — human rendering is one numbered line per row:
`"<n>. <id>  severity=<sev>[ blocks][ affects-consumers]  <createdAt>"`. `--json` top-level keys:
`severityOrder`, `rows` (each row carries `severityRank`, `blocksOther`, `affectsConsumers` alongside
its input fields). Exit 0 on a normal ordering; exit 2 when a required flag is missing, `--rows-from`
is unreadable/malformed, or a `--blocks`/`--affects-consumers` token names no row. No exit-1 path.

**Example**

```bash
nen backlog order --rows-from rows.json --severity-order critical,high,medium,low --blocks 98
```
```text
1. BC-IS-#98  severity=critical blocks  2026-07-20T00:00:00Z
2. BC-IS-#110  severity=high  2026-08-15T00:00:00Z
3. BC-IS-#101  severity=medium  2026-08-01T00:00:00Z
```
(from a real run against a hand-written `rows.json`)

<a id="family-board"></a>

**`nen board`**

Assembles, renders, and diffs the gate board — a padded-markdown table, one row per effort, showing
its status, gate, refs and what it needs next. `board` never computes a gate or a colour itself: those
come from `nen gate derive` and `nen color status` respectively, and this family's job is holding the
result as one shape, rendering it, and diffing two snapshots of it.

### `nen board build`

Assembles a `Board` from rows the caller has already computed — nothing here derives a gate or a
colour. It validates every row at the JSON boundary (issue #32): a `refs` field sent as one
pre-joined string instead of an array is refused by name, naming the row and the field.

**Usage**

```text
nen board build --repo-slug <owner/name> --rows-from <path>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo-slug <owner/name>` | yes | The repository this board is for. | Recorded in the output header; not itself fetched from. |
| `--rows-from <path>` | yes | A JSON array of BoardRow: `{ id, title, refs, gate, status, needs }`. | `refs` MUST be an array of ref strings, one per reference — a one-element array for a single ref, never a joined string. A wrong shape names the row and field (exit 2). |
| `--repo <path>` | no | Resolves `--rows-from`'s path when relative. | Defaults to cwd. |

**Output and exit codes** — human rendering is the padded-markdown table (see `board render` below).
`--json` is the `Board`: `{ repo, generatedAt, rows }`. Exit 0 on a normal build; exit 2 when a
required flag is missing or a row fails the shape check (missing/wrong-typed `id`, `title`, `refs`,
`gate`, `status`, or `needs`). No exit-1 path — every failure here is a usage error, by design (#32).

**Example**

```bash
nen board build --repo-slug zheref/bankai-core --rows-from board-rows.json
```
```text
zheref/bankai-core -- generated 2026-09-07T22:56:32.469Z

| Effort                            | Refs                   | Status (gate)    | Needs             |
| --------------------------------- | ---------------------- | ---------------- | ----------------- |
| Guard the allowlist metachar path | BC-IS-#101, BC-PR-#112 | 🟡 G1-ready (G2) | maintainer review |
| Watch classifier allowlist        | BC-IS-#98              | 🟢 G2/G4-ready   |                   |
```
(from a real run against a hand-written `board-rows.json`)

### `nen board render`

Renders a `Board` (a `board build --json` result) as the same padded-markdown table
`scripts/ichigo_board.sh` (bankai-core#653) established. It is the read half of `board build`, split
out so a caller holding an already-assembled board (from disk, or piped from `build`) can re-render it
without re-supplying the raw rows.

**Usage**

```text
nen board render --board-from <path>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--board-from <path>` | yes | A Board JSON document (a `board build --json` result) to render. | The row shape is validated the same way as `board build` — a malformed board is refused by name (see the exit codes below). |
| `--repo <path>` | no | Resolves `--board-from`'s path when relative. | Defaults to cwd. |

**Output and exit codes** — same rendering as `board build`'s human output. `--json` echoes the Board
back unchanged. Exit 0 on success; exit 2 if `--board-from` is missing, unreadable/not-JSON, or a row
fails the shape check (malformed `refs`, etc.) — fixed in #99 (issue #92).

**Example**

```bash
nen board render --board-from board.json
```
```text
zheref/bankai-core -- generated 2026-09-07T22:56:32.507Z

| Effort                            | Refs                   | Status (gate)    | Needs             |
| --------------------------------- | ---------------------- | ---------------- | ----------------- |
| Guard the allowlist metachar path | BC-IS-#101, BC-PR-#112 | 🟡 G1-ready (G2) | maintainer review |
| Watch classifier allowlist        | BC-IS-#98              | 🟢 G2/G4-ready   |                   |
```
(from a real run against the `board.json` produced by the `board build` example above)

### `nen board diff`

Answers "what changed between these two board snapshots", field by field, matched by row id — for a
caller re-rendering the board on every state change who wants to report the delta, not re-announce the
whole board every time.

**Usage**

```text
nen board diff --before <path> --after <path>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--before <path>` | yes | The earlier Board snapshot. | Validated the same way as `board render` (issue #92 fixed in #99). |
| `--after <path>` | yes | The later Board snapshot. | |
| `--repo <path>` | no | Resolves both paths when relative. | Defaults to cwd. |

**Output and exit codes** — human rendering is one line per changed/added/removed row:
`"changed  <id>: <field> '<before>' -> '<after>', ..."`, `"added  <id>"`, `"removed  <id>"`, or the
single line `"no change"` when nothing differs. `--json` top-level keys: `rows`, `changed`. Exit 0 on
a normal diff (whether or not anything changed); exit 2 for a missing/unreadable path or a malformed
snapshot (wrong row shape).

**Example**

```bash
nen board diff --before board-before.json --after board-after.json
```
```text
changed  101: gate 'G2' -> 'G4', status '🟡 G1-ready' -> '🟢 G2/G4-ready', needs 'maintainer review' -> ''
```
(from a real run against two hand-written snapshots)

<a id="family-epic"></a>

**`nen epic`**

Coordinates one epic's child checklist: flips a completed child's checkbox, redraws the `## Progress`
bar, and computes which unchecked children are releasable next under a concurrency cap. It reads
nothing from GitHub or from `nen/` — the parent issue's body is handed to it as a file, and the
citation naming the rule the coordinator acts under is always caller-supplied, never a literal this
binary carries.

### `nen epic next-wave`

Answers "if this child just merged, what does the epic's body look like now, and what should be
released next": it flips the completed child's `- [ ]` to `- [x]` (idempotently), recomputes the
progress bar and fraction, and computes the next wave — unchecked children whose declared blockers
(`blocked by #N` on the child's own line, or `blocks #N` on the blocker's line — both directions count)
are ALL known, checked children of this same parent, not already in flight, up to the in-flight cap. A
checkbox with no resolvable child reference is counted into `unparsed` and reported loudly, never
silently dropped; a duplicate child id, or a checklist that is entirely unparseable, refuses outright
rather than reporting a wrong or empty result.

**Usage**

```text
nen epic next-wave --body-file <path> --citation <rule-id>
                   [--completed <n>] [--inflight 1,2] [--cap <n>] [--out <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--body-file <path>` | yes | The parent issue's body, as markdown. | A read failure is reported and exits 1 (not a parser-level usage error). |
| `--citation <rule-id>` | yes | The rule id the progress footer cites. | Never defaulted — a clause id belongs to the target repository's own canon, not to this binary. |
| `--completed <n>` | no | The child whose delivery just merged. | Flipping is idempotent; accepts a leading `#`. |
| `--inflight <n,n>` | no | Children already released — they occupy cap slots while unchecked. | Any digit run in the value is read as an id. |
| `--cap <n>` | no | How many children may be in flight at once. | Default 3. |
| `--out <path>` | no | Write the rewritten body here. | Omit to compute without writing; never written when the coordinator refuses (duplicate id / all-unparseable checklist). |

**Output and exit codes** — human rendering: `"children: <done>/<total> done"`, an optional `WARNING:`
line naming unparsed checkboxes, then one `"next wave: #<n>[ -> <owner>]"` line per releasable child (or
`"next wave: nothing releasable -- ..."`). `--json` prints `{ total, done, release, unparsed }`. Exit 0
on a normal run; exit 1 when `--body-file` cannot be read, when the same child id appears twice in the
checklist, or when the body has checkbox lines but none resolves to a child; exit 2 when `--body-file`
or `--citation` is omitted, or `--completed`/`--cap` is not a whole number.

**Example**

```bash
nen epic next-wave --body-file epic-body.md --citation CON-25 --completed 101 --inflight 102 --cap 2 --out epic-out.md
```
```text
children: 1/4 done
next wave: #103
wrote epic-out.md
```
(from a real run against a hand-written epic body with four `- [ ]`/`- [x]` children)

<a id="family-effort"></a>

**`nen effort`**

Classifies one epic or child issue against senkei §3's effort taxonomy, from facts the caller already
resolved (stage labels, PR/branch existence and shape). It is the mechanical half only: a live signal
like "did a reviewer job die mid-run" is an optional caller-supplied fact, never fetched here.

### `nen effort classify`

Answers "which of senkei's classes does this object belong to right now", given its issue state, stage
labels, and PR/branch facts. Two stage-family labels at once wins over every other rule and is reported
as `state-machine-violation`, flagged rather than resolved by guessing which one is authoritative.

**Usage**

```text
nen effort classify --input <path.json>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--input <path.json>` | yes | A JSON array of `{kind, issueState, stageLabels, modeLabelPresent, hasPr, prOpen, prIsDelivery, integrationBranchAlive, reviewerVerdictMissing?}`. | An unreadable file or non-array JSON is reported and exits 1. |

**Output and exit codes** — human rendering is the class name per entry, followed by its evidence
line(s) indented two spaces. `--json` prints an array of each input object merged with its
`effortClass`/`evidence`. Exit 0 whatever the classification (even `state-machine-violation`); exit 1
only when `--input` cannot be read or parsed as a JSON array; exit 2 when `--input` is omitted.

> **Note:** `--help` under-reports the class list. It names six classes
> (`delivering`, `building`, `stalled`, `queued`, `idle`,
> `state-machine-violation`), but `src/effort/classify.ts` has a seventh
> that this verb really can return: `undecidable`, reached when an entry
> carries no stage label, no mode label, no PR and no live integration
> branch. Handle it in any caller that switches on the class. Tracked as
> [zheref/nen#53](https://github.com/zheref/nen/issues/53).

**Example**

```bash
nen effort classify --input effort-input.json
```
```text
building
  carries the released stage label 'bankai:stage/building' and has a PR in progress
stalled
  carries 'bankai:stage/building' -- released, but no branch or PR was ever opened; a reviewer job posted no Verdict line at all -- a job that died mid-run, not a pending review
idle
  the epic is closed but its integration branch is still alive -- flag for cleanup
```
(from a real run against a hand-written `effort-input.json`)

<a id="family-loop"></a>

**`nen loop`**

Counts the two concurrency budgets — CI and local — from a caller-supplied efforts file and explicit
caps. It never starts, stops, or drives anything; it reports occupancy and which efforts are still
holding a slot, and by which plane's own freeing rule.

### `nen loop slots`

Answers "how many concurrency slots does each plane have free right now". A CI slot frees the moment
its PR opens (the builder's own iterate loop takes over from there); a local slot frees only once the
PR is ready AND the human has been prompted, because nothing else is behind a locally-authored PR. The
two budgets are counted and reported separately and are never traded against each other.

**Usage**

```text
nen loop slots --efforts <path.json> --local-cap <n> [--ci-cap <n>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--efforts <path.json>` | yes | A JSON array of `{id, plane: "ci"\|"local", prOpen, ready, prompted}`. | An unreadable/malformed file is reported and exits 1. |
| `--local-cap <n>` | yes | The local-plane concurrency cap. | No default (issue #52 removed one of 7): a guard must be chosen, never inherited. |
| `--ci-cap <n>` | no | The CI-plane concurrency cap. | Default 2 — the ported loop's own CI budget. |

**Output and exit codes** — human rendering is one line per plane:
`"<plane>: <occupied>/<cap> occupied, <free> free[  <- BINDING]"`, each with its holding efforts and
why indented beneath, plus a `"freed: <id>, ..."` line when any effort finished by its plane's rule.
`--json` prints `{ ci, local, done }`, each plane carrying `{ plane, cap, occupied, free, holding,
binding }`. Exit 0 when neither budget is fully occupied; exit 1 when either plane is fully occupied
(`binding: true`) — the caller can stop starting work without re-reading the report; exit 2 when
`--efforts` or `--local-cap` is missing, or a cap is not an integer.

**Example**

```bash
nen loop slots --efforts efforts.json --local-cap 2
```
```text
ci: 1/2 occupied, 1 free
    BC-IS-#98: released, but no PR yet
local: 1/2 occupied, 1 free
    BC-IS-#101: ready, but the human has not been prompted -- readiness nobody was told about is not a handover
freed: BC-IS-#110
```
(from a real run against a hand-written `efforts.json`)

<a id="family-warmup"></a>

**`nen warmup`**

Detects stale or missing version pins across every consumer recorded in the target repository's
`nen/repos.json`, and optionally sweeps a set of handbook questions for which repositories have not
answered them. It only reports — it never edits the registry, and "not checked" is always distinct from
"checked and clean".

### `nen warmup`

This family has a single command with no subcommand of its own — `nen warmup <anything-else>` ignores
the extra word rather than refusing it, unlike every other family in this section. It answers "is any
consumer's pin behind `--current`, and does any consumer have an unanswered handbook question": a
consumer recorded with NO pin at all is reported as an `unpinned` finding and fails the run exactly like
a stale one, because an unperformed check must never render as a clean one.

**This warms a *registry*, and reads only. [`nen shu warmup`](#nen-shu-warmup) warms a *working copy*
(clean → fetch → fast-forward the trunk → cut a branch → verify the declared build) and mutates git
state.** Two verbs, one word, and neither is a rename of the other: the collision is resolved by
nesting, exactly as `nen dev` / [`nen shu dev`](#nen-shu-dev) already is, and izanami's table keys on
the *family*, so `warmup` and `shu` are structurally distinct rows — this one classifies **read-only**
and that one **mutating in every form**. They compose in that order when you want both.

**Usage**

```text
nen warmup --current <vX.Y.Z> [--questions-from <path>] [--answers-from <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--current <vX.Y.Z>` | yes | This repository's actual latest version. | Stated explicitly — a plugin-shipped `registry.latest` can itself be stale. |
| `--questions-from <path>` | no | A JSON array of `{ id, text }` handbook questions. | Omitting it skips the sweep, reported as an explicit `NOT CHECKED` (`{"checked": false}` in `--json`), never a silent "no gaps". |
| `--answers-from <path>` | required together with `--questions-from` | A JSON object `{ "<repo>": ["<question-id>", ...] }`. | Required once `--questions-from` is given (exit 2 otherwise). |
| `--repo <path>` | no | The checkout whose `nen/repos.json` is checked. | Defaults to cwd. |

**Output and exit codes** — human rendering: a stale-pins block (`"no stale pins"` or `"<n> stale
pin(s):"` plus one line per finding), an unpinned-consumers block, and either a question-sweep block
or the literal `"handbook-question sweep: NOT CHECKED (--questions-from was not supplied)"`. `--json`
top-level keys: `current`, `pinFindings`, `questionSweep`. Exit 0 only when there are no stale/unpinned
findings AND (the sweep was not requested, or it found no gaps); exit 1 otherwise; exit 2 when
`--current` is missing or `--answers-from` is missing while `--questions-from` was given.

**Example**

```bash
nen warmup --repo src/schema/fixtures/bankai-repo --current v0.12.0
```
```text
4 stale pin(s):
  zheref/KroApple pinned: v0.11.2 -> v0.12.0
  zheref/KroAndroid pinned: v0.11.2 -> v0.12.0
  zheref/bankai-scaffold pinned: v0.10.0 -> v0.12.0
  zheref/bankai-scaffold db_migrate_pinned: v0.9.7 -> v0.12.0
no unpinned consumers
handbook-question sweep: NOT CHECKED (--questions-from was not supplied)
```
exit 1 — stale pins were found, and a stale pin fails the run.
(from a real run against `src/schema/fixtures/bankai-repo`)

<a id="family-watch"></a>

**`nen watch`**

Polls one read-only observation command on an interval and reports whether its condition has become
true. It is izanami's loop, ported: fetch, evaluate, report one line, pace, stop — and it refuses,
by name, to watch anything that classifies as mutating; a task that needs to act belongs to
`nen parse izanagi` instead.

### `nen watch until`

Answers "has this condition become true yet", by repeating one command and testing its output or exit
code, paced, until it has (or until a bound is reached). The command is classified against izanami's
read-only table before the very first run — a mutating command is refused outright rather than being
repeated once and then reported on. A permanently broken observation (bad usage, no auth, no such
binary) must never masquerade as "not yet true": three consecutive observation errors stop the watch
regardless of `--max-iterations`.

**Usage**

```text
nen watch until --command "<bin> <args...>" [--true-pattern <regex>]
                [--interval-ms 5000] [--max-iterations <n>] [--cwd <path>]
                [--error-exit-threshold <n>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--command "<bin> <args...>"` | yes | The read-only observation to repeat. | Spawned directly, no shell — `<bin>` must be a real executable on PATH (a shell builtin fails at spawn). Classified before the first run; a mutating command refuses at exit 2. |
| `--true-pattern <regex>` | no | Regex tested against the command's stdout. | Omit to treat exit code 0 as true. When given, a non-zero exit is an OBSERVATION ERROR, not a false reading. |
| `--interval-ms <n>` | no | Pace between observations. | Default 5000. |
| `--max-iterations <n>` | no | A safety bound, not izanagi's mandatory cap. | Omit for an unbounded watch; an error streak still stops it. |
| `--cwd <path>` | no | Working directory for the spawned command. | Defaults to the process's own cwd. |
| `--error-exit-threshold <n>` | no | In exit-code-as-truth mode (no `--true-pattern`), an exit code at or above this is an OBSERVATION ERROR. | Default 2; ignored when `--true-pattern` is given. |

**Output and exit codes** — human rendering is one `"[<n>] <message>"` line per observation, then a
final line naming the outcome. `--json` prints `{ outcome, iterations }`, each iteration carrying
`{ iteration, conditionTrue, errored, message }`. Exit 0 when the condition became true; exit 1 on an
error streak or a bound reached; exit 2 when `--command` is missing/empty, or it classifies as
mutating.

**Example**

```bash
nen watch until --command "git status --short" --interval-ms 100 --max-iterations 2
```
```text
[1] condition is true (exit 0)
condition became true after 1 observation(s)
```
(from a real run in this checkout, using `git status --short` as a harmless read-only observation)

## Labels, issues & taxonomy

The four taxonomy files and the verbs that read them: applying and migrating
labels, validating the schema set itself, resolving a colour by the
repository's own precedence, resolving a repository token against the
registry, and formatting the object notation the rest of the surface cross-
references objects with.

<a id="family-label"></a>

**`nen label`**

Applies one label to one object (an issue or a pull request) and appends a durable, after-the-fact
ledger line recording the decision. It checks the label against the target repository's
`nen/labels.json` before attempting anything, and it never writes to GitHub unless `--run` is
given — the ledger records the decision either way.

### `nen label apply`

Answers "apply this label to this object, and remember that I asked" — a single object * label
mutation, logged. `--label` is validated against the taxonomy before the ledger is even opened; the
GitHub call (when `--run` is given) is attempted BEFORE the ledger line is written, so the ledger's
`outcome` always reflects what GitHub actually did, never what the caller merely asked for.

**Usage**

```text
nen label apply <object-ref> --label <name> --repo-slug <owner/name> [--reason <text>] [--ledger <path>] [--run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `<object-ref>` (positional) | yes | `<CODE>-<IS\|PR>-#<N>`. | Only the number is used against `--repo-slug`'s numbering — the code is not re-resolved. Malformed -> exit 2. |
| `--label <name>` | yes | Checked against `nen/labels.json` before anything is attempted. | Unknown label -> exit 2, naming the declared labels. |
| `--repo-slug <owner/name>` | yes | The owner/name the mutation runs against. | |
| `--reason <text>` | no | Recorded in the ledger. | Never sent to GitHub. |
| `--ledger <path>` | no | Ledger file location. | Defaults to `label-ledger.jsonl` under `--repo`'s root. |
| `--run` | no (boolean) | Without it, nothing is written to GitHub. | The ledger still records the decision, with `outcome: "dry-run"`. With `--run`, it records `"applied"` or `"failed"`, written AFTER the call resolves. |
| `--repo <path>` | no | The checkout whose taxonomy is checked, and the ledger's default base directory. | Defaults to cwd. |

**Output and exit codes** — human rendering: `"(dry run) would apply '<label>' to <ref>"` or
`"applied '<label>' to <ref>"`, then `"ledger: <path>"`. `--json` prints `{ entry, ledgerPath }`. Exit 0
on a dry run or a successful `--run`; exit 1 when `--run` was given and GitHub's own call failed
(a 404/403/rate-limit — the ledger records `"failed"` either way); exit 2 for a missing/malformed
object ref, a missing `--label`/`--repo-slug`, or an undeclared label.

**Example**

```bash
nen label apply BC-IS-#386 --label "bankai:stage/human-review" --repo-slug zheref/bankai-core \
  --repo src/schema/fixtures/bankai-repo \
  --reason "watch classifier landed; needs maintainer review" --ledger /tmp/label-ledger.jsonl
```
```text
(dry run) would apply 'bankai:stage/human-review' to BC-IS-#386
ledger: /tmp/label-ledger.jsonl
```
(from a real run against `src/schema/fixtures/bankai-repo`, without `--run` — this verb reaches GitHub
only when `--run` is given, which was not exercised live)

<a id="family-labels"></a>

**`nen labels`**

Syncs a repository's own label taxonomy onto a target repository (create-or-update), and renames
labels in place across it, preserving every issue association. Unlike `label apply`, both verbs here
mutate GitHub by default — `--dry-run` is what makes either one safe to preview.

### `nen labels sync`

Answers "does the target repository's label set match this repository's own taxonomy": for every
label in `nen/labels.json`, it creates the label if it is absent or updates it if it already
exists. One bad label (a description GitHub rejects) never aborts the run — every other good label
still lands, and the failures are named at the end.

**Usage**

```text
nen labels sync --target <owner/name> --repo <path> [--dry-run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The repository labels are synced to. | A missing `--target` exits **1**, not 2 — see the note below. |
| `--repo <path>` | yes | The checkout whose `nen/labels.json` is the taxonomy being synced. | Listed unbracketed in usage; omitting it is refused BY NAME at exit 2 (issue #28) rather than silently defaulting to cwd. |
| `--dry-run` | no (boolean) | Logs every label ("would sync: ...") without calling `gh` at all. | There is no separate `--run` flag here (unlike `label apply`): omitting `--dry-run` means this verb mutates immediately. |

> **Note:** a missing `--target` exits 1 rather than 2 on **sixteen**
> verbs. Four families — `labels`, `repo`, `pr` and `issue` — each define
> their own local `requireTarget()` helper (`src/labels/command.ts:10`,
> `src/repo/command.ts:13`, `src/pr/command.ts:47`,
> `src/issue/command.ts:293`) that throws a plain `Error` instead of the
> `VerbUsageError` every other required flag on the surface throws — so
> forgetting `--target` reports a usage message but exits with the failure
> code, not the usage code. The sixteen are `labels sync`,
> [`labels rename`](#nen-labels-rename),
> [`repo inventory`](#nen-repo-inventory),
> [`repo scenario`](#nen-repo-scenario), [`pr fetch`](#nen-pr-fetch),
> [`pr next-blocker`](#nen-pr-next-blocker),
> [`pr retarget`](#nen-pr-retarget),
> [`pr request-reviews`](#nen-pr-request-reviews) and all eight `issue`
> verbs ([`search`](#nen-issue-search),
> [`open-pr-check`](#nen-issue-open-pr-check), [`file`](#nen-issue-file),
> [`comment`](#nen-issue-comment), [`attach-sub`](#nen-issue-attach-sub),
> [`consolidate-close`](#nen-issue-consolidate-close),
> [`chain-position`](#nen-issue-chain-position) and
> [`terminus`](#nen-issue-terminus)). The two verbs that take `--target`
> and are NOT affected read it through `requireValue` and so exit 2 the
> ordinary way: [`run rerun-failed`](#nen-run-rerun-failed) and
> [`idea file`](#nen-idea-file). A caller that branches on `2` to mean "you
> typed it wrong" will read a forgotten flag as a real failure on the
> sixteen. Confirmed by `src/labels/command.test.ts`'s `"requires
> --target"` case, which asserts exit 1, and by running all eighteen.
> Tracked as [zheref/nen#93](https://github.com/zheref/nen/issues/93).

**Output and exit codes** — human rendering is one line per label (`"would sync: <name> (#<color>) --
<description>"` in dry-run, or the entry's own message otherwise), then, if any failed, a summary line
naming them. `--json` prints the full sync report (`entries`, `failed`). Exit 0 when every label
synced (or, in dry-run, was reported); exit 1 when at least one label failed to sync; exit 2 when
`--target` is malformed, or `--repo` is omitted.

**Example**

```bash
nen labels sync --target zheref/bankai-core --repo src/schema/fixtures/bankai-repo --dry-run
```
```text
would sync: bankai:stage/idea (#ededed) -- Raw idea awaiting research
would sync: bankai:stage/researched (#1d76db) -- Epic drafted, awaiting G1 approval
would sync: bankai:stage/building (#fbca04) -- Released to a builder
...
would sync: bankai:epic (#5319e7) -- An epic, delivered on an integration branch
```
(from a real `--dry-run` run against `src/schema/fixtures/bankai-repo` — 13 labels total, truncated
here for length; `--dry-run` makes no `gh` call at all, so this was safe to run live)

### `nen labels rename`

Answers "rename this label across the target repository, without breaking anything that already
carries it": `gh label edit <from> --name <to>` is one API call against the label's existing id, so
every issue (open and closed) that carried the old name keeps the same label object under the new one.
It is idempotent — a mapping already applied (the new name exists, the old one is gone) is reported
`already-done`, never retried or failed, so a repeated invocation of the same map is always safe.

**Usage**

```text
nen labels rename --target <owner/name> --map from=to,from2=to2 [--dry-run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The repository whose labels are renamed. | Missing -> exit 1 (same `requireTarget` inconsistency noted under `labels sync`). |
| `--map from=to,from2=to2` | yes | Rename mapping, applied in the order given. | A chain (`a=b,b=c`) applies in one invocation; missing or naming no mappings -> exit 2. |
| `--dry-run` | no (boolean) | Logs the `gh label edit` call it would make, per mapping. | This verb accepts the global `--repo` and never reads it — the rename map comes from `--map`, not from a local taxonomy. Even in `--dry-run`, it still calls `gh label list` live (to decide idempotence) before deciding what it "would" do — dry-run here is not fully side-effect-free of network access, only of mutation. |

**Output and exit codes** — human rendering is one line per mapping:
`"<from> -> <to>: <status> -- <message>"` (`status` one of `renamed`, `already-done`, `would-rename`,
`failed`). `--json` prints the array of per-mapping results. Exit 0 when every mapping renamed,
was already done, or (in dry-run) was logged; exit 1 when at least one mapping failed (neither the old
nor the new name exists on the target); exit 2 when `--target` is malformed or `--map` is
missing/empty.

**Example** (quoted from `src/labels/rename.test.ts` and `src/labels/command.test.ts` — this verb
always makes at least one live `gh label list` call, even in `--dry-run`, so it was not run live per
this section's setup notes)

```bash
nen labels rename --target zheref/nen --map old=new
```
```text
old -> new: renamed -- renamed 'old' -> 'new', associations preserved
```

<a id="family-schema"></a>

**`nen schema`**

Loads and validates the files a target repository is expected to carry under `nen/` —
`nen/labels.json`, `nen/repos.json`, `nen/colors.yml`, `nen/gates.json` and the optional
`nen/contract.json` — and reports each file's own verdict. `nen` has no built-in copy of any of them to
fall back on: an absent or malformed file is reported by name, never guessed past.

### `nen schema check`

Answers "can this repository's taxonomy be read at all, and by which files": every REQUIRED file
(labels, repos, colors) failing fails the whole report; `gates.json` is optional in the sense that its
ABSENCE does not fail the report (only the readiness verbs need it) — but a `gates.json` that IS present
and malformed is still required, because a file that exists and is wrong is a defect in this
repository's own taxonomy, not a feature it simply hasn't adopted. `nen/contract.json` is optional the
same way, one step further: its absence is an `ok` row reading `absent (optional)`, and only a contract
that is present and malformed fails.

It is also where the `schemas/` → `nen/` migration is reported. A file read from the legacy `schemas/`
location gets a `warn` row printed at the path it was actually read from, followed by an indented
`^ legacy location…` line naming the canonical path and the v0.4.0 removal. A file present in BOTH
places whose bytes DIFFER is a **shadowed leftover**: the row FAILS the report even though the file
loaded, because `nen/` won the read and the copy somebody may still be editing is the one nen ignores.
Identical bytes in both places is an `ok` row with a note saying the deletion is free. The comparison
is **byte-exact** — a CRLF/LF drift between the two copies counts as different, since "identical" is
the finding that licenses deleting one of them.

A fourth state exists for the case where the comparison could not be made at all: both copies are
present, and one of them will not open (`EACCES`, a symlink cycle). That row is an **unverified
leftover**, and it fails the report for the same fail-closed reason — but it says so in its own words
and names the errno, rather than asserting bytes it never compared. The distinction is not cosmetic:
when it is the `nen/` copy that cannot be read, "the bytes differ, nen read the `nen/` one, delete the
legacy copy" is three claims that are false and one instruction that would delete the only readable
file the repository has left.

**Usage**

```text
nen schema check --repo <path> [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | no | The target repository's working-tree root. | Defaults to cwd. |
| `--json` | no (boolean) | Machine-readable output. | `{ root, ok, checks: [...], deprecations: [...] }`. |

**Output and exit codes** — human rendering: `"repository: <root>"` then one line per file:
`"  <ok|FAIL|warn>  <file, at the path it was read from>  <detail>"`, optionally followed by an
indented `"        ^ <migration note>"` line. `--json` matches exactly: `{ root, ok, checks,
deprecations }`, each check carrying `{ file, path, location, ok, detail, required, shadow, shadowed,
note }` in that key order for every row — `location` is `"nen"` or `"schemas"`, `shadow` is
`"none" | "identical" | "different" | "unknown"` (what the two copies had to say to each other, so a
machine reader can tell "the bytes disagree" from "nen could not look"), `shadowed` is the boolean that
fails the row, and `deprecations` lists every migration note in row order (empty for a fully migrated
repository). Exit 0 when every REQUIRED file loaded and validated and nothing is shadowed; exit 1 when
any required file failed (absent, unreadable, or invalid) or any file's legacy copy is unaccounted for
— different bytes, or a comparison nen could not make — `gates.json` failing only because it is absent
does not trip this, and neither does an absent `nen/contract.json`.

**Example**

```bash
nen schema check --repo src/schema/fixtures/bankai-repo
```
```text
repository: /path/to/src/schema/fixtures/bankai-repo
  ok    nen/labels.json  13 labels
  ok    nen/repos.json  3 consumers, 6 product codes, latest v0.11.2
  ok    nen/colors.yml  3 categories, 13 values
  ok    nen/gates.json  5 reviewer identities
  ok    nen/contract.json  dependency (nen >= 0.3, pinned v0.3.0), project (2 lanes: web, android; 10 verbs; 3 toolchain entries)
```
(from a real run against the bundled fixture repo)

The same verb against the bundled **un-migrated** fixture, which carries the four files at the legacy
location and no contract:

```bash
nen schema check --repo src/schema/fixtures/legacy-repo
```
```text
repository: /path/to/src/schema/fixtures/legacy-repo
  warn  schemas/labels.json  13 labels
        ^ legacy location. Move it to 'nen/labels.json'; the schemas/ fallback is removed in v0.4.0.
  warn  schemas/repos.json  3 consumers, 6 product codes, latest v0.11.2
        ^ legacy location. Move it to 'nen/repos.json'; the schemas/ fallback is removed in v0.4.0.
  warn  schemas/colors.yml  3 categories, 13 values
        ^ legacy location. Move it to 'nen/colors.yml'; the schemas/ fallback is removed in v0.4.0.
  warn  schemas/gates.json  5 reviewer identities
        ^ legacy location. Move it to 'nen/gates.json'; the schemas/ fallback is removed in v0.4.0.
  ok    nen/contract.json  absent (optional)
```
exit 0 — an un-migrated repository still passes for the whole v0.3 line.
(from a real run against the bundled fixture repo)

<a id="family-color"></a>

**`nen color`**

Resolves one row's colour token by applying the target repository's own `nen/colors.yml`
precedence to the values that are true of that row. There is no built-in colour table and no fallback
anywhere in this family: a combination the file's precedence cannot rank is reported unresolved rather
than picked from arbitrarily.

### `nen color status`

Answers "given everything that is true of this row, which colour applies, by this repository's own
rule" — the FIRST value in the category's declared `precedence` list that is also present wins; every
other present value is reported as `outranked`. A category the file does not declare is a typo (exit
2), the same class of refusal as an unknown label or product code elsewhere in this section.

**Usage**

```text
nen color status --present <a,b,c> [--category <name>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--present <a,b,c>` | no (the parser accepts its absence) | The category values that apply to this row, comma-separated. | Order is irrelevant — the file's own precedence decides. An empty/omitted value resolves to `"unresolved"` at exit 1, not a usage error. |
| `--category <name>` | no | The colours category to resolve in. | Defaults to the subcommand's own name (`"status"`). An undeclared category is a usage error (exit 2), naming the ones the file does declare. |
| `--repo <path>` | no | The checkout whose `nen/colors.yml` is read. | Defaults to cwd. |

**Output and exit codes** — human rendering: `"<emoji>  <name>[  <label>]"`, an optional
`"outranked: ..."` line, then `"precedence: <a > b > c>"`, and, if any `--present` value is not one of
the category's own values, a `"not values of '<category>': ..."` line. `--json` prints the full
`StatusResolution`. Exit 0 when a value resolved; exit 1 when nothing resolved (nothing present, or
none of what's present is ranked); exit 2 for an undeclared `--category`.

**Example**

```bash
nen color status --repo src/schema/fixtures/bankai-repo --present ready_g1,blocked --category status
```
```text
🔴  blocked  Blocked
outranked: ready_g1
precedence: on_hold > blocked > ready_g2_g4 > ready_g1 > in_progress
```
(from a real run against `src/schema/fixtures/bankai-repo`)

<a id="family-repo"></a>

**`nen repo`**

Resolves a repository token against the target repository's own `nen/repos.json`, inventories a
consumer's live GitHub backlog, and reads back one target's recorded scenario. Resolution is always
exact and case-insensitive, never a prefix match: an unknown token is an error naming what the registry
does contain, never a guess at "the closest match".

### `nen repo resolve`

Answers "which repository/repositories does this token name, per this registry" — a product code
(`BC`), an `owner/name` slug, a repository's short name, or `all`, matched from EVERYTHING the file
records (consumers, `product_codes`, `maintained_tools`, `pending_onboarding`), never just the consumer
list. With no token, it reads the CALL SITE's own `origin` remote and resolves that instead — an
`origin` that fails to resolve is an error, never a silent fallback to `all`.

**Usage**

```text
nen repo resolve [<token>] [--repo <path>]
nen repo resolve [--from <dir>] [--repo <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `<token>` (positional) | no | A product code, `owner/name` slug, short name, or `all`. | Matched exactly, case-insensitively, never as a prefix. An unknown token is refused (exit 1), listing every code/repo the registry does have. |
| `--from <dir>` | no | NO-TOKEN FORM ONLY: the directory whose `origin` is read. | Defaults to cwd. Refused (exit 2) when combined with an explicit token. |
| `--repo <path>` | no | The checkout whose `nen/repos.json` is the registry resolved against. | Defaults to cwd. Independent of `--from` — one is "whose registry", the other is "whose origin". |

**Output and exit codes** — human rendering: an `"origin: <url>"` line (no-token form only), then one
line per resolved repo: `"<repo>[  (<code>)]  via <kind>"`. `--json` prints `{ token, origin, repos }`.
Exit 0 on any successful resolution (including `all`); exit 1 when the token (or the resolved origin)
names nothing in the registry, or when there is no readable `origin` remote to fall back to; exit 2
when `--from` is combined with an explicit token.

**Example**

```bash
nen repo resolve KP --repo src/schema/fixtures/bankai-repo
```
```text
zheref/KroApple  (KP)  via code
```
(from a real run against the bundled fixture registry)

### `nen repo inventory`

senkei's live enumeration of one consumer's backlog: every open issue carrying `--epic-label` with its
children (read over the REST sub-issues endpoint), every branch under `--integration-prefix` with its
ahead/behind count against `--trunk`, and every open pull request. Always fetched live — there is no
cached or offline form of this verb.

**Usage**

```text
nen repo inventory --target <owner/name> --epic-label <label> --integration-prefix <prefix> [--trunk main]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The repository to enumerate, live. | Missing -> exit 1 (same `requireTarget` inconsistency as `labels sync`, above — confirmed live: `nen repo inventory --epic-label ... --integration-prefix ...` with no `--target` prints `--target owner/name is required.` and exits 1, not 2). |
| `--epic-label <label>` | yes | The label marking an epic issue. | Missing -> exit 2. |
| `--integration-prefix <prefix>` | yes | The naming convention for a live integration branch. | No default — the convention is the target repository's own; missing -> exit 2. |
| `--trunk <branch>` | no | Branch integration branches are compared against. | Default `main`. |

**Output and exit codes** — human rendering: `"epics: <n>"` then, per epic, its children indented,
`"integration branches: <n>"` with each branch's ahead/behind, `"open PRs: <n>"` with each PR's base
branch and draft state. `--json` prints `{ epics, integrationBranches, openPrs }`. Exit 0 always on a
completed enumeration (this verb has no exit-1/2 path once past flag validation — a `gh` failure
propagates as an uncaught error, generic exit 1).

**Example** (shape confirmed from `src/repo/inventory.test.ts` — this verb always reaches GitHub live
and was not run per this section's setup notes)

```bash
nen repo inventory --target zheref/KroApple --epic-label type:epic --integration-prefix integration/ --trunk main
```
```text
epics: 1
  #1 epic -- 0 child(ren)
integration branches: 0
open PRs: 0
```

### `nen repo scenario`

Reads back the `scenario` string recorded for `--target` in `--repo`'s `nen/repos.json` — the
value `canon resolve`/quality-tooling lookups read elsewhere in this CLI. `--repo` is required and
never defaulted to cwd here specifically because a cwd default previously surfaced whatever unrelated
registry happened to be there instead of the forgotten flag (issue #28).

**Usage**

```text
nen repo scenario --repo <path> --target <owner/name>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The checkout whose `nen/repos.json` records `--target`'s scenario. | Listed unbracketed; omitting it is refused BY NAME at exit 2, never silently defaulted. |
| `--target <owner/name>` | yes | The repository whose scenario is read back. | Missing -> exit 1 (same inconsistency as above). |

**Output and exit codes** — human rendering is the bare scenario string on success, or `"nen: <reason>"`
on stderr otherwise. `--json` prints `{ ok, scenario }` or `{ ok, reason }`. Exit 0 when a scenario was
found; exit 1 with a DISTINCT reason for each of: `--repo` carries no `nen/repos.json`, `--target`
is not recorded anywhere in it, or it is recorded but carries no `scenario` field; exit 2 when `--repo`
is omitted.

**Example**

```bash
nen repo scenario --repo src/schema/fixtures/bankai-repo --target zheref/KroApple
```
```text
swiftui-tca-uzf-v2
```
(from a real run against the bundled fixture registry)

<a id="family-ref"></a>

**`nen ref`**

Formats and parses the `<CODE>-<IS|PR>-#<N>` object notation this CLI and the skills that call it use
to cross-reference an issue or a PR unambiguously across repositories — a bare `#386` does not say
which repository it lives in or whether it is an issue or a PR. `format` checks its code against the
target repository's own registry before emitting; `parse` never guesses at a malformed token.

### `nen ref format`

Answers "what is the correctly-formatted token for this object", building `<CODE>-<IS|PR>-#<N>` plus an
optional kind glyph and state mark. The kind glyph is always derived from `--kind` itself, never a
separate field, so it can never disagree with the notation; the state mark comes from an explicit
`--state`, since a lifecycle cannot be read off a bare ref. `open` renders no mark by design — that is
a fact ("confirmed open"), not the same as an unrecognized state, which still renders the bare token
but warns and fails the run.

**Usage**

```text
nen ref format --code <CODE> --kind <IS|PR> --number <N> [--state <s>] [--url <u>] [--no-glyphs]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--code <CODE>` | yes | Two or three uppercase letters. | Checked against `nen/repos.json`; a code the registry does not carry is refused (exit 2), naming the declared codes. |
| `--kind <IS\|PR>` | yes | IS for an issue, PR for a pull request. | Any other value -> exit 2. |
| `--number <N>` | yes | The object's number. | Must be a whole number. |
| `--state <s>` | no | `merged \| completed \| closed \| draft \| open`. | An unrecognized value still emits the bare token, but warns on stderr and exits 1 — an unreadable lifecycle must not look like a confirmed-open one. |
| `--url <u>` | no | Wraps the WHOLE token as a markdown link. | |
| `--no-glyphs` | no (boolean) | Emit the bare notation, no kind glyph or state mark. | |
| `--repo <path>` | no | The registry the code is checked against. | Defaults to cwd. |

**Output and exit codes** — human rendering is the formatted token alone. `--json` prints
`{ ref, token, glyph, mark, unknownState }`. Exit 0 on a recognized (or omitted) state; exit 1 when
`--state` is given but not one of the five known states; exit 2 for a missing required flag, an
unrecognized `--kind`, a non-numeric `--number`, or a `--code` the registry does not declare.

**Example**

```bash
nen ref format --repo src/schema/fixtures/bankai-repo --code KP --kind PR --number 386 --state open
```
```text
🔀 KP-PR-#386
```
(from a real run against `src/schema/fixtures/bankai-repo`)

### `nen ref parse`

Answers "what does this token mean" — the inverse of `format`. A token that does not match
`<CODE>-<IS|PR>-#<N>` is refused with the full grammar restated, never guessed at.

**Usage**

```text
nen ref parse <token>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `<token>` (positional) | yes | A token in object notation. | Missing or malformed -> exit 2, naming the exact grammar. Does not touch the registry — the code half is not re-validated against it. |

**Output and exit codes** — human rendering: `ref:`, `code:`, `kind:`, `number:`, `glyph:` lines.
`--json` prints `{ ref, code, kind, number, glyph }`. Exit 0 on a well-formed token; exit 2 when the
token is missing or does not match the notation.

**Example**

```bash
nen ref parse "KP-PR-#386" --json
```
```text
{
  "ref": "KP-PR-#386",
  "code": "KP",
  "kind": "PR",
  "number": 386,
  "glyph": "🔀"
}
```
(from a real run — no registry involved)

## Release mechanics

The local release machinery: the preconditions a cut depends on, the changelog
reconciliation and collation, the annotated tag pinned at an explicit SHA, the
consumer fan-out, and the one CI re-run verb. None of these publishes a
release — a tag is not a release.

<a id="family-release"></a>

**`nen release`**

getsuga's local release machinery: `preflight` gathers every precondition of
a release cut and reports the whole table, never stopping at the first
failure; `resolve-target` and `self-check` answer two git-mechanical
reachability questions the cut depends on. It never cuts the tag itself
(`nen tag cut` does that) and never decides whether a held or live-chore
release should proceed — those stay human calls.

### `nen release preflight`

Checks every row of getsuga §2's precondition table: the `RELEASE_HOLD`
variable (or `--hold-var`'s own name), open critical issues, CON-36 live
chores, an empty `changelog.d/` at the cut point, CON-33(c) reconciliation,
and whether the tag name already exists — all six, always, never just the
first failure.

**Usage**

```text
nen release preflight --repo-slug <owner/name> --tag <vX.Y.Z> --range <vPrev>..<cut-point> --changelog <path> --owner-repo <owner/name> [--hold-var <name>] [--critical-issues <n,n>] [--live-chores-from <path>] [--fragment-dir <dir>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo-slug <owner/name>` | yes | checks `RELEASE_HOLD` and the tag against this GitHub repo | passed straight to `gh variable get`/`git ls-remote` |
| `--tag <vX.Y.Z>` | yes | the tag being proposed | checked against `git ls-remote --tags origin` |
| `--range <vPrev>..<cut-point>` | yes | same contract as `nen changelog completeness` | — |
| `--changelog <path>` | yes | the `CHANGELOG.md` at the cut point | — |
| `--owner-repo <owner/name>` | yes | scopes changelog link matching to this repo | — |
| `--hold-var <name>` | no | the gh variable to read | default `RELEASE_HOLD`; case-insensitive `true`/`1`/`yes` = held, `false`/`0`/`no`/unset = not held, any other non-empty value fails CLOSED as held |
| `--critical-issues <n,n>` | bracketed, but **required to pass the row** | open critical-severity issue numbers, gathered by the caller | omitting it reports "not supplied -- not checked" and fails the row; pass `''` to assert none |
| `--live-chores-from <path>` | bracketed, but **required to pass the row** | a JSON array of the CON-36 three-part test's inputs per chore | omitting it fails the row the same way; a file containing `[]` asserts none live |
| `--fragment-dir <dir>` | no | same default and empty/non-directory rules as `nen changelog completeness` | default `changelog.d` |
| `--repo <path>` | no | resolves relative `--changelog`/`--live-chores-from`/`--fragment-dir` | default cwd |
| `--json` | no | machine-readable preflight table | — |

**Output and exit codes** — human lines: `ok`/`FAIL` plus the check name and
detail, one per row; `--json` top-level keys: `checks[]` (`name`, `ok`,
`detail`), `liveChores[]`, `ok`. Exit 0 when every row passes, exit 1 when
any row fails, exit 2 on a missing required flag.

**Example**

```bash
nen release preflight --repo-slug o/r --tag v1.1.0 --range v1.0.0..v1.1.0 --changelog CHANGELOG.md --owner-repo o/r --critical-issues '' --live-chores-from live-chores.json
```
```text
ok  RELEASE_HOLD -- not set
ok  open critical issues -- none
ok  CON-36 live chores -- none live (issue open AND branch exists AND an open PR targets it or main)
ok  changelog.d/ empty at cut point -- empty
ok  CON-33(c) reconciled -- every merged PR has a CHANGELOG entry or fragment
ok  tag does not already exist -- clear
```
exit 0
(from `src/release/command.test.ts`'s "passes every check on a clean cut point" case — this verb reaches GitHub via `gh variable get` and `git ls-remote origin`, so it was not run live here)

### `nen release resolve-target`

getsuga §1: resolves a release token to a SHA (re-fetching `origin/--trunk`
first) and tests `git merge-base --is-ancestor <sha> origin/<trunk>` — the
load-bearing check that a tag is only ever cut on the trunk. A dirty
`checkout` token is refused outright.

**Usage**

```text
nen release resolve-target --repo <path> --token <main|last-commit|checkout|hash|branch> [--trunk main]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the repository whose `origin/--trunk` the token resolves against | unbracketed in usage; omitted is refused at exit 2 (#28) |
| `--token <t>` | yes | `main`, `last-commit`, `checkout`, or a literal SHA/branch name | `main`/`last-commit` both resolve to `origin/<trunk>`'s tip; `checkout` resolves to `HEAD` (refused if dirty); anything else is used as-is as a `git rev-parse` argument |
| `--trunk <branch>` | no | the trunk branch | default `main` |
| `--json` | no | machine-readable resolution | — |

**Output and exit codes** — human lines: `<token> -> <sha>`, then whether it
is an ancestor of the trunk; `--json` top-level keys: `token`, `sha`,
`isAncestorOfTrunk`. Exit 0 when the resolved commit is an ancestor of the
trunk, exit 1 when it is not (or the token cannot be resolved, or a dirty
`checkout` is refused), exit 2 on a missing `--token`/`--repo`.

**Example**

```bash
nen release resolve-target --repo . --token main
```
```text
origin/main -> sha1
an ancestor of the trunk -- safe to cut
```
exit 0
(from `src/release/command.test.ts`'s scripted `git fetch origin main` / `git rev-parse origin/main` / `git merge-base --is-ancestor sha1 origin/main` case — this verb reaches GitHub via `git fetch`, so it was not run live here)

### `nen release self-check`

getsuga §3: whether a release PR should list itself — true iff its own merge
commit is reachable from `--cut-point` and not already reachable from
`--previous-tag`. A git-mechanical fact, never a judgement.

**Usage**

```text
nen release self-check --repo <path> --pr-merge-sha <sha> --previous-tag <ref> --cut-point <ref>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the repository whose history answers the reachability question | unbracketed in usage; omitted is refused at exit 2 (#28) |
| `--pr-merge-sha <sha>` | yes | the release PR's own merge commit | — |
| `--previous-tag <ref>` | yes | the tag the previous release cut | — |
| `--cut-point <ref>` | yes | the commit this release is cutting at | — |
| `--json` | no | machine-readable result | — |

**Output and exit codes** — human line: `#<sha> should [NOT] list ITSELF --
it falls [outside/inside] <previous>..<cut-point>`; `--json` top-level keys:
`prMergeSha`, `previousTag`, `cutPoint`, `reachableFromCutPoint`,
`alreadyInPreviousTag`, `shouldListItself`. Always exits 0 (a report, not a
guard); exit 2 on a missing flag; a `git merge-base` failure propagates as
exit 1.

**Example**

```bash
nen release self-check --repo . --pr-merge-sha pr-sha --previous-tag v1.0.0 --cut-point cut-point
```
```text
#pr-sha should list ITSELF -- it falls inside <v1.0.0>..<cut-point>
```
(from `src/release/command.test.ts`'s scripted `git merge-base --is-ancestor pr-sha cut-point` (0) / `git merge-base --is-ancestor pr-sha v1.0.0` (1) case — this is local git-only, but the exact SHAs/tags are synthetic test values, so quoted rather than fabricated as a "real" release)

<a id="family-changelog"></a>

**`nen changelog`**

CON-33's changelog machinery, in three parts: whether a change owes a
`changelog.d/` fragment (a), collating fragments into a new dated
`CHANGELOG.md` section (b), and reconciling a merged-PR range against the
changelog (c). It reads and writes only the changelog file and the fragment
directory the caller names; it never opens or merges a PR.

### `nen changelog fragment-required`

CON-33(a): does this change owe a `changelog.d/` fragment? Not applicable if
no spec/canon path changed; satisfied by an opt-out stated in the body, a
fragment added at head, or a recognized "release move" (Unreleased emptied
via collation); otherwise required.

**Usage**

```text
nen changelog fragment-required --spec-paths <a,b> --fragment-dir <dir> (--files ... | --files-from ... | --range ...) [--body-from <path>] [--base-changelog <path>] --head-changelog <path> [--base-repos <path>] [--head-repos <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--spec-paths <a,b>` | yes | the spec/canon path patterns CON-33(a) covers | — |
| `--fragment-dir <dir>` | yes | the fragment directory, relative to the repo root | unlike `completeness`/`preflight`, this verb has no default — it must be named |
| `--files`/`--files-from`/`--range` | exactly one | the changed-file set | same three-way contract as `gate derive` |
| `--head-changelog <path>` | yes | the changelog at HEAD | — |
| `--body-from <path>` | no | the PR body, checked for an opt-out statement | — |
| `--base-changelog <path>` | no | the changelog at the merge base | used to detect a "release move" |
| `--base-repos <path>` / `--head-repos <path>` | no | a `nen/repos.json`-shaped file, read only for its `.latest` field | used to detect an integration-epic collation |
| `--repo <path>` | no | resolves every relative path above, and `--range`'s `git diff` | default cwd |
| `--json` | no | machine-readable verdict | — |

**Output and exit codes** — human lines: the verdict, then the one-line
detail; `--json` top-level keys: `verdict`
(`not-applicable`\|`opt-out`\|`fragment-present`\|`release-move`\|`required`),
`required`, `triggers[]`, `detail`. Exit 0 unless `verdict: required` (exit
1); exit 2 on a missing required flag or more/fewer than one changed-file
source.

**Example**

```bash
nen changelog fragment-required --repo . --spec-paths "schemas/*" --fragment-dir changelog.d --files "schemas/gates.json" --head-changelog CHANGELOG.md
```
```text
required
this change touches a spec/canon path (schemas/*) but adds no changelog.d/ fragment, and its body carries no opt-out with a reason. Add changelog.d/<number>-<slug>.md -- never a direct edit to the changelog's Unreleased block, which the fragment convention retired as the per-PR mechanism -- or state the opt-out reason if this change is genuinely non-spec.
```
exit 1
(from a real run against a scratch repo whose `changelog.d/` held an unrelated fragment and whose changed file was `schemas/gates.json`)

### `nen changelog collate`

CON-33(b): collates every fragment in `--fragment-dir` into a new dated
section of `--changelog`. Without `--write`, reports the rendered result
without touching disk or deleting fragments.

**Usage**

```text
nen changelog collate --version <vX.Y.Z> --theme <text> --changelog <path> --fragment-dir <dir> [--write]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--version <vX.Y.Z>` | yes | the new release version | — |
| `--theme <text>` | yes | the release's one-line theme | — |
| `--changelog <path>` | yes | the `CHANGELOG.md` to rewrite | — |
| `--fragment-dir <dir>` | yes | the fragment directory | a missing directory contributes zero fragments rather than refusing |
| `--write` | no | actually rewrite the changelog and delete the collated fragments | default off (dry-run) |
| `--repo <path>` | no | resolves relative `--changelog`/`--fragment-dir` | default cwd |
| `--json` | no | machine-readable collation result | — |

**Output and exit codes** — human lines: `(no --write) would collate` or
`collated <n> fragment(s) into <path> ### v<version> — <theme>`, then each
fragment name; `--json` top-level keys: `version`, `theme`, `fragments[]`,
`written`. Exit 0 on any completed run — there is no "drift" verdict here,
only "wrote/didn't write". Exit 2 on a missing required flag. Exit 1 on an
unreadable `--changelog`: the read at `src/changelog/command.ts:130` is
unguarded, so the ENOENT escapes as a raw
`nen changelog: ENOENT: no such file or directory, open '<resolved path>'`
rather than the exit-2 named refusal a mistyped path deserves, in both text
and `--json` mode. Tracked as
[zheref/nen#101](https://github.com/zheref/nen/issues/101).

**Example**

```bash
nen changelog collate --repo . --version v0.3.0 --theme "readiness and release docs" --changelog CHANGELOG.md --fragment-dir changelog.d
```
```text
(no --write) would collate 1 fragment(s) into CHANGELOG.md ### v0.3.0 — readiness and release docs
  90-usage-docs.md
```
(from a real run against a scratch `CHANGELOG.md` and a `changelog.d/90-usage-docs.md` fragment; `CHANGELOG.md` was confirmed unchanged on disk afterward since `--write` was not given)

### `nen changelog completeness`

CON-33(c): every PR merged in `--range` has a CHANGELOG entry or an
(un)collated fragment. `--owner-repo` scopes changelog link matching to this
repository, so a foreign-repo link sharing a PR number never counts.

**Usage**

```text
nen changelog completeness --range <vPrev>..<vNew> --changelog <path> --owner-repo <owner/name> [--fragment-dir <dir>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--range <vPrev>..<vNew>` | yes | as `git log --merges` understands it | — |
| `--changelog <path>` | yes | the `CHANGELOG.md` to reconcile against | — |
| `--owner-repo <owner/name>` | yes | scopes changelog link matching to THIS repository | — |
| `--fragment-dir <dir>` | no | same default/empty/non-directory rules as `release preflight` | default `changelog.d`; a missing directory means zero fragments, not a refusal |
| `--repo <path>` | no | resolves relative `--changelog`/`--fragment-dir` and runs `git log` | default cwd |
| `--json` | no | machine-readable result | — |

**Output and exit codes** — human lines: a pass line, or `missing CHANGELOG
entry or fragment for:` plus each `#<n>`; `--json` top-level keys: `ok`,
`missing[]`. Exit 0 when every merged PR is covered, exit 1 when any PR is
missing, exit 2 on a missing required flag.

**Example**

```bash
nen changelog completeness --repo . --range v0.2.0..v0.3.0 --changelog CHANGELOG.md --owner-repo zheref/nen
```
```text
every PR merged in v0.2.0..v0.3.0 has a CHANGELOG entry or fragment.
```
exit 0
(from a real run against a scratch git repo carrying a "Merge pull request #90" merge commit and a matching `changelog.d/90-usage-docs.md` fragment)

<a id="family-tag"></a>

**`nen tag`**

Cuts one annotated git tag pinned at an explicit SHA — getsuga §4's
mechanical follow-through once a release PR merges. It never resolves "the
cut point" itself (`nen release resolve-target` does that), and it never
pushes unless `--push` is given.

### `nen tag cut`

Refuses if the name already exists locally or on origin (never re-tagged),
if `--at` is not an ancestor of `origin/--trunk` (never tags off-trunk), or
if either existence check itself fails to run (never cut on an unverified
name). The tag is always annotated (`git tag -a`).

**Usage**

```text
nen tag cut --repo <path> --name <vX.Y.Z> --at <sha> [--message <text>] [--trunk main] [--push]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the repository the tag is cut in | unbracketed in usage; omitted is refused at exit 2 (#28) |
| `--name <vX.Y.Z>` | yes | the tag name | — |
| `--at <sha>` | yes | the exact commit to pin the tag at | REQUIRED, never defaulted to HEAD — "cut from main" is not an instruction a script can follow |
| `--message <text>` | no | the annotated tag's message | default: the tag name itself |
| `--trunk <branch>` | no | checked as `origin/--trunk` for the ancestor test | default `main` |
| `--push` | no | also `git push origin <name>` | without it the tag is created LOCALLY ONLY, never auto-pushed |
| `--json` | no | machine-readable cut result | — |

**Output and exit codes** — human lines are the `log[]` entries (existence
checks, the ancestor check, `created local tag '<name>' at <sha>`, `NOT
pushed -- pass --push...` or `pushed '<name>' to origin`); `--json`
top-level keys: `ok`, `pushed`, `log[]`, `error`. Exit 0 on a successful cut
(pushed or not, as asked), exit 1 on any refusal (name exists, not an
ancestor, an existence check itself failing) or a push failure, exit 2 on a
missing `--name`/`--at`/`--repo`.

**Example**

```bash
nen tag cut --repo . --name v1.0.0 --at abc
```
```text
'v1.0.0' does not exist locally or on origin
'abc' is an ancestor of origin/main
created local tag 'v1.0.0' at abc
NOT pushed -- pass --push to push this tag; it is never automatic
```
exit 0
(from `src/tag/command.test.ts`'s scripted `git ls-remote`/`git tag -l`/`git merge-base --is-ancestor`/`git tag -a` case — this verb mutates the target repository (and, with `--push`, reaches GitHub), so it was not run live here)

<a id="family-fanout"></a>

**`nen fanout`**

getsuga §7's CON-22 fan-out: which downstream consumers (`nen/repos.json`)
are affected by the GitHub Actions workflows a release range changed. It
never opens a repin PR itself — `compute` reports the set and `record`
appends it to an audit ledger for a caller to act on.

### `nen fanout compute`

`changed-workflows(vPrev..vNew)` INTERSECT each registered consumer's
`consumes`. Every consumer is a row: `affected` with its matched workflow
basenames, or an EXPLICIT `n/a` — an unstated N/A would be indistinguishable
from an unswept repo.

**Usage**

```text
nen fanout compute --range <vPrev>..<vNew> [--workflows-dir <dir>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--range <vPrev>..<vNew>` | yes | the release range | computed via `git diff --name-only` scoped to `--workflows-dir` |
| `--workflows-dir <dir>` | no | the workflows directory | default `.github/workflows` |
| `--repo <path>` | no | the repo whose `nen/repos.json` and workflow history are read | default cwd |
| `--json` | no | machine-readable fan-out rows | — |

**Output and exit codes** — human lines: `changed workflows in <range>:
<list>`, then one `AFFECTED`/`n/a` row per registered consumer with its
basis; `--json` top-level keys: `range`, `changedWorkflows[]`, `rows[]`
(`repo`, `code`, `status`, `matchedWorkflows[]`, `basis`). Always exits 0.

**Example**

```bash
nen fanout compute --repo . --range v0.11.2..v0.11.3
```
```text
changed workflows in v0.11.2..v0.11.3: sasuke-review.yml
AFFECTED  zheref/KroApple (KP)  -- consumes sasuke-review.yml, which changed in this range
AFFECTED  zheref/KroAndroid (KN)  -- consumes sasuke-review.yml, which changed in this range
AFFECTED  zheref/bankai-scaffold (BS)  -- consumes sasuke-review.yml, which changed in this range
```
(from a real run against a scratch git repo seeded with the bundled fixture's `nen/repos.json` and two tags, `v0.11.2` and `v0.11.3`, differing only in `sasuke-review.yml`)

### `nen fanout record`

The same computation as `compute`, appended to a ledger for audit: one JSON
line per consumer, per invocation.

**Usage**

```text
nen fanout record --range <vPrev>..<vNew> [--workflows-dir <dir>] [--ledger <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--range <vPrev>..<vNew>` | yes | the release range | same as `compute` |
| `--workflows-dir <dir>` | no | the workflows directory | default `.github/workflows` |
| `--ledger <path>` | no | the ledger file to append to | default `fanout-ledger.jsonl`, resolved against `--repo`/cwd if relative (not stated in `--help`, only in code) |
| `--repo <path>` | no | the repo whose `nen/repos.json` and workflow history are read | default cwd |
| `--json` | no | machine-readable fan-out rows plus `ledgerPath` | — |

**Output and exit codes** — human line: `recorded <n> row(s) to <ledgerPath>`;
`--json` top-level keys: `range`, `changedWorkflows[]`, `rows[]`,
`ledgerPath`. Always exits 0.

**Example**

```bash
nen fanout record --repo . --range v0.11.2..v0.11.3
```
```text
recorded 3 row(s) to /path/to/repo/fanout-ledger.jsonl
```
(from a real run, same scratch repo as `fanout compute`'s example; `fanout-ledger.jsonl` afterward held one JSON line per row, the first reading `{"range":"v0.11.2..v0.11.3","at":"2026-09-07T22:58:40.613Z","repo":"zheref/KroApple","code":"KP","status":"affected","matchedWorkflows":["sasuke-review.yml"],"basis":"consumes sasuke-review.yml, which changed in this range"}`)

<a id="family-run"></a>

**`nen run`**

One verb: re-running a workflow run's failed jobs, senkei's dead-reviewer
recovery. It never re-labels a PR to force a fresh review round — only ever
runs the rerun.

### `nen run rerun-failed`

Exactly `gh run rerun <n> --failed`.

**Usage**

```text
nen run rerun-failed --target <owner/name> --run-id <n>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | the GitHub repository | missing exits 2 (this family's own refusal uses `VerbUsageError`, unlike `pr`'s); a malformed slug is caught and exits 1 |
| `--run-id <n>` | yes | the Actions run id | missing/non-numeric exits 2 |
| `--json` | no | machine-readable result | — |

This verb reads no `--repo` — it has no reason to touch a local checkout.

**Output and exit codes** — human line: `re-ran the failed job(s) of
<target>'s run <n>`, or the `gh` failure message; `--json` top-level keys:
`ok`, `message`. Exit 0 on success, exit 1 when `gh` fails or `--target` is
malformed, exit 2 on a missing `--target`/`--run-id`.

**Example**

```bash
nen run rerun-failed --target zheref/KroApple --run-id 42
```
```text
re-ran the failed job(s) of zheref/KroApple's run 42
```
(from `src/run/command.test.ts`, which scripts `gh run rerun 42 --repo zheref/KroApple --failed` — this verb reaches GitHub, so it was not run live here)

## Issue & idea filing

Reconcile against the backlog before writing to it, then file, attach, close
and classify. Every verb here reaches GitHub, and several of them read it even
under `--dry-run`; the only schema file any of them opens is the target
repository's `nen/labels.json`.

<a id="family-issue"></a>

**`nen issue`**

Reconciles the backlog before it writes to it: `nen issue` is the search-guard-file-classify choreography around GitHub issues -- it never decides that two issues are the same problem, never chooses a severity, and never writes a title or body, all of which stay a human's or an LLM caller's judgment. It reads and writes exclusively through `gh`; the only schema file any of its subcommands opens is the target repository's `nen/labels.json` (`file` and `consolidate-close`, to validate every label before it is ever sent to GitHub).

Every subcommand shares one flag spec, and `nen issue <verb>` refuses any flag a *different* sibling subcommand owns (e.g. `issue chain-position --dry-run` or `issue file --body <text>`) with a message naming which verb the flag actually belongs to, rather than silently accepting and ignoring it.

### `nen issue search`

The reconciliation's first move: four independent `gh issue list` passes, each answering a different question -- is this the same problem already open; was it the same problem, closed inside the last 90 days (`RECENTLY_CLOSED_DAYS`), so a regression reads as a re-open with new evidence rather than a new issue; does it touch the same files or rule IDs as an open issue, which is a fold candidate; does it share a lane label with an open issue, which is a routing neighbour. A pass with no terms (e.g. no `--files`/`--rule-ids` given) is reported as **skipped**, never silently omitted, because "ran three passes" and "ran four and found nothing" must read differently. Refuses (exit 1) the instant any pass could not run at all -- "found nothing" and "could not look" are never allowed to look the same. Also reports an `exact title match (normalized)`: the absorbed `dedupe_handbook_questions.sh` normalization, run over the open-subject pass, naming any issue whose title collapses to the exact same string as `--subject`.

**Usage**

```text
nen issue search --target <owner/name> --subject <text>
                 [--files a,b] [--rule-ids X-1,X-2] [--lane-labels l1,l2]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository to search. | Absence is a refusal at **exit 1** (a plain thrown error, not a parser usage error) -- an inconsistency worth knowing: every other required flag in this family that is checked at the parser boundary exits 2. |
| `--subject <text>` | no | Free-text problem statement, matched against open and recently-closed issues. | Omit it and both subject-driven passes report `skipped`; the files/rule-ids and lane passes still run if their own flags are given. |
| `--files a,b` | no | Paths the problem touches; each becomes an `in:body` OR-term for the fold-candidate pass. | Comma list. |
| `--rule-ids X-1,X-2` | no | Clause/rule identifiers, in whatever vocabulary the target repository spells them. | Comma list; joined into the SAME fold-candidate pass as `--files`. |
| `--lane-labels l1,l2` | no | Routing/lane labels from the target repository's own taxonomy. | Comma list; drives the lane pass alone. |
| `--repo <path>` | no | Not used by this verb at all. | `search` never reads a local checkout. |

**Output and exit codes** -- human rendering prints `repository: <slug>`, then each of the four passes (`[<id>] <rationale>`, the literal query, each `#<n> <state> <title>` candidate or `no candidates`, and a `WARNING` if the page came back full); `--json` top-level keys: `target`, `passes` (each carrying `id`, `query`, `argv`, `skipped`, `truncated`, `error`, `issues`), `exactTitleMatches`, `ok`. Exit 0 when every pass ran (whether or not it found anything); exit 1 when one or more passes could not run, or when `--target` was omitted.

**Example**

```bash
nen issue search --target zheref/bankai-core \
  --subject "wake verify swallows a paginated PR comment thread" \
  --files src/wake/command.ts,src/wake/detect.ts --rule-ids CON-38
```
```text
repository: zheref/bankai-core

[subject-open] the same problem, already open -- amend it with the new evidence instead of filing a second one
  query: wake verify swallows a paginated PR comment thread
  no candidates

[subject-recently-closed] the same problem, closed within the window -- a fix that regressed is a re-open with new evidence, not a new issue
  query: wake verify swallows a paginated PR comment thread closed:>=2026-06-09
  no candidates

[files-and-rule-ids] a different problem in the same files or under the same rule -- the fold candidates one PR would sanely deliver together
  query: "src/wake/command.ts" OR "src/wake/detect.ts" OR "CON-38"
  #41  OPEN  wake verify only paginates one page of PR comments

[lane] the same lane -- neighbours routed to the same authority, which is where a fold is defensible at all
  skipped -- this pass had no terms to search with
```
(shape derived from `src/issue/search.ts`'s recipes and `src/issue/command.ts`'s `printPass` rendering -- not run live, this reaches GitHub)

### `nen issue open-pr-check`

The guard that runs before any close: for each candidate issue number, is there an OPEN pull request that closes or mentions it. An issue with one in flight is never quietly closed by anything downstream, because closing it orphans work already underway. This is the same check `consolidate-close` runs internally over the children it is about to close -- exposed standalone so a caller can run it on its own before any other choreography.

**Usage**

```text
nen issue open-pr-check --target <owner/name> --issues 12,34
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository whose open PRs are scanned. | Missing exits 1 (same non-parser refusal as `search`). |
| `--issues 12,34` | yes | Comma-separated candidate issue numbers. | Omitted or empty exits **2** (a parser-level usage error, unlike `--target`). |

**Output and exit codes** -- prints `open pull requests scanned: <n>` (plus a `WARNING` if that scan came back full -- a "no open PR" answer is then not conclusive), then one line per issue: `#<n>: no open PR` or `#<n>: OPEN PR #<pr>[, ...] -- closing this orphans work in flight`. `--json`: `{ target, findings: [{ issue, pullRequests, blocked }], scanned, truncated }`. Exit 0 when nothing is blocked; exit 1 when any candidate is blocked -- so a shell caller piping this into a close loop stops rather than closing past the guard.

**Example**

```bash
nen issue open-pr-check --target zheref/bankai-core --issues 41,52,60
```
```text
open pull requests scanned: 37
  #41: OPEN PR #63 (draft) -- closing this orphans work in flight
  #52: no open PR
  #60: no open PR
```
(shape derived from `src/issue/file.ts`'s `OpenPrReport`/`LinkedPullRequest` and `src/issue/command.ts`'s `openPr()` -- not run live, this reaches GitHub)

### `nen issue file`

Creates the issue with its labels and assignee IN the create call -- never a follow-up `gh issue edit`, because a label applied a second later is a *second* `labeled` event on an object that already existed, and in a system where a label is a wake edge that is the difference between one dispatch and two. Refuses (never creates) a label the target repository's taxonomy does not carry, and a label whose family the caller declared off-limits with `--forbid-family`; GitHub itself would silently CREATE an unknown label rather than refuse, which is exactly the permanent undocumented label this verb exists to prevent.

**Usage**

```text
nen issue file --target <owner/name> --repo <path> --title <t>
               --body-file <path> --label a,b --assignee <user>
               [--forbid-family ns:family] [--dry-run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository to file into. | Missing exits 1. |
| `--repo <path>` | yes | The checkout whose `nen/labels.json` validates every `--label`. | Listed unbracketed in usage: omitted, this exits **2** by name, never silently reads the cwd's own taxonomy. |
| `--title <t>` | yes | The issue title. | Empty title is refused as part of the batch below (exit 1), not at the parser. |
| `--body-file <path>` | yes | Path to the issue body. A body typed inline on the command line is a body nobody reviewed, so there is no `--body`. | Omitted entirely exits **2** (checked ahead of the batch); an unreadable path is a separate refusal. |
| `--label a,b` | yes | Comma-separated labels, applied in the create call. | Every label must exist in `--repo`'s taxonomy; an empty list is refused. |
| `--assignee <user>` | yes | A single GitHub login. | Empty is refused: an unassigned issue reaches nobody by notification. |
| `--forbid-family ns:family` | no | Label families this invocation declares off-limits. | Caller data -- nen carries no repository's own "which family means released" convention. |
| `--dry-run` | no | Print the exact `gh issue create` argv and write nothing. | No network call is made in this mode at all -- safe to run against any target. |

**Output and exit codes** -- human rendering: `filed #<n> <url>` on success, or `would run: gh issue create ...` under `--dry-run`. `--json`: `{ ...FileResult, labels }` on success (`FileResult` = `{ url, number }`), `{ dryRun: true, argv }` under `--dry-run`. Refusals are ALWAYS printed as plain `nen: <reason>` lines to stderr, even under `--json` -- a caller in JSON mode still gets prose for a refusal, only the success path is machine-shaped. Exit 0 on a successful file (dry or real); exit 1 when title/labels/assignee/label-taxonomy/forbidden-family checks fail (every failing check is reported at once, not one round trip at a time); exit 2 when `--repo` or `--body-file` was omitted outright, or the label taxonomy itself could not be loaded.

**Example**

```bash
nen issue file --target zheref/bankai-core --repo src/schema/fixtures/bankai-repo \
  --title "wake verify does not paginate PR comments past one page" \
  --body-file /tmp/body.md \
  --label bankai:stage/idea,bankai:severity/medium --assignee zheref --dry-run
```
```text
would run: gh issue create --repo zheref/bankai-core --title wake verify does not paginate PR comments past one page --body-file /tmp/body.md --assignee zheref --label bankai:stage/idea --label bankai:severity/medium
```
(from a real run in `--dry-run` mode — no GitHub write, no network)

### `nen issue comment`

The general primitive the rest of the family lacked: post ONE caller-supplied comment on ONE issue -- so a mechanized choreography no longer has to drop back to a hand-run `gh issue comment` for the one step written in a human's own words. Deliberately accepts a number that names a pull request (unlike `attach-sub`/`chain-position`/`terminus`), because commenting on a PR is a normal thing to want to do and carries none of the hazards attaching or closing one silently would.

**Usage**

```text
nen issue comment --target <owner/name> --issue <n>
                  (--body-file <path> | --body <text>) [--dry-run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository. | Missing exits 1. |
| `--issue <n>` | yes | The issue or PR number to comment on. | Read with a strict `/^\d+$/` guard (unlike `--parent`/`chain-position`'s looser `Number(...)` read elsewhere in this family) -- `1e3` or `0x0c` are refused rather than silently accepted as 1000/12. |
| `--body <text>` | one of these two | The comment text, inline. | Exactly one of `--body`/`--body-file`; giving both, or neither, is refused (exit 2). A value starting with `-` must be spelled `--body=<text>`. |
| `--body-file <path>` | one of these two | The comment text, from a file -- keeps a body of any size off the command line. | An unreadable path, or one holding only whitespace, is refused. |
| `--dry-run` | no | Print the exact `gh` call AND the exact bytes it would send; write nothing. | No network call at all in this mode. |

**Output and exit codes** -- prints `commented on <target>#<issue> <url>` (or, when `gh` printed no URL, says so explicitly rather than inventing one). `--dry-run` prints `would run: gh ...` plus the body fenced between `--- body as it would be posted ---` / `--- end of body ...---`, stating explicitly whether the body ends with a trailing newline. `--json`: `{ dryRun, target, issue, source, argv, body, url? }`. Exit 0 on a successful post (dry or real); exit 2 on a malformed/absent body or issue number.

**Example**

```bash
nen issue comment --target zheref/bankai-core --issue 90 \
  --body "Filed as part of the USAGE.md doc pass; see docs/USAGE.md#issue for the wire-up." --dry-run
```
```text
would run: gh issue comment 90 --repo zheref/bankai-core --body Filed as part of the USAGE.md doc pass; see docs/USAGE.md#issue for the wire-up.
--- body as it would be posted ---
Filed as part of the USAGE.md doc pass; see docs/USAGE.md#issue for the wire-up.
--- end of body (no trailing newline) ---
```
(from a real run in `--dry-run` mode — no GitHub write, no network)

### `nen issue attach-sub`

Attaches children as GitHub sub-issues, resolving each child's numeric ID (the sub-issues API takes an ID, not the issue number) before writing. Posts NO comment and takes no close-comment channel -- a comment at attach time is a claim about a consolidation that a failed attach stops before completing; compose `issue comment` alongside it when one is wanted. Certifies `--parent` and every `--children` entry as an ISSUE, never a pull request, before the first write: GitHub numbers issues and PRs in one sequence served from the same `issues/{n}` endpoint, so attaching a pull request as a sub-issue would succeed and be invisible afterwards. A mixed list attaches NOTHING, rather than the genuine issues in it.

**Usage**

```text
nen issue attach-sub --target <owner/name> --parent <n> --children 1,2
                     [--dry-run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository. | Missing exits 1. |
| `--parent <n>` | yes | The parent issue every child attaches under. | Refused (exit 1) if it turns out to name a pull request, listing it under `pullRequests`. |
| `--children 1,2` | yes | Comma-separated child issue numbers. | Same PR-name refusal applies per-entry; a child that could not be READ at all (rather than certified-as-a-PR) is instead recorded in `failed` and its siblings still proceed. |
| `--dry-run` | no | Print the exact `gh api ... sub_issues` calls that would run; write nothing. | Still reads `--parent` and every `--children` entry over `gh api` to certify their object class first -- **this is not network-free**, unlike `issue file --dry-run`. |

**Output and exit codes** -- human rendering is the run's own `log` lines: `would run: gh api --method POST repos/<slug>/issues/<parent>/sub_issues -F sub_issue_id=<id>   (#<child> -> id <id>)` under `--dry-run`, or `attached #<child> (id <id>) to #<parent>` for a real write; a 404/410 from the sub-issues endpoint is reported with the documented task-list fallback. `--json`: the `AttachReport` -- `{ attached, failed, fallbackTaskList, log }`, or `{ parent, children, pullRequests, refused: true, reason }` on the object-class refusal. Exit 0 when every child attached; exit 1 when one or more children failed to attach, OR when the object-class certification refused (nothing is attached in that case).

**Example**

```bash
nen issue attach-sub --target zheref/bankai-core --parent 12 --children 41,52 --dry-run
```
```text
would run: gh api --method POST repos/zheref/bankai-core/issues/12/sub_issues -F sub_issue_id=100041   (#41 -> id 100041)
would run: gh api --method POST repos/zheref/bankai-core/issues/12/sub_issues -F sub_issue_id=100052   (#52 -> id 100052)
```
(shape derived from `src/issue/subissue.ts`'s `attachSub` and `src/issue/subissue.test.ts` -- not run live: even `--dry-run` reads GitHub to certify `--parent`/`--children` are issues, never pull requests)

### `nen issue consolidate-close`

The whole choreography in its load-bearing order: file (already done by the caller) -> attach -> close, with the label union and severity maximum computed and reported. `--severity-family <ns>:<family>` names the ONE label family reduced to its single strongest label instead of unioned; omitted, the verb REFUSES whenever the plain union would put two-or-more labels from one family on the parent at once, rather than silently defeating the reduction. Runs the same open-PR guard `open-pr-check` does over every child that would be closed, FIRST, and refuses the whole close (listing the blocking PRs) unless `--allow-open-pr` is given. Certifies `--parent` and every `--children` entry as an ISSUE before anything is written, exactly as `attach-sub` does, and answers a pull-request number with that refusal ahead of either of the two above -- never with advice ("pass --allow-open-pr") that cannot apply to it.

**Usage**

```text
nen issue consolidate-close --target <owner/name> --parent <n>
                            --children 1,2 --repo <path>
                            [--severity-family <ns>:<family>]
                            [--close-comment <template>]
                            [--close-comment-map <path>]
                            [--dry-run] [--allow-open-pr]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository. | Missing exits 1. |
| `--parent <n>` | yes | The consolidated issue every child folds into. | Object-class certified before any read is even used for planning. |
| `--children 1,2` | yes | Issue numbers to attach then close. | Same certification. |
| `--repo <path>` | yes | The checkout whose `nen/labels.json` computes the label union and severity maximum. | Listed unbracketed: omitted, exits **2** by name (zheref/nen#28). |
| `--severity-family <ns>:<family>` | no | The one label family reduced to its single strongest label. | Malformed shape (no `:`, or a leaf given instead of a family) is a usage error (exit 2); a well-formed family the taxonomy does not declare is a refusal (exit 1) naming the families it DOES declare. |
| `--close-comment <template>` | no | Replaces the default close text for EVERY child. | Template over `{parent}`/`{child}` ONLY; any other brace run (unmatched, or an unknown placeholder) is refused (exit 2) before any call. Mutually exclusive with `--close-comment-map`. |
| `--close-comment-map <path>` | no | A JSON object `{"<child>": "<text>", ...}` giving each child ITS OWN close text. | Path resolved against `--repo`'s root, not `process.cwd()`. Its key set must equal `--children` exactly -- a missing or extra key is refused. |
| `--allow-open-pr` | no | Override the open-PR guard. | Without it, any blocked child refuses the whole close. |
| `--dry-run` | no | Preview the plan and the rendered close comments; write nothing. | Still reads `--parent`/every child over `gh api` to certify object class and run the open-PR guard -- not network-free. |

**Output and exit codes** -- prints `parent: #<n>`, `label union: <a, b, ...>`, the severity line, any plan `note:` lines, then the attach log and the close log (or `would run:` lines under `--dry-run`). Without either `--close-comment` flag, every child is closed with the fixed `Consolidated into #<parent>.`, byte for byte. `--json` carries `{ plan, openPrs, report }` on a normal run, `{ plan, refused: true }` on the omitted-severity-family refusal, `{ plan, openPrs, refused: true }` on the open-PR block, or `{ parent, children, pullRequests, refused: true, reason }` on the object-class refusal (which publishes NO plan). Exit 0 on a clean close; exit 1 on any of: an unreduced severity family, a blocked open PR without `--allow-open-pr`, an object-class refusal, or a failed attach/close step; exit 2 on a malformed `--severity-family`, `--close-comment`/`--close-comment-map`, or an omitted `--repo`.

**Example**

```bash
nen issue consolidate-close --target zheref/bankai-core --repo src/schema/fixtures/bankai-repo \
  --parent 12 --children 41,52 --severity-family bankai:severity \
  --close-comment "Folded into #{parent} -- see its own body for the combined evidence." --dry-run
```
```text
parent: #12
label union: bankai:stage/idea, bankai:severity/high
severity: bankai:severity/high (max of bankai:severity/medium, bankai:severity/high)
would run: gh api --method POST repos/zheref/bankai-core/issues/12/sub_issues -F sub_issue_id=100041   (#41 -> id 100041)
would run: gh api --method POST repos/zheref/bankai-core/issues/12/sub_issues -F sub_issue_id=100052   (#52 -> id 100052)
would run: gh issue close 41 --repo zheref/bankai-core --comment "Folded into #12 -- see its own body for the combined evidence."
would run: gh issue close 52 --repo zheref/bankai-core --comment "Folded into #12 -- see its own body for the combined evidence."
```
(shape derived from `src/issue/subissue.ts`'s `consolidateClose`/`planConsolidation` and `src/issue/command.test.ts` -- not run live: reads and the open-PR guard reach GitHub even under `--dry-run`)

### `nen issue chain-position`

Where an OPEN issue sits on the five-place delivery-chain table (a raw brief, an epic awaiting its mode label, an approved epic, a routable child/standalone task, something already building), decided from labels and state alone -- never from the title, because a title is prose and prose is what an LLM caller reads, not this verb. `--chain-labels` supplies which literal label spells each of the eight roles (`idea, researched, approved-team, approved-direct, building, in-review, epic, chore`); a role the caller never mapped is reported "unmapped", never guessed past. Refuses (exit 1) when the answer is `undecidable` -- that is itself a refusal, not a result -- and separately refuses when `--issue` names a pull request, since a delivery-chain position is defined only for issues.

**Usage**

```text
nen issue chain-position --target <owner/name> --issue <n> [--repo <path>]
                         [--chain-labels role=label,...]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository. | Missing exits 1. |
| `--issue <n>` | yes | The issue to classify. | `Number(...)`-read (looser than `comment`'s digit guard); refused (exit 1) if it names a pull request. |
| `--chain-labels role=label,...` | no | Maps each of the 8 roles to its literal label. | An entry with no `=`, an unknown role, or an empty label exits **2**; an unmapped role is reported, never guessed. |
| `--repo <path>` | no | Accepted (it is a global flag) but **not used by this verb at all** -- position never reads a local checkout. | |

**Output and exit codes** -- prints `#<n>: <position>` then each evidence line indented. `--json`: `{ issue, position, evidence, unmappedRoles }`, or `{ issue, refused: true, reason }` on the pull-request refusal. Exit 0 for any decided position (`closed`, `building`, `idea`, `epic-awaiting-approval`, `epic-approved`, `routable`); exit 1 for `undecidable` or the pull-request refusal; exit 2 on a malformed `--chain-labels` entry.

**Example**

```bash
nen issue chain-position --target zheref/bankai-core --issue 41 \
  --chain-labels idea=bankai:stage/idea,building=bankai:stage/building,in-review=bankai:stage/in-review,epic=bankai:epic,researched=bankai:stage/researched,approved-team=,approved-direct=,chore=
```
```text
#41: routable
  carries no idea, epic or release label -- a routable child or standalone task
```
(shape derived from `src/issue/chain.ts`'s `classifyChainPosition` and `src/issue/chain.test.ts` -- not run live, this reaches GitHub)

### `nen issue terminus`

Which object ends an issue's delivery run: its own PR into trunk, each child's own PR (an epic approved direct, with no integration branch), or the single `<prefix>* -> <trunk>` delivery PR off an integration branch (a chore, or an epic approved team-mode) -- the rule that costs runs when missed being "a sub-PR merged onto a chore/integration branch is not the gate and never ends the run". Shares `chain-position`'s role map and pull-request refusal.

**Usage**

```text
nen issue terminus --target <owner/name> --issue <n>
                   [--chain-labels role=label,...]
                   [--integration-prefix <prefix>] [--trunk main]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository. | Missing exits 1. |
| `--issue <n>` | yes | The issue to classify. | Same pull-request refusal as `chain-position`. |
| `--chain-labels role=label,...` | no | Same role map as `chain-position`. | Same parse rules. |
| `--integration-prefix <prefix>` | no | The integration-branch prefix a chore/team-epic delivers on. | Its absence, when the issue DOES deliver on one, is itself `undecidable` rather than guessed. |
| `--trunk main` | no | The base branch the terminus PR targets. | Defaults to `main`. |

**Output and exit codes** -- prints `terminus: <kind>` then indented evidence. `--json`: `{ issue, kind, evidence, expectedHeadPrefix, expectedBase }`, or the same `{ issue, refused: true, reason }` shape as `chain-position` on a PR number. Exit 0 for `run-already-ended`, `integration-delivery-pr`, `each-child-pr`, `own-pr`; exit 1 for `undecidable` or the pull-request refusal; exit 2 on a malformed `--chain-labels` entry.

**Example**

```bash
nen issue terminus --target zheref/bankai-core --issue 12 \
  --chain-labels epic=bankai:epic,chore=,approved-team=bankai:stage/approved-team,approved-direct= \
  --integration-prefix release/ --trunk main
```
```text
terminus: integration-delivery-pr
  carries 'bankai:epic' with the mode label 'bankai:stage/approved-team' -- the terminus is the single 'release/* -> main' delivery PR. A sub-PR merged onto that branch is not the gate.
```
(shape derived from `src/issue/chain.ts`'s `classifyTerminus` and `src/issue/chain.test.ts` -- not run live, this reaches GitHub)

<a id="family-idea"></a>

**`nen idea`**

Files an idea into the backlog as an issue, then treats its own create call with the same suspicion it would treat anyone else's: it READS THE ISSUE BACK over the API and diffs title, body and label set against what was actually submitted. Reuses `issue file`'s own choreography (labels and assignee in the create call, taxonomy-validated) rather than a second implementation. Writes exactly one issue; reads it back exactly once more.

### `nen idea file`

Answers "did GitHub store this idea exactly as sent" -- a `gh issue create` exit code only confirms the REQUEST succeeded, never that the STORED record matches it (a re-rendered body, a label race, a trimmed title would all still exit 0). The read-back also checks WHICH CLASS OF OBJECT answered: since issues and pull requests share one number sequence and one `issues/{n}` endpoint, a read-back landing on a pull request has reached a different object than the one just filed, and comparing fields against it would be either a mismatch about a record nobody filed or a false "read-back OK" -- so that fails loudly (exit 1, the issue named) rather than rendering a verdict it cannot support.

**Usage**

```text
nen idea file --target <owner/name> --repo <path> --title <t>
             --body-file <path> --label a,b --assignee <user>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository to file into. | |
| `--repo <path>` | yes | The checkout whose `nen/labels.json` validates every `--label`. | Listed unbracketed: omitted, exits 2 by name. |
| `--title <t>` | yes | The idea's title. | |
| `--body-file <path>` | yes | Path to the idea body. | Omitted entirely exits 2; the read text is compared byte-for-byte against the read-back. |
| `--label a,b` | yes | Comma-separated labels. | Same taxonomy validation as `issue file`. |
| `--assignee <user>` | yes | A single GitHub login. | |
| `--forbid-family ns:family` | no | Label families this invocation declares off-limits. | Works exactly as [`issue file`](#nen-issue-file)'s does, but is undocumented in `--help` — see the note below. |

> **Note:** `--forbid-family` works but is undocumented. It is declared in
> `src/idea/command.ts`'s own flag spec and forwarded into `fileIdea`'s
> `FileRequest` exactly as [`issue file`](#nen-issue-file)'s is, so it
> refuses a label whose family this invocation declared off-limits — but
> neither `nen idea --help` nor the family's own `USAGE` constant mentions
> it, so nothing outside the source tells a caller it exists. Tracked as
> [zheref/nen#94](https://github.com/zheref/nen/issues/94).

**Output and exit codes** -- prints `filed #<n> <url>`, then either `read-back OK -- title, body and labels match what was submitted.` or, per mismatch, `<field>: expected '<expected>', got '<actual>'`. `--json`: the full `FileIdeaResult` -- `{ filed: { url, number }, readBack: { title, body, labels }, mismatches }`. Content refusals (empty title, no labels, unknown/forbidden label) print as plain `nen:` lines regardless of `--json`, same as `issue file`. Exit 0 when filed and the read-back matches exactly; exit 1 on any mismatch, on a read-back that could not be confirmed at all, or on a read-back that answers as a pull request; exit 2 when `--repo`/`--body-file` was omitted.

**Example**

```bash
nen idea file --target zheref/bankai-core --repo src/schema/fixtures/bankai-repo \
  --title "Consider a --paginate flag on wake verify's three gh api reads" \
  --body-file /tmp/idea-body.md --label bankai:stage/idea --assignee zheref
```
```text
filed #97 https://github.com/zheref/bankai-core/issues/97
read-back OK -- title, body and labels match what was submitted.
```
(shape derived from `src/idea/file.ts`'s `fileIdea`/`FileIdeaResult` and `src/idea/file.test.ts` -- not run live, this reaches GitHub)

## Repository scaffolding & canon

Standing a repository up and keeping its canon honest: the deterministic
scaffold, the handbook set and its generated rule mirror, the three mechanical
questions the pre-release quality gate asks, and Conventional Commits shape.

<a id="family-scaffold"></a>

**`nen scaffold`**

Stands a repository up: the scenario-agnostic taxonomy layer (directory layout, the commit-msg hook, a canon-values template) plus the stack-aware layer (`nen/contract.json`, the `schemas/` → `nen/` migration, the stack's CI workflow, `.gitignore` upkeep) and a closing toolchain **check** that installs nothing. `init` works on an **existing** repository; `new` writes a **fresh** tree into an empty directory.

It still never generates scenario-specific project *code* — a framework's own source tree is that framework's job, and `nen scaffold new` sits **beside** a full project scaffolder rather than replacing one: it ports the toolchain/CI/declaration slice only. And it **never guesses a stack**: `--stack <id>` states one, `--accept-detected` accepts the proposal [`shu detect`](#nen-shu-detect) prints, and with neither `init` refuses at exit 2 naming both.

**Templates are data, not code.** Each stack the [profiles pack](#nen-shu-detect) gives a `scaffoldTemplate` name gets that template's files from `templates/<name>/template.json` at the repository root — versioned with nen, readable end to end by a reviewer, and static-imported so `bun build --compile` embeds it. No module under `src/scaffold/` names a build tool, a package manager or a test runner; a test sweeps for one. Two stacks (`compose-desktop`, `dotnet-winui`) carry `scaffoldTemplate: null` and get no workflow, and two more (`gradle-android`, `xcode-ios`) have a workflow but **no fresh-tree form**, because their stack marker is a downloaded jar or an IDE-authored project document and a fabricated marker is a declaration that lies.

### `nen scaffold init`

Nine steps, each reporting `created` / `appended` / `skipped` / `would-create` / `would-append` / `refused` with the reason. In order: resolve the stack (**before any write**, so a refusal leaves the tree untouched); create every `--directories` entry that does not exist; install the trailer-enforcing commit-msg hook; write the canon-values template when `--canon-values-path` is given and nothing is there; **copy** any of the four taxonomy files still under `schemas/` into `nen/` and print the `git rm` line; write `nen/contract.json`'s `project` block into absence; add the stack's CI workflow; append `.nen/` to `.gitignore`; and run [`nen shu tools`](#nen-shu-tools) in **check** mode, printing what this host is missing and the `--install` command rather than running it.

`--agent-trailer`/`--run-trailer`/`--marker-env` are caller data (which trailer pair and environment variable mark an automated commit is a convention of the target repository, not a literal this binary ships) and are validated as legal git-trailer-key / shell-identifier shapes, since each is interpolated into the generated hook script.

**Usage**

```text
nen scaffold init --repo <path>
                  --agent-trailer <key> --run-trailer <key> --marker-env <VAR>
                  [--directories src,tests,docs]
                  (--stack <id> | --accept-detected)
                  [--hook-path .git/hooks/commit-msg] [--force]
                  [--canon-values-path .claude/canon-values.yml] [--scenario <name>]
                  [--nen-ref vX.Y.Z] [--install-tools] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The repository being scaffolded. | Listed unbracketed: omitted, exits 2 by name -- never defaults to the cwd, which would scaffold whatever directory the process happened to be standing in. |
| `--stack <id>` | one of the two | The stack this repository builds, stated. | Validated by shape first (`[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]`, because it is spliced into a lookup and a file) and membership second; either refusal is exit 2 and lists the known ids. The proposal is `detect`'s, **narrowed** to this stack's lanes; a stack no marker answered still gets one lane at the repository root, with an **empty verb map** — nen writes a command row only for a verb it cross-checked against this tree. |
| `--accept-detected` | one of the two | Accept `shu detect`'s proposal whole. | The caller confirming a printed proposal, not nen deciding. An **ambiguous tree is not an error**: several lanes means `defaultLane: null` and `--lane` required, a withheld row means a seat a maintainer answers, and both are written exactly as [`detect --write`](#nen-shu-detect) writes them, with detect's own notes printed. Passing it *with* `--stack` is exit 2: the two can disagree. |
| `--directories src,tests,docs` | no | Comma list of directories to create if absent. | |
| `--agent-trailer <key>` | yes | The git trailer key marking the acting agent. | Must match `[A-Za-z0-9][A-Za-z0-9-]*`; refused otherwise. |
| `--run-trailer <key>` | yes | The git trailer key marking the run. | Same shape rule. |
| `--marker-env <VAR>` | yes | The environment variable the hook reads to recognise an automated commit. | Must match `[A-Za-z_][A-Za-z0-9_]*`. |
| `--hook-path <path>` | no | Where the commit-msg hook is installed. | Defaults to `.git/hooks/commit-msg`. **Contained**: a value resolving outside `--repo` (`../outside/evil-hook`, or an absolute path elsewhere) is exit 2 naming the flag and where it landed, decided before the first write — the same rule [`shu`](#family-shu) applies to a path a declaration states. The hook is written `0755`, because `git` silently skips a `commit-msg` hook that is not executable. |
| `--force` | no | Overwrite a DIFFERENT existing hook at `--hook-path`. | Without it, a foreign hook there is refused (exit 1), not silently replaced; the existing file is backed up to `<path>.bak` first when `--force` is given. A hook with identical generated content is left alone either way. **It covers the hook only** — there is deliberately no override for a conflicting CI file, declaration or migration. |
| `--canon-values-path <path>` | no | Where to write the canon-values template. | Only written if nothing is already there. Contained the same way `--hook-path` is. |
| `--scenario <name>` | no | Recorded in the canon-values template. | |
| `--nen-ref vX.Y.Z` | no | The nen release the generated workflow pins. | Left off, nen writes the **greater** of this binary's own version and the minimum `templates/index.json` declares — the first release carrying the `nen shu` verbs the workflow runs. A ref below that minimum is exit 2 naming both; so is anything that is not a `vX.Y.Z` tag. When the written ref is not this binary's own version, the report says so, and says nen cannot verify offline that a release exists for it. |
| `--install-tools` | no | Run the closing check as `shu tools --install` instead of a check. | The one flag here whose blast radius is the **developer's machine**. Without it nothing is installed, ever; the report names the command instead. `--install-tools --dry-run` is exit 2. |
| `--dry-run` | no | Print every write, every migration and every refusal; perform none. | It spawns **nothing**, probes included: the toolchain step prints `would check`. That is what makes this form `read-only` in izanami's table rather than a claim about somebody else's declaration. |

**Every write stays inside `--repo`, and the report says where each one landed.** Two flags (`--hook-path`, `--canon-values-path`) are resolved against the repository root and refused at exit 2 when they leave it. The two writes that *create* a directory — `nen/contract.json` and `.github/workflows/nen-shu.yml` — are additionally checked against the **real** path: a symlinked `nen/` or `.github/` would send the write outside the tree while the report kept printing the repo-relative name, so it is `refused` (exit 1) naming the link and where it points. `.git/` is deliberately *not* held to that rule: it is legitimately a symlink or a gitdir file in a worktree.

**A filesystem failure is a row, not a crash.** An unwritable path, a directory in the way, a read-only checkout: the errno becomes a `refused` write, the run continues, and the report is still printed — under `--json` too. A run that threw here used to exit 1 with empty stdout, having already written several files it never reported.

**The `schemas/` → `nen/` migration is a COPY.** Each of the four taxonomy files found only under `schemas/` is copied to `nen/`, the original is **left in place**, and the `git rm` line is printed for the caller to run (and only for a copy that actually happened). A legacy file that is a **symlink** is `refused` naming both paths: `copyFileSync` follows it, so nen would be copying whatever it points at into the repository under a taxonomy file's name and then telling the caller to stage it. A delete is not recoverable if some tool in the estate still reads the old path, and this verb's hook rule already established refuse-and-report over destroy; the `nen/` copy wins immediately because [the loader prefers it](#taxonomy-as-data), so the new behaviour arrives before the removal does, and [`schema check`](#nen-schema-check) reports the leftover as shadowed until it happens. A file present in **both** with identical bytes is `skipped` (only the removal is left); one present in both with **different** bytes is `refused`, naming both paths, with no `--force` — two disagreeing taxonomies is not a merge nen can make.

**`.gitignore` is APPENDED to, byte for byte.** The file's own bytes are written back unchanged and the appended line matches its own line ending, so a CRLF `.gitignore` is not silently rewritten wholesale. The action is `appended` (or `would-append` under `--dry-run`) rather than `created`, because the file was already there and the caller's own lines are still in it.

**Idempotence.** A second run changes nothing and says so per item: the hook, the declaration, the workflow and the `.gitignore` entry all report `skipped` when what is on disk is already exactly what this run would write. That is the one place this verb is more permissive than `shu detect --write`, which refuses on *presence*; anything whose content differs is still refused here.

**Output and exit codes** — the first three lines are v0.2.0's, unchanged: `created directories: <list>` (or `(none -- all already existed)`), `hook: <outcome> (<path>)`, and `canon-values: <path>` if one was written. Under `--dry-run` the first reads `would create directories:` and the second `hook: would-install`, because a preview that said `created` about directories that are not there would be the one line in the report that lies; `--dry-run` is new here, so no v0.2.0 caller reads that spelling. Then `stack: <id>`, one line per migration, one line per write, detect's notes, and the toolchain table. `--json` is a versioned contract, keys in order: `{ contract: "nen.scaffold.init/v0.1", writes: [{ path, action, why }], migrated: [{ from, to, action, why }], tools, exitCode }`, where `action` is `created`/`appended`/`skipped`/`would-create`/`would-append`/`refused`, `path` is repo-relative, and `tools` is [`shu tools`](#nen-shu-tools)'s own `nen.shu.tools/v0.1` document or `null`. **A `refused` row is always published**, in `writes[]` alongside the rest — a report that listed only what succeeded would be a report that says "done".

Under `--json`, stdout is exactly one document and the prose the shape has no field for — `detect`'s open questions, the toolchain table and its advice — is relayed to **stderr** rather than dropped, the way the [`shu`](#family-shu) verbs relay a child's output.

Exit **2** for a usage refusal decided before any write (no stack, both stack flags, an unknown stack, a malformed trailer or marker, a missing `--repo`, a `--hook-path`/`--canon-values-path` outside the repository, a `--nen-ref` that is not a tag or is below the minimum, `--dry-run --install-tools`); exit **1** when a write was `refused` (a foreign hook, an existing declaration, a differing CI file, a conflicting migration, a symlinked legacy source, a symlinked target directory, an errno from the filesystem) — matching v0.2.0's hook behaviour; exit **0** otherwise. **`--dry-run` is a read-only form that can still return 1**: a preview over a tree that already carries a conflicting hook, declaration or workflow reports those refusals and exits 1, because "this run would refuse" is the answer the preview exists to give. It is still read-only — nothing is written and nothing is spawned. **The closing check never moves the exit code**: scaffolding succeeded, and whether this host can build the thing is a separate question with its own verb and its own code. A `scaffold init` that failed because an IDE is absent would be permanently red on every machine that is not already set up, CI runners that legitimately never build that stack included — run [`nen shu tools`](#nen-shu-tools) and read *its* exit code for the host verdict.

**Example**

```bash
nen scaffold init --repo /tmp/site --accept-detected --directories src,docs \
  --agent-trailer Agent-Name --run-trailer Run-Id --marker-env NEN_AUTOMATED
```
```text
created directories: /tmp/site/src, /tmp/site/docs, /tmp/site/.git/hooks
hook: installed (/tmp/site/.git/hooks/commit-msg)
stack: gatsby
created: .git/hooks/commit-msg -- installed
created: nen/contract.json -- the project block, written into absence
created: .github/workflows/nen-shu.yml -- the 'full' template's workflow for gatsby
created: .gitignore -- created, ignoring '.nen/'
a lane's NAME is proposed from the directory it lives in (or from the stack id at the repository root) and is yours to change -- it is the token '--lane' takes, and nothing in nen reads meaning into it.
lane:          gatsby  (gatsby)
mode:          check
tools:         (none declared)
```
(run for real against a scratch copy of this repository's own `gatsby-site` marker fixture; the absolute paths are elided to `/tmp/site`)

### `nen scaffold new`

A **fresh** tree: the stack template's files with `{{name}}` substituted, the CI workflow, `.gitignore`, the commit-msg hook when a trailer convention is stated, and `nen/contract.json` — **proposed by `shu detect` off the marker this verb just wrote**, so "scaffolded a project" and "declared a stack" stop being two chores with two chances to disagree.

**Every post-step is PRINTED and none is run.** No repository is initialised, no dependency is installed, no native project is generated, and no network call is made — including the toolchain check, which `init` runs and this verb only names. Writing into a fresh directory and writing to the host are two different consents.

**Usage**

```text
nen scaffold new --stack <id> --name <project> --dir <path>
                 [--agent-trailer <key> --run-trailer <key> --marker-env <VAR>]
                 [--nen-ref vX.Y.Z] [--dry-run] [--json]
```

**It takes no `init` flag, and says so.** The two verbs share one flag spec, so the argv reader accepts `--hook-path`, `--force`, `--install-tools`, `--accept-detected`, `--canon-values-path`, `--scenario` and `--directories` on a `new` invocation — each is now **refused at exit 2 naming it**, rather than accepted and ignored. `--repo` is refused here too: this verb writes into `--dir`, and a caller who passed both has named two directories.

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--stack <id>` | yes | The stack to write. Never inferred — there is no tree to infer from. | Exit 2 for an unknown id, for a stack the catalogue proposes no template for (`compose-desktop`, `dotnet-winui`), and for one with no fresh-tree form (`gradle-android`, `xcode-ios`) — each naming the `scaffold init` invocation to run after creating the project with its own generator. |
| `--name <project>` | yes | Written into this tree's own manifest. | Must match `[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]`: it is spliced into JSON bodies, and a name that has to be escaped first was never one. |
| `--dir <path>` | yes | The directory to write into. | Must not exist, or must be empty. **No merge and no `--force`** — a directory with something in it is one somebody is using, and the failure a merge produces is a half-scaffolded tree whose declaration describes files that were skipped. Exit 2. A **one-slash relative** value (`parity/nextjs`) reads as an `owner/name` slug and is exit 2 naming the `./parity/nextjs` spelling — the same ambiguity [`--repo`](#--repo-path-is-a-path) refuses rather than guesses. Every other relative value is `./`-prefixed in the printed post-steps, seven of which pass it to `--repo`. |
| `--agent-trailer` / `--run-trailer` / `--marker-env` | no | The trailer convention the commit-msg hook enforces. | All three or none. Omitted, the hook is `skipped` and the post-steps name the `scaffold init` line that installs it — nen ships no trailer convention and will not invent one for every project this verb ever writes. The hook is written `0755`, as `init` writes it. |
| `--nen-ref vX.Y.Z` | no | The nen release the generated workflow pins. | Same rule and same refusals as [`init`](#nen-scaffold-init)'s. A fresh tree has no declaration to read a pin out of, so the answer is the greater of this binary's version and the declared minimum. |
| `--dry-run` | no | Print the tree it would write, and write nothing. | The declaration is *described* rather than shown: there is no tree yet to read a marker out of, and deriving the block by a second route is how two routes to one document drift. |

**Output and exit codes** — one line per write, then the numbered post-steps. `--json` publishes the same key order as `init` under its own contract string: `{ contract: "nen.scaffold.new/v0.1", writes, migrated: [], tools: null, exitCode }` — `tools` is always `null`, because this verb names the toolchain check and never runs it, and `migrated` is always empty, so both documents read alike. The post-steps have no field in that shape and are relayed to **stderr** under `--json` rather than dropped. Exit **2** for every usage refusal above, all of them decided before the first write; exit **1** when a write was `refused` — the filesystem rejecting one of the tree's files, or the written tree carrying no marker `shu detect` recognises (a defect in the template, reported rather than hidden); exit **0** otherwise. A malformed bundled template is exit 1 too, naming the document and field: nothing the caller typed can produce it, so `--help` would be advice about the wrong file.

**Example**

```bash
nen scaffold new --stack nextjs --name kro-site --dir ./kro-site --dry-run
```
```text
stack: nextjs   name: kro-site   dir: ./kro-site
would-create: .gitignore -- the 'full' template
would-create: next.config.ts -- the 'full' template
would-create: package.json -- the 'full' template
would-create: .github/workflows/nen-shu.yml -- the 'full' template's workflow for nextjs
skipped: .git/hooks/commit-msg -- no trailer convention was stated (--agent-trailer, --run-trailer, --marker-env), and nen ships none. The post-steps name the invocation that installs it.
would-create: nen/contract.json -- proposed by 'nen shu detect' off the marker written above -- the same block 'nen shu detect --write' writes, seats and all
a dry run writes nothing, so the declaration is described rather than shown: it is exactly what 'nen shu detect --repo ./kro-site' prints once the tree exists.
post-steps (nen does NOT run these):
  1. cd ./kro-site && git init && git add -A && git commit -m "chore: scaffold"
  2. name the package manager in package.json's "packageManager" field. nen never picks one, so until it is there every declared row that needs it stays a withheld seat
  3. add the framework and its dependencies to package.json, then install them
  4. nen scaffold init --repo ./kro-site --stack nextjs --agent-trailer <key> --run-trailer <key> --marker-env <VAR>
  5. nen shu detect --repo ./kro-site            # re-propose the rows it withheld, once the manifest answers
  6. nen shu tools --repo ./kro-site            # checks the host; --install acts
  7. nen shu build --repo ./kro-site --dry-run  # confirm the declaration
```
(run for real)

**What the generated workflow does.** `.github/workflows/nen-shu.yml` declares `permissions: contents: read`, fetches nen's bootstrap at a pinned ref, runs `nen shu tools --repo .`, then `build`, `test` and `lint` — **`--dry-run` first, then for real** — treating exit 4 (this lane declares no such verb) as a fact rather than a failure.

**Which ref it pins, and why it needs a published release.** The ref is `--nen-ref` when given; otherwise the repository's own `dependency.pinnedRef` (for `init`) or this binary's own version, and then **the greater of that and the minimum `templates/index.json` declares** — which is the first release carrying the `nen shu` verbs the workflow runs. That floor exists because the failure without it is silent at scaffold time and total at CI time: a workflow pinned at a release with no `shu` family is red on the first push, and one pinned at a tag with no *release* never gets a binary at all — `bash nen-bootstrap.sh --ref <tag>` refuses at **exit 6**, because [a tag is not a release](#getting-the-binary) and there is no `SHA256SUMS` to verify against. nen cannot check either fact offline, so whenever the written ref is not this binary's own version it prints the ref, that caveat, and the releases page. It names no build tool, no package manager and no test runner: every argv it runs comes from the scaffolded repository's own `nen/contract.json`, so changing what CI runs means changing the declaration.

<a id="family-canon"></a>

**`nen canon`**

Resolves which handbooks a target repository loads, and keeps a canonical-rule mirror in sync with a `canon-values.yml`. It never decides handbook CONTENT -- it only resolves the always-load set plus one stack handbook from a recorded scenario (`nen/repos.json`), and substitutes/diffs a rule mirror the way `scripts/sync_canon.py` did.

### `nen canon resolve`

Answers "which handbooks does this repository load" as always-load-paths + exactly one stack handbook, the stack path derived directly from the target's recorded scenario (never looked up in a table). `--always-load` is the target repository's own manifest, handed in by the caller; `--repo`, `--target`, `--stack-dir` and `--always-load` are all required and refused by name if omitted or empty, never defaulted to something that would misreport a forgotten flag as a missing registry.

**Usage**

```text
nen canon resolve --repo <path> --target <owner/name>
                  --always-load <path,path,...> --stack-dir <dir>
                  [--leaf architecture.md]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The checkout whose `nen/repos.json` maps `--target` to a scenario. | Listed unbracketed: omitted, exits 2 by name. |
| `--target <owner/name>` | yes | The consumer repository being resolved. | Refused (exit 1) if unrecorded, or recorded but not a consumer (`nen/repos.json`'s `consumers[]`). |
| `--always-load <path,path,...>` | yes | The repository's own unconditional-load manifest. | An empty list is refused -- there is no meaningful "loads nothing" empty form. |
| `--stack-dir <dir>` | yes | Directory the one stack handbook is resolved under. | |
| `--leaf <file>` | no | The stack handbook's filename. | Defaults to `architecture.md`. |

**Output and exit codes** -- prints `scenario: <name>`, `always load: <a, b, ...>`, `stack handbook: <stack-dir>/<scenario>/<leaf>`. `--json`: `{ scenario, alwaysLoad, stackHandbook }`. Every refusal (unrecorded target, empty always-load, a path-shaped scenario) prints as a plain `nen:` line even under `--json`. Exit 0 on a resolved scenario; exit 1 on an unrecorded/non-consumer target or an invalid scenario shape.

**Example**

```bash
nen canon resolve --repo src/schema/fixtures/bankai-repo --target zheref/KroApple \
  --always-load handbooks/uzf-core.md,handbooks/security-baseline.md --stack-dir handbooks/stacks
```
```text
scenario: swiftui-tca-uzf-v2
always load: handbooks/uzf-core.md, handbooks/security-baseline.md
stack handbook: handbooks/stacks/swiftui-tca-uzf-v2/architecture.md
```
(run for real against the bundled fixture repo)

### `nen canon mirror generate`

Ported from `scripts/sync_canon.py`: substitutes every `{{TOKEN}}` in each canonical rule file (every `.md` in `--rules-dir` except `--not-mirrored`) using the parsed `--canon-values`, prepends a generated-file header, and writes only the files whose content actually changed -- deleting an orphaned mirror file whose canon source is gone. `--header-template` is caller data (the header text/convention belongs to the target repository, never a literal shipped here).

**Usage**

```text
nen canon mirror generate --rules-dir <dir> --canon-values <path>
                          --out-dir <dir> --ref <ref>
                          --header-template <template> --not-mirrored <a,b>
                          [--scenario <name>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--rules-dir <dir>` | yes | Directory of canonical `.md` rule files. | |
| `--canon-values <path>` | yes | The values file substituted into every `{{TOKEN}}`. | Must carry a `scenario:` field, unless `--scenario` is given. |
| `--out-dir <dir>` | yes | Where the mirror is written. | |
| `--ref <ref>` | yes | Recorded in the generated header. | |
| `--header-template <template>` | yes | `{ref}`/`{scenario}`/`{file}` placeholders. | Caller's own convention. |
| `--not-mirrored a,b` | yes (may be empty) | Rule files excluded from mirroring. | |
| `--scenario <name>` | no | Overrides the scenario read from `--canon-values`. | Its absence with no `scenario:` field in the values file is a refusal (exit 2). |
| `--repo <path>` | no | Not used -- this verb operates purely on the paths given. | |

**Output and exit codes** -- prints `written: <list>`, `unchanged: <list>`, `deleted (orphaned): <list>` (each `(none)` when empty). `--json`: `{ written, unchanged, deleted }`. Exit 0 always on a completed run (there is no "drift" concept here, only "wrote/didn't write"); exit **1** on an unreadable `--canon-values` (`src/canon/command.ts:193-197` prints `nen: could not read --canon-values '<path>': <errno>` and returns 1, not the exit-2 named refusal a mistyped path deserves — tracked as [zheref/nen#101](https://github.com/zheref/nen/issues/101)); exit 2 on a missing `--scenario` with no `scenario:` field in the values file, on a missing required flag, or on a rules-dir generation error.

**Example**

```bash
nen canon mirror generate --rules-dir handbooks/rules --canon-values .claude/canon-values.yml \
  --out-dir .claude/mirror --ref v0.2.0 \
  --header-template "<!-- GENERATED from {file} at {ref} for {scenario}; do not edit -->" \
  --not-mirrored README.md
```
```text
written: CON-32.md
unchanged: CON-38.md, CON-22.md
deleted (orphaned): CON-99.md
```
(shape derived from `src/canon/mirror.ts`'s `generateMirror`/`writeMirror` and `src/canon/mirror.test.ts`)

### `nen canon mirror check`

Regenerates the mirror from the SAME inputs `generate` uses and diffs it against `--mirror-dir` WITHOUT writing anything -- the CI-safe half of the pair. `--header-pattern` reads the ref back out of the COMMITTED mirror file's own first line (a JS regex with named groups `(?<ref>...)`, `(?<scenario>...)`, `(?<file>...)`), which is what tells `stale` (ref moved) from `hand-edited` (content changed but header claims the same ref) apart.

**Usage**

```text
nen canon mirror check --rules-dir <dir> --canon-values <path>
                       --mirror-dir <dir> --ref <ref>
                       --header-template <template> --header-pattern <regex>
                       --not-mirrored <a,b>
                       [--scenario <name>] [--markdown-out <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--rules-dir <dir>` | yes | Same as `generate`. | |
| `--canon-values <path>` | yes | Same as `generate`. | |
| `--mirror-dir <dir>` | yes | The COMMITTED mirror being checked. | Never written to. |
| `--ref <ref>` | yes | The ref this run expects. | Compared against what `--header-pattern` reads out of each mirror file. |
| `--header-template <template>` | yes | Regenerates the in-memory comparison copy. | |
| `--header-pattern <regex>` | yes | Reads `ref`/`scenario`/`file` back out of the mirror file's FIRST LINE only. | No need to anchor with `^` -- only the first line is ever matched. |
| `--not-mirrored a,b` | yes (may be empty) | Same as `generate`. | |
| `--scenario <name>` | no | Same override as `generate`. | |
| `--markdown-out <path>` | no | Also write the report as a markdown table. | Written regardless of `--json`. |

**Output and exit codes** -- prints `ok: <n>`, `missing: <list>`, `extra: <list>`, `stale: <list>`, `hand-edited: <list>`. `--json`: the full report, same four buckets plus `ok`. Exit 0 when missing/extra/stale/hand-edited are all empty; exit 1 on any drift, and also on an unreadable `--canon-values` — the same shared reader `generate` uses (`src/canon/command.ts:193-197`) returns 1 rather than the exit-2 named refusal a mistyped path deserves, which means an unreadable values file and real drift are indistinguishable by exit code alone; read the stderr line, or `--json`'s absence, to tell them apart. Tracked as [zheref/nen#101](https://github.com/zheref/nen/issues/101). Exit 2 on a missing `--scenario` with no `scenario:` field in the values file, on a missing required flag, or on a regeneration error.

**Example**

```bash
nen canon mirror check --rules-dir handbooks/rules --canon-values .claude/canon-values.yml \
  --mirror-dir .claude/mirror --ref v0.2.0 \
  --header-template "<!-- GENERATED from {file} at {ref} for {scenario}; do not edit -->" \
  --header-pattern "GENERATED from (?<file>\S+) at (?<ref>\S+) for (?<scenario>\S+)" \
  --not-mirrored README.md
```
```text
ok: 1
missing: (none)
extra: (none)
stale: CON-38.md
hand-edited: (none)
```
(shape derived from `src/canon/mirror.ts`'s `checkMirror` and `src/canon/mirror.test.ts`)

<a id="family-quality"></a>

**`nen quality`**

Answers three narrow, mechanical questions the pre-release gate needs and never itself measures anything or judges whether a number is good: which tooling a scenario uses, whether a measured value regressed past QA-13's fixed thresholds, and whether a reported measurement's method block is complete enough to trust. It reads only caller-supplied JSON (a tooling table, a method block) -- never a schema file, and never `git`/`gh`.

### `nen quality tooling`

Looks up the e2e/adversarial/perf tooling recorded for `--scenario` in the caller-supplied `--table` -- the target repository's own manifest, never a table shipped inside this binary.

**Usage**

```text
nen quality tooling --table <path.json> --scenario <name>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--table <path.json>` | yes | The scenario -> tooling manifest, as a JSON object. | Caller's own file; an array or scalar at the top level is refused. |
| `--scenario <name>` | yes | Which entry to resolve. | |

**Output and exit codes** -- prints `scenario: <name>` then `e2e`, `adversarial`, `not used`, `perf harness`, `perf diagnosis`, each `(none)` when absent. `--json`: `{ ok, scenario, tooling: { e2e, adversarial, notUsed, perfHarness, perfDiagnosis } }` or `{ ok: false, reason }`. Exit 0 when the scenario has an entry; exit 1 when it does not, or the table file could not be read; exit 2 when either `--table` or `--scenario` is missing (`quality tooling takes --table <path.json> and --scenario <name>.`).

**Example**

```bash
nen quality tooling --table .claude/quality-tooling.json --scenario swiftui-tca-uzf-v2
```
```text
scenario: swiftui-tca-uzf-v2
  e2e: XCUITest
  adversarial: swift-testing
  not used: Appium, Selenium
  perf harness: xcodebuild test -only-testing PerfSuite
  perf diagnosis: Instruments Time Profiler
```
(run for real, against a table file authored for this example)

### `nen quality perf-compare`

Classifies one measured-vs-baseline pair at QA-13's fixed thresholds: a regression over 10% (relative to `--baseline`) is `high`, over 25% is `critical`; lower is always better, so an improvement is never flagged. The metric name is not restricted to a fixed list in code -- QA-11 names seven canonical ones (cold launch, warm launch, frame hitches, memory high-water, artifact size, network payload/requests, longest main-thread block), but this verb compares whatever `--metric` names against whatever `--baseline` it is given.

**Usage**

```text
nen quality perf-compare --metric <name> --baseline <n> --measured <n>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--metric <name>` | yes | The metric's name, echoed back verbatim. | Not validated against a fixed vocabulary. |
| `--baseline <n>` | yes | The recorded baseline value. | A zero baseline is refused outright (exit 1) -- a percentage regression against zero is not a defined number. |
| `--measured <n>` | yes | The newly measured value. | |

**Output and exit codes** -- prints `<metric>: <pct>% vs baseline -- <severity>`. `--json`: `{ metric, baseline, measured, regressionPct, severity }`. Exit 0 when severity is `ok`; exit 1 when `high` or `critical` (or on a zero baseline).

**Example**

```bash
nen quality perf-compare --metric cold_launch_ms --baseline 1200 --measured 1400
```
```text
cold_launch_ms: 16.7% vs baseline -- high
```
(run for real)

### `nen quality method-check`

Validates a QA-15 method block states everything a number needs to be trusted: device and OS, a Release configuration with no debugger attached, a sample size of at least 5 with the first discarded (warm-up/cold-cache skew), median AND p90 reported, and both thermal state and network condition stated. It never judges whether the NUMBER itself is good -- only whether the claim behind it is complete ("prove or drop", QA-1).

**Usage**

```text
nen quality method-check --input <path.json>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--input <path.json>` | yes | The method block, as JSON: `device`, `os`, `releaseConfig` (bool), `debuggerAttached` (bool), `sampleSize`, `firstDiscarded` (bool), `median`, `p90`, `thermalState`, `networkCondition`. | |

**Output and exit codes** -- prints `OK -- method block is complete.` or one `gap: <reason>` line per missing item. `--json`: `{ ok, refusals }`. Exit 0 when complete; exit 1 on any gap, or an unreadable/malformed `--input`; exit 2 when `--input` is missing entirely (`quality method-check takes --input <path.json>.`).

**Example**

```bash
nen quality method-check --input /tmp/method.json
```
```text
OK -- method block is complete.
```
(run for real, against a method block authored for this example: `{"device":"iPhone 15 Pro","os":"iOS 17.5","releaseConfig":true,"debuggerAttached":false,"sampleSize":6,"firstDiscarded":true,"median":812,"p90":940,"thermalState":"nominal","networkCondition":"wifi"}`)

<a id="family-commit"></a>

**`nen commit`**

Validates the SHAPE of a Conventional Commits message -- a declared type, a non-empty subject under 72 characters, no trailing sentence punctuation -- and never its content; what changed and why stays the author's to write. Reads and writes nothing on disk or over the network.

### `nen commit format`

Builds and validates one Conventional Commits header (`type(scope)!: subject`) plus optional body paragraph and trailers, from the type set `feat, fix, chore, docs, refactor, test, perf, build, ci`. `--trailer` keys are caller data (a specific persona's trailer convention lives in the calling skill, never a literal in this binary).

**Usage**

```text
nen commit format --type feat --subject "a short imperative subject"
                  [--scope <scope>] [--breaking] [--body "paragraph one"]
                  [--trailer key=value,key2=value2]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--type <type>` | yes | One of `feat, fix, chore, docs, refactor, test, perf, build, ci`. | |
| `--subject <text>` | yes | The header's imperative subject. | Non-empty, the FULL header line (`type(scope)!: subject`) must be <= 72 characters, and must not end in `.!?`. |
| `--scope <scope>` | no | The parenthesised scope. | Given but empty is refused -- omit the flag entirely instead. |
| `--breaking` | no | Adds the `!` marker after type/scope. | |
| `--body "paragraph"` | no | ONE paragraph. | This parser does not support repeating `--body`; pass one paragraph and use blank lines inside it for multiple, if the shell allows a multi-line value. |
| `--trailer key=value,key2=value2` | no | Comma-separated `key=value` pairs. | A key containing `:` or empty is refused. |

**Output and exit codes** -- prints the formatted message. `--json`: `{ message }`. All shape violations print as plain `nen:` lines even under `--json`. Exit 0 on a valid shape; exit 2 on any shape violation (never 1 -- there is no partial-success or network-failure mode here).

**Example**

```bash
nen commit format --type feat --scope issue --subject "add a general comment verb" --trailer "Closes=#29"
```
```text
feat(issue): add a general comment verb

Closes: #29
```
(run for real)

## Stack-aware developer verbs

Build, test, lint, run and ship a *project* — as opposed to every other family
here, which works on the backlog, the readiness verdict and the release
mechanics around one. Every verb in this family runs what the **target
repository declares** in its own `nen/contract.json`, under a `project` block:
its lanes, its per-verb argv, its preconditions, its platforms. Nen carries no
build system, no package manager and no test runner, and knows the name of
none — every module on the execution path contains zero toolchain names, and a
test in `src/shu/purity.test.ts` fails the build if that ever stops being true.
It sweeps the directory rather than a list of filenames, so a module added later
cannot quietly land outside the rule. Two files are excluded, each by argument
and each with assertions of its own in exchange: `detect.ts`, which reads
*filenames* (a universal fact, unlike an argv, which is a repository's own
vocabulary), and `install.ts`, the one module that turns an installer **id** —
from the contract's own closed set — into a command, because
[`shu tools --install`](#nen-shu-tools) is the one verb with no declaration to
take a program name from. That file is held to naming only ids from that set,
and to importing no subprocess seam at all.

`detect` is the one verb that reads the filesystem rather than the declaration,
and it **proposes**: it writes nothing without `--write`, and never overwrites
a declaration at all.

<a id="family-shu"></a>

**`nen shu`**

Stack-aware developer verbs. Every one of them runs what the TARGET REPOSITORY declares in nen/contract.json under "project" -- its lanes, its per-verb argv, its preconditions, its platforms. Nen carries no build system, no package manager and no test runner, and knows the name of none: a verb this repository has is a verb this repository states.

**The declaration** — `<repo>/nen/contract.json`, `project` block. Absent, or
present with no `project` block, is exit 2 naming the file; `nen shu detect`
proposes one.

| Field | Meaning |
|---|---|
| `project.lanes` | `{ "<lane>": { "stack": "<id>", "cwd": "<repo-relative>" } }`. A stack is a **per-lane** property: one repository is routinely several builds. |
| `project.defaultLane` | Which lane `--lane` defaults to. `null` is legal and means `--lane` is required — even when there is exactly one lane, so a second lane arriving later cannot silently change what a scripted `nen shu build` builds. |
| `project.verbs` | `{ "<lane>": { "<verb>": <invocation> } }`, where an invocation is `{ exe, argv }`, `{ steps: [...] }`, or `{ unsupported: "<why>" }`. `argv` is a **list**, never a string: there is no shell, no expansion, no `sh -c`. An invocation may also carry `env` (NAME → value, passed to the child; only the names are ever reported) and `artifacts` (repo-relative paths the verb produces, which nen reports and never creates). |
| `project.preconditions` | `{ "<lane>": [ { kind, value, why } ] }`. Nen **asserts** these and **never performs** them. |
| `project.hosts` | `{ "<verb>\|*": ["darwin","linux","win32"] }`, compared against this host. An exact verb key wins over `*`, and a declaration with no `hosts` block constrains no verb — a repository that said nothing about platforms has not said `darwin`. |
| `project.targets` | `{ "<name>": { args, requiresEnv, unsupported, why } }` — the deploy destinations. `--target` must name a key of it, and there is no default — not even when there is exactly one. The **command** stays in `project.verbs.<lane>.deploy`, where every other verb's command is; a target says where that command sends it. `args` are appended to that argv, in order (refused on a multi-step row: which step reaches the destination is a guess). `requiresEnv` names variables that must be **set**, asserted exactly as a precondition of kind `env` is — the value is never read, compared, logged or printed, so a credential belongs in the environment and never in this file. `unsupported` is the destination that has **no command line at all** (a hosting provider's git integration, a CI action): exit 4 in the repository's own words. All four keys are optional; `{}` is a legal name-only target, and naming it is still mandatory. See [`nen shu deploy`](#nen-shu-deploy). |

**Preconditions are asserted, never performed.** A declaration saying
`{ "kind": "path", "value": "node_modules" }` is telling nen that a dependency
install has already happened. Nen checks it and refuses when it has not; it does
not run the install, because a dependency install executes the project's own
postinstall scripts. This release asserts two kinds:

| `kind` | `value` | Satisfied when |
|---|---|---|
| `path` | one repo-root-relative path | the entry exists (a dangling symlink, or a path nen cannot `lstat` at all, counts as present-and-broken, not absent) |
| `env` | one variable **name** | the variable is set. Its value is never read, compared or printed |

A kind nen cannot assert is reported as `satisfied: null` — *"cannot assert"* —
and **refuses at exit 2**. It is never reported as a pass: a check that could
not be performed must never render as one that came back clean. That covers a
kind this release does not know **and** a kind it does know stated as a *list*
of values: `{"kind": "path", "value": ["a", "b"]}` is not a path, and reading
the first element would be nen guessing which one the declaration meant.

**Every path a declaration states is relative to the repository root**, and one
that resolves outside it — a lane `cwd` of `../..`, a precondition path of
`../../etc/passwd`, an artifact outside the tree — is exit 2 naming the path.
Nen will not step outside the tree `--repo` pointed it at.

**Exit codes** — this family extends the CLI's published `0`/`1`/`2` with three
more. See also the [Exit codes](#exit-codes) convention.

| Code | Meaning |
|---|---|
| `0` | the tool ran and succeeded, or a dry run rendered |
| `1` | the tool ran and failed. Nen exits 1 whatever the tool's own code was; the tool's code is in `steps[].exitCode`. A `nen/contract.json` that is **present and malformed** is also 1 — the file is there and says something nen cannot read, which is a repository defect rather than a mistyped invocation, and it is the code every family in this CLI answers an unreadable schema file with. The refusal names the file, the pointer and the expectation |
| `2` | usage: **no** declaration, no `project` block, an unknown `--lane`, a placeholder nen cannot substitute, a **missing** `--target` or one that names no declared target, `--json` on a long-running verb without `--dry-run`, a path that resolves outside the repository, or a precondition that is not satisfied |
| `3` | **unsupported host** — the verb is real, this machine cannot run it. Never 1 (a retry wrapper would retry forever) and never 2 (the invocation was correct) |
| `4` | **unsupported verb for this lane** — the declaration says so, in its own words. The invocation was correct; the answer is a fact about the repository. Across the seven stacks this family is designed for, it is the majority case. [`shu warmup`](#nen-shu-warmup) passes it through from the build (or test) it delegates, unchanged |
| `5` | the declared program could not be started at all — not installed, or not on `PATH`. On [`shu tools`](#nen-shu-tools) it is also the CHECK verdict for a host where anything is missing or is not the pinned version |

**`--json`**, on every verb that executes one, is one object with these keys, in
this order: `{ contract, lane, stack, verb, target, steps, cwd, env, host,
preconditions, exitCode, durationMs, artifacts, log }`. `contract` is
`nen.shu.<verb>/v0.1`. `env` is variable **names** only, never values.
`target` is `null` on every verb but [`deploy`](#nen-shu-deploy), where it is
`{ name, args, requiresEnv }` — the destination that was resolved, what it
appended to the argv, and the variable names it requires. Never a value of one.
`steps[].exitCode` is the **tool's** own code and is `null` when nothing was
run — which is how a `--json` reader tells a dry run from a real one; `exitCode`
is nen's. Under `--json` a step's own output is relayed to **stderr**, so stdout
stays exactly one document.

[`shu coverage`](#nen-shu-coverage) is the one executing verb whose `--json`
document is **not** that shape: it runs through the same executor and then
parses the report the run produced, so its stdout carries
`nen.shu.coverage/v0.1` — `{ contract, lane, stack, total, targets, threshold,
report, exitCode }` — and the executor's own report is rendered to **stderr**
instead, where every argv, duration and precondition row still is. Nothing is
lost and stdout is still exactly one object.

`--json` is **refused at exit 2** on [`shu dev`](#nen-shu-dev) and
[`shu run`](#nen-shu-run) unless `--dry-run` is also given. Those two hand this
terminal to the child, so stdout belongs to the child from the handover
onwards, and one JSON object followed by however much a dev server then writes
is not a document. `--dry-run --json` is their machine-readable pre-flight; the
refusal is checked before the declaration is read, because it is a fact about
the command line rather than about the repository.

**Placeholders.** A `{token}` in a declared argv is refused **only** when it is
one of the reference pack's own — `{pm}`, `{scheme}`, `{destination}` and the
rest of the closed set [`docs/STACK-MATRIX.md`](STACK-MATRIX.md) publishes and
explains. Every other braced argument is passed to the child exactly as
written, so a declaration may state `--define={"a":1}` without nen having an
opinion about it. The refusal lists the set, which is the whole answer to
"then what may I write".

**Argv quoting.** Every printed argv quotes an element containing whitespace.
Those quotes are information: `-destination 'platform=iOS Simulator,name=iPhone
17 Pro,OS=26.5'` is **one** argv element, and a reader who re-splits the line on
spaces gets a different command.

The quotes are a **rendering**, and only the text one. The same element reaches
`--json` and the seam as the bytes the declaration states — no quotes added, no
comma or space treated as a separator anywhere between the file and the child
process — which is what makes a `--json` report safe to read back on a host
whose shell would have split it. All three renderings of that one element are
pinned together in `src/shu/run.test.ts`, on one hand-written row, because two of
them agreeing proves nothing about the third.

### `nen shu detect`

Read the markers on disk and propose a `project` block. It never resolves an ambiguity, never proposes a command the repository cannot run, and never overwrites a declaration.

**Usage**

```text
nen shu detect [--repo <path>] [--write] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | no | Which tree to scan. | Defaults to the current directory. The scan is bounded twice — three directories deep for a lane, and two more below each lane for the module that carries a stack's plugin — and it skips `.git`, `node_modules`, build output and the like. |
| `--write` | no | Write `nen/contract.json`. | Only into the **absence** of one. There is no `--force` and no merge: a declaration is a decision and a proposal is an inference, so an existing file — even a `dependency`-only one — is exit 2 with the block printed for you to merge. |

**Markers**, one per stack. A filename is a universal fact, which is why this is
the one piece of filesystem knowledge the family is allowed to have:

| Marker | Proposed stack |
|---|---|
| `next.config.{js,mjs,cjs,ts,mts,cts}` | `nextjs` |
| `gatsby-config.{js,mjs,cjs,ts}` | `gatsby` |
| `app.json` carrying an `expo` key, or `app.config.{js,mjs,cjs,ts}` beside an `expo` dependency | `expo` |
| `*.xcworkspace` (preferred) or `*.xcodeproj` | `xcode-ios` |
| a Gradle wrapper **and** the lane's own `settings.gradle{,.kts}`, plus a **module's** build file applying `com.android.application` | `gradle-android` |
| a Gradle wrapper **and** the lane's own `settings.gradle{,.kts}`, plus a build file carrying a `compose.desktop` block | `compose-desktop` |
| `*.csproj` containing `<UseWinUI>true</UseWinUI>`, plus any `*.sln` or `*.slnx` beside it as a second marker | `dotnet-winui` |

The last row is the one read out of the reference pack rather than out of
`detect`'s own table, and the two halves are not equal: the `*.csproj` carrying
the property **qualifies** the stack, and the `*.sln` only **corroborates** it.
A directory with a solution and nothing else is not a lane — a `*.csproj` alone
is .NET, which is not this stack, and a `*.sln` alone says less still. Both
matched files are recorded on **one** lane, in byte order.

Two files the reference pack calls markers identify **no** lane on their own,
and `detect` records each as `evidence` beside the marker that did: a `Podfile`
beside an Xcode container — the pack's own reason is that it *"adds a `pod
install` PRECONDITION; on its own it does not identify the stack"*, and a tree
that has one is a tree where this profile's precondition notes are live rather
than quoted from somebody else's repository — and an `eas.json` beside an Expo
manifest, where a build service's configuration says nothing about which
manifest, lane or platform anything runs on, and a lane proposed from it alone
would be nen deciding what kind of project this is from an ancillary file. Both
are recorded under their own word — `evidence:` in the terminal, `evidence` in
`--json`, kept apart from `markers` because "delete it and the lane goes away"
is true of every marker and false of these — each with a note quoting the pack's
own sentence for it, because a seat whose quoted reason turns on a file's
absence is the first row to distrust in a tree that has it.

**What it will not do.** Two lanes in one tree get two lanes and
`defaultLane: null` plus a note — choosing would be how a scripted `nen shu
build` silently starts building something else. Two stacks' markers in **one**
directory get both lanes, both names qualified by their stack
(`web-gatsby`, `web-nextjs`), and neither is chosen. Two spellings of one
framework's config in one directory are **one** lane with two markers. A
subdirectory shipping its **own** build wrapper — or its **own** settings file —
is its own build and never a marker for the lane above it: a repository whose
root is `gradle-android` and whose `program/` is `compose-desktop` gets exactly
two lanes, not three, and one whose `program/` has a settings file and no
wrapper of its own gets exactly **one** lane plus a finding naming the build
`detect` could see and could not address. A `Makefile` beside a lane is reported
as a **finding**, never as a proposal.

**A marker pattern's directory prefix is part of the marker.**
`*/build.gradle{,.kts}` names a **module's** build file and is never satisfied
by the lane's own one — an Android root build file names the application plugin
`apply false` as a matter of convention, which is a line that switches it *off*,
and reading it as the marker proposed a whole Android lane out of a tree with no
Android module in it. A pattern written *without* a prefix names the lane's own
build file; found one directory down instead, that directory is the build the
pack's rows describe, so `detect` proposes `{gw} :<module>:<task>` using the
module name the lane's own settings file states — running the pack's bare task
name at the lane root would run the *root* project's task of that name, a
different command with the same spelling. Where the settings file names no
module there, every row is withheld: the build is neither a module this lane's
wrapper can address nor a build of its own.

**A commented-out fact is not a fact.** Both comment forms (`//` and `/* */`)
are stripped before any build script is read — for the marker `contains` check
and for the settings file's `include(...)` alike — with quoted strings stepped
over so a `//` inside a URL is not mistaken for a comment. A
`// TODO: id("com.android.application")` makes no lane, and a
`/* include(":retired") */` names no module.

**And every row is cross-checked before it is proposed.** The reference pack
([`docs/STACK-MATRIX.md`](STACK-MATRIX.md)) states a *shape*; `detect`
substitutes what your repository answers and then withholds anything it cannot
stand behind, naming the row and the reason:

| Check | A row is withheld when |
|---|---|
| **placeholders** | it still carries a pack token after substitution. Four are answered from the lane's own `package.json`: `{pm}` (the `packageManager` field with its version stripped), `{packageManager}` (that field verbatim), `{package}` (the manifest's own `name`, and **only** when the manifest is not a workspace root), and any token a declared **script** answers — the next row says what makes a script an answer. A fifth route reads *project files* where the pack says which file answers which token (the second table below). `{scheme}`, `{destination}`, `{resultBundle}` and the rest are facts only your repository knows, and a guessed argument is a different command |
| **corroboration** | a script agrees with the step by word count and at every position the pack spelled out, and *nothing else backs the match up*. Arity is a strong match for a step that spells most of itself out — `<pm> turbo run build` states three words and asks for one — and no match at all for one that does not: `node {archiveScript}` states **one** word and asks for one, so every one-argument `node` script in your manifest agrees with it, and a `"start": "node server.js"` answered the PDF-archive row. So a step whose literal words do not outnumber its token positions is answered only where the **script's own key** names the intent: a word of that key appearing in the verb, in the token's name, or in the value the script would answer with. `"resume:pdf": "node scripts/build-resume-pdf.mjs"` corroborates itself — you named the script after the file it runs; `"start"` says nothing that ties it to an archive, and the note names it as a near miss rather than proposing it |
| **the executable, and the tool it hands the work to** | its `exe` is neither the package manager `package.json` names, nor a package it declares as a dependency, nor part of a step the manifest spells out **verbatim** as one of its own scripts. The third is the strongest — a manifest whose `scripts` block contains this exact line is the repository saying it runs *this line*, so such a step skips this check and the task check both. **And the check follows the work one hop further.** `pnpm turbo run build` passes on `exe` the moment your manifest names pnpm, and says nothing whatever about turbo — which is the program that has to be there; the same held for `pnpm exec biome check .`. The three hand-off forms (`npx <tool>`, `<pm> exec <tool>`, `<pm> <tool> run <task>`) are read one level in, and that tool must be a declared dependency. A scoped `@biomejs/biome` answers for the `biome` an argv names: the scope is the publisher's |
| **the task, against the list its runner reads** | `run <task>` names a task, and *who* is asked to run it is the word before `run`. `<pm> run <task>` asks the package manager, whose list is your `scripts`. `<pm> turbo run <task>` asks **turbo**, whose list is your `turbo.json` (`tasks`, or `pipeline` in turbo 1) — you can have the npm script and not the turbo task, or the reverse, so looking a turbo task up in `scripts` validated the wrong list in both directions. Where `detect` cannot see the runner's list — no `turbo.json` in the lane, or a runner whose config filename it does not know — the row is withheld saying which, because *"could not check"* must never render as *"checked, and fine"*. And for a row `{package}` was answered in, the element *after* the package name is a task your manifest must declare |
| **ambiguity** | two of the lane's own scripts corroborate the match and answer the same token differently. `detect` resolves no ambiguity, and one arriving from inside a single file is not a different kind of ambiguity: both candidates are named and the row is yours to state. Corroboration decides what a *candidate* is and runs first, so a coincidence of word count is never a competing answer |

**And a second family of checks reads project files rather than a
`package.json`,** for the stacks whose ecosystem has no manifest to be
cross-checked against. Everything they need is stated in the pack —
`docs/STACK-MATRIX.md` renders each one beside that stack's markers — so
`detect` carries no table of its own, and a stack that states none reads
nothing and behaves exactly as before:

| Check | A row is withheld when |
|---|---|
| **the file a row addresses** | the tree does not resolve to exactly **one** candidate at any rank the pack lists. The candidates are an *ordered* list and the order is an argument: for `dotnet-winui`, a `*.sln` outranks a `*.csproj`, because a solution is your own list of the projects a build addresses and naming one project of a tree that has a solution would be `detect` choosing a subset you never chose. Two solutions, or two WinUI project files and no solution, are an **ambiguity** — both are named and neither is picked |
| **evidence the row needs** | nothing in the lane carries what the row would run against. `dotnet test` is a real command for a .NET lane and a fiction in a tree with no test project, so the row is proposed only where some `*.csproj` references `Microsoft.NET.Test.Sdk`, `xunit`, `NUnit` or `MSTest`. **The evidence file is also what the row addresses** — pointing `dotnet test` at the application would propose a command that builds fine and tests nothing — and several of them are an ambiguity rather than a choice |
| **a reference that leaves the repository** | a project file points at a path outside the tree. `zheref/KroWindows`'s `KroCore/KroCore.csproj` names a sibling clone of `zheref/Bankai`, and there is no submodule, no package and no restore step that fetches it. That is not a precondition `detect` can *write*: every path a declaration states is resolved against the repository root and one that escapes it exits **2** by name — so the row is withheld with the reference and its landing place quoted, never proposed with a precondition that could never hold. `detect` clones nothing. A reference that stays **inside** the tree becomes a `path` precondition instead, asserted before a verb runs and never performed |
| **a toolchain pin the tree does not state** | the entry's version file is absent or silent. `.NET` states its SDK in a `global.json` (looked for in the lane and then up to the repository root); `zheref/KroWindows` has none, so the build floats on whatever SDK is installed. `detect` then proposes **no** `project.toolchain` entry and says so: assert the version CI would need and `detect` will use it, but it will not invent one — a toolchain entry with no `version` is one nen's own reader refuses, and a pin `detect` chose is a pin that pins nothing. The note carries the block to paste, probe and installer included |

A proposal you paste and then discover is fiction is worse than an empty map
with a reason.

**A cell the pack has no command for becomes an explicit seat, not a hole.**
`declared-only` and `unsupported` rows are proposed as
`{"unsupported": "<the pack's own reason, quoted>"}`, and three things follow
from that. The declaration nen writes **loads**: a lane whose verb map is empty
is a file nen's own reader refuses, so a tree whose every command row was
withheld used to get a proposal the very next `nen shu build` rejected. The
reason you read in the file is the same sentence the executor prints back at
exit 4, because it *is* that repository's reason once the file is yours. And
the note tells you which seats are `declared-only` — the pack **has** observed
commands and declines to pick one, so those are the rows to replace first —
because "the pack declined to choose for you" and "this proposal has a gap" are
different facts and a reader who cannot tell them apart writes the row nen was
avoiding. The text output prints the two kinds on separate lines for the same
reason; `--json` is unchanged, and the split is read off each row's own shape.

**And a precondition nen would have to invent a value for is never proposed.**
Where a stack's toolchain entry probes for something `detect` has nothing to
read — an installed browser binary, a Visual Studio workload, the Gradle
wrapper token — it says so in a note, quotes the pack's reason, and proposes
nothing. `path` is not merely the wrong choice for an installed binary, it is
one nen **refuses**: every path a declaration states is resolved against the
repository root and one that escapes it exits **2** by name, so a machine's
absolute install location is not expressible as a precondition at all. And
`detect` names no environment variable the reference does not cite. If your
repository has one, state it yourself:
`{"kind": "env", "value": "<NAME>"}` under `project.preconditions.<lane>`. The
note appears for **every** toolchain probe carrying a pack token, `{gw}`
included: the pack's prose calls that one "the token nen resolves itself", and
the executor refuses it by name all the same — where the catalogue's prose and
the program's behaviour disagree about what nen does, the behaviour is the fact.

**And the one block it writes EMPTY on purpose.** Every proposal carries
`"targets": {}`, on every stack, from every tree — the deploy destinations
[`nen shu deploy`](#nen-shu-deploy) requires by name. It is the opposite of the
rule above it: a `toolchain` block is written only where the tree answered
something, because an empty one would be a **claim** (*"this repository needs no
host tools"*) that `detect` never made, while an empty `targets` block claims
nothing about your repository at all. It is a statement about **nen** — a deploy
destination is not a fact any checkout carries, so `detect` will never propose
one however much of the tree it reads — and the empty block is the seat that
says so in the file where your answer goes. Each lane's notes carry the
reference pack's own word on `deploy` for that stack, the shape to write
(`args`, `requiresEnv`, `unsupported`, `why`), and the one rule that matters
while you are writing it: `requiresEnv` names **variables**, never their values,
because this file is committed.

**`{gw}`, the one token `detect` answers from the HOST.** Every other
placeholder is a fact only your repository knows, and `detect` withholds the row
rather than guess one. `{gw}` is the exception the pack documents: it is your
own Gradle wrapper, and only its *spelling* differs by machine — `./gradlew` on
darwin and linux, `gradlew.bat` on win32. So `detect` writes the spelling for
the host it is running on straight into the proposal, and the declaration you
end up with carries a runnable word rather than a token. It writes it **only
when that file is in the lane**: a tree carrying the other host's spelling and
not this one's gets every row withheld, naming the platform, the spelling it
implies and the file that is actually there. A lane with no wrapper is a
*finding*, never an install — nen installs nothing. The executor still refuses
an unsubstituted `{gw}` by name at exit 2, so a hand-written declaration that
carries the token is a refusal rather than a child process called `{gw}`.

**And the declaration records which host answered it.** A committed declaration
is read by a whole team, and the word inside it is true for exactly the machine
that ran `detect`. So every lane whose proposed rows carry a resolved `{gw}`
gets a note naming the platform and the spelling written — *"a teammate on the
other host must re-run `nen shu detect` or hand-edit the spelling; the wrapper
is committed under both names, but a declaration carries one."* `hosts` is
deliberately **not** narrowed to that platform: the pack states this stack runs
everywhere and cites the repository saying so, both wrapper spellings ship side
by side in the tree, and narrowing would turn a one-word edit into exit **3**
*"unsupported host"* — a refusal that is false about the stack and that hides
the actual fix.

**Per-stack notes.** The five stacks `detect` proposes end to end, plus `expo`,
whose Metro lane is proposed end to end and whose native lanes are proposed as
lanes of their own stacks, plus `xcode-ios`, which proposes **no command row on
any tree** and is the clearest example of what a withheld row still gives you:

| Stack | What it proposes | What it withholds, and why |
|---|---|---|
| `nextjs` | `build`, `test`, `dev` (`<pm> turbo run <task>`), `run` (`next start`), `lint` (**two steps, in order** — the repo-wide format check, then the per-workspace fan-out), and `coverage` (`<pm> --filter <package> test:coverage`) where the lane resolves to one package that declares the task. Every workspace member carrying a `next.config.*` becomes its own lane, plus the root when the root has one, with `defaultLane: null` and `--lane` required. Seats for `ui-test`, `archive`, `deploy` (all `declared-only`) and `release` (`unsupported` — one observed repository says so in its own Makefile). | The four turbo rows unless your manifest declares **turbo** and your lane has a `turbo.json` declaring that task — `turbo run build` does not run the npm `build` script, and a manager the manifest names says nothing about the tool it hands the work to. `lint` likewise needs **biome** declared (`@biomejs/biome` counts). `coverage` on a **workspace root** — the root is the *list* of packages, not one of them, so answering `{package}` with its own name would propose a command the repository never runs; the note names every member it found, negations applied and missing directories dropped. `coverage` on a lane with no `test:coverage` script, naming the task. Any row whose `{pm}` cannot be read, because `package.json` states no `packageManager` (or states one with no `@version` to split). |
| `gatsby` | `build` (`gatsby build`), `dev` (`gatsby develop`), `run` (`gatsby serve`), `archive` (`node <the script your package.json names>`) and the two-step `deploy` (that same archive step, then the pages push the pack cites). Seats for `test`, `ui-test`, `lint`, `release` and `coverage`, each with the pack's sentence — *"no test script and no test-runner dependency"*, *"NO LINTER OF ANY KIND EXISTS IN THIS REPOSITORY."* `hosts` is every platform. | `archive` and `deploy` when no declared script both matches the shape **and** corroborates it — `{archiveScript}` is a path, the one place `detect` can see a path this repository runs is its own `scripts` block, and `node {archiveScript}` is thin enough that arity alone would take the first one-argument `node` script in the file. A `resume:pdf` answers; a `start` is named as a near miss. Two corroborated scripts that disagree are an ambiguity, not a choice. `build`/`dev`/`run` when `gatsby` is not a declared dependency, and the second step of `deploy` when the **publishing** tool the pack cites is not one either: a marker match is not evidence a tool is installed, and this is the one row where a proposal nobody checked would put bytes on somebody's infrastructure. And **no precondition for the locally installed browser** `archive` and `deploy` need — the reference probes for it *by path* and cites no environment variable, and a `path` precondition cannot name a location outside the repository at all, so `detect` reports the requirement in a note. |
| `gradle-android` | `build` (`{gw} assembleDebug --stacktrace`), `lint` (`{gw} :app:lintDebug --stacktrace`), and — **only where a module of your lane applies the Paparazzi plugin** — `ui-test` (`{gw} verifyPaparazziDebug` — screenshot verification; **recording** the baselines is the deliberately separate `{gw} recordPaparazziDebug`, which your declaration states if it wants it) and `test` (`{gw} verifyPaparazziDebug <your unit-test task> --stacktrace`), the latter additionally needing your settings file to name exactly one module `detect` can see is a library. Seats for `archive` (a `release` buildType with **no signingConfig**), `release`, `dev`, `run`, `deploy` and `coverage` (**no** JaCoCo or Kover is applied anywhere — and the observed repository's own checklist documents a task that does not exist on a clean checkout). `hosts` is every platform: the toolchain is cross-platform and the repository says so itself. **The `test` row's `why` is load-bearing and is carried verbatim into your declaration** — the task must be `verifyPaparazziDebug` and never `testDebugUnitTest`, because under the latter a snapshot test renders and discards: replacing a golden with a completely different image still reports PASSED. A note also reports a **conflict** the pack records and refuses to resolve: one canonical handbook binds its lint/test placeholder to exactly the forbidden task. Fix that upstream; nen encodes one side, cites it, and reports the other. A second note names the **plugin gate** on those two rows and why the markers cannot stand in for it. | `test` unless the lane's own `settings.gradle{,.kts}` names exactly **one** module `detect` can see is a library. Every included module is classified three ways — `application` (its build file carries the plugin that identified this lane), `library` (`detect` read the file, every plugin application in it is a literal id, and none of them is the plugin or a look-alike for it), and **`unknown`** — and a single `unknown` ends the row, naming the module and why. A module is `unknown` when its directory is not there, when its `projectDir` is remapped outside the repository, when its build file applies no plugin `detect` can see, when it applies one through an `alias(…)` or a dynamic `apply(…)` — the id then lives in a version catalogue `detect` does not read — or when it applies an id ending in the same word as the lane's plugin, which is how a **convention plugin** wrapping it is spelled. This is why `unknown` is not folded into `library`: an application module applying AGP through `id("myapp.android.application")` would otherwise be the one "library" the settings file named, and `{unitTestTask}` would be answered `:app:test` — the aggregate this row's own `why` exists to forbid. Also withheld: no `include(...)` `detect` can read, every module an application module, or two library candidates, in which case the note lists them and asks which. (`includeBuild` is deliberately not read: it names a separate build, not a module of this one.) And every row on a lane whose wrapper is missing for **this** host, naming the platform, the spelling it implies and what the lane carries instead. <br><br>**`test` *and* `ui-test` unless a module of this lane applies the Paparazzi plugin.** Both rows run `verifyPaparazziDebug`, which is that plugin's own task, and the markers that identify this stack confirm a wrapper, a settings file and the Android *application* plugin — none of the three says anything about Paparazzi, so a lane without it used to be handed a command whose first run is `Task 'verifyPaparazziDebug' not found in root project`. Four spellings count as applied — `id("app.cash.paparazzi")`, `id 'app.cash.paparazzi'`, `apply plugin: 'app.cash.paparazzi'`, and `alias(libs.plugins.paparazzi)` — and the id has to be the **argument of an application**, never merely present: a `testImplementation("app.cash.paparazzi:paparazzi-annotations:…")` names this plugin's artifacts and applies nothing. The alias is followed in the catalogue **its own accessor names**, among the `gradle/*.versions.toml` files at your lane root (`libs.` is `gradle/libs.versions.toml`; a second catalogue is addressed by its own file stem, and a `testLibs.` accessor is not answered by `libs`), matched on the **whole key** Gradle would generate — `libs.plugins.compose.paparazzi` is your `compose-paparazzi` entry or it is nothing. Every spelling is read with **comments stripped** (a commented-out application is not one, in either language — the catalogue by TOML's `#` rule and the build files by the script one), in a **module** build file your settings file `include(…)`s: a root `plugins` block naming the plugin `apply false` applies it nowhere, and a directory Gradle never configures creates no task whatever it applies — a build file in one is named as outside the build rather than counted. The answer is three-valued: `applied`, `absent`, or **`unknown`** — an `alias(…)` no catalogue of that name resolves, a settings file that builds its catalogues itself with `versionCatalogs {`, a dynamic `apply(…)`, a **root** build file that configures its modules from the top (`subprojects {`, `allprojects {`, `apply(…)` — the one thing `detect` reads the root for, and never for the id), or a `buildSrc/` or `build-logic/` whose convention plugins `detect` does not read and one of which may be applying it. `absent` and `unknown` both **withhold**, as a seat that says which of the two it was, names every file it opened and every file it deliberately did not, and states what to write instead: for `test`, the plain JVM row `{gw} :<module>:test` (never `testDebugUnitTest`); for `ui-test`, that there is no screenshot task to propose and instrumented UI tests are unsupported on this stack. A plugin applied inside a **nested build** (a directory with its own wrapper or settings file) is named and not counted — it is applied to a build your lane's wrapper never runs. |
| `compose-desktop` | `run` (`{gw} run`) and nothing else — one observed lane, one observed command, and it exists only as an IDE run configuration. Seats for the other nine, each with the pack's sentence: `archive` in particular declares `Dmg`/`Msi`/`Deb` target formats, **so the tasks exist**, and no command string for them appears anywhere in the repository — proposing one would be nen inventing a release path. `hosts` is every platform *to run*; packaging is per-format and host-locked, which is a `hosts` constraint your declaration states rather than a tool nen can supply. | The `run` row on a lane whose wrapper is missing for this host, **and** every row when the `compose.desktop` block sits in a subdirectory the lane's settings file names no module for — that build is neither addressable as `:<module>:run` nor a build of its own. Where the settings file *does* include it, the row is proposed as `{gw} :<module>:run`, and a note says so. A note also carries the pack's own argument for **per-lane** stacks: this lane lives inside a repository whose every other verb is Android, with its own wrapper pinned to a different version than the root's. |
| `expo` | The **Metro lane**, end to end: `dev` (`expo start`) and `lint` (`expo lint`), each proposed only where `expo` is a dependency the lane's own `package.json` declares — `expo` is invoked through the project, and Expo itself warns against a global install. Seats for `test`, `ui-test`, `archive`, `release`, `deploy`, `coverage` and — the one worth reading — **`build`**. `hosts` is every platform for a single-lane tree. | **`build`, always, and this is a rule rather than a withholding.** `expo run:ios` and `expo run:android` build *and launch*; there is no build-only invocation, and `expo start --web` is a dev server rather than an export. A `build` row mapped onto either would start an application on somebody's simulator the first time a script asked for a compile, so the pack carries no such row and `detect` will not manufacture one — the seat quotes that reason and `nen shu build` refuses at exit 4 with it. And **`run`**, because `expo run:{platform}` names a native lane and neither half is the other's default. The note goes further than naming the token: it names every value the lane's **own scripts** spell in that position (`ios` from `"ios": "expo run:ios"`, `android` from `"android": "expo run:android"`) and says where to state one — seeing a value and choosing one are different acts, and only the second is forbidden. Paste the pack's row in unedited and the executor refuses at exit **2**, naming `{platform}`. |
| `xcode-ios` | **No command row, on any tree** — and the seven seats, the darwin-only `hosts` block, and everything the checkout says about the rows it could not write. `{project}` is answered from the one container of the kind **the reference row's own flag addresses** — a lone `.xcodeproj` behind `-project`, a lone `.xcworkspace` behind `-workspace`, and lane-relative either way; the flag is read out of the pack's argv, not assumed. `{scheme}` is answered from the one shared scheme whose cross-check was performed **in full** and passed: every testable is read against the container *its own* `ReferencedContainer` names, and a scheme that delegates its test action to a `<TestPlanReference>` — which is what every project a recent Xcode creates looks like — is followed into the `.xctestplan` and checked from there. `{resultBundle}` comes from nen's own `.nen/`. Every withheld row then says what it **did** answer — *"nen DID answer `{project} = Kro.xcodeproj`, `{scheme} = Kro` from this lane's own files, so what this row still needs stated is `{destination}` and nothing else"* — which is the whole value of the verb on this stack: it does the copying out of the checkout, and you add the one value it cannot know. Seats for `ui-test`, `lint` (**declared-only** — two incompatible scripts in the observed repository, and SwiftLint appears in none of the seven), `archive`, `release`, `dev`, `run` and `deploy` (the observed repository's only deploy lane is a **database migration**, which is not an app deploy). A `Podfile` beside the container is recorded as **evidence**, never as a marker. | **`build`, `test` and `coverage`, on every tree there will ever be**, and one reason covers all three: each names `{destination}` or `id={simUdid}`, which name a simulator that exists, is of the right device type and is **booted on the machine** — and `detect` reads a working tree and spawns nothing. That is the one withholding here that is not a gap in your repository, and the note says so rather than reading like something you could close. The pack's own rows CITE forms for the position (`-destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5'`, `-destination id=<udid>`); `detect` quotes those sentences once per lane and lifts no value out of them. `{project}` is withheld where the container is not the kind the reference row's flag addresses — a workspace-only lane behind a project flag, the CocoaPods shape where the workspace's own `contents.xcworkspacedata` references the project, a workspace whose contents file `detect` could not read at all (**fail closed**: a container it could not ask is not a container that answered), or a flag it knows no container kind for — because the flag is **part of the row** and a path of the wrong kind behind it fails on every machine; the note names the flag the pack's row carries and asks you for both halves. Also withheld, each with its own sentence because each is a different repair: two projects (or two workspaces); two shared schemes; an unreadable `project.pbxproj`, which withholds the cross-check for the **whole lane** rather than measuring schemes against a target list missing a project; a test plan `detect` could not read, which is a target list it has not got rather than a scheme that names nothing; a testable declared **outside** this lane's root projects — a local Swift package, a project one directory over — which is neither confirmed nor called broken, because `detect` reads the `.xcodeproj` bundles at the lane root and nothing else, and a *partial* check is not a check that passed; a scheme whose test action names a target the projects do not declare (**a finding about your checkout**, not about the proposal — `xcodebuild test` on that scheme fails before any token matters); and a scheme that names **no** target anywhere. |
| `dotnet-winui` | `build` (`dotnet build <the project or solution your tree resolves to> -c Debug`) and, where a test project exists, `test` (`dotnet test <that test project>`). `hosts` is **`win32` only** — every verb, exit **3** everywhere else, and the pack's `hostNote` rides along as a lane note saying what that means in practice. A `path` precondition for each `ProjectReference` that resolves inside the tree **and names a file that is there today**, and a `project.toolchain.dotnet-sdk` entry when a `global.json` states `sdk.version` (searched from the lane up to the repository root; a `rollForward` beside the pin is carried into the reason, because it makes the pin a **floor** and a toolchain block has no field for one). Seats for the other eight, each with the pack's own sentence — *"NOTHING IN THE REPOSITORY INVOKES A COMMAND"* — plus a seat for any row a cross-check withholds, carrying the reason. **Read those two rows honestly:** the observed repository (`zheref/KroWindows`) runs no command anywhere — no Makefile, no `.cmd`/`.ps1`/`.sh`, no `.github/` at all. `dotnet build` is the maintainer's approved decision; `-c Debug` and the whole `test` row are argued in this PR and are **not** in that approval, which is why the pack's `source` fields say so and why deleting the `test` row returns the grid to the approved shape. | **`archive`, and MSIX packaging with it.** Packaging here is a Visual Studio gesture needing a platform, a signing identity and a publish profile the repository states nowhere, and the approval was `dotnet build` **alone**. `build` and `test` when the tree does not resolve to exactly one project or solution, with the candidates named — and a solution answers only when it **lists** the lane's WinUI project, so an unrelated, empty or stale one is named in a note and stands aside. Both rows when a `ProjectReference` in the graph the answer reaches **escapes the repository**, or is one `detect` cannot resolve at all — an MSBuild `$(property)`, a `*`/`?` wildcard, a `;`-list, an `&entity;` — or differs from disk only in **case**: each is quoted verbatim, no precondition is written, and nothing is guessed. A reference in a project file the answered graph does **not** reach is a finding and withholds nothing. `test` when nothing in the tree is a test project. And the SDK **version** when no `global.json` states one: assert the version CI would need and `detect` uses it; it will not invent one. |

**A bare-workflow Expo repository is three lanes, and `detect` says so.** Where
`ios/` and `android/` prebuild output is committed beside the manifest —
`zheref/food-diary`, the repository the catalogue read for this stack — the
scan finds a `.xcworkspace` under one and a Gradle wrapper plus
`com.android.application` under the other, and proposes `ios` (`xcode-ios`,
darwin) and `android` (`gradle-android`) as lanes of their own with those
stacks' rows. **The Android half is not a marker-only lane**, and it is where
the two stacks meet: `gradle-android`'s tool is a file the repository *commits*,
and `expo prebuild` writes it — so the wrapper and the lane's own
`settings.gradle` are both right there, `build`, `ui-test` and `lint` arrive as
**commands** with `{gw}` resolved for this host, and only `test` is withheld,
because `include ':app'` names the application module rather than the library
`{unitTestTask}` needs. `defaultLane` is `null`, and **no `hosts` block is
proposed**: the Apple lane runs on darwin alone and the other two run anywhere,
and `hosts` is keyed by *verb* rather than by lane, so a union would let
`nen shu test --lane ios` start on linux. A note relates the three — the `expo`
profile names `ios` **and** `android` among its own markers, which is the pack's
way of saying prebuild output is committed — and merges nothing: whether a verb
on the Metro lane should drive a native one is a decision the repository makes.

The note's gate is that **conjunction**, in full: the pack's sentence is *"`ios/`
AND `android/` both present means the BARE workflow"*, so a tree with only one of
them gets no claim at all rather than a weaker one — a half-met conjunction is a
different tree, not a softer version of the same one. And the lanes the note
calls siblings are only the ones the profile's markers **name**. A `site/`
Next.js build sitting one directory down is hand-written rather than generated,
so it is listed in a clause of its own that says exactly that: this profile's
markers do not name that directory, so nen relates it to nothing.

**Where a `hosts` block *is* proposed, the pack's own note on the platforms is
printed beside it.** A `hosts` entry is an allowlist `nen shu` refuses to start
outside (exit 3) — it is not a claim that every platform in it can do every part
of every verb, and `expo` is the stack where the difference bites: a managed
tree is written `"hosts": {"*": ["darwin", "linux", "win32"]}`, and the same `*`
row covers `expo start`, which runs anywhere, and `expo run:ios`, which needs
macOS with Xcode and CocoaPods. Nen writes the row the pack states and quotes
the pack's sentence next to it. It will not narrow the row from the prose:
deciding a platform policy out of a paragraph is exactly the kind of guess this
verb does not make.

**The Apple lane's scheme is read, cross-checked against the project's own
targets, and — where that check PASSES — substituted.** `{scheme}` is answered
from exactly one shape: a lane with one **shared** scheme (`xcshareddata/
xcschemes/`; a scheme under `xcuserdata/` is one developer's checkout and is
never read) whose test action names at least one target, every one of which the
lane's projects declare. Four shapes withhold it, and they are four different
repairs rather than one shrug: **two shared schemes** (named, by name and by
file — which one a verb means is your decision, not a count); a
`project.pbxproj` `detect` **could not parse** (a cross-check that could not be
performed is not one that passed, and a scheme it could not check is not one it
answers from); a test action naming **no** target (nothing failed is not the
same fact as it passed); and a test action naming a target the projects do not
declare.

That last one is the finding the check exists for. `food-diary`'s shared scheme
names a test target (`fooddiaryTests`) its `project.pbxproj` does not contain,
so a test run on that scheme **fails on a clean checkout** — the row is not one
placeholder away from working, and a note that named only the placeholder would
send you to fix the wrong thing. Every finding names the **file** as well as the
scheme: a repository may keep a shared scheme of the same name in its
`.xcworkspace` *and* its `.xcodeproj`, and those are two files to edit apart
rather than one paragraph printed twice.

**Comments are not facts, in either file format.** A `.pbxproj` delimits its own
sections with comments, so `detect` finds the target section in the raw text and
then strips comments from that section alone — a `/* name = Ghost; */` left over
from a deleted target is not a target, and a working scheme is not reported
broken against one. The same rule applies to a commented-out
`<TestableReference>` in a scheme and a commented-out `<FileRef>` in a
workspace.

**No test in this repository spawns an Apple toolchain**, and none ever will by
default: every seam is scripted, the platform is injected rather than read, and
the fixtures are directory trees carrying the two file formats `detect` parses.
A **live smoke** — one real `xcodebuild -version` and one real build of a
throwaway project, opt-in, on a macOS host — is deliberately left as follow-up
work rather than added here: it needs a runner with Xcode and a simulator
runtime installed, and a suite that silently skips on the other two CI lanes is
a suite that reports green for a check nobody ran.

**Which container the row addresses is part of the row.** The build tool takes a
different flag for a project and for a workspace, and the pack's reference row
carries one of them as a literal word — so `detect` answers `{project}` only
from a container of the kind that flag names. A workspace-only lane, two
projects, or the CocoaPods shape (a workspace whose own
`contents.xcworkspacedata` references the project) are each withheld with the
shape they are, and the note quotes the flag out of the pack's own argv rather
than spelling one. A workspace that references **something else** decides
nothing: it is another build's container that happens to live in the directory,
so it neither answers the row nor withholds it. A workspace `detect` could not
read fails closed.

The scan is bounded three ways, and every bound can hide a real lane: it
descends at most **three** directories below `--repo` looking for a lane; from
each lane root it looks at most **two** directories down for the module that
carries a stack's plugin; and it never enters `.git`, `.gradle`, `.idea`,
`.nen`, `.next`, `DerivedData`, `Pods`, `bin`, `build`, `dist`, `node_modules`,
`obj`, `out` or `vendor`. That is **one** list, used by the lane scan and by the
per-lane project walk alike — they used to be two, and the disagreement made a
`bin/Sub/App.csproj` into a lane called `Sub`. So a lane living in a directory
named like build output, and a lane whose application module sits three or more
directories inside it, are both invisible by design. The "no lane detected"
message names all three, because a silent miss and an empty tree look identical
from outside.

**A marker inside a comment is not a marker**, in XML as in a build script:
`<!-- <UseWinUI>true</UseWinUI> -->` makes no lane, a commented-out
`<ProjectReference>` withholds nothing, and a `<!-- we deleted xunit -->`
does not make a project a test project. Comments are stripped once, before every
question `detect` asks a project file. `CDATA` is stepped over rather than
scanned, because a `<!--` inside one is character data.

**And a property `detect` cannot evaluate is reported rather than skipped.** A
`<UseWinUI Condition="...">true</UseWinUI>` does not match the pack's literal —
an attribute can switch a property off as easily as on, and a lane proposed from
a line `detect` cannot read would be a guess — but the file is now named in a
finding, because "a real project I declined to read" and "an empty directory"
used to produce the same silence.

**Output and exit codes** — the proposal on stdout (as text with the block to
paste, or as `--json` `{ contract, repo, declaration, declarationPresent, lanes,
proposal, notes, written, exitCode }`). Exit 0 when at least one lane was
detected; exit **1**, with the reason, when nothing was — never a silent empty
proposal. Exit 2 when `--write` would overwrite, or when `--write` was given and
nothing was detected.

**Example**

```bash
nen shu detect --repo ./two-app-monorepo
```
```text
repository:  /Users/…/two-app-monorepo
declaration: /Users/…/two-app-monorepo/nen/contract.json  (absent)

  admin  (nextjs)  cwd admin
        marker: admin/next.config.js
        verbs:  build, dev, lint, run, test
        unsupported (the pack's reason, yours to replace):  archive, deploy, release, ui-test
        ^ 'coverage' withheld: its reference command asks the package '@acme/admin' for the task 'test:coverage', and this lane's package.json declares no such script. If the task is declared somewhere nen does not read -- a workspace member, a task runner's own config -- add the row by hand; a verb the project does not visibly carry is a warning, never a proposal.
        ^ the reference pack proposes no command for ui-test (two meanings), archive (evidence, not an artifact), release (declared n/a in the repo), deploy (three shapes, no default). … ui-test, archive, deploy are declared-only rather than unsupported: the pack HAS observed commands for them and declines to pick one, so those rows are the first to replace.
  web  (nextjs)  cwd web
        marker: web/next.config.js
        verbs:  build, dev, lint, run, test
        unsupported (the pack's reason, yours to replace):  archive, deploy, release, ui-test
        ^ … (the same two notes)

note: a lane's NAME is proposed from the directory it lives in (or from the stack id at the repository root) and is yours to change -- it is the token '--lane' takes, and nothing in nen reads meaning into it.

note: 2 lanes were found, so defaultLane is null and --lane is required. nen will not pick one: a repository with several builds in one tree has not said which one 'nen shu build' means.

proposed nen/contract.json (nothing was written -- pass --write, or paste this):
{
  "$schema": "nen.contract/v0.1",
  "project": {
    "lanes": {
      "admin": { "stack": "nextjs", "cwd": "admin" },
      "web": { "stack": "nextjs", "cwd": "web" }
    },
    "defaultLane": null,
    …
  }
}
```
(run for real against a two-lane fixture tree; the proposal is elided at `…`.
The lanes come out in **byte order** — `admin` before `web`, and `apps/Beta`
before `apps/alpha` — because the directory listing every part of this verb
walks is sorted here rather than left to the host: Node and Bun return the same
directory in different orders, so one tree used to propose two documents.)

### `nen shu build`

Compile or assemble the lane, by running the `build` invocation its declaration states.

**Usage**

```text
nen shu build [--repo <path>] [--lane <name>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--lane <name>` | no | Which lane to build. | Defaults to `project.defaultLane`; exit 2 naming every declared lane when neither is given. |
| `--dry-run` | no | Print every step and run nothing. | The argv printed **is** the argv that would be spawned — same rendering, same plan. |

**Output and exit codes** — the report, as text or `--json`. `0`/`1`/`2`/`3`/`4`/`5` as the family's table above.

**Example**

```bash
nen shu build --dry-run
```
```text
lane:          web  (nextjs)
verb:          build
host:          darwin -- supported (declared: darwin, linux, win32)
preconditions:
  ok    path  deps
  ok    env   PLACEHOLDER_LANE_TOKEN
would run:     pnpm turbo run build
cwd:           /Users/…/shu-repo
env:           (none added)
artifacts:     packages/app/.output (absent)
log:           dry run -- nothing was executed, so there is no output to capture and no tool exit code to report.
```
(run for real, against the executor's own fixture declaration)

### `nen shu test`

Run the lane's test suite, from its declared `test` invocation.

**Usage**

```text
nen shu test [--repo <path>] [--lane <name>] [--dry-run] [--json]
```

**Output and exit codes** — as `build`. Like every executing verb in this family it is **`dry-run-gated`** in izanami's automation-policy table, so `nen watch until --command "nen shu test"` refuses and `nen shu test --dry-run` is the form a watcher or a loop can use. The reason is in [`--dry-run` discipline](#--dry-run-discipline) above and in `src/parse/izanami.ts`: the argv comes from a file in the *target* repository — a declared test task may well write, and one keystroke separates a golden-image check from its recorder — so the bare form is never certified, while the dry run is, because rendering and spawning nothing is a property of nen rather than a claim about that argv.

### `nen shu ui-test`

Run the lane's UI/E2E suite. Same shape as `test`, same `dry-run-gated` classification. Multi-step declarations are common here — a browser download step before the suite itself — and every step is printed by `--dry-run` and run in order.

### `nen shu lint`

Run the lane's linter and format check. Same shape as `test`, same `dry-run-gated` classification — a check mode and its `--write` twin differ by one flag *in the declaration*, which is exactly why nen does not certify the bare form.

**Example**

```bash
nen shu lint --dry-run
```
```text
would run:     pnpm exec biome check .
would run:     pnpm turbo run lint
```
(the two `would run:` lines of a two-step declaration; the rest of the report is elided)

### `nen shu archive`

Produce the lane's distributable artifact. Across the stacks this family is designed for, most lanes declare `{ "unsupported": "<why>" }` here, and the refusal quotes that sentence at exit 4.

### `nen shu release`

Publish the artifact, where the lane declares a publication step. Nen never synthesises signing material — no export options, no keystore, no provisioning profile, no notarization credential — and a lane that has no publication step says so in its own words.

### `nen shu dev`

Start the lane's **debug** build for local iteration. Long-running: nen prints the pre-flight report as text, then inherits this terminal and hands it to the child, so the report's `steps[].exitCode` and `exitCode` are `null` and `log.mode` is `"interactive"`. Ctrl-C reaches the child; nen stays alive to report. `--dry-run` starts nothing at all.

`--json` is **refused at exit 2** here unless `--dry-run` is given: stdout belongs to the child from the handover onwards, so a report on that stream would be one object followed by a dev server's log lines. `nen shu dev --dry-run --json` is the machine-readable form of exactly the same pre-flight.

### `nen shu run`

Start the lane's **production or staging** build, locally. The distinguishing property against `dev` is the build configuration, not the lifetime — `run` is long-running too, goes through the same interactive seam, and refuses `--json` without `--dry-run` for the same reason.

### `nen shu deploy`

Send a build to a declared, **named** target. It is the one verb in this family
whose blast radius is other people's users, which is why every rule below is
stated as a refusal.

**Usage**

```text
nen shu deploy --target <name> [--repo <path>] [--lane <name>] [--dry-run] [--json]
```

`--target` is required and has **no default, ever** — not even when
`project.targets` has exactly one key — and must name a key of that map;
anything else is exit 2 listing what is declared. Nen never picks where a build
goes, and it never handles a credential: a target names environment
**variables**, and nen asserts that each is set without ever reading its value.

**What runs.** The command is the lane's own `project.verbs.<lane>.deploy`,
exactly like every other verb — one command, in the place a reader already
looks for one. The target contributes the destination:

```jsonc
"verbs": {
  "site": {
    "deploy": { "exe": "your-deploy-tool", "argv": ["publish", "--dir", "public"] }
  }
},
"targets": {
  "production": {
    "args": ["--env", "production"],
    "requiresEnv": ["YOUR_DEPLOY_TOKEN"],
    "why": "the live site"
  },
  "preview":   { "why": "a name-only target: the row above already names this destination" },
  "on-push":   { "unsupported": "the push to main IS the deploy, through the host's git integration. There is no command line for nen to run." }
}
```

`nen shu deploy --lane site --target production --dry-run` then prints

```text
target:        production  (appends: --env production)  requires env: YOUR_DEPLOY_TOKEN
would run:     your-deploy-tool publish --dir public --env production
```

and spawns nothing. The three shapes above are the three the inventory behind
[zheref/nen#91](https://github.com/zheref/nen/issues/91) found in the field: a
destination that differs by a flag, a destination the command already names, and
a destination that **has no command line at all**.

**The order the refusals come in, and why.** `--target` used to be a usage gate
checked *before* the declaration was read. That made a written `deploy` **seat**
unreachable: a lane whose declaration says, in its own words, that it has no
deploy answered *"no targets declared"* — sending a maintainer to write a
`targets` block that could not have helped. The destination is now resolved
after the lane, the verb, the host and the placeholders, and before the
preconditions:

| Order | Condition | Exit |
|---|---|---|
| 1 | `--json` on a long-running verb without `--dry-run` (not this verb) | 2 |
| 2 | no declaration, or no `project` block | 2 (malformed: 1) |
| 3 | `--lane` names no declared lane | 2 |
| 4 | the lane declares no `deploy`, or declares it `{ "unsupported": "<why>" }` | **4**, quoting that sentence |
| 5 | `project.hosts` does not allow this platform | 3 |
| 6 | an argv still carries a reference-pack placeholder | 2 |
| 7 | `--target` absent | 2, naming every declared target in byte order — or, with none declared, the exact `targets` block to paste |
| 8 | `--target` names no declared target | 2, listing the declared ones |
| 9 | the target declares `unsupported` | **4**, quoting that sentence |
| 10 | the target has `args` and the lane's `deploy` has more than one step | 2 |
| 11 | a precondition — the lane's, **or** a variable the target's `requiresEnv` names — is not satisfied | 2, with the report |
| 12 | otherwise: `--dry-run` prints the resolved argv and runs nothing; without it, the declared command spawns | 0 / 1 / 5 |

Rows 4 and 9 are **terminal**: they are true however the line is retyped, and a
refusal that sends someone to do work that cannot help is worse than one that
costs them a retype. Everything from row 7 down is a fact about the command line
or about this machine's environment, which the caller fixes and runs again. The
one thing this order costs is that a mistyped `--target` on a seated lane is
answered with the seat rather than with the typo — the right trade, because the
typo is invisible to a repository that will never deploy that lane at all.

**`--json`** carries the destination in the report's `target` key —
`{ name, args, requiresEnv }`, and `null` on every verb that takes no target —
so a deploy that ran can be audited for *where* it went. `requiresEnv` is
byte-ordered. No value of any variable appears in it, in the text rendering, in
a refusal, or in a log line; a refusal prints no document at all, as everywhere
else in this CLI.

**What `nen shu detect` proposes.** `"targets": {}`, always, on every stack —
the one field in a proposal whose emptiness is a fact about *nen* rather than
about the tree, because a deploy destination is not a fact any checkout carries.
The lane's notes carry the reference pack's own word on `deploy` for that stack,
the shape to write, and the rule that a credential value never goes into a file
that is committed.

### `nen shu coverage`

Run the lane's coverage command — through the same executor as every other verb,
with the same refusals and the same `--dry-run` — and then **parse the report
that run produced** into one shape: a total, a row per target, and (with
`--threshold`) whether the number cleared a bar. Same `dry-run-gated`
classification as `test`: a coverage run writes its report tree by definition.

**Usage**

```text
nen shu coverage [--repo <path>] [--lane <name>] [--threshold <0-100>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--lane <name>` | no | Which lane to measure. | Defaults to `project.defaultLane`, as everywhere else in this family. |
| `--threshold <n>` | no | A percentage, 0–100, compared against the report's **line** coverage. | **Reports `met` and never gates** — see below. A value nen cannot read is exit 2, before anything is spawned. |
| `--dry-run` | no | Print every step, run nothing — and **parse nothing**. | The report may well be on disk from a previous run; a dry run does not read it, because reporting yesterday's numbers for a command that did not execute is the most believable wrong answer this verb can give. |

**Where the report comes from — the verb's own `artifacts`.** nen parses the
first path under `project.verbs.<lane>.coverage.artifacts` whose **format** it
recognises, and it never searches a tree for one:

```json
"coverage": {
  "exe": "pnpm", "argv": ["--filter", "@kro/core", "test:coverage"],
  "artifacts": ["coverage/coverage-summary.json"]
}
```

**The path is resolved against the repository root, not the lane's `cwd`** —
the same rule every path in a declaration follows (`shu`'s `artifacts`,
`preconditions[].value`), and the likeliest first mistake this verb produces. A
lane whose `cwd` is `apps/web` and whose reporter writes `apps/web/coverage/
lcov.info` declares exactly that, in full. A path that escapes the repository is
**exit 2** naming it. `artifacts` are **literal paths**: nen expands no globs —
there is no shell in this program — so `coverage/*.info` is a file called
`*.info` and the refusal says so.

A lane that declares none — or declares only artifacts that are not reports — is
**exit 1** naming the field to add, listing the formats nen reads, and quoting
the reference pack's *advisory* location for that stack (`docs/STACK-MATRIX.md`
carries the same line per stack). That advisory is printed and **never opened**:
the pack is a catalogue, and a path nen went and read on a catalogue's say-so
would be a path nobody declared. If the lane declares a **`report`** key —
the field an earlier draft of this design published — the refusal names it
too, with the pointer, and says that this release reads `artifacts`.

**Row names are made repo-relative.** `nyc` and vitest's `json-summary` write
*absolute* keys (`/Users/<you>/work/<repo>/src/a.ts`, `C:\Users\…` on Windows),
so a `--json` document or a pasted table would otherwise carry your account name
and directory layout. A row that resolves inside the repository is reported
relative to its root, `/`-separated on every platform; a row genuinely outside
the tree is left exactly as the report wrote it, because that is a fact about
the run rather than a string to rewrite.

**Formats.** Chosen by file name first and confirmed against the bytes, so a
report under an unfamiliar name is still read and a name that lies is still
caught:

| `report.format` | what it is | conventionally |
|---|---|---|
| `istanbul-summary` | the Istanbul/Vitest JSON summary; rows are files | `coverage-summary.json` |
| `xccov-report` | the JSON an `xccov view --report --json` step writes to a file; rows are build targets, and there is **no branch figure** — the key is omitted rather than zeroed | no convention: name the path in the step, and in `artifacts` |
| `cobertura` | Cobertura XML (coverlet and others); rows are packages | `coverage.cobertura.xml` |
| `jacoco` | JaCoCo XML, and Kover's compatible form; rows are packages | the plugin's own path |
| `lcov` | the LCOV tracefile, the common fallback; rows are files | `lcov.info` |

A file in none of them is exit 1 listing exactly this table — and the refusal
names `coverage-final.json` explicitly, because it is the likeliest thing to be
declared by mistake: it is what a v8/Istanbul run writes *by default*, it sits
beside the summary, and it is the **raw** per-statement map rather than a
summary. Add the `json-summary` reporter (or `lcov`) and declare that file
instead.

**A report that is damaged is a refusal, never a number.** A truncated LCOV
tracefile — a record with no `end_of_record`, from a killed run or a full disk —
is exit 1 naming the `SF:` it stopped inside, rather than a total quietly missing
a row (that format's total *is* the sum of its rows, so a dropped row reads as a
smaller project, not as a broken file). A report stating more covered lines than
it has lines is refused with both counts, rather than printed as `117.65%` or
clamped to 100%.

**`--threshold` reports and never gates.** `met` is `true`, `false`, or `null`
when there was no number to compare. The exit code is the **run's**, in both
directions: coverage under the bar still exits 0 when the tool exited 0. nen does
not decide whether a number is good enough — the policy that prompted this flag
scopes its bar to *the files a pull request touched*, a git-diff-aware judgement
no coverage report can answer. Read `met` and decide.

The comparison is on the **counts**, not on the rounded percentage the table
prints: 19 999 of 25 000 lines displays as `80.00%` and is **not** met at
`--threshold 80`, because it is 79.996%. A value must be written in decimal
digits (`80`, `82.5`); `0x50`, `8e1` and a trailing `%` are exit 2 rather than a
number nen guessed at.

**Output and exit codes** — `0`/`1`/`2`/`3`/`4`/`5` as the family's table above,
plus: **exit 1** when the run succeeded and the report is missing, unreadable, in
no format nen reads, or not declared at all. A run that did **not** succeed is
not parsed at all — the file on disk may be a previous run's, and nen cannot tell
by looking. On **exit 5** (the tool could not be started) the executor's report
is still printed, and under `--json` stdout still carries exactly one document,
with `exitCode: 5` — the same thing [`shu build`](#nen-shu-build) prints on that
path.

**The per-target table is not capped.** An Istanbul or LCOV report has one row
per *file*, so a large repository prints a long table; `--json` carries the same
rows. Pipe it (`| head`), or read `total` alone, until a `--top <n>` exists.

**`--json`** is a different contract from the other executing verbs
(`nen.shu.coverage/v0.1`), keys in order: `{ contract, lane, stack, total,
targets, threshold, report, exitCode }`. `percent` is computed from the counts
(two decimals) rather than read out of the file — three of the five formats carry
a percentage of their own, rounded three different ways, one of them as a
fraction — and it is `null` for a report about no code, because 0 of 0 is neither
100% nor 0%. **A dry run is told by `exitCode: 0` with `total: null`**; nothing
else produces that pair. The executor's own report goes to stderr in this mode.

**Example**

```bash
nen shu coverage --threshold 80
```
```text
lane:          web  (nextjs)
verb:          coverage
host:          darwin -- supported (declared: darwin, linux, win32)
preconditions: (none declared)
ran:           pnpm --filter @placeholder/core test:coverage  -- exit 0 in 0ms
cwd:           /Users/…/shu-coverage-repo
env:           (none added)
artifacts:     coverage/coverage-summary.json
log:           not captured to a file -- each step's own stdout and stderr were relayed as it finished. A .nen/logs/ transcript is not in this release (zheref/nen#91).
report:        coverage/coverage-summary.json  (istanbul-summary)
total:         lines 82.35% (14/17)   branches 75.00% (3/4)
targets:
  lines           branches      target
  75.00% (3/4)    --            packages/app/src/main.ts
  84.62% (11/13)  75.00% (3/4)  packages/core/src/index.ts
threshold:     80% -- met. This is REPORTED and never enforced: nen exits 0 here, and the threshold moved that by nothing.
```
(run against this repository's own coverage fixture declaration; the same run
with `--threshold 95` prints `95% -- NOT met` and still exits **0**)

### `nen shu tools`

Check the **host** toolchain this repository pins, and — only with `--install`,
and only through one installer — install what nen is allowed to install. It is
the one verb in this family whose blast radius is the developer's machine rather
than a repository, which is why every rule below is stated as a refusal.

**Usage**

```text
nen shu tools [--repo <path>] [--lane <name>] [--only <tool[,tool]>] [--json]
nen shu tools --install [--only <tool[,tool]>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--lane <name>` | no | Which lane's directory the probes run in, and whose stack supplies the advisory column. | **Optional here, unlike every other verb in this family**: `project.toolchain` hangs off the *project*, not off a lane, so a repository with three unrelated builds still has one set of host tools. With no `--lane` and no `defaultLane` the report has no lane, the probes run at the repository root, and the advisory column is empty. A named lane must still be declared (exit 2). |
| `--only <tool[,tool]>` | no | Check (and install) just these tools, by the name the declaration gives them. | A name the declaration does not carry is exit 2 listing the ones it does — an empty report is not an answer to a mistyped tool. |
| `--install` | no | Act. **The one flag in this family that changes the host.** | See the eight rules below. |
| `--dry-run` | no | Print every command — **probes included** — and run nothing whatever. | This is the only form izanami certifies read-only. |

**What it reads** — `project.toolchain`, `{ "<tool>": { version, probe, versionFrom, installer, why } }`:

| Field | Required | Meaning |
|---|---|---|
| *the key* | **yes** | The tool's name, and the one map key this loader validates — it does not stay in the file: `--install` renders `<tool>@<version>` into the argv it spawns, and `--only` matches against it. It is held to npm's package-name shape (an optional `@scope/`, then letters, digits, `.`, `_`, `~`, `-`, not starting with `-`, `.` or `_`), so a key of `--all` cannot become a **flag** to the installer. Anything else is exit 1 at load, naming the pointer. A `$`-prefixed key is metadata and is skipped, as everywhere else in this schema. |
| `version` | **yes** | The pin. Either an exact version (`"9.15.9"`) or a floor (`">=20.19.0"`) — the two forms nen can evaluate. There is no caret, no tilde, no two-sided range and no dist-tag; one of those is exit 2 naming the pointer and both forms. A pre-release or build-metadata suffix is held to **semver's own identifier charset** (alphanumerics and `-`, per dot-separated identifier): `1.2.3-rc.1+sha512.abc` is a pin, `1.2.3-; rm -rf /` is exit 2 by pointer — that suffix is the one part of a pin that reaches an installer's argv unreshaped. **No entry may omit it**: nen never certifies or installs `latest`, and the loader refuses an entry that tries. |
| `probe` | **yes** | Argv, never a string. There is no shell. |
| `versionFrom` | **yes** | One of `first-semver-on-stdout`, `first-semver-on-stderr`, `whole-line-stdout`, `path-exists`. **Deliberately not a regex** — a caller-supplied pattern is a caller-supplied program, and a ReDoS surface `src/schema/pattern.ts` exists to guard. The two `first-semver` members read the first version-shaped token (one dot or more) on that stream, **preferring a three-component one when the line offers several** — so a banner leading with a build date `2024.01` does not beat the `1.2.3` beside it, while `MAJOR.MINOR` is still read when that is all a probe prints. Nothing scores further: two three-component tokens on one line still yield the first, because choosing between them would be nen guessing which version the probe meant. A probe whose line leads with an unrelated dotted number and carries no three-component version reads *that* number — declare a probe that prints the version alone. |
| `installer` | **yes** | One of `verify-only`, `corepack`, `wrapper`, `npx`, `sdkmanager`, `dotnet-install`, `winget`. Only **`corepack`** runs in this release. |
| `why` | no | Where the pin comes from, in the repository's own words. Printed verbatim; never nen's. |

The **`nen` row** comes from the `dependency` block instead, when there is one:
its `version_probe` argv, compared against `minimum` under the contract's own
**zero-major rule** — at major zero the MINOR is the breaking-change vehicle, so
`0.3` means `>=0.3.0 <0.4.0` *exactly*, out of range in both directions; above
zero the vehicle moves one component up, so `1.4` means `>=1.4.0 <2.0.0`. The
floor is **exactly two components**: `0.3.5` is exit 2 naming the pointer, not a
floor silently widened to `0.3` — a comparison nen quietly weakened is a
comparison nobody made. A leading `v` is accepted and normalised away. It is
always `verify-only`: re-pinning nen is [`nen bootstrap`](#family-bootstrap)'s job
and the consuming repository's decision, and the row prints the `pinned_ref` its
bootstrap would install. A `project.toolchain` entry of the same name wins, and
the row is then not synthesised.

**The four row states**

| State | Meaning | Exit 5? |
|---|---|---|
| `present-and-matching` | Found, and it satisfies the declaration's pin. For a `path-exists` entry: the probe named a path and the path is there — presence is the whole check that member asks for. | no |
| `present-but-wrong-version` | Found, and it does not satisfy the pin. **Also** the case where the probe ran and no `versionFrom` member could read a version out of what it printed — rendered `unknown`, and never satisfied: a comparison nobody made must not render as one that came back clean. | **yes** |
| `missing` | The probe could not be started at all (the seam's `spawnFailed`), or a `path-exists` probe named nothing that is there. | **yes** |
| `not-probed` | **Only under `--dry-run`**, where nothing was looked at. `satisfied` is `null`. A tool nobody looked for is not a tool that is absent. | no |

**The advisory `packMinimum` column** is the version nen has been *tested*
against, from the bundled profiles pack
([`docs/STACK-MATRIX.md`](STACK-MATRIX.md) renders it). It is printed as
`(tested minimum X)` beside each row and **never moves the exit code** — the
pack is a catalogue, and a catalogue that failed a build would be an authority.
It is the only reason this verb reads the pack at all, and it does so from a
module that cannot reach the subprocess seam (`src/shu/tools.ts`), while the
module that spawns (`src/shu/probe.ts`) cannot reach the pack. A source-scan
test computes that rule from the seam rather than from a list of names.

**What `--install` will and will not do**

| Installer | `--install` runs | Why |
|---|---|---|
| `corepack` | `corepack enable`, then `corepack prepare <tool>@<pin> --activate` — **on `darwin` and `linux` only** | The one install nen performs. The activator ships with the runtime it manages, and the version is the one the repository's own declaration pins. On **`win32` it is REFUSED**, with those two commands printed to run by hand: there `corepack` is a batch shim (`corepack.cmd`), and nen's one subprocess seam never uses a shell. A runtime that refuses to start a `.bat`/`.cmd` without one (node, since the fix for CVE-2024-27980) fails; a runtime that starts it anyway starts it *through* the command interpreter, which re-parses the argument list nen assembled element by element — a shell by another name. Nen will not guess which of the two this host does, and an install that "works on POSIX and is untested on Windows" is a claim nobody checked. The **check** is unaffected on every host: it spawns only the probe the repository declared. |
| `verify-only` | nothing | Reported with the pin and the sentence *"install by hand"*. A system-wide install with five common answers is exactly the choice nen does not make for you. |
| `wrapper`, `npx` | nothing | There is nothing to install: the repository's own committed wrapper, or its own dependency graph, resolves the tool. |
| `sdkmanager`, `dotnet-install`, `winget` | nothing | Declared, and **not enabled in this release**: every installer that fetches and executes vendor code, or writes into an SDK root, ships behind its own explicit decision. The row names the tool, the pin and the installer a human runs. |

**Eight fail-closed rules.** (1) Check is the default and `--install` is the
only way to act — no field, env var or declaration key flips it. (2) `--dry-run`
prints every command and runs nothing, probes included. (3) **Never `sudo`**,
never elevation; a test sweeps every rendered install plan for `sudo`, `runas`,
`pkexec` and `Start-Process -Verb RunAs`. (4) Never an installer the declaration
does not name. (5) **Never a version the declaration does not pin** — a range
pin is refused rather than resolved to "the newest thing that satisfies it", and
a pin the lane's own `package.json` `packageManager` field contradicts is
refused rather than silently preferred. That cross-check compares **versions,
not strings** — `9.15` and `9.15.0` agree, `v9.15.9` and `9.15.9` agree, and an
integrity suffix is split off — and it fires only when both sides state
something nen can read, because that field belongs to the ecosystem rather than
to nen. Agreeing is not adopting: the argv still carries the *declaration's*
spelling. Both refusals fire *before* anything is installed. (6) Never a URL nen invented. (7) Never edits `PATH`, a shell profile
or an environment — and what it installed is **re-probed** afterwards, because
an installer that exited 0 has not said the tool is on this `PATH`. (8) Never
installs a project's dependencies: that is a precondition nen asserts and never
performs.

**Output and exit codes** — the table above on stdout; the summary and the two
lines that fix it on stderr. Exit **0** when every tool passes, when a dry run
rendered, or when the repository declares no `toolchain` and no `dependency`
(*"nothing to check"*, pointing at [`shu detect`](#nen-shu-detect)). Exit **5**
when the CHECK found anything missing or not the pinned version — never 1: a
missing tool is not a failed build, and a caller retrying a 1 would retry
forever on a machine that is simply not set up. Exit **2** for an `--only` that
names an undeclared tool, a `version` in a form nen cannot evaluate, or a pin
`--install` will not act on. Exit **3** when `project.hosts` does not name this
platform — checked **before any probe runs**, so nothing is spawned.

**Under `--install` the code is 0 when everything nen *could* install now
passes**, even if verify-only tools are still absent. That split is deliberate:
the alternative makes the install form permanently red on a machine nen can
never fix, and "is this host ready" is the question the CHECK and its exit 5
answer. The cost of the rule is a green exit beside a host that is not ready, so
the run *says so*: `summary.notInstallable` counts those rows and the table
prints a footer naming them.

**`--install --only <tools nen installs none of>` is exit 2, not a green
no-op** — refused *before the first probe*, with each row's own way out quoted.
A caller who names the tools and asks for an install has made a claim, and the
claim is wrong: that run would have probed, installed nothing and exited 0 with
`satisfied: false` in the report. The general rule above survives because a full
`--install` has a half that succeeds — it installed everything it could — and a
narrowed one that can install nothing has none.

**`--json`** is a different contract from the rest of the family:
`{ contract, lane, stack, mode, summary, tools, exitCode }` with `contract` =
`nen.shu.tools/v0.1` and `mode` one of `check` / `install` / `dry-run`. **It
carries every value the table prints** — the human rendering is derived *from*
this object, not beside it, so the two cannot come apart.

`summary` is `{ checked, satisfied, missing, wrong, notProbed, installed,
refused, notInstallable }`. The four state counts always sum to `checked`.
`refused` counts rows carrying a pin this release will not act on;
**`notInstallable` counts rows that do not pass and that nen has no installer
for** — the number that explains an `--install` run exiting 0 beside a host that
is still not ready, and the text prints it as a footer for the same reason.

Each `tools[]` row is `{ name, required, packMinimum, pinned, versionFrom,
probe, found, probeOutput, satisfied, state, installer, installCommand, remedy,
install, why }`, in that order:

| Field | Meaning |
|---|---|
| `pinned` | The declaration's pin, normalised — an exact version, `>=X.Y.Z`, or the two-sided range a `dependency.minimum` floor stands for. |
| `versionFrom` | The member that read the version. It is what makes a satisfied row with no `found` readable: `path-exists` means presence *was* the check. |
| `probe` | The declared probe argv, rendered exactly as `--dry-run` prints it. |
| `probeOutput` | The first line the probe printed, **only** on a row that says "present, version unknown" — the one case where the output is the finding. Null everywhere else, including on satisfied rows, where `found` is the answer. Capped at 200 characters. |
| `installCommand` | The rendered commands, non-null only for an installer nen runs *and* only when there is something to do. |
| `remedy` | The way out **in words**, for a row with no command: `verify-only: install by hand — …`, `corepack: REFUSED — …`, `sdkmanager: not enabled in this release — …`, `wrapper: nothing to install — …`. Exactly one of `installCommand` and `remedy` is non-null on a row that needs a way out; both are null on a row that passes. Without it a refused `corepack` row and a `verify-only` row were the same row to a machine reader, because `why` is the *declaration's* reason for the pin and is null on most refusing rows. |
| `install` | What `--install` ran for this row — `{ steps: [{ exe, argv, exitCode, durationMs }], outcome, failure }` — and `null` in every mode that installs nothing. `outcome` is `installed` (every step nen ran exited 0), `failed`, or `skipped` (nen acted on nothing here). It describes the **installer**, never the host: `installed` beside `state: "missing"` is the real finding "it installed somewhere not on this `PATH`", which is why this verb re-probes. There is no `refused` outcome, because a refusal stops the run before the first install and this CLI answers a refusal with a stderr line and exit 2 rather than a document (below). |

**A refusal prints no document.** Every family in this CLI answers exit 2 with a
line on stderr and an empty stdout, and `shu tools` is no exception: `--install`
on a pin nen will not act on, an `--only` naming an undeclared tool, an
unevaluable `version` and an unknown `--lane` all leave stdout empty under
`--json` too. That is the family's rule rather than this verb's, and the reason
for it is that a `--json` reader should never have to tell a report from an
error object on the same stream.

**Example**

```bash
nen shu tools --repo ./web-app
```
```text
lane:          web  (nextjs)
mode:          check
  ok       node    22.11.0  pinned >=20.19.0  (tested minimum 20.19.0)
  MISSING  pnpm    --       pinned 9.15.9     (tested minimum 9.15.9)
                            install: corepack enable
                                     corepack prepare pnpm@9.15.9 --activate
```
```text
1 of 2 declared tools are missing or not the pinned version. nen can install 1 of them (pnpm):
  nen shu tools --repo ./web-app --lane web --install --dry-run   # see the commands
  nen shu tools --repo ./web-app --lane web --install             # run them
```

(exit 5; the summary and the two lines are on stderr)

### `nen shu warmup`

Get a working copy ready to iterate, in one line: check it is clean, fetch, fast-forward the trunk,
cut the branch you name from its fresh tip, then verify that the project still builds. **It is the one
verb in this family that mutates git state** — every other `shu` verb either reads, or spawns what the
target repository declared inside a directory — which is why `--repo` is required here and bracketed
everywhere else, and why every step **refuses rather than guessing**.

**Not [`nen warmup`](#nen-warmup)**, which is a different verb entirely: that one sweeps a *registry*
for stale pins and unanswered handbook questions, and reads only. This one warms a *working copy*. The
collision is resolved by nesting, exactly as `nen dev` / [`nen shu dev`](#nen-shu-dev) already is, and
the two compose in that order rather than replacing each other.

**Nothing is ever rolled back.** A step that fails leaves the tree exactly where it got to and says so,
with the report listing what did run. Undoing a fetch, deleting a branch or restoring files would be a
second mutation on a working copy nen has just discovered it does not understand.

**Usage**

```text
nen shu warmup --repo <path> --branch <name> [--from <trunk>] [--discard] [--tests]
               [--lane <name>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | The working copy to warm. | No default, unlike every other `shu` verb: a verb that fetches into a repository, moves a branch ref and checks out a new branch must never do it to "wherever this process happens to be". |
| `--branch <name>` | **yes** | The branch to cut from the freshly-fetched trunk. | Nen never invents one. Validated with git's own `check-ref-format --branch`, and refused at 2 if it already exists **locally or on `origin`** — never reused, reset or force-moved. A name beginning with `-` is refused before git can read it as an option. |
| `--from <trunk>` | no | The **local** trunk to fast-forward, and what `--branch` is cut from (as `origin/<trunk>`). | Defaults to `main` **when that local branch exists**, and refuses at 2 naming this flag when it does not. Nen infers a trunk from no remote `HEAD`, from no checked-out branch and from no lone branch. |
| `--discard` | no | Throw uncommitted work away instead of refusing it. | `git reset --hard` then `git clean -fd`, in that order, with the exact list printed first — **and then the tree is read again**. **Never `git clean -x`**: an ignored file is the developer's own cache. **Never a second `-f`** either: that deletes a nested repository. On an already-clean tree it runs neither command. See [what `--discard` will and will not remove](#what---discard-removes). |
| `--tests` | no | Also run the lane's declared `test` after the build. | Off by default — a test suite is the slow half and a warm-up is the fast one. The test is skipped when the build did not pass. |
| `--lane <name>` | no | Which lane the build/test verification runs on. | Defaults to `project.defaultLane`. An unknown lane is refused at 2 **before a single git call** — a caller who mistyped it must not have their working copy cleaned to find out. The lane is then **resolved again** from the declaration on the branch this verb cut, which is the tree the build actually runs in. |
| `--dry-run` | no | Print every command, in order, and run **nothing**. | Not even the fetch, and not one probe. Because it reads no git state, three of its lines say what a real run would spell differently: which fast-forward shape applies, that `main` is an assumption, and that the orphan-commit count is asked only on a detached `HEAD`. |
| `--json` | no | The report as one object. | See below. |

**The remote is `origin`, and only `origin`.** There is no `--remote`: a flag like that would have to
answer "and what does it mean when the trunk exists on two of them" the day somebody used it, and a
warm-up is not where that gets settled. A repository without an `origin` is refused at 2 with whatever
`git remote` actually listed.

**Steps, in the one order they may run in** — and the ordering is tested, because three of the
dependencies are load-bearing. The working copy is classified **before** the fetch (no point touching a
remote for a tree that is about to be refused). The name-on-the-remote question is asked **after** it (a
stale remote-tracking ref would report a branch absent that the real remote already has). And **every
check that needs no mutation runs before `--discard` destroys anything** — an absent `origin`, a `--from`
that is not a local branch, a name git will not accept, a name that is already a local branch. A mistyped
`--branch` is the cheapest mistake there is, and it must not cost anybody their uncommitted work.

| # | Command | Refuses when |
|---|---|---|
| 1 | `git branch --show-current` | it cannot be read at all. Empty output means a **detached HEAD**, which is *reported*, not an error |
| 1a | `git rev-list --count HEAD --not --branches --remotes` | *(only on a detached HEAD)* the count is non-zero (exit 2, naming it): `git switch -c` would orphan exactly those commits, and the only record of them afterwards is the reflog, which expires. A count that cannot be read refuses too — it is never answered "none" |
| 1b | `git rev-list --ignore-missing -1 MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD` | anything comes back: a merge, rebase or cherry-pick is in progress (exit 2). Nen then asks `git rev-parse --verify --quiet` per ref to name which, and quotes that operation's own `--abort`. This is **not** an ordinary dirty tree and `--discard` does not clear it |
| 2 | `git -c core.quotePath=false status --porcelain=v1 -z -uall` | the tree is dirty and there is no `--discard` (exit 2, every path listed, with a [`stage triage`](#nen-stage-triage) flag beside a filename shaped like a secret or a binary). An **unreadable** status refuses too — it is never read as a clean one |
| 3 | `git remote` | `origin` is not among them (exit 2, listing what is) |
| 4 | `git show-ref --verify --quiet refs/heads/<trunk>` | there is no such local branch (exit 2, naming `--from`). A code *above* 1 is git failing to answer and is reported as that, never as "absent" |
| 5 | `git check-ref-format --branch <name>` | git will not accept the name (exit 2, quoting git's own refusal) |
| 6 | `git show-ref --verify --quiet refs/heads/<name>` | the name is already a local branch (exit 2) |
| 6a | `git reset --hard`, then `git clean -fd`, then the status read **again** | only with `--discard`, and only when there was something to discard. The re-read refuses at 2 if anything survived — see [below](#what---discard-removes) |
| 7 | `git fetch origin` | it fails (exit 1 — a *step* failure, not a refusal) |
| 8 | `git merge-base --is-ancestor <trunk> origin/<trunk>` | the local trunk has **diverged** (exit 2). A code *above* 1 is git failing to answer and is reported as that, never as "diverged" |
| 9 | `git merge --ff-only origin/<trunk>` *(on the trunk)* or `git branch --force <trunk> origin/<trunk>` *(not on it)* | it fails. Two shapes because git has two: a checked-out branch cannot be moved by `branch --force`, and one that is not checked out cannot be advanced by `merge` |
| 10 | `git ls-remote --heads origin refs/heads/<name>` | the name is already on `origin` (exit 2) — **or the look-up itself failed**, which is never read as "absent". The ref is spelled in **full**: `ls-remote` matches a bare pattern against the *tail* of every ref on slash boundaries, so `--branch x` asked as a bare `x` would match an existing `refs/heads/feat/x` and refuse a name that is free |
| 11 | `git switch -c <name> origin/<trunk>` | it fails |
| 12 | the lane's declared `build`, then (with `--tests`) its `test` | see the exit codes below |

<a id="what---discard-removes"></a>

**What `--discard` will and will not remove.** It runs `git reset --hard` and then `git clean -fd`, and
then **reads the working copy again** — because "the command exited 0" and "the tree is clean" are
different claims, and only the second one is what the flag promised.

- **Removed:** every unstaged change to a tracked file, every **staged** change (which is why the tracked
  half is `git reset --hard` and not `git checkout -- .` — the latter restores the tree *from the index*,
  so a staged change survives it in both and rides onto the new branch), and every untracked file and
  ordinary untracked directory.
- **Never removed:** an **ignored** file (no `-x`: it is the developer's own cache), an untracked
  **nested repository** (no second `-f`: that directory is a repository and may carry commits that exist
  nowhere else), and anything inside a **submodule** (no `--recurse-submodules`: a submodule is its own
  repository with its own uncommitted work, and this flag is scoped to the repository `--repo` names).
- A nested repository or a dirty submodule therefore **survives** the discard, and the re-read refuses at
  exit 2 naming it, quoting whatever `git clean` itself said. Refused and named, rather than removed.
  At that point nothing has been fetched and no ref has moved.

**The build and test are delegated, in this process**, to the same executor
[`nen shu build`](#nen-shu-build) is — never a `spawnSync` of nen calling itself — so the argv that runs
is the lane's own declared argv, in the lane's own `cwd`, and the delegate's per-step exit code and
duration land in this verb's report.

**The declaration is re-read after the checkout.** The lane the build runs on is resolved from the
`nen/contract.json` on the **branch this verb just cut**, not from the tree the run started in — between
the two sits a fetch, a fast-forward and a checkout. A repository that gained a `project` block on the
trunk is verified against it rather than being reported as having none; a lane renamed on the trunk
resolves to the new name, and the disagreement with the pre-fetch read is stated on stderr. `--lane` is
still validated against the *starting* tree before the first git call, because a caller who mistyped it
is owed that answer before anything is discarded.

**A repository with no declaration is not a failure.** One that carries no `nen/contract.json` `project`
block gets the branch it asked for, the line `no declaration — build/test verification skipped` on
stderr naming [`nen shu detect`](#nen-shu-detect), and **exit 0**. The git half is useful on its own.

**Output and exit codes**

| Code | When |
|---|---|
| `0` | every step passed, or a dry run rendered, or there was no declaration to verify against |
| `1` | a step **ran and failed** — a `git` that answered non-zero, or the declared build/test. The report is still emitted, because the caller now has a working copy in a state they did not ask for and that list is the only thing that says which. A `git` that could not be **started** is also 1, with no document: *install it, or put it on PATH*. **A delegated `2` is also `1`** — see below |
| `2` | every refusal above: dirty tree without `--discard`, a merge/rebase/cherry-pick in progress, a detached `HEAD` carrying commits nothing else reaches, no `origin`, a `--from` that is not a local branch, a diverged trunk, a name git will not accept, a name that already exists, a `--discard` that ran and left the tree still not clean, an unknown `--lane`, a missing `--repo` or `--branch`. Each prints its evidence on **stderr** |
| `3`/`4`/`5` | passed through **unchanged** from the delegated build or test — unsupported host, unsupported verb for this lane, declared program not installed |

**A delegated `2` becomes `1`, and only here.** The executor's `2` means "this verb could not be performed
as declared" — an unmet precondition, an invocation it will not honour. Warmup's own `2` means something
else and incompatible: *nen refused, and changed nothing*. By the time the verification runs, the trunk is
fast-forwarded and the branch is checked out, so passing the code through would say something false and
would owe the caller a document that exit 2 does not carry. From warmup's side this is a verification step
that ran and did not pass, which is what `1` means here and everywhere else in the family. The executor's
own code is in the report row's `note` and in the sentence on stderr, and its own evidence is on stderr
unchanged. `3`, `4` and `5` still pass through: each of those is a fact about the repository or the host
that warmup has no better answer to.

**The document follows the mutation, not the code.** A refusal reached **before** this verb changed
anything prints its evidence on stderr and **no document** on stdout, as everywhere else in this CLI. A
refusal reached **after** it has already discarded work, **completed a fetch** or moved a ref prints the
report of what it changed first — the same argument a failed step makes: the caller now holds a repository
in a state they did not ask for, and `steps` is the only thing that says which state. **A completed
`git fetch origin` counts**, because it writes objects and moves remote-tracking refs — even though it
leaves the working copy, the index and every local branch alone, so it is nothing a caller has to repair.
A diverged trunk (step 8), a name already on `origin` and a look-up that could not answer (step 10) are
therefore each refused **with** the report; every refusal made before the fetch still prints none, except
the `--discard` re-read (step 6a), which already carried one for a destruction of its own. stdout is
therefore always either empty or exactly one document of the published shape, and never an error object.

`--json` is `{ contract, repo, trunk, remote, branch, discard, steps, lane, exitCode }`, in that order,
with `contract: "nen.shu.warmup/v0.1"`. Each `steps[]` row is `{ kind, argv, exitCode, durationMs, note }`,
where `kind` is `git | build | test` and `argv` is the **whole** command line, executable first — and is
**empty** on the row of a delegated verb the executor refused before it rendered one (a lane that seats
`test` as `unsupported`, say), so the last row of that report is not a *successful build* sitting beside an
exit code of 4. `exitCode` and `durationMs` are `null` **exactly** when nothing was run — a dry run, a step
the run never reached, or that same unrendered row — and `lane` is `null` when there is no declaration.

**Example — the dry run**

```bash
nen shu warmup --repo ./web-app --branch my-idea --dry-run
```
```text
repo:          /abs/path/web-app
remote:        origin
trunk:         main
branch:        my-idea
discard:       no -- a dirty working copy refuses
lane:          web
would run:     git branch --show-current
would run:     git rev-list --count HEAD --not --branches --remotes
would run:     git rev-list --ignore-missing -1 MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD
would run:     git -c core.quotePath=false status --porcelain=v1 -z -uall
would run:     git remote
would run:     git show-ref --verify --quiet refs/heads/main
would run:     git check-ref-format --branch my-idea
would run:     git show-ref --verify --quiet refs/heads/my-idea
would run:     git fetch origin
would run:     git merge-base --is-ancestor main origin/main
would run:     git branch --force main origin/main
would run:     git ls-remote --heads origin refs/heads/my-idea
would run:     git switch -c my-idea origin/main
would run:     pnpm turbo run build
```

(most lines also carry an indented note saying what that step decides or refuses on; they are elided
here. exit 0, and **nothing at all is spawned**. The orphan-commit count on line 2 is one of the three a
real run may spell differently: it asks it only when line 1 comes back empty. With `--discard` the plan
gains `git reset --hard`, `git clean -fd` and a second `git status` after line 8.)

**Example — a dirty tree, refused**

```text
nen shu warmup: the working copy at /abs/path/web-app carries 3 uncommitted path(s), and warmup destroys nothing nobody asked it to.
   M README.md
  ?? .env  [secret-shape]
  ?? sub/new.txt
Commit them, stash them, or pass --discard to throw them away -- that runs 'git reset --hard' and then 'git clean -fd', in that order, printing this same list first and re-reading the tree afterwards.
Ignored files are NEVER touched: 'git clean' is run without -x, because an ignored file is this developer's cache and not this verb's to delete.
```

(exit 2, all on stderr; stdout is empty, because this refusal changed nothing)

**Example — `--discard` ran, and something survived it**

```text
ran:           git reset --hard  -- exit 0 in 14ms
               discarding 4 uncommitted path(s):
                  M README.md
                 ?? .env  [secret-shape]
                 ?? sub/new.txt
                 ?? vendored/
ran:           git clean -fd  -- exit 0 in 11ms
               untracked files and directories only. -x is never passed: ...
               git said: Removing .env
               git said: Removing sub/
ran:           git -c core.quotePath=false status --porcelain=v1 -z -uall  -- exit 0 in 11ms
               1 path(s) SURVIVED the discard
```
```text
nen shu warmup: --discard ran and the working copy at /abs/path/web-app is STILL not clean: 1 path(s) survived it.
  ?? vendored/
'git clean -fd' said, for its part:
  Removing .env
  Removing sub/
Both commands exited 0, and neither of them destroys these:
  - a path ending in '/' is a directory git would not descend into, which under -uall means a NESTED REPOSITORY. 'git clean' will not delete one without a second -f, and nen never passes -ff: that directory is a repository and may carry commits that exist nowhere else.
  - a modified path that is a SUBMODULE is its own repository with its own uncommitted work. 'git reset --hard' is run without --recurse-submodules deliberately: --discard is scoped to the repository --repo names, and never reaches into another one.
Deal with them yourself and run this again. Nothing has been fetched and no ref has moved -- the only thing this run changed is the tracked and untracked work the two commands above did destroy, which the report above lists.
```

(exit 2, the report on stdout and the refusal on stderr — the one shape of exit 2 here that carries a
document, because by then this run had already destroyed something)

## This repository's own dev loop

Nen's own harness, and nothing else's. Each of these runs *this* repository's
tooling and needs a checkout to run it in; a compiled binary has no harness,
linter or corpus slice, and refuses by name rather than failing as an opaque
spawn error.

<a id="family-dev"></a>

**`nen dev`**

This checkout's own harness, and nothing else's: test, lint, and a corpus-slice regression replay. Each of these is explicitly a DEV verb -- it runs THIS repository's own tooling (`bun run test`/`bun run lint`, both of which are `devDependencies`) and needs a checkout to run it in; a compiled `nen` binary has no harness, linter or corpus slice to run, and says so by name rather than failing as an opaque spawn error.

### `nen dev test`

A thin spawn of `bun run test` (-> vitest, reading `vitest.config.ts`) -- deliberately not a second, bespoke test runner, so this verb can never drift from what CI itself runs.

**Usage**

```text
nen dev test [-- <args>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `-- <args>` | no | Everything after `--` is handed to vitest UNPARSED. | A wrapper that re-interpreted its own passthrough is a wrapper that will eventually disagree with vitest about what e.g. `-t` means. |
| `--repo <path>` | no | Which checkout's `package.json`/harness to run. | Defaults to the cwd; a compiled binary or a directory with no `package.json` is refused (exit 2) by name. |

**Output and exit codes** -- output is vitest's own, inherited stdio (no nen-level rendering, no `--json`). Exit code is vitest's own process exit code; exit 2 specifically when no `package.json` exists under `--repo`, or `bun` is not on `PATH`.

**Example**

```bash
nen dev test -- src/commit
```
```text
$ vitest run src/commit

 RUN  v2.1.8 <checkout>

 ✓ src/commit/format.test.ts (12 tests) 3ms
 ✓ src/commit/command.test.ts (5 tests) 2ms

 Test Files  2 passed (2)
      Tests  17 passed (17)
```
(run for real, against this checkout, scoped to one directory)

### `nen dev lint`

The same shape as `dev test`, for eslint: a thin spawn of `bun run lint`, so a rule override added to the npm script is never missed by a bespoke invocation here.

**Usage**

```text
nen dev lint [-- <args>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `-- <args>` | no | Passed straight through to eslint. | |
| `--repo <path>` | no | Which checkout to lint. | Same package.json/bun requirement as `dev test`. |

**Output and exit codes** -- eslint's own inherited-stdio output; no nen-level rendering or `--json`. Exit code is eslint's own; exit 2 when no `package.json`/`bun` is found.

**Example**

```bash
nen dev lint
```
```text
exit 0 -- no lint errors
```
(run for real, against this checkout)

### `nen dev replay`

Replays the imported corpus slice (`tests/fixtures/dualrun-slice/`, the evidence that this dedupe logic reproduces the shell script it replaced) against nen's OWN equivalent logic -- currently `src/issue/search.ts`'s `normalizeTitle`/`findCanonical`, absorbed from `dedupe_handbook_questions.sh`. `tests/fixtures/dualrun-slice/dedupe/MANIFEST.json` records exactly which fixtures were imported and why every excluded one has no nen equivalent to replay against.

**Usage**

```text
nen dev replay [--slice-dir <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--slice-dir <path>` | no | Where the fixture JSON files live. | Defaults to `<repo>/tests/fixtures/dualrun-slice/dedupe`. |
| `--repo <path>` | no | Used only to compute the default `--slice-dir`. | |

**Output and exit codes** -- prints `replayed <n> fixture(s): <p> passed, <f> failed`, then one `FAIL <id>: expected <x>, got <y>` line per disagreement. `--json`: `{ total, passed, failed, error }`. Exit 0 when every fixture agrees; exit 1 on any disagreement, OR when `--slice-dir` names an existing-but-EMPTY directory (never a silent 0/0 pass); exit 2 when `--slice-dir` does not exist at all.

**Example**

```bash
nen dev replay
```
```text
replayed 10 fixture(s): 10 passed, 0 failed
```
(run for real, against this checkout's own bundled corpus slice)

## Skill-grammar parsing

Parse a skill invocation against the grammar that skill publishes, echo the
parse, and refuse an unparseable line with a corrected line ready to paste.
Three skills carry their own grammar and extra domain logic here because each
does more than match a template; every other skill supplies its grammar as a
`--grammar` template.

<a id="family-parse"></a>

**`nen parse`**

Parses a skill invocation against the grammar that skill itself publishes, echoes the parse, and refuses an unparseable line with a corrected line ready to paste -- it never decides that a parsed line is a good idea, only that it matches its own grammar. Three skills (`futon`, `izanagi`, `izanami`) carry their own grammar and extra domain logic baked into this binary because each does strictly more than "match a template": `futon` resolves its repo token against `nen/repos.json`, `izanami` classifies every command against its own read-only allow/refuse table, `izanagi` enforces that its cap is never defaulted. Every OTHER skill name is a caller-supplied `--grammar` template matched against `--line`.

### `nen parse <skill>`

The generic engine: any skill name, its `--grammar` template (`<name>` for a slot, `<name:a|b|c>` for an enumerated slot, `word(s) <slot>` for a slot introduced by literal words matched at its LAST whole-word occurrence, `@<slot>`/`#<slot>` for a symbol-separated slot, `[ ... ]` for an optional trailing clause, `[+]` for an optional literal suffix), and `--line`, the invocation to check.

**Usage**

```text
nen parse <skill> --grammar <template> --line <invocation>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `<skill>` (positional) | yes | The skill name; used only to build the corrected line. | Any name other than `futon`/`izanagi`/`izanami`. |
| `--grammar <template>` | yes | The template, exactly as the skill documents it. | A template the engine cannot split unambiguously is a usage error (exit 2), same as an unparseable `--line`. |
| `--line <text>` | yes | The invocation to parse. | |

**Output and exit codes** -- on a match, echoes the parse one clause per line (`<slot>: <value>[ (+)]`, `[<clause>]: present`). On a refusal, prints each problem as `nen parse: <problem>` to stderr, then `Corrected line:` and the suggested rewrite. `--json`: the full `ParseResult` -- `{ skill, template, line, ok, slots, clauses, missing, problems, corrected, echo }`. Exit 0 when the line parses; exit 2 when it does not, or when `--grammar` itself is malformed.

**Example**

```bash
nen parse mybuild --grammar "build <target> for <env>" --line "build app for prod"
```
```text
target: app
env: prod
```
(run for real)

### `nen parse futon`

Parses futon's own invocation grammar (`<repo>@<severity>[+] [then <terminal>]`) and resolves its repo token against `--repo`'s `nen/repos.json` registry -- `+` means this severity band OR HIGHER, a bare severity means that band alone, and `then tag`/`then tag+fanout` is read from the LAST whole-word `then`. The terminal clause is refused unless the resolved repo IS the one you are standing in (or `--self` names it): a consumer's release is a different job than the registry owner's, and this refusal is what keeps a consumer's futon invocation from accidentally cutting the OWNER's tag.

**Usage**

```text
nen parse futon --repo <path> "<repo>@<severity>[+] [then <terminal>]" [--self <owner/name>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The checkout whose `nen/repos.json` the repo token resolves against. | Listed unbracketed: omitted, exits 2 by name. |
| (positional invocation) | yes | The futon line itself, e.g. `BC@high+ then tag`. | Joined from every positional after `futon`. |
| `--self <owner/name>` | no | Overrides "which repo am I standing in" (otherwise read from the git remote). | Needed when the caller's own remote does not resolve, or under test. |

**Output and exit codes** -- prints `repo: <slug> (<code>)`, `band: <severity>[+] -> <severities>`, `terminal: <clause or '(none -- build-only)'>`. `--json`: `{ repo, code, isSelf, band, terminal }`. Exit 0 on a resolved, permitted invocation; exit 2 on an unparseable line, an unresolvable repo token, or a `then <terminal>` clause against a repo that is not the caller's own (with a corrected, build-only line offered).

**Example**

```bash
nen parse futon --repo src/schema/fixtures/bankai-repo "BC@high+ then tag" --self zheref/bankai-core
```
```text
repo: zheref/bankai-core (BC)
band: high+ -> critical, high
terminal: tag
```
(run for real against the bundled fixture repo)

### `nen parse izanagi`

Parses the MUTATING loop's grammar (`<task> until <condition> up to <N>`). `up to <N>` is REQUIRED and never defaulted: an invocation without an explicit cap is refused with a corrected line, because an uncapped mutating loop is exactly the hazard this grammar exists to close off.

**Usage**

```text
nen parse izanagi "<task> until <condition> up to <N>"
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| (positional invocation) | yes | The full izanagi line. | Every positional after `izanagi` is joined with spaces. |

**Output and exit codes** -- prints `task: <task>`, `until: <condition>`, `cap: <N>`. `--json`: `{ task, condition, cap }` on success, `{ ok: false, error }` on refusal. Exit 0 when parsed with a cap present; exit 2 on an unparseable line or a missing `up to <N>` (with a corrected line on stderr where one can be offered).

**Example**

```bash
nen parse izanagi "retry the flaky build until CI is green up to 3"
```
```text
task: retry the flaky build
until: CI is green
cap: 3
```
(run for real)

### `nen parse izanami`

Parses the READ-ONLY loop's grammar (`<task> until <condition>`, no cap -- izanami needs none) and classifies every command in the task against izanami's own allow/refuse table. Refuses the WHOLE run (exit 1) the moment any one command classifies as mutating or unknown, rather than only flagging the offending step.

**Usage**

```text
nen parse izanami "<task> until <condition>"
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| (positional invocation) | yes | The full izanami line. | Every positional after `izanami` is joined with newlines (a multi-command task is one command per line). |

**Output and exit codes** -- prints `until: <condition>`, then `  [<classification>] <command>` per command. `--json`: `{ condition, commands: [{ command, classification }], ok }`. Exit 0 when every command classifies read-only; exit 1 when any classifies as mutating or unknown (naming `nen parse izanagi` as the loop to use instead); exit 2 on an unparseable line.

**Example**

```bash
nen parse izanami "gh pr checks 42 until it is green"
```
```text
until: it is green
  [read-only] gh pr checks 42
```
(run for real)

## Supply

Getting a verified binary, firing and verifying a wake, and rendering the
gate-stop banner that says a human's input is needed.

<a id="family-bootstrap"></a>

**`nen bootstrap`**

The TypeScript half of the supply contract: resolves `bootstrap/nen.sh` (found from the repository root -- `--repo`, or the cwd -- never guessed relative to the compiled binary's own location, which has no sibling `bootstrap/` directory) and runs it unchanged, relaying its exit code and stdout verbatim. It never reimplements the integrity rules -- refuse an absent manifest, refuse an ambiguous one, refuse a host with no hashing tool, DELETE bytes that mismatch, never print a path to an unverified binary -- because a second implementation is a second thing that can drift, and the shell script is the one artifact a machine with no `nen` yet actually runs. This is a top-level entry, not a registered family: it takes no `--json`, and it is one of only two commands (with `schema check`) documented outside the family registry.

### `nen bootstrap`

There is deliberately no default and no `latest`: a bootstrap that picked the newest release would convert a source-pinned supply chain into an unpinned one, so `--ref` is required with no fallback. On success, stdout carries ONLY the verified binary path; every diagnostic goes to stderr.

**Usage**

```text
nen bootstrap --ref <tag> [--source <owner/name>] [--cache-dir <dir>] [--script <path>] [--repo <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--ref <tag>` | yes | The exact tag to fetch and pin to. | No default, no `latest`; omitted, this exits its own usage code (2). |
| `--source <owner/name>` | no | GitHub repository to fetch release assets from. | Defaults to `zheref/nen` inside the script; NOT `--repo` -- a wholly different meaning (a path vs. an `owner/name`) is deliberately given two different flag names across both the shell and the CLI. |
| `--cache-dir <dir>` | no | Cache root for verified binaries. | Defaults to `${XDG_CACHE_HOME:-$HOME/.cache}/nen`. |
| `--script <path>` | no | An explicit path to `bootstrap/nen.sh`, for a binary invoked outside any checkout. | Falls back to `$NEN_BOOTSTRAP_SH`, then `<repo>/bootstrap/nen.sh`. |
| `--repo <path>` | no | The checkout `bootstrap/nen.sh` is found under, when `--script` is not given. | Defaults to the cwd. |

**Output and exit codes** -- stdout carries ONLY the verified path, and only on success; every diagnostic is on stderr. Exit codes are a published contract, restated from `bootstrap/nen.sh`'s own header (and cross-checked by `src/supply/bootstrap.test.ts`): `0` OK, `2` usage error (nothing attempted), `3` unsupported host (no binary published for this OS/arch), `4` download failure -- **the only retryable one**, `5` checksum mismatch or unverifiable -- SECURITY, never retry, `6` manifest (`SHA256SUMS`) unfetchable/missing/malformed/silent about the artifact -- never retry, `7` the TypeScript wrapper itself could not run the script at all (no `bash` on PATH, script not found) -- distinct from any code the script itself can return.

**Example**

```bash
nen bootstrap --ref v0.2.0 --source zheref/nen
```
```text
/home/me/.cache/nen/v0.2.0/nen-linux-x64
```
(shape derived from `bootstrap/nen.sh`'s own header and `src/supply/bootstrap.ts`/`bootstrap.test.ts` -- not run live, this needs the network and a real published release)

<a id="family-wake"></a>

**`nen wake`**

Fires or verifies a "wake": a workflow run that was silently swallowed (concluded `action_required`/`startup_failure` and never actually executed), or a label-triggered workflow that needs an edge-trigger re-fire. Both subcommands follow CON-38's dry-run-first convention -- nothing is written to GitHub without `--run`, including `verify`, whose name reads as an inspection but which reruns workflows and posts comments once it is given permission to.

### `nen wake verify`

Scans open pull requests whose author matches `--author-pattern` for a workflow run that concluded `action_required`/`startup_failure` and never executed, and auto-redrives what can safely be redriven (at most once per run), falling back to a comment flag for a human otherwise. `--now` is the sweep's own fixed instant (never the live clock), so a replay is reproducible. A failed redrive or a failed comment POST never aborts the whole sweep -- it warns and moves to the next PR, so one bad PR cannot strand every PR after it unscanned.

**Usage**

```text
nen wake verify --repo-slug <owner/name> --now <ISO-8601> --author-pattern <regex> [--max-prs <n>] [--max-runs-per-pr <n>] [--flag-marker <text>] [--redrive-marker <text>] [--run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo-slug <owner/name>` | yes | The repository scanned over `gh api`. | |
| `--now <ISO-8601>` | yes | The sweep's fixed instant. | Read once, never `Date.now()` -- makes a replay reproducible. |
| `--author-pattern <regex>` | yes | Which PR authors are in scope. | Nen carries no repository's own agent-login list, so this has no default; refused at the flag (before any `gh` call) if it has a potentially catastrophic-backtracking shape (e.g. `(a+)+`). |
| `--flag-marker <text>` | no | The idempotency-stamp phrase a detect-only flag comment carries. | Defaults to `nen-wake-guard`; NOT interoperable at that default with the shell sweep this replaces -- set it to that script's own phrase when migrating alongside it. |
| `--redrive-marker <text>` | no | The idempotency-stamp phrase a redrive comment carries. | Defaults to `nen-wake-redrive`; same interop note. |
| `--max-prs <n>` | no | Cap on PRs scanned this tick. | Defaults to 6. |
| `--max-runs-per-pr <n>` | no | Cap on swallowed runs handled per PR this tick. | Defaults to 3. |
| `--run` | no | Actually rerun workflows / post comments. | Without it, this is a dry-run report only -- despite the verb's name. |

**Output and exit codes** -- prints `scanned <n> PR(s)[ (dry run)]`, then `#<pr> run <id>: <kind> -- <reason>` per action (or `no swallowed wakes found`), then any `warning: ...` lines. `--json`: `{ repo, now, dryRun, scanned, results, warnings }`. Exit 0 on a completed sweep -- a failed redrive or a failed follow-up comment POST is tolerated (reported as a `warning:` line, never a non-zero exit); exit 1 if one of the THREE `gh api` fetches this sweep depends on (the open-PR list, a PR's run history, a PR's comment thread) itself fails, since those go through the throwing `must`/`mustJson` seam rather than the tolerated per-action path; exit 2 on a malformed or catastrophic-shaped `--author-pattern`, before any `gh` call.

**Example**

```bash
nen wake verify --repo-slug zheref/bankai-core --now 2026-09-07T00:00:00Z \
  --author-pattern '^(kaido-bot|senku-bot)\[bot\]$' --run
```
```text
scanned 4 PR(s)
#63 run 998877: redrive -- swallowed 'action_required' on a redrivable event -- auto-redriving via 'gh run rerun 998877'
```
A sweep that found nothing prints the count and one more line instead, never
alongside an action line -- `no swallowed wakes found` is emitted only when the
action total is zero (`src/wake/command.ts:265`):
```text
scanned 4 PR(s)
no swallowed wakes found
```
(both captured from `runFamily` driven against `src/wake/command.test.ts`'s own
stubbed `gh` seam -- four open PRs matching `--author-pattern`, one of them
carrying an `action_required` run on a redrivable event -- since this verb
reaches GitHub and mutates it under `--run`, it was not pointed at a live
repository)

### `nen wake fire`

Fires a wake ALONE on one object by removing then re-applying a label -- the edge-trigger convention several skills rely on to re-fire a label-triggered workflow on, e.g., a conflicted PR -- then posts an optional settle comment.

**Usage**

```text
nen wake fire --repo-slug <owner/name> --ref <object-ref> --label <name> [--comment <text>] [--run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo-slug <owner/name>` | yes | The repository. | |
| `--ref <object-ref>` | yes | `<CODE>-<IS\|PR>-#<N>`; only the trailing `#<N>` is actually used. | Refused if it carries no `#<N>` suffix. |
| `--label <name>` | yes | The label removed then re-applied. | |
| `--comment <text>` | no | A settle comment posted after the re-apply. | |
| `--run` | no | Actually write to GitHub. | Without it, every line is prefixed `(dry run)` and nothing is written. |

**Output and exit codes** -- prints `[(dry run) ]remove label '<label>' from <slug>#<n>`, then the same for re-apply, then the settle-comment line if `--comment` was given, then (without `--run`) `nothing written -- pass --run to fire for real.`. `--json`: `{ repo, number, label, comment, run }`. Exit 0 on success (dry or real); exit 2 when `--ref` carries no `#<N>`; a `--run` write that fails (the label removal, the re-apply, or the comment POST) throws and exits 1 -- these three go through the throwing `must` seam, unlike `wake verify`'s tolerated per-action failures.

**Example**

```bash
nen wake fire --repo-slug zheref/bankai-core --ref "BC-PR-#63" --label bankai:stage/in-review \
  --comment "Re-firing tenma-review after the merge conflict was resolved."
```
```text
(dry run) remove label 'bankai:stage/in-review' from zheref/bankai-core#63
(dry run) re-apply label 'bankai:stage/in-review' to zheref/bankai-core#63
(dry run) post settle comment on zheref/bankai-core#63
nothing written -- pass --run to fire for real.
```
(shape derived from `src/wake/command.ts`'s `fire()` and `src/wake/command.test.ts` -- not run live, this reaches GitHub; the dry-run text itself needs no network and is byte-accurate)

<a id="family-stop"></a>

**`nen stop`**

Renders the gate-stop banner and the padded-markdown efforts table -- the ceremony that says "your input is needed" and shows what is waiting, ported from bankai-core's `scripts/gate_stop.sh` + `scripts/ichigo_prompt.sh` with the embedded python3 removed (there is only ever this one renderer) and with no built-in persona name or ASCII portrait (this repository's own rule against a hard-coded persona in shipped code). It renders rung 4 of a four-rung escalation ladder (an OS notification and an audible cue, rungs 2-3, are NOT fired -- nen only ever shells out to `git`/`gh`, neither of which is a notification primitive) and states rung 1's status, which is the caller's to have actually fired.

### `nen stop`

Prints the banner (who is asking, which gate, whether the push-notification rung was already fired) followed by a table read from a markdown pipe-table file (or stdin via `-`). `--template` instead emits a blank 5-column table to fill in, with no banner and no signal line -- nothing is being waited on yet.

**Usage**

```text
nen stop [--who <name>] [--gate G1|G1-M|G2|G3|G4|G5] [--notified] [efforts.md | -]
nen stop --template
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--who <name>` | no | Who is asking, stated by the caller. | Nen ships no built-in persona name. |
| `--gate <g>` | no | The human gate being asked for: `G1` epic approval, `G1-M` release into build, `G2` merge, `G3` release go/no-go, `G4` policy/spec change, `G5` decision/human-only action. | An unrecognised gate name is refused (exit 2). |
| `--notified` | no | States rung 1 (push notification) was already fired by the caller. | Nen never fires it itself. |
| `efforts.md \| -` (positional) | no | A markdown pipe table (header + rows) to render below the banner; `-` reads stdin. | Resolved against `--repo` (default cwd) when a relative path is given. |
| `--template` | no | Emit a blank 5-column table (`Effort`, `Open issues & PRs`, `Status (gate)`, `Thought flow`, `Session / lane`) instead of the banner. | Mutually exclusive in effect with the banner mode -- no signal line is printed, since nothing is being waited on. |

**Output and exit codes** -- the banner is `=== YOUR INPUT IS NEEDED ===...`, then `who:`/`gate:` lines if given, the rung-1/rung-2-3 status lines, then the rendered padded-markdown table (or nothing, with a note that "no banner above => nothing needs you right now" -- though the banner itself is unconditional whenever this command runs without `--template`). `--json`: `{ template: true, rows }` for `--template`; otherwise `{ who, gate, notified, rows }` (the banner text itself is not part of the JSON -- only the structured fields are). Exit 0 on a normal render; exit 2 on an unrecognised `--gate` value, or when the `efforts.md`/`-` argument names a file that cannot be read.

**Example**

```bash
nen stop --who Ichigo --gate G2 --notified efforts.md
```
```text
=== YOUR INPUT IS NEEDED ==============================
who: Ichigo
gate: G2 -- merge
rung 1 (push notification): reported sent by the caller.
rungs 2-3 (OS notification, audible cue): not fired by nen -- only git/gh subprocesses are ever shelled out to.
see the table below. No banner above => nothing needs you right now.

| Effort                     | Open issues & PRs | Status (gate)  | Thought flow                        | Session / lane         |
| -------------------------- | ----------------- | -------------- | ----------------------------------- | ---------------------- |
| issue comment verb         | #29, PR #75       | in review (G2) | wired the general comment primitive | p2/29-issue-comment    |
| watch classifier allowlist | #31, PR #74       | merged (G2)    | closed the metachar guard gap       | p2/31-watch-classifier |
```
(run for real, against a local `efforts.md` authored for this example — the table above is the renderer's own padded output, byte for byte)

## Developer workflows

Six end-to-end scenarios, composed only from verbs that exist in v0.2.0. Every
command below is real; where a step needs a repository registry, the examples
point at this repository's own bundled fixture
(`src/schema/fixtures/bankai-repo`) so they run without a target repository.
Nen supplies the evidence at each step — the decision after it is yours.

### Is this pull request ready to merge?

Start with the verdict, then ask what is in the way, then act on the one thing
the verdict named. `pr ready` is read-only: it never labels, merges or
comments, and a non-zero exit never means "cleared".

```bash
# The verdict alone: exit 0 only on `ready`.
nen pr ready 112 --gh-repo zheref/nen --reviewers copilot,sasuke

# The full conjunct table, in evaluation order, plus what the gate does NOT decide.
nen pr ready 112 --gh-repo zheref/nen --reviewers copilot,sasuke --explain

# The same result for a script: `verdict`, `firstFailing`, `conjuncts[]`,
# and `contract: "nen.pr.ready/v0.1"`.
nen pr ready 112 --gh-repo zheref/nen --reviewers copilot,sasuke --json
```

Look for `verdict`. `ready` exits 0; `not-ready` and `unevaluated` both exit 1,
and `unevaluated` means GitHub could not be read — never that the PR passed.
In a repository that ships `nen/gates.json`, drop `--reviewers` and let the
identities come from the taxonomy instead; `--gates <path>` points at a gates
file somewhere else.

When it is not ready, ask for the single first blocker, in the fixed order
conflict → red required check → owed reviewer round → unresolved thread →
missing body requirement:

```bash
nen pr next-blocker --target zheref/nen --pr 112 --repo . \
  --gates src/schema/fixtures/bankai-repo/nen/gates.json
```

`kind: none` exits 0; anything else exits 1 and the `detail` line names what to
fix. Two follow-ups sharpen the picture:

```bash
# Is this PR stale, and is the one no-human merge permitted?
nen pr staleness --wakes-from wakes.json \
  --last-activity 2026-09-07T18:00:00Z --now 2026-09-07T20:05:00Z --ready

# Does the body satisfy this repository's own template requirements?
nen pr body-check --body-from body.md --requirements-from pr-requirements.json
```

`staleness` always exits 0 — it is a report, and the merge decision behind
`merge PERMITTED (stale + Ready)` is still a human's. `body-check` checks every
requirement rather than stopping at the first miss, and refuses an empty
requirement list rather than reporting a vacuous pass.

Then act on what the blocker was:

```bash
# Checks are red: re-run the failed jobs (never re-label to force a re-vote).
nen run rerun-failed --target zheref/nen --run-id 998877

# Reviews are missing: see who is already requested first ...
nen pr fetch --target zheref/nen --pr 112 --json

# ... then request the rest. This verb has NO --dry-run: the `gh pr edit
# --add-reviewer` call runs immediately, once per name.
nen pr request-reviews --target zheref/nen --pr 112 --add-reviewers copilot,sasuke
```

`pr fetch --json` carries `reviewRequests[]`, so it is the preview
`request-reviews` does not have. Request on the maintainer's own user token — a
bot token silently no-ops on that call, and no verb here can tell which
credential ran it.

### Cut a release and fan it out

A tag is not a release. `tag cut` creates an annotated tag; the binaries and
`SHA256SUMS` a consumer's bootstrap needs exist only once a release has been
published for that tag, which is a step outside this CLI.

```bash
# 1. Which commit is being cut, and is it actually on the trunk?
nen release resolve-target --repo . --token main
```

Look for `an ancestor of the trunk -- safe to cut`. Exit 1 means the resolved
commit is not reachable from `origin/main` — a `checkout` token over a dirty
working tree is refused outright, since uncommitted work is in no commit.

```bash
# 2. Every precondition at once — never just the first failure.
nen release preflight --repo-slug zheref/nen --tag v0.3.0 \
  --range v0.2.0..HEAD --changelog CHANGELOG.md --owner-repo zheref/nen \
  --critical-issues '' --live-chores-from live-chores.json
```

Six rows, each `ok` or `FAIL`. `--critical-issues` and `--live-chores-from`
look optional in the usage line but are required to *pass* their rows: omitting
either reports `not supplied -- not checked` and fails the table. Pass
`--critical-issues ''` to assert there are none, and point `--live-chores-from`
at a file containing `[]` to assert no CON-36 chore is live. A `RELEASE_HOLD`
variable holding anything other than a recognised true/false word fails closed
as a hold.

```bash
# 3. Reconcile the range against the changelog, then collate the fragments.
nen changelog completeness --repo . --range v0.2.0..HEAD \
  --changelog CHANGELOG.md --owner-repo zheref/nen

nen changelog collate --repo . --version v0.3.0 --theme "usage documentation" \
  --changelog CHANGELOG.md --fragment-dir changelog.d          # preview
nen changelog collate --repo . --version v0.3.0 --theme "usage documentation" \
  --changelog CHANGELOG.md --fragment-dir changelog.d --write  # rewrite + delete fragments
```

`completeness` exits 1 listing each `#<n>` with neither a CHANGELOG entry nor a
fragment. `collate` without `--write` touches no file and deletes no fragment;
`--write` is the only thing that rewrites `CHANGELOG.md`.

```bash
# 4. Cut the tag at the exact reconciled commit. --at is never defaulted to HEAD.
nen tag cut --repo . --name v0.3.0 --at 1cf8b04 --message "v0.3.0" --push
```

Without `--push` the tag exists locally only. The cut refuses if the name
already exists locally or on origin, if `--at` is not an ancestor of
`origin/main`, or if either existence check itself could not run.

```bash
# 5. Which registered consumers does this range's workflow churn affect?
nen fanout compute --repo . --range v0.2.0..v0.3.0
nen fanout record --repo . --range v0.2.0..v0.3.0 --ledger fanout-ledger.jsonl
```

Every consumer is a row: `AFFECTED` with the workflow basenames it consumes, or
an explicit `n/a` — an unstated N/A is indistinguishable from an unswept repo.
Both always exit 0; `record` appends one JSON line per consumer for audit and
opens no repin PR itself.

```bash
# 6. On the consumer registry: whose pin is now behind?
nen warmup --repo src/schema/fixtures/bankai-repo --current v0.3.0
```

Look for the stale-pin block and, separately, `no unpinned consumers`. A
consumer recorded with no pin at all fails the run exactly like a stale one,
because an unperformed check must never render as a clean one; the handbook
sweep reports `NOT CHECKED` unless `--questions-from` and `--answers-from` are
both given.

### Onboard a repository's taxonomy

Bring a new repository up to the point where the taxonomy-reading verbs work
against it.

```bash
# 1. Directory skeleton, the trailer-enforcing commit-msg hook, a canon-values template.
nen scaffold init --repo /path/to/new-consumer --directories src,tests,docs \
  --agent-trailer Agent-Name --run-trailer Run-Id --marker-env NEN_AUTOMATED \
  --canon-values-path .claude/canon-values.yml --scenario swiftui-tca-uzf-v2
```

Look for `hook: installed`. A *different* hook already at `--hook-path` is
refused (exit 1) rather than replaced; `--force` backs the existing one up to
`<path>.bak` first. An identical hook is left alone either way.

```bash
# 2. Can the four taxonomy files be read at all?
nen schema check --repo /path/to/new-consumer
```

One line per file. The three required files (labels, repos, colors) failing
fails the report; an absent `gates.json` does not, but a present-and-malformed
one does.

```bash
# 3. Push the label set to GitHub — preview, then live.
nen labels sync --target owner/new-consumer --repo /path/to/new-consumer --dry-run
nen labels sync --target owner/new-consumer --repo /path/to/new-consumer
```

`--dry-run` makes no `gh` call at all. Live, one bad label never aborts the run:
every other label still lands and the failures are named at the end (exit 1).

```bash
# 4. Rename in place, preserving every issue association.
nen labels rename --target owner/new-consumer \
  --map "bankai:stage/idea=stage:idea,bankai:stage/building=stage:building" --dry-run
```

Each mapping reports `renamed`, `already-done`, `would-rename` or `failed`. It
is idempotent, so re-running the same map is always safe — but note that even
`--dry-run` calls `gh label list` to decide idempotence, so it needs a token.

```bash
# 5. Does the colour precedence resolve the way the repository declared it?
nen color status --repo /path/to/new-consumer --present ready_g1,blocked --category status
```

The first value in the category's declared `precedence` that is present wins;
every other present value is reported `outranked`. Nothing resolvable exits 1
rather than picking arbitrarily.

```bash
# 6. Which handbooks does this repository load, and is its rule mirror current?
nen canon resolve --repo /path/to/new-consumer --target owner/new-consumer \
  --always-load handbooks/uzf-core.md,handbooks/security-baseline.md \
  --stack-dir handbooks/stacks

nen canon mirror generate --rules-dir handbooks/rules \
  --canon-values .claude/canon-values.yml --out-dir .claude/mirror --ref v0.3.0 \
  --header-template "<!-- GENERATED from {file} at {ref} for {scenario}; do not edit -->" \
  --not-mirrored README.md

nen canon mirror check --rules-dir handbooks/rules \
  --canon-values .claude/canon-values.yml --mirror-dir .claude/mirror --ref v0.3.0 \
  --header-template "<!-- GENERATED from {file} at {ref} for {scenario}; do not edit -->" \
  --header-pattern "GENERATED from (?<file>\S+) at (?<ref>\S+) for (?<scenario>\S+)" \
  --not-mirrored README.md
```

`resolve` prints the always-load set plus exactly one stack handbook, derived
from the scenario `nen/repos.json` records for the target. `mirror check`
writes nothing and is the CI half: it exits 1 on any `missing`, `extra`,
`stale` or `hand-edited` file, and `--header-pattern` is what tells a moved ref
(`stale`) from an edited mirror file (`hand-edited`).

### Triage and file work

Reconcile against the backlog before writing to it, then file, attach and
order.

```bash
# 1. Four duplicate searches, each reported with what it was for.
nen issue search --target zheref/nen \
  --subject "wake verify swallows a paginated PR comment thread" \
  --files src/wake/command.ts,src/wake/detect.ts --rule-ids CON-38
```

A pass with no terms reports `skipped`, never nothing — "ran three passes" and
"ran four and found nothing" must read differently. Exit 1 the instant any pass
could not run at all. Watch for `exact title match (normalized)`: that is a
duplicate, not a neighbour.

```bash
# 2. The guard before any close: does a candidate carry an OPEN PR?
nen issue open-pr-check --target zheref/nen --issues 41,52,60
```

Exit 1 when anything is blocked, so a shell loop stops rather than closing past
the guard. This is the same check `consolidate-close` runs internally; it is
exposed here so you can run it first.

```bash
# 3. File it — labels and assignee IN the create call, never a follow-up edit.
#    --body-file is relative to THIS shell, not to --repo: see below.
nen issue file --target zheref/nen --repo src/schema/fixtures/bankai-repo \
  --title "wake verify does not paginate PR comments past one page" \
  --body-file ./body.md --label bankai:stage/idea,bankai:severity/medium \
  --assignee zheref --dry-run

# An idea instead: same choreography, plus a read-back that diffs
# title/body/labels against what was submitted. NOTE: no --dry-run exists
# here — this one files for real.
nen idea file --target zheref/nen --repo src/schema/fixtures/bankai-repo \
  --title "Consider a --paginate flag on wake verify's gh api reads" \
  --body-file ./idea-body.md --label bankai:stage/idea --assignee zheref
```

`issue file --dry-run` prints the exact `gh issue create` argv and makes no
network call at all. There is no `--body`: a body typed on the command line is
a body nobody reviewed. Every label is checked against `--repo`'s
`nen/labels.json` first, because GitHub would silently *create* an unknown
label rather than refuse. `idea file` looks for `read-back OK`; any mismatch
exits 1, and so does a read-back that lands on a pull request — and it has no
`--dry-run`, so run it only when you mean to file.

Two different bases are in play in that block, which is why the body paths are
spelled `./`. `--repo` points at the bundled fixture because that is where
`nen/labels.json` lives; `--body-file` does **not** resolve against it.
`issue file` never opens the body at all — the path goes into the `gh issue
create` argv verbatim, so `gh`'s own working directory resolves it (the
dry-run above prints `--body-file ./body.md` unchanged) — and `idea file`
reads it with a bare `readFileSync`, against this process's directory. See
[Relative paths resolve against two different
bases](#relative-paths-resolve-against-two-different-bases).

```bash
# 4. Fold the neighbours in: attach, then close with a comment.
nen issue attach-sub --target zheref/nen --parent 12 --children 41,52 --dry-run

nen issue consolidate-close --target zheref/nen --repo src/schema/fixtures/bankai-repo \
  --parent 12 --children 41,52 --severity-family bankai:severity \
  --close-comment "Folded into #{parent} -- see its own body for the combined evidence." \
  --dry-run
```

Both certify `--parent` and every child as an *issue*, never a pull request,
before the first write — GitHub numbers both in one sequence off the same
endpoint, so attaching a PR as a sub-issue would succeed and be invisible
afterwards. A mixed list attaches nothing. `--severity-family` names the one
label family reduced to its strongest label instead of unioned; omit it and the
verb refuses rather than silently putting two severities on the parent. Neither
`--dry-run` here is network-free.

```bash
# 5. Where is this issue on its delivery chain, and what ends its run?
nen issue chain-position --target zheref/nen --issue 41 \
  --chain-labels idea=bankai:stage/idea,building=bankai:stage/building,epic=bankai:epic

nen issue terminus --target zheref/nen --issue 12 \
  --chain-labels epic=bankai:epic,approved-team=bankai:stage/approved-team \
  --integration-prefix release/ --trunk main

# And say something on it, in your own words.
nen issue comment --target zheref/nen --issue 90 \
  --body-file comment.md --dry-run
```

Both classifiers refuse a pull-request number and exit 1 on `undecidable` — a
refusal, not a result. An unmapped role is reported as unmapped, never guessed.
`issue comment` deliberately *does* accept a PR number, and its `--dry-run`
prints the exact bytes it would post, including whether the body ends with a
newline.

```bash
# 6. What does the epic release next, and what does the whole backlog look like?
nen epic next-wave --body-file epic-body.md --citation CON-25 \
  --completed 101 --inflight 102 --cap 2 --out epic-out.md

nen backlog fetch --repo-slug zheref/nen --limit 200 --json > rows.json

# order-rows.json and board-rows.json are the CALLER's files, reshaped from
# rows.json -- neither is any verb's output. See below.
nen backlog order --rows-from order-rows.json --severity-order critical,high,medium,low --blocks 98

nen board build --repo-slug zheref/nen --rows-from board-rows.json --json > board.json
nen board render --board-from board.json
nen board diff --before board-before.json --after board.json
```

`next-wave` reports unparsed checkbox lines loudly and refuses outright on a
duplicate child id — it never writes `--out` when it refuses. `backlog fetch`
paginates past GitHub's 100-row page clamp and always reports a `--limit` cap
as `TRUNCATED`. `board build`, `render`, and `diff` all validate every row at the
JSON boundary (`refs` must be an array) — fixed in #99 (issue #92).

These verbs deliberately do **not** compose by file on their own. `backlog
fetch --json` emits `{issueNumber, title, labels, prNumbers, createdAt}` rows
*inside an object*; [`backlog order`](#nen-backlog-order) takes a JSON **array**
of `{id, severity, blocksOther, affectsConsumers, createdAt, number}`, and
[`board build`](#nen-board-build) a JSON array of BoardRow — `{id, title, refs,
gate, status, needs}`, its `gate` from [`gate derive`](#nen-gate-derive) and its
`status` from [`color status`](#nen-color-status). Reading a severity out of
labels, deciding which rows block another, and deciding what a row needs next
are judgement calls, so both reshapes belong to the caller — a skill or a
script — not to these verbs. Handing `fetch`'s output straight to `order` today
crashes with `{} is not iterable` instead of refusing with that explanation:
[zheref/nen#105](https://github.com/zheref/nen/issues/105).

```bash
# 7. Classify the efforts, then check whether there is room to start another.
nen effort classify --input efforts-input.json
nen loop slots --efforts efforts.json --local-cap 2
```

`effort classify` always exits 0, even on `state-machine-violation` — two stage
labels at once is flagged, never resolved by guessing. `loop slots` exits 1 when
either plane is fully occupied, so a caller can stop starting work without
re-reading the report; `--local-cap` has no default, because a guard must be
chosen rather than inherited.

### Keep a working copy honest before a PR

Five checks and a stop, before anything is staged.

```bash
# 1. Where does this working copy sit?
nen wc classify --repo .
```

`must-move` (dirty on the trunk), `on-branch-dirty`, or `on-branch-clean`. A
git command that *fails* — a detached HEAD, an unresolvable `--base` — is
reported as an error at exit 1, never folded into one of the three cases as an
empty reading.

```bash
# 2. What should never be staged blind?
nen stage triage --repo . --scope "src/,docs/" --mentions "$(cat commit-draft.txt)"
```

Exit 1 whenever anything is flagged: a secret-shaped name, a git-ignored file, a
binary, a path outside `--scope`, or a deleted path your draft never mentions.
The yes to stage a flagged file is always yours.

```bash
# 3. Shape the commit message.
nen commit format --type docs --scope usage \
  --subject "document every verb and the workflows they compose" \
  --trailer "Closes=#90"
```

Shape only — a declared type, a non-empty subject, the whole header line at or
under 72 characters, no trailing sentence punctuation. What changed and why
stays yours to write. Any shape violation exits 2.

```bash
# 4. Which human gate does this diff sit at?
nen gate derive --repo . --policy-paths "schemas/,CONSTITUTION.md" \
  --process-paths ".github/workflows/,scripts/" --range main..HEAD --asserted G2
```

A hit in either path set derives G4; a miss on both derives G2. When
`--asserted` disagrees, the disagreement is reported and the *derived* gate
stands. Both path sets explicitly empty exits 1 — that derivation would be
vacuous. This is the diff's half only: a PR that is not ready has no gate at
all.

```bash
# 5. If the work was split by axis, prove nothing was left behind.
git diff main > original.diff
git diff main...axis-pr > axis-pr.diff
git diff main...axis-gate > axis-gate.diff
nen split verify --original original.diff --branches axis-pr.diff,axis-gate.diff
```

Every hunk in the original must land in exactly one branch with the same body.
`MISSING` is a hunk in no PR at all; `ALTERED` is a header match with a
different body. An original naming zero hunks is refused rather than passed.

```bash
# 6. Hand it over.
nen stop --who Ichigo --gate G2 --notified efforts.md
```

The banner plus the efforts table. `--template` emits a blank five-column table
instead, with no banner — nothing is being waited on yet. Nen renders rung 4 of
the escalation ladder and states rung 1's status; it never fires an OS
notification or an audible cue, because it only ever shells out to `git` and
`gh`.

### Bootstrap nen in CI and watch a command

```bash
# 1. Two-step fetch, pinned. Never `latest`.
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.2.0/bootstrap/nen.sh -o nen-bootstrap.sh
nen="$(bash nen-bootstrap.sh --ref v0.2.0)"
"$nen" --version
```

Stdout carries only the verified path, so `$(...)` is the whole integration.
Retry only on exit `4`; `5` and `6` are integrity failures and must never be
retried. Once a `nen` exists, the in-CLI form pins a second one — pass
`--script` when the binary is running outside any checkout, since it cannot
find `bootstrap/nen.sh` relative to itself:

```bash
nen bootstrap --ref v0.2.0 --source zheref/nen --script ./nen-bootstrap.sh
```

```bash
# 2. Wait for a read-only observation to come true.
nen watch until --command "git status --short" --interval-ms 5000 --max-iterations 12
nen watch until --command "gh pr checks 112" --true-pattern "All checks were successful"
```

The command is spawned directly with no shell and is classified against
izanami's read-only table *before the first run*, so a mutating command is
refused outright rather than run once and then reported on. Three consecutive
observation errors stop the watch regardless of `--max-iterations`: a
permanently broken observation (bad usage, no auth, no such binary) must never
masquerade as "not yet true".

The allowlist is deliberately literal about what it can prove. `gh api` with a
quoted `--jq` argument is refused:

```
$ nen watch until --command "gh api repos/zheref/nen/pulls --jq '.[].number'" --max-iterations 1
nen: 'gh api repos/zheref/nen/pulls --jq '.[].number'' classifies as unknown ...
```

exit 2. The scan walks whitespace tokens, and a quoted or escaped argument is
one word to that walk and something else to a real shell (`-X 'DELETE'` is the
worked example), so only the quote-free form is provably a GET. Drop the quotes
or use a command the table can classify.

```bash
# 3. Check a skill invocation against its published grammar, before running it.
nen parse izanami "gh pr checks 112 until it is green"
nen parse izanagi "retry the flaky build until CI is green up to 3"
nen parse futon --repo src/schema/fixtures/bankai-repo "BC@high+ then tag" --self zheref/bankai-core
```

`parse izanami` classifies every command in the task and refuses the *whole*
run (exit 1) the moment one is mutating or unknown, naming `nen parse izanagi`
as the loop to use instead. `parse izanagi` refuses a line with no `up to <N>`:
the cap is required grammar, not a default. `parse futon` resolves its repo
token against the registry and refuses a `then <terminal>` clause on a
repository that is not the caller's own, which is what keeps a consumer's
invocation from cutting the registry owner's tag.

```bash
# 4. Was a workflow run silently swallowed?
nen wake verify --repo-slug zheref/nen --now 2026-09-07T00:00:00Z \
  --author-pattern '^(kaido-bot|senku-bot)\[bot\]$'

# Edge-trigger one object by removing and re-applying a label.
nen wake fire --repo-slug zheref/nen --ref "BC-PR-#112" --label bankai:stage/in-review \
  --comment "Re-firing review after the merge conflict was resolved."
```

Neither writes anything without `--run` — including `verify`, whose name reads
as an inspection but which reruns workflows and posts comments once it has
permission. `--now` is the sweep's fixed instant rather than the live clock, so
a replay is reproducible, and `--author-pattern` has no default because nen
carries no repository's agent-login list.

```bash
# 5. This repository's own harness.
nen dev test -- src/commit
nen dev lint
nen dev replay
```

`dev test` and `dev lint` are thin spawns of `bun run test` and `bun run lint`,
so they can never drift from what CI runs; everything after `--` is handed
through unparsed. `dev replay` re-runs the imported dedupe corpus slice against
nen's own logic and exits 1 on any disagreement — or on an existing-but-empty
`--slice-dir`, which must never read as a silent 0/0 pass. All three need a
checkout: a compiled binary has no harness to run, and says so by name.

## Day-to-day actions → today's verbs

What a developer does in a day, against what actually ships. The
[`shu`](#family-shu) family closed the headline gap — but read "exists" exactly:
every verb below runs what the target repository **declares** in its
`nen/contract.json`, so it exists for a repository that carries a declaration
nen can read, and for **any** stack that writes one. What varies by stack is how
much of that declaration [`shu detect`](#nen-shu-detect) can propose for you:
the reference pack carries a command for a given verb on a given stack, or it
declines to (`declared-only`, `unsupported`), and `detect` withholds anything it
cannot cross-check against the repository's own `package.json`.
[`docs/STACK-MATRIX.md`](STACK-MATRIX.md) is the cell-by-cell answer.

**Five stacks are proposed end to end today: `nextjs`, `gatsby`,
`gradle-android`, `compose-desktop` and `dotnet-winui`.** For those, `detect`
fills every row of the declaration — a command where the repository's own files
confirm one, and an explicit `{"unsupported": "<the pack's reason>"}` seat where
the pack has none, so the file it writes is one the executor loads with no hand
edit. The other two stacks get the same lane, the same `hosts` block and **their
own** seats — the count differs per stack, because it is the pack's own tally of
cells it has no command for: `nextjs` has 4 and `gatsby` 5, `expo` 7,
`gradle-android` 6, `xcode-ios` 7, `compose-desktop` 9, and `dotnet-winui` 8.

**What changed for the three newest stacks is what `detect` can SEE.** For
`nextjs` and `gatsby` the evidence for an argv is a `package.json` — a declared
dependency, a declared script — and a tree without one gets its command rows
withheld. The two Gradle stacks run through a wrapper the repository **commits**,
so the evidence is a file on disk in the lane, and the only word that varies is
its spelling: `./gradlew` on POSIX, `gradlew.bat` on win32, resolved by `detect`
from the host it is running on. Their remaining withholding is a real one:
`gradle-android`'s `test` row names a module, and the only honest source for a
module name is the lane's own `settings.gradle{,.kts}`.

**`dotnet-winui` is the third, and it reads a second kind of file.** Its
ecosystem has no `package.json` at all, so every row used to be withheld for the
absence of a manifest that was never going to exist. It now reads the project
files themselves — which one a build addresses, whether a test project is
there, where each `ProjectReference` lands, what a `global.json` pins — all of
it stated in the pack rather than in `detect`. Two rows are proposed on that
evidence (`dotnet build`, and `dotnet test` where there is something to test),
`win32` only. **MSIX packaging stays unsupported**, and so does anything whose
project graph reaches outside the repository.

**`expo` is the near miss among the rest and is worth naming**: it *does* carry
one — a realistic Expo repository (an `app.json` with an `expo` key beside a
manifest declaring `expo`) gets `dev` (`expo start`) and `lint` (`expo lint`)
proposed end to end, `build` **never** — the reference `run` row builds *and
launches*, so a `build` mapping would start an application when a script asked
for a compile — and `run` withheld naming both values the repository's own
scripts spell, because `expo run:{platform}` names a native lane neither of
whose halves is the other's default. A **bare-workflow** Expo tree (`ios/` and
`android/` prebuild output committed, as in `zheref/food-diary`) is proposed as
**three** lanes, with the Apple one's shared scheme read and cross-checked
against the project's own targets.

**`xcode-ios` is the honest limit, and it is worth reading for the shape rather
than the stack.** `detect` reads that lane's project and scheme files, answers
`{project}`, `{scheme}` and `{resultBundle}` from them — following each testable's
own `ReferencedContainer` and each scheme's own test plan, so that a target
declared in a local Swift package is never reported as one your project is
missing — and still proposes **no command row on any tree** — because every row the pack carries names a
simulator, and a simulator is a fact about the machine rather than about the
checkout. So the value it delivers is the withheld row's own note: the seven
seats, the darwin-only `hosts` block, and a per-row line saying what nen
answered and what is left for you. `dotnet-winui` reads its own project files
too, so no stack's build system is unread now: this one's limit is the machine
rather than the reader. See [per-stack notes](#nen-shu-detect) under
`shu detect`.

| Action | Exists today? | Verb | Scope |
|---|---|---|---|
| build | **yes — any lane that declares one** | [`shu build`](#nen-shu-build) | Runs the `build` invocation the lane declares, in the lane's `cwd`, with `--dry-run` printing every step first. **`expo` is the one stack `detect` will never propose a `build` for**, and it is a rule rather than a gap: `expo run:*` builds *and launches*, so a `build` mapping would start an application when a script asked for a compile. The seat quotes that reason and the verb refuses at exit 4 with it. Nen's own binaries are still cross-compiled by `bun run build:<target>`, which is a package script, not a nen verb. |
| test | **yes — any lane that declares one** | [`shu test`](#nen-shu-test), [`dev test`](#nen-dev-test) | `shu test` runs a *target project's* declared test invocation; `dev test` still spawns `bun run test` in *this* checkout. |
| ui-test | **yes on `gradle-android` where the plugin is applied; a seat elsewhere** | [`shu ui-test`](#nen-shu-ui-test) | Runs the lane's declared UI/E2E invocation, including the multi-step form. **One stack ships a reference row, and `detect` proposes it where the tree evidences it**: `gradle-android`'s `{gw} verifyPaparazziDebug` — screenshot verification, and recording the baselines is a deliberately separate command the declaration states if it wants it. That row is **gated on the Paparazzi plugin being applied** in one of the lane's module build files: the task is the plugin's, so a lane without it gets a seat carrying the reason rather than a command the build cannot run. Everywhere else the pack proposes no default, and for two different reasons a reader should not conflate: `nextjs` is the *declined-to-choose* case (Playwright as two steps, or a Storybook static build — the observed repositories disagree about what this verb even means), and `gatsby` the *nothing-observed* one. `detect` proposes those as `unsupported` **seats** carrying the pack's own sentence, and the declaration decides. Nen runs no E2E tool of its own; [`quality tooling`](#nen-quality-tooling) *looks up* which one a scenario uses. |
| lint | **yes — any lane that declares one** | [`shu lint`](#nen-shu-lint), [`dev lint`](#nen-dev-lint) | `shu lint` runs a *target project's* declared lint invocation (commonly two steps, in order); `dev lint` still spawns `bun run lint` in *this* checkout. |
| archive | **yes on `gatsby`; a seat elsewhere** | [`shu archive`](#nen-shu-archive) | Runs a lane's declared packaging step. `gatsby` is the one stack whose archive produces a real artifact, and `detect` proposes it — `node <the script your package.json names>` — reading the path out of the repository's own `scripts` block rather than guessing one. Most other lanes declare `{"unsupported": "<why>"}`, and the refusal quotes that sentence at exit 4. `dotnet-winui` is the sharpest case: **MSIX packaging is unsupported and stays so** — it is a Visual Studio gesture needing a platform, a signing identity and a publish profile the repository states nowhere, and the approval that gave that stack a `build` row deliberately did not give it this one. No signing material is ever synthesised. |
| release | **mechanics, plus the verb** | [`shu release`](#nen-shu-release), [`release resolve-target`](#nen-release-resolve-target), [`release preflight`](#nen-release-preflight), [`release self-check`](#nen-release-self-check), [`changelog collate`](#nen-changelog-collate), [`changelog completeness`](#nen-changelog-completeness), [`tag cut`](#nen-tag-cut), [`fanout compute`](#nen-fanout-compute), [`fanout record`](#nen-fanout-record) | `shu release` runs a lane's declared publication step where it has one. The rest is unchanged: preconditions, the changelog, the annotated tag, the consumer fan-out — a tag is not a release. |
| dev (debug run) | **yes — any lane that declares one** | [`shu dev`](#nen-shu-dev) | Starts the lane's declared debug process, long-running, on this terminal. Nen still starts no simulator, emulator, device or daemon of its own. |
| run (production run) | **yes — any lane that declares one** | [`shu run`](#nen-shu-run) | Starts the lane's declared production process, locally and long-running. It is `compose-desktop`'s **only** row — `{gw} run`, the one invocation that lane has, which `detect` proposes end to end. On `expo` it is the verb that *builds and launches* a native lane, which is why `detect` proposes no `build` there and withholds `run` itself until the declaration names a platform — `expo run:{platform}` unedited is exit **2**. [`run rerun-failed`](#nen-run-rerun-failed) is unrelated — it is a CI re-run, and the `run` *family* name is about GitHub Actions runs. |
| deploy | **the verb exists; `--target` is mandatory** | [`shu deploy`](#nen-shu-deploy) | Runs a lane's declared deploy invocation against a **named** target from `project.targets`, with the target's own `args` appended and the variables its `requiresEnv` names asserted (never read). There is no default target, ever — and the destination is resolved **after** the lane, the verb and the host, so a lane whose `deploy` is a seat answers exit 4 with its own reason whatever `--target` says, while a runnable row with no target is exit 2 naming what is declared. `gatsby` is the one stack with a reference deploy row (two steps: the archive, then the pages push, proposed only where the tree declares the publishing tool); `nextjs` has three observed shapes and no default, so `detect` proposes a seat. `detect` proposes `"targets": {}` on every stack and a destination on none. |
| coverage | **yes on a single-package `nextjs` lane** | [`shu coverage`](#nen-shu-coverage) | Runs the lane's declared coverage command. The pack states this row as a shape run **once per package**, so `detect` proposes it only where that resolves to one command it can stand behind: a lane whose `package.json` names itself and declares the task. A **workspace root** is withheld with the members named — which of them, and in what order, is the repository's answer — and a lane that answers `{package}` but declares no such task is withheld naming the task. `xcode-ios`'s two-step row is withheld naming the **simulator**, not the result bundle: the bundle path is the one value `detect` contributes rather than reads (it is an *output*, and nen's own generated output lives under `.nen/`). The note says so, and says four more things a maintainer would otherwise meet as a failure — the path is **lane-relative** (an `ios/` lane writes `ios/.nen/`); `.nen/` is the line [`nen scaffold init`](#nen-scaffold-init) appends to your `.gitignore`, so a repository stood up another way must ignore it itself; `xcodebuild` **refuses an existing `-resultBundlePath`**, so a filled-in row succeeds once and then fails until the previous bundle is deleted or the value carries something per-run; and the value must move in every step of the row at once. **The bundle is not the report.** When you fill that row in, the path to declare under `project.verbs.<lane>.coverage.artifacts` is the file the *second* step's JSON lands in — `xcrun xccov view --report --json` writes to stdout, so redirect it, and give the file a name with `xccov` in it — because an `.xcresult` is a **directory** and the coverage reader recognises a report by its name. What a run produced is then **parsed**: nen reads the first path under the verb's own `artifacts` whose format it recognises — the Istanbul/Vitest JSON summary, `xccov` JSON, Cobertura XML, JaCoCo XML, LCOV — into a total and a row per target, and refuses a report it cannot honestly read (truncated, or claiming more covered lines than lines) by name rather than printing a plausible number for it. `--threshold` reports `met` against the **counts** and never changes the exit code, in either direction. |
| host toolchain | **yes to check; one installer to install** | [`shu tools`](#nen-shu-tools) | Probes every tool `project.toolchain` pins (and nen itself, from `dependency`) and exits 5 when anything is missing or is not the pinned version, naming the exact command per tool. `--install` acts only through `corepack`; every other declared installer is verify-only in this release, reported with its pin for a human to run. |
| start a piece of work (clean, fetch, branch, prove it builds) | **yes — the git half everywhere, the build half where a lane declares one** | [`shu warmup`](#nen-shu-warmup) | One line for the five things a developer does by hand at the start of every task: refuse (or, with `--discard`, destroy) uncommitted work, fetch, fast-forward the trunk, cut the branch **you** name from its fresh tip, then run the lane's declared `build` — and its `test` with `--tests`. The **only** `shu` verb that mutates git state, so `--repo` is required and every step refuses rather than guessing; `--dry-run` prints every git and toolchain command and runs none of them. A repository with no `project` block still gets the git half and exits 0. Not [`warmup`](#nen-warmup), which sweeps a registry for stale pins and reads only. |

The remaining work is tracked in
[zheref/nen#91](https://github.com/zheref/nen/issues/91), *stack-aware developer
verbs*, and it is now the **deploy targets** alone: stack-aware scaffolding and
`coverage`'s report parsing have both landed. Until that one does, deploying
stays with each project's own toolchain — and a repository that writes its own
`nen/contract.json` can drive any stack through `nen shu` today.

**What those verbs can run, per stack, is already written down.**
[`docs/STACK-MATRIX.md`](STACK-MATRIX.md) is the full reference: seven stacks ×
thirteen verbs, each cell either a command cited to the repository it was read
from, `declared-only` (real for the stack, and the observed repositories
disagree about what it means, so no default is proposed), or `unsupported` with
the reason. It is **generated** from the bundled profiles pack
(`profiles/*.json`) by `bun run matrix` and drift-checked in the suite, so it
cannot go stale. The pack is a catalogue, not an authority: `nen shu detect`
reads it to write a **proposal** a human edits, and a source-scan test
(`src/profiles/inertness.test.ts`) keeps every module that can spawn a process
out of it — including `shu`'s own executor.

A command in that page is a **shape**, not a runnable line: `{project}`,
`{scheme}`, `{pm}` and the rest are placeholders your own `nen/contract.json`
substitutes, and the page's *Placeholders* section lists the closed set with
what each one means. One of them — the Gradle wrapper — is resolved by nen from
`process.platform`; every other value comes from your declaration and never
from the pack. `nen shu detect` substitutes the ones it can read out of a
repository's own files — a `package.json`'s `packageManager`, `name` and
`scripts`, and, where the pack says which file answers a token, a project file
such as a `.sln` or a `.csproj` — and **withholds** every row still carrying a
token, with the reason; a token that survived to a spawn is refused rather than
run.
