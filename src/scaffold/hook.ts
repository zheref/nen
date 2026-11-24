// src/scaffold/hook.ts -- the Akatsuki-Agent:/Akatsuki-Run: trailer-enforcing
// commit-msg hook.
//
// THIS HOOK NEVER EXISTED IN bankai-core. Its trailer pair is bankai-core's
// own naming convention renamed (Bankai-Agent:/Bankai-Run: -> Akatsuki-
// Agent:/Akatsuki-Run:, the migration's own global rename), but the HOOK
// ITSELF -- a commit-msg guard that enforces the trailer is present and
// well-formed on an automated commit -- is new: bankai-core's commits carry
// the trailer by convention, unchecked. Scaffold output is where it is
// specified to live (issue #4, artifact assumption 3), so it is authored
// fresh here rather than ported from anywhere.
//
// ENFORCEMENT IS CONDITIONAL ON THE ENVIRONMENT, NOT ON EVERY COMMIT. A human
// typing `git commit` at a keyboard is not an automated run and carries no
// obligation to add either trailer. The hook only requires them when an
// automated commit says so of ITSELF -- the caller-named environment variable
// being set is what marks a commit as automated -- so a human's ordinary
// workflow is never touched by this at all. Getting that backwards (requiring
// the trailer on every commit) would make every human commit fail a hook
// installed by a scaffold nobody read the fine print of.
//
// THE TRAILER NAMES ARE CALLER DATA. Which trailer key this hook requires,
// which second one it requires alongside it (if any), and which environment
// variable marks an automated commit, are supplied by the caller
// (../scaffold/command.ts's flags) -- this system serves more than one
// target, and a literal 'Akatsuki-Agent' baked into THIS module would be
// exactly the persona-naming violation §3 exists to catch, even though this
// specific pair is Akatsuki's own by design (../scaffold/command.ts's
// `--agent-trailer` default names it, one layer up, where a caller who wants
// a different key already has the flag that overrides it; the point is that
// THIS module does not assume it).
//
// v0.6.0 (zheref/nen#167): THE AUTOMATED HALF NOW REQUIRES exactly ONE
// trailer -- ../schema/workflow.ts's `commits.runTrailer` makes a second one
// an OPTIONAL obligation a repository opts into, rather than a pair this hook
// always demanded. And the one it does require is no longer taken on faith:
// `nen scaffold init` resolves, at generation time, whether the repository's
// OWN policy actually admits the key it is about to require
// (../schema/workflow.ts's `trailerAdmitted`) -- a policy that does not is a
// requirement no commit could ever honestly satisfy, so the generated hook's
// automated half refuses every automated commit outright, naming the missing
// policy, rather than checking for a trailer nobody could ever add without
// also having it refused by the check above.

import { chmodSync, writeFileSync } from "node:fs";

/**
 * Write a generated hook and make it executable, in that order.
 *
 * BOTH VERBS GO THROUGH THIS ONE FUNCTION, and the mode is why. `git` will not
 * run a `commit-msg` hook that is not executable -- it skips it, silently, on
 * every commit -- so a hook written 0644 is a hook that reports `created` and
 * enforces nothing. `nen scaffold new` shipped one for exactly as long as it had
 * its own two-line writer beside `nen scaffold init`'s three-line one; one
 * writer is one place the mode is set.
 *
 * A FAILED `chmod` IS NOT A FAILED INSTALL. Windows filesystems do not model
 * the POSIX executable bit and `git` only consults it on a POSIX checkout, so
 * the bit is set where it means something and its absence is not an error where
 * it does not. The write itself is NOT caught here: a `commit-msg` hook that
 * could not be written is a fact the caller has to hear about, and each verb
 * records it with the errno.
 */
export function writeHookFile(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  try {
    chmodSync(path, 0o755);
  } catch {
    // See above: the bit is advisory on the platforms where this throws.
  }
}

export interface HookSpec {
  /** The trailer key naming which agent/persona made an automated commit. */
  readonly agentTrailer: string;
  /**
   * The trailer key naming which CI run produced an automated commit, or
   * `null` when this repository states none (../schema/workflow.ts's
   * `commits.runTrailer`, absent by default). ABSENT MEANS OPTIONAL: unlike
   * `agentTrailer`, a run identifier is never required unless the policy
   * says so.
   */
  readonly runTrailer: string | null;
  /** The environment variable whose presence marks a commit as automated. */
  readonly markerEnvVar: string;
}

