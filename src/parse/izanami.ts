// src/parse/izanami.ts -- the izanami invocation grammar (`<task> until
// <condition>`, no cap), and the read-only/mutating classification against
// izanami's own explicit table (§2).
//
// CLASSIFY BEFORE RUNNING IT ONCE. The skill is explicit: "If any part of it
// writes, izanami refuses and names izanagi" -- and "refuse the WHOLE run, not
// the offending step", because a loop that runs four of five commands and
// skips the fifth reports a condition it never actually tested. So this module
// classifies every command up front and the caller (../watch/until.ts) never
// gets to observe a task with even one refused command in it.
//
// AN UNRECOGNIZED COMMAND IS TREATED AS MUTATING, NEVER AS SAFE. The skill's
// table is an ALLOWLIST (read-only) alongside named refusals; it is not
// exhaustive of every gh/git subcommand that exists. A command matching
// neither list is unknown, and "resolve or refuse, never guess" -- the rule
// every parser in this repository already follows -- means an unknown
// classification blocks the run exactly as a known-mutating one does.
//
// THE COMMAND VOCABULARY HERE IS gh/git/nen's OWN -- structural CLI grammar,
// not a target repository's persona/label/check-name/colour vocabulary (§3).
// The skill's table also names its own mutating sibling skills by name (drive,
// build, file, tensho, jujisho, getsuga, backlog-synthesis, backlog-loop) as a
// refused example; that naming is NOT reproduced here as a literal, because
// this binary's taxonomy-purity sweep (src/taxonomy-purity.test.ts) treats a
// hard-coded system/skill name in shipped code exactly like a hard-coded label
// -- decided-with, not merely read. A task string that does not match a known
// gh/git read shape below already classifies as "unknown", which blocks the
// run exactly as the skill's named refusals would; naming the specific skill in
// the reason string is a UX nicety this port gives up rather than hard-coding
// a system name (a deviation, reported rather than hidden).
//
// TWO ALLOWLIST GAPS CLOSED (zheref/nen#31), neither of which loosens the
// mutating guards above or below:
//
//   * PLAIN FILE READS. The skill's own table always permitted "reading a
//     file, running a checker script", and this port's first cut carried only
//     the gh/git columns -- so `cat`/`type`/`head`/`tail`/`wc`/`stat` and a
//     `test -f`-style predicate all refused as "unknown". They are admitted
//     below, but ONLY in their bare, provably-read form: a shell
//     metacharacter on the line (a redirection, a pipe, a `;`, a `$()`)
//     means the line is no longer just the read it starts with -- `cat >
//     file` is how a shell WRITES a file -- and such a line stays "unknown".
//
//     (That guard now lives at the classification SEAM and binds every row --
//     see the #70 section below -- rather than only the rows #31 added.)
//
//   * nen's OWN VERBS. Every `nen <verb>` invocation classified "unknown"
//     regardless of what the verb does, so a watch could never poll a
//     computed nen verdict (`nen pr ready`) and had to poll the raw gh read
//     underneath it. NEN_VERB_TABLE below classifies nen's own verb surface
//     explicitly, one entry per REGISTERED verb family -- and an
//     exhaustiveness test (izanami.test.ts) diffs the table's keys against
//     ../cli/registry.ts's real COMMANDS list, so a future verb family that
//     lands without a classification turns the build red instead of silently
//     classifying "unknown" (or worse, being guessed at). Flag-dependent
//     verbs classify read-only ONLY in their provably-read form: an explicit
//     --dry-run present for verbs that write by default, and no --run/
//     --write/--out/--markdown-out flag -- IN ANY SPELLING ../cli/args.ts
//     accepts -- for verbs that read by default. When in doubt -- an unlisted
//     subcommand, a passthrough `--`, a metacharacter -- the answer is NOT
//     read-only.
//
// ONE GUARD AT THE SEAM, NOT ONE PER ROW (zheref/nen#70). #31 bolted its
// metacharacter guard onto the two row families IT added and left the
// pre-existing gh/git rows as they were -- in scope terms a defensible line,
// in classifier terms a hole with a name: `git log > out.txt` classified
// [read-only], and handed to a skill-side shell that verdict CERTIFIES a
// write. Verified live on this branch's parent, every one of these printed
// `[read-only]` and the whole run exited 0: `git log > out.txt`, `gh pr view
// 42 | tee leak.txt`, `git status; git push`, `gh issue list && git push`,
// `git diff \`whoami\``, `gh run list $(git push)`.
//
// The fix is deliberately NOT one more copy of the check, next to the gh/git
// loop. A guard that has to be REMEMBERED at each return site is a guard that
// will be forgotten at the next one -- which is the entire history of this
// module -- so SHELL_METACHARS is now applied ONCE, in classifyCommand, ahead
// of every branch that can answer "read-only": gh api, nen's own verbs, the
// plain file reads and the gh/git rows alike. A row added tomorrow inherits
// it without its author knowing the guard exists.
//
// IT SITS AFTER THE NAMED MUTATING REFUSALS, ON PURPOSE. MUTATING_PATTERNS is
// head-anchored: when a line STARTS with `git push`, that rule is true no
// matter what else the line carries, and naming the rule beats a generic
// "there is a metacharacter here". Every other row's read-only answer, by
// contrast, is about a line the metacharacter has already turned into two
// commands -- so it is the read-only certifications, and only those, that the
// seam intercepts.
//
// AND THE gh/git ROWS' OWN SCAN-DEPENDENCE, checked because #31's invariant
// says a verdict resting on a token scan needs a faithful line -- not because
// #70 asked for it. Two of these rows do rest on one, and both were live
// fail-opens (verified on the parent commit, both printing `[read-only]`):
//
//   * `git branch '-D'`      -- a shell deletes the branch. MUTATING_PATTERNS
//     wants `(?:\s|^)-d`, and the quote is neither, so the named refusal misses
//     it; the allowlist row's trailing `(\s+[^-\s]\S*)?$` then takes `'-D'` for
//     an ordinary branch NAME.
//   * `git remote 'prune'`   -- a shell prunes the remote-tracking refs, and
//     the same two misses apply.
//
// Those two rows are `$`-anchored ENUMERATIONS -- their claim is about the
// WHOLE line ("...and nothing else is here"), which is a token scan wearing a
// regex, so they are gated on isScanFaithfulLine exactly as nen's
// scan-dependent policies are. `gh api`'s read-only answer is a set of ABSENCE
// claims over the whole line (no non-GET method, no field flag, not graphql)
// and is gated the same way: `gh api repos/o/r/issues -X 'DELETE'` classified
// [read-only], because round one's `([A-Za-z]+)` method capture could not see
// past the quote a shell strips. (Round two replaced those captures with a
// pflag-faithful WALK -- see the GH_API block -- for reasons the capture could
// not have been widened out of.)
//
// THE gh ROWS ARE NOT GATED, and that restraint is still the point: `gh pr
// view`, `gh issue list` and their siblings are pinned by LITERAL words at
// LITERAL positions AND have no writing argument form (swept against gh 2.92.0
// -- no flag on any of them writes a file), so their verdict is the
// subcommand's identity and no argument spelling can flip it. Gating them
// would refuse `gh pr list --search "is:open"` -- a plain read -- for no gain,
// and it is the same reasoning that keeps `nen watch until --command "gh pr
// checks 1"` read-only.
//
// ROUND TWO IS WHERE THE "IDENTITY" LABEL WAS MADE TO EARN ITSELF. Round one
// applied it to the git rows on the strength of "no argument spelling changes
// WHICH subcommand runs" -- a true sentence that answers the wrong question,
// because a subcommand can write on an argument of its own without any
// spelling changing. It disclosed `git diff --output=f`, `git show --output=f`
// and `git fetch --prune` in this very comment as "a known gap, reported
// rather than fixed in passing", and the next review verified all three still
// classifying [read-only] and refused the disclosure as a substitute for the
// fix. It was right to: this module may only err in the refusing direction, so
// a gap it can NAME is a gap it must close.
//
// Closed here, each verified live (git 2.53.0, gh 2.92.0, this environment):
//
//   * `git branch nen70-probe` classified [read-only] and `nen watch until`
//     CREATED the branch, in-binary, no shell involved -- round one's trailing
//     optional positional, added for `--list <pat>`, admitted the bare create
//     form too (and its own test pinned `git branch feature/x` as correct).
//     `git branch -v zzz` created one as well.
//   * `git remote update` fetched and rewrote the remote-tracking refs.
//   * `git log|diff|show --output f` wrote f, in both spellings -- and
//     `git log '--output' f` wrote it through a real shell, which is why
//     those three rows are line-scan-gated now rather than merely carrying a
//     named refusal.
//   * `git fetch --prune` deleted a ref; `git fetch origin main:local`
//     created a LOCAL branch. `git fetch` is an allowlist of its
//     provably-plain forms now.
//   * `gh api ... -X=DELETE` sent a DELETE and `... -ftitle=pwned` sent a
//     POST, both classified [read-only] -- so gh api's absence claims are
//     decided by a pflag-faithful WALK now, not by regexes over the raw line.
//
// WHAT IS STILL NOT CLAIMED, in the same idiom and without pretending it is
// smaller than it is: the git allowlist rows name the write forms this sweep
// FOUND. A writing option on `git log`/`diff`/`show` that nobody here has
// named would still ride the row on a scan-faithful line, exactly as
// `--output` did. The line-scan gate closes the laundering half of that
// (a quoted spelling cannot hide), the fail-closed default covers every
// subcommand not listed at all, and the enumerating half remains what it has
// always been: a claim only as good as the sweep behind it, restated here so
// the next round argues with a sentence rather than discovering one.
//
// THE SCAN-FAITHFULNESS INVARIANT (zheref/nen#31, rounds two through four).
// Every fail-open this module has shipped was ONE defect wearing a different
// costume each round: a whitespace split is not an argument vector, and a
// verdict that HINGED on that split trusted it anyway. Round one shipped no
// guard. Round two added a QUOTE tripwire, and the next review walked past it
// with a BACKSLASH in both directions (`--title x\ --dry-run` donates a
// `--dry-run` token the shell never produces -- one argument, no gate, the
// verb WRITES -- while `\--run` hides a write flag the shell does produce),
// with a quote-spliced `'--'`, and with a non-breaking space that JS's `\s`
// splits on and no shell does. Enumerating the dangerous characters loses
// that race; every round found another one. So the rule is inverted into an
// ALLOWLIST.
//
// WHICH READERS THE INVARIANT IS ABOUT (round four's correction). Round three
// phrased the claim as "the argv a real SHELL would build", and that reader
// set was wrong -- not too weak in shape, wrong in membership. A verdict from
// this module is a claim about EVERY reader the classified line reaches:
//
//   1. ../cli/args.ts -- ALWAYS, and on one path it is the ONLY reader. A
//      `nen watch until --command "..."` value never meets a shell at all:
//      ../watch/command.ts classifies the string, splits it on whitespace and
//      SPAWNS the binary directly. Round four's blocker lived exactly there.
//      args.ts strips ONE OR TWO leading dashes (`token.replace(/^--?/, "")`),
//      so `-run` IS `--run` to nen's own parser, while this module's flag scan
//      matched only `--run`/`--run=`. Every write flag in the table below was
//      reachable that way -- `nen wake fire ... -run`, `nen changelog collate
//      -write`, `nen epic next-wave -out x.md`, `nen canon mirror check
//      -markdown-out r.md` -- each classifying [read-only] while writing, and
//      worst of all inside a `nen watch until` that re-fires it every
//      interval. findFlagToken now matches what args.ts ACCEPTS, and a
//      structural coupling test (izanami.test.ts) drives every spelling
//      through the REAL parseArgs with each family's REAL FlagSpec rather
//      than through another hand-written list.
//   2. A POSIX SHELL (bash/sh), when the skill side hands the classified
//      string to one. ANALYSED: quoting, backslash escaping, `$`/backtick
//      expansion, globbing, field splitting, word-initial `#`.
//   3. POWERSHELL, on that same skill-side path under Windows. ANALYSED ONLY
//      IN PART. Three of its argument-mode behaviours were verified in this
//      repository's own environment to change the argv and are closed below
//      (word-initial `@` splatting, a `,` at a word boundary building an
//      array, and a parenthesised SUBEXPRESSION in argument position, which
//      #70 round two found running a whole second command -- `cmd /c echo
//      (whoami)` printed this machine's user name); the rest of its parser has
//      NOT been swept.
//   4. cmd.exe -- STILL NOT SWEPT, and now one verified vector poorer. Said
//      out loud rather than papered over. #70 round one wrote that the safe
//      set "happens to exclude every cmd metacharacter anyone here thought to
//      check", and then, one comment further down, turned that into a positive
//      claim that no second-command construct in cmd could get past
//      SHELL_METACHARS. The claim was false: `%VAR%` expansion happens BEFORE
//      cmd parses the line for special characters, so `cmd /c "echo start
//      %X%"` with X set to `&& whoami` printed `start` and then RAN whoami --
//      and `%` was not in the metacharacter set. `%` is in it now, but the
//      general position is unchanged and is the honest one: "we did not find
//      one" is not "we looked", and a module whose whole idiom is "resolve or
//      refuse, never guess" should not guess about a reader it never studied.
//
// So the guarantee this file can honestly make is: the allowlist is faithful
// to args.ts (pinned by a structural test), and faithful to a POSIX shell
// (pinned by the repro battery); for PowerShell it closes the three vectors
// that were actually found, and for cmd.exe it closes the one vector that was
// actually found and claims nothing beyond it. The fail-closed default is what
// covers the rest -- an unanalysed reader's metacharacter is refused if it is
// outside the safe set, which is the whole reason the guard is written this
// way round.
//
// THE READERS DISAGREE WITH EACH OTHER, and that is its own reason to refuse
// (#70 round two's correction to a reason, not to a behaviour). A verdict is a
// claim about EVERY reader, so a line the readers tokenize DIFFERENTLY is not
// provably anything -- even when each reader on its own is harmless. Verified
// here, with a program that prints its own argv: `A<U+00A0>--run` is ONE
// argument to bash and TWO to PowerShell. Round one explained the exotic-space
// refusal as "JS's \s+ splits where a real shell does not"; that is true of
// bash and false of PowerShell, and the refusal stands on the disagreement
// rather than on either half of it.
//
// The allowlist is applied in two halves:
//
//   (A) THE VERB PATH MUST BE PROVABLE, for EVERY policy. Every token this
//       module reads to decide WHICH verb runs -- `nen`, the pre-verb global
//       flags it skips, THEIR VALUES, the family, and the subcommand key --
//       must be drawn entirely from the safe set. Otherwise the word at that
//       position is not provably the word a shell puts there, so no row of
//       this table has been shown to apply at all: unknown.
//
//       This is the half round three found still open after round two's fix,
//       and it is why the "the verb identification cannot be laundered"
//       claim that guarded it was wrong. `nen --repo $FOO pr ready` reads to
//       the scan as the read-only `nen pr ready`, because the walk skips
//       `--repo`'s value WITHOUT LOOKING AT IT -- while a shell expanding
//       FOO='x label apply --run XX-PR-#1 --label wake' runs `nen label
//       apply --run`, a row THIS TABLE calls mutating. Word splitting after
//       expansion adds words the scan never saw, so "a split only ever cuts
//       a word into MORE pieces" is false, and with it the whole argument
//       that identity is scan-proof.
//
//   (B) A VERDICT THAT ALSO SCANS THE ARGUMENTS NEEDS THE WHOLE LINE.
//       dry-run-gated (the `--dry-run` token must be PRESENT), write-flag-
//       gated (the write flags must be ABSENT) and read-only-forwarding (a
//       bare `--` must be ABSENT) each rest on a scan of everything after
//       the verb, so each refuses unless every character of the line is in
//       the safe set -- refusing in its OWN direction (see the three bullets
//       above evaluateNenPolicy).
//
//       Half (B) has TWO obligations, and round three only stated the first.
//       Faithfulness is necessary -- the tokens must be the words the reader
//       sees -- but it is not SUFFICIENT: the scan must also recognize every
//       SPELLING that reader accepts for the flag it is looking for. A
//       perfectly faithful token list is still fail-open if `-run` and
//       `--run` are the same flag to args.ts and only one of them is on this
//       side of the comparison. findFlagToken carries that half.
//
// A plain "read-only" row needs only (A). Its verdict is VERB IDENTITY
// ALONE: `nen pr ready` and `nen watch until` never write whatever their
// arguments say (../watch/command.ts re-classifies its own --command against
// this very table and spawns it with NO shell), so once the verb is proven
// no argument mangling can flip it -- which is exactly why `nen watch until
// --command "gh pr checks 1"` stays read-only on a quoted line, as it must.
//
// THE SAFE SET is ASCII alphanumerics, space, tab, and - _ . / # @ : = , ~ +
// (see SCAN_FAITHFUL_CHARS), MINUS three of those characters in word-boundary
// position (see isScanFaithfulToken). Everything else, INCLUDING characters
// nobody has enumerated yet, lands on the refusing side by default -- which
// is the entire point of writing the guard this way round.

