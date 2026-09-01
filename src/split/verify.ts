// src/split/verify.ts -- the completeness proof jujisho §2 requires BEFORE
// opening anything: the union of the branches' diffs equals the original
// working-copy diff.
//
// "A LEFTOVER HUNK IS A SILENT BUG" (the skill's own words), because it is
// invisible in both PRs and surfaces later as an unexplained local change. This
// module's whole job is to make that bug LOUD instead: every hunk in the
// original diff must appear in EXACTLY ONE branch's diff. Missing from every
// branch, or present in more than one, are both reported by name -- a hunk
// deliberately shared between two axes still goes on exactly the LOWER one in
// the stack (the skill's own resolution), never duplicated.
//
// FILE-LEVEL AND HUNK-LEVEL, BOTH. A file that exists in the original diff but
// in none of the branches is reported as a missing file (every one of its
// hunks is, transitively, missing); a file introduced by a branch that the
// original diff never touched is reported as an extra file. Neither case is
// assumed impossible -- a caller handed the wrong original diff, or a stray
// `git add` on one branch, produces exactly this and must be named rather than
// silently passed through per-hunk comparison.

import { parseDiff, type FileDiff } from "./diff.js";

export interface HunkLocation {
  readonly path: string;
  readonly header: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  /** In the original diff, absent from every branch -- the skill's "leftover hunk". */
  readonly missing: readonly HunkLocation[];
  /** In two or more branches at once -- duplicated instead of assigned to the lower one. */
  readonly duplicated: readonly (HunkLocation & { readonly branches: readonly number[] })[];
  /** In a branch's diff but not in the original -- introduced work the proof did not expect. */
  readonly extra: readonly HunkLocation[];
  readonly filesInOriginal: number;
  readonly filesInBranches: number;
}

function index(files: readonly FileDiff[]): Map<string, Map<string, string>> {
  // path -> (hunk header -> hunk text). Keyed by header first because two
  // hunks in one file never share a header (git's own hunk-range accounting
  // guarantees the '@@ -a,b +c,d @@' ranges are unique per file per diff).
  const byFile = new Map<string, Map<string, string>>();
  for (const file of files) {
    const hunks = byFile.get(file.path) ?? new Map<string, string>();
    for (const hunk of file.hunks) hunks.set(hunk.header, hunk.text);
    byFile.set(file.path, hunks);
  }
  return byFile;
}

export function verifySplit(originalDiff: string, branchDiffs: readonly string[]): VerifyResult {
  const original = index(parseDiff(originalDiff));
  const branches = branchDiffs.map((text): Map<string, Map<string, string>> => index(parseDiff(text)));

  const missing: HunkLocation[] = [];
  const duplicated: (HunkLocation & { branches: readonly number[] })[] = [];
  const extra: HunkLocation[] = [];

  const allPaths = new Set<string>([...original.keys(), ...branches.flatMap((b): string[] => [...b.keys()])]);

  for (const path of allPaths) {
    const originalHunks = original.get(path) ?? new Map<string, string>();
    const headers = new Set<string>([
      ...originalHunks.keys(),
      ...branches.flatMap((b): string[] => [...(b.get(path)?.keys() ?? [])]),
    ]);

    for (const header of headers) {
      const owners: number[] = [];
      branches.forEach((branch, branchIndex): void => {
        if (branch.get(path)?.has(header) === true) owners.push(branchIndex);
      });

      const inOriginal = originalHunks.has(header);
      if (inOriginal && owners.length === 0) {
        missing.push({ path, header });
      } else if (inOriginal && owners.length > 1) {
        duplicated.push({ path, header, branches: owners });
      } else if (!inOriginal && owners.length > 0) {
        extra.push({ path, header });
      }
      // inOriginal && owners.length === 1: exactly the intended shape, no report.
    }
  }

  return {
    ok: missing.length === 0 && duplicated.length === 0 && extra.length === 0,
    missing,
    duplicated,
    extra,
    filesInOriginal: original.size,
    filesInBranches: new Set(branches.flatMap((b): string[] => [...b.keys()])).size,
  };
}