/** The sidecar under the git dir the strip step names each removed key in -- `<git dir>/nen-stripped-trailers.<run id>`; ../commit/strip.ts reads it. */
export const STRIP_SIDECAR_FILE = "nen-stripped-trailers";

/** The variable whose PRESENCE gates the strip step -- ../commit/strip.ts sets it on the child `git commit`. */
export const HOOK_COMPOSED_KEYS_ENV = "NEN_COMPOSED_TRAILER_KEYS";

/**
 * The variable naming the nen RUN a strip is recorded for: lower-case hex,
 * fresh per invocation of `nen commit write` / `nen wc squash`. The sidecar
 * is `<git dir>/nen-stripped-trailers.<run>`, so two runs never read each
 * other's (hanten round 1, Feitan SEC-12). Missing or malformed while
 * HOOK_COMPOSED_KEYS_ENV is set means that variable was exported or leaked
 * rather than set by a verb: the hook still strips, says so, and writes no
 * sidecar.
 */
export const HOOK_STRIP_RUN_ENV = "NEN_STRIP_RUN";

/**
 * The awk program the strip step runs once per key, with `key` the lower-cased
 * key. It prints the message with that key's trailer lines (and their folded
 * continuations) removed from the trailer block, and exits 0 when it removed
 * one, 1 when it did not -- an awk that fails exits 2, which the script reads
 * as "nothing removed", so the refusal below then decides (fail closed).
 *
 * THE TRAILER BLOCK IS FOUND AS GIT FINDS IT: below a scissors line nothing
 * counts -- a key there is never stripped and is left for the refusal below,
 * which greps the whole file (fail closed); trailing blank and '#' lines are
 * skipped; the block is the last paragraph, and never the FIRST one (that is
 * the subject). Every non-'#' line in it must be a trailer (`Key:` or
 * `Key :`) or a continuation (leading whitespace, not first) -- a paragraph of
 * prose with one `Key:` line in it is body text, and nothing in it is
 * touched. CRLF is matched through, and every kept line is printed exactly as
 * it was read.
 *
 * THE KEY MATCHES EXACTLY, IN EITHER FORM GIT PARSES: `Key:` and the spaced
 * `Key : value` (spaces or tabs before the colon), any case -- never a prefix
 * (`Co-authored-by-bot:` is another key and is kept). The spaced form is
 * stripped HERE only: the refusal greps below match `^Key:` and are left byte
 * for byte as they were, so outside the opt-in a spaced key still reaches the
 * read-back, which refuses it at exit 3 as before.
 */
const STRIP_AWK = String.raw`{ raw[NR] = $0; t = $0; sub(/\r$/, "", t); txt[NR] = t }
END {
  n = NR
  for (i = 1; i <= NR; i++) if (txt[i] ~ /^# -+ >8 -+$/) { n = i - 1; break }
  e = n
  while (e > 0 && (txt[e] ~ /^[ \t]*$/ || substr(txt[e], 1, 1) == "#")) e--
  s = e
  while (s > 1 && txt[s - 1] !~ /^[ \t]*$/) s--
  ok = 0
  for (i = 1; i < s; i++) if (txt[i] !~ /^[ \t]*$/) ok = 1
  for (i = s; ok && i <= e; i++) {
    if (substr(txt[i], 1, 1) == "#") continue
    if (txt[i] ~ /^[A-Za-z0-9][A-Za-z0-9-]*[ \t]*:/) continue
    if (i > s && txt[i] ~ /^[ \t]/) continue
    ok = 0
  }
  hit = 0
  skip = 0
  k = length(key)
  for (i = 1; i <= NR; i++) {
    if (ok && i >= s && i <= e) {
      if (skip && txt[i] ~ /^[ \t]/) continue
      skip = 0
      if (tolower(substr(txt[i], 1, k)) == key && substr(txt[i], k + 1) ~ /^[ \t]*:/) { skip = 1; hit = 1; continue }
    }
    print raw[i]
  }
  if (hit) exit 0
  exit 1
}`;

/** The listed keys, de-duplicated case-insensitively, in the policy's own spelling -- what the report and the sidecar say. */
function stripKeys(stripInjected: readonly string[]): readonly string[] {
  const keys: string[] = [];
  for (const key of stripInjected) {
    if (!keys.some((other): boolean => other.toLowerCase() === key.toLowerCase())) keys.push(key);
  }
  return keys;
}

/**
 * The strip step, or "" when the repository lists no key -- the empty string is
 * what keeps an unchanged policy's hook byte-identical (renderCommitMsgHook's
 * header).
 */
