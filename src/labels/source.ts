// src/labels/source.ts -- where `nen labels sync` reads nen/labels.json from.
//
// zheref/nen#591: a pull request that ADDS or changes the labels file could not
// prove its labels before it merged, because the only gate that read a landed
// declaration (`classify install --sync`) reads the default branch. `--ref`
// reads the file as a named git ref in the --repo checkout has it, and
// `--working-tree` names the checkout's own file explicitly; both preview by
// default and sync only behind --apply.

import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { LABELS_FILE } from "../schema/source.js";
import { parseLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";
import { VerbUsageError } from "../cli/command.js";

/**
 * A ref is the caller's text and goes into git's argv: one that opens with `-`
 * would be read as an option, and one with a colon or whitespace would change
 * which object `<ref>:<path>` names. Both are refused as usage errors before
 * git runs; every other spelling is git's own to resolve or refuse.
 */
export function checkRef(ref: string): string {
  if (ref === "" || ref.startsWith("-") || /[:\s]/.test(ref)) {
    throw new VerbUsageError(`--ref '${ref}' is not a ref nen will pass to git: name a branch, tag or commit (no leading '-', no ':' or whitespace).`);
  }
  return ref;
}

/**
 * The argv that prints nen/labels.json as `ref` holds it. Plumbing, as every
 * other file-at-a-ref read in nen: `cat-file blob` reads no porcelain config
 * and refuses a range such as `a..b`, which `git show` would print as a log.
 */
export function showLabelsArgv(root: string, ref: string): readonly string[] {
  return ["-C", root, "cat-file", "blob", `${ref}:${LABELS_FILE}`];
}

/** nen/labels.json at `ref` of the checkout at `root`, through the same validating parser a disk read uses. */
export function loadLabelTaxonomyAtRef(seams: Seams, root: string, ref: string): LabelTaxonomy {
  const result = seams.run(GIT, [...showLabelsArgv(root, ref)]);
  const where = `${ref}:${LABELS_FILE}`;
  if (result.spawnFailed || result.code !== 0) {
    const reason = outputLines(result.stderr).at(-1) ?? `exit ${result.code}`;
    throw new Error(`could not read ${where} in ${root} (${reason}); nothing was synced. Fetch the ref first, or name one this checkout holds.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(`${where} is not valid JSON (${error instanceof Error ? error.message : String(error)}); nothing was synced.`);
  }
  return parseLabelTaxonomy(where, value);
}
