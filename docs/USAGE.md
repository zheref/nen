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
with the `nen` spelling. This document covers the **v0.13.0 line** (one new family, `usage`, and five
new verbs, `usage record`, `usage show`, `wc catch-up`, `wc publish`,
`commit write` and `pr open`; the usage ledger, the `steps[]` a `shu` run
leaves on an open phase, the pinned stall rule and the `profile` policy key
arrive with them): 41 command
families, 119 verbs, every flag checked against the binary this repository
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

Seventeen verbs require it by name instead of defaulting, because each one either
mutates or reports on whatever it is pointed at, and a silent cwd default turned
a forgotten flag into a confident wrong answer (zheref/nen#28):
[`pr next-blocker`](#nen-pr-next-blocker),
[`pr cascade-main`](#nen-pr-cascade-main),
[`wc classify`](#nen-wc-classify),
[`wc squash`](#nen-wc-squash),
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
[`canon resolve`](#nen-canon-resolve),
[`parse futon`](#nen-parse-futon) and
[`report data`](#nen-report-data).
Twenty-nine verbs accept it and never read it at all — they work entirely from
the paths and slugs they are handed. Every verb of
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

One verb reads it **conditionally**, which is a third thing again:
[`stop`](#nen-stop) writes under it only with `--mark`.
[`commit format`](#nen-commit-format) used to be the second, opening
[`nen/workflow.json`](#nenworkflowjson) only when the invocation carried a
`--trailer`; it reads the file — and the repository's commitlint config — on
**every** run now, because `commits.subjectCase` can refuse any subject
([#263](https://github.com/zheref/nen/issues/263)).

#### Relative paths resolve against one base: `--repo`'s root

An **absolute** value is always used as-is. A **relative** one resolves against
the root `--repo` names — `--rows-from`, `--board-from`, `--gates`,
`--changelog`, `--fragment-dir`, `--wakes-from`, `--body-from`,
`--requirements-from`, `--ledger`, `--questions-from`, `--answers-from`,
`--tiers`, `--template`, `--data`, `--out`, `--body-file`, `--input`,
`--efforts`, `--original`, `--branches`, `--table`, `--rules-dir`,
`--canon-values`, `--markdown-out`, `--plan`, and every
taxonomy file a verb opens for itself. `--repo` itself defaults to the process's
current directory, so a caller standing in the repository sees no difference
between the two.

**There used to be two bases** ([#100](https://github.com/zheref/nen/issues/100)).
A closed set of "own-path" flags was handed to `readFileSync`/`writeFileSync`
unresolved, so they resolved against the **process's** directory and ignored
`--repo` entirely. Nothing was inconsistent within a single invocation, which is
exactly why it survived: run from the repository root, the two bases are the same
path and the split is invisible. It appeared the moment a caller ran from
somewhere else — a worktree, a wrapper script, a CI step with its own working
directory — and then `--repo ../other --body-file notes.md` read *this* tree's
`notes.md` while every other flag on the same line read the other tree's. An
`ENOENT` is the lucky version of that; the unlucky one is a same-named file that
exists in both.

The root wins, which is the decision
[#86](https://github.com/zheref/nen/issues/86) already made for `--gates`, and
its reasoning generalises without change: every other path a verb reads is
anchored there, and the failure the exception produced was silent and wrong.
Where a path also travels onward — `issue comment`/`issue edit-body` hand
`--body-file` to `gh` — the **resolved** path is what travels, so nen and
`gh` cannot disagree about which file it is. The root is resolved before the
read, so a malformed `--repo` stays the usage error (exit 2) it is rather than
becoming a "could not read" at exit 1 about a file nobody had a path to yet.

### Containment

Every path a declaration states is repo-root-relative, and nen refuses one that
leaves the tree `--repo` pointed at — at exit **2**, before anything is spawned,
read or written, naming the pointer that stated it. The test is against the path
the **kernel would actually reach**, `realpath`-resolved, not against its
spelling: `build/payload` reads as plainly inside the repository and is refused
just the same when `build/` is a symlink to somewhere else — and the refusal
names the link and where it points
([zheref/nen#157](https://github.com/zheref/nen/issues/157)). A symlink that
stays inside the tree is ordinary and allowed — the question is where the path
lands, never whether a link was involved. It holds for
`project.lanes.<lane>.cwd`, a `path` precondition, every `artifacts[i]`, a
[`project.launch.<name>.artifact`](#nen-shu-dev), a step's `stdoutTo`, the
coverage and test reports [`shu coverage`](#nen-shu-coverage) and
[`shu test-report`](#nen-shu-test-report) read back, and — the flag-stated
member of the same family — [`report render --out`](#nen-report-render).
`nen schema check` does **not** answer it: the loader has no filesystem, so a
`cwd` of `../../../../etc` reads as a well-formed declaration and is refused at
the moment of use instead. Pointers are checked at load; paths at use.

### `--target <owner/name>` names the GitHub repository

A verb that calls `gh` needs the repository on GitHub, which is a different
thing from the checkout on disk, so it gets a different flag. `--target
<owner/name>` is the usual spelling — [`pr fetch`](#nen-pr-fetch),
[`pr next-blocker`](#nen-pr-next-blocker), [`pr retarget`](#nen-pr-retarget),
[`pr request-reviews`](#nen-pr-request-reviews),
[`pr edit-body`](#nen-pr-edit-body),
[`pr mark-ready`](#nen-pr-mark-ready),
[`run rerun-failed`](#nen-run-rerun-failed), the whole
[`issue`](#family-issue) family (including
[`issue edit-body`](#nen-issue-edit-body)), [`idea file`](#nen-idea-file),
[`labels sync`](#nen-labels-sync), [`labels rename`](#nen-labels-rename),
[`repo inventory`](#nen-repo-inventory),
[`repo scenario`](#nen-repo-scenario) and the whole [`runner`](#family-runner)
family all take it. Four OTHER spellings cover
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

**Which shapes carry a `contract`, and why not all of them.**
[#79](https://github.com/zheref/nen/issues/79) asked the question directly, so
here is the ruling rather than the silence. A `contract` field is **earned by a
shape a consumer must be able to REFUSE on** — one where reading an unrecognised
document half-understood is worse than not reading it at all. Thirty shapes
qualify today and declare one (thirty-two ids: `nen.stop.mark` and
`nen.runner.plan` each have two versions):

`nen.commit.check/v0.1` · `nen.contract/v0.1` · `nen.issue.edit-body/v0.1` ·
`nen.loop.iterate/v0.1` · `nen.pr.edit-body/v0.1` · `nen.pr.mark-ready/v0.1` · `nen.pr.ready/v0.1` ·
`nen.report.data/v0.1` · `nen.report.render/v0.1` · `nen.scaffold.init/v0.1` ·
`nen.scaffold.new/v0.1` · `nen.shu.<verb>/v0.1` (per executing verb) ·
`nen.shu.coverage/v0.1` · `nen.shu.detect/v0.1` · `nen.shu.evidence/v0.1` ·
`nen.shu.proof/v0.1` · `nen.shu.test-report/v0.1` · `nen.shu.tools/v0.1` ·
`nen.shu.warmup/v0.1` · `nen.stop.mark/v0.1` · `nen.stop.mark/v0.2` · `nen.decisions/v0.1` · `nen.phase.ledger/v0.1` · `nen.repo.classify/v0.1` · `nen.runner.plan/v0.1` · `nen.runner.plan/v0.2` · `nen.surface.capabilities/v0.1` ·
`nen.surface.mirror.check/v0.1` · `nen.surface.mirror.check-installed/v0.1` · `nen.surface.mirror.generate/v0.1` ·
`nen.wc.squash/v0.1` · `nen.workflow/v0.1`

Every one of them is read by a **program** that acts on it: a gate decides a
merge, a hook rings a bell, a scaffolder writes a file, a coverage ladder bands
a row. The rest are **diagnostics a caller reads once** — a verdict, a table, a
plan — where a missing key is visible immediately and an unrecognised one costs
nothing. Stamping a version on all ninety-two would create ninety-two things to
version, ninety-two decisions about what counts as breaking, and no consumer
asking for any of it: a promise nobody made and everybody would then have to
keep. **The rule going forward** is the one above — a new shape gains a
`contract` when something must refuse it, in the same change that gives it that
consumer — and the shape of every `--json` document, contract or not, is stated
in its own section below and held there by `src/cli/json-shape.test.ts`.

Four verbs have no `--json` because they have no result of their own to
render: [`dev test`](#nen-dev-test) and [`dev lint`](#nen-dev-lint) inherit
their subprocess's stdio, [`bootstrap`](#nen-bootstrap) prints only the
verified binary path, and [`report mermaid`](#nen-report-mermaid) prints the
diagram text itself. The last of them **refuses `--json` by name** rather than
accepting and ignoring it; the other three predate that rule and still accept
it silently. And a handful of verbs — [`issue file`](#nen-issue-file),
[`idea file`](#nen-idea-file), [`canon resolve`](#nen-canon-resolve),
[`commit format`](#nen-commit-format) — print refusals as plain `nen: <reason>`
lines even under `--json`: only the success path is machine-shaped, because a
caller that mis-invoked a verb needs the sentence more than it needs a schema.

### Exit codes

**An unknown command or subcommand followed by `--help` exits 2 (v0.11.0, zheref/nen#216).** Through
v0.10.0 `nen bogus --help` printed the global usage at exit 0, so a presence probe by `--help` passed for a
verb that does not exist; now the usage prints on stderr and the code says nothing by that name is here. A
family that declares its subcommands (`phase`, `stop`, `watch`, …) applies the same to `nen <family>
<bogus> --help`.

`0` success, `1` the verb's own refusal or failure, `2` a usage error. The rule
`src/index.ts` states, and the reason the last two are not one code:

> A usage error is deliberately distinct from a failure: "you typed it wrong"
> and "the thing you asked for did not work" want different reactions from a
> caller.

A missing `--target <owner/name>` is a **usage error (exit 2)** on every verb
that requires one, the same as every other required flag. Four families used to
keep a private `requireTarget` that threw a plain error, so sixteen verbs across
`repo`, `labels`, `pr` and `issue` answered a forgotten flag with exit **1** —
"the thing you asked for did not work" — when the truth was "you typed it
wrong", and a retry wrapper honouring that distinction would retry a typo
forever ([#93](https://github.com/zheref/nen/issues/93)). A *malformed* value
(`--target not-a-slug`) is exit 2 too: it is the same mistake -- a typo in a
flag -- and `parseTarget`'s own refusal is re-raised through `parseCallerToken`
with its message intact. It used to be exit 1, which fixing only the absence
would have left as a narrower version of the same inconsistency.

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

`shu` is the only *family* that returns `3` **and** `4` in that table's sense.
Every code above `2` is per verb, and **the same number means different things
in different verbs** — a caller branching on anything above `2` must know which
verb it invoked. The complete list:

| Verb | Code | Meaning |
|---|---|---|
| every [`shu`](#family-shu) verb | `3` / `4` / `5` | the table above; [`shu warmup`](#nen-shu-warmup) passes them through from the build it delegates |
| [`shu coverage`](#nen-shu-coverage) | `6` | `--touched` measured nothing: no touched file joined a report row ([#236](https://github.com/zheref/nen/issues/236)) |
| every [`runner`](#family-runner) verb that calls `gh` | `5` | `gh` could not be started, in `shu`'s sense; a GitHub refusal there is `1`, because this table reserves no code for a network failure |
| [`commit write`](#nen-commit-write) | `3` | committed, and the read-back found a trailer the policy refuses — **injected** by a hook, or carried by the message where git's parser read one nen's did not; the commit is left in place ([#273](https://github.com/zheref/nen/issues/273)) |
| [`wc squash`](#nen-wc-squash) | `3` | squashed, and the read-back found a refused trailer on the fold — as `commit write`'s `3` ([#273](https://github.com/zheref/nen/issues/273)) |
| [`wc swap`](#nen-wc-swap) | `3` | a tree is dirty; nothing moved |
| [`pr threads`](#nen-pr-threads) | `3` / `4` / `5` | the thread is already resolved / no thread with that id / the credential could not authenticate |
| [`pr merge`](#nen-pr-merge) | `5` / `6` | `gh pr merge` refused / `gh` could not be started |
| [`pr ready`](#nen-pr-ready) | `8` | `--require-head` did not match GitHub's head; no verdict |
| [`pr request-reviews`](#nen-pr-request-reviews) | `9` | a bot request GitHub accepted and never recorded |
| [`bootstrap`](#nen-bootstrap) | `3`–`7` | not on the three-code scheme at all: it relays the bootstrap script's own published codes unchanged ([Getting the binary](#getting-the-binary)), and those numbers mean the script's things |

One inconsistency is worth knowing before it surprises you: a missing
`--target` exits `1` rather than `2` on eighteen verbs — every verb routed
through one of the four families' local `requireTarget()` helpers (including
[`issue edit-body`](#nen-issue-edit-body) and
[`pr edit-body`](#nen-pr-edit-body), which reuse the SAME helper as the rest
of their families rather than inventing a one-off exit-2 spelling for
themselves). See the note under [`labels sync`](#nen-labels-sync), and
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
| [`issue edit-body`](#nen-issue-edit-body) | no | `--dry-run` | **still reads GitHub** to certify the number is an issue, not a PR, before printing the byte count and first/last line |
| [`issue attach-sub`](#nen-issue-attach-sub) | no | `--dry-run` | **still reads GitHub** to certify every number is an issue, not a PR |
| [`issue consolidate-close`](#nen-issue-consolidate-close) | no | `--dry-run` | **still reads GitHub** for the object-class check and the open-PR guard |
| [`labels sync`](#nen-labels-sync) | no | `--dry-run` | fully offline |
| [`labels rename`](#nen-labels-rename) | no | `--dry-run` | **still calls `gh label list`** to decide idempotence |
| [`label apply`](#nen-label-apply) | yes | `--run` | the ledger line is written either way, with `outcome: "dry-run"` |
| [`wake verify`](#nen-wake-verify) | yes | `--run` | despite the name, `--run` reruns workflows and posts comments |
| [`wake fire`](#nen-wake-fire) | yes | `--run` | every line is prefixed `(dry run)` without it |
| [`changelog collate`](#nen-changelog-collate) | yes | `--write` | without it, nothing is rewritten and no fragment is deleted |
| [`tag cut`](#nen-tag-cut) | yes | `--push` | the tag is created locally; a tag is never auto-pushed |
| [`canon mirror generate`](#nen-canon-mirror-generate) | no | `--dry-run` | writes into every declared surface's rules location under `--repo`; the dry form reports every write, deletion and foreign file and performs none. [`canon mirror check`](#nen-canon-mirror-check) writes nothing but its `--markdown-out` table (creating that table's parent directory) and refuses `--dry-run` |
| [`scaffold init`](#nen-scaffold-init) | no | `--dry-run` | prints every write, every migration and every refusal, and performs none. It spawns **nothing**, probes included — the closing [`shu tools`](#nen-shu-tools) check is reported as `would check` rather than run, which is why the dry form classifies **read-only** in izanami's table while the bare form classifies **mutating**. `--dry-run --install-tools` is refused at exit 2: one says nothing happens, the other changes the HOST |
| [`scaffold new`](#nen-scaffold-new) | no | `--dry-run` | prints the tree it would write. Even the bare form spawns nothing at all: **every post-step is printed and none is run**, the toolchain check included |
| [`pr retarget`](#nen-pr-retarget), [`pr cascade-main`](#nen-pr-cascade-main), [`run rerun-failed`](#nen-run-rerun-failed) | no | — | one narrow `gh`/`git` call each, with no preview form |
| [`pr edit-body`](#nen-pr-edit-body) | no | `--dry-run` | **still reads GitHub** to certify the number reads as a pull request, before printing the byte count and first/last line |
| [`pr mark-ready`](#nen-pr-mark-ready) | no | `--dry-run` | **still reads GitHub** — the one GraphQL read that certifies the number, its state and its head — so every refusal (not a PR, closed/merged, head mismatch, already ready) answers exactly as the real run would; prints the `markPullRequestReadyForReview` argv and sends nothing |
| [`pr request-reviews`](#nen-pr-request-reviews) | no | `--dry-run` | **still reads GitHub** — resolving every `--add-reviewers` login against the pull request's own known bots and `--target`'s collaborators, so it can print which route each name or `--add-bots` id would go to — but neither `gh pr edit --add-reviewer` nor the `requestReviews` mutation is ever called (zheref/nen#160) |
| [`runner script`](#nen-runner-script), [`runner workflow`](#nen-runner-workflow) | no | `--dry-run` | render and validate, write nothing; neither verb ever runs what it renders -- the host script's launch is the maintainer's |
| [`runner preflight`](#nen-runner-preflight), [`runner enable`](#nen-runner-enable) | no | `--dry-run` | **still reads GitHub** -- the default branch; the run `enable` certifies and the variable's current value -- and dispatches or sets nothing |
| [`shu detect`](#nen-shu-detect) | yes | `--write` | fully offline; refuses to overwrite an existing declaration even with `--write`, and there is no `--force` |
| [`shu build`](#nen-shu-build), [`shu test`](#nen-shu-test), [`shu ui-test`](#nen-shu-ui-test), [`shu lint`](#nen-shu-lint), [`shu archive`](#nen-shu-archive), [`shu release`](#nen-shu-release), [`shu dev`](#nen-shu-dev), [`shu run`](#nen-shu-run), [`shu coverage`](#nen-shu-coverage), [`shu test-report`](#nen-shu-test-report) | no | `--dry-run` | prints every step's exact argv, cwd and env NAMES and spawns **nothing**. All ten are `dry-run-gated` in izanami's automation-policy table: the bare form classifies **mutating** — the argv comes from a file in the *target* repository, and certifying it read-only sight unseen would certify whatever it happens to contain — and the `--dry-run` form classifies **read-only**, because nen renders and spawns nothing whatever that file says. On `dev` and `run`, `--json` is **refused** without `--dry-run`. `coverage` and `test-report` additionally **parse** what their run produced — and their `--dry-run` parses nothing either, so the report sitting on disk from a previous run is never read. `test-report` carries the table's one **second** read gate, `--from-artifacts`, which never reaches the executor at all |
| [`shu deploy`](#nen-shu-deploy) | **yes** | `--run` | the one executing verb in this family that is **dry-run-first**, and the only one whose blast radius is *other people's users*: every other verb here spawns something inside a directory and can be undone by running it again, and a deploy cannot. Without `--run` it prints the fully resolved plan — the destination substituted into the argv, every precondition asserted, each step as `would run:` — and spawns **nothing**, at exit 0. `--dry-run` is the explicit spelling of that same form, and `--run --dry-run` together is exit 2 rather than a guess about which of two contradicting instructions was meant. **Two flags and no single-flag path to acting**: `--target <name>` says *where* (required, no default ever, resolved after the lane, the verb and the host, so a lane that declares no deploy answers its own refusal first) and `--run` says *now*. So this row is `write-flag-gated` on `--run` in izanami's table — like [`label apply`](#nen-label-apply) and [`wake fire`](#nen-wake-fire), and unlike the nine above: the bare form classifies **read-only** because nen spawns nothing whatever the declaration says, which is a property of nen rather than a claim about that file |
| [`shu tools`](#nen-shu-tools) | yes — nen writes nothing, but see the note | `--install` | the **only verb in this CLI whose blast radius is the developer's machine**, and the only row with three izanami answers rather than two. The bare check form spawns the version probes the *target repository* declares, so it classifies **`unknown`** — refused, and honestly labelled "not provably a read" rather than mislabelled "writes"; `--install` classifies **mutating**; and `--dry-run` classifies **read-only**, because that form spawns nothing at all, probes included. `--install --dry-run` is refused anyway: the write flag is decisive, because a read-only claim that hinges on one adjacent token still being present is exactly what the write-flag rule exists for |
| [`stop`](#nen-stop) | **yes** | `--mark` | the banner and the table are a pure render, and this verb fires nothing, ever. `--mark` is its one writing form: `.nen/last-stop.json`, the marker a host hook reads to ring the two rungs nen may not ring itself. So this row is `write-flag-gated` on `--mark` in izanami's table — the bare form is **read-only** because nen provably writes nothing without the flag, which is a property of nen rather than a claim about anybody's file |
| [`shu warmup`](#nen-shu-warmup) | no | `--dry-run` | **the only verb in the `shu` family that mutates git state.** `--dry-run` prints every git command *and* every delegated toolchain command, in order, and runs **none** of them — not even the fetch. Unlike the ten rows above, that form still classifies **mutating** in izanami's table, dry run included: nobody watches a warm-up, so the fail-closed answer costs nothing. `--discard` is its *other* dangerous flag, and it is the destructive one: without it a dirty tree is refused at exit 2 with every path listed, and with it the tree is reset and cleaned (`git reset --hard`, then `git clean -fd`) and then **read again**, refusing at 2 if anything survived — but **never** `git clean -x` and never a second `-f`, because an ignored file is the developer's own cache and a nested repository is not this verb's to delete |

"Still reads GitHub" matters in CI: a dry run of those five needs a token even
though it writes nothing.

### Taxonomy as data

Nen hard-codes no label names, no repository names, no reviewer names and no
colours. Every verb that needs a repository's own vocabulary reads it from that
repository's `nen/` directory, at the path `--repo` names:

| File | What it holds | What reads it |
|---|---|---|
| `nen/labels.json` | the label set — names, colours, descriptions | [`labels sync`](#nen-labels-sync), [`label apply`](#nen-label-apply), [`issue file`](#nen-issue-file), [`issue consolidate-close`](#nen-issue-consolidate-close), [`idea file`](#nen-idea-file), [`schema check`](#nen-schema-check) |
| `nen/repos.json` | the registry — consumers, product codes, per-consumer pins, recorded scenarios, and the **canon pin**: the `pinned` tag on the canonical handbooks repository's `maintained_tools` entry (`CON-13`) | [`repo resolve`](#nen-repo-resolve), [`repo scenario`](#nen-repo-scenario), [`ref format`](#nen-ref-format), [`fanout compute`](#nen-fanout-compute), [`fanout record`](#nen-fanout-record), [`warmup`](#nen-warmup), [`canon resolve`](#nen-canon-resolve), [`canon pin`](#nen-canon-pin), [`canon mirror generate`](#nen-canon-mirror-generate) and [`canon mirror check`](#nen-canon-mirror-check) (the pin, when `--source`/`--ref` are omitted), [`parse futon`](#nen-parse-futon), [`pr ready`](#nen-pr-ready) (ref resolution), [`schema check`](#nen-schema-check) (reports the pin) |
| `nen/colors.yml` | the status-colour precedence for board rendering | [`color status`](#nen-color-status), [`schema check`](#nen-schema-check) |
| `nen/gates.json` | reviewer identities for the readiness check | [`pr ready`](#nen-pr-ready), [`pr next-blocker`](#nen-pr-next-blocker), [`schema check`](#nen-schema-check) |
| `nen/contract.json` | optional — `dependency` (what this repository needs *from* nen: the version floor, the pinned ref, the bootstrap) and `project` (its stack declaration: lanes, per-lane verbs, toolchain pins) | [`shu detect`](#nen-shu-detect) (proposes the `project` block), [`shu build`/`test`/`lint`/…](#family-shu) (every argv they run comes from it), [`shu tools`](#nen-shu-tools) (the `toolchain` pins), [`scaffold init`](#nen-scaffold-init) and [`scaffold new`](#nen-scaffold-new) (write it into absence; `init` also reads `dependency.pinned_ref` for the CI file's ref), [`schema check`](#nen-schema-check) |
| `nen/workflow.json` | optional — the delivery loop's **policy**: the branch template and trunk, the iteration checks, the coverage ladder, the attribution trailers a commit may carry, the declared subject-case rule and body width, the reports directory, the model matrix, the self-hosted runner pools. See [`nen/workflow.json`](#nenworkflowjson) | [`runner`](#family-runner) (the `runners` block), [`commit format`](#nen-commit-format) and [`commit write`](#nen-commit-write) (the trailer policy, `commits.subjectCase` and `commits.bodyMaxLineLength`), [`shu coverage`](#nen-shu-coverage) (the ladder, under `--touched` with no `--threshold`), [`scaffold init`](#nen-scaffold-init) and [`scaffold new`](#nen-scaffold-new) (write it into absence, and generate both git hooks out of it), [`schema check`](#nen-schema-check) |

`nen/` holds committed configuration only. Generated output goes to a
dot-prefixed, gitignored `.nen/`; the two have opposite lifetimes, and the
one-character difference is what keeps a build log out of a review.

**The legacy `schemas/` location — removed in v0.5.0.** Before v0.3 the four
taxonomy files lived in a `schemas/` directory; v0.3.0 through v0.4.0 read
`schemas/` as a fallback when `nen/` did not carry a file, so an un-migrated
repository kept working. That fallback is gone: `nen/` is the only directory
anything ever reads a taxonomy file from. A repository that still carries a
file only under `schemas/` is, from every verb's point of view, the SAME as one
carrying it nowhere — the refusal it gets is the ordinary "no such file" one,
with one addition: it names the legacy copy it found and the way out, **run
`nen scaffold init --accept-detected`** (or copy the file by hand). The
migration path is a verb, not a fallback — see [`scaffold
init`](#nen-scaffold-init) below.

[`schema check`](#nen-schema-check) still reports the migration state, in a
different shape: a REQUIRED file present only under `schemas/` FAILS the check
by the same refusal, and a file that loaded from `nen/` with a `schemas/` copy
still sitting beside it is a *leftover* — a `warn` row naming the copy and the
`git rm` that clears it. It is a `warn`, not a `FAIL`, because `nen/` is the
only file anything reads now: a stale duplicate is clutter to delete, never a
correctness risk, so whether its bytes still agree with `nen/`'s no longer
matters to this check.

The migration table covers the four taxonomy files and nothing else.
`nen/contract.json` and `nen/workflow.json` are new in this line and have
**no** legacy location — no released nen ever read one under `schemas/` — so a
repository's own unrelated file there is never claimed as a nen contract.

**An explicitly pinned path was never covered by the fallback, and still isn't.**
A caller that hard-codes a location — `pr ready --gates schemas/gates.json`, or
`gate derive --policy-paths "schemas/,…"` — is naming a path, and nen takes it
literally: `--gates` does not resolve through `nen/`-vs-`schemas/` at all. Move
those pins along with the files, in the same change; `schema check` will not
warn about them, because it never sees them.

#### `nen/workflow.json`

**Optional, and its absence is a full policy rather than none.** Every key in
it has a default, so a repository that carries no policy file runs under the
same parameters as one whose file states them all — and
[`schema check`](#nen-schema-check) reports the absence as an `ok` row reading
`absent (defaults apply)`, not as a finding. That is deliberately *unlike* the
four taxonomy files, whose absence is a hard refusal: a taxonomy fallback would
make nen report label names this repository does not have, while a policy
default invents nobody's vocabulary. `80` is a number; `main` is a branch name
one line overrides.

It is a **second** file rather than a block inside `nen/contract.json` because
the two have different audiences and different lifetimes. The contract says what
nen *executes* — lanes, argv, toolchain pins, deploy destinations — and changes
when the build changes. This says what the loop's *parameters* are, and changes
when the team's rules do. Nothing in it is ever spawned, and nothing in it names
a program.

```json
{
  "$schema": "nen.workflow/v0.1",
  "branch": { "template": "{model}/{persona}/{descriptor}", "base": "main" },
  "iteration": { "checks": ["build"], "lane": null },
  "tests": { "required": ["test"], "extra": [] },
  "coverage": { "minimum": 80, "recommended": 85, "ideal": 90, "scope": "touched" },
  "launch": { "default": null, "fallback": null },
  "reports": { "dir": "Reports", "retain": "final-only", "template": "rikugan", "captures": "Reports/captures" },
  "notifications": { "rungs": ["push", "os", "sound"], "sound": "Glass", "turn": "rung1" },
  "commits": { "allowedAttributionTrailers": [], "forbiddenTrailers": [], "runTrailer": null, "subjectCase": null, "bodyMaxLineLength": null },
  "monitor": { "maxCycles": 20, "pollSeconds": 300 },
  "models": { "rule": "…", "<surface>": { "<tier>": "<alias>" }, "roles": { "reviewer": "deep" } },
  "review": { "scopes": {} }
}
```

**Two blocks with no default at all, added in v0.12.0** (zheref/nen#220), for
the same reason `models` has none — each would be nen inventing somebody else's
vocabulary. `reports.sections` declares the report VARIANTS: `{ "<variant>": {
"template": "<slug>", "blocks": ["<slug>", …] } }`, read by [`report render
--variant`](#nen-report-render), which injects a presence flag per declared
block so a template writes `{{#if sections.desk}}…{{/if}}`. A variant must name
a template and at least one block, and may not name the same block twice — the
flag is a presence map, so a second mention changes nothing in the render, which
is exactly why it is refused rather than collapsed. `review.scopes` declares the
REVIEWERS: `{ "<scope>": { "persona": "<name>", "tier": "<models tier>",
"budget": <n>, "paths": ["<prefix or glob>", …] } }`, read by [`review
scopes`](#nen-review-scopes). `persona` and `tier` are validated as *names* and
never against a list — a persona belongs to somebody's roster and a tier is a
key of this file's own open `models` matrix — and a scope must claim at least
one path, because a scope that claims nothing can never be raised by any diff.
Both blocks are absent-by-default, and both get a row of their own in [`schema
check`](#nen-schema-check).

That block is the default set, written out: it is exactly what an absent file
means, and exactly what [`scaffold init`](#nen-scaffold-init) writes (with
`iteration.lane` set to the lane it scaffolded, `commits.allowedAttributionTrailers`
set to the one trailer key `--agent-trailer` resolved to — its own default
or a caller override — `commits.runTrailer` set to `--run-trailer`'s key when
one was named, and a starting `models` matrix; it never declares
`commits.subjectCase` or `commits.bodyMaxLineLength`, which are the
repository's call). **Six fields have no default at all** — `models`,
`launch.default`, `iteration.lane`, `commits.runTrailer`,
`commits.subjectCase` and `commits.bodyMaxLineLength` — because each would be
nen inventing a name or a convention rather than a number (the last IS a
number, but it is the repository's own width, and absent it the verbs say what
they assumed instead); they come back empty or `null`.

| Key | What it decides | Read by |
|---|---|---|
| `branch.template` | how a branch is named. **Must contain `{descriptor}`** — every other token is optional, but a template without that one renders the same branch name for every effort this repository ever runs | callers |
| `branch.base` | the trunk a branch is cut from | the generated `pre-commit` hook, which bakes it in and refuses a commit made on that branch |
| `iteration.checks` / `iteration.lane` | which declared verbs an iteration proves, and in which lane | callers |
| `tests.required` / `tests.extra` | which declared verbs a test pass runs | callers |
| `coverage.minimum` / `recommended` / `ideal` / `scope` | the ladder. Whole percentages `0`–`100`, and they must **ascend** — three rungs whose order is the whole of their meaning | callers |
| `launch.default` / `launch.fallback` | which `project.launch` target a bare launch uses. No default ever | callers |
| `reports.sections` | which blocks each report VARIANT renders, and with which template. No default ever | [`report render --variant`](#nen-report-render) |
| `review.scopes` | which reviewer, at which tier, within which budget, over which paths. No default ever | [`review scopes`](#nen-review-scopes) |
| `reports.dir` / `retain` / `template` / `captures` | where reports go. `dir` is what [`scaffold init`](#nen-scaffold-init) appends to `.gitignore`, beside `.nen/` | callers |
| `notifications.rungs` / `sound` | which escalation rungs a host hook fires | host hooks |
| `notifications.turn` | how loud an ORDINARY (no-gate) turn is: `"rung1"` (default) rings only the first rung `rungs` lists, `"all"` rings every rung `rungs` lists on every turn. Never widens what `rungs` grants | host hooks |
| `commits.allowedAttributionTrailers` / `forbiddenTrailers` | which attribution trailers a commit may carry | [`commit format`](#nen-commit-format), the generated `commit-msg` hook |
| `commits.runTrailer` | the trailer key an AUTOMATED commit must ALSO carry, alongside the one attribution trailer the hook requires. Absent (`null`) by default — a run identifier is optional, never itself an attribution trailer, so it is never folded into `allowedAttributionTrailers` | the generated `commit-msg` hook's automated half |
| `commits.subjectCase` | the commitlint `subject-case` rule, **declared as data** ([#263](https://github.com/zheref/nen/issues/263)): the string `"config-conventional"` (`@commitlint/config-conventional`'s published default, `[2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]]`) or an explicit commitlint rule `[level, "always"\|"never", cases]` — level `0`, `1` or `2`; `[0]` alone disables; each case one of the names `@commitlint/ensure` accepts, bare or as `{ "case": …, "when": "never" }`. **Precedence:** a commitlint config the verbs can read as data wins, and this key is then reported as *not applied*; it **binds** where that config is JavaScript/TypeScript (which nen never executes), otherwise unreadable, or absent — level 2 refuses at exit 2, and the output names this file as the rule's source. Any other string (another preset is a JavaScript package), a non-list value, or a tuple commitlint would reject is refused **by pointer** at load, down to the element (`commits.subjectCase[2][0]`). Absent (`null`) by default — no rule is ever assumed | [`commit format`](#nen-commit-format), [`commit write`](#nen-commit-write) |
| `commits.bodyMaxLineLength` | the commitlint `body-max-line-length` WIDTH, **declared as data** ([#290](https://github.com/zheref/nen/issues/290); the maintainer's ruling, "Refuse at 100, declarable"): a whole number of at least 1. **Precedence, as `subjectCase`'s:** a commitlint config the verbs can read as data wins, and this key is then reported as *not applied* — agreeing or **DIFFERING**, both named; it **binds** where that config is JavaScript/TypeScript, otherwise unreadable, or absent — a body line over it is refused at exit 2, and the output names this file as the width's source. Without it, an unreadable config means 100, assumed and binding. **The body only**: `footer-max-line-length` has no declared form. A string, a fraction, a width below 1 or any other value is refused **by pointer** at load (`commits.bodyMaxLineLength`), never coerced. Absent (`null`) by default — no width is ever declared for a repository | [`commit format`](#nen-commit-format) (its `--body` wrap and check), [`commit write`](#nen-commit-write) |
| `monitor.maxCycles` / `pollSeconds` | how long a monitoring loop may run | callers |
| `models.<surface>.<tier>` / `models.roles` / `models.rule` | which model alias a role gets on a surface. An **open** map at both levels — nen checks that every leaf is a string and reads nothing else | callers |
| `profile.default` / `profile.allowed` | which RUN PROFILE a bare turn runs under, and which a caller may ask for (v0.13.0, [#227](https://github.com/zheref/nen/issues/227)). The names are **closed** — `fast`, `standard`, `thorough` — and their meaning is the turn loop's, not nen's: nen refuses a fourth name by pointer, an empty or repeating `allowed`, and a `default` outside `allowed`. Default `{ "default": "standard", "allowed": ["fast", "standard", "thorough"] }`; an `allowed` with no `default` falls back to `standard` when listed, else its first entry | callers ([`schema check`](#nen-schema-check) prints it as the `nen/workflow.json#profile` row) |
| `release.unitPaths` | the release-unit entry list a release unit is bounded to. Each entry is either a STRING (a repo-relative prefix or narrow glob, `src/report/patterns.ts`'s grammar) or an OBJECT `{"path": "<exact file>", "keys": ["<json pointer or dotted key>", ...]}` bounding one exact JSON file to a set of its own leaf keys rather than its whole content (item 4) — `path` matched by exact equality, never a pattern; `keys` a non-empty list of non-empty JSON-pointer or dotted leaf paths. `null` (the key absent) means UNDECLARED, never "everything" or "nothing" — [`release unit-check`](#nen-release-unit-check) and [`nen pr merge`](#nen-pr-merge)'s own unit gate both refuse (naming the key) rather than guess a boundary the repository never drew. A STRING pattern the shared matcher proves claims EVERY path (`**`, `**/*`, and any other pattern that matches a repo-relative path no matter its shape) is refused by pointer too: a release unit that bounds nothing is never what declaring this key is meant to say. `*` (one path segment) is NOT refused -- it claims a single top-level entry, never every path -- and a leading `/` (e.g. `/**`) is refused separately as an invalid absolute pattern, since every path this key is compared against is already repo-relative. No default | [`release unit-check`](#nen-release-unit-check), [`nen pr merge`](#nen-pr-merge) (read from the pull request's BASE commit, never this checkout's own file) |
| `futon.advanceGo` | which repo KINDS (`product` \| `process` \| `library`, `../repo/classify.ts`'s own closed three) a named skill's advance-go step is gated to, keyed by skill name with any `plugin:` prefix stripped and lower-cased. A skill this DECLARED map does not name is UNGATED. When the map itself is EMPTY -- the key absent, the whole file absent, an explicit `{}`, or a body carrying only `$`-prefixed metadata keys (none of which count as a declared skill) -- the gate does not read as "no gate" at all: the built-in `DEFAULT_ADVANCE_GO` policy applies instead, and every step it annotates carries `source: "default"`. A map naming even ONE skill is a genuine declaration and replaces the default wholesale (`source: "declared"`) -- see [`parse futon`](#nen-parse-futon)'s "declared vs. default" section | [`parse futon`](#nen-parse-futon) |
| `runners.naming` / `runners.pools[]` | the self-hosted runner pools [`runner`](#family-runner) acts on (from v0.18.0). `naming` is exactly `{machine}-{consumer}R{slot}` -- the one template this release parses, any other refused naming it -- and may be omitted. Each pool: `id` (a slug, unique), `os` (`Linux`\|`macOS`\|`Windows`) and `arch` (`X64`\|`ARM64`) in GitHub's label case (`windows`, `x64`, `darwin`, `amd64` are refused naming the spelling), `mode` (optional, #333: `service` or `interactive` -- how the runners run on their host; absent is `service` for `Windows` and `Linux` and `interactive` for `macOS`, whose runner is always a LaunchAgent in the user's session. `macOS` + `service` and `Linux` + `interactive` are refused, naming why. An interactive `Windows` pool runs inside a signed-in desktop session, for jobs that drive a real UI, which a service in session 0 cannot), `labels` exactly `["self-hosted", os, arch]`, or `["self-hosted", "Windows", arch, "desktop"]` for an interactive Windows pool (any other extra label is refused: the runner-policy guard admits only the canonical sets, and a bare `self-hosted` would match every runner; `desktop` on a service pool is refused naming the missing `"mode": "interactive"`), `enableVariable` (optional, `^[A-Z][A-Z0-9_]*$` -- the repository variable a gated job reads; absent means the pool's jobs are not variable-gated), `tools` (non-empty, one word each -- they are written into a bash step), `preflightWorkflow` (a `.yml` basename, **one per pool**: the file is rendered for one pool's `runs-on`, and a green run of it is what `runner enable` accepts), and `root` (optional `windows`/`linux`/`darwin` defaults, a `~` expanded at run time, never stored expanded; no quote, `$`, backtick, `;`, `&`, `|` or `%`, because it is written into PowerShell and bash). Two pools with one label set are refused. **No default, ever**: absent, every `runner` verb that needs it refuses at exit 2 naming the key | [`runner`](#family-runner) ([`schema check`](#nen-schema-check) prints it as the `nen/workflow.json#runners` row) |

**Unknown keys are preserved, and near-miss keys are refused *because* they
are.** A key nen has never heard of survives a round trip untouched — the file
is the repository's, and a later release (or its own tooling) may read it. That
is exactly why a key one letter from one nen *does* read is refused by pointer:
`{"coverage": {"minimun": 90}}` is a perfectly-shaped number under a key nothing
reads, so it would be kept, ignored, and the ladder would silently hold the
default the repository was trying to change. The rule is the one
`project.targets` already applies, and it is **not** applied inside `models`,
whose key space is open by design.

**Attribution-shaped is an enumeration, not a pattern.** `Assisted-by`,
`Claude-Session`, `Co-Authored-By`, `Generated-by`, `Generated-with`,
`Reviewed-by` and `Signed-off-by` are the keys nen counts as saying *who or what
produced this commit*, plus every key `commits.forbiddenTrailers` adds. A
repository that wants one of them lists it in
`commits.allowedAttributionTrailers`; everything else — `Closes`, `Refs`, a
project's own agent trailer — is untouched. Matching **ignores case**, because
every tool that reads the finished commit does, and a guard one capital defeats
is not a guard.

##### Two provenance trailers

`Hatsu-Agent` and `Akatsuki-Agent` are two conventional attribution-trailer
keys used across this project's family to record *which plane* made a commit
— never an AI-authorship claim. `Hatsu-Agent` marks a commit made by a
**local** plane: an agent working in a human's own working copy, on that
human's own credentials. `Akatsuki-Agent` marks one made by an **autonomous
CI** plane, running unattended. nen ships **neither** as a default — like
every attribution-shaped key, each is admitted only when a repository's own
`nen/workflow.json` lists it in `commits.allowedAttributionTrailers`. A
repository running both planes lists both:

```json
"commits": { "allowedAttributionTrailers": ["Hatsu-Agent", "Akatsuki-Agent"] }
```

one running only one plane lists only that key; one following neither
convention lists neither, and both keys are refused exactly like any other
unlisted attribution trailer.

**`nen scaffold init`'s own `--agent-trailer` now defaults to `Akatsuki-Agent`
when a caller states none**, since this ruling ratified it as the family's own
CI-plane key — a fresh policy this verb writes into absence therefore admits
`Akatsuki-Agent` unless `--agent-trailer <key>` names a different one. That is
a **CLI default**, not a schema one: `nen/workflow.json`'s own
`commits.allowedAttributionTrailers` still starts empty for any *other* route
to the file (a hand-written one, or one from before this default existed), and
[`schema check`](#nen-schema-check) still reports an absent file as a full
policy admitting nothing. A repository that wants `Hatsu-Agent` too adds it by
hand — `scaffold init` never invents the local-plane key, only the CI-plane
one it now defaults to.

**The generated `commit-msg` hook's automated half is DERIVED from this file,
not merely checked against it.** `nen scaffold init` reads whether an
*existing* `nen/workflow.json` admits the key `--agent-trailer` resolved to
before writing the hook: when it does, the hook requires that trailer (plus
`commits.runTrailer`, when the policy states one) on every automated commit;
when it does **not** — an existing policy whose `allowedAttributionTrailers`
never grew the key an invocation is about to require — the hook's automated
half refuses **every** automated commit outright, naming the missing policy,
rather than checking for a trailer no commit could ever honestly carry. Add
the key to `commits.allowedAttributionTrailers` and re-run `scaffold init` to
regenerate a hook that checks for it instead.

**Two values leave the file and become part of a script**, so both are held to a
shape at load: `branch.base` (a git branch name a shell reads only once) and
every trailer key (`[A-Za-z0-9][A-Za-z0-9-]*`, a git trailer key's own charset).
`reports.dir` and `reports.captures` must be repo-relative with no `..`, since
one of them is appended to a `.gitignore` verbatim.

**There is no legacy `schemas/` location for it.** Like `nen/contract.json`, it
is new in this line, and no released nen ever looked for one elsewhere.

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

The whole test suite runs on Linux and macOS on every change, and on Windows —
the self-hosted pool, under Git Bash — on every change while the pool is
declared online (the repository variable `NEN_WINDOWS_RUNNER` is `online`); with
the variable unset or anything else, the Windows leg is skipped. So
"identically" is a checked claim whenever the pool is online.

Two host-wide rules are defined here, because the host cannot hold the POSIX
form:

- **Paths a message names are the host's own.** A note or refusal that names a
  file by absolute path prints it as the host spells it —
  `C:\Users\me\work\repo\nen\workflow.json` on Windows — so it can be pasted
  back into that host's tools. This holds for every verb (the
  [`commit format`](#nen-commit-format) and [`commit write`](#nen-commit-write)
  commit-policy notes among them), and no verb section repeats it.
- **No executable bit.** NTFS holds only a read-only attribute, so a hook
  script's declared mode is compared in those terms
  ([`surface mirror generate`](#nen-surface-mirror-generate)), and a
  `--hooks-root` is given in the form the surface's `sh` reads — a drive path
  with forward slashes, `C:/Users/…` — since a backslash is refused there.

Other Windows-specific behaviour is a single verb's, and is documented with
that verb: [`shu tools --install`](#nen-shu-tools) refuses the `corepack`
install on `win32`, [`watch until`](#watch-until-quoting) keeps the whole-line
metacharacter check on Windows, and the `dotnet-winui` stack of
[`shu detect`](#nen-shu-detect) declares `win32` as its only host.

### Getting the binary

Each published GitHub release attaches binaries for `linux-x64`,
`darwin-arm64` and `windows-x64` alongside a `SHA256SUMS` manifest. Cutting a
tag does not by itself publish a release, so the assets exist once a release
has actually been published for that tag — not the moment
[`tag cut`](#nen-tag-cut) runs. The release lane attaches them one asset per
step, each bounded and retried, the three binaries first and `SHA256SUMS`
**last** and only once all three are attached. So a release on its first
attach — or one whose attach run ended red, naming the missing assets, before
its manifest went up — has no manifest yet, and the bootstrap refuses it at
exit `6` until the manifest lands rather than trusting an unlisted download. A
re-run over an already-complete release is different: it replaces each asset
in place with the same bytes and leaves the existing `SHA256SUMS` up, so while
it runs one binary can be briefly absent, which the bootstrap reports as its
retryable exit `4` ([#228](https://github.com/zheref/nen/issues/228)). Fetch
the bootstrap script, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.19.0/bootstrap/nen.sh -o nen-bootstrap.sh
bash nen-bootstrap.sh --ref v0.19.0
```

It verifies the downloaded binary against that manifest, caches it under
`${XDG_CACHE_HOME:-$HOME/.cache}/nen`, and prints the path to a verified,
executable binary on stdout and nothing else — so it composes directly:

```bash
nen="$(bash nen-bootstrap.sh --ref v0.19.0)"
"$nen" --version
```

**The checksum proves the bytes, not that they run.** The `darwin-arm64`
binary is ad-hoc-signed **after** `bun build --compile` has appended its
payload (`codesign -s - --force`, in `bun run build:darwin-arm64` through
`src/dev/sign.ts` and again in the release lane), because the linker's own
signature covers only the bytes as linked and the append invalidates it — a
macOS that enforces the signature then kills the process before `main`, exit
137, with a checksum that still matches. Every published `darwin-arm64` from
v0.9.0 to v0.12.0 shipped that way ([#233](https://github.com/zheref/nen/issues/233));
from v0.13.0 the release lane verifies the signature (`codesign -v`) and
**executes** both the darwin and the linux binary (`--version` must print the
tagged `package.json`'s version) before `SHA256SUMS` is written and before
anything is attached. An ad-hoc signature carries no identity and nothing
Gatekeeper trusts; what makes the binary trusted is the checksum this script
verifies, and what makes it run is the signature the lane refuses to ship
without.

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

All 119 verbs, grouped as the README groups them. **Reads** is what a
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
| [`pr`](#family-pr) | [`nen pr cascade-main`](#nen-pr-cascade-main) | merges (never rebases) the trunk into the current branch and pushes on a clean merge, or stops there under `--no-push` | git (fetch/merge/push, reaches origin) | yes |
| [`pr`](#family-pr) | [`nen pr retarget`](#nen-pr-retarget) | gh pr edit --base, for a stacked PR after its predecessor merges | github (gh) | yes |
| [`pr`](#family-pr) | [`nen pr request-reviews`](#nen-pr-request-reviews) | resolves each `--add-reviewers` login as a Bot or a collaborator, then requests it through `gh pr edit --add-reviewer` (User/Team) or GitHub's `requestReviews` mutation (Bot, `botIds`) — the one route `--add-bots` node ids travel too | github (gh api graphql to resolve + request; gh pr edit for the user route) | yes |
| [`pr`](#family-pr) | [`nen pr edit-body`](#nen-pr-edit-body) | replaces a pull request's body outright with a file's bytes, certifying the number IS a pull request before any write | github (gh api read to certify, gh pr edit unless --dry-run) | yes |
| [`pr`](#family-pr) | [`nen pr mark-ready`](#nen-pr-mark-ready) | moves ONE existing draft pull request out of draft through GitHub's `markPullRequestReadyForReview` mutation, after certifying it is an open PR at the pinned head, and reports success only on a not-draft read back — never the CON-32 verdict, which stays `pr ready`'s | github (gh api graphql: one certifying read; the mutation and a read back unless --dry-run) | yes |
| [`pr`](#family-pr) | [`nen pr threads`](#nen-pr-threads) | a pull request's review threads: list them all (paginated to completion, with path, line, author, first comment and url), reply to one, or resolve one | github (gh api graphql: one read walk; one mutation for reply/resolve unless --dry-run) | yes |
| [`pr`](#family-pr) | [`nen pr open`](#nen-pr-open) | open exactly one pull request from a head the remote already holds at the local sha, refusing an unpushed head at exit 2 and reporting an already-open one at exit 1 | git (symbolic-ref, rev-parse, ls-remote), github (gh pr list always; gh pr create unless --dry-run) | yes |
| [`pr`](#family-pr) | [`nen pr merge`](#nen-pr-merge) | the ONE bounded merge: `pr ready` (in-process) + head pin + `pr body-check` (live body, one fetch) + `release unit-check` (policy from the PR's base) + whose-pr, every gate must pass; `gh pr merge --merge --match-head-commit` only under `--run` | github (gh pr view, gh api contents/trees/user, gh pr merge unless plan-only), nen/gates.json, nen/repos.json (a `CODE#n` ref) | yes |
| [`gate`](#family-gate) | [`nen gate derive`](#nen-gate-derive) | derive G2 vs G4 from a changed-file set against two caller-supplied path sets | git diff (for --range), no schema file -- path sets are flags | yes |
| [`split`](#family-split) | [`nen split verify`](#nen-split-verify) | prove the union of per-axis branch diffs equals one original diff | caller-supplied --original/--branches diff files, no git/gh | yes |
| [`wc`](#family-wc) | [`nen wc classify`](#nen-wc-classify) | classify the working copy as must-move / on-branch-dirty / on-branch-clean | git (branch, status, ahead-count) | yes |
| [`wc`](#family-wc) | [`nen wc squash`](#nen-wc-squash) | fold every commit since `git merge-base <onto> HEAD` into one, validated message, refused if dirty / --onto not an ancestor / any commit already on the upstream | git (status, merge-base, log, fetch, reset --soft, commit -F, interpret-trailers --parse --no-divider, config trailer.separators and cat-file commit for the folded commit's trailer read-back -- exit 3 on an injected one, #273), nen/workflow.json under --repo | yes |
| [`wc`](#family-wc) | [`nen wc catch-up`](#nen-wc-catch-up) | fetch `origin/<base>` and rebase (nothing published) or merge (something is) the current branch onto it; stop on a conflict with both sides of every path and the abort line, never picking one; re-run on the same tree to continue a staged resolution, `--abort` to back out | git (status, fetch, rev-list, rebase / merge, diff --diff-filter=U, show :2:/:3:, rebase --continue / commit --no-edit, --abort) | yes |
| [`wc`](#family-wc) | [`nen wc publish`](#nen-wc-publish) | push the current branch **under its own name** to the remote its upstream names (origin, or `--remote`, when it has none), refusing a detached HEAD, the trunk as local name **or as destination**, an upstream of **another name** unless `--set-upstream` (which publishes to `<remote>/<own name>` — `--remote`, else `origin`, else the upstream's remote — and retracks it there), any refspec/force shape, and reporting `needsForce` at exit 1 instead of forcing | git (symbolic-ref, fetch, merge-base, rev-list, push, reaches the upstream's remote) | yes |
| [`wc`](#family-wc) | [`nen wc worktrees`](#nen-wc-worktrees) | list every checkout of the project, core first: core/in mark, branch or detached, uncommitted count, +ahead/-behind against `origin/<base>`, HEAD, last commit and age, path | git (rev-parse --git-common-dir, worktree list, status, rev-list, log) | yes |
| [`wc`](#family-wc) | [`nen wc swap`](#nen-wc-swap) | bring a worktree's committed tree into the core checkout (view: HEAD detached; `--take`: the branch), `--return` it with core's parked work restored, `--status`; core's work parked in a pinned commit, never stashed; exit 3 on a dirty tree | git (worktree list, status, read-tree/add/write-tree/commit-tree through a temporary index, update-ref, reset --hard, clean -fd, checkout, diff) | yes |
| [`stage`](#family-stage) | [`nen stage triage`](#nen-stage-triage) | flag secret-shaped, binary, out-of-scope and unmentioned-deletion files before staging; report git-ignored paths separately, never counted toward the exit code | git status --porcelain | yes |
| [`backlog`](#family-backlog) | [`nen backlog fetch`](#nen-backlog-fetch) | fetches open issues + open PRs fresh over 'gh api' (never cached) and assembles one row per effort | gh (issues, pulls, paginated) | yes |
| [`backlog`](#family-backlog) | [`nen backlog order`](#nen-backlog-order) | applies backlog-loop's severity/blocks/consumer/age priority order to a pre-fetched row set | local file (--rows-from) | yes |
| [`board`](#family-board) | [`nen board build`](#nen-board-build) | assembles a Board from already-computed rows (gate from 'gate derive', colour from 'color status') | local file (--rows-from) | yes |
| [`board`](#family-board) | [`nen board render`](#nen-board-render) | renders a Board snapshot as the padded-markdown table bankai-core's own script established | local file (--board-from) | yes |
| [`board`](#family-board) | [`nen board diff`](#nen-board-diff) | field-level diff of two Board snapshots, by row id | local files (--before, --after) | yes |
| [`epic`](#family-epic) | [`nen epic next-wave`](#nen-epic-next-wave) | flips a completed child, redraws the progress bar, computes the next releasable wave | local file (--body-file), optional write (--out) | yes |
| [`effort`](#family-effort) | [`nen effort classify`](#nen-effort-classify) | classifies one epic/child against senkei's five-class (plus undecidable) taxonomy from caller-supplied facts | local file (--input) | yes |
| [`loop`](#family-loop) | [`nen loop slots`](#nen-loop-slots) | counts how many CI and local concurrency slots are free, from a caller-supplied efforts file and explicit caps | local file (--efforts) | yes |
| [`loop`](#family-loop) | [`nen loop iterate`](#nen-loop-iterate) | claims one iteration of an izanagi loop against its own `up to <N>` cap, refusing the claim past it | `.nen/loop/<id>.json` under --repo (reads and writes) | yes |
| [`phase`](#family-phase) | [`nen phase`](#nen-phase) | records when a workflow phase began and ended for one effort, with the elapsed milliseconds and exit code, in a per-effort ledger | `.nen/phases/<effort>.json` under --repo (reads and writes); no git/gh | yes |
| [`usage`](#family-usage) | [`nen usage`](#nen-usage) | records what a surface and model spent on an effort -- token counts, minutes, the source of the numbers, or `notReported` -- in a per-effort ledger, and shows the ledger with totals per surface and model | `.nen/usage/<effort>.json` under --repo (reads and writes); no git/gh | yes |
| [`warmup`](#family-warmup) | [`nen warmup`](#nen-warmup) | warms a REGISTRY: detects stale/unpinned consumer versions, plus an optional handbook-question sweep. Reads only. Not [`nen shu warmup`](#nen-shu-warmup), which warms a working copy | nen/repos.json, optional local files | yes |
| [`watch`](#family-watch) | [`nen watch until`](#nen-watch-until) | polls one read-only observation command until its condition holds, paced and bounded | whatever --command names (typically git or gh) | yes |
| [`label`](#family-label) | [`nen label apply`](#nen-label-apply) | applies one label to one object and appends a durable, after-the-fact ledger line | nen/labels.json; gh only with --run | yes |
| [`labels`](#family-labels) | [`nen labels sync`](#nen-labels-sync) | creates or updates every taxonomy label on a target repository | nen/labels.json; gh unless --dry-run | yes |
| [`labels`](#family-labels) | [`nen labels rename`](#nen-labels-rename) | renames labels in place, preserving every issue association, idempotently | gh label list (always), gh label edit unless --dry-run | yes |
| [`schema`](#family-schema) | [`nen schema check`](#nen-schema-check) | loads and validates the files a repository is expected to carry under nen/, reporting each one's verdict and any legacy schemas/ leftover | nen/labels.json, repos.json, colors.yml, gates.json, contract.json (optional), workflow.json (optional) | yes |
| [`color`](#family-color) | [`nen color status`](#nen-color-status) | resolves one row's colour token by the repository's own nen/colors.yml precedence | nen/colors.yml | yes |
| [`repo`](#family-repo) | [`nen repo resolve`](#nen-repo-resolve) | resolves a repository token (code, slug, short name, or 'all') against the registry, or the cwd's own origin | nen/repos.json; git (no-token form) | yes |
| [`repo`](#family-repo) | [`nen repo inventory`](#nen-repo-inventory) | senkei's live enumeration: epics + children, integration branches, open PRs | gh (issue list, api sub_issues/branches/compare, pr list) | yes |
| [`repo`](#family-repo) | [`nen repo scenario`](#nen-repo-scenario) | reads back the scenario recorded for one --target in the registry | nen/repos.json | yes |
| [`repo`](#family-repo) | [`nen repo classify`](#nen-repo-classify) | one verdict about a repository: role (canon / consumer / unregistered), kind (product / process / library / unknown), stack, lanes, and the gate a change there stands at | nen/repos.json + nen/contract.json under --repo; `git remote get-url origin` when no --target | yes |
| [`ref`](#family-ref) | [`nen ref format`](#nen-ref-format) | formats the &lt;CODE&gt;-&lt;IS\|PR&gt;-#&lt;N&gt; notation, checking the code against the registry first | nen/repos.json | yes |
| [`ref`](#family-ref) | [`nen ref parse`](#nen-ref-parse) | parses a token in object notation | none | yes |
| [`release`](#family-release) | [`nen release preflight`](#nen-release-preflight) | every getsuga §2 release-cut precondition, checked and reported whole | github (gh variable get, git ls-remote), CHANGELOG.md, changelog.d/, git log --merges, git ls-tree/cat-file (the CHANGELOG's history, for the release-PR allowance) | yes |
| [`release`](#family-release) | [`nen release resolve-target`](#nen-release-resolve-target) | resolve a release token (main/last-commit/checkout/hash/branch) to a SHA and test trunk ancestry | git (fetch/rev-parse/merge-base, reaches origin) | yes |
| [`release`](#family-release) | [`nen release self-check`](#nen-release-self-check) | whether a release PR should list itself in its own range | git (merge-base ancestry, local only) | yes |
| [`release`](#family-release) | [`nen release unit-check`](#nen-release-unit-check) | whether a pull request's changed files stay inside `--repo`'s declared `release.unitPaths` | github (`gh api --paginate --slurp repos/{owner}/{repo}/pulls/{n}/files`), nen/workflow.json, nen/repos.json (a `CODE#n` ref) | yes |
| [`changelog`](#family-changelog) | [`nen changelog fragment-required`](#nen-changelog-fragment-required) | whether a change owes a changelog.d/ fragment (CON-33(a)) | git diff/caller files, CHANGELOG.md at base+head, optional nen/repos.json-shaped --base-repos/--head-repos | yes |
| [`changelog`](#family-changelog) | [`nen changelog collate`](#nen-changelog-collate) | collate every changelog.d/ fragment into a new dated CHANGELOG.md section (CON-33(b)) | changelog.d/, CHANGELOG.md | yes |
| [`changelog`](#family-changelog) | [`nen changelog completeness`](#nen-changelog-completeness) | every PR merged in a range has a CHANGELOG entry or an (un)collated fragment (CON-33(c)), except the range's terminal PR when its merge introduced the dated section | git log --merges, git ls-tree/cat-file (the CHANGELOG's history, for the release-PR allowance), CHANGELOG.md, changelog.d/ | yes |
| [`tag`](#family-tag) | [`nen tag cut`](#nen-tag-cut) | cut an annotated git tag pinned at an explicit SHA, never auto-pushed | git (tag/ls-remote/merge-base; --push also reaches origin) | yes |
| [`fanout`](#family-fanout) | [`nen fanout compute`](#nen-fanout-compute) | which registered consumers (nen/repos.json) are affected by workflows changed in a release range | nen/repos.json, git diff, .github/workflows/ | yes |
| [`fanout`](#family-fanout) | [`nen fanout record`](#nen-fanout-record) | the same computation, appended to an audit ledger file | nen/repos.json, git diff, .github/workflows/, ledger file | yes |
| [`report`](#family-report) | [`nen report data`](#nen-report-data) | one document describing a branch against a base: commits, changed files (with a caller-supplied tier), the evidence seam, the lane's coverage report if it is on disk, the build proof, the last recorded stop, and -- only when one of the five register flags is given -- the issues and pull requests the effort is about | git (rev-parse/symbolic-ref/log/diff), nen/contract.json for the lane, .nen/proof/&lt;lane&gt;.json, .nen/last-stop.json, the declared coverage artifact, a caller-supplied --tiers file; under --target/--prs/--issues/--backlog also github (gh api, gh pr view) and nen's own in-process readiness gate; under --objects-from a caller-supplied file instead | yes |
| [`report`](#family-report) | [`nen report render`](#nen-report-render) | fill a template with a data document and write the result: {{token}}, {{{token}}}, {{#each}}, {{#if}} and nothing else, refusing an unknown token by name; --variant injects a declared variant's section flags and --graph injects a validated architecture-delta graph | caller-named --template + --data (+ --graph) files, nen/workflow.json's reports.sections under --variant; writes --out, inside --repo, unless --dry-run | yes |
| [`report`](#family-report) | [`nen report mermaid`](#nen-report-mermaid) | print the mermaid text for a graph document and nothing else | a caller-named --graph file; writes nothing; no git/gh | no |
| [`review`](#family-review) | [`nen review scopes`](#nen-review-scopes) | which review scopes a branch diff raises, off the repository's own review.scopes block, plus the changed paths no scope claims | nen/workflow.json's review block, git diff --name-only; writes nothing; no gh | yes |
| [`surface`](#family-surface) | [`nen surface mirror generate`](#nen-surface-mirror-generate) | render every &lt;name&gt;/SKILL.md under a skills directory into another agent surface's own layout (codex, cursor, antigravity): the body verbatim but for its relative links, re-aimed for the depth each copy lands at, the frontmatter reduced to the keys that surface documents, invocation mentions respelled, personas written where the surface keeps them — plus, per flag, the surface's hook manifest (`--hooks`), rules file (`--rules`), permission pack (`--permissions`) and model aliases (`--models`), and a `--stamp` in the marker | caller-named --source + --agents directories and pack files; writes --out; no git/gh | yes |
| [`surface`](#family-surface) | [`nen surface mirror check`](#nen-surface-mirror-check) | regenerate that mirror in memory and diff it against the committed --out: missing / extra / stale (generated for another surface, with `--stamp` for another version, or by a build before relative links were re-aimed) / hand-edited — or, with [`--installed`](#nen-surface-mirror-check---installed) in place of --out, against an INSTALLED copy on this host (a plugin cache directory, a consumer's .codex/, .cursor/, .agents/) under its own contract, so a warm-up copies only on drift; `--surface claude-code` compares a plugin tree verbatim | caller-named --source + --agents + --out or --installed; writes nothing at all; no git/gh | yes |
| [`runner`](#family-runner) | [`nen runner inventory`](#nen-runner-inventory) | every self-hosted runner a repository has, each name parsed as `<machine>-<consumer>R<slot>` or runner 0, grouped by the pools `--repo`'s `runners` block declares (online, free) plus the unpooled, and the runner package GitHub offers with its SHA-256 | github (gh api GET runners, every page, and runners/downloads); nen/workflow.json with --repo or --pool | yes |
| [`runner`](#family-runner) | [`nen runner plan`](#nen-runner-plan) | which runners to add: the lowest free slots for a machine and consumer code, install dirs under the root in the host's separators, the service identity (or `ask`), the pool's mode, and the package with its SHA-256 -- the `nen.runner.plan/v0.2` contract, `--out` writes it; on the pool's own host, a stderr warning (exit 0) when the account already runs another repository's runners of different visibility | nen/workflow.json (runners), nen/repos.json (product_codes), github (gh api GET), this host's runner services (powershell Get-CimInstance / systemctl, read-only); writes --out only | yes |
| [`runner`](#family-runner) | [`nen runner script`](#nen-runner-script) | render a plan's host script -- PowerShell 5.1 (elevated; locks the runner root first, asks the password once, mints each token itself, hands both to config.cmd through the environment, never argv; an interactive Windows plan asks no password and registers logon tasks instead of services), bash for Linux (sudo) and macOS (as yourself) -- and print the one launch line; never runs it | a caller-named --plan file; writes --out unless --dry-run; no gh | yes |
| [`runner`](#family-runner) | [`nen runner verify`](#nen-runner-verify) | poll the runners list until every expected name is present, online and labelled; never exits 0 on a partial pass | github (gh api GET runners) | yes |
| [`runner`](#family-runner) | [`nen runner workflow`](#nen-runner-workflow) | render a pool's preflight workflow from a caller's `@@NAME@@` template, refusing a leftover placeholder or invalid YAML, and a changed file without --force | nen/workflow.json (runners), a caller-named --template; writes .github/workflows/<preflightWorkflow> (or --out) unless --dry-run | yes |
| [`runner`](#family-runner) | [`nen runner preflight`](#nen-runner-preflight) | dispatch the pool's preflight workflow, find the run it created by id, and wait for its verdict; a job still queued at the deadline is named -- no free runner picked it up | github (gh repo view, gh run list, gh api GET runs/jobs; gh workflow run unless --dry-run) | yes |
| [`runner`](#family-runner) | [`nen runner enable`](#nen-runner-enable) | set a pool's enable variable only after re-reading a completed, successful run of its own preflight whose jobs asked for its labels, dispatched on the default branch with the default branch's own workflow blob; read back, idempotent | nen/workflow.json (runners), github (gh api GET runs/jobs/contents, gh repo view, gh variable get; gh variable set unless --dry-run) | yes |
| [`surface`](#family-surface) | [`nen surface capabilities`](#nen-surface-capabilities) | what a running session on a surface can do -- picker, subagent, hook events and decision key, worktree isolation, artifact, notify, permissions file and shape, agent model key, rules file and limit, description budget -- as data with a citation per row | nothing; a table this binary ships | yes |
| [`run`](#family-run) | [`nen run rerun-failed`](#nen-run-rerun-failed) | re-run a workflow run's failed jobs (gh run rerun --failed) | github (gh) | yes |
| [`issue`](#family-issue) | [`nen issue search`](#nen-issue-search) | duplicate-search the backlog before filing: four gh passes (open subject, recently-closed subject, files+rule-ids, lane) reported with what each was for | gh (issue list x4) | yes |
| [`issue`](#family-issue) | [`nen issue open-pr-check`](#nen-issue-open-pr-check) | which candidate issues carry an OPEN pull request that closing would orphan | gh (pr list) | yes |
| [`issue`](#family-issue) | [`nen issue file`](#nen-issue-file) | file an issue with labels and assignee IN the create call, refusing any label the target taxonomy does not carry or that a forbidden family names | nen/labels.json; gh (issue create) | yes |
| [`issue`](#family-issue) | [`nen issue comment`](#nen-issue-comment) | post one caller-supplied comment on one issue (or, deliberately, one PR) number | gh (issue comment / api) | yes |
| [`issue`](#family-issue) | [`nen issue attach-sub`](#nen-issue-attach-sub) | attach children as GitHub sub-issues under a parent, certifying every number as an ISSUE (never a PR) before the first write | gh (api reads, sub_issues POST) | yes |
| [`issue`](#family-issue) | [`nen issue consolidate-close`](#nen-issue-consolidate-close) | the file-&gt;attach-&gt;close choreography: union labels, reduce one severity family to its strongest label, guard every child for an open PR, close each with a comment | nen/labels.json; gh (api reads, sub_issues POST, issue close/comment) | yes |
| [`issue`](#family-issue) | [`nen issue chain-position`](#nen-issue-chain-position) | classify where an OPEN issue sits on its delivery chain, from its labels alone | gh (api read) | yes |
| [`issue`](#family-issue) | [`nen issue terminus`](#nen-issue-terminus) | classify which object ends an issue's delivery run (its own PR, each child's PR, or one integration-branch delivery PR) | gh (api read) | yes |
| [`issue`](#family-issue) | [`nen issue edit-body`](#nen-issue-edit-body) | replaces an issue's body outright with a file's bytes, certifying the number is an ISSUE (never a PR) before any write | gh (api read to certify, issue edit unless --dry-run) | yes |
| [`idea`](#family-idea) | [`nen idea file`](#nen-idea-file) | file an idea issue (reusing issue file's own choreography), then read it back over the API and diff title/body/labels against what was submitted | nen/labels.json; gh (issue create + api read) | yes |
| [`scaffold`](#family-scaffold) | [`nen scaffold init`](#nen-scaffold-init) | stand an EXISTING repository up: the directory skeleton, the trailer-enforcing commit-msg hook, the trunk-guarding pre-commit hook, a canon-values.yml template, nen/contract.json's project block, nen/workflow.json's policy, the schemas/-&gt;nen/ copy migration, the stack's CI workflow, .gitignore upkeep, and a closing `shu tools` CHECK that installs nothing | nen/contract.json + nen/workflow.json (both hooks are generated FROM the policy) + the legacy schemas/ copies; the bundled profiles pack and templates/; writes to disk under --repo; spawns the version probes the target declares (never on --dry-run) | yes |
| [`scaffold`](#family-scaffold) | [`nen scaffold new`](#nen-scaffold-new) | write a FRESH tree for one stack into an empty --dir: the template's files with {{name}} substituted, the CI workflow, .gitignore, both git hooks, nen/workflow.json's policy, and nen/contract.json as `shu detect` proposes it off the marker just written -- every post-step PRINTED, none run | the bundled profiles pack and templates/; writes to disk under --dir; spawns nothing at all | yes |
| [`canon`](#family-canon) | [`nen canon resolve`](#nen-canon-resolve) | resolve a target repo's always-load handbook set plus its ONE stack handbook, from the scenario nen/repos.json records for it | nen/repos.json | yes |
| [`canon`](#family-canon) | [`nen canon pin`](#nen-canon-pin) | read the canonical handbooks repository a consumer mirrors and the TAG it is pinned to, from the `pinned` field on that repository's maintained_tools entry -- data a sync checks the canon out at, and a drift check holds the mirror to | nen/repos.json | yes |
| [`canon`](#family-canon) | [`nen canon mirror generate`](#nen-canon-mirror-generate) | render every canonical rule file, {{TOKEN}}s bound, into the rules location of EACH agent surface the consumer declares (a directory of marked files, or one marked block inside AGENTS.md), writing only changed files, deleting marked orphans, refusing to touch a hand-written file | caller-named --rules-dir (a handbooks checkout at the pinned tag) + --canon-values; the surface table (src/surface/rules.ts); writes under --repo; no git/gh | yes |
| [`canon`](#family-canon) | [`nen canon mirror check`](#nen-canon-mirror-check) | render the mirror in memory and diff every declared surface's committed copy against it: ok / missing / extra / stale / hand-edited per file, foreign for the consumer's own | caller-named --rules-dir + --canon-values; the surface table; reads under --repo; --markdown-out writes its table (and its parent directory) there; no git/gh | yes |
| [`quality`](#family-quality) | [`nen quality tooling`](#nen-quality-tooling) | look up the e2e/adversarial/perf tooling recorded for a scenario in a caller-supplied table | caller's own --table JSON (never a table shipped in nen) | yes |
| [`quality`](#family-quality) | [`nen quality perf-compare`](#nen-quality-perf-compare) | classify a measured-vs-baseline regression at QA-13's fixed 10%/25% thresholds | none (pure arithmetic over the two numbers given) | yes |
| [`quality`](#family-quality) | [`nen quality method-check`](#nen-quality-method-check) | validate a QA-15 method block: device/OS stated, Release with no debugger, n&gt;=5 with the first discarded, median+p90, thermal+network stated | caller's own --input JSON method block | yes |
| [`commit`](#family-commit) | [`nen commit format`](#nen-commit-format) | format and validate ONE Conventional Commits message's shape (type, subject, scope, breaking, trailers) the repository's `subject-case` rule (commitlint's own when readable as data, else `commits.subjectCase`), and its body/footer line lengths, wrapping `--body` to them (commitlint's own when readable as data, else `commits.bodyMaxLineLength`, else 100) -- never its content | on every run: nen/workflow.json under --repo (the attribution-trailer policy, commits.subjectCase and commits.bodyMaxLineLength), and the commitlint config commitlint would load from --repo's root (data forms parsed; JS/TS never executed) | yes |
| [`commit`](#family-commit) | [`nen commit check`](#nen-commit-check) | is this working copy the one a green build proved? compares .nen/proof/<lane>.json's tree against the tree now | .nen/proof/<lane>.json under --repo, git (add/rm/write-tree into a scratch index) | yes |
| [`commit`](#family-commit) | [`nen commit write`](#nen-commit-write) | commit the index with a message file validated under `commit format`'s own rules plus every `--trailer`, refusing a red `--require-proof` and an empty index; `git commit -F` is the one write | nen/workflow.json under --repo (the trailer policy, commits.subjectCase and commits.bodyMaxLineLength), the commitlint config at --repo's root (`subject-case`, `body-max-line-length`, `footer-max-line-length`), .nen/proof/<lane>.json and the scratch-index hash under --require-proof, git (diff --cached, commit -F, rev-parse, interpret-trailers --parse --no-divider, config trailer.separators and cat-file commit for the written commit's trailer read-back -- exit 3 on an injected one, #273) | yes |
| [`shu`](#family-shu) | [`nen shu detect`](#nen-shu-detect) | read the markers on disk and PROPOSE a nen/contract.json project block; never writes without --write and never overwrites one | the target repo's own files (framework configs, package.json, project files); writes nen/contract.json only with --write | yes |
| [`shu`](#family-shu) | [`nen shu build`](#nen-shu-build) | compile or assemble a lane, from the invocation its declaration states | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu test`](#nen-shu-test) | run a lane's test suite, from the invocation its declaration states | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu ui-test`](#nen-shu-ui-test) | run a lane's UI/E2E suite, from the invocation its declaration states | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu lint`](#nen-shu-lint) | run a lane's linter and format check, from the invocation its declaration states | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu archive`](#nen-shu-archive) | produce a lane's distributable artifact, where its declaration states one | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu release`](#nen-shu-release) | publish a lane's artifact, where its declaration states a publication step | nen/contract.json (project block); spawns the declared argv unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu dev`](#nen-shu-dev) | start a lane's DEBUG build; long-running, on this terminal. With `--target <name>` it launches a declared DEVICE instead: the declared probe, the verb, then the target's after-steps | nen/contract.json (project block, plus project.launch for `--target`); inherits stdio unless --dry-run; spawns the declared device probe and after-steps only with `--target` | yes |
| [`shu`](#family-shu) | [`nen shu run`](#nen-shu-run) | start a lane's PRODUCTION build locally; long-running, on this terminal. Takes the same optional `--target` | nen/contract.json (project block, plus project.launch for `--target`); inherits stdio unless --dry-run | yes |
| [`shu`](#family-shu) | [`nen shu deploy`](#nen-shu-deploy) | send a build to a declared, NAMED target -- TWO flags and no single-flag path to acting: --target is required and has no default, --run is required before anything is sent, and a lane whose deploy is a seat refuses with its own reason whatever --target says | nen/contract.json (project block + project.targets: the destination's args, the env NAMES it requires, or the sentence saying it has no command line); spawns the declared argv only with --run | yes |
| [`shu`](#family-shu) | [`nen shu coverage`](#nen-shu-coverage) | run a lane's coverage command and PARSE the report it produced into one shape -- totals, per-target rows, and `--threshold`'s `met`, which never moves the exit code; `--touched --base <ref>` narrows the rows to the files a change touched (a git-diff read after the run) and, with `--threshold` absent, bands each row against `nen/workflow.json`'s coverage ladder -- or, where that file is absent, nen's published 80/85/90 defaults -- instead; never gating either way | nen/contract.json (project block); spawns the declared argv unless --dry-run, then READS the report the verb's `artifacts` name (and, under `--touched` with no `--threshold`, `nen/workflow.json` through the shared loader) | yes |
| [`shu`](#family-shu) | [`nen shu test-report`](#nen-shu-test-report) | run a lane's declared TEST command and PARSE the results it produced into one shape -- a row per test and the four counts. It declares nothing of its own: it runs `project.verbs.<lane>.test` and reads THAT row's `artifacts`, one file or a whole directory of XML | nen/contract.json (project block); spawns the declared `test` argv unless --dry-run or --from-artifacts, then READS the results the `test` verb's `artifacts` name | yes |
| [`shu`](#family-shu) | [`nen shu evidence`](#nen-shu-evidence) | match `git diff --name-status <base>...HEAD` against project.evidence.globs, deriving each survivor's suite/scene and grouping suite -> scenes; empty is exit 0, never an error | git diff (through the seam only -- no declared invocation, no lane); nen/contract.json (project.evidence) | yes |
| [`shu`](#family-shu) | [`nen shu tools`](#nen-shu-tools) | check the host toolchain a declaration pins (exit 5 when anything is missing or wrong, exit 7 when nen is behind the dependency block's pinned_ref inside its minimum), and with --install install what corepack can | nen/contract.json (project.toolchain + dependency); spawns each declared version probe unless --dry-run; spawns an installer only with --install | yes |
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
| [`stop`](#family-stop) | [`nen stop`](#nen-stop) | render the gate-stop banner plus a padded-markdown efforts table read from a file/stdin, or (--template) a blank table to fill in; --mark also records the stop for a host hook | a local efforts.md file or stdin; no git/gh. --mark WRITES .nen/last-stop.json under --repo | yes |

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
(`next-blocker`), a trunk cascade-merge (`cascade-main`), a narrow `gh pr
edit` mutation (`retarget`), and reviewer requests routed by resolved kind
(`request-reviews` — `gh pr edit --add-reviewer` for a User/Team, GitHub's
`requestReviews` GraphQL mutation for a Bot), and the one draft-to-ready
transition (`mark-ready` — a write, and never the readiness verdict).
`ready` and `next-blocker`
read reviewer identities from `nen/gates.json` (or an explicit `--gates`
file, or a reduced `--reviewers` set with no default); `ready`'s ref
resolution also reads `nen/repos.json`'s `product_codes`. This family
never merges, labels, or comments on a pull request.

### `nen pr ready`

Reports one pull request's CON-32 readiness: the deterministic gate's
verdict, quoted, plus every conjunct row — `ready`, `FAILED`, or `unknown`
with the missing fact named. It is
read-only: it never labels, merges or comments, and it holds no readiness
*authority* today (the shell gate still does; see the verb's own header for
the shadow-window position). A `<CODE>#<N>` ref is resolved through the
target repository's `nen/repos.json` `product_codes`; a bare number needs
`--gh-repo`. Reviewer identities come from exactly one of `--gates <path>`,
the target repo's `nen/gates.json`, or `--reviewers a,b,c` — there is no
built-in default set, and with none of the three the verb refuses rather than
guessing.

`nen/gates.json` may explicitly set `"approval_policy": "review-round-only"` together with
`"default_approvers": []` when automated readiness requires every configured reviewer round at the
current head but deliberately requires no separate `APPROVED` review. The approval conjunct then
passes with a note stating that policy and that human merge authority remains separate. Missing or
pending rounds and unresolved threads still refuse. Omitting `approval_policy` keeps the default
`"required"` behavior, under which an absent or empty `default_approvers` remains a schema error.

**`--round-policy`, and what changed in zheref/nen#214.** `bounded` (the
default) and `strict` decide how CON-32(b)'s *owed* limb reads a reviewer's
round:

- `strict` — a round only counts when it was posted **at the current head**.
  A remediation push that nothing re-reviews re-opens the owed limb, forever,
  for a reviewer nothing re-requests after the final push.
- `bounded` — a round posted **at any earlier head of the same pull request**
  satisfies the owed limb, provided no *new* review request for that reviewer
  is pending. This is what closes zheref/nen#214: under `review-round-only`
  (or any policy), a Copilot round posted once and never revisited no longer
  gets re-owed on every subsequent head, so a PR whose author pushes a
  remediation commit after a review round can still reach `ready` without a
  third, un-requestable round. This limb only answers "did the reviewer show
  up for this PR at all" — it does **not** decide whether that round's
  findings were addressed. CON-32(d)'s zero-unresolved-threads conjunct (a
  separate row, evaluated regardless of policy) still refuses while a thread
  from that round stays open, and a **fresh** pending review request for the
  same reviewer still re-opens the limb immediately (the *stalled* row below
  is unaffected by this policy and stalls on a fresh pending request precisely
  the same way under either policy). A reviewer marked
  `bounded_policy_exempt: true` in `nen/gates.json` keeps its own, stronger
  exemption ("never wait on this reviewer once nothing is pending, even if it
  never reviewed at all") — `bounded_policy_exempt` and the general `bounded`
  any-head reading are independent knobs.

**The bounded rule, stated precisely.** Under `bounded` (the default) a
reviewer's posted round at ANY earlier head satisfies CON-32(b) unless a
review request naming that reviewer is pending; whether the new head's diff
was reviewed is the CALLER's responsibility — the driving agent requests a
fresh round after every substantive push (which makes a request pending, so
the gate holds until it posts), and CON-32(d) still requires every thread
resolved. `strict` keeps the current-head requirement. A delivery-holistic-pass
reviewer keeps the current-head reading under both policies.

**The stall bound.** A pending review request for a `bounded_policy_exempt`
reviewer, older than the stall bound and never posted, fails the gate loudly:
`not-ready: <reviewer> round stalled — requested <N> min ago and never posted
(CON-32b; re-request it, a user token is required)`. The bound defaults to 30
minutes and can be overridden per repository with `nen/gates.json`'s
`"round_policy": { "stallMinutes": <N> }`:

```json
"round_policy": { "stallMinutes": 15 }
```

Omitting `round_policy` (or `stallMinutes` within it) keeps the built-in
30-minute default.

**Every row is evaluated, not only up to the first failure (zheref/nen#248).**
Through v0.14.0 the gate stopped at the first failing row and printed every
later row `unevaluated`. On zheref/nen#247 that hid two real unresolved review
threads behind a red check that the maintainer had ruled out of scope. Now each row is its
own predicate on its own evidence, asked whether or not an earlier row failed.
**No row's criterion changed**, the verdict is still the whole conjunction,
the first line (`gateLine`) is still the *first* failing row's reason byte for
byte, `firstFailing` is kept, and the exit code is unchanged. What is new is
`failing`, which lists every failed row in order. A row that cannot be computed
names the fact it lacked (`conjuncts[].missing`), for example *no head SHA was read* or
*the check rollup could not be read (row 2 carries the parse error)*, instead of a
blanket `unevaluated`. In `--json` its `status` stays `unevaluated`, so the v0.1
closed set does not move. `--explain` renders it as `unknown`. An `unknown` row is
never a pass: a table with no failure but an unknown row is still `not-ready`.
Two rows can now fail together where they are one fact seen twice. A stalled
round is also an owed one, so rows 3 and 4 both fail and the line is row 3's.
CON-30's carve-out is read whenever the rollup is readable, rather than only
after row 2 passed.

**A skip is not a build, and a draft is never ready (zheref/nen#331; the
maintainer's ruling of 2026-10-02).** CON-32(a) reads each check name's
latest run. `SUCCESS`, `NEUTRAL` and `SKIPPED` are admissible, so a
path-filtered or conditional job that did not apply is not a failure. A
`SKIPPED` or `NEUTRAL` check is admissible **only beside at least one
`SUCCESS`**:

| Latest runs at head | Row 2 (CON-32(a)) |
|---|---|
| every one `SUCCESS` | `ready`, no note |
| at least one `SUCCESS`, the rest `SKIPPED`/`NEUTRAL` | `ready`, with the note `admitted beside a SUCCESS, not verified: <name> (SKIPPED), …` |
| every one `SKIPPED` or `NEUTRAL` | FAILED: `not-ready: no check SUCCEEDED at head (CON-32a) — every latest check was skipped or neutral, so nothing was verified: <name> (SKIPPED), …` |
| any absent, pending, failed, cancelled or unknown | FAILED, unchanged |

A draft pull request fails row 1 (CON-42/1) with `not-ready: the PR is a DRAFT
(CON-42/1) — a draft cannot be merged; mark it ready for review first`, even
when GitHub reports it `MERGEABLE`. An intentional-skip exception is never
inferred from branch protection, and **no mechanism declares one today**:
`--exclude-check` only removes names, and an all-skipped head with its skips
excluded is an empty rollup, which also fails. A declared exception is
zheref/nen#249's to build. **Consumer note:** a repository whose only checks
are conditional (a job-level `if:` that skips on a docs-only change, or jobs
gated on a runner variable) now reads not-ready on such a head; make one job
run and succeed on every head.

**A run that has not started is the latest run of its name
(zheref/nen#317).** A queued run that carries no `startedAt` (`null`, empty,
or gh's zero time `0001-01-01T00:00:00Z`) used to sort *before* an older
`SUCCESS` of the same name, so row 2 read that superseded success. Now a run
with no verdict and no start time is the latest of its name, and row 2 waits
for it. GitHub's own GraphQL stamps a queued run's `startedAt` when it is
queued (recorded on zheref/nen#342, 2026-10-02: `compile`, `QUEUED`,
`startedAt: 2026-10-02T23:02:39Z`), so a live rollup already orders a queued
re-run after the run it repeats. The precedence is a fail-closed guard for the
shapes a hand-built state or gh's rendering can carry. That holds even beside a *later* `SUCCESS` of the same name (two
workflows sharing a job name, or a run stuck behind an offline runner): the
row stays not-ready until the stuck run starts or is cancelled. A run that
already has a verdict, or a start time, sorts as before.

**Which head the verdict is about (zheref/nen#245).** The verdict concerns
**GitHub's current head** for the pull request at the moment the verb reads
it. That is not necessarily your local commit. On zheref/KroApple#577 a `ready`
was decided eight seconds before a push registered, so it judged the parent
commit. Three things make that visible:

- **The judged head is always stated.** The plain output's second line and
  `--explain`'s second line are `judged head: <sha>`. `--json` carries it as the
  top-level `judgedHead`, the same value as `meta.headSha`.
- **A local tip that differs is warned about, in every output mode.** When the
  verb runs inside a checkout of the pull request's **head branch**, the
  branch name must match *and* a remote must name the repository on github.com, since `main` exists
  everywhere. The remote URL is parsed and its host checked (`https`, `ssh`, `git`, or
  scp-style `git@github.com:o/r`, with `ssh.github.com` also accepted), so a trailing-slug
  look-alike such as `github.com.evil/o/r` or a local path does not count. If that checkout's `git rev-parse HEAD` is not GitHub's head, a
  `head mismatch:` warning naming both SHAs goes into `meta.warnings`. The plain
  output and `--explain` print it, and `--json` carries it together with
  `localHead: { branch, sha, matches }`. `localHead` is `null` outside such a
  checkout. The warning never changes the verdict or the exit code.
- **`--require-head <sha>` pins it.** It takes 7–40 hex digits and matches them
  as a case-insensitive prefix of GitHub's head. If GitHub's head is anything
  else, or GitHub answered none, the verb exits **`8`** with status
  `head-mismatch`, prints both SHAs, and prints **no verdict**. A `8` is never
  `ready` or `not-ready`, because the question was about a commit GitHub does not
  hold as the head. The code collides with nothing else this CLI or its
  bootstrap returns (`1`/`2` are every verb's, `3`–`5` are `shu`'s, `wc`'s,
  `commit write`'s and `pr threads`', `5`/`6` are `pr merge`'s, `runner`'s and
  `shu coverage`'s, `9` is `pr request-reviews`', and `3`–`7` are the
  bootstrap script's). Under `--json` the mismatch
  prints its own document with its own contract,
  `nen.pr.ready.head-mismatch/v0.1`, whose keys are `contract`, `status`, `ref`, `repo`, `pr`,
  `requiredHead`, `githubHead`, `message`, `evaluatedAt` and `generator`. It deliberately does
  *not* use a `nen.pr.ready/v0.1` report with an invented verdict. In the other modes the output is one
  stdout line, `<repo>#<pr>: head-mismatch: required <sha>, GitHub's head is <sha>`,
  followed by the reason on stderr. On a match the verdict is exactly what it would be
  without the flag, and `meta.requiredHead` records the flag's value.
  `meta.requiredHead` is non-null **only once verified**. An `unevaluated` report,
  where GitHub was never read, carries `null` even when the flag was given. The verb
  **never waits or retries**. Whether to poll until the head registers is the caller's decision.

**Usage**

```text
nen pr ready <ref> [--explain] [--gh-repo <owner/name>] [--reviewers <a,b,c>] [--approvers <a,b>] [--round-policy strict|bounded] [--exclude-run <id>] [--exclude-check <name>]... [--gates <path>] [--token-env <VAR>] [--require-head <sha>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `<ref>` | yes | `<CODE>#<N>` (the `#` optional) or a bare `<N>` with `--gh-repo` | the shorthand splits at the LONGEST trailing digit run; a code ending in a digit needs the `#` |
| `--gh-repo <owner/name>` | no | the repository, when `<ref>` is a bare number | wins over a code if both are given |
| `--explain` | no | print the full conjunct table plus what the gate does not decide | suppressed by `--json` (the JSON already carries the table) |
| `--reviewers <a,b,c>` | no | the configured reviewer set | also the identity source of last resort — see `--gates`; a file's `round_quorum` still applies |
| `--approvers <a,b>` | no | the approval set, on the `--reviewers` identity path only | omitted defaults to the reviewer set (conservative: everyone must approve), never to "nobody" |
| `--round-policy <p>` | no | `strict` \| `bounded` | default `bounded`; see above |
| `--exclude-run <id>` | no | drop one Actions run's own checks (CON-36 clause 3) | numeric run id; pass only from inside that run's own job |
| `--exclude-check <name>` | no | drop check(s) with this exact name from CON-32(a) before it is evaluated (zheref/hatsu#81) | **repeatable**, one name per occurrence ([zheref/nen#243](https://github.com/zheref/nen/issues/243)); one value may also join names with commas, and a comma inside `()`/`[]`/`{}` is part of the name — see below |
| `--gates <path>` | no | read reviewer identities from this file instead of `nen/gates.json` | a RELATIVE path resolves against `--repo`, never cwd |
| `--token-env <VAR>` | no | env var holding the GitHub token | default `GH_TOKEN`; never read ambiently |
| `--require-head <sha>` | no | judge only this commit: 7–40 hex digits, a case-insensitive prefix of GitHub's head | any other head is exit `8` (`head-mismatch`), both SHAs printed, no verdict; malformed is exit `2` |
| `--repo <path>` | no | the checkout whose `nen/` is read | default cwd |
| `--json` | no | machine contract `nen.pr.ready/v0.1` | — |

**`--exclude-check`, and why it exists (zheref/hatsu#81).** `--exclude-run`
carves out every check one Actions *run* produced, by `detailsUrl` — the right
tool from *inside* that run's own job, where `github.run_id` is available.
`--exclude-check` answers a different shape: a consumer of `nen pr ready`
whose *only* reporting check is its own prior `readiness` check run would
otherwise read a false `ready` off that completed/success rollup entry, which
is really this exact question being asked of itself. Matching is by the
check's own name — `CheckRun.name` or the legacy `StatusContext.context` —
**exact only, never a substring or a pattern**: `--exclude-check readiness`
does not drop `readiness / summary`. If the rollup has **nothing left** after
the named exclusion(s), the verdict is
`not-ready: no checks reported (after excluding: <names>) (CON-32a)` —
an absent verdict, never `ready`, the same "absence is not evidence" reading
`--exclude-run` gives an emptied rollup. The exclusion never changes which
reviewers owe a round or whether CON-30's dependabot carve-out fires — both
still read the un-excluded rollup, same as `--exclude-run`. The names applied
are reported in `--explain` and in `--json`'s `meta.excludedChecks`. A name
that matches **no** entry in the rollup is never a silent no-op: it is
reported as a `meta.warnings` entry (`--exclude-check '<name>' matched no
check in the rollup`), printed under `--explain`, and the rollup is otherwise
left intact. Every name is trimmed of surrounding whitespace before
matching, and a name given twice is applied (and warned about) once.

**Naming a check whose name contains a comma (zheref/nen#243).** A GitHub
Actions matrix job is named `<job> (<v1>, <v2>, ...)` — this repository's own
CI reports `check (Windows, ["self-hosted","Windows","X64"])` — and through
v0.15.x `--exclude-check` split its one value on every comma, so such a name
fragmented into pieces that matched nothing and the verdict stayed
`not-ready` on a job the maintainer had ruled out
([zheref/nen#242](https://github.com/zheref/nen/pull/242)). The flag now
**repeats** — `--exclude-check readiness --exclude-check 'check (Windows,
["self-hosted","Windows","X64"])'` is two names — and within one occurrence a
comma separates names **only outside brackets**: `(`, `[` and `{` open a
group, the matching closer ends it, and a comma inside a group belongs to the
name. So `--exclude-check a,b` is still two names, exactly as before, and a
matrix name is one name with or without the repeat:

```bash
nen pr ready 242 --gh-repo zheref/nen --exclude-check 'check (Windows, ["self-hosted","Windows","X64"])'
nen pr ready 242 --gh-repo zheref/nen --exclude-check 'compile,check (Windows, ["self-hosted","Windows","X64"])'
```

Two shapes are stated rather than guessed. A value with an opener that is
**never closed and a comma after it** (`--exclude-check 'lint (,build'`) has
two readings — the comma separates `lint (` from `build`, or belongs to one
name — and is **refused at exit `2`**, naming the character; give each check
its own occurrence instead. (An unclosed opener with no comma after it, such
as `lint (`, is not ambiguous and is kept as typed; a closer with no opener
is an ordinary character.) And a name with a comma **outside every bracket**
(`lint, format`) still splits and cannot be named by this flag — no Actions
matrix name is shaped that way; a declared, pattern-capable exclusion is
[zheref/nen#249](https://github.com/zheref/nen/issues/249)'s. The grammar is
`src/pr/excludecheck.ts`'s header.

**CON-30's dependency-author carve-out.** `nen/gates.json` may declare an
optional `dependabot_carve_out`:

```json
"dependabot_carve_out": {
  "author_pattern": { "pattern": "^dependabot(\\[bot\\])?$", "ignoreCase": true },
  "satisfied_by_context": ["sasuke / audit", "kakuzu / review"]
}
```

When the pull request's author matches `author_pattern` **and every context in
`satisfied_by_context` is present in the rollup and green on its latest run**,
the three CON-32(b) rows — the stall bound, the owed round and the approve limb
— are satisfied by the review shim that reported those contexts rather than by a
review round. It is **satisfied by presence, never by absence**: a pull request
missing one of the named contexts has not been shimmed, it has merely not been
reviewed, and the gate runs exactly as it always does. CON-32(a) runs **first**,
so a dependency PR is never exempted from having checks or from their being
green, and CON-32(d) still runs after, so an unresolved thread still fails —
a human who opened one is owed an answer whether or not a shim covered the
rounds.

It is never a silent exemption: `--explain` prints the reason under each row it
satisfied, `--json`'s `conjuncts[].note` carries the same string, and
`meta.dependabotCarveOut` says whether it fired (`null` on an unevaluated
report, where the gate never ran far enough to ask). The block is optional — a
file that omits it behaves exactly as before — and the carve-out never applies
on the `--reviewers` identity path, which names no file and so declares none.
An empty `satisfied_by_context` is refused at load: a carve-out satisfied by no
context is satisfied by nothing, and would clear the review rounds for that
author on no evidence at all.

**`round_quorum`: at least N of a group must have a round (maintainer ruling
2026-09-29).** The maintainer's words: *"Copilot credits are exhausted. Expect
Cursor instead. Let's make it canon on the repo so that we solve at least one
round of reviews from both Copilot OR Cursor (or both) as applicable."* Without
this key every reviewer is judged on its own. A file can then owe both rounds
(neither reviewer exempt, so one exhausted reviewer holds every pull request
shut). Or it can owe neither unless one is requested or enrolled (both exempt,
so a pull request nobody reviewed reads `ready`). It cannot say "Copilot or
Cursor Bugbot". `round_quorum` says it:

```json
"round_quorum": { "any_of": ["copilot", "bugbot"], "minimum": 1 }
```

- **What counts as a round** is decided by exactly the rules that already
  clear one reviewer, through the same code. A posted, non-`PENDING` review
  under the member's `login_pattern` counts, at any earlier head under
  `bounded` and at the current head under `strict` (and for a CON-40
  delivery-holistic-pass member on a delivery PR). A `round_check_pattern`
  run that concluded **`SUCCESS`** counts too, on the same terms: at the
  current head under either policy, and **on an earlier commit that GitHub
  lists against this pull request, under `bounded`** (see *Round checks at an earlier head*
  below). No other conclusion is a round (see *Consumer note: a round check
  must conclude `SUCCESS`* below). So does CON-40's holistic pass. Each member is
  counted **whether or not it is in the configured reviewer set** (base set,
  enrolled by its check, or `--reviewers`) and **whether or not it is
  `bounded_policy_exempt`**. Those two facts decide who is *owed* a round, not
  who *has* one. A pending review request is reported beside the member, and it
  is never counted either way.
- **It only adds a requirement.** Fewer than `minimum` members with a round
  fails row 4 (`rounds-owed`, CON-32(b)). Every per-reviewer owed round is
  judged exactly as before and is never excused by a met quorum. A member with
  a pending request is still owed, and an enrolled `Cursor Bugbot` whose check
  is still running is still owed. The quorum is on row 4 rather than a row of
  its own because `conjuncts` stays the six rows of `nen.pr.ready/v0.1`, and a
  seventh would change what the table means for every consumer.
- **The reason names every member.** With nothing owed, the row reads
  `not-ready: round quorum not met (0 of 2 with a round, 1 required, CON-32b):
  copilot (no round), bugbot (no round, no 'Cursor Bugbot' check)`. A member
  without a round says which reading judged it (`no round` or `no round at
  head`), whether a request for it is pending (`review requested, not yet
  posted`), and where its round check stands: `no '<check>' check`, `'<check>'
  check not yet completed`, `'<check>' check SKIPPED`, or `'<check>' check
  concluded <CONCLUSION>, not SUCCESS`. When a round is also
  owed, the owed sentence comes first, unchanged, and the quorum clause follows
  after ` — and `.
- **`--explain` and `--json`.** A met quorum is stated in row 4's note
  (`round quorum met (1 of 2 with a round, 1 required, CON-32b): …`). Row 4
  also carries `conjuncts[].roundQuorum`: `anyOf`, `minimum`, `count`, `met`,
  and `members[]` with `reviewer`, `round`
  (`review`\|`round-check`\|`round-check-earlier-head`\|`delivery-holistic-pass`\|`null`),
  `reading` (`any-head`\|`current-head`, the policy's reading), `requested`,
  and `roundCheck` (`null`, or `{ pattern, name, state, conclusion, from, sha }`
  with `state` `absent`\|`pending`\|`skipped`\|`unsuccessful`\|`completed`,
  where `completed` means a `SUCCESS` and `unsuccessful` any other completed
  conclusion, carried in `conclusion`, and `from`
  `head`\|`earlier-head`\|`null` naming the commit, `sha`, that the reported
  run is on). The field is **absent**, not
  `null`, on every other row. It is also absent when the file declares no
  quorum, when CON-30's carve-out satisfied the row, and when the row could not
  be computed. A repository without the key therefore gets a byte-identical
  report. The field is additive, so the contract stays `nen.pr.ready/v0.1`.
- **`--reviewers` does not switch it off.** When identities come from a file
  (the in-repo `nen/gates.json` or `--gates`), the quorum applies whatever
  `--reviewers` names. The configured set decides who is owed a round, while the
  quorum is the repository's declared floor on who has reviewed. The
  `--reviewers`-only identity path (no file at all) declares no quorum, just as
  it declares no carve-out.
- **CON-30's carve-out satisfies row 4 whole**, quorum included. The review
  shim stands in for review rounds, all of them.
- **Refused at load, by pointer.** Each of the following names its pointer:
  - `round_quorum` is not an object.
  - `round_quorum.any_of` is missing, is not an array, or is empty.
  - `round_quorum.any_of[i]` is not a non-empty string, names a reviewer not
    declared in `reviewers`, or duplicates an earlier member (one round would
    count twice).
  - `round_quorum.minimum` is missing or not an integer. It is stated and never
    defaulted, because "at least one" and "all of them" are both plausible.
  - `round_quorum.minimum` is below 1, which nobody reviewing would meet.
  - `round_quorum.minimum` is above the size of `any_of`, which no set of rounds
    could meet.
- **Older nen.** The schema stays at `version: 1`. **Every nen release before
  the one that ships `round_quorum`** (v0.15.1 and v0.16.0 verified) ignores
  the key and applies the rest of the file. The file is still valid, and every
  requested or enrolled round is still owed, but there is no one-reviewer
  floor.

**Consumer note: a round check must conclude `SUCCESS` (review of E7, finding
C1).** Until this change, any `round_check_pattern` run that completed with a
conclusion other than `SKIPPED` cleared that reviewer's round. Now only
`SUCCESS` does, at head and on an earlier commit alike. This applies to
**every repository that declares `round_check_pattern`**, not only one with a
`round_quorum`. The reason is Cursor Bugbot's `NEUTRAL`, which means either
"found N issues" or "run cancelled because a newer commit was pushed".
zheref/nen#281 has no review at all, and its cancelled `NEUTRAL` run on
`cc7a948` read as Bugbot's round. The findings case loses nothing, because a
reviewer whose check is its round posts a review when it has findings
(`cursor[bot]` did on zheref/nen#278 and #285), and the review counts on its
own. The direction is fail-safe: a round-check reviewer can only become owed
where it used to be cleared, never the reverse.
- A run that completed without success still **enrols** the reviewer (it is
  configured for the pull request) and does not clear it.
- Unlike a `SKIPPED` run, that state has a way out: a re-run that succeeds, or
  a review, clears it. The next paragraph says how.

**The way out of an owed Bugbot round (Nobunaga's delta review of E7, finding
F3).** On this repository Cursor Bugbot runs once per pull request and does not
re-run by itself. A Bugbot round that is owed, or a quorum it would meet, stays
unmet until something changes. There are two remedies:
- **Re-trigger Bugbot** by commenting `bugbot run` on the pull request.
  Cursor's documented trigger is `bugbot run` or `cursor review`, and each
  re-run needs a new comment ([Cursor Docs: Bugbot](https://cursor.com/help/ai-features/bugbot)).
  A run that concludes `SUCCESS` is Bugbot's round. A run with findings posts a
  review, which is its round too.
- **When Bugbot cannot succeed and Copilot already has a round**, run
  `nen pr ready <ref> --reviewers copilot` (the reviewers other than Bugbot).
  `--reviewers` sets who is *owed* a round, so Bugbot stops being owed. The
  quorum is the repository's declared floor and still counts Copilot's round,
  so the pull request is not waved through on nobody's review.

**Worked example: this repository's own `nen/gates.json`.** Copilot is kept but
exempt under `bounded`, Cursor Bugbot is added, and the quorum asks for at least
one of the two:

```json
"reviewers": [
  { "name": "copilot",
    "login_pattern": { "pattern": "^(copilot|copilot-pull-request-reviewer(\\[bot\\])?)$", "ignoreCase": true },
    "bounded_policy_exempt": true },
  { "name": "bugbot",
    "login_pattern": { "pattern": "^(cursor(\\[bot\\])?|bugbot\\[bot\\])$", "ignoreCase": true },
    "round_check_pattern": { "pattern": "^Cursor Bugbot$", "ignoreCase": true },
    "enrolment_check_pattern": { "pattern": "^Cursor Bugbot$", "ignoreCase": true } }
],
"approval_policy": "review-round-only",
"default_approvers": [],
"base_reviewers": ["copilot"],
"round_quorum": { "any_of": ["copilot", "bugbot"], "minimum": 1 }
```

| The pull request, under `bounded` | Row 4 (`rounds-owed`) |
|---|---|
| Nobody reviewed, no `Cursor Bugbot` check at head | FAILED: `round quorum not met (0 of 2 with a round, 1 required, CON-32b): copilot (no round), bugbot (no round, no 'Cursor Bugbot' check)` |
| No review, and Bugbot's run at head concluded `NEUTRAL` (for example, cancelled) | FAILED: `round quorum not met …`, naming `bugbot (no round, 'Cursor Bugbot' check concluded NEUTRAL, not SUCCESS)` |
| No review, and Bugbot's only run was cancelled (`NEUTRAL`) on an **earlier** commit | FAILED. The earlier run is not a round, so the member reads as if no run were there. zheref/nen#281 (the cancelled run on `cc7a948`, head `322a492`) reads `round quorum not met (0 of 2 with a round, 1 required, CON-32b): copilot (no round), bugbot (no round, no 'Cursor Bugbot' check)` |
| `Cursor Bugbot` concluded `SUCCESS` at head (no findings) | ready, noted `round quorum met (1 of 2 …): copilot (no round), bugbot (round: 'Cursor Bugbot' check completed)` |
| Bugbot posted a review (as `cursor[bot]`) at any earlier head | ready |
| Bugbot's run concluded `SUCCESS` on an earlier commit that GitHub lists against this PR, nothing at head, no review | ready under `bounded`, noted `bugbot (round: 'Cursor Bugbot' check completed at earlier head <sha>)`. FAILED under `strict` |
| Copilot posted a review at any earlier head | ready |
| `Cursor Bugbot` still running, Copilot reviewed earlier | FAILED: `bugbot (no round at head)`. It is enrolled and owed until its run concludes `SUCCESS` or it posts a review. See *The way out of an owed Bugbot round* below |
| Copilot re-requested and not yet posted, Bugbot reviewed | FAILED: `copilot (review requested, not yet posted)` |

Under a release that predates `round_quorum` (through v0.16.0), the first three
rows read `ready`: no reviewer is owed, and those releases ignore the floor.
Those releases never read a run on an earlier commit, and they still count a
`NEUTRAL` run at head as Bugbot's round. Every other row reads the same under
both.

- **Why the bot logins only (review of E7, finding M2).** The pattern names
  `cursor[bot]` and `bugbot[bot]`, plus the bare `cursor`, which is how
  GraphQL spells the bot's login. On GitHub `cursor` is an Organization, and an
  Organization cannot author a review. It does **not** match the bare `bugbot`,
  which is a human GitHub `User` account (`gh api users/bugbot`), because on a
  public repository that account could otherwise post Bugbot's round.
  Requiring the REST `user.type` of `Bot` would be stronger still. That needs
  the review record to carry the type (`src/github/types.ts` and `parse.ts`),
  and it is not in this change.
- **Why `strict` is not a policy for this repository (review of E7, finding
  L2).** Copilot's exemption applies under the default `bounded` policy only.
  Under `--round-policy strict`, Copilot is owed a round at head like any other
  base reviewer. With Copilot's credits gone, that holds every pull request.

**Round checks at an earlier head (the same maintainer ruling of 2026-09-29, option B).**
Under `bounded`, a run of a reviewer's `round_check_pattern` check counts as
that reviewer's round when all three of these hold:
- it concluded **`SUCCESS`**;
- it is on an **earlier commit of this pull request**;
- GitHub lists it **against this pull request**.

This is no new policy. It is zheref/nen#214's
`bounded` reading, which already accepts a review posted at any earlier head,
applied to a reviewer whose check is its round. Without it, a reviewer that
posts only when it has findings was rewarded for finding something. A run with
findings leaves a review that counts at every later head, while a clean run
leaves only a check that no later head's rollup shows. On this repository
Cursor Bugbot runs **once per pull request**, not on every push: on
zheref/nen#279 it ran on `2851d2e` and not on the later `7cee8a5`. That PR now
reads the quorum met through that run.

- **`strict` is unchanged.** Only a run at the current head counts, exactly as
  only a review at the current head does.
- **A run in flight at head supersedes history.** A reviewer whose check is
  queued or running at head has no round from an earlier run, so an enrolled
  `Cursor Bugbot` whose check is still running is still owed.
- **Enrolment still keys on the head's checks only.** An earlier run proves the
  reviewer showed up, not that it is configured for this pull request now.
  Under `bounded` the same run would satisfy the very reviewer it enrolled, so
  enrolling on it could add nothing except making a pending request owed.
- **`SUCCESS` only, and the walk keeps looking (finding C1).** A newer
  cancelled (`NEUTRAL`) or failed run is skipped. The read carries on to an
  older commit, so it cannot hide an older clean run.
- **A run GitHub lists against this pull request (review of E7, findings H1
  and F4).** Stacked pull requests share commits: zheref/nen#278's commit list
  carries #274's four. A run therefore counts only when one of its REST
  `pull_requests[]` entries is this pull request, meaning its `number` **and**
  its base repository match. `gh api repos/zheref/nen/commits/2851d2e/check-runs`
  lists #279 with base `zheref/nen`.
  - A number alone is not an identity: #7 of a fork's or another repository's
    list is a different pull request.
  - REST gives the base repository as `{ id, name, url }` with no owner field.
    The owner and name are read from the URL's `/repos/{owner}/{name}` suffix,
    which also covers a GitHub Enterprise `…/api/v3/repos/…` URL, and `name`
    must agree with it. Both are compared case-insensitively.
  - An entry whose base repository cannot be read fails closed and is not
    counted.
  - A run listed against another pull request only is skipped silently,
    since it is correctly not this one's round.
  - A run that names **no** pull request is not counted, and the read adds a
    `meta.warnings` entry, because nothing attributes it. GitHub leaves the
    list empty for a pull request from a fork, and once a pull request is
    merged.
- **It fails closed.** The state is read into a separate
  `earlier_round_checks` field, so `checks` stays the head's rollup for
  CON-32(a) and every other reader. Every failure ends the read with a
  `meta.warnings` entry and counts nothing further: a failed commit listing, a
  failed or unreadable check-run read, or reaching the budget. A run already
  read in full before the failure is kept.
- **Page limits are warned, not refused (finding L1).** Both limits can only
  leave a run uncounted, so both add a warning and the read carries on:
  - `pulls/{n}/commits` lists at most 250 commits, and a listing that long says
    older commits were not read.
  - A commit's check runs are read one page of 100 at a time, and a page
    carrying fewer than the commit's `total_count` says the rest were not
    read.
- **The call budget.** The read makes **zero** extra calls unless all of these
  hold:
  - the policy is `bounded`;
  - some declared reviewer with a `round_check_pattern` is configured for the
    pull request, or is a `round_quorum` member while the quorum is not already
    met by posted reviews or `SUCCESS` head runs;
  - that reviewer has posted no review;
  - that reviewer's latest head run neither concluded `SUCCESS` nor is in
    flight.

  When it does read, it lists the pull request's commits once. It then reads
  one page of check runs per earlier commit, **newest first**, and stops as
  soon as every wanted reviewer has a qualifying run. It never reads more than
  20 commits. Measured live: zheref/nen#279 cost 2 extra calls (the listing
  and `2851d2e`). zheref/nen#278 (Bugbot posted a review) and zheref/nen#274
  (Copilot's review met the quorum) cost none. With `--round-policy strict`
  the read makes no extra calls at all. The read needs `checks:read`, the
  grant the head rollup already needs.

**Provenance — which binary decided it.** Every report says which `nen`
produced it: `meta.generator` carries `program`, `version` and `executable`
(the resolved path of the running process), and `--explain` renders them as a
`decided by nen <version> (<path>) at <timestamp>` line. `nen --version` says
which nen a caller *believes* it has; `executable` says which file actually
answered — a checksum-verified binary under the bootstrap cache
(`~/.cache/nen/<source>/<ref>/…`), a locally built one, or `bun src/index.ts`
out of a working tree, all three of which can carry the same version string and
different behaviour. It is deliberately **not** a checkout SHA: a compiled
binary has no checkout at evaluation time, and its bytes are already verifiable
against the published `SHA256SUMS` for a ref. It is deliberately **not** printed
on stderr on every invocation either — every verb in this binary shares one
stderr that callers treat as diagnostics, and `pr ready` is not privileged among
them; the report carries it, and a caller that wants it reads the report.

**Output and exit codes**. The human output's first line is `<repo>#<pr>: <gateLine>`,
unchanged. It is followed by the `judged head:` line, one `also FAILED <clause>: <reason>`
line for each failing row after the first, and one `warning:` line for each warning.
`--explain` prints the full conjunct table instead, headed by the same two lines and a
`failing rows (<n>):` summary. The `--json` top-level keys are `contract`,
`verdict` (`ready`\|`not-ready`\|`unevaluated`), `gateLine`, `firstFailing`,
`failing[]`, `judgedHead`, `localHead`, `conjuncts[]` (each row has `id`, `order`,
`clause`, `title`, `status`, `reason`, `note` and `missing`, and the `rounds-owed` row also
carries `roundQuorum` when the file declares a `round_quorum`), `caveats[]`, `remedy` and `meta`
(`meta.requiredHead` included). `failing`, `judgedHead`, `localHead`,
`conjuncts[].missing`, `conjuncts[].roundQuorum` and `meta.requiredHead` are additive to
`nen.pr.ready/v0.1`.
Exit 0 only on `verdict: ready`.
Exit 1 on `not-ready` **or** `unevaluated`, because a non-zero exit never means
"cleared" (SKILL.md §4's "absence is never a pass").
Exit 2 on a malformed ref, an unresolvable code (unknown, or matching two registry keys
that differ only by letter case), a malformed `--require-head`, a non-numeric
`--exclude-run`, an ambiguous `--exclude-check` value (an opener never closed, with a
comma after it), or no reviewer-identity source at all. That is a usage problem, never a
verdict.
Exit **8** on `head-mismatch`: `--require-head` named a commit that is not GitHub's head, and no verdict was
decided.

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

**`round_quorum`, and the head only (review of E7, finding H2).** When the
`gates.json` declares a `round_quorum`, the owed-round step asks it too. It
uses the same inputs as the per-reviewer rounds and the wording `nen pr ready`
uses.
- A quorum that is not met is an `owed-round` blocker, whose `detail` is the
  quorum clause, for example `round quorum not met (0 of 2 with a round, 1
  required, CON-32b): copilot (no round), bugbot (no round, no 'Cursor Bugbot'
  check)`.
- When a reviewer is also owed, the owed list comes first and the clause
  follows after ` — and `.
- Before this, this repository's own `gates.json` let an unreviewed pull
  request answer `none` while `nen pr ready` refused it.

This verb reads the **head only**: its snapshot carries no earlier-commit check
runs. So it does not count a round-check run on an earlier commit, which
`nen pr ready` does under `bounded`. Where the two differ, `next-blocker` calls
the round owed. It is stricter than `pr ready` there, never looser.

The quorum clause **says so wherever it can matter** (Nobunaga's delta review
of E7, finding F2). That is when the quorum is unmet under `bounded` and a
round-check member has no run, a `SKIPPED` run, or an unsuccessful run at head.
The clause then ends with `(head only — \`nen pr ready\` also reads earlier
commits of this PR)`. zheref/nen#279 is the common shape, since Bugbot runs
once per pull request: `pr ready` reads the quorum met through the run on
`2851d2e`, while this verb reads it unmet with that note.

It carries no earlier-commit runs because the fetch is not told which to look
for. Its caller does not pass the reviewer identities or the policy, so reading
the history here would mean reading every earlier commit's check runs, up to 21
extra `gh` calls, on every call. The head usually settles it.

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
(`conflict`\|`draft`\|`red-check`\|`owed-round`\|`unresolved-thread`\|`missing-body-requirement`\|`none`),
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
clean merge, unless `--no-push` says to stop before that step. A conflict is
reported, never resolved — this verb does not run `git merge --abort`, does
not pick a side, and does not push when conflict markers remain, `--no-push`
or not.

**Usage**

```text
nen pr cascade-main --repo <path> [--trunk main] [--no-push]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the repository whose current branch the trunk is merged into | unbracketed in usage; omitted is refused at exit 2 — this verb mutates whatever it is pointed at (#28) |
| `--trunk <branch>` | no | the trunk branch | default `main` |
| `--no-push` | no | fetch and merge exactly as always, then stop — never push | still merges into the working tree and index, so izanami's table keeps this verb `mutating` in every spelling; there is no read-only or preview form (see the `--dry-run` discipline table above). Refused at exit 2 on every OTHER `pr` subcommand — this family has no per-subcommand flag table yet, so it would otherwise parse cleanly and be silently ignored |
| `--json` | no | machine-readable cascade result | — |

**Output and exit codes** — human lines are the `log[]` entries (`fetched
origin/<trunk>`, `merged origin/<trunk> cleanly` or the conflict note,
`pushed` or, under `--no-push`, `not pushed (--no-push)`), followed by one
block per conflict when the merge failed:

```text
  <path>  (<kind>)
    ours:   <commit>, <commit>, ...
    theirs: <commit>, ...
```

`--json` top-level keys: `conflicted`, `pushed`, `noPush`, `log[]`, `error`,
`conflicts[]`. `noPush` echoes whether `--no-push` was given (`false`
otherwise, never omitted). `conflicts[]` is `[]` except on a conflicted
merge, where it carries one entry per unmerged path from `git diff
--name-only --diff-filter=U`:

| Field | Meaning |
|---|---|
| `path` | the unmerged path |
| `kind` | `both-modified`, `add-add`, `modify-delete` (we kept/modified it, the trunk deleted it) or `delete-modify` (we deleted it, the trunk kept/modified it) — read off `git ls-files -u`'s stage table (1 = merge base, 2 = ours, 3 = theirs) |
| `ours[]` / `theirs[]` | commit SHAs that touched `path` since the merge base, on the current branch and on `origin/<trunk>` respectively (`git log --format=%H <mergeBase>..<ref> -- <path>`); both empty when the merge base itself could not be resolved |

Exit 0 on a clean merge (pushed, or not under `--no-push`), exit 1 on a
conflict, a fetch failure, or a push failure, exit 2 on a missing `--repo`.

**Example**

Run live against a throwaway repository constructed with one real conflict
of each of the four kinds (`shared.txt` edited on both sides, `new-file.txt`
added independently on both sides, `kept-by-us.txt` edited on the current
branch and deleted on the trunk, `kept-by-them.txt` deleted on the current
branch and edited on the trunk):

```bash
nen pr cascade-main --repo . --no-push
```
```text
fetched origin/main
merge left conflicts -- resolve them, then commit and push yourself; this cascade never picks a side
  kept-by-them.txt  (delete-modify)
    ours:   d798f724277267e7c7b5dcdcf028169b8c2bf457
    theirs: 10b2def54dd1dc04544adb22841b7f4b06b464d0
  kept-by-us.txt  (modify-delete)
    ours:   d7104738412d0285b84a6eb9ec41e52398ed2cef
    theirs: 09ff5277dfeba95cc9ab73c4539d75f3c6bd600c
  new-file.txt  (add-add)
    ours:   551d51ae42e491ca936f7ab2409be653eb3f1f2c
    theirs: bb41fa9abe38decb9551bdf827bf1bf6be38313f
  shared.txt  (both-modified)
    ours:   ae8526a586bd231d2a636ddfcf5647508e250fdd
    theirs: 908565a7847a327d013b87ada35844f467665761
```
exit 1 (conflict; `git status` in the fixture agrees: "deleted by us" for
`kept-by-them.txt` and "deleted by them" for `kept-by-us.txt`, the same
direction this verb's `delete-modify`/`modify-delete` names encode). The
same fixture's non-conflicting branch, merged with `--no-push`, prints
`fetched origin/main`, `merged origin/main cleanly`, `not pushed
(--no-push)` at exit 0 and leaves no `origin/<branch>` update behind; the
bare form (no `--no-push`) prints `pushed` in its place and does push.

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

Two routes, chosen per name. A login this pull request already knows as a
Bot (its own `reviewRequests` or `timelineItems`) or a raw node id named
with `--add-bots` is requested through GitHub's `requestReviews` GraphQL
mutation (`botIds`, one call for every bot named or resolved); a login that
instead reads as a collaborator of `--target` is requested through `gh pr
edit --add-reviewer`, unchanged from before. The split exists because `gh pr
edit --add-reviewer` resolves through GitHub's `requestReviewsByLogin`
mutation, which never resolves a Bot reviewer at all — the exact refusal
this verb used to hand straight back with no route around it
([zheref/nen#160](https://github.com/zheref/nen/issues/160)). An
`--add-reviewers` entry containing a `/` (an `org/team` slug) is a **team**
and goes straight to `gh pr edit --add-reviewer` with no bot-or-collaborator
lookup at all, exactly as it did before that resolution existed. Request on
the MAINTAINER's user token — a bot token silently no-ops on the user route
(S6); this verb cannot enforce which credential ran it, only warn in its
usage text.

**Usage**

```text
nen pr request-reviews --target <owner/name> --pr <n> [--add-reviewers a,b] [--add-bots id,id] [--dry-run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | the GitHub repository | missing exits 1 |
| `--pr <n>` | yes | the pull-request number | missing/invalid exits 2 |
| `--add-reviewers <a,b>` | one of this or `--add-bots` | comma-separated reviewer logins, resolved one by one (see above) | a login that resolves to NEITHER a known bot nor a collaborator is refused at exit 2, naming it and pointing at `--add-bots` |
| `--add-bots <id,id>` | one of this or `--add-reviewers` | comma-separated Bot **node ids** (GraphQL global ids), routed straight to the mutation's `botIds` | the one way to request a bot this pull request has never seen — nothing short of the id resolves one |
| `--dry-run` | no | resolves every `--add-reviewers` login (still reads GitHub) and prints which route each name or id would go to, then requests nothing | not network-free — see the `--dry-run` discipline table above |
| `--json` | no | machine-readable result | adds a `routing` array (`{ name, via, route, id }` per name/id) and an `unrecordedBots` array (`{ id, login }` per requested bot GitHub did not record — see exit `9`) alongside `ok`/`message` |

Both flags absent (or both empty) is refused at exit 1, naming both:
`no reviewers named -- --add-reviewers takes a comma-separated list of
logins, or --add-bots a comma-separated list of node ids` — the wording
`--add-reviewers` itself always carried; a prior version of this same
refusal named `--reviewers`, this verb's SIBLING flag on `pr ready` and `pr
next-blocker` rather than its own
([zheref/nen#95](https://github.com/zheref/nen/issues/95), fixed alongside
`--add-bots`).

This verb reads no `--repo` — every call addresses the PR and its
repository entirely via `--target`/`--pr`.

**Output and exit codes** — human line(s): one per route actually called
(`requested <a>, <b> on <target>#<pr>` for the user route; for the bot
route, what the mutation's OWN response says is now pending review, not an
echo of what this verb sent — see `src/pr/bots.ts`'s header for why:
the identical mutation call has been observed answering `NOT_FOUND` for a
botId under one token and succeeding under another, so success is reported
from GitHub's answer, never assumed from an exit code alone); `--json`
top-level keys: `ok`, `message`, `routing`, `unrecordedBots` (a `--dry-run`
carries `ok`, `dryRun`, `routing`, `message`). Exit 0 on success (or a
`--dry-run`), exit 1 when no reviewers were named or a route's `gh` call
failed or answered something unreadable, exit 2 on a missing `--pr` or an
unresolved `--add-reviewers` login, and **exit `9` when every call was
accepted but GitHub did not record at least one requested bot**.

**Exit `9` — a bot request GitHub accepted and never recorded
([zheref/nen#277](https://github.com/zheref/nen/issues/277)).** On
zheref/hatsu#123, #128 and #130 (2026-09-29) the `requestReviews` mutation
for Copilot's node id exited 0 and answered, but its own `reviewRequests`
listed no pending request from that bot, GitHub recorded no
`ReviewRequestedEvent`, and no review arrived — while this verb reported
`ok: true`, "pending review requests now include bot(s): (none reported
back)". Every requested bot is now looked for in the mutation's response **by
node id**, and one that is absent fails the call:

```text
zheref/hatsu#130: GitHub accepted the bot review request but did not record it for BOT_kgDOCnlnWA -- the mutation's own response lists no pending review request from that bot, so no review round should be expected from it. Pending bot review requests it does list: (none).
```

The bot is named `login (id)` where this pull request already knows it (its
own `reviewRequests` or `timelineItems`) and by id alone otherwise; `--json`
carries the same fact as `ok: false` and `unrecordedBots: [{ id, login }]`
(`login` `null` for a bot the pull request has never seen), and
`unrecordedBots` is `[]` on success. A caller should read `9` as **no review
round to expect from that bot**, not as a failure to retry: nothing on the call
itself failed. One limit, stated rather than hidden: the response's
`reviewRequests` is read as a single `first:100` page, so on a pull request with
more than 100 pending review requests a bot that *did* land can fall past it and
be reported here — a false refusal, never a false success, which is the
direction this verdict is allowed to err in. When one
route's `gh` call failed outright in the same invocation, exit `1` wins and
`unrecordedBots` still names the bot; a response with no `reviewRequests` list
at all is exit `1` too (nothing was read that could say which bot landed). The
code was chosen, like [`pr ready`](#nen-pr-ready)'s `8`, because it collides
with nothing else this CLI or its bootstrap returns. The PR timeline's
`ReviewRequestedEvent` is deliberately **not** read: telling this request's
event from an earlier request's needs a clock window, and the mutation's own
response is the same transaction's answer.

**Example — a login this pull request already knows as a bot**

```bash
nen pr request-reviews --target zheref/nen --pr 9 --add-reviewers copilot-pull-request-reviewer
```
```text
zheref/nen#9's pending review requests now include bot(s): copilot-pull-request-reviewer
```
(from `src/pr/command.test.ts`, scripted: the known-bots query answers that
login as a `Bot` already in this pull request's `timelineItems`, then the
`requestReviews` mutation is called with that bot's resolved node id in
`botIds` — this verb reaches GitHub, so it was not run live here)

**Example — a collaborator, and a node id named directly**

```bash
nen pr request-reviews --target zheref/nen --pr 9 --add-reviewers sasuke --add-bots BOT_kgDOCnlnWA --dry-run
```
```text
would request review on zheref/nen#9:
  sasuke -> user [add-reviewers]
  BOT_kgDOCnlnWA -> bot [add-bots]
```
(scripted the same way — `sasuke` resolves as a collaborator, and the node
id named with `--add-bots` needs no resolution at all; `--dry-run` still
performs both reads but calls neither `gh pr edit --add-reviewer` nor the
mutation)

### `nen pr edit-body`

Replaces a pull request's body OUTRIGHT with a file's bytes — no trimming, no
template, the file becomes the body exactly, through `gh pr edit
--body-file`. Unlike [`issue comment`](#nen-issue-comment), which
deliberately accepts either object class, this verb never writes the wrong
object: the number is CERTIFIED as a pull request (`gh api
repos/<target>/pulls/<n>` resolves 200) before anything is written. A number
that does not resolve there is refused rather than guessed at — the wording
never claims the number IS an issue, only that it is not a pull request,
because a 404/410 from `pulls/<n>` cannot tell "an issue" apart from
"nothing at all".

**Usage**

```text
nen pr edit-body --target <owner/name> --pr <n> --body-file <path> [--dry-run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository. | Missing exits 1. |
| `--pr <n>` | yes | The pull request to replace the body of. | Read with a strict `/^\d+$/` guard (like [`issue comment`](#nen-issue-comment)'s `--issue`, unlike this file's own `requirePr()`) — `1e3` or `0x0c` are refused rather than silently accepted as 1000/12, because this is a MUTATING read. |
| `--body-file <path>` | yes | The new body, read RAW (no CRLF normalization) so `gh` reads the same bytes this verb previewed. | There is no inline `--body`. An unreadable path, or one holding only whitespace, is refused (exit 2). |
| `--dry-run` | no | Certify the number, then print the target, the number, the byte count and the first/last line instead of writing. | **Still reads GitHub** to certify — this verb is not network-free even under `--dry-run`, the same shape [`issue attach-sub`](#nen-issue-attach-sub) has. |

**Output and exit codes** — human line on a real write: `replaced
<target>#<pr>'s body (<n> byte(s))`; `--dry-run` prints `would run: gh pr
edit ...` followed by `target:`/`number:`/`bytes:`/`first line:`/`last
line:`. `--json`: `{ contract: "nen.pr.edit-body/v0.1", target, number,
bytes, written, dryRun }` — exactly those six fields, dry run or not. Exit 0
on success (dry or real); exit 2 on a malformed/absent `--pr`, an
empty/unreadable `--body-file`, or a number that does not certify as a pull
request; exit 1 if `gh pr edit` itself fails after certification passed.

**Example**

```bash
nen pr edit-body --target zheref/nen --pr 141 \
  --body-file body.md --dry-run
```
```text
would run: gh pr edit 141 --repo zheref/nen --body-file body.md
target: zheref/nen
number: 141
bytes: 225
first line: ## What this changes for you
last line: Run `nen pr cascade-main --repo . --no-push` against a conflicted fixture.
```
(a real run against `zheref/nen#141` — read-only: the certifying `gh api
repos/zheref/nen/pulls/141` call reached GitHub, `gh pr edit` did not)

Handed an issue's number instead, the certification refuses before anything
is written — this is `zheref/nen#93`, a genuine open issue, run live against
`pr edit-body`:

```text
nen pr: #93 does not read as a pull request in zheref/nen (the pulls
endpoint answered 404) -- 'nen pr edit-body' replaces a PULL REQUEST's body
only, and it is certified before any write, so nothing was changed. If #93
is an issue, ask 'nen issue edit-body' instead.
Run 'nen pr --help'.
```
exit 2

### `nen pr mark-ready`

Moves ONE existing draft pull request out of draft, through GitHub's
`markPullRequestReadyForReview` GraphQL mutation
([#345](https://github.com/zheref/nen/issues/345)). It is **not**
[`pr ready`](#nen-pr-ready): that verb is the read-only CON-32 verdict — and
since a draft fails its first row ("a draft is never Ready"), this verb is the
way out of that row. It changes one fact, `isDraft`, and decides nothing about
readiness; a `ready` verdict never triggers it, and it never consults one.

**Authorization boundary.** It runs on whatever credential `gh` is already
authenticated as, and neither widens nor replaces it. It never merges, casts a
review vote, applies a label, requests a reviewer or changes a permission. A
refusal from GitHub (insufficient access, a branch rule) is reported as
`refused` at exit 1, never routed around.

**Order of operations.** One certifying GraphQL read (`repository.pullRequest(number:)`
→ `id number state isDraft headRefOid url`) runs first, and every refusal is
decided from it **before any write**: a number or repository that does not
resolve (exit 2), a pull request that is `CLOSED` or `MERGED` (exit 3), a
`--require-head` that is not a prefix of GitHub's head (exit 8, both SHAs
printed). A pull request that is already not a draft answers `already-ready`
at exit 0 with nothing sent. Otherwise the mutation is addressed by the node id
that read produced — never re-resolved from the number — and GitHub is **read
back**: `marked-ready` (exit 0) only when the same pull request now reads
`isDraft: false`. Only a 200 carrying `errors` is `refused`, without a read
back. A non-zero `gh` exit, a spawn failure or a non-JSON answer can follow a
write GitHub did apply, so it is read back like a clean answer, and its own
words ride along in the message. A read back that fails, still reads draft, or
answers a different object is `unconfirmed`. `refused` and `unconfirmed` both
exit 1, and neither is ever reported as ready. The mutation takes no expected
head, so a push landing between the read and the write cannot be refused by
GitHub. With `--require-head`, a head that moved by the read back is
`marked-ready-head-moved` at exit 8: the pull request left draft, but the pin
no longer holds. Without `--require-head`, `headMoved: true` is only reported.

Every family flag this verb does not read is refused at exit 2 before any
`gh` call: `pr ready`'s `--token-env` ("mark-ready runs on gh's own
credential"), `--gh-repo`, `--reviewers`, `--gates`, `--explain`,
`--exclude-check` and the rest, and other verbs' `--base`,
`--add-reviewers`, `--policy` and so on. Accepted silently, `--token-env`
would read as "this ran on that token" when the write ran on gh's.

**Usage**

```text
nen pr mark-ready --target <owner/name> --pr <n> [--require-head <sha>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository. | Missing or malformed exits 2. |
| `--pr <n>` | yes | The pull request to move out of draft. | The strict reader [`pr edit-body`](#nen-pr-edit-body) uses — `1e3` or `0x0c` are refused (exit 2), because this verb WRITES. |
| `--require-head <sha>` | no | Refuse before the write unless GitHub's head is this commit; the mutation itself is not pinned. | 7–40 hex digits, a prefix of GitHub's head, any case — `pr ready`'s own rule and exit code (8). Malformed exits 2. A head that moved by the read back is `marked-ready-head-moved`, exit 8. |
| `--dry-run` | no | Run the certifying read and every refusal, then print the mutation argv and send nothing. | **Still reads GitHub** — a dry run whose refusals differed from the real run's would prove nothing. |

**Output and exit codes** — the first human line is the status, the second the
message, then the url and the head. `--json`: `{ contract:
"nen.pr.mark-ready/v0.1", status, ok, target, number, url, stateBefore,
wasDraft, isDraft, requiredHead, headBefore, headAfter, headMoved, sent,
dryRun, mutationArgv, message }` — `status` is one of `marked-ready`,
`marked-ready-head-moved`, `already-ready`, `dry-run`, `not-open`,
`head-mismatch`, `refused`, `unconfirmed`; `isDraft` is `null` when a read
back could not be read. The human lines strip control characters from
GitHub-controlled strings (the url, the node id, gh's stderr); `--json`
carries the original bytes. A head GitHub answers that is not a full
40-hex-digit SHA, or a 200 missing `data`, `repository` or `pullRequest`, is
an unreadable answer at exit 1 — only an explicit `null` means "does not
resolve" (exit 2).

| Exit | Status | Meaning |
|---|---|---|
| 0 | `marked-ready` · `already-ready` · `dry-run` | read back not a draft; already not a draft, nothing sent; or a dry run |
| 1 | `refused` · `unconfirmed` | GitHub answered the mutation with `errors`; or the read back failed, still reads draft, or answered another object. Also a first read that failed or answered something unreadable (no document; the error is on stderr) |
| 2 | — | usage: `--target`, `--pr`, `--require-head`, a flag this verb does not read, or a number/repository that does not resolve |
| 3 | `not-open` | the pull request is `CLOSED` or `MERGED`; nothing sent |
| 8 | `head-mismatch` · `marked-ready-head-moved` | `--require-head` is not GitHub's head, nothing sent; or the pull request left draft but its head moved from the pinned one by the read back |

**Example**

```bash
nen pr mark-ready --target acme/widgets --pr 42 --require-head 0123456 --dry-run
```
```text
dry-run
would mark acme/widgets#42 ready for review (it is a draft at 0123456789abcdef0123456789abcdef01234567); nothing was sent.
would run: gh api --method POST graphql -f 'query=mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}' -f id=PR_kwSYNTHETIC
  https://github.com/acme/widgets/pull/42
  head: 0123456789abcdef0123456789abcdef01234567
  --require-head 0123456
```
(scripted — the repository, number and node id are synthetic)

### `nen pr threads`

A pull request's **review threads**, which are not PR comments and not
reviews: a thread is anchored to a file and a line, it carries a resolution
state that exists only over GraphQL, and answering one means
`addPullRequestReviewThreadReply` against its node id. `list` reads them all,
`reply` posts one answer, `resolve` closes one.

`list` walks `reviewThreads` **to completion and fail-closed**, exactly as
[`pr fetch`](#nen-pr-fetch) does and for the same reason: only the literal
`hasNextPage: false` ends the walk, and a page that neither ends it nor
carries a usable cursor is an error rather than a stopping point. A partial
list handed to a loop about to answer "every unresolved thread" is the same
false-green shape one layer along.

`--thread <id>` is the **GraphQL node id** `list` prints, never a position:
the third thread stops being the third one the moment anybody comments. Both
mutations look the thread up first, which is what makes "no such thread" and
"already resolved" two different answers instead of one GraphQL error — and
what lets `--dry-run` be truthful about a thread that is not there.

**Usage**

```text
nen pr threads list --target <owner/name> --pr <n> [--json]
nen pr threads reply --target <owner/name> --pr <n> --thread <id> --body-file <path> [--dry-run] [--json]
nen pr threads resolve --target <owner/name> --pr <n> --thread <id> [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | **yes** | the GitHub side | `--repo` names a checkout on disk and never addresses the API |
| `--pr <n>` | **yes** | the pull request | a positive whole number |
| `--thread <id>` | `reply`/`resolve` | the thread's GraphQL node id | as `list` prints it; there is no positional form. Each action refuses the flags it does not read — `--thread` on `list`, `--body-file` on `list`/`resolve`, `--dry-run` on `list` — rather than accepting and ignoring them |
| `--body-file <path>` | `reply` | the reply's bytes, read raw | a reply typed on a command line is a reply nobody reviewed; an empty or whitespace-only file is refused. A relative path resolves against `--repo`, not the process cwd |
| `--dry-run` | no | print the exact `gh api graphql` argv and write nothing | the thread is still looked up, so exits 3 and 4 still fire |
| `--json` | no | the document | see below |

**Output and exit codes** — `list` prints one line per thread (resolution
mark, id, `path:line`, author) with the first 200 characters of its opening
comment under it. `--json` top-level keys: `contract`
(`nen.pr.threads/v0.1`), `target`, `pr`, `head`, `thread` (the id acted on,
`null` for `list`), `replied`, `resolved`, `dryRun`, `threads[]` (`id`,
`isResolved`, `path`, `line` — `null` on an outdated hunk —, `author`,
`firstComment`, `url`; empty for the two mutations) and `argv` (the full
argv the mutation ran, or **would** have run under `--dry-run`; `null` for
`list`). The human `would run:` line summarises the body as a byte count plus
its first line and quotes every other element; the unsummarised argv is in
`--json`. Human renderings of a path, an author or a comment have their
control characters stripped — a terminal *executes* `ESC[2K` — while `--json`
keeps GitHub's bytes unchanged.

The exit codes are a **published contract**, and they go past 2 on purpose —
"I resolved it" and "it was already resolved" are different facts, and a
driving loop that recorded the second as the first would claim credit for
somebody else's work:

| Code | Meaning |
|---|---|
| `0` | done: the list printed, the reply posted, the thread resolved — or `--dry-run` completed |
| `1` | the API refused (including a GraphQL `200` carrying an `errors` array, which is how a refused mutation actually arrives) |
| `2` | usage: a missing action, `--target`, `--pr`, `--thread` or `--body-file` |
| `3` | the thread is **already resolved**, named, with nothing sent |
| `4` | this pull request carries **no thread with that id**, named, with the thread count |
| `5` | the credential could not authenticate |

**Example**

```bash
nen pr threads list --target zheref/nen --pr 217
```
```text
zheref/nen#217 @ 1f4bb2c0: 10 review thread(s), 0 unresolved
  resolved    PRRT_kwDOPmRi0c5ktVBH  src/report/data.ts:212  @copilot-pull-request-reviewer
      Consider naming the ref in this refusal.
  …
```


### `nen pr open`

Opens exactly **one** pull request from a head that is already on the
remote (v0.13.0, [#227](https://github.com/zheref/nen/issues/227)) — the
`gh pr create` Hatsu's `shibari` used to hand-roll.

**Usage**

```text
nen pr open --target <owner/name> --base <ref> --title-file <path> --body-file <path>
            [--head <branch>] [--draft] [--repo <path>] [--dry-run] [--json]
```

| Flag | Required | Meaning |
|---|---|---|
| `--target <owner/name>` | **yes** | the GitHub repository; `--repo` names a checkout and never addresses the API |
| `--base <ref>` | **yes** | the pull request's base branch |
| `--title-file <path>` | **yes** | the title is the file's first non-empty line; a file with none is refused at exit 2 |
| `--body-file <path>` | **yes** | the body, handed to `gh pr create --body-file` by path (read once first, so a missing file is refused before any question is asked) |
| `--head <branch>` | no | the head branch; default the branch checked out under `--repo` (the current directory by default — this verb's write goes to GitHub, and the checkout is only asked which branch is out) |
| `--draft` | no | open as a draft |
| `--dry-run` | no | print the `gh pr create` argv; still asks git and GitHub every question below, creates nothing |
| `--json` | no | `nen.pr.open/v0.1` — see below |

**Refused at exit 2:** a detached `HEAD` with no `--head`; a head with no
upstream (never published); a head whose local sha is not what its
**upstream's remote** holds — `<remote>/<branch>` is split off
`<head>@{upstream}` the way [`wc publish`](#nen-wc-publish) splits it, and
`git ls-remote <remote> refs/heads/<branch>` is asked (never a hard-coded
`origin`; the refusal names the remote it asked) — nothing there, or an
older sha — because a pull request opened now would not show the commits
here. Push first ([`wc publish`](#nen-wc-publish)). A git failure echoed
into any of these messages has remote credentials redacted (`://user:***@`,
`***` for a GitHub token) before it is printed. **Exit 1, nothing opened:** a
pull request is already open for that head (`gh pr list --head <branch>
--state open`), reported with its number and url — one head, one pull
request. Then `gh pr create --repo --base --head --title --body-file
[--draft]`, and the number is **read out of the url gh printed**: a create
that prints none is exit 1, never reported as opened.

**`--json`** — `nen.pr.open/v0.1`: `{ contract, number, url, head, base,
draft, dryRun, existing }`. `number` and `url` are `null` on a dry run;
`existing` is `true` on the exit-1 case, where they name the pull request
already there.

**Example**

```bash
nen pr open --target zheref/nen --base main --title-file title.txt --body-file body.md --dry-run
```
```text
would run: gh pr create --repo zheref/nen --base main --head feature/x --title "feat: the thing" --body-file /…/body.md
```

### `nen pr merge`

THE ONE BOUNDED MERGE THIS BINARY PERFORMS — never a general-purpose merge.
The second of the maintainer's 2026-09-26 "make it deterministic" trio: it
evaluates, IN ORDER, five gates, EVERY ONE regardless of an earlier
failure, and every verdict line is printed VERBATIM, the same sentence the
standalone verb would print:

1. **`pr ready`** (`../verbs/pr_ready.ts`'s own gate, called IN-PROCESS —
   never a subprocess).
2. **head pin** — `pr ready`'s own verdict names the exact commit it judged
   (`judgedHead`); this gate refuses when `pr ready` reported none, and
   refuses BY NAME (both SHAs printed) when the pull request's head — read
   in the ONE `gh pr view` fetch this verb makes of the pull request itself
   — no longer matches it. A passing plan's `gh pr merge` argv then carries
   `--match-head-commit <judgedHead>`, so GitHub itself refuses the merge if
   the head moves again after this read.
3. **`pr body-check`** — against `--requirements-from`, checked against the
   body from that SAME single fetch (never a second, independent `gh pr
   view`).
4. **`release unit-check`** — against `release.unitPaths` in
   `nen/workflow.json` AT THE PULL REQUEST'S BASE COMMIT, read over the
   GitHub API, never this checkout's own local file (a local clone may be
   stale, and a branch must not be judged against a policy it is itself
   editing). Refused outright when the pull request changes
   `nen/workflow.json` or `nen/gates.json`, or when a changed path inside
   the unit is a symlink or a submodule (git tree mode `120000`/`160000`).
   A content-scoped (object) entry is checked too: the declared file's
   content is read at the MERGE BASE of base/head (never `baseRefOid`
   directly — see [`nen release unit-check`](#nen-release-unit-check)'s
   own "content-scoped entries" section) and at head, over the same `gh api
   repos/{slug}/contents/<path>?ref=<sha>` calls that verb makes, and any
   leaf outside its declared `keys` sets `unitOk: false` with a
   `release unit-check: outside (content-scoped): "<path>" changed at
   "<key>"` line quoted verbatim, exactly as the standalone verb would print
   it.
5. **whose pr** — refused when the pull request is cross-repository (a
   fork's branch), or its author is not the viewer authenticated to `gh`.
   No branch-name rule.

**Usage**

```text
nen pr merge <n|owner/name#n|CODE#n> --release-unit --requirements-from <path> --repo <path> [--run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `<n\|owner/name#n\|CODE#n>` | **yes** | the pull request to merge | positional; a bare `<n>` resolves against `--repo`'s own `origin` remote; `owner/name#n` and `CODE#n` must name the SAME repository `--repo`'s `origin` does, or exit 2 — see *The ref* below |
| `--release-unit` | **yes** | says explicitly that this is a bounded release-unit merge | omitted: exit 2, "nen pr merge only merges a release unit" — there is no general-purpose merge here |
| `--requirements-from <path>` | **yes** | the same `{ name, pattern }` JSON array `pr body-check` takes | validated (exists, non-empty, parseable) BEFORE any `gh` call; checked against the pull request's CURRENT body, read live over `gh` — never a `--body-from` file, which could have drifted from what GitHub will merge |
| `--repo <path>` | **yes** | the checkout whose `origin` remote and `nen/gates.json` this merge is judged against | required, exit 2 if omitted; `release.unitPaths` itself is read from the PULL REQUEST'S BASE, not this checkout |
| `--run` | no | execute the merge once every gate passes | omit to see the plan only |
| `--json` | no | machine-readable result | — |

**The ref, and why it is narrower than `pr ready`'s
([zheref/nen#269](https://github.com/zheref/nen/issues/269)).** `pr merge`
and [`release unit-check`](#nen-release-unit-check) share one ref grammar:
`<n>`, `<owner/name>#<n>`, or `<CODE>#<n>`. Through v0.15.x that grammar
*matched* `HA#117` and then handed `HA` to the `owner/name` parser, which
refused it — `--target takes an owner/name repository slug and 'HA' is not
one` — so a ref that `pr ready HA#117` had just accepted was refused here.
The prefix is now told apart by shape: a `/` makes it an `owner/name` slug, a
code's shape (a letter, then letters and digits) makes it a **product code**,
resolved through `--repo`'s own `nen/repos.json` by **the same lookup `pr
ready <CODE>#<N>` uses** (`consumers[].code` first, then `product_codes`,
case-insensitive over ASCII letters only), and anything else is refused naming
the three forms. An unknown code (the refusal lists the known ones and the file
it read), a code that matches two registry keys differing only by letter case
(the refusal names every key and the repository each names — nen never picks
one), or a registry that cannot be read is exit 2. Case is folded for `A`–`Z`
alone, never by Unicode's rules, so a non-ASCII key (one spelled with U+212A
KELVIN SIGN, which Unicode lowercases to `k`) never answers a typed `K`; a
refusal prints such a key as `\u{212a}`. A code that resolves to any
repository **other than `--repo`'s origin** is refused at exit 2 before any
gate runs — a registry legitimately lists other repositories' codes, and this
verb never merges a repository `--repo` does not name:

```text
nen pr: 'HA#130' resolves 'HA' to 'zheref/hatsu' through --repo's own registry, but '--repo' at '/path/to/nen' has an origin of 'zheref/nen' -- these must be the same repository, and nen pr merge never merges a repository --repo does not name. Point --repo at a checkout of 'zheref/hatsu', or write the ref as a bare <n> to merge in 'zheref/nen'.
```

**The `#` is required — a deliberate narrowing.** `pr ready` also accepts
the no-`#` shorthand (`HA117`), whose split is a stated rule (the number is
the longest trailing digit run), not a delimiter; that is a fair trade for a
read-only verdict, and not one a verb that merges takes. `HA117` is refused
at exit 2 naming the `<CODE>#<n>` form.

**Without `--run`:** prints the plan only (every verdict line, plus the
exact `gh pr merge` argv that WOULD run, carrying `--match-head-commit`)
and exits 0 when every gate passed, 1 otherwise. **With `--run`:** on a
passing plan, executes `gh pr merge <n> --merge --match-head-commit
<judgedHead>` — NEVER `--admin`, NEVER `--auto`; this subcommand's own flag
set declares neither, so passing either is refused at the parser (exit 2)
before the merge composition ever runs. A `gh pr merge` exit 0 is not
itself trusted as "merged" — the pull request's state is re-read, and only
GitHub's own `MERGED` state is reported as `merged:`; anything else prints
`queued (auto-merge or merge queue):`, naming the state read back.

**Exit codes:** 0 merged, or a passing plan printed without `--run`; 1 at
least one gate did not pass; 2 usage (missing `--release-unit`, a bad ref,
an unknown product code or an unreadable `nen/repos.json`,
missing/empty/unparseable `--requirements-from`, `--repo`'s origin naming a
different repository than the ref or its code resolves to, or an unknown
flag such as
`--admin`/`--auto`); 5 `gh` REFUSED the merge (branch protection, a
required review, …) — its stderr and the exact command are printed for a
human to run once the refusal is resolved; 6 `gh` could not be RUN at all
(not on `PATH`, no permission) — distinct from 5, which means `gh` ran and
said no. Every echoed `gh` stderr line is redacted for a remote credential
first (the same redaction every other verb's echoed subprocess output
gets).

**`--json`** — `nen.pr.merge-unit/v0.1`: `{ contract, target, pr, ready,
bodyOk, unitOk, pinOk, wholeOk, ok, ran, spawnFailed, judgedHead, state,
mergeArgv, gates: [{ name, ok, lines }] }`.

**Example**

```bash
nen pr merge zheref/example#9 --release-unit --requirements-from pr-requirements.json --repo .
```
```text
pr ready: ready
head pin: pinned to cafebabe
pr body-check: 1/1 requirement(s) satisfied
  ok  how to verify
release unit-check: zheref/example#9: 1 changed file(s), unit 'src/unit/**'
release unit-check: every changed path is inside the release unit
whose pr: authored by the viewer ('someone'), same repository
plan only (pass --run to execute): gh pr merge 9 --repo zheref/example --merge --match-head-commit cafebabe
```
(from `src/pr/mergeunit.test.ts`'s scripted fixture)

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
duplicated, altered or extra hunk, and on an `--original` naming zero hunks — that last one is a refusal, not a
usage error, because the flag was spelled correctly and the file was read: it
just did not prove anything (`src/split/command.ts`; under `--json` the exit is
`result.ok ? 0 : 1`, so the zero-hunk refusal is exit 1 there too, with the
sentence in the `error` key). An **unreadable** `--original` or branch file is
exit **2**, not 1 ([#101](https://github.com/zheref/nen/issues/101)): this
verb's whole answer is a comparison between files, so one of them being absent
is a question that was never asked rather than a verdict that came out
negative — and the refusal names the resolved path, the errno, and which of the
two files it was. Exit 2 also on a missing `--original`/`--branches`
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
knows whether to move it before opening a PR (`classify`, read-only); and
folds a branch's own commits into one before it is pushed (`squash`, aka's
own residue); catches it up with its base (`catch-up`) and publishes it
(`publish`); and lists every checkout of the project (`worktrees`) and swaps
one worktree's committed tree into the core checkout and back (`swap`).


`--json`: the full `VerifyResult` — `{ ok, error, missing[], duplicated[], altered[], extra[], filesInOriginal, filesInBranches }`, where each entry of the four arrays carries `{ path, header }` and `duplicated` adds `branches[]`, `altered` adds `branch` and `diff`.
### `nen wc classify`

Reports one of `must-move` (on the trunk, dirty), `on-branch-dirty` (on a
branch with uncommitted work — whether it is the same effort as the
branch's existing commits is a judgement this verb hands you evidence for,
never decides), or `on-branch-clean` (nothing to commit). A git command that
FAILS (a `--base` that does not resolve, an unreadable status) is never folded
into one of the three cases as an empty/zero reading; it is reported as an
error and exits non-zero.

**A detached `HEAD` is classified like any other working copy**, not refused.
The classification is decided by *trunk-or-not* and *dirty-or-not*, and a
detached `HEAD` answers both: it is standing on no branch, so it is never the
trunk (`must-move` cannot apply — a commit made there lands on no branch at
all), and its tree is as dirty as any other. The branch is one **field of the
answer**, not a precondition of it: `--json` reports `branch: null` beside a new
`detachedAt` (the short sha), and the text output reads
`branch: (detached HEAD at <short sha>)`. A worktree added with `--detach`, a
bisect and a rebase step are all ordinary working copies. The one refusal left
is a `HEAD` that names no branch **and** resolves to no commit — a repository
with no commits yet, where there is nothing to classify.

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

**Output and exit codes** — human lines: `case: <case>`, then `branch: <name>`
(or `branch: (detached HEAD at <short sha>)`), then indented evidence lines;
`--json` top-level keys: `state` (`branch` — `null` on a detached `HEAD` —,
`detachedAt`, `isTrunk`, `dirty`, `aheadOfBase`, `existingCommitSubjects[]`,
`uncommittedPaths[]`), `result` (`case`, `evidence[]`). Exit 0 for any of the
three cases (a report, not a guard), **including on a detached `HEAD`**; exit 1
when the underlying git command fails (an unresolvable `--base`, an unreadable
status, a `HEAD` that resolves to no commit at all); exit 2 on a missing
`--repo`.

**Example**

```bash
nen wc classify --repo .
```
```text
case: on-branch-clean
branch: docs-usage-part1-scratch
  on 'docs-usage-part1-scratch' with nothing uncommitted -- open or report the existing PR
```
(from a real run, on a throwaway local branch created and deleted for this check; an unresolvable `--base` prints `could not count commits ahead of base` at exit 1)

**Example — a detached `HEAD`** (a real run, in a worktree added with
`git worktree add --detach`, with one tracked file edited)

```bash
nen wc classify --repo /tmp/wt-demo/detached
```
```text
case: on-branch-dirty
branch: (detached HEAD at 9ed03cf)
  on a detached HEAD at 9ed03cf, 0 commit(s) ahead of base, 1 uncommitted path(s) -- whether these are the SAME effort as the branch's existing commits is a judgement this module does not make; the commit subjects and paths below are the evidence for it
```
```bash
nen wc classify --repo /tmp/wt-demo/detached --json
```
```json
{
  "state": {
    "branch": null,
    "detachedAt": "9ed03cf",
    "isTrunk": false,
    "dirty": false,
    "aheadOfBase": 0,
    "existingCommitSubjects": [],
    "uncommittedPaths": []
  },
  "result": {
    "case": "on-branch-clean",
    "evidence": [
      "on a detached HEAD at 9ed03cf with nothing uncommitted -- open or report the existing PR"
    ]
  }
}
```
(exit 0 on both; the `--json` run was made against the same worktree with the edit reverted)

### `nen wc squash`

Folds every commit since `git merge-base <onto> HEAD` into ONE, whose message
is `--message-file`'s contents. The one write this family makes, and every
refusal below runs BEFORE it: a dirty working tree; `--onto` not an ancestor
of HEAD; any commit in the range already reachable from this branch's own
`@{upstream}` (fetched first, through the seam) — squashing published history
is refused outright; any commit in the range already on the **base**
(`origin/<base>` or the local `<base>`, whichever resolve) — what a catch-up
merge of the base brings into a branch, every one named with the ref it is
on ([#251](https://github.com/zheref/nen/issues/251)); a `--message-file` that fails the same shape
[`nen commit format`](#nen-commit-format) enforces (a Conventional Commits
header ≤ 72 characters, trailers as `Key: value` lines in the final
paragraph, and any attribution trailer this repository's
[`nen/workflow.json`](#nenworkflowjson) does not admit). Fewer than two
commits to fold is **not** a refusal: exit 0, one line (ending `base check: NOT performed.`, since the base is not read), nothing moves.

**Why the base is guarded on its own.** The fold set is `git merge-base
<onto> HEAD`..`HEAD`, so on a published branch that was caught up with a
**merge** of its base, `--onto <upstream sha>` reaches back through that
merge and would fold every base commit it brought in. Those commits are
published on `origin/<base>`, not on `origin/<branch>`, so the `@{upstream}`
check never sees them. The verb **refuses** rather than excluding them: a
fold that skipped them would still collapse the merge into a single-parent
commit and lose its ancestry. The refusal names every such commit and the
base ref it was found on; squash only the branch's own commits (an `--onto`
at or after the last base merge), or publish them unsquashed. `--dry-run`
reaches the same verdict the real call would. The base check reads the refs
already in the repository and does **not** fetch: a merge can only bring in
commits the repository already holds.

**Usage**

```text
nen wc squash --repo <path> --onto <ref> --message-file <file> [--base <branch>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the working tree being squashed | unbracketed in usage; omitted is refused at exit 2, exactly as `wc classify`'s (#28) |
| `--onto <ref>` | **yes** | the ref this branch is built on top of | e.g. `main` or `origin/main`; every commit `git merge-base <onto> HEAD` finds is folded |
| `--message-file <file>` | **yes** | the new commit's whole message | validated to `nen commit format`'s shape before anything moves |
| `--base <branch>` | no | the base whose commits are never folded | default: `nen/workflow.json`'s `branch.base` (`main` when the file is absent), the key [`wc publish`](#nen-wc-publish) reads; must be the **short** branch name that `git check-ref-format --branch` returns unchanged. Not `refs/heads/main`, not `@{-1}`, and nothing shaped like a refspec or a force. Otherwise it is refused at exit 2, because the guard builds `origin/<base>` and `<base>` from the name, and any other spelling would resolve nothing and silently skip the guard. The policy's value is held to the same rule, and a rejected one (`main/`) is exit 1 naming the file |
| `--dry-run` | no | print the commits that would fold and the message | spawns neither `git reset` nor `git commit` |
| `--json` | no | machine-readable result | `nen.wc.squash/v0.1` — see below |

**Mechanism.** `git reset --soft <merge-base>` then `git commit -F
<message-file>`, both through the seam, in that order, only once every
refusal above has passed. `git reset --soft` only moves the branch ref and
the index — it never deletes a commit object — so a `git commit` that then
fails leaves the original commits recoverable from `ORIG_HEAD` /
the reflog, which the verb's own error names. This verb never touches a
remote except the read-only fetch the upstream check makes, never pushes,
never force-anything.

**Output and exit codes** — text output is one line per folded commit
(`<sha> <subject>`, oldest first), a `base check:` line naming the refs the
base check ran against (or saying it was **NOT performed** because neither
`origin/<base>` nor `<base>` resolves), then either the new commit line
(`squashed into <sha>`) or, for `--dry-run`, the message that would have been
committed. `--json`'s contract is `nen.wc.squash/v0.1`: `{ contract, onto,
mergeBase, folded: [sha, ...], newSha, dryRun, base, baseRefs: [ref, ...],
injected: [key, ...] }`
— `folded` is oldest first; `newSha` is `null` for a dry run and for "nothing
to squash"; `base` is the base branch's name and `baseRefs` the refs checked,
**empty meaning the check was not performed** (no ref resolves, or nothing to
squash), never that it passed; `injected` is the read-back's verdict below,
`null` whenever nothing was written (a dry run, nothing to squash). Exit 0 on a
squash, a dry run, or "nothing to squash"; exit 2 on every refusal above,
naming it; exit 1 when a git command this verb did not expect to fail fails
anyway (an unresolvable `--onto`, a fetch that cannot reach the upstream, the
read-back) — never folded into one of the exit-2 refusals, exactly as
[`wc classify`](#nen-wc-classify)'s own git-failure rule — and when
`nen/workflow.json` is present and malformed; **exit 3 when the fold landed
and a hook injected a trailer the policy refuses**.

**The folded commit is read back** ([#273](https://github.com/zheref/nen/issues/273)),
exactly as [`commit write`](#nen-commit-write) reads its own and under the
same three rules: the message file through `git interpret-trailers --parse
--unfold --no-divider` before the reset, the folded commit through `git cat-file commit
<newSha>` and the same parser after. An injected key is named in `injected[]`
and on stderr with its source and rule, and the verb exits **3** — the squash
is **left in place, never amended**; `git reset --soft ORIG_HEAD` restores the
unsquashed commits (the fold changed no file). An added key nothing refuses is
a `nen: note:` line, exit unchanged. Because the read-back needs the policy,
`nen/workflow.json` is now loaded **once, before the message is judged and
before anything moves, on every squash**: a malformed one is exit 1 even with
`--base` and a message carrying no trailer, where it used to be read only for
a trailer or for `branch.base`.

**Example**

```bash
nen wc squash --repo . --onto main --message-file message.txt --dry-run
```
```text
would fold 3 commit(s) onto 40cc931000edabb8f7979aebd6fc69fe08c4716d (--onto main):
  ad31f70e4d58083fc5cf6590329dd101ec40ce98 feat: add one.txt
  6c2088d8016be75e3b0f2322c0747739850028e8 feat: add two.txt
  a46a710615ed8a118b5551f7d7319c988597150c feat: add three.txt
base check: none of the folded commits is on origin/main or main (branch.base's default -- no nen/workflow.json)
message:
  feat(wc): add one/two/three together

  Closes: #99
```
```bash
nen wc squash --repo . --onto main --message-file message.txt
```
```text
  ad31f70e4d58083fc5cf6590329dd101ec40ce98 feat: add one.txt
  6c2088d8016be75e3b0f2322c0747739850028e8 feat: add two.txt
  a46a710615ed8a118b5551f7d7319c988597150c feat: add three.txt
base check: none of the folded commits is on origin/main or main (branch.base's default -- no nen/workflow.json)
squashed into df56d7826b9d3df10ced19167122388e36d7ca10
```
Then the [#251](https://github.com/zheref/nen/issues/251) case: a branch
published at `d5f31529`, caught up with a merge of `origin/main` (which had
moved on by one commit), one more commit on top, and squashed `--onto` its own
upstream sha. Exit 2, nothing moved:
```bash
nen wc squash --repo . --onto d5f315297f2186697cfb953a8d18fad96b08fbd1 --message-file message.txt --dry-run
```
```text
nen wc: the base 'main' (branch.base's default -- no nen/workflow.json; checked against origin/main, main) already holds 1 of the 3 commit(s) since 'git merge-base d5f315297f2186697cfb953a8d18fad96b08fbd1 HEAD' (d5f315297f2186697cfb953a8d18fad96b08fbd1) -- a merge of the base brought them into this branch, and squashing would rewrite the base's published history into one commit on this branch and flatten the merge's ancestry: 6a1b27eec3511b87ddf80e938702bb062b708459 ('chore: the base moves on', on origin/main). Squash only this branch's own commits (an --onto at or after the last base merge), or publish them unsquashed.
Run 'nen wc --help'.
```
(from a real run, on a throwaway local repository with a bare `origin`, built
for this check: three commits on `docs-example` folded onto `main` into one,
`git log -1 --format=%B` afterwards reading exactly `message.txt`'s contents —
`feat(wc): add one/two/three together`, blank line, `Closes: #99`; then the
refusal above from the same repository. That the call without `--dry-run`
refuses in the same words is `src/wc/squash.integration.test.ts`'s claim)


### `nen wc catch-up`

Brings the current branch up to date with its base (v0.13.0,
[#227](https://github.com/zheref/nen/issues/227)) — the git Hatsu's `ao`
skill used to hand-roll. It fetches `origin/<base>`, decides rebase or merge,
runs exactly one of them, and on a conflict **stops**: the tree is left
exactly as git left it, every conflicted path is reported with our side and
their side, and the abort line is printed. It never picks a side.

**Usage** (needs **git ≥ 2.24** — the fetch is `--end-of-options`; an older
git is refused at exit 2 naming its version, never fetched around)

```text
nen wc catch-up --repo <path> --base <ref> [--strategy rebase|merge|auto]
                [--abort] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the working tree being caught up | unbracketed; omitted is refused at exit 2 — this verb moves the branch ref |
| `--base <ref>` | **yes** | the base branch | validated **before the first git call** by `git check-ref-format --branch` and refused at exit 2 (with git's answer) when git rejects it, or when it is shaped like an option, a refspec or a force (a leading `-` or `+`, a `:`) — so `--base=--upload-pack=/x` never reaches a fetch, under `--dry-run` either; then fetched as `git fetch --end-of-options origin refs/heads/<base>:refs/remotes/origin/<base>`, the refspec in full so nothing in the name is an option; the rebase/merge target is `origin/<base>`, never a stale local ref |
| `--strategy` | no | `rebase`, `merge` or `auto` (default) | **auto rebases when no commit of the branch is on its `@{upstream}`** and merges otherwise — the same published-commit detection [`wc squash`](#nen-wc-squash) refuses on, shared rather than copied. A rebase rewrites what somebody else may already hold |
| `--abort` | no | back out an in-progress rebase or merge | runs the matching `git rebase --abort` / `git merge --abort`; refused at exit 2 when nothing is in progress |
| `--dry-run` | no | print the strategy and the git line | fetches (a read), runs neither |
| `--json` | no | machine-readable result | `nen.wc.catch-up/v0.1` — see below |

**Mechanism.** `--base` is validated first (above), then a dirty tree is
refused at exit 2 before the fetch. Then `git fetch --end-of-options origin
refs/heads/<base>:refs/remotes/origin/<base>`, `before`/`behindBefore`/`aheadBefore` are read,
the strategy is resolved, and — unless the branch is already up to date
(`noOp: true`, exit 0, nothing run) — `git rebase origin/<base>` or
`git merge --no-edit origin/<base>` runs. **On a conflict** the report's
`conflicted[]` carries each path with `ours` — **always this branch's
side** — and `theirs` — **always the base's** — whichever index stage holds
it: on a merge stage 2 is this branch and stage 3 is `origin/<base>`; on a
rebase git replays this branch's commits on top of the base, so stage 2 is
`origin/<base>` and stage 3 the replayed commit, and the verb labels by
strategy so a reader never has to know which. Each side is capped at 4000
characters, is `null` where that side deleted the path (the stage is absent
from `git ls-files -u`), and reads `(binary, N bytes)` where the blob
carries a NUL — its size, never its bytes. Paths are read raw (`-c
core.quotePath=false`, `-z`), so a non-ASCII or spaced path is shown by the
same name git holds it under; a stage the index lists but `git show` cannot
read is an **error** at exit 1, never reported as a deletion. The text
output prints the sides indented under the path with every control byte but
the newline and tab stripped (`--json` keeps the bytes), then `to back out:
git <strategy> --abort`. Exit 1. Nothing is resolved, aborted or pushed.

**Resuming.** Re-run the **same command on the same tree** once the
resolutions are staged — Hatsu's `ao` already says so. The verb asks git
whether a rebase or merge is in progress (`git rebase --show-current-patch` / `MERGE_HEAD`,
through the seam, so a worktree's relocated git directory changes nothing)
and continues it: `git rebase --continue` under `GIT_EDITOR=true`, or
`git commit --no-edit` for a merge, reporting `resumed: true`. No status
refusal and no fetch on that path — the tree is dirty by definition. Unmerged
paths, or a staged file `git diff --cached --check` says still carries a
conflict marker, are reported as `conflicted[]` again at exit 1 with the
abort line, and nothing is continued over them; a continued rebase that
conflicts on a *later* commit reports that conflict the same way. A
`--strategy` that disagrees with what is in progress is refused at exit 2.
A rebase **paused with no current patch** (a `break` or a failed `exec`
line; `--show-current-patch` exits 1) is not one this verb started, so it is
refused at exit 2 naming `git rebase --continue` / `--abort`, and only
`--abort` acts on it. A probe git does not answer with 0, 1 or 128 is
refused at exit 2, never read as "nothing in progress". A 128 counts as
"no rebase" only once `git rev-parse --git-dir` shows git can answer in the
repository at all, since git exits 128 on any fatal (#307).

**`--json`** — `nen.wc.catch-up/v0.1`: `{ contract, base, strategy, before,
after, behindBefore, aheadBefore, noOp, conflicted: [{ path, ours, theirs }],
resumed, aborted, dryRun }`. `strategy` is the one that ran (`auto` resolved);
`after` is `null` on a dry run and on a conflict. Exit 0 on a clean catch-up,
a resume, an abort, a dry run or `noOp`; exit 1 on a conflict (the document is
still printed) or a git failure this verb did not expect; exit 2 on every
refusal above.

**Example**

```bash
nen wc catch-up --repo . --base main --dry-run
```
```text
fetched origin/main
strategy: rebase (auto -- nothing on 'origin/feature/x' yet)
would run: git rebase origin/main  (2 ahead, 3 behind)
```

### `nen wc publish`

Pushes the **current branch**, **under its own name**, and nothing else
(v0.13.0, [#227](https://github.com/zheref/nen/issues/227)) — `git push [-u]
<remote> -- refs/heads/<branch>:refs/heads/<branch>`, the refspec spelled in
full behind `--` so that no branch *name* can change what the push does.
Everything that could rewrite somebody else's history is refused before the
push. **Which remote** it goes to is decided in this order, and nowhere else:

1. **No upstream:** `--remote <name>` when given (it must be one `git remote`
   lists), else `origin`; `--set-upstream` then tracks `<remote>/<branch>`.
2. **An upstream of the same name** (`fork/feature` for `feature`), kept — no
   `--set-upstream`, or `--set-upstream` without `--remote`: the upstream's
   remote, with the fast-forward check made against `fork/feature`, the ref
   the push moves (Copilot review on
   [#231](https://github.com/zheref/nen/pull/231)). A `--remote` that names
   another remote is refused at exit 2 **without `--set-upstream`**, and the
   refusal names `--set-upstream --remote <name>` as the route — never `git
   branch --set-upstream-to <name>/<branch>`, which git itself refuses while
   that remote has no such branch, i.e. on a first publish.
3. **`--set-upstream` replacing the upstream** — one of another name (below),
   or one of the same name with a `--remote` naming another remote:
   `--remote <name>` when given (validated against `git remote` exactly as in
   1), else **`origin`** when this repository has one, else the upstream's own
   remote. A branch cut from `upstream/main` in a fork workflow, whose `origin`
   is the fork, is published to `origin` — never created on the canonical
   repository it was cut from.

**The destination is always the branch's own name**
([#271](https://github.com/zheref/nen/issues/271)). An upstream whose
branch name differs from the current branch's — a stacked branch tracking the
effort it was cut from, a branch cut from `origin/main` that still tracks it,
a local `feature` tracking `fork/topic` — is a fact to report, **never a
destination to follow**. Until #271 the push followed it (`feature` tracking
`fork/topic` went out as `refs/heads/feature:refs/heads/topic`, Copilot round 3
on #231), and on 2026-09-28 that put a stacked effort's commit on its base
branch and on the pull request open from it. Now:

- **Without `--set-upstream`** such a branch is **refused at exit 2**, before
  any fetch, naming the branch, the upstream and the upstream's branch, and
  naming `--set-upstream` as the way through. `--dry-run` reaches the same
  refusal; nothing is fetched or pushed and no document is printed.
- **With `--set-upstream`** the push goes to `<remote>/<branch>` — the remote
  rule 3 above resolves, the branch's own name — and its `-u` **replaces** the
  mismatched upstream: the report says `retargetedUpstream: true`, with
  `upstreamBefore` still naming what it tracked before and `destination` equal
  to `branch`. The fast-forward is judged against `<remote>/<branch>` when the
  remote already has it (`git ls-remote --exit-code`; exit 2 means no such
  ref, so there is nothing a push could rewrite) and **never** against the
  upstream's branch, which this push does not move. When it is not a
  fast-forward the answer is `needsForce: true` at exit 1: nothing is pushed
  and **nothing is retracked** (`retargetedUpstream: false`).
- **An upstream being replaced may already be gone** — a stacked branch whose
  base was merged and deleted still names it. Its fetch only feeds `ahead`, so
  on this route alone git's `couldn't find remote ref` is an answer, not a
  failure: `ahead: null`, and the text says `nothing counted: '<upstream>' is
  gone from <remote>`. Any other failure of that fetch, and the same answer on
  any other route, is still exit 1.
- An upstream naming the branch's **own** name on another remote
  (`fork/feature` for `feature`) is not a mismatch: it publishes to that
  remote as before (rule 2).

**The destination is never the trunk** (v0.13.1,
[#234](https://github.com/zheref/nen/issues/234)). `git worktree add -b x
origin/main` leaves `x` tracking `origin/main`; on 2026-09-21 a push that
followed it went out as `refs/heads/x:refs/heads/main` and fast-forwarded the
trunk with no pull request. A branch that tracks the trunk is one more
upstream of another name: since #271 a bare publish of it **refuses** (the
refusal says the upstream is the trunk) where v0.13.1–v0.15.1 pushed it under
its own name and left the upstream on the trunk — the same answer git's own
`push.default=simple` gives — and `--set-upstream` publishes it as `x` and
retracks it to `<remote>/x`. A trunk **destination** (`main`, `master` or
`branch.base`, compared normalized) is still checked on the final refspec,
right before the push, as a **defensive belt only**: while the destination is
the local name it cannot fire, because a local name that is the trunk was
refused first.

**Usage**

```text
nen wc publish --repo <path> [--set-upstream] [--remote <name>] [--dry-run] [--json]
```

| Flag | Required | Meaning |
|---|---|---|
| `--repo <path>` | **yes** | the working tree whose current branch is pushed |
| `--set-upstream` | no | push with `-u`, so the branch tracks `<remote>/<branch>` afterwards — **replacing** an upstream of another name, which is the only way past that refusal ([#271](https://github.com/zheref/nen/issues/271)), or one on another remote than `--remote` names |
| `--remote <name>` | no | where a branch with **no upstream** goes (default `origin`), and where `--set-upstream` takes a branch whose upstream it replaces (default `origin` when it exists, else the upstream's remote) — rules 1 and 3 above; must be a remote `git remote` lists. Without `--set-upstream` it is refused at exit 2 when a same-name upstream names a *different* remote, naming `--set-upstream --remote <name>` as the route (rule 2); `--remote` on any other `wc` subcommand is refused rather than ignored |
| `--dry-run` | no | print the push line; push nothing (the upstream is still fetched — a read) |
| `--json` | no | `nen.wc.publish/v0.1` — see below |

> Needs **git ≥ 2.24**: the upstream fetch is spelled `git fetch
> --end-of-options …`, a parse-options flag every git since 2.24 (2019)
> accepts on `fetch`. An older git that answers `unknown option` is refused at
> exit 2 naming its version — the flag is never dropped to make the fetch go
> through, because it is what keeps a branch name from being read as an
> option. The same floor applies to [`wc catch-up`](#nen-wc-catch-up).

**Refused at exit 2:** a detached `HEAD` (no branch to push); the trunk —
[`nen/workflow.json`](#nenworkflowjson)'s `branch.base`, and `main`/`master`
whatever the policy says — because the trunk moves by merging a pull request,
compared against the **normalized** name (a leading `+` and a `refs/heads/`
prefix taken off, so a branch git holds as `+main` is the trunk too), and
the trunk as the **destination** of the final refspec, whichever route named
it (#234); a
branch name git itself rejects (`git check-ref-format --branch`, asked
through the seam, its answer quoted); a branch name shaped like a refspec or
a force even where git accepts it — git will hold a branch named `+main`,
and `git push origin +main` is a force push of `main`; and anything that
looks like a refspec or a force on the command line: a positional, a `+`, a
`:`, and `--force`, which the strict parser already refuses as an unknown
option; a `--remote` shaped like an option, a refspec or a path, one `git
remote` does not list, or one that contradicts a same-name upstream without
`--set-upstream` (rule 2); and an upstream whose branch name is not the
current branch's, without `--set-upstream` (#271, above). The branch the
upstream tracks passes the same two checks before it is fetched, and the
fetch is `git fetch --end-of-options <remote>
refs/heads/<branch>:refs/remotes/<remote>/<branch>`, from the upstream's own
remote. **Exit 1, nothing
pushed:** any other fetch failure, including a missing ref on a kept upstream;
and the ref the push moves exists and the local branch is not a
fast-forward of it (fetched first, then `git merge-base --is-ancestor <ref>
HEAD` — the upstream, or `<remote>/<branch>` when `--set-upstream` is
replacing the upstream) — the push would need `--force`, and
this verb never forces; the report says `needsForce: true` and the text names
[`wc catch-up`](#nen-wc-catch-up) as the repair.

**`--json`** — `nen.wc.publish/v0.1`: `{ contract, branch, remote,
destination, upstreamBefore, ahead, needsForce, pushed, dryRun,
retargetedUpstream }`. `branch`
is the local branch, the source half of the refspec; `remote` is the one
pushed to, by rules 1–3 above; `destination` is the branch name on that remote the push updates — **always
`branch`** since #271, kept so a reader of the v0.1 contract has nothing to
change; `upstreamBefore` is `null` and `ahead` is `null` when the branch
tracked nothing before this call — or when the upstream `--set-upstream`
replaces is gone from its remote — and otherwise `ahead` counts the commits
not on `upstreamBefore`; `retargetedUpstream` is `true` only when `--set-upstream` replaced the
upstream — one of another name, or one on another remote than `--remote`
names — with `<remote>/<branch>` (on `--dry-run`, would replace it), and `false` whenever
nothing is (or would be) pushed, `needsForce` included. The refusals above are
exit 2 with the reason on stderr and **no** document. The text line is
`pushed '<branch>' to <remote>[ (upstream set)][ -- <n> commit(s) ahead of
<upstream>]` (or `-- nothing counted: '<upstream>' is gone from <remote>`),
and a retarget appends `-- its upstream '<upstreamBefore>' named another
branch` (or `the trunk`, or `another remote ('<name>')`) `, so it went to
<remote> under its own name and now tracks <remote>/<branch>`; `--dry-run`
says `would go` / `then track`.

**Example**

```bash
nen wc publish --repo . --set-upstream --dry-run
```
```text
would run: git push -u origin -- refs/heads/feature/x:refs/heads/feature/x  (no upstream yet)
```

### `nen wc worktrees`

Lists **every checkout of the project** — the core checkout (the one whose
`.git` is the common git directory) and each of its worktrees — so a caller
can see what each one holds before [`wc swap`](#nen-wc-swap) brings one into
core (v0.14.0, [#241](https://github.com/zheref/nen/issues/241)). Read-only.
`--repo` may name **any** of them: core is resolved through `git rev-parse
--git-common-dir`. Parsed off `git worktree list --porcelain`; a `prunable`
worktree (its directory is gone) is skipped.

**Usage**

```text
nen wc worktrees --repo <path> [--base main] [--json]
```

| Flag | Required | Meaning |
|---|---|---|
| `--repo <path>` | **yes** | any checkout of the project — core or one of its worktrees |
| `--base <branch>` | no | the distance column is measured against `origin/<base>` (default `main`) |
| `--json` | no | `nen.wc.worktrees/v0.1` — see below |

One row per worktree, core first: a `core` / `in` mark (`in` is the worktree
core is currently holding), the branch or `(detached)`, the uncommitted-path
count (untracked included), `+ahead/-behind` against `origin/<base>` (`?`
when that range does not resolve), the short HEAD, the last commit's subject
and git's own relative age, and the path. When a swap is active a closing
line names what core holds and its home. Exit 0; exit 2 outside a checkout.

**`--json`** — `nen.wc.worktrees/v0.1`: `{ contract, core, base, swap,
worktrees: [{ path, mark, branch, head, dirty, ahead, behind, lastSubject,
lastAge }] }`. `swap` is the swap record (below) or `null`; `mark` is
`"core"`, `"in"` or `null`; `branch` is `null` for a detached worktree;
`dirty`, `ahead` and `behind` are `null` when git could not answer.

**Example**

```bash
nen wc worktrees --repo .
```
```text
     BRANCH                                       DIRTY     ±main   HEAD      LAST COMMIT · PATH
core main                                         3         +0/-0   4f5c11a2b fix(stops): a decision on the page (2 hours ago) · /work/app
in   opus/kurapika/login-flow                     0         +2/-0   9a1e0c7d3 feat(login): the flow (5 minutes ago) · /work/app/.claude/worktrees/login
core is holding /work/app/.claude/worktrees/login (view); home: main
```

### `nen wc swap`

Brings one worktree's **committed** tree into the core checkout, and puts
core back (v0.14.0, [#241](https://github.com/zheref/nen/issues/241)). The
use: a developer who debugs from an IDE opened on core — its project path,
derived data, signing and untracked local config — sees a worktree's work
there instead of opening a second project on the worktree.

- **View (the default)** — core checks out the worktree's HEAD **detached**;
  the worktree keeps its branch, so a session working there is undisturbed.
  Swapping again picks up the worktree's newer commits and keeps the
  **first** swap's home.
- **`--take`** — the **branch** moves: the worktree is detached at the same
  commit and core checks the branch out, so a commit made in core lands on
  it. Refused on a detached worktree. A dirty core that is *viewing* the same
  commit is promoted to a take **in place**, its edits kept.
- **`--return`** — core goes back to its home branch (or its detached home
  commit); after a take the branch goes back to the worktree; core's parked
  work is restored.
- **`--status`** — the recorded swap, or `no swap active`.

**Only committed work travels**: a target worktree with uncommitted changes
is refused. **Core's own work is parked, never stashed** — the stash stack is
shared by every worktree and every session. Uncommitted work in core
(untracked included, **ignored never**) is written through a temporary index
into a commit pinned at `refs/nen/wc-swap/parked`, and only once that ref
exists is core cleared (`git reset --hard` + `git clean -fd`, never `-x`).
`--return` restores modified, new and deleted paths exactly, nothing staged,
and drops the ref. The swap record is `<common git dir>/nen-wc-swap.json`,
never in the tree. After a swap any changed `project.pbxproj`,
`Package.resolved`, `Podfile.lock` or `Cartfile.resolved` is named — the IDE
may ask to reload or re-resolve packages — measured from the tree the IDE had
open (the parked tree on a first swap from a dirty core) to the tree it has
now.

**Concurrency.** A swap and a return run under one advisory lock beside the
record (`nen-wc-swap.json.lock`, the phase and usage ledgers' own); a
second swap that finds it held is refused at exit 2 with nothing moved. The
record is written through a temp file and a rename, so `--status` and
`worktrees` never read half of one. A record whose fields are not the
contract's types is refused at exit 1 rather than read around.

**While a take is active** the branch is core's and its worktree is detached;
naming that branch or that worktree means the take's own target, which gets
the branch back first — so a re-swap views the branch's **current** tip,
commits made in core included.

**Usage**

```text
nen wc swap <worktree path | branch | worktree dir name> --repo <path> [--take] [--json]
nen wc swap --return --repo <path> [--json]
nen wc swap --status --repo <path> [--json]
```

| Flag | Required | Meaning |
|---|---|---|
| `<target>` | for a swap | a worktree's path (a relative one resolves against `--repo`), its branch, or its directory name; a name matching two worktrees is refused — pass the path |
| `--repo <path>` | **yes** | any checkout of the project; core is resolved from it |
| `--take` | no | move the branch into core rather than view its commit |
| `--return` | no | put core back; takes no target |
| `--status` | no | print the swap record; takes no target |
| `--json` | no | `nen.wc.swap/v0.1` — see below |

`--take`, `--return` and `--status` are refused on every other `wc`
subcommand, and `--base` is refused here, rather than accepted and ignored.

**Exit codes** — the reference engine's own, kept:

| Code | Meaning |
|---|---|
| `0` | done |
| `2` | refused before anything moved — an unknown or ambiguous target, core itself, no swap to return from, `--take` on a detached worktree, a bad argument, not a checkout, `refs/nen/wc-swap/parked` still pinned by an interrupted swap with no swap recorded (a second park would overwrite it; the refusal names the recovery), or another swap holding the lock |
| `3` | a tree is dirty — the target on a swap, core on `--return` or a re-swap, or a submodule dirty *inside* core on a first swap (a park holds the superproject's gitlink only, so those edits could be neither kept nor cleared) — every path listed on stderr; nothing moved, and nothing is committed, discarded or stashed on anyone's behalf |
| `1` | a git step failed part-way; the message says where, and the parked commit is still pinned |

`3` is not `2` on purpose, unlike [`wc squash`](#nen-wc-squash)'s and
[`wc catch-up`](#nen-wc-catch-up)'s dirty refusal: the invocation was right,
and what the caller owes is a decision about somebody's uncommitted work.

**`--json`** — `nen.wc.swap/v0.1`: `{ contract, action, core, coreBranch,
head, active, target, branch, mode, home, homeSha, parked, reloadHints,
dirty }`. `action` is `swap`, `promote`, `return` or `status`; `coreBranch`
and `head` are core's after the run; `mode` is `view` or `take`; `home` is
`null` when core's home was a detached commit (`homeSha`); `dirty` is `{
checkout, paths[] }` on exit 3 (printed to stdout as well as the prose to
stderr) and `null` otherwise. After `--return`, `active` is `false` and the
other fields describe the swap that was undone. The record in the common git
directory is `nen.wc.swap.state/v0.1`: `{ contract, target, branch, mode,
home, homeSha, parked }`.

**Example**

```bash
nen wc swap opus/kurapika/login-flow --repo .
```
```text
core now holds 'opus/kurapika/login-flow' from /work/app/.claude/worktrees/login (view, 9a1e0c7d3).
core's uncommitted work is parked at 5b7c2e110 (refs/nen/wc-swap/parked); 'nen wc swap --return' restores it.
project or dependency files changed -- the IDE may ask to reload or re-resolve packages:
  App.xcodeproj/project.pbxproj
```

<a id="family-stage"></a>

**`nen stage`**

Flags what should never be staged blind, tensho §3's own table: secret
shapes, binaries, out-of-scope paths and unmentioned deletions. It detects,
never decides — the yes to stage a flagged file is always the human's. A
git-ignored path is reported separately, never as a flag: it cannot be staged
without `-f`, so there is nothing to ask.

### `nen stage triage`

Reads `git status --porcelain=v1 -z --ignored -uall` and reasons over every
entry: a secret-looking name (`.env`, `*.pem`, `*.key`, `credentials*`), a
**local-config filename** (the `.local` infix — `settings.local.json`,
`.env.local`, `config.local.yml`), a file **at or over `--large-bytes`**, a
binary, a path outside `--scope`, or a deleted path whose basename
`--mentions` never names — each of these is FLAGGED, needing a human's yes
before it is staged. A git-ignored entry is a FACT rather than a question (a
plain `git add` cannot stage it at all) and is reported in its own `ignored`
bucket instead: a repository with a large ignored tree (`node_modules/`, a
generated surface mirror under `.cursor/`) no longer buries the handful of
rows that actually need a decision under thousands that don't
([#169](https://github.com/zheref/nen/issues/169)). An entry that is BOTH —
a secret-shaped file inside an ignored directory, say — stays in `ignored`
with every reason it matched, `secret-shape` included, and never appears in
`flagged`.

**Usage**

```text
nen stage triage --repo <path> [--scope src/,docs/] [--mentions "<free text>"]
                 [--large-bytes <n>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the working tree whose unstaged files are triaged | unbracketed in usage; omitted is refused at exit 2 (#28) |
| `--scope <a,b>` | no | in-scope path prefixes | omit to skip the out-of-scope check entirely |
| `--mentions <text>` | no | free text (a commit message draft, a PR description) searched for a deleted path's basename | an unmentioned deletion is flagged, never silently staged |
| `--large-bytes <n>` | no | bytes at or above which a file is flagged `large` | default **1048576** (1 MiB) — no ordinary source file trips it, a multi-megabyte accident does. A default exists here where [`loop slots --local-cap`](#nen-loop-slots) refuses one, because that flag is a concurrency *guard* whose forgotten default silently widens what is allowed, while this is a *detection* threshold on a verb that decides nothing and whose default errs toward flagging. A zero or negative value is refused at exit 2. |
| `--json` | no | machine-readable triage | — |

**The two detectors added for [#57](https://github.com/zheref/nen/issues/57).**
`local-config` is a **filename** check like the secret shape, not a directory
rule: `.claude/` and `.vscode/` hold committed project configuration as often as
personal settings, and flagging every file in them would bury the rows that need
a decision under the ones that do not. `large` is measured at the CLI seam and
handed to the pure module, and a path the verb could not measure — a deletion, a
broken symlink — is **never** flagged `large`, because "not measured" must not
render as "measured and small". **An ignored path is not measured either**: it
can never reach `flagged`, never affects the exit code and is never listed in
text, so statting a `node_modules/` tree would buy one unread `--json` field for
thousands of synchronous stats on every invocation. Both travel alongside every other reason a file
matched: `.env.local` comes back `[secret-shape, local-config]`.

**Output and exit codes** — human lines: `clean: <n> file(s)` then each
clean path; `ignored: <n> file(s), not listed` (a count only — this verb has
no `--verbose` flag, so the ignored paths themselves are never printed in
text, only under `--json`); and (if any) `flagged: <n> file(s) -- never
staged without an explicit yes` then each flagged path with its reason tags.
`--json` top-level keys: `clean[]`, `flagged[]` and `ignored[]` (each of the
latter two `{ path, reasons[] }`). **The exit code follows `flagged` only**:
exit 0 when nothing is flagged — including a tree that is entirely
ignored rows — exit 1 when anything is flagged or the underlying `git
status` fails, exit 2 on a missing `--repo`.

**Example**

```bash
nen stage triage --repo . --scope "src/,docs/"
```
```text
clean: 1 file(s)
  src/a.ts
ignored: 2 file(s), not listed
flagged: 1 file(s) -- never staged without an explicit yes
  .env  [secret-shape, out-of-scope]
```
(from a real run against a throwaway scratch git repository: a committed,
in-scope `src/a.ts` carrying an uncommitted edit, an untracked `.env`, and a
`node_modules/` — ignored via `.gitignore` — holding both an ordinary file
and its own `.env`, which the `--json` form below shows still carries
`secret-shape` inside the `ignored` bucket)

```bash
nen stage triage --repo . --scope "src/,docs/" --json
```
```json
{
  "clean": ["src/a.ts"],
  "flagged": [{ "path": ".env", "reasons": ["secret-shape", "out-of-scope"] }],
  "ignored": [
    { "path": "node_modules/leftpad/.env", "reasons": ["ignored", "secret-shape", "out-of-scope"] },
    { "path": "node_modules/leftpad/index.js", "reasons": ["ignored", "out-of-scope"] }
  ]
}
```

A tree with only ignored rows — the shape a `node_modules/` or a generated
surface mirror produces — now exits 0 instead of flooding `flagged`:

```bash
nen stage triage --repo .
```
```text
clean: 0 file(s)
ignored: 2 file(s), not listed
```
(exit 0 — same scratch repository, with the in-scope edit and the untracked `.env` committed away first, leaving only the ignored `node_modules/` tree dirty)

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


`--json`: the `Board` — `{ repo, generatedAt, rows[] }`, where `generatedAt` is the caller's own `Seams.now()` and never the live clock, so a rendering is reproducible.
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

**The seven printable values, and why the taxonomy is still five.** senkei §3's
taxonomy has five classes — `delivering`, `building`, `stalled`, `queued`,
`idle` — and this verb's own name for itself says so. Two more values are real,
reachable output, and they are answers *about* the taxonomy rather than members
of it: `state-machine-violation` (two stage labels at once, flagged rather than
resolved by guessing which is authoritative) and `undecidable` (no stage label,
no mode label, no PR and no live integration branch — nothing here places the
object anywhere). **Handle both in any caller that switches on the class.**
`--help` used to name the count and five of the six it listed, mentioning
`undecidable` nowhere at all (zheref/nen#53); it now names all seven with the
counts derived from the lists rather than written, `src/effort/classify.ts`
carries a compile-time proof that the list covers the union (the error names
the missing class), and `src/effort/command.test.ts` fails the build if a class
in that list is missing from the help text.

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


`--json`: an ARRAY, one entry per input row — each input object merged with its `effortClass` and `evidence[]`.
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

### `nen loop iterate`

Claims one iteration of an izanagi loop against the cap its own invocation states, and refuses the claim past it. [`parse izanagi`](#nen-parse-skill) refuses an invocation with no `up to <N>` — which makes the cap's presence and shape nen's business — and then never sees iteration 2; [`watch until --max-iterations`](#nen-watch-until) is a different, optional bound on **izanami's** read-only loop, whose own help says so. So the count of how many times the *mutating* task had actually run lived entirely in the caller's own prose, with no nen-side backstop against a caller that miscounts (zheref/nen#47).

nen is a stateless CLI and the loop belongs to the caller; what nen owns is the **count**. The caller claims each iteration *before* performing it, and the cap is enforced by the claim being refused rather than by anyone remembering.

**Usage**

```text
nen loop iterate --id <id> --line "<task> until <condition> up to <N>"
                 [--release <why>] [--repo <path>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--id <id>` | yes | This loop's own label, and the name of its ledger. | One path segment: 1–100 characters of `[A-Za-z0-9._-]`, starting with a letter or digit, no `..`. **Refused, never sanitised** — two ids mangled to one segment would silently share a cap between two loops, which is the failure this verb exists to prevent. |
| `--line "<...>"` | yes | The invocation, restated on **every** claim and parsed by the izanagi grammar. | A claim whose line differs from the running one is refused (exit 2), naming both: a cap a caller can raise by re-typing the line with a bigger N is not a cap. It also catches the honest version — a second loop reusing an id that already belongs to a different task. |
| `--release <why>` | no | End the loop instead of claiming: the condition became true, or a gate ended it. | The reason is required text; an empty one records that a loop stopped and not why. Releasing twice is not an error; claiming after a release is. A loop at its cap can always still be released — the way out is never blocked. |
| `--repo <path>` | no | The repository the ledger lives under. | Ledger path is `.nen/loop/<id>.json` — the dot-prefixed generated tree, never the committed `nen/`, the same rule [`stop --mark`](#nen-stop) follows. |
| `--json` | no | One machine document per claim. | `{ contract: "nen.loop.iterate/v0.1", id, claimed, capReached, task, condition, cap, iterations, remaining, released, releaseReason, startedAt, lastAt, path }`. |

**Output and exit codes** — `iteration <n>/<cap> -- <task> until <condition>` on a claim, `released <id> after <n>/<cap> iteration(s): <why>` on a release. Exit **0** on either. Exit **1** when the cap is REACHED — an answer, not a failure: izanagi's cap is grammar rather than a default precisely so that reaching it is a decision to bring to a human, never a bound to raise and re-run. Exit **2** for a malformed `--id`, a `--line` the grammar refuses, a changed line, a claim after a release, or a ledger that cannot be read (refused rather than started again: a loop whose count nen cannot read has an unknown number of writes behind it, and beginning at 1 would hand out a whole cap's worth more).

**Example**

```bash
nen loop iterate --id sweep --line "address the backlog until it is empty up to 3"
```
```text
iteration 1/3 -- address the backlog until it is empty
  2 remaining after this one; ledger /repo/.nen/loop/sweep.json
```
The fourth claim, after three:
```text
nen: loop 'sweep' has claimed all 3 iteration(s) its invocation allowed, so this claim is REFUSED.
nen:   address the backlog until it is empty up to 3
nen: This is the cap doing its job, not a failure: izanagi's cap is grammar rather than a default precisely so that reaching it is a decision to bring back to a human, never a bound to raise and re-run. End the loop with --release <why>, and take what it reached to the gate.
```
(from a real run against a temporary `--repo`)

<a id="family-warmup"></a>

**`nen warmup`**

Detects stale or missing version pins across every consumer recorded in the target repository's
`nen/repos.json`, and optionally sweeps a set of handbook questions for which repositories have not
answered them. It only reports — it never edits the registry, and "not checked" is always distinct from
"checked and clean".


### `nen phase`

`nen phase begin|end|show` -- the per-phase timing ledger (v0.11.0, zheref/nen#216). `nen shu` already
measures how long every step took and prints it; nothing recorded when a workflow PHASE began or ended, so
"what is slow" was inference. This family writes that fact once, on every surface, to
`.nen/phases/<effort>.json` (generated output, gitignored), contract `nen.phase.ledger/v0.1`.

```
nen phase begin --effort <id> --phase <name> [--surface <s>] [--model <alias>] [--note <text>]
nen phase end   --effort <id> [--phase <name>] [--exit <code>] [--note <text>]
nen phase show  --effort <id> [--json]
```

`begin` opens an entry stamped with this invocation's clock; `end` closes the most recent OPEN entry -- the
one named by `--phase`, or the last opened -- and records `durationMs` (`endedAt - startedAt` on the seam's
clock, the same measure `shu` prints) and the exit code the caller reports. `nen report data` FLATTENS every
ledger into `phases[]`, one element per entry carrying its `effort`, so a template iterates entries directly. Two open entries with one name
are refused; `end` with nothing open is a usage error naming the effort. An effort id is the caller's (a
branch slug, a PR number, a session id); a `/` in it becomes `-` in the filename. `nen report data` merges
every ledger it finds as `phases[]`.

**`--json`** — `begin` and `end` emit `{ path, entry: { phase, startedAt, endedAt, durationMs, exitCode,
surface, model, note, steps } }`; `show` emits the ledger itself, `{ contract: "nen.phase.ledger/v0.1", effort,
phases: [ … ] }`. `steps` is `[]` from `begin` (v0.13.0, [#227](https://github.com/zheref/nen/issues/227)) and
grows by one `{ verb, argv, exitCode, durationMs, stalled }` per step a `nen shu <verb> --effort <id>` run
executes while the entry is open — the executor never opens an entry of its own. `show` renders them
indented under their phase. The contract stays `v0.1`: the key is additive, and an entry written before it
existed reads as `steps: []`.

```
nen phase begin --effort HA/85 --phase breath --surface codex
nen phase end   --effort HA/85 --exit 0
ended breath on 'HA/85' after 7500ms (exit 0) -- /…/.nen/phases/HA%2F85.json
nen phase show --effort HA/85
effort: HA/85 (2 phase entries)
  breath            7500ms  2026-01-01T00:00:00.000Z  exit 0 · codex
  rasengan            open  2026-01-01T00:00:08.000Z
    build        1200ms e0  pnpm turbo run build
```


<a id="family-usage"></a>

**`nen usage`**

Records what an effort COST, beside what [`nen phase`](#nen-phase) records
about how long it took: which surface ran, which model alias, the token
counts the surface exposed, the wall minutes, and where the numbers came
from. Nen reads nothing from a surface and prices nothing — the caller types
what it obtained, and a surface that exposes nothing says so.

### `nen usage`

`nen usage record|show` -- the per-effort usage ledger (v0.13.0, [#227](https://github.com/zheref/nen/issues/227)).
One JSON file per effort under `.nen/usage/<effort>.json` (generated output, gitignored), contract
`nen.usage.ledger/v0.1`; `record` appends ONE entry per call, stamped with the invocation's clock, and
`show` prints the ledger and the totals per surface and model.

```
nen usage record --effort <id> --surface <s> [--model <alias>]
                 [--input <n>] [--output <n>] [--cache-read <n>] [--cache-write <n>]
                 [--minutes <n>] [--source <text>] [--note <text>] [--not-reported] [--repo <path>] [--json]
nen usage show   --effort <id> [--repo <path>] [--json]
```

| Flag | Meaning |
|---|---|
| `--effort <id>` | the effort — the same id `nen phase` takes (letters, digits, `.`, `_`, `-`, `/`; a `/` is percent-encoded in the filename), so one effort names both ledgers |
| `--surface <s>` | which surface ran (`claude-code`, `codex`, `cursor`, `antigravity`), recorded verbatim |
| `--model <alias>` | which model alias ran, recorded verbatim; `null` when absent |
| `--input` / `--output` / `--cache-read` / `--cache-write <n>` | token counts, non-negative whole numbers; each is `null` when absent, never `0` — zero is a measurement and null is the absence of one |
| `--minutes <n>` | wall minutes, a non-negative number |
| `--source <text>` | where the numbers came from, in your own words: `claude /cost`, `codex session log`, `gh actions timing` |
| `--note <text>` | one free-text line kept on the entry |
| `--not-reported` | this surface exposed no numbers: every count is recorded `null` and `notReported` is `true`. Given together with ANY number it is refused at exit 2 — a surface either reported or it did not |

An entry with no number and no `--not-reported` is refused at exit 2 (it would record nothing about
anything), as is a bad count or an effort id outside the alphabet. A ledger file that is present and does
not carry the contract is exit 1, never appended to. `show` on an effort with no ledger is exit 0 with zero
entries.

**`--json`** — `record` emits `{ path, entry }`; `show` emits the ledger plus its totals:
`{ contract: "nen.usage.ledger/v0.1", effort, entries: [{ recordedAt, surface, model, input, output,
cacheRead, cacheWrite, minutes, source, note, notReported }], totals: [{ surface, model, entries,
notReported, input, output, cacheRead, cacheWrite, minutes }] }`. A `null` number adds nothing to a total.
[`nen report data`](#nen-report-data) merges every ledger it finds as `usage[]`, one row per entry carrying
its `effort`.

```
nen usage record --effort HA/85 --surface claude-code --model opus --input 1200 --output 300 --cache-read 9000 --minutes 7.5 --source "claude /cost"
recorded claude-code/opus on 'HA/85' -- /…/.nen/usage/HA%2F85.json
nen usage record --effort HA/85 --surface cursor --not-reported
recorded cursor on 'HA/85' (not reported) -- /…/.nen/usage/HA%2F85.json
nen usage show --effort HA/85
effort: HA/85 (2 usage entries)
  2026-09-20T10:00:00.000Z  claude-code/opus         in 1200  out 300  cache r/w 9000/-  7.5 min  (claude /cost)
  2026-09-20T10:00:00.000Z  cursor                   not reported
totals:
  claude-code/opus         in 1200  out 300  cache r/w 9000/0  7.5 min  (1 entry)
  cursor                   in 0  out 0  cache r/w 0/0  0 min  (1 entry, 1 not reported)
```

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


`--json`: `{ current, pinFindings[], questionSweep }`, where `questionSweep` is `{ checked: false }` when no sweep ran and `{ checked: true, gaps[] }` when one did — never a silent "no gaps".
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

**The target's `monitor` policy is the default pace (v0.11.0, zheref/nen#216).** When the checkout under
`--repo` carries a `nen/workflow.json`, `monitor.pollSeconds` (×1000) is the default `--interval-ms` and
a declared `monitor.maxCycles` is the default `--max-iterations` (a declared `0` means the watch never runs: exit 1, nothing observed); a typed flag still wins, and a
repository with no policy file keeps the old 5000 ms and unbounded defaults. Through v0.10.0 the block
was parsed and consumed by nothing, so a file that said 300 s watched every 5 s.

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--command "<bin> <args...>"` | yes | The read-only observation to repeat. | Spawned directly, no shell — `<bin>` must be a real executable on PATH (a shell builtin fails at spawn). Split into arguments with a POSIX shell's *quoting* and nothing else (see [quoting](#watch-until-quoting) below). Classified before the first run; a mutating command refuses at exit 2. |
| `--true-pattern <regex>` | no | Regex tested against the command's stdout. | Omit to treat exit code 0 as true. When given, a non-zero exit is an OBSERVATION ERROR, not a false reading. |
| `--interval-ms <n>` | no | Pace between observations. | Default 5000. |
| `--max-iterations <n>` | no | A safety bound, not izanagi's mandatory cap. | Omit for an unbounded watch; an error streak still stops it. |
| `--cwd <path>` | no | Working directory for the spawned command. | Defaults to the process's own cwd. |
| `--error-exit-threshold <n>` | no | In exit-code-as-truth mode (no `--true-pattern`), an exit code at or above this is an OBSERVATION ERROR. | Default 2; ignored when `--true-pattern` is given. |

**Output and exit codes** — human rendering is one `"[<n>] <message>"` line per observation, then a
final line naming the outcome. `--json` prints `{ outcome, iterations }`, each iteration carrying
`{ iteration, conditionTrue, errored, message }`. Exit 0 when the condition became true; exit 1 on an
error streak or a bound reached; exit 2 when `--command` is missing/empty, or it classifies as
mutating or unknown — which includes a metacharacter a shell would act on, an unclosed quote, a
trailing backslash, whitespace other than a space or a tab, and a NUL byte (below).

<a id="watch-until-quoting"></a>

**Quoting — one tokeniser, classified and spawned ([#288](https://github.com/zheref/nen/issues/288)).**
The `--command` line is split into arguments exactly as a POSIX shell would *quote* it — `'...'` is
literal, `"..."` is literal except that `\` escapes `$`, `` ` ``, `"` and `\`, a bare `\` escapes one
character, adjacent pieces join (`a'|'b` is one argument, `a|b`) — and then spawned with no shell, so
nothing is expanded: a `$VAR`, a glob, a `~` or a `#` reaches the command as typed. Every verdict is
computed from the **same** argument vector the spawn uses: the metacharacter check asks of your line
only whether a shell would act on a character; the `gh api` row walks the argument vector itself, the
way gh's own flag parser will; and every other row reads a rendering of it (plain elements bare, the
rest single-quoted) that splits back into exactly that vector. So a metacharacter *inside* one argument
is just a character of it — a `gh pr`/`gh issue`/`gh run`/`gh repo` read, a plain file read (`cat`,
`[ -e … ]`, `test ! -f …`), a read-only nen verb and `gh api` all accept it — while a read whose
verdict scans every argument
(`git log`/`diff`/`show`/`fetch`/`branch`/`remote`, nen's gated verbs) still refuses an argument
outside its safe set, as before. That is what makes the ordinary jq idiom a plain read:

```bash
nen watch until \
  --command 'gh pr view 295 --repo zheref/nen --json reviews --jq "[.reviews[]|select(.commit.oid|startswith(\"ecc420c\"))|.author.login]"' \
  --true-pattern '"cursor"'
```
```text
[1] condition is true (exit 0)
condition became true after 1 observation(s)
```
(run for real against [zheref/nen#295](https://github.com/zheref/nen/pull/295))

What still refuses at exit 2, with the same message as before: a `|`, `;`, `&` (so `&&`), `<`, `>`,
`(`, `)` or backtick a shell would **act on** — unquoted and unescaped — and a backtick or `$(` inside
`"..."`, where a shell still substitutes; a newline or a CR anywhere; and a `%` anywhere, quoted or not
(cmd.exe's `%VAR%` rule, unchanged). Four refusals are new, because a split with no shell has to
refuse wherever the argument vector would be a guess: an unclosed `'` or `"` and a trailing unquoted
`\` (a shell would wait for more input), whitespace other than a space or a tab (a word boundary to
some readers and not to others), and a NUL byte (the operating system ends an argument there, so the
program would receive a different one). Through v0.17.0 the classifier scanned the joined line — so
the jq example above refused on its `|` — and the spawn split on whitespace and kept every quote, so a
`--jq '.number'` the classifier accepted reached jq as `'.number'` and failed to parse; both halves
now read one argument vector. [`nen parse izanami`](#nen-parse-izanami) keeps the whole-line check:
its verdict goes to a skill-side shell, and in cmd.exe a single quote quotes nothing.

**On Windows the whole-line check stays for the watch too, for now.** A `.cmd`/`.bat` target is run
through cmd.exe, which re-parses the arguments by its own rules — an argument such as `a|b` reaches it
as a bare pipe — and whether the spawn can resolve a bare `gh` to such a shim ahead of `gh.exe` has not
been verified on a Windows host. So on Windows a metacharacter refuses wherever it sits, quoted or not,
exactly as through v0.17.0; the quote-stripping half applies everywhere (`--jq '.number'` reaches jq as
`.number` on every host).

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


`--json`: an ARRAY of `{ from, to, status, message }`, one per rename attempted.
### `nen schema check`

Answers "can this repository's taxonomy be read at all, and by which files": every REQUIRED file
(labels, repos, colors) failing fails the whole report; `gates.json` is optional in the sense that its
ABSENCE does not fail the report (only the readiness verbs need it) — but a `gates.json` that IS present
and malformed is still required, because a file that exists and is wrong is a defect in this
repository's own taxonomy, not a feature it simply hasn't adopted. `nen/contract.json` is optional the
same way, one step further: its absence is an `ok` row reading `absent (optional)`, and only a contract
that is present and malformed fails.

[`nen/workflow.json`](#nenworkflowjson) is optional in a **third** sense, and its row says which one:
its absence is an `ok` row reading `absent (defaults apply)`, because every parameter in that file has a
default and a repository that states no policy still runs under one. An absent contract is *nothing to
read*; an absent policy is *a full policy made of defaults*, and telling the two apart is the whole
reason they are two sentences. Present, the row names what the file decides — the coverage ladder, the
branch template and the trunk. Present and malformed, the row FAILS naming the **pointer**, exactly like
a malformed contract; and the closing refusal for that case does **not** say "nen has no built-in copy
to fall back on", because for this one file it has: nen is deliberately declining to apply its own
default over a policy the repository states and nen could not parse.

It is also where the `schemas/` → `nen/` migration is reported, in the shape v0.5.0 left it: `nen/` is
the only directory anything reads, so the report distinguishes two, unrelated findings instead of the
four the fallback needed. A REQUIRED file present only under `schemas/` FAILS the report exactly as an
absent file always has — its `detail` is the ordinary "no such file" refusal, with one addition: it
names the legacy copy it found and the migration (`nen scaffold init --accept-detected`, or copy it by
hand). A file that DID load from `nen/`, with a `schemas/` copy still sitting beside it, is a
**leftover**: a `warn` row, never a `FAIL`, with an indented `^ a legacy '<path>' copy is still
there…` line naming the `git rm` that clears it. It is a `warn` because `nen/` is the only file anything
reads now — a stale duplicate is clutter to delete, not a correctness risk, so whether its bytes still
agree with `nen/`'s no longer changes the verdict, and detecting the leftover is a stat, never a read: an
unopenable `schemas/` copy (a directory, a broken symlink) is still reported as a leftover to delete.

**Usage**

```text
nen schema check --repo <path> [--json]
```

**Four POINTER rows (zheref/nen#220, #227).** Four rows name a pointer
rather than a file — `nen/workflow.json#reports.sections`,
`nen/workflow.json#review.scopes`, from v0.13.0
`nen/workflow.json#profile`, and from v0.18.0 `nen/workflow.json#runners`
(the pools, each with its labels and enable variable, or `none declared`) —
and the `#` is what lets a machine reader
tell them from the file rows. They sit immediately under the policy row they
read out of and answer a question it does not: whether this repository declares
the thing [`report render --variant`](#nen-report-render) and [`review
scopes`](#nen-review-scopes) need, and which run profile a bare turn runs
under — which a warm-up should not have to read a coverage ladder to find out.
None is ever required and none FAILs on its own — a malformed block already
fails the policy row by pointer. A repository that declares neither of the
first two has not adopted the two verbs, which reads `none declared`; the
`profile` row reads the defaults when the key is absent, e.g.
`nen/workflow.json#profile  default standard; allowed fast, standard, thorough`.

**Two optional rows from v0.11.0 (zheref/nen#216).** `nen/colors.yml` is **optional**: an absent file is an
`ok` row reading `absent (optional)` and no longer fails the aggregate -- the verbs that resolve a colour
(`nen color status`, the board renderers) refuse by name when asked, which is where that refusal belongs.
Present and malformed still FAILs by pointer. `nen/decisions.json` -- the decision matrix, contract
`nen.decisions/v0.1` -- is the seventh and last row: absent reads `absent (none declared)`, present reads
the row counts by class, and a malformed row FAILs by pointer. Its shape:

```json
{ "contract": "nen.decisions/v0.1",
  "rows": [
    { "id": "dirty-tree", "class": "autonomous", "default": "nen shu warmup --carry --branch <branch>" },
    { "id": "mode-unknown", "class": "ask-once-per-run", "proposeIssue": true,
      "preferred": [ { "key": "A", "label": "Transmuter", "command": "…", "recommended": true },
                     { "key": "B", "label": "Conjurer",   "command": "…" } ],
      "surfaces": { "codex": { "picker": "request_user_input" } } },
    { "id": "semantic-conflict", "class": "human-gate", "gate": "G5",
      "preferred": [ { "key": "A", "label": "take ours", "command": "…" } ] }
  ] }
```

`class` is one of `autonomous` (resolved by `default`, no question), `ask-once-per-run` (asks once, seeded by
`preferred`) or `human-gate` (a gate canon reserves for a person, named by `gate`). An autonomous row must
carry a default; a gate row must carry a gate and no default; an ask row must seed at least one option; at
most one option is `recommended`; an option's `command` is never empty; an option whose label names the
report is refused. A consumer's own file may add rows and may make an ask row autonomous; it may never
reclassify a `human-gate` row -- that is the definition of the gate, not a knob -- and a loader merging two
files refuses the widening by pointer.

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | no | The target repository's working-tree root. | Defaults to cwd. |
| `--json` | no (boolean) | Machine-readable output. | `{ root, ok, checks: [...], deprecations: [...] }` — `checks[]` carries one row per file, `nen/workflow.json` last. |

**Output and exit codes** — human rendering: `"repository: <root>"` then one line per file:
`"  <ok|FAIL|warn>  <nen/…>  <detail>"` — always the canonical `nen/` spelling, whether or not the file
loaded — optionally followed by an indented `"        ^ <leftover note>"` line. `--json` matches
exactly: `{ root, ok, checks, deprecations }`, each check carrying `{ file, path, ok, detail, required,
legacy, note }` in that key order for every row — `file`/`path` are always the `nen/` spelling, `legacy`
is `true` when a `schemas/<file>` copy is present on disk (detected, never read; `false` for
`nen/contract.json` and `nen/workflow.json`, which have no legacy location), `note` is the leftover
sentence when `legacy` is `true` AND the row itself is `ok` (`null` otherwise — a failing row's own
`detail` already names the migration, so `note` does not repeat it), and `deprecations` lists every
`note` in row order (empty for a fully migrated repository, and for one carrying no legacy copy at all).
Exit 0 when every REQUIRED file loaded and validated — a `warn` row never trips this, leftover or
absent-and-optional alike; exit 1 when any required file failed to load, whether it is missing outright
or present only under the legacy `schemas/` location.

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
  ok    nen/workflow.json  absent (defaults apply)
```
(from a real run against the bundled fixture repo)

The same fixture after `nen scaffold init` has written a policy into it, and then with that policy's
coverage ladder edited so it no longer ascends:

```text
  ok    nen/workflow.json  coverage 80/85/90 (touched), branch '{model}/{persona}/{descriptor}' off 'main', checks: build
```
```text
  FAIL  nen/workflow.json  /tmp/site/nen/workflow.json: at coverage, states a ladder that does not ascend: minimum 95, recommended 85, ideal 90. The three rungs mean 'stop below this', 'aim for this', 'this is the target', so they must satisfy minimum <= recommended <= ideal -- nen will not guess which of the three was mistyped
```
exit 1 for the second. (both from real runs against a scratch copy of the bundled fixture; the absolute
path is elided to `/tmp/site`)

The same verb against the bundled **un-migrated** fixture, which carries the four files at the legacy
location and no contract:

```bash
nen schema check --repo src/schema/fixtures/legacy-repo
```
```text
repository: /path/to/src/schema/fixtures/legacy-repo
  FAIL  nen/labels.json  /path/to/src/schema/fixtures/legacy-repo/nen/labels.json: no such file. Nen reads this repository's taxonomy from 'nen/labels.json' in the TARGET repo and has no built-in copy to fall back on -- a binary that guessed the names would report a taxonomy this repository does not have. A legacy 'schemas/labels.json' is present -- run 'nen scaffold init --accept-detected' (or copy it) to migrate; the schemas/ fallback was removed in v0.5.0. Point it at a checkout that carries the file with --repo <path>, or add the file.
  FAIL  nen/repos.json  /path/to/src/schema/fixtures/legacy-repo/nen/repos.json: no such file. Nen reads this repository's taxonomy from 'nen/repos.json' in the TARGET repo and has no built-in copy to fall back on -- a binary that guessed the names would report a taxonomy this repository does not have. A legacy 'schemas/repos.json' is present -- run 'nen scaffold init --accept-detected' (or copy it) to migrate; the schemas/ fallback was removed in v0.5.0. Point it at a checkout that carries the file with --repo <path>, or add the file.
  FAIL  nen/colors.yml  /path/to/src/schema/fixtures/legacy-repo/nen/colors.yml: no such file. Nen reads this repository's taxonomy from 'nen/colors.yml' in the TARGET repo and has no built-in copy to fall back on -- a binary that guessed the names would report a taxonomy this repository does not have. A legacy 'schemas/colors.yml' is present -- run 'nen scaffold init --accept-detected' (or copy it) to migrate; the schemas/ fallback was removed in v0.5.0. Point it at a checkout that carries the file with --repo <path>, or add the file.
  warn  nen/gates.json  /path/to/src/schema/fixtures/legacy-repo/nen/gates.json: no such file. Nen reads this repository's taxonomy from 'nen/gates.json' in the TARGET repo and has no built-in copy to fall back on -- a binary that guessed the names would report a taxonomy this repository does not have. A legacy 'schemas/gates.json' is present -- run 'nen scaffold init --accept-detected' (or copy it) to migrate; the schemas/ fallback was removed in v0.5.0. Point it at a checkout that carries the file with --repo <path>, or add the file.
  ok    nen/contract.json  absent (optional)
  ok    nen/workflow.json  absent (defaults apply)
nen: this repository's taxonomy could not be read. Nen has no built-in copy to fall back on -- a binary that guessed the names would report a taxonomy this repository does not have.
```
exit 1 — an un-migrated repository is refused exactly like one with no taxonomy at all; `gates.json`
still only `warn`s, because its absence never failed the report even before v0.3.0 introduced `schemas/`.
(from a real run against the bundled fixture repo; the absolute path is elided to `/path/to/…`)

And the same fixture with `nen/labels.json` scaffolded in but the `schemas/` copy left behind — the
**leftover** case, against a scratch copy so the `git rm` advice is not run for real:

```bash
nen schema check --repo /tmp/site
```
```text
repository: /tmp/site
  warn  nen/labels.json  13 labels
        ^ a legacy 'schemas/labels.json' copy is still there, beside 'nen/labels.json'. Delete it (git rm -r schemas/labels.json, or rm -r schemas/labels.json if it was never committed) -- the schemas/ fallback was removed in v0.5.0.
  ok    nen/repos.json  3 consumers, 6 product codes, latest v0.11.2
  ok    nen/colors.yml  3 categories, 13 values
  ok    nen/gates.json  5 reviewer identities
  ok    nen/contract.json  dependency (nen >= 0.3, pinned v0.3.0), project (2 lanes: web, android; 10 verbs; 3 toolchain entries)
  ok    nen/workflow.json  absent (defaults apply)
```
exit 0 — the leftover never fails the report.
(from a real run against a scratch copy of the bundled fixture, with `schemas/labels.json` left in
place after `nen/labels.json` was copied in; the absolute path is elided to `/tmp/site`)

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


`--json`: the resolution — `{ category, precedence[], present[], unknown[], resolved, outranked[], reason }`. `resolved` is `null` and `reason` says why when the precedence cannot rank the set.
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

**Which sections carry `scenario`.** A `scenario` string on a row of **`consumers[]`,
`maintained_tools[]` or `pending_onboarding[]`** — whichever section is true of the repository,
never one chosen to hold the field. Through `v0.15.1` only a `consumers[]` entry carried it, so a
registry's own tool repositories, which consume nothing, could never have one, and the refusal told
the caller to re-file them as consumers ([#219](https://github.com/zheref/nen/issues/219)). A
`product_codes` value is a name, not a row, and carries none. The field is validated alike in all three
sections — optional, a string when present — so a non-string one is refused by pointer
(`at maintained_tools[0].scenario, expected a string or nothing`) **wherever the registry is loaded**:
by every verb that reads `nen/repos.json` (`repo resolve`, `fanout`, `pr ready`'s ref resolution,
`parse futon`, …), whatever target it was asked about, and by [`schema check`](#nen-schema-check),
where it fails the `nen/repos.json` row. Through `v0.15.1` such a value on a `maintained_tools[]` or
`pending_onboarding[]` row was ignored. An **empty** string states no scenario in any section — it is
read as absent, never printed as a blank success. A repository recorded in more than one section (a maintained
tool that is also a consumer) has **one** scenario: a value on any of its rows is read, the same value
on several is fine, and rows stating **different** values are refused, naming each row by pointer
(`its maintained_tools[1] row`). That disagreement is refused by this lookup only — `schema check`
does not detect it and still reports the file `ok`, because refusing it at load would stop every verb
for every target over one repository's rows.

```json
"maintained_tools": [
  { "repo": "zheref/nen", "role": "Shared deterministic machinery", "scenario": "<scenario>" }
]
```

**Usage**

```text
nen repo scenario --repo <path> --target <owner/name>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The checkout whose `nen/repos.json` records `--target`'s scenario. | Listed unbracketed; omitting it is refused BY NAME at exit 2, never silently defaulted. |
| `--target <owner/name>` | yes | The repository whose scenario is read back. | Missing or malformed -> exit 2, by name. |

**Output and exit codes** — human rendering is the bare scenario string on success, or `"nen: <reason>"`
on stderr otherwise. `--json` prints `{ ok, scenario }` or `{ ok, reason }`, unchanged by #219. Exit 0
when a scenario was found. Exit 1 with a DISTINCT reason for each of: `--target` is not recorded
anywhere in the registry; it is recorded on a row that carries no `scenario` (the remedy names the
section it is **already** in — *"Add one to its maintained_tools[] row"* — never a move to another
section); it is recorded only as a `product_codes` value (the remedy lays out what each section is for,
so the new row goes where it is true); or its rows state different scenarios. Exit 1 too when the
registry is present but malformed. Exit 2 when `--repo` is omitted, or carries no `nen/repos.json` at
all (the same precondition [`repo resolve`](#nen-repo-resolve) refuses the same way).

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

### `nen repo classify`

ONE verdict about what kind of repository this is (v0.11.0, zheref/nen#216), contract
`nen.repo.classify/v0.1`, so a reviewer or a gate reads a fact rather than carrying a list of repositories
in its own prose.

```
nen repo classify [--target <owner/name>] [--repo <path>] [--json]
```

| Fact | Source | Values |
|---|---|---|
| `role` | `nen/repos.json` under `--repo`: a repository under `maintained_tools` is **canon** (its product is the process -- a merge there changes how OTHER repositories behave, and `maintained_tools` wins over a `consumers` entry for the same slug); one under `consumers` or `pending_onboarding` is a **consumer**; one the registry does not know is **unregistered**, reported as such with a note and never rounded to consumer | `canon` · `consumer` · `unregistered` |
| `kind` | A declared `project.kind` (`product`, `process` or `library`) wins, with `sources.kind` naming what the lanes alone read -- it is the only way to be a **library** (reusable code shared across repositories, any stack). Otherwise `nen/contract.json`'s lane stacks: any application stack (`xcode-ios`, `gradle-android`, `nextjs`, `expo`, `gatsby`, `compose-desktop`, `dotnet-winui`, …) makes it a **product**; tooling stacks only make it a **process** repository; no `project` block is **unknown** | `product` · `process` · `library` · `unknown` |
| `stack`, `lanes` | the default lane's stack and every lane name | — |
| `defaultGate` | the maintainer's ruling of 2026-09-18: the gate is the repository's ROLE, not the file's kind | `G4` for canon, `G2` for a consumer, `null` (not derived) for an unregistered repository |

`--target` names the repository; omitted, the checkout's own `origin` is read (exit 1 when it cannot be).
**`kind`, `stack` and `lanes` are derived only when the target IS this checkout** -- proved by the origin
remote matching `--target` -- because the contract on disk describes the checkout it sits in and nobody
else: a `--target` naming another repository gets its role and gate from the registry and `kind: unknown`
with a note saying to run the verb from that repository's own checkout, never this checkout's lanes as if
they were its. Every fact names its source in `sources`; `notes[]` carries the unregistered warning, the
not-this-checkout note and the no-contract note.

**`--json`** — `{ contract: "nen.repo.classify/v0.1", target, role, kind, stack, lanes, defaultGate, sources: { role,
kind }, notes }`.

```
nen repo classify --repo src/schema/fixtures/bankai-repo --target zheref/bankai-scaffold
zheref/bankai-scaffold: role canon · kind product · stack nextjs · gate G4
```

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


`--json`: `{ ref, token, glyph, mark, unknownState }`.
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

<a id="the-release-time-floor-step"></a>

**One release-time step is nen's own and is not a verb: the compatibility
floor.** `src/version.ts` ships `COMPATIBLE_MINOR_FLOOR` — `MAJOR.MINOR`, the
lowest `dependency.minimum` pin the build satisfies
([`nen shu tools`](#the-compatibility-floor) is what reads it). The cut that
writes `## vX.Y.0` decides it, in the **same commit** as `VERSION` and
`package.json`:

- the new section's `### Breaking / consumer notes` carries **at least one
  bullet that is not the repin sentence** → set the floor to **`X.Y`**, this
  release's own minor;
- it carries none, or has no such section → **leave the floor where it is**.
  That is the whole benefit: consumers pinned at or above it read the new binary
  with no repin PR.

The pin bullet itself changes with the rule. It used to be owed
unconditionally — *"repin `0.6` → `0.7`"* on every minor. Now it is owed **only
when the floor moved**, and the section carries one bullet either way, under a
**dedicated bold lead-in the guard below matches on**:

- the floor moved → `- **Repin: \`"0.6"\` → \`"0.7"\`, and \`v0.6.0\` → \`v0.7.0\`.** …`
- the floor stayed → `- **No repin: the compatibility floor stays \`0.7\`.** A repository pinned \`0.7\` needs no change …`

The lead-in must *begin* `Repin:` or `No repin:` — the guard treats any other
bullet in that section as a real breaking note, which is the safe way for it to
be wrong.

`src/version.test.ts` is the guard, and it fails the build when the two
disagree: it reads CHANGELOG.md's **topmost released section** and asserts that
a release declaring breaking notes moved the floor to its own minor, and that
one declaring none did not move it above. This is a test rather than a
[`release preflight`](#nen-release-preflight) row on purpose — preflight is
repo-agnostic and runs against any repository's cut point, while the floor is a
literal compiled into *this* binary and can only be reconciled against *this*
repository's changelog.

### `nen release preflight`

Checks every row of getsuga §2's precondition table: the `RELEASE_HOLD`
variable (or `--hold-var`'s own name), open critical issues, CON-36 live
chores, an empty `changelog.d/` at the cut point, CON-33(c) reconciliation,
and whether the tag name already exists — all six, always, never just the
first failure.

The CON-33(c) row runs the **same reconciliation** as
[`nen changelog completeness`](#nen-changelog-completeness), including the
**release-PR allowance** described there: for one range the two verbs give one
verdict. When the allowance excuses the terminal PR, the row still passes and
names it (`…, but one, excused by the release-PR allowance -- #N reconciled by
the CON-33(c) release-PR allowance: …`). When it declines a terminal PR that is
still missing, the row appends why (`missing: #N -- #N not reconciled by the
release-PR allowance: …`). A `--range` with a revision beginning with `-` is
refused at exit 2 as there, and here before any tool runs, `gh` included.

**Usage**

```text
nen release preflight --repo-slug <owner/name> --tag <vX.Y.Z> --range <vPrev>..<cut-point> --changelog <path> --owner-repo <owner/name> [--hold-var <name>] [--critical-issues <n,n>] [--live-chores-from <path>] [--fragment-dir <dir>] [--repo <path>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo-slug <owner/name>` | yes | the GitHub repo whose hold variable is read | passed straight to `gh variable get --repo`; the tag is NOT checked here -- see `--tag` |
| `--tag <vX.Y.Z>` | yes | the tag being proposed | checked with `git ls-remote --tags origin`, run in `--repo`'s checkout, so against that checkout's `origin` remote |
| `--range <vPrev>..<cut-point>` | yes | same contract as `nen changelog completeness` | — |
| `--changelog <path>` | yes | the `CHANGELOG.md` at the cut point | — |
| `--owner-repo <owner/name>` | yes | scopes changelog link matching to this repo | — |
| `--hold-var <name>` | no | the gh variable to read | default `RELEASE_HOLD`; case-insensitive `true`/`1`/`yes` = held, `false`/`0`/`no`/unset = not held, any other non-empty value fails CLOSED as held |
| `--critical-issues <n,n>` | bracketed, but **required to pass the row** | open critical-severity issue numbers, gathered by the caller | omitting it reports "not supplied -- not checked" and fails the row; pass `''` to assert none |
| `--live-chores-from <path>` | bracketed, but **required to pass the row** | a JSON array of the CON-36 three-part test's inputs per chore | omitting it fails the row the same way; a file containing `[]` asserts none live |
| `--fragment-dir <dir>` | no | same default and empty/non-directory rules as `nen changelog completeness` | default `changelog.d` |
| `--repo <path>` | no | the checkout whose `origin` the tag is checked against and whose history is reconciled; resolves relative `--changelog`/`--live-chores-from`/`--fragment-dir` | default cwd; those files are checked once `--repo` resolves (an empty `--fragment-dir` is refused either way) |
| `--json` | no | machine-readable preflight table | — |

**Output and exit codes** — human lines: `ok`/`FAIL` plus the check name and
detail, one per row; `--json` top-level keys: `checks[]` (`name`, `ok`,
`detail`), `liveChores[]`, `releasePrAllowance` (the CON-33(c) row's
release-PR allowance decision, the same object
[`changelog completeness`](#nen-changelog-completeness) reports, or `null`
when every merged PR was already cited), `ok`. Exit 0 when every row passes,
exit 1 when any row fails, exit 2 on a usage problem. Every usage problem is
reported in **one** refusal, before any tool runs: with several required flags
missing (or an invalid `--range`/`--critical-issues`/`--fragment-dir`, an
unreadable `--changelog`/`--live-chores-from` -- files are checked once `--repo`
resolves -- or an unresolvable `--repo`), the
refusal reads `release preflight refused for N reasons -- nothing was run:`
followed by one `- <reason>` line each; a single problem keeps its own message
(zheref/nen#309).

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

### `nen release unit-check`

Whether a pull request's changed files stay inside a DECLARED release unit —
one of the three things the maintainer's 2026-09-26 ruling names as "judged
by reading rather than by a nen command": reads the PR's changed files (`gh
api --paginate repos/{slug}/pulls/{n}/files`, never `gh pr view --json
files` — that field is itself silently paginated by `gh` with no
`--paginate` ever offered for it) and compares them to `--repo`'s
`nen/workflow.json` key `release.unitPaths` (a repo-relative prefix or
narrow glob list, the same grammar `nen review scopes`/`report data
--tiers` read — see `src/report/patterns.ts`).

**A RENAME's previous path is checked too.** A file the unit now owns that
was renamed IN from outside it is still reported `outside` — its new name
sitting inside the unit does not retroactively make the rename itself an
in-unit change.

**The PR's own `changed_files` count is cross-checked against what the
files endpoint actually returned** (this catches a mismatch a naive read
would silently miss on a large pull request), **and 3000 or more changed
files is refused outright** — GitHub's own documented cap on this endpoint,
past which the true changed-file set cannot be read at all. Either case is
`UnitCheckTruncatedError`, exit 1, never a guessed verdict over a list this
check knows is incomplete.

Each `outside:` path is printed via `JSON.stringify`, so a path carrying a
quote, a control character, or a leading/trailing space is unambiguous in
the rendering rather than blending into the line around it.

**Content-scoped entries** (item 4, maintainer's ruling): a `release.unitPaths`
entry may also be an OBJECT, `{"path": "<exact file>", "keys": ["<json
pointer or dotted key>", ...]}`, bounding one exact JSON file to a set of its
own LEAF keys rather than its whole content — a version file the unit owns
may bump `version` without the unit claiming `description` too. `path` is
matched by EXACT EQUALITY (never a pattern), and is refused at schema load if
it carries a `#`, `?` or `%` (N2 — each of those would change what the
contents API URL means once the path is interpolated into it).

**The diff is STRUCTURAL, not string-based** (N1): both files are parsed into
a tree that keeps every container's own type (object / array / scalar) and
every key's own segment — never flattened into a dotted string — so a
literal key that happens to contain a dot (`"scripts.test"`) can never
collide with a truly nested path (`scripts` → `test`), and an array
rewritten into an object with equal-looking numeric keys (`[5]` → `{"0":
5}`) is caught as a container TYPE change rather than read as "no change".
A declared key (dotted `version`, or an RFC 6901 JSON pointer `/version`
with `~1`→`/` and `~0`→`~` decoding) allows a change AT or BENEATH its own
segment path only — a type change at an ANCESTOR of a declared key is still
a violation, reported at the ancestor. Two JSON numbers compare by their RAW
SOURCE TEXT once either is past `Number.MAX_SAFE_INTEGER` (N16) — `12345678901234567890`
editing to `...67891` is detected even though both round to the identical
IEEE-754 double under an ordinary parse; within safe-integer range, `1` and
`1.0` still compare equal (ordinary formatting variance).

When the declared file actually changed in the pull request, its content is
read at the MERGE BASE of the pull request's base/head (N6 — `gh api
repos/{slug}/compare/{base}...{head}`'s own `merge_base_commit.sha`, never
`baseRefOid` directly, because `baseRefOid` drifts forward as the target
branch moves and would otherwise show an unrelated later commit as "this
branch's own change") and at head, over `gh api
repos/{slug}/contents/<path>?ref=<sha>` — each path SEGMENT
percent-encoded (N2) — base64-decoded, then parsed with a bespoke
precision-preserving JSON parser (never `JSON.parse`, for N16's reason).
Any leaf that differs OUTSIDE the declared keys is reported as a
content-scoped violation, naming the offending segment path. A file this
check cannot read as JSON at all at either ref (missing, not valid JSON, a
fetch failure) is FAIL CLOSED — reported as a violation, never treated as
passing by default, and (N4) a keyed entry that DID change but has no way
to read base/head content at all (no `keyScoped` context) is ALSO reported
as a violation ("content not read"), never silently skipped. Both `nen
release unit-check` and [`nen pr merge --release-unit`](#nen-pr-merge) run
this same check; `unit-check` fetches the PR's `baseRefOid`/`headRefOid` and
resolves the merge base itself (only when a keyed entry is declared at
all), and `pr merge` reuses the one `gh pr view` fetch it already made,
resolving the merge base from the same base/head it read there.

```json
{"release": {"unitPaths": ["src/my-unit/**", {"path": "nen/contract.json", "keys": ["version"]}]}}
```

**Usage**

```text
nen release unit-check --pr <n|owner/name#n|CODE#n> --repo <path> [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--pr <n\|owner/name#n\|CODE#n>` | **yes** | the pull request to check | a bare `<n>` resolves against `--repo`'s own `origin` remote; `owner/name#n` names the repository explicitly; `CODE#n` ([zheref/nen#269](https://github.com/zheref/nen/issues/269)) resolves a product code through `--repo`'s `nen/repos.json` by the same lookup `pr ready <CODE>#<N>` uses — an unknown code, a code matching two registry keys that differ only by letter case (see [`pr merge`](#nen-pr-merge)'s *The ref*), or an unreadable registry is exit 2. Like `owner/name#n`, a code may name a repository other than `--repo`'s origin: this verb only reads (`pr merge`, which shares the grammar, refuses that). The `#` is required; the no-`#` shorthand `pr ready` also accepts is not |
| `--repo <path>` | **yes** | the checkout whose `nen/workflow.json` declares `release.unitPaths` | required, exit 2 if omitted (#28) |
| `--json` | no | machine-readable result | — |

**Output and exit codes** — Exit 0: every changed path is inside the unit,
and every content-scoped entry stayed inside its declared keys. Exit 1:
lists every path outside it (`outside: <path>` lines) and every
content-scoped violation (`outside (content-scoped): <path> changed at
<key>` lines). Exit 2: usage, OR `--repo` declares no `release.unitPaths` —
the refusal names the exact key to add
(`{"release": {"unitPaths": ["src/my-unit/**"]}}`), because "every path is
outside the unit" and "every path is inside it" are both a guess this verb
refuses to make about a boundary the repository never drew. `--json`:
`{ contract: "nen.release.unit-check/v0.1", target, pr, unitPaths,
keyedPaths, changedFiles, outsideUnit, keyScopedViolations, ok }` — N15:
`unitPaths` stays the STRING (whole-path pattern) entries only, exactly the
shape it had before content-scoped entries existed; the OBJECT
(content-scoped) entries are carried in their own `keyedPaths` field rather
than widening `unitPaths`'s own type.

**Example**

```bash
nen release unit-check --pr acme/widgets#9 --repo .
```
```text
acme/widgets#9: 2 changed file(s), unit 'src/unit/**'
1 path(s) outside the release unit
  outside: docs/readme.md
```
(from `src/release/unitcheck.test.ts`/`src/release/command.test.ts`'s scripted `gh pr view 9 --repo acme/widgets --json files` case)

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
fragment name **in the order it was written into the section** — newest-first
by the leading `<n>-` prefix, the same order the section itself reads, so the
manifest can be cross-checked against it line for line. `--json` top-level
keys: `version`, `theme`, `fragments[]` (that same order), `written`. Exit 0 on any completed run — there is no "drift" verdict here,
only "wrote/didn't write". Exit **2** on a missing required flag, and on an
unreadable `--changelog` or fragment: the read goes through the shared reader,
so a mistyped path is the named refusal every other path flag gives —
`could not read '<resolved path>' (ENOENT). --changelog names the file this
verb REWRITES, so an unreadable one is refused rather than collated into
nothing.` It used to escape as a raw errno at exit 1
([#101](https://github.com/zheref/nen/issues/101)).

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

**The release-PR allowance (zheref/nen#229).** The terminal PR whose merge
introduced the dated section does not have to cite itself. That is what a
release proposal does: it writes the dated section before its own number
exists, so without this, its own merge could never pass. The terminal PR `#N`
is reconciled without a citation only when all five of these hold, each read
from git:

1. `--range` is `<vPrev>..<vNew>`, and it ends at a two-parent
   `Merge pull request #N` commit. This is the range's **terminal merge**.
2. `#N` is uncited.
3. `--changelog` opens with a **dated** section (`## vX.Y.Z` or `### vX.Y.Z`),
   and the CHANGELOG at the terminal merge opens with the same dated section.
4. That dated section is **absent at the merge's first parent**: the trunk did
   not have it before this merge.
5. No **other** merge on the PR's own branch introduced it, whether a PR merge
   or a local `git merge`. "Introduced" means absent at that merge's first
   parent and present at the merge.

A heading whose trailing text is `unreleased` (any case, e.g.
`## v0.14.0 — unreleased`) is **not dated**:

- a `--changelog` that opens with one cuts no dated section, and declines
  (`no-dated-section`);
- one on the first parent does not count as present at condition 4, so the PR
  that **dates** it is the PR that introduced the dated section.

That is "introduced", and it is decided from commits and CHANGELOG blobs. No
GitHub metadata is read. The boundary:

- The allowance covers **at most one PR**, and only the range's terminal
  merge.
- Every **other** uncited merged PR still fails exactly as before.
- A PR that **carried** the dated section to the trunk still fails
  (condition 5) and must be cited. An example is a release bump merged into a
  feature branch (by a PR or locally) that a later PR then merged to `main`.
- A PR ending the range after the dated section was already on the trunk also
  still fails (condition 4), for example a reconcile PR.
- A git read that fails **declines** the allowance. It never grants it.
- **What it cannot tell apart:** the history proves that the terminal PR's
  merge introduced the dated section, not that the PR is a release proposal. A
  delivery PR that opens the dated section itself, and ends the range, is
  excused the same way.
- A `git pull` merge on the branch whose first parent lacked the section and
  whose second parent carried it reads as another merge introducing it, and
  declines.

This does not change CON-33 itself, `changelog fragment-required` (a), or
`changelog collate` (b).

**Usage**

```text
nen changelog completeness --range <vPrev>..<vNew> --changelog <path> --owner-repo <owner/name> [--fragment-dir <dir>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--range <vPrev>..<vNew>` | yes | as `git log --merges` understands it | a revision beginning with `-` is refused at exit 2 before git runs (git would read it as an option); every revision reaches git behind `--end-of-options` |
| `--changelog <path>` | yes | the `CHANGELOG.md` to reconcile against | — |
| `--owner-repo <owner/name>` | yes | scopes changelog link matching to THIS repository | — |
| `--fragment-dir <dir>` | no | same default/empty/non-directory rules as `release preflight` | default `changelog.d`; a missing directory means zero fragments, not a refusal |
| `--repo <path>` | no | resolves relative `--changelog`/`--fragment-dir` and runs `git log` | default cwd; `--changelog` must sit inside it for the release-PR allowance to read its history |
| `--json` | no | machine-readable result | — |

**Output and exit codes**

Human lines are one of:

- a pass line;
- `missing CHANGELOG entry or fragment for:` plus each `#<n>`.

The allowance is **named, never silently folded in**:

- When it excuses the terminal PR, the pass line reads `…, but one, excused by
  the release-PR allowance:` and is followed by
  `  #N reconciled by the CON-33(c) release-PR allowance: <why>`. The line names
  the rule, not an identity: see "what it cannot tell apart" above.
- When it declines a terminal PR that is still missing, the list is followed by
  `#N not reconciled by the release-PR allowance: <why>`.

`--json` top-level keys, in this order: `missing[]` (after the allowance),
`ok`, `releasePrAllowance`. `releasePrAllowance` is `null` when every merged
PR was already cited. Otherwise it is `{ applied, verdict, pr, mergeSha,
firstParentSha, section, carriedBy, detail }`, and `verdict` is one of:

- `applied`
- `range-not-two-dot`
- `terminal-unreadable`
- `terminal-not-pr-merge`
- `terminal-pr-cited`
- `no-dated-section`
- `changelog-outside-repo`
- `section-not-at-terminal`
- `section-on-first-parent`
- `section-carried` (with `carriedBy`, the PR whose merge introduced the
  section, or `null` for a local merge, whose sha is in `detail`)
- `history-unreadable`

Exit codes:

- `0` when every merged PR is covered, the allowance included;
- `1` when any PR is missing;
- `2` on a missing required flag, or a `--range` with a revision beginning
  with `-`.

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


`--json`: `{ ok, pushed, log[], error }` — `error` is `null` on success, and `pushed` says whether the tag reached the remote as distinct from whether it was created.
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

### `nen issue edit-body`

Replaces an issue's body OUTRIGHT with a file's bytes — no trimming, no
template, the file becomes the body exactly, through `gh issue edit
--body-file`. UNLIKE [`issue comment`](#nen-issue-comment), a number that
names a pull request is refused (exit 2), never accepted: a comment adds to
a timeline either way, but replacing the whole body is not additive and is
invisible the moment the command exits — the same hazard
[`attach-sub`](#nen-issue-attach-sub)/[`consolidate-close`](#nen-issue-consolidate-close)
refuse a pull request for. The number is certified over the same
`issues/{n}` read `readIssue` already performs for this family, before any
write.

**Usage**

```text
nen issue edit-body --target <owner/name> --issue <n> --body-file <path> [--dry-run]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | yes | The GitHub repository. | Missing exits 1. |
| `--issue <n>` | yes | The issue to replace the body of. | Read with the same strict `/^\d+$/` guard `comment`'s `--issue` uses — `1e3` or `0x0c` are refused rather than silently accepted as 1000/12, because this is a MUTATING read. |
| `--body-file <path>` | yes | The new body, read RAW (no CRLF normalization) so `gh` reads the same bytes this verb previewed. | There is no inline `--body` — that flag belongs to [`issue comment`](#nen-issue-comment). An unreadable path, or one holding only whitespace, is refused (exit 2). |
| `--dry-run` | no | Certify the number, then print the target, the number, the byte count and the first/last line instead of writing. | **Still reads GitHub** to certify — the same "not network-free" shape [`attach-sub`](#nen-issue-attach-sub) has. |

**Output and exit codes** — human line on a real write: `replaced
<target>#<issue>'s body (<n> byte(s))`; `--dry-run` prints `would run: gh
issue edit ...` followed by `target:`/`number:`/`bytes:`/`first line:`/`last
line:`. `--json`: `{ contract: "nen.issue.edit-body/v0.1", target, number,
bytes, written, dryRun }` — exactly those six fields, dry run or not. Exit 0
on success (dry or real); exit 2 on a malformed/absent `--issue`, an
empty/unreadable `--body-file`, or a number that certifies as a pull
request; exit 1 if `gh issue edit` itself fails after certification passed.

**Example**

```bash
nen issue edit-body --target zheref/nen --issue 93 \
  --body-file body.md --dry-run
```
```text
would run: gh issue edit 93 --repo zheref/nen --body-file body.md
target: zheref/nen
number: 93
bytes: 259
first line: ## Finding
last line: permanently.
```
(a real run against `zheref/nen#93` — read-only: the certifying `gh api
repos/zheref/nen/issues/93` call reached GitHub, `gh issue edit` did not)

Handed a pull request's number instead, the certification refuses before
anything is written — this is `zheref/nen#141`, a genuine (closed) pull
request, run live against `issue edit-body`:

```text
nen issue: #141 names a pull request in zheref/nen, not an issue -- 'nen
issue edit-body' replaces an ISSUE's body only, and it is certified before
any write, so nothing was changed. Ask 'nen pr edit-body' for the pull
request's body instead.
Run 'nen issue --help'.
```
exit 2

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

**When the sub-issues endpoint is absent (404/410).** The documented fallback is a task list in the parent's body. This verb DETECTS that case and hands the lines back -- printed in the human rendering, and `fallbackTaskList` under `--json` -- but it does **not** perform the write. It posts to `issues/{parent}/sub_issues` and nothing else; replacing a body is a different write, a read-modify-write that could clobber an edit made between this run's read and its own, on the one path in the verb reachable only where the endpoint is missing and therefore the least exercised. Apply it yourself:

```text
fallback task list for the parent's body:
  - [ ] #41
  - [ ] #52

nen does NOT write this. To apply it, put the CURRENT body of #12 plus these lines in a file and run:
  nen issue edit-body --target zheref/bankai-core --issue 12 --body-file <file>
```

[`issue edit-body`](#nen-issue-edit-body) requires `--target` the same way this verb does, so the line above is copy/pastable as written; and it **replaces** a body, so the file is the parent's current body *plus* those lines -- handing it only the lines loses the body. And say which form was used: a task list is not a sub-issue graph, and a later sweep that reads one as the other is wrong about the whole chain.

**Output and exit codes** -- human rendering is the run's own `log` lines: `would run: gh api --method POST repos/<slug>/issues/<parent>/sub_issues -F sub_issue_id=<id>   (#<child> -> id <id>)` under `--dry-run`, or `attached #<child> (id <id>) to #<parent>` for a real write; a 404/410 from the sub-issues endpoint is reported with the task-list fallback block above. `--json`: the `AttachReport` -- `{ attached, failed, fallbackTaskList, log }`, or `{ parent, children, pullRequests, refused: true, reason }` on the object-class refusal. Exit 0 when every child attached; exit 1 when one or more children failed to attach, OR when the object-class certification refused (nothing is attached in that case).

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

Where an OPEN issue sits on the five-place delivery-chain table (a raw brief, an epic awaiting its mode label, an approved epic, a routable child/standalone task, something already building), decided from labels and state alone -- never from the title, because a title is prose and prose is what an LLM caller reads, not this verb. `--chain-labels` supplies which literal label spells each of the eight roles (`idea, researched, approved-team, approved-direct, building, in-review, epic, chore`); a role the caller never mapped is reported "unmapped", never guessed past. **Four of the eight can refuse a verdict and four cannot**: `building`, `in-review`, `idea` and `epic` decide whether an issue that matched nothing is really `routable`, so an unmapped one is `undecidable` rather than a guess — "carries no building label" and "building was never mapped, so this issue's building label (if any) was never checked" read identically, and only one of them is `routable`. `researched`, `approved-team`, `approved-direct` and `chore` are reported under `unmappedRoles` when absent and never block an answer, so a target repository whose taxonomy genuinely lacks one needs **no placeholder for it**. A position a mapped role positively matches is decided before any of this is consulted, so partial credit already applies wherever the labels answer the question (zheref/nen#55). Refuses (exit 1) when the answer is `undecidable` -- that is itself a refusal, not a result -- and separately refuses when `--issue` names a pull request, since a delivery-chain position is defined only for issues.

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

**Output and exit codes** -- prints `#<n>: <position>` then each evidence line indented. `--json`: `{ issue, position, evidence, unmappedRoles }`, or `{ issue, refused: true, reason }` on the pull-request refusal. **`issue` is the number the caller typed**, on both paths -- a decided verdict and a refusal. (This verb's evidence lines name labels rather than numbers; the ones that do carry a number are [`terminus`](#nen-issue-terminus)'s, and they carry the same one.) GitHub redirects a transferred object, so `--issue 925` can be answered by a payload numbered 926; the two renderings of one run used to disagree about which number it was, text printing the typed one and `--json` the payload's ([#85](https://github.com/zheref/nen/issues/85)). A verdict labelled with a number the caller never typed is a verdict they cannot look up. Exit 0 for any decided position (`closed`, `building`, `idea`, `epic-awaiting-approval`, `epic-approved`, `routable`); exit 1 for `undecidable` or the pull-request refusal; exit 2 on a malformed `--chain-labels` entry.

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
| `--forbid-family ns:family` | no | Label families this invocation declares off-limits. | Works exactly as [`issue file`](#nen-issue-file)'s does — forwarded into the same `FileRequest` — and is documented in `nen idea --help` since [#94](https://github.com/zheref/nen/issues/94). Caller data: nen carries no repository's own convention about which family means what. |

**Output and exit codes** -- prints `filed #<n> <url>`, then either `read-back OK -- title, body and labels match what was submitted.` or, per mismatch, `<field>: expected '<expected>', got '<actual>'`. `--json`: the full `FileIdeaResult` -- `{ filed: { url, number }, readBack: { title, body, labels }, mismatches }`. Content refusals (empty title, no labels, unknown/forbidden label) print as plain `nen:` lines regardless of `--json`, same as `issue file`. Exit 0 when filed and the read-back matches exactly; exit 1 on any mismatch, on a read-back that could not be confirmed at all, or on a read-back that answers as a pull request; exit 2 when `--repo`/`--body-file` was omitted, and when `--target` is missing **or malformed** — this family kept a fifth copy of that check which answered a bad slug with exit 1, and it now refuses the way the other four do ([#93](https://github.com/zheref/nen/issues/93)).

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

**The CI workflow's `toolchain` step reads `shu tools`'s exit code.** It runs the check and fails the job on any non-zero code **except 7** — [behind `pinned_ref`](#behind-the-pinned-ref), meaning the workflow's own `NEN_REF` is older than the `dependency.pinned_ref` in `nen/contract.json`. That is drift in the CI file rather than a broken runner, so the step prints a `::warning::` naming it (repin `NEN_REF`) and the job goes on. Exit 5 — a pinned tool missing or out of range — still fails it.

### `nen scaffold init`

Eleven steps, each reporting `created` / `appended` / `skipped` / `would-create` / `would-append` / `refused` with the reason. In order: resolve the stack **and the policy** (**before any write**, so a refusal leaves the tree untouched); create every `--directories` entry that does not exist; install the trailer-enforcing commit-msg hook; install the trunk-guarding pre-commit hook; write the canon-values template when `--canon-values-path` is given and nothing is there; **copy** any of the four taxonomy files still under `schemas/` into `nen/` and print the `git rm` line; write `nen/contract.json`'s `project` block into absence; write [`nen/workflow.json`](#nenworkflowjson)'s policy into absence; add the stack's CI workflow; append `.nen/` and the policy's `reports.dir` to `.gitignore`; and run [`nen shu tools`](#nen-shu-tools) in **check** mode, printing what this host is missing and the `--install` command rather than running it.

**Both git hooks are made out of `nen/workflow.json`, which is why the policy is resolved first.** The commit-msg hook bakes in, *as data*, every attribution trailer the policy does not admit — so it needs no `nen` on `PATH` at the moment of commit — and the pre-commit hook bakes in `branch.base` and refuses a commit made on that branch. A policy file that is **already there wins and is never overwritten**: this run is generated *from* it, and overwriting it would install guards enforcing the rules that had just been deleted. A policy that is there and **malformed** refuses the whole run at exit **2**, before the first write, naming the pointer — nen will not scaffold around a file it could not read. The policy this run writes admits exactly the one trailer key `--agent-trailer` resolved to, and records `--run-trailer` (when given) under the **separate** `commits.runTrailer` key rather than the allow-list — a run identifier is never itself an attribution claim — so a repository that also uses one of the other [attribution trailers](#nenworkflowjson) adds it to `commits.allowedAttributionTrailers` and re-runs.

**The commit-msg hook's automated half is itself DERIVED from the resolved policy (zheref/nen#167), not a fixed pair baked in regardless of it.** It requires exactly the one attribution trailer `--agent-trailer` resolved to, plus `commits.runTrailer` too when that key is stated — never a hard-coded pair. When an **existing** `nen/workflow.json`'s `commits.allowedAttributionTrailers` does **not** admit the key `--agent-trailer` resolved to, the generated hook's automated half refuses **every** automated commit outright, naming the missing policy: there is no message such a repository could ever write that would satisfy a check for a trailer it does not admit, so the hook does not pretend to check for one. Regenerating a hook from an **unchanged** policy is byte-stable.

`--agent-trailer`/`--run-trailer`/`--marker-env` are caller data (which trailer key(s) and environment variable mark an automated commit is a convention of the target repository, not a literal this binary ships) and are validated as legal git-trailer-key / shell-identifier shapes, since each is interpolated into the generated hook script. **Only `--marker-env` is required.** `--agent-trailer` is optional and defaults to this project family's own CI-plane provenance trailer ([Two provenance trailers](#two-provenance-trailers)) when omitted; `--run-trailer` is optional with no default, and when given is the key `commits.runTrailer` takes.

**Usage**

```text
nen scaffold init --repo <path> --marker-env <VAR>
                  [--agent-trailer <key>] [--run-trailer <key>]
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
| `--agent-trailer <key>` | no | The git trailer key marking the acting agent — the one the automated half REQUIRES. | Must match `[A-Za-z0-9][A-Za-z0-9-]*`; refused otherwise. Omitted, defaults to this project family's own CI-plane provenance trailer — see [Two provenance trailers](#two-provenance-trailers) — never a nen-wide assumption baked into the renderer itself (zheref/nen#167). |
| `--run-trailer <key>` | no | The git trailer key marking the run — an OPTIONAL second requirement. | Same shape rule. Omitted (the default), the automated half requires only `--agent-trailer`'s key; given, it is written to `commits.runTrailer` and the automated half requires it too. |
| `--marker-env <VAR>` | **yes** | The environment variable the hook reads to recognise an automated commit. | Must match `[A-Za-z_][A-Za-z0-9_]*`. The one flag of the three still unconditionally required: omitted, `init` refuses at exit 2 naming it and what the other two default to / are for (zheref/nen#138). |
| `--hook-path <path>` | no | Where the commit-msg hook is installed, and the DIRECTORY the `pre-commit` hook goes in beside it. | Defaults to `.git/hooks/commit-msg`; `--hook-path .husky/commit-msg` puts the trunk guard at `.husky/pre-commit`. There is deliberately no second flag — two flags would be two ways to write the two guards to two unrelated places, which is a repository with one installed and the other somewhere nobody looks. **Contained**: a value resolving outside `--repo` (`../outside/evil-hook`, or an absolute path elsewhere) is exit 2 naming the flag and where it landed, decided before the first write — the same rule [`shu`](#family-shu) applies to a path a declaration states. The hook is written `0755`, because `git` silently skips a `commit-msg` hook that is not executable. |
| `--force` | no | Overwrite a DIFFERENT existing hook at `--hook-path`, or at the `pre-commit` path beside it. | Without it, a foreign hook at either path is refused (exit 1), not silently replaced; the existing file is backed up to `<path>.bak` first when `--force` is given. A hook with identical generated content is left alone either way. **It covers the two hooks only** — there is deliberately no override for a conflicting CI file, declaration, policy or migration. |
| `--canon-values-path <path>` | no | Where to write the canon-values template. | Only written if nothing is already there. Contained the same way `--hook-path` is. |
| `--scenario <name>` | no | Recorded in the canon-values template. | |
| `--nen-ref vX.Y.Z` | no | The nen release the generated workflow pins. | Left off, nen writes the **greater** of this binary's own version and the minimum `templates/index.json` declares — the first release carrying the `nen shu` verbs the workflow runs. A ref below that minimum is exit 2 naming both; so is anything that is not a `vX.Y.Z` tag. When the written ref is not this binary's own version, the report says so, and says nen cannot verify offline that a release exists for it. |
| `--install-tools` | no | Run the closing check as `shu tools --install` instead of a check. | The one flag here whose blast radius is the **developer's machine**. Without it nothing is installed, ever; the report names the command instead. `--install-tools --dry-run` is exit 2. |
| `--dry-run` | no | Print every write, every migration and every refusal; perform none. | It spawns **nothing**, probes included: the toolchain step prints `would check`. That is what makes this form `read-only` in izanami's table rather than a claim about somebody else's declaration. |

**Every write stays inside `--repo`, and the report says where each one landed.** Two flags (`--hook-path`, `--canon-values-path`) are resolved against the repository root and refused at exit 2 when they leave it. The two writes that *create* a directory — `nen/contract.json` and `.github/workflows/nen-shu.yml` — are additionally checked against the **real** path: a symlinked `nen/` or `.github/` would send the write outside the tree while the report kept printing the repo-relative name, so it is `refused` (exit 1) naming the link and where it points. `.git/` is deliberately *not* held to that rule: it is legitimately a symlink or a gitdir file in a worktree.

**A filesystem failure is a row, not a crash.** An unwritable path, a directory in the way, a read-only checkout: the errno becomes a `refused` write, the run continues, and the report is still printed — under `--json` too. A run that threw here used to exit 1 with empty stdout, having already written several files it never reported.

**The `schemas/` → `nen/` migration is a COPY.** Each of the four taxonomy files found only under `schemas/` is copied to `nen/`, the original is **left in place**, and the `git rm` line is printed for the caller to run (and only for a copy that actually happened). A legacy file that is a **symlink** is `refused` naming both paths: `copyFileSync` follows it, so nen would be copying whatever it points at into the repository under a taxonomy file's name and then telling the caller to stage it. A delete is not recoverable if some tool in the estate still reads the old path, and this verb's hook rule already established refuse-and-report over destroy; the `nen/` copy is [the only one anything ever reads](#taxonomy-as-data), so the new behaviour arrives before the removal does, and [`schema check`](#nen-schema-check) reports the leftover as a `warn` until it happens. A file present in **both** with identical bytes is `skipped` (only the removal is left); one present in both with **different** bytes is `refused`, naming both paths, with no `--force` — two disagreeing taxonomies is not a merge nen can make (`schema check`'s own `warn` does not make this distinction, because it no longer opens the `schemas/` copy at all — this verb still does, because it is the one that has to decide whether copying over the canonical file is safe).

**`.gitignore` is APPENDED to, byte for byte.** The file's own bytes are written back unchanged and the appended lines match its own line ending, so a CRLF `.gitignore` is not silently rewritten wholesale. The action is `appended` (or `would-append` under `--dry-run`) rather than `created`, because the file was already there and the caller's own lines are still in it. **Two entries**, decided separately: `.nen/`, which is nen's own generated output, and the policy's `reports.dir` — read out of `nen/workflow.json` rather than assumed, so a repository that renamed it does not get the wrong line ignored in silence. A file that already carries one of the two gets the one it is missing, not a `skipped` row about the one it has.

**Idempotence.** A second run changes nothing and says so per item: both hooks, the declaration, the policy, the CI workflow and the `.gitignore` entries all report `skipped` when what is on disk is already exactly what this run would write. That is the one place this verb is more permissive than `shu detect --write`, which refuses on *presence*; anything whose content differs is still refused here.

**Idempotence holds within a release, not across one.** The declaration this
verb writes is [`shu detect`](#nen-shu-detect)'s proposal, and that proposal
grows: this release adds `"targets": {}` to every project block it proposes.
So a tree scaffolded by **v0.2.0** and re-run under this release reports the
declaration `refused` — *already exists with different content* — rather than
`skipped`, which is correct and is not a regression: the file differs, and this
verb never overwrites a declaration and has no `--force`. The block it would
have written is printed above the refusal; add the one line by hand (or leave
it out — an absent `targets` and an empty one behave identically, and
[`shu deploy`](#nen-shu-deploy) refuses at 2 with the block to paste either
way). Every other step still reports `skipped`.

**Output and exit codes** — the opening lines are v0.2.0's, with the trunk guard's own line between the second and the third: `created directories: <list>` (or `(none -- all already existed)`), `hook: <outcome> (<path>)`, `pre-commit: <outcome> (<path>)`, and `canon-values: <path>` if one was written. Both hook outcomes are one of `installed` / `unchanged` / `refused` / `would-install`, decided the same way. Under `--dry-run` the first reads `would create directories:` and the second `hook: would-install`, because a preview that said `created` about directories that are not there would be the one line in the report that lies; `--dry-run` is new here, so no v0.2.0 caller reads that spelling. Then `stack: <id>`, one line per migration, one line per write, detect's notes, and the toolchain table. `--json` is a versioned contract, keys in order: `{ contract: "nen.scaffold.init/v0.1", writes: [{ path, action, why }], migrated: [{ from, to, action, why }], tools, exitCode }`, where `action` is `created`/`appended`/`skipped`/`would-create`/`would-append`/`refused`, `path` is repo-relative, and `tools` is [`shu tools`](#nen-shu-tools)'s own `nen.shu.tools/v0.1` document or `null`. **A `refused` row is always published**, in `writes[]` alongside the rest — a report that listed only what succeeded would be a report that says "done".

Under `--json`, stdout is exactly one document and the prose the shape has no field for — `detect`'s open questions, the toolchain table and its advice — is relayed to **stderr** rather than dropped, the way the [`shu`](#family-shu) verbs relay a child's output.

Exit **2** for a usage refusal decided before any write (no stack, both stack flags, an unknown stack, a malformed trailer or marker, a missing `--marker-env` (naming it and what `--agent-trailer`/`--run-trailer` default to or are for), a missing `--repo`, a `--hook-path`/`--canon-values-path` outside the repository, a `--nen-ref` that is not a tag or is below the minimum, `--dry-run --install-tools`); exit **1** when a write was `refused` (a foreign hook, an existing declaration, a differing CI file, a conflicting migration, a symlinked legacy source, a symlinked target directory, an errno from the filesystem) — matching v0.2.0's hook behaviour; exit **0** otherwise. **`--dry-run` is a read-only form that can still return 1**: a preview over a tree that already carries a conflicting hook, declaration or workflow reports those refusals and exits 1, because "this run would refuse" is the answer the preview exists to give. It is still read-only — nothing is written and nothing is spawned. **The closing check never moves the exit code**: scaffolding succeeded, and whether this host can build the thing is a separate question with its own verb and its own code. A `scaffold init` that failed because an IDE is absent would be permanently red on every machine that is not already set up, CI runners that legitimately never build that stack included — run [`nen shu tools`](#nen-shu-tools) and read *its* exit code for the host verdict.

**Example**

```bash
nen scaffold init --repo /tmp/site --accept-detected --directories src,docs \
  --agent-trailer Agent-Name --run-trailer Run-Id --marker-env NEN_AUTOMATED
```
```text
created directories: /tmp/site/src, /tmp/site/docs, /tmp/site/.git/hooks
hook: installed (/tmp/site/.git/hooks/commit-msg)
pre-commit: installed (/tmp/site/.git/hooks/pre-commit)
stack: gatsby
created: .git/hooks/commit-msg -- installed
created: .git/hooks/pre-commit -- installed
created: nen/contract.json -- the project block, written into absence
created: nen/workflow.json -- the delivery policy, written into absence -- every key in it carries nen's own default, so editing one line changes one thing
created: .github/workflows/nen-shu.yml -- the 'full' template's workflow for gatsby
created: .gitignore -- created, ignoring '.nen/' and 'Reports/'
a lane's NAME is proposed from the directory it lives in (or from the stack id at the repository root) and is yours to change -- it is the token '--lane' takes, and nothing in nen reads meaning into it.
lane:          gatsby  (gatsby)
mode:          check
tools:         (none declared)
```
(run for real against a scratch copy of this repository's own `gatsby-site` marker fixture; the absolute paths are elided to `/tmp/site`)

### `nen scaffold new`

A **fresh** tree: the stack template's files with `{{name}}` substituted, the CI workflow, `.gitignore` (ignoring `.nen/` and `Reports/`), the commit-msg hook when a trailer convention is stated, the trunk-guarding `pre-commit` hook **always**, [`nen/workflow.json`](#nenworkflowjson)'s policy, and `nen/contract.json` — **proposed by `shu detect` off the marker this verb just wrote**, so "scaffolded a project" and "declared a stack" stop being two chores with two chances to disagree.

**The trunk guard is unconditional; the commit-msg hook is not**, and the difference is what each one needs. The commit-msg hook enforces a trailer convention that is turned on by `--marker-env` — the flag that decides whether a hook is wanted at all — so it is written only when `--marker-env` states one, `--agent-trailer` defaulting to this project family's own CI-plane provenance trailer ([Two provenance trailers](#two-provenance-trailers)) and `--run-trailer` staying optional; the `pre-commit` hook refuses a commit on `branch.base`, and every repository has a trunk. A fresh tree is also the one place that guard is free — nothing has been committed to it yet. Both are generated from the policy this verb writes, and `iteration.lane` in that policy is the lane the declaration ends up declaring, so the two files cannot name different lanes.

**Every post-step is PRINTED and none is run.** No repository is initialised, no dependency is installed, no native project is generated, and no network call is made — including the toolchain check, which `init` runs and this verb only names. Writing into a fresh directory and writing to the host are two different consents.

**Usage**

```text
nen scaffold new --stack <id> --name <project> --dir <path>
                 [--marker-env <VAR> [--agent-trailer <key>] [--run-trailer <key>]]
                 [--nen-ref vX.Y.Z] [--dry-run] [--json]
```

**It takes no `init` flag, and says so.** The two verbs share one flag spec, so the argv reader accepts `--hook-path`, `--force`, `--install-tools`, `--accept-detected`, `--canon-values-path`, `--scenario` and `--directories` on a `new` invocation — each is now **refused at exit 2 naming it**, rather than accepted and ignored. `--repo` is refused here too: this verb writes into `--dir`, and a caller who passed both has named two directories.

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--stack <id>` | yes | The stack to write. Never inferred — there is no tree to infer from. | Exit 2 for an unknown id, for a stack the catalogue proposes no template for (`compose-desktop`, `dotnet-winui`), and for one with no fresh-tree form (`gradle-android`, `xcode-ios`) — each naming the `scaffold init` invocation to run after creating the project with its own generator. |
| `--name <project>` | yes | Written into this tree's own manifest. | Must match `[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]`: it is spliced into JSON bodies, and a name that has to be escaped first was never one. |
| `--dir <path>` | yes | The directory to write into. | Must not exist, or must be empty. **No merge and no `--force`** — a directory with something in it is one somebody is using, and the failure a merge produces is a half-scaffolded tree whose declaration describes files that were skipped. Exit 2. A **one-slash relative** value (`parity/nextjs`) reads as an `owner/name` slug and is exit 2 naming the `./parity/nextjs` spelling — the same ambiguity [`--repo`](#--repo-path-is-a-path) refuses rather than guesses. Every other relative value is `./`-prefixed in the printed post-steps, seven of which pass it to `--repo`. |
| `--marker-env <VAR>` | no | The environment variable the hook reads to recognise an automated commit. **Decides whether the hook is wanted at all.** | Must match `[A-Za-z_][A-Za-z0-9_]*`. Omitted (with neither of the other two stated), the hook is `skipped` and the post-steps name the `scaffold init` line that installs it — nen ships no marker variable and invents none. Given, the hook is written `0755`, as `init` writes it. Naming `--agent-trailer`/`--run-trailer` without it is exit 2: half a convention is a caller mistake, not something silently dropped. |
| `--agent-trailer <key>` | no | The git trailer key marking the acting agent. | Must match `[A-Za-z0-9][A-Za-z0-9-]*`. Omitted, defaults to this project family's own CI-plane provenance trailer ([Two provenance trailers](#two-provenance-trailers)) — the same default `init` applies. |
| `--run-trailer <key>` | no | The git trailer key marking the run — an OPTIONAL second requirement. | Same shape rule. Written to `commits.runTrailer` when given; the automated half then requires it too, alongside `--agent-trailer`'s key. |
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
skipped: .git/hooks/commit-msg -- no --marker-env was stated, so there is nothing to mark a commit as automated: nen ships no marker variable and invents none. The post-steps name the invocation that installs it (--agent-trailer defaults to 'Akatsuki-Agent' when omitted; --run-trailer is optional).
would-create: .git/hooks/pre-commit -- the trunk guard for 'main'
would-create: nen/contract.json -- proposed by 'nen shu detect' off the marker written above -- the same block 'nen shu detect --write' writes, seats and all
would-create: nen/workflow.json -- the delivery policy the generated hooks were made from -- every key carries nen's own default
a dry run writes nothing, so the declaration is described rather than shown: it is exactly what 'nen shu detect --repo ./kro-site' prints once the tree exists.
post-steps (nen does NOT run these):
  1. cd ./kro-site && git init && git add -A && git commit -m "chore: scaffold"
  2. name the package manager in package.json's "packageManager" field. nen never picks one, so until it is there every declared row that needs it stays a withheld seat
  3. add the framework and its dependencies to package.json, then install them
  4. nen scaffold init --repo ./kro-site --stack nextjs --marker-env <VAR> [--agent-trailer <key>] [--run-trailer <key>]
  5. nen shu detect --repo ./kro-site            # re-propose the rows it withheld, once the manifest answers
  6. nen shu tools --repo ./kro-site            # checks the host; --install acts
  7. nen shu build --repo ./kro-site --dry-run  # confirm the declaration
```
(run for real, `dist/nen-darwin-arm64 scaffold new --stack nextjs --name kro-site --dir ./kro-site --dry-run`)

**What the generated workflow does.** `.github/workflows/nen-shu.yml` declares `permissions: contents: read`, fetches nen's bootstrap at a pinned ref, runs `nen shu tools --repo .`, then `build`, `test` and `lint` — **`--dry-run` first, then for real** — treating exit 4 (this lane declares no such verb) as a fact rather than a failure.

**Which ref it pins, and why it needs a published release.** The ref is `--nen-ref` when given; otherwise the repository's own `dependency.pinned_ref` (for `init`) or this binary's own version, and then **the greater of that and the minimum `templates/index.json` declares** — which is the first release carrying the `nen shu` verbs the workflow runs. That floor exists because the failure without it is silent at scaffold time and total at CI time: a workflow pinned at a release with no `shu` family is red on the first push, and one pinned at a tag with no *release* never gets a binary at all — `bash nen-bootstrap.sh --ref <tag>` refuses at **exit 6**, because [a tag is not a release](#getting-the-binary) and there is no `SHA256SUMS` to verify against. nen cannot check either fact offline, so whenever the written ref is not this binary's own version it prints the ref, that caveat, and the releases page. It names no build tool, no package manager and no test runner: every argv it runs comes from the scaffolded repository's own `nen/contract.json`, so changing what CI runs means changing the declaration.

<a id="family-canon"></a>

**`nen canon`**

Resolves which handbooks a target repository loads, reads the canon pin its registry records, and keeps a canonical-rule mirror in sync with a `canon-values.yml` -- in the rules location of **every agent surface the consumer declares**, not one directory. It never decides handbook CONTENT -- it only resolves the always-load set plus one stack handbook from a recorded scenario (`nen/repos.json`), and renders/diffs the stack's rule set into each surface's own location, the way the reference implementation's `scripts/sync_canon.py` did for one.

**Where the canon lives.** The single canonical source of every handbook and rule set is the public [`zheref/bankai-handbooks`](https://github.com/zheref/bankai-handbooks) repository (`CON-13`): `handbooks/INDEX.md` is its manifest -- the always-load set plus exactly one `stacks/<scenario>/` handbook per scenario, each stack carrying its operational `rules/` set. Every path flag on this family (`--always-load`, `--stack-dir`, `--rules-dir`) names a location inside a **checkout of that repository at the tag the consumer pins**; nen fetches nothing and knows no repository by name. The scenario-to-stack mapping is derived, not looked up: the recorded scenario IS the directory name under `--stack-dir`, so a stack added to the canon needs no change here. The reference implementation these verbs were ported from is frozen; nothing in this family reads it.

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
| `--target <owner/name>` | yes | The repository being resolved -- a consumer, a maintained tool or a pending onboarding. | Its scenario is read exactly as [`repo scenario`](#nen-repo-scenario) reads it, off its `consumers[]`, `maintained_tools[]` or `pending_onboarding[]` row ([#219](https://github.com/zheref/nen/issues/219)). Refused (exit 1) if unrecorded, recorded on no row that states a scenario, or recorded with conflicting ones -- each with `repo scenario`'s own reason. |
| `--always-load <path,path,...>` | yes | The repository's own unconditional-load manifest. | An empty list is refused -- there is no meaningful "loads nothing" empty form. |
| `--stack-dir <dir>` | yes | Directory the one stack handbook is resolved under. | The `handbooks/stacks` directory of a `bankai-handbooks` checkout at the pinned tag; the stack path is `<stack-dir>/<scenario>/<leaf>`. |
| `--leaf <file>` | no | The stack handbook's filename. | Defaults to `architecture.md`. `--leaf rules` resolves the stack's operational rule directory, which is what [`canon mirror generate`](#nen-canon-mirror-generate) takes as `--rules-dir`. |

**Output and exit codes** -- prints `scenario: <name>`, `always load: <a, b, ...>`, `stack handbook: <stack-dir>/<scenario>/<leaf>`. `--json`: `{ scenario, alwaysLoad, stackHandbook }`. Every refusal (unrecorded target, empty always-load, a path-shaped scenario) prints as a plain `nen:` line even under `--json`. Exit 0 on a resolved scenario; exit 1 on an unrecorded target, one with no (or conflicting) recorded scenario, or an invalid scenario shape.

**Example** -- for a consumer whose `consumers[]` entry records `swiftui-tca-uzf-v2` (`owner/name` and `/path/to/repo` are placeholders), passing the five always-load baselines `handbooks/INDEX.md` names at `v0.6.0`:

```bash
nen canon resolve --repo /path/to/repo --target owner/name \
  --always-load handbooks/uzf-core.md,handbooks/security-baseline.md,handbooks/ux-baseline.md,handbooks/release-policy.md,handbooks/quality-baseline.md \
  --stack-dir handbooks/stacks
```
```text
scenario: swiftui-tca-uzf-v2
always load: handbooks/uzf-core.md, handbooks/security-baseline.md, handbooks/ux-baseline.md, handbooks/release-policy.md, handbooks/quality-baseline.md
stack handbook: handbooks/stacks/swiftui-tca-uzf-v2/architecture.md
```

### `nen canon pin`

Answers "which canonical handbooks repository does this consumer mirror, and at which tag" from the consumer's **own** `nen/repos.json`: the `pinned` field on that repository's `maintained_tools` entry. The pin is data there for two reasons this family depends on: a sync has to know the tag **before** it can check the canon out and render, and [`canon mirror check`](#nen-canon-mirror-check) has to know it to hold the mirror to it -- a mirror that cannot name the tag it was rendered from cannot be checked for drift against it. It lives on `maintained_tools`, not `consumers[]`, because [`repo classify`](#nen-repo-classify) reads a `consumers` entry as a consumer at G2 while a canon repository stands at G4, and `maintained_tools` is the list whose entries classify as canon. [`schema check`](#nen-schema-check) reports the same pin on its `nen/repos.json` row.

**Usage**

```text
nen canon pin --repo <consumer> [--source <owner/name>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The consumer whose registry records the pin. | Listed unbracketed: omitted, exits 2 by name. |
| `--source <owner/name>` | no | Which pinned tool is the canon, when the registry pins more than one. | Refused (exit 1) when the registry records no `pinned` for it. |

**Output and exit codes** -- prints `source: <owner/name>`, `ref: <tag>`, `recorded in: <path> (maintained_tools[].pinned)`. `--json`: `{ contract: "nen.canon.pin/v0.1", source, ref, tagShaped, recordedIn }`. Exit 0 when exactly one pin answers. Exit **1**, with a distinct reason naming `maintained_tools[].pinned` as the field to record, when `--repo` has no `nen/repos.json`, when no maintained tool is pinned, when several are and `--source` does not say which, or when `--source` names a tool the registry does not pin. A recorded pin that is not tag-shaped (`main`, a SHA) is printed and then **exits 1** too: a canon mirror is rendered from a tag, never a floating branch (`CON-13`). Exit 2 on an omitted `--repo` or an empty `--source`.

**Example**

```bash
nen canon pin --repo /path/to/consumer --json
```
```json
{
  "contract": "nen.canon.pin/v0.1",
  "source": "owner/handbooks",
  "ref": "v0.6.0",
  "tagShaped": true,
  "recordedIn": "nen/repos.json (maintained_tools[].pinned)"
}
```
(for a registry whose `maintained_tools` carries `{ "repo": "owner/handbooks", "role": "canonical handbooks", "pinned": "v0.6.0" }`; shape from `src/canon/command.test.ts`)

### `nen canon mirror generate`

Renders the stack's canonical rule set -- every `.md` in `--rules-dir` except `--not-mirrored` (the canon directory's own `README.md` and `placeholders.md`), with every `{{TOKEN}}` bound from `--canon-values` -- into the rules location of **each agent surface the consumer declares**, under the consumer's own root (`--repo`). The location, the file extension, the frontmatter the surface needs and its size limit are the surface's **row** in `src/surface/rules.ts` (its `canonMirror` block, each fact cited to the page it was read from); adding a surface is adding a row, never a change to this verb. Only files whose bytes changed are written; a mirror file whose canon source is gone is deleted as an orphan.

| Surface | Where the canon lands | Shape |
|---|---|---|
| `claude-code` | `.claude/rules/<stem>.md` | one file per canon file, no frontmatter ([docs](https://code.claude.com/docs/en/memory)) |
| `codex` | `AGENTS.md` | **one managed block** between a `BEGIN` and an `END` marker, one `<!-- canon: <file> -->` section per canon file; the consumer's own prose outside the block is preserved byte for byte, and a document with no block gets one appended ([docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md)) |
| `cursor` | `.cursor/rules/<stem>.mdc` | one file per canon file with `description: <stem>` / `alwaysApply: true` frontmatter -- a plain `.md` there is ignored ([docs](https://cursor.com/docs/context/rules)) |
| `antigravity` | `.agents/rules/<stem>.md` | one file per canon file with `trigger: always_on` / `description: <stem>` frontmatter -- a file without one is silently discarded; **24,000-byte limit per file**, over it the run is refused ([docs](https://antigravity.google/docs/rules)) |

**Every file carries a generated-from marker** as its first *markdown* line (under the frontmatter fence where the surface needs one): `<!-- GENERATED by nen canon mirror from <source>@<ref>: <scenario>/<file> -- do not edit; change the canon and regenerate -->`. It is nen's own, not a template: `--source`, `--ref` and the scenario are the caller's, and `check` reads the same line back to tell stale from hand-edited. A document surface's block opens with `<!-- BEGIN GENERATED by nen canon mirror from <source>@<ref>: <scenario> -- ... -->` and closes with `<!-- END GENERATED by nen canon mirror -->`.

**The marker is the ownership claim -- the collision rule.** nen owns exactly the files that carry its marker. A destination that exists and carries none was written by hand: the **whole run is refused (exit 2) before the first byte is written on any surface**, naming the file -- move or rename the consumer's own rule, or delete it in favour of the canon one. An unmarked file in a rules directory with no canon source is the consumer's own (CON-13 leaves repo-specific, non-canon config to the consumer): never deleted, listed as **foreign**, never drift. Only a directory's *immediate* children are the mirror's, so a consumer's own rules can live in a subdirectory (`.claude/rules/local/`, say) untouched. A marked file with no canon source is an orphan and is deleted. A symbolic link at a destination is refused. A document whose block has lost its `END` marker (or gained a second `BEGIN`) is refused, because nen cannot tell where the hand-written prose resumes. A destination caught mid-merge is refused the same way **whether or not its marker survived on line 1** -- never regenerated over -- but the refusal names it as an **unresolved merge conflict** with its first conflict line (`<file> has an unresolved merge conflict (line N: '<<<<<<< HEAD') ...`), never as hand-written: finish the merge, then regenerate (zheref/nen#309). A conflict is a `<<<<<<<` or `>>>>>>>` line; the `|||||||` and `=======` lines git writes between them count only inside such a hunk, so a lone `=======` -- a setext heading underline in a hand-written rule -- is not one.

**The pin is data, and the flags default to it.** `--source` and `--ref` may be omitted: they then come from the consumer's own `nen/repos.json` -- the `pinned` tag on the canonical repository's `maintained_tools` entry, the same fact [`canon pin`](#nen-canon-pin) reads -- when exactly one maintained tool is pinned, or the one `--source` names. Given, a flag overrides the recorded pin. Neither given nor recorded is refused by name, saying both ways to supply it. **Pin discipline is enforced** either way: the ref must be tag-shaped (`v1.2`, `v1.2.3`, `v0.6.0-rc1`) -- a canon mirror is rendered from a **tag** of the canonical repository, never a branch or a bare commit -- and the incident `CON-13` records is a consumer pinned to a tag that predated the canon, whose next regen wiped its mirror from an empty source. Cut the tag first, then pin. `--rules-dir` names the stack's `rules/` directory inside a checkout of that repository **at that tag** (`nen canon resolve --leaf rules` derives the path); nen fetches nothing and checks nothing out.

**AGENTS.md is read by more than Codex** -- Cursor and Antigravity read it as plain prose, and Claude Code (v2.1.277+) reads it **only when the consumer has no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` at or above the root** (`~/.claude/CLAUDE.md`, a managed `CLAUDE.md` and `.claude/rules/` do not count and keep loading beside it). So rendering `claude-code` and `codex` into one consumer is safe -- the two coexist -- but a consumer that renders both keeps a `CLAUDE.md` (its project-specifics header) so each surface reads the canon once; the Claude Code setting that reads both files (`claude-md-and-agents-md`) is honoured in **user and managed scope only**, is ignored in a repository's settings files, and is therefore not part of this design. The portable single-file pattern, where a consumer wants one shared file, is a `CLAUDE.md` containing `@AGENTS.md` -- never double-loaded on any version or setting. Each surface's caveat, including this one, prints on stderr as `nen: note: <surface>: ...` and is never acted on.

**Usage**

```text
nen canon mirror generate --repo <consumer> --rules-dir <dir> --canon-values <path>
                          [--source <owner/name>] [--ref <tag>]
                          [--surfaces <a,b,...>] [--scenario <name>]
                          [--not-mirrored <a,b>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The CONSUMER repository the mirror is rendered into. | Listed unbracketed: omitted, exits 2 by name. This verb writes into the consumer's tree, and a cwd default would render a mirror into whatever directory the shell was standing in. `--rules-dir`, `--canon-values` and `--markdown-out` resolve against it; an absolute value is used as-is ([#100](https://github.com/zheref/nen/issues/100)). |
| `--rules-dir <dir>` | yes | The stack's `rules/` directory in a checkout of the canonical handbooks repository at `--ref`. | Refused (exit 2) if unreadable, if it holds no rule file (an empty rendering would delete every mirrored file as orphaned), if a rule file's name is not one a marker can carry and read back (letters, digits, `.`, `_`, `-`, ending `.md` -- no whitespace, no separator; list such a file under `--not-mirrored` or rename it upstream), or if it resolves inside a declared surface's own rules location (the mirror would be rendered from itself). |
| `--canon-values <path>` | yes | The consumer's `{{TOKEN}}` bindings, plus its `scenario:` and `surfaces:`. | `surfaces:` is an inline comma list (`claude-code, codex`) or a `- name` block list. An unbound token refuses the run naming the file and the token (exit 2). |
| `--source <owner/name>` | no, when the registry pins it | The canonical handbooks repository, as the marker cites it. | Defaults to the one pinned `maintained_tools` entry in the consumer's `nen/repos.json`; required when none or several are pinned. Refused unless it is an `owner/name` slug. |
| `--ref <tag>` | no, when the registry pins it | The tag of `--source` the mirror is rendered from, as the marker cites it. | Defaults to `--source`'s recorded `pinned` tag. Refused unless tag-shaped (`v<major>.<minor>[.<patch>][-pre]`), whichever way it arrived. |
| `--surfaces <a,b,...>` | one of the two | The surfaces to render into; overrides the file's `surfaces:`. | Neither given, or an empty list, is refused (exit 2) naming the known surfaces; so is a name that is not a row. "Every supported surface" is deliberately not a default. |
| `--scenario <name>` | no | Overrides the scenario read from `--canon-values`. | Its absence with no `scenario:` field in the values file is a refusal (exit 2); so is a value that is not the plain token [`canon resolve`](#nen-canon-resolve) requires (no `/`, no whitespace, no leading or trailing `.`/`_`/`-`), because it is written into every marker and read back by `check`. |
| `--not-mirrored <a,b>` | no | Files in `--rules-dir` that are never mirrored. | The canon directory's own meta files (`README.md,placeholders.md`). Default: none. |
| `--dry-run` | no | Report every write, deletion and foreign file; write nothing. | |

**Output and exit codes** -- prints `source: <owner/name>@<ref> (scenario <name>)`, `root: <path>`, then per surface `surface: <name> -> <location>` with indented `written:`, `unchanged:`, `deleted (orphaned):` lists (each `(none)` when empty), a `foreign (the consumer's own, left alone):` line when there are any, and `note:` lines (a block past a document surface's documented read limit, a file past a surface's line advice). `--json`: `{ contract: "nen.canon.mirror.generate/v0.1", source, ref, scenario, root, dryRun, surfaces: [{ surface, location, written, unchanged, deleted, foreign, notes }] }`. Exit 0 on a completed run; exit **2** on a missing or malformed flag, an unknown or empty surface list, an unreadable `--canon-values` (the shared reader's named refusal, `could not read '<resolved path>' (ENOENT). --canon-values names the vocabulary every mirrored rule is keyed by, ...` -- [#101](https://github.com/zheref/nen/issues/101)), an unbound token, a rules file over a surface's byte limit, or a destination this mirror does not own (nothing written on any surface). The one-directory shape's flags (`--out-dir`, `--mirror-dir`, `--header-template`, `--header-pattern`) are refused by name with where each meaning went.

**Example** -- a consumer whose `.claude/canon-values.yml` declares `scenario: swiftui-tca-uzf-v2` and `surfaces: claude-code, codex`, with the canonical repository checked out beside it at `v0.6.0`:

```bash
nen canon mirror generate --repo /path/to/consumer \
  --rules-dir ../handbooks/handbooks/stacks/swiftui-tca-uzf-v2/rules \
  --canon-values .claude/canon-values.yml \
  --source owner/handbooks --ref v0.6.0 --not-mirrored README.md,placeholders.md
```
```text
source: owner/handbooks@v0.6.0 (scenario swiftui-tca-uzf-v2)
root: /path/to/consumer
surface: claude-code -> .claude/rules/
  written: .claude/rules/00-overview.md, .claude/rules/01-folder-layout.md, ...
  unchanged: (none)
  deleted (orphaned): (none)
  foreign (the consumer's own, left alone): .claude/rules/house-style.md
surface: codex -> AGENTS.md
  written: AGENTS.md
  unchanged: (none)
  deleted (orphaned): (none)
  note: AGENTS.md's canon block is 158211 bytes; 'codex' documents that it stops reading project documents at 32768 bytes (project_doc_max_bytes in .codex/config.toml) ...
```
(shape derived from `src/canon/mirror.ts`'s `renderSurface`/`writeSurface` and `src/canon/command.test.ts`)

### `nen canon mirror check`

Renders the mirror from the SAME inputs `generate` takes and diffs **every declared surface's** committed copy against it, writing nothing -- the CI half of the pair. Drift is detected **per surface and per canon file**, not merely by presence: the marker every file carries names the pin it was rendered from, which is what tells `stale` (the pin moved and nobody regenerated) from `hand-edited` (this pin, other bytes) apart.

Per surface, a file is:

| Class | Meaning |
|---|---|
| `ok` | byte-identical to a fresh rendering at `--source@--ref` (line endings normalised, so a CRLF checkout is not drift) |
| `missing` | canon has it; the mirror does not |
| `extra` | the mirror has a **marked** file (or block section) with no canon source -- an orphan `generate` would delete |
| `stale` | marked for another source, ref or scenario: generated, never regenerated after the pin moved |
| `hand-edited` | marked for this pin but not a fresh rendering's bytes -- or carrying no marker at all where a canon file should be |
| `foreign` | an unmarked file with no canon source beside the mirror: the consumer's own, reported, **not drift** |

On a document surface the block's sections are classified one canon file at a time (a section canon dropped is `extra`; text between the `BEGIN` line and the first section is `extra` too, as `(text inside the block before its first canon section)`); a document with no block reads `missing` whole, a block whose marker pair is broken reads `hand-edited` whole, and prose outside the block is nobody's drift.

**Usage**

```text
nen canon mirror check --repo <consumer> --rules-dir <dir> --canon-values <path>
                       [--source <owner/name>] [--ref <tag>]
                       [--surfaces <a,b,...>] [--scenario <name>]
                       [--not-mirrored <a,b>] [--markdown-out <path>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | yes | The consumer whose committed mirror is checked. | Same as `generate`; never written to. |
| `--rules-dir <dir>` | yes | Same as `generate`. | |
| `--canon-values <path>` | yes | Same as `generate`. | |
| `--source <owner/name>` | no, when the registry pins it | Same as `generate`. | A file whose marker names another source is `stale`. |
| `--ref <tag>` | no, when the registry pins it | The pin this run expects; defaults to the recorded one. | A file whose marker names another ref is `stale` -- so moving the recorded pin without regenerating is exactly what turns every mirror file stale. |
| `--surfaces <a,b,...>` | one of the two | Same as `generate`. | |
| `--scenario <name>` | no | Same override as `generate`. | |
| `--not-mirrored <a,b>` | no | Same as `generate`. | |
| `--markdown-out <path>` | no | Also write the drift as a table: `Surface \| File \| Issue`. | Written regardless of `--json`, clean mirror or not, and its **parent directory is created** ([#292](https://github.com/zheref/nen/issues/292)); a relative path resolves against `--repo`, never the shell's directory, so no `mkdir -p` beforehand is needed (one run from the shell's directory would have made it in the wrong tree anyway). An empty value is refused. A table that cannot be written is exit **2** (see below). `--dry-run` is refused here: check writes nothing to begin with. |

**Output and exit codes** -- prints the same `source:` and `root:` lines as `generate`, then per surface `surface: <name> -> <location>` with indented `ok: <n>`, `missing:`, `extra:`, `stale:`, `hand-edited:` lists (each `(none)` when empty) and a `foreign (the consumer's own, not drift):` line when there are any, closing with `drift: none` or `drift: yes`. `--json`: `{ contract: "nen.canon.mirror.check/v0.1", source, ref, scenario, root, drift, surfaces: [{ surface, location, ok, missing, extra, stale, handEdited, foreign }] }`. Exit 0 when no surface has drift; exit **1** iff any surface has a missing, extra, stale or hand-edited entry and the run completed. An unreadable `--canon-values`, an unbound token, an unknown surface or a missing flag is exit **2**, not 1 -- a typo and a finding must stay distinguishable by exit code alone ([#101](https://github.com/zheref/nen/issues/101)). So is a `--markdown-out` that cannot be written -- a parent that is a file (`EEXIST`/`ENOTDIR`), a path that is a directory (`EISDIR`), no permission (`EACCES`/`EPERM`), or any other write failure (`ENOSPC`, `EROFS`, …): exit **2** on a clean mirror and a drifting one alike, because a report you asked for and did not get is a failed run, and it is **never** exit 1, which means drift. The refusal names the value as typed, the path it resolved to, the errno and the verdict the check reached, and it is raised before the verdict prints, so stdout carries no `drift` document beside it. Through v0.17.0 each of these -- and a missing parent directory, which is now created -- escaped as a raw error at exit **1**, so a clean mirror whose report could not be written read as drift ([#292](https://github.com/zheref/nen/issues/292)).

**Example**

```bash
nen canon mirror check --repo /path/to/consumer \
  --rules-dir ../handbooks/handbooks/stacks/swiftui-tca-uzf-v2/rules \
  --canon-values .claude/canon-values.yml \
  --source owner/handbooks --ref v0.7.0 --not-mirrored README.md,placeholders.md \
  --markdown-out .nen/canon-drift.md
```
```text
source: owner/handbooks@v0.7.0 (scenario swiftui-tca-uzf-v2)
root: /path/to/consumer
surface: claude-code -> .claude/rules/
  ok: 0
  missing: (none)
  extra: (none)
  stale: .claude/rules/00-overview.md, .claude/rules/01-folder-layout.md, ...
  hand-edited: (none)
  foreign (the consumer's own, not drift): .claude/rules/house-style.md
surface: codex -> AGENTS.md
  ok: 0
  missing: (none)
  extra: (none)
  stale: 00-overview.md, 01-folder-layout.md, ...
  hand-edited: (none)
drift: yes
```
(the pin moved to `v0.7.0` and nothing was regenerated: every file is stale on every surface, and the fix is one `generate` at the new pin; shape derived from `src/canon/mirror.ts`'s `checkSurface` and `src/canon/command.test.ts`)

**Driving the pair from a skill or CI.** The sequence a sync skill runs is: `nen canon pin --repo <consumer> --json` to learn the canonical repository and the tag the consumer is pinned to; check that repository out **at the tag**; `nen canon resolve --repo <consumer> --target <owner/name> --always-load <manifest> --stack-dir <checkout>/handbooks/stacks --leaf rules` to derive `--rules-dir` from the consumer's recorded scenario; `nen canon mirror generate --repo <consumer> --rules-dir <that> --canon-values <path>` (source and ref default to the recorded pin; its `--json` says what changed per surface, and exit 2 with nothing written names a collision the human resolves); commit. The consumer's CI runs `nen canon mirror check` with the same inputs and fails on exit 1 -- the drift check `CON-13` asks for. Repinning is then one edit to `maintained_tools[].pinned` followed by one `generate`; a repin without the regenerate is what `check` reports as stale on every surface.

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

Validates the SHAPE of a Conventional Commits message -- a declared type, a non-empty subject under 72 characters, no trailing sentence punctuation -- and never its content; what changed and why stays the author's to write. `format` reads and writes nothing on disk or over the network beyond `nen/workflow.json` (the trailer policy, `commits.subjectCase` and `commits.bodyMaxLineLength`) and the repository's commitlint config; `check` reads one build proof and asks git for a tree hash, and writes nothing at all.

### `nen commit format`

Builds and validates one Conventional Commits header (`type(scope)!: subject`) plus optional body paragraph and trailers, from the type set `feat, fix, chore, docs, refactor, test, perf, build, ci`. `--trailer` keys are caller data (a specific persona's trailer convention lives in the calling skill, never a literal in this binary).

**A repository may state which ATTRIBUTION trailers it admits, and then this verb enforces it.** When [`nen/workflow.json`](#nenworkflowjson) is present under `--repo`, a `--trailer` whose key is attribution-shaped and is *not* listed in that file's `commits.allowedAttributionTrailers` is refused at exit **2**, naming the trailer and the file. Attribution-shaped means one of `Assisted-by`, `Claude-Session`, `Co-Authored-By`, `Generated-by`, `Generated-with`, `Reviewed-by`, `Signed-off-by` — the keys that say *who or what produced this commit* — plus every key the file's own `commits.forbiddenTrailers` adds; matching **ignores case**, because every tool that reads the finished commit does. `Closes`, `Refs` and a project's own agent trailer are untouched.

**With no workflow file, no trailer is refused and the trailer check behaves exactly as it always has** — though, since [#290](https://github.com/zheref/nen/issues/290), `--body` is still wrapped to the commitlint line length (below). The list is never nen's: `commits.allowedAttributionTrailers` is the repository's, and a guard that fired without the repository having asked for it would be this verb deciding somebody's commit convention for them. The policy is read on **every** invocation, with or without a `--trailer` — `commits.subjectCase` (below) can refuse any subject, so no message is one that could not have violated it. A workflow file that is present and **malformed** is exit **1**, naming the pointer: the invocation was correct, and nen will not shape a message under a policy it could not read.

**The repository's `subject-case` rule is enforced too** ([#263](https://github.com/zheref/nen/issues/263)). A subject `nen commit format` passed used to meet commitlint's commit-msg hook afterwards and be refused there (`Start…`, `Escape…`) — an amend and a recommit. Now the subject gets the rule's verdict first, from one of two places. Only `subject-case`: nen's other shape rules are unchanged and are not reconciled with the repository's other commitlint rules.

1. **The commitlint config, when nen can read it as data** — the rules below. It is the gate commitlint actually runs at commit time, so where it is readable it **wins**.
2. **`commits.subjectCase` in [`nen/workflow.json`](#nenworkflowjson)** — the rule *declared* as data: `"config-conventional"` (that preset's published default) or an explicit commitlint rule `[level, "always"|"never", cases]`. It applies — and is **binding**: level 2 refuses at exit **2** — wherever the commitlint config cannot be read as data: a **JavaScript/TypeScript** config (which nen never executes), a preset nen cannot resolve after config-conventional in `extends`, cosmiconfig's `$import`, a package manifest whose `commitlint` key will not parse — and wherever there is **no** commitlint config at all. The output always says the rule came from `nen/workflow.json`: the refusal names it, and a subject that passes gets a `nen: note: subject-case checked against commits.subjectCase in …` line. The repository that declares it owns keeping it in step with its commitlint config.

**Precedence, stated once.** A readable data commitlint config decides, and a `commits.subjectCase` beside it is reported with `nen: note: commits.subjectCase in … is not applied` — never silently dropped, and never allowed to overrule the real gate, which would refuse subjects commitlint accepts or pass ones it refuses. The note says which case it is: a declaration that states the same rule *agrees with it: redundant here*; one that states a different rule — another level, condition or case list, or a rule where the config states none — **DIFFERS**, and the note names both (`<file> states <tuple | no subject-case rule>, the declaration states <tuple>; nen follows <file>, which is what commitlint runs`). Where the commitlint config is code, unreadable or absent, the declaration decides. With **neither** — a code config and nothing declared — nen can only warn that the rule was NOT checked, with config-conventional's verdict for reference, at exit 0, and commitlint can still refuse after the commit exists; that warning names `commits.subjectCase` as the fix. A malformed `.commitlintrc` is exit 1 whatever is declared: it is a broken gate, not a missing one.

- **Where it is read.** The config commitlint would load from `--repo`'s root, in commitlint's own order (`@commitlint/load`'s search places): `package.json` (its `commitlint` key), `package.yaml` (the same key), `.commitlintrc`, `.commitlintrc.json`, `.commitlintrc.yaml`, `.commitlintrc.yml`, then `.commitlintrc.{js,cjs,mjs}`, `commitlint.config.{js,cjs,mjs}`, `.commitlintrc.{ts,cts,mts}`, `commitlint.config.{ts,cts,mts}`. The first that holds a config wins; a blank file and a file holding `null` are stepped past, as commitlint steps past them. Read on **every** invocation — every subject can break it — and never from a parent directory, commitlint's global config directory, or a `--config` path a hook passes. commitlint itself also looks in parent directories, so when nothing is found, nothing is declared, and `--repo` (the cwd by default) has no `.git` entry — a subdirectory, most likely — the verb says so: `nen: warning: subject-case NOT checked: no commitlint config at <root>, and commitlint also looks in parent directories -- pass --repo <checkout root>`, exit 0.
- **A package manifest is commitlint's only through its key.** A `package.json` or `package.yaml` whose text carries no `commitlint` key is stepped past **unparsed** — a repository without commitlint is never stopped by its manifest, however it is written (an anchored `package.yaml`, a malformed `package.json`). One that carries the key but will not parse is a rule nen could not read — `commits.subjectCase` applies if declared, a `NOT checked` warning at exit 0 if not — never a failure.
- **Which rule.** An explicit `rules["subject-case"]` is decisive. Without one, `extends: ["@commitlint/config-conventional"]` (a string or in a list) means that preset's published default, `[2, "never", ["sentence-case", "start-case", "pascal-case", "upper-case"]]`. No rule and no config-conventional means commitlint checks nothing, and so does nen.
- **The subject is the one commitlint's parser finds in the header.** With config-conventional extended or any `parserPreset` named, the header is split with `conventional-changelog-conventionalcommits`' grammar — greedy about the scope, so `fix(a): Foo (b): bar` has the subject `bar`. With neither, and no preset extended that could supply one, commitlint uses its default parser (`conventional-changelog-angular`'s), which does not parse a `!` header: `feat!: Foo bar` gets no subject-case verdict from commitlint, and nen gives none either, saying so in a `NOT checked` warning. A `parserPreset` other than conventionalcommits, or one a preset extended beside an explicit rule may supply, is read with the conventionalcommits grammar — not mirrored. A rule declared in `commits.subjectCase` is judged with the conventionalcommits grammar too: the header nen renders, and config-conventional's own.
- **The verdict is commitlint's.** The semantics are ported from `@commitlint/rules` and `@commitlint/ensure` 21.2.3: a subject that does not open with a letter is not checked; quoted (`'…'`, `"…"`) and backticked spans are deleted before the check, so `` `Escape` key closes the modal `` passes; an empty or digit-leading remainder passes; `never` fails when any listed case matches, `always` when none does. Level **2** is refused at exit **2** with the other shape violations, naming the rule, the file and the fix; level **1** is a `nen: warning:` line and exit 0 (commitlint warns and still commits, unless the hook runs it with `--strict`); level **0** and no config change nothing.
- **Code is never executed.** A JavaScript or TypeScript config can only be read by running it, which a message formatter does not do. With `commits.subjectCase` declared, the declared rule applies instead (above). Without it, it is a `nen: warning: subject-case NOT checked:` line naming the file and the `commits.subjectCase` fix, exit 0 — never a silent pass, and never protection either. So is a preset other than config-conventional that comes after it in `extends` (it may set the rule; state `subject-case` under the file's own `rules`, or declare `commits.subjectCase`, and nen checks it), and a config using cosmiconfig's `$import`. The warning adds, labelled *for reference only*, what config-conventional's default would say of the subject.
- **A `.commitlintrc` nen cannot read is exit 1**, naming the file and the fault: invalid JSON or YAML (the YAML reader is the strict one — anchors, aliases, tags and merge keys are refused), a config that is not an object, or a `subject-case` rule commitlint itself would reject (a level other than 0, 1 or 2, a condition other than `always`/`never`, a length other than 2–3, an unknown case name). The same holds for a package manifest's `commitlint` key that parses into such a config. nen will not call a subject well-formed under a subject-case rule it could not read. A malformed `commits.subjectCase` is exit 1 too, by pointer down to the tuple element — `commits.subjectCase[1]` for a bad condition, `commits.subjectCase[2][0]` for an unknown case — through the same validator a commitlint rule meets.

**The body is wrapped to the repository's commitlint line length** ([#290](https://github.com/zheref/nen/issues/290)). `--body` used to be emitted exactly as typed, so a one-line paragraph over the width commitlint allows passed `nen commit format` and was then refused by the commit-msg hook, after `wc squash` had already reset. Now the same commitlint config the subject-case rule comes from is read for `body-max-line-length` and `footer-max-line-length` — or the body width is **declared** in [`nen/workflow.json`](#nenworkflowjson)'s `commits.bodyMaxLineLength` — and the verb acts on them before the message exists.

- **Which width — the maintainer's ruling, "Refuse at 100, declarable", on `commits.subjectCase`'s precedence.**
  1. **A commitlint config nen can read as data decides.** An explicit `rules["body-max-line-length"]` (or `footer-…`) is decisive; without one, extending `@commitlint/config-conventional` (with no preset nen cannot resolve after it) means that preset's published `[2, "always", 100]` for both. A `commits.bodyMaxLineLength` beside it is reported in a `nen: note: commits.bodyMaxLineLength in … is not applied` line — *agrees with it: redundant here*, or **DIFFERS**, naming both — and never overrules it.
  2. **Otherwise `commits.bodyMaxLineLength` binds** — where the config is JavaScript/TypeScript (never executed), uses `$import`, extends a preset nen cannot resolve after config-conventional, is a package `commitlint` key that will not parse, **and where there is no commitlint config at all**. A body line over it is refused at exit **2**, naming the declaration and why it applied; a body within it gets a `nen: note: body-max-line-length checked against commits.bodyMaxLineLength in …` line.
  3. **With neither, a config nen cannot read means 100, assumed and binding**: `--body` is wrapped at 100, a body line still over 100 is refused at exit **2** (the refusal says the width was not read and names `commits.bodyMaxLineLength` as the way to declare another), and a `nen: note: 'body-max-line-length' … NOT read:` line names the file. A code config that allows *longer* lines is therefore stricter here than at the hook until the repository declares its width. **With no config and nothing declared**, nothing is judged — there is no gate — and `--body` is still wrapped at **100**, config-conventional's width and nen's documented default. The same holds for a readable config that states no such rule.
  - **"The body" is every line of the message's own prose, wherever commitlint places it.** Where nen's width binds (the declared key, or the assumed 100), it holds every line after the header that is not in the **trailer block** — including prose commitlint reads as footer because a `Note: …` or `Closes #1 …` line opened the footer before it; that line and the rest of `--body` are still held, and wrapped, to the body's width. The trailer block is the final paragraph when every line of it is `Key: value`, as nen's message reader and git decide it: `format`'s `--trailer` lines, and the final trailer paragraph of a `write` message file, so both verbs split one message the same way. **The trailer block is not bound**: `footer-max-line-length` has no declared form, and where the config cannot be read a trailer line over 100 is a `nen: warning:` *for reference only* at exit 0, never a refusal. A readable `footer-max-line-length` beside an unreadable body rule still decides the footer's prose, as the gate commitlint runs there.
  - **A rule turned off (`[0]`) is not wrapped to at all** — the repository disabled the limit, so the body is emitted as typed.
  - **A width is read as commitlint reads it, and never refused.** commitlint compares `line.length <= width` with JavaScript's coercion, so `"100"` and `[100]` are 100, a missing width, `null`, `""` and `false` are 0, and `"abc"` or `{}` is NaN. A width of at least 1 is judged and wrapped to. A width below 1 — or NaN — is still a rule commitlint runs: a message with **no body passes**, and a body is refused (one finding for the section, at the rule's level, saying what commitlint does with that width: below 1 it refuses every body line that is not blank and holds no URL; negative or NaN, blank lines inside the body too); nen does not wrap to such a width, since no wrap can meet it.
- **The wrap.** Every `--body` line the rule would refuse is rewrapped to that width, breaking only at spaces and tabs — never inside a word, so a URL, a path or any unbroken token stays whole on a line of its own, and never at a no-break space. Between two words that stay on one line the whitespace is kept exactly; at each break it becomes the line's own terminator (a CRLF line stays CRLF) and the hang indent, and trailing whitespace on a rewrapped line is dropped (git drops it on commit anyway). Blank-line paragraph breaks are kept; a list item (`- `, `* `, `+ `, `1. `, `1) `) keeps its marker and its continuation lines hang under its text; a line indented as preformatted text (four spaces, or a tab) is left exactly as it is. **The wrap never changes how commitlint reads the message**: no line it creates starts with `#` (a comment to git and to `commitlint --edit`), `gpg:`, a footer token (`Closes #12`, `Key: value`) or a note (`BREAKING CHANGE:`), and a line that opens the footer still opens it (its first line keeps the token with the word after it). The break moves a word earlier; where no earlier break is safe it moves to the next safe one after it, and the line is left over the width for the check to name. A line that holds an `http(s)://` URL is left alone, because commitlint exempts it whatever its length. `--trailer` lines are never wrapped. Each rewrapped line is named in a `nen: note: --body rewrapped: …` line — numbered as the `--body` was given, blank lines it starts with included — including on a run another problem refuses, so one pass names both an over-long header and an over-long body line. **A message within its limits is emitted byte for byte.**
- **The check.** The finished message is then judged the way commitlint splits it — the body, then the footer from the first footer token or note onward, each without the blank lines at its edges — with `@commitlint/ensure` 21.2.3's per-line rule, ported with no dependency: a line passes if it holds an `http(s)` URL anywhere or is no longer than the width, counted in UTF-16 code units; `#` comment lines, git's scissors and after, and `gpg:` lines are not judged, as `commitlint --edit` does not judge them (`core.commentChar` itself is not read). A line over a **level-2** rule, the declared width, or the assumed 100 — one the wrap could not shorten, or a `--trailer` over the footer's width — is refused at exit **2** with the other shape violations, naming the line number, its length, the width, where it came from and why nen could not wrap it (a word longer than the width, preformatted text, or no break that keeps the message's reading); **level 1** is a `nen: warning:` at exit 0.
- **A malformed line-length rule is exit 1**, naming the file and the rule — only a *shape* commitlint itself rejects (a level other than 0, 1 or 2, a condition other than `always`/`never`, a length other than 1–3). **A malformed `commits.bodyMaxLineLength` is exit 1 too, by pointer** (`commits.bodyMaxLineLength`): it must be a whole number of at least 1 — this key is nen's own data, so a string, a fraction or a width below 1 is refused rather than coerced. Header length is unchanged: nen's own 72-character limit still applies, before the commit is made.

**Usage**

```text
nen commit format --type feat --subject "a short imperative subject"
                  [--scope <scope>] [--breaking] [--body "paragraph one"]
                  [--trailer key=value,key2=value2] [--repo <path>]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--type <type>` | yes | One of `feat, fix, chore, docs, refactor, test, perf, build, ci`. | |
| `--subject <text>` | yes | The header's imperative subject. | Non-empty, the FULL header line (`type(scope)!: subject`) must be <= 72 characters, and must not end in `.!?`. |
| `--scope <scope>` | no | The parenthesised scope. | Given but empty is refused -- omit the flag entirely instead. |
| `--breaking` | no | Adds the `!` marker after type/scope. | |
| `--body "paragraph"` | no | ONE paragraph. | This parser does not support repeating `--body`; pass one paragraph and use blank lines inside it for multiple, if the shell allows a multi-line value. A line over the repository's commitlint line length (100 where none is read) is wrapped at spaces — see above. |
| `--trailer key=value,key2=value2` | no | Comma-separated `key=value` pairs. | A key containing `:` or empty is refused. An attribution-shaped key the repository's `nen/workflow.json` does not admit is refused too — see above. |
| `--repo <path>` | no | The repository whose `nen/workflow.json` states the trailer policy, `commits.subjectCase` and `commits.bodyMaxLineLength`, and whose commitlint config states `subject-case`, `body-max-line-length` and `footer-max-line-length`. | Defaults to the cwd. Both are read on every run, so a `--repo` that does not exist is exit 2. |

**Output and exit codes** -- prints the formatted message, its `--body` wrapped as above. `--json`: `{ message }` -- unchanged; no key was added for `subject-case` or the line length, and `message` is the wrapped one. All shape violations, policy refusals and `subject-case` refusals, warnings and notes print as plain `nen:` lines on stderr even under `--json`, and **every** one of them is printed, not just the first -- a shape violation, a refused trailer and a capitalized subject in the same invocation are three problems reported together. Exit 0 on a valid shape (a `nen: warning:` or `nen: note:` line may accompany it — and in a repository whose commitlint config is code and that declares no `commits.subjectCase`, every run carries a `subject-case NOT checked` warning, so exit 0 is **not** a subject-case verdict there); exit 2 on any shape violation, trailer-policy refusal, level-2 `subject-case` break — commitlint's own or the declared one — or line over a level-2 `body-max-line-length`/`footer-max-line-length`, the declared `commits.bodyMaxLineLength`, or the 100 assumed for a body whose config nen cannot read; exit **1** when a `nen/workflow.json` (a malformed `commits.subjectCase` or `commits.bodyMaxLineLength` included) or a `.commitlintrc` (a line-length rule of a shape commitlint rejects included) is present and could not be read. A broken config is reported **first**: both files are named when both are broken, and then any shape violation the run could still establish is printed after them rather than dropped — the exit stays 1, because the repository's files are what is wrong. [`commit write`](#nen-commit-write) reports the same failures in the same order.

```bash
nen commit format --type fix --subject "stop dropping the last row" --trailer "Co-Authored-By=A" --repo .
```
```text
nen: trailer key 'Co-Authored-By' is an attribution trailer this repository refuses. '/tmp/site/nen/workflow.json' admits 'Akatsuki-Agent', 'Akatsuki-Run' under commits.allowedAttributionTrailers, and 'Co-Authored-By' is not one of them. Drop the trailer, or add its key to that list
```
exit 2. (from a real run against a scratch repository scaffolded by `nen scaffold init`; the absolute path is elided to `/tmp/site`)

```bash
nen commit format --type fix --scope ui --subject "Escape key closes the modal" --repo .
```
```text
nen: subject 'Escape key closes the modal' breaks this repository's commitlint rule 'subject-case' (@commitlint/config-conventional's default, which /tmp/site/.commitlintrc.json extends): subject must not be sentence-case. commitlint refuses this message at commit time, so nen refuses it now: start the subject with a lower-case word -- a quoted or backticked span is not checked, so a proper name can stay as it is inside `backticks`.
```
exit 2 -- and ``--subject "`Escape` key closes the modal"`` prints `` fix(ui): `Escape` key closes the modal `` at exit 0. With `commitlint.config.cjs` in place of the `.commitlintrc.json` and **nothing declared**, the same subject formats at exit **0** under a warning — and commitlint then refuses the commit after it exists:
```text
nen: warning: subject-case NOT checked: /tmp/site/commitlint.config.cjs is a JavaScript/TypeScript commitlint config, and nen does not execute a repository's code to read one. Declare the rule as data in nen/workflow.json's commits.subjectCase ('config-conventional' or a commitlint rule tuple) and nen checks it. commitlint still applies whatever rule the file states when the commit is made, after the commit exists. For reference only: under @commitlint/config-conventional's default -- the preset most commitlint configs extend -- this subject would be refused (subject must not be sentence-case).
```
Declaring it — `nen/workflow.json` is `{ "commits": { "subjectCase": "config-conventional" } }` beside that `commitlint.config.cjs` — makes it binding:

```bash
nen commit format --type fix --subject "Escape closes it" --repo .
```
```text
nen: subject 'Escape closes it' breaks the subject-case rule this repository declares (commits.subjectCase in /tmp/site/nen/workflow.json, 'config-conventional' (@commitlint/config-conventional's default); nen applies it because /tmp/site/commitlint.config.cjs is a JavaScript/TypeScript commitlint config nen does not execute): subject must not be sentence-case. The declaration makes the rule binding, so nen refuses it: start the subject with a lower-case word -- a quoted or backticked span is not checked, so a proper name can stay as it is inside `backticks`.
```
exit 2 -- and `--subject "escape closes it"` prints `fix: escape closes it` at exit 0 under
```text
nen: note: subject-case checked against commits.subjectCase in /tmp/site/nen/workflow.json, 'config-conventional' (@commitlint/config-conventional's default): nen applies it because /tmp/site/commitlint.config.cjs is a JavaScript/TypeScript commitlint config nen does not execute -- keep the two in step, since commitlint still runs its own rule at commit time
```
A malformed declaration, `"subjectCase": [2, "sometimes", "lower-case"]`, is exit 1 by pointer:
```text
nen: /tmp/site/nen/workflow.json: at commits.subjectCase[1], the subject-case rule must have 'always' or 'never' as its condition, received [2,"sometimes","lower-case"]. This repository's nen/workflow.json states the commit policy -- which attribution trailers a commit may carry, commits.subjectCase and commits.bodyMaxLineLength -- and nen will not shape a message under a policy it could not read. Run 'nen schema check' for the whole file's verdict.
```
(all from real runs against scratch checkouts holding `.git/`, that commitlint config — `{ "extends": ["@commitlint/config-conventional"] }` or its `module.exports` form — and, where stated, that `nen/workflow.json`; the absolute path is elided to `/tmp/site`)

The body, against a `.commitlintrc.json` that extends config-conventional:

```bash
nen commit format --type feat --scope capture --subject "rebuild the prompt" --trailer "Hatsu-Agent=kurapika" \
  --body "This rebuilds the capture prompt so that endeavor pills are rendered inline and the pane-hosted Inbox triage keeps its selection across reloads."
```
```text
nen: note: --body rewrapped: its line 1 (144 characters) was over the 100 characters this repository's commitlint rule 'body-max-line-length' allows (@commitlint/config-conventional's default, which /tmp/site/.commitlintrc.json extends), so nen broke it at spaces, never inside a word
feat(capture): rebuild the prompt

This rebuilds the capture prompt so that endeavor pills are rendered inline and the pane-hosted
Inbox triage keeps its selection across reloads.

Hatsu-Agent: kurapika
```
exit 0 — and commitlint 21.2.3 passes it, where it refused the unwrapped line with `body's lines must not be longer than 100 characters [body-max-line-length]`. A 75-character header in the same run is still refused, and the note still printed: `nen: header line is 75 characters, over the 72-character convention: …`, exit 2. With `commitlint.config.cjs` in its place — the config is code, and nothing is declared — the body is wrapped the same way, under
```text
nen: note: 'body-max-line-length' NOT read: /tmp/site/commitlint.config.cjs is a JavaScript/TypeScript commitlint config nen does not execute. So nen holds the body to @commitlint/config-conventional's 100 characters a line, the width most commitlint configs inherit, and refuses a line over it -- declare the repository's own width in nen/workflow.json's commits.bodyMaxLineLength if it is another
```
and a line the wrap cannot bring under the assumed 100 — `--body "see <a 120-character token>"` — is refused, as the maintainer ruled:
```text
nen: line 4 is 120 characters, over the 100 nen holds the body to because 'body-max-line-length' could not be read (/tmp/site/commitlint.config.cjs is a JavaScript/TypeScript commitlint config nen does not execute) -- @commitlint/config-conventional's default, the width most commitlint configs inherit: 'wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww...'. nen refuses it: it holds a word longer than 100 characters, which nen never splits -- shorten it (a line holding an http(s) URL is exempt, as commitlint exempts it) -- or, if the repository allows longer lines, declare its width in nen/workflow.json's commits.bodyMaxLineLength.
```
exit 2. With `{ "commits": { "bodyMaxLineLength": 150 } }` declared in `nen/workflow.json`, the same message formats at exit 0 under
```text
nen: note: body-max-line-length checked against commits.bodyMaxLineLength in /tmp/site/nen/workflow.json, 150; nen applies it because /tmp/site/commitlint.config.cjs is a JavaScript/TypeScript commitlint config nen does not execute -- keep the two in step, since commitlint still runs its own rule at commit time
```
(all from real runs against scratch checkouts; the absolute path is elided to `/tmp/site`)

**Example**

```bash
nen commit format --type feat --scope issue --subject "add a general comment verb" --trailer "Closes=#29"
```
```text
feat(issue): add a general comment verb

Closes: #29
```
(run for real)

### `nen commit check`

Answers ONE question: **is this working copy the one a green build proved?**
[`nen shu build`](#nen-shu-build) records `.nen/proof/<lane>.json` when every
step exits 0 -- the lane, the moment, and the git **tree** it built -- and
removes it when the build comes out red, so a proof never outlives the tree it
proved. This reads that file and compares its tree against this working copy's,
computed the same way: a **scratch index**, never yours (`git add -A`, then
`git rm --cached` for `.nen/`, then `git write-tree`).

**It is what makes "never commit over a red build" affordable.** The alternative
is rebuilding before every commit, or believing a sentence in a transcript.

**Usage**

```text
nen commit check --repo <path> --require-proof <lane> [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--require-proof <lane>` | yes | The lane whose build proof to check. | No default, ever: nen never picks a lane. A lane that resolves outside the tree is exit 2. |
| `--repo <path>` | yes | The working copy this answers about. | Required for [`shu warmup`](#nen-shu-warmup)'s reason applied to the other verb whose whole answer is about which directory it ran in: "wherever this process happens to be" is not a working copy anybody named. |

**Output and exit codes** -- `--json` is one object,
`{ contract, repo, lane, path, proof, treeHash, ok, difference, exitCode }`
(`nen.commit.check/v0.1`), where `proof` is the document as read (or `null`) and
`treeHash` is the tree **now**.

| Code | Meaning |
|---|---|
| `0` | the proof is there, it is that lane's, and its tree is this tree |
| `1` | one of the three differences, **named**: there is no proof (which is also what a red build since the last green one looks like), it records a different lane, or the tree has moved since the build. Not 2: the invocation was correct and the answer is a fact about the repository |
| `2` | `--require-proof` or `--repo` missing, a lane that escapes the tree, a flag this subcommand does not read, or a proof file that is present and is not valid JSON -- nen will not read a damaged proof as a missing one |

A proof is checked for its **values** and not only its field types: another `contract` may mean something else by the same fields, and `verb`/`exitCode` are the file's own assertion that a **green build** produced it (nen writes no pair but `build`/`0`, so any other reached the disk by hand). Each is exit 1 saying which, rather than a verdict computed from a document nen cannot stand behind.

**It reports and blocks nothing.** No commit is refused, no file is written, no
ref moves. Read the code and decide, as with
[`shu coverage --threshold`](#nen-shu-coverage)'s `met`.

```bash
nen shu build --repo . && nen commit check --repo . --require-proof nen
```
```text
lane:      nen
tree:      a63bdbfee2ae9182d83cf09afe3f29718fbf02d0
proof:     .nen/proof/nen.json  tree a63bdbfee2ae9182d83cf09afe3f29718fbf02d0 at 2026-09-10T06:58:24.364Z
verdict:   OK -- this working copy is the one the build proved green.
```
exit 0. Then one edited file later:

```text
lane:      nen
tree:      de1f5cd3bdecb39016bd9267b25423b3275d09b6
proof:     .nen/proof/nen.json  tree a63bdbfee2ae9182d83cf09afe3f29718fbf02d0 at 2026-09-10T06:58:24.364Z
verdict:   NOT PROVED -- the tree has moved since the build: it proved a63bdbfee2ae9182d83cf09afe3f29718fbf02d0 at 2026-09-10T06:58:24.364Z, and this working copy is de1f5cd3bdecb39016bd9267b25423b3275d09b6. Whatever changed since is unbuilt -- run 'nen shu build --lane nen' again.
```
exit 1. (both run for real, against this repository)


### `nen commit write`

Commits the index with a message file (v0.13.0,
[#227](https://github.com/zheref/nen/issues/227)) — the `git commit` Hatsu's
`kokusen` used to hand-roll. The message is validated **whole**, after every
`--trailer` has been appended, under the same rules
[`commit format`](#nen-commit-format) applies: the Conventional Commits shape
and this repository's attribution-trailer policy, through the parser and
the two validators [`wc squash`](#nen-wc-squash) already reads with
(`src/wc/messagefile.ts`'s parser, `validateCommitMessage`,
`attributionRefusalMessages`), never a second copy of them — composed here
with the **one** `nen/workflow.json` the verb loads, so the file is read once
and a broken one never hides the message's own shape fault — and the
repository's `subject-case` rule
([#263](https://github.com/zheref/nen/issues/263)), commitlint's own or the
one `nen/workflow.json`'s `commits.subjectCase` declares, under the **same
precedence** `commit format` states (a readable data commitlint config wins;
the declaration binds where that config is code, unreadable or absent),
through the one check `commit format` runs (`src/commit/commitlint.ts`), on
the subject commitlint's parser finds in the file's header. So
`nen/workflow.json` is read on every run here too, and a malformed one —
a bad `commits.subjectCase` or `commits.bodyMaxLineLength` included — is exit 1 by pointer even with no
`--trailer`. Its warnings (a level-1 rule, or a rule nen did not check) and
notes (which rule a verdict came from, or which declaration was not applied)
print as `nen: warning:` / `nen: note:` lines the moment they are known, so
they appear even when the repository's own hook then refuses the commit.
The message's line lengths are judged by the same check `commit format` runs
on what it emits ([#290](https://github.com/zheref/nen/issues/290)), under
the same precedence: a body or footer line over a level-2
`body-max-line-length`/`footer-max-line-length`, a body line over
`commits.bodyMaxLineLength` where that declaration binds, and a body line over
the 100 assumed where the config cannot be read and nothing is declared, is a
shape reason at exit **2**, naming the line; level 1, and a footer line over
100 under an unreadable config (for reference only), are warnings. **`write` does not wrap** — the file is the caller's message,
committed as written or refused, never rewritten; `commit format`'s output
already fits. `wc squash` does not apply `subject-case` or the line lengths.

**Usage**

```text
nen commit write --repo <path> --message-file <path> [--trailer <Key: value>]...
                 [--require-proof <lane>] [--dry-run] [--json]
```

| Flag | Required | Meaning |
|---|---|---|
| `--repo <path>` | **yes** | the repository whose index is committed |
| `--message-file <path>` | **yes** | the message; a relative path resolves against `--repo` |
| `--trailer <Key: value>` | no, **repeatable** | appended to the message's trailer block in order — onto the file's own block when it ends in one, as a new final paragraph otherwise. Exactly `Key: value`: a key of letters, digits and `-`, a colon, one space, a value. The first flag in this CLI that repeats; `format`'s comma-joined `key=value` spelling is unchanged |
| `--require-proof <lane>` | no | refuse unless [`commit check`](#nen-commit-check) would say OK for this lane — its own verdict, asked and acted on |
| `--dry-run` | no | print the git line and the composed message; commit nothing, write no file |
| `--json` | no | `nen.commit.write/v0.1` — see below |

**Order of refusals**, the same as [`commit format`](#nen-commit-format)'s
for everything the two share. A malformed `nen/workflow.json` (naming the
pointer) or a `.commitlintrc` nen cannot read (naming the file) — exit
**1**, reported **first**, both when both are broken, with any shape fault
the message still has printed after them; then the message or a `--trailer`
failing the shape — a level-2 `subject-case` break among them, commitlint's
or the declared one, and a line over a level-2 line-length rule — exit **2**,
every reason named; each of these before
any git call. Then the proof, when required — exit **1** (absent, for
another lane, or the tree has moved since the build); an empty index — exit
**1**, `nothing staged`. Only then `git commit -F .nen/commit/message.txt`: the composed message
is written there (a deterministic path under the generated-output directory)
and removed afterwards whatever git answered, and the `.nen/commit/`
directory with it when the message was its only occupant.

**There is no `--sign-off`.** `Signed-off-by` is an attribution-shaped
trailer, and this repository's trailer policy forbids attribution trailers
other than the ones it names — the verb would be adding a line the validator
then refuses. Where a repository's policy *admits* it, pass it as any other
trailer: `--trailer "Signed-off-by: Name <email>"`. Typing `--sign-off`
anyway is refused as an unknown option at exit 2, and the refusal says
exactly this (`nen commit --help` does too).

**Then the commit is read back** ([#273](https://github.com/zheref/nen/issues/273)).
A hook that runs *inside* the verb's own `git commit` — `prepare-commit-msg`,
`commit-msg`, or a harness's own (Cursor appends `Co-authored-by: Cursor
<cursoragent@cursor.com>`, [zheref/hatsu#66](https://github.com/zheref/hatsu/issues/66))
— can add a trailer to a message nen already validated. So after the write the
verb asks git's own trailer parser what the commit carries and compares it
with the message it wrote, case-insensitively on the key. **Both sides are read by git's own
trailer parser**: the composed message through `git interpret-trailers --parse
--unfold --no-divider` *before* the write (a git that cannot parse it stops the
verb with nothing committed), and the written commit through `git cat-file
commit <sha>` — plumbing, which no `log.*` setting such as `log.showSignature`
can add a line to — and the same parser after. `--no-divider` keeps a
standalone `---` line in the body from ending the read (without it git takes
it for the start of a patch and sees no trailer below it), and the output is
decoded with the **first character of `trailer.separators`** (`git config
--get trailer.separators`, `:` when unset) — the character `--parse` prints
with — so a repository declaring `=:` is read, not silently emptied. A refused key on the commit is
**injected** when:

- a hook **added** it (the message did not carry it) and this repository's
  [`nen/workflow.json`](#nenworkflowjson) refuses it — an attribution trailer
  not in `commits.allowedAttributionTrailers`, or a key in
  `commits.forbiddenTrailers`, the same `trailerRefusal` `commit format` and
  the generated hook ask;
- a hook **added** it and its key ends in **`-by` or `-with`** (any case) and
  `commits.allowedAttributionTrailers` does not admit it — Hatsu's own guard's
  rule, which catches a harness stamp on no list (`Made-with: Cursor`). This
  rule binds with **no** `nen/workflow.json` too, where the allow-list is
  empty; it is the only one that does;
- the **message itself** carried it and the policy refuses it — possible only
  where git reads a trailer nen's stricter shape check did not (a
  `Key:value` line with no space). It is worded as *carried by the message*,
  never *added by a hook*, and the `-by`/`-with` rule is not applied to it.

Every such key is named in `injected[]` and on stderr with its source and
rule, and the verb exits **3**. The commit is **left in place — never
amended**; the line names the way back, **parent-aware**, with the change kept
staged: `git reset --soft HEAD~1` — or, when the written commit is the
repository's **root** commit and there is no `HEAD~1`, `git update-ref -d
HEAD` on a branch (the branch is unborn again, the index untouched) and `git
checkout --orphan <branch>` on a detached HEAD, asked of `git symbolic-ref -q
HEAD`. A key a hook added that nothing refuses (the repository's own
`Hatsu-Agent`, Gerrit's `Change-Id`) is a `nen: note:` line and the exit is
unchanged.

A read-back git cannot answer is exit **1**: the commit exists, and the check
was **not** performed — never rendered as `injected: []`.

**Exit codes** — `0` committed, nothing refused added; `1` a broken config, a
refused proof, an empty index, a failed `git commit` or read-back; `2` the
message or a `--trailer` failing the shape; **`3` committed, and a hook
injected a trailer the policy refuses**.

**`--json`** — `nen.commit.write/v0.1`: `{ contract, sha, subject, trailers:
[{ key, value }], injected: [key, ...], dryRun }`. `sha` is `null` on a dry
run. On a real write `trailers` is **read back from the written commit**, so a
trailer a hook added is in it; on a dry run it is the composed message's, the
file's own first. `injected` is the keys above (`[]` when the read-back found
none) and **`null` on a dry run** — nothing was written, so nothing was
checked.

**Example**

```bash
nen commit write --repo . --message-file message.txt --trailer "Hatsu-Agent: kurapika" --dry-run
```
```text
would run: git commit -F .nen/commit/message.txt
message:
  feat(x): add a thing

  Why it changed.

  Hatsu-Agent: kurapika
```

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

<a id="stall-two-gate"></a>
**Stall guard — the two-gate symptom.** A step with a declared `stall` block
strikes only when **both** of its budgets are exceeded at the same tick:
`elapsedMs` since the step started **and** `quietMs` since its last byte of
output. Neither alone is a symptom. A build past its elapsed budget that is
still printing has not stalled — its quiet window keeps resetting; a build
that has said nothing for longer than `quietMs` but is still inside
`elapsedMs` has not stalled either — a compile legitimately goes quiet early
on. `nen shu <verb> --dry-run` states the rule on every guarded step as
`stall guard: elapsed >N ms AND quiet >M ms (both): <remedy>`, so the second
number cannot be read as a silence timeout on its own, and
`src/shu/run.test.ts` pins all three cases against the seam's own window
arithmetic. The `test` row carries no guard by ruling: tests are untimed, and
a `stall` declared there is refused at load by pointer.

**`--effort <id>` — a run's steps on the phase ledger** (v0.13.0,
[#227](https://github.com/zheref/nen/issues/227)). Every executing `shu` verb
takes `--effort <id>` (or reads `NEN_EFFORT` from the environment when the
flag is absent) and, when the [`nen phase`](#nen-phase) ledger for that effort
has an OPEN entry, appends every step it ran to that entry as
`{ verb, argv, exitCode, durationMs, stalled }` — the same `durationMs` the run
report prints, `null` when the tool never started. Nothing is written when no
entry is open (a run outside a phase is never a phase of its own), when no
ledger exists, on `--dry-run`, or on an interactive pre-flight; a ledger that
cannot be written is a line on stderr and never a failed run.

<a id="shu-run-report"></a>
**The shared `--json` run report.** Every `shu` verb that EXECUTES a declared
invocation emits one object with the same top-level keys, in this order:

```text
{ contract, lane, stack, verb, target, steps, cwd, env, host,
  preconditions, exitCode, durationMs, artifacts, log }
```

`contract` is `nen.shu.<verb>/v0.1` — per verb, so a consumer that recognises
`nen.shu.build/v0.1` is never handed a `test` report by accident. `build` adds
one key after `log`: `proof`, the `.nen/proof/<lane>.json` a green build records
(`null` when the build was not green or nothing was run). `target` is `null`
unless a destination or a device was resolved — on [`deploy`](#nen-shu-deploy) it is
`{ name, args, requiresEnv }` (variable **names**, never a value), and on
[`dev`](#nen-shu-dev)/[`run`](#nen-shu-run) with `--target` it is
`{ name, verb, lane, args, artifact, device, probe, after }`. `env` carries
variable **names** only. `steps[].exitCode` is the **tool's** code and is `null`
when nothing was run, which is how a reader tells a dry run from a real one;
`exitCode` is nen's own. Under `--json` a step's own output goes to **stderr**,
so stdout stays exactly one document.

Six verbs of this family answer a **different** contract instead, because they
report on something other than a run: [`detect`](#nen-shu-detect)
(`nen.shu.detect/v0.1`), [`tools`](#nen-shu-tools) (`nen.shu.tools/v0.1`),
[`coverage`](#nen-shu-coverage) (`nen.shu.coverage/v0.1`),
[`test-report`](#nen-shu-test-report) (`nen.shu.test-report/v0.1`),
[`evidence`](#nen-shu-evidence) (`nen.shu.evidence/v0.1`) and
[`warmup`](#nen-shu-warmup) (`nen.shu.warmup/v0.1`). Each is documented in its
own section. `--json` is **refused** on `dev` and `run` unless `--dry-run` is
also given: those two hand this terminal to the child, and one object followed
by a server's log lines is not a document.

| Field | Meaning |
|---|---|
| `project.lanes` | `{ "<lane>": { "stack": "<id>", "cwd": "<repo-relative>" } }`. A stack is a **per-lane** property: one repository is routinely several builds. |
| `project.kind` | Optional. `product`, `process` (plugins and machinery) or `library` (reusable code shared across repositories, products and other process or library repositories, whatever its stack). Absent, [`repo classify`](#nen-repo-classify) derives `product` or `process` from the lanes' stacks; a declaration wins, and is the only way to read `library`. A value outside the three is refused by pointer at load. |
| `project.defaultLane` | Which lane `--lane` defaults to. `null` is legal and means `--lane` is required — even when there is exactly one lane, so a second lane arriving later cannot silently change what a scripted `nen shu build` builds. |
| `project.verbs` | `{ "<lane>": { "<verb>": <invocation> } }`, where an invocation is `{ exe, argv }`, `{ steps: [...] }`, or `{ unsupported: "<why>" }`. `argv` is a **list**, never a string: there is no shell, no expansion, no `sh -c`. An invocation may also carry `env` (NAME → value, passed to the child; only the names are ever reported), `artifacts` (repo-relative paths the verb produces, which nen reports and never creates) `stall` and `stdoutTo` (both below). |
| `…<verb>.stall` | `{ elapsedMs, quietMs, onStall: { exe, argv }, maxStrikes }` — what to do about a step that stops making progress, **in the repository's own words**. Some toolchains hang: a compiler process wedges, the build stops emitting and never finishes, and the fix is to kill the wedged **grandchild** and let the build respawn it. Which process that is, and how it is named, is knowledge about a toolchain — the one thing this family's executor may not carry — so the repository declares the remedy as an ordinary argv and nen contributes the two numbers that decide **when**. It runs `onStall` once **both** budgets are past: `elapsedMs` since the step started **and** `quietMs` with no output. Both, never one — a guard that acted on silence alone would fire at a healthy build that legitimately went quiet early on. Each firing restarts the quiet window and costs a strike; after `maxStrikes` (default **2**) the step is reported **stalled** at exit 1. **Nen never kills the child it started**, at any strike count: on a stall it stops watching, stops waiting, and says the process is still running and is yours to stop. Both budgets and `maxStrikes` are required positive integers (a default for either budget would be nen deciding what "too long" means for somebody else's build) and `onStall` is argv, never a string. Declarable on an invocation (it reaches every step that declares none) or on one `steps[]` entry (which wins). Only on the verbs whose output nen READS — `build`, `ui-test`, `lint`, `archive`, `coverage`, `test-report` — since [`dev`](#nen-shu-dev)/[`run`](#nen-shu-run) hand this terminal to the child and `release`/`deploy` put bytes where nen will not intervene mid-flight; anywhere else is exit 2 naming the set. **A `stall` on the `test` row is refused at load, by pointer, with the reason "tests are untimed"** (v0.13.0, [#227](https://github.com/zheref/nen/issues/227)): a test suite that goes quiet is a suite that is thinking, and a remedy fired at it would be nen deciding how long somebody else's tests may take. `--dry-run` prints the guard as a `stall guard: elapsed >N ms AND quiet >M ms (both)` line under the step it guards — see [the two-gate symptom](#stall-two-gate). |
| `stdoutTo` | On an invocation, or on one entry of its `steps`: the **repo-relative file** that step's stdout is written to. There is still no shell and no redirection **operator** — nen already captures a child's stdout, and this says to write those bytes to a file rather than relay them. It is the answer for a tool that **prints** the thing nen then parses (`xccov view --report --json` is the bundled example: `nen shu coverage` reads a *file*). Refused **at load** for a path that is absolute, carries a `..` segment, or carries a glob character (`*`, `?`, `[…]`) — nen expands nothing, so a glob would create a file with that character in its name; refused **at the run**, before anything spawns, when a directory is already at the path or a symlink would land the write outside the tree. Refused outright on `dev` and `run`: those hand the terminal to the child, so nen never sees their output. The file is written whatever the tool exited (a half report is what a redirect leaves), and **not** written for a step that could not start. That step's stdout does not also go to the terminal; its **stderr** still does. `--dry-run` prints `stdout -> <path>` on the step, the report lists every such file beside `artifacts`, and `--json` carries `steps[].stdoutTo`. It works on a step that also carries a `stall` guard: that step's output arrives from the streaming seam as chunks rather than as one buffer, so the chunks are held and joined rather than relayed. |
| `project.preconditions` | `{ "<lane>": [ { kind, value, why } ] }`. Nen **asserts** these and **never performs** them. |
| `project.hosts` | `{ "<verb>\|*": ["darwin","linux","win32"] }`, compared against this host. An exact verb key wins over `*`, and a declaration with no `hosts` block constrains no verb — a repository that said nothing about platforms has not said `darwin`. |
| `project.targets` | `{ "<name>": { args, requiresEnv, unsupported, why } }` — the deploy destinations, and a **project-level** map rather than a per-lane one. `--target` must name a key of it, and there is no default — not even when there is exactly one. The **command** stays in `project.verbs.<lane>.deploy`, where every other verb's command is; a target says where that command sends it. `args` are appended to that argv, in order — refused on a multi-step row (which step reaches the destination is a guess), and refused, like any other argv, when they carry one of the reference pack's own placeholder tokens. `requiresEnv` names variables that must be **set**, asserted exactly as a precondition of kind `env` is — the value is never read, compared, logged or printed, so a credential belongs in the environment and never in this file; each entry is held to a shell identifier (`[A-Za-z_][A-Za-z0-9_]*`) at load, because a name no environment could carry is a row that could only ever report `FAIL`. Repeats are collapsed, and a variable the lane's own preconditions already declare is asserted **once**. `unsupported` is the destination that has **no command line at all** (a hosting provider's own push integration, a CI action): exit 4 in the repository's own words, and the sentence is required rather than just the key. All four keys are optional; `{}` is a legal name-only target, and naming it is still mandatory. **Unknown keys are preserved** here as everywhere in this schema — with one exception: a key that misspells one of the four is **refused by pointer, naming the key it meant and which misspelling it is** — one letter out (`arg`, `requireEnv`), the same word in a different case (`Args`, `WHY`), or that key with an English plural on it — because preserving it means the flag was accepted, nothing was appended, and a different command deployed at exit 0. **Target names are the repository's own** and nen constrains them no more than it constrains a lane name: a name carrying a space or a leading `-` is legal, is listed verbatim in every refusal, and a leading `-` reaches `--target` only through the `--target=<name>` spelling. See [`nen shu deploy`](#nen-shu-deploy). |
| `project.launch` | `{ "<name>": { verb, lane, args, artifact, device, after, unsupported, why } }` — the **launch** targets `nen shu dev` and `nen shu run` take, and a project-level map like `targets`. A different block and a different vocabulary: `targets` says where a build is **sent**, `launch` says which **device** a local run lands on. `--target` is **optional** here — a bare `dev` runs the lane's declared `dev`, as it always has — and a name this block does not carry is exit 2 listing the ones it does. `verb` is `dev` or `run`, required, out of a closed set: the two are different builds, so naming a `dev` target on `run` is exit 2 rather than a silent cross-over. `args` are appended to that verb's argv, refused on a multi-step row exactly as a deploy target's are, and refused at exit 2 when they name `{device.id}` or `{artifact}`: substitution reaches the target's `after` steps and nowhere else, so a token here is not unfillable but simply unfilled, and would reach the child process as itself. `device` is `{ name, kind, resolve, extract?, readyWhen }`: `name` is matched **exactly** against what the probe printed (never a prefix, never a case fold, never "the only one connected" — nen does not pick a device); `resolve` is a declared `{ exe, argv }` probe whose output nen searches, as JSON (a `name` property, with `identifier`/`id`/`udid`/`serial` from the same object, one of its direct children, or up to two enclosing objects) or as plain lines (the line carrying the name, and its first token of six-plus characters that carries a digit); `kind: "simulator"` with no probe resolves the id to the **name itself** and spawns nothing, while any other device with no probe is exit 2. A device the probe did not name is **exit 5 listing what it did offer**, and a name two id-bearing candidates carry is exit 5 naming both rather than a guess. `readyWhen` is **which of the probe's own states count as ready**, optional, and absent leaves the behaviour exactly as it was — a row that carries the name is taken as the device. It is `{ "field": <n>, "in": […] }` for a probe that prints lines (`field` is a whitespace-separated position on the device's own row, **counting the first token as 1**, the way a reader counts columns on their screen) or `{ "path": "<key>", "in": […] }` for one that prints JSON (a dotted key read off the object whose `name` matched, or — exactly as the id is — off an enclosing object up to two levels out). **Exactly one** of `field`/`path`, `in` non-empty beside it, `field` a whole number ≥ 1, and the rule refused on a device with **no `resolve` probe** (nothing is spawned there, so the rule would never be read) — all four at load, by pointer. States are compared as whole strings, verbatim; a JSON `true` or `3` at the named path is compared as `"true"` and `"3"`. A device whose row is present but whose state is not in the set is **exit 5 naming the device, the state seen and the states accepted**, and listing what the probe offered — the same discipline the absence refusal follows. `lane` is which lane that verb is read from, **optional**, and absent means the lane `--lane` named or, with no flag, `project.defaultLane` — it exists because a device build is routinely a different declared row from the one a developer iterates in, and a target that could not say so would install whatever the default lane produced; it must name a **declared** lane (refused by pointer at load, listing the ones that are) and an explicit `--lane` that disagrees with it is exit 2 naming both, because nen picks between two stated facts nowhere. It is read **before anything is rendered**, so a target whose own lane is the only one declaring the verb is reachable without retyping `--lane` — a lane the declaration overrode does not get to refuse the run first. `artifact` is the repo-relative path `{artifact}` stands for **instead of** the verb's first artifact, also optional: "the first artifact" is the right answer for the thing a lane *builds* and the wrong one for the thing a device *installs*, and a build routinely produces both. It is refused **outside the tree** (pointer `project.launch.<name>.artifact`, the same containment rule every declared path gets), refused as an empty string, and refused when **no after-step names `{artifact}`** — the key has one effect and a target that never writes the token has stated a path nothing reads. `after` is `[{ exe, argv }]` run once the verb exits 0, with `{device.id}` and `{artifact}` substituted — `{artifact}` is the **first** entry of the verb's own `artifacts` unless the target overrides it, and naming either token with nothing to fill it is exit 2 before anything spawns. `unsupported` is the target with **no command line at all** (a device farm's web console): exit 4 in the repository's own words, and it may not be declared beside anything that would be run. **Unknown keys are preserved** here as everywhere — except a key one spelling away from one nen reads (`arg`, `devices`, `resolver`, `verbs`, `lanes`, `artifacts`, `readywhen`, a readiness rule's own `fields`/`paths`, and the block key itself as `launches` or `Launch`), which is **refused by pointer naming the key it meant and which misspelling it is** — one letter out, a case slip, or an English plural. See [`nen shu dev`](#nen-shu-dev). |
| `project.evidence` | `{ globs, mechanism, scene, suiteSuffix }` — what [`shu evidence`](#nen-shu-evidence) matches a changed file against, **project-level** like `targets` rather than per-lane. `globs` (required, at least one) is a list of `*`/`**`/`?` patterns; `mechanism` (required) is one of `public-mirror` \| `files-changed` \| `embedded`, the repository's own answer to "how does a survivor reach a human" — `evidence` never mirrors, embeds or lists files itself, it only reports which mechanism a later step should use. `scene` (default `"{suite}-{scene}"`) and `suiteSuffix` (default `"SnapshotTests"`) are read by a later mirroring step, not by this release of `evidence` itself, which reports `suite` and `scene` as separate row fields. Refused by pointer, exactly as `targets` is and saying which misspelling it is, for a key that misspells one of the four — **and for a misspelling of the block key itself** (`evidences`, `Evidence`, `evidenc`), which no per-entry guard could catch: preserved as an unknown key it would be read by nobody, and this verb would refuse saying the repository declares no evidence block, about a file that plainly declares one. `launch`'s block key is guarded the same way; the older optional blocks (`targets`, `hosts`, `toolchain`, `profiles`) are deliberately **not**, because a declaration written against 0.3.0 may already park a near-miss key there. Absent block: exit 2 naming it. |

`project.launch.<name>.device` also admits optional `extract`, making its full
shape `{ name, kind, resolve, extract?, readyWhen }`. JSON extraction is
`{ format: "json", records: "<dotted array path>", name: ["<field path>", …],
identifier: ["<field path>", …], readiness?: ["<field path>", …] }`; text is
`{ format: "text", name: { field: <n> }, identifier: { field: <n> },
readiness?: { field: <n> } }`, with fields counted from 1. Ordered JSON paths
are fallbacks inside one record. Every declared JSON record must have a scalar
name; malformed JSON, a missing/non-array record path, or a non-object/nameless
record refuses. More than one exact-name record refuses even when IDs agree.
With extraction, `readyWhen` requires `extract.readiness` and carries only
non-empty `in`; legacy `readyWhen.field`/`path` selectors are refused so there
is one authority for the state location. Without `extract`, inferred discovery
in the table remains compatible.

**Preconditions are asserted, never performed.** A declaration saying
`{ "kind": "path", "value": "node_modules" }` is telling nen that a dependency
install has already happened. Nen checks it and refuses when it has not; it does
not run the install, because a dependency install executes the project's own
postinstall scripts. This release asserts two kinds:

| `kind` | `value` | Satisfied when |
|---|---|---|
| `path` | one repo-root-relative path | the entry exists (a dangling symlink, or a path nen cannot `lstat` at all, counts as present-and-broken, not absent) |
| `env` | one variable **name**, held at load to a shell identifier (`[A-Za-z_][A-Za-z0-9_]*`) | the variable is set. Its value is never read, compared or printed. `NAME=value`, `A B` and `--flag` are refused by pointer when the file loads rather than reported `FAIL` forever: a name no environment could carry is a check that cannot pass, which is a refusal wearing a check's clothes |
| `port` | one port **number**, 1–65535, written as a JSON number (`3000`, not `"3000"`) — plus `expect`, which is **required** and is `listening` or `free` | nen opens a TCP connection to **`127.0.0.1:<port>`** and destroys it. `listening` is satisfied when the connection is **accepted**; `free` when it is **refused**. Nothing is read or written either way, and the host is not a parameter — a declaration cannot make nen connect anywhere else. A connect that neither completes nor is refused within 500 ms is `satisfied: null` — *cannot assert* — and refuses at exit 2 like every other unassertable row: "nothing answered in time" is not "nothing is there". `expect` on any other kind is refused by pointer rather than silently dropped |

A kind nen cannot assert is reported as `satisfied: null` — *"cannot assert"* —
and **refuses at exit 2**. It is never reported as a pass: a check that could
not be performed must never render as one that came back clean. That covers a
kind this release does not know, a `port` whose probe **timed out**, **and** a
kind it does know stated as a *list* of values: `{"kind": "path", "value":
["a", "b"]}` is not a path, and reading the first element would be nen guessing
which one the declaration meant.

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
| `2` | usage: **no** declaration, no `project` block, an unknown `--lane`, a placeholder nen cannot substitute, a **missing** `--target` or one that names no declared target, `--json` on a long-running verb without `--dry-run`, a path that resolves outside the repository, or a precondition that is not satisfied. On [`shu evidence`](#nen-shu-evidence): a missing `project.evidence` block, naming it — the **one** usage refusal that verb has, since it takes no lane and spawns no declared invocation for a placeholder or a precondition to apply to. No changed file matching a glob is **not** this — it is exit 0 with an empty `rows`/`suites` set, never an error |
| `3` | **unsupported host** — the verb is real, this machine cannot run it. Never 1 (a retry wrapper would retry forever) and never 2 (the invocation was correct) |
| `4` | **unsupported verb for this lane** — the declaration says so, in its own words. The invocation was correct; the answer is a fact about the repository. Across the seven stacks this family is designed for, it is the majority case. [`shu warmup`](#nen-shu-warmup) passes it through from the build (or test) it delegates, unchanged. On [`shu deploy`](#nen-shu-deploy) it is also the answer for a **destination** the declaration marks `unsupported` — one that has no command line at all — for the same reason and in the same words |
| `5` | the declared program could not be started at all — not installed, or not on `PATH`. On [`shu tools`](#nen-shu-tools) it is also the CHECK verdict for a host where anything is missing or is not the pinned version |

**`--json`**, on every verb that executes one, is one object with these keys, in
this order: `{ contract, lane, stack, verb, target, steps, cwd, env, host,
preconditions, exitCode, durationMs, artifacts, log, proof }`. `contract` is
`nen.shu.<verb>/v0.1`. `env` is variable **names** only, never values.
`target` is `null` on every verb but [`deploy`](#nen-shu-deploy), where it is
`{ name, args, requiresEnv }` — the destination that was resolved, what it
appended to the argv, and the variable names it requires. Never a value of one.
`steps[].exitCode` is the **tool's** own code and is `null` when nothing was
run — which is how a `--json` reader tells a dry run from a real one; `exitCode`
is nen's. `steps[].stdoutTo` is the repo-relative file that step's stdout goes
to, or `null`. `preconditions[].expect` is `listening`/`free` on a `port` row
and `null` on every other kind — the verdict is meaningless without it. Under
`--json` a step's own output is relayed to **stderr**, so stdout stays exactly
one document; a step with `stdoutTo` sends its stdout to the file instead, and
only its stderr is relayed.

`steps[].stall` is `null` unless that step declares a guard, and otherwise
`{ elapsedMs, quietMs, maxStrikes, onStall, strikes, at, stalled }` — the
budgets as declared, then what happened: how many times the remedy ran, how many
**milliseconds into the step** each firing was (`at`, never a wall clock, so two
runs of one build compare), and whether the budgets were breached again with
none left. Spending every strike and finishing green is the guard **working**;
`stalled` is the separate verdict, and a stalled step reports `exitCode: null`
because the child never gave one — nen stopped waiting rather than killing it.

`proof` is the build proof this run wrote, or `null`. Only
[`shu build`](#nen-shu-build) ever fills it; it is on every verb's document for
the reason `target` is — one family, one document shape.

[`shu coverage`](#nen-shu-coverage) and
[`shu test-report`](#nen-shu-test-report) are the two executing verbs whose
`--json` document is **not** that shape: each runs through the same executor and
then parses what the run produced, so their stdout carries
`nen.shu.coverage/v0.1` — `{ contract, lane, stack, total, targets, threshold,
report, exitCode, touched, ladder }` — and `nen.shu.test-report/v0.1` — `{ contract, lane, stack,
report, tests, passed, failed, skipped, total, exitCode }` — and the executor's
own report is rendered to **stderr** instead, where every argv, duration and
precondition row still is. Nothing is lost and stdout is still exactly one
object.

[`shu evidence`](#nen-shu-evidence) is a FIFTH contract entirely
(`nen.shu.evidence/v0.1`), keys in order: `{ contract, base, mechanism, rows,
suites }`. There is no `lane`, `stack`, `steps`, `cwd`, `env` or `host` — this
verb runs no declared invocation, so none of those questions apply. Each
`rows[]` entry is `{ suite, scene, path, status }`, `status` being one of
`added` \| `modified` \| `deleted` \| `renamed` (git's own finer `R###`/`C###`/`T`
codes fold into this set: a copy reports as added, a rename at its **new**
path). Each `suites[]` entry is `{ suite, scenes }`, `scenes` being the unique
scene names under that suite in first-seen order. An empty `rows`/`suites` pair
is a **successful, exit-0** document — a branch that changed no evidence, not
an error.

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
`{"kind": "env", "value": "<NAME>"}` under `project.preconditions.<lane>` —
where `<NAME>` is the variable's name alone and is held to a shell identifier
(`[A-Za-z_][A-Za-z0-9_]*`) at load, the same rule a target's `requiresEnv`
entries are held to, because a name no environment could carry is a row that
could only ever report `FAIL`. The
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
`settings.gradle` are both right there, `build` and `lint` arrive as
**commands** with `{gw}` resolved for this host, and the other two are withheld
by two *different* readers, neither of them Node-shaped: `test` by the settings
reader, because `include ':app'` names the application module rather than the
library `{unitTestTask}` needs, and `ui-test` by the **plugin gate**, because
nothing in this lane applies the screenshot plugin whose task both of those rows
run. `defaultLane` is `null`, and **no `hosts` block is
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
| `--effort <id>` | no | The `nen phase` effort whose OPEN entry this run's steps are appended to. | Or `NEN_EFFORT` from the environment; see [`--effort`](#stall-two-gate) above. Nothing is written when no entry is open. |

**Output and exit codes** — the report, as text or `--json`. `0`/`1`/`2`/`3`/`4`/`5` as the family's table above. `--json` is the family's [shared run report](#shu-run-report), with `contract: "nen.shu.build/v0.1"`.

**A green build records the tree it proved.** When every step exits 0, this verb
writes `.nen/proof/<lane>.json` (creating the directory):

```json
{ "contract": "nen.shu.proof/v0.1", "lane": "nen", "verb": "build",
  "treeHash": "a63bdbfee2ae9182d83cf09afe3f29718fbf02d0",
  "at": "2026-09-10T06:58:24.364Z", "exitCode": 0 }
```

`treeHash` is git's own tree object for this **working copy** — not the index:
the build ran against the files on disk with nothing staged, and a check run a
moment before a commit sees everything staged, so an index-based hash would
disagree every time. It is computed through the seam with a **scratch index**
(`GIT_INDEX_FILE` under `.nen/`, removed afterwards) — `git add -A`, then
`git rm --cached` for `.nen/`, then `git write-tree` — so the repository's own
index is never read or written, no ref moves, and nen's own artifacts cannot
change the number they are used to compute. [`nen commit
check`](#nen-commit-check) reads it back and computes the same hash the same way.

It is a **fact, not a gate**: nothing here reads a proof, and no verb refuses
because one is absent. A **dry run writes nothing** — it ran no build, so it
learned nothing about this tree — and a build that comes out **red removes** an
existing proof, because a stale proof is a green answer to a question that has
since been answered red. A proof that cannot be written is one line on stderr
and a still-green build: a marker file may not fail a compile. `nen shu warmup`
delegates its verification build through this same executor, so a green warm-up
records a proof too.

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
stdout to:     (none declared)
log:           dry run -- nothing was executed, so there is no output to capture and no tool exit code to report.
```
(run for real, against the executor's own fixture declaration)

**Example — a step that stops making progress.** A lane declaring
`"stall": { "elapsedMs": 2000, "quietMs": 1000, "maxStrikes": 2, "onStall": {…} }`
against a step that never prints anything:

```bash
nen shu build --repo /tmp/demo
```
```text
step 1 of 1 has produced no output for 2009ms and has been running 2009ms -- past this repository's declared budget (elapsedMs 2000, quietMs 1000). Running its declared remedy, strike 1 of 2: echo 'the repository'\''s own remedy ran'
the repository's own remedy ran
step 1 of 1 has produced no output for 1500ms and has been running 3516ms -- past this repository's declared budget (elapsedMs 2000, quietMs 1000). Running its declared remedy, strike 2 of 2: echo 'the repository'\''s own remedy ran'
the repository's own remedy ran
step 1 of 1 is STALLED: 2 of 2 declared remedies have run and it has still produced nothing for 1002ms (4519ms in). nen does not kill what it started, and will not wait on it either -- the process is STILL RUNNING and is yours to stop. What nen ran is this repository's own project.verbs declaration, nothing nen chose.
lane:          demo  (demo-stack)
verb:          build
host:          darwin -- supported (the declaration constrains no platform)
preconditions: (none declared)
ran:           sleep 20  -- STALLED, still running (nen stopped waiting)
stall guard:   elapsed >2000 ms AND quiet >1000 ms (both): echo 'the repository'\''s own remedy ran'  (up to 2 times; ran 2 at 2009ms, 3516ms; STALLED -- every remedy spent)
…
step 1 of 1 stalled: sleep 20 -- every one of the 2 declared remedies ran and it went quiet again. nen exits 1; the step itself was never killed and has no exit code to report.
```
exit 1, in 4.6 seconds against a child that had 20 to go. (run for real; the
report's unchanged rows are elided at `…`.)

### `nen shu test`

Run the lane's test suite, from its declared `test` invocation. It reports the
runner's own output and the **exit code**, and nothing about which tests ran; for
that, [`nen shu test-report`](#nen-shu-test-report) runs this same invocation and
then parses the results file it names under `artifacts`.

**Usage**

```text
nen shu test [--repo <path>] [--lane <name>] [--dry-run] [--json]
```

**Output and exit codes** — as `build`, and `--json` is the family's [shared run report](#shu-run-report), with `contract: "nen.shu.test/v0.1"`. Like every executing verb in this family it is **`dry-run-gated`** in izanami's automation-policy table, so `nen watch until --command "nen shu test"` refuses and `nen shu test --dry-run` is the form a watcher or a loop can use. The reason is in [`--dry-run` discipline](#--dry-run-discipline) above and in `src/parse/izanami.ts`: the argv comes from a file in the *target* repository — a declared test task may well write, and one keystroke separates a golden-image check from its recorder — so the bare form is never certified, while the dry run is, because rendering and spawning nothing is a property of nen rather than a claim about that argv.

### `nen shu ui-test`

Run the lane's UI/E2E suite. Same shape as `test`, same `dry-run-gated` classification. Multi-step declarations are common here — a browser download step before the suite itself — and every step is printed by `--dry-run` and run in order.


**Output and exit codes** — the report, as text or `--json`; `0`/`1`/`2`/`3`/`4`/`5` as the family's table above. `--json` is the family's [shared run report](#shu-run-report), with `contract: "nen.shu.ui-test/v0.1"`.
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


**Output and exit codes** — the report, as text or `--json`; `0`/`1`/`2`/`3`/`4`/`5` as the family's table above. `--json` is the family's [shared run report](#shu-run-report), with `contract: "nen.shu.lint/v0.1"`.
### `nen shu archive`

Produce the lane's distributable artifact. Across the stacks this family is designed for, most lanes declare `{ "unsupported": "<why>" }` here, and the refusal quotes that sentence at exit 4.


**Output and exit codes** — the report, as text or `--json`; `0`/`1`/`2`/`3`/`4`/`5` as the family's table above. `--json` is the family's [shared run report](#shu-run-report), with `contract: "nen.shu.archive/v0.1"`.
### `nen shu release`

Publish the artifact, where the lane declares a publication step. Nen never synthesises signing material — no export options, no keystore, no provisioning profile, no notarization credential — and a lane that has no publication step says so in its own words.


**Output and exit codes** — the report, as text or `--json`; `0`/`1`/`2`/`3`/`4`/`5` as the family's table above. `--json` is the family's [shared run report](#shu-run-report), with `contract: "nen.shu.release/v0.1"`.
### `nen shu dev`

Start the lane's **debug** build for local iteration. Long-running: nen prints the pre-flight report as text, then inherits this terminal and hands it to the child, so the report's `steps[].exitCode` and `exitCode` are `null` and `log.mode` is `"interactive"`. Ctrl-C reaches the child; nen stays alive to report. `--dry-run` starts nothing at all.

`--json` is **refused at exit 2** here unless `--dry-run` is given: stdout belongs to the child from the handover onwards, so a report on that stream would be one object followed by a dev server's log lines. `nen shu dev --dry-run --json` is the machine-readable form of exactly the same pre-flight.

**`--target <name>` launches a declared device.** It names a key of [`project.launch`](#family-shu) — a different block from `project.targets`, and a different vocabulary: that one says where a build is *sent*, this one says which **device** a local run lands on. The flag is **optional** here and has **no default ever**: a bare `nen shu dev` runs the lane's declared `dev` exactly as it always has, so a repository declaring its first launch target changes nothing about the line anyone ran yesterday. A `--target` naming no declared key is exit 2 listing the ones that are declared.

Given, the verb becomes three things, in this order:

1. **the device probe** — `device.resolve`, an ordinary declared `{exe, argv}`, spawned through the **captured** seam because nen has to read its output. Nen searches that output for `device.name`, matched **exactly** as the repository writes it: JSON is walked for a `name` property, taking `identifier`/`id`/`udid`/`serial` from the same object, one of its direct children, or up to two enclosing objects; plain output is read as lines, taking the line that carries the name and its first token of six-plus characters that also carries a digit. A device the probe did not name is **exit 5 listing what it *did* offer**; a device it named with no id nen recognises is exit 5 saying exactly that. And a name **two** candidates carry — plain output has no field boundaries, so a declared `Handset` is carried by the `Handset Pro` row as well as its own — is exit 5 naming both, because taking the first would put the build on somebody else's device and report success. (One id reached twice is not an ambiguity; the same device described twice is one device.) A `device` with `kind: "simulator"` and no probe resolves to **its own name** and spawns nothing;

   **`device.name` is matched EXACTLY, as a string, and nen performs no Unicode normalisation.** macOS names a paired phone with its own typographic apostrophe — `’` (U+2019 RIGHT SINGLE QUOTATION MARK, the character autocorrect writes for a possessive), never the straight `'` (U+0027 APOSTROPHE) a keyboard's apostrophe key types — and a device probe reproduces the name the OS gave it, curly quote included. A `project.launch` declaration written with the straight quote (`"name": "Sergio's iPhone"`) will not match a probe row that says `Sergio’s iPhone`, exactly as a case fold or a prefix does not match either: the two are different strings at the code-point level, and this family compares strings, never sightlines. Declare the name with the SAME character the probe prints — copy it out of the probe's own `--dry-run` output (or `saw` in `--json`) rather than retyping it, since retyping is precisely how the two apostrophes get swapped.

   **A device that is PRESENT is not a device that is READY, and `device.readyWhen` is where a declaration says which is which.** The row that carries the name also carries a *state* — attached is not paired, paired is not unlocked, present is not finished booting — and matching the name alone answers only the first of those. Without the key nen read the first and reported it as the second: the probe resolved an id, exit 0, and every command after it failed one at a time against a device that was never going to answer. Declare `{ "field": <n>, "in": […] }` against a probe that prints **lines** (`field` counts whitespace-separated tokens on the device's own row, the row's **first token being field 1**) or `{ "path": "<key>", "in": […] }` against one that prints **JSON** (a dotted key on the object whose `name` matched, or on an enclosing object up to two levels out — the same walk the id already makes). A row whose state is not in the set is **exit 5 naming the device, the state seen and the states accepted**, listing what the probe offered, and it answers **before** the missing-id refusal — a device whose state is the reason it is unusable routinely prints a row with no id on it, and "the probe gave nen no id" is then the true sentence that helps least. Absent, nothing changes: every declaration written before the key existed behaves exactly as it did.

   **`device.extract` declares the record boundary when a probe has a richer schema.** For JSON, `records` is the dotted path to the device array and `name`, `identifier`, and optional `readiness` are ordered fallback paths read *inside each record*. This prevents two nested copies of one device name, or logical and hardware identifier aliases, from becoming two devices. For text, each non-empty line is one record and each field is a 1-based whitespace position. Matching stays exact, and more than one matching declared record always refuses — even when the identifiers agree or one is missing — because Nen does not collapse records across a boundary the repository declared. A declared JSON extractor refuses malformed JSON, a missing/non-array record path, non-object records, and any record with no scalar value at its declared name paths; it never turns those shapes into a successful empty inventory. `extract.readiness` owns where state is read, while `readyWhen.in` owns which states are accepted. With extraction enabled, any `readyWhen` requires `extract.readiness`, and declaring the legacy `readyWhen.field` or `.path` selector is a schema error.

   Apple JSON example (the executable and argv remain consumer declarations):

   ```json
   {
     "name": "Owner’s iPhone",
     "resolve": { "exe": "xcrun", "argv": ["devicectl", "list", "devices", "--json-output", "-"] },
     "extract": {
       "format": "json",
       "records": "result.devices",
       "name": ["properties.state.name", "deviceProperties.name"],
       "identifier": ["identifier", "hardwareProperties.udid"],
       "readiness": ["properties.connection.state", "connectionProperties.tunnelState"]
     },
     "readyWhen": { "in": ["connected"] }
   }
   ```

   Android text example for `adb devices` uses the serial as both exact target name and identifier; headings and daemon notices do not match field 1:

   ```json
   {
     "name": "R58M123456",
     "resolve": { "exe": "adb", "argv": ["devices"] },
     "extract": {
       "format": "text",
       "name": { "field": 1 },
       "identifier": { "field": 1 },
       "readiness": { "field": 2 }
     },
     "readyWhen": { "in": ["device"] }
   }
   ```

   Expo does not gain a third device schema: its iOS launch target uses the Apple extractor and its Android target uses the Android extractor, alongside the repository's own `expo run:ios` / `expo run:android` declarations.
2. **the lane's own verb**, interactively as ever, with the target's `args` appended (refused on a multi-step row — which step reaches the device is a guess). **Which lane** is `project.launch.<name>.lane` when the target names one — read before the invocation is rendered at all, so the override reaches the verb rather than being second-guessed by the lane it replaced — and otherwise the lane the invocation already resolved: a device build and the build a developer iterates in are two declared rows, and the target is where the file says which of them this launch is. An explicit `--lane` that contradicts it is exit 2 naming both, never a silent winner;
3. **the target's `after` steps**, captured, in order, with `{device.id}` and `{artifact}` substituted — `{artifact}` being the **first** entry of the verb's own `artifacts`, or `project.launch.<name>.artifact` where the target names one. That override exists because the first artifact is the thing the lane *built* and the installer wants the thing it *signed*, which is a later entry; it is refused outside the tree, refused empty, and refused when no after-step names `{artifact}` at all. Naming `{artifact}` on a verb that declares none *and* a target that overrides nothing, or `{device.id}` on a target with no device, is exit 2 *before anything spawns*: a token nothing can fill must never reach a command line as itself. Either token written into `args` is exit 2 for the other half of the same sentence — `args` is appended to the verb's own argv, which substitution never touches. They run only if the verb exited 0, and **a verb that never exits never reaches them** — that is what the declaration asked for, and nen backgrounds nothing.

   **`{artifact}` is substituted relative to the directory the after-step runs in**, which is the *lane's* — while `artifacts` and `project.launch.<name>.artifact` are stated, like every declared path, against the *repository root*. On a lane whose `cwd` is the root the two are the same string and always were, so nothing an existing declaration passes changes by a byte; on a lane one directory down, a declared `build/App.app` reaches the installer as `../build/App.app` rather than as a path that resolved against the wrong root. The `substitutes:` line says both when they differ — `{artifact} <- ../build/App.app  (declared build/App.app, as the after-steps' own directory sees it — lane '<name>' does not sit at the repository root)` — while `artifacts:` keeps reporting the repository-relative string: the two answer different questions (*what does this build produce* against *what will the child receive*), and collapsing them would hide the rebasing rather than show it. `--json` carries both, as `target.artifact` (the declared override, or `null`) and `target.artifactAs` (what is actually substituted).

All three run in the lane's `cwd` and are given the verb's own declared `env`: a launch is one lane operation, and an installer that could not see the variables the build was given would be a second environment nobody declared. Only the **names** are ever reported, here as everywhere.

**Which refusal answers first, when `--target` is given.** A target belongs to **one** of the two long-running verbs, and that is a fact about the declaration — true on every lane and every host — while a lane's `unsupported` seat is a fact about one row. So the target's own verb is checked **before the lane is even read**: `nen shu run --target <a target declared for dev>` is exit **2** naming the fix (`run 'dev --target <name>'`), never the lane's exit 4. It used to be the other way round, and on any lane where the other verb is seated or simply undeclared the caller got a dead end — *"'run' is unsupported on lane 'device'"*, true, and pointing at a row they never wanted — while nen already held the sentence that ends the problem one check further down. Everything else keeps the order it had: a lane's seat still answers **4** when the target's verb *does* match (there the seat is the whole answer), a target with **no command line at all** still answers 4 in the repository's own words, and a `--target` this block does not declare is still exit 2 listing the ones it does.

`--dry-run` prints all three as `would run:` lines with the tokens **unfilled**, plus one `substitutes:` line saying what each stands for, and spawns nothing at all — the probe included, which is what keeps this form read-only in [izanami's table](#nen-parse-izanami). `--json` still needs `--dry-run`, and the document's `target` is then `{ name, verb, lane, args, artifact, artifactAs, device: { name, kind, id, extract?, readyWhen }, probe, after }`, with `id` null exactly because nothing was probed. `extract` is present only when declared, preserving the existing report shape for older declarations.

```text
$ nen shu dev --repo <repo> --target handset --dry-run
lane:          web  (nextjs)
verb:          dev
target:        handset  (appends no argument)
device:        Placeholder Handset Pro  -- id not resolved (nothing was probed)
host:          darwin -- supported (declared: darwin, linux, win32)
preconditions:
  ok    path deps
  ok    env  PLACEHOLDER_LANE_TOKEN
would run:     placeholder-device-tool list --json
would run:     pnpm exec next dev
would run:     placeholder-installer install --device {device.id}
substitutes:   {device.id} <- the id of device 'Placeholder Handset Pro', read from the probe above
cwd:           <repo>
env:           (none added)
artifacts:     (none declared)
stdout to:     (none declared)
log:           dry run -- nothing was executed, so there is no output to capture and no tool exit code to report.
```

(from a real run against `src/schema/fixtures/shu-repo`, whose `project.launch` declares the five rows this verb has to answer for — a simulated device, a probed one, one declared for the other verb, one with no command line at all, and one that overrides both its lane and its artifact.)

**The two overrides, as `--dry-run` renders them.** `install` is the fixture's row that declares both: its verb is read from the `device` lane rather than from `defaultLane`'s `web`, and `{artifact}` is the **second** of that lane's two declared artifacts rather than the first.

```text
$ nen shu dev --repo <repo> --target install --dry-run
lane:          device  (xcode-ios)
verb:          dev
target:        install  (appends no argument)  -- on lane 'device', which this target declares
device:        Placeholder Handset Pro  -- id not resolved (nothing was probed)
host:          darwin -- supported (declared: darwin, linux, win32)
preconditions: (none declared)
would run:     placeholder-device-tool list --json
would run:     placeholder-build-tool -destination generic/platform=placeholder-device build
would run:     placeholder-installer install --device {device.id} {artifact}
substitutes:   {device.id} <- the id of device 'Placeholder Handset Pro', read from the probe above; {artifact} <- build/device/Placeholder.signed  (project.launch.install.artifact, not the verb's own)
cwd:           <repo>
env:           (none added)
artifacts:     build/device/Placeholder.app (absent), build/device/Placeholder.signed (absent)
stdout to:     (none declared)
log:           dry run -- nothing was executed, so there is no output to capture and no tool exit code to report.
```

Four things on that page are the point, and each is a rule rather than a rendering choice:

- the `lane:` line is the **target's** lane, and the `target:` line says so — `lane:` alone cannot tell a reader whether the cross-lane launch was their own `--lane` or the declaration's decision, and that is the one thing they would misread;
- the middle `would run:` is the `device` lane's argv. Without the override it would be `web`'s, and the installer would put a simulator build on a handset at exit 0;
- **both tokens stay unfilled in the printed step**, `{artifact}` included, even though nothing needs to be spawned to know it. The printed argv is what a real run composes, and the `substitutes:` line is where a value nen has *read* is stated — filling one token and not the other would make the same line mean two things;
- `artifacts:` still lists what the **verb** declares, both entries, in declaration order. It answers what this build produces; `substitutes:` answers what this target installs. Collapsing the two would hide the override rather than show it.

`--dry-run --json` carries the same facts as fields: `target.lane` and `target.artifact` (both `null` on a target that declares neither), `target.after` verbatim with its tokens intact, and `artifacts[]` unchanged.

**The readiness rule, beside the probe that has not run yet.** The fixture's `paired` row declares one: its device is named by a serial, because that is the shape of the listing whose *second* column is the state.

```text
$ nen shu dev --repo <repo> --target paired --dry-run
lane:          web  (nextjs)
verb:          dev
target:        paired  (appends no argument)
device:        PH0000000001  -- id not resolved (nothing was probed)
readiness:     field 2 of the device's own row (counting from 1) must be one of: ready  (project.launch.paired.device.readyWhen)
host:          darwin -- supported (declared: darwin, linux, win32)
preconditions:
  ok    path deps
  ok    env  PLACEHOLDER_LANE_TOKEN
would run:     placeholder-device-tool list --long
would run:     pnpm exec next dev
would run:     placeholder-installer install --device {device.id}
substitutes:   {device.id} <- the id of device 'PH0000000001', read from the probe above
cwd:           <repo>
env:           (none added)
artifacts:     (none declared)
stdout to:     (none declared)
log:           dry run -- nothing was executed, so there is no output to capture and no tool exit code to report.
```

The `readiness:` line is printed **only where a rule is declared**, and it is the *declaration's* rule rather than a reading — knowable with no device connected at all, which is exactly why it is worth printing beside a probe that has not run. A real launch whose row says something else is exit **5**:

```text
$ nen shu dev --repo <repo> --target box
nen shu dev: the device 'PH0000000001' is on the probe's list and its state is 'unpaired', which is not one
project.launch.box.device.readyWhen accepts. Accepted: 'ready' -- read from field 2 of the device's own row
(counting from 1), which is how nen reads a probe that prints LINES. A device that is PRESENT is not a device
that is READY: every step this launch would run next addresses it by id, and nen will not report the probe green
and let each of them fail one at a time. The probe printed: PH0000000001   unpaired | PH0000000009   ready
usb:1-1. Get the device into one of the accepted states -- unlock it, answer its pairing prompt, wait for it to
finish starting -- or, if this state IS usable here, add it to readyWhen.in.
```

(wrapped here for the page; nen prints it as one line.)

**A lane that is not at the repository root, and what `{artifact}` then becomes.** The fixture's `nested` row runs on the `embedded` lane, whose `cwd` is `native`:

```text
$ nen shu dev --repo <repo> --target nested --dry-run
lane:          embedded  (xcode-ios)
verb:          dev
target:        nested  (appends no argument)  -- on lane 'embedded', which this target declares
device:        Placeholder Bench 2 (simulator)  -- id not resolved (nothing was probed)
host:          darwin -- supported (declared: darwin, linux, win32)
preconditions: (none declared)
would run:     placeholder-build-tool -destination generic/platform=placeholder-embedded build
would run:     placeholder-installer install {artifact} --on {device.id}
substitutes:   {device.id} <- 'Placeholder Bench 2' itself -- a simulated device is addressed by its name, so nothing is probed; {artifact} <- ../build/embedded/Placeholder.app  (declared build/embedded/Placeholder.app, as the after-steps' own directory sees it -- lane 'embedded' does not sit at the repository root)
cwd:           <repo>/native
env:           (none added)
artifacts:     build/embedded/Placeholder.app (absent)
stdout to:     (none declared)
log:           dry run -- nothing was executed, so there is no output to capture and no tool exit code to report.
```

`artifacts:` and `substitutes:` name the same file from the two roots that exist here — the repository's, which is where the declaration writes every path, and the after-step's own `cwd`, which is where the installer will actually look. Every launch target on a lane whose `cwd` is `.` prints and passes exactly what it always did.

### `nen shu run`

Start the lane's **production or staging** build, locally. The distinguishing property against `dev` is the build configuration, not the lifetime — `run` is long-running too, goes through the same interactive seam, refuses `--json` without `--dry-run` for the same reason, and takes the same optional `--target`. A launch target declares which of the two verbs it belongs to; naming a `dev` target on `run` (or the reverse) is exit 2, because the two are different builds and nen carries a target across in neither direction. That check runs **before the lane's own row is read**, so it is the answer even on a lane where the other verb is `unsupported` or undeclared — see [which refusal answers first](#nen-shu-dev).


**Output and exit codes** — the report, as text or `--json`; `0`/`1`/`2`/`3`/`4`/`5` as the family's table above. `--json` is the family's [shared run report](#shu-run-report), with `contract: "nen.shu.run/v0.1"`.
### `nen shu deploy`

Send a build to a declared, **named** target. It is the one verb in this family
whose blast radius is other people's users, which is why every rule below is
stated as a refusal.

**Usage**

```text
nen shu deploy --target <name> [--run] [--repo <path>] [--lane <name>] [--dry-run] [--json]
```

Bare, this is a safe, exit-0 plan -- the target resolved, every precondition
asserted, nothing sent -- and `--run` is what acts.

**Two flags, and no single-flag path to acting.** `--target` says *where* and
`--run` says *now*, and neither implies the other:

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <name>` | yes | Which declared destination. | **No default, ever** — not even when `project.targets` has exactly one key — and it must name a key of that map; anything else is exit 2 listing what is declared. Nen never picks where a build goes. |
| `--run` | yes, to act | Send it. | Without it the verb prints the **fully resolved plan** — the destination substituted into the argv, every precondition asserted, each step as `would run:` — and spawns **nothing**, at exit 0, with one line on stderr saying nothing was sent. |
| `--dry-run` | no | The explicit spelling of that same report. | Identical output. `--run --dry-run` together is **exit 2**: one says send it and the other says send nothing, and nen will not pick between two contradicting instructions on this verb. |

`--run` is the same dry-run-first gate [`label apply`](#nen-label-apply) and
[`wake fire`](#nen-wake-fire) carry, and it is here for the reason the other
nine executing verbs do not have it: each of those spawns something inside a
directory you are standing in and can be undone by running it again, and a
deploy cannot. So `shu deploy` is the one row of this family that izanami
classifies **`write-flag-gated`** rather than `dry-run-gated`: without `--run`
it is **read-only**, because nen spawns nothing whatever the declaration says —
a property of nen rather than a claim about somebody else's argv — and a quoted
or escaped `--run` the scan cannot prove absent is refused rather than
certified.

Nen never handles a credential either: a target names environment
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
  "on-push":   { "unsupported": "the push to main IS the deploy, through the host's own integration. There is no command line for nen to run." }
}
```

`nen shu deploy --lane site --target production` then prints

```text
target:        production  (appends: --env production)  requires env: YOUR_DEPLOY_TOKEN
would run:     your-deploy-tool publish --dir public --env production
```

and spawns nothing; adding `--run` spawns exactly that line and nothing else.
The three target shapes above are the three the inventory behind
[zheref/nen#91](https://github.com/zheref/nen/issues/91) found in the field: a
destination that differs by a flag, a destination the command already names, and
a destination that **has no command line at all**.

**Targets are project-level; deploy rows are per-lane.** Nothing checks that a
target is *meaningful* for the lane it is used on, and that is a decision rather
than an oversight: a destination is a fact about where this repository ships,
and a repository with one deployable lane — the common shape — would have to
repeat itself under every lane to say so. The cost is real and worth stating: on
a repository with two deployable lanes, `--target production` is accepted on
either, so a flag written for one lane's command can be appended to the other's.
Three things keep that visible rather than silent — the default form of this
verb prints the whole composed argv before anything runs, the report's
`target.args` says which half of the line came from the destination, and `--run`
is a second, explicit instruction. A per-target lane allowlist
(`targets.<name>.lanes`) is the follow-up if the shape turns out to be common.

**The order the refusals come in, and why.** `--target` used to be a usage gate
checked *before* the declaration was read. That made a written `deploy` **seat**
unreachable: a lane whose declaration says, in its own words, that it has no
deploy answered *"no targets declared"* — sending a maintainer to write a
`targets` block that could not have helped. The destination is now resolved
after the lane, the verb, the host and the placeholders, and before the
preconditions:

| Order | Condition | Exit |
|---|---|---|
| 1 | a flag another `shu` verb owns, on this one (or `--target`/`--run` on a verb that is not this one) | 2 |
| 2 | a flag pair nen cannot honour: `--run` with `--dry-run` here; `--json` on a long-running verb without `--dry-run` (not this verb) | 2 |
| 3 | no declaration, or no `project` block | 2 (malformed: 1) |
| 4 | `--lane` names no declared lane | 2 |
| 5 | the lane declares no `deploy`, or declares it `{ "unsupported": "<why>" }` | **4**, quoting that sentence |
| 6 | `project.hosts` does not allow this platform | 3 |
| 7 | the lane's own argv still carries a reference-pack placeholder | 2 |
| 8 | `--target` absent | 2, naming every declared target in byte order — or, with none declared, the exact `targets` block to paste |
| 9 | `--target` names no declared target | 2, listing the declared ones |
| 10 | the target declares `unsupported` | **4**, quoting that sentence |
| 11 | the target has `args` and the lane's `deploy` has more than one step | 2 |
| 12 | the target's `args` carry a reference-pack placeholder | 2, naming `project.targets.<name>.args` |
| 13 | the lane's `cwd`, an `artifacts` path or a precondition path resolves outside the repository | 2, naming the path |
| 14 | a precondition — the lane's, **or** a variable the target's `requiresEnv` names — is not satisfied | 2, **with the report** |
| 15 | otherwise: without `--run` the resolved plan is printed and nothing spawns; with it, the declared command runs | 0 / 1 / 5 |

Rows 5 and 10 are **terminal**: they are true however the line is retyped, and a
refusal that sends someone to do work that cannot help is worse than one that
costs them a retype. Rows 5 and 6 also beat rows 8–12 for that reason — a
mistyped `--target` on a seated lane is answered with the seat, and on a
host the declaration excludes with the host. Everything from row 8 down is a
fact about the command line or about this machine's environment, which the
caller fixes and runs again. The one thing this order costs is that a mistyped
`--target` is invisible on a lane that will never deploy at all, which is the
right trade.

**`--json`** carries the destination in the report's `target` key —
`{ name, args, requiresEnv }`, and `null` on every verb that takes no target —
so a deploy that ran can be audited for *where* it went. `requiresEnv` is
byte-ordered and de-duplicated. No value of any variable appears in it, in the
text rendering, in a refusal, or in a log line.

**Which refusals print a document, and which print none.** A refusal about the
declaration or the command line — rows 1 through 13 — prints **no document at
all** on stdout, as everywhere else in this CLI: exit 2, 3 or 4 is a line on
stderr and an empty stdout, so a `--json` reader never has to tell a report from
an error object. Row 14 is the exception, and deliberately so: an unsatisfied
precondition prints the report **with the failing rows in it**, because a caller
debugging *why this will not run* needs the table more there than anywhere.
"Was anything executed" is still told the way it is told everywhere in this
report — `steps[].exitCode` is `null` — so the gated form, `--dry-run` and a
precondition refusal are all distinguishable from a run by the same field, and
there is no `dryRun` boolean here either.

**What `nen shu detect` proposes.** `"targets": {}`, always, on every stack —
the one field in a proposal whose emptiness is a fact about *nen* rather than
about the tree, because a deploy destination is not a fact any checkout carries.
The lane's notes carry the reference pack's own word on `deploy` for that stack,
the shape to write, and the rule that a credential value never goes into a file
that is committed.

**Output and exit codes** — the report, as text or `--json`; `0`/`1`/`2`/`3`/`4`/`5` as the family's table above. `--json` is the family's [shared run report](#shu-run-report), with `contract: "nen.shu.deploy/v0.1"`.
### `nen shu coverage`

Run the lane's coverage command — through the same executor as every other verb,
with the same refusals and the same `--dry-run` — and then **parse the report
that run produced** into one shape: a total, a row per target, and (with
`--threshold`) whether the number cleared a bar. Same `dry-run-gated`
classification as `test`: a coverage run writes its report tree by definition.

**Usage**

```text
nen shu coverage [--repo <path>] [--lane <name>] [--threshold <0-100>] [--touched --base <ref>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--lane <name>` | no | Which lane to measure. | Defaults to `project.defaultLane`, as everywhere else in this family. |
| `--threshold <n>` | no | A percentage, 0–100, compared against the report's **line** coverage. | **Reports `met` and never gates** — see below. A value nen cannot read is exit 2, before anything is spawned. Under `--touched`, also reported **per row**, and giving it OVERRIDES the workflow-file ladder below for that run. |
| `--touched` | no | Narrow `targets` to the rows a change touched. | Requires `--base`; given without it, **exit 2**. Reads **every** declared report nen can parse, each resolved against its own root; **0 matched against a non-empty touched set is exit 6**. With `--threshold` absent, also loads `nen/workflow.json`'s coverage ladder (defaulting to 80/85/90 when that file is absent) and bands each row; a malformed policy is exit 1 before anything is spawned. See below. |
| `--base <ref>` | only with `--touched` | The ref `--touched` diffs `HEAD` against. | Given without `--touched`, **exit 2** — it has nothing to do on its own. No default: nen never invents a base. |
| `--dry-run` | no | Print every step, run nothing — and **parse nothing**. | The report may well be on disk from a previous run; a dry run does not read it, because reporting yesterday's numbers for a command that did not execute is the most believable wrong answer this verb can give. `--touched` still computes the touched-file set under `--dry-run`: that read is `git diff`, not the declared tool, and previewing which files would be checked costs nothing. |

**Where the report comes from — the verb's own `artifacts`.** nen parses the
first path under `project.verbs.<lane>.coverage.artifacts` whose **format** it
recognises, and it never searches a tree for one. Under `--touched` it parses
**every** such path instead — see [each report against its own
root](#coverage-touched-roots) below:

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
| `cobertura` | Cobertura XML (coverlet and others); rows are packages — under `--touched`, **files**, from each `<class filename>` ([below](#coverage-touched-cobertura)) | `coverage.cobertura.xml` |
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
clamped to 100%. A Cobertura line stating more conditions covered than it has
(`condition-coverage="250% (5/2)"`) is refused the same way, naming the file and
the line. That holds on a plain run and under `--touched` alike, and whatever
sits beside it: `(5/2)` next to `(0/4)` would otherwise add up to a plausible
5 of 6.

**`--threshold` reports and never gates.** `met` is `true`, `false`, or `null`
when there was no number to compare. The exit code is the **run's**, in both
directions: coverage under the bar still exits 0 when the tool exited 0. nen does
not decide whether a number is good enough — the policy that prompted this flag
scopes its bar to *the files a pull request touched*, which is exactly what
`--touched` below answers. Read `met` and decide.

The comparison is on the **counts**, not on the rounded percentage the table
prints: 19 999 of 25 000 lines displays as `80.00%` and is **not** met at
`--threshold 80`, because it is 79.996%. A value must be written in decimal
digits (`80`, `82.5`); `0x50`, `8e1` and a trailing `%` are exit 2 rather than a
number nen guessed at.

**Output and exit codes** — `0`/`1`/`2`/`3`/`4`/`5` as the family's table above,
plus: **exit 1** when the run succeeded and the report is missing, unreadable, in
no format nen reads, or not declared at all — under `--touched`, when **any**
declared report is, each one named — and **exit 6**, under `--touched` only, when
the run succeeded, its reports parsed, the diff named at least one file, and
**not one** of them joined to a report row (below). A run that did **not** succeed is
not parsed at all — the file on disk may be a previous run's, and nen cannot tell
by looking. On **exit 5** (the tool could not be started) the executor's report
is still printed, and under `--json` stdout still carries exactly one document,
with `exitCode: 5` — the same thing [`shu build`](#nen-shu-build) prints on that
path.

**The per-target table is not capped.** An Istanbul or LCOV report has one row
per *file*, so a large repository prints a long table; `--json` carries the same
rows. Pipe it (`| head`), or read `total` alone, until a `--top <n>` exists.

**`--touched --base <ref>` narrows `targets` to the rows a change touched.**
After the run and the parse above, nen computes `git diff --name-only
<base>...HEAD` **in the repository root** and filters the per-target table down
to the rows that diff names — the same *files a pull request touched* scope
`--threshold`'s own policy already talks about, made real. `--touched` requires
`--base`; either flag given without the other is **exit 2**, before anything
runs.

The match depends on what a row **is**:

- **File-grain formats** (`istanbul-summary`, `lcov`) match a touched path by
  plain equality against the row's own (already repo-relative) name.
- **Package-grain formats** (`jacoco`, and a `cobertura` report whose classes
  name **no** file) name a row after a
  *package*, not a file, so a touched file matches when its own path contains
  that package's segments, in order, with the file itself left over —
  "this touched file sits **under** that package". The text rendering says so
  (`-- rows matched BY PACKAGE, not by file`) when every report read is
  package-grain, and omits the note when reports of both grains were read —
  each report's own `from:` line says which it is (`rows are packages` for a
  package-grain one); `--json` carries no grain key — a package-grain report
  is the one whose `touched.artifacts[]` entry has `root: null` and
  `error: null`.
- <a id="coverage-touched-cobertura"></a>**`cobertura`** is read at **file**
  grain whenever its classes name files — every coverlet report does
  ([#296](https://github.com/zheref/nen/issues/296)). Its own rows are
  packages, and a plain run keeps printing them, but a package's number is
  neither any touched file's coverage nor their average, so under `--touched`
  nen reads each `<class filename>` instead (`\` read as `/`, spaces kept) and
  resolves it **per file**:
  - **The report's own `<sources><source>` roots come first, and nen looks in
    every one of them.** If exactly one holds the file inside the repository,
    that is the file. If two **different** stated roots each hold a file of
    that name, the name is **ambiguous**, and nen never guesses. coverage.py
    writes one `<source>` per measured package, so `pkgA/utils.py` and
    `pkgB/utils.py` are both `filename="utils.py"`, and taking the first root
    would report one file's lines as the other's.
  - **A stated root outside the repository still counts.** nen looks in it if
    it exists on this machine (coverage.py states a package installed into
    site-packages this way). A file found there beside one in the repository
    makes the name ambiguous. A file found only there is outside the
    repository, so no touched file is credited with its lines.
  - **Some stated roots can't be checked:** an absolute root that is not a
    directory on this machine, like a CI runner's path in a report read
    locally. In a report stating **two or more** roots, a name its report wrote
    as **two or more** `<class>` entries is **unverifiable**. Those entries may
    be two files whose lines were already unioned, so it is never matched.
    A single-entry name still resolves, and so does every name in a report
    stating a single root. A coverlet report written on CI with one foreign
    drive-root `<source>` therefore resolves as before.
  - **Only when no stated root holds the file** are the three candidates below
    tried, in order.
  - **Absolute paths are anchored under both spellings of the repository
    root:** the path you gave, and the one the filesystem resolves it to. A
    tool writes the resolved one (a symlinked checkout, macOS `/tmp` →
    `/private/tmp`). A Windows-shaped root (a drive letter or UNC share) is
    compared without regard to letter case.
  - **A file found under another letter case** (a case-insensitive
    filesystem) is reported with the **letter case it has on disk**, in
    Unicode **NFC** — the form git names it in on macOS, where a file may sit
    on disk decomposed (NFD). Two spellings of one file are one row.

  A file several `<class>` entries name — a partial class, a nested or
  compiler-generated one (`<>c__DisplayClass…`) — is **one** row. Its lines
  are the **union** of theirs: a line counts once, covered if any entry ran
  it. Each line keeps **one** condition figure — the entry stating the most
  conditions, then the most covered — never a sum. (A line stating more
  conditions covered than it has is refused outright: see *A report that is
  damaged* above.)

  A name that cannot be placed is **never matched**, and its touched file
  stays `unmatched`, never credited to its package or to a same-named file.
  That covers:
  - an ambiguous name;
  - an unverifiable name;
  - a file only outside the repository;
  - another machine's absolute path;
  - a generated file that is not on disk.

  coverlet's `UseSourceLink` writes every filename as a **URL**, which never
  resolves, so every file of that report is unmatched. The run exits 6 unless
  another declared report joins a touched file. Only a report in which no
  class names a file at all falls back to package matching.
- **`xccov-report`** is read at **file** grain here only: nen descends
  `targets[].files[]` instead of stopping at the target row, because "this
  whole app/framework was touched" is true of nearly every diff and would
  keep almost the entire table. The file path is relativised the same way
  every other format's row name is.

`--json` gains a ninth key, `touched: { base, files, matched, unmatched,
artifacts }` (`files` is everything git named; `matched` and `unmatched`
partition it — their lengths always sum to `files.length`; `artifacts` is
described just below), and each **row** gains its own
`met` when `--threshold` is also given — the aggregate `threshold.met` above
still answers for the whole report; a row's `met` answers for that row alone,
both compared on the **counts**, never the rounded percentage. **This still
never gates**: the exit code is the run's, exactly as bare `--threshold` is.

`--dry-run --touched` still computes and reports the touched set: that read is
`git diff`, not the declared tool, so a preview costs nothing — `targets` is
still empty, because nothing was parsed to filter, and `artifacts` is `[]`.

<a id="coverage-touched-roots"></a>
**Each report against its own root** ([#236](https://github.com/zheref/nen/issues/236)).
A workspace runs its coverage tool once per member, and each member's tool
writes paths relative to **that member** — `packages/core/coverage/lcov.info`
says `SF:src/utils/q.ts` — while git names the same file
`packages/core/src/utils/q.ts`. Under `--touched`, nen therefore:

- **reads every declared artifact whose format it reads**, not only the first,
  and merges their rows — a file touched in `apps/web` is matched from
  `apps/web`'s report. A row two reports both name is kept once, from the
  first-declared report. A report that cannot be read is **named** in
  `touched.artifacts[].error` and on stderr, and the run is **exit 1** — never
  its files silently reported `unmatched`;
- **resolves each report's relative row names against that report's root**,
  chosen once per report from three candidates, in order: **`artifact`** — the
  artifact's directory with one trailing `coverage/` removed
  (`packages/core/coverage/lcov.info` → `packages/core`), proposed only when
  that segment is there; **`lane-cwd`** — the lane's declared `cwd`; and
  **`repo-root`**. The candidate under which **more** of the report's paths
  exist on disk wins, and a tie — including a tree with none of them on it —
  goes to the earlier one. So a report that already writes repo-relative
  paths keeps them (the tree outvotes the `coverage/` guess), and a
  single-package repository, where all three candidates are one directory,
  is resolved exactly as it always was. Absolute row names are relativised
  as above and never rebased; a relative name that would climb out of the
  repository is left as written; package-grain rows (`jacoco`, and a
  `cobertura` report that names no file) are never rebased, because they are
  package names rather than paths. A `cobertura` report's file names are
  resolved **one at a time** instead, because the report states its roots and
  never says which name is under which (above).

`touched.artifacts` carries one `{ path, format, root, basis, rows, onDisk,
error }` per report, so the join is auditable without re-deriving it: `root`
is the repo-relative directory the report's paths were resolved against (`.`
for the repository root; `null` for package rows or an unread report),
`basis` is which candidate it was — `artifact`, `lane-cwd`, `repo-root`, or
`source` for a root the report itself stated — and `onDisk` how many of its
relative paths name a file there. For a `cobertura` report read by file,
`rows` is the number of distinct file names it states, `root`/`basis` the root
**most** of them resolved under, `onDisk` how many resolved anywhere — and
`rows − onDisk` are the unresolved names. Such an entry carries an eighth key,
`unresolved: [{ name, reason }]` (empty when every name resolved; absent on
every other report). Each `reason` says why its name could not be placed:
ambiguous (naming both paths), unverifiable (naming the root nen could not
check), present only outside the repository (naming where), a URL, an absolute
path outside the repository, or not found (naming where nen looked). A report
whose measurement was refused keeps the key too. The text rendering prints the same as one `from:`
line per report (`, 1 unresolved (never matched)`), followed by up to three
`unresolved: <name> -- <reason>` lines. `total`, `report` and the aggregate `threshold.met` stay the
**first** report's — exactly what a run without `--touched` reports — so
`--threshold`'s meaning does not move.

**Zero matched is exit 6, never 0.** When the reports parsed, the diff named
at least one file and **not one** of them joined to a row, nothing was
measured, and `0 of 58 matched` at exit 0 reads as "measured, and fine" to
every caller checking `$?`. nen exits **6** — distinct from 1 (the tool failed,
or a report could not be read) — and stderr names the path shape the rows
carried beside the repo-relative shape git uses, plus the root each report
was resolved against. An **empty** touched set is still exit 0: nothing was
touched, so there was nothing to join. A change that touches only files no
test measures (a README) *is* exit 6, deliberately: nen cannot tell "nothing
to measure" from "could not join" by looking, and it reports neither as a
pass. A dry run and a run whose tool failed are never 6.

**The ladder — `nen/workflow.json`'s `coverage.{minimum,recommended,ideal}`,
when `--threshold` is not given.** The design's own shape for that file states
`"coverage": { "minimum": 80, "recommended": 85, "ideal": 90, "scope":
"touched" }` — a policy about the files a change touched, the same scope
`--touched` already reads. So under `--touched`, with no explicit `--threshold`
to override it, nen reads that block and reports each row's **band** instead of
`met`: `under-minimum` / `minimum` / `recommended` / `ideal`, on the same
inclusive-at-the-boundary, counts-not-percentage comparison `--threshold`'s own
`met` uses. `--json` gains a tenth key, `ladder: { minimum, recommended, ideal,
source, present }`, or `null`.

**The file is read by the one loader, and an absent file is a ladder.** These
are the same `src/schema/workflow.ts` numbers `nen schema check` validates and
`nen commit format` reads its trailer policy from — there is no second reader of
`nen/workflow.json` in this binary. Every key in that file is optional and every
default is published, so a repository that has never written one is banded
against **80 / 85 / 90** rather than not banded at all: `ladder.present` is
`false` there, and the text line reads `nen/workflow.json is absent — these are
nen's defaults`, so a rung a repository *chose* is never mistaken for one nen
*assumed*. A partial `coverage` block takes the published default for each rung
it omits. `source` is the repo-relative `nen/workflow.json`, never the absolute
path the loader hands back — this document gets pasted into issues, and the row
names are already relativised for exactly that reason.

**A malformed policy is exit 1, before the coverage tool is spawned.** The
ladder is loaded alongside `--threshold`'s number and `--touched`'s flag
pairing, at the top of the run rather than in the middle of the report: a file
that is present and unreadable, or that states a `coverage` block nen cannot
read (a string where a number belongs, a ladder that does not ascend, a key one
letter away from one nen reads), is a refusal naming the pointer — and a refusal
a caller has to sit through a whole coverage build to hear is one delivered at
the worst possible moment.

`ladder: null` is a fact about the **invocation**, never about the repository.
An explicit `--threshold` wins where both exist — it is the caller overriding
the file's policy for this one run, not a second number to reconcile against it
— and a plain (non-`--touched`) run never reads the file at all: **this too
still never gates.**

**`--json`** is a different contract from the other executing verbs
(`nen.shu.coverage/v0.1`), keys in order: `{ contract, lane, stack, total,
targets, threshold, report, exitCode, touched, ladder }`; `touched` is `{ base,
files, matched, unmatched, artifacts }`, the last key appended. `percent` is computed
from the counts (two decimals) rather than read out of the file — three of the five
formats carry a percentage of their own, rounded three different ways, one of
them as a fraction — and it is `null` for a report about no code, because 0 of 0
is neither 100% nor 0%. **A dry run is told by `exitCode: 0` with `total:
null`**; nothing else produces that pair. The executor's own report goes to
stderr in this mode.

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

**Example — `--touched`**

```bash
nen shu coverage --touched --base <base> --threshold 80
```
```text
lane:          web  (nextjs)
verb:          coverage
host:          darwin -- supported (declared: darwin, linux, win32)
preconditions: (none declared)
ran:           pnpm --filter @placeholder/core test:coverage  -- exit 0 in 208ms
cwd:           /…/shu-coverage-repo
env:           (none added)
artifacts:     coverage/coverage-summary.json
log:           not captured to a file -- each step's own stdout and stderr were relayed as it finished. A .nen/logs/ transcript is not in this release (zheref/nen#91).
report:        coverage/coverage-summary.json  (istanbul-summary)
total:         lines 82.35% (14/17)   branches 75.00% (3/4)
targets:
  lines           branches      met  target
  84.62% (11/13)  75.00% (3/4)  met  packages/core/src/index.ts
threshold:     80% -- met. This is REPORTED and never enforced: nen exits 0 here, and the threshold moved that by nothing.
touched:       base <base>: 2 files (1 matched, 1 unmatched)
  unmatched: README.md
```
(run against a copy of this repository's own coverage fixture, in a REAL git
history: `<base>` is the commit before one that edited
`packages/core/src/index.ts` and added `README.md`. `packages/app/src/main.ts`
is untouched by that commit, so its row is gone from the table entirely — not
merely marked unmet. `--json` for the same run:)

```json
{
  "targets": [
    { "name": "packages/core/src/index.ts", "lines": { "covered": 11, "total": 13, "percent": 84.62 },
      "branches": { "covered": 3, "total": 4, "percent": 75 }, "met": true }
  ],
  "threshold": { "value": 80, "met": true },
  "touched": {
    "base": "<base>",
    "files": ["README.md", "packages/core/src/index.ts"],
    "matched": ["packages/core/src/index.ts"],
    "unmatched": ["README.md"]
  }
}
```

(recorded before `touched.artifacts` and the `from:` lines existed; a run today
adds both, as the workspace example below shows.)

**Example — `--touched` in a two-package workspace**

```bash
nen shu coverage --touched --base <base>
```
```text
report:        packages/a/coverage/lcov.info  (lcov)
total:         lines 75.00% (3/4)
targets:
  lines          band           target
  75.00% (3/4)   under-minimum  packages/a/src/sum.ts
  100.00% (5/5)  ideal          apps/web/src/page.tsx
ladder:        nen/workflow.json is absent -- these are nen's defaults -- minimum 80% / recommended 85% / ideal 90%. REPORTED per row as 'band', and never enforced: nen exits 0 here, whatever the bands say.
touched:       base <base>: 3 files (2 matched, 1 unmatched)
  from: packages/a/coverage/lcov.info (lcov) -- 1 row, root packages/a [artifact], 1 on disk
  from: apps/web/coverage/lcov.info (lcov) -- 1 row, root apps/web [artifact], 1 on disk
  unmatched: .env.example
```
(the executor's block above `report:` omitted. Rendered from
`src/schema/fixtures/shu-coverage-workspace/` — whose two tracefiles say
`SF:src/sum.ts` and `SF:src/page.tsx` — with the diff scripted to name
`.env.example`, `apps/web/src/page.tsx` and `packages/a/src/sum.ts`. The same
run with the diff naming only `.env.example` exits **6** and prints on stderr:)

```text
--touched joined 0 of 1 touched file to the 2 rows nen read, so NOTHING was measured -- exit 6, not 0. Path shape SEEN in the report rows: 'packages/a/src/sum.ts', 'apps/web/src/page.tsx'. Path shape EXPECTED, as git names the touched files (repo-relative): '.env.example'. Roots used: packages/a/coverage/lcov.info -> root packages/a; apps/web/coverage/lcov.info -> root apps/web. If the two shapes should meet, […]
```
(elided to the keys this example is about; the full document still carries all
ten, `ladder: null` among them since `--threshold` was given)

**Example — the ladder, no `--threshold`**

```bash
nen shu coverage --touched --base <base>
```
```text
lane:          web  (nextjs)
verb:          coverage
host:          darwin -- supported (declared: darwin, linux, win32)
preconditions: (none declared)
ran:           pnpm --filter @placeholder/core test:coverage  -- exit 0 in 1181ms
cwd:           /…/shu-coverage-repo
env:           (none added)
artifacts:     coverage/coverage-summary.json
log:           not captured to a file -- each step's own stdout and stderr were relayed as it finished. A .nen/logs/ transcript is not in this release (zheref/nen#91).
report:        coverage/coverage-summary.json  (istanbul-summary)
total:         lines 82.35% (14/17)   branches 75.00% (3/4)
targets:
  lines           branches      band           target
  75.00% (3/4)    --            under-minimum  packages/app/src/main.ts
  84.62% (11/13)  75.00% (3/4)  minimum        packages/core/src/index.ts
ladder:        nen/workflow.json -- minimum 80% / recommended 85% / ideal 90%. REPORTED per row as 'band', and never enforced: nen exits 0 here, whatever the bands say.
touched:       base <base>: 2 files (2 matched, 0 unmatched)
```
(run against a copy of this repository's own coverage fixture, with a real
`nen/workflow.json` declaring `{"coverage":{"minimum":80,"recommended":85,
"ideal":90,"scope":"touched"}}`, and `<base>` the commit before one that
touched both files. No `--threshold` was given, so `threshold` is absent from
the text and `null` in `--json`, and `ladder` carries the three numbers
instead — with `present: true`, because the file was really there. Delete that
file and the same run prints `nen/workflow.json is absent — these are nen's
defaults` and the identical three rungs, because 80/85/90 is what the loader
answers with)

### `nen shu test-report`

Run the lane's **`test`** command — through the same executor as every other
verb, with the same refusals and the same `--dry-run` — and then **parse the
results file that run produced** into one shape: a row per test, and the four
counts. Same `dry-run-gated` classification as [`test`](#nen-shu-test), with one
extra certified form: `--from-artifacts`, which reads and starts nothing.

**There is no `test-report` row to declare.** This verb runs
`project.verbs.<lane>.test` and reads *that* row's `artifacts`. A repository
which has already said how its tests run has said everything nen needs, and a
second, nearly identical invocation to keep in step is how a declaration ends up
with the two halves disagreeing.

**Usage**

```text
nen shu test-report [--repo <path>] [--lane <name>] [--from-artifacts] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--lane <name>` | no | Which lane's tests to report on. | Defaults to `project.defaultLane`, as everywhere else in this family. |
| `--from-artifacts` | no | **Run nothing**: read the results file the lane's `test` declares and parse whatever is on disk. | The one read-only form beside `--dry-run`, and the one izanami certifies read-only for a different reason — it never reaches the executor at all. nen cannot tell how old the file is, and says so on the second line of its output. |
| `--dry-run` | no | Print every step, run nothing — and **parse nothing**. | The results file may well be on disk from a previous run; a dry run does not read it. Giving this together with `--from-artifacts` is **exit 2**: both start nothing, and they answer different questions. |

**Where the report comes from — the `test` verb's own `artifacts`.** nen parses
the first path under `project.verbs.<lane>.test.artifacts` it recognises, and it
never searches a tree for one:

```json
"test": {
  "exe": "pnpm", "argv": ["--filter", "@kro/core", "test", "--reporter=json",
                          "--outputFile=reports/test-results.json"],
  "artifacts": ["reports/test-results.json"]
}
```

**A directory is a legitimate artifact**, and for one very common shape it is the
*only* honest one: a runner that writes one XML file per suite is declared by
naming the directory it writes them into, and nen reads every `*.xml` under it —
recursively, in sorted order — and merges them into one report.

```json
"test": {
  "exe": "./gradlew", "argv": [":app:testDebugUnitTest"],
  "artifacts": ["app/build/test-results/testDebugUnitTest"]
}
```

`artifacts` are **literal paths**: nen expands no globs — there is no shell in
this program — so the doubled-star pattern a runner's own documentation prints is
refused with that sentence and the directory form named as the answer. The path
is resolved against the **repository root**, not the lane's `cwd`, like every
other path in a declaration; one that escapes the repository is exit 2 naming it.

**Which artifact, in two passes.** A `test` verb routinely names several outputs.
nen takes the first whose **name** states a format it reads (`*.xml`, `*.json`);
only if none does does it take the first whose last segment carries **no
extension at all** — the shape of a directory. That order is what keeps the
weaker rule from shadowing the stronger one: a lane declaring
`["build/libs/app", "build/test-results/test"]` gets the directory, and one
declaring `["build/libs/app", "reports/results.xml"]` gets the XML rather than a
refusal about a binary. Both passes are by **name**, because `--dry-run` has to
say which path a real run would parse and has nothing on disk to look at; what a
path actually **is** is then settled by the filesystem, and what a file
**contains** by its bytes.

A lane that declares none — or declares only artifacts nen does not recognise —
is **exit 1** naming the field to add and listing the formats.

**Formats.** Chosen by file name first and confirmed against the bytes, so a
report under an unfamiliar name is still read and a name that lies is still
caught:

| `report.format` | what it is | conventionally |
|---|---|---|
| `junit` | JUnit XML — the shape almost every runner on earth can be asked to write. `<failure>` and `<error>` are both failures; `<skipped>` is a skip; `time` is **seconds** | `*.xml`, one file **or a directory of them** |
| `assertion-results` | the `testResults[].assertionResults[]` JSON a JavaScript runner writes with its JSON reporter. The test **file** is the suite; `duration` is **milliseconds** | any `*.json` the reporter is pointed at (commonly `test-results.json`) |
| `xcresult-summary` | the JSON test summary a **declared** result-bundle extraction step writes. It states its totals and lists only its failures | any `*.json` that step's output is redirected into |

**nen never opens a result bundle itself.** A bundle is a directory in a
proprietary layout and the only supported way to read one is the vendor's own
extraction tool — so the *declaration* runs that as a second step of its own
`test` row and names the JSON it writes. nen reads the file the repository said
it would produce, and spawns nothing it was not told about:

```json
"test": { "steps": [
  { "exe": "xcodebuild", "argv": ["test", "-resultBundlePath", "reports/App.xcresult", "…"] },
  { "exe": "xcrun", "argv": ["xcresulttool", "get", "test-results", "summary",
                             "--path", "reports/App.xcresult", "--format", "json",
                             "--output-path", "reports/test-summary.json"] }
], "artifacts": ["reports/test-summary.json"] }
```

**Three statuses, out of the eight words the formats spell between them.**
`passed`, `failed`, `skipped`. An `error` is a **failure** — a caller deciding
whether to ship cannot treat "it did not get as far as failing" as anything
else. `pending`, `todo` and `disabled` are **skips**. An `Expected Failure` is a
**pass**: the suite did what it said it would. A word nen has not met is exit 1
naming it and listing the ones it reads, rather than a guess — guessing wrong in
one direction makes a red suite look green.

**Suite names are made repo-relative**, exactly as
[`shu coverage`](#nen-shu-coverage)'s row names are and for the same reason: one
of these formats names a suite with the **absolute** path of the test file, so a
`--json` document or a pasted table would otherwise carry your account name and
directory layout out of the machine that ran it.

**A report that is damaged is a refusal, never a number.** A `<testcase>` with no
`name`; a status word nen does not read; a count that is a string; a summary
stating 4 passed + 2 failed + 1 skipped out of 5 tests — each is exit 1 naming
the file and the field, rather than a plausible total assembled around the
damage. Inside a **directory** artifact the same rule reaches one file deep: an
`*.xml` under it that carries no `<testsuite>` refuses the whole read by name,
because reading the half of a tree nen understood and printing a total for it is
exactly the failure this verb must not have. (A file that is not `*.xml` at all —
a runner's binary cache, a properties file, an HTML page — was never a candidate
and is simply not collected.)

**A run that FAILED is still parsed, and that is the point.** This is the one
place this verb disagrees with [`shu coverage`](#nen-shu-coverage), which refuses
to parse anything after a non-zero run. A failing suite is the *interesting*
report, and a verb that went silent exactly when the tests went red would be
useless in the case it exists for. The staleness risk that rule protects against
is answered rather than denied: **the exit code is always the run's**, so a
caller reading the code gets the run's verdict whatever the file said, and the
numbers are reported beside it and never instead of it.

**A run that started NOTHING parses nothing**, and that half is unchanged: a dry
run, an unmet precondition, a program that could not be spawned. There the file
on disk is certainly not this invocation's, and nen says `(nothing parsed)` with
the reason.

**The failures never move the exit code**, in either direction — the same line
`--threshold` draws on `shu coverage`. `failed: 3` does not make a green run red;
`failed: 0` does not make a red one green. Under `--from-artifacts`, where
nothing ran at all, the code is about the **read**: `0` for a report that parsed,
however red it was. Read `failed` and decide.

**Output and exit codes** — `0`/`1`/`2`/`3`/`4`/`5` as the family's table above,
plus: **exit 1** when the report is missing, unreadable, in no format nen reads,
or not declared at all. Because the verb runs `test`, its refusals are `test`'s:
a lane with no `test` row is **exit 4** in the declaration's own words, in every
form including `--from-artifacts`, because the artifact list is a property of
that invocation. On **exit 5** the executor's report is still printed, and under
`--json` stdout still carries exactly one document.

**The per-test table is not capped**, and it is ordered **failures first** —
skips, then passes. A red row eleven hundred lines down a passing suite is a row
nobody reads. The `--json` document keeps the **report's own** order instead,
because a machine reader comparing two runs wants the order the runner produced.

**`--json`** is a different contract from the other executing verbs
(`nen.shu.test-report/v0.1`), keys in order: `{ contract, lane, stack, report,
tests, passed, failed, skipped, total, exitCode }`, where each `tests[]` row is
`{ name, suite, status, durationMs }`. `suite` and `durationMs` are `null` where
the report states neither. The four counts are `null` exactly when nothing was
parsed, so **a dry run is told by `exitCode: 0` with `total: null`**.
`tests.length` is **not** another spelling of `total`: the summary format states
its totals and lists only its failures, and the text rendering says so on a
`rows:` line when the two differ. The executor's own report goes to stderr in
this mode.

**Example**

```bash
nen shu test-report --lane droid --from-artifacts
```
```text
lane:          droid  (gradle-android)
read:          --from-artifacts -- nothing was run. The report below is whatever is on disk, written by whichever run last wrote it; nen cannot tell how old it is.
report:        reports/results  (junit)
totals:        5 tests -- 3 passed, 1 failed, 1 skipped
tests:
  outcome  time     test
  FAILED   12.00ms  placeholder.CartTest > refusesANegativeQuantity
  skipped  --       placeholder.TotalsTest > appliesADiscount
  passed   12.00ms  placeholder.CartTest > addsOneItem
  passed   21.00ms  placeholder.CartTest > addsTwoItems
  passed   30.00ms  placeholder.TotalsTest > sumsAnEmptyCart
```
(run against this repository's own test-report fixture declaration, whose `droid`
lane declares a **directory** of one XML file per suite; the same lane without
`--from-artifacts` runs the declared command first and prints the executor's
report above these lines)

### `nen shu evidence`

Match `git diff --name-status <base>...HEAD` — through the seam, never a
lane's declared argv — against this repository's `project.evidence.globs`,
derive each survivor's **suite** and **scene**, and report them grouped
suite → scene. The one verb in this family that spawns no invocation the
target repository declared: only `git diff`, a command nen itself chose.

**Usage**

```text
nen shu evidence [--repo <path>] --base <ref> [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--base <ref>` | **yes** | The other end of `git diff --name-status <base>...HEAD`. | `HEAD` is always the checkout's own current commit, never a flag. Nen never invents a base to diff against. |

No `--lane` (`project.evidence` is project-level, like `targets`, not
per-lane) and no `--dry-run` (nothing here would need to be skipped — the
`git diff` runs unconditionally, exactly as [`nen wc classify`](#nen-wc-classify)'s
own `git status` read does). Both are refused as flags this subcommand does
not read, exactly as `--write` is refused on `build`.

**The glob matcher.** `*`, `**` and `?`, no dependency and no fourth wildcard:
`*` matches any run of characters within one path segment, `**` also crosses
`/` — including matching **zero** directories, so `**/*.png` matches a
root-level file and `a/**/b` matches `a/b` as well as `a/x/y/b` — and `?` is
exactly one character, never a `/`. `[...]` classes and brace expansion are
not implemented; a pattern using either is matched literally, character by
character.

**Suite and scene**, generalised from KroApple's own `ci_scripts/
pr_screenshots.sh` (`scene_of()`): walk a changed path's ancestor
directories, nearest first, and the first one whose name ends with
`suiteSuffix` (default `"SnapshotTests"`) names the **suite**, with the
suffix stripped. No such ancestor at all — Paparazzi's own flat
`.../snapshots/images/<name>.png` layout, which names no per-suite directory
— falls back to the immediate parent directory's own name, unstripped. The
**scene** is the file's basename with its extension removed, then a trailing
`.<n>` a test runner adds when two cases share a name (`disabled.1.png`,
`disabled.2.png`), then the `test_snapshot_` and `test_` prefixes XCTest and
swift-testing generate — applied in that order, unconditionally, exactly as
the bash `${b#test_snapshot_}` / `${b#test_}` pair is. A basename neither
prefix recognises is returned with only its extension and index removed.

**`status`** folds git's finer `--name-status` codes into the four this
family publishes: `A` → `added`, `M`/`T` → `modified`, `D` → `deleted`,
`R###` → `renamed` (reported at the **new** path — the survivor), `C###` →
`added` (a copy is a brand-new path whose content happens to match another;
`copied` is not one of the four).

**Output and exit codes** — `0` (matched some evidence, or matched none — an
empty `rows`/`suites` set is a **successful** answer, never an error) and `2`
(no `project.evidence` block, naming it — the one usage refusal this verb
has). Codes `1`, `3`, `4` and `5` do not apply: there is no declared
invocation to fail, no lane-scoped host restriction, no unsupported-verb
seat, and no program nen spawns that could fail to start other than `git`
itself, whose own failure (an unresolvable `--base`, a detached `HEAD`)
propagates as an ordinary tool failure rather than a silent "nothing
changed".

**`--json`** is a contract of its own (`nen.shu.evidence/v0.1`), keys in
order: `{ contract, base, mechanism, rows, suites }`. No `lane`, `stack`,
`steps`, `cwd`, `env` or `host` — none of those questions apply to a verb
that runs no declared invocation. Each `rows[]` entry is
`{ suite, scene, path, status }`; each `suites[]` entry is
`{ suite, scenes }`, `scenes` being the unique scene names under that suite
in first-seen order.

**Example**

```bash
nen shu evidence --base main
```
```text
evidence: 1 changed file across 1 suite (public-mirror), against main...HEAD

suite: DateTimeField
  added    disabled                 Kro/Tests/DateTimeFieldSnapshotTests/__Snapshots__/DateTimeFieldSnapshotTests/test_snapshot_disabled.1.png
```
(run against a KroApple-shaped fixture declaring
`{"globs": ["**/__Snapshots__/**/*.png"], "mechanism": "public-mirror"}`; a
branch that changed no `__Snapshots__/**/*.png` file prints `evidence: no
changed file under project.evidence.globs against main...HEAD` and still
exits `0`)


`--json`: a contract of its own — `{ contract: "nen.shu.evidence/v0.1", base, mechanism, rows[], suites[] }`, keys in that order. There is no `lane`, `stack`, `steps`, `cwd`, `env` or `host`: this verb runs no declared invocation, so none of those questions apply. Each `rows[]` entry is `{ suite, scene, path, status }`.
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
**zero-major rule**. The floor is **exactly two components**: `0.3.5` is exit 2
naming the pointer, not a floor silently widened to `0.3` — a comparison nen
quietly weakened is a comparison nobody made. A leading `v` is accepted and
normalised away. It is always `verify-only`: re-pinning nen is
[`nen bootstrap`](#family-bootstrap)'s job and the consuming repository's
decision, and the row prints the `pinned_ref` its bootstrap would install. A
`project.toolchain` entry of the same name wins, and the row is then not
synthesised.

<a id="behind-the-pinned-ref"></a>

**Behind the pinned ref** ([#327](https://github.com/zheref/nen/issues/327)).
The row is also compared against `dependency.pinned_ref`, as a second fact
beside the range rather than a narrowing of it: `minimum` still alone decides
whether the row is satisfied. A host version **inside** the minimum's range
and **lower** than the pinned ref reads `BEHIND` — state
`present-but-behind-pin`, `satisfied: true` — with the ref on the row's line
and a remedy naming the install
(`nen bootstrap --ref <pinned_ref> [--source <source>] --script <the bootstrap, fetched to a file>`):

```text
  BEHIND   nen  0.18.1  pinned >=0.18.0 <0.19.0  pinned_ref v0.18.2
```

A check whose rows are all satisfied and one of them `BEHIND` exits **7**. At
or above the pin the row is `ok` exactly as before; outside the minimum it is
`WRONG` and exit 5 exactly as before, whatever the pin says. The comparison is
full semver precedence with a leading `v` dropped, so `0.18.2-rc.1` is behind
`v0.18.2`. Only a ref shaped like a **release tag** is compared —
`[v]X.Y.Z`, optionally with a pre-release and build suffix. Anything else (a
branch, a SHA — including an all-digit abbreviated one like `1234567` — or a
bare `2026`) is not compared: `behindPinnedRef` is `null`, the table prints a line saying the
comparison was not made, and the row keeps its other verdict — it is never
rendered as "at the pin". `shu tools` still installs nothing for this row,
under `--install` included.

<a id="the-compatibility-floor"></a>

**The `0.x` rule, and the compatibility floor.** Above major zero the
breaking-change vehicle is the MAJOR, so `1.4` means `>=1.4.0 <2.0.0` and
nothing below applies. **At major zero the vehicle is the MINOR**, and until
v0.7.0 nen read that at its strictest: `0.6` meant `>=0.6.0 <0.7.0` *exactly*,
out of range in both directions, so **every** minor release — breaking or not —
owed a repin PR in every consuming repository. The maintainer's ruling of
2026-09-10 narrows it to *exact minor is fine, unless there is a breaking
change*, and the fact that makes the distinction decidable is one the binary
**ships**: `COMPATIBLE_MINOR_FLOOR` (`src/version.ts`), the lowest `minimum`
pin this build satisfies. A release whose CHANGELOG section declares breaking
consumer notes sets it to its own minor; a release that declares none leaves it
where it was, and thereby goes on accepting the pins already written.

A `minimum` of `0.A`, read by a build whose version is `0.V.p` and whose floor
is `0.F`, admits:

| `minimum` | this build | floor | admits | why |
|---|---|---|---|---|
| `0.7` | 0.7.0 | 0.7 | `>=0.7.0 <0.8.0` | the pin is at the floor; this build's own minor is the top |
| `0.7` | 0.8.0 | 0.7 | `>=0.7.0 <0.9.0` | v0.8.0 declared no breaking notes and kept the floor, so the pin still holds — **no repin** |
| `0.6` | 0.7.0 | 0.7 | `>=0.6.0 <0.7.0` | below the floor: v0.7.0's notes are breaking, so no 0.7.x satisfies it — exit **5**, repin to `0.7` |
| `0.9` | 0.8.0 | 0.7 | `>=0.9.0 <0.10.0` | a floor is never a ceiling: this build is simply older than the pin |
| `1.4` | any | any | `>=1.4.0 <2.0.0` | above major zero the floor is not consulted at all |

Two properties are worth stating outright. **A pin's own minor always satisfies
it** — the widening only ever adds versions. And **a version this build cannot
speak for keeps the old exact-minor rule**: a 0.8.0 binary asked about a 0.9.0
on the host has no way to know what 0.9.0 broke, so it refuses rather than
guessing "compatible", which is the fail-open read of the one range where
compatibility is least guaranteed. The rendered `pinned` range is the *exact*
range the verdict applies, and a test sweeps both over the same versions, so the
table can never print a range that disagrees with its own `ok`/`WRONG`.

**A pre-release is read differently at each end of the range**, each way round
being the fail-closed one for that end. The **floor** keeps semver precedence in
full, so `0.7.0-rc.1` does not satisfy `0.7` — a release candidate is not the
release. The **ceiling** compares the numbers only, so `0.9.0-rc.1` does *not*
sit under a `<0.9.0` ceiling: it is a binary on the 0.9 line, and the minor is
what the whole rule turns on. (Under plain precedence it did, and so did
`0.4.0-rc.1` against a `0.3` pin before this release — a standing hole, closed
here.) A pre-release *inside* the range is still inside it: `0.8.1-rc.1`
satisfies `0.7` on a 0.8.0 build.

The floor is printed on **every** run, beside the binary's own version
(`compat floor:  0.7  (the lowest dependency.minimum nen 0.8.0 satisfies)`),
and carried as `compatibleMinorFloor` in `--json` — including in a report whose
declaration has no `dependency` block, because *"do I owe a repin"* is a
question about nen and not about the declaration that asked. When a `minimum`
is below the floor the row's `remedy` says so in words and names the repin: no
version of that binary can satisfy it, whatever the host answers.

**The five row states**

| State | Meaning | Exit 5? |
|---|---|---|
| `present-and-matching` | Found, and it satisfies the declaration's pin. For a `path-exists` entry: the probe named a path and the path is there — presence is the whole check that member asks for. | no |
| `present-but-behind-pin` | **The `dependency` row only**: found inside `minimum`'s range — so `satisfied` is `true` — and lower than `dependency.pinned_ref`. Text mark `BEHIND`. | no — exit **7** when no row is missing or wrong |
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
forever on a machine that is simply not set up. Exit **7** when every row is
satisfied and the `nen` row is [behind `pinned_ref`](#behind-the-pinned-ref)
inside its minimum — a distinct code so a consumer's warm-up can route it to an
install of the pin; 5 wins when a row is also missing or wrong, and neither
`--install` nor `--dry-run` ever exits 7. Exit **2** for an `--only` that
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
`{ contract, lane, stack, mode, compatibleMinorFloor, summary, tools, exitCode }`
with `contract` = `nen.shu.tools/v0.1` and `mode` one of `check` / `install` /
`dry-run`. **It carries every value the table prints** — the human rendering is
derived *from* this object, not beside it, so the two cannot come apart.
`compatibleMinorFloor` is `MAJOR.MINOR`, the lowest `dependency.minimum` pin
this build satisfies ([the compatibility floor](#the-compatibility-floor)); it
is present on every report, including one whose declaration has no `dependency`
block.

`summary` is `{ checked, satisfied, missing, wrong, notProbed, installed,
refused, notInstallable, behind }`. The five state counts — `satisfied`,
`behind`, `missing`, `wrong`, `notProbed` — always sum to `checked`;
`satisfied` counts `present-and-matching` rows **only**, and `behind` counts
`present-but-behind-pin` rows, which are **not** in `satisfied`.
`refused` counts rows carrying a pin this release will not act on;
**`notInstallable` counts rows that do not pass and that nen has no installer
for** — the number that explains an `--install` run exiting 0 beside a host that
is still not ready, and the text prints it as a footer for the same reason.

Each `tools[]` row is `{ name, required, packMinimum, pinned, versionFrom,
probe, found, probeOutput, satisfied, state, installer, installCommand, remedy,
install, why, pinnedRef, behindPinnedRef }`, in that order:

| Field | Meaning |
|---|---|
| `pinned` | The declaration's pin, normalised — an exact version, `>=X.Y.Z`, or the two-sided range a `dependency.minimum` floor stands for. That range is the **exact** one the verdict on the same row applies, floor included, so a satisfied `0.8.0` never sits beside a `<0.8.0`. |
| `versionFrom` | The member that read the version. It is what makes a satisfied row with no `found` readable: `path-exists` means presence *was* the check. |
| `probe` | The declared probe argv, rendered exactly as `--dry-run` prints it. |
| `probeOutput` | The first line the probe printed, **only** on a row that says "present, version unknown" — the one case where the output is the finding. Null everywhere else, including on satisfied rows, where `found` is the answer. Capped at 200 characters. |
| `installCommand` | The rendered commands, non-null only for an installer nen runs *and* only when there is something to do. |
| `remedy` | The way out **in words**, for a row with no command: `verify-only: install by hand — …`, `corepack: REFUSED — …`, `sdkmanager: not enabled in this release — …`, `wrapper: nothing to install — …`. Exactly one of `installCommand` and `remedy` is non-null on a row that needs a way out; both are null on a row that passes. Without it a refused `corepack` row and a `verify-only` row were the same row to a machine reader, because `why` is the *declaration's* reason for the pin and is null on most refusing rows. |
| `pinnedRef` | `dependency.pinned_ref`, verbatim, on the `dependency` row; `null` on every `project.toolchain` row, which pins a version rather than a ref. |
| `behindPinnedRef` | The host version against `pinnedRef`: `true` behind it (the `BEHIND` row), `false` at or above it, `null` when **no comparison was made** — no ref on the row, nothing observed or no version read, or a `pinned_ref` that is not a release tag. `null` never means "not behind". |
| `install` | What `--install` ran for this row — `{ steps: [{ exe, argv, exitCode, durationMs }], outcome, failure }` — and `null` in every mode that installs nothing. `outcome` is `installed` (every step nen ran exited 0), `failed`, or `skipped` (nen acted on nothing here). It describes the **installer**, never the host: `installed` beside `state: "missing"` is the real finding "it installed somewhere not on this `PATH`", which is why this verb re-probes. There is no `refused` outcome, because a refusal stops the run before the first install and this CLI answers a refusal with a stderr line and exit 2 rather than a document (below). |

**A refusal prints no document.** Every family in this CLI answers exit 2 with a
line on stderr and an empty stdout, and `shu tools` is no exception: `--install`
on a pin nen will not act on, an `--only` naming an undeclared tool, an
unevaluable `version` and an unknown `--lane` all leave stdout empty under
`--json` too. That is the family's rule rather than this verb's, and the reason
for it is that a `--json` reader should never have to tell a report from an
error object on the same stream. The rule is about refusals *this CLI* makes
about your invocation or your declaration; it is not about a report of work
that was attempted. Two documented exceptions state their own reason where they
happen and are the only ones: an executing verb's **unsatisfied precondition**
prints the report with the failing rows in it (see [`shu deploy`](#nen-shu-deploy)'s
refusal order, row 14 — a caller debugging *why this will not run* needs the
table most there), and [`shu warmup`](#nen-shu-warmup) prints one for any
refusal reached *after* it has already changed the working copy.

**Example**

```bash
nen shu tools --repo ./web-app
```
```text
lane:          web  (nextjs)
mode:          check
compat floor:  0.7  (the lowest dependency.minimum nen 0.8.0 satisfies)
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

**Example — the `nen` row and its floor.** Two declarations, identical but for
`minimum`, checked by a v0.8.0 binary that is also what the host has — the
same v0.7.0 pair the compatibility floor was introduced against ([#200](https://github.com/zheref/nen/pull/200)),
re-run one release later. **v0.8.0 kept the floor at `0.7`** (its CHANGELOG
declares no breaking consumer notes), so the "at the floor" pin below now
demonstrates the widening itself: its admitted ceiling moves from `<0.8.0` to
`<0.9.0` with no repin:

```bash
nen shu tools --repo ./pinned-0.6
```
```text
lane:          app  (nextjs)
mode:          check
compat floor:  0.7  (the lowest dependency.minimum nen 0.8.0 satisfies)
  WRONG    nen   0.8.0  pinned >=0.6.0 <0.7.0
                 verify-only: install by hand -- the bootstrap this repository pins installs v0.7.0. Re-pinning nen is the bootstrap's job and this repository's decision; this verb reports the version and never changes it. minimum '0.6' is below this build's compatibility floor '0.7' -- the 0.7 line declared breaking consumer notes, so no 0.8.0 binary satisfies a pin under '0.7', whatever the host answers. Repin to '0.7'. A pin at or above the floor is satisfied by every later 0.x release that keeps it, so a repin is owed again when the floor moves and not when the minor does.
```
```text
1 of 1 declared tool is missing or not the pinned version. None of them has an installer nen runs in this release: each row above names what to do instead. nen never installs a toolchain on a repository's say-so.
```

(exit 5; the second block is on stderr, exactly as in the `--repo ./web-app` example above)

```bash
nen shu tools --repo ./pinned-0.7
```
```text
lane:          app  (nextjs)
mode:          check
compat floor:  0.7  (the lowest dependency.minimum nen 0.8.0 satisfies)
  ok       nen   0.8.0  pinned >=0.7.0 <0.9.0
```
exit 0

(both run live against `dist/nen-darwin-arm64`, built from a v0.8.0 checkout,
with that binary on `PATH` as the `version_probe`'s `nen`)

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

**In a linked worktree, the trunk is somebody else's.** The ordinary shape of a worktree-based flow is a
primary checkout standing on `main` with every effort in its own `git worktree` beside it — and git
**refuses** to force-move a branch that is checked out anywhere (`fatal: cannot force update the branch
'main' used by worktree at '…'`). Warmup reads `git worktree list --porcelain` before the fast-forward: if
another worktree holds the trunk, the local update is **skipped**, that worktree is named
(`trunk held by worktree <path>; cutting from origin/<trunk> directly`), and `--branch` is cut from
`origin/<trunk>` exactly as it always was — the cut never read the local ref. `--dry-run` reads the same
list and prints the same decision.

**Nothing is ever rolled back.** A step that fails leaves the tree exactly where it got to and says so,
with the report listing what did run. Undoing a fetch, deleting a branch or restoring files would be a
second mutation on a working copy nen has just discovered it does not understand.

**Usage**

```text
nen shu warmup --repo <path> --branch <name> [--from <trunk>] [--discard | --carry] [--tests]
               [--lane <name>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | The working copy to warm. | No default, unlike every other `shu` verb: a verb that fetches into a repository, moves a branch ref and checks out a new branch must never do it to "wherever this process happens to be". |
| `--branch <name>` | **yes** | The branch to cut from the freshly-fetched trunk. | Nen never invents one. Validated with git's own `check-ref-format --branch`, and refused at 2 if it already exists **locally or on `origin`** — never reused, reset or force-moved. A name beginning with `-` is refused before git can read it as an option. |
| `--from <trunk>` | no | The **local** trunk to fast-forward, and what `--branch` is cut from (as `origin/<trunk>`) — **never what it tracks**: the cut is `--no-track` ([#271](https://github.com/zheref/nen/issues/271)). | Defaults to `main` **when that local branch exists**, and refuses at 2 naming this flag when it does not. Nen infers a trunk from no remote `HEAD`, from no checked-out branch and from no lone branch. |
| `--discard` | no | Throw uncommitted work away instead of refusing it. | `git reset --hard` then `git clean -fd`, in that order, with the exact list printed first — **and then the tree is read again**. **Never `git clean -x`**: an ignored file is the developer's own cache. **Never a second `-f`** either: that deletes a nested repository. On an already-clean tree it runs neither command. See [what `--discard` will and will not remove](#what---discard-removes). **Never together with `--carry`** — exit 2, naming both. |
| `--carry` | no | The **third door**: preserve uncommitted work (tracked **and** untracked) across the warm-up instead of refusing it or throwing it away. | `git stash push --include-untracked -m "nen shu warmup --carry <branch> <instant>#<pid>"` runs where `--discard`'s reset/clean would — after every free question and before the fetch — and `git stash list --format=%H%x09%s` right afterwards finds **that message** and reads its SHA (never `refs/stash`, which names whatever was pushed last by anybody; a message matched by zero or several entries refuses without popping). That SHA is this run's own **identity** for the entry, carried in `carry.stashed` and named in every message from here to the end. On an already-clean tree it is a no-op: no stash command runs at all. Once the branch is cut and the declared build (and, with `--tests`, the declared test) has answered — pass **or** fail — `git stash apply <sha>` restores it **by the object itself**, which no other stash push can shift; only the drop that follows needs a `stash@{n}` ref, and that ref is re-resolved with `git stash list --format=%H%x09%gd`, checked with `git rev-parse --verify` immediately before `git stash drop`, and confirmed by a second list afterwards — a drop that took a foreign entry (a push landing in between) is put back with `git stash store` and named. Nothing runs `git stash pop`, whose restore-and-drop by stack index is the race. **Never together with `--discard`** — exit 2, naming both. See [what `--carry` does and does not restore](#what---carry-restores). |
| `--tests` | no | Also run the lane's declared `test` after the build. | Off by default — a test suite is the slow half and a warm-up is the fast one. The test is skipped when the build did not pass. |
| `--lane <name>` | no | Which lane the build/test verification runs on. | Defaults to `project.defaultLane`. An unknown lane is refused at 2 **before a single git call** — a caller who mistyped it must not have their working copy cleaned to find out. The lane is then **resolved again** from the declaration on the branch this verb cut, which is the tree the build actually runs in. |
| `--dry-run` | no | Print every command, in order, and **mutate nothing**. | It performs exactly **one** command and the list is closed: `git worktree list --porcelain`, the one question the plan cannot honestly guess at (see above). Not the fetch, not the status, not a probe. That row carries its real exit code and is labelled `ran:`; every other row is labelled `would run:`, and `dryRun` on the report says which form this is. Two lines still say what a real run would decide differently: that `main` is an assumption, and that the orphan-commit count is asked only on a detached `HEAD`. |
| `--json` | no | The report as one object. | See below. |

<a id="the-new-branch-tracks-nothing"></a>

**The new branch tracks nothing** ([#271](https://github.com/zheref/nen/issues/271)). `git switch -c
<name> origin/<trunk>` starts from a remote-tracking ref, and under git's **default**
`branch.autoSetupMerge` that makes `<name>` *track* `origin/<trunk>` — the trunk without `--from`, and
another effort's branch with `--from <that branch>`. An upstream of another name is exactly what
[`wc publish`](#nen-wc-publish) used to follow: on 2026-09-28 a stacked effort cut with `--from` its
base pushed its commit onto the base branch and its pull request. So the cut is **`git switch
--no-track`**, an explicit flag rather than a reliance on the host's configuration, and the new branch
has **no upstream** until its first `nen wc publish --set-upstream` gives it its own name on `origin`.
The cut's row says so in both forms, on the report's `steps[].note` (and so in `--json` too):
`upstream: none -- --no-track leaves '<name>' tracking nothing, never origin/<trunk>, whatever
branch.autoSetupMerge says. …`. A branch cut by an older warmup still tracks what it was cut from, and
`wc publish` refuses it at exit 2 until `--set-upstream` retracks it.

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
| 1b | `git rev-list --ignore-missing -1 MERGE_HEAD CHERRY_PICK_HEAD` | anything comes back: a merge or cherry-pick is in progress (exit 2). Nen then asks `git rev-parse --verify --quiet` per ref to name which, and quotes that operation's own `--abort`. This is **not** an ordinary dirty tree and `--discard` does not clear it |
| 1c | `git rebase --show-current-patch` | it exits 0 (a rebase stopped on a patch) or 1 (a rebase paused with no current patch, at a `break` or a failed `exec` line): exit 2, naming `git rebase --abort`. Exit 128 is the answer "no rebase". git also exits 128 while a `git am` session is in progress, which this step does not detect. Any other exit refuses as unanswered. A rebase is **not** read through `REBASE_HEAD`, which git leaves behind after a rebase completes; this is the same reading [`wc catch-up`](#nen-wc-catch-up) asks, and catch-up refuses a paused or unanswered rebase too (#307) |
| 2 | `git -c core.quotePath=false status --porcelain=v1 -z -uall` | the tree is dirty and there is no `--discard` (exit 2, every path listed, with a [`stage triage`](#nen-stage-triage) flag beside a filename shaped like a secret or a binary). An **unreadable** status refuses too — it is never read as a clean one |
| 3 | `git remote` | `origin` is not among them (exit 2, listing what is) |
| 4 | `git show-ref --verify --quiet refs/heads/<trunk>` | there is no such local branch (exit 2, naming `--from`). A code *above* 1 is git failing to answer and is reported as that, never as "absent" |
| 4a | `git worktree list --porcelain` | it cannot be read at all (exit 2). Its answer decides step 9, and only step 9. An unanswered question is never read as "nothing else holds the trunk" — that reading is what made the fast-forward fail half-way through a run that had already fetched |
| 5 | `git check-ref-format --branch <name>` | git will not accept the name (exit 2, quoting git's own refusal) |
| 6 | `git show-ref --verify --quiet refs/heads/<name>` | the name is already a local branch (exit 2) |
| 6a | `git reset --hard`, then `git clean -fd`, then the status read **again** | only with `--discard`, and only when there was something to discard. The re-read refuses at 2 if anything survived — see [below](#what---discard-removes) |
| 6b | `git stash push --include-untracked -m "nen shu warmup --carry <branch> <instant>#<pid>"`, then `git stash list --format=%H%x09%s` to find that message | only with `--carry`, and only when there was something to carry. The push failing refuses at exit 1, quoting it, **before** the fetch or any ref move; a failed SHA read after a successful push refuses the same way — see [below](#what---carry-restores) |
| 7 | `git fetch origin` | it fails (exit 1 — a *step* failure, not a refusal) |
| 8 | `git merge-base --is-ancestor <trunk> origin/<trunk>` | the local trunk has **diverged** (exit 2). A code *above* 1 is git failing to answer and is reported as that, never as "diverged" |
| 9 | `git merge --ff-only origin/<trunk>` *(this checkout is on the trunk)*, `git branch --force <trunk> origin/<trunk>` *(no worktree holds it)*, or **nothing at all** *(another worktree holds it)* | it fails. Three shapes because git has three: a checked-out branch cannot be moved by `branch --force`, one that is not checked out cannot be advanced by `merge`, and one checked out in **another** worktree cannot be moved from here at all — so it is skipped, named, and step 11 cuts from the fetched ref regardless |
| 10 | `git ls-remote --heads origin refs/heads/<name>` | the name is already on `origin` (exit 2) — **or the look-up itself failed**, which is never read as "absent". The ref is spelled in **full**: `ls-remote` matches a bare pattern against the *tail* of every ref on slash boundaries, so `--branch x` asked as a bare `x` would match an existing `refs/heads/feat/x` and refuse a name that is free |
| 11 | `git switch --no-track -c <name> origin/<trunk>` | it fails. **`--no-track` is explicit**: the new branch tracks nothing, whatever `branch.autoSetupMerge` says — see [below](#the-new-branch-tracks-nothing) |
| 12 | the lane's declared `build`, then (with `--tests`) its `test` | see the exit codes below |
| 12a | `git stash apply <sha>`, then `git stash list --format=%H%x09%gd`, `git rev-parse --verify --quiet <stash@{n}>`, `git stash drop <stash@{n}>`, `git stash list --format=%H` | only with `--carry`, and only when step 6b actually stashed something. Runs **after** step 12, whether it passed or failed — `--carry`'s promise is that the work comes back, not that it comes back only when the build does. The apply restores by the object step 6b recorded, so nothing else's stash push can shift it; the four lines after it resolve, check, drop and confirm the entry's ref. An entry already gone from the list is reported and the work is restored all the same. A conflict or a failure on the apply does **not** drop the stash: see [below](#what---carry-restores) |

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

<a id="what---carry-restores"></a>

**What `--carry` restores, and when.** It runs `git stash push --include-untracked -m "nen shu warmup
--carry <branch> <instant>#<pid>"` where `--discard`'s reset/clean would — after every free question, before the fetch —
then `git stash list --format=%H%x09%s` to find its own message and read the SHA of what it just pushed.

- **Restored by SHA, never by a stack index.** By the time this run reaches its own restore, a fetch, a
  fast-forward, a checkout and a build sit between the push and it; `stash@{0}` is the *top* of the stash
  stack at whatever moment it is read, and any other stash pushed in between — a script, a hook, a habit —
  would shift it. The SHA read right after the push (`git stash list`, matched on this run's own message)
  is this run's own identity for the entry, and `git stash apply <sha>` restores by that object directly.
  Only the drop needs a `stash@{n}`: `git stash list --format=%H%x09%gd` resolves it, `git rev-parse
  --verify` checks it names the SHA immediately before `git stash drop`, and a second list afterwards
  confirms the drop took this entry and no other — a foreign entry taken by a push landing in between is
  put back with `git stash store` and named. `git stash pop` never runs.
- **A clean tree is a no-op.** There is nothing to carry, so neither `git stash push` nor the
  apply/drop sequence runs at all, and `carry.stashed` in the report is `null`.
- **The push failing refuses at exit 1**, quoting the failed command, **before** the fetch or any ref move
  — nothing else runs. So does a push that succeeded but whose entry could not be found afterwards: the
  work is safe in the stash under this run's message, the refusal quotes that message and the
  `git stash list | grep -F` line that finds it, and nothing is guessed at `stash@{0}`.
- **Every exit from the push onward names the stash.** A fetch failure, a diverged trunk, a taken branch
  name, a fast-forward that fails, a `switch -c` that fails — any of these between the push and the pop
  leaves the report with `carry.restored: false` and `carry.stashed: <sha>`, and its stderr message names
  that SHA and `git stash apply <sha>` as the way to get the work back by hand. None of them attempt the
  pop themselves; the git half is left exactly where it stopped, same as every other mid-run failure this
  verb reports.
- **If the SHA is no longer on the stash list when the pop is due** — dropped, popped or cleared by
  something else while this run was building — **nothing is popped**. The run exits 1 naming the SHA and
  `git stash apply <sha>` (still valid: the SHA is a real object whether or not it is on the stash list).
- **The restore runs after the declared build (and, with `--tests`, the declared test) — whether it passed
  or failed.** `--carry`'s whole promise is that the work comes back; a failing build must not be the reason
  it stays stranded in a stash the caller has to go find by hand.
- **An apply that conflicts or fails does NOT drop the stash.** Nothing is resolved or discarded on the
  caller's behalf — the same "nothing is rolled back" rule this verb keeps everywhere else, applied to the
  step that runs last instead of first. The refusal prints the SHA and the exact `git stash apply <sha>`
  to run by hand once the conflict is resolved, and exits 1. **The cut branch stays exactly where it is** —
  nothing before the restore is undone.

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
| `1` | a step **ran and failed** — a `git` that answered non-zero, or the declared build/test. The report is still emitted, because the caller now has a working copy in a state they did not ask for and that list is the only thing that says which. A `git` that could not be **started** is also 1, with no document: *install it, or put it on PATH*. **A delegated `2` is also `1`** — see below. **`--carry`'s own steps are here too**: the stash push failing (before the fetch), the list-and-pop finding the SHA no longer on the stash list (nothing popped), or the final pop conflicting or failing (the stash is kept, not dropped) — every one of these, from the push onward, names the SHA and `git stash apply <sha>` in its message |
| `2` | every refusal above: dirty tree without `--discard` or `--carry`, a merge/rebase/cherry-pick in progress, a detached `HEAD` carrying commits nothing else reaches, no `origin`, a `--from` that is not a local branch, a diverged trunk, a name git will not accept, a name that already exists, a `--discard` that ran and left the tree still not clean, `--discard` and `--carry` given together, an unknown `--lane`, a missing `--repo` or `--branch`. Each prints its evidence on **stderr** |
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

`--json` is `{ contract, repo, trunk, remote, branch, discard, dryRun, steps, lane, carry, exitCode }`, in
that order, with `contract: "nen.shu.warmup/v0.1"`. `carry` is
`{ requested, stashed, carried, restored }`: `requested` is `true` whenever `--carry` was given, whatever
the tree turned out to hold; `stashed` is the SHA `git stash list` found for this run's own message right after the push, or
`null` on a clean tree (nothing to carry) or without `--carry` at all; `carried` is the list of paths
`git status` read **before** the push -- the same evidence `--discard` prints, kept here rather than
re-derived from the stash's own diff; `restored` is `true` the moment nothing needed restoring and flips
to `false` the instant the push lands, staying `false` through every exit from there on -- a fetch
failure, a diverged trunk, or the final `git stash apply <sha>` conflicting or failing -- and back to
`true` the moment that apply succeeds. The drop that follows is housekeeping: an entry already gone
from the list, a ref that moved, or a drop that failed is reported on stderr and never un-restores. Each `steps[]` row is
`{ kind, argv, exitCode, durationMs, note }`,
where `kind` is `git | build | test` and `argv` is the **whole** command line, executable first — and is
**empty** on the row of a delegated verb the executor refused before it rendered one (a lane that seats
`test` as `unsupported`, say), so the last row of that report is not a *successful build* sitting beside an
exit code of 4. `exitCode` and `durationMs` are `null` **exactly** when nothing was run — a *planned* step of a dry run, a
step the run never reached, or that same unrendered row — and `lane` is `null` when there is no
declaration. `dryRun` exists because a dry run is no longer "nothing was executed": it performs the one
worktree read above, whose row carries a real exit code like any other, so `steps[].exitCode` alone can no
longer tell the two forms apart.

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
would run:     git rev-list --ignore-missing -1 MERGE_HEAD CHERRY_PICK_HEAD
would run:     git rebase --show-current-patch
would run:     git -c core.quotePath=false status --porcelain=v1 -z -uall
would run:     git remote
would run:     git show-ref --verify --quiet refs/heads/main
ran:           git worktree list --porcelain  -- exit 0 in 14ms
would run:     git check-ref-format --branch my-idea
would run:     git show-ref --verify --quiet refs/heads/my-idea
would run:     git fetch origin
would run:     git merge-base --is-ancestor main origin/main
would run:     git branch --force main origin/main
would run:     git ls-remote --heads origin refs/heads/my-idea
would run:     git switch --no-track -c my-idea origin/main
would run:     pnpm turbo run build
```

(most lines also carry an indented note saying what that step decides or refuses on; they are elided
here. exit 0, and the only thing spawned is the `worktree list` — the one row labelled `ran:`. The
orphan-commit count on line 2 is one of the two a real run may spell differently: it asks it only when
line 1 comes back empty. With `--discard` the plan gains `git reset --hard`, `git clean -fd` and a second
`git status` after line 9. With `--carry` instead, the plan gains `git stash push --include-untracked`
and `git stash list --format=%H%x09%s` in that same spot, and `git stash apply <sha>` followed by a
`git stash list --format=%H%x09%gd` line at the very end, after the declared build -- the apply restores
by the object, and the list is where a real run resolves, checks and drops the entry's ref afterwards.)

**Example — the trunk is checked out in another worktree** (a real run, against a throwaway repository
with a primary checkout on `main` and an effort in a linked worktree beside it; `git branch --force main
origin/main` typed by hand in that worktree answers `fatal: cannot force update the branch 'main' used by
worktree at '…/primary'` at exit 128)

```bash
nen shu warmup --repo /tmp/wt-demo/effort --branch my-idea
```
```text
repo:          /tmp/wt-demo/effort
remote:        origin
trunk:         main
branch:        my-idea
discard:       no -- a dirty working copy refuses
lane:          (none -- no declaration, so build/test verification was skipped)
ran:           git branch --show-current  -- exit 0 in 13ms
               on 'my-idea-holder'
ran:           git rev-list --ignore-missing -1 MERGE_HEAD CHERRY_PICK_HEAD  -- exit 0 in 14ms
ran:           git rebase --show-current-patch  -- exit 128 in 11ms
               no rebase git will name -- exit 128 is the answer, not a failure, whatever REBASE_HEAD says
ran:           git -c core.quotePath=false status --porcelain=v1 -z -uall  -- exit 0 in 14ms
               clean -- nothing staged, modified or untracked
ran:           git remote  -- exit 0 in 12ms
               remotes: origin
ran:           git show-ref --verify --quiet refs/heads/main  -- exit 0 in 14ms
               the trunk to fast-forward, assumed because --from was not given
ran:           git worktree list --porcelain  -- exit 0 in 14ms
               trunk held by worktree /tmp/wt-demo/primary; cutting from origin/main directly. The local 'main' is left exactly where it is -- moving it is git's to refuse, and nothing here needs it moved
ran:           git check-ref-format --branch my-idea  -- exit 0 in 12ms
ran:           git show-ref --verify --quiet refs/heads/my-idea  -- exit 1 in 12ms
ran:           git fetch origin  -- exit 0 in 30ms
ran:           git merge-base --is-ancestor main origin/main  -- exit 0 in 11ms
ran:           git ls-remote --heads origin refs/heads/my-idea  -- exit 0 in 18ms
ran:           git switch --no-track -c my-idea origin/main  -- exit 0 in 16ms
               cut from origin/main, the tip this run just fetched
               upstream: none -- --no-track leaves 'my-idea' tracking nothing, never origin/main, whatever branch.autoSetupMerge says. Its first 'nen wc publish --set-upstream' pushes it to origin/my-idea and tracks that
```

(exit 0; there is **no** `git branch --force` row at all, and the same run under `--dry-run` prints the
same decision on the same `worktree list` row. Some notes are elided here. The other worktree is left
exactly as it was: still on `main`, still pointing where it did.)

**Example — a dirty tree, refused**

```text
nen shu warmup: the working copy at /abs/path/web-app carries 3 uncommitted path(s), and warmup destroys nothing nobody asked it to.
   M README.md
  ?? .env  [secret-shape]
  ?? sub/new.txt
Commit them, stash them, pass --carry to stash them across the warm-up and pop them back, or pass --discard to throw them away -- that runs 'git reset --hard' and then 'git clean -fd', in that order, printing this same list first and re-reading the tree afterwards.
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

**Example — `--carry` on a dirty tree**

```bash
nen shu warmup --repo ./web-app --branch my-idea --carry
```
```text
ran:           git stash push --include-untracked -m 'nen shu warmup --carry my-idea'  -- exit 0 in 18ms
               carrying 2 uncommitted path(s) across this warm-up, to be restored once it is done:
                 ?? .env  [secret-shape]
                 ?? notes.md
ran:           git stash list --format=%H%x09%s  -- exit 0 in 6ms
               stashed as 7c3f9a1... -- every step from here addresses it by that SHA, never by 'stash@{0}'
```
```text
[the fetch, the fast-forward, the branch cut and the declared build run exactly as they do without --carry]
```
```text
ran:           git stash apply 7c3f9a1...  -- exit 0 in 12ms
               restoring the 2 path(s) carried across this warm-up, addressed by the SHA itself -- 'git stash apply' takes a commit object, so no stack index can shift underneath it
               the 2 carried path(s) are back
ran:           git stash list --format=%H%x09%gd  -- exit 0 in 4ms
               resolving the stash ref for 7c3f9a1... -- 'git stash drop' takes a stash ref (stash@{n}), never a raw SHA
ran:           git rev-parse --verify --quiet stash@{0}  -- exit 0 in 3ms
               checking that stash@{0} still names 7c3f9a1... immediately before the drop
ran:           git stash drop stash@{0}  -- exit 0 in 5ms
               dropping stash@{0}, verified a moment ago to be 7c3f9a1...
ran:           git stash list --format=%H  -- exit 0 in 3ms
               confirming the drop took this run's own entry and no other
```

(exit 0; `carry.restored` is `true` in `--json`. If the apply had conflicted instead, nen would print the
SHA and the exact `git stash apply 7c3f9a1...` to run by hand, exit 1, and leave the stash exactly
where it was -- `--branch`'s checkout stays in place either way. If the entry were no longer on the
list by the time the drop is due -- dropped by something else in the meantime -- the work is restored
all the same, because the apply addressed the object; nen says so and drops nothing.)

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
| `--line <text>` | yes | The invocation to parse. | **May be empty** when every clause of the grammar is optional -- see below. |

**An empty `--line` is a complete invocation when nothing is required.** For a
grammar whose every slot is bracketed (`at [<gate:…>]`), `--line ""` and
`--line "at"` parse **identically**, both reporting `gate: (clause absent)` at
exit 0: the invocation with nothing in it is the ordinary one for a skill whose
only clause is optional, and a caller should not have to know to spell a bare
`at`. This holds however the template writes the separator -- inside the
brackets (`[onto <slot>]`) or outside them (`at [<gate>]`). A grammar carrying a
**required** clause is unaffected: an empty line still refuses at exit 2, naming
the slot, with the corrected line to paste.

**Output and exit codes** -- on a match, echoes the parse one clause per line: a supplied slot as `<slot>: <value>[ (+)]`, an optional slot nobody filled as `<slot>: (clause absent)`, and a literal-only clause the line carried as `[<clause>]: present`. On a refusal, prints each problem as `nen parse: <problem>` to stderr, then `Corrected line:` and the suggested rewrite. `--json`: the full `ParseResult` -- `{ skill, template, line, ok, slots, clauses, missing, problems, corrected, echo }`; `slots[]` still carries only what the line supplied, so the `(clause absent)` line is the report rather than the data. Exit 0 when the line parses; exit 2 when it does not, or when `--grammar` itself is malformed.

**Example**

```bash
nen parse mybuild --grammar "build <target> for <env>" --line "build app for prod"
```
```text
target: app
env: prod
```
(run for real)

**Example — the two spellings of "no clause"** (both run for real)

```bash
nen parse jutaisho --grammar "at [<gate:G2|G4>]" --line ""
```
```text
gate: (clause absent)
```
```bash
nen parse jutaisho --grammar "at [<gate:G2|G4>]" --line "at"
```
```text
gate: (clause absent)
```
```bash
nen parse backlog-state --grammar "<repo>[@<gate:G1|G2>]" --line ""
```
```text
nen parse: <repo> is required and the line does not supply it.

Corrected line:
  backlog-state <repo>
```
(exit 0, exit 0, exit 2: `<repo>` is required, so the empty line is still a refusal there)

### `nen parse futon`

Parses futon's own invocation grammar (`<repo>@<severity>[+] [then <terminal>]`, or `<repo>@<label> [then <terminal>]`) and resolves its repo token against `--repo`'s `nen/repos.json` registry -- `+` means this severity band OR HIGHER, a bare severity means that band alone, any other token is a **label** matched exactly (case and spaces kept -- boundary spaces inside a quoted selector are part of the label too -- surrounding quotes stripped, never expanded: a trailing `+` stays part of the label verbatim unless the token in front of it is itself a severity, so `c++` is the label `c++`, not a refused severity-band operator; `--json` carries `band: null, label: "<label>"`), and the `then` clause starts at the FIRST whole-word `then` after the `@`: `tag`/`tag+fanout` are the built-in terminals, kebab skill tokens joined by `+`, each optionally `plugin:`-prefixed and `@<target>`-suffixed (`getsuga+mugetsu@github`), are classified as a **skill chain** run in order, and anything else as **prose** kept verbatim (`--json` carries `then: {kind: "terminal"|"skills"|"prose", ...}`, `skills` with `steps: [{skill, target}]` beside the unchanged `terminal`). nen classifies a skill or prose step and never authorizes it -- whether it exists and may run is the calling skill's rule. A tag terminal is refused unless the resolved repo IS the one you are standing in (or `--self` names it): a consumer's release is a different job than the registry owner's, and this refusal is what keeps a consumer's futon invocation from accidentally cutting the OWNER's tag.

**Usage**

```text
nen parse futon --repo <path> "<repo>@<severity>[+]|<repo>@<label> [then <tag|tag+fanout|skill[@target][+skill...]|prose>]" [--self <owner/name>]
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

**The advance-go gate** (maintainer's ruling, 2026-09-26; the third of the
"make it deterministic" trio). When the `then` clause classifies as a
**skill chain**, every step whose skill is listed in the ACTIVE advance-go
policy (below) is annotated with `gate: {allowed, kind, reason, source}`. A
step whose skill that policy does **not** name gets no `gate` field at all
-- exactly as `nen review scopes` raises a scope only for a path a declared
pattern claims. The kind is [`nen repo classify`](#nen-repo-classify)'s own
verdict for the RESOLVED band's repo, derivable only when that repo IS the
checkout `--repo` names (its origin remote matches) -- otherwise `unknown`,
and `unknown` FAILS CLOSED (never treated as allowed). A REFUSED step does
**not** fail the parse: the exit code stays 0, and the plain rendering
prints a `refused: <skill> (<reason>) [<source>]` line for it.
`'plugin:mugetsu'` and `'mugetsu'` are matched against the same map key --
the prefix is stripped on both the declaration and the step before
comparison.

**`source` -- declared vs. default** (maintainer's ruling, 2026-09-28): an
ABSENT key must never read as "no gate". When `--repo`'s `nen/workflow.json`
declares no `futon.advanceGo` at all -- the key absent, the whole file
absent, `"futon": {}` , an explicit `"advanceGo": {}`, or `"advanceGo"`
carrying ONLY `$`-prefixed metadata keys (a `$comment`, say -- none of which
is a declared skill) -- the gate falls back to a built-in default policy,
and every gate this run annotates carries `source: "default"`:

```json
{"mugetsu": ["process", "library"], "kagutsuchi": ["product", "process", "library"], "getsuga": ["product", "process", "library"]}
```

A repository that declares `futon.advanceGo` at all -- even naming only one
skill -- REPLACES this default wholesale rather than merging with it, and
every gate it annotates carries `source: "declared"`: a repository that
chose to leave `kagutsuchi` ungated must not have that choice silently
reinstated.

```json
{"futon": {"advanceGo": {"mugetsu": ["process", "library"], "kagutsuchi": ["product"]}}}
```

```bash
nen parse futon --repo <path> "@high then mugetsu"
```
```text
then: skills mugetsu (existence and authority are the caller's to check)
  refused: mugetsu (repo kind 'product' is not an allowed repo kind for 'mugetsu' (allowed: process, library)) [declared]
```
(from `src/grammar/command.test.ts`'s advance-go gate suite)

**Grammar edge cases, all refused or read exactly rather than guessed:**

- **The `then` split requires whitespace on both sides.** `nen@then-review`
  names the LABEL `then-review`, not a `then` clause with an empty selector —
  the word must be surrounded by whitespace (or sit at the string's end) to
  split at all, and a `then` living inside a quoted selector
  (`nen@"ready then ship"`) is never mistaken for the split either.
- **`tag` and `fanout` are reserved step names inside a skill chain.** A
  chain naming either alongside another step (`tag+mugetsu`) is refused —
  they are the terminal's own vocabulary, not ordinary skills — with a
  corrected line offering `then tag`/`then tag+fanout` alone, or the chain
  with the reserved name dropped.
- **A near-miss of a built-in terminal is refused by name, not read as a
  skill or prose.** `then tga` and `then tag+fanuot` (edit distance ≤ 2 from
  `tag` / `tag+fanout`) are refused with the closest terminal named and
  offered as the correction, checked BEFORE the reserved-name rule above so a
  two-part typo like `tag+fanuot` reports the right reason.
- **`c++` is the label `c++`, never the label `c` with a refused trailing
  `+`.** A trailing `+` is the band-expansion operator only when the token in
  front of it is itself a severity name; otherwise it stays part of the
  label verbatim.
- **Spaces around the chain operator are normalized before classifying.**
  `getsuga + mugetsu` reads as the chain `getsuga+mugetsu`, not as prose
  merely because someone put spaces around `+`.
- **An empty chain part is refused.** `getsuga++mugetsu` and `+mugetsu` are
  refused by name ("a malformed chain — an empty step between `+`s") rather
  than silently dropping the empty step.
- **A missing selector never manufactures one to correct itself with**
  (maintainer's ruling, 2026-09-28). `bc@` and `example/app@ then
  getsuga+mugetsu` are refused with `correctedLine: null` — never a filled-in
  `bc@critical` — because the selector is the one scoping decision only a
  human (or a picker relaying one) may state for a chain that goes on to
  publish; nen will not pick the most severe band on the caller's behalf.
- **A duplicate step (same skill, same target) is refused.** A chain naming
  the same skill against the same target twice — `getsuga+mugetsu+mugetsu`,
  or `mugetsu@a+mugetsu@a` — is refused with a corrected line that drops the
  repeat, because it is either a double-run of the same step or a paste
  error and nen will not guess which. The SAME skill against DIFFERENT
  targets (`mugetsu@a+mugetsu@b`) stays allowed, and this rule states no
  step-order requirement.

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

A shell metacharacter anywhere on a command line refuses it here, **quoted or not** -- `gh pr view 1 --jq '.a|.b'` is `[unknown]` -- because this verdict is handed to whatever shell the skill side runs, and in cmd.exe a single quote quotes nothing. [`nen watch until`](#nen-watch-until) is the one path that may be narrower ([#288](https://github.com/zheref/nen/issues/288)): it spawns with no shell, so on a POSIX host it refuses a metacharacter only where a shell would act on it -- see its [quoting](#watch-until-quoting) note, which also says why Windows keeps this check for now.

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
| `--source <owner/name>` | no | GitHub repository to fetch release assets from. | Defaults to `zheref/nen` inside the script; NOT `--repo` -- a wholly different meaning (a path vs. an `owner/name`) is deliberately given two different flag names across both the shell and the CLI. Both halves must be a real name: neither may be empty, `.` or `..`, so `a/..` is a usage error (2) at the flag rather than a 404 from the network. |
| `--cache-dir <dir>` | no | Cache root for verified binaries. | Defaults to `${XDG_CACHE_HOME:-$HOME/.cache}/nen`. A verified binary is cached at `<root>/<source>/<ref>/<artifact>`, each key flattened to exactly one path segment -- so a fork or a mirror at the same tag as the upstream gets its own slot instead of sharing one. |
| `--script <path>` | no | An explicit path to `bootstrap/nen.sh`, for a binary invoked outside any checkout. | Falls back to `$NEN_BOOTSTRAP_SH`, then `<repo>/bootstrap/nen.sh`. |
| `--repo <path>` | no | The checkout `bootstrap/nen.sh` is found under, when `--script` is not given. | Defaults to the cwd. |

**Output and exit codes** -- stdout carries ONLY the verified path, and only on success; every diagnostic is on stderr. Exit codes are a published contract, restated from `bootstrap/nen.sh`'s own header, printed in full by `nen bootstrap --help` since [#58](https://github.com/zheref/nen/issues/58) (a caller scripting around code **7** had to discover its meaning empirically before that), and cross-checked by `src/supply/bootstrap.test.ts`, which fails the build if the help text omits a code `BootstrapExit` declares: `0` OK, `2` usage error (nothing attempted), `3` unsupported host (no binary published for this OS/arch), `4` download failure -- **the only retryable one**, `5` checksum mismatch or unverifiable -- SECURITY, never retry, `6` manifest (`SHA256SUMS`) unfetchable/missing/malformed/silent about the artifact -- never retry, `7` the TypeScript wrapper itself could not run the script at all (no `bash` on PATH, script not found) -- distinct from any code the script itself can return.

**Example**

```bash
nen bootstrap --ref v0.19.0 --source zheref/nen
```
```text
/home/me/.cache/nen/zheref_nen/v0.19.0/nen-linux-x64
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

**Rungs 2 and 3 stay the host's, and `--mark` is how the host rings them.** Nen only ever shells out to `git` and `gh`, and neither is a notification primitive, so this command fires nothing and never will. What the two rungs do not need is for *nen* to fire them: `--mark` records the stop as a fact -- `.nen/last-stop.json`, carrying `{ contract, who, gate, notified, at }` -- and a `Stop` hook on your own machine reads that file and rings whatever the platform has. The split is the one this verb already draws about rung 1: nen states the fact, the host acts on it.

The marker goes under the dot-prefixed, gitignored `.nen/` (generated output), never the committed `nen/`; the directory is created when absent, and an existing marker is **replaced**, because the latest stop is the one a hook should ring for. It is written **last**, after every refusal this verb can make -- a hook ringing for a banner nobody saw is worse than one that never rang. `--mark` is the only form of this verb that writes anything, which is why the row is `write-flag-gated` on it in [izanami's table](#nen-parse-izanami).

**Usage**

```text
nen stop [--who <name>] [--gate G1|G1-M|G2|G3|G4|G5] [--notified] [--mark]
         [--title <line>] [--body <text>] [--report-url <url>]
         [--options <file.json>] [--propose-issue <file.json>]
nen stop clear [--repo <path>]
         [--repo <path>] [efforts.md | -]
nen stop --template
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--who <name>` | no | Who is asking, stated by the caller. | Nen ships no built-in persona name. |
| `--gate <g>` | no | The human gate being asked for: `G1` epic approval, `G1-M` release into build, `G2` merge, `G3` release go/no-go, `G4` policy/spec change, `G5` decision/human-only action. | An unrecognised gate name is refused (exit 2). |
| `--notified` | no | States rung 1 (push notification) was already fired by the caller. | Nen never fires it itself. |
| `efforts.md \| -` (positional) | no | A markdown pipe table (header + rows) to render below the banner; `-` reads stdin. | Resolved against `--repo` (default cwd) when a relative path is given. |
| `--mark` | no | Also write `.nen/last-stop.json` under `--repo`: `{ contract, who, gate, notified, at }`. | The ONLY form of this verb that writes. The instant is the invocation's own clock, ISO-8601, so a host hook's freshness window is provable rather than raced. `--mark --template` is exit 2: a blank table waits on nothing, so there is no stop to record. A marker that cannot be written is exit **1** with the errno -- a caller who typed `--mark` asked for a rung to be armed, and "the banner rendered and the marker did not" is where somebody waits for a bell that never rings. |
| `--template` | no | Emit a blank 5-column table (`Effort`, `Open issues & PRs`, `Status (gate)`, `Thought flow`, `Session / lane`) instead of the banner. | Mutually exclusive in effect with the banner mode -- no signal line is printed, since nothing is being waited on. |

**Output and exit codes** -- the banner is `=== YOUR INPUT IS NEEDED ===...`, then `who:`/`gate:` lines if given, the rung-1/rung-2-3 status lines, then the rendered padded-markdown table (or nothing, with a note that "no banner above => nothing needs you right now" -- though the banner itself is unconditional whenever this command runs without `--template`). `--json`: `{ template: true, rows }` for `--template`; otherwise `{ who, gate, notified, rows, marker }` (the banner text itself is not part of the JSON -- only the structured fields are). `marker` is `null` unless `--mark` was given, and otherwise carries `{ path, contract, who, gate, notified, at }`; the file on disk carries every one of those but `path`, since a file that names where it is is wrong the moment a checkout moves. The text form gains one line, `marked: <path> -- a host hook may ring rungs 2-3 off it.` Exit 0 on a normal render; exit 2 on an unrecognised `--gate` value, on `--mark --template`, or when the `efforts.md`/`-` argument names a file that cannot be read; exit 1 when `--mark` could not write the marker.

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

And the same verb asked to leave a marker behind:

```bash
nen stop --who Kurapika --gate G5 --mark --repo /tmp/site
```
```text
=== YOUR INPUT IS NEEDED ==============================
who: Kurapika
gate: G5 -- decision / human-only action
rung 1 (push notification): NOT fired -- the caller's to have sent, before this renders.
rungs 2-3 (OS notification, audible cue): not fired by nen -- only git/gh subprocesses are ever shelled out to.
see the table below. No banner above => nothing needs you right now.
marked: /tmp/site/.nen/last-stop.json -- a host hook may ring rungs 2-3 off it.
```
```json
{
  "contract": "nen.stop.mark/v0.1",
  "who": "Kurapika",
  "gate": "G5",
  "notified": false,
  "at": "2026-09-10T05:27:13.269Z"
}
```

**The rich stop (v0.11.0, zheref/nen#216) -- Crazy Slots.** A stop that carries any of `--title`, `--body`,
`--report-url`, `--options <file>` or `--propose-issue <file>` renders those parts under the banner and,
with `--mark`, writes the marker as **`nen.stop.mark/v0.2`** with the five v0.1 keys plus `title`, `body`,
`reportUrl`, `options[]` and `proposedIssue`. A stop that carries none keeps writing v0.1 byte for byte,
so a hook reading the old shape sees nothing change until its caller starts saying more.

`--options` is a JSON array of the DECISIONS the stop asks for -- `[{ key, label, command, consequence?,
recommended? }]` -- rendered as lettered lines with a star on the recommended one. Three rules are
enforced rather than advised: every `command` is non-empty (an option nothing executes is a suggestion),
exactly one option is `recommended` (a stop with no star, or two, has made no recommendation), and a
label reading *open / read / view the report* is refused -- the report is LINKED with every stop through
`--report-url` and is never one of the decisions. Fewer than three options is accepted and said aloud.

`--propose-issue` is a JSON object `{ title, body, labels? }` drafting the process issue this stop suggests
filing; with `--mark` it is carried in the marker and written beside it at `.nen/proposed/<at>.json`
(`nen.stop.proposed-issue/v0.1`) for a later harvest to pick up.

`nen stop show` reads the marker back and validates it -- v0.1 or v0.2 with exactly that contract's key set (an absent key is a defect, not a null), every option executable, one starred,
none naming the report -- at exit 1 naming the first defect, so a hook or a report can rely on the shape.
`nen stop clear` removes `.nen/last-stop.json` when it exists -- the consumption a Stop hook performs on a
surface that has one, as a verb for the surfaces that do not. Exit 0 either way; the line says which.

```
nen stop --who Kurapika --gate G5 --title "dirty tree at breath" --body "which door?" \
  --report-url https://claude.ai/artifact/… --options options.json --propose-issue issue.json --mark
```
(run for real against a scratch repository; the absolute path is elided to `/tmp/site`)
## Reports

The two halves of an effort report: the facts, and the fill that turns them
into one. Both are local — no `gh`, no network — and neither decides anything:
no coverage bar is applied, no readiness is computed, nothing is published.

<a id="family-report"></a>

**`nen report`**

`data` gathers what is on a branch against a base — commits, changed files, the artifacts a run left under `.nen/`, the coverage report the lane's declaration names — into one document; `render` fills a template with that document and writes the result. They are two verbs and not one for the same reason [`board build`](#nen-board-build) and [`board render`](#nen-board-render) are: a verb that gathered AND filled would be a verb whose facts exist only inside the rendering that consumed them, so you could neither diff them, store them beside the report, nor re-render from them. `render` takes any JSON, so a caller who assembles their own facts is not locked out of the templating.

### `nen report data`

One document describing this branch against `--base`: the commits (`<base>..HEAD`), the changed files (`<base>...HEAD` — three dots, the merge-base set a pull request shows), the evidence rows (an empty list in this release: `nen shu evidence` owns them), the lane's coverage report **if one is already on disk**, the build proof, and the last recorded stop. **Read-only**: it runs four `git` reads, opens files, and has no write path in any flag combination.

Every absence is `null` and no absence is a failure — a repository with no coverage report, no build proof and no recorded stop still produces the whole document, with the reason for each null on stderr. What is *not* folded into a null is a git command that FAILS: an unresolvable `--base` is refused by name at exit 2 before anything is read, and a failed `git log`/`git diff` is refused rather than reported as a branch with nothing on it. `repo` carries the checkout's directory **name**, never its absolute path — this document gets filled into a report that gets pasted into a pull request.

**Usage**

```text
nen report data --repo <path> --base <ref> [--lane <name>] [--tiers <file>] [--json]
nen report data … [--target <owner/name>] [--prs <n,...>] [--issues <n,...>] [--backlog]
nen report data … --objects-from <file>
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the working tree this report describes | unbracketed in usage; omitted is refused at exit 2 (#28) |
| `--base <ref>` | **yes** | what this branch is measured against | the trunk, or the commit the effort was cut from; a ref that does not resolve is refused at exit 2 naming it, with nothing read |
| `--lane <name>` | no | which declared lane's coverage report and build proof to read | defaults to the declaration's own `defaultLane`; with neither, both fields are `null`. A value that would escape the tree through `.nen/proof/<lane>.json` is refused at exit 2 |
| `--tiers <file>` | no | a JSON object mapping a tier name to its paths | `{ "<tier>": ["<path prefix or glob>", …] }`. The file's **key order is the precedence** — the first tier whose patterns match a path wins. A pattern with no `*`/`?` is a path **prefix** matched on segment boundaries (`src/report` claims `src/report/data.ts`, never `src/reporting.ts`); one with them is a narrow glob (`*` stops at `/`, `**` crosses it, `?` is one character). Without the flag every file's `tier` is `null` |
| `--target <owner/name>` | for the live register | the GitHub side of the register | `--repo` names a checkout on disk and never addresses the API. Required as soon as any of the three below is given |
| `--prs <n,...>` | no | pull requests to read, by number | a comma-separated list of **positive** whole numbers; a non-numeric entry, or a `0`, is refused at exit 2 naming it, before any call — GitHub numbers issues and pull requests from 1 |
| `--issues <n,...>` | no | issues to read, by number | same grammar, same refusal |
| `--backlog` | no (boolean) | every **open** issue and pull request of `--target` | paginated to completion; a fetch that hits the defensive page ceiling says so on stderr rather than presenting a partial register as whole |
| `--objects-from <file>` | no | the register, read from a file instead of GitHub | a JSON array of rows already in the published `objects` shape. **Validated at the read seam and refused BY ROW INDEX at exit 2.** Never mixed with the four flags above: a register whose rows came from two authorities says nothing about which row came from which |
| `--json` | no | the document itself | — |

**The `objects` register** is `[]` unless one of those five flags is given,
which keeps this verb's default shape exactly what it has always been — local,
four git reads, no network, no token. A pull-request row carries `kind`,
`number`, `title`, `url`, `state`, `labels[]`, `head`, `mergeStateStatus`,
`checks` (`total`/`green`/`red`/`pending`, counted over the **latest** run per
check name, through the same `latestChecks` reduction [`pr
ready`](#nen-pr-ready) uses), `threads` (`total`/`unresolved`),
`reviewRequests[]`, `linked[]` (the issue numbers it references), `readiness`
and `notes[]`. An issue row carries `kind`, `number`, `title`, `url`, `state`,
`labels[]`, `linked[]` (the pull requests that reference it), a `readiness`
that is **always `null`** — CON-32 is a statement about a pull request — and
`notes[]`.

**A FIELD degrades; an OBJECT does not go missing.** Each field of a pull
request is read on its own: a check rollup that will not validate (an unknown
`conclusion`, say) is counted leniently: an entry with no readable
conclusion or state counts `pending`, one with an unrecognised conclusion
counts `red`, and none counts `green`. An in-flight run's `conclusion` of
`""` is simply unset since #304 and counts `pending` without degrading.
`mergeStateStatus` is carried verbatim, an unreadable thread walk is
`0/0`, and **every degradation is named in that row's `notes[]` and on
stderr**. What is *not* tolerated is losing an object you asked for: a
`--prs`/`--issues` number that cannot be read at all, or a `--backlog`
fetch that hits its pagination ceiling, is **exit 1 naming it** —
because a short `objects[]` at exit 0 says "that is the whole register" about
a register that is not. (Routing the register through the readiness gate's
fail-closed parser is what used to delete a named pull request outright.)

`readiness` says **which authority answered it**, in `source`: `check` when the
head carries a check run named `readiness` that clears **four** tests — it is
the **latest** run of that name by `started_at`, its `status` is `completed`,
its `conclusion` is not one of FAILURE/CANCELLED/TIMED_OUT/ACTION_REQUIRED/
STARTUP_FAILURE/STALE, and its `output.summary` or `output.text` (**never**
`output.title`) carries a line that **is** a verdict end to end (`ready`, or
`not-ready: <reason>`). Any of them failing warns and falls through to the
gate, because a run still deciding has not decided and a title reading "Ready
to merge" is not a verdict; `computed` when nen's own in-process gate decided it, which is
[`pr ready`](#nen-pr-ready) called as a function rather than a second reading of
CON-32; and `null`, with the reason on stderr, when neither could be read — no
token, an unevaluated gate, an unreachable API. An unevaluated gate has not said
"not ready"; it has said nothing, and publishing the two as one word is the
false-red twin of a false green.

**Output and exit codes** — human lines: a `repo:`/`generated:` header, then `commits:` and one line per commit, `files:` and one line per file (status, path, tier), then `evidence:`, `coverage:`, `proof:` and `last stop:`. `--json` keys, in this order: `contract` (`nen.report.data/v0.1`), `repo`, `branch` (`null` on a detached HEAD), `base`, `generatedAt`, `commits[]` (`sha`, `subject`, `author`, `date`), `files[]` (`path` — a rename's **destination** — `status` (git's own token, `R096` and all), `tier`), `evidence[]` (empty; see below), `coverage` (`lane`, `format`, `path`, `total`, `targets[]` — the same shape [`shu coverage`](#nen-shu-coverage) parses, from the same parser — or `null`), `proof` (`.nen/proof/<lane>.json` verbatim, or `null`), `lastStop` (`.nen/last-stop.json` verbatim, or `null`), `phases[]` (each entry flattened with its `effort`; since v0.13.0 also its `note` and the `steps[]` a `shu` run left under it), then `usage[]` (every `.nen/usage/<effort>.json` entry, flattened with its `effort` — **appended after `lastStop`** in v0.13.0, [#227](https://github.com/zheref/nen/issues/227); the human rendering carries one `usage: N entries, M not reported` line), and `objects[]` — **appended at the end of the key order** in v0.12.0 and kept last, so a consumer reading the twelve keys before them reads the same document it always did. Exit 0 on any document; exit 1 when `git log`/`git diff` fails for a reason other than the flags — git could not be run at all, or ran and refused (no repository, an unreadable object) — with `--base` already known to resolve; exit 2 on a missing `--repo`/`--base`, an unresolvable `--base`, a `--tiers` file that is not a tier table, or a `--lane` that escapes the tree.

`evidence` is **an empty list in this release, and the empty list is the seam**: the rows belong to `nen shu evidence --base <ref>`, which reads `project.evidence` (globs, mechanism, a `{suite}-{scene}` template) and which does not exist yet. The field ships now so a template written against this contract does not change shape when the verb lands — `{{#each evidence}}` renders nothing today and renders rows tomorrow. This verb deliberately does **not** glob a tree for them: that answer must come from the one verb that owns `project.evidence`, or the two will disagree the first time a scene template changes.

**Example**

```bash
nen report data --repo . --base origin/main --tiers tiers.json
```
```text
repo: report-family on 'opus/kurapika/report-family', base 'origin/main'
generated: 2026-09-10T05:15:27.751Z
commits: 4
  fe71eafb Merge remote-tracking branch 'origin/main' into opus/kurapika/report-family
  9d647966 docs(changelog): link the report family bullet to its PR
  e17af580 docs(report): document the report family, its two verbs and the counts
  5e70ff32 feat(report): add the report family -- data and render
files: 13 (13 tiered)
  M    CHANGELOG.md  [docs]
  M    README.md  [docs]
  M    docs/USAGE.md  [docs]
  M    src/cli/registry.ts  [source]
  M    src/parse/izanami.ts  [source]
  A    src/report/command.ts  [source]
  A    src/report/data.test.ts  [tests]
  A    src/report/data.ts  [source]
  A    src/report/fixtures/report.html  [source]
  A    src/report/render.test.ts  [tests]
  A    src/report/render.ts  [source]
  A    src/report/template.test.ts  [tests]
  A    src/report/template.ts  [source]
evidence: 0 row(s) -- 'nen shu evidence' fills this; this verb never globs a tree
coverage: 93.74% lines on 'nen' (lcov, coverage/lcov.info)
proof: none
last stop: none
```
(run for real, in this repository's own worktree while the family was being written; `tiers.json` was `{"tests": ["src/**/*.test.ts"], "source": ["src"], "docs": ["docs", "README.md", "CHANGELOG.md"]}`. The coverage line is this repository's OWN declaration answering: `nen/contract.json` names lane `nen`, whose `coverage` verb declares `coverage/lcov.info`, and that file was on disk from a previous [`shu coverage`](#nen-shu-coverage) run — this verb read it and spawned nothing. Before that run it printed `coverage: none read`, with `coverage: lane 'nen' declares 'coverage/lcov.info', which is not there. Run 'nen shu coverage --repo <path> --lane nen' to produce it; reported as null.` on stderr)

### `nen report render`

Fills a template with a data document and writes the result. The **whole** template language is four constructs: `{{token}}` (HTML-escaped), `{{{token}}}` (raw), `{{#each <list>}}…{{/each}}` (nested; `{{.}}` is a scalar item and `{{@index}}` its position) and `{{#if <key>}}…{{/if}}`. There are no helpers, no partials, no comments and no expressions — nen fills reports, it does not run them, and the whole language fits in a sentence on purpose.

A token the data document has not got is **refused at exit 2 naming it**, because a blank cell in a published report reads as a fact (there were no commits) rather than as a mistake. A present `null` renders as the empty string — that is the data document's own way of saying there is nothing to say — and an object or a list reaching a value tag is refused, since `[object Object]` is the same silent wrong answer one indirection along. Inside `{{#each}}` a row's own field wins and resolution walks outward to the document for one it has not got; a missing **later** segment of a dotted path is an unknown token rather than a reason to try the next scope out.

**Usage**

```text
nen report render --template <file> --data <file> --out <file> [--variant <name>] [--graph <file>] [--dry-run] [--repo <path>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--template <file>` | **yes** | the template to fill | read **raw**: its own line endings survive into the output, so a CRLF template writes a CRLF report |
| `--data <file>` | **yes** | the JSON document every token is answered from | typically [`report data --json`](#nen-report-data)'s output, but any JSON works |
| `--out <file>` | **yes** | where to write | must resolve **inside** `--repo`, **with symlinks resolved** — a `Reports/` that is a link out of the tree is refused naming the link. Parent directories are created |
| `--dry-run` | no | print every token the template names and write nothing | it still parses **and renders**, so its refusals are the real run's; a refusal on a dry run also lists the tokens, so the advice to run it is not a loop |
| `--variant <name>` | no | a variant declared under `reports.sections` in `--repo`'s [`nen/workflow.json`](#nenworkflowjson) | injects `sections` (a presence flag per declared block) and `sectionList` (the block names in the file's own order) into the data document before the fill, **and nothing else**. An undeclared variant is refused at exit 2 naming the declared ones; a `--data` document whose own `variant` key disagrees is refused too. Without the flag nothing at all is injected — v0.11 behaviour byte for byte |
| `--graph <file>` | no | an architecture-delta graph document | validated whole (see [`report mermaid`](#nen-report-mermaid)) and injected as `graphJson`, `graphMermaid`, `graphNodes` and `graphEdges`. All four together, always, because a template that draws the graph must be able to count on every token it names being there |
| `--repo <path>` | no | the tree `--out` is checked against | bracketed: defaults to the current directory, which is the tree the report belongs to |
| `--json` | no | the render report | — |

**Output and exit codes** — human lines: `template:`, `data:`, `out:`, `tokens: <n>` then one indented token per line, then `wrote <out>` or `(dry run) nothing written`. `--json` keys, in this order: `contract` (`nen.report.render/v0.1`), `template`, `out` (both **as the caller typed them**, never resolved — an absolute path in a document destined for a PR body carries a home directory with it), `tokens[]` (first-appearance order, de-duplicated), `written` (`false` on `--dry-run`), and — appended in v0.12.0 — `variant` (the name, or `null`) and `injected[]` (the root keys `--variant`/`--graph` merged in, sorted; empty for neither). The injection is a **root** merge onto a copy of the document: nothing is merged deeply and the `--data` file itself is never rewritten. Exit 0 on a fill; exit 2 on a missing flag, an `--out` outside the tree, an unreadable template, a `--data` that is not JSON, a tag this language does not have, a block left open, a token the data has not got, or a value with no text form. Nothing is written on any refusal.

**Example**

```bash
nen report data --repo . --base origin/main --json > report-data.json
nen report render --repo . --template effort.html --data report-data.json --out Reports/effort.html
```
```text
template: effort.html
data: report-data.json
out: Reports/effort.html
tokens: 11
  repo
  branch
  base
  generatedAt
  commits
  @index
  sha
  subject
  coverage
  coverage.total.lines.percent
  coverage.lane
wrote Reports/effort.html
```
```text
<h1>report-family -- opus/kurapika/report-family</h1>
<p>against origin/main, generated 2026-09-10T05:15:35.200Z</p>
<table>
<tr><td>0</td><td>fe71eafb3e6c0478c1e4f6403eb4fb91a7060cf6</td><td>Merge remote-tracking branch &#39;origin/main&#39; into opus/kurapika/report-family</td></tr>
<tr><td>1</td><td>9d647966a95dd126c660b18c3dd276320ea5bccb</td><td>docs(changelog): link the report family bullet to its PR</td></tr>
<tr><td>2</td><td>e17af5808a8a3f5d887d379f553822d8ad306c69</td><td>docs(report): document the report family, its two verbs and the counts</td></tr>
<tr><td>3</td><td>5e70ff32ed78b267edf7434b80e0a6d0ed7fd4c2</td><td>feat(report): add the report family -- data and render</td></tr>
</table>
<p>93.74% of lines on 'nen'</p>
```
(both run for real, `effort.html` being the six-line template above. Note the escaping: the merge commit's `'origin/main'` came out as `&#39;origin/main&#39;` from a `{{subject}}` cell, which is the default and the point. With a `coverage` of `null` the last paragraph is simply absent — the `{{#if}}` block is skipped, not blanked. The same render with `--out ../escape.html` prints `--out '../escape.html' resolves outside the repository at … 'report render' writes the report INTO the repository it is reporting on and nowhere else` at exit 2)

### `nen report mermaid`

Prints the **mermaid text** for a graph document and nothing else: one file is
read, nothing is written, and no template is involved. It is the same text
[`report render --graph`](#nen-report-render) injects as `graphMermaid`, from
the same validation, so a caller can paste a diagram into a pull-request body
without rendering a page for it.

The document is the **architecture delta** a model writes — nen has no opinion
about which modules a session touched and must never grow one. What nen does is
the half a model is bad at: hold it to a shape, and **refuse an edge whose
endpoint names a node nobody declared**, at exit 2, naming the row. A dropped
edge would render a finished-looking diagram missing the arrow that was the
point of drawing it.

```json
{ "contract": "nen.report.graph/v0.1",
  "caption": "one line, model-written",
  "nodes": [ { "id": "report-render", "label": "nen report render", "kind": "verb", "change": "changed" } ],
  "edges": [ { "from": "rikugan", "to": "report-render", "rel": "calls", "change": "added" } ] }
```

`id` is a slug and unique (it becomes a mermaid identifier); `label` is a
non-empty string; `kind` is a free slug — `module`, `verb`, `file`, `service`,
`skill`, `agent`, `template`, whatever this repository's vocabulary is;
`change` is one of `added`, `changed`, `removed`, `unchanged`, on nodes and
edges alike; `rel` is a short free string and optional; `caption` is optional.

The output is **deterministic and in document order** — nothing is sorted,
grouped or de-duplicated — because it lands in a published report and two runs
over an unchanged document must be byte-identical or every re-render is a diff.
The `classDef` lines carry **stroke weights and no colour**: a colour is the
consuming repository's, stated in its own `nen/colors.yml` or its own
stylesheet, and the class names (`added`, `changed`, `removed`) are the whole
contract a page styles against.

**Usage**

```text
nen report mermaid --graph <file> [--repo <path>]
```

**Output and exit codes** — the mermaid text on stdout, and nothing else. There
is no machine-readable document here, and `--json` is **refused by name at exit
2** rather than accepted and ignored: the text IS the output, so wrapping it
would make every caller unwrap it before pasting it where it was printed for,
and a flag accepted and ignored is worse than one refused. Redirect stdout if
you want the text in a file. Exit 0 on a valid document; exit 2 on `--json`, a
missing `--graph`, a document that does not name the contract, a malformed node
or edge, a repeated id, or an edge endpoint that names no declared node.

**Example**

```bash
nen report mermaid --graph src/report/fixtures/graph.json
```
```text
flowchart LR
  report-render["nen report render"]:::changed
  report-graph["src/report/graph.ts"]:::added
  rikugan["templates/rikugan.html"]:::changed
  report-render -->|reads| report-graph
  rikugan -->|filled by| report-render
  classDef added stroke-width:2px
  classDef changed stroke-width:2px,stroke-dasharray:0
  classDef removed stroke-width:1px,stroke-dasharray:4 2
```

## Reviewers

Which reviewers a branch raises, read off the repository's own declaration. The
verb classifies and does **not** summon: it opens nothing, requests no review,
spends no budget and names no gate. A verb that raised a scope *and* summoned
its reviewer would be a verb whose dry run is a different program from its real
one.

<a id="family-review"></a>

**`nen review`**

One verb. `scopes` diffs `<base>...HEAD` and reports which rows of
[`nen/workflow.json`](#nenworkflowjson)'s `review.scopes` block the changed
paths raise, and which paths no row claims at all.

### `nen review scopes`

Classifies this branch's diff against `<base>...HEAD` — **three dots**, the
merge-base set a pull request shows, so a trunk that moved on since the branch
was cut does not raise a reviewer for somebody else's commits — by the
repository's own `review.scopes` rows.

**A path may raise several scopes**, and that is the design rather than an
accident: one file can be both an architecture question and a security one. It
is the opposite of [`report data --tiers`](#nen-report-data), which is
first-match-wins, and the difference is the question each answers — a file has
one tier and any number of readers. The path grammar is the same in both: a
pattern with no `*`/`?` is a prefix matched on segment boundaries, one with
them is a narrow glob (`*` stops at `/`, `**` crosses it, `?` is one
character).

**An unclaimed path is reported, never swallowed.** A repository whose table
has a hole in it — a new directory nobody added to any `paths` list — looks
exactly like a repository whose diff raised no scope there, and the two are
opposite findings: one is "nothing to review here", the other is "nobody is
looking at this".

**Usage**

```text
nen review scopes --base <ref> [--repo <path>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--base <ref>` | **yes** | what this branch is measured against | a ref that does not resolve is refused at exit 2 naming it, with nothing read — the same refusal [`report data`](#nen-report-data) gives, through the same function |
| `--repo <path>` | no | the checkout whose `nen/workflow.json` declares the scopes, and whose diff is read | bracketed: defaults to the current directory |
| `--json` | no | the document | — |

**Output and exit codes** — human lines: a `base` header with the changed-file
count, then one block per raised scope (its persona, tier and budget, then its
claimed paths), then the unclaimed list. `--json` top-level keys: `contract`
(`nen.review.scopes/v0.1`), `base`, `files` (how many paths the diff carried),
`scopes[]` (`scope`, `persona`, `tier`, `budget`, `paths[]` — **raised scopes
only, in the declaration's order**, never the diff's) and `unclaimed[]`.

| Code | Meaning |
|---|---|
| `0` | the classification, whether or not it raised a scope |
| `1` | the repository declares **no `review` block**, named, with the pointer to write. Not a usage error: the invocation was right and there is nothing here to classify by |
| `2` | a missing or unresolvable `--base`, or a malformed `review` block — refused by pointer by the policy loader |

**Example**

```bash
nen review scopes --base origin/main --repo ../hatsu --json
```

## Surfaces

One skills directory, rendered into the layout and frontmatter another agent
surface documents for itself. Both verbs are local — no `gh`, no network — and
neither installs anything: they write a mirror into a directory you name, and
say how the committed one differs from a fresh generation. Where a skill lives
once and has to be readable by more than one agent product, this is the copy
that is generated rather than maintained.

<a id="family-surface"></a>

**`nen surface`**

`mirror generate` writes `<out>/<name>/SKILL.md` for every `<name>/SKILL.md`
under `--source`; `mirror check` regenerates the same thing in memory and diffs
it against what is committed, exactly as [`canon mirror
check`](#nen-canon-mirror-check) does, with the same four drift classes. Every
per-surface difference — which frontmatter keys survive, how an invocation is
spelled, where a persona goes — is **a row in `src/surface/rules.ts`**, not a
branch in the generator, and each row carries the URL every fact in it was read
from. Adding a surface is adding a row.

The three mirrored rows (read 2026-09-10, re-read 2026-09-20 for the pack
fields; [#227](https://github.com/zheref/nen/issues/227)) and the verbatim one:

| | `codex` | `cursor` | `antigravity` | `claude-code` |
|---|---|---|---|---|
| skills read from | `.agents/skills/<name>/SKILL.md` ([docs](https://learn.chatgpt.com/docs/build-skills)) | `.cursor/skills/<name>/SKILL.md` ([docs](https://cursor.com/docs/context/skills)) | `.agents/skills/<name>/SKILL.md` in a workspace — `.agent/` is the back-compatibility spelling ([docs](https://antigravity.google/docs/skills)); the **mirror is laid out as a plugin**, `<out>/skills/<name>/SKILL.md` beside `agents/`, `hooks.json`, `plugin.json` and `rules/` ([plugins](https://antigravity.google/docs/plugins)), because a global install symlinks the whole mirror as the plugin root; the workspace path is the installer's target | `.claude/skills/<name>/SKILL.md`; a plugin ships `skills/` and `agents/` at its root ([docs](https://code.claude.com/docs/en/skills)) |
| frontmatter kept | `name`, `description` — the page documents no other key — plus nen's own `summary` (below) | `name`, `description`, `paths`, `globs`, `disable-model-invocation`, `icon`, `color`, `metadata` — the documented table, whole — plus `summary` | `name`, `description` | **every key**: the row is the identity |
| required | `name`, `description` | `name`, `description` | `description` (the page makes `name` optional) | `name`, `description` |
| invocation spelled | `$<name>` (*"run /skills or type $ to mention a skill"*) | `/<name>` (*"you explicitly type /skill-name in chat"*) | `/<name>` | none: nothing is rewritten |
| personas | **no markdown persona file** — every one becomes a `## <name>` section of a generated `AGENTS.md` ([docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md)); with `--models`, also one `agents/<stem>.toml` apiece (`name`, `description`, `model`, `developer_instructions`) for `.codex/agents/` | one file per persona under `<out>/agents/<stem>.md`, frontmatter reduced to `name`, `description`, `model`, `readonly`, `is_background` ([docs](https://cursor.com/docs/agent/subagents)) | one file per persona under `<out>/agents/<stem>.md`, keys `name`, `description`, `tools`, `mainAgent`, `subagent`, `model`, `commandExecutionPolicy`, `mcpServers`, `skills` ([docs](https://antigravity.google/docs/subagents)) | `agents/<stem>.md`, verbatim |
| hooks (`--hooks`) | `hooks.json` → `.codex/hooks.json`, grouped shape, events `Stop` / `PreToolUse` / `SessionStart` | `hooks.json` → `.cursor/hooks.json`, `{ version: 1, hooks: { stop, beforeShellExecution, sessionStart } }`, one `{ command }` per entry | `hooks.json` → `.agents/hooks.json`, grouped, `Stop` / `PreToolUse` (matcher `run_command`) / **`PreInvocation`** — there is no SessionStart event | `hooks/hooks.json`, byte for byte |
| model map (`--models`) | not on the appendix; `config.toml.fragment` carries `[agents] default_subagent_model = <models.codex.fast>`, and the TOML personas carry `model` | **`model: inherit` for every persona** — the page documents `model:` as inherit (the default) or a specific model ID, and a tier alias from `models.cursor` is neither, so the tier is resolved (a bad value is still refused) and reported as `modelMapped: <persona>: <tier> -> inherit`; an explicit `inherit` is carried | `model: <tier>` → `models.antigravity.<tier>`; `inherit` carried; an alias outside `inherit`/`flash`/`pro` is emitted and named | none |
| rules (`--rules`) | none — `AGENTS.md` is the prose surface, read up to 32 KiB (`project_doc_max_bytes`); an appendix past it is named in the report | `rules/<stem>.mdc` → `.cursor/rules/`, with `description: <stem>` / `alwaysApply: true` frontmatter; no character limit, the page advises under 500 lines | `rules/<stem>.md` → `.agents/rules/`, with `trigger: always_on` / `description: <stem>` frontmatter -- the page (re-read 2026-09-28) says every rules file must open with one or is silently discarded; **24,000-byte limit**, over it refused ([docs](https://antigravity.google/docs/rules)) | none |
| description budget | **186** chars | **30** chars | none | none here (the documented 1,536 is a capabilities fact) |
| permissions (`--permissions`) | `config.toml` → `.codex/config.toml` (approval policy, sandbox, `writable_roots = []` for the installer to fill) | `cli.json` → `.cursor/cli.json` (`Shell(exe:args)` / `Shell(exe)` allow/deny — the documented grammar — plus whatever `surfaces.cursor` in the source declares, verbatim) | **none** — no allowlist file exists, and `commandExecutionPolicy: auto` would approve arbitrary commands, so nothing is written and the report says `not supported` | `settings.local.json` (`Bash(exe args)` allow/deny), for the consumer to merge |

The two description budgets are **measured, not documented** — the length at
which each surface's picker cut a description off, measured 2026-09-19 in the
hardening audit — and the row says so in its `descriptionBudgetSource`. Every
other number and path in the table is a citation.

Caveats the table carries and prints on stderr, rather than acting on: a
project `.codex/config.toml` loads only for a project the user marked trusted;
Cursor documents that a skill's `name` must be lowercase letters, numbers and
hyphens and must match its folder name, which nen carries through and does not
enforce; Antigravity's workflows are deprecated (retired 2026-11-01), so the
rules file is its prose surface; and the `claude-code` row exists for
[`check --installed`](#nen-surface-mirror-check---installed) and for a mirror
that *is* the source — `generate` refuses it, because there is nothing to
generate and no marker to guard a destination with.

**The generated marker is the first *markdown* line, not the first line of the
file.** Every surface here identifies a skill by YAML frontmatter delimited by
`---` **at the start of the file**, so an HTML comment above that fence would
produce a file the surface silently declines to load — a "do not edit" banner
bought at the price of the document. So the marker sits immediately after the
closing fence (and on line 1 of `AGENTS.md`, which has no frontmatter):

```text
<!-- GENERATED by nen surface mirror (surface: cursor) -- do not edit; edit the source and regenerate -->
<!-- GENERATED by nen surface mirror (surface: cursor, stamp: 0.43.0) -- do not edit; edit the source and regenerate -->
```

It is ASCII, it names the surface — and, with `--stamp <version>`, the version
of the source it was generated from — and `check` reads it back out of that one
position only — a marker-shaped line further down the file (a quoted example, a
nested fence) is never mistaken for the real one, the same anchoring
[`canon mirror check`](#nen-canon-mirror-check) applies to its own header. Both
forms are read back; a stamped mirror checked without `--stamp` is compared
with its stamp masked, so it is not drift. The files that are not markdown
carry the same text in the comment their own format has: a TOML file
(`config.toml`, `config.toml.fragment`, `agents/<stem>.toml`) as its `# ` first
line, and a JSON file (`hooks.json`, `cli.json`, `settings.local.json`) — which
has no comment — as a top-level `"$generated"` key, the `$`-prefixed
convention every consumer of those files already ignores.

**What is mirrored, and what is not.** Only `<name>/SKILL.md` — a skill
directory's `scripts/`, `references/` and assets are left where they are, and a
mirror directory may hold them beside the generated file without either verb
touching them. A hook script named by a `--hooks` command is read from beside the manifest **as its own bytes**: one that is a symbolic link is refused at exit 2 by name rather than followed to whatever it points at. A destination under `--out` that is a symbolic link is refused the same way, before the first byte is written — a write there would land wherever the link points. A script's declared mode (0755) is applied on every generate, unchanged bytes included, and reported under `written[]` when only the mode moved. The `# ` marker goes on line 2 only where the shebang implies `#` comments (`sh`, `bash`, `zsh`, `dash`, `ksh`, `python`, `perl`, `ruby`, or no shebang); a script under any other interpreter (`node`, `deno`, `bun`, …) is carried byte for byte with no marker — a `#` line there is a syntax error, and the manifest beside it carries the marker — noted in the report, compared by bytes in `check`, never clobber-guarded (the manifest is), and outside the orphan universe.
Under `--agents`, a **`_`-prefixed file is a shared include**
a persona cites by path ("read `agents/_review-preamble.md` first"), not a
persona ([#223](https://github.com/zheref/nen/issues/223)): it is never
mirrored as a subagent nobody defined, and it is **carried as an include**
so the mirrored persona's citation lands on a file the mirror holds — on a
files-kind row as `<out>/<agents dir>/_<stem>.md` with the frontmatter
reduced like a persona's **minus `model` and `tools`, which are dropped on
every row rather than rewritten** — an include is protocol text, not an
agent, so a tier in its source has nothing to map to, and carried verbatim it
put a `model: sonnet` in an Antigravity persona file whose model key does not
admit it; `name` and `description` stay — the marker after it and the body
verbatim (no required-key check, no empty-frontmatter refusal: nothing
routes on it); on the appendix row (codex) as a `## _<stem>` section after
the personas, never a TOML persona. The report lists them under `includes[]`
(`includes (shared, carried beside the personas, not personas):` in text);
`skippedAgents[]` remains for anything else set aside — a `*.md` that is not
a regular file — and is otherwise empty. The **filename universe** these two
verbs consider their own has
**two** conditions: a file must sit at one of the row's own locations
(`<name>/SKILL.md`, the persona location, the row's hook manifest and
`hooks/` scripts, rules, permission, plugin-manifest, fragment and TOML-persona
files) **and carry a generated marker**.
An unmarked file is somebody's own work wherever it sits, so it is never
overwritten, never deleted as an orphan, and never reported as `extra` — a
`SKILL.md` written by hand in the mirror directory is as untouchable as a
`README.md` beside it. The gate is "carries *a* marker", not "carries *this*
surface's": a file generated for another surface whose source has since gone is
still this generator's output, and is exactly what `check` calls `extra` and
`generate` deletes. Both verbs read the same list, so what one reports the other
clears.

**Relative links are re-aimed for the depth each copy lands at**
([#270](https://github.com/zheref/nen/issues/270)). A body is carried
verbatim *but for its relative links*: a link is a statement about where its
file is, and the same text copied one directory deeper (antigravity's nested
`skills/<name>/`), to another depth than its source (every `agents/<stem>.md`:
`surfaces/<s>/agents/` sits a level deeper than `claude/agents/`), to the
mirror's root (codex's `AGENTS.md`) or into a TOML string (codex's
`agents/<stem>.toml`) names another file — usually none. Every relative link in a skill, a persona,
an include, an `AGENTS.md` section, a persona TOML body and the rules file is
resolved against **its source file's own directory** and then:

- when it names a **mirrored item** — a skill's `SKILL.md` or its directory, a
  persona, a shared include, the `--rules` file — it is pointed at **that
  item's copy** (a Cursor persona's `../skills/<name>/SKILL.md` becomes
  `../<name>/SKILL.md`; a skill's `../../agents/<p>.md` becomes
  `../agents/<p>.md`, and `../../rules/<stem>.md` the row's own
  `../rules/<stem>.mdc`; a link to a skill's *directory* lands on the mirror's
  directory for it, which holds only the generated `SKILL.md` — the skill's
  other files stay where they are). On **codex**, whose personas are prose, a persona's
  copy is its `## <name>` section: the link becomes `AGENTS.md#<anchor>`
  (`../AGENTS.md#<anchor>` from a skill or a persona TOML, a bare
  `#<anchor>` inside `AGENTS.md` itself), where `<anchor>` is the renderer's
  slug of the heading — or the fragment the source link already carried;
- otherwise it is pointed at **the same file on disk** — whatever its suffix,
  `.md`, `.json`, `.sh`, `.html`, an image — so antigravity's nested
  `../../../docs/<page>` becomes `../../../../docs/<page>`, a persona's
  `../../docs/<page>` becomes `../../../docs/<page>`, and a link to a file
  beside a skill in the source (`references/notes.md`) reaches that file where
  it is;

either way relative to the **destination** file's directory, the `#fragment`
kept, the form kept (`](<target>)` stays bracketed, a `"title"`, `'title'` or `(title)` stays, a
reference definition `[label]: target` is re-aimed in place). An inline link
inside a **fenced** block is still re-aimed — a reader copies a path out of a
fence, and a copied dangling path dangles the same — but a reference
definition there is not (a fence is code: `[warn]: deprecated` in it is a log
line), and nothing inside an **inline code span** is read at all, as a
renderer reads it: CommonMark's backtick-string rule (a run of N backticks
closed by the next run of exactly N in the same paragraph; a
backslash-escaped backtick opens nothing). And a `[` directly after a word
character, a `]`, a `)` or a backslash does not open a link — that is code
(`handlers[name](event)`, `xs[0](value)`) or an escaped bracket, and
re-aiming `event` as a path would corrupt the sample. Only path
arithmetic is done: whether the target exists is never asked, so a link that
dangles in the source dangles the same way in the mirror, re-aimed at the same
missing file.

**The tree a re-aimed link may reach is `--repo <path>`, else the working
directory** — the base every verb here takes. Every end (that root, the
sources, `--out`) is resolved through symlinks first, so a mirror reached
through a symlink — a plugin directory pointing at the committed mirror —
regenerates to the committed bytes. A link whose target **or** whose copy
lies outside that tree — a mirror written straight into an installed surface
(`~/.codex`, another repository's `.cursor/`) — would have to spell this
machine's layout above both, so it is **carried as written** and named in the
report (`linksVerbatim[]`, `<mirror path>: <target>`); nen never invents a
path there. A link to a **mirrored item** is always re-aimed, wherever `--out`
is: its target moves with the mirror. Run `generate` and `check` from the same
root, or pass both the same `--repo`.

Per surface, where a link to each mirrored item lands and what is left as written:

| | `codex` | `cursor` | `antigravity` | `claude-code` |
|---|---|---|---|---|
| a skill's copy | flat `<name>/SKILL.md`: a link out of the mirror gains or loses a `../` for each directory `--out` sits deeper or shallower than `--source` — none in the common `claude/skills` → `surfaces/<s>` layout | `<name>/SKILL.md`, the same | `skills/<name>/SKILL.md` — **one directory deeper**, so every link out of the mirror gains a `../` | nothing is re-aimed: the row is the identity |
| a persona's copy | its `## <name>` section of `AGENTS.md` (`#<anchor>`); the `agents/<stem>.toml` bodies are aimed from `agents/` | `agents/<stem>.md`, at another depth than its source (`surfaces/<s>/agents/` is a level deeper than `claude/agents/`) | `agents/<stem>.md`, the same | nothing |
| the rules file's copy | none (no rules row): a link to the rules source lands on the source on disk | `rules/<stem>.mdc` | `rules/<stem>.md` | nothing |
| carried as written | the forms below, plus a heading anchor a same-text heading earlier in `AGENTS.md` would displace (not computed) | the forms below | the forms below | every link |

**Carried as written, on every surface, and why**: an absolute path, any
`scheme:` target (`http(s):`, `mailto:`), a bare `#fragment` and a `~`-rooted
path do not depend on where the file sits; an HTML `href`/`src` attribute and
a path written as prose are not markdown links, and nen does not guess which
prose is a path; anything inside an inline code span, a reference definition
inside a fence, and a link written flush against a word (`foo[bar](baz)`,
which CommonMark does render — the rarer case, left alone rather than risk a
code sample) are carried too; the code-span reading does not model raw HTML or
an autolink that CommonMark would let win over a backtick, nor an indented
(four-space) code block; a footnote definition (`[^n]: text`) is not a
link definition; a target carrying a character no portable path spelling uses
(whitespace outside `<…>`, `[ ] { } ^ * | $ < > " '`, a backtick, a
backslash) is a regex or a placeholder inside an example; and a "target"
followed by anything but a title (`](a b)`) is not a link. Destinations and
titles are read by CommonMark's rules, not a pattern: a bare destination may
hold **balanced** parentheses (`a(b).md`), a `<…>` one spaces and parentheses
(`<a (b).md>`), and a title parentheses of its own — so all three are
re-aimed; unbalanced parentheses are not a link, and a link whose destination
and title are split across lines (which CommonMark allows) is read as none,
because the consumer's guard reads a link a line at a time. On **codex** the
heading anchor is the renderer's slug of the persona's name; a heading with
the same text *earlier* in `AGENTS.md` would move that anchor to `-1`, which
nen does not compute — a repository keeps its persona names unique. The
verbatim **claude-code** row rewrites nothing, links included: its copy *is*
the source's own layout.

### `nen surface mirror generate`

Reads every `<name>/SKILL.md` under `--source` and writes `<out>/<name>/SKILL.md`
— `<out>/skills/<name>/SKILL.md` on the two plugin-shaped rows, `antigravity`
and `claude-code`, whose mirror is a plugin root — with the body verbatim but
for its relative links, re-aimed for the depth the copy lands at (above), the
frontmatter reduced to the keys `--surface`'s row
documents, and — with `--invocation-prefix` — every `<prefix><name>` mention
rewritten into that surface's own spelling. Writes only files whose content
actually changed, and deletes an orphan whose source is gone (plus the directory
that emptied, if nothing else was in it).

It **never overwrites a file it did not write**. Every destination is checked
for the marker *before the first byte is written*, and a file that carries none
is refused by name at exit 2 — the case this exists for is `AGENTS.md`, which
people write by hand at the root of a project and which an `--out` pointed one
directory too high would otherwise destroy with no diff to recover it from. A
file that *does* carry the marker is overwritten freely, hand edits included:
that is the self-healing the mirror is for.

**Usage**

```text
nen surface mirror generate --source <dir> --surface codex|cursor|antigravity --out <dir>
                            [--agents <dir>] [--invocation-prefix <prefix>] [--repo <path>]
                            [--hooks <hooks.json>] [--hooks-root <expr>]
                            [--manifest <plugin.json>] [--models <nen/workflow.json>]
                            [--source-surface <name>] [--rules <file.md>]
                            [--permissions <permissions.json>]
                            [--stamp <version>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--source <dir>` | **yes** | the directory whose **subdirectories** are the skills | one holding no `<name>/SKILL.md` is refused at exit 2, never mirrored as empty: an empty generation would delete the whole mirror as orphaned, so the one plausible typo (`--source` pointed one level too high) would quietly empty it instead of saying so |
| `--surface <name>` | **yes** | which row of the table above | anything else is refused at exit 2, listing the ones that exist |
| `--out <dir>` | **yes** | where the mirror is written | a path resolving **inside** `--source` (its own directory included) is refused at exit 2 — the mirror would become part of the source, and the next run would mirror its own output. Created if absent |
| `--agents <dir>` | no | a directory of `*.md` persona files | each persona's `name:` frontmatter names it, falling back to the filename. An empty directory is fine; an empty *value* is refused. On a surface that keeps personas as **files**, a persona that would mirror to an **empty frontmatter block** — no fence in the source, or a fence holding only keys that surface does not read — is refused at exit 2: the file written would carry no frontmatter at all, and there would be nothing for the surface to route on. On a surface whose personas are **prose** (the appendix), the same file is fine, because frontmatter is not a concept there |
| `--invocation-prefix <p>` | no | the **source's own** invocation namespace, e.g. `myplugin:` | caller data, never a literal in this binary (§3), for the same reason [`canon mirror generate`](#nen-canon-mirror-generate)'s `--header-template` is a flag. Without it nothing is rewritten; with it, mentions of skills *outside* the mirrored set are rewritten too, because a half-rewritten document is worse than an unrewritten one |
| `--hooks <hooks.json>` | no | a **Claude-Code-shaped** hook manifest: `{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command", "timeout"? } ] } ], "PreToolUse": [ { "matcher", "hooks": [ … ] } ], "SessionStart": [ … ] } }` (the `hooks` wrapper may be omitted) | emitted at the row's hook file with the three events renamed to the surface's own (`Stop`→`stop`, `PreToolUse`→`beforeShellExecution`, `SessionStart`→`sessionStart` on Cursor; `SessionStart`→`PreInvocation` on Antigravity, which has no session-start event) and the same commands; a `Bash` matcher becomes the surface's own (`run_command` on Antigravity) or is dropped where the surface has none. Any other event in the manifest is left out and named in `notes[]`. A malformed group or an empty command is refused by pointer at exit 2. A row with no hooks writes nothing and reports `hooks: not supported` |
| `--hooks-root <expr>` | no | what `${CLAUDE_PLUGIN_ROOT}` in a `--hooks` command becomes — the source manifest names its root with Claude Code's own variable, which no other surface defines | every occurrence is replaced by the expression, **wrapped in double quotes inside the command** when it carries whitespace or anything a shell expands (`"${HATSU_PLUGIN_ROOT:-$HOME/.gemini/config/plugins/hatsu}"/hooks/bell.hook --mode $MODE`), so the root is one word and the command's own arguments stay separate words; a plain path (`/opt/demo`) is substituted bare. When the result still carries a `$`, or the root was quoted, the whole command is emitted as `sh -c 'exec <command>' --` with the single-quote rule (`'` → `'\''`) applied to the payload, so a surface that does not run hooks through a shell still expands it; a command that neither expands nor names the root is carried as it was. Without the flag commands are carried verbatim. Refused at exit 2 without `--hooks`, with an empty value, on the verbatim `claude-code` row (its manifest is byte for byte), and — naming the character — for a root expression or command carrying a `"`, a backtick, `$(`, a backslash or a newline, which the wrapper cannot hold safely — so on Windows a drive path is given with forward slashes (`C:/Users/me/plugins/demo`), the form Git Bash's `sh` reads. Give `check` the same expression |
| `--manifest <plugin.json>` | no | a Claude plugin manifest (`.claude-plugin/plugin.json`) | a row that documents a plugin manifest of its own — Antigravity's `plugin.json` (`name`, `version`, `description`; `name` and `description` required) — gets `<out>/plugin.json` carrying those keys from the source under a `$generated` marker; every other row reports `manifest: not supported` and writes nothing. A required key the source lacks is refused at exit 2 |
| `--models <workflow.json>` | no | a `nen/workflow.json` (or any JSON carrying its `models` block) whose `models.<surface>` maps tiers (`frontier`, `deep`, `fast`, `economy`, …) to the surface's own aliases | on a surface whose row maps models, a persona's `model: <tier>` is rewritten to `models.<surface>.<tier>` **from that file**; `model: inherit` is carried as `inherit` where the surface documents it (Cursor, Antigravity) and dropped elsewhere with a `droppedInherit[]` line. **Cursor writes `model: inherit` for every persona whatever the tier** (`modelInheritOnly` on its row): its page documents `model:` as `inherit` — the default — or a specific model ID, and a tier alias such as `composer` or `grok` from `models.cursor` is not a documented ID; the tier is still resolved, so an unknown value is still refused, and reaches only the report as `modelMapped: <persona>: <tier> -> inherit (cursor writes no model id)` (`modelMapped[]` under `--json`). Codex and Antigravity write the alias as before; a tier the file does not declare is refused at exit 2 by pointer (`models.<surface>.<tier>`), as is a file with no `models.<surface>` at all. An alias outside the surface's documented set (Antigravity documents `inherit`, `flash`, `pro`) is emitted verbatim — it is the repository's own word — and named in `undocumentedAliases[]`. **Codex** additionally gets `config.toml.fragment` carrying `[agents]` / `default_subagent_model = "<models.codex.fast>"` — a fragment the consumer merges; `config.toml` itself is never a destination for it — and one `agents/<stem>.toml` per persona for `.codex/agents/` |
| `--source-surface <name>` | no | the surface the **source** personas were written for; default `claude` — the key every real workflow spells its Claude Code row under | a canonical persona file is read directly by one surface, so its `model:` carries *that* surface's alias (`opus`), never a tier — rewriting the source to tiers would break the surface that reads it unmirrored. With `--models`, a persona's value is resolved in two steps: first as a tier of `models.<surface>` (written as-is), else as an alias under `models.<source-surface>` read back to **the one tier** it sits under (`opus` → `deep`), then tier → `models.<surface>.<tier>` (`deep` → `pro` on Antigravity). An alias under two tiers of the source row, a value that is neither, or a source row the file lacks when a persona needs it are each refused at exit 2 by pointer; in the last case, when exactly one declared row *would* resolve the alias, the refusal ends `Did you mean --source-surface <name>?` (two candidates is a choice, and nen names none). The value is a key of the caller's own `models` matrix and nothing else — a workflow that spells the row `claude-code` passes `--source-surface claude-code` |
| `--rules <file.md>` | no | a rules document | emitted at the row's rules directory as `<stem><extension>` (`rules/<stem>.mdc` on Cursor, with `description: <stem>` / `alwaysApply: true` prepended; `rules/<stem>.md` on Antigravity, with `trigger: always_on` / `description: <stem>` prepended, because that surface discards a rules file with no frontmatter), the marker first and the source under it — its relative links re-aimed like a skill's (a link to a mirrored skill lands on its copy), its invocation mentions **not** rewritten. Over the surface's documented limit (Antigravity: 24,000 bytes), counted on what is written — the re-aimed links included — it is **refused at exit 2 naming both numbers, never truncated**; past a page's line advice (Cursor: 500) it is written and a note says so. A row with no rules file reports `rules: not supported` |
| `--permissions <file.json>` | no | a permissions source: `{ "allow": [ { "exe", "args" } ], "deny": [ … ], "surfaces": { "<surface>": { "allow": [ "<row>" ], "deny": [ "<row>" ], "network_access": <boolean> } } }`; every other key is ignored | emitted as the row's pack: `settings.local.json` with `Bash(exe args)` patterns (claude-code); `cli.json` with `Shell(exe:args)` — or `Shell(exe)` when `args` is empty — patterns, Cursor's documented grammar (`Shell(commandBase)` with an optional `:args`; never `Shell(exe args)`) (cursor); `config.toml` stating the approval policy and workspace-write sandbox with **`writable_roots = []`** under a comment naming what fills it — the working tree, each linked worktree, the git common dir — never a placeholder string a consumer could copy beside a live setting; the report says `writableRootsPlaceholder: true` and adds a `note:` so an installer knows to fill it (codex). **The source decides `network_access`**: the sandbox block carries a `network_access = true|false` line **only when `surfaces.codex.network_access` declares it** (a boolean; anything else is refused by pointer); absent, no line is written — Codex's own default applies, nen never chooses a boundary the source did not state — and the report says `network: not declared (no network_access line; the surface's own default applies)`, or `network: declared (network_access = true)` when it was (`permissionNetworkAccess` under `--json`: the boolean, or null). A `network_access` under a surface whose pack states no sandbox (cursor, claude-code) is refused, since it has no line to land on. **Nothing the source did not declare is written**: the `Read(./**)` / `Write(./**)` grants Cursor needs come from a `surfaces.cursor.allow` block in the source, transcribed verbatim after the shared rows *for that surface only* and counted in the report as `permissions: written (+N surface rows)` (`permissionSurfaceRows` under `--json`); a block for a surface whose pack has no rows (codex) is refused. Antigravity has no allowlist file, so nothing is written and the report says `permissions: not supported`. A malformed row is refused by pointer, as is a `(` or `)` in an `exe` or `args` — every pack wraps the row in the surface's own `Tool(...)`, and a parenthesis inside it would close that early |
| `--stamp <version>` | no | `MAJOR.MINOR.PATCH` of the source (a `-pre`/`+build` tail is accepted and ignored) | written into every marker as `, stamp: <version>`; anything not version-shaped is refused at exit 2 |
| `--dry-run` | no | compute the same three lists and write nothing | including the orphans it would delete |
| `--repo <path>` | no | the tree a re-aimed relative link may reach; default the working directory | a link whose target or copy lies outside it is carried as written and listed under `linksVerbatim[]`; a link to a mirrored item is re-aimed wherever `--out` is. Resolved through symlinks, like `--source` and `--out`. The path flags themselves still resolve against the working directory, as they always have — `--repo` does not rebase them. A value that is empty or does not exist is refused at exit 2. Give `check` the same `--repo` |

**Hook scripts travel with the manifest.** On every non-verbatim row, each
script a `--hooks` command names as `${CLAUDE_PLUGIN_ROOT}/hooks/<file>` is
read from beside the manifest and written to `<out>/hooks/<file>`, mode 755,
with the marker as a `# ` comment on line 2 after the shebang (line 1 when
there is none) — so a plugin-mode install, the mirror symlinked as the plugin
root, resolves the commands to files it ships. They are reported under
`written[]`, they are in `check`'s universe, and a manifest naming a script
that is not beside it is refused at exit 2.

**On Windows, mode 755 is what NTFS can hold of it: a writable file.** NTFS
stores no POSIX permission bits — `chmod` there sets or clears only the
read-only attribute, from the owner-write bit, and `stat` reports `0666` or
`0444` — so a hook script cannot be marked executable on the file itself. On
`win32`, `generate` and `check` compare a script's mode in those terms:
a freshly generated script is `ok` and regenerates as `unchanged`; one
whose read-only attribute was set by hand is `hand-edited`, and a regenerate
clears it and reports it under `written[]`. Where the executable bit matters
— a mirror committed from a Windows checkout and installed on macOS or Linux —
it is git's to record (`core.fileMode` is false on Windows):
`git update-index --chmod=+x hooks/<file>`. Nen never sets it there.

**The description budget.** Where the row states one (codex 186, cursor 30 —
both measured, neither documented), a skill whose `description` is longer keeps
it **as-is** and gains a `summary:` key holding its first sentence trimmed to
the budget (at the last whitespace inside it, or hard at the budget when there
is none) — inserted right after `description`, and never added over a
`summary` the source already carries. Each such skill is listed in
`truncated[]`. `summary` is nen's key, not the surface's: an extra frontmatter
line the surface ignores, holding the sentence its picker would otherwise cut.
The sentence, and the budget it is measured against, are read from the
description's **text**: a folded or literal block scalar (`>`, `>-`, `|`,
`|+2`, …) contributes its lines, never its header (zheref/nen#328). The
`summary:` line itself always parses as the string it holds: it is written
plain where YAML 1.2 and 1.1 both read it back as that string, and
double-quoted otherwise (an opening indicator character, `: `, ` #`, a
trailing `:`, a control or line-break character, or a value such as `1.`,
`yes` or `2026-10-02` a parser would read as a number, bool or date). A
summary with none of those keeps the bytes earlier builds wrote. The
`summary:` line is nen's; a source `description:` that is itself invalid YAML
is copied as written and stays invalid. **On upgrade**, a mirror an earlier
build wrote with an unquoted summary that now needs quoting reads **stale**
(never hand-edited) until it is regenerated once.

**Output and exit codes** — prints `surface:`, `out:`, `stamp:` (when given),
then `written:`, `unchanged:` and `deleted (orphaned):` (each `(none)` when
empty), then the report lines that apply: `includes (shared, carried beside
the personas, not personas):`, `skipped (not a regular file):`, `truncated (…):`, `model: inherit dropped (…):`, `model alias
outside the surface's documented set (…):`, `modelMapped: … (<surface> writes no model id)`, and always `hooks:`, `rules:` and
`permissions:` and `manifest:` (`none` when the flag was not given, `not
supported` when the row has no such file, else what was written), a
`network:` line after `permissions:` when the pack states a sandbox (codex),
then `links re-aimed for this mirror's depth: <n>` when any link moved and
`links left as written (the target or the copy is outside <root>, the tree
--repo names): <mirror path>: <target>, …` when any was declined, then any
`note:` lines; the row's
caveat goes to **stderr**, so `--json` stays one document. `--json`:
`{ contract: "nen.surface.mirror.generate/v0.1", surface, skillsPath, out,
dryRun, written, unchanged, deleted, stamp, skippedAgents, truncated,
droppedInherit, undocumentedAliases, modelMapped, hooks, rules, permissions, manifest, notes,
permissionSurfaceRows, writableRootsPlaceholder, permissionNetworkAccess, includes,
linkRoot, linksRewritten, linksVerbatim }` — the
keys after `deleted` are v0.13.0's, appended at the end of the key order, and
the last three are [#270](https://github.com/zheref/nen/issues/270)'s, appended
after them: `linkRoot` is the real path of the tree a re-aimed link may reach,
`linksRewritten` the number of relative links re-aimed (counted per generated
file), `linksVerbatim` every `<mirror path>: <target>` carried as written
because it would have left that tree (sorted, `[]` when none);
`modelMapped` is `[]` except on a `modelInheritOnly` row (cursor) and
`permissionNetworkAccess` is the declared boolean or null;
`rules` is `"none"`, `"not supported"` or `{ path, chars, limit }`. Exit 0 on
any completed run; exit 2 on a missing or unknown flag, a `--repo` that is
empty or does not exist, an `--out` inside
`--source`, a `--source` with no `SKILL.md`, a `SKILL.md` with no frontmatter
block or missing a key the surface documents as required, a rules file over the
surface's limit (its links re-aimed), a tier `--models` does not declare, a malformed pack file, a
stamp that is not a version, the verbatim `claude-code` row, or a destination
that exists and carries no marker.

**Example**

```bash
nen surface mirror generate --source src/surface/fixtures/skills \
  --agents src/surface/fixtures/agents --surface cursor \
  --out /tmp/nen-doc/cursor --invocation-prefix "demo:"
```
```text
nen: note: cursor: this surface documents that a skill's `name` must be lowercase letters, numbers and hyphens and must match its folder name; nen mirrors the folder name and the `name` line it was given, and refuses neither.
surface: cursor (.cursor/skills/<name>/SKILL.md)
out: /tmp/nen-doc/cursor
written: agents/_shared.md, agents/scout.md, alpha/SKILL.md, beta/SKILL.md
unchanged: (none)
deleted (orphaned): (none)
includes (shared, carried beside the personas, not personas): _shared.md
truncated (description over the 30-char budget; summary: added): alpha, beta
hooks: none
rules: none
permissions: none
manifest: none
```
The `alpha` skill's source frontmatter carries `name`, `description`,
`allowed-tools`, `model`, `license` and `metadata`; what lands in the mirror is
`name`, `description`, a `summary` (both fixture descriptions are over Cursor's
30-character budget) and `metadata`, and every `demo:alpha` in the body — and
in the description — has become `/alpha`. Under `--surface codex` the same
source produces `name` and `description` only (both descriptions fit its
186-character budget), `$alpha`, and one `AGENTS.md` holding a `## scout`
section instead of `agents/scout.md`, followed by a `## _shared` section for
the include.

The full pack, stamped, with every optional file:

```bash
nen surface mirror generate --source claude/skills --agents claude/agents \
  --surface antigravity --out surfaces/antigravity --invocation-prefix "hatsu:" \
  --hooks hooks/hooks.json --models nen/workflow.json --rules docs/rules.md \
  --permissions contracts/permissions.json --stamp 0.43.0 --json
```
```json
{
  "contract": "nen.surface.mirror.generate/v0.1",
  "surface": "antigravity",
  "skillsPath": ".agents/skills/<name>/SKILL.md",
  "out": "surfaces/antigravity",
  "dryRun": false,
  "written": ["agents/kurapika.md", "…", "hooks.json", "hooks/guard-base-branch.sh", "hooks/stop-bell.sh", "ren/SKILL.md", "rules/rules.md"],
  "unchanged": [],
  "deleted": [],
  "stamp": "0.43.0",
  "skippedAgents": ["_shared.md"],
  "truncated": [],
  "droppedInherit": [],
  "undocumentedAliases": ["illumi: flash_lite"],
  "modelMapped": [],
  "hooks": "written",
  "rules": { "path": "rules/rules.md", "chars": 4257, "bytes": 4301, "limit": 24000 },
  "permissions": "not supported",
  "manifest": "none",
  "notes": [],
  "permissionSurfaceRows": 0,
  "writableRootsPlaceholder": false,
  "permissionNetworkAccess": null,
  "includes": ["_review-preamble.md"],
  "linkRoot": "/home/me/checkout",
  "linksRewritten": 223,
  "linksVerbatim": []
}
```
The same command with `--surface codex` writes `AGENTS.md`, one
`agents/<stem>.toml` per persona, `config.toml` (the pack, its
`writable_roots = []` left for the installer and `writableRootsPlaceholder:
true` in the report, and `network_access` only as `surfaces.codex.network_access`
declares it — `network: not declared` otherwise) and `config.toml.fragment`
(the `[agents]` default), and reports `rules: not supported`; with
`--surface cursor` it writes `agents/<stem>.md` with `model: inherit` for
every persona (the tier under `modelMapped`), `hooks.json`, `cli.json`
(`Shell(exe:args)` rows plus whatever `surfaces.cursor` declares) and
`rules/rules.mdc`.

### `nen surface capabilities`

What a RUNNING SESSION on a surface can do, as data with a citation per row (v0.11.0, zheref/nen#216;
v0.13.0, zheref/nen#227), contract `nen.surface.capabilities/v0.1` -- so a skill branches on a fact rather
than on prose that was true the day it was written. Four surfaces: `claude-code`, `codex`, `cursor`,
`antigravity` (the mirror table in `nen surface mirror` carries the same four; this table answers a different
question about them, and a test holds the two to the same answer where they overlap).

```
nen surface capabilities --surface <name> [--json]
nen surface capabilities [--json]          # every surface
```

Per row: `ask` (the multiple-choice tool), `subagent`, `hooks.{file, stop, preToolUse, sessionStart,
decisionKey}`, `worktreeIsolation`, `sandboxExtraRoots` (a linked worktree must declare the main git
directory as an extra writable root), `artifact`, `notify`, `permissionsFile`, `agentModelKey`, and since
v0.13.0 `hookEvents[]` (every event the surface documents, in its own spelling), `rulesFile` and `rulesLimit`
(characters, or null), `descriptionBudget` with `descriptionBudgetSource` (which says "measured" where no page
states the number and "documented" with the page where one does), `permissionsShape` (the pack shape
`nen surface mirror generate --permissions` writes: `claude-settings`, `codex-toml`, `cursor-cli-json`, or
null where it writes none), then `source` and a `caveat`. In text the new facts render as `permissions
shape:`, `hook events:`, `rules file: … (limit N bytes)` and `description budget: N chars (source)`.

**`--json`** — one surface: `{ contract: "nen.surface.capabilities/v0.1", surface, ask, subagent, hooks, worktreeIsolation,
sandboxExtraRoots, artifact, notify, permissionsFile, agentModelKey, hookEvents, rulesFile, rulesLimit, descriptionBudget,
descriptionBudgetSource, permissionsShape, source, caveat }`; every surface: `{ contract, surfaces: [ … ] }`. An unknown surface exits 2 naming the four. Facts read 2026-09-19 and re-read 2026-09-20; when a row goes wrong, re-read
the page in the row and change the row.

### `nen surface mirror check`

Regenerates from the SAME inputs `generate` uses and diffs the result against
`--out` **without writing anything** — the CI-safe half of the pair. A file is:

| Class | Meaning |
|---|---|
| `ok` | byte-identical to a fresh generation |
| `missing` | the source has it; `--out` has not |
| `extra` | `--out` has it, in the mirror's filename universe, and no source produces it |
| `stale` | it carries a marker, but for a **different surface** — really generated, really out of date |
| `hand-edited` | the marker is for this surface and the bytes differ, or the marker was deleted outright — or the bytes match but a file that declares a mode (a `hooks/` script, 0755) sits under another one: a hook at 0644 is one the surface cannot run. On Windows the mode is compared as the read-only attribute alone, the one mode bit NTFS holds — a read-only script is `hand-edited`, a writable one is not ([generate](#nen-surface-mirror-generate) says why) |
| `stale` (with `--stamp`) | the marker is for this surface but carries **no stamp, or a stamp other than `--stamp`** — an older one is the case that matters (a mirror generated from an older source than the one now asked about); a newer one is not this source's either. A file with no stamp is stale **only when `--stamp` is given**; without it the stamp is masked on both sides and never a drift class. A marker whose stamp is not a `MAJOR.MINOR.PATCH` version is stale too, named like any other — never an exit-2 refusal, which could not have reported the file it was asked about. Ordering: a missing marker is `hand-edited`, another surface's is `stale`, then the stamp, then the bytes |
| `stale` (an older build) | the marker is for this surface (and the stamp, if asked, matches), and the bytes are **byte for byte what a build before [#270](https://github.com/zheref/nen/issues/270) generated from these same inputs** — its relative links carried as written rather than re-aimed. Really generated, by an older nen, so the regeneration is forced rather than optional, and `hand-edited` would send its maintainer looking for an edit nobody made. A file whose links moved AND that somebody also edited is `hand-edited`. Checked after the stamp, before the bytes |
| `stale` (aimed from elsewhere) | the bytes are a fresh generation's **once every relative link that leaves the mirror is masked on both sides** — the links inside it (to a mirrored skill, persona, include or rules file, or a directory holding one) must still match. The mirror was really generated, for another location: a **copied install**, or a `generate` run from another root or `--repo` than this check. The text report names these files on a line of their own, `stale because their links out of the mirror are aimed from another location (…): <files>`; the `--json` shape does not change (they are in `stale`). A hand edit confined to such a link's target reads `stale` too — either way the check fails and a regenerate heals it. Checked after the older-build case |

`stale` is where [`canon mirror check`](#nen-canon-mirror-check)'s `--ref` sits
in this verb: the facts the marker carries are the **surface** and, when
stamped, the **source version**, and a mirror generated for one surface and
checked against another — or stamped from an older source than the one now
asked about — is exactly that verb's stale case. Calling it hand-edited would
send its maintainer looking for an edit nobody made. On the verbatim
`claude-code` row there is no marker to read, so a file is `ok` when its bytes
match the source and `hand-edited` otherwise, and `stale` is never reported.

**Usage**

```text
nen surface mirror check --source <dir> --surface <name> --out <dir>
                         [--agents <dir>] [--invocation-prefix <prefix>] [--repo <path>]
                         [--hooks <hooks.json>] [--models <workflow.json>]
                         [--rules <file.md>] [--permissions <permissions.json>]
                         [--stamp <version>] [--json]
```

**Arguments** — the same as `generate`, minus `--dry-run`, which is **refused**
here (exit 2) rather than ignored: this verb never writes, so a flag saying "do
not write" would be an instruction accepted and dropped. Give the same pack
flags the generate run had: a `hooks.json` the check does not regenerate is a
file it reports as `extra`, and one it regenerates but the mirror lacks is
`missing`. `--stamp <version>` compares the marker's stamp by version
(numerically, component by component; a `-pre`/`+build` tail is ignored).
Give the same `--repo` (or run from the same directory) as well: the re-aimed
links are part of the generation, and a check run from another root
regenerates them for that root.

**Output and exit codes** — prints `surface:`, `stamp:` (when given),
`ok: <n>`, then `missing:`, `extra:`, `stale:` and `hand-edited:` (each `(none)`
when empty), with a `stale because their links out of the mirror are aimed
from another location (…): <files>` line after `stale:` only when some are
(text only — the `--json` shape below is unchanged). `--json`: `{ contract: "nen.surface.mirror.check/v0.1", surface,
ok, missing, extra, stale, handEdited, stamp }` — `stamp` (the value asked
about, or null) is v0.13.0's, appended at the end; the contract stays v0.1
because nothing before it moved. Exit **0** when all four drift lists are
empty; exit **1** on any drift; exit 2 on the same refusals `generate` has,
plus `--dry-run`.

**Example**

```bash
nen surface mirror check --source src/surface/fixtures/skills \
  --agents src/surface/fixtures/agents --surface cursor \
  --out /tmp/nen-doc/cursor --invocation-prefix "demo:"
```
```text
surface: cursor
ok: 1
missing: beta/SKILL.md
extra: gamma/SKILL.md
stale: (none)
hand-edited: alpha/SKILL.md
```
(exit 1, after `beta/SKILL.md` was deleted from the mirror, a paragraph was
appended to `alpha/SKILL.md`, and a `gamma/SKILL.md` with no source was left
behind. Re-running `generate` heals all three at once — `written: alpha/SKILL.md,
beta/SKILL.md`, `deleted (orphaned): gamma/SKILL.md` — and the check then exits 0)

A stamp check:

```bash
nen surface mirror generate --source claude/skills --surface codex --out surfaces/codex --stamp 0.42.0
nen surface mirror check    --source claude/skills --surface codex --out surfaces/codex --stamp 0.43.0 --json
```
```json
{
  "contract": "nen.surface.mirror.check/v0.1",
  "surface": "codex",
  "ok": [],
  "missing": [],
  "extra": [],
  "stale": ["AGENTS.md", "alpha/SKILL.md", "beta/SKILL.md"],
  "handEdited": [],
  "stamp": "0.43.0"
}
```
(exit 1: every file was generated, from `0.42.0`; with `--stamp 0.42.0`, or with
no `--stamp` at all, the same mirror is `ok` and the check exits 0)

<a id="nen-surface-mirror-check---installed"></a>

#### `check --installed <dir>`

The same check, against a copy somebody **installed** on this host rather than
the committed mirror ([#227](https://github.com/zheref/nen/issues/227)): the
Claude plugin cache (`~/.claude/plugins/cache/<plugin>/<plugin>/<version>/claude`),
a consumer's `.codex/`, `.cursor/` or `.agents/`. A warm-up that runs it copies
only on drift, and says which file drifted rather than "something did". It
reads the installed tree and writes nothing to it.

**Usage**

```text
nen surface mirror check --source <dir> --surface <name> --installed <dir>
                         [--agents <dir>] [--invocation-prefix <prefix>]
                         [--hooks <hooks.json>] [--models <workflow.json>]
                         [--rules <file.md>] [--permissions <permissions.json>]
                         [--stamp <version>] [--json]
```

**Arguments** — the same inputs as `check`, with `--installed <dir>` **in place
of** `--out`; giving both is refused at exit 2 (the installed copy *is* the
directory being checked). `--installed` is `check`'s flag only — on `generate`
it is refused as not read. The generation is fresh and in memory, from exactly
the inputs given; the installed tree is compared against it file by file with
the same five classes: `ok`, `missing` (generated, not installed), `stale`
(installed from another surface or, with `--stamp`, another version),
`hand-edited` (installed bytes differ), `extra` (in the installed tree's mirror
universe, with no source).

**Relative links are regenerated for the installed directory's own location**,
resolved through symlinks. An install that is a **symlink** to the committed
mirror (a plugin directory pointing at `surfaces/<s>`) resolves to it and
compares clean. An install that is a **copy** placed outside `--repo` carries
its links out of the mirror as they were aimed where it was generated, while
the fresh generation for its location carries them as written (see *the tree
a re-aimed link may reach*): such a file is `stale` (aimed from elsewhere),
named on the `stale because …` text line, and never `hand-edited` unless its
prose or a link inside the mirror changed too. A fresh copy therefore exits
1 with only `stale` — generate into the installed location itself
(`generate --out <installed dir>`) to make it `ok`, or check the committed
mirror with `--out`.

**`--surface claude-code`** is the case the verbatim row exists for: a Claude
Code plugin's installed copy is the source tree itself, so the "generation" is
the identity — `skills/<name>/SKILL.md` and `agents/<stem>.md` copied byte for
byte, every frontmatter key kept, nothing rewritten, no marker. Point
`--installed` at the directory holding `skills/` and `agents/` (for a plugin
whose manifest maps them under `claude/`, that is `<cache>/claude`); a
`hooks/hooks.json` given with `--hooks` is compared verbatim too. A
`_`-prefixed file under `agents/` is a shared include on both sides and is
never `extra`. `generate` on this row is refused: there is nothing to generate.

**Output and exit codes** — prints `surface:`, `installed:`, `stamp:` (when
given), `ok: <n>`, then the four drift lists. `--json`: `{ contract:
"nen.surface.mirror.check-installed/v0.1", surface, ok, missing, extra, stale,
handEdited, installed, stamp }`. Exit **0** on a fresh install; exit **1** on
any drift; exit 2 on `check`'s refusals plus `--installed` with `--out`.

**Example**

```bash
nen surface mirror check --source claude/skills --agents claude/agents \
  --surface claude-code --installed ~/.claude/plugins/cache/hatsu/hatsu/0.43.0/claude --json
```
```json
{
  "contract": "nen.surface.mirror.check-installed/v0.1",
  "surface": "claude-code",
  "ok": ["agents/kurapika.md", "…", "skills/ren/SKILL.md"],
  "missing": [],
  "extra": [],
  "stale": [],
  "handEdited": ["skills/breath/SKILL.md"],
  "installed": "/Users/me/.claude/plugins/cache/hatsu/hatsu/0.43.0/claude",
  "stamp": null
}
```
(exit 1, after one byte of the installed `breath/SKILL.md` was changed; on a
fresh install the same command exits 0 with every file under `ok`)

## Self-hosted runners

Registering, proving and switching on a pool of self-hosted GitHub Actions
runners for one repository — every deterministic step a verb, and the one
step that is not deterministic (the elevated act on the host) rendered for a
human and never performed. Nen **never mints a registration token, never sees
a service account's password and never runs the host script**: the script
mints its own token with `gh` inside the elevated process, the password is
typed into the script's own prompt, and the launch is the maintainer's
consent (a UAC prompt on Windows, their own `sudo` on Linux). The pools come
from the [`runners` block](#nenworkflowjson) of `--repo`'s
`nen/workflow.json`.

<a id="family-runner"></a>

**`nen runner`**

Seven verbs in the order a provisioning run uses them: `inventory` (what the
repository has), `plan` (what to add, where, as whom, from which package),
`script` (the host script that adds it), `verify` (the runners came up),
`workflow` (the pool's preflight workflow, rendered from a caller's template),
`preflight` (dispatch it and wait for a verdict — the only check that runs
**as the service**), and `enable` (set the pool's repository variable, only on
a green preflight). `--target` defaults to `--repo`'s `origin` for the four
that read or render; `preflight` and `enable` write to GitHub and require it.
Exit codes: `0`, `1` (the verb's own failure — **including a GitHub refusal or
an unreadable answer**: this CLI reserves no code for a network failure, the
same reading [`pr ready`](#nen-pr-ready) gives "GitHub could not be read"),
`2` (usage, or no or a malformed `runners` block), and `5` (`gh` could not be
started — the [`shu`](#family-shu) family's "the declared program could not
be started", reused because it is the same fact).

**Not in this release**, named rather than implied: runner removal and
deregistration; `--ephemeral` supervisors; a shared `_work/_actions` cache
across the runners of one host; runner groups (an organization-account
feature — every consumer here is on a user account, where runners are
repository-scoped). The Windows ARM64 and Linux ARM64 host scripts are
**rendered** (the architecture is data) and have not been executed anywhere.

### `nen runner inventory`

Reads `GET /repos/{owner}/{repo}/actions/runners` — every page, never a
silent cap — and `GET .../actions/runners/downloads`, the runner package
GitHub offers the repository today with its SHA-256. Each runner's name is
parsed against the one convention, `<MachineCode>-<ConsumerCode>R<N>`
(`^([A-Za-z0-9]+)-([A-Za-z0-9]+)R([1-9][0-9]*)$`); a name that does not read
as it is **runner 0**, a grandfathered runner, reported and never renamed.
With `--repo` or `--pool`, each runner is matched to the declared pools by a
**superset** of the pool's three labels, compared case-insensitively as
GitHub's scheduler compares them — a runner carrying an extra label still
matches, exactly as a job would land on it.

**Usage**

```text
nen runner inventory [--target <owner/name>] [--repo <path>] [--pool <id>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | no | the GitHub repository | defaults to `--repo`'s `origin`; a malformed slug is exit 2 |
| `--repo <path>` | no | the checkout whose `runners` block groups the list | given explicitly (or with `--pool`), the block is required: absent or malformed is exit 2 |
| `--pool <id>` | no | report one pool | `unpooled` is still measured against every declared pool |
| `--json` | no | the report | — |

**Output and exit codes** — human: a count line, one table of runners (name,
status, busy/idle, os, labels, machine, consumer, slot), then one line per
pool and the unpooled names. `--json` top-level keys: `target`, `runners[]`
(`name`, `id`, `os`, `status`, `busy`, `labels[]`, `convention`
`named`\|`runner-0`, `machine`, `consumer`, `slot`), `downloads[]` (the API's
own `os`, `architecture`, `filename`, `download_url`, `sha256_checksum`),
`pools[]` (`id`, `labels[]`, `runners[]` names, `online`, `free` — online and
not busy) and `unpooled[]`; the last two are `null` when no policy was read.
Exit 0 when GitHub answered; 1 when it refused — a 403 is worded **"needs
admin on `<target>`"**, because listing runners is a repository-admin
operation; 5 when `gh` cannot be started.

**Example**

```bash
nen runner inventory --target zheref/nen --repo .
```
```text
zheref/nen: 3 self-hosted runner(s)
| name     | status | busy | os    | labels                  | machine | consumer | slot |
| -------- | ------ | ---- | ----- | ----------------------- | ------- | -------- | ---- |
| RJ2-NNR1 | online | idle | macOS | self-hosted,macOS,ARM64 | RJ2     | NN       | 1    |
| RJ2-NNR2 | online | idle | macOS | self-hosted,macOS,ARM64 | RJ2     | NN       | 2    |
| RJ2-NNR3 | online | idle | macOS | self-hosted,macOS,ARM64 | RJ2     | NN       | 3    |
pool windows-x64 [self-hosted, Windows, X64]: 0 runner(s), 0 online, 0 free
pool macos-arm64 [self-hosted, macOS, ARM64]: 3 runner(s), 3 online, 3 free -- RJ2-NNR1, RJ2-NNR2, RJ2-NNR3
unpooled: (none)
```
(run for real against zheref/nen, 2026-09-30)

### `nen runner plan`

Pure computation over the inventory and the declaration: which runners to add,
where, as whom, from which package. **Slots** are the lowest `--count`
positive integers not already held by a runner whose parsed machine and
consumer are these ones, in any pool (a name is unique per repository, and
compared without regard to case). The **consumer code** is
`--consumer-code`, else the one `nen/repos.json` `product_codes` key whose
value names `--target`; none or several is exit 2 asking for the flag. The
**root** is `--root`, else the pool's `root.<windows|linux|darwin>` for the
pool's OS, else the built-in `C:\GithubRunners`, `/opt/actions-runners` or
`~/actions-runners`; a `~` is expanded here, from this process's `HOME`, and
only when this process runs on the pool's OS (anywhere else it is exit 2 —
pass `--root`). The project directory is `<root>/<repo name>-runners` and each
install directory `<project>/Runner<slot>`, **written in the target host's
separators**, not this process's. The **identity** is `--service-account`:
on Windows a LOCAL account, stored `.\<name>` (an e-mail or a domain account
is refused — a Microsoft account cannot be a service logon), or
`network-service` only by that explicit word; on Linux the user `svc.sh
install` takes (never `root`); on macOS none (a LaunchAgent runs as the user
who installs it, stored `invoking-user`). Unnamed, it is `ask`, and
[`runner script`](#nen-runner-script) refuses to render it.

**An interactive Windows pool** (`mode: interactive`, #333) is a runner in a
signed-in desktop session, started at its identity's logon, never a service.
Its identity must be an account that can log on interactively: a LOCAL
account, stored `.\<name>` (for a Microsoft account, the local account
Windows created for it, as `whoami` prints it after the backslash). The
built-in service identities — `network-service`, `NetworkService`,
`LocalService`, `LocalSystem`, `SYSTEM`, in any case — are refused, exit 2:
they have no desktop session, so the logon task would never fire. Whether the
named account exists and is enabled is the host's to answer, and the
rendered script checks it there; whether it holds *Allow log on locally* is
checked by nobody. Every rendering of the plan says what that
costs: the runner is **online only while that account is signed in** (or
auto-logged on, which nen never configures), and every job it takes runs with
that account's profile and credentials — and that is **every** job such a
runner takes, not only the ones asking for `desktop`: GitHub gives a job to
any runner carrying all of its labels, so a runner labelled
`[self-hosted, Windows, X64, desktop]` also takes every job aimed at
`[self-hosted, Windows, X64]` on that repository ([`runner
inventory`](#nen-runner-inventory) counts it in both pools for that reason).
A UI job also needs that session **active and unlocked**, with `run.cmd`'s
console window open: a locked screen or a disconnected session still has a
non-zero session id, which the preflight probe accepts. When the identity is **the account
computing the plan** — `USERNAME`, compared without regard to case, and only
when the plan is computed on Windows — the plan prints a `warning:` naming it
as your own daily account and records `dailyAccount: true`;
[`runner script`](#nen-runner-script) then renders it only with
`--accept-daily-account`, and makes the same check again itself when it runs
on Windows, so a plan computed on another host is caught where it is
rendered. Use a dedicated local account instead.

**One account is one trust domain (#330).** Every runner service that logs on
as the same account can rewrite every other one's binaries and `_work` (on
Windows, `config.cmd` gives the account's `GITHUB_ActionsRunner_*` group full
control of each `Runner<N>`), so a public repository's CI — one compromised
dependency — could persist into a private repository's jobs and their token.
So when this verb runs **on the pool's own OS** (Windows or Linux) with a
named account, it reads this host's existing `actions.runner.*` services,
read-only, with these tools:
- Windows: `Get-CimInstance Win32_Service` returns each service's `Name`,
  `StartName` and the account's SID. Windows PowerShell is started by its
  full path under `%SystemRoot%`.
- Linux: `systemctl list-units`, then `systemctl show -p Id -p User`.

It resolves **every** service's repository from its service name
(`gh api --method GET repos/<owner>/<repo>`). No prefix is trusted:
`actions.runner.zheref-nen.docs.R1` is `zheref/nen.docs`. Splits are tried
from the last dot first and with the target's owner first, and the first split
GitHub answers for wins. A name that no split resolves (actions/runner shortens
long ones on Windows) is reported as unresolved, as is one that `gh` could not
read. Visibility here means `public`, `private` or `internal`. It then
**warns, on stderr, at exit 0**, about two things:
- **The planned account is shared.** Services that log on as the planned
  account and serve another repository whose visibility differs from the
  target's, or cannot be determined, are named with their repositories. How the
  account is matched:
  - Windows: `.\name` or `<COMPUTERNAME>\name`, ignoring case and spaces.
    `network-service` matches SID `S-1-5-20` or the spelling `NT AUTHORITY\NETWORK SERVICE`
    that actions/runner writes, which is localized on a non-English host.
  - Linux: the user name, matched exactly.

  The warning recommends a per-repository account: `runner-<repo>`, else
  `runner-<owner>-<repo>`, else `runner-<repo>-2`, `-3` and so on, each
  trimmed to what the OS accepts (Windows 20 characters, Linux 32). It picks
  the first name that no other repository's runner service on this host
  already logs on as, so two owners' `shared` repositories, or a long name
  shortened, never end up recommended into one account. A service row the read
  cannot vouch for (no name, no logon account) makes the whole read a `note:`.
- **The target's own runners keep a shared account.** A new account moves
  only the runners this plan adds. The target's existing services on another
  account that also serves a repository of different or unknown visibility
  are named. They keep that account until they are removed and registered
  again under the new one.

**You** create the account; nen never creates an account or handles its
password. nen still accepts a shared account (the maintainer's ruling on #330:
warn and recommend, never refuse). The plan itself, on stdout under `--json`
and in `--out`, is unchanged. Off the pool's OS the check cannot see the host,
so it prints a `note:` saying it did not run. A failed host read is also a
`note:`, never an exit. macOS is not checked: a LaunchAgent runs as the
installing user, so there is no account to choose. An interactive Windows
pool's runners are logon tasks, not services, so this read does not see
them: an account they share is not reported.

**Usage**

```text
nen runner plan --pool <id> --machine-code <CODE> --count <n> [--target <owner/name>] [--repo <path>] [--root <dir>] [--service-account <name>] [--consumer-code <CODE>] [--out <file>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--pool <id>` | yes | one pool of the `runners` block | an unknown id is exit 2, listing the declared ones |
| `--machine-code <CODE>` | yes | the host's code in every name | upper-cased; one to eight letters or digits, else exit 2 |
| `--count <n>` | yes | how many to add | 1 to 16, else exit 2. There is no default |
| `--target <owner/name>` | no | the repository | defaults to `--repo`'s `origin` |
| `--root <dir>` | no | the runner root | the declaration's default is used otherwise |
| `--service-account <name>` | no | the service identity | see above; `ask` when absent |
| `--consumer-code <CODE>` | no | the consumer code | letters and digits |
| `--out <file>` | no | also write the plan JSON there | resolved against `--repo` |
| `--json` | no | the plan | — |

**Output and exit codes** — human: the count, the labels line, the mode, the
identity (and, for an interactive Windows pool, its `note:` and `warning:`
lines), the package with its SHA-256, the project directory, a table (slot,
name, install dir, service — `logon task` for an interactive Windows pool),
and the names this machine and consumer already hold.
`--json` (and `--out`) is the plan, contract **`nen.runner.plan/v0.2`** — a
program reads it back, so [`runner script`](#nen-runner-script) refuses one it
cannot vouch for — top-level keys: `contract`, `target`, `pool`, `os`, `arch`,
`mode`, `labels[]`, `machineCode`, `consumerCode`, `root`, `projectDir`,
`identity`, `dailyAccount`, `runnerVersion`, `download` (`os`,
`architecture`, `filename`, `download_url`, `sha256_checksum`), `runners[]`
(`slot`, `name`, `installDir`, `serviceName` — GitHub's own
`actions.runner.<owner>-<repo>.<name>`, also the logon task's name) and
`existing[]`. v0.2 added `mode` and `dailyAccount`; a `v0.1` plan still
reads, as the service plan it was. Exit 0; 1 when GitHub refused, offers no package for the
pool's OS and architecture, or a planned name is already registered; 2 for
every usage refusal above and a missing `runners` block; 5 without `gh`.

**Example**

```bash
nen runner plan --repo . --target zheref/nen --pool windows-x64 --machine-code NZ --count 3 --service-account lordzheref
```
```text
plan: 3 runner(s) for zheref/nen, pool windows-x64
labels: self-hosted,Windows,X64
mode: service
identity: .\lordzheref
download: actions-runner-win-x64-2.337.0.zip (runner 2.337.0, sha256 1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc)
project dir: C:\GithubRunners\nen-runners
| slot | name    | install dir                          | service                           |
| ---- | ------- | ------------------------------------ | --------------------------------- |
| 1    | NZ-NNR1 | C:\GithubRunners\nen-runners\Runner1 | actions.runner.zheref-nen.NZ-NNR1 |
| 2    | NZ-NNR2 | C:\GithubRunners\nen-runners\Runner2 | actions.runner.zheref-nen.NZ-NNR2 |
| 3    | NZ-NNR3 | C:\GithubRunners\nen-runners\Runner3 | actions.runner.zheref-nen.NZ-NNR3 |
already registered for NZ/NN: (none)
```
(run for real against zheref/nen, 2026-09-30)

```bash
nen runner plan --repo . --target zheref/nen --pool windows-x64 --machine-code NZ --count 1 --service-account lordzheref
```
```text
plan: 1 runner(s) for zheref/nen, pool windows-x64
...
nen runner plan: warning: .\lordzheref already runs 11 runner service(s) on this host for repositories whose visibility differs from zheref/nen's (public) or cannot be told -- one account is one trust domain, so either repository's jobs can rewrite the other's runners (#330):
nen runner plan:   actions.runner.zheref-bankai-core.NZ-BCR1 -- zheref/bankai-core, private
...
nen runner plan:   actions.runner.zheref-KroWindows.NZ-KWIR5 -- zheref/KroWindows, private
nen runner plan: recommended: a local account for zheref/nen alone, e.g. --service-account runner-nen (create it yourself first; nen never creates an account or handles its password).
```
(run for real on the maintainer's Windows host, 2026-10-02: exit 0; the plan
and nine of the eleven service lines abridged)

```bash
nen runner plan --repo . --target zheref/nen --pool windows-x64 --machine-code NZ --count 1 --service-account runner-nen
```
```text
...
nen runner plan: warning: zheref/nen's existing runner service(s) actions.runner.zheref-nen.NZ-NNR1, actions.runner.zheref-nen.NZ-NNR2, actions.runner.zheref-nen.NZ-NNR3 log on as .\lordzheref, which also serves repositories whose visibility differs or cannot be told; a new account moves only the runners this plan adds -- these keep .\lordzheref until they are removed and registered again under the new account (#330):
nen runner plan:   actions.runner.zheref-bankai-core.NZ-BCR1 -- zheref/bankai-core, private
...
```
(the same host, following the recommendation: exit 0; the plan and all but the
first of the eleven shared services abridged)

### `nen runner script`

Renders the plan's **host script**, deterministically — no timestamp, host
name or random value is written into it — and prints the one command line
that launches it. It never runs it. The plan is re-checked field by field
first (every value that reaches the script: the target, the labels, the
paths, the identity, the package URL — only an `actions/runner` release asset
— and its SHA-256), so a hand-edited plan cannot put a quote into a
PowerShell string; a file that is not a plan this build wrote is exit 2.

**Where the script goes.** `--out` belongs in **your own profile**, outside
the runner root — `%LOCALAPPDATA%\nen\jusshin\` on Windows,
`~/.local/state/nen/jusshin/` on Linux and macOS — where only you (and an
administrator) can change it between rendering and the elevated run. An
`--out` at or under the plan's `root` is **refused, exit 2**: a root the
runners' own service account can reach is a root a CI job could rewrite the
script in before UAC. `--json`'s `scriptSha256` is the SHA-256 of the bytes
written, for a caller that re-checks the file (`Get-FileHash`) right before
it launches it. (The script does not hash itself: a check inside a file that
was swapped is swapped with it.)

**The secrets never touch a command line.** The registration token is minted
inside the script, per runner, into a variable that is never printed; the
Windows service-account password is typed once into `Read-Host
-AsSecureString`. Neither is ever passed as an argument: `config.cmd` is a
batch file `cmd.exe` re-parses, so `& | < > ^ %` in an argument split it,
expanded it or ran a command, and any argument is visible to
process-creation auditing. Both reach the runner through its own
environment inputs — `ACTIONS_RUNNER_INPUT_TOKEN` and
`ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD`, which `actions/runner`'s
`CommandSettings` reads as `--token` and `--windowslogonpassword`, registers
with its secret masker and removes from its own environment — set only
around the one call and cleared in a `finally`.

- **Windows** — a Windows PowerShell **5.1** script (no `&&`, no `??`, no
  ternary; ASCII only). It asserts elevation (exit **3**, "run elevated"),
  then **locks the runner root down before anything is downloaded or run
  from it**, in this order, with well-known SIDs so it reads the same in
  every display language: the root's owner becomes Administrators
  (`icacls <root> /setowner *S-1-5-32-544`); its inherited entries are
  removed and SYSTEM and Administrators get full control inherited by
  everything below (`/inheritance:r /grant:r *S-1-5-18:(OI)(CI)F
  *S-1-5-32-544:(OI)(CI)F` — a root an unelevated session created inherits
  `Authenticated Users: Modify` from the drive, and that entry is what goes;
  explicit grants other projects' accounts hold on the root are kept); the
  project, `_jusshin` and `_jusshin\pkg` directories are created or re-owned
  by Administrators and `/reset` to inherit only that; `_jusshin\pkg` then
  drops inheritance too (SYSTEM and Administrators only); and the elevated
  user gets `(OI)(CI)RX` on `_jusshin` to read the transcript and summary.
  A failed `icacls` stops the run (exit 1). Then it starts a transcript at
  `<projectDir>\_jusshin\register-<yyyyMMdd-HHmmss>.log`, checks that `gh`
  resolves and `gh auth status` succeeds (exit **5**), and for a local
  account grants it `(RX)` on the root and the project directory — **this
  folder only, not inherited**: `config.cmd` grants the leaf `Runner<N>`
  folders itself, and nothing else grants the service account Modify. It
  asks **once** for the account's password (only if a runner still needs
  registering) and **refuses it before its first use**, exit 1, when it is
  empty, begins or ends with whitespace (the runner trims an environment
  input), or carries any of `& | < > ^ % " '` or a line break — the message
  names that rule. It downloads the package once into the admin-only
  `_jusshin\pkg` unless a copy with the planned SHA-256 is already there,
  and deletes it on a mismatch (exit **6**). Per runner: skip when
  `<installDir>\.runner` already names it **and** its service
  `actions.runner.<owner>-<repo>.<name>` exists **and** GitHub still lists
  the registration (`gh api --paginate repos/<owner>/<repo>/actions/runners`,
  read once). A folder that names it but fails either check is **stale**
  (#319 — a failed service install leaves `.runner` with no service; a
  removed registration leaves one GitHub no longer lists): the line
  `<name> in <dir> is stale (<reason>) -- emptied and re-registered.` is
  printed, a leftover service is stopped and `sc.exe delete`d, and the runner
  is registered like a fresh one — with `--replace` when GitHub still lists
  the name — so the summary counts it **registered**, never skipped. A
  runner list `gh` cannot read leaves such a folder untouched and counts it
  failed: live and stale cannot be told apart. Otherwise empty the folder (it
  holds no configured runner, or a stale one, so nothing in it predates the
  lockdown worth trusting), **re-hash the package immediately before `Expand-Archive`**
  (a mismatch deletes it, exit 6), mint a registration token **now** with
  `gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token
  --jq .token`, and run `config.cmd --unattended --url ... --name <name>
  --labels self-hosted,<OS>,<ARCH> --work _work --runasservice
  --windowslogonaccount .\<account>` (no account flag for
  `network-service`) with the token and password in the environment as
  above. **`config.cmd`'s output is discarded, never replayed**: the
  transcript (stopped around the call all the same) records only its exit
  code and the fixed line `config.cmd exited <code> for <name>; its own
  (masked) log is under <installDir>\_diag`. Every planned service must then
  be `Running` (a stopped one is started once); the
  `Get-Service actions.runner.<owner>-<repo>.*` table is printed, then the one
  summary line `jusshin: <n> registered, <m> skipped, <k> failed`. The window
  stays open on a failure only when it is an interactive console. Exit 0 only
  when every planned service is Running and nothing failed.
- **Windows, interactive** (`mode: interactive`, #333) — the same 5.1 script
  up to registration, with the same root lockdown, transcript, `gh` checks,
  package hash and token handling, and four differences. It checks that the
  identity is an **enabled local account** on the host (`Get-LocalUser`;
  exit 1 otherwise, naming it), and prints a `WARNING` when it is the account
  running the script. It asks **no password**: `config.cmd` runs
  without `--runasservice` and without a logon account, so only
  `ACTIONS_RUNNER_INPUT_TOKEN` is set around the call. It resets each
  `Runner<N>` folder to the locked root's inherited baseline (`icacls /reset
  /T`), so an account an earlier run granted keeps no access, then grants the
  identity `(OI)(CI)M` there and nothing wider, because
  `run.cmd` runs as the identity and writes `_diag`, `_work` and its own
  updates there. Then, for every planned runner (skipped ones included), it
  registers a **Scheduled Task** named `actions.runner.<owner>-<repo>.<name>`
  at the root of the task library: action `<installDir>\run.cmd` in that
  folder, trigger at logon of `<COMPUTERNAME>\<account>`, principal that
  account with an **interactive token** (`-LogonType Interactive`, so the
  task runs only in its desktop session and stores no password), run level
  Limited, priority 4 (normal — Task Scheduler's default 7 is below normal,
  and every job would inherit it), no execution time limit, restarted every
  minute (up to 255 times) when the task ends in failure — a sign-out is not
  a failure — one instance at a time, `-Force` to replace an earlier
  registration. **It never installs a service**, and a runner folder an
  earlier service-mode run left installed as the service of the same name is
  refused (no task beside it; exit 1). If the identity is signed in now (it
  owns an `explorer.exe` on this computer), each task is started and must
  reach `Running` within 30 s. Otherwise the tasks wait, and the script says
  the runners come online when that account signs in (or is auto-logged on,
  which the script never configures); when it cannot tell, it says so and
  starts none. A table of the tasks and the one
  summary line follow. Exit 0 when every task is registered, and running
  wherever the identity is signed in, and nothing failed.
- **Linux** — bash, run by the maintainer as `sudo bash <file>`: it refuses
  anything but root reached through `sudo` from a real account (exit 3),
  runs `gh` as that account (`SUDO_USER`, with its own sign-in), `config.sh`
  as the service user (it refuses root), then `svc.sh install <user>`,
  `svc.sh start` and `svc.sh status`; `curl -fsSL` and `sha256sum -c` for the
  package, re-checked before every `tar` extraction; a `systemctl list-units`
  table at the end. `config.sh` is a bash script and its arguments are
  quoted, so the token was never re-parsed — but it sat on `argv`, readable
  by every local user through `/proc/<pid>/cmdline`. It now reaches
  `config.sh` as `ACTIONS_RUNNER_INPUT_TOKEN`: the builtin `printf` writes it
  into a pipe, and the service user's `bash -c` reads it from stdin into its
  own environment before `exec ./config.sh` (`sudo` would strip an inherited
  variable, and `env VAR=...` would put it back on `argv`).
- **macOS** — bash, run as **yourself** (root is exit 3): `config.sh` (the
  token as a `ACTIONS_RUNNER_INPUT_TOKEN="$token"` prefix assignment, never
  an argument), then `svc.sh install` and `svc.sh start`; the package is
  re-checked with `shasum -a 256 -c` before every extraction; then, per
  runner, `launchctl print gui/<uid>/<label>` and the PID check — a
  LaunchAgent with no PID is held pending **Background Task Management**
  approval under System Settings → General → Login Items, which the script
  prints and never approves.
- **Stale directories on Linux and macOS** follow the Windows rule above: a
  `.runner` naming the planned runner stands only while its service exists
  (Linux: `systemctl show -p LoadState --value <prefix><name>.service`, where
  only `not-found` means absent; macOS:
  `~/Library/LaunchAgents/<prefix><name>.plist`) and GitHub lists the
  registration. A stale one has its service removed with `svc.sh stop` and
  `svc.sh uninstall`, the directory is deleted, and `config.sh` re-registers
  it (`--replace` when GitHub still lists the name). Each step fails closed,
  counting that runner failed and moving to the next: a service state
  `systemctl` cannot read leaves the directory untouched, as does a stop or
  uninstall that fails, and a directory `rm -rf` cannot empty never ends the
  run (`set -e`) without its summary line.

**The summary file.** Every script — Windows, Linux and macOS — also writes
the one summary line, and **nothing else**, to
`<projectDir>/_jusshin/register-<yyyyMMdd-HHmmss>.summary` (backslashes on
Windows) beside its log, so a caller reads the outcome without reading the
transcript, which is the maintainer's. It is written from the point the
script has its `_jusshin` directory (after the lockdown on Windows): a run
that stopped before that — not elevated, wrong user — leaves none.

The header carries the target, pool, names, identity, root and package as
comments, and the line `# rendered by nen <version> runner script — do not
edit; re-run nen runner script` (`--` in place of the dash in the PowerShell
file, which 5.1 would otherwise read in the ANSI code page).

**Usage**

```text
nen runner script --plan <plan.json> --out <file> [--repo <path>] [--accept-daily-account] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--plan <plan.json>` | yes | what [`runner plan --out`](#nen-runner-plan) wrote | resolved against `--repo`; unreadable or not a plan is exit 2 |
| `--out <file>` | yes | where the script is written | its directory is created. Outside the plan's `root` (exit 2 otherwise) — `%LOCALAPPDATA%\nen\jusshin\` on Windows, `~/.local/state/nen/jusshin/` elsewhere. On Windows it must end `.ps1` and carry no space or quote — the launch line passes it inside a quoted argument list |
| `--accept-daily-account` | no | render a plan whose `dailyAccount` is `true` | without it such a plan is exit 2: its interactive runners would run every UI job as your own daily account. Re-plan with a dedicated local account instead where you can |
| `--dry-run` | no | render and validate, write nothing | — |
| `--json` | no | the result | — |

**Output and exit codes** — human: the file line, the `sha256 ...; the run
leaves its one summary line in ...` line, and the launch line.
`--json` top-level keys: `os`, `out`, `runners[]` (names), `identity`,
`mode`, `dailyAccount`, `needsElevation` (Windows and Linux `true`), `launch` — Windows
`powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process
powershell -Verb RunAs -Wait -ArgumentList
'-NoProfile','-ExecutionPolicy','Bypass','-File','<out>'"`, Linux `sudo bash
<out>`, macOS `bash <out>` — `written`, and (additive in 0.18.1)
`scriptSha256` (lowercase hex SHA-256 of the rendered bytes) and `summary`
(the glob `<projectDir>\_jusshin\register-*.summary` the run's summary file
matches; the newest is this run's). Exit 0; 2 for a plan that is not one, an
identity still `ask`, a `dailyAccount` plan without `--accept-daily-account`, a Windows `--out` that is not a plain `.ps1`, or an
`--out` under the plan's root. The script's own exit codes (`0`, `1`, `3`,
`5`, `6`) are its own, listed above, and are never this verb's.

**Example**

```bash
nen runner script --plan plan.json --out 'C:\GithubRunners\nen-runners\_jusshin\register.ps1' --dry-run
```
```text
nen runner: --out 'C:\GithubRunners\nen-runners\_jusshin\register.ps1' is under the plan's runner root 'C:\GithubRunners'. Write the script where only you can change it before it runs elevated -- %LOCALAPPDATA%\nen\jusshin\ -- never inside the root the runners' own service account can reach.
Run 'nen runner --help'.
```
(exit 2)

```bash
nen runner script --plan plan.json --out 'C:\Users\maintainer\AppData\Local\nen\jusshin\register.ps1' --dry-run
```
```text
(dry run) would write C:\Users\maintainer\AppData\Local\nen\jusshin\register.ps1 -- Windows host script for NZ-NNR1, NZ-NNR2, NZ-NNR3 as .\lordzheref
sha256 28e57708069963439e7f51ec799140ef96c7873f76732a193c7e3779264ebdb0; the run leaves its one summary line in C:\GithubRunners\nen-runners\_jusshin\register-*.summary
launch (elevated): powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\maintainer\AppData\Local\nen\jusshin\register.ps1'"
```
(run for real on the plan above with v0.18.3, the profile's user name replaced with `maintainer`; #319's stale-slot check changed the script's bytes, so a later build prints another `sha256`. The rendered script's bytes are pinned by `src/runner/fixtures/register.windows.golden.ps1`)

### `nen runner verify`

Polls the runners list every 10 s, for up to `--wait` seconds, until every
`--expect` name is present, `online`, and — with `--labels` — carries every
listed label (case-insensitively). **Never exits 0 on a partial pass**: every
expected name is judged on every attempt, and the verdict is their
conjunction. An online runner proves the runner **process**; it says nothing
about the host's toolchain — that is [`runner preflight`](#nen-runner-preflight)'s.

**Usage**

```text
nen runner verify --expect <name>[,<name>...] [--target <owner/name>] [--labels <a,b,c>] [--wait <seconds>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--expect <names>` | yes | the runners that must be online | comma-separated; an empty list is exit 2 |
| `--target <owner/name>` | no | the repository | defaults to `--repo`'s `origin` |
| `--labels <a,b,c>` | no | labels each must carry | — |
| `--wait <seconds>` | no | how long to keep polling | default `0`: one read |
| `--json` | no | the report | — |

**Output and exit codes** — human: a verdict line (`ok` or `NOT READY`, the
count online, attempts, seconds waited) and a table of name and verdict:
`ok`, `missing`, `offline` (or GitHub's own status word), or `labels: missing
<x>`. `--json` top-level keys: `target`, `ok`, `attempts`, `waitedSeconds`,
`runners[]` (`name`, `verdict` `ok`\|`missing`\|`offline`\|`labels`,
`status`, `missingLabels[]`, `detail`). Exit 0 when all pass; 1 otherwise, or
when GitHub refused; 2 on usage; 5 without `gh`.

**Example**

```bash
nen runner verify --target zheref/nen --expect NZ-NNR1
```
```text
NOT READY: 0/1 runner(s) online on zheref/nen (1 attempt(s), waited 0s)
| name    | verdict |
| ------- | ------- |
| NZ-NNR1 | missing |
```
(run for real against zheref/nen, before any Windows runner existed: exit 1)

### `nen runner workflow`

Renders the pool's **preflight workflow** from a template the caller
supplies. Nen carries the **renderer**, not the template — the same split the
readiness workflow a skill installs already has. Eight placeholders, all
`@@NAME@@`: `@@REPO_SLUG@@`, `@@RUNS_ON@@` (the pool's labels as a flow
sequence, `[self-hosted, Windows, X64]`), `@@OS@@` (the `RUNNER_OS` value),
`@@MODE@@` (the pool's mode, `service` or `interactive`, #333; a
template that predates it still renders — a template need not use every
value), `@@TOOLS@@` (space-separated), `@@POOL_ID@@`, `@@WORKFLOW_FILE@@` (the pool's
`preflightWorkflow`, for the push path filter) and `@@RENDERED_BY@@` (`nen
<version> runner workflow`). Any `@@X@@` left after substitution is exit 1
naming it, and so is a rendering the YAML reader refuses — nothing is written
in either case.

**Usage**

```text
nen runner workflow --pool <id> --template <path> [--target <owner/name>] [--repo <path>] [--out <path>] [--force] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--pool <id>` | yes | the pool the workflow proves | — |
| `--template <path>` | yes | the template | resolved against `--repo`; unreadable is exit 2 |
| `--target <owner/name>` | no | `@@REPO_SLUG@@` | defaults to `--repo`'s `origin` |
| `--out <path>` | no | where to write | default `<repo>/.github/workflows/<preflightWorkflow>`; its directory is created |
| `--force` | no | overwrite an existing file that differs | without it, a differing file is exit 1 naming how many lines differ |
| `--dry-run` | no | render and check, write nothing | — |
| `--json` | no | the result | — |

**Output and exit codes** — human: one line, `wrote`, `(dry run) would
write`, or `already matches the rendering`. `--json` top-level keys: `out`,
`pool`, `target`, `runsOn[]`, `written`, `unchanged`. Exit 0; 1 on a leftover
placeholder, invalid YAML, or a differing file without `--force`; 2 on usage or
a missing `runners` block. It runs on a branch: the file reaches the
repository through its own pull request, like any workflow.

**Example**

```bash
nen runner workflow --repo . --pool windows-x64 --template ../hatsu/templates/runner-preflight.yml --dry-run
```
```text
(dry run) would write C:\Users\zhere\Code\CLIs\nen\.github\workflows\runner-preflight-windows-x64.yml -- preflight for pool windows-x64 [self-hosted, Windows, X64] on zheref/nen
```
(run for real with `src/runner/fixtures/runner-preflight.template.yml`, the candidate template; its rendering for this pool is pinned by `runner-preflight-windows-x64.golden.yml` and passes `src/ci/runner-policy.test.ts`)

### `nen runner preflight`

`gh workflow run <workflow> --repo <target> --ref <ref>` (the ref defaults to
the default branch `gh repo view` answers), then finds **the run it created**:
the run list is read before the dispatch, and the run is the new
`workflow_dispatch` run on that ref whose id was not in it — never a
comparison of this host's clock with GitHub's. The listing is retried every
5 s for up to 60 s, because a run appears asynchronously; then the run and its
jobs (`gh api .../actions/runs/<id>` and `.../jobs`, which carries
`runner_name`) are polled every 10 s until it completes or `--wait` runs out.
A job **still queued at the deadline** is named for what it is — no free
runner with those labels picked it up, the "pending forever" signature of an
offline or empty pool.

**Usage**

```text
nen runner preflight --target <owner/name> --workflow <basename> [--ref <branch>] [--wait <seconds>] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | **yes** | the repository | this verb writes (a dispatch), so it never falls back to a remote |
| `--workflow <basename>` | yes | the preflight file | a basename ending `.yml` |
| `--ref <branch>` | no | the branch to run on | default: the default branch. Only a run on the default branch can certify a pool: [`runner enable`](#nen-runner-enable) refuses any other ref's run (#319), so another `--ref` is a rehearsal, never the proof |
| `--wait <seconds>` | no | how long to wait for the conclusion | default `600` |
| `--dry-run` | no | resolve the ref and print the dispatch, send nothing | **still reads GitHub** for the default branch |
| `--json` | no | the report | — |

**Output and exit codes** — human: `<verdict>: <workflow> on <target>@<ref> --
<detail>`, the run URL, and a jobs table (job, status, conclusion, runner,
labels). `--json` top-level keys: `target`, `workflow`, `ref`, `runId`, `url`,
`status`, `conclusion`, `runnerName`, `runnerOs`, `jobs[]` (`name`, `status`,
`conclusion`, `runnerName`, `labels[]`), `verdict`
(`success`\|`failure`\|`queued`\|`timeout`\|`dry-run`), `detail`, `dryRun`.
Exit 0 only on `success` (or a dry run); 1 on failure, cancellation, a queued
or unfinished run at the deadline, a dispatch GitHub refused, or no run
appearing in 60 s; **2 when the workflow is not on the ref** (the `gh workflow
run` 404 shape) — merge the preflight workflow first; 5 without `gh`.

**Example**

```bash
nen runner preflight --target zheref/nen --workflow runner-preflight-windows-x64.yml --dry-run
```
```text
dry-run: runner-preflight-windows-x64.yml on zheref/nen@main -- would run: gh workflow run runner-preflight-windows-x64.yml --repo zheref/nen --ref main
```
(run for real: the dry form read the default branch and dispatched nothing)

### `nen runner enable`

The fail-closed switch. It reads the pool's `enableVariable` (a pool that
declares none is exit 2 — "not variable-gated; nothing to enable"), re-reads
run `--after-run` from GitHub and **requires** all of: a run of the pool's own
`preflightWorkflow` (the run's `path`), `completed`, concluded `success`,
every job in it asked for this pool's labels and concluded `success`, and
(#319) **the default branch's own proof**: the run's `event` is
`workflow_dispatch` (what [`runner preflight`](#nen-runner-preflight)
starts), its `head_branch` is the target's default branch, and the
workflow's blob at the run's `head_sha` is the blob the default branch
carries now (`gh api --method GET repos/<target>/contents/<path>?ref=...`,
read for its `sha`). So a green run of another workflow, of the same file
rendered for another pool, of a `push` on an unmerged branch, or of an
edited copy of the preflight (steps removed, `TOOLS` emptied, `runs-on`
kept) is refused by name — and a run made before the default branch's
preflight last changed no longer certifies: dispatch it again. Only then
`gh variable set <NAME> --body <value> --repo <target>`, and the variable is
read back; a read that disagrees is exit 1. Idempotent: a variable already
holding the value is not written.

**Usage**

```text
nen runner enable --target <owner/name> --pool <id> --after-run <run-id> [--repo <path>] [--value online] [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--target <owner/name>` | **yes** | the repository | this verb writes a variable, so it never falls back to a remote |
| `--pool <id>` | yes | the pool to switch on | — |
| `--after-run <run-id>` | yes | the green preflight run | a positive integer, else exit 2 |
| `--value <v>` | no | the value to set | default `online`; any other must match `^[a-z0-9-]{1,32}$` |
| `--dry-run` | no | certify the run, read the variable, set nothing | **still reads GitHub** |
| `--json` | no | the result | — |

**Output and exit codes** — human: one line naming the variable, value,
previous value and run. `--json` top-level keys: `target`, `pool`,
`variable`, `value`, `previous` (or `null` when unset), `runId`, `changed`,
`dryRun`. Exit 0; 1 when the run is not a green preflight of this pool (each
reason named, **nothing set**), GitHub refused, or the read-back disagrees; 2
on usage, an ungated pool or a missing `runners` block; 5 without `gh`.
**A refusal under `--json`** prints, on stdout, `{ target, pool, runId,
refused: true, problems[] }`, each problem `{ check, detail }` with `check`
one of `workflow`, `status`, `conclusion`, `jobs`, `labels`,
`job-conclusion`, `event`, `branch`, `blob` — the same reasons the stderr
line names, in the same order, still at exit 1.

**Example**

```bash
nen runner enable --target zheref/nen --repo . --pool windows-x64 --after-run 36740464215 --dry-run
```
```text
nen runner enable: run 36740464215 on zheref/nen is not a green preflight of pool windows-x64: it is a run of '.github/workflows/ci.yml', not .github/workflows/runner-preflight-windows-x64.yml; job 'compile' did not ask for pool windows-x64's labels (missing Windows, X64); ... Nothing was set -- run 'nen runner preflight' (it dispatches on the default branch) and pass the run id it reports.
```
(run for real with a `ci.yml` run id: exit 1, nothing set; the job list is abridged here)

```bash
nen runner enable --target zheref/nen --repo . --pool windows-x64 --after-run 36791237018 --dry-run --json
```
```text
{
  "target": "zheref/nen",
  "pool": "windows-x64",
  "runId": 36791237018,
  "refused": true,
  "problems": [
    { "check": "event", "detail": "it was triggered by 'push', not workflow_dispatch" },
    { "check": "branch", "detail": "it ran on 'fable/kurapika/runner-preflight-windows-x64', not the default branch 'main'" },
    { "check": "blob", "detail": ".github/workflows/runner-preflight-windows-x64.yml at 5903e47a5a6a is blob d9f6a577051f, not the default branch's blob e2375dfe87a2" }
  ]
}
```
(run for real on the green `push` run that certified this repository's own
pool before #319: exit 1, nothing set, the stderr line omitted; the JSON is
re-indented here)

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

# ... then preview where each name would go before requesting anything ...
nen pr request-reviews --target zheref/nen --pr 112 --add-reviewers sasuke --dry-run

# ... then request the rest. A collaborator's LOGIN resolves on its own; a
# Bot this pull request has never seen (no prior review, no pending
# request) needs its node id named directly with --add-bots.
nen pr request-reviews --target zheref/nen --pr 112 --add-reviewers sasuke
nen pr request-reviews --target zheref/nen --pr 112 --add-bots BOT_kgDOCnlnWA
```

`pr fetch --json` carries `reviewRequests[]`, so it is one way to see who is
already requested before naming the rest. Request the USER route on the
maintainer's own user token — a bot token silently no-ops on that call, and
no verb here can tell which credential ran it; the bot route has no such
caveat, since GitHub's `requestReviews` mutation is not
`requestReviewsByLogin`.

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
fragment. There is one exception. After the release PR merges, run it with the
cut point as the range's end: the release PR is reconciled without citing
itself, and is named on its own line, when its merge introduced the dated
section being cut. Dating a `## vX.Y.Z — unreleased` heading that an earlier
PR opened counts as introducing it. That is the
[release-PR allowance](#nen-changelog-completeness), so no follow-up
"reconcile" PR is needed. `collate` without `--write` touches no file and
deletes no fragment; `--write` is the only thing that rewrites `CHANGELOG.md`.

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

Exit 1 whenever anything is flagged: a secret-shaped name, a binary, a path
outside `--scope`, or a deleted path your draft never mentions. The yes to
stage a flagged file is always yours. A git-ignored path is reported
separately (`ignored: <n> file(s), not listed`) and never moves this exit
code — a tree that is entirely `node_modules/` or a generated mirror is
exit 0.

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
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.19.0/bootstrap/nen.sh -o nen-bootstrap.sh
nen="$(bash nen-bootstrap.sh --ref v0.19.0)"
"$nen" --version
```

Stdout carries only the verified path, so `$(...)` is the whole integration.
Retry only on exit `4`; `5` and `6` are integrity failures and must never be
retried. Once a `nen` exists, the in-CLI form pins a second one — pass
`--script` when the binary is running outside any checkout, since it cannot
find `bootstrap/nen.sh` relative to itself:

```bash
nen bootstrap --ref v0.19.0 --source zheref/nen --script ./nen-bootstrap.sh
```

```bash
# 2. Wait for a read-only observation to come true.
nen watch until --command "git status --short" --interval-ms 5000 --max-iterations 12
nen watch until --command "gh pr checks 112" --true-pattern "All checks were successful"
```

The command is spawned directly with no shell and is classified against
izanami's read-only table *before the first run*, so a mutating command is
refused outright rather than run once and then reported on. It is split with a
POSIX shell's quoting, and every verdict is computed from that same argument
vector — so on a POSIX host a quoted `--jq "[.a[]|.b]"` on a `gh pr view` or a
`gh api` read is one argument and a watchable read, a read whose verdict scans
every argument (`git log`, nen's gated verbs) still refuses an argument outside
its safe set, and an unquoted `|` still refuses ([quoting](#watch-until-quoting)). Three consecutive
observation errors stop the watch regardless of `--max-iterations`: a
permanently broken observation (bad usage, no auth, no such binary) must never
masquerade as "not yet true".

Under `parse izanami` the allowlist is deliberately literal about what it can
prove. The scan walks whitespace tokens, and a quoted or escaped argument is one
word to that walk and something else to a real shell (`-X 'DELETE'` is the worked
example), so a line it cannot read faithfully is refused rather than assumed to be
a GET. `watch until` does not face that question: it walks the argument vector it
will spawn, so `-X 'DELETE'` there is the method `DELETE`, named as mutating, and
a quoted value is simply the argument after its flag.

**A single-quoted `--jq` is the one exception, and it reads** — the commonest
`gh api` read spelling there is ([#78](https://github.com/zheref/nen/issues/78)):

```
$ nen parse izanami "gh api repos/zheref/nen/pulls --jq '.[].number' until it is empty"
until: it is empty
  [read-only] gh api repos/zheref/nen/pulls --jq '.[].number'
```

A `'...'` span with no inner quote and no newline is exactly **one word** to
every shell this table has been checked against, and its content is literal — no
expansion, no substitution, no word splitting. So the row folds it into one
inert placeholder before scanning, which changes neither the argument vector's
length nor any other word in it: the gate is not weakened, the line is made
provable. A **non-empty** `'<expr>'` folds the same way in `--jq='<expr>'`,
`-q '<expr>'`, `-q='<expr>'` and the attached `-q'<expr>'`, and so does a value
containing spaces. An **empty** attached value is not that shape: a shell turns
`-q''` into a bare `-q`, which takes the *next* argument as its value — so
`gh api <path> -q'' -H -XDELETE` is a DELETE (`-q` takes `-H`). It is not folded,
and refuses ([#288](https://github.com/zheref/nen/issues/288)'s review).

**A shorthand's attached value is read in gh's own order.** `-X=v` takes `v`; any
other attached text, a bare `=` included, *is* the value; only nothing attached
takes the next argument. Through v0.17.0 a bare `=` was dropped, so
`gh api <path> -q= -XDELETE` read as a GET under both `parse izanami` and
`watch until` while gh sent a DELETE (`-q=` is the value `=`, and `-XDELETE` stays
a flag). Both verbs name it as mutating now.

Three shapes still refuse, each for its own reason:

| shape | why |
|---|---|
| `--jq ".name"` | under `parse izanami`: double quotes expand `$x`, a backtick and `\` — one word, but not an *inert* one, and inertness is the whole claim. **Respell it with single quotes**, or watch the bare read and apply `jq` to its output downstream — the refusal now says both. Under **`watch until`** it reads: the walk takes the spawned argument after `--jq`, whatever quoted it. |
| `--jq'.name'` | `--jq.name` to a shell: one word, an unknown long flag, not a flag and its value. |
| `--jq '.a \| .b'` | under `parse izanami`, a metacharacter is refused by the whole-line seam that runs *before* any row vouches for anything, and this fold deliberately does not reach past its own row to move it. Under **`watch until`** on a POSIX host it reads ([#288](https://github.com/zheref/nen/issues/288)): that path spawns with no shell, so its seam refuses a metacharacter only where a shell would act on it, and a single-quoted `\|` is one character of one argument -- see [quoting](#watch-until-quoting). |

Under `parse izanami` a quoted **method** (`-X 'DELETE'`) is still `unknown`,
unchanged: the fold is scoped to `--jq` precisely so the adversarial repro
[#70](https://github.com/zheref/nen/issues/70) pinned stays where its own review
put it. Under `watch until` it is `mutating`: the walk reads the spawned argument
`DELETE`.

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
| deploy | **the verb exists; `--target` and `--run` are both mandatory** | [`shu deploy`](#nen-shu-deploy) | Runs a lane's declared deploy invocation against a **named** target from `project.targets`, with the target's own `args` appended and the variables its `requiresEnv` names asserted (never read). Two flags and no single-flag path to acting: there is no default target, ever, and without `--run` the verb prints the fully resolved plan and spawns nothing at exit 0. The destination is resolved **after** the lane, the verb and the host, so a lane whose `deploy` is a seat answers exit 4 with its own reason whatever `--target` says, while a runnable row with no target is exit 2 naming what is declared. `gatsby` is the one stack with a reference deploy row (two steps: the archive, then the pages push, proposed only where the tree declares the publishing tool); `nextjs` has three observed shapes and no default, so `detect` proposes a seat. `detect` proposes `"targets": {}` on every stack and a destination on none. |
| coverage | **yes on a single-package `nextjs` lane** | [`shu coverage`](#nen-shu-coverage) | Runs the lane's declared coverage command. The pack states this row as a shape run **once per package**, so `detect` proposes it only where that resolves to one command it can stand behind: a lane whose `package.json` names itself and declares the task. A **workspace root** is withheld with the members named — which of them, and in what order, is the repository's answer — and a lane that answers `{package}` but declares no such task is withheld naming the task. `xcode-ios`'s two-step row is withheld naming the **simulator**, not the result bundle: the bundle path is the one value `detect` contributes rather than reads (it is an *output*, and nen's own generated output lives under `.nen/`). The note says so, and says four more things a maintainer would otherwise meet as a failure — the path is **lane-relative** (an `ios/` lane writes `ios/.nen/`); `.nen/` is the line [`nen scaffold init`](#nen-scaffold-init) appends to your `.gitignore`, so a repository stood up another way must ignore it itself; `xcodebuild` **refuses an existing `-resultBundlePath`**, so a filled-in row succeeds once and then fails until the previous bundle is deleted or the value carries something per-run; and the value must move in every step of the row at once. **The bundle is not the report.** When you fill that row in, the path to declare under `project.verbs.<lane>.coverage.artifacts` is the file the *second* step's JSON lands in — `xcrun xccov view --report --json` writes to stdout, so give that step a `stdoutTo` naming the same path (nen writes the captured bytes itself; there is no shell and no redirection operator), and give the file a name with `xccov` in it — because an `.xcresult` is a **directory** and the coverage reader recognises a report by its name. What a run produced is then **parsed**: nen reads the first path under the verb's own `artifacts` whose format it recognises — the Istanbul/Vitest JSON summary, `xccov` JSON, Cobertura XML, JaCoCo XML, LCOV — into a total and a row per target, and refuses a report it cannot honestly read (truncated, or claiming more covered lines than lines) by name rather than printing a plausible number for it. `--threshold` reports `met` against the **counts** and never changes the exit code, in either direction. |
| host toolchain | **yes to check; one installer to install** | [`shu tools`](#nen-shu-tools) | Probes every tool `project.toolchain` pins (and nen itself, from `dependency`) and exits 5 when anything is missing or is not the pinned version, or **7** when everything passes but nen is `BEHIND` — inside the dependency block's `minimum` and below its `pinned_ref` ([behind the pinned ref](#behind-the-pinned-ref)) — naming the exact command per tool. `--install` acts only through `corepack`; every other declared installer is verify-only in this release, reported with its pin for a human to run. |
| start a piece of work (clean, fetch, branch, prove it builds) | **yes — the git half everywhere, the build half where a lane declares one** | [`shu warmup`](#nen-shu-warmup) | One line for the five things a developer does by hand at the start of every task: refuse (or, with `--discard`, destroy) uncommitted work, fetch, fast-forward the trunk, cut the branch **you** name from its fresh tip, then run the lane's declared `build` — and its `test` with `--tests`. The **only** `shu` verb that mutates git state, so `--repo` is required and every step refuses rather than guessing; `--dry-run` prints every git and toolchain command and runs none of them. A repository with no `project` block still gets the git half and exits 0. Not [`warmup`](#nen-warmup), which sweeps a registry for stale pins and reads only. |
| report on a piece of work | **yes — the facts and the fill** | [`report data`](#nen-report-data), [`report render`](#nen-report-render) | `report data` gathers what is on the branch against a base — commits, changed files (with a tier from your own `--tiers` table), the lane's coverage report **if one is already on disk**, the build proof under `.nen/proof/<lane>.json`, the last recorded stop — into one document, reading and never writing. `report render` fills a template with it: four constructs and nothing else, an unknown token refused **naming it** rather than published as a blank cell, and `--out` refused unless it resolves inside the repository with symlinks resolved. It never runs the coverage command — [`shu coverage`](#nen-shu-coverage) is the verb that produces the report this one reads, and both parse it with the same reader. `evidence` is an empty list until `nen shu evidence` lands; the field ships now so a template written today does not change shape when it does. |

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


### Nen's own phase verification lanes

The `device-records` lane runs the focused launch/schema/executor tests through
`nen shu test --repo . --lane device-records`, without coverage. The default `nen` lane's full
`test` collects JUnit and LCOV during the aka regression phase. Its `coverage` row only checks that
the saved LCOV exists and lets Nen parse it during mukai; it never reruns the suite. Verify the
capture's source-tree and configuration provenance before measurement; mere artifact existence
is not freshness. This wiring implements the phase boundary requested by Hatsu #48 for Nen #204.