export interface IzanamiInvocation {
  readonly commands: readonly string[];
  readonly condition: string;
}

export interface IzanamiParseError {
  readonly message: string;
}

export type IzanamiParseResult =
  | { readonly ok: true; readonly value: IzanamiInvocation }
  | { readonly ok: false; readonly error: IzanamiParseError };

const UNTIL = /\buntil\b/gi;

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | undefined {
  return [...text.matchAll(pattern)].at(-1);
}

// Two forms (skill §1): `<task> until <condition>` on one line, or `until
// <condition>` on its own line followed by one command per subsequent line.
export function parseIzanamiInvocation(raw: string): IzanamiParseResult {
  const lines = raw.split("\n").map((line): string => line.trim());
  const firstLine = lines[0] ?? "";
  if (firstLine === "" && lines.length <= 1) {
    return { ok: false, error: { message: "empty invocation. Expected '<task> until <condition>'." } };
  }

  const until = lastMatch(firstLine, UNTIL);
  if (until === undefined || until.index === undefined) {
    return { ok: false, error: { message: "no 'until <condition>'. Expected '<task> until <condition>'." } };
  }
  const task = firstLine.slice(0, until.index).trim();
  const condition = firstLine.slice(until.index + until[0].length).trim();
  if (condition === "") {
    return { ok: false, error: { message: "the condition is empty." } };
  }

  const rest = lines.slice(1).filter((line): boolean => line !== "");
  if (task === "" && rest.length === 0) {
    return {
      ok: false,
      error: { message: "no task and no commands to repeat -- expected a task on the first line, or a command per following line." },
    };
  }
  const commands = task === "" ? rest : [task];
  return { ok: true, value: { commands, condition } };
}

export type Classification = "read-only" | "mutating" | "unknown";

export interface ClassifyResult {
  readonly classification: Classification;
  readonly reason: string;
}

// Read-only gh/git subcommands (§2's left column), matched on the FIRST two or
// three tokens -- deliberately narrow, so `gh pr merge` does not accidentally
// match a `gh pr` prefix meant for `view`/`checks`/`list`.
//
// `git branch` and `git remote` are matched on their FORM, not just their
// subcommand name -- both have mutating flag forms (`git branch -D`, `git
// remote add`) that read the same "subcommand" as their read-only siblings.
// These two patterns admit only the listing forms; anything else (a flag
// outside this set) falls through to MUTATING_PATTERNS below or, failing
// that, to "unknown" -- never silently read-only.
//
// EVERY ROW ALSO DECLARES WHAT ITS VERDICT RESTS ON (zheref/nen#70). This is
// the same distinction NEN_VERB_TABLE already draws between a plain
// "read-only" policy (verb identity alone -- no scan, so no argument spelling
// can flip it) and its three scan-dependent siblings, carried over to the
// gh/git half so both halves are guarded by ONE rule instead of two:
//
//   * "identity"  -- the row pins its subcommand with LITERAL words at LITERAL
//     positions, and the subcommand HAS NO WRITING ARGUMENT FORM, so everything
//     after those words is arguments this verdict never needs to read. A quote,
//     a backslash or a Windows path in them cannot change what the line does --
//     which is what keeps `gh pr list --search "is:open"` a read.
//   * "line-scan" -- the row's read-only answer is a claim about the WHOLE
//     line ("only these listing flags", "no --output anywhere"). That is a
//     token scan wearing a regex, so #31's invariant binds it: a quote splices
//     a flag out of the claim's sight exactly as it spliced `--run` out of
//     nen's flag scan. Verified live before the gate, both classifying
//     [read-only]: `git branch '-D'` (a shell DELETES the branch -- and
//     MUTATING_PATTERNS misses it too, since it wants `(?:\s|^)-d` and the
//     quote is neither) and `git remote 'prune'` (a shell PRUNES the
//     remote-tracking refs).
//
// "IDENTITY" IS A CLAIM ABOUT THE SUBCOMMAND, AND #70's SECOND ROUND FOUND IT
// MADE FALSELY. Round one put `git fetch|log|diff|status|ls-tree|show` in one
// identity row on the strength of "no argument spelling changes WHICH
// subcommand runs" -- true, and beside the point, because three of those six
// subcommands WRITE on an argument of their own. Verified in this repository's
// own environment against git 2.53.0, each having classified [read-only]:
//
//   * `git log --output=f`, `git log --output f`, `git diff --output=f`,
//     `git show --output=f` -- all four created f. (`git status --output=f`
//     and `git ls-tree --output=f` are usage errors, which is why those two
//     stay identity rows.) And the laundered spelling writes too: through a
//     real shell, `git log '--output' f` created f, which is why a named
//     refusal alone would not have been enough and log/diff/show are now
//     line-scan rows whose claim is "no --output token anywhere".
//   * `git fetch --prune` -- deleted a remote-tracking ref. `git remote
//     update` -- fetched and created new ones. `git fetch origin main:local`
//     -- created the LOCAL branch `local`. `git fetch` is therefore an
//     allowlist of its provably-plain forms now, not a head-token match: a
//     flag chase would have to win every round, and this table's whole idiom
//     is the other shape.
//
// THE COST IS REAL AND PINNED (izanami.test.ts): `git log --grep "fix: thing"`
// and `git diff --stat "C:/Program Files/x"` were read-only under the identity
// row and refuse now. That is the same trade #31 made for every flag-dependent
// nen verb and #70 round one made for `gh api --jq '.name'` -- the caller's way
// out is the unquoted form. The gh rows keep their identity hinge because the
// same sweep found no writing argument form on any of them (`gh pr
// view|checks|list|diff|status`, `gh issue view|list`, `gh run view|list|watch`,
// `gh repo view` expose no flag that writes a file), so gating them would cost
// a plain read for nothing.
type ReadOnlyHinge = "identity" | "line-scan";

