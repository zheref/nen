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
with the `nen` spelling. This document covers **v0.2.0**: 34 command families,
70 verbs, every flag checked against that release's own `--help`.

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

One inconsistency is worth knowing before it surprises you: a missing
`--target` exits `1` rather than `2` on sixteen verbs — every verb routed
through one of the four families' local `requireTarget()` helpers. See the
note under [`labels sync`](#nen-labels-sync), and
[zheref/nen#93](https://github.com/zheref/nen/issues/93).

### `--dry-run` discipline

Every mutating verb can be asked to print the exact `gh` (or `git`) call it
would make and write nothing. The flag's name follows what the verb does by
default:

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
| [`pr retarget`](#nen-pr-retarget), [`pr request-reviews`](#nen-pr-request-reviews), [`pr cascade-main`](#nen-pr-cascade-main), [`run rerun-failed`](#nen-run-rerun-failed) | no | — | one narrow `gh`/`git` call each, with no preview form |

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
| `nen/contract.json` | optional — `dependency` (what this repository needs *from* nen: the version floor, the pinned ref, the bootstrap) and `project` (its stack declaration: lanes, per-lane verbs, toolchain pins). Parsed and validated; **no verb acts on it yet** | [`schema check`](#nen-schema-check) |

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

All 70 verbs, grouped as the README groups them. **Reads** is what a
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
| [`warmup`](#family-warmup) | [`nen warmup`](#nen-warmup) | detects stale/unpinned consumer versions in the registry, plus an optional handbook-question sweep | nen/repos.json, optional local files | yes |
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
| [`scaffold`](#family-scaffold) | [`nen scaffold init`](#nen-scaffold-init) | create the directory skeleton, install the trailer-enforcing commit-msg hook, and (once) write a canon-values.yml template | writes to disk under --repo (.git/hooks/, canon-values path); no git/gh | yes |
| [`canon`](#family-canon) | [`nen canon resolve`](#nen-canon-resolve) | resolve a target repo's always-load handbook set plus its ONE stack handbook, from the scenario nen/repos.json records for it | nen/repos.json | yes |
| [`canon`](#family-canon) | [`nen canon mirror generate`](#nen-canon-mirror-generate) | substitute every {{TOKEN}} in each canonical rule file into a mirror directory, writing only changed files and deleting orphans | caller-named --rules-dir + --canon-values file; writes --out-dir; no git/gh | yes |
| [`canon`](#family-canon) | [`nen canon mirror check`](#nen-canon-mirror-check) | regenerate the mirror in memory and diff it against the committed --mirror-dir: missing / extra / stale / hand-edited | caller-named --rules-dir + --canon-values + --mirror-dir; no git/gh | yes |
| [`quality`](#family-quality) | [`nen quality tooling`](#nen-quality-tooling) | look up the e2e/adversarial/perf tooling recorded for a scenario in a caller-supplied table | caller's own --table JSON (never a table shipped in nen) | yes |
| [`quality`](#family-quality) | [`nen quality perf-compare`](#nen-quality-perf-compare) | classify a measured-vs-baseline regression at QA-13's fixed 10%/25% thresholds | none (pure arithmetic over the two numbers given) | yes |
| [`quality`](#family-quality) | [`nen quality method-check`](#nen-quality-method-check) | validate a QA-15 method block: device/OS stated, Release with no debugger, n&gt;=5 with the first discarded, median+p90, thermal+network stated | caller's own --input JSON method block | yes |
| [`commit`](#family-commit) | [`nen commit format`](#nen-commit-format) | format and validate ONE Conventional Commits message's shape (type, subject, scope, breaking, trailers) -- never its content | none | yes |
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

The deterministic, scenario-agnostic half of a full project scaffolder: directory layout, the commit-msg hook, and (once) a canon-values template. It never generates scenario-specific project code (mobile-web, mobile-desktop, cross-apple, ...) -- that half of a full scaffolder's role is explicitly out of scope for this verb. It reads nothing from `nen/`; it only writes to the target `--repo`.

### `nen scaffold init`

Creates every `--directories` entry that does not already exist, installs the trailer-enforcing commit-msg hook (a new mechanism, not ported from any prior shell script), and -- only when `--canon-values-path` is given and nothing is there yet -- writes a `canon-values.yml` template ready for `nen canon mirror generate` to consume. `--agent-trailer`/`--run-trailer`/`--marker-env` are caller data (which trailer pair and environment variable mark an automated commit is a convention of the target repository, not a literal this binary ships) and are validated as legal git-trailer-key / shell-identifier shapes, since each is interpolated into the generated hook script.

**Usage**

```text
nen scaffold init --repo <path> [--directories src,tests,docs]
                  --agent-trailer <key> --run-trailer <key> --marker-env <VAR>
                  [--hook-path .git/hooks/commit-msg] [--force]
                  [--canon-values-path .claude/canon-values.yml] [--scenario <name>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The repository being scaffolded. | Listed unbracketed: omitted, exits 2 by name -- never defaults to the cwd, which would scaffold whatever directory the process happened to be standing in. |
| `--directories src,tests,docs` | no | Comma list of directories to create if absent. | |
| `--agent-trailer <key>` | yes | The git trailer key marking the acting agent. | Must match `[A-Za-z0-9][A-Za-z0-9-]*`; refused otherwise. |
| `--run-trailer <key>` | yes | The git trailer key marking the run. | Same shape rule. |
| `--marker-env <VAR>` | yes | The environment variable the hook reads to recognise an automated commit. | Must match `[A-Za-z_][A-Za-z0-9_]*`. |
| `--hook-path <path>` | no | Where the commit-msg hook is installed. | Defaults to `.git/hooks/commit-msg`. |
| `--force` | no | Overwrite a DIFFERENT existing hook at `--hook-path`. | Without it, a foreign hook there is refused (exit 1), not silently replaced; the existing file is backed up to `<path>.bak` first when `--force` is given. A hook with identical generated content is left alone either way. |
| `--canon-values-path <path>` | no | Where to write the canon-values template. | Only written if nothing is already there. |
| `--scenario <name>` | no | Recorded in the canon-values template. | |

**Output and exit codes** -- prints `created directories: <list>` (or `(none -- all already existed)`), `hook: <outcome> (<path>)`, and `canon-values: <path>` if one was written. `--json`: `{ createdDirectories, hookWritten, hookOutcome, hookError?, canonValuesWritten }`, where `hookOutcome` is `installed`, `unchanged`, or `refused`. Exit 0 unless the hook install was refused (a foreign hook without `--force`), which exits 1.

**Example**

```bash
nen scaffold init --repo /tmp/new-consumer --directories src,tests,docs \
  --agent-trailer Agent-Name --run-trailer Run-Id --marker-env NEN_AUTOMATED \
  --canon-values-path .claude/canon-values.yml --scenario swiftui-tca-uzf-v2
```
```text
created directories: /tmp/new-consumer/src, /tmp/new-consumer/tests, /tmp/new-consumer/docs, /tmp/new-consumer/.git/hooks, /tmp/new-consumer/.claude
hook: installed (/tmp/new-consumer/.git/hooks/commit-msg)
canon-values: /tmp/new-consumer/.claude/canon-values.yml
```
(run for real against a scratch directory)

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

What a developer does in a day, against what v0.2.0 actually ships. Nen's verbs
are backlog, readiness and release machinery; it has **no stack-aware build
verbs at all**. Nothing below builds, runs, packages or deploys a project.

| Action | Exists today? | Verb | Scope |
|---|---|---|---|
| build | **no** | — | No verb compiles or packages any project. Nen's own binaries are cross-compiled by `bun run build:<target>` in this repository, which is a package script, not a nen verb. |
| test | **only for nen itself** | [`dev test`](#nen-dev-test) | Spawns `bun run test` (→ vitest) in *this* checkout. There is no verb that runs a target project's test suite. |
| ui-test | **no** | — | No UI/E2E runner of any kind. [`quality tooling`](#nen-quality-tooling) can *look up* which E2E tool a scenario uses, from a table you supply — it runs nothing. |
| lint | **only for nen itself** | [`dev lint`](#nen-dev-lint) | Spawns `bun run lint` (→ eslint) in *this* checkout. No target-project linting. |
| archive | **no** | — | No packaging, signing or artifact-archiving verb. |
| release | **mechanics only** | [`release resolve-target`](#nen-release-resolve-target), [`release preflight`](#nen-release-preflight), [`release self-check`](#nen-release-self-check), [`changelog collate`](#nen-changelog-collate), [`changelog completeness`](#nen-changelog-completeness), [`tag cut`](#nen-tag-cut), [`fanout compute`](#nen-fanout-compute), [`fanout record`](#nen-fanout-record) | Preconditions, the changelog, the annotated tag and the consumer fan-out. No stack build, no artifact upload, and no release publication — a tag is not a release. |
| dev (debug run) | **no** | — | Nothing launches an app, a simulator, a dev server or a debugger. |
| run (production run) | **no** | — | [`run rerun-failed`](#nen-run-rerun-failed) is a CI re-run — `gh run rerun <n> --failed` — not a way to run anything locally. The `run` family name is about GitHub Actions runs. |
| deploy | **no** | — | No deployment verb, and no verb that talks to any deployment target. |

The gap is tracked in [zheref/nen#91](https://github.com/zheref/nen/issues/91),
*stack-aware developer verbs: build / test / ui-test / lint / archive / release
for Xcode, Expo, Next.js and JVM/Kotlin/Android projects*. Until those land,
these actions stay with each project's own toolchain — nen's job is the
backlog, the readiness verdict and the release mechanics around them.

**What those verbs will be able to run, per stack, is already written down.**
[`docs/STACK-MATRIX.md`](STACK-MATRIX.md) is the full reference: seven stacks ×
thirteen verbs, each cell either a command cited to the repository it was read
from, `declared-only` (real for the stack, and the observed repositories
disagree about what it means, so no default is proposed), or `unsupported` with
the reason. It is **generated** from the bundled profiles pack
(`profiles/*.json`) by `bun run matrix` and drift-checked in the suite, so it
cannot go stale. It is reference material only: no verb reads the pack today,
and a source-scan test keeps it that way.

A command in that page is a **shape**, not a runnable line: `{project}`,
`{scheme}`, `{pm}` and the rest are placeholders your own `nen/contract.json`
substitutes, and the page's *Placeholders* section lists the closed set with
what each one means. One of them — the Gradle wrapper — is resolved by nen from
`process.platform`; every other value comes from your declaration and never
from the pack. A token left unsubstituted is refused rather than run.
