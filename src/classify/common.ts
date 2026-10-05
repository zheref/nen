// src/classify/common.ts -- the three small things every `nen classify` verb
// resolves the same way, written once so the four verbs cannot disagree about
// them (the lesson of zheref/nen#93: four private copies of one refusal answered
// one mistake with two different exit codes).
//
//   * `--target owner/name`, a MALFORMED value being the same typo as an absent
//     one, so both exit 2.
//   * `--repo`, required by every verb that reads or writes the consumer's
//     `nen/labels.json`, and checked to be a directory that exists.
//   * `--taxonomy`, resolved against that root and validated on load.

import {
  parseCallerToken,
  requireRepoFlag,
  requireTargetFlag,
  requireValue,
  type CommandContext,
} from "../cli/command.js";
import { parseTarget, TargetError, type Target } from "../github/target.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadClassifyTaxonomy, type ClassifyTaxonomy } from "./taxonomy.js";

export function requireTarget(context: CommandContext): Target {
  const raw = requireTargetFlag(
    context,
    "It is the GitHub side of the pair; --repo names a checkout on disk and is never used to address the API.",
  );
  return parseCallerToken(
    (): Target => parseTarget(raw),
    (error: unknown): boolean => error instanceof TargetError,
  );
}

export interface Loaded {
  readonly root: string;
  readonly taxonomy: ClassifyTaxonomy;
}

/** `--repo` required: these verbs read the consumer's own declaration, never the cwd's by accident. */
export function loadRequiringRepo(context: CommandContext): Loaded {
  const flag = requireValue(
    context.args,
    "taxonomy",
    "It is the classification taxonomy file the label set is read from (relative paths resolve against --repo).",
  );
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the checkout whose nen/labels.json is the consumer's declaration."),
  });
  return { root, taxonomy: loadClassifyTaxonomy(root, flag) };
}
