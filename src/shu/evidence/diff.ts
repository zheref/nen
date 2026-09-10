// src/shu/evidence/diff.ts -- the changed-file half of `nen shu evidence`:
// `git diff --name-status <base>...HEAD`, through the seam, normalized to the
// four statuses ../../schema/contract.ts's row shape reports.

import { GIT, must, outputLines, type Seams } from "../../seam/exec.js";

export type EvidenceStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  readonly path: string;
  readonly status: EvidenceStatus;
}

/**
 * One `--name-status` code, normalized to the four this family reports.
 *
 * GIT'S CODES ARE FINER THAN THE FOUR THE BRIEF PUBLISHES, and this is which
 * of the four each finer one is closest to, decided once rather than left for
 * a reader to reverse-engineer from a switch:
 *   R### (rename)  -> renamed, reported at its NEW path -- the survivor.
 *   C### (copy)    -> added. A copy is a brand-new path whose content happens
 *                     to match another; from "did THIS path change" it is
 *                     indistinguishable from a fresh file, and 'copied' is not
 *                     one of the four the schema publishes.
 *   T   (type change, e.g. file <-> symlink) -> modified: the path is the
 *                     same, only what it points at changed.
 *   U/X/B (unmerged, unknown, broken pairing) -- these do not occur on a
 *                     two-commit `A...B` diff (they are working-tree-only, or
 *                     `--diff-filter` artifacts); 'modified' is the fail-safe
 *                     answer rather than a crash on a code this release has
 *                     never actually seen `git diff --name-status` produce.
 */
function normalizeStatus(code: string): EvidenceStatus {
  const letter = code.charAt(0);
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  if (letter === "C") return "added";
  return "modified";
}

/**
 * `git diff --name-status <base>...HEAD`, through the seam.
 *
 * THREE DOTS, NOT TWO. `<base>...HEAD` is the MERGE-BASE diff -- what HEAD
 * introduced since it and `<base>` last shared history -- which is what "did
 * this branch change any evidence" means. `<base>..HEAD` would also surface
 * every commit `<base>` itself gained meanwhile, on a base that has moved
 * since the branch was cut, which is not evidence this branch produced.
 *
 * A GIT FAILURE PROPAGATES AS ITS OWN ERROR (`must` throws `ToolError`), never
 * as an empty changed-file set: an unresolvable `--base` or a detached HEAD
 * must not be read as "nothing changed" -- see ../../wc/classify.ts's own
 * header for the same rule, applied there to `git status`.
 */
export function readChangedFiles(
  seams: Seams,
  cwd: string,
  base: string,
): readonly ChangedFile[] {
  const result = must(seams, GIT, ["diff", "--name-status", `${base}...HEAD`], { cwd });
  const rows: ChangedFile[] = [];
  for (const line of outputLines(result.stdout)) {
    const columns = line.split("\t");
    const code = columns[0];
    if (code === undefined || code === "") continue;
    // A rename/copy row carries TWO paths (old, new); every other code
    // carries one. The LAST column is the new path either way.
    const path = columns[columns.length - 1];
    if (path === undefined || path === "") continue;
    rows.push({ path, status: normalizeStatus(code) });
  }
  return rows;
}
