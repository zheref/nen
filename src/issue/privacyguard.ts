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
import { SchemaError } from "../schema/errors.js";
import { loadWorkflow, type LoadedWorkflow } from "../schema/workflow.js";
import type { Target } from "../github/target.js";
import {
  checkPrivateNames,
  ignoreFileInsideTree,
  NamedListError,
  parseIgnoreList,
  privateNameLines,
  readCommittedNamedList,
  SKIP_PRIVATE_NAME_CHECK_FLAG,
  type CheckedText,
  type CommittedNamedListRead,
  type IgnoreList,
  type NamedList,
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
 * like every other own-path flag (zheref/nen#100), and refused (exit 2) when
 * its real path lies inside the working tree holding that root.
 */
export function readIgnoreFlag(context: CommandContext): IgnoreList | null {
  const raw = context.args.values[PRIVATE_NAMES_IGNORE_FILE_FLAG];
  if (raw === undefined) {
    // `--allow-all-ignored` alone is judged against the OTHER list too
    // (zheref/nen#441): a declared named list can exempt every name on its
    // own, and the refusal that recommends the flag must name a remedy a verb
    // accepts. guardPrivateNames refuses the flag when neither list is there.
    if (context.args.booleans.has(ALLOW_ALL_IGNORED_FLAG) && !namedListDeclared(context)) {
      throw new VerbUsageError(
        `--${ALLOW_ALL_IGNORED_FLAG} permits a list that exempts every private name; it means nothing without --${PRIVATE_NAMES_IGNORE_FILE_FLAG} <path> or a committed named list declared by --repo's nen/workflow.json (privateNames.namedFile).`,
      );
    }
    return null;
  }
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const path = resolveAgainstRepo(root, raw);
  // Never a list the change under review could have written (Feitan F8).
  const inside = ignoreFileInsideTree(path, root);
  if (inside !== null) throw new VerbUsageError(`--${PRIVATE_NAMES_IGNORE_FILE_FLAG}: ${inside}`);
  return parseIgnoreList(
    readTextFile(
      path,
      process.cwd(),
      `--${PRIVATE_NAMES_IGNORE_FILE_FLAG} names the private repositories this run may mention; a missing one is never read as an empty list.`,
    ),
  );
}

/**
 * The `--repo` checkout's committed named list (zheref/nen#441), or null when
 * the checkout's `nen/workflow.json` declares none. The checkout's
 * declaration is only the SWITCH: everything that decides what is exempt --
 * the ref, the policy copy, the path and the list -- is read at the remote's
 * default branch (`refs/remotes/origin/HEAD`) by ./privacy.ts's
 * readCommittedNamedList, never from the checkout, so the change under review
 * cannot write its own exemption, retarget the base at itself, or point the
 * guard at a file of its own (Feitan F8, and his finding on this change).
 * Whatever cannot be read on that route is said, one stderr line prefixed
 * with `verb`, and names nothing -- each leaves the guard STRICTER than a read
 * list would. A line that is not an exact `owner/name` is the one refusal
 * (exit 2): a bare name would exempt every owner's repository of that name.
 */
/**
 * Whether the checkout's `nen/workflow.json` declares `privateNames.namedFile`
 * -- the switch readNamedList turns on, read without git. An unreadable policy
 * reads false (nothing is read then either).
 */
export function namedListDeclared(context: CommandContext): boolean {
  try {
    return loadWorkflow(resolveRepoRoot({ repoFlag: context.repoFlag })).workflow.privateNames.namedFile !== null;
  } catch (error) {
    if (error instanceof SchemaError) return false;
    throw error;
  }
}

export function readNamedList(context: CommandContext, verb: string): NamedList | null {
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  let loaded: LoadedWorkflow;
  try {
    loaded = loadWorkflow(root);
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    context.io.err(
      `${verb}: named list not read -- ${error.message}; no committed named list exempts anything in this run (the ignore file, if any, still does).`,
    );
    return null;
  }
  const declared = loaded.workflow.privateNames.namedFile;
  if (declared === null) return null;
  let read: CommittedNamedListRead;
  try {
    read = readCommittedNamedList(context.seams, root, declared);
  } catch (error) {
    if (!(error instanceof NamedListError)) throw error;
    throw new VerbUsageError(`named list at the remote's default branch: ${error.message}`);
  }
  if (read.named === null) {
    context.io.err(`${verb}: named list not read -- ${read.reason}; it names nothing in this run.`);
    return null;
  }
  if (read.path !== declared) {
    context.io.err(`${verb}: named list read from ${read.ref}:${read.path}; the checkout declares '${declared}', which is head content and decides nothing.`);
  }
  return read.named;
}

/**
 * Run the check for one write and print its lines to stderr, prefixed with
 * `verb` (./privacy.ts's privateNameLines). The committed named list, where
 * the `--repo` checkout declares one, is read here (readNamedList) so every
 * guarded verb honours it without a call-site change (zheref/nen#441). Runs on a dry run too: a dry run
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
  const skip = context.args.booleans.has(SKIP_PRIVATE_NAME_CHECK_FLAG);
  // Read lazily, by checkPrivateNames, after the target's visibility: nothing
  // is read under the opt-out or for a private target.
  const named = (): NamedList | null => readNamedList(context, verb);
  const check = checkPrivateNames(
    context.seams,
    target,
    fields,
    skip,
    ignore,
    context.args.booleans.has(ALLOW_ALL_IGNORED_FLAG),
    named,
  );
  for (const line of privateNameLines(check, target, verb)) context.io.err(line);
  return check;
}
