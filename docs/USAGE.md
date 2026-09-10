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
with the `nen` spelling. This document covers the **v0.6.0 line** (it adds no
family and no verb — `pr request-reviews --add-bots`, a launch device's
`readyWhen`, real-root containment for every declared path, `stage triage`'s
`ignored` bucket and `commits.runTrailer` are what is new in it): 37 command
families, 95 verbs, every flag checked against the binary this repository
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

Two verbs read it **conditionally**, which is a third thing again.
[`commit format`](#nen-commit-format) opens
[`nen/workflow.json`](#nenworkflowjson) only when the invocation carries at
least one `--trailer` — a message that could not violate the trailer policy
never touches the filesystem — and [`stop`](#nen-stop) writes under it only
with `--mark`.

#### Relative paths resolve against one base: `--repo`'s root

An **absolute** value is always used as-is. A **relative** one resolves against
the root `--repo` names — `--rows-from`, `--board-from`, `--gates`,
`--changelog`, `--fragment-dir`, `--wakes-from`, `--body-from`,
`--requirements-from`, `--ledger`, `--questions-from`, `--answers-from`,
`--tiers`, `--template`, `--data`, `--out`, `--body-file`, `--input`,
`--efforts`, `--original`, `--branches`, `--table`, `--rules-dir`,
`--canon-values`, `--out-dir`, `--mirror-dir`, `--markdown-out`, and every
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
[`run rerun-failed`](#nen-run-rerun-failed), the whole
[`issue`](#family-issue) family (including
[`issue edit-body`](#nen-issue-edit-body)), [`idea file`](#nen-idea-file),
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

**Which shapes carry a `contract`, and why not all of them.**
[#79](https://github.com/zheref/nen/issues/79) asked the question directly, so
here is the ruling rather than the silence. A `contract` field is **earned by a
shape a consumer must be able to REFUSE on** — one where reading an unrecognised
document half-understood is worse than not reading it at all. Twenty-two shapes
qualify today and declare one:

`nen.commit.check/v0.1` · `nen.contract/v0.1` · `nen.issue.edit-body/v0.1` ·
`nen.loop.iterate/v0.1` · `nen.pr.edit-body/v0.1` · `nen.pr.ready/v0.1` ·
`nen.report.data/v0.1` · `nen.report.render/v0.1` · `nen.scaffold.init/v0.1` ·
`nen.scaffold.new/v0.1` · `nen.shu.<verb>/v0.1` (per executing verb) ·
`nen.shu.coverage/v0.1` · `nen.shu.detect/v0.1` · `nen.shu.evidence/v0.1` ·
`nen.shu.proof/v0.1` · `nen.shu.test-report/v0.1` · `nen.shu.tools/v0.1` ·
`nen.shu.warmup/v0.1` · `nen.stop.mark/v0.1` ·
`nen.surface.mirror.check/v0.1` · `nen.surface.mirror.generate/v0.1` ·
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

`shu` is the only *family* that returns `3`, `4` or `5`; the one other place in
this CLI where a code above `2` appears is [`bootstrap`](#nen-bootstrap), which
is not on the three-code scheme at all — it relays the bootstrap script's own
published `3`–`7` unchanged, and those numbers mean the script's things, not
these. A caller branching on `3`/`4`/`5` must know which of the two it invoked.

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
| [`canon mirror generate`](#nen-canon-mirror-generate) | no | — | use [`canon mirror check`](#nen-canon-mirror-check), which writes nothing |
| [`scaffold init`](#nen-scaffold-init) | no | `--dry-run` | prints every write, every migration and every refusal, and performs none. It spawns **nothing**, probes included — the closing [`shu tools`](#nen-shu-tools) check is reported as `would check` rather than run, which is why the dry form classifies **read-only** in izanami's table while the bare form classifies **mutating**. `--dry-run --install-tools` is refused at exit 2: one says nothing happens, the other changes the HOST |
| [`scaffold new`](#nen-scaffold-new) | no | `--dry-run` | prints the tree it would write. Even the bare form spawns nothing at all: **every post-step is printed and none is run**, the toolchain check included |
| [`pr retarget`](#nen-pr-retarget), [`pr cascade-main`](#nen-pr-cascade-main), [`run rerun-failed`](#nen-run-rerun-failed) | no | — | one narrow `gh`/`git` call each, with no preview form |
| [`pr edit-body`](#nen-pr-edit-body) | no | `--dry-run` | **still reads GitHub** to certify the number reads as a pull request, before printing the byte count and first/last line |
| [`pr request-reviews`](#nen-pr-request-reviews) | no | `--dry-run` | **still reads GitHub** — resolving every `--add-reviewers` login against the pull request's own known bots and `--target`'s collaborators, so it can print which route each name or `--add-bots` id would go to — but neither `gh pr edit --add-reviewer` nor the `requestReviews` mutation is ever called (zheref/nen#160) |
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
| `nen/repos.json` | the registry — consumers, product codes, per-consumer pins, recorded scenarios | [`repo resolve`](#nen-repo-resolve), [`repo scenario`](#nen-repo-scenario), [`ref format`](#nen-ref-format), [`fanout compute`](#nen-fanout-compute), [`fanout record`](#nen-fanout-record), [`warmup`](#nen-warmup), [`canon resolve`](#nen-canon-resolve), [`parse futon`](#nen-parse-futon), [`pr ready`](#nen-pr-ready) (ref resolution), [`schema check`](#nen-schema-check) |
| `nen/colors.yml` | the status-colour precedence for board rendering | [`color status`](#nen-color-status), [`schema check`](#nen-schema-check) |
| `nen/gates.json` | reviewer identities for the readiness check | [`pr ready`](#nen-pr-ready), [`pr next-blocker`](#nen-pr-next-blocker), [`schema check`](#nen-schema-check) |
| `nen/contract.json` | optional — `dependency` (what this repository needs *from* nen: the version floor, the pinned ref, the bootstrap) and `project` (its stack declaration: lanes, per-lane verbs, toolchain pins) | [`shu detect`](#nen-shu-detect) (proposes the `project` block), [`shu build`/`test`/`lint`/…](#family-shu) (every argv they run comes from it), [`shu tools`](#nen-shu-tools) (the `toolchain` pins), [`scaffold init`](#nen-scaffold-init) and [`scaffold new`](#nen-scaffold-new) (write it into absence; `init` also reads `dependency.pinned_ref` for the CI file's ref), [`schema check`](#nen-schema-check) |
| `nen/workflow.json` | optional — the delivery loop's **policy**: the branch template and trunk, the iteration checks, the coverage ladder, the attribution trailers a commit may carry, the reports directory, the model matrix. See [`nen/workflow.json`](#nenworkflowjson) | [`commit format`](#nen-commit-format) (the trailer policy), [`shu coverage`](#nen-shu-coverage) (the ladder, under `--touched` with no `--threshold`), [`scaffold init`](#nen-scaffold-init) and [`scaffold new`](#nen-scaffold-new) (write it into absence, and generate both git hooks out of it), [`schema check`](#nen-schema-check) |

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
  "commits": { "allowedAttributionTrailers": [], "forbiddenTrailers": [], "runTrailer": null },
  "monitor": { "maxCycles": 20, "pollSeconds": 300 },
  "models": { "rule": "…", "<surface>": { "<tier>": "<alias>" }, "roles": { "reviewer": "deep" } }
}
```

That block is the default set, written out: it is exactly what an absent file
means, and exactly what [`scaffold init`](#nen-scaffold-init) writes (with
`iteration.lane` set to the lane it scaffolded, `commits.allowedAttributionTrailers`
set to the one trailer key `--agent-trailer` resolved to — its own default
or a caller override — `commits.runTrailer` set to `--run-trailer`'s key when
one was named, and a starting `models` matrix). **Four fields have no default
at all** — `models`, `launch.default`, `iteration.lane` and `commits.runTrailer`
— because each would be nen inventing a name rather than a number; they come
back empty or `null`.

| Key | What it decides | Read by |
|---|---|---|
| `branch.template` | how a branch is named. **Must contain `{descriptor}`** — every other token is optional, but a template without that one renders the same branch name for every effort this repository ever runs | callers |
| `branch.base` | the trunk a branch is cut from | the generated `pre-commit` hook, which bakes it in and refuses a commit made on that branch |
| `iteration.checks` / `iteration.lane` | which declared verbs an iteration proves, and in which lane | callers |
| `tests.required` / `tests.extra` | which declared verbs a test pass runs | callers |
| `coverage.minimum` / `recommended` / `ideal` / `scope` | the ladder. Whole percentages `0`–`100`, and they must **ascend** — three rungs whose order is the whole of their meaning | callers |
| `launch.default` / `launch.fallback` | which `project.launch` target a bare launch uses. No default ever | callers |
| `reports.dir` / `retain` / `template` / `captures` | where reports go. `dir` is what [`scaffold init`](#nen-scaffold-init) appends to `.gitignore`, beside `.nen/` | callers |
| `notifications.rungs` / `sound` | which escalation rungs a host hook fires | host hooks |
| `notifications.turn` | how loud an ORDINARY (no-gate) turn is: `"rung1"` (default) rings only the first rung `rungs` lists, `"all"` rings every rung `rungs` lists on every turn. Never widens what `rungs` grants | host hooks |
| `commits.allowedAttributionTrailers` / `forbiddenTrailers` | which attribution trailers a commit may carry | [`commit format`](#nen-commit-format), the generated `commit-msg` hook |
| `commits.runTrailer` | the trailer key an AUTOMATED commit must ALSO carry, alongside the one attribution trailer the hook requires. Absent (`null`) by default — a run identifier is optional, never itself an attribution trailer, so it is never folded into `allowedAttributionTrailers` | the generated `commit-msg` hook's automated half |
| `monitor.maxCycles` / `pollSeconds` | how long a monitoring loop may run | callers |
| `models.<surface>.<tier>` / `models.roles` / `models.rule` | which model alias a role gets on a surface. An **open** map at both levels — nen checks that every leaf is a string and reads nothing else | callers |

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

### Getting the binary

Each published GitHub release attaches binaries for `linux-x64`,
`darwin-arm64` and `windows-x64` alongside a `SHA256SUMS` manifest. Cutting a
tag does not by itself publish a release, so the assets exist once a release
has actually been published for that tag — not the moment
[`tag cut`](#nen-tag-cut) runs. Fetch the bootstrap script, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.6.0/bootstrap/nen.sh -o nen-bootstrap.sh
bash nen-bootstrap.sh --ref v0.6.0
```

It verifies the downloaded binary against that manifest, caches it under
`${XDG_CACHE_HOME:-$HOME/.cache}/nen`, and prints the path to a verified,
executable binary on stdout and nothing else — so it composes directly:

```bash
nen="$(bash nen-bootstrap.sh --ref v0.6.0)"
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

All 95 verbs, grouped as the README groups them. **Reads** is what a
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
| [`gate`](#family-gate) | [`nen gate derive`](#nen-gate-derive) | derive G2 vs G4 from a changed-file set against two caller-supplied path sets | git diff (for --range), no schema file -- path sets are flags | yes |
| [`split`](#family-split) | [`nen split verify`](#nen-split-verify) | prove the union of per-axis branch diffs equals one original diff | caller-supplied --original/--branches diff files, no git/gh | yes |
| [`wc`](#family-wc) | [`nen wc classify`](#nen-wc-classify) | classify the working copy as must-move / on-branch-dirty / on-branch-clean | git (branch, status, ahead-count) | yes |
| [`wc`](#family-wc) | [`nen wc squash`](#nen-wc-squash) | fold every commit since `git merge-base <onto> HEAD` into one, validated message, refused if dirty / --onto not an ancestor / any commit already on the upstream | git (status, merge-base, log, fetch, reset --soft, commit -F) | yes |
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
| [`report`](#family-report) | [`nen report data`](#nen-report-data) | one document describing a branch against a base: commits, changed files (with a caller-supplied tier), the evidence seam, the lane's coverage report if it is on disk, the build proof, the last recorded stop | git (rev-parse/symbolic-ref/log/diff), nen/contract.json for the lane, .nen/proof/&lt;lane&gt;.json, .nen/last-stop.json, the declared coverage artifact, a caller-supplied --tiers file | yes |
| [`report`](#family-report) | [`nen report render`](#nen-report-render) | fill a template with a data document and write the result: {{token}}, {{{token}}}, {{#each}}, {{#if}} and nothing else, refusing an unknown token by name | caller-named --template + --data files; writes --out, inside --repo, unless --dry-run | yes |
| [`surface`](#family-surface) | [`nen surface mirror generate`](#nen-surface-mirror-generate) | render every &lt;name&gt;/SKILL.md under a skills directory into another agent surface's own layout: the body verbatim, the frontmatter reduced to the keys that surface documents, invocation mentions respelled, personas written where the surface keeps them | caller-named --source + --agents directories; writes --out; no git/gh | yes |
| [`surface`](#family-surface) | [`nen surface mirror check`](#nen-surface-mirror-check) | regenerate that mirror in memory and diff it against the committed --out: missing / extra / stale (generated for another surface) / hand-edited | caller-named --source + --agents + --out; writes nothing at all; no git/gh | yes |
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
| [`canon`](#family-canon) | [`nen canon mirror generate`](#nen-canon-mirror-generate) | substitute every {{TOKEN}} in each canonical rule file into a mirror directory, writing only changed files and deleting orphans | caller-named --rules-dir + --canon-values file; writes --out-dir; no git/gh | yes |
| [`canon`](#family-canon) | [`nen canon mirror check`](#nen-canon-mirror-check) | regenerate the mirror in memory and diff it against the committed --mirror-dir: missing / extra / stale / hand-edited | caller-named --rules-dir + --canon-values + --mirror-dir; no git/gh | yes |
| [`quality`](#family-quality) | [`nen quality tooling`](#nen-quality-tooling) | look up the e2e/adversarial/perf tooling recorded for a scenario in a caller-supplied table | caller's own --table JSON (never a table shipped in nen) | yes |
| [`quality`](#family-quality) | [`nen quality perf-compare`](#nen-quality-perf-compare) | classify a measured-vs-baseline regression at QA-13's fixed 10%/25% thresholds | none (pure arithmetic over the two numbers given) | yes |
| [`quality`](#family-quality) | [`nen quality method-check`](#nen-quality-method-check) | validate a QA-15 method block: device/OS stated, Release with no debugger, n&gt;=5 with the first discarded, median+p90, thermal+network stated | caller's own --input JSON method block | yes |
| [`commit`](#family-commit) | [`nen commit format`](#nen-commit-format) | format and validate ONE Conventional Commits message's shape (type, subject, scope, breaking, trailers) -- never its content | nen/workflow.json under --repo, and only when the invocation carries a --trailer: the attribution-trailer policy | yes |
| [`commit`](#family-commit) | [`nen commit check`](#nen-commit-check) | is this working copy the one a green build proved? compares .nen/proof/<lane>.json's tree against the tree now | .nen/proof/<lane>.json under --repo, git (add/rm/write-tree into a scratch index) | yes |
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
`requestReviews` GraphQL mutation for a Bot). `ready` and `next-blocker`
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

**Output and exit codes** — human line is `<repo>#<pr>: <gateLine>` (or the
full conjunct table with `--explain`); `--json` top-level keys: `contract`,
`verdict` (`ready`\|`not-ready`\|`unevaluated`), `gateLine`, `firstFailing`,
`conjuncts[]` (each row `id`, `order`, `clause`, `title`, `status`, `reason`,
`note`), `caveats[]`, `remedy`, `meta`. Exit 0 only on `verdict: ready`;
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
| `--json` | no | machine-readable result | adds a `routing` array (`{ name, via, route, id }` per name/id) alongside `ok`/`message` |

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
top-level keys: `ok`, `message`, `routing`. Exit 0 on success (or a
`--dry-run`), exit 1 when no reviewers were named or a route's `gh` call
failed, exit 2 on a missing `--pr` or an unresolved `--add-reviewers` login.

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
knows whether to move it before opening a PR (`classify`, read-only); and
folds a branch's own commits into one before it is pushed (`squash`, aka's
own residue — the only verb in this family that writes anything).


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
is refused outright; a `--message-file` that fails the same shape
[`nen commit format`](#nen-commit-format) enforces (a Conventional Commits
header ≤ 72 characters, trailers as `Key: value` lines in the final
paragraph, and any attribution trailer this repository's
[`nen/workflow.json`](#nenworkflowjson) does not admit). Fewer than two
commits to fold is **not** a refusal: exit 0, one line, nothing moves.

**Usage**

```text
nen wc squash --repo <path> --onto <ref> --message-file <file> [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the working tree being squashed | unbracketed in usage; omitted is refused at exit 2, exactly as `wc classify`'s (#28) |
| `--onto <ref>` | **yes** | the ref this branch is built on top of | e.g. `main` or `origin/main`; every commit `git merge-base <onto> HEAD` finds is folded |
| `--message-file <file>` | **yes** | the new commit's whole message | validated to `nen commit format`'s shape before anything moves |
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
(`<sha> <subject>`, oldest first), then either the new commit line
(`squashed into <sha>`) or, for `--dry-run`, the message that would have been
committed. `--json`'s contract is `nen.wc.squash/v0.1`: `{ contract, onto,
mergeBase, folded: [sha, ...], newSha, dryRun }` — `folded` is oldest first;
`newSha` is `null` for a dry run and for "nothing to squash". Exit 0 on a
squash, a dry run, or "nothing to squash"; exit 2 on every refusal above,
naming it; exit 1 when a git command this verb did not expect to fail fails
anyway (an unresolvable `--onto`, a fetch that cannot reach the upstream) —
never folded into one of the exit-2 refusals, exactly as
[`wc classify`](#nen-wc-classify)'s own git-failure rule.

**Example**

```bash
nen wc squash --repo . --onto main --message-file message.txt --dry-run
```
```text
would fold 3 commit(s) onto 82d4c9bc5882f21eb8b8d19a27dcedf2406fb316 (--onto main):
  f362ffd1cc489b413f0ecb40af06a208827d34f3 feat: add one.txt
  2069b623c8d8885db60ff94bd098ccc821caf271 feat: add two.txt
  33e9e20d4ef97e60a94a34deb86c8744c5635621 feat: add three.txt
message:
  feat(wc): add one/two/three together

  Closes: #99
```
```bash
nen wc squash --repo . --onto main --message-file message.txt
```
```text
  f362ffd1cc489b413f0ecb40af06a208827d34f3 feat: add one.txt
  2069b623c8d8885db60ff94bd098ccc821caf271 feat: add two.txt
  33e9e20d4ef97e60a94a34deb86c8744c5635621 feat: add three.txt
squashed into 2bc2e0e68e8aa13fe7476b190dfccb3e8ac24bf8
```
(from a real run, on a throwaway local repository built for this check: three
commits on `docs-example` folded onto `main` into one, `git log -1 --format=%B`
afterwards reading exactly `message.txt`'s contents — `feat(wc): add
one/two/three together`, blank line, `Closes: #99`)

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
fragment name **in the order it was written into the section** — newest-first
by the leading `<n>-` prefix, the same order the section itself reads, so the
manifest can be cross-checked against it line for line. `--json` top-level
keys: `version`, `theme`, `fragments[]` (that same order), `written`. Exit 0 on any completed run — there is no "drift" verdict here,
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

Validates the SHAPE of a Conventional Commits message -- a declared type, a non-empty subject under 72 characters, no trailing sentence punctuation -- and never its content; what changed and why stays the author's to write. `format` reads and writes nothing on disk or over the network beyond the trailer policy; `check` reads one build proof and asks git for a tree hash, and writes nothing at all.

### `nen commit format`

Builds and validates one Conventional Commits header (`type(scope)!: subject`) plus optional body paragraph and trailers, from the type set `feat, fix, chore, docs, refactor, test, perf, build, ci`. `--trailer` keys are caller data (a specific persona's trailer convention lives in the calling skill, never a literal in this binary).

**A repository may state which ATTRIBUTION trailers it admits, and then this verb enforces it.** When [`nen/workflow.json`](#nenworkflowjson) is present under `--repo`, a `--trailer` whose key is attribution-shaped and is *not* listed in that file's `commits.allowedAttributionTrailers` is refused at exit **2**, naming the trailer and the file. Attribution-shaped means one of `Assisted-by`, `Claude-Session`, `Co-Authored-By`, `Generated-by`, `Generated-with`, `Reviewed-by`, `Signed-off-by` — the keys that say *who or what produced this commit* — plus every key the file's own `commits.forbiddenTrailers` adds; matching **ignores case**, because every tool that reads the finished commit does. `Closes`, `Refs` and a project's own agent trailer are untouched.

**With no workflow file, nothing is refused and this verb behaves exactly as it always has.** The list is never nen's: `commits.allowedAttributionTrailers` is the repository's, and a guard that fired without the repository having asked for it would be this verb deciding somebody's commit convention for them. The policy is read **only when the invocation carries at least one `--trailer`** — a message that could not have violated it never touches the filesystem. A workflow file that is present and **malformed** is exit **1**, naming the pointer: the invocation was correct, and nen will not shape a message under a policy it could not read.

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
| `--trailer key=value,key2=value2` | no | Comma-separated `key=value` pairs. | A key containing `:` or empty is refused. An attribution-shaped key the repository's `nen/workflow.json` does not admit is refused too — see above. |
| `--repo <path>` | no | The repository whose `nen/workflow.json` states the trailer policy. | Defaults to the cwd, and is opened **only** when this invocation carries a `--trailer`. |

**Output and exit codes** -- prints the formatted message. `--json`: `{ message }`. All shape violations and policy refusals print as plain `nen:` lines even under `--json`, and **every** one of them is printed, not just the first -- a shape violation and a refused trailer in the same invocation are two problems reported together. Exit 0 on a valid shape; exit 2 on any shape violation or trailer-policy refusal; exit **1** in exactly one case, a `nen/workflow.json` that is present and could not be read.

```bash
nen commit format --type fix --subject "stop dropping the last row" --trailer "Co-Authored-By=A" --repo .
```
```text
nen: trailer key 'Co-Authored-By' is an attribution trailer this repository refuses. '/tmp/site/nen/workflow.json' admits 'Akatsuki-Agent', 'Akatsuki-Run' under commits.allowedAttributionTrailers, and 'Co-Authored-By' is not one of them. Drop the trailer, or add its key to that list
```
exit 2. (from a real run against a scratch repository scaffolded by `nen scaffold init`; the absolute path is elided to `/tmp/site`)

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
| `project.defaultLane` | Which lane `--lane` defaults to. `null` is legal and means `--lane` is required — even when there is exactly one lane, so a second lane arriving later cannot silently change what a scripted `nen shu build` builds. |
| `project.verbs` | `{ "<lane>": { "<verb>": <invocation> } }`, where an invocation is `{ exe, argv }`, `{ steps: [...] }`, or `{ unsupported: "<why>" }`. `argv` is a **list**, never a string: there is no shell, no expansion, no `sh -c`. An invocation may also carry `env` (NAME → value, passed to the child; only the names are ever reported), `artifacts` (repo-relative paths the verb produces, which nen reports and never creates) `stall` and `stdoutTo` (both below). |
| `…<verb>.stall` | `{ elapsedMs, quietMs, onStall: { exe, argv }, maxStrikes }` — what to do about a step that stops making progress, **in the repository's own words**. Some toolchains hang: a compiler process wedges, the build stops emitting and never finishes, and the fix is to kill the wedged **grandchild** and let the build respawn it. Which process that is, and how it is named, is knowledge about a toolchain — the one thing this family's executor may not carry — so the repository declares the remedy as an ordinary argv and nen contributes the two numbers that decide **when**. It runs `onStall` once **both** budgets are past: `elapsedMs` since the step started **and** `quietMs` with no output. Both, never one — a guard that acted on silence alone would fire at a healthy build that legitimately went quiet early on. Each firing restarts the quiet window and costs a strike; after `maxStrikes` (default **2**) the step is reported **stalled** at exit 1. **Nen never kills the child it started**, at any strike count: on a stall it stops watching, stops waiting, and says the process is still running and is yours to stop. Both budgets and `maxStrikes` are required positive integers (a default for either budget would be nen deciding what "too long" means for somebody else's build) and `onStall` is argv, never a string. Declarable on an invocation (it reaches every step that declares none) or on one `steps[]` entry (which wins). Only on the verbs whose output nen READS — `build`, `test`, `ui-test`, `lint`, `archive`, `coverage`, `test-report` — since [`dev`](#nen-shu-dev)/[`run`](#nen-shu-run) hand this terminal to the child and `release`/`deploy` put bytes where nen will not intervene mid-flight; anywhere else is exit 2 naming the set. `--dry-run` prints it as an `on stall:` line under the step it guards. |
| `stdoutTo` | On an invocation, or on one entry of its `steps`: the **repo-relative file** that step's stdout is written to. There is still no shell and no redirection **operator** — nen already captures a child's stdout, and this says to write those bytes to a file rather than relay them. It is the answer for a tool that **prints** the thing nen then parses (`xccov view --report --json` is the bundled example: `nen shu coverage` reads a *file*). Refused **at load** for a path that is absolute, carries a `..` segment, or carries a glob character (`*`, `?`, `[…]`) — nen expands nothing, so a glob would create a file with that character in its name; refused **at the run**, before anything spawns, when a directory is already at the path or a symlink would land the write outside the tree. Refused outright on `dev` and `run`: those hand the terminal to the child, so nen never sees their output. The file is written whatever the tool exited (a half report is what a redirect leaves), and **not** written for a step that could not start. That step's stdout does not also go to the terminal; its **stderr** still does. `--dry-run` prints `stdout -> <path>` on the step, the report lists every such file beside `artifacts`, and `--json` carries `steps[].stdoutTo`. It works on a step that also carries a `stall` guard: that step's output arrives from the streaming seam as chunks rather than as one buffer, so the chunks are held and joined rather than relayed. |
| `project.preconditions` | `{ "<lane>": [ { kind, value, why } ] }`. Nen **asserts** these and **never performs** them. |
| `project.hosts` | `{ "<verb>\|*": ["darwin","linux","win32"] }`, compared against this host. An exact verb key wins over `*`, and a declaration with no `hosts` block constrains no verb — a repository that said nothing about platforms has not said `darwin`. |
| `project.targets` | `{ "<name>": { args, requiresEnv, unsupported, why } }` — the deploy destinations, and a **project-level** map rather than a per-lane one. `--target` must name a key of it, and there is no default — not even when there is exactly one. The **command** stays in `project.verbs.<lane>.deploy`, where every other verb's command is; a target says where that command sends it. `args` are appended to that argv, in order — refused on a multi-step row (which step reaches the destination is a guess), and refused, like any other argv, when they carry one of the reference pack's own placeholder tokens. `requiresEnv` names variables that must be **set**, asserted exactly as a precondition of kind `env` is — the value is never read, compared, logged or printed, so a credential belongs in the environment and never in this file; each entry is held to a shell identifier (`[A-Za-z_][A-Za-z0-9_]*`) at load, because a name no environment could carry is a row that could only ever report `FAIL`. Repeats are collapsed, and a variable the lane's own preconditions already declare is asserted **once**. `unsupported` is the destination that has **no command line at all** (a hosting provider's own push integration, a CI action): exit 4 in the repository's own words, and the sentence is required rather than just the key. All four keys are optional; `{}` is a legal name-only target, and naming it is still mandatory. **Unknown keys are preserved** here as everywhere in this schema — with one exception: a key that misspells one of the four is **refused by pointer, naming the key it meant and which misspelling it is** — one letter out (`arg`, `requireEnv`), the same word in a different case (`Args`, `WHY`), or that key with an English plural on it — because preserving it means the flag was accepted, nothing was appended, and a different command deployed at exit 0. **Target names are the repository's own** and nen constrains them no more than it constrains a lane name: a name carrying a space or a leading `-` is legal, is listed verbatim in every refusal, and a leading `-` reaches `--target` only through the `--target=<name>` spelling. See [`nen shu deploy`](#nen-shu-deploy). |
| `project.launch` | `{ "<name>": { verb, lane, args, artifact, device, after, unsupported, why } }` — the **launch** targets `nen shu dev` and `nen shu run` take, and a project-level map like `targets`. A different block and a different vocabulary: `targets` says where a build is **sent**, `launch` says which **device** a local run lands on. `--target` is **optional** here — a bare `dev` runs the lane's declared `dev`, as it always has — and a name this block does not carry is exit 2 listing the ones it does. `verb` is `dev` or `run`, required, out of a closed set: the two are different builds, so naming a `dev` target on `run` is exit 2 rather than a silent cross-over. `args` are appended to that verb's argv, refused on a multi-step row exactly as a deploy target's are, and refused at exit 2 when they name `{device.id}` or `{artifact}`: substitution reaches the target's `after` steps and nowhere else, so a token here is not unfillable but simply unfilled, and would reach the child process as itself. `device` is `{ name, kind, resolve, readyWhen }`: `name` is matched **exactly** against what the probe printed (never a prefix, never a case fold, never "the only one connected" — nen does not pick a device); `resolve` is a declared `{ exe, argv }` probe whose output nen searches, as JSON (a `name` property, with `identifier`/`id`/`udid`/`serial` from the same object, one of its direct children, or up to two enclosing objects) or as plain lines (the line carrying the name, and its first token of six-plus characters that carries a digit); `kind: "simulator"` with no probe resolves the id to the **name itself** and spawns nothing, while any other device with no probe is exit 2. A device the probe did not name is **exit 5 listing what it did offer**, and a name two id-bearing candidates carry is exit 5 naming both rather than a guess. `readyWhen` is **which of the probe's own states count as ready**, optional, and absent leaves the behaviour exactly as it was — a row that carries the name is taken as the device. It is `{ "field": <n>, "in": […] }` for a probe that prints lines (`field` is a whitespace-separated position on the device's own row, **counting the first token as 1**, the way a reader counts columns on their screen) or `{ "path": "<key>", "in": […] }` for one that prints JSON (a dotted key read off the object whose `name` matched, or — exactly as the id is — off an enclosing object up to two levels out). **Exactly one** of `field`/`path`, `in` non-empty beside it, `field` a whole number ≥ 1, and the rule refused on a device with **no `resolve` probe** (nothing is spawned there, so the rule would never be read) — all four at load, by pointer. States are compared as whole strings, verbatim; a JSON `true` or `3` at the named path is compared as `"true"` and `"3"`. A device whose row is present but whose state is not in the set is **exit 5 naming the device, the state seen and the states accepted**, and listing what the probe offered — the same discipline the absence refusal follows. `lane` is which lane that verb is read from, **optional**, and absent means the lane `--lane` named or, with no flag, `project.defaultLane` — it exists because a device build is routinely a different declared row from the one a developer iterates in, and a target that could not say so would install whatever the default lane produced; it must name a **declared** lane (refused by pointer at load, listing the ones that are) and an explicit `--lane` that disagrees with it is exit 2 naming both, because nen picks between two stated facts nowhere. It is read **before anything is rendered**, so a target whose own lane is the only one declaring the verb is reachable without retyping `--lane` — a lane the declaration overrode does not get to refuse the run first. `artifact` is the repo-relative path `{artifact}` stands for **instead of** the verb's first artifact, also optional: "the first artifact" is the right answer for the thing a lane *builds* and the wrong one for the thing a device *installs*, and a build routinely produces both. It is refused **outside the tree** (pointer `project.launch.<name>.artifact`, the same containment rule every declared path gets), refused as an empty string, and refused when **no after-step names `{artifact}`** — the key has one effect and a target that never writes the token has stated a path nothing reads. `after` is `[{ exe, argv }]` run once the verb exits 0, with `{device.id}` and `{artifact}` substituted — `{artifact}` is the **first** entry of the verb's own `artifacts` unless the target overrides it, and naming either token with nothing to fill it is exit 2 before anything spawns. `unsupported` is the target with **no command line at all** (a device farm's web console): exit 4 in the repository's own words, and it may not be declared beside anything that would be run. **Unknown keys are preserved** here as everywhere — except a key one spelling away from one nen reads (`arg`, `devices`, `resolver`, `verbs`, `lanes`, `artifacts`, `readywhen`, a readiness rule's own `fields`/`paths`, and the block key itself as `launches` or `Launch`), which is **refused by pointer naming the key it meant and which misspelling it is** — one letter out, a case slip, or an English plural. See [`nen shu dev`](#nen-shu-dev). |
| `project.evidence` | `{ globs, mechanism, scene, suiteSuffix }` — what [`shu evidence`](#nen-shu-evidence) matches a changed file against, **project-level** like `targets` rather than per-lane. `globs` (required, at least one) is a list of `*`/`**`/`?` patterns; `mechanism` (required) is one of `public-mirror` \| `files-changed` \| `embedded`, the repository's own answer to "how does a survivor reach a human" — `evidence` never mirrors, embeds or lists files itself, it only reports which mechanism a later step should use. `scene` (default `"{suite}-{scene}"`) and `suiteSuffix` (default `"SnapshotTests"`) are read by a later mirroring step, not by this release of `evidence` itself, which reports `suite` and `scene` as separate row fields. Refused by pointer, exactly as `targets` is and saying which misspelling it is, for a key that misspells one of the four — **and for a misspelling of the block key itself** (`evidences`, `Evidence`, `evidenc`), which no per-entry guard could catch: preserved as an unknown key it would be read by nobody, and this verb would refuse saying the repository declares no evidence block, about a file that plainly declares one. `launch`'s block key is guarded the same way; the older optional blocks (`targets`, `hosts`, `toolchain`, `profiles`) are deliberately **not**, because a declaration written against 0.3.0 may already park a near-miss key there. Absent block: exit 2 naming it. |

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
on stall:      after 2000ms elapsed AND 1000ms with no output: echo 'the repository'\''s own remedy ran'  (up to 2 times; ran 2 at 2009ms, 3516ms; STALLED -- every remedy spent)
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
2. **the lane's own verb**, interactively as ever, with the target's `args` appended (refused on a multi-step row — which step reaches the device is a guess). **Which lane** is `project.launch.<name>.lane` when the target names one — read before the invocation is rendered at all, so the override reaches the verb rather than being second-guessed by the lane it replaced — and otherwise the lane the invocation already resolved: a device build and the build a developer iterates in are two declared rows, and the target is where the file says which of them this launch is. An explicit `--lane` that contradicts it is exit 2 naming both, never a silent winner;
3. **the target's `after` steps**, captured, in order, with `{device.id}` and `{artifact}` substituted — `{artifact}` being the **first** entry of the verb's own `artifacts`, or `project.launch.<name>.artifact` where the target names one. That override exists because the first artifact is the thing the lane *built* and the installer wants the thing it *signed*, which is a later entry; it is refused outside the tree, refused empty, and refused when no after-step names `{artifact}` at all. Naming `{artifact}` on a verb that declares none *and* a target that overrides nothing, or `{device.id}` on a target with no device, is exit 2 *before anything spawns*: a token nothing can fill must never reach a command line as itself. Either token written into `args` is exit 2 for the other half of the same sentence — `args` is appended to the verb's own argv, which substitution never touches. They run only if the verb exited 0, and **a verb that never exits never reaches them** — that is what the declaration asked for, and nen backgrounds nothing.

   **`{artifact}` is substituted relative to the directory the after-step runs in**, which is the *lane's* — while `artifacts` and `project.launch.<name>.artifact` are stated, like every declared path, against the *repository root*. On a lane whose `cwd` is the root the two are the same string and always were, so nothing an existing declaration passes changes by a byte; on a lane one directory down, a declared `build/App.app` reaches the installer as `../build/App.app` rather than as a path that resolved against the wrong root. The `substitutes:` line says both when they differ — `{artifact} <- ../build/App.app  (declared build/App.app, as the after-steps' own directory sees it — lane '<name>' does not sit at the repository root)` — while `artifacts:` keeps reporting the repository-relative string: the two answer different questions (*what does this build produce* against *what will the child receive*), and collapsing them would hide the rebasing rather than show it. `--json` carries both, as `target.artifact` (the declared override, or `null`) and `target.artifactAs` (what is actually substituted).

All three run in the lane's `cwd` and are given the verb's own declared `env`: a launch is one lane operation, and an installer that could not see the variables the build was given would be a second environment nobody declared. Only the **names** are ever reported, here as everywhere.

**Which refusal answers first, when `--target` is given.** A target belongs to **one** of the two long-running verbs, and that is a fact about the declaration — true on every lane and every host — while a lane's `unsupported` seat is a fact about one row. So the target's own verb is checked **before the lane is even read**: `nen shu run --target <a target declared for dev>` is exit **2** naming the fix (`run 'dev --target <name>'`), never the lane's exit 4. It used to be the other way round, and on any lane where the other verb is seated or simply undeclared the caller got a dead end — *"'run' is unsupported on lane 'device'"*, true, and pointing at a row they never wanted — while nen already held the sentence that ends the problem one check further down. Everything else keeps the order it had: a lane's seat still answers **4** when the target's verb *does* match (there the seat is the whole answer), a target with **no command line at all** still answers 4 in the repository's own words, and a `--target` this block does not declare is still exit 2 listing the ones it does.

`--dry-run` prints all three as `would run:` lines with the tokens **unfilled**, plus one `substitutes:` line saying what each stands for, and spawns nothing at all — the probe included, which is what keeps this form read-only in [izanami's table](#nen-parse-izanami). `--json` still needs `--dry-run`, and the document's `target` is then `{ name, verb, lane, args, artifact, artifactAs, device: { name, kind, id, readyWhen }, probe, after }`, with `id` null exactly because nothing was probed.

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
| `--touched` | no | Narrow `targets` to the rows a change touched. | Requires `--base`; given without it, **exit 2**. With `--threshold` absent, also loads `nen/workflow.json`'s coverage ladder (defaulting to 80/85/90 when that file is absent) and bands each row; a malformed policy is exit 1 before anything is spawned. See below. |
| `--base <ref>` | only with `--touched` | The ref `--touched` diffs `HEAD` against. | Given without `--touched`, **exit 2** — it has nothing to do on its own. No default: nen never invents a base. |
| `--dry-run` | no | Print every step, run nothing — and **parse nothing**. | The report may well be on disk from a previous run; a dry run does not read it, because reporting yesterday's numbers for a command that did not execute is the most believable wrong answer this verb can give. `--touched` still computes the touched-file set under `--dry-run`: that read is `git diff`, not the declared tool, and previewing which files would be checked costs nothing. |

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
scopes its bar to *the files a pull request touched*, which is exactly what
`--touched` below answers. Read `met` and decide.

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
- **Package-grain formats** (`cobertura`, `jacoco`) name a row after a
  *package*, not a file, so a touched file matches when its own path contains
  that package's segments, in order, with the file itself left over —
  "this touched file sits **under** that package". The text rendering says so
  (`-- rows matched BY PACKAGE, not by file`); `--json` does not carry the
  grain, because it already follows from `report.format`.
- **`xccov-report`** is read at **file** grain here only: nen descends
  `targets[].files[]` instead of stopping at the target row, because "this
  whole app/framework was touched" is true of nearly every diff and would
  keep almost the entire table. The file path is relativised the same way
  every other format's row name is.

`--json` gains a ninth key, `touched: { base, files, matched, unmatched }`
(`files` is everything git named; `matched` and `unmatched` partition it —
their lengths always sum to `files.length`), and each **row** gains its own
`met` when `--threshold` is also given — the aggregate `threshold.met` above
still answers for the whole report; a row's `met` answers for that row alone,
both compared on the **counts**, never the rounded percentage. **This still
never gates**: the exit code is the run's, exactly as bare `--threshold` is.

`--dry-run --touched` still computes and reports the touched set: that read is
`git diff`, not the declared tool, so a preview costs nothing — `targets` is
still empty, because nothing was parsed to filter.

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
targets, threshold, report, exitCode, touched, ladder }`. `percent` is computed
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
| `--dry-run` | no | Print every command, in order, and **mutate nothing**. | It performs exactly **one** command and the list is closed: `git worktree list --porcelain`, the one question the plan cannot honestly guess at (see above). Not the fetch, not the status, not a probe. That row carries its real exit code and is labelled `ran:`; every other row is labelled `would run:`, and `dryRun` on the report says which form this is. Two lines still say what a real run would decide differently: that `main` is an assumption, and that the orphan-commit count is asked only on a detached `HEAD`. |
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
| 4a | `git worktree list --porcelain` | it cannot be read at all (exit 2). Its answer decides step 9, and only step 9. An unanswered question is never read as "nothing else holds the trunk" — that reading is what made the fast-forward fail half-way through a run that had already fetched |
| 5 | `git check-ref-format --branch <name>` | git will not accept the name (exit 2, quoting git's own refusal) |
| 6 | `git show-ref --verify --quiet refs/heads/<name>` | the name is already a local branch (exit 2) |
| 6a | `git reset --hard`, then `git clean -fd`, then the status read **again** | only with `--discard`, and only when there was something to discard. The re-read refuses at 2 if anything survived — see [below](#what---discard-removes) |
| 7 | `git fetch origin` | it fails (exit 1 — a *step* failure, not a refusal) |
| 8 | `git merge-base --is-ancestor <trunk> origin/<trunk>` | the local trunk has **diverged** (exit 2). A code *above* 1 is git failing to answer and is reported as that, never as "diverged" |
| 9 | `git merge --ff-only origin/<trunk>` *(this checkout is on the trunk)*, `git branch --force <trunk> origin/<trunk>` *(no worktree holds it)*, or **nothing at all** *(another worktree holds it)* | it fails. Three shapes because git has three: a checked-out branch cannot be moved by `branch --force`, one that is not checked out cannot be advanced by `merge`, and one checked out in **another** worktree cannot be moved from here at all — so it is skipped, named, and step 11 cuts from the fetched ref regardless |
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

`--json` is `{ contract, repo, trunk, remote, branch, discard, dryRun, steps, lane, exitCode }`, in that order,
with `contract: "nen.shu.warmup/v0.1"`. Each `steps[]` row is `{ kind, argv, exitCode, durationMs, note }`,
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
would run:     git rev-list --ignore-missing -1 MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD
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
would run:     git switch -c my-idea origin/main
would run:     pnpm turbo run build
```

(most lines also carry an indented note saying what that step decides or refuses on; they are elided
here. exit 0, and the only thing spawned is the `worktree list` — the one row labelled `ran:`. The
orphan-commit count on line 2 is one of the two a real run may spell differently: it asks it only when
line 1 comes back empty. With `--discard` the plan gains `git reset --hard`, `git clean -fd` and a second
`git status` after line 9.)

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
ran:           git rev-list --ignore-missing -1 MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD  -- exit 0 in 14ms
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
ran:           git switch -c my-idea origin/main  -- exit 0 in 16ms
               cut from origin/main, the tip this run just fetched
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
| `--source <owner/name>` | no | GitHub repository to fetch release assets from. | Defaults to `zheref/nen` inside the script; NOT `--repo` -- a wholly different meaning (a path vs. an `owner/name`) is deliberately given two different flag names across both the shell and the CLI. Both halves must be a real name: neither may be empty, `.` or `..`, so `a/..` is a usage error (2) at the flag rather than a 404 from the network. |
| `--cache-dir <dir>` | no | Cache root for verified binaries. | Defaults to `${XDG_CACHE_HOME:-$HOME/.cache}/nen`. A verified binary is cached at `<root>/<source>/<ref>/<artifact>`, each key flattened to exactly one path segment -- so a fork or a mirror at the same tag as the upstream gets its own slot instead of sharing one. |
| `--script <path>` | no | An explicit path to `bootstrap/nen.sh`, for a binary invoked outside any checkout. | Falls back to `$NEN_BOOTSTRAP_SH`, then `<repo>/bootstrap/nen.sh`. |
| `--repo <path>` | no | The checkout `bootstrap/nen.sh` is found under, when `--script` is not given. | Defaults to the cwd. |

**Output and exit codes** -- stdout carries ONLY the verified path, and only on success; every diagnostic is on stderr. Exit codes are a published contract, restated from `bootstrap/nen.sh`'s own header, printed in full by `nen bootstrap --help` since [#58](https://github.com/zheref/nen/issues/58) (a caller scripting around code **7** had to discover its meaning empirically before that), and cross-checked by `src/supply/bootstrap.test.ts`, which fails the build if the help text omits a code `BootstrapExit` declares: `0` OK, `2` usage error (nothing attempted), `3` unsupported host (no binary published for this OS/arch), `4` download failure -- **the only retryable one**, `5` checksum mismatch or unverifiable -- SECURITY, never retry, `6` manifest (`SHA256SUMS`) unfetchable/missing/malformed/silent about the artifact -- never retry, `7` the TypeScript wrapper itself could not run the script at all (no `bash` on PATH, script not found) -- distinct from any code the script itself can return.

**Example**

```bash
nen bootstrap --ref v0.6.0 --source zheref/nen
```
```text
/home/me/.cache/nen/zheref_nen/v0.6.0/nen-linux-x64
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
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--repo <path>` | **yes** | the working tree this report describes | unbracketed in usage; omitted is refused at exit 2 (#28) |
| `--base <ref>` | **yes** | what this branch is measured against | the trunk, or the commit the effort was cut from; a ref that does not resolve is refused at exit 2 naming it, with nothing read |
| `--lane <name>` | no | which declared lane's coverage report and build proof to read | defaults to the declaration's own `defaultLane`; with neither, both fields are `null`. A value that would escape the tree through `.nen/proof/<lane>.json` is refused at exit 2 |
| `--tiers <file>` | no | a JSON object mapping a tier name to its paths | `{ "<tier>": ["<path prefix or glob>", …] }`. The file's **key order is the precedence** — the first tier whose patterns match a path wins. A pattern with no `*`/`?` is a path **prefix** matched on segment boundaries (`src/report` claims `src/report/data.ts`, never `src/reporting.ts`); one with them is a narrow glob (`*` stops at `/`, `**` crosses it, `?` is one character). Without the flag every file's `tier` is `null` |
| `--json` | no | the document itself | — |

**Output and exit codes** — human lines: a `repo:`/`generated:` header, then `commits:` and one line per commit, `files:` and one line per file (status, path, tier), then `evidence:`, `coverage:`, `proof:` and `last stop:`. `--json` keys, in this order: `contract` (`nen.report.data/v0.1`), `repo`, `branch` (`null` on a detached HEAD), `base`, `generatedAt`, `commits[]` (`sha`, `subject`, `author`, `date`), `files[]` (`path` — a rename's **destination** — `status` (git's own token, `R096` and all), `tier`), `evidence[]` (empty; see below), `coverage` (`lane`, `format`, `path`, `total`, `targets[]` — the same shape [`shu coverage`](#nen-shu-coverage) parses, from the same parser — or `null`), `proof` (`.nen/proof/<lane>.json` verbatim, or `null`), `lastStop` (`.nen/last-stop.json` verbatim, or `null`). Exit 0 on any document; exit 1 when `git log`/`git diff` fails for a reason other than the flags — git could not be run at all, or ran and refused (no repository, an unreadable object) — with `--base` already known to resolve; exit 2 on a missing `--repo`/`--base`, an unresolvable `--base`, a `--tiers` file that is not a tier table, or a `--lane` that escapes the tree.

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
nen report render --template <file> --data <file> --out <file> [--dry-run] [--repo <path>] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--template <file>` | **yes** | the template to fill | read **raw**: its own line endings survive into the output, so a CRLF template writes a CRLF report |
| `--data <file>` | **yes** | the JSON document every token is answered from | typically [`report data --json`](#nen-report-data)'s output, but any JSON works |
| `--out <file>` | **yes** | where to write | must resolve **inside** `--repo`, **with symlinks resolved** — a `Reports/` that is a link out of the tree is refused naming the link. Parent directories are created |
| `--dry-run` | no | print every token the template names and write nothing | it still parses **and renders**, so its refusals are the real run's; a refusal on a dry run also lists the tokens, so the advice to run it is not a loop |
| `--repo <path>` | no | the tree `--out` is checked against | bracketed: defaults to the current directory, which is the tree the report belongs to |
| `--json` | no | the render report | — |

**Output and exit codes** — human lines: `template:`, `data:`, `out:`, `tokens: <n>` then one indented token per line, then `wrote <out>` or `(dry run) nothing written`. `--json` keys, in this order: `contract` (`nen.report.render/v0.1`), `template`, `out` (both **as the caller typed them**, never resolved — an absolute path in a document destined for a PR body carries a home directory with it), `tokens[]` (first-appearance order, de-duplicated), `written` (`false` on `--dry-run`). Exit 0 on a fill; exit 2 on a missing flag, an `--out` outside the tree, an unreadable template, a `--data` that is not JSON, a tag this language does not have, a block left open, a token the data has not got, or a value with no text form. Nothing is written on any refusal.

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

The two rows this release ships, read on 2026-09-10:

| | `codex` | `cursor` |
|---|---|---|
| skills read from | `.agents/skills/<name>/SKILL.md` ([docs](https://learn.chatgpt.com/docs/build-skills)) | `.cursor/skills/<name>/SKILL.md` ([docs](https://cursor.com/docs/skills)) |
| frontmatter kept | `name`, `description` — the page documents no other key | `name`, `description`, `paths`, `globs`, `disable-model-invocation`, `icon`, `color`, `metadata` — the documented table, whole |
| required | `name`, `description` | `name`, `description` |
| invocation spelled | `$<name>` (*"run /skills or type $ to mention a skill"*) | `/<name>` (*"you explicitly type /skill-name in chat"*) |
| personas | **no markdown persona file** — every one becomes a `## <name>` section of a generated `AGENTS.md` ([docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md)) | one file per persona under `<out>/agents/<stem>.md`, frontmatter reduced to `name`, `description`, `model`, `readonly`, `is_background` ([docs](https://cursor.com/docs/agent/subagents)) |

Two caveats the table carries and prints on stderr, rather than acting on:
Codex **also** documents standalone per-agent **TOML** files under
`.codex/agents/` (`name`, `description`, `developer_instructions`), which this
verb does not write — it mirrors markdown to markdown, so a persona lands in
`AGENTS.md` as prose; and Cursor documents that a skill's `name` must be
lowercase letters, numbers and hyphens and must match its folder name, which nen
carries through and does not enforce.

**The generated marker is the first *markdown* line, not the first line of the
file.** Every surface here identifies a skill by YAML frontmatter delimited by
`---` **at the start of the file**, so an HTML comment above that fence would
produce a file the surface silently declines to load — a "do not edit" banner
bought at the price of the document. So the marker sits immediately after the
closing fence (and on line 1 of `AGENTS.md`, which has no frontmatter):

```text
<!-- GENERATED by nen surface mirror (surface: cursor) -- do not edit; edit the source and regenerate -->
```

It is ASCII, it names the surface, and `check` reads it back out of that one
position only — a marker-shaped line further down the file (a quoted example, a
nested fence) is never mistaken for the real one, the same anchoring
[`canon mirror check`](#nen-canon-mirror-check) applies to its own header.

**What is mirrored, and what is not.** Only `<name>/SKILL.md` — a skill
directory's `scripts/`, `references/` and assets are left where they are, and a
mirror directory may hold them beside the generated file without either verb
touching them. The **filename universe** these two verbs consider their own has
**two** conditions: a file must sit at one of the row's own locations
(`<name>/SKILL.md`, or the persona location) **and carry a generated marker**.
An unmarked file is somebody's own work wherever it sits, so it is never
overwritten, never deleted as an orphan, and never reported as `extra` — a
`SKILL.md` written by hand in the mirror directory is as untouchable as a
`README.md` beside it. The gate is "carries *a* marker", not "carries *this*
surface's": a file generated for another surface whose source has since gone is
still this generator's output, and is exactly what `check` calls `extra` and
`generate` deletes. Both verbs read the same list, so what one reports the other
clears.

### `nen surface mirror generate`

Reads every `<name>/SKILL.md` under `--source` and writes `<out>/<name>/SKILL.md`
with the body verbatim, the frontmatter reduced to the keys `--surface`'s row
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
nen surface mirror generate --source <dir> --surface codex|cursor --out <dir>
                            [--agents <dir>] [--invocation-prefix <prefix>]
                            [--dry-run] [--json]
```

**Arguments**

| Flag | Required | Meaning | Notes |
|---|---|---|---|
| `--source <dir>` | **yes** | the directory whose **subdirectories** are the skills | one holding no `<name>/SKILL.md` is refused at exit 2, never mirrored as empty: an empty generation would delete the whole mirror as orphaned, so the one plausible typo (`--source` pointed one level too high) would quietly empty it instead of saying so |
| `--surface <name>` | **yes** | which row of the table above | anything else is refused at exit 2, listing the ones that exist |
| `--out <dir>` | **yes** | where the mirror is written | a path resolving **inside** `--source` (its own directory included) is refused at exit 2 — the mirror would become part of the source, and the next run would mirror its own output. Created if absent |
| `--agents <dir>` | no | a directory of `*.md` persona files | each persona's `name:` frontmatter names it, falling back to the filename. An empty directory is fine; an empty *value* is refused. On a surface that keeps personas as **files**, a persona that would mirror to an **empty frontmatter block** — no fence in the source, or a fence holding only keys that surface does not read — is refused at exit 2: the file written would carry no frontmatter at all, and there would be nothing for the surface to route on. On a surface whose personas are **prose** (the appendix), the same file is fine, because frontmatter is not a concept there |
| `--invocation-prefix <p>` | no | the **source's own** invocation namespace, e.g. `myplugin:` | caller data, never a literal in this binary (§3), for the same reason [`canon mirror generate`](#nen-canon-mirror-generate)'s `--header-template` is a flag. Without it nothing is rewritten; with it, mentions of skills *outside* the mirrored set are rewritten too, because a half-rewritten document is worse than an unrewritten one |
| `--dry-run` | no | compute the same three lists and write nothing | including the orphans it would delete |
| `--repo <path>` | no | Not used — this verb operates purely on the paths given. | |

**Output and exit codes** — prints `surface:`, `out:`, then `written:`,
`unchanged:` and `deleted (orphaned):` (each `(none)` when empty); the row's
caveat goes to **stderr**, so `--json` stays one document. `--json`:
`{ contract: "nen.surface.mirror.generate/v0.1", surface, skillsPath, out,
dryRun, written, unchanged, deleted }`. Exit 0 on any completed run; exit 2 on a
missing or unknown flag, an `--out` inside `--source`, a `--source` with no
`SKILL.md`, a `SKILL.md` with no frontmatter block or missing a key the surface
documents as required, or a destination that exists and carries no marker.

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
written: agents/scout.md, alpha/SKILL.md, beta/SKILL.md
unchanged: (none)
deleted (orphaned): (none)
```
The `alpha` skill's source frontmatter carries `name`, `description`,
`allowed-tools`, `model`, `license` and `metadata`; what lands in the mirror is
`name`, `description` and `metadata`, and every `demo:alpha` in the body — and
in the description — has become `/alpha`. Under `--surface codex` the same
source produces `name` and `description` only, `$alpha`, and one `AGENTS.md`
holding a `## scout` section instead of `agents/scout.md`.

### `nen surface mirror check`

Regenerates from the SAME inputs `generate` uses and diffs the result against
`--out` **without writing anything** — the CI-safe half of the pair. A file is:

| Class | Meaning |
|---|---|
| `ok` | byte-identical to a fresh generation |
| `missing` | the source has it; `--out` has not |
| `extra` | `--out` has it, in the mirror's filename universe, and no source produces it |
| `stale` | it carries a marker, but for a **different surface** — really generated, really out of date |
| `hand-edited` | the marker is for this surface and the bytes differ, or the marker was deleted outright |

`stale` is where [`canon mirror check`](#nen-canon-mirror-check)'s `--ref` sits
in this verb: there is no pinned upstream version to compare, so the fact the
marker carries is the **surface**, and a mirror generated for one surface and
checked against another is exactly that verb's stale case. Calling it
hand-edited would send its maintainer looking for an edit nobody made.

**Usage**

```text
nen surface mirror check --source <dir> --surface codex|cursor --out <dir>
                         [--agents <dir>] [--invocation-prefix <prefix>]
                         [--json]
```

**Arguments** — the same as `generate`, minus `--dry-run`, which is **refused**
here (exit 2) rather than ignored: this verb never writes, so a flag saying "do
not write" would be an instruction accepted and dropped.

**Output and exit codes** — prints `surface:`, `ok: <n>`, then `missing:`,
`extra:`, `stale:` and `hand-edited:` (each `(none)` when empty). `--json`:
`{ contract: "nen.surface.mirror.check/v0.1", surface, ok, missing, extra,
stale, handEdited }`. Exit **0** when all four drift lists are empty; exit **1**
on any drift; exit 2 on the same refusals `generate` has, plus `--dry-run`.

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
curl -fsSL https://raw.githubusercontent.com/zheref/nen/v0.6.0/bootstrap/nen.sh -o nen-bootstrap.sh
nen="$(bash nen-bootstrap.sh --ref v0.6.0)"
"$nen" --version
```

Stdout carries only the verified path, so `$(...)` is the whole integration.
Retry only on exit `4`; `5` and `6` are integrity failures and must never be
retried. Once a `nen` exists, the in-CLI form pins a second one — pass
`--script` when the binary is running outside any checkout, since it cannot
find `bootstrap/nen.sh` relative to itself:

```bash
nen bootstrap --ref v0.6.0 --source zheref/nen --script ./nen-bootstrap.sh
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

The allowlist is deliberately literal about what it can prove. The scan walks
whitespace tokens, and a quoted or escaped argument is one word to that walk and
something else to a real shell (`-X 'DELETE'` is the worked example), so a line
it cannot read faithfully is refused rather than assumed to be a GET.

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
provable. `--jq='<expr>'`, `-q '<expr>'`, `-q='<expr>'`, the attached `-q'<expr>'`
and a value containing spaces all fold the same way -- pflag takes a shorthand
value three ways and all three are the same safe shape.

Three shapes still refuse, each for its own reason:

| shape | why |
|---|---|
| `--jq ".name"` | double quotes expand `$x`, a backtick and `\` — one word, but not an *inert* one, and inertness is the whole claim. **Respell it with single quotes**, or watch the bare read and apply `jq` to its output downstream — the refusal now says both. |
| `--jq'.name'` | `--jq.name` to a shell: one word, an unknown long flag, not a flag and its value. |
| `--jq '.a \| .b'` | a metacharacter is refused by the whole-line seam that runs *before* any row vouches for anything, and this fold deliberately does not reach past its own row to move it. |

A quoted **method** (`-X 'DELETE'`) is still `unknown`, unchanged: the fold is
scoped to `--jq` precisely so the adversarial repro
[#70](https://github.com/zheref/nen/issues/70) pinned stays where its own review
put it.

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
| host toolchain | **yes to check; one installer to install** | [`shu tools`](#nen-shu-tools) | Probes every tool `project.toolchain` pins (and nen itself, from `dependency`) and exits 5 when anything is missing or is not the pinned version, naming the exact command per tool. `--install` acts only through `corepack`; every other declared installer is verify-only in this release, reported with its pin for a human to run. |
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