function renderStripStep(keys: readonly string[]): string {
  if (keys.length === 0) return "";
  return `
# commits.stripInjected (zheref/nen#594). Only inside a commit a nen verb
# started -- ${HOOK_COMPOSED_KEYS_ENV} set, even empty, to the keys the message
# nen composed carries -- remove each key listed here that the composed message
# did NOT carry from the message's trailer block: a hook (a harness's own
# prepare-commit-msg) added it. This is not an override: it never lets a
# refused key through (the refusals below still run on what is left), never
# touches a key the composed message carried, and a plain 'git commit' (the
# variable unset) strips nothing. Every removal is reported on stderr and, for
# the nen run ${HOOK_STRIP_RUN_ENV} names, in ${STRIP_SIDECAR_FILE}.<run> under
# the git dir, which the verb reports as exit 4. NEITHER VARIABLE IS EVER
# EXPORTED BY HAND: nen sets both on the one child 'git commit' it runs, and a
# composed-keys variable found without a well-formed run id was exported or
# leaked -- the strip still happens, says so, and records nothing.
if [ -n "\${${HOOK_COMPOSED_KEYS_ENV}+x}" ]; then
  nen_composed=",\$(printf '%s' "\$${HOOK_COMPOSED_KEYS_ENV}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'),"
  nen_run="\${${HOOK_STRIP_RUN_ENV}:-}"
  case "\$nen_run" in
    ''|*[!0-9a-f]*) nen_run='' ;;
  esac
  # The listed keys, space-separated: each is [A-Za-z0-9][A-Za-z0-9-]* (held
  # to that shape at load), so the unquoted expansion below splits on spaces
  # and nothing else.
  nen_strip_keys='${keys.join(" ")}'
  for nen_key in \$nen_strip_keys; do
    nen_lower="\$(printf '%s' "\$nen_key" | tr '[:upper:]' '[:lower:]')"
    case "\$nen_composed" in
      *",\$nen_lower,"*) continue ;;
    esac
    # A stripped message always keeps its subject, so EMPTY output is never a
    # strip: nothing is replaced, and the refusal below decides.
    if awk -v key="\$nen_lower" '${STRIP_AWK}' "\$msg_file" >"\$msg_file.nen-strip" && [ -s "\$msg_file.nen-strip" ]; then
      if [ -n "\$nen_run" ]; then
        nen_git_dir="\$(git rev-parse --git-dir)" || {
          rm -f "\$msg_file.nen-strip"
          echo "commit-msg: could not resolve the git dir to record a stripped '\$nen_key:' trailer (commits.stripInjected), so nothing is stripped." >&2
          exit 1
        }
      fi
      cat "\$msg_file.nen-strip" >"\$msg_file"
      rm -f "\$msg_file.nen-strip"
      if [ -n "\$nen_run" ]; then
        printf '%s\\n' "\$nen_key" >>"\$nen_git_dir/${STRIP_SIDECAR_FILE}.\$nen_run"
        echo "commit-msg: stripped the hook-injected '\$nen_key:' trailer (commits.stripInjected)" >&2
      else
        echo "commit-msg: stripped the hook-injected '\$nen_key:' trailer (commits.stripInjected), but ${HOOK_COMPOSED_KEYS_ENV} was found without a nen run id (${HOOK_STRIP_RUN_ENV} missing or malformed): it was exported or leaked rather than set by a nen verb, so no sidecar was written and no verb will report this strip." >&2
      fi
    else
      rm -f "\$msg_file.nen-strip"
    fi
  done
fi
`;
}

