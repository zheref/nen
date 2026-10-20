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
  parseNamedList,
  privateNameLines,
  readNamedListAtBase,
  SKIP_PRIVATE_NAME_CHECK_FLAG,
  type CheckedText,
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
    if (context.args.booleans.has(ALLOW_ALL_IGNORED_FLAG)) {
      throw new VerbUsageError(
        `--${ALLOW_ALL_IGNORED_FLAG} permits an ignore file that exempts every private name; it means nothing without --${PRIVATE_NAMES_IGNORE_FILE_FLAG} <path>.`,
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
 * `nen/workflow.json` declares none. Read AT THE BASE TIP
 * (`refs/remotes/origin/<branch.base>:<privateNames.namedFile>`), never from
 * the checkout, so the change under review cannot write its own exemption
 * (Feitan F8). Three things are said rather than failed, each one stderr
 * line prefixed with `verb`, because each leaves the guard STRICTER than a
 * read list would: a `nen/workflow.json` nen cannot read, a declared file
 * not at the base tip, and -- not said, nothing to say -- no declaration at
 * all. A line that is not an exact `owner/name` is the one refusal (exit 2):
 * a bare name would exempt every owner's repository of that name.
 */
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
  const path = loaded.workflow.privateNames.namedFile;
  if (path === null) return null;
  const base = loaded.workflow.branch.base;
  const text = readNamedListAtBase(context.seams, root, base, path);
  if (text === null) {
    context.io.err(
      `${verb}: named list '${path}' is not at refs/remotes/origin/${base} (it is read at the base tip, never from the checkout), so it names nothing in this run.`,
    );
    return null;
  }
  try {
    return parseNamedList(text);
  } catch (error) {
    if (!(error instanceof NamedListError)) throw error;
    throw new VerbUsageError(`named list '${path}' at refs/remotes/origin/${base}: ${error.message}`);
  }
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
  // Nothing is read under the opt-out: the run compares against nothing.
  const named = skip ? null : readNamedList(context, verb);
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
