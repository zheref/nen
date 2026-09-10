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
// THE TRAILER NAMES ARE CALLER DATA. Which two trailer keys this hook
// enforces, and which environment variable marks an automated commit, are
// supplied by the caller (../scaffold/verb.ts's flags) -- this system serves
// more than one target, and a literal 'Akatsuki-Agent' baked into shipped
// code would be exactly the persona-naming violation §3 exists to catch, even
// though this specific pair is Akatsuki's own by design (the caller is free
// to pass exactly that pair; the point is that THIS module does not assume
// it).

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
  /** The trailer key naming which CI run produced an automated commit. */
  readonly runTrailer: string;
  /** The environment variable whose presence marks a commit as automated. */
  readonly markerEnvVar: string;
}

// A POSIX sh script -- portable to the Windows Git Bash lane this repository's
// own CI already runs on (.gitattributes' `* text=auto`, the CRLF discipline
// every parser here already follows), and to any Unix scaffold target.
//
// TWO GUARDS, WITH DELIBERATELY DIFFERENT SCOPES, and the difference is the
// whole design of this script:
//
//   * THE TRAILER PAIR IS REQUIRED ON AN AUTOMATED COMMIT ONLY (above). It is a
//     positive obligation an automated run takes on about itself.
//   * A REFUSED ATTRIBUTION TRAILER IS REFUSED ON EVERY COMMIT. It is a fact
//     about the MESSAGE, not about who typed it: a `Co-Authored-By:` naming a
//     tool is equally wrong in the history whether a script or a person put it
//     there, and a guard that only fires for automated runs is one that any
//     agent evades by not setting the marker. That is the whole reason a hook
//     exists rather than a lint.
//
// THE REFUSED LIST IS DATA, BAKED IN AT GENERATION TIME. `nen scaffold init`
// resolves it once from the repository's own `nen/workflow.json` (../schema/
// workflow.ts's `refusedTrailerKeys`) and hands it here, so the hook needs no
// nen on PATH to run and cannot drift from the policy at the moment of commit.
// Re-run the scaffold after changing the policy; the report says `unchanged`
// when nothing moved and rewrites the hook (under --force) when it did.
//
// MATCHING IGNORES CASE (`grep -i`), for ../schema/workflow.ts's own reason:
// every tool that reads the finished commit reads a trailer key without regard
// to case, so a guard one capital defeats is not a guard.
export function renderCommitMsgHook(
  spec: HookSpec,
  refusedTrailers: readonly string[] = [],
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
  return `#!/bin/sh
# commit-msg -- enforces the ${spec.agentTrailer}:/${spec.runTrailer}: trailer
# pair on an AUTOMATED commit only, and refuses every attribution trailer this
# repository does not admit, on EVERY commit. Generated by 'nen scaffold init'.
#
# A commit is "automated" iff ${spec.markerEnvVar} is set in the environment
# the commit runs in. An ordinary human commit at a keyboard carries no such
# variable and is never asked for the trailer PAIR -- but the refused-trailer
# list below applies to it too, because a trailer nobody wants in the history is
# unwanted whoever typed it.
#
# The refused list was read from nen/workflow.json when this file was generated
# and is baked in as data: this hook needs no nen on PATH. Re-run
# 'nen scaffold init' after changing that policy.

set -eu

msg_file="\$1"
${refusals}
if [ -z "\${${spec.markerEnvVar}:-}" ]; then
  # Not an automated commit -- nothing further to enforce.
  exit 0
fi

if ! grep -qE '^${spec.agentTrailer}: .+' "\$msg_file"; then
  echo "commit-msg: ${spec.markerEnvVar} is set (an automated commit) but the message carries no '${spec.agentTrailer}: <value>' trailer." >&2
  exit 1
fi

if ! grep -qE '^${spec.runTrailer}: .+' "\$msg_file"; then
  echo "commit-msg: ${spec.markerEnvVar} is set (an automated commit) but the message carries no '${spec.runTrailer}: <value>' trailer." >&2
  exit 1
fi

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