// A POSIX sh script -- portable to the Windows Git Bash lane this repository's
// own CI already runs on (.gitattributes' `* text=auto`, the CRLF discipline
// every parser here already follows), and to any Unix scaffold target.
//
// TWO GUARDS, WITH DELIBERATELY DIFFERENT SCOPES, and the difference is the
// whole design of this script:
//
//   * THE REQUIRED TRAILER(S) ARE REQUIRED ON AN AUTOMATED COMMIT ONLY
//     (above). It is a positive obligation an automated run takes on about
//     itself: `agentTrailer` always, `runTrailer` only when the policy states
//     one.
//   * A REFUSED ATTRIBUTION TRAILER IS REFUSED ON EVERY COMMIT. It is a fact
//     about the MESSAGE, not about who typed it: a `Co-Authored-By:` naming a
//     tool is equally wrong in the history whether a script or a person put it
//     there, and a guard that only fires for automated runs is one that any
//     agent evades by not setting the marker. That is the whole reason a hook
//     exists rather than a lint.
//
// THE REFUSED LIST, AND WHETHER THE REQUIRED KEY IS ADMITTED, ARE BOTH DATA,
// BAKED IN AT GENERATION TIME. `nen scaffold init` resolves both once from the
// repository's own `nen/workflow.json` (../schema/workflow.ts's
// `refusedTrailerKeys` and `trailerAdmitted`) and hands them here, so the hook
// needs no nen on PATH to run and cannot drift from the policy at the moment
// of commit. Re-run the scaffold after changing the policy; the report says
// `unchanged` when nothing moved and rewrites the hook (under --force) when
// it did -- and regenerating from an UNCHANGED policy is byte-stable, because
// every one of these decisions is made once, here, from the same inputs.
//
// `agentTrailerAdmitted: false` IS A CONFIGURATION nen REFUSES TO PAPER OVER.
// A repository whose OWN `commits.allowedAttributionTrailers` does not list
// the key this run is about to require has stated two things that contradict
// each other -- "automated commits must carry this trailer" and "this trailer
// is not one this repository admits" -- and there is no commit message that
// satisfies both. Rather than generate a check for a trailer that could never
// be added without also being refused, the automated half refuses every
// automated commit outright and names the fix: admit the key, or regenerate
// with a different `--agent-trailer`.
//
// MATCHING IGNORES CASE EVERYWHERE (`grep -i` throughout: the refusals above,
// the required-trailer check(s) below), for ../schema/workflow.ts's own
// reason: every tool that reads the finished commit reads a trailer key
// without regard to case, so a guard one capital defeats is not a guard.
//
// `stripInjected` (zheref/nen#594) IS THE ONE STEP THAT EDITS THE MESSAGE, and
// it is rendered ONLY when the repository's `commits.stripInjected` lists a
// key: with the list empty -- the default -- the script is byte for byte the
// one this function rendered before the step existed, so every consumer's
// `nen scaffold init` still answers `unchanged`. When it is rendered it runs
// BEFORE the refusal greps, and only when NEN_COMPOSED_TRAILER_KEYS is SET
// (set-but-empty counts) -- the variable `nen commit write` and `nen wc
// squash` give their child `git commit`. For each listed key the composed
// message did NOT carry, it removes that key's lines, and their folded
// continuations, from the message's TRAILER BLOCK only (git's definition: the
// final paragraph, never the subject; a paragraph with a non-trailer line in
// it is not a trailer block and is left alone), reports each removal on
// stderr and appends the key to `<git dir>/nen-stripped-trailers`.
//
// WHY THIS VARIABLE IS NOT THE "IN-BAND OVERRIDE" `renderPreCommitHook` BELOW
// REFUSES TO BUILD. That warning is about a variable that lets a refused
// commit THROUGH. This one cannot: it never admits a key (the refusals still
// run on what is left, so a refused key the strip did not remove still
// refuses), it only ever REMOVES a key, only a key the repository itself
// listed, never one the composed message carried (the variable's value names
// those, and a listed key among them is left for the refusal -- AC-2), and
// every removal is reported, on stderr and in the sidecar the verb turns into
// exit 4. Set by accident outside nen, it can at worst remove a refused key
// the repository asked to have removed -- and say so.
//
// PORTABLE POSIX sh AND awk ONLY: `tr`, `awk -v`, `cat`, `rm -f`, `git
// rev-parse --git-dir` -- no bashism, no GNU-only flag -- for macOS, Linux and
// Git for Windows' sh alike. The awk program carries no single quote, so it
// sits inside one in the script.
export function renderCommitMsgHook(
  spec: HookSpec,
  refusedTrailers: readonly string[] = [],
  agentTrailerAdmitted = true,
  stripInjected: readonly string[] = [],
): string {
  const refusals = refusedTrailers
    .map(
      (key): string => `
if grep -qiE '^${key}:' "\$msg_file"; then
  echo "commit-msg: this message carries a '${key}:' trailer, which this repository's nen/workflow.json does not list under commits.allowedAttributionTrailers." >&2
  exit 1
fi
`,
    )
    .join("");
  const keys = stripKeys(stripInjected);
  // H: one header line when the strip step is rendered; none (byte-identical) when it is not.
  const stripHeader = keys.length === 0
    ? ""
    : "#\n# It also REMOVES a listed trailer a hook injected, first (commits.stripInjected),\n# and only inside a commit a nen verb started -- see the step below.\n";
  const required = spec.runTrailer === null ? spec.agentTrailer : `${spec.agentTrailer}:/${spec.runTrailer}`;
  const automatedHalf = !agentTrailerAdmitted
    ? `  echo "commit-msg: ${spec.markerEnvVar} is set (an automated commit), but this repository's nen/workflow.json does not admit '${spec.agentTrailer}' under commits.allowedAttributionTrailers -- no automated commit can carry a trailer this policy does not list. Add '${spec.agentTrailer}' to that list (or regenerate this hook with a different --agent-trailer), then re-run 'nen scaffold init'." >&2
  exit 1`
    : `  if ! grep -qiE '^${spec.agentTrailer}: .+' "\$msg_file"; then
    echo "commit-msg: ${spec.markerEnvVar} is set (an automated commit) but the message carries no '${spec.agentTrailer}: <value>' trailer." >&2
    exit 1
  fi
${
  spec.runTrailer === null
    ? ""
    : `
  if ! grep -qiE '^${spec.runTrailer}: .+' "\$msg_file"; then
    echo "commit-msg: ${spec.markerEnvVar} is set (an automated commit) but the message carries no '${spec.runTrailer}: <value>' trailer." >&2
    exit 1
  fi
`
}`;
  return `#!/bin/sh
# commit-msg -- enforces the ${required}: trailer${spec.runTrailer === null ? "" : "s"}
# on an AUTOMATED commit only, and refuses every attribution trailer this
# repository does not admit, on EVERY commit. Generated by 'nen scaffold init'.
#
# A commit is "automated" iff ${spec.markerEnvVar} is set in the environment
# the commit runs in. An ordinary human commit at a keyboard carries no such
# variable and is never asked for either trailer -- but the refused-trailer
# list below applies to it too, because a trailer nobody wants in the history is
# unwanted whoever typed it.
#
# The refused list, and whether '${spec.agentTrailer}' is one this repository's
# own policy admits, were both read from nen/workflow.json when this file was
# generated and are baked in as data: this hook needs no nen on PATH. Re-run
# 'nen scaffold init' after changing that policy.
${stripHeader}
set -eu

msg_file="\$1"
${renderStripStep(keys)}${refusals}
if [ -z "\${${spec.markerEnvVar}:-}" ]; then
  # Not an automated commit -- nothing further to enforce.
  exit 0
fi

${automatedHalf}

exit 0
`;
}