interface ReadOnlyRow {
  readonly pattern: RegExp;
  readonly hinge: ReadOnlyHinge;
  /**
   * For a line-scan row: what its WHOLE-LINE claim actually is, quoted back in
   * the refusal so a caller learns which claim went unprovable rather than a
   * generic "unfaithful line". Absent on identity rows, which make no such
   * claim.
   */
  readonly claim?: string;
}

// `git branch`'s listing form. THE TRAILING POSITIONAL IS THE POINT
// (zheref/nen#70 round two): round one wrote it as a free-floating
// `(\s+[^-\s]\S*)?$` so that `--list <pattern>` and `--contains <ref>` would
// fit -- and that same optional word admits the bare CREATE form. `git branch
// nen70-probe` classified [read-only] and `nen watch until` ACTUALLY CREATED
// the branch, in-binary, with no shell involved. Worse, round one's own test
// pinned `git branch feature/x` as correctly read-only.
//
// A positional is now admitted only IN THE COMPANY OF a listing flag that
// takes one. Verified against git 2.53.0 in this environment, which is what
// decides the membership of each half:
//
//   * `git branch -l zzz` and `git branch --list zzz` -- LIST by pattern, no
//     branch created (`-l` is `--list` in modern git). `git branch --contains
//     zzz` -- a ref argument; a bad one errors, it never creates.
//   * `git branch -a zzz` -- git REFUSES ("the -a, and -r, options to 'git
//     branch' do not take a branch name"), so `-a`/`-r` take no positional.
//   * `git branch -v zzz-v` -- CREATED the branch zzz-v. That form matched
//     round one's row too, and is closed by the same rule.
const GIT_BRANCH_LISTING =
  /^git\s+branch(?:\s+(?:(?:-l|--list|--contains)\s+[^-\s]\S*|-l|--list|-a|-r|-v|--contains|--show-current))*$/i;

// `git remote`'s listing form, closed the same way and for the same reason:
// round one's trailing `(\s+\S+)?$` took `update` for a remote NAME, and `git
// remote update` fetches every remote and rewrites the remote-tracking refs
// (verified: it created refs/remotes/origin/late on a fresh clone). A
// positional is admitted only after `show` or `get-url`, which are the two
// listing subcommands that take one.
const GIT_REMOTE_LISTING = /^git\s+remote(?:\s+-v)?(?:\s+(?:show|get-url)(?:\s+[^-\s]\S*)?)?$/i;

// `git fetch`'s provably-plain form. An ALLOWLIST rather than a flag chase,
// because the write forms are many and the module's own header says
// enumerating loses that race: only these read-safe flags, and only positionals
// that carry no `:` (a `<src>:<dst>` refspec writes a LOCAL ref -- verified:
// `git fetch origin main:local` created refs/heads/local) and no leading `+`
// (the force marker). `--prune`, `-p`, `--force` and every unlisted flag fall
// out of the row entirely.
const GIT_FETCH_PLAIN =
  /^git\s+fetch(?:\s+(?:-q|--quiet|-v|--verbose|--all|--dry-run|--progress|--no-progress|[^-+\s:][^\s:]*))*$/i;

const READ_ONLY_PATTERNS: readonly ReadOnlyRow[] = [
  { pattern: /^gh\s+pr\s+(view|checks|list|diff|status)\b/i, hinge: "identity" },
  { pattern: /^gh\s+issue\s+(view|list)\b/i, hinge: "identity" },
  { pattern: /^gh\s+run\s+(view|list|watch)\b/i, hinge: "identity" },
  { pattern: /^gh\s+repo\s+view\b/i, hinge: "identity" },
  { pattern: /^git\s+(status|ls-tree)\b/i, hinge: "identity" },
  {
    pattern: /^git\s+(log|diff|show)\b/i,
    hinge: "line-scan",
    claim: "no --output <file> anywhere on the line -- --output WRITES that file, on all three of log, diff and show",
  },
  {
    pattern: GIT_FETCH_PLAIN,
    hinge: "line-scan",
    claim: "only the read-safe fetch flags, and only positionals with no ':' refspec and no leading '+'",
  },
  {
    pattern: GIT_BRANCH_LISTING,
    hinge: "line-scan",
    claim: "only these listing flags, and a positional only where a listing flag takes one -- 'git branch <name>' CREATES",
  },
  {
    pattern: GIT_REMOTE_LISTING,
    hinge: "line-scan",
    claim: "only -v, 'show' or 'get-url', and a positional only after those two",
  },
];

// `gh api` is read-only ONLY for a verified GET: no explicit non-GET method,
// no `-f`/`-F`/`--field`/`--raw-field`/`--input` value (gh's own documented
// rule is that the method defaults to POST the moment any parameter is
// given -- https://cli.github.com/manual/gh_api, "the method is POST when
// any parameters are added"), and not the `graphql` endpoint (a query and a
// mutation are indistinguishable from the CLI form, so graphql is never
// treated as read-only).
//
// THOSE ARE ABSENCE CLAIMS OVER THE WHOLE LINE, which makes this row's
// read-only answer scan-dependent in the sense #31's invariant means, and it
// is therefore gated on isScanFaithfulLine (zheref/nen#70). The repro that
// proves the gate is load-bearing: `gh api repos/o/r/issues -X 'DELETE'`
// classified [read-only] on #70's parent, because a `([A-Za-z]+)` capture
// cannot match past the quote a real shell strips -- so the scan found no
// method at all and fell through to "GET by default", certifying a DELETE.
//
// THE ABSENCE CLAIMS ARE NO LONGER TESTED WITH REGEXES OVER THE RAW LINE
// (zheref/nen#70 round two), and the reason is that a regex over the raw line
// is a spelling chase this module already knows it loses. Two live fail-opens
// found it, both verified against the real gh 2.92.0 in this environment with
// GH_DEBUG=api printing the request line gh actually built:
//
//   * `gh api repos/o/r/issues -X=DELETE`  -> `DELETE /repos/o/r/issues`.
//     Round one's method regex had an `=` arm for `--method` and not for `-X`,
//     so no method was found and the line classified [read-only].
//   * `gh api repos/o/r/issues -ftitle=pwned` -> `POST /repos/o/r/issues`
//     (and gh's own 404 body names the create-an-issue endpoint). Round one's
//     field-flag regex demanded a word boundary after `-f`, which pflag's
//     ATTACHED value spelling does not provide -- so no field flag, no method,
//     [read-only].
//
// And a third spelling shows why "add the two missing arms" would have been
// the wrong repair: pflag GROUPS shorthands, so `gh api repos/o/r/issues -iX
// DELETE` and `-if title=pwned` are also a DELETE and a POST (both verified),
// and neither token starts with `-X` or `-f` at all.
//
// So the row is decided by a WALK of the argument vector under pflag's own
// rules -- long `--flag`/`--flag=v`/`--flag v`, shorthand clusters, attached
// and `=`-attached shorthand values -- against the flag table gh 2.92.0's own
// `gh api --help` prints (GH_API_LONG_FLAGS / GH_API_SHORT_FLAGS below, and
// classifyGhApi is the walk). A token the walk cannot place
// is not a gh api line this row has been shown to apply to: unknown. That is
// the same inversion SCAN_FAITHFUL_CHARS is, one level up.
const GH_API = /^gh\s+api\b/i;
const GH_API_GRAPHQL = /\bgraphql\b/i;

/**
 * What one gh api flag does to the verdict.
 *
 *   * "boolean"      -- takes no value and cannot write.
 *   * "value"        -- takes a value the walk must CONSUME (so the value is
 *                       never mistaken for the endpoint or for another flag),
 *                       and cannot write.
 *   * "method"       -- `-X`/`--method`. Its value decides the verdict.
 *   * "post-forcing" -- `-f`/`-F`/`--field`/`--raw-field`/`--input`. gh's
 *                       documented rule flips the method to POST the moment
 *                       any of these is given, whatever `-X` says.
 */
type GhApiFlagKind = "boolean" | "value" | "method" | "post-forcing";

// Exactly the flags `gh api --help` lists on gh 2.92.0, plus the one inherited
// flag it names (`--help`). A flag gh adds tomorrow is NOT here, so a line
// carrying it refuses rather than being assumed inert -- which is the
// fail-closed direction and the reason this is a table rather than a
// blocklist of the three dangerous ones.
const GH_API_LONG_FLAGS: Readonly<Record<string, GhApiFlagKind>> = {
  cache: "value",
  field: "post-forcing",
  header: "value",
  help: "boolean",
  hostname: "value",
  include: "boolean",
  input: "post-forcing",
  jq: "value",
  method: "method",
  paginate: "boolean",
  preview: "value",
  "raw-field": "post-forcing",
  silent: "boolean",
  slurp: "boolean",
  template: "value",
  verbose: "boolean",
};

const GH_API_SHORT_FLAGS: Readonly<Record<string, GhApiFlagKind>> = {
  F: "post-forcing",
  H: "value",
  X: "method",
  f: "post-forcing",
  i: "boolean",
  p: "value",
  q: "value",
  t: "value",
};

const GH_API_POST_FORCING_REASON =
  "gh api with a -f/-F/--field/--raw-field/--input value -- gh defaults to POST once any parameter is given";

// Plain file reads (zheref/nen#31): the skill's allow table's "reading a
// file, running a checker script" column. Matched on the head token only --
// none of these utilities has a mutating flag form (`test`, in particular,
// never writes anything no matter its arguments) -- BUT only when the line
// carries no shell metacharacter -- checked once at classifyCommand's seam
// now, for these rows and every other one (zheref/nen#70): the utilities
// themselves are pure reads, while the SHELL around them is where the write
// would hide (`cat > file` truncates; `cat x; git push` runs a second command
// this head-token match would never see).
//
// `test`/`[` are admitted only when the FIRST predicate is a recognized
// read-only unary check (-e/-f/-d/-r/-s/-w/-x/-L/-h/-n/-z, optionally
// negated) -- deliberately the provable shape rather than "anything test
// accepts", and case-SENSITIVE because the predicate letters are (a
// hypothetical uppercase sibling must not ride in on /i).
const PLAIN_READ_PATTERNS: readonly RegExp[] = [
  /^cat(\s|$)/i,
  /^type\s+\S/i,
  /^head(\s|$)/i,
  /^tail(\s|$)/i,
  /^wc(\s|$)/i,
  /^stat\s+\S/i,
  /^test\s+(!\s+)?-[efdrswxLhnz]\b/,
  /^\[\s+(!\s+)?-[efdrswxLhnz]\b[^\]]*\]$/,
];

