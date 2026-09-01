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
  /** Set when the proof itself could not be run (e.g. an empty --original). ok is always false when this is set. */
  readonly error: string | null;
  /** In the original diff, absent from every branch -- the skill's "leftover hunk". */
  readonly missing: readonly HunkLocation[];
  /** In two or more branches at once -- duplicated instead of assigned to the lower one. */
  readonly duplicated: readonly (HunkLocation & { readonly branches: readonly number[] })[];
  /**
   * Present in exactly one branch under the SAME header, but the hunk BODY
   * differs from the original -- a hunk altered in transit, which "the
   * header lands somewhere" alone would miss entirely (see diff.ts's header:
   * identity is the hunk's exact text, not just its header).
   */
  readonly altered: readonly (HunkLocation & { readonly branch: number; readonly diff: string })[];
  /** In a branch's diff but not in the original -- introduced work the proof did not expect. */
  readonly extra: readonly HunkLocation[];
  readonly filesInOriginal: number;
  readonly filesInBranches: number;
}

// A short, human-scannable summary of where two hunk bodies with the SAME
// header diverge -- not a full diff (that is what the caller's own diff tool
// is for), just enough to tell "this is the same change" from "this is a
// different change wearing the same header" at a glance.
function shortDiff(originalText: string, branchText: string): string {
  const originalLines = originalText.split("\n");
  const branchLines = branchText.split("\n");
  const max = Math.max(originalLines.length, branchLines.length);
  const divergent: string[] = [];
  for (let i = 0; i < max && divergent.length < 3; i++) {
    const a = originalLines[i];
    const b = branchLines[i];
    if (a !== b) divergent.push(`  line ${i + 1}: original ${JSON.stringify(a ?? "(absent)")} vs branch ${JSON.stringify(b ?? "(absent)")}`);
  }
  return divergent.join("\n");
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

  const originalHunkCount = [...original.values()].reduce((sum, hunks): number => sum + hunks.size, 0);
  if (originalHunkCount === 0) {
    // An empty diff is not a proof of completeness -- it is indistinguishable
    // from "the caller pointed --original at the wrong base" or "nothing was
    // staged", and either way the union-of-branches claim below would be
    // vacuously true against nothing.
    return {
      ok: false,
      error: "--original names no hunks -- an empty diff is not a proof of completeness. Check --original: wrong base, or nothing staged?",
      missing: [],
      duplicated: [],
      altered: [],
      extra: [],
      filesInOriginal: original.size,
      filesInBranches: new Set(branches.flatMap((b): string[] => [...b.keys()])).size,
    };
  }

  const missing: HunkLocation[] = [];
  const duplicated: (HunkLocation & { branches: readonly number[] })[] = [];
  const altered: (HunkLocation & { branch: number; diff: string })[] = [];
  const extra: HunkLocation[] = [];

  const allPaths = new Set<string>([...original.keys(), ...branches.flatMap((b): string[] => [...b.keys()])]);

  for (const path of allPaths) {
    const originalHunks = original.get(path) ?? new Map<string, string>();
    const headers = new Set<string>([
      ...originalHunks.keys(),
      ...branches.flatMap((b): string[] => [...(b.get(path)?.keys() ?? [])]),
    ]);

    for (const header of headers) {
      const originalText = originalHunks.get(header);
      const inOriginal = originalText !== undefined;

      // Every branch that carries this (path, header) at all -- identity for
      // "is it here", independent of whether the BODY still matches.
      const owners: number[] = [];
      branches.forEach((branch, branchIndex): void => {
        if (branch.get(path)?.has(header) === true) owners.push(branchIndex);
      });

      if (!inOriginal) {
        if (owners.length > 0) extra.push({ path, header });
        continue;
      }

      if (owners.length === 0) {
        missing.push({ path, header });
      } else if (owners.length > 1) {
        // Present in more than one branch under this header -- duplicated is
        // the bigger problem regardless of whether the bodies also differ;
        // TEXT is still the identity (diff.ts's header), but the count of
        // owners is reported first since a caller fixing "which branch owns
        // this" needs that before "is this copy also altered".
        duplicated.push({ path, header, branches: owners });
      } else {
        // Exactly one branch carries this header. IDENTITY IS TEXT, NOT JUST
        // THE HEADER -- a matching header with a different body is a hunk
        // that changed in transit, not a hunk that landed.
        const branchIndex = owners[0] as number;
        const branchText = branches[branchIndex]?.get(path)?.get(header) as string;
        if (branchText !== originalText) {
          altered.push({ path, header, branch: branchIndex, diff: shortDiff(originalText, branchText) });
        }
        // else: exactly the intended shape, no report.
      }
    }
  }

  return {
    ok: missing.length === 0 && duplicated.length === 0 && altered.length === 0 && extra.length === 0,
    error: null,
    missing,
    duplicated,
    altered,
    extra,
    filesInOriginal: original.size,
    filesInBranches: new Set(branches.flatMap((b): string[] => [...b.keys()])).size,
  };
}