/**
 * The generated `pre-commit` hook: a commit on the trunk is refused.
 *
 * WHY A HOOK AND NOT ADVICE. "Never commit on `main`" is the rule every branch
 * workflow rests on and the one an agent breaks silently: the commit succeeds,
 * the tree looks right, and the mistake surfaces at the push -- or does not,
 * and lands. A `pre-commit` hook is the only place the refusal costs nothing to
 * recover from, because nothing has been written yet.
 *
 * `git branch --show-current` IS THE PROBE, AND ITS EMPTY ANSWER IS A PASS. A
 * detached HEAD (a rebase, a bisect, a `git commit` inside a `filter-branch`)
 * prints nothing, which is not the trunk, so those keep working -- refusing
 * them would make this hook the reason a rebase cannot finish.
 *
 * THE TRUNK'S NAME IS DATA, from `nen/workflow.json`'s `branch.base`, held to
 * ../schema/workflow.ts's `BRANCH_BASE` shape before it is interpolated here.
 * A repository whose trunk is called something else says so in one line.
 *
 * NO `--no-verify` ESCAPE IS BUILT IN, deliberately: git already has one, it is
 * typed by a human at the moment they mean it, and a second in-band override
 * (an environment variable this script checks) is one an automated run sets by
 * accident and nobody ever sees.
 */
export function renderPreCommitHook(base: string): string {
  return `#!/bin/sh
# pre-commit -- refuses a commit made ON the trunk. Generated by
# 'nen scaffold init', with the trunk's name read from nen/workflow.json's
# branch.base at generation time.
#
# A detached HEAD reports no branch and is allowed through: a rebase or a bisect
# is not somebody committing to the trunk by accident, which is what this hook
# is for.

set -eu

base="${base}"
current="\$(git branch --show-current 2>/dev/null || true)"

if [ "\$current" = "\$base" ]; then
  echo "pre-commit: refusing a commit on '\$base' -- this repository's nen/workflow.json names it as branch.base, the trunk. Cut a branch first (git switch -c <branch>), then commit." >&2
  exit 1
fi

exit 0
`;
}