// The metacharacters that hand part of the line to the SHELL rather than to
// the command the line starts with: redirections, pipes, separators, command
// substitution -- and the line separators themselves, because an embedded
// newline or CR IS a second command in every shell (`cat a.txt\ngit push`).
// Unreachable as an execution vector through this binary (`parse izanami`
// splits on newlines before classifying, and `watch until` tokenizes on
// whitespace and spawns without a shell), but this classification is also
// consumed by the skill side, which may hand the string to a real shell --
// belt and braces, per the #31 review.
//
// APPLIED TO EVERY ROW SINCE zheref/nen#70, at classifyCommand's seam. It was
// #31's own rows only until then, which is what left `git log > out.txt`
// classifying read-only.
//
// RECONCILED WITH THE SET #70 NAMES (`>`, `>>`, `|`, `;`, `&`, backtick,
// `$(`, newline/CR): this expression covers all of them -- `>>` is two `>`,
// `&&`/`||` are `&`/`|` -- plus the `<` #31's rounds added for the redirection
// and the process substitution `<(cmd)` that read the other way.
//
// WIDENED BY THREE CHARACTERS IN #70's SECOND ROUND, and the widening is a
// RETRACTION rather than a discovery. Round one's comment in this place
// claimed that "every construct that adds a SECOND COMMAND in bash, PowerShell
// or cmd.exe passes through one of these characters". That was a guess about
// two readers this module had not swept -- exactly what the header's honesty
// section forbids -- and it is false in both. Verified in this repository's
// own environment, and each line classified [read-only] on the round-one
// commit:
//
//   * `(` and `)` -- POWERSHELL runs a parenthesised subexpression in ARGUMENT
//     position and substitutes its output. `cmd /c echo (whoami)` printed this
//     machine's user name, so `git log (git push)` is `git push` RUNNING, with
//     its output handed to git log as an argument. (`$(` was already in the
//     set; `(` alone subsumes it, so the `$(` alternation is gone as a
//     duplicate, not as a relaxation.)
//   * `%` -- CMD.EXE expands `%VAR%` BEFORE it parses the line for special
//     characters, so an expansion can inject the very separator the scan was
//     looking for. With X set to `&& whoami`, `cmd /c "echo start %X%"`
//     printed `start` and then ran whoami. `git diff %X%` is that shape.
//
// The header's reader list still says cmd.exe has not been SWEPT, and that
// stays true: what changed is that this module no longer claims the set is
// complete for a reader it never studied. It claims only what was verified,
// and refuses the characters it found.
//
// NONE OF THE THREE IS A NEW CLASS. All three were ALREADY outside
// SCAN_FAITHFUL_CHARS, so every scan-dependent row has refused them since #31;
// the identity rows were the only place they got through, and the seam is
// where that is closed once for all rows.
//
// THE COST, stated rather than discovered later: `%` refuses `git log
// --pretty=%h` and `gh api` paths carrying a percent-encoded segment, and `(`
// refuses a parenthesised grep pattern. Those are plain reads. It is the
// refusing direction, which is the only direction this module is allowed to
// err in, and the caller's way out is the unformatted read.
const SHELL_METACHARS = /[|;&<>()%`\n\r]/;

/**
 * The one refusal every read-only row shares, so a caller reading it on a `git
 * log` line and on a `cat` line learns the same rule once. ACTIONABLE, as this
 * repository's refusals are required to be: it says what to do instead rather
 * than only what was refused.
 *
 * IT QUOTES THE CALLER'S OWN LINE (zheref/nen#70 round two). Round one
 * hard-coded `git log > out.txt` as the example for every family, so a caller
 * who typed `git diff %X%` was answered with a sentence about some other
 * command -- and a refusal a caller does not believe is a refusal they route
 * around. The CR and LF that are themselves in the set are rendered as `\r`
 * and `\n` rather than pasted, so the reason stays one readable line.
 */
function shellMetacharRefusal(command: string): string {
  const shown = command.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return `a shell metacharacter (>, >>, |, ;, &, <, (, ), %, a backtick, a newline or a CR) hands part of this line to the SHELL rather than to the command it starts with, so '${shown}' is no longer the single command any row could vouch for. Watch the bare read, and run the redirection or the second command yourself.`;
}

// Explicitly refused (§2's right column), named rather than left to fall
// through to "unknown" -- the skill states them, so the refusal message can
// name the actual rule instead of a generic "not on the allowlist". Checked
// FIRST, so a mutating flag form of an otherwise read-only subcommand (`git
// branch -D`, `git remote add`) always wins over the allowlist below.
//
// A NAMED REFUSAL IS NEVER LOAD-BEARING FOR SAFETY HERE, and that is what lets
// these stay plain head-anchored regexes while the allowlist rows had to
// become walks: every arm below can only turn a line MORE refused. When one of
// them misses a laundered spelling the line simply falls through to the
// allowlist row, which is gated. So a miss here costs a good refusal MESSAGE,
// never a certification.
//
// FOUR ARMS ADDED IN zheref/nen#70's SECOND ROUND, each for a write the round
// before let through as [read-only] and each verified against git 2.53.0 in
// this environment (see GIT_BRANCH_LISTING and the ReadOnlyRow comment for the
// transcripts):
//
//   * `git branch <name>` (one or two bare positionals) CREATES the branch --
//     the form `nen watch until` was observed actually creating, in-binary.
//   * `git remote update` fetches every remote and rewrites the
//     remote-tracking refs.
//   * `git fetch --prune`/`-p`/`--force`/... deletes or force-updates refs.
//   * `git log|diff|show --output <file>` WRITES that file, in both the `=`
//     and the space spelling.
const MUTATING_PATTERNS: readonly RegExp[] = [
  /^git\s+(push|commit|merge|tag|rebase|reset|clean)\b/i,
  /^git\s+checkout\s+-b\b/i,
  /^git\s+branch\b.*(?:\s|^)(-(d|m)\b|--(delete|move)\b)/i,
  // The positional's head is deliberately NARROWER than the allowlist row's
  // `[^-\s]`: a NAMED refusal must be sure what it is naming, and `git branch
  // '-D'` is a DELETE to a real shell, not the create this arm describes. Only
  // an ordinary branch-name head is claimed here; the laundered spellings fall
  // through to the gated allowlist row, which refuses them as unprovable.
  /^git\s+branch(?:\s+[A-Za-z0-9_.\/]\S*){1,2}\s*$/i,
  /^git\s+remote\s+(add|remove|rm|set-url|rename|prune|set-head|update|set-branches)\b/i,
  /^git\s+fetch\b.*\s(?:-p|-P|-f|-u|--prune|--prune-tags|--force|--update-head-ok)\b/i,
  /^git\s+(log|diff|show)\b.*\s--output(?:=|\s|$)/i,
  /^gh\s+(pr|issue)\s+(create|edit|close|merge|comment|review|reopen)\b/i,
  /^gh\s+(label|release)\s+(create|edit|delete)\b/i,
];

// ---------------------------------------------------------------------------
// nen's own verb surface (zheref/nen#31).
//
// ONE ENTRY PER REGISTERED VERB FAMILY, and the shape is deliberately a
// closed union of five policies rather than a predicate function per verb:
// the table is DATA an exhaustiveness test can diff against
// ../cli/registry.ts's COMMANDS list, and a reviewer can read one entry and
// know exactly which invocations it admits.
//
//   * "read-only"        -- every form reads: gh/git reads, local file reads,
//                           or pure computation. Flags only select and format.
//                           The verdict is verb identity alone; no scan.
//   * "read-only-forwarding"
//                        -- reads by itself, BUT hands everything after a
//                           bare `--` to another program, so its read-only
//                           claim also depends on there being no `--` -- a
//                           scan, and therefore scan-faithfulness-gated. Only
//                           `nen dev test` and `nen dev lint` are in this
//                           class today: they are the only two verbs in the
//                           binary that read ParsedArgs.passthrough at all
//                           (`nen dev replay` ignores it, and stays plain
//                           "read-only").
//   * "mutating"         -- every form writes somewhere (GitHub, the working
//                           copy, a ledger file). No flag makes it a read.
//   * "dry-run-gated"    -- WRITES BY DEFAULT; the explicit --dry-run form is
//                           the only provably-read one, so read-only requires
//                           the --dry-run token present.
//   * "write-flag-gated" -- READS BY DEFAULT; any of the named flags makes it
//                           write, so read-only requires them all absent.
//
// THE TABLE IS NOT IMPORTED FROM THE REGISTRY, and cannot be: the registry
// imports ../watch/command.ts, which imports this module -- a runtime import
// the other way would be a cycle. The exhaustiveness lives in the TEST
// (izanami.test.ts), which may import both sides freely; a registered family
// missing here, or a stale key naming no registered family, turns the build
// red. A SUBCOMMAND that drifts in unclassified needs no test at all: the
// lookup below falls through to "unknown", which refuses.
//
// FLAG DETECTION IS TOKEN-LEVEL -- a /[ \t]+/ split of the line -- and that
// split reproduces the argv this line's readers build only on a SCAN-FAITHFUL
// line (see this file's header for who those readers are, and for why the
// guard is a safe-set allowlist rather than a list of the characters previous
// rounds got caught by). The three policies whose read-only answer HINGES on
// that split therefore refuse an unfaithful line outright, each in its own
// refusing direction:
//
//   * dry-run-gated        -> mutating. The verb writes by default, so an
//     unprovable gate is no gate. This is the direction round two got wrong
//     twice: `--title "add --dry-run support"` and `--title x\ --dry-run`
//     both donate a `--dry-run` token to the scan that no shell produces.
//   * write-flag-gated     -> unknown. The claim is the write flags'
//     ABSENCE, and an unfaithful line can splice one out of sight ('--run'
//     and \--run are both --run to a shell, neither is the token --run to
//     the scan). A MUTATING hit still fires FIRST and unconditionally,
//     because that direction only ever over-refuses.
//   * read-only-forwarding -> unknown. The claim includes "no bare `--`",
//     and `nen dev test '--' -u` is a bare `--` to every real shell, which
//     hands vitest its snapshot-REWRITING flag.
//
// THE ARGUMENT half of the guard lives INSIDE the flag-dependent evaluation
// (see evaluateNenPolicy), deliberately NOT in SHELL_METACHARS: a quote or a
// backslash is legitimate shell -- `nen watch until --command "gh pr checks
// 1"` must stay read-only, and a plain read of a Windows path must not start
// refusing -- and it is only a token SCAN that they make unsound, so only
// classifications that HINGE on such a scan refuse them. The VERB-PATH half
// (unprovableVerbPath) binds every policy including those rows, because
// identifying the verb is itself a scan -- see half (A) of the file header.
//
// A FAITHFUL SCAN IS NOT YET A CORRECT ONE (#31 round four). Faithfulness
// says the scan's tokens ARE the reader's arguments; it says nothing about
// whether the scan recognizes the reader's SPELLINGS for a given flag. Both
// gates below therefore state their spelling rule explicitly, and in opposite
// directions, because they are asking opposite questions:
//
//   * the WRITE-FLAG side asks "is a write flag present", so it matches every
//     spelling ../cli/args.ts accepts -- `--run`, `-run`, `--out=x`, `-out=x`
//     -- since args.ts strips one OR two dashes. Matching one spelling too
//     many only over-refuses. See findFlagToken.
//   * the DRY-RUN side asks "is the read gate present", so it stays on the
//     exact `--dry-run` token. `--dry-run=<x>` is refused by args.ts on a
//     boolean flag and could mean the opposite to another tool; the
//     single-dash `-dry-run` really would run as a dry run, and is left
//     unmatched anyway, because widening a GATE is how a fail-open is built.

export type NenVerbPolicy =
  | { readonly kind: "read-only"; readonly why: string }
  | { readonly kind: "read-only-forwarding"; readonly why: string }
  | { readonly kind: "mutating"; readonly why: string }
  | { readonly kind: "dry-run-gated"; readonly why: string }
  | { readonly kind: "write-flag-gated"; readonly writeFlags: readonly string[]; readonly why: string };

export interface NenFamilyEntry {
  /**
   * Policies keyed by subcommand. A two-token key ("mirror check") is tried
   * before the one-token key; "*" covers a family whose flags, not a
   * subcommand, select the behaviour (stop, warmup) or whose every
   * subcommand shares one policy (parse). A subcommand matching NO key
   * classifies "unknown" -- never assumed safe.
   */
  readonly subcommands: Readonly<Record<string, NenVerbPolicy>>;
}

const RO = (why: string): NenVerbPolicy => ({ kind: "read-only", why });
const RO_FWD = (why: string): NenVerbPolicy => ({ kind: "read-only-forwarding", why });
const MUT = (why: string): NenVerbPolicy => ({ kind: "mutating", why });
const DRY = (why: string): NenVerbPolicy => ({ kind: "dry-run-gated", why });
const GATED = (writeFlags: readonly string[], why: string): NenVerbPolicy => ({
  kind: "write-flag-gated",
  writeFlags,
  why,
});

// `nen dev test -- -u` would hand vitest its snapshot-REWRITING flag, so the
// dev family is read-only only without a passthrough `--`; with one, the
// classification is "unknown" rather than "mutating" -- what runs behind the
// separator is the underlying tool's business, not provably either way.
//
// TWO of the three dev subcommands actually FORWARD that passthrough: ../dev/
// command.ts hands `context.args.passthrough` to runDevTest/runDevLint, which
// splice it back behind a `--` in the argv they spawn (../dev/test.ts's
// devTestArgv, ../dev/lint.ts's devLintArgv). `dev replay` reads only
// --slice-dir and forwards nothing. That difference is why they carry
// different policies below: for test/lint the read-only claim depends on the
// `--` SCAN finding nothing, which makes it scan-faithfulness-gated (#31
// round three); for replay the claim is verb identity alone. A test pins the
// coupling from both sides, so a future verb that starts forwarding
// passthrough cannot quietly keep a plain read-only row.
//
// A DELIBERATE NARROWING, stated the way this module's header states its
// other deviations: the old skill's allow-table row read "running a checker
// script" -- ANY checker. This port admits only nen's OWN `dev test|lint|
// replay`, whose behaviour ships in this repository and is provable; an
// arbitrary checker (`bash scripts/x.sh`, `./check.sh`, `bun run lint`)
// is a name pointing at code this classifier cannot see, so it stays
// "unknown" and refuses, like every other unlisted head token. A caller
// who needs an arbitrary script watched runs the watch by hand -- the same
// fail-closed trade the rest of this table makes.
const DEV_FORWARDING_CHECKER = RO_FWD(
  "runs this checkout's own checker harness (izanami's 'running a checker script' row), but forwards everything after a bare '--' to bun -> vitest/eslint",
);
const DEV_CHECKER = RO("runs this checkout's own checker harness -- the 'running a checker script' row of izanami's allow table");

export const NEN_VERB_TABLE: Readonly<Record<string, NenFamilyEntry>> = {
  backlog: {
    subcommands: {
      fetch: RO("fetches open issues and PRs over gh api reads"),
      order: RO("orders a pre-fetched row set -- pure computation"),
    },
  },
  board: {
    subcommands: {
      build: RO("assembles a board from rows already fetched"),
      render: RO("renders a board JSON as a table"),
      diff: RO("diffs two board snapshots"),
    },
  },
  canon: {
    subcommands: {
      resolve: RO("resolves a repo's handbook set from the registry"),
      "mirror generate": MUT("writes and deletes mirror files under --out-dir"),
      "mirror check": GATED(["--markdown-out"], "writes the drift report to --markdown-out"),
    },
  },
  changelog: {
    subcommands: {
      "fragment-required": RO("decides whether a change owes a fragment -- reads only"),
      collate: GATED(["--write"], "rewrites the changelog and deletes collated fragments"),
      completeness: RO("reconciles 'git log --merges' against the changelog -- reads only"),
    },
  },
  color: { subcommands: { status: RO("resolves a colour by the repository's own precedence") } },
  commit: { subcommands: { format: RO("formats and validates a message; never runs git commit") } },
  dev: { subcommands: { test: DEV_FORWARDING_CHECKER, lint: DEV_FORWARDING_CHECKER, replay: DEV_CHECKER } },
  effort: { subcommands: { classify: RO("classifies an effort -- pure computation") } },
  epic: { subcommands: { "next-wave": GATED(["--out"], "writes the rewritten body to --out") } },
  fanout: {
    subcommands: {
      compute: RO("computes the fan-out set from git/workflow reads"),
      record: MUT("appends rows to the fan-out ledger file"),
    },
  },
  gate: { subcommands: { derive: RO("derives a gate from a changed-file set -- pure computation") } },
  idea: { subcommands: { file: MUT("creates a GitHub issue; it has no dry-run form") } },
  issue: {
    subcommands: {
      search: RO("the four duplicate searches -- gh reads only"),
      "open-pr-check": RO("checks for open PRs referencing an issue -- gh reads only"),
      file: DRY("creates a GitHub issue unless --dry-run is given"),
      // Dry-run-gated like its issue-family siblings, and NOT "read-only
      // because it only comments": posting a comment is a public write on
      // someone else's timeline, and the verb's own --dry-run is the only form
      // that provably sends nothing (../issue/command.ts prints the argv and
      // the exact bytes and returns before postComment).
      comment: DRY("posts a caller-supplied comment on GitHub unless --dry-run is given"),
      "attach-sub": DRY("attaches sub-issues unless --dry-run is given"),
      "consolidate-close": DRY("attaches and closes issues unless --dry-run is given"),
      "chain-position": RO("computes a chain position -- pure computation"),
      terminus: RO("computes a chain terminus -- pure computation"),
    },
  },
  label: {
    subcommands: {
      // NOT dry-run-gated, despite --run existing: EVERY invocation appends a
      // ledger line (src/label/command.ts, "every call writes a ledger line,
      // dry run or not"), so no form of this verb is a pure read.
      apply: MUT("appends a ledger line on every call (dry run included), and edits GitHub with --run"),
    },
  },
  labels: {
    subcommands: {
      sync: DRY("creates/updates GitHub labels unless --dry-run is given"),
      rename: DRY("renames GitHub labels in place unless --dry-run is given"),
    },
  },
  loop: { subcommands: { slots: RO("counts concurrency budgets from a report file") } },
  parse: { subcommands: { "*": RO("parses a grammar; never executes what it classified") } },
  pr: {
    subcommands: {
      ready: RO("reports CON-32 readiness -- reads GitHub, never labels, merges or comments"),
      staleness: RO("computes staleness from a wakes file -- pure computation"),
      "body-check": RO("checks a body against requirements -- reads files only"),
      // fetch/next-blocker run ../pr/fetch.ts's REST reviews call, which is
      // a read ONLY because reviewsArgv pins an explicit `--method GET`:
      // gh's documented default flips to POST the moment any -f/-F
      // parameter rides along (the very rule the gh api walk above refuses
      // in raw form), and a POST to /pulls/<n>/reviews CREATES a
      // pending review. The #31 review caught these two rows certifying the
      // then-unpinned call as read-only -- the same defect zheref/nen#19
      // fixed module-wide (every argv ../pr/fetch.ts builds now names its
      // method explicitly, held by fetch.test.ts's sweep test); on top of
      // that, izanami.test.ts asserts the classification-to-argv COUPLING
      // from this side, so the rows cannot silently go false again no
      // matter which module a refactor touches first.
      fetch: RO("one typed PR snapshot -- gh reads only (its REST reviews call pins --method GET)"),
      "next-blocker": RO("reports the first blocking condition -- reads only (same pinned-GET fetch)"),
      "cascade-main": MUT("merges the trunk into the branch and pushes"),
      retarget: MUT("gh pr edit --base"),
      "request-reviews": MUT("gh pr edit --add-reviewer"),
    },
  },
  quality: {
    subcommands: {
      tooling: RO("resolves scenario tooling -- reads only"),
      "perf-compare": RO("compares a measurement to a budget -- reads only"),
      "method-check": RO("validates a method block -- reads only"),
    },
  },
  ref: {
    subcommands: {
      format: RO("formats the object notation -- pure computation"),
      parse: RO("parses the object notation -- pure computation"),
    },
  },
  release: {
    subcommands: {
      preflight: RO("gathers the precondition table over gh/git reads"),
      "resolve-target": RO("resolves a target token over git reads (its 'git fetch' is the same read the gh/git allowlist already admits)"),
      "self-check": RO("checks a release PR's self-enumeration -- git reads only"),
    },
  },
  repo: {
    subcommands: {
      resolve: RO("resolves a repository token against the registry"),
      inventory: RO("inventories a consumer's backlog -- gh reads only"),
      scenario: RO("reads a repo's recorded scenario"),
    },
  },
  run: { subcommands: { "rerun-failed": MUT("gh run rerun -- re-runs workflow jobs") } },
  scaffold: { subcommands: { init: MUT("creates directories, a commit-msg hook and a template file") } },
  split: { subcommands: { verify: RO("proves diff equality over git reads") } },
  stage: { subcommands: { triage: RO("reads 'git status --porcelain'; stages nothing") } },
  stop: { subcommands: { "*": RO("renders the gate-stop banner; fires nothing itself") } },
  tag: { subcommands: { cut: MUT("creates a tag locally even without --push") } },
  wake: {
    subcommands: {
      fire: GATED(["--run"], "removes/re-applies a label and comments once --run is given"),
      verify: GATED(["--run"], "redrives runs and posts comments once --run is given"),
    },
  },
  warmup: { subcommands: { "*": RO("detects stale pins and sweeps questions -- reads only") } },
  watch: {
    subcommands: {
      until: RO("re-classifies its own --command against this very table before the first observation"),
    },
  },
  wc: { subcommands: { classify: RO("classifies the working copy over git reads") } },
};

// The three commands ../index.ts answers BEFORE the registry (its own header
// explains why they stay pre-registry). Kept as a separate table so the
// exhaustiveness test can require NEN_VERB_TABLE's keys to equal the registry
// EXACTLY -- folding these in would let a stale registry entry hide behind a
// pre-registry name.
export const NEN_PRE_REGISTRY_TABLE: Readonly<Record<string, NenVerbPolicy>> = {
  bootstrap: MUT("downloads and writes a verified binary into the cache"),
  schema: RO("loads and validates the taxonomy files -- reads only"),
  version: RO("prints the version"),
};

const NEN_HEAD = /^nen(\s|$)/;

// THE SAFE SET (#31 rounds three and four). Every character a token scan is
// allowed to see before this module will trust its tokens as the argument
// vector its readers will build.
//
// Deliberately an ALLOWLIST of boring argv characters -- ASCII alphanumerics,
// space, tab, and the punctuation nen's own flags and values actually use:
// - _ . / # @ : = , ~ + (an owner/repo slug, a ../path, a ref like XX-PR-#1,
// a BC@high+ futon token, a --map a=b, an ISO timestamp, a v1..v2 range, a
// severity band's +). That is the whole point of writing it this way round:
// quotes, backslashes, non-breaking spaces, and every character nobody has
// thought of yet land on the REFUSING side by default, instead of being
// enumerated one review round at a time -- which is exactly the race rounds
// one and two lost.
//
// THE PROPERTY BEING BOUGHT is not "these characters look harmless"; it is
// that none of them can change the WORD COUNT or the word BOUNDARIES the
// readers named in this file's header produce. Nothing here quotes (' " \),
// expands into fields ($ `), globs (* ? [ ]) or braces -- so with only these
// on the line, the argv IS the /[ \t]+/ split, word for word.
//
// THREE OF THEM DO SOMETHING AT A WORD BOUNDARY, and only there, which is why
// the character set below is paired with a POSITION rule in
// isScanFaithfulToken rather than being narrowed further:
//
//   * `#` opens a bash COMMENT at the start of a word (round three), so
//     `#x --dry-run` deletes the rest of the line from bash's argv while
//     donating a --dry-run token to this scan. Mid-word it is the ref
//     notation XX-PR-#1 that half this table's examples use.
//   * `@` is PowerShell's SPLAT at the start of a word (round four).
//     Verified in this repository's own environment: with $a = @('--run',
//     'extra'), `cmd /c echo hi @a` prints `hi --run extra` -- ONE scanned
//     token becoming TWO arguments, one of them a write flag. Mid-word it is
//     inert (`x@a` stays `x@a`) and legitimate: `BC@high+`, `nen parse
//     backlog-state BC@G4`, a `git@host:owner/name.git` remote.
//   * `,` at either END of a word is PowerShell's argument-mode ARRAY
//     (round four's own sweep, same environment): `cmd /c echo P --run, x`
//     prints `P --run x`, and `cmd /c echo R x ,--run` prints `R x --run`.
//     The comma is STRIPPED, so the scan's token `--run,` or `,--run` is the
//     argument `--run` to PowerShell -- a write flag invisible to an
//     exact-token match. Mid-word it does not split at all (`x,--run` stays
//     one argument) and it is the comma list nen's own flags take
//     (`--map a=b,c=d`, `--children 2,3`).
//
// The `~` in the set is left alone deliberately: bash expands it as ONE field
// (tilde expansion is not subject to field splitting) and PowerShell passes
// it through literally, so it cannot change a word count in either.
const SCAN_FAITHFUL_CHARS = /^[A-Za-z0-9 \t_.\/#@:=,~+-]*$/;
const SCAN_FAITHFUL_TOKEN_CHARS = /^[A-Za-z0-9_.\/#@:=,~+-]*$/;

// The word-boundary rules above, as the two regexes the token guard applies.
// Kept separate from the character set because they say a different thing:
// the set is about which characters may appear AT ALL, these are about the
// two positions where three of those characters stop being inert.
const BOUNDARY_UNSAFE_HEAD = /^[#@,]/;
const BOUNDARY_UNSAFE_TAIL = /,$/;

// ASCII space/tab ONLY, because THE READERS DISAGREE ABOUT THE REST
// (zheref/nen#70 round two corrected this reason; the behaviour is unchanged).
// JavaScript's \s splits on U+00A0 and friends -- and so does POWERSHELL.
// Verified here with a program that prints its own argv: `A<U+00A0>--run`
// arrives as TWO arguments under PowerShell and as ONE under bash. Round one
// wrote that "no POSIX shell" treats it as a separator -- true -- and then
// leaned on it as though it settled the question for every reader, which it
// does not. The honest statement is that a \s+ split matches one reader and
// not the other, so on such a line the scan's tokens are not provably ANY
// reader's argument vector: under bash a `--dry-run` token is donated that the
// shell never produces, under PowerShell that token is real. Neither reading
// is provable from here, and unprovable refuses.
//
// The bash half is still the vector that found this: a \s+ split hands the
// scan a `--dry-run` token out of the single argument `x --dry-run`.
// Belt to SCAN_FAITHFUL_CHARS's braces -- exotic whitespace is outside the
// safe set too, so either guard alone closes that vector; both are kept
// because they state different halves of one invariant (what a token IS, and
// what a line may CONTAIN), and neither should silently start depending on
// the other.
const SCAN_SPLIT = /[ \t]+/;

/**
 * Whether one whitespace-delimited token is provably the word its readers
 * would put at that position.
 *
 * The BOUNDARY arms are not decoration; each closed a live fail-open found by
 * a review round, and all three hide INSIDE the safe set rather than outside
 * it (see SCAN_FAITHFUL_CHARS for the verified repros):
 *
 *   * word-initial `#` -- bash comment. `nen labels sync --target o/r #x
 *     --dry-run` hands bash the comment `#x --dry-run` and runs the WRITING
 *     form while donating a `--dry-run` token to this scan.
 *   * word-initial `@` -- PowerShell splat. `nen wake fire ... @a` classified
 *     read-only while a caller with $a = @('--run') ran the write.
 *   * word-edge `,` -- PowerShell argument-mode array. `,--run` and `--run,`
 *     both arrive at nen as `--run`, which an exact-token flag scan misses.
 *
 * All three over-refuse in every OTHER position they could occur in, which is
 * the direction this module always accepts.
 */
export function isScanFaithfulToken(token: string): boolean {
  return (
    SCAN_FAITHFUL_TOKEN_CHARS.test(token) &&
    !BOUNDARY_UNSAFE_HEAD.test(token) &&
    !BOUNDARY_UNSAFE_TAIL.test(token)
  );
}

/**
 * Whether a /[ \t]+/ split of this whole line provably reproduces the
 * argument vector its readers would build from it -- ../cli/args.ts always,
 * plus whatever shell the skill side may hand the string to (see this file's
 * header for exactly which shells that claim has been checked against).
 *
 * Exported alongside isScanFaithfulToken for their own test: this pair is the
 * load-bearing half of every scan-dependent verdict below, and a widened safe
 * set must go red on its own terms rather than only through whichever repro
 * happens to still be pinned.
 */
export function isScanFaithfulLine(line: string): boolean {
  return SCAN_FAITHFUL_CHARS.test(line) && line.split(SCAN_SPLIT).every(isScanFaithfulToken);
}

function nenUnknown(reason: string): ClassifyResult {
  return { classification: "unknown", reason };
}

/**
 * ASCII TRIM ONLY -- the trim every scan-dependent verdict in this file
 * answers against.
 *
 * String.trim() strips U+00A0 and every other Unicode space where a shell
 * strips neither, so trimming with it would hand the scan a line the shell
 * never sees: a guard whose own input can be laundered by the call in front of
 * it is not a guard. (Space and tab are inside the safe set, so ordinary
 * leading/trailing whitespace costs nothing.)
 *
 * Hoisted out of classifyNenInvocation by zheref/nen#70, because the gh/git
 * rows' faithfulness gate needs the same treatment for the same reason.
 */
function asciiTrim(raw: string): string {
  return raw.replace(/^[ \t]+|[ \t]+$/g, "");
}

/**
 * Half (A) of the scan-faithfulness invariant: the tokens read to identify
 * the verb must each be provably the shell's word at that position.
 *
 * `endIndex` is INCLUSIVE and names the last token the walk consumed for
 * identification -- the subcommand key, the family for a "*" row, or the
 * global flag that answered on its own. Everything after it is arguments,
 * which half (B) judges separately (and which a verb-identity-only row does
 * not judge at all).
 */
function unprovableVerbPath(tokens: readonly string[], endIndex: number): ClassifyResult | undefined {
  const offender = tokens.slice(0, endIndex + 1).find((token): boolean => !isScanFaithfulToken(token));
  if (offender === undefined) return undefined;
  return nenUnknown(
    `'${offender}' sits in this line's verb path and carries a character outside the scan's safe set (a quote, a backslash, a $, a glob, exotic whitespace, a word-initial # or @, a word-edge comma, ...) -- so the word this line's readers would put there is not provably the word this scan read, and no row of the table has been shown to apply`,
  );
}

function classifyNenInvocation(raw: string): ClassifyResult {
  // The whole nen branch answers against the ASCII-trimmed line (see
  // asciiTrim for why String.trim() would not do).
  const line = asciiTrim(raw);
  const lineFaithful = isScanFaithfulLine(line);

  // NO METACHARACTER GUARD HERE ANY MORE (zheref/nen#70). It used to run
  // first in this function -- `nen pr ready 1; git push` is not a nen
  // invocation with a strange argument, it is two commands, and the second is
  // the shell's to run rather than this table's to vouch for -- and that
  // reasoning is unchanged; what changed is WHERE it is enforced. The check
  // now runs once at classifyCommand's seam, ahead of this branch and of
  // every other one that can answer read-only, so the gh/git rows get the
  // same guard from the same code instead of a copy of it. This branch
  // is unreachable with a metacharacter on the line, and the verdicts it
  // produces are unchanged: the seam refuses the same lines this guard did,
  // one call earlier.
  const tokens = line.split(SCAN_SPLIT);
  // Skip the global flags ../index.ts's stage-one parse admits before the
  // family; --version/--help print and exit, which is a read.
  let index = 1;
  for (;;) {
    const token = tokens[index];
    if (token === undefined) {
      return nenUnknown("'nen' names no verb -- there is nothing to classify");
    }
    if (token === "--version" || token === "-v" || token === "--help" || token === "-h") {
      return (
        unprovableVerbPath(tokens, index) ?? {
          classification: "read-only",
          reason: "nen --version/--help prints and exits",
        }
      );
    }
    if (token === "--json") {
      index += 1;
      continue;
    }
    if (token === "--repo") {
      index += 2;
      continue;
    }
    if (token.startsWith("--repo=")) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return nenUnknown(`'${token}' is not a global flag this table recognizes before the verb -- not assumed safe`);
    }
    break;
  }

  const family = tokens[index] ?? "";
  const pre = NEN_PRE_REGISTRY_TABLE[family];
  if (pre !== undefined) {
    return unprovableVerbPath(tokens, index) ?? evaluateNenPolicy(pre, `nen ${family}`, tokens, lineFaithful);
  }
  const entry = NEN_VERB_TABLE[family];
  if (entry === undefined) {
    return nenUnknown(
      `'nen ${family}' is not a verb family this table classifies -- an unclassified verb is never assumed safe`,
    );
  }

  // Longest key first ("mirror check" before "mirror"), the family-wide "*"
  // last -- and the LABEL is the key that matched, so a reason line always
  // names exactly the form the table vouched for.
  const sub = tokens[index + 1];
  const subsub = tokens[index + 2];
  const candidates: readonly string[] = [
    ...(sub !== undefined && subsub !== undefined ? [`${sub} ${subsub}`] : []),
    ...(sub !== undefined ? [sub] : []),
  ];
  for (const [offset, key] of candidates.entries()) {
    const policy = entry.subcommands[key];
    if (policy !== undefined) {
      // The two-token key ("mirror check") is tried first, so its own path
      // runs one token longer than the one-token key's -- hence the offset
      // rather than a constant.
      const pathEnd = index + (candidates.length - offset);
      return (
        unprovableVerbPath(tokens, pathEnd) ??
        evaluateNenPolicy(policy, `nen ${family} ${key}`, tokens, lineFaithful)
      );
    }
  }
  const familyWide = entry.subcommands["*"];
  if (familyWide !== undefined) {
    // A "*" row is selected by the FAMILY alone (stop, warmup, parse), so the
    // subcommand token is an argument here, not part of the path.
    return unprovableVerbPath(tokens, index) ?? evaluateNenPolicy(familyWide, `nen ${family}`, tokens, lineFaithful);
  }
  return nenUnknown(
    `'nen ${family} ${sub ?? "(none)"}' is not in the verb table for '${family}' -- a subcommand this table has not classified is never assumed safe`,
  );
}

// Used by the WRITE-FLAG-GATED scan only, where every arm errs refusing at
// worst.
//
// IT MATCHES WHAT ../cli/args.ts ACCEPTS, NOT WHAT A USAGE LINE PRINTS (#31
// round four's blocker). args.ts resolves a flag's name with
// `token.replace(/^--?/, "")` -- ONE dash or two, no distinction -- so `-run`
// and `--run` are the same flag to nen, and `-out x` and `--out=x` are the
// same value flag. The scan used to compare against the two-dash spelling
// only, which made every write flag in the table reachable behind a single
// dash while the line still classified [read-only]: `nen wake fire ... -run`,
// `nen wake verify ... -run`, `nen changelog collate -write`, `nen epic
// next-wave -out x.md`, `nen canon mirror check --rules-dir r -markdown-out
// report.md`. On the `nen watch until --command "..."` path that fired the
// write on every observation interval, inside a watch that only accepts
// read-only commands. All four spellings are matched here, and
// izanami.test.ts pins the correspondence STRUCTURALLY -- driving each
// family's real FlagSpec through the real parseArgs -- so a future change to
// either side that reopens the gap goes red rather than shipping.
//
// The `=value` arms are live for the value-taking write flags (--out,
// --markdown-out) and merely over-refuse for the boolean ones (`--run=x`
// dies as a usage error inside args.ts, and calling that line mutating
// refuses something that could never run -- the safe direction).
//
// THE DRY-RUN GATE DELIBERATELY DOES NOT USE THIS HELPER, and the asymmetry
// is the point: this helper answers "is a WRITE flag present", where matching
// more spellings refuses more, while the dry-run gate answers "is the READ
// gate present", where matching more spellings ADMITS more. So the gate stays
// on the exact `--dry-run` token: `--dry-run=false` can never run as a dry run
// (args.ts refuses inline values on booleans) and could mean the opposite to
// another tool a shell hands it to, and the single-dash `-dry-run` -- which
// args.ts really would accept -- is left unmatched too, costing only an
// over-refusal of a genuinely-read line. Widening a gate is how a fail-open
// gets built; widening a refusal is not.
//
// IT RETURNS THE TOKEN, not a boolean, so the refusal can quote the spelling
// the caller actually typed. A message that answers `-run` with "matches
// --run" reads like the classifier misread the line, when the real answer is
// "those are the same flag to nen" -- and a refusal a caller does not believe
// is a refusal they route around.
function findFlagToken(tokens: readonly string[], flag: string): string | undefined {
  const name = flag.replace(/^--/, "");
  const spellings = [`--${name}`, `-${name}`];
  return tokens.find((token): boolean =>
    spellings.some((spelling): boolean => token === spelling || token.startsWith(`${spelling}=`)),
  );
}

// One sentence, reused by every scan-dependent refusal, so a caller reading
// three different reasons still learns the same rule once.
const UNFAITHFUL =
  "this line carries a character outside the scan's safe set (a quote, a backslash, exotic whitespace, a word-initial # or @, a word-edge comma, ...), so its whitespace tokens are not provably the argument vector this line's readers would build";

function evaluateNenPolicy(
  policy: NenVerbPolicy,
  label: string,
  tokens: readonly string[],
  lineFaithful: boolean,
): ClassifyResult {
  // A passthrough `--` hands everything after it to an underlying tool
  // (../cli/args.ts), and what THAT tool does with it is not provable from
  // here -- `nen dev test -- -u` would have vitest rewriting snapshot files
  // under a verb this table calls a checker. Refused as unknown for every
  // policy, including "read-only": the table vouches for nen's verbs, not
  // for arbitrary arguments forwarded through them.
  //
  // THIS CHECK IS ITSELF A SCAN, and its negative result is only worth
  // anything on a scan-faithful line -- which is why the two policies whose
  // read-only verdict depends on that negative (read-only-forwarding) or on
  // any other flag scan (dry-run-gated, write-flag-gated) re-check
  // lineFaithful below. A plain "read-only" verb forwards nothing, so a `--`
  // the scan missed lands nowhere and cannot make it write.
  if (tokens.includes("--")) {
    return nenUnknown(
      `${label} with a passthrough '--' forwards arguments to an underlying tool -- what runs behind the separator is not provably read-only`,
    );
  }

  switch (policy.kind) {
    case "read-only":
      // No LINE-level guard here, deliberately: this policy's answer hinges
      // on the VERB, not on any argument scan, so a quoted or escaped
      // ARGUMENT cannot flip it (`nen watch until --command "gh pr checks
      // 1"` stays read-only, and must). The verb PATH that got us here was
      // already proven faithful by unprovableVerbPath -- half (A) of the
      // file header -- which is the part round two left open.
      return { classification: "read-only", reason: `${label} -- ${policy.why}` };
    case "read-only-forwarding": {
      // The verb reads, but it FORWARDS post-`--` argv to another program
      // (`nen dev test -- -u` has vitest rewriting snapshots), so the
      // read-only claim rests on the `--` scan above finding nothing -- and
      // that negative is only provable on a faithful line. `nen dev test
      // '--' -u` is a bare `--` to every real shell while the scan sees the
      // token `'--'`; `nen dev test \-- -u` is the same trick unquoted.
      if (!lineFaithful) {
        return nenUnknown(
          `${label} forwards everything after a bare '--' to another tool, and ${UNFAITHFUL} -- so the '--' this scan did not find is not provably absent`,
        );
      }
      return { classification: "read-only", reason: `${label} -- ${policy.why}` };
    }
    case "mutating":
      return { classification: "mutating", reason: `${label} -- ${policy.why}` };
    case "dry-run-gated": {
      // The verb WRITES by default; only an explicit `--dry-run` argument
      // makes it a read. Both halves must hold: the exact token is present,
      // AND the line is scan-faithful so that token is provably an argument
      // of its own rather than a fragment of one (`--title "add --dry-run
      // support"` and `--title x\ --dry-run` each donate a `--dry-run` token
      // to the scan that no shell ever produces). An unprovable gate on a
      // writes-by-default verb is no gate: mutating.
      if (!tokens.includes("--dry-run")) {
        return { classification: "mutating", reason: `${label} -- ${policy.why}` };
      }
      if (!lineFaithful) {
        return {
          classification: "mutating",
          reason: `${label} -- ${UNFAITHFUL}; the --dry-run cannot be proven to be an argument of its own rather than part of an adjacent value, and an unprovable gate on a writes-by-default verb is no gate`,
        };
      }
      return { classification: "read-only", reason: `${label} --dry-run -- the explicit dry-run form reports without writing` };
    }
    case "write-flag-gated": {
      const hit = policy.writeFlags
        .map((flag): { flag: string; token: string | undefined } => ({ flag, token: findFlagToken(tokens, flag) }))
        .find((entry): boolean => entry.token !== undefined);
      if (hit?.token !== undefined) {
        // Checked BEFORE scan-faithfulness and unconditionally: a
        // flag-shaped substring the scan mistakes for the real thing flips
        // this to mutating, which is the direction this module always
        // accepts (see the flag-detection note above NEN_VERB_TABLE).
        //
        // The message names the token AS TYPED, and says why a spelling that
        // is not the table's own still counts -- otherwise a caller who wrote
        // `-run` reads "matches --run" as the classifier having misread them.
        const spelled =
          hit.token === hit.flag
            ? hit.flag
            : `${hit.token} (the ${hit.flag} flag -- nen's own argv reader takes one or two leading dashes alike)`;
        return { classification: "mutating", reason: `${label} ${spelled} -- ${policy.why}` };
      }
      if (!lineFaithful) {
        // The symmetric open direction: this read-only claim hinges on the
        // write flags' ABSENCE, and an unfaithful line can splice one out of
        // the scan's sight -- '--run' and \--run are both --run to a shell,
        // and neither is the token --run to the scan.
        return nenUnknown(
          `${label} claims read-only because ${policy.writeFlags.join("/")} is absent, but ${UNFAITHFUL} -- a quoted or escaped spelling of a write flag would be invisible to it, so only the scan-faithful form is provably a read`,
        );
      }
      return {
        classification: "read-only",
        reason: `${label} without ${policy.writeFlags.join("/")} -- reports without writing`,
      };
    }
  }
}

/**
 * `-X`/`--method`'s verdict for one resolved value, or undefined when the
 * value positively resolves to GET and the walk may continue.
 *
 * THE THREE ANSWERS ARE DELIBERATELY DISTINCT, and the middle one is the whole
 * point of #70 round two's blocker: a value the scan cannot POSITIVELY resolve
 * to GET is not a read, whatever it looks like. Round one's regex answered
 * "no method found" for `-X=DELETE` and fell through to "GET by default",
 * which is the one answer a table that may only err in the refusing direction
 * must never give.
 */
function ghApiMethodVerdict(spelling: string, value: string | undefined): ClassifyResult | undefined {
  if (value === undefined) {
    return {
      classification: "unknown",
      reason: `gh api's '${spelling}' names an HTTP method but this line gives it no value the scan can read, so the request is not provably a GET`,
    };
  }
  // A method is a bare word to gh. Anything else -- `'DELETE'`, `\DELETE`,
  // an empty `--method=` -- is a value this scan cannot resolve, and an
  // unresolved method is refused rather than guessed at.
  if (!/^[A-Za-z]+$/.test(value)) {
    return {
      classification: "unknown",
      reason: `gh api's '${spelling}' carries the value '${value}', which is not a bare HTTP method this scan can resolve (a real shell would unquote or unescape it first) -- so the request is not provably a GET`,
    };
  }
  if (/^GET$/i.test(value)) return undefined;
  return { classification: "mutating", reason: `gh api with an explicit non-GET method (${value})` };
}

/**
 * The whole `gh api` verdict, decided by walking the argument vector under
 * pflag's rules rather than by matching spellings on the raw line.
 *
 * See the GH_API block comment for the two live fail-opens that forced this
 * (`-X=DELETE` -> DELETE, `-ftitle=pwned` -> POST, both verified against the
 * real gh 2.92.0) and for the grouped-shorthand spelling (`-iX DELETE`) that
 * shows why patching those two arms would only have moved the hole.
 *
 * A TOKEN THE WALK CANNOT PLACE REFUSES. That covers a flag gh grows tomorrow,
 * a second positional, a bare `-`, a `--` terminator -- none of them is a
 * shape this row has been shown to apply to.
 */
function classifyGhApi(scanLine: string, faithful: boolean): ClassifyResult {
  const unresolved = (reason: string): ClassifyResult => ({ classification: "unknown", reason });
  // `gh` and `api` are the two tokens GH_API already matched.
  const tokens = scanLine.split(SCAN_SPLIT).slice(2);
  let positionals = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "") continue;

    if (token === "--" || token === "-") {
      return unresolved(
        `gh api with a bare '${token}' -- pflag stops flag parsing there, so what follows is not provably the endpoint this row would vouch for`,
      );
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const kind = GH_API_LONG_FLAGS[name];
      if (kind === undefined) {
        return unresolved(
          `'--${name}' is not a flag this gh api row classifies (the table carries exactly what 'gh api --help' lists on gh 2.92.0) -- an unclassified flag is never assumed inert`,
        );
      }
      if (kind === "post-forcing") {
        return { classification: "mutating", reason: GH_API_POST_FORCING_REASON };
      }
      if (kind === "method") {
        let value = inline;
        if (value === undefined) {
          index += 1;
          value = tokens[index];
        }
        const verdict = ghApiMethodVerdict(`--${name}`, value);
        if (verdict !== undefined) return verdict;
        continue;
      }
      if (kind === "value" && inline === undefined) {
        index += 1;
        if (tokens[index] === undefined) {
          return unresolved(`gh api's '--${name}' takes a value and this line ends before giving it one`);
        }
      }
      continue;
    }

    if (token.startsWith("-")) {
      // A pflag SHORTHAND CLUSTER: `-i`, `-iX`, `-iXDELETE`, `-iX=DELETE`,
      // `-if` are all one token and up to two flags. Walking it character by
      // character is what round one's `(?:^|\s)-f\b` could not do.
      let cursor = 1;
      let consumedValue = false;
      while (cursor < token.length && !consumedValue) {
        const letter = token.charAt(cursor);
        const kind = GH_API_SHORT_FLAGS[letter];
        if (kind === undefined) {
          return unresolved(
            `'-${letter}' (in '${token}') is not a shorthand this gh api row classifies -- an unclassified flag is never assumed inert`,
          );
        }
        if (kind === "post-forcing") {
          return { classification: "mutating", reason: GH_API_POST_FORCING_REASON };
        }
        if (kind === "method" || kind === "value") {
          // pflag takes the REST of the cluster as the value, dropping one
          // optional `=`; an empty rest takes the next token instead.
          const rest = token.slice(cursor + 1);
          const attached = rest.startsWith("=") ? rest.slice(1) : rest;
          let value: string | undefined = attached;
          if (attached === "") {
            index += 1;
            value = tokens[index];
          }
          if (kind === "method") {
            const verdict = ghApiMethodVerdict(`-${letter}`, value);
            if (verdict !== undefined) return verdict;
          } else if (value === undefined) {
            return unresolved(`gh api's '-${letter}' takes a value and this line ends before giving it one`);
          }
          consumedValue = true;
          continue;
        }
        cursor += 1;
      }
      continue;
    }

    positionals += 1;
    if (positionals > 1) {
      return unresolved(
        `gh api takes ONE endpoint and this line offers ${positionals} bare words -- the extra ones are not arguments this row can place, so the request is not provably a GET`,
      );
    }
  }

  // Kept as a whole-line check rather than an endpoint check: it only ever
  // over-refuses (a `--jq .graphql` read refuses with it), and a query and a
  // mutation are indistinguishable from the CLI form either way.
  if (GH_API_GRAPHQL.test(scanLine)) {
    return { classification: "mutating", reason: "gh api graphql -- a query and a mutation are indistinguishable from the CLI form" };
  }

  // The read-only answer is a set of ABSENCE claims scanned over the whole
  // line, so it is only worth anything on a line whose tokens are provably the
  // ones its readers build (zheref/nen#70; the `-X 'DELETE'` repro walked past
  // round one's three regexes entirely).
  if (!faithful) {
    return unresolved(
      `gh api claims read-only because every flag on the line walks to a read (no non-GET method, no -f/-F/--field/--raw-field/--input value, not graphql), but ${UNFAITHFUL} -- a quoted or escaped method (\`-X 'DELETE'\`) is one word to this walk and the bare flag to a real shell, so only the scan-faithful form is provably a GET`,
    );
  }
  return { classification: "read-only", reason: "gh api with no write method, no field flags, and not graphql -- GET by default" };
}

export function classifyCommand(command: string): ClassifyResult {
  const trimmed = command.trim();
  // The line the scan-dependent gates below answer against -- ASCII-trimmed,
  // never String.trim()'d, for the reason asciiTrim states. `trimmed` keeps
  // doing the ROUTING (which row family this line belongs to), which only ever
  // admits MORE lines into a fail-closed table.
  const scanLine = asciiTrim(command);

  for (const pattern of MUTATING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { classification: "mutating", reason: `matches a refused pattern (${pattern.source})` };
    }
  }

  // `gh api`'s verdict is computed HERE, before the seam, and only its
  // MUTATING half is allowed to answer from here (zheref/nen#70 round two).
  //
  // The reason is the same one that puts MUTATING_PATTERNS above the seam: a
  // named refusal beats a generic one. Round one put the whole gh api block
  // BELOW the seam, so `gh api repos/o/r -X POST | tee x` -- three of this
  // module's most specific refusals, one per line -- came back as "there is a
  // metacharacter here" and lost its name. Reading the verdict early and
  // returning only the mutating half restores the name without letting a
  // read-only certification out ahead of the metacharacter check, which is the
  // one thing the seam exists to prevent.
  const ghApi = GH_API.test(trimmed) ? classifyGhApi(scanLine, isScanFaithfulLine(scanLine)) : undefined;
  if (ghApi?.classification === "mutating") return ghApi;

  // THE METACHARACTER SEAM (zheref/nen#70). ONE guard, ahead of every branch
  // below that can answer "read-only" -- gh api, nen's own verbs, the plain
  // file reads, and the pre-existing gh/git rows that used to walk past it.
  //
  // WHY HERE AND NOT AT EACH RETURN SITE: a guard that must be remembered at
  // the next return site is a guard that will be forgotten there, which is
  // exactly how `git log > out.txt` came to certify a write. At the seam, a
  // row added tomorrow inherits it without its author knowing it exists.
  //
  // WHY AFTER THE NAMED MUTATING REFUSALS: those are head-anchored, so when a
  // line STARTS with `git push` the named rule holds no matter what else the
  // line carries, and naming the rule is the more actionable refusal. It is
  // the READ-ONLY certifications -- claims about a line the metacharacter has
  // already turned into two commands -- that this seam exists to stop.
  //
  // TESTED AGAINST THE RAW COMMAND, not `trimmed`: String.trim() strips the
  // newline and CR that are themselves in this set, so trimming first would
  // let the guard's own input be laundered by the call in front of it. The
  // nen branch already refused a trailing newline this way; every row does
  // now, and `classifyCommand("git log\n")` is the test that kills the
  // `trimmed` mutant (zheref/nen#70 round two -- round one argued this in
  // prose and pinned nothing, and the mutant survived the whole suite).
  if (SHELL_METACHARS.test(command)) {
    return { classification: "unknown", reason: shellMetacharRefusal(command) };
  }

  if (ghApi !== undefined) return ghApi;

  // nen's own verbs, against the explicit per-verb table above (#31). This
  // runs BEFORE the plain-read patterns so `nen wc classify` is decided by
  // the table's entry for the wc FAMILY, never by the `wc` utility pattern
  // matching mid-string -- though head-anchoring already prevents that, the
  // ordering states the intent.
  if (NEN_HEAD.test(trimmed)) {
    // The RAW command goes down, not `trimmed`: classifyNenInvocation does
    // its own ASCII-only trim, because String.trim() strips U+00A0 and
    // friends where a shell strips neither. (`trimmed` decided we are on the
    // nen path at all, and that decision only ever admits MORE lines into
    // this fail-closed table -- `nen<U+00A0>pr ready` matches NEN_HEAD's
    // `\s`, routes here, and refuses on its unprovable verb path.)
    return classifyNenInvocation(command);
  }

  for (const pattern of PLAIN_READ_PATTERNS) {
    if (pattern.test(trimmed)) {
      // The metacharacter check that used to live here is the seam's now
      // (zheref/nen#70) -- `cat > file` cannot reach this line.
      return {
        classification: "read-only",
        reason: `a plain file read (${pattern.source}) -- izanami's own 'reading a file' row`,
      };
    }
  }

  for (const row of READ_ONLY_PATTERNS) {
    if (row.pattern.test(trimmed)) {
      // A "line-scan" row's verdict is a claim about the WHOLE line, which is
      // a token scan by another spelling -- so #31's invariant binds it and an
      // unfaithful line refuses (zheref/nen#70; `git branch '-D'`, `git remote
      // 'prune'` and `git log '--output' f` are the repros, the last one
      // verified writing the file through a real shell). An "identity" row's
      // verdict is the subcommand's, and its subcommand has no writing
      // argument form at all, so it is left free to carry a quoted value
      // exactly as nen's plain read-only rows are.
      //
      // The refusal quotes the row's OWN whole-line claim rather than one
      // example borrowed from another row, for the same reason
      // shellMetacharRefusal quotes the caller's own line.
      if (row.hinge === "line-scan" && !isScanFaithfulLine(scanLine)) {
        return {
          classification: "unknown",
          reason: `izanami's allowlist admits this only in its provably-read form (${row.claim ?? row.pattern.source}) -- a claim about the WHOLE line, not just its head -- and ${UNFAITHFUL}: a quoted or escaped flag ('-D', 'prune', '--output') is one word to this scan and the bare writing flag to a real shell, so only the scan-faithful form is provably a read`,
        };
      }
      return { classification: "read-only", reason: `matches izanami's allowlist (${row.pattern.source})` };
    }
  }

  return {
    classification: "unknown",
    reason: "matches neither izanami's allowlist nor a named refusal -- an unrecognized command is never assumed safe",
  };
}

export interface ClassifiedInvocation {
  readonly ok: boolean;
  readonly condition: string;
  readonly commands: readonly { readonly command: string; readonly classification: ClassifyResult }[];
}

export function classifyInvocation(invocation: IzanamiInvocation): ClassifiedInvocation {
  const commands = invocation.commands.map((command): { command: string; classification: ClassifyResult } => ({
    command,
    classification: classifyCommand(command),
  }));
  return {
    ok: commands.every((entry): boolean => entry.classification.classification === "read-only"),
    condition: invocation.condition,
    commands,
  };
}
