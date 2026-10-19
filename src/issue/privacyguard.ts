// src/issue/privacyguard.ts -- the private-name guard as a VERB runs it: its
// three flags, the ignore file, the stderr lines and the verdict
// (zheref/nen#329, #363).
//
// WHY ITS OWN MODULE. #329 put the check (./privacy.ts) behind three `issue`
// verbs, and the two command-side helpers -- read `--private-names-ignore-file`
// before any `gh` call, then run the check and print its lines -- lived in
// ./command.ts. #363 puts the same guard in front of every other verb that
// writes caller text to GitHub (`idea file`, `pr open`, `pr edit-body`, `pr
// threads reply|settle`, `wake fire|verify`, `issue consolidate-close`), and a
// copy of those helpers per family is a copy that drifts: an ignore file read
// from the process cwd in one family and from `--repo` in another, or an
// opt-out named in one and silent in the next. So every guarded verb calls
// these, and ./privacy.ts stays the one place the matching lives.
//
// `src/dev/release-publish.ts` is the one guarded writer that is not a
// `Command` -- it parses its own argv and carries its own runner -- so it calls
// ./privacy.ts directly, with the same flags, exits and lines.

import { VerbUsageError, type CommandContext } from "../cli/command.js";
import type { FlagSpec } from "../cli/args.js";
import { readTextFile, resolveAgainstRepo } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import type { Target } from "../github/target.js";
import {
  checkPrivateNames,
  parseIgnoreList,
  privateNameLines,
  SKIP_PRIVATE_NAME_CHECK_FLAG,
  type CheckedText,
  type IgnoreList,
  type PrivateNameCheck,
} from "./privacy.js";

/** The ignore-file flag, a value. */
export const PRIVATE_NAMES_IGNORE_FILE_FLAG = "private-names-ignore-file";

/** The flag that permits an ignore file exempting every private name. */
export const ALLOW_ALL_IGNORED_FLAG = "allow-all-ignored";

/**
 * The guard's three flags, in a parser spec's shape. Every guarded verb's own
 * flag row spreads these, so a verb cannot run the guard and refuse its
 * opt-out as foreign, or accept the opt-out and never read it.
 */
export const PRIVATE_NAME_FLAGS: Required<Pick<FlagSpec, "values" | "booleans">> = {
  values: [PRIVATE_NAMES_IGNORE_FILE_FLAG],
  booleans: [SKIP_PRIVATE_NAME_CHECK_FLAG, ALLOW_ALL_IGNORED_FLAG],
};

/**
 * `--private-names-ignore-file <path>`, read BEFORE any `gh` call: absent or
 * unreadable when given is a usage error (exit 2), and with the flag omitted
 * nothing is read -- there is no default path. Resolved against --repo's root
 * like every other own-path flag (zheref/nen#100).
 */
export function readIgnoreFlag(context: CommandContext): IgnoreList | null {
  const raw = context.args.values[PRIVATE_NAMES_IGNORE_FILE_FLAG];
  if (raw === undefined) {
    if (context.args.booleans.has(ALLOW_ALL_IGNORED_FLAG)) {
      throw new VerbUsageError(
        `--${ALLOW_ALL_IGNORED_FLAG} permits an ignore file that exempts every private name; it means nothing without --${PRIVATE_NAMES_IGNORE_FILE_FLAG} <path>.`,
      );
    }
    return null;
  }
  const path = resolveAgainstRepo(resolveRepoRoot({ repoFlag: context.repoFlag }), raw);
  return parseIgnoreList(
    readTextFile(
      path,
      process.cwd(),
      `--${PRIVATE_NAMES_IGNORE_FILE_FLAG} names the private repositories this run may mention; a missing one is never read as an empty list.`,
    ),
  );
}

/**
 * Run the check for one write and print its lines to stderr, prefixed with
 * `verb` (./privacy.ts's privateNameLines). Runs on a dry run too: a dry run
 * whose verdict differs from the real run's is not a dry run. Stderr in every
 * mode, so a passing run's stdout is unchanged and the opt-out is named even
 * under --json. The caller refuses on `blocksWrite`, with `blockingExit`.
 */
export function guardPrivateNames(
  context: CommandContext,
  target: Target,
  fields: readonly CheckedText[],
  ignore: IgnoreList | null,
  verb: string,
): PrivateNameCheck {
  const check = checkPrivateNames(
    context.seams,
    target,
    fields,
    context.args.booleans.has(SKIP_PRIVATE_NAME_CHECK_FLAG),
    ignore,
    context.args.booleans.has(ALLOW_ALL_IGNORED_FLAG),
  );
  for (const line of privateNameLines(check, target, verb)) context.io.err(line);
  return check;
}
